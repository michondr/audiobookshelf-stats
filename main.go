package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "time/tzdata" // embed the timezone database so TZ works on a bare image
)

type config struct {
	absURL  string
	absTok  string
	tz      string
	port    string
	webDir  string
	dataDir string
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadConfig() config {
	return config{
		absURL:  os.Getenv("ABS_URL"),
		absTok:  os.Getenv("ABS_TOKEN"),
		tz:      env("TZ", "UTC"),
		port:    env("PORT", "8080"),
		webDir:  env("WEB_DIR", "public"),
		dataDir: env("DATA_DIR", "data"),
	}
}

// status is the live sync state polled by the frontend loader.
type status struct {
	mu        sync.Mutex
	Ready     bool   `json:"ready"`
	Building  bool   `json:"building"`
	Fetched   int    `json:"sessionsFetched"`
	Message   string `json:"message"`
	Error     string `json:"error"`
	UpdatedAt string `json:"updatedAt"`
}

func (s *status) snapshot() status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return status{Ready: s.Ready, Building: s.Building, Fetched: s.Fetched, Message: s.Message, Error: s.Error, UpdatedAt: s.UpdatedAt}
}

func (s *status) set(f func(*status)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f(s)
}

func main() {
	cfg := loadConfig()
	if cfg.absURL == "" || cfg.absTok == "" {
		log.Fatal("ABS_URL and ABS_TOKEN are required")
	}
	loc, err := time.LoadLocation(cfg.tz)
	if err != nil {
		log.Fatalf("bad TZ %q: %v", cfg.tz, err)
	}

	if err := os.MkdirAll(cfg.dataDir, 0o755); err != nil {
		log.Fatalf("create data dir: %v", err)
	}
	coversDir := filepath.Join(cfg.dataDir, "covers")
	if err := os.MkdirAll(coversDir, 0o755); err != nil {
		log.Fatalf("create covers dir: %v", err)
	}

	store, err := openStore(cfg.dataDir)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer store.Close()

	st := &status{}
	if n, err := store.sessionCount(); err == nil && n > 0 {
		st.set(func(s *status) { s.Ready = true }) // serve existing data immediately
	}

	client := NewClient(cfg.absURL, cfg.absTok)
	syncer := newSyncer(client, store, coversDir, loc, st)

	// Kick an initial sync at startup; page loads trigger further (deduped) syncs.
	syncer.trigger()

	mux := http.NewServeMux()

	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(st.snapshot())
	})

	mux.HandleFunc("/api/data", func(w http.ResponseWriter, r *http.Request) {
		syncer.trigger() // refresh in the background for next time
		sessions, err := store.bookSessions()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		enc := json.NewEncoder(w)
		enc.SetEscapeHTML(false)
		enc.Encode(aggregate(sessions, loc))
	})

	mux.Handle("/covers/", http.StripPrefix("/covers/",
		cacheControl(http.FileServer(http.Dir(coversDir)), "public, max-age=86400")))

	// Static frontend; visiting it nudges a background refresh.
	// no-cache (not no-store) lets the browser keep a copy but forces it to revalidate every load,
	// so edits to index.html/CSS/JS show up on a normal reload instead of being heuristically cached.
	fs := http.FileServer(http.Dir(cfg.webDir))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			syncer.trigger()
		}
		w.Header().Set("Cache-Control", "no-cache")
		fs.ServeHTTP(w, r)
	}))

	log.Printf("listening on :%s (tz=%s, data=%s)", cfg.port, loc, cfg.dataDir)
	if err := http.ListenAndServe(":"+cfg.port, mux); err != nil {
		log.Fatal(err)
	}
}

func cacheControl(h http.Handler, v string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", v)
		h.ServeHTTP(w, r)
	})
}
