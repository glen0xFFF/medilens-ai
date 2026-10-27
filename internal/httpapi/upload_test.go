package httpapi

import (
	"bytes"
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/application"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

const sendPhotosMessage = `Send 1 to 3 photos in the "images" field.`

func TestAnUploadIsReadAsTheS1FixtureInMockMode(t *testing.T) {
	e := newEnv(t, envOptions{})
	id := accepted(t, e.upload(sharp(t)))
	st := e.wait(t, id)
	if st.Status != application.StateCompleted || st.Stage != pipeline.StageCompleted || !st.IsDemo {
		t.Fatalf("status %+v", st)
	}
	var r contracts.AnalysisResult
	decode(t, e.get("/api/v1/analyses/"+id+"/result"), &r)
	if !r.IsDemo || r.ID != id || r.Match.Status != contracts.MatchVerified || r.PipelineState != contracts.PipelineExplanationReady ||
		r.ImageRetention != contracts.ImageRetentionNone || !strings.HasPrefix(r.Explanation.SpokenChunks[0], "Demo data.") {
		t.Errorf("result %+v", r)
	}
	if r.Provenance == nil || *r.Provenance != (contracts.Provenance{Model: "mock", References: "fixture"}) {
		t.Errorf("provenance %+v", r.Provenance)
	}
}

func TestUpToThreeImagesAreAccepted(t *testing.T) {
	e := newEnv(t, envOptions{})
	id := accepted(t, e.upload(sharp(t), png(t), sharp(t)))
	if st := e.wait(t, id); st.Status != application.StateCompleted {
		t.Errorf("status %+v", st)
	}
}

func TestABlurryPhotoNeedsAttention(t *testing.T) {
	e := newEnv(t, envOptions{})
	id := accepted(t, e.upload(blurry(t)))
	if st := e.wait(t, id); st.Status != application.StateCompleted || st.Stage != pipeline.StageNeedsAttention {
		t.Fatalf("status %+v", st)
	}
	var r contracts.AnalysisResult
	decode(t, e.get("/api/v1/analyses/"+id+"/result"), &r)
	if r.PipelineState != contracts.PipelineLabelUnreadable || r.Label != nil || !contains(r.Quality.Reasons, contracts.QualityBlurry) {
		t.Errorf("result %+v", r)
	}
}

func contains[T comparable](xs []T, x T) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// Synchronous validation (Go port spec §4): 400, 413 or 415 before a job
// is accepted, with Node's codes and messages.
func TestUploadValidation(t *testing.T) {
	e := newEnv(t, envOptions{})
	img := sharp(t)
	nine := make([]byte, 9<<20)
	copy(nine, []byte{0xff, 0xd8, 0xff, 0xe0})
	over := make([]byte, 8<<20+1)
	copy(over, img)
	text := []byte("hello, this is not an image")
	field := func(name, value string) part { return part{field: name, body: []byte(value)} }
	file := func(name string, b []byte) part { return part{field: name, file: "a.jpg", body: b} }
	many := []part{file("images", img)}
	for i := range 11 {
		many = append(many, field("f"+string(rune('a'+i)), "x"))
	}

	cases := []struct {
		name    string
		parts   []part
		status  int
		code    contracts.ErrorCode
		message string
	}{
		{"only a text field", []part{field("note", "hello")}, 400, contracts.ErrValidationFailed, sendPhotosMessage},
		{"no parts", nil, 400, contracts.ErrValidationFailed, sendPhotosMessage},
		{"9 MB file", []part{file("images", nine)}, 413, contracts.ErrImageTooLarge, "Each photo must be 8 MB or smaller."},
		{"8 MiB + 1 byte", []part{file("images", over)}, 413, contracts.ErrImageTooLarge, "Each photo must be 8 MB or smaller."},
		{"4 files", []part{file("images", img), file("images", img), file("images", img), file("images", img)}, 400, contracts.ErrValidationFailed, sendPhotosMessage},
		{"a file under another field", []part{file("photo", img)}, 400, contracts.ErrValidationFailed, sendPhotosMessage},
		{"a file under another field after an image", []part{file("images", img), file("photo", img)}, 400, contracts.ErrValidationFailed, sendPhotosMessage},
		{"text file", []part{{field: "images", file: "notes.txt", body: text}}, 415, contracts.ErrInvalidImage, "Please send a JPEG, PNG or WebP photo."},
		{"text renamed .jpg", []part{file("images", text)}, 415, contracts.ErrInvalidImage, "Please send a JPEG, PNG or WebP photo."},
		{"an empty file", []part{file("images", nil)}, 415, contracts.ErrInvalidImage, "Please send a JPEG, PNG or WebP photo."},
		{"one bad among good", []part{file("images", img), file("images", text)}, 415, contracts.ErrInvalidImage, "Please send a JPEG, PNG or WebP photo."},
		{"11 text fields", many, 400, contracts.ErrValidationFailed, sendPhotosMessage},
		{"a field over 1 KB", []part{file("images", img), field("note", strings.Repeat("x", 1025))}, 400, contracts.ErrValidationFailed, sendPhotosMessage},
		{"a field name over 100 bytes", []part{file("images", img), field(strings.Repeat("n", 101), "x")}, 400, contracts.ErrValidationFailed, sendPhotosMessage},
		{"a text field named images", []part{field("images", "x")}, 400, contracts.ErrValidationFailed, sendPhotosMessage},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			body, ct := multipartBody(c.parts...)
			if msg := wantError(t, e.postRaw("/api/v1/analyses", ct, body), c.status, c.code); msg != c.message {
				t.Errorf("message %q", msg)
			}
		})
	}

	// what multer would still take: 10 fields of 1 KB beside the image
	ok := []part{file("images", img)}
	for i := range 10 {
		ok = append(ok, field("f"+string(rune('a'+i)), strings.Repeat("x", 1024)))
	}
	body, ct := multipartBody(ok...)
	accepted(t, e.postRaw("/api/v1/analyses", ct, body))

	for _, c := range []struct{ name, ct, body string }{
		{"no body", "", ""},
		{"JSON", "application/json", `{"images":[]}`},
		{"no boundary", "multipart/form-data", "--XYZ\r\n"},
		{"truncated", "multipart/form-data; boundary=XYZ", "--XYZ\r\nContent-Disposition: form-data; name=\"images\"; filename=\"a.jpg\"\r\nContent-Type: image/jpeg\r\n\r\nabc"},
		{"garbage", "multipart/form-data; boundary=XYZ", "not multipart at all"},
	} {
		if msg := wantError(t, e.postRaw("/api/v1/analyses", c.ct, []byte(c.body)), 400, contracts.ErrValidationFailed); msg != sendPhotosMessage {
			t.Errorf("%s: message %q", c.name, msg)
		}
	}
}

