package mcptools

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/auth"
)

const (
	tokenA = "SECRET-token-aaaaaaaaaaaaaaaa"
	tokenB = "SECRET-token-bbbbbbbbbbbbbbbb"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestLoadConfigDefaults(t *testing.T) {
	c, err := LoadConfig(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if DefaultAddr != "127.0.0.1:8788" || c.Addr != DefaultAddr || c.AuthRequired() || c.TokenCount() != 0 || c.AllowNoAuth {
		t.Fatalf("%+v", c)
	}
}

func TestLoadConfigTokensAreHashedNeverKept(t *testing.T) {
	c, err := LoadConfig(env(map[string]string{"MCP_API_TOKENS": " " + tokenA + " ,, " + tokenB + ",", "MCP_ADDR": "0.0.0.0:9000"}))
	if err != nil {
		t.Fatal(err)
	}
	if !c.AuthRequired() || c.TokenCount() != 2 || c.Addr != "0.0.0.0:9000" {
		t.Fatalf("%+v", c)
	}
	for _, s := range []string{fmt.Sprintf("%v", c), fmt.Sprintf("%+v", c), fmt.Sprintf("%#v", c)} {
		if strings.Contains(s, "SECRET") || strings.Contains(s, "aaaa") {
			t.Errorf("the config prints a token: %s", s)
		}
	}
}

func TestLoadConfigRejectsBadValuesNamingOnlyTheVariable(t *testing.T) {
	for _, c := range []struct {
		env  map[string]string
		name string
	}{
		{map[string]string{"MCP_API_TOKENS": "SECRET-short"}, "MCP_API_TOKENS"},
		{map[string]string{"MCP_API_TOKENS": "SECRET-has a-space-in-it-xxxxx"}, "MCP_API_TOKENS"},
		{map[string]string{"MCP_API_TOKENS": "SECRET-non-ascii-éééééééééééééé"}, "MCP_API_TOKENS"},
		{map[string]string{"MCP_API_TOKENS": " , ,"}, "MCP_API_TOKENS"},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "SECRET-yes"}, "MCP_ALLOW_NO_AUTH"},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "true"}, "MCP_ALLOW_NO_AUTH"},
		{map[string]string{"MCP_ADDR": "SECRET-no-port"}, "MCP_ADDR"},
		{map[string]string{"MCP_ADDR": "127.0.0.1:SECRET"}, "MCP_ADDR"},
		{map[string]string{"MCP_ADDR": "127.0.0.1:70000"}, "MCP_ADDR"},
	} {
		_, err := LoadConfig(env(c.env))
		if err == nil {
			t.Errorf("%v: accepted", c.env)
			continue
		}
		if !strings.Contains(err.Error(), c.name) || strings.Contains(err.Error(), "SECRET") {
			t.Errorf("%v: %v", c.env, err)
		}
	}
	for _, v := range []string{"", "0", " 0 ", "1", " 1"} {
		c, err := LoadConfig(env(map[string]string{"MCP_ALLOW_NO_AUTH": v}))
		if err != nil || c.AllowNoAuth != (strings.TrimSpace(v) == "1") {
			t.Errorf("%q: %+v %v", v, c, err)
		}
	}
}

// Go port spec §5: with no tokens the server refuses to start unless
// MCP_ALLOW_NO_AUTH=1 AND the bind is loopback. Tokens always win.
func TestCheckBind(t *testing.T) {
	for _, c := range []struct {
		env  map[string]string
		pass bool
	}{
		// no tokens, no opt-out: refused everywhere
		{map[string]string{}, false},
		{map[string]string{"MCP_ADDR": "0.0.0.0:8788"}, false},
		// no tokens + opt-out: loopback only
		{map[string]string{"MCP_ALLOW_NO_AUTH": "1"}, true},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "127.0.0.1:0"}, true},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "127.9.9.9:8788"}, true},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "[::1]:8788"}, true},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "localhost:8788"}, true},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "0.0.0.0:8788"}, false},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": ":8788"}, false},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "[::]:8788"}, false},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "192.168.1.20:8788"}, false},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "[::ffff:127.0.0.1]:8788"}, true},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "[::ffff:10.0.0.1]:8788"}, false},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "medilens.example:8788"}, false},
		{map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "localhost.attacker.example:8788"}, false},
		// tokens: any bind
		{map[string]string{"MCP_API_TOKENS": tokenA, "MCP_ADDR": "0.0.0.0:8788"}, true},
		{map[string]string{"MCP_API_TOKENS": tokenA, "MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "0.0.0.0:8788"}, true},
	} {
		cfg, err := LoadConfig(env(c.env))
		if err != nil {
			t.Fatalf("%v: %v", c.env, err)
		}
		if err := cfg.CheckBind(); (err == nil) != c.pass {
			t.Errorf("%v: CheckBind %v", c.env, err)
		}
		if c.env["MCP_API_TOKENS"] != "" && !cfg.AuthRequired() {
			t.Errorf("%v: tokens configured but auth is off", c.env)
		}
	}
}

// The bound address is checked too: a host name that resolved off
// loopback never serves without auth.
func TestCheckListener(t *testing.T) {
	open, err := LoadConfig(env(map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "localhost:8788"}))
	if err != nil {
		t.Fatal(err)
	}
	locked, err := LoadConfig(env(map[string]string{"MCP_API_TOKENS": tokenA}))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		addr       net.Addr
		openPasses bool
	}{
		{&net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 8788}, true},
		{&net.TCPAddr{IP: net.IPv6loopback, Port: 8788}, true},
		{&net.TCPAddr{IP: net.IPv4zero, Port: 8788}, false},
		{&net.TCPAddr{IP: net.IPv4(10, 0, 0, 5), Port: 8788}, false},
		{&net.UnixAddr{Name: "x", Net: "unix"}, false},
	} {
		if err := open.CheckListener(c.addr); (err == nil) != c.openPasses {
			t.Errorf("no auth on %v: %v", c.addr, err)
		}
		if err := locked.CheckListener(c.addr); err != nil {
			t.Errorf("auth on %v: %v", c.addr, err)
		}
	}
}

func TestTheVerifierComparesHashedTokens(t *testing.T) {
	cfg, err := LoadConfig(env(map[string]string{"MCP_API_TOKENS": tokenA + "," + tokenB}))
	if err != nil {
		t.Fatal(err)
	}
	verify := cfg.verifier()
	r := httptest.NewRequest("POST", "/mcp", nil)
	for _, tok := range []string{tokenA, tokenB} {
		info, err := verify(context.Background(), tok, r)
		if err != nil || info == nil || !info.Expiration.IsZero() {
			t.Errorf("valid token refused: %v %+v", err, info)
		}
	}
	for _, tok := range []string{"", tokenA[:len(tokenA)-1], tokenA + "x", strings.ToUpper(tokenA), " " + tokenA, tokenA + tokenB, "SECRET-token-cccccccccccccccc"} {
		info, err := verify(context.Background(), tok, r)
		if err == nil || info != nil || !errors.Is(err, auth.ErrInvalidToken) {
			t.Errorf("%q: %+v %v", tok, info, err)
			continue
		}
		if strings.Contains(err.Error(), "SECRET") || strings.Contains(err.Error(), "aaaa") {
			t.Errorf("the error shows a token: %v", err)
		}
	}
}

func TestNewHTTPHandlerRefusesAnOpenServerThatWasNotAllowed(t *testing.T) {
	cfg, err := LoadConfig(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewHTTPHandler(NewServer(&fakeService{}, Options{}), cfg); err == nil {
		t.Fatal("an open handler was built with no tokens and no MCP_ALLOW_NO_AUTH")
	}
}
