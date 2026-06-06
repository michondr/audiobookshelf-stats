package main

// Static demo generator (`-gendemo <outdir>`). Builds a self-contained copy of the
// frontend backed by a generated data.json + real book covers, for publishing to
// GitHub Pages. It needs no Audiobookshelf server and no database:
//   1. pull a book list (titles/authors/cover ids) from Open Library, fully live;
//   2. synthesize ~3 years of plausible listening history over those books;
//   3. run it through the real aggregate() so the payload is byte-identical in shape
//      to what the live server emits;
//   4. download + downscale the covers used, and assemble <outdir>/ as a static site.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"log"
	"math"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Open Library subjects sampled for a varied shelf. Fully dynamic: what each returns
// (and so the demo's exact books) changes as Open Library's data does.
var olSubjects = []string{
	"fantasy", "science_fiction", "thriller", "mystery", "historical_fiction",
	"horror", "biography", "history", "science", "fiction", "young_adult", "adventure",
}

const (
	demoYears      = 3
	demoSeed       = 20240607 // keeps a single run self-consistent (the OL list still varies)
	olPerSubject   = 30
	maxConcurrent  = 2
	demoUserAgent  = "abs-stats-demo/1.0 (github.com/michondr/audiobookshelf-status; static Pages demo)"
	demoCoverDelay = 120 * time.Millisecond // be polite to covers.openlibrary.org
)

type demoBook struct {
	id     string // Open Library cover id, as string (cover filename + Books key)
	title  string
	author string
	durSec float64
}

func runGenDemo(outDir string) int {
	loc, err := time.LoadLocation(env("TZ", "Europe/Prague"))
	if err != nil {
		log.Printf("gendemo: bad TZ: %v", err)
		return 1
	}
	hc := &http.Client{Timeout: 30 * time.Second}

	candidates, err := fetchOpenLibraryBooks(hc)
	if err != nil {
		log.Printf("gendemo: fetch book list: %v", err)
		return 1
	}
	if len(candidates) < 10 {
		log.Printf("gendemo: too few books from Open Library (%d)", len(candidates))
		return 1
	}
	log.Printf("gendemo: %d candidate books from Open Library", len(candidates))

	rng := rand.New(rand.NewSource(demoSeed))
	rng.Shuffle(len(candidates), func(i, j int) { candidates[i], candidates[j] = candidates[j], candidates[i] })

	sessions, used := synthSessions(candidates, loc, rng)
	log.Printf("gendemo: synthesized %d sessions across %d books", len(sessions), len(used))

	data := aggregate(sessions, loc)
	// no absBase: the "Open in Audiobookshelf" feature self-disables in the frontend.

	if err := assembleSite(outDir, data, used, hc); err != nil {
		log.Printf("gendemo: assemble site: %v", err)
		return 1
	}
	log.Printf("gendemo: wrote static demo to %s", outDir)
	return 0
}

// ---- Open Library book list ----

type olSubjectResp struct {
	Works []struct {
		Key     string `json:"key"`
		Title   string `json:"title"`
		CoverID int    `json:"cover_id"`
		Authors []struct {
			Name string `json:"name"`
		} `json:"authors"`
	} `json:"works"`
}

func fetchOpenLibraryBooks(hc *http.Client) ([]demoBook, error) {
	seen := map[string]bool{}      // dedupe by work key
	seenCover := map[int]bool{}    // and by cover id (avoid duplicate covers)
	var books []demoBook
	for _, subj := range olSubjects {
		url := fmt.Sprintf("https://openlibrary.org/subjects/%s.json?limit=%d", subj, olPerSubject)
		var sr olSubjectResp
		if err := getJSONInto(hc, url, &sr); err != nil {
			log.Printf("gendemo: subject %q: %v (skipping)", subj, err)
			continue
		}
		for _, w := range sr.Works {
			if w.CoverID <= 0 || w.Title == "" || len(w.Authors) == 0 || w.Authors[0].Name == "" {
				continue
			}
			if seen[w.Key] || seenCover[w.CoverID] {
				continue
			}
			seen[w.Key] = true
			seenCover[w.CoverID] = true
			books = append(books, demoBook{
				id:     strconv.Itoa(w.CoverID),
				title:  w.Title,
				author: w.Authors[0].Name,
			})
		}
	}
	return books, nil
}