// The body is capped at 3 x 8 MiB + 64 KiB: a declared length over the cap
// is refused before anything is read, and an undeclared one (chunked) when
// the reader passes the cap.
func TestAnUploadOverTheBodyCapIsTooLarge(t *testing.T) {
	e := newEnv(t, envOptions{})
	body, ct := multipartBody(part{field: "images", file: "a.jpg", body: sharp(t)})
	r := httptest.NewRequest("POST", "/api/v1/analyses", bytes.NewReader(body))
	r.Header.Set("Content-Type", ct)
	r.ContentLength = maxUploadBody + 1
	wantError(t, e.do(r), 413, contracts.ErrImageTooLarge)

	img := make([]byte, 8<<20)
	copy(img, sharp(t))
	parts := []part{{field: "images", file: "a.jpg", body: img}, {field: "images", file: "b.jpg", body: img}, {field: "images", file: "c.jpg", body: img}}
	full, ct := multipartBody(append(parts, part{field: "images", file: strings.Repeat("f", 100<<10) + ".jpg", body: []byte("x")})...)
	r = httptest.NewRequest("POST", "/api/v1/analyses", io.MultiReader(bytes.NewReader(full)))
	r.Header.Set("Content-Type", ct)
	if r.ContentLength != -1 {
		t.Fatalf("ContentLength %d", r.ContentLength)
	}
	wantError(t, e.do(r), 413, contracts.ErrImageTooLarge)
}

