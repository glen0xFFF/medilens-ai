package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/domain"
	"github.com/medilens-ai/medilens/internal/parity"
	"github.com/medilens-ai/medilens/internal/references"
)

// Ports apps/server/test/pipeline/analyze.test.ts (analyzeImages,
// analyzeScenario, final review I2), plus the Go stage events. All label
// and registry data here is synthetic DEMO DATA with fictional names.

const notEnoughText = "Not enough clear text to search the registry."

var (
	imageOnce  sync.Once
	sharpJPEG  []byte
	blurredJPG []byte
	imageErr   error
)

// testImages are the Node test images (helpers/images.ts sharpJpeg and
// blurredJpeg), recorded in fixtures/parity/images.
func testImages(t testing.TB) (sharp, blurred []byte) {
	t.Helper()
	imageOnce.Do(func() {
		dir, err := parity.Dir()
		if err != nil {
			imageErr = err
			return
		}
		if sharpJPEG, err = os.ReadFile(filepath.Join(dir, "images", "sharp.jpg")); err != nil {
			imageErr = err
			return
		}
		blurredJPG, imageErr = os.ReadFile(filepath.Join(dir, "images", "blurred.jpg"))
	})
	if imageErr != nil {
		t.Fatal(imageErr)
	}
	return sharpJPEG, blurredJPG
}

func lf(key contracts.FieldKey, value *string, legibility contracts.Legibility) contracts.LabelField {
	return contracts.LabelField{Key: key, Value: value, Legibility: legibility, EvidenceText: value, ImageIndex: contracts.Ptr(0)}
}

func clear(key contracts.FieldKey, value string) contracts.LabelField {
	return lf(key, contracts.Ptr(value), contracts.LegibilityClear)
}

func testLabel(kind contracts.ImageKind, fields ...contracts.LabelField) contracts.ExtractedLabel {
	if fields == nil {
		fields = []contracts.LabelField{}
	}
	return contracts.ExtractedLabel{ImageKind: kind, Fields: fields, RawText: "DEMO DATA", Warnings: []string{}}
}

func paracelin() contracts.ExtractedLabel {
	return testLabel(contracts.ImageKindLabel,
		clear(contracts.FieldBrandName, "Paracelin 500"),
		clear(contracts.FieldGenericNames, "Paracetamol"),
		clear(contracts.FieldStrength, "500 mg"),
		clear(contracts.FieldDosageForm, "Tablet"),
		clear(contracts.FieldRegistrationNumber, "dr-xy 900001"),
	)
}

func testRecord() contracts.ReferenceRecord {
	return contracts.ReferenceRecord{
		Provider:           "demo-fixture",
		SourceURL:          "https://verification.fda.gov.ph/?q=DR-XY900001",
		RegistrationNumber: "DR-XY900001",
		BrandName:          contracts.Ptr("Paracelin 500"),
		GenericName:        contracts.Ptr("Paracetamol"),
		StrengthForm:       contracts.Ptr("500 mg Tablet"),
		RegistrationExpiry: contracts.Ptr("2030-12-31"),
		CheckedAt:          "2026-10-27T00:00:00.000Z",
	}
}

func okSearch(records ...contracts.ReferenceRecord) contracts.SearchResult {
	return contracts.SearchResult{Kind: contracts.SearchOK, Records: records, Advisories: []contracts.Advisory{}}
}

type stubReader struct {
	mu     sync.Mutex
	calls  [][][]byte
	result ai.ReadResult
	// wait, when set, blocks Read until ctx ends.
	wait bool
}

func (r *stubReader) Read(ctx context.Context, images [][]byte) (ai.ReadResult, error) {
	r.mu.Lock()
	r.calls = append(r.calls, images)
	res := r.result
	r.mu.Unlock()
	if r.wait {
		<-ctx.Done()
		return ai.ReadResult{Usage: ai.Usage{PromptTokens: 7}}, ctx.Err()
	}
	b, _ := json.Marshal(res.Label)
	var copied contracts.ExtractedLabel
	_ = json.Unmarshal(b, &copied)
	res.Label = copied
	return res, nil
}

func (r *stubReader) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

type stubRefs struct {
	mu     sync.Mutex
	calls  []references.Query
	result contracts.SearchResult
	panics bool
	// cancel, when set, is called during Search (a lookup cut off by a
	// cancelled job), and Search then reports unavailable.
	cancel context.CancelFunc
}

func (s *stubRefs) Search(_ context.Context, q references.Query) contracts.SearchResult {
	s.mu.Lock()
	s.calls = append(s.calls, q)
	s.mu.Unlock()
	if s.panics {
		panic("socket hang up")
	}
	if s.cancel != nil {
		s.cancel()
		return contracts.SearchResult{Kind: contracts.SearchUnavailable, Reason: "PH FDA lookup failed: aborted"}
	}
	return s.result
}

