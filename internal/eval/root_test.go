package eval

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRepoRoot(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := RepoRoot(deep); err == nil {
		t.Error("found a root with no go.mod above")
	}
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := RepoRoot(deep)
	if err != nil || got != root {
		t.Errorf("RepoRoot = %q, %v; want %q", got, err, root)
	}
}
