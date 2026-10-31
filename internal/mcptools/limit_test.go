package mcptools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/domain"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

// fakeService returns a fixed stored result and answer; panics on demand.
type fakeService struct {
	result  contracts.AnalysisResult
	answer  contracts.Answer
	explain error
	panics  bool
}

func (f *fakeService) Create(context.Context, [][]byte) (string, error) { return f.result.ID, nil }
func (f *fakeService) CreateDemo(context.Context, string) (string, error) {
	return f.result.ID, nil
}

func (f *fakeService) Subscribe(string, int) (<-chan pipeline.Event, func(), error) {
	ch := make(chan pipeline.Event, 1)
	ch <- pipeline.Event{Seq: 1, Stage: pipeline.StageCompleted}
	close(ch)
	return ch, func() {}, nil
}

func (f *fakeService) Result(string) (contracts.AnalysisResult, error) {
	if f.panics {
		panic("SECRET service bug")
	}
	return f.result, nil
}

func (f *fakeService) Explain(context.Context, string, string) (contracts.Answer, error) {
	return f.answer, f.explain
}

func (f *fakeService) Delete(string) error { return nil }

const fakeID = "00000000-0000-4000-8000-0000000000f0"

func bigResult(candidates int, strLen int) contracts.AnalysisResult {
	long := strings.Repeat("é", strLen) // two bytes each in UTF-8
	label := contracts.ExtractedLabel{ImageKind: contracts.ImageKindLabel, Warnings: []string{long}}
	for _, k := range contracts.FieldKeys {
		label.Fields = append(label.Fields, contracts.LabelField{
			Key: k, Value: contracts.Ptr(long), Legibility: contracts.LegibilityClear, EvidenceText: contracts.Ptr(long),
		})
	}
	var recs []contracts.ReferenceRecord
	for i := range candidates {
		recs = append(recs, contracts.ReferenceRecord{
			Provider: "ph-fda", SourceURL: "https://verification.fda.gov.ph/?search=x",
			RegistrationNumber: fmt.Sprintf("DR-XY%05d", i), BrandName: contracts.Ptr(long),
			GenericName: contracts.Ptr(long), CheckedAt: "2026-10-27T09:00:00.000Z",
		})
	}
	return contracts.AnalysisResult{
		ID: fakeID, CreatedAt: "2026-10-27T09:00:00.000Z", ExpiresAt: "2026-10-27T09:15:00.000Z",
		PipelineState: contracts.PipelineExplanationReady, Label: &label,
		Match: contracts.MatchAssessment{Status: contracts.MatchAmbiguous, Candidates: recs, Limitations: []string{long}},
	}
}

// Hunt: no tool output is over 64 KiB of JSON; long text is cut with the
// marker, short text (ids, enums, safety sentences) is kept whole.
func TestOutputsAreCappedAt64KiBWithAMarker(t *testing.T) {
	f := &fakeService{result: bigResult(3, 20_000)}
	cs := connect(t, f)
	ex := ok[ExtractOutput](t, call(t, cs, "extract_medication_label", map[string]any{"scenario_id": "s1-clear"}))
	if ex.AnalysisID != fakeID || len(ex.Fields) != len(contracts.FieldKeys) {
		t.Fatalf("shape lost: %+v", ex)
	}
	for _, fl := range ex.Fields {
		if fl.Value == nil || !strings.HasSuffix(*fl.Value, TruncationMarker) {
			t.Fatalf("value not cut with the marker: %.40q", *fl.Value)
		}
	}
	cmp := ok[CompareOutput](t, call(t, cs, "compare_medication_evidence", map[string]any{"analysis_id": fakeID}))
	if cmp.Status != contracts.MatchAmbiguous || len(cmp.Candidates) != 3 || cmp.Candidates[2].RegistrationNumber != "DR-XY00002" {
		t.Fatalf("shape lost: %s", jsonOf(t, cmp))
	}
	lk := ok[LookupOutput](t, call(t, cs, "lookup_medication_reference", map[string]any{"analysis_id": fakeID}))
	if len(lk.Candidates) != 3 {
		t.Fatalf("lookup: %d candidates", len(lk.Candidates))
	}
	det := ok[DetailsOutput](t, call(t, cs, "get_reference_details", map[string]any{"analysis_id": fakeID, "registration_number": "DR-XY00001"}))
	if det.Record.RegistrationNumber != "DR-XY00001" {
		t.Fatalf("details: %s", jsonOf(t, det))
	}
}

// Too many records to fit even when every long text is cut: an error,
// never a silently shortened list.
func TestAnOutputThatCannotFitIsAnError(t *testing.T) {
	f := &fakeService{result: bigResult(2000, 10)}
	cs := connect(t, f)
	text := toolErr(t, call(t, cs, "compare_medication_evidence", map[string]any{"analysis_id": fakeID}), contracts.ErrInternal)
	if len(text) > 512 {
		t.Errorf("error text is %d bytes", len(text))
	}
}