func (s *stubRefs) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.calls)
}

type recorder struct {
	mu     sync.Mutex
	stages []Stage
	usage  ai.Usage
}

func (r *recorder) emit(s Stage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stages = append(r.stages, s)
}

func (r *recorder) record(u ai.Usage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.usage = r.usage.Add(u)
}

func (r *recorder) seen() []Stage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.stages)
}

type setup struct {
	deps   Deps
	reader *stubReader
	refs   *stubRefs
	rec    *recorder
}

func newSetup(read *ai.ReadResult, search *contracts.SearchResult) *setup {
	r := ai.ReadResult{OK: true, Label: paracelin(), Model: "muse-spark-1.3"}
	if read != nil {
		r = *read
	}
	sr := okSearch(testRecord())
	if search != nil {
		sr = *search
	}
	s := &setup{reader: &stubReader{result: r}, refs: &stubRefs{result: sr}, rec: &recorder{}}
	s.deps = Deps{
		Reader:     s.reader,
		References: s.refs,
		Now:        fixed(t0),
		TTL:        fifteenMin,
		Emit:       s.rec.emit,
		OnUsage:    s.rec.record,
	}
	return s
}

func okRead(l contracts.ExtractedLabel) *ai.ReadResult {
	return &ai.ReadResult{OK: true, Label: l, Model: "muse-spark-1.3"}
}

