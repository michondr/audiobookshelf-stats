# audiobookshelf stats heatmap

A GitHub-contributions-style heatmap of your [Audiobookshelf](https://www.audiobookshelf.org/) listening history. Zoom from a year-at-a-glance overview all the way down to per-day cards showing covers, progress, and time listened.

**🔎 Live demo:** https://michondr.github.io/audiobookshelf-stats/
*(demo data is synthetic — real books & covers from [Open Library](https://openlibrary.org/), ~14 months of generated listening)*

## What it does

- Pulls your listening sessions from your Audiobookshelf server and stores them in SQLite.
- Buckets them by calendar day and renders a zoomable timeline:
  **year overview → heatmap → finished books → covers → compact → full detail.**
- Downloads and downscales book covers locally.
- Syncs in the background on each page load — no cron needed.

## Run it

A single Go container serves both the frontend and API.

```sh
cp .env.example .env   # fill in ABS_URL, ABS_TOKEN, and optionally ABS_PUBLIC_URL
docker compose up -d
```

**Using the pre-built image** — no local build needed, works on amd64 and arm64:

```yaml
# docker-compose.yml
services:
  abs-stats:
    image: ghcr.io/michondr/audiobookshelf-stats:latest
    container_name: abs-stats
    restart: unless-stopped
    user: "${PUID:-1000}:${PGID:-1000}"
    environment:
      ABS_URL: ${ABS_URL}
      ABS_PUBLIC_URL: ${ABS_PUBLIC_URL:-}
      ABS_TOKEN: ${ABS_TOKEN}
      TZ: ${TZ:-Europe/Prague}
      PORT: ${PORT:-8080}
      DATA_DIR: ${DATA_DIR:-/data}
    volumes:
      - ./data:/data
    ports:
      - "8080:8080"
```

**Building locally** — swap `image:` for `build: .` (or use the included `docker-compose.yml` which does this by default).

## Demo

`go run . -gendemo dist` builds the static demo into `dist/` (book list + covers fetched live from Open Library, ~14 months of listening synthesized through the same aggregation as production). On every push, `.github/workflows/demo.yml` builds it and publishes to GitHub Pages.