// Cutting an answer never leaves part of the fixed advisory sentence, so
// a cut can never make "counterfeit" appear outside it.
func TestCuttingNeverBreaksTheFixedAdvisorySentence(t *testing.T) {
	for _, pad := range []int{30_000, 32_700, 32_760, 32_800, 40_000} {
		text := strings.Repeat("a", pad) + " " + domain.CounterfeitAdvisorySentence + " " + strings.Repeat("b", 40_000)
		f := &fakeService{result: bigResult(0, 1), answer: contracts.Answer{
			Status: contracts.AnswerAnswered, Text: text, SpokenChunks: []string{text},
			CitedFields: []contracts.FieldKey{}, SafetyNotice: nil,
		}}
		cs := connect(t, f)
		got := ok[ExplainOutput](t, call(t, cs, "explain_verified_label", map[string]any{"analysis_id": fakeID, "question": "What do the warnings say?"}))
		for _, s := range append([]string{got.Text}, got.SpokenChunks...) {
			if !strings.HasSuffix(s, TruncationMarker) {
				t.Errorf("pad %d: not cut: %d bytes", pad, len(s))
			}
			if pipeline.MentionsFake(s) {
				t.Errorf("pad %d: the cut left part of the advisory sentence: %q", pad, s[max(0, len(s)-160):])
			}
		}
	}
}

// The fixed safety texts are shorter than MinKeptRunes, so the cap never
// cuts a refusal, the final line or a registry sentence.
func TestFixedSafetyTextsAreNeverCut(t *testing.T) {
	texts := []string{domain.FinalLine, domain.CounterfeitAdvisorySentence, domain.LoosePillSentence, domain.NotALabelSentence}
	for _, s := range domain.RefusalText {
		texts = append(texts, s)
	}
	for _, s := range domain.StatusSentence {
		texts = append(texts, s)
	}
	for _, s := range texts {
		if n := len([]rune(s)); n > MinKeptRunes {
			t.Errorf("%d characters, over %d: %q", n, MinKeptRunes, s)
		}
		if got := cutTree(s, MinKeptRunes); got != s {
			t.Errorf("cut: %q", got)
		}
	}
}

func TestCapOutputKeepsSmallOutputsUnchanged(t *testing.T) {
	in := LookupOutput{Status: LookupOK, Candidates: []contracts.ReferenceRecord{}, Advisories: []contracts.Advisory{},
		Limitations: []string{strings.Repeat("x", 5000)}, IsDemo: true}
	out, err := capOutput(in)
	if err != nil || jsonOf(t, out) != jsonOf(t, in) {
		t.Fatalf("%v %s", err, jsonOf(t, out))
	}
}

// A schema or decoding error from the SDK quotes the offending argument;
// the error is cut so it stays small whatever was sent.
func TestArgumentErrorsAreBounded(t *testing.T) {
	cs := connect(t, newService(t, svcOptions{}))
	huge := strings.Repeat("SECRET", 200_000)
	for _, c := range []struct {
		tool string
		args map[string]any
	}{
		{"assess_image_quality", map[string]any{"image_base64": []string{huge}}},
		{"extract_medication_label", map[string]any{"scenario_id": huge}},
		{"extract_medication_label", map[string]any{"images_base64": huge}},
		{"get_reference_details", map[string]any{"analysis_id": "x", "registration_number": huge}},
		{"explain_verified_label", map[string]any{"analysis_id": "x", "question": huge, huge[:5000]: 1}},
	} {
		res := call(t, cs, c.tool, c.args)
		text := toolErr(t, res, contracts.ErrValidationFailed)
		b, _ := json.Marshal(res)
		if len(b) > 4096 {
			t.Errorf("%s: the error result is %d bytes", c.tool, len(b))
		}
		_ = text
	}
	// an unknown tool is a protocol error, also bounded
	ctx := context.Background()
	_, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: huge, Arguments: map[string]any{}})
	if err == nil || len(err.Error()) > 4096 {
		t.Errorf("unknown tool: %d bytes", len(fmt.Sprint(err)))
	}
}

// A panic in a tool is an INTERNAL_ERROR result; the server keeps serving
// and the panic value is never shown or logged.
func TestAPanicIsAnInternalErrorAndTheServerLives(t *testing.T) {
	var logs bytes.Buffer
	f := &fakeService{result: bigResult(1, 1), panics: true}
	cs := connectServer(t, NewServer(f, Options{Logger: slog.New(slog.NewJSONHandler(&logs, nil))}))
	text := toolErr(t, call(t, cs, "compare_medication_evidence", map[string]any{"analysis_id": fakeID}), contracts.ErrInternal)
	if strings.Contains(text, "SECRET") || strings.Contains(logs.String(), "SECRET") {
		t.Errorf("the panic value leaked: %q\n%s", text, logs.String())
	}
	f.panics = false
	ok[CompareOutput](t, call(t, cs, "compare_medication_evidence", map[string]any{"analysis_id": fakeID}))
}

// Unexpected errors are INTERNAL_ERROR with the fixed message; their text
// never reaches the caller or the log.
func TestUnexpectedErrorsAreNotShown(t *testing.T) {
	var logs bytes.Buffer
	f := &fakeService{result: bigResult(1, 1), explain: errors.New("SECRET provider detail: label says Paracelin")}
	cs := connectServer(t, NewServer(f, Options{Logger: slog.New(slog.NewJSONHandler(&logs, nil))}))
	text := toolErr(t, call(t, cs, "explain_verified_label", map[string]any{"analysis_id": fakeID, "question": "SECRET question"}), contracts.ErrInternal)
	if strings.Contains(text, "SECRET") || strings.Contains(logs.String(), "SECRET") || strings.Contains(logs.String(), "Paracelin") {
		t.Errorf("leaked: %q\n%s", text, logs.String())
	}
	if !strings.Contains(logs.String(), `"tool":"explain_verified_label"`) {
		t.Errorf("no tool log line:\n%s", logs.String())
	}
}
