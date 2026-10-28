package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// nodeDotenvCases are .env files and what Node v24.21.0's
// process.loadEnvFile set from each (measured for task G8 with a probe
// script over every case; the keys were absent beforehand). The Go loader
// must set the same.
var nodeDotenvCases = []struct {
	name, content string
	want          map[string]string
}{
	{"plain", "A=plain\n", map[string]string{"A": "plain"}},
	{"noNewlineAtEOF", "A=plain", map[string]string{"A": "plain"}},
	{"emptyValue", "A=\nB=x\n", map[string]string{"A": "", "B": "x"}},
	{"emptyAtEOF", "A=", map[string]string{"A": ""}},
	{"noEquals", "A\nB=x\n", map[string]string{"B": "x"}},
	{"inlineComment", "A=x # c\n", map[string]string{"A": "x"}},
	{"hashNoSpace", "A=has#hash\n", map[string]string{"A": "has"}},
	{"onlyHash", "A=#x\n", map[string]string{"A": ""}},
	{"dqInlineComment", "A=\"dq\" # c\n", map[string]string{"A": "dq"}},
	{"dqHash", "A=\"#notcomment\"\n", map[string]string{"A": "#notcomment"}},
	{"sqHash", "A='#nc' # c\n", map[string]string{"A": "#nc"}},
	{"btHash", "A=`#nc` # c\n", map[string]string{"A": "#nc"}},
	{"dqEscN", "A=\"a\\nb\"\n", map[string]string{"A": "a\nb"}},
	{"sqEscN", "A='a\\nb'\n", map[string]string{"A": "a\\nb"}},
	{"btEscN", "A=`a\\nb`\n", map[string]string{"A": "a\\nb"}},
	{"plainEscN", "A=a\\nb\n", map[string]string{"A": "a\\nb"}},
	{"dqEscapedQuote", "A=\"a\\\"b\"\n", map[string]string{"A": "a\\"}},
	{"dqDoubleBackslashN", "A=\"a\\\\nb\"\n", map[string]string{"A": "a\\\nb"}},
	{"dqEscT", "A=\"a\\tb\"\n", map[string]string{"A": "a\\tb"}},
	{"dqTwoEscN", "A=\"\\n\\n\"\n", map[string]string{"A": "\n\n"}},
	{"dqMultiline", "A=\"l1\nl2\"\nB=x\n", map[string]string{"A": "l1\nl2", "B": "x"}},
	{"sqMultiline", "A='l1\nl2'\nB=x\n", map[string]string{"A": "l1\nl2", "B": "x"}},
	{"btMultiline", "A=`l1\nl2`\nB=x\n", map[string]string{"A": "l1\nl2", "B": "x"}},
	{"dqUnterminated", "A=\"abc\nB=x\n", map[string]string{"A": "\"abc", "B": "x"}},
	{"sqUnterminated", "A='abc\nB=x\n", map[string]string{"A": "'abc", "B": "x"}},
	{"btUnterminated", "A=`x\nB=y\n", map[string]string{"A": "`x", "B": "y"}},
	{"dqUnterminatedEOF", "A=\"abc", map[string]string{"A": "\"abc"}},
	{"sqUnterminatedEOF", "A='abc", map[string]string{"A": "'abc"}},
	{"dqSpanToNextQuote", "A=\"x\nB=\"y\"\nC=z\n", map[string]string{"A": "x\nB=", "C": "z"}},
	{"sqSpanToNextQuote", "A='x\nB='y'\nC=z\n", map[string]string{"A": "x\nB=", "C": "z"}},
	{"dqTrailingText", "A=\"a\"b\nB=x\n", map[string]string{"A": "a", "B": "x"}},
	{"dqInnerSpaces", "A=\"  a  \"\n", map[string]string{"A": "  a  "}},
	{"dqThenSpaces", "A=\"q\"   \nB=x\n", map[string]string{"A": "q", "B": "x"}},
	{"dqThenComment", "A=\"q\"\n# c\nB=y\n", map[string]string{"A": "q", "B": "y"}},
	{"spaceBeforeDQ", "A= \"q\"\n", map[string]string{"A": "q"}},
	{"emptyDQ", "A=\"\"\n", map[string]string{"A": ""}},
	{"emptySQ", "A=''\n", map[string]string{"A": ""}},
	{"singleQuoteAlone", "A='\n", map[string]string{"A": "'"}},
	{"equalsInDQ", "A=\"a=b\"\n", map[string]string{"A": "a=b"}},
	{"valueWithQuoteInside", "A=a\"b\n", map[string]string{"A": "a\"b"}},
	{"spacesAround", "  A  =  v  \n", map[string]string{"A": "v"}},
	{"tabsAround", "\tA\t=\tv\t\n", map[string]string{"A": "v"}},
	{"keyTrailingTab", "A\t=v\n", map[string]string{"A": "v"}},
	{"exportPrefix", "export A=e\n", map[string]string{"A": "e"}},
	{"exportSpaces", "export   A=e\n", map[string]string{"A": "e"}},
	{"exportNoSpace", "exportA=e\n", map[string]string{"exportA": "e"}},
	{"exportTab", "export\tA=e\n", map[string]string{"export\tA": "e"}},
	{"exportOnly", "export =v\nB=x\n", map[string]string{"export": "v", "B": "x"}},
	{"exportKeyEmpty", "export A=\nB=x\n", map[string]string{"export A": "", "B": "x"}},
	{"doubleEquals", "A==eq\n", map[string]string{"A": "=eq"}},
	{"emptyKey", "=v\nB=x\n", map[string]string{"B": "x"}},
	{"keyOnlySpaces", "   =v\nB=x\n", map[string]string{"B": "x"}},
	{"equalsAfterNewlineNoKey", "A\n=x\nB=y\n", map[string]string{"B": "y"}},
	{"indentedComment", "  # C=1\nB=x\n", map[string]string{"B": "x"}},
	{"commentWithEquals", "# C=1\nB=x\n", map[string]string{"B": "x"}},
	{"hashKey", "#A=1\nB=2", map[string]string{"B": "2"}},
	{"spaceBeforeHashComment", "A=x\n   #C=1\nB=y\n", map[string]string{"A": "x", "B": "y"}},
	{"hashAfterSpacesOnly", "A=   # c\nB=x\n", map[string]string{"A": "", "B": "x"}},
	{"duplicateKey", "A=1\nA=2\n", map[string]string{"A": "2"}},
	{"crlf", "A=crlf\r\nB=\"q\"\r\n", map[string]string{"A": "crlf", "B": "q"}},
	{"crInValue", "A=a\rb\n", map[string]string{"A": "ab"}},
	{"valueOnlyCR", "A=\r\nB=x\n", map[string]string{"A": "", "B": "x"}},
	{"keyWithSpace", "Z A=1\n", map[string]string{"Z A": "1"}},
	{"quoteInKey", "\"A\"=v\n", map[string]string{"\"A\"": "v"}},
	{"vtKey", "\vA=v\n", map[string]string{"\vA": "v"}},
	{"dollar", "A=abc$HOME\n", map[string]string{"A": "abc$HOME"}},
	{"dollarBraces", "A=${HOME}\n", map[string]string{"A": "${HOME}"}},
	{"nbspValue", "A= v \n", map[string]string{"A": " v "}},
	{"vtabValue", "A=\vv\v\n", map[string]string{"A": "\vv\v"}},
	{"ffValue", "A=\fv\f\n", map[string]string{"A": "\fv\f"}},
	{"leadingBlankLines", "\n\n  \nA=1\n", map[string]string{"A": "1"}},
	{"blankLineWithSpaces", "A=1\n   \nB=2\n", map[string]string{"A": "1", "B": "2"}},
	{"newlineOnlyFile", "\n\n", map[string]string{}},
	{"bomStart", "\xef\xbb\xbfA=1\n", map[string]string{"\xef\xbb\xbfA": "1"}},
	{"spacesAtEOF", "A=   ", map[string]string{"A": ""}},
	{"keySpacesNewline", "A \nB=x\n", map[string]string{"B": "x"}},
}

