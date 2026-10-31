package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/domain"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

const questionMessage = `Send {"question": "..."} with 1 to 300 characters.`

func (e *testEnv) ask(id, question string) *httptest.ResponseRecorder {
	b, _ := json.Marshal(map[string]string{"question": question})
	return e.postJSON("/api/v1/analyses/"+id+"/explanation", string(b))
}

func answerOf(t *testing.T, w *httptest.ResponseRecorder) contracts.Answer {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var raw map[string]json.RawMessage
	decode(t, w, &raw)
	if len(raw) != 5 {
		t.Errorf("answer keys %v", raw)
	}
	var a contracts.Answer
	decode(t, w, &a)
	return a
}

func TestTheSafetyGateRunsFirst(t *testing.T) {
	e := newEnv(t, envOptions{})
	s7 := e.demoResult(t, "s7-unsupported-question")
	refusal := domain.RefusalText[domain.RefusalPersonalDose]
	got := answerOf(t, e.ask(s7, *scenario(t, "s7-unsupported-question").PresetQuestion))
	want := contracts.Answer{Status: contracts.AnswerRefused, Text: refusal, SpokenChunks: []string{refusal}, CitedFields: []contracts.FieldKey{}, SafetyNotice: &refusal}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("s7: %+v", got)
	}
	s2 := e.demoResult(t, "s2-blurry")
	if a := answerOf(t, e.ask(s2, "My child swallowed the whole bottle")); a.Status != contracts.AnswerRefused ||
		a.Text != domain.RefusalText[domain.RefusalPossibleOverdose] {
		t.Errorf("overdose: %+v", a)
	}
	s1 := e.demoResult(t, "s1-clear")
	if a := answerOf(t, e.ask(s1, "Tell me a joke about pharmacists")); a.Text != domain.RefusalText[domain.RefusalOutsideLabel] {
		t.Errorf("outside the label: %+v", a)
	}
}

func TestAllowedQuestionsAreAnswered(t *testing.T) {
	e := newEnv(t, envOptions{})
	s1 := e.demoResult(t, "s1-clear")
	a := answerOf(t, e.ask(s1, "What strength is printed here?"))
	if a.Status != contracts.AnswerAnswered || !reflect.DeepEqual(a.CitedFields, []contracts.FieldKey{contracts.FieldStrength}) ||
		!strings.Contains(a.Text, "500 mg") || a.SpokenChunks[len(a.SpokenChunks)-1] != domain.FinalLine {
		t.Errorf("%+v", a)
	}
	for _, q := range domain.AllowedQuestionExamples {
		if a := answerOf(t, e.ask(s1, q)); a.Status == contracts.AnswerRefused {
			t.Errorf("preset %q refused", q)
		}
	}
	s2 := e.demoResult(t, "s2-blurry")
	if a := answerOf(t, e.ask(s2, "What strength is printed here?")); a.Status != contracts.AnswerUnclear || a.Text != domain.NoLabelText {
		t.Errorf("no label: %+v", a)
	}
}

func TestExplanationValidation(t *testing.T) {
	e := newEnv(t, envOptions{})
	s1 := e.demoResult(t, "s1-clear")
	path := "/api/v1/analyses/" + s1 + "/explanation"
	for _, body := range []string{`{}`, `{"question":""}`, `{"question":"   "}`, `{"question":5}`, `{"question":null}`,
		`{"question":"` + strings.Repeat("x", 301) + `"}`, `[]`, ``} {
		if msg := wantError(t, e.postJSON(path, body), 400, contracts.ErrValidationFailed); msg != questionMessage {
			t.Errorf("%.40s: message %q", body, msg)
		}
	}
	// the id is checked before the question, as in Node
	wantError(t, e.postJSON("/api/v1/analyses/no-such-id/explanation", `{"question":5}`), 404, contracts.ErrNotFound)
	// a body that is not JSON fails before the route, as express.json
	for _, body := range []string{`{"question": `, `null`, `"What strength?"`, " \t", " {}"} {
		if msg := wantError(t, e.postJSON("/api/v1/analyses/no-such-id/explanation", body), 400, contracts.ErrValidationFailed); msg != "The request body is not valid JSON of up to 16 kB." {
			t.Errorf("%q: message %q", body, msg)
		}
	}
}

