package config

import (
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/medilens-ai/medilens/internal/parity"
)

// blankValueLine is the one place ParseDotenv departs from Node: an = then
// only spaces or tabs up to the end of the line.
var blankValueLine = regexp.MustCompile("=[ \t]+\n")

// fixtures/parity/dotenv/node-parse-env.jsonl is Node's util.parseEnv (the
// parser of process.loadEnvFile) on hand-picked and random .env files
// (scripts/parity/record-dotenv.ts). With Node's blank-value behaviour
// switched on, the Go parser gives exactly Node's variables for every file;
// ParseDotenv differs only on files with a blank value line.
func TestParseDotenvMatchesTheRecordedNodeParser(t *testing.T) {
	cases := parity.Load(t, "dotenv/node-parse-env.jsonl")
	if len(cases) < 1000 {
		t.Fatalf("only %d recorded files", len(cases))
	}
	differ := 0
	for _, c := range cases {
		if c.Fn != "util.parseEnv" || len(c.Args) != 1 {
			t.Fatalf("line %+v", c)
		}
		var content string
		var want map[string]string
		if err := json.Unmarshal(c.Args[0], &content); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(c.Result, &want); err != nil {
			t.Fatal(err)
		}
		if got := parseDotenv(content, true); !reflect.DeepEqual(got, want) {
			t.Errorf("node mode %q: got %q, want %q", content, got, want)
		}
		if got := ParseDotenv(content); !reflect.DeepEqual(got, want) {
			differ++
			if !blankValueLine.MatchString(strings.ReplaceAll(content, "\r", "")) {
				t.Errorf("%q: got %q, want %q (no blank value line)", content, got, want)
			}
		}
	}
	if differ == 0 {
		t.Error("no recorded file has a blank value line, so the difference is untested")
	}
	t.Logf("%d recorded files; ParseDotenv departs from Node on %d, each with a blank value line", len(cases), differ)
}
