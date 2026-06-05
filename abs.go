package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
)

// ---- Audiobookshelf API shapes (only the fields we use) ----

type absSession struct {
	ID            string  `json:"id"`
	LibraryItemID string  `json:"libraryItemId"`
	EpisodeID     string  `json:"episodeId"`
	MediaType     string  `json:"mediaType"`
	DisplayTitle  string  `json:"displayTitle"`
	DisplayAuthor string  `json:"displayAuthor"`
	Duration      float64 `json:"duration"`      // total media length, seconds
	TimeListening float64 `json:"timeListening"` // listened in this session, seconds
	StartTime     float64 `json:"startTime"`     // playback position at session start, seconds
	CurrentTime   float64 `json:"currentTime"`   // playback position at session end, seconds
	CreatedAt     int64   `json:"createdAt"`     // epoch ms
	UpdatedAt     int64   `json:"updatedAt"`     // epoch ms
	MediaMetadata struct {
		Title string `json:"title"`
	} `json:"mediaMetadata"`
}

type sessionsResp struct {
	Total        int          `json:"total"`
	NumPages     int          `json:"numPages"`
	Page         int          `json:"page"`
	ItemsPerPage int          `json:"itemsPerPage"`
	Sessions     []absSession `json:"sessions"`
}

// ---- API response shapes (consumed by the frontend) ----

type Book struct {
	T   string `json:"t"`   // title
	A   string `json:"a"`   // author
	Img string `json:"img"` // relative cover path, e.g. "covers/<id>.jpg"
}

type DaySession struct {
	ID      string `json:"id"`      // book id (key into Books)
	From    int    `json:"from"`    // progress % at start of the day
	To      int    `json:"to"`      // progress % at end of the day
	Fin     bool   `json:"fin"`     // finished (>= ~99%)
	Secs    int    `json:"secs"`    // seconds listened that day
	Started string `json:"started"` // YYYY-MM-DD the book was first listened to
}

type Data struct {
	GeneratedAt string                  `json:"generatedAt"`
	TZ          string                  `json:"tz"`
	Start       string                  `json:"start"` // Monday on/before earliest session, YYYY-MM-DD
	Today       string                  `json:"today"` // today in TZ, YYYY-MM-DD
	Books       map[string]Book         `json:"books"`
	Days        map[string][]DaySession `json:"days"`
}

// ---- client ----

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 60 * time.Second},
	}
}

func (c *Client) get(ctx context.Context, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	return c.http.Do(req)
}

// fetchSessionsPage fetches a single page of listening sessions. Page 0 is the
// newest. perPage caps the page size.
func (c *Client) fetchSessionsPage(ctx context.Context, page, perPage int) (*sessionsResp, error) {
	resp, err := c.get(ctx, fmt.Sprintf("/api/me/listening-sessions?itemsPerPage=%d&page=%d", perPage, page))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("listening-sessions page %d: %s: %s", page, resp.Status, strings.TrimSpace(string(body)))
	}
	var sr sessionsResp
	if err := json.NewDecoder(resp.Body).Decode(&sr); err != nil {
		return nil, fmt.Errorf("decode page %d: %w", page, err)
	}
	return &sr, nil
}

// ---- aggregation ----

func pct(pos, dur float64) int {
	if dur <= 0 {
		return 0
	}
	v := int(math.Round(pos / dur * 100))
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

// aggregate turns raw sessions into the frontend Data, bucketing by calendar
// day in loc and merging multiple sessions of the same book on the same day.
func aggregate(sessions []absSession, loc *time.Location) Data {
	type key struct{ day, id string }
	type acc struct {
		secs       float64
		currentPos float64
		duration   float64
	}
	accs := map[key]*acc{}
	books := map[string]Book{}
	started := map[string]string{} // book id -> earliest day seen

	for _, s := range sessions {
		if s.MediaType != "book" {
			continue
		}
		id := s.LibraryItemID
		if id == "" {
			continue
		}
		day := time.UnixMilli(s.UpdatedAt).In(loc).Format("2006-01-02")
		k := key{day, id}
		a := accs[k]
		if a == nil {
			a = &acc{currentPos: s.CurrentTime}
			accs[k] = a
		}
		a.secs += s.TimeListening
		if s.CurrentTime > a.currentPos {
			a.currentPos = s.CurrentTime
		}
		if s.Duration > a.duration {
			a.duration = s.Duration
		}

		title := s.DisplayTitle
		if title == "" {
			title = s.MediaMetadata.Title
		}
		books[id] = Book{T: title, A: s.DisplayAuthor, Img: "covers/" + id + ".jpg"}
		if cur, ok := started[id]; !ok || day < cur {
			started[id] = day
		}
	}

	// Walk each book's days in order and turn raw positions into a continuous
	// progress bar: a day's "from" is where the previous day left off (the max
	// progress reached so far for that book), not the session's own startTime —
	// ABS frequently reports startTime=0 even when resuming.
	byBook := map[string][]string{} // book id -> its days
	for k := range accs {
		byBook[k.id] = append(byBook[k.id], k.day)
	}
	days := map[string][]DaySession{}
	var earliest string
	for id, ds := range byBook {
		sort.Strings(ds)
		running := 0 // max progress % reached on earlier days
		for _, day := range ds {
			a := accs[key{day, id}]
			to := pct(a.currentPos, a.duration)
			if to < running {
				to = running // re-listening an earlier part: no new forward progress
			}
			days[day] = append(days[day], DaySession{
				ID:      id,
				From:    running,
				To:      to,
				Fin:     to >= 99,
				Secs:    int(math.Round(a.secs)),
				Started: started[id],
			})
			running = to
			if earliest == "" || day < earliest {
				earliest = day
			}
		}
	}
	// stable order within a day (largest listen first) for deterministic output
	for _, ss := range days {
		sort.Slice(ss, func(i, j int) bool { return ss[i].Secs > ss[j].Secs })
	}

	now := time.Now().In(loc)
	today := now.Format("2006-01-02")
	start := mondayOnOrBefore(earliest, today, loc)

	return Data{
		GeneratedAt: now.Format(time.RFC3339),
		TZ:          loc.String(),
		Start:       start,
		Today:       today,
		Books:       books,
		Days:        days,
	}
}

// mondayOnOrBefore returns the Monday on or before earliest (YYYY-MM-DD).
// Falls back to ~6 weeks before today when there is no data yet.
func mondayOnOrBefore(earliest, today string, loc *time.Location) string {
	d, err := time.ParseInLocation("2006-01-02", earliest, loc)
	if err != nil {
		t, _ := time.ParseInLocation("2006-01-02", today, loc)
		d = t.AddDate(0, 0, -42)
	}
	// Go: Monday==1 ... Sunday==0; shift back to Monday
	off := (int(d.Weekday()) + 6) % 7
	return d.AddDate(0, 0, -off).Format("2006-01-02")
}
