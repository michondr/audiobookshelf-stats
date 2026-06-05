package main

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // ABS often serves webp covers
	_ "image/gif"               // register decoders
	_ "image/png"               //
)

const coverMaxEdge = 400 // longest-edge target for downscaled covers, px

// errCoverGone marks a cover that ABS no longer has (404) — typically a book
// deleted from the library. Such ids are recorded as a miss so we don't refetch
// them on every sync.
var errCoverGone = errors.New("cover not found")

func coverPath(dir, id string) string     { return filepath.Join(dir, id+".jpg") }
func coverMissPath(dir, id string) string { return filepath.Join(dir, id+".miss") }

// coverResolved reports whether we already have this cover, or have given up on
// it (a recorded permanent miss). Either way there's nothing more to fetch.
func coverResolved(dir, id string) bool {
	if _, err := os.Stat(coverPath(dir, id)); err == nil {
		return true
	}
	_, err := os.Stat(coverMissPath(dir, id))
	return err == nil
}

func markCoverMiss(dir, id string) {
	if f, err := os.Create(coverMissPath(dir, id)); err == nil {
		f.Close()
	}
}

// fetchCover downloads the ABS cover for itemID, downscales it so its longest
// edge is <= coverMaxEdge, and writes it as a JPEG to dir/<id>.jpg. Existing
// files are left untouched.
func (c *Client) fetchCover(ctx context.Context, dir, itemID string) error {
	dst := coverPath(dir, itemID)
	if _, err := os.Stat(dst); err == nil {
		return nil
	}
	// ABS content-negotiates the cover: without an Accept header it returns a
	// server-side JPEG conversion that is corrupt (flat green) for some covers,
	// while its webp original is fine. Ask for webp explicitly and decode that.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/items/"+itemID+"/cover", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "image/webp,image/*")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return errCoverGone
	}
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 512))
		return fmt.Errorf("cover %s: %s", itemID, resp.Status)
	}

	src, _, err := image.Decode(resp.Body)
	if err != nil {
		return fmt.Errorf("decode cover %s: %w", itemID, err)
	}
	out := downscale(src, coverMaxEdge)

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := dst + ".tmp"
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
	return os.Rename(tmp, dst)
}

// downscale returns src resized so its longest edge is at most maxEdge,
// preserving aspect ratio. Images already within bounds are returned as-is.
func downscale(src image.Image, maxEdge int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= maxEdge && h <= maxEdge {
		return src
	}
	nw, nh := w, h
	if w >= h {
		nw = maxEdge
		nh = int(float64(h) * float64(maxEdge) / float64(w))
	} else {
		nh = maxEdge
		nw = int(float64(w) * float64(maxEdge) / float64(h))
	}
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)
	return dst
}