func TestParseDotenvMatchesNode(t *testing.T) {
	for _, c := range nodeDotenvCases {
		if got := ParseDotenv(c.content); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s %q: got %q, want %q", c.name, c.content, got, c.want)
		}
	}
}

// The one deliberate difference from Node: a value of only spaces or tabs
// is empty. Node trims the newline too and reads the next line as the
// value ("A=   \nB=x" sets A to "B=x" and loses B), so one blank-looking
// line could silently swallow the next variable.
func TestParseDotenvBlankValueDoesNotSwallowTheNextLine(t *testing.T) {
	for _, content := range []string{"A=   \nB=x\n", "A=\t\nB=x\n", "A= \t \nB=x"} {
		want := map[string]string{"A": "", "B": "x"}
		if got := ParseDotenv(content); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %q, want %q", content, got, want)
		}
	}
}

// LoadDotenv sets what the file gives, never overrides a variable already
// set (even to ""), and ignores a missing file, as process.loadEnvFile in
// Node's loadRootEnv.
func TestLoadDotenv(t *testing.T) {
	const a, b, c, d = "MEDILENS_G8_TEST_A", "MEDILENS_G8_TEST_B", "MEDILENS_G8_TEST_C", "MEDILENS_G8_TEST_D"
	for _, k := range []string{a, b, c, d} {
		t.Setenv(k, "restored-by-cleanup")
		if err := os.Unsetenv(k); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv(b, "from_env")
	t.Setenv(d, "")
	path := filepath.Join(t.TempDir(), ".env")
	content := a + "=from_file # comment\n" + b + "=from_file\n" + c + "=\n" + d + "=from_file\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := LoadDotenv(path); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]string{a: "from_file", b: "from_env", c: "", d: ""} {
		got, ok := os.LookupEnv(k)
		if !ok || got != want {
			t.Errorf("%s = %q (set %v), want %q", k, got, ok, want)
		}
	}
	if err := LoadDotenv(filepath.Join(t.TempDir(), "missing.env")); err != nil {
		t.Errorf("a missing file is not an error: %v", err)
	}
	// a directory where the file should be is reported, never read as empty
	if err := LoadDotenv(t.TempDir()); err == nil {
		t.Error("a directory was read as a .env file")
	}
}

// DotenvPath is ENV_FILE when set, else .env in the working directory.
func TestDotenvPath(t *testing.T) {
	if got := DotenvPath(env(nil)); got != ".env" {
		t.Errorf("default %q", got)
	}
	if got := DotenvPath(env(map[string]string{"ENV_FILE": " /etc/medilens.env "})); got != "/etc/medilens.env" {
		t.Errorf("ENV_FILE %q", got)
	}
}
