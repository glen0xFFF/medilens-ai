package mcptools

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/medilens-ai/medilens/internal/domain"
)

// The MCP server's transport and auth (Go port spec §5): stateless
// Streamable HTTP at Path, bearer tokens from MCP_API_TOKENS compared by
// SHA-256 in constant time, and a loopback-only opt-out.

const (
	// DefaultAddr is MCP_ADDR when unset: loopback only.
	DefaultAddr = "127.0.0.1:8788"
	// Path is where the Streamable HTTP handler is served.
	Path = "/mcp"
	// MaxRequestBodyBytes caps one HTTP request body (413 over it).
	MaxRequestBodyBytes = 30 << 20
	// MinTokenLength and MaxTokenLength bound each MCP_API_TOKENS entry.
	MinTokenLength = 16
	MaxTokenLength = 512
)

// tokenHash is the SHA-256 of a bearer token. The tokens themselves are
// never kept.
type tokenHash [sha256.Size]byte

// Config is the MCP server's own configuration (the providers come from
// internal/config, as for the API).
//
//   - MCP_ADDR: host:port to listen on; DefaultAddr when unset.
//   - MCP_API_TOKENS: comma-separated bearer tokens (16 to 512 visible
//     ASCII characters each; spaces around an entry and empty entries are
//     ignored). Only their SHA-256 hashes are kept.
//   - MCP_ALLOW_NO_AUTH: 1 serves without auth, on a loopback address only
//     and only when no token is configured; 0 or unset otherwise.
//
// It prints and logs no token or hash: only the counts.
type Config struct {
	Addr        string
	AllowNoAuth bool
	tokens      []tokenHash
}

// Format prints the config without the token hashes, whatever the verb.
func (c Config) Format(f fmt.State, _ rune) {
	_, _ = fmt.Fprintf(f, "{Addr:%s AllowNoAuth:%t Tokens:%d}", c.Addr, c.AllowNoAuth, len(c.tokens))
}

// LogValue logs the config without the token hashes.
func (c Config) LogValue() slog.Value {
	return slog.GroupValue(slog.String("addr", c.Addr), slog.Bool("allowNoAuth", c.AllowNoAuth), slog.Int("tokens", len(c.tokens)))
}

// AuthRequired reports whether bearer tokens are configured. With tokens,
// auth is always on, MCP_ALLOW_NO_AUTH notwithstanding.
func (c Config) AuthRequired() bool { return len(c.tokens) > 0 }

// TokenCount is the number of configured tokens.
func (c Config) TokenCount() int { return len(c.tokens) }

// LoadConfig reads MCP_ADDR, MCP_API_TOKENS and MCP_ALLOW_NO_AUTH through
// getenv. A bad value is an error naming each bad variable, never its
// value. Blank values mean "not set".
func LoadConfig(getenv func(string) string) (Config, error) {
	cfg := Config{Addr: DefaultAddr}
	var problems []string
	bad := func(name, rule string) { problems = append(problems, name+": "+rule) }

	if v := domain.JSTrim(getenv("MCP_ADDR")); v != "" {
		if validAddr(v) {
			cfg.Addr = v
		} else {
			bad("MCP_ADDR", "must be host:port, such as 127.0.0.1:8788")
		}
	}
	if v := getenv("MCP_API_TOKENS"); domain.JSTrim(v) != "" {
		if hashes, ok := parseTokens(v); ok {
			cfg.tokens = hashes
		} else {
			bad("MCP_API_TOKENS", fmt.Sprintf("must be a comma-separated list of tokens of %d to %d visible ASCII characters", MinTokenLength, MaxTokenLength))
		}
	}
	switch domain.JSTrim(getenv("MCP_ALLOW_NO_AUTH")) {
	case "", "0":
	case "1":
		cfg.AllowNoAuth = true
	default:
		bad("MCP_ALLOW_NO_AUTH", "must be 1 or unset")
	}
	if len(problems) > 0 {
		return Config{}, errors.New("invalid MCP configuration: " + strings.Join(problems, "; "))
	}
	return cfg, nil
}

func validAddr(s string) bool {
	_, port, err := net.SplitHostPort(s)
	if err != nil || port == "" || len(port) > 5 {
		return false
	}
	for _, c := range port {
		if c < '0' || c > '9' {
			return false
		}
	}
	n, err := strconv.Atoi(port)
	return err == nil && n <= 65535
}