func jsonOf(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func wantCode(t *testing.T, err error, code contracts.ErrorCode) *Error {
	t.Helper()
	var pe *Error
	if !errors.As(err, &pe) {
		t.Fatalf("error %v, want a pipeline error %s", err, code)
	}
	if pe.Code != code {
		t.Fatalf("code %s, want %s", pe.Code, code)
	}
	if pe.Message == "" {
		t.Errorf("%s has no message", code)
	}
	return pe
}

func analyze(t *testing.T, s *setup, images ...[]byte) contracts.AnalysisResult {
	t.Helper()
	r, err := AnalyzeImages(context.Background(), "id-1", images, s.deps)
	if err != nil {
		t.Fatalf("analyze: %v", err)
	}
	return r
}

func TestAnalyzeImagesHappyPath(t *testing.T) {
	sharp, _ := testImages(t)
	s := newSetup(nil, nil)
	r := analyze(t, s, sharp)

	if r.ID != "id-1" || r.IsDemo || r.ImageRetention != contracts.ImageRetentionNone ||
		r.PipelineState != contracts.PipelineExplanationReady || !r.Quality.OK {
		t.Fatalf("result %+v", r)
	}
	if jsonOf(t, r.Label) != jsonOf(t, paracelin()) {
		t.Errorf("label %s", jsonOf(t, r.Label))
	}
	if r.Match.Status != contracts.MatchVerified {
		t.Errorf("status %s", r.Match.Status)
	}
	if r.CreatedAt != "2026-10-27T08:00:00.000Z" || r.ExpiresAt != "2026-10-27T08:15:00.000Z" {
		t.Errorf("times %s %s", r.CreatedAt, r.ExpiresAt)
	}
	if chunks := r.Explanation.SpokenChunks; chunks[len(chunks)-1] != domain.FinalLine {
		t.Errorf("last chunk %q", chunks[len(chunks)-1])
	}
	if !strings.Contains(r.Explanation.DisplayText, "Paracelin 500") {
		t.Errorf("display %q", r.Explanation.DisplayText)
	}
	if s.reader.count() != 1 || s.refs.count() != 1 {
		t.Errorf("calls read %d search %d", s.reader.count(), s.refs.count())
	}
	if q := s.refs.calls[0]; q != (references.Query{RegistrationNumber: "DR-XY900001", Name: "Paracelin 500"}) {
		t.Errorf("query %+v", q)
	}
	if r.Provenance != nil {
		t.Errorf("provenance %+v without deps.Provenance", r.Provenance)
	}
	want := []Stage{StageQuality, StageReading, StageReviewingFields, StageCheckingReferences, StageComparing, StageExplaining}
	if got := s.rec.seen(); !slices.Equal(got, want) {
		t.Errorf("stages %v", got)
	}
}

func TestAnalyzeImagesPassesTheReaderNormalisedJPEGsOnePerImage(t *testing.T) {
	sharp, _ := testImages(t)
	s := newSetup(nil, nil)
	analyze(t, s, sharp, sharp)
	call := s.reader.calls[0]
	if len(call) != 2 {
		t.Fatalf("%d images", len(call))
	}
	for _, img := range call {
		if len(img) < 3 || img[0] != 0xFF || img[1] != 0xD8 || img[2] != 0xFF {
			t.Error("not a JPEG")
		}
	}
}

func TestAnalyzeImagesIsDemoAndProvenanceFollowDeps(t *testing.T) {
	sharp, _ := testImages(t)
	s := newSetup(nil, nil)
	s.deps.IsDemo = true
	s.deps.Provenance = &contracts.Provenance{Model: ai.MockModel, References: "fixture"}
	r := analyze(t, s, sharp)
	if !r.IsDemo || r.Provenance == nil || *r.Provenance != (contracts.Provenance{Model: "mock", References: "fixture"}) {
		t.Errorf("isDemo %v provenance %+v", r.IsDemo, r.Provenance)
	}
	s.deps.Provenance.Model = "changed"
	if r.Provenance.Model != "mock" {
		t.Error("the result shares the deps provenance")
	}
}

func TestAnalyzeImagesBlurryPhotoIsLabelUnreadableWithoutReaderOrRegistry(t *testing.T) {
	_, blurred := testImages(t)
	s := newSetup(nil, nil)
	r := analyze(t, s, blurred)
	if s.reader.count() != 0 || s.refs.count() != 0 {
		t.Errorf("calls read %d search %d", s.reader.count(), s.refs.count())
	}
	if r.PipelineState != contracts.PipelineLabelUnreadable || r.Label != nil || r.Quality.OK ||
		!slices.Contains(r.Quality.Reasons, contracts.QualityBlurry) {
		t.Fatalf("result %s", jsonOf(t, r))
	}
	if r.Match.Status != contracts.MatchNotAttempted || !slices.Equal(r.Match.Limitations, []string{"Registry lookup was not attempted."}) {
		t.Errorf("match %+v", r.Match)
	}
	if !strings.Contains(r.Explanation.DisplayText, "The photo is blurry.") {
		t.Errorf("display %q", r.Explanation.DisplayText)
	}
	if chunks := r.Explanation.SpokenChunks; chunks[len(chunks)-1] != domain.FinalLine {
		t.Errorf("last chunk %q", chunks[len(chunks)-1])
	}
	if got := s.rec.seen(); !slices.Equal(got, []Stage{StageQuality, StageExplaining}) {
		t.Errorf("stages %v", got)
	}
}

func TestAnalyzeImagesOneBlurryPhotoAmongSharpOnesFailsTheWholeScan(t *testing.T) {
	sharp, blurred := testImages(t)
	s := newSetup(nil, nil)
	r := analyze(t, s, sharp, blurred)
	if s.reader.count() != 0 || r.PipelineState != contracts.PipelineLabelUnreadable ||
		!slices.Contains(r.Quality.Reasons, contracts.QualityBlurry) {
		t.Errorf("reads %d result %s", s.reader.count(), jsonOf(t, r))
	}
}

func TestAnalyzeImagesLoosePillHasNoLookup(t *testing.T) {
	sharp, _ := testImages(t)
	pill := testLabel(contracts.ImageKindLoosePill, lf(contracts.FieldBrandName, nil, contracts.LegibilityUnreadable))
	s := newSetup(okRead(pill), nil)
	r := analyze(t, s, sharp)
	if s.refs.count() != 0 || r.PipelineState != contracts.PipelineLoosePill || r.Match.Status != contracts.MatchNotAttempted {
		t.Fatalf("search %d result %s", s.refs.count(), jsonOf(t, r))
	}
	if !slices.Contains(r.Explanation.SpokenChunks, domain.LoosePillSentence) ||
		!slices.Contains(r.Explanation.SafetyNotices, domain.LoosePillSentence) {
		t.Errorf("explanation %+v", r.Explanation)
	}
	if got := s.rec.seen(); !slices.Equal(got, []Stage{StageQuality, StageReading, StageReviewingFields, StageExplaining}) {
		t.Errorf("stages %v", got)
	}
}

func TestAnalyzeImagesNotMedicineHasNoLookup(t *testing.T) {
	sharp, _ := testImages(t)
	s := newSetup(okRead(testLabel(contracts.ImageKindNotMedicine)), nil)
	r := analyze(t, s, sharp)
	if s.refs.count() != 0 || r.PipelineState != contracts.PipelineNotALabel || r.Match.Status != contracts.MatchNotAttempted {
		t.Fatalf("search %d result %s", s.refs.count(), jsonOf(t, r))
	}
	if domain.NotALabelSentence != "I couldn't find a medicine label in this photo." ||
		!slices.Contains(r.Explanation.SpokenChunks, domain.NotALabelSentence) {
		t.Errorf("chunks %v", r.Explanation.SpokenChunks)
	}
}

func TestAnalyzeImagesReaderUnreadableKeepsTheLabelWithTextEmptied(t *testing.T) {
	sharp, _ := testImages(t)
	unreadable := testLabel(contracts.ImageKindUnreadable)
	s := newSetup(okRead(unreadable), nil)
	r := analyze(t, s, sharp)
	want := unreadable
	want.RawText = ""
	if s.refs.count() != 0 || r.PipelineState != contracts.PipelineLabelUnreadable || jsonOf(t, r.Label) != jsonOf(t, want) {
		t.Fatalf("search %d result %s", s.refs.count(), jsonOf(t, r))
	}
	if r.Match.Status != contracts.MatchNotAttempted || !strings.Contains(r.Explanation.DisplayText, "I couldn't read this label.") {
		t.Errorf("match %s display %q", r.Match.Status, r.Explanation.DisplayText)
	}
}

func TestAnalyzeImagesQueryUsesTheGenericNameWhenTheBrandIsNotClear(t *testing.T) {
	sharp, _ := testImages(t)
	l := testLabel(contracts.ImageKindLabel,
		lf(contracts.FieldBrandName, contracts.Ptr("Paracel"), contracts.LegibilityPartial),
		clear(contracts.FieldGenericNames, "Paracetamol"),
		clear(contracts.FieldRegistrationNumber, "DR-XY900001"),
	)
	s := newSetup(okRead(l), nil)
	analyze(t, s, sharp)
	if q := s.refs.calls[0]; q != (references.Query{RegistrationNumber: "DR-XY900001", Name: "Paracetamol"}) {
		t.Errorf("query %+v", q)
	}
}

func TestAnalyzeImagesQueryOmitsARegistrationNumberNotClearOrNotWellFormed(t *testing.T) {
	sharp, _ := testImages(t)
	for _, reg := range []contracts.LabelField{
		lf(contracts.FieldRegistrationNumber, contracts.Ptr("DR-XY900001"), contracts.LegibilityPartial),
		clear(contracts.FieldRegistrationNumber, "see box"),
	} {
		s := newSetup(okRead(testLabel(contracts.ImageKindLabel, clear(contracts.FieldBrandName, "Paracelin 500"), reg)), nil)
		analyze(t, s, sharp)
		if q := s.refs.calls[0]; q != (references.Query{Name: "Paracelin 500"}) {
			t.Errorf("query %+v", q)
		}
	}
}

func TestAnalyzeImagesARegistrationNumberAloneIsEnoughToSearch(t *testing.T) {
	sharp, _ := testImages(t)
	l := testLabel(contracts.ImageKindLabel,
		lf(contracts.FieldBrandName, nil, contracts.LegibilityUnreadable),
		clear(contracts.FieldRegistrationNumber, "DR-XY900001"),
	)
	s := newSetup(okRead(l), nil)
	analyze(t, s, sharp)
	if q := s.refs.calls[0]; q != (references.Query{RegistrationNumber: "DR-XY900001"}) {
		t.Errorf("query %+v", q)
	}
}

func TestAnalyzeImagesNotEnoughClearTextSkipsTheLookupAndItsStages(t *testing.T) {
	sharp, _ := testImages(t)
	l := testLabel(contracts.ImageKindLabel,
		lf(contracts.FieldBrandName, contracts.Ptr("Paracelin 500"), contracts.LegibilityPartial),
		lf(contracts.FieldGenericNames, contracts.Ptr("Paracetamol"), contracts.LegibilityUnreadable),
		lf(contracts.FieldRegistrationNumber, contracts.Ptr("DR-XY900001"), contracts.LegibilityPartial),
		clear(contracts.FieldStrength, "500 mg"),
	)
	s := newSetup(okRead(l), nil)
	r := analyze(t, s, sharp)
	if s.refs.count() != 0 || r.PipelineState != contracts.PipelineExplanationReady || r.Match.Status != contracts.MatchNotAttempted ||
		!slices.Equal(r.Match.Limitations, []string{notEnoughText}) || NotEnoughTextNote != notEnoughText {
		t.Fatalf("search %d result %s", s.refs.count(), jsonOf(t, r))
	}
	if got := s.rec.seen(); !slices.Equal(got, []Stage{StageQuality, StageReading, StageReviewingFields, StageExplaining}) {
		t.Errorf("stages %v", got)
	}
}

func TestAnalyzeImagesRegistryUnavailableIsAResultNotAFailure(t *testing.T) {
	sharp, _ := testImages(t)
	down := contracts.SearchResult{Kind: contracts.SearchUnavailable, Reason: "PH FDA lookup failed: timeout"}
	s := newSetup(nil, &down)
	r := analyze(t, s, sharp)
	if r.PipelineState != contracts.PipelineExplanationReady || r.Match.Status != contracts.MatchUnavailable {
		t.Errorf("result %s", jsonOf(t, r))
	}
}

// Node: a registry that throws is reported as unavailable.
func TestAnalyzeImagesARegistryThatPanicsIsReportedAsUnavailable(t *testing.T) {
	sharp, _ := testImages(t)
	s := newSetup(nil, nil)
	s.refs.panics = true
	r := analyze(t, s, sharp)
	if r.PipelineState != contracts.PipelineExplanationReady || r.Match.Status != contracts.MatchUnavailable {
		t.Errorf("result %s", jsonOf(t, r))
	}
}

func TestAnalyzeImagesReaderFailureIsOCRFailedAndItsUsageIsStillCharged(t *testing.T) {
	sharp, _ := testImages(t)
	s := newSetup(&ai.ReadResult{Detail: "request_failed", Usage: ai.UsageEstimate}, nil)
	_, err := AnalyzeImages(context.Background(), "id-1", [][]byte{sharp}, s.deps)
	wantCode(t, err, contracts.ErrOCRFailed)
	if s.rec.usage != ai.UsageEstimate {
		t.Errorf("usage %+v", s.rec.usage)
	}
	if got := s.rec.seen(); !slices.Equal(got, []Stage{StageQuality, StageReading}) {
		t.Errorf("stages %v", got)
	}
}

func TestAnalyzeImagesChargesTheReadUsage(t *testing.T) {
	sharp, _ := testImages(t)
	read := okRead(paracelin())
	read.Usage = ai.Usage{PromptTokens: 1200, CompletionTokens: 300}
	s := newSetup(read, nil)
	analyze(t, s, sharp)
	if s.rec.usage != read.Usage {
		t.Errorf("usage %+v", s.rec.usage)
	}
}

func TestAnalyzeImagesRejectsBadUploadsBeforeTheReader(t *testing.T) {
	sharp, _ := testImages(t)
	for name, tc := range map[string]struct {
		images [][]byte
		code   contracts.ErrorCode
	}{
		"not an image":    {[][]byte{sharp, []byte("not an image at all")}, contracts.ErrInvalidImage},
		"over 8 MB":       {[][]byte{make([]byte, 8*1024*1024+1)}, contracts.ErrImageTooLarge},
		"truncated JPEG":  {[][]byte{sharp[:600]}, contracts.ErrInvalidImage},
		"no images":       {[][]byte{}, contracts.ErrValidationFailed},
		"four images":     {[][]byte{sharp, sharp, sharp, sharp}, contracts.ErrValidationFailed},
		"nil image slice": {nil, contracts.ErrValidationFailed},
	} {
		t.Run(name, func(t *testing.T) {
			s := newSetup(nil, nil)
			_, err := AnalyzeImages(context.Background(), "id-1", tc.images, s.deps)
			wantCode(t, err, tc.code)
			if s.reader.count() != 0 {
				t.Error("the reader ran")
			}
		})
	}
}

func TestValidateUploadsChecksCountSizeAndFormatOnly(t *testing.T) {
	sharp, _ := testImages(t)
	if err := ValidateUploads([][]byte{sharp, sharp, sharp}); err != nil {
		t.Errorf("valid uploads: %v", err)
	}
	// header-only: a truncated JPEG whose header parses is accepted here
	// and rejected when the job decodes it
	pe := wantCode(t, ValidateUploads([][]byte{}), contracts.ErrValidationFailed)
	if pe.Message != `Send 1 to 3 photos in the "images" field.` {
		t.Errorf("message %q", pe.Message)
	}
	wantCode(t, ValidateUploads([][]byte{sharp, sharp, sharp, sharp}), contracts.ErrValidationFailed)
	wantCode(t, ValidateUploads([][]byte{[]byte("GIF89a")}), contracts.ErrInvalidImage)
	wantCode(t, ValidateUploads([][]byte{make([]byte, 8*1024*1024+1)}), contracts.ErrImageTooLarge)
}

func TestAnalyzeImagesAReaderLabelThatBreaksTheContractIsInternalError(t *testing.T) {
	sharp, _ := testImages(t)
	bad := testLabel(contracts.ImageKindLabel, clear("dose", "500 mg"))
	for name, read := range map[string]*ai.ReadResult{
		"unknown field key": okRead(bad),
		"unknown legibility": okRead(testLabel(contracts.ImageKindLabel,
			lf(contracts.FieldStrength, contracts.Ptr("500 mg"), "smudged"))),
		"negative image index": okRead(testLabel(contracts.ImageKindLabel, contracts.LabelField{
			Key: contracts.FieldStrength, Value: contracts.Ptr("500 mg"), Legibility: contracts.LegibilityClear, ImageIndex: contracts.Ptr(-1),
		})),
		"unknown image kind": okRead(testLabel("pill_bottle")),
	} {
		t.Run(name, func(t *testing.T) {
			s := newSetup(read, nil)
			_, err := AnalyzeImages(context.Background(), "id-1", [][]byte{sharp}, s.deps)
			wantCode(t, err, contracts.ErrInternal)
		})
	}
}

func TestAnalyzeImagesARegistryRecordThatBreaksTheContractIsInternalError(t *testing.T) {
	sharp, _ := testImages(t)
	for name, mutate := range map[string]func(*contracts.ReferenceRecord){
		"javascript url":  func(r *contracts.ReferenceRecord) { r.SourceURL = "javascript:alert(1)" },
		"bad checked at":  func(r *contracts.ReferenceRecord) { r.CheckedAt = "2026-10-27 00:00" },
		"offset time":     func(r *contracts.ReferenceRecord) { r.CheckedAt = "2026-10-27T00:00:00+08:00" },
		"impossible date": func(r *contracts.ReferenceRecord) { r.CheckedAt = "2026-02-30T00:00:00Z" },
	} {
		t.Run(name, func(t *testing.T) {
			rec := testRecord()
			mutate(&rec)
			sr := okSearch(rec)
			s := newSetup(nil, &sr)
			_, err := AnalyzeImages(context.Background(), "id-1", [][]byte{sharp}, s.deps)
			wantCode(t, err, contracts.ErrInternal)
		})
	}
}

// zod's httpUrl outputs the URL trimmed with tab and newline removed; Node
// stored that output, so the Go result does too.
func TestAnalyzeImagesStoresURLsAsTheContractOutputsThem(t *testing.T) {
	sharp, _ := testImages(t)
	rec := testRecord()
	rec.SourceURL = " https://verification.fda.gov.ph/?q=DR-XY\t900001 "
	sr := okSearch(rec)
	sr.Advisories = []contracts.Advisory{{Title: "DEMO DATA advisory", URL: "https://www.fda.gov.ph/demo-\nadvisory"}}
	s := newSetup(nil, &sr)
	r := analyze(t, s, sharp)
	if r.Match.Candidates[0].SourceURL != "https://verification.fda.gov.ph/?q=DR-XY900001" {
		t.Errorf("source url %q", r.Match.Candidates[0].SourceURL)
	}
	if r.Match.Advisories[0].URL != "https://www.fda.gov.ph/demo-advisory" {
		t.Errorf("advisory url %q", r.Match.Advisories[0].URL)
	}
}

func TestAnalyzeImagesStopsWhenTheContextIsCancelledDuringTheRead(t *testing.T) {
	sharp, _ := testImages(t)
	s := newSetup(nil, nil)
	s.reader.wait = true
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := AnalyzeImages(ctx, "id-1", [][]byte{sharp}, s.deps)
		done <- err
	}()
	deadline := time.Now().Add(5 * time.Second)
	for s.reader.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("err %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the pipeline did not stop")
	}
	if s.refs.count() != 0 {
		t.Error("the registry was searched after the cancel")
	}
	if s.rec.usage.PromptTokens != 7 {
		t.Errorf("the cut-off read was not charged: %+v", s.rec.usage)
	}
	if got := s.rec.seen(); !slices.Equal(got, []Stage{StageQuality, StageReading}) {
		t.Errorf("stages %v", got)
	}
}

