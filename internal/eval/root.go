package eval

import (
	"errors"
	"os"
	"path/filepath"
)

// RepoRoot is the repository root: the first directory at or above start
// that holds go.mod. The eval and smoke commands read <root>/.env (as the
// Node scripts read the repository-root .env) and the eval writes under
// <root>/docs.
func RepoRoot(start string) (string, error) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("eval: no go.mod at or above the working directory")
		}
		dir = parent
	}
}