func getJSONInto(hc *http.Client, url string, v any) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", demoUserAgent)
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 512))
		return fmt.Errorf("HTTP %s", resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

// ---- listening-history synthesis ----

// synthSessions walks day-by-day over ~demoYears and emits one absSession per
// (book, day-listened). It feeds the real aggregate(): positions only ever move
// forward, a book reaching its duration finishes (fin), and a few are abandoned
// partway. Returns the sessions and the books that actually got used.
func synthSessions(candidates []demoBook, loc *time.Location, rng *rand.Rand) ([]absSession, map[string]demoBook) {
	now := time.Now().In(loc)
	today := time.Date(now.Year(), now.Month(), now.Day(), 12, 0, 0, 0, loc)
	start := today.AddDate(-demoYears, 0, 0)

	type active struct {
		b   demoBook
		pos float64
	}
	var actives []*active
	used := map[string]demoBook{}
	var sessions []absSession
	next := 0 // index into candidates

	for day := start; !day.After(today); day = day.AddDate(0, 0, 1) {
		// Start a new primary book on idle days (short gaps between books), or
		// occasionally pick up a concurrent second one.
		if len(actives) == 0 {
			if next < len(candidates) && rng.Float64() < 0.55 {
				b := candidates[next]
				next++
				b.durSec = (6 + rng.Float64()*14) * 3600 // 6–20 h
				actives = append(actives, &active{b: b})
			}
		} else if len(actives) < maxConcurrent && next < len(candidates) && rng.Float64() < 0.02 {
			b := candidates[next]
			next++
			b.durSec = (6 + rng.Float64()*14) * 3600
			actives = append(actives, &active{b: b})
		}

		if rng.Float64() < 0.18 { // rest day: no listening at all
			continue
		}

		kept := actives[:0]
		for _, a := range actives {
			if rng.Float64() >= 0.70 { // didn't get to this book today
				kept = append(kept, a)
				continue
			}
			prev := a.pos
			a.pos += listenSecs(rng)
			finished := a.pos >= a.b.durSec
			if finished {
				a.pos = a.b.durSec
			}
			sessions = append(sessions, mkSession(a.b, a.pos, a.pos-prev, day, loc, rng))
			used[a.b.id] = a.b
			if finished {
				continue // drop: done
			}
			if rng.Float64() < 0.012 { // abandoned partway
				continue
			}
			kept = append(kept, a)
		}
		actives = kept
	}
	return sessions, used
}

func listenSecs(rng *rand.Rand) float64 {
	s := 1800 + rng.Float64()*5400 // 0.5–2 h
	if rng.Float64() < 0.12 {
		s += rng.Float64() * 5400 // occasional binge
	}
	return math.Round(s)
}

func mkSession(b demoBook, pos, listened float64, day time.Time, loc *time.Location, rng *rand.Rand) absSession {
	ts := time.Date(day.Year(), day.Month(), day.Day(), 9+rng.Intn(12), rng.Intn(60), 0, 0, loc)
	return absSession{
		MediaType:     "book",
		LibraryItemID: b.id,
		DisplayTitle:  b.title,
		DisplayAuthor: b.author,
		Duration:      b.durSec,
		CurrentTime:   pos,
		TimeListening: listened,
		UpdatedAt:     ts.UnixMilli(),
		CreatedAt:     ts.UnixMilli(),
	}
}

// ---- static site assembly ----

func assembleSite(outDir string, data Data, used map[string]demoBook, hc *http.Client) error {
	if err := os.RemoveAll(outDir); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(outDir, "covers"), 0o755); err != nil {
		return err
	}

	// 1. copy the frontend (everything in public/ except index.html, which we rewrite)
	webDir := env("WEB_DIR", "public")
	if err := copyTreeExcept(webDir, outDir, "index.html"); err != nil {
		return fmt.Errorf("copy frontend: %w", err)
	}
	if err := writeDemoIndex(filepath.Join(webDir, "index.html"), filepath.Join(outDir, "index.html")); err != nil {
		return err
	}
	// Pages otherwise runs Jekyll, which can drop files; serve verbatim.
	if err := os.WriteFile(filepath.Join(outDir, ".nojekyll"), nil, 0o644); err != nil {
		return err
	}

	// 2. data.json (escape-HTML off to match the live server's encoder)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(data); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(outDir, "data.json"), buf.Bytes(), 0o644); err != nil {
		return err
	}

	// 3. covers for the books that actually appear
	coversDir := filepath.Join(outDir, "covers")
	ok, fail := 0, 0
	for id := range used {
		if err := downloadCover(hc, coversDir, id); err != nil {
			fail++
			continue
		}
		ok++
		time.Sleep(demoCoverDelay)
	}
	log.Printf("gendemo: covers downloaded %d, missing %d (missing show a placeholder)", ok, fail)
	return nil
}

// downloadCover fetches an Open Library cover by id, downscales it (reusing the
// production downscale()), and writes covers/<id>.jpg. ?default=false makes OL
// return 404 instead of a blank placeholder when it has no image.
func downloadCover(hc *http.Client, dir, coverID string) error {
	url := "https://covers.openlibrary.org/b/id/" + coverID + "-L.jpg?default=false"
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", demoUserAgent)
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 512))
		return fmt.Errorf("cover %s: HTTP %s", coverID, resp.Status)
	}
	src, _, err := image.Decode(resp.Body)
	if err != nil {
		return fmt.Errorf("decode cover %s: %w", coverID, err)
	}
	out := downscale(src, coverMaxEdge)
	tmp := filepath.Join(dir, coverID+".jpg.tmp")
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if err := jpeg.Encode(f, out, &jpeg.Options{Quality: 82}); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, coverID+".jpg"))
}

// writeDemoIndex copies index.html with two adjustments so it works as a static
// site under the Pages subpath: absolute asset refs become relative, and a small
// inline config points the frontend at the static data.json (and skips the sync poll).
func writeDemoIndex(srcPath, dstPath string) error {
	b, err := os.ReadFile(srcPath)
	if err != nil {
		return err
	}
	html := string(b)
	html = strings.ReplaceAll(html, `href="/style.css"`, `href="style.css"`)
	html = strings.ReplaceAll(html, `src="/js/app.js"`, `src="js/app.js"`)
	const cfg = "<script>window.__STATUS_URL=null;window.__DATA_URL=\"data.json\";</script>\n"
	html = strings.Replace(html, `<script type="module"`, cfg+`<script type="module"`, 1)
	return os.WriteFile(dstPath, []byte(html), 0o644)
}

// copyTreeExcept copies every file under src into dst, skipping a basename at the root.
func copyTreeExcept(src, dst, skipRoot string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if rel == skipRoot {
			return nil
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(path, target)
	})
}

func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
