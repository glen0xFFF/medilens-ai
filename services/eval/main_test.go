package main

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/medilens-ai/medilens/internal/metaapi"
	"github.com/medilens-ai/medilens/internal/parity"
)

// No network: the Meta Model API is a local fake serving the recorded
// synthetic label-ok completion (DEMO DATA, fictional product).

func jpegBytes(t *testing.T) []byte {
	t.Helper()
	img := image.NewGray(image.Rect(0, 0, 64, 48))
	for y := 0; y < 48; y++ {
		for x := 0; x < 64; x++ {
			img.SetGray(x, y, color.Gray{Y: uint8((x * 4) ^ (y * 5))})
		}
	}
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

type fakeMeta struct {
	srv  *httptest.Server
	mu   sync.Mutex
	auth []string
}

func newFakeMeta(t *testing.T, fixture string) *fakeMeta {
	t.Helper()
	dir, err := parity.Dir()
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, "providers", "muse", fixture+".json"))
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeMeta{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		f.mu.Lock()
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeMeta) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.auth...)
}

// the label-ok fixture's values, so a faithful read scores all correct
const goodTruth = `{"packId":"pack-01","images":["front.jpg"],"brandName":"Paracelin 500","genericNames":["Paracetamol"],"strength":"500 mg","dosageForm":"Tablet","registrationNumber":"DR-XY12345","expiryDate":"%s"}`

func writePack(t *testing.T, root, id, truth string, images map[string][]byte) {
	t.Helper()
	dir := filepath.Join(root, "eval", "packs", id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "truth.json"), []byte(truth), 0o644); err != nil {
		t.Fatal(err)
	}
	for name, b := range images {
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func newRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

type result struct {
	code           int
	stdout, stderr string
}

func runEval(t *testing.T, root string, getenv func(string) string, meta *fakeMeta) result {
	t.Helper()
	var out, errOut bytes.Buffer
	d := deps{now: func() time.Time { return time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC) }}
	if meta != nil {
		d.meta = []metaapi.Option{metaapi.WithBaseURL(meta.srv.URL)}
	}
	code := run(context.Background(), root, getenv, &out, &errOut, d)
	return result{code, out.String(), errOut.String()}
}

func TestNoPacks(t *testing.T) {
	root := newRoot(t)
	r := runEval(t, root, env(nil), nil)
	if r.code != 0 || strings.TrimSpace(r.stdout) != "No packs found" {
		t.Fatalf("got %+v", r)
	}
	if _, err := os.Stat(filepath.Join(root, "docs", "eval-results.md")); !os.IsNotExist(err) {
		t.Error("results written with no packs")
	}
}

func TestKeyRequired(t *testing.T) {
	root := newRoot(t)
	writePack(t, root, "pack-01", strings.Replace(goodTruth, "%s", "12/2027", 1), map[string][]byte{"front.jpg": jpegBytes(t)})
	r := runEval(t, root, env(map[string]string{"MODEL_API_KEY": "   "}), nil)
	if r.code != 1 || !strings.Contains(r.stderr, "MODEL_API_KEY is not set") {
		t.Fatalf("got %+v", r)
	}
}

func TestInvalidSpendCap(t *testing.T) {
	root := newRoot(t)
	writePack(t, root, "pack-01", strings.Replace(goodTruth, "%s", "12/2027", 1), map[string][]byte{"front.jpg": jpegBytes(t)})
	r := runEval(t, root, env(map[string]string{"MODEL_API_KEY": "k", "DAILY_SPEND_CAP_USD": "lots"}), nil)
	if r.code != 1 || !strings.Contains(r.stderr, "DAILY_SPEND_CAP_USD") {
		t.Fatalf("got %+v", r)
	}
}