// The JSON body is read as express.json({limit: '16kb'}) read it (body-parser
// 2.4.0, measured with Node v24.21.0 for task G8).
func TestJSONBodiesAreReadAsExpressReadThem(t *testing.T) {
	e := newEnv(t, envOptions{})
	s1 := e.demoResult(t, "s1-clear")
	path := "/api/v1/analyses/" + s1 + "/explanation"
	q := []byte(`"What strength is printed here?"`)
	body := []byte(`{"question":` + string(q) + `}`)
	post := func(ct string, b []byte, enc string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, bytes.NewReader(b))
		if ct != "" {
			r.Header.Set("Content-Type", ct)
		}
		if enc != "" {
			r.Header.Set("Content-Encoding", enc)
		}
		return e.do(r)
	}
	for _, c := range []struct {
		name, ct string
		body     []byte
		enc      string
	}{
		{"charset UTF-8", "application/json; charset=UTF-8", body, ""},
		{"quoted charset", `application/json; charset="utf-8"`, body, ""},
		{"upper-case type", "APPLICATION/JSON", body, ""},
		{"a malformed parameter", "application/json; foo", body, ""},
		{"a byte order mark", "application/json", append([]byte("\xef\xbb\xbf"), body...), ""},
		{"leading whitespace", "application/json", append([]byte(" \r\n\t"), body...), ""},
		{"identity encoding", "application/json", body, "identity"},
		{"duplicate keys: the last wins", "application/json", []byte(`{"question":5,"question":` + string(q) + `}`), ""},
	} {
		if a := answerOf(t, post(c.ct, c.body, c.enc)); a.Status != contracts.AnswerAnswered {
			t.Errorf("%s: %+v", c.name, a)
		}
	}
	for _, c := range []struct {
		name, ct string
		body     []byte
		enc      string
		message  string
	}{
		{"latin1", "application/json; charset=latin1", body, "", "The request body is not valid JSON of up to 16 kB."},
		{"utf8 without the dash", "application/json; charset=utf8", body, "", "The request body is not valid JSON of up to 16 kB."},
		{"gzip", "application/json", body, "gzip", "The request body is not valid JSON of up to 16 kB."},
		{"two byte order marks", "application/json", append([]byte("\xef\xbb\xbf\xef\xbb\xbf"), body...), "", "The request body is not valid JSON of up to 16 kB."},
		{"text/plain", "text/plain", body, "", questionMessage},
		{"no content type", "", body, "", questionMessage},
		{"a +json type", "application/merge-patch+json", body, "", questionMessage},
	} {
		if msg := wantError(t, post(c.ct, c.body, c.enc), 400, contracts.ErrValidationFailed); msg != c.message {
			t.Errorf("%s: message %q", c.name, msg)
		}
	}
	// 16384 bytes is the limit (body-parser '16kb')
	pad := func(n int) []byte {
		b := []byte(`{"question":"What strength is printed here?","pad":"`)
		b = append(b, bytes.Repeat([]byte("x"), n-len(b)-2)...)
		return append(b, '"', '}')
	}
	if a := answerOf(t, post("application/json", pad(16384), "")); a.Status != contracts.AnswerAnswered {
		t.Errorf("16384 bytes: %+v", a)
	}
	wantError(t, post("application/json", pad(16385), ""), 400, contracts.ErrValidationFailed)
}

// Task G7 concern: Node decodes a body as UTF-8 the WHATWG way (one U+FFFD
// per maximal invalid subpart); Go's encoding/json would give one per
// byte. A truncated sequence at the end of a 299-character question is one
// character in Node, so the question is 300 characters and is answered,
// not rejected.
func TestInvalidUTF8CountsAsInNode(t *testing.T) {
	e := newEnv(t, envOptions{})
	s1 := e.demoResult(t, "s1-clear")
	body := []byte(`{"question":"` + strings.Repeat("x", 299) + "\xe2\x82" + `"}`)
	a := answerOf(t, e.postRaw("/api/v1/analyses/"+s1+"/explanation", "application/json", body))
	if a.Status != contracts.AnswerRefused {
		t.Errorf("%+v", a)
	}
	body = []byte(`{"question":"` + strings.Repeat("x", 299) + "\xe2\x82\xe2\x82" + `"}`)
	wantError(t, e.postRaw("/api/v1/analyses/"+s1+"/explanation", "application/json", body), 400, contracts.ErrValidationFailed)
}

