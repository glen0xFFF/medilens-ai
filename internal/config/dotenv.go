package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"

	"github.com/medilens-ai/medilens/internal/domain"
)

// The .env loader (task G8). Node's server called process.loadEnvFile on
// the repository-root .env; this standard-library parser reproduces the
// one behind it (Node v24.21.0, also exposed as util.parseEnv). It was
// written from Node's observed output, not from Node's source, and is held
// to Node's results on hand-picked cases (dotenv_test.go) and on a
// recorded corpus of 2,937 files (dotenv_parity_test.go). What it shares
// with Node:
//
//   - KEY=VALUE lines; spaces and tabs around the key and the value are
//     trimmed; blank lines and lines starting with # are skipped; a line
//     with no = is skipped; an optional "export " before the key is
//     removed.
//   - An unquoted value ends at the first # (an inline comment), so
//     KEY=a#b is "a": quote a value that contains #.
//   - '...', "..." and `...` quote a value; the quotes are removed, the
//     value may run over several lines, and text after the closing quote
//     is ignored. Only "..." expands \n to a newline; there are no other
//     escapes (\" ends nothing: the value ends at the next ").
//   - No $VAR expansion, and every \r in the file is dropped.
//   - A variable already in the environment is never overridden, even
//     when it is set to "".
//   - A missing file is not an error.
//
// Known differences from Node:
//
//   - A value of only spaces or tabs is "". Node trims the newline too and
//     takes the next line as the value (A=<spaces> then B=x sets A to "B=x"
//     and loses B); here the next line is read as its own variable.
//   - A file that exists but cannot be read (a directory, no permission) is
//     an error the caller reports; Node's loader ignored every error.
//   - The file is ENV_FILE, or .env in the working directory (DotenvPath).
//     Node always read <repository root>/.env, found from its own source
//     path; a Go binary has none, so run it from the repository root.
//   - The bytes are taken as they are; Node decoded the file as UTF-8
//     first (an invalid sequence became U+FFFD).

// DotenvPath is the .env file to load: ENV_FILE when set, else .env in the
// working directory.
func DotenvPath(getenv func(string) string) string {
	if p := domain.JSTrim(getenv("ENV_FILE")); p != "" {
		return p
	}
	return ".env"
}

// LoadDotenv sets each variable of the .env file at path that is not
// already in the environment. A missing file is not an error. An error
// names the file, never a value.
func LoadDotenv(path string) error {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("config: cannot read the env file %s: %w", path, err)
	}
	for k, v := range ParseDotenv(string(b)) {
		if _, set := os.LookupEnv(k); set {
			continue
		}
		if err := os.Setenv(k, v); err != nil {
			return fmt.Errorf("config: the env file %s has a variable name the system rejects", path)
		}
	}
	return nil
}

// dotenvSpace is what Node's trim_spaces removes.
const dotenvSpace = " \t\n"

func trimDotenv(s string) string { return strings.Trim(s, dotenvSpace) }

// afterNewline is s after the first newline at or after from, or "".
func afterNewline(s string, from int) string {
	if i := strings.IndexByte(s[from:], '\n'); i >= 0 {
		return s[from+i+1:]
	}
	return ""
}

// ParseDotenv parses .env content as Node's process.loadEnvFile does (see
// the notes above): the variables it defines, the last definition of a
// key winning. Keys are not validated, as in Node; an empty key is
// dropped.
func ParseDotenv(content string) map[string]string { return parseDotenv(content, false) }

// parseDotenv is ParseDotenv; nodeBlank switches on Node's handling of a
// value of only spaces or tabs (the newline is trimmed too, and the next
// line becomes the value), so the tests can check every other rule against
// the recorded Node parser.
func parseDotenv(content string, nodeBlank bool) map[string]string {
	vars := map[string]string{}
	set := func(k, v string) {
		if k != "" {
			vars[k] = v
		}
	}
	s := trimDotenv(strings.ReplaceAll(content, "\r", ""))
	for s != "" {
		if s[0] == '\n' || s[0] == '#' {
			s = afterNewline(s, 0)
			continue
		}
		eq := strings.IndexAny(s, "=\n")
		if eq < 0 || s[eq] == '\n' {
			nl := strings.IndexByte(s, '\n')
			if nl < 0 {
				break
			}
			s = trimDotenv(s[nl+1:])
			continue
		}
		key := trimDotenv(s[:eq])
		s = s[eq+1:]
		if s == "" || s[0] == '\n' {
			// as Node: stored before "export " is removed
			set(key, "")
			continue
		}
		// Node trims spaces, tabs and newlines here; a newline right after
		// spaces and tabs is an empty value instead (see the notes above)
		if nodeBlank {
			s = strings.TrimLeft(s, dotenvSpace)
		} else {
			s = strings.TrimLeft(s, " \t")
		}
		blank := s != "" && s[0] == '\n'
		s = strings.TrimRight(s, dotenvSpace)
		if key == "" {
			// as Node: only the = is dropped; parsing goes on from the
			// value, so "=A=1" defines A
			continue
		}
		if strings.HasPrefix(key, "export ") {
			key = trimDotenv(key[len("export "):])
		}
		if s == "" {
			set(key, "")
			break
		}
		if blank {
			set(key, "")
			s = trimDotenv(s)
			continue
		}
		if s[0] == '"' {
			if end := strings.IndexByte(s[1:], '"'); end >= 0 {
				end++
				set(key, strings.ReplaceAll(s[1:end], "\\n", "\n"))
				// as Node: no trim before the next line is read
				s = afterNewline(s, end+1)
				continue
			}
		}
		if q := s[0]; q == '\'' || q == '"' || q == '`' {
			end := strings.IndexByte(s[1:], q)
			if end < 0 {
				// no closing quote: the rest of the line, opening quote
				// included
				nl := strings.IndexByte(s, '\n')
				if nl < 0 {
					set(key, s)
					break
				}
				set(key, s[:nl])
				s = s[nl:]
			} else {
				end++
				set(key, s[1:end])
				s = afterNewline(s, end+1)
			}
		} else {
			line, rest := s, ""
			if nl := strings.IndexByte(s, '\n'); nl >= 0 {
				line, rest = s[:nl], s[nl+1:]
			}
			if h := strings.IndexByte(line, '#'); h >= 0 {
				line = line[:h]
			}
			set(key, trimDotenv(line))
			s = rest
		}
		s = trimDotenv(s)
	}
	return vars
}