// A lookup cut off by the cancel is not reported as "registry unavailable":
// the job stops instead.
func TestAnalyzeImagesStopsWhenTheContextIsCancelledDuringTheLookup(t *testing.T) {
	sharp, _ := testImages(t)
	s := newSetup(nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	s.refs.cancel = cancel
	_, err := AnalyzeImages(ctx, "id-1", [][]byte{sharp}, s.deps)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err %v", err)
	}
	if got := s.rec.seen(); slices.Contains(got, StageComparing) || slices.Contains(got, StageExplaining) {
		t.Errorf("stages %v", got)
	}
}

func TestAnalyzeImagesWithACancelledContextDoesNothing(t *testing.T) {
	sharp, _ := testImages(t)
	s := newSetup(nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := AnalyzeImages(ctx, "id-1", [][]byte{sharp}, s.deps)
	if !errors.Is(err, context.Canceled) || s.reader.count() != 0 || len(s.rec.seen()) != 0 {
		t.Errorf("err %v reads %d stages %v", err, s.reader.count(), s.rec.seen())
	}
}

/* ------------------------------------------------------------ scenarios */

func scenarioDeps(rec *recorder) Deps {
	return Deps{Now: fixed(t0), TTL: fifteenMin, Emit: rec.emit, OnUsage: rec.record}
}

func TestAnalyzeScenarioS1UsesTheFixturesAndIsDemo(t *testing.T) {
	rec := &recorder{}
	r, err := AnalyzeScenario(context.Background(), "demo-1", "s1-clear", scenarioDeps(rec))
	if err != nil {
		t.Fatal(err)
	}
	if !r.IsDemo || r.PipelineState != contracts.PipelineExplanationReady || r.Match.Status != contracts.MatchVerified ||
		r.ImageRetention != contracts.ImageRetentionNone || r.ID != "demo-1" || r.Provenance != nil {
		t.Fatalf("result %s", jsonOf(t, r))
	}
	if !strings.Contains(r.Explanation.SpokenChunks[0], "Demo data") {
		t.Errorf("first chunk %q", r.Explanation.SpokenChunks[0])
	}
	// steps 1-3 are skipped: there is no quality stage
	want := []Stage{StageReading, StageReviewingFields, StageCheckingReferences, StageComparing, StageExplaining}
	if got := rec.seen(); !slices.Equal(got, want) {
		t.Errorf("stages %v", got)
	}
}

// Demo scenarios always run on the fixtures, whatever providers the deps
// carry, and are always demo.
func TestAnalyzeScenarioIgnoresTheConfiguredProviders(t *testing.T) {
	s := newSetup(nil, nil)
	s.deps.IsDemo = false
	r, err := AnalyzeScenario(context.Background(), "demo-1", "s5-nomatch", s.deps)
	if err != nil {
		t.Fatal(err)
	}
	if s.reader.count() != 0 || s.refs.count() != 0 || !r.IsDemo || r.Match.Status != contracts.MatchNoMatch {
		t.Errorf("reads %d searches %d result %s", s.reader.count(), s.refs.count(), jsonOf(t, r))
	}
}

func TestAnalyzeScenarioS2FixtureQualityFailsSoNothingIsRead(t *testing.T) {
	rec := &recorder{}
	r, err := AnalyzeScenario(context.Background(), "demo-1", "s2-blurry", scenarioDeps(rec))
	if err != nil {
		t.Fatal(err)
	}
	if r.PipelineState != contracts.PipelineLabelUnreadable || r.Label != nil || !r.IsDemo ||
		!slices.Equal(r.Quality.Reasons, []contracts.QualityReason{contracts.QualityBlurry, contracts.QualityGlare}) {
		t.Fatalf("result %s", jsonOf(t, r))
	}
	if got := rec.seen(); !slices.Equal(got, []Stage{StageExplaining}) {
		t.Errorf("stages %v", got)
	}
}

func TestAnalyzeScenarioS6LoosePillHasNoLookup(t *testing.T) {
	rec := &recorder{}
	r, err := AnalyzeScenario(context.Background(), "demo-1", "s6-loose-pill", scenarioDeps(rec))
	if err != nil {
		t.Fatal(err)
	}
	if r.PipelineState != contracts.PipelineLoosePill || !slices.Contains(r.Explanation.SpokenChunks, domain.LoosePillSentence) {
		t.Fatalf("result %s", jsonOf(t, r))
	}
	if got := rec.seen(); !slices.Equal(got, []Stage{StageReading, StageReviewingFields, StageExplaining}) {
		t.Errorf("stages %v", got)
	}
}

func TestAnalyzeScenarioRunsTheRealMatcherOverTheFixtures(t *testing.T) {
	got := map[string]contracts.MatchStatus{}
	for _, id := range []string{"s4-conflict", "s5-nomatch", "s8-registry-down"} {
		r, err := AnalyzeScenario(context.Background(), "demo-1", id, scenarioDeps(&recorder{}))
		if err != nil {
			t.Fatal(err)
		}
		got[id] = r.Match.Status
	}
	want := map[string]contracts.MatchStatus{"s4-conflict": "conflicting", "s5-nomatch": "no_match", "s8-registry-down": "unavailable"}
	if jsonOf(t, got) != jsonOf(t, want) {
		t.Errorf("statuses %v", got)
	}
}

func TestAnalyzeScenarioUnknownIDIsNotFound(t *testing.T) {
	rec := &recorder{}
	_, err := AnalyzeScenario(context.Background(), "demo-1", "s99-nope", scenarioDeps(rec))
	pe := wantCode(t, err, contracts.ErrNotFound)
	if pe.Message != "Unknown demo scenario." || len(rec.seen()) != 0 {
		t.Errorf("message %q stages %v", pe.Message, rec.seen())
	}
}

/* ------------------------------------------------------ final review I2 */

// filled is a read whose model copied a tablet imprint into the fields
// despite reader rule 7.
func filled(kind contracts.ImageKind) contracts.ExtractedLabel {
	brand := clear(contracts.FieldBrandName, "Paracelin 500")
	brand.Notes = contracts.Ptr("Imprint on the tablet.")
	return contracts.ExtractedLabel{
		ImageKind: kind,
		Fields: []contracts.LabelField{
			brand,
			clear(contracts.FieldGenericNames, "Paracetamol"),
			clear(contracts.FieldStrength, "500 mg"),
			clear(contracts.FieldDosageForm, "Tablet"),
		},
		RawText:  "PARACELIN 500 imprint",
		Warnings: []string{"DEMO DATA photo note"},
	}
}

func TestNoTranscribedValueSurvivesALoosePillNonMedicineOrUnreadableRead(t *testing.T) {
	sharp, _ := testImages(t)
	values := regexp.MustCompile(`Paracelin|Paracetamol|500 mg`)
	for kind, state := range map[contracts.ImageKind]contracts.PipelineState{
		contracts.ImageKindLoosePill:   contracts.PipelineLoosePill,
		contracts.ImageKindNotMedicine: contracts.PipelineNotALabel,
		contracts.ImageKindUnreadable:  contracts.PipelineLabelUnreadable,
	} {
		t.Run(string(kind), func(t *testing.T) {
			s := newSetup(okRead(filled(kind)), nil)
			r := analyze(t, s, sharp)
			if s.refs.count() != 0 || r.PipelineState != state || r.Label == nil || r.Label.ImageKind != kind ||
				r.Label.RawText != "" || !slices.Equal(r.Label.Warnings, []string{"DEMO DATA photo note"}) {
				t.Fatalf("result %s", jsonOf(t, r))
			}
			var keys []contracts.FieldKey
			for _, f := range r.Label.Fields {
				keys = append(keys, f.Key)
				want := contracts.LabelField{Key: f.Key, Legibility: contracts.LegibilityUnreadable}
				if jsonOf(t, f) != jsonOf(t, want) {
					t.Errorf("field %s", jsonOf(t, f))
				}
			}
			if !slices.Equal(keys, []contracts.FieldKey{"brandName", "genericNames", "strength", "dosageForm"}) {
				t.Errorf("keys %v", keys)
			}
			if values.MatchString(jsonOf(t, r)) {
				t.Errorf("a value survived: %s", jsonOf(t, r))
			}
		})
	}
}

func TestALabelReadKeepsItsValues(t *testing.T) {
	sharp, _ := testImages(t)
	r := analyze(t, newSetup(nil, nil), sharp)
	if jsonOf(t, r.Label) != jsonOf(t, paracelin()) {
		t.Errorf("label %s", jsonOf(t, r.Label))
	}
}

/* -------------------------------------------------------------- errors */

func TestErrorMessagesAreTheNodeOnesAndNeverStackLike(t *testing.T) {
	want := map[contracts.ErrorCode]string{
		contracts.ErrInvalidImage:         "Please send a JPEG, PNG or WebP photo.",
		contracts.ErrImageTooLarge:        "Each photo must be 8 MB or smaller.",
		contracts.ErrLiveBudgetExhausted:  "Live scanning is paused for today. Please use Demo Mode instead.",
		contracts.ErrLabelUnreadable:      "I couldn't read this label. Please take another photo.",
		contracts.ErrOCRFailed:            "I couldn't read the label right now. Please try again.",
		contracts.ErrReferenceUnavailable: "I couldn't check the FDA registry right now.",
		contracts.ErrNoReliableMatch:      "No matching registration found.",
		contracts.ErrConflictingMatch:     "Some details on the label do not match the registry.",
		contracts.ErrUnsupportedRequest:   "I can only read and explain the printed text on this label.",
		contracts.ErrRateLimited:          "Too many requests. Please wait a minute and try again.",
		contracts.ErrNotFound:             "This scan result has expired or does not exist. Please scan again.",
		contracts.ErrValidationFailed:     "The request is not valid.",
		contracts.ErrInternal:             "Something went wrong. Please try again.",
	}
	for _, code := range contracts.ErrorCodes {
		if got := NewError(code).Message; got != want[code] {
			t.Errorf("%s: %q", code, got)
		}
	}
	for _, code := range []contracts.ErrorCode{CodeAnalysisNotReady, CodeAnalysisFailed} {
		if NewError(code).Message == "" {
			t.Errorf("%s has no message", code)
		}
	}
	if CodeAnalysisNotReady != "ANALYSIS_NOT_READY" || CodeAnalysisFailed != "ANALYSIS_FAILED" {
		t.Error("new code names")
	}
	for code, msg := range errorMessages {
		if strings.Contains(msg, "at ") || strings.Contains(strings.ToLower(msg), "stack") {
			t.Errorf("%s message %q", code, msg)
		}
	}
	e := NewError(contracts.ErrOCRFailed)
	if e.Error() == "" || !errors.Is(e, e) {
		t.Error("Error()")
	}
}