func parseTokens(s string) ([]tokenHash, bool) {
	var out []tokenHash
	for _, part := range strings.Split(s, ",") {
		tok := strings.TrimSpace(part)
		if tok == "" {
			continue
		}
		if len(tok) < MinTokenLength || len(tok) > MaxTokenLength {
			return nil, false
		}
		for i := 0; i < len(tok); i++ {
			// visible ASCII: a token with a space could never be sent
			// (the Authorization header is split on whitespace)
			if tok[i] < 0x21 || tok[i] > 0x7e {
				return nil, false
			}
		}
		out = append(out, sha256.Sum256([]byte(tok)))
	}
	return out, len(out) > 0
}

// errNoTokens and errNotLoopback are the startup refusals (Go port spec
// §5: with no tokens the server refuses to start unless MCP_ALLOW_NO_AUTH=1
// AND the bind is loopback).
var (
	errNoTokens    = errors.New("MCP_API_TOKENS: required; set MCP_ALLOW_NO_AUTH=1 to serve without auth on a loopback address")
	errNotLoopback = errors.New("MCP_API_TOKENS: required to listen on a non-loopback address; MCP_ALLOW_NO_AUTH=1 applies to loopback only")
)

// CheckBind is the check before listening: with tokens any address is
// allowed; without, MCP_ALLOW_NO_AUTH=1 and a loopback MCP_ADDR are
// required. A loopback address is an IP literal in 127.0.0.0/8 or ::1 (an
// IPv4-mapped form included), or "localhost", whose bound address
// CheckListener then verifies. Any other host name, and an empty host
// (every interface), is not loopback.
func (c Config) CheckBind() error {
	if c.AuthRequired() {
		return nil
	}
	if !c.AllowNoAuth {
		return errNoTokens
	}
	host, _, err := net.SplitHostPort(c.Addr)
	if err != nil {
		return errNotLoopback
	}
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	if a, err := netip.ParseAddr(host); err == nil && a.Unmap().IsLoopback() {
		return nil
	}
	return errNotLoopback
}

// CheckListener is the check after listening: an open server (no tokens)
// must be bound to a loopback TCP address, whatever MCP_ADDR resolved to.
func (c Config) CheckListener(addr net.Addr) error {
	if c.AuthRequired() {
		return nil
	}
	if !c.AllowNoAuth {
		return errNoTokens
	}
	tcp, ok := addr.(*net.TCPAddr)
	if !ok {
		return errNotLoopback
	}
	a, ok := netip.AddrFromSlice(tcp.IP)
	if !ok || !a.Unmap().IsLoopback() {
		return errNotLoopback
	}
	return nil
}

// errInvalidToken is every refused token: 401 with a fixed message that
// never shows the token.
var errInvalidToken = fmt.Errorf("mcp: %w", auth.ErrInvalidToken)

// verifier checks a bearer token against the configured hashes: the
// token's SHA-256 is compared with every hash in constant time, with no
// early exit. A token carries no expiration (AllowMissingExpiration).
func (c Config) verifier() auth.TokenVerifier {
	hashes := append([]tokenHash(nil), c.tokens...)
	return func(_ context.Context, token string, _ *http.Request) (*auth.TokenInfo, error) {
		h := sha256.Sum256([]byte(token))
		match := 0
		for i := range hashes {
			match |= subtle.ConstantTimeCompare(h[:], hashes[i][:])
		}
		if match != 1 {
			return nil, errInvalidToken
		}
		return &auth.TokenInfo{}, nil
	}
}

// NewHTTPHandler serves s over stateless Streamable HTTP (Go port spec §5):
// MaxRequestBodyBytes, request cancellation reaching the tool, the SDK's
// DNS-rebinding guard for loopback, cross-origin browser requests refused,
// and bearer auth when tokens are configured. It refuses to build an open
// handler unless MCP_ALLOW_NO_AUTH=1 (the bind itself is checked by
// CheckBind and CheckListener).
func NewHTTPHandler(s *mcp.Server, cfg Config) (http.Handler, error) {
	if s == nil {
		return nil, errors.New("mcptools: a server is required")
	}
	if !cfg.AuthRequired() && !cfg.AllowNoAuth {
		return nil, errNoTokens
	}
	var h http.Handler = mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s }, &mcp.StreamableHTTPOptions{
		Stateless:                    true,
		PropagateRequestCancellation: true,
		MaxRequestBodyBytes:          MaxRequestBodyBytes,
	})
	if cfg.AuthRequired() {
		h = auth.RequireBearerToken(cfg.verifier(), &auth.RequireBearerTokenOptions{AllowMissingExpiration: true})(h)
	}
	return http.NewCrossOriginProtection().Handler(h), nil
}
