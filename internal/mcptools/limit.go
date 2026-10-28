package mcptools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/domain"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

// Output limits (Go port spec §5): every tool output is at most
// MaxOutputBytes of JSON, long text cut with TruncationMarker; the SDK's
// own argument and protocol errors, which quote what was sent, are cut
// short too.

const (
	// MaxOutputBytes is the most JSON one tool output (its structured
	// content) may take. The SDK repeats it as the text content, for
	// clients that predate structured content.
	MaxOutputBytes = 64 << 10
	// TruncationMarker ends every text cut to fit.
	TruncationMarker = " [truncated]"
	// MinKeptRunes: a text is never cut to fewer characters than this, so
	// short text (ids, enums, URLs, the fixed safety sentences) is kept
	// whole. An output that cannot fit that way is an error, never a
	// silently shortened list.
	MinKeptRunes = 512
	// maxErrorRunes bounds the quoted part of an SDK argument or protocol
	// error.
	maxErrorRunes = 300
)

// errTooLarge: the output does not fit even with every long text cut.
var errTooLarge = &toolError{code: contracts.ErrInternal, message: "The result is too large to return over MCP."}

// capOutput returns out unchanged when its JSON fits in MaxOutputBytes.
// Otherwise every string longer than a common length is cut to that
// length plus TruncationMarker, the longest length that fits being found
// by bisection; the shape (keys, arrays, numbers, nulls) never changes.
// A cut never ends inside one of the fixed sentences that may say "fake"
// or "counterfeit", so cutting can never leave such a word outside them.
func capOutput[T any](out T) (T, error) {
	var zero T
	b, err := json.Marshal(out)
	if err != nil {
		return zero, internalError()
	}
	if len(b) <= MaxOutputBytes {
		return out, nil
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var tree any
	if err := dec.Decode(&tree); err != nil {
		return zero, internalError()
	}
	longest := longestText(tree)
	fits := func(keep int) ([]byte, bool) {
		cb, err := json.Marshal(cutTree(tree, keep))
		return cb, err == nil && len(cb) <= MaxOutputBytes
	}
	lo, hi := MinKeptRunes, longest
	best, ok := fits(lo)
	if longest <= MinKeptRunes || !ok {
		return zero, errTooLarge
	}
	for lo < hi {
		mid := lo + (hi-lo+1)/2
		if cb, ok := fits(mid); ok {
			lo, best = mid, cb
		} else {
			hi = mid - 1
		}
	}
	var res T
	if err := json.Unmarshal(best, &res); err != nil {
		return zero, internalError()
	}
	return res, nil
}

func longestText(v any) int {
	n := 0
	switch x := v.(type) {
	case string:
		n = utf8.RuneCountInString(x)
	case []any:
		for _, e := range x {
			n = max(n, longestText(e))
		}
	case map[string]any:
		for _, e := range x {
			n = max(n, longestText(e))
		}
	}
	return n
}

// cutTree is a copy of v with every string over keep characters (plus the
// marker's length, so a cut never makes a string longer) cut.
func cutTree(v any, keep int) any {
	switch x := v.(type) {
	case string:
		if utf8.RuneCountInString(x) > keep+utf8.RuneCountInString(TruncationMarker) {
			return cutText(x, keep)
		}
		return x
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = cutTree(e, keep)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = cutTree(e, keep)
		}
		return out
	}
	return v
}

// fixedFakeSentences are the fixed texts that may say "fake" or
// "counterfeit" (pipeline.MentionsFake allows them, sentence by sentence):
// the FDA advisory sentence and the no-match sentence, whole and each of
// their sentences that has such a word. A cut never ends inside one.
var fixedFakeSentences = func() []string {
	var out []string
	for _, s := range []string{domain.CounterfeitAdvisorySentence, domain.StatusSentence[contracts.MatchNoMatch]} {
		out = append(out, s)
		for _, part := range strings.SplitAfter(s, ". ") {
			part = strings.TrimSpace(part)
			// the fixed sentences are ASCII
			lower := strings.ToLower(part)
			if part != s && (strings.Contains(lower, "fake") || strings.Contains(lower, "counterfeit")) {
				out = append(out, part)
			}
		}
	}
	return out
}()

// cutText keeps the first keep characters of s, moved back to the start
// of any fixed sentence the cut would split, and appends the marker. Fail
// closed: should the cut still say "fake" or "counterfeit" where s did
// not, only the marker is kept.
func cutText(s string, keep int) string {
	end := len(s)
	for i := range s {
		if keep == 0 {
			end = i
			break
		}
		keep--
	}
	for moved := true; moved; {
		moved = false
		for _, f := range fixedFakeSentences {
			for from := 0; from < end; {
				j := strings.Index(s[from:], f)
				if j < 0 {
					break
				}
				j += from
				if j < end && end < j+len(f) {
					end, moved = j, true
					break
				}
				from = j + 1
			}
		}
	}
	out := s[:end] + TruncationMarker
	if pipeline.MentionsFake(out) && !pipeline.MentionsFake(s) {
		return strings.TrimSpace(TruncationMarker)
	}
	return out
}

// shortText is s cut to maxErrorRunes characters with the marker.
func shortText(s string) string {
	if utf8.RuneCountInString(s) <= maxErrorRunes {
		return s
	}
	n := 0
	for i := range s {
		if n == maxErrorRunes {
			return s[:i] + TruncationMarker
		}
		n++
	}
	return s
}

// boundResults is the server's receiving middleware for tools/call:
//
//   - a tool error of ours (*toolError) passes as it is;
//   - any other tool error is the SDK refusing the arguments (schema or
//     decoding), whose text quotes what was sent: it becomes
//     VALIDATION_FAILED with that text cut short;
//   - a result whose structured content is over MaxOutputBytes (which
//     capOutput prevents) is replaced by an error;
//   - a protocol error (an unknown tool, a failed output check) keeps its
//     code with its message cut short, and any other error is replaced by
//     the fixed INTERNAL_ERROR text.
func boundResults(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		res, err := next(ctx, method, req)
		if method != "tools/call" {
			return res, err
		}
		if err != nil {
			var we *jsonrpc.Error
			if errors.As(err, &we) {
				return nil, &jsonrpc.Error{Code: we.Code, Message: shortText(we.Message)}
			}
			return nil, &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: internalError().Error()}
		}
		r, ok := res.(*mcp.CallToolResult)
		if !ok || r == nil {
			return res, nil
		}
		if r.IsError {
			var te *toolError
			if errors.As(r.GetError(), &te) {
				return r, nil
			}
			text := "The arguments are not valid."
			if e := r.GetError(); e != nil {
				text += " " + shortText(e.Error())
			}
			return errorResult(&toolError{code: contracts.ErrValidationFailed, message: text}), nil
		}
		if r.StructuredContent != nil {
			b, err := json.Marshal(r.StructuredContent)
			if err != nil || len(b) > MaxOutputBytes {
				return errorResult(errTooLarge), nil
			}
		}
		return r, nil
	}
}

func errorResult(e *toolError) *mcp.CallToolResult {
	r := &mcp.CallToolResult{}
	r.SetError(e)
	return r
}
