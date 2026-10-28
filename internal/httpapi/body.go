package httpapi

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

// JSON request bodies (the explanation, speak and demo routes) are read as
// Node's express.json({limit: '16kb'}) read them (body-parser 2.4.0, each
// rule measured with Node v24.21.0 for task G8):
//
//   - Only a Content-Type of application/json (any case, any parameters)
//     is parsed; any other body counts as no body, so the route's own
//     schema message answers.
//   - A charset other than utf-8 is refused (body-parser: 415, which Node
//     mapped to 400).
//   - At most 16384 bytes.
//   - The bytes are decoded as UTF-8 the WHATWG way (one U+FFFD per
//     maximal invalid subpart, as Node's decoder), and one leading byte
//     order mark is dropped (iconv-lite).
//   - An empty body is {}. Otherwise the first character after JSON
//     whitespace must be { or [ (strict mode), and the whole body must be
//     one JSON value. Duplicate keys: the last one wins (JSON.parse).
//
// Every refusal is 400 VALIDATION_FAILED with Node's message.
//
// Known differences from Node: a body with a Content-Encoding other than
// identity is refused (Node inflated gzip, deflate and br), and so is a
// UTF-16 charset (Node decoded utf-16le).

// jsonBodyLimit is body-parser's '16kb'.
const jsonBodyLimit = 16 << 10

const invalidJSONMessage = "The request body is not valid JSON of up to 16 kB."

func invalidJSON() *pipeline.Error {
	return &pipeline.Error{Code: contracts.ErrValidationFailed, Message: invalidJSONMessage}
}

// readJSONObject reads the request's JSON body. It returns the members of
// a JSON object, or nil when there is no JSON body or it is not an object
// (an array), or a 400 error for a body express.json refused.
func readJSONObject(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, *pipeline.Error) {
	mt, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil && err != mime.ErrInvalidMediaParameter {
		return nil, nil
	}
	if mt != "application/json" {
		return nil, nil
	}
	if cs, ok := params["charset"]; ok && !strings.EqualFold(cs, "utf-8") {
		return nil, invalidJSON()
	}
	if enc := r.Header.Get("Content-Encoding"); enc != "" && !strings.EqualFold(enc, "identity") {
		return nil, invalidJSON()
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, jsonBodyLimit))
	if err != nil {
		return nil, invalidJSON()
	}
	body := decodeUTF8(raw)
	if len(body) >= 3 && body[0] == 0xef && body[1] == 0xbb && body[2] == 0xbf {
		body = body[3:]
	}
	if len(body) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	first := strings.TrimLeft(string(body), " \t\n\r")
	if first == "" || (first[0] != '{' && first[0] != '[') {
		return nil, invalidJSON()
	}
	var v json.RawMessage
	if err := json.Unmarshal(body, &v); err != nil {
		return nil, invalidJSON()
	}
	if first[0] == '[' {
		return nil, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(v, &fields); err != nil {
		return nil, invalidJSON()
	}
	return fields, nil
}

// stringField is the member name when it is a JSON string.
func stringField(fields map[string]json.RawMessage, name string) (string, bool) {
	raw, ok := fields[name]
	if !ok || len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

// decodeUTF8 is the WHATWG UTF-8 decoder (Encoding Standard, "UTF-8
// decoder"), as Node decodes a request body: each maximal subpart of an
// invalid sequence becomes one U+FFFD. Go's own decoding (encoding/json)
// gives one U+FFFD per byte instead, so a truncated sequence would count
// as two or three characters against the 300-character question limit.
func decodeUTF8(b []byte) []byte {
	if utf8.Valid(b) {
		return b
	}
	out := make([]byte, 0, len(b)+8)
	for i := 0; i < len(b); {
		c := b[i]
		if c < 0x80 {
			out = append(out, c)
			i++
			continue
		}
		need, lower, upper := 0, byte(0x80), byte(0xbf)
		switch {
		case c >= 0xc2 && c <= 0xdf:
			need = 1
		case c >= 0xe0 && c <= 0xef:
			need = 2
			if c == 0xe0 {
				lower = 0xa0
			} else if c == 0xed {
				upper = 0x9f
			}
		case c >= 0xf0 && c <= 0xf4:
			need = 3
			if c == 0xf0 {
				lower = 0x90
			} else if c == 0xf4 {
				upper = 0x8f
			}
		default:
			out = utf8.AppendRune(out, utf8.RuneError)
			i++
			continue
		}
		j := i + 1
		for k := 0; k < need; k++ {
			if j >= len(b) || b[j] < lower || b[j] > upper {
				break
			}
			lower, upper = 0x80, 0xbf
			j++
		}
		if j-i == need+1 {
			out = append(out, b[i:j]...)
		} else {
			// the maximal subpart b[i:j] is one U+FFFD; b[j] is read again
			out = utf8.AppendRune(out, utf8.RuneError)
		}
		i = j
	}
	return out
}