func TestScoresPacksAndWritesCountsOnly(t *testing.T) {
	root := newRoot(t)
	img := jpegBytes(t)
	writePack(t, root, "pack-01", strings.Replace(goodTruth, "%s", "12/2027", 1), map[string][]byte{"front.jpg": img})
	writePack(t, root, "pack-02", `{"packId":"pack-02"}`, nil)
	writePack(t, root, "pack-03", strings.Replace(strings.Replace(goodTruth, "%s", "12/2027", 1), "pack-01", "pack-03", 1), nil) // image missing
	writePack(t, root, "pack-04", strings.Replace(strings.Replace(goodTruth, "%s", "12/2027", 1), `"front.jpg"`, `"../front.jpg"`, 1), nil)
	writePack(t, root, "pack-05", strings.Replace(goodTruth, "%s", "12/2027", 1), map[string][]byte{"front.jpg": []byte("not an image")})
	// a folder without truth.json is not a pack
	if err := os.MkdirAll(filepath.Join(root, "eval", "packs", "notes"), 0o755); err != nil {
		t.Fatal(err)
	}
	meta := newFakeMeta(t, "label-ok")
	r := runEval(t, root, env(map[string]string{"MODEL_API_KEY": " test-key "}), meta)
	if r.code != 0 {
		t.Fatalf("code %d\nstdout:\n%s\nstderr:\n%s", r.code, r.stdout, r.stderr)
	}
	if calls := meta.calls(); len(calls) != 1 || calls[0] != "Bearer test-key" {
		t.Errorf("model calls %q, want one with the trimmed key", calls)
	}
	for _, s := range []string{
		"Scored pack-01",
		"Packs found: 5   attempted: 5   scored: 1   skipped: 4   Spent: $",
		"No confidently-wrong fields.",
		"Bar (zero confidently-wrong strengths or expiry dates): MET",
	} {
		if !strings.Contains(r.stdout, s) {
			t.Errorf("stdout lacks %q:\n%s", s, r.stdout)
		}
	}
	for _, s := range []string{
		"Skipped pack-02: images: Invalid input: expected array, received undefined",
		"Skipped pack-03: missing image front.jpg",
		"Skipped pack-04: images must be file names inside the pack folder",
		"Skipped pack-05: front.jpg: INVALID_IMAGE",
	} {
		if !strings.Contains(r.stderr, s) {
			t.Errorf("stderr lacks %q:\n%s", s, r.stderr)
		}
	}
	md, err := os.ReadFile(filepath.Join(root, "docs", "eval-results.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"Run date: 2026-10-30.", "Packs found: 5. Attempted: 5. Scored: 1. Skipped: 4.", "Not a clean run", "| strength | 1 | 1 | 0 | 0 |", ": MET."} {
		if !strings.Contains(string(md), s) {
			t.Errorf("results lack %q:\n%s", s, md)
		}
	}
	for _, s := range []string{"pack-01", "Paracelin", "DR-XY"} {
		if strings.Contains(string(md), s) {
			t.Errorf("results contain %q", s)
		}
	}
}

func TestBarMissedExitsTwo(t *testing.T) {
	root := newRoot(t)
	writePack(t, root, "pack-01", strings.Replace(goodTruth, "%s", "11/2027", 1), map[string][]byte{"front.jpg": jpegBytes(t)})
	meta := newFakeMeta(t, "label-ok")
	r := runEval(t, root, env(map[string]string{"MODEL_API_KEY": "test-key"}), meta)
	if r.code != 2 {
		t.Fatalf("code %d\nstdout:\n%s\nstderr:\n%s", r.code, r.stdout, r.stderr)
	}
	want := `  pack-01  expiryDate  read: "EXP 12/2027"`
	if !strings.Contains(r.stdout, want) || !strings.Contains(r.stdout, "NOT MET") {
		t.Errorf("stdout lacks %q / NOT MET:\n%s", want, r.stdout)
	}
}

func TestSpendCapStopsBeforeAPack(t *testing.T) {
	root := newRoot(t)
	writePack(t, root, "pack-01", strings.Replace(goodTruth, "%s", "12/2027", 1), map[string][]byte{"front.jpg": jpegBytes(t)})
	meta := newFakeMeta(t, "label-ok")
	r := runEval(t, root, env(map[string]string{"MODEL_API_KEY": "test-key", "DAILY_SPEND_CAP_USD": "0"}), meta)
	if r.code != 1 || !strings.Contains(r.stderr, "Daily spend cap of $0 reached; stopping before pack pack-01.") ||
		!strings.Contains(r.stderr, "No pack could be scored; docs/eval-results.md was not written.") {
		t.Fatalf("got %+v", r)
	}
	if len(meta.calls()) != 0 {
		t.Error("a model call was made past the cap")
	}
}

func TestOCRFailureIsSkipped(t *testing.T) {
	root := newRoot(t)
	writePack(t, root, "pack-01", strings.Replace(goodTruth, "%s", "12/2027", 1), map[string][]byte{"front.jpg": jpegBytes(t)})
	meta := newFakeMeta(t, "label-contributor")
	r := runEval(t, root, env(map[string]string{"MODEL_API_KEY": "test-key"}), meta)
	if r.code != 1 || !strings.Contains(r.stderr, "Skipped pack-01: OCR_FAILED (contributor_model)") {
		t.Fatalf("got %+v", r)
	}
}

func TestJSONString(t *testing.T) {
	// JSON.stringify: no HTML escaping, U+2028 left as is
	got := jsonString("a<b>&\"\u2028")
	if got != "\"a<b>&\\\"\u2028\"" {
		t.Errorf("jsonString = %q", got)
	}
}
