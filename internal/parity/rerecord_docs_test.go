package parity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The re-recording notes are the only route back to the Node reference after
// task G12 removed apps/server (spec §6.5: fix the TS first, then re-record).
// The tag node-fallback-v1 predates scripts/parity and the root parity:record
// script, so a whole-tree `git checkout node-fallback-v1` leaves no recorder.
// Every note must restore only apps/server from the tag onto the current tree
// (task G12 review round 1).

// restoreServer keeps the restored files LF: record-providers.ts copies the
// Node provider fixtures byte for byte.
const restoreServer = "git -c core.autocrlf=false checkout node-fallback-v1 -- apps/server"

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := Dir()
	if err != nil {
		t.Fatalf("parity: %v", err)
	}
	return filepath.Dir(filepath.Dir(dir))
}

func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repoRoot(t), filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(b)
}

// rerecordNotes lists every file that tells a reader how to re-record.
func rerecordNotes(t *testing.T) []string {
	t.Helper()
	files := []string{
		"README.md",
		"docs/ARCHITECTURE.md",
		"fixtures/parity/README.md",
		"scripts/parity/README.md",
	}
	scripts, err := filepath.Glob(filepath.Join(repoRoot(t), "scripts", "parity", "*.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if len(scripts) == 0 {
		t.Fatal("no scripts/parity/*.ts found")
	}
	for _, s := range scripts {
		files = append(files, "scripts/parity/"+filepath.Base(s))
	}
	return files
}

func TestRerecordNotesNeverCheckOutTheWholeTag(t *testing.T) {
	for _, rel := range rerecordNotes(t) {
		text := strings.ReplaceAll(readRepoFile(t, rel), "\r\n", "\n")
		rest := text
		for {
			i := strings.Index(rest, "checkout node-fallback-v1")
			if i < 0 {
				break
			}
			after := rest[i+len("checkout node-fallback-v1"):]
			if !strings.HasPrefix(after, " -- apps/server") {
				line := 1 + strings.Count(text[:len(text)-len(rest)+i], "\n")
				t.Errorf("%s:%d: a whole-tree checkout of node-fallback-v1 has no scripts/parity; restore only apps/server (%q)", rel, line, restoreServer)
			}
			rest = after
		}
	}
}

func TestRerecordNotesPointAtTheProcedure(t *testing.T) {
	// Each place that says re-recording needs the Node build names the
	// restore step or links the procedure in scripts/parity/README.md.
	for _, rel := range []string{"README.md", "docs/ARCHITECTURE.md", "fixtures/parity/README.md"} {
		text := readRepoFile(t, rel)
		if !strings.Contains(text, "scripts/parity/README.md") {
			t.Errorf("%s does not link scripts/parity/README.md", rel)
		}
	}
	// fixtures/parity/README.md has one note per recorder: the main corpora,
	// go-probes, go-probes-answers, record-images, record-providers and
	// record-question-limits.
	fx := readRepoFile(t, "fixtures/parity/README.md")
	if n := strings.Count(fx, "scripts/parity/README.md#re-recording"); n < 6 {
		t.Errorf("fixtures/parity/README.md links the procedure %d times, want at least 6 (one per recorder note)", n)
	}
}

func TestRerecordProcedureStepsInOrder(t *testing.T) {
	text := readRepoFile(t, "scripts/parity/README.md")
	steps := []string{
		restoreServer,
		"npm install",
		"npm run parity:record",
		"git rm -r -q -f apps/server",
		"git checkout -- package-lock.json",
		"npm install",
	}
	at := 0
	for _, s := range steps {
		i := strings.Index(text[at:], s)
		if i < 0 {
			t.Fatalf("scripts/parity/README.md: step %q missing or out of order", s)
		}
		at += i + len(s)
	}
}

func TestRerecordProcedureMatchesTheCurrentTree(t *testing.T) {
	// The procedure runs on the current branch, so the recorder entry point
	// must live here: the root parity:record script, record.ts, and the
	// vitest config rooted at the restored apps/server.
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal([]byte(readRepoFile(t, "package.json")), &pkg); err != nil {
		t.Fatalf("package.json: %v", err)
	}
	if got := pkg.Scripts["parity:record"]; got != "tsx scripts/parity/record.ts" {
		t.Errorf("root parity:record = %q, want %q", got, "tsx scripts/parity/record.ts")
	}
	readRepoFile(t, "scripts/parity/record.ts")
	if cfg := readRepoFile(t, "scripts/parity/vitest.config.ts"); !strings.Contains(cfg, "'../../apps/server'") {
		t.Error("scripts/parity/vitest.config.ts no longer roots at ../../apps/server, the path the procedure restores")
	}
}
