// Package parity loads the golden corpora recorded from the Node build
// (fixtures/parity/*.jsonl, written by `npm run parity:record`) for the Go
// parity tests. See fixtures/parity/README.md for the format, including the
// {"$undefined":true} and {"$number":"..."} markers (ruling R8).
package parity

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// Case is one recorded call: the exported TS function name, its arguments
// (one raw JSON value per declared parameter) and its result.
type Case struct {
	Fn     string            `json:"fn"`
	Args   []json.RawMessage `json:"args"`
	Result json.RawMessage   `json:"result"`
}

// Load reads fixtures/parity/<file> and fails the test if the corpus is
// missing, empty or malformed.
func Load(t testing.TB, file string) []Case {
	t.Helper()
	dir, err := Dir()
	if err != nil {
		t.Fatalf("parity: %v", err)
	}
	f, err := os.Open(filepath.Join(dir, file))
	if err != nil {
		t.Fatalf("parity: %v", err)
	}
	defer f.Close()
	cases, err := Parse(f)
	if err != nil {
		t.Fatalf("parity: %s: %v", file, err)
	}
	return cases
}

// Dir is the absolute path of fixtures/parity, found by walking up from the
// working directory (a package directory under `go test`) to go.mod.
func Dir() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return filepath.Join(dir, "fixtures", "parity"), nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("no go.mod above the working directory")
		}
		dir = parent
	}
}

// Parse reads a corpus: one JSON object per LF-terminated line (the last
// newline is optional), each with exactly the keys fn, args and result.
// Blank lines, CRLF endings and an empty corpus are errors.
func Parse(r io.Reader) ([]Case, error) {
	br := bufio.NewReader(r)
	var cases []Case
	for n := 1; ; n++ {
		line, err := br.ReadBytes('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		if len(line) == 0 && errors.Is(err, io.EOF) {
			break
		}
		body := bytes.TrimSuffix(line, []byte("\n"))
		c, perr := parseLine(body)
		if perr != nil {
			return nil, fmt.Errorf("line %d: %w", n, perr)
		}
		cases = append(cases, c)
		if errors.Is(err, io.EOF) {
			break
		}
	}
	if len(cases) == 0 {
		return nil, errors.New("no cases")
	}
	return cases, nil
}

func parseLine(body []byte) (Case, error) {
	if len(body) == 0 {
		return Case{}, errors.New("blank line")
	}
	if bytes.HasSuffix(body, []byte("\r")) {
		return Case{}, errors.New("CRLF line ending (corpora are LF; see .gitattributes)")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	var fields map[string]json.RawMessage
	if err := dec.Decode(&fields); err != nil {
		return Case{}, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return Case{}, errors.New("more than one JSON value on the line")
	}
	for k := range fields {
		if k != "fn" && k != "args" && k != "result" {
			return Case{}, fmt.Errorf("unknown key %q", k)
		}
	}
	var c Case
	for _, k := range []string{"fn", "args", "result"} {
		if _, ok := fields[k]; !ok {
			return Case{}, fmt.Errorf("missing key %q", k)
		}
	}
	if err := json.Unmarshal(fields["fn"], &c.Fn); err != nil || c.Fn == "" {
		return Case{}, fmt.Errorf("fn must be a non-empty string: %s", fields["fn"])
	}
	if err := json.Unmarshal(fields["args"], &c.Args); err != nil || c.Args == nil {
		return Case{}, fmt.Errorf("args must be an array: %s", fields["args"])
	}
	c.Result = fields["result"]
	return c, nil
}

// IsUndefined reports whether raw is the recorder's marker for JS undefined,
// {"$undefined":true}, as opposed to null or an absent value.
func IsUndefined(raw json.RawMessage) bool {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || len(m) != 1 {
		return false
	}
	v, ok := m["$undefined"]
	return ok && string(bytes.TrimSpace(v)) == "true"
}

// Normalize re-encodes JSON in one canonical form (object keys sorted, no
// insignificant spacing, numbers as float64), so two encodings of the same
// value compare byte-equal.
func Normalize(raw []byte) ([]byte, error) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return json.Marshal(v)
}
