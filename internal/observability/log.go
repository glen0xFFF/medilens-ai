// Package observability sets up the structured logs of the Go services (Go
// port spec §4, Logging): slog JSON lines on one writer, with redaction.
//
// Logs never carry request or response bodies, label values, questions,
// answers or keys. Three layers keep them out:
//
//  1. Callers log only plain values they chose: the access log has the
//     method, route pattern, status, duration and request id only, and an
//     error is logged by its type name (ErrorName), never its text.
//  2. Domain types implement slog.LogValuer with a whitelist of states and
//     counts (internal/contracts/logvalue.go), and config.Secret logs
//     [redacted].
//  3. ReplaceAttr is the backstop: the keys rawText, question, evidenceText
//     and authorization (any letter case, at any group depth) are
//     redacted, and so is any value slog would marshal with encoding/json
//     (a struct, map, slice, pointer or error that is not a LogValuer),
//     because ReplaceAttr never sees the fields inside such a value.
package observability

import (
	"fmt"
	"io"
	"log/slog"
	"strings"
)

// Redacted is written in place of a redacted value.
const Redacted = "[redacted]"

// redactedKeys are the keys whose values are always redacted (Node's
// REDACT_PATHS: req.headers.authorization, *.rawText, *.question,
// *.evidenceText), compared in lower case.
var redactedKeys = map[string]bool{
	"rawtext":       true,
	"question":      true,
	"evidencetext":  true,
	"authorization": true,
}

// ReplaceAttr is the redaction backstop (see the package comment). slog
// has already resolved LogValuers when it is called. slog calls it for the
// attributes inside a group with the group path, never for the group
// itself, so a value under a sensitive group name is redacted too, as
// pino's *.question redacted a whole object (final review M15).
func ReplaceAttr(groups []string, a slog.Attr) slog.Attr {
	if redactedKeys[strings.ToLower(a.Key)] {
		return slog.String(a.Key, Redacted)
	}
	for _, g := range groups {
		if redactedKeys[strings.ToLower(g)] {
			return slog.String(a.Key, Redacted)
		}
	}
	if a.Value.Kind() == slog.KindAny {
		// the record's own level is an Any value too
		if _, isLevel := a.Value.Any().(slog.Level); isLevel {
			return a
		}
		return slog.String(a.Key, Redacted)
	}
	return a
}

// New is the JSON logger writing one line per record to w, with
// ReplaceAttr.
func New(w io.Writer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{ReplaceAttr: ReplaceAttr}))
}

// ErrorName is what an error is logged as: its Go type, never its message,
// which could carry label text or a provider detail (Node logged the
// error's name only). "" for nil.
func ErrorName(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf("%T", err)
}