func TestAnUndecodableImageFailsTheAnalysis(t *testing.T) {
	e := newEnv(t, envOptions{})
	img := sharp(t)
	id := accepted(t, e.upload(img[:len(img)/2]))
	if st := e.wait(t, id); st.Status != application.StateFailed || st.Stage != pipeline.StageFailed {
		t.Fatalf("status %+v", st)
	}
	w := e.get("/api/v1/analyses/" + id)
	var st application.Status
	decode(t, w, &st)
	if st.Error == nil || st.Error.Code != contracts.ErrInvalidImage || st.Error.Message != "Please send a JPEG, PNG or WebP photo." ||
		st.Error.RequestID != w.Header().Get("X-Request-Id") {
		t.Errorf("status error %+v", st.Error)
	}
	if msg := wantError(t, e.get("/api/v1/analyses/"+id+"/result"), 415, contracts.ErrInvalidImage); msg != "Please send a JPEG, PNG or WebP photo." {
		t.Errorf("message %q", msg)
	}
	wantError(t, e.postJSON("/api/v1/analyses/"+id+"/explanation", `{"question":"What strength is printed here?"}`), 415, contracts.ErrInvalidImage)
}

func TestAReaderFailureIsOCRFailed(t *testing.T) {
	reader := &countingReader{result: ai.ReadResult{Detail: "SECRET-invalid_output", Usage: ai.UsageEstimate}}
	live := liveProviders(reader, scenario(t, "s1-clear").Reference)
	e := newEnv(t, envOptions{providers: &live})
	id := accepted(t, e.upload(sharp(t)))
	e.wait(t, id)
	w := e.get("/api/v1/analyses/" + id + "/result")
	if msg := wantError(t, w, 502, contracts.ErrOCRFailed); msg != "I couldn't read the label right now. Please try again." {
		t.Errorf("message %q", msg)
	}
	if strings.Contains(w.Body.String(), "SECRET") || strings.Contains(e.logs.String(), "SECRET") {
		t.Error("the reader's detail leaked")
	}
}

type panicReader struct{}

func (panicReader) Read(context.Context, [][]byte) (ai.ReadResult, error) {
	panic("SECRET-reader-bug at reader.go:1")
}

func TestAReaderPanicIsAnInternalError(t *testing.T) {
	live := liveProviders(panicReader{}, scenario(t, "s1-clear").Reference)
	e := newEnv(t, envOptions{providers: &live})
	id := accepted(t, e.upload(sharp(t)))
	e.wait(t, id)
	w := e.get("/api/v1/analyses/" + id + "/result")
	if msg := wantError(t, w, 500, contracts.ErrInternal); msg != "Something went wrong. Please try again." {
		t.Errorf("message %q", msg)
	}
	if strings.Contains(e.logs.String(), "SECRET") {
		t.Error("the panic text reached the log")
	}
}

// Base spec §5.1: with the daily budget spent, a live upload is refused
// before the model is called, and the demo scenarios still work.
func TestAnExhaustedBudgetRefusesLiveUploadsOnly(t *testing.T) {
	reader := &countingReader{result: s1Read(t)}
	live := liveProviders(reader, scenario(t, "s1-clear").Reference)
	meter := pipeline.NewSpendMeter(5, time.Now)
	meter.Record(ai.Usage{PromptTokens: 4_000_000})
	e := newEnv(t, envOptions{providers: &live, meter: meter})
	msg := wantError(t, e.upload(sharp(t)), 503, contracts.ErrLiveBudgetExhausted)
	if !strings.Contains(strings.ToLower(msg), "demo mode") || reader.count() != 0 {
		t.Errorf("message %q, reads %d", msg, reader.count())
	}
	accepted(t, e.postJSON("/api/v1/demo/scenarios", `{"scenarioId":"s1-clear"}`))
}

// Go port spec §4: 2 workers and 8 queued; past that 503 RATE_LIMITED with
// Retry-After.
func TestAFullQueueIsRefusedWithRetryAfter(t *testing.T) {
	gate := newGate(s1Read(t))
	live := liveProviders(gate, scenario(t, "s1-clear").Reference)
	e := newEnv(t, envOptions{providers: &live, workers: 1, queue: 1})
	first := accepted(t, e.upload(sharp(t)))
	gate.waitStarted(t)
	accepted(t, e.upload(sharp(t)))
	w := e.upload(sharp(t))
	if msg := wantError(t, w, 503, contracts.ErrRateLimited); msg != "Too many requests. Please wait a minute and try again." {
		t.Errorf("message %q", msg)
	}
	if ra := w.Header().Get("Retry-After"); ra != "5" {
		t.Errorf("Retry-After %q", ra)
	}
	close(gate.release)
	e.wait(t, first)
}

