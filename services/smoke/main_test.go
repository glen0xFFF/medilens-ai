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
	"sync/atomic"
	"testing"

	"github.com/medilens-ai/medilens/internal/metaapi"
	"github.com/medilens-ai/medilens/internal/parity"
)

// No network: Muse Spark and PH FDA are local fakes serving the recorded
// synthetic fixtures (DEMO DATA, fictional products).

func writeJPEG(t *testing.T) string {
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
	p := filepath.Join(t.TempDir(), "label.jpg")
	if err := os.WriteFile(p, b.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func serveFixture(t *testing.T, parts ...string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	dir, err := parity.Dir()
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(append([]string{dir, "providers"}, parts...)...))
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

type result struct {
	code           int
	stdout, stderr string
}

func runSmoke(t *testing.T, args []string, env map[string]string, meta, fda *httptest.Server) result {
	t.Helper()
	var out, errOut bytes.Buffer
	d := deps{}
	if meta != nil {
		d.meta = []metaapi.Option{metaapi.WithBaseURL(meta.URL)}
	}
	if fda != nil {
		d.phfdaURL = fda.URL + "/api/search?q="
	}
	code := run(context.Background(), args, func(k string) string { return env[k] }, &out, &errOut, d)
	return result{code, out.String(), errOut.String()}
}

func TestUsage(t *testing.T) {
	r := runSmoke(t, nil, nil, nil, nil)
	if r.code != 1 || !strings.Contains(r.stderr, "Usage: go run ./services/smoke <image> [fda-search-term]") {
		t.Fatalf("got %+v", r)
	}
}

func TestKeyRequired(t *testing.T) {
	r := runSmoke(t, []string{writeJPEG(t)}, map[string]string{"MODEL_API_KEY": " "}, nil, nil)
	if r.code != 1 || !strings.Contains(r.stderr, "MODEL_API_KEY is not set. The live smoke test needs it.") {
		t.Fatalf("got %+v", r)
	}
}

func TestImageChecks(t *testing.T) {
	key := map[string]string{"MODEL_API_KEY": "test-key"}
	r := runSmoke(t, []string{filepath.Join(t.TempDir(), "none.jpg")}, key, nil, nil)
	if r.code != 1 || !strings.Contains(r.stderr, "Image file not found.") {
		t.Fatalf("missing: %+v", r)
	}
	bad := filepath.Join(t.TempDir(), "bad.jpg")
	if err := os.WriteFile(bad, []byte("not an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	r = runSmoke(t, []string{bad}, key, nil, nil)
	if r.code != 1 || !strings.Contains(r.stderr, "Image rejected: INVALID_IMAGE") {
		t.Fatalf("invalid: %+v", r)
	}
}

func TestMetadataOnly(t *testing.T) {
	meta, _ := serveFixture(t, "muse", "label-ok.json")
	fda, fdaCalls := serveFixture(t, "phfda", "search-paracelin.json")
	r := runSmoke(t, []string{writeJPEG(t), "paracelin"}, map[string]string{"MODEL_API_KEY": "test-key"}, meta, fda)
	if r.code != 0 {
		t.Fatalf("code %d\nstdout:\n%s\nstderr:\n%s", r.code, r.stdout, r.stderr)
	}
	for _, s := range []string{
		"Muse Spark call 1: model=muse-spark-1.3 finish_reason=stop prompt_tokens=1800 completion_tokens=420 total_tokens=2220 reasoning_tokens=not reported",
		"Label read: ok (imageKind=label, fields with a value: 10/12, clear: 11)",
		"PH FDA request 1: HTTP 200; top-level keys: ",
		"PH FDA lookup: ok (records: ",
	} {
		if !strings.Contains(r.stdout, s) {
			t.Errorf("stdout lacks %q:\n%s", s, r.stdout)
		}
	}
	if fdaCalls.Load() != 1 {
		t.Errorf("PH FDA calls %d, want 1", fdaCalls.Load())
	}
	for _, s := range []string{"Paracelin", "Paracetamol", "DR-XY", "Demo Pharma"} {
		if strings.Contains(r.stdout+r.stderr, s) {
			t.Errorf("output contains the value %q:\n%s", s, r.stdout)
		}
	}
}

func TestContributorAborts(t *testing.T) {
	meta, _ := serveFixture(t, "muse", "label-contributor.json")
	fda, fdaCalls := serveFixture(t, "phfda", "search-paracelin.json")
	r := runSmoke(t, []string{writeJPEG(t)}, map[string]string{"MODEL_API_KEY": "test-key"}, meta, fda)
	if r.code != 3 || !strings.Contains(r.stdout, "ABORT: a contributor model served this request") {
		t.Fatalf("got %+v", r)
	}
	if fdaCalls.Load() != 0 {
		t.Error("PH FDA was called after an abort")
	}
}

// Final review I2 ruling: an empty response model aborts with exit 3, as
// the spec says (Go port spec §3), and PH FDA is never called.
func TestEmptyModelAborts(t *testing.T) {
	dir, err := parity.Dir()
	if err != nil {
		t.Fatal(err)
	}
	ok, err := os.ReadFile(filepath.Join(dir, "providers", "muse", "label-ok.json"))
	if err != nil {
		t.Fatal(err)
	}
	body := bytes.Replace(ok, []byte(`"model": "muse-spark-1.3"`), []byte(`"model": ""`), 1)
	if bytes.Equal(body, ok) {
		t.Fatal("label-ok.json has no model to blank")
	}
	meta := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(meta.Close)
	fda, fdaCalls := serveFixture(t, "phfda", "search-paracelin.json")
	r := runSmoke(t, []string{writeJPEG(t)}, map[string]string{"MODEL_API_KEY": "test-key"}, meta, fda)
	if r.code != 3 || !strings.Contains(r.stdout, "model= finish_reason") || !strings.Contains(r.stdout, "ABORT:") {
		t.Fatalf("got %+v", r)
	}
	if fdaCalls.Load() != 0 {
		t.Error("PH FDA was called after an abort")
	}
}

func TestInvalidRepoURL(t *testing.T) {
	meta, _ := serveFixture(t, "muse", "label-ok.json")
	r := runSmoke(t, []string{writeJPEG(t)}, map[string]string{"MODEL_API_KEY": "test-key", "PUBLIC_REPO_URL": "not a url"}, meta, nil)
	if r.code != 1 || !strings.Contains(r.stderr, "PUBLIC_REPO_URL") {
		t.Fatalf("got %+v", r)
	}
}
