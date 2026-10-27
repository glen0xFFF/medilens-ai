package parity

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseReadsOneCasePerLine(t *testing.T) {
	in := `{"fn":"parseStrength","args":["500 mg"],"result":[{"amount":500,"unit":"mg"}]}
{"fn":"classifyQuestion","args":[{"$undefined":true}],"result":{"allowed":false,"reason":"outside_label"}}
`
	cases, err := Parse(strings.NewReader(in))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(cases) != 2 {
		t.Fatalf("got %d cases, want 2", len(cases))
	}
	c := cases[0]
	if c.Fn != "parseStrength" || len(c.Args) != 1 || string(c.Args[0]) != `"500 mg"` {
		t.Errorf("case 0 = %+v", c)
	}
	if string(c.Result) != `[{"amount":500,"unit":"mg"}]` {
		t.Errorf("case 0 result = %s", c.Result)
	}
	if !IsUndefined(cases[1].Args[0]) {
		t.Errorf("case 1 arg should be undefined: %s", cases[1].Args[0])
	}
}

func TestParseAcceptsALastLineWithoutNewline(t *testing.T) {
	cases, err := Parse(strings.NewReader(`{"fn":"f","args":[],"result":null}`))
	if err != nil || len(cases) != 1 {
		t.Fatalf("got %d cases, err %v", len(cases), err)
	}
	if string(cases[0].Result) != "null" {
		t.Errorf("a null result must stay the JSON null, got %q", cases[0].Result)
	}
}

func TestParseRejectsBadLines(t *testing.T) {
	for name, in := range map[string]string{
		"malformed":      "{\"fn\":\"f\",\"args\":[],\"result\":1}\n{not json}\n",
		"blank line":     "{\"fn\":\"f\",\"args\":[],\"result\":1}\n\n{\"fn\":\"g\",\"args\":[],\"result\":1}\n",
		"unknown field":  `{"fn":"f","args":[],"result":1,"extra":true}` + "\n",
		"missing fn":     `{"args":[],"result":1}` + "\n",
		"missing args":   `{"fn":"f","result":1}` + "\n",
		"missing result": `{"fn":"f","args":[]}` + "\n",
		"two values":     `{"fn":"f","args":[],"result":1} {"fn":"g","args":[],"result":1}` + "\n",
		"crlf":           "{\"fn\":\"f\",\"args\":[],\"result\":1}\r\n",
		"empty":          "",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(strings.NewReader(in)); err == nil {
				t.Errorf("Parse accepted %q", in)
			}
		})
	}
}

func TestParseErrorNamesTheLine(t *testing.T) {
	_, err := Parse(strings.NewReader("{\"fn\":\"f\",\"args\":[],\"result\":1}\n{oops}\n"))
	if err == nil || !strings.Contains(err.Error(), "line 2") {
		t.Errorf("error should name line 2, got %v", err)
	}
}

func TestIsUndefined(t *testing.T) {
	for raw, want := range map[string]bool{
		`{"$undefined":true}`:       true,
		` { "$undefined" : true } `: true,
		`null`:                      false,
		`{"$undefined":false}`:      false,
		`{"$undefined":true,"x":1}`: false,
		`"$undefined"`:              false,
	} {
		if got := IsUndefined(json.RawMessage(raw)); got != want {
			t.Errorf("IsUndefined(%s) = %v, want %v", raw, got, want)
		}
	}
}

func TestNormalizeSortsKeysAndIgnoresSpacing(t *testing.T) {
	a, err := Normalize([]byte(`{"b":[1, 2.50],"a":{"y":null,"x":"é<"}}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := Normalize([]byte(`{"a":{"x":"é<","y":null},"b":[1.0,2.5]}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(a) != string(b) {
		t.Errorf("normalized forms differ:\n%s\n%s", a, b)
	}
	if _, err := Normalize([]byte(`{`)); err == nil {
		t.Error("Normalize accepted invalid JSON")
	}
}

// Every committed corpus loads, and every case has a function name.
func TestLoadReadsEveryCommittedCorpus(t *testing.T) {
	for _, file := range []string{
		"parsers.jsonl", "matcher.jsonl", "safety.jsonl",
		"summary.jsonl", "answers.jsonl", "scenarios.jsonl",
	} {
		t.Run(file, func(t *testing.T) {
			cases := Load(t, file)
			if len(cases) == 0 {
				t.Fatalf("%s has no cases", file)
			}
			for i, c := range cases {
				if c.Fn == "" || c.Result == nil || c.Args == nil {
					t.Fatalf("%s case %d is incomplete: %+v", file, i, c)
				}
			}
		})
	}
}

func TestScenarioCorpusHasAllEightScenarios(t *testing.T) {
	if n := len(Load(t, "scenarios.jsonl")); n != 8 {
		t.Errorf("scenarios.jsonl has %d cases, want 8", n)
	}
}