/* ------------------------------------------------------------ never on disk */

// redirectTemp points os.TempDir() at a fresh empty directory.
func redirectTemp(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, k := range []string{"TMP", "TEMP", "TMPDIR"} {
		t.Setenv(k, dir)
	}
	if got := os.TempDir(); filepath.Clean(got) != filepath.Clean(dir) {
		t.Fatalf("os.TempDir() = %q, want %q", got, dir)
	}
	return dir
}

func entries(t *testing.T, dir string) []string {
	t.Helper()
	des, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, d := range des {
		names = append(names, d.Name())
	}
	return names
}

// largestUpload is three images of exactly 8 MiB: a real JPEG followed by
// zero padding (a decoder stops at the end-of-image marker).
func largestUpload(t *testing.T) ([]byte, string) {
	t.Helper()
	img := make([]byte, 8<<20)
	copy(img, sharp(t))
	return multipartBody(
		part{field: "images", file: "a.jpg", body: img},
		part{field: "images", file: "b.jpg", body: img},
		part{field: "images", file: "c.jpg", body: img},
	)
}

// Go port spec §4 (Uploads): the largest allowed upload goes through the
// API and its analysis runs to the end with the temp directory empty
// throughout: images are never written to disk.
func TestTheLargestUploadLeavesTheTempDirEmpty(t *testing.T) {
	dir := redirectTemp(t)
	e := newEnv(t, envOptions{})
	body, ct := largestUpload(t)
	id := accepted(t, e.postRaw("/api/v1/analyses", ct, body))
	if got := entries(t, dir); len(got) != 0 {
		t.Fatalf("temp dir after the upload: %v", got)
	}
	e.wait(t, id)
	if got := entries(t, dir); len(got) != 0 {
		t.Errorf("temp dir after the analysis: %v", got)
	}
}

// The negative control: the same body through ParseMultipartForm (what
// FormFile and FormValue call) is written to the temp directory, so the
// guard above can fail.
func TestParseMultipartFormWouldSpillTheSameUpload(t *testing.T) {
	dir := redirectTemp(t)
	body, ct := largestUpload(t)
	r := httptest.NewRequest("POST", "/api/v1/analyses", bytes.NewReader(body))
	r.Header.Set("Content-Type", ct)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		t.Fatal(err)
	}
	spilled := entries(t, dir)
	if err := r.MultipartForm.RemoveAll(); err != nil {
		t.Fatal(err)
	}
	if len(spilled) == 0 {
		t.Fatal("ParseMultipartForm wrote nothing: the guard test proves nothing")
	}
	t.Logf("ParseMultipartForm wrote %d temp files", len(spilled))
}

// bannedFormAccess are the request methods and fields that parse a
// multipart body into a form, writing file parts to disk (ReadForm is the
// multipart.Reader method they call).
var bannedFormAccess = map[string]bool{
	"ParseMultipartForm": true, "FormValue": true, "FormFile": true, "PostFormValue": true,
	"ParseForm": true, "MultipartForm": true, "PostForm": true, "Form": true, "ReadForm": true,
}

// formAccesses lists the banned selectors (x.FormFile, r.MultipartForm, ...)
// in a Go source.
func formAccesses(t *testing.T, name string, src any) []string {
	t.Helper()
	f, err := parser.ParseFile(token.NewFileSet(), name, src, 0)
	if err != nil {
		t.Fatal(err)
	}
	var found []string
	ast.Inspect(f, func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok && bannedFormAccess[sel.Sel.Name] {
			found = append(found, sel.Sel.Name)
		}
		return true
	})
	return found
}

// No code of this package (comments aside) touches a request's form
// parsing, so no upload can be spilled to disk by a helper.
func TestNoHandlerCanParseAMultipartForm(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		checked++
		if found := formAccesses(t, f, nil); len(found) > 0 {
			t.Errorf("%s uses %v", f, found)
		}
	}
	if checked < 6 {
		t.Errorf("checked %d files", checked)
	}
	// negative control: the check finds such a call
	bad := "package x\nfunc f(r *http.Request) { r.ParseMultipartForm(1); _, _, _ = r.FormFile(\"images\"); _ = r.MultipartForm }\n"
	if found := formAccesses(t, "bad.go", bad); len(found) != 3 {
		t.Errorf("the check missed calls: %v", found)
	}
}