func TestDecodeUTF8LikeWHATWG(t *testing.T) {
	// measured with Node v24.21.0 through express.json: the code points
	// between "a" and "b"
	for in, want := range map[string]string{
		"e282":     "�",
		"e28241":   "�A",
		"ff":       "�",
		"c080":     "��",
		"eda080":   "���",
		"f4908080": "����",
		"f09f98":   "�",
		"e08080":   "���",
		"8080":     "��",
		"e282ac":   "€",
		"f09f9880": "\U0001F600",
	} {
		raw := make([]byte, 0, len(in)/2)
		for i := 0; i < len(in); i += 2 {
			var b byte
			for _, c := range in[i : i+2] {
				b <<= 4
				if c >= 'a' {
					b |= byte(c-'a') + 10
				} else {
					b |= byte(c - '0')
				}
			}
			raw = append(raw, b)
		}
		got := string(decodeUTF8(append(append([]byte("a"), raw...), 'b')))
		if got != "a"+want+"b" || !utf8.ValidString(got) {
			t.Errorf("%s: %+q, want %+q", in, got, "a"+want+"b")
		}
	}
}

func TestALiveExplanationNeedsTheBudget(t *testing.T) {
	live := liveProviders(&countingReader{result: s1Read(t)}, scenario(t, "s1-clear").Reference)
	meter := pipeline.NewSpendMeter(5, time.Now)
	e := newEnv(t, envOptions{providers: &live, meter: meter})
	id := accepted(t, e.upload(sharp(t)))
	e.wait(t, id)
	meter.Record(ai.Usage{PromptTokens: 4_000_000})
	wantError(t, e.ask(id, "What strength is printed here?"), 503, contracts.ErrLiveBudgetExhausted)
	if a := answerOf(t, e.ask(id, "How many should I take for my headache?")); a.Status != contracts.AnswerRefused {
		t.Errorf("refusal: %+v", a)
	}
	if a := answerOf(t, e.ask(id, "Can you repeat that?")); a.Status != contracts.AnswerAnswered {
		t.Errorf("repeat: %+v", a)
	}
}

/* ------------------------------------------------------------ speak */

const speakMessage = `Send {"target": "summary"} or {"target": "answer", "text": "..."}.`

func TestSpeak(t *testing.T) {
	e := newEnv(t, envOptions{})
	s1 := e.demoResult(t, "s1-clear")
	var r contracts.AnalysisResult
	decode(t, e.get("/api/v1/analyses/"+s1+"/result"), &r)
	path := "/api/v1/analyses/" + s1 + "/speak"

	w := e.postJSON(path, `{"target":"summary"}`)
	var raw map[string]json.RawMessage
	decode(t, w, &raw)
	if w.Code != 200 || len(raw) != 2 || string(raw["language"]) != `"en-US"` {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var chunks []string
	_ = json.Unmarshal(raw["chunks"], &chunks)
	if !reflect.DeepEqual(chunks, r.Explanation.SpokenChunks) {
		t.Errorf("summary chunks %v", chunks)
	}

	text := strings.Repeat("Take with water. ", 30)
	b, _ := json.Marshal(map[string]string{"target": "answer", "text": text})
	decode(t, e.postJSON(path, string(b)), &raw)
	_ = json.Unmarshal(raw["chunks"], &chunks)
	if want := domain.ChunkSpeech(text); !reflect.DeepEqual(chunks, want) || len(want) < 2 {
		t.Errorf("answer chunks %v, want %v", chunks, want)
	}
	// a text beside the summary target is ignored, as zod strips it
	if w := e.postJSON(path, `{"target":"summary","text":5}`); w.Code != 200 {
		t.Errorf("summary with text: %d", w.Code)
	}

	for _, body := range []string{`{}`, `{"target":"x"}`, `{"target":"answer"}`, `{"target":"answer","text":"  "}`, `{"target":"answer","text":5}`, `{"target":5}`, `[]`} {
		if msg := wantError(t, e.postJSON(path, body), 400, contracts.ErrValidationFailed); msg != speakMessage {
			t.Errorf("%s: message %q", body, msg)
		}
	}
	wantError(t, e.postJSON("/api/v1/analyses/no-such-id/speak", `{"target":5}`), 404, contracts.ErrNotFound)
	wantError(t, e.postJSON(path, `{"target":`), 400, contracts.ErrValidationFailed)
}
