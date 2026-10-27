package jsregex

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type v8Probe struct {
	Source string `json:"source"`
	Input  string `json:"input"`
	Result *struct {
		Index  int       `json:"index"`
		Groups []*string `json:"groups"`
	} `json:"result"`
}

func loadProbes(t *testing.T) []v8Probe {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", "v8_probes.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var probes []v8Probe
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var p v8Probe
		dec := json.NewDecoder(strings.NewReader(sc.Text()))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&p); err != nil {
			t.Fatalf("decode %s: %v", sc.Text(), err)
		}
		probes = append(probes, p)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	if len(probes) < 10000 {
		t.Fatalf("only %d probes", len(probes))
	}
	return probes
}

func show(s *string) string {
	if s == nil {
		return "undefined"
	}
	b, _ := json.Marshal(*s)
	return string(b)
}

// TestV8Probes replays every probe recorded from V8 (Node v24.21.0) by
// scripts/parity/go-probes.ts: the hand-written JS-semantics probes and 3000
// seeded random patterns over quantifiers, groups, captures, lookaround,
// anchors and boundaries. Index and every capture (undefined vs "") must
// agree.
func TestV8Probes(t *testing.T) {
	failed := 0
	for i, p := range loadProbes(t) {
		re, err := Compile(p.Source)
		if err != nil {
			t.Errorf("probe %d: compile %q: %v", i, p.Source, err)
			failed++
			continue
		}
		m := re.Exec(p.Input)
		if (m == nil) != (p.Result == nil) {
			t.Errorf("probe %d: /%s/.exec(%q): got match=%v, V8 match=%v", i, p.Source, p.Input, m != nil, p.Result != nil)
			failed++
			continue
		}
		if m == nil {
			if re.Test(p.Input) {
				t.Errorf("probe %d: Test true but Exec nil for /%s/ on %q", i, p.Source, p.Input)
				failed++
			}
			continue
		}
		if !re.Test(p.Input) {
			t.Errorf("probe %d: Test false but Exec matched for /%s/ on %q", i, p.Source, p.Input)
			failed++
		}
		if m.Index != p.Result.Index || m.NumGroups() != len(p.Result.Groups) {
			t.Errorf("probe %d: /%s/.exec(%q): index %d groups %d, V8 index %d groups %d", i, p.Source, p.Input, m.Index, m.NumGroups(), p.Result.Index, len(p.Result.Groups))
			failed++
			continue
		}
		for g, want := range p.Result.Groups {
			got, ok := m.Group(g)
			var gp *string
			if ok {
				gp = &got
			}
			if show(gp) != show(want) {
				t.Errorf("probe %d: /%s/.exec(%q) group %d: got %s, V8 %s", i, p.Source, p.Input, g, show(gp), show(want))
				failed++
			}
		}
	}
	if failed > 0 {
		t.Logf("%d probe failures", failed)
	}
}

// Unsupported syntax fails loudly at compile time instead of being read
// with Go or Annex-B semantics the safety patterns never rely on.
func TestCompileRejectsUnsupportedSyntax(t *testing.T) {
	for _, src := range []string{
		`(a)\1`,   // backreference
		`(?<n>a)`, // named group
		`\k<n>`,   // named backreference
		`\p{L}`,   // property escape without the u flag is an identity escape in JS
		`\P{L}`,   //
		`\c`,      // \c without a control letter
		`\8`,      // legacy octal / decimal escape
		`(?=a)*`,  // quantified lookahead (Annex B)
		`a**`,     // nothing to repeat
		`*a`,      //
		`(a`,      // unbalanced
		`a)`,      //
		`[a`,      //
		`[z-a]`,   // out-of-order range
		`x{2,1}`,  // numbers out of order
		`(?i:a)`,  // modifiers
	} {
		if _, err := Compile(src); err == nil {
			t.Errorf("Compile(%q) succeeded; want an error", src)
		}
	}
}

func TestMustCompilePanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("MustCompile did not panic on a bad pattern")
		}
	}()
	MustCompile(`(`)
}

// Source returns the pattern exactly as given.
func TestSource(t *testing.T) {
	const src = `(?<!\b(?:read|say)\b.*)\bagain\b`
	if got := MustCompile(src).Source(); got != src {
		t.Fatalf("Source() = %q", got)
	}
}

// Inputs are UTF-16 code units, as in JS without the u flag: an astral
// character is two units for `.`, `{n}` and capture boundaries.
func TestCodeUnits(t *testing.T) {
	if MustCompile(`^.$`).Test("😀") {
		t.Fatal("one . matched an astral character")
	}
	if !MustCompile(`^..$`).Test("😀") {
		t.Fatal("two . did not match an astral character")
	}
	if Len("😀a") != 3 || Len("é") != 1 || Len("") != 0 {
		t.Fatal("Len is not the UTF-16 length")
	}
}
