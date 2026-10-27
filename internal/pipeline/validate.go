package pipeline

import (
	"math"
	"regexp"

	"github.com/medilens-ai/medilens/internal/contracts"
)

// The contract checks Node ran with Zod before it stored a result
// (AnalysisResultSchema.safeParse) or returned an answer (AnswerSchema):
// a provider that breaks the contract is INTERNAL_ERROR, never stored or
// shown. Like zod, the result check also outputs the parsed value: an
// httpUrl is stored as zod outputs it (trimmed, with ASCII tab and newline
// removed), as Node stored parsed.data.

// isoDatetime is zod 4.6.7's z.iso.datetime() with its defaults (no
// offset, no local time, any sub-second precision): node_modules/zod/v4/
// core/regexes.js datetime({}). \d is ASCII in both JS (no u flag) and RE2.
var isoDatetime = regexp.MustCompile(`^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z))$`)

// zodNumber is z.number(): finite (zod 4 rejects NaN and ±Infinity).
func zodNumber(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }

func validKeys(keys []contracts.FieldKey) bool {
	for _, k := range keys {
		if !k.Valid() {
			return false
		}
	}
	return true
}

func conformQuality(q contracts.QualityReport) bool {
	if !zodNumber(q.Sharpness) || q.Sharpness < 0 ||
		!zodNumber(q.Luminance) || q.Luminance < 0 || q.Luminance > 255 ||
		!zodNumber(q.GlareFraction) || q.GlareFraction < 0 || q.GlareFraction > 1 {
		return false
	}
	for _, r := range q.Reasons {
		if !r.Valid() {
			return false
		}
	}
	return true
}

func conformLabel(l *contracts.ExtractedLabel) bool {
	if l == nil {
		return true
	}
	if !l.ImageKind.Valid() {
		return false
	}
	for _, f := range l.Fields {
		if !f.Key.Valid() || !f.Legibility.Valid() || (f.ImageIndex != nil && *f.ImageIndex < 0) {
			return false
		}
	}
	return true
}

// conformMatch checks m and rewrites its URLs to zod's output.
func conformMatch(m *contracts.MatchAssessment) bool {
	if !m.Status.Valid() || !validKeys(m.Matched) || !validKeys(m.Missing) {
		return false
	}
	for _, c := range m.Conflicting {
		if !c.Key.Valid() {
			return false
		}
	}
	for i := range m.Candidates {
		c := &m.Candidates[i]
		u, ok := contracts.ParseHTTPURL(c.SourceURL)
		if !ok || !isoDatetime.MatchString(c.CheckedAt) {
			return false
		}
		c.SourceURL = u
	}
	for i := range m.Advisories {
		u, ok := contracts.ParseHTTPURL(m.Advisories[i].URL)
		if !ok {
			return false
		}
		m.Advisories[i].URL = u
	}
	return true
}

// conformResult is AnalysisResultSchema.safeParse: it reports whether r
// conforms, and rewrites r's URLs to the schema's output.
func conformResult(r *contracts.AnalysisResult) bool {
	return r.ID != "" &&
		isoDatetime.MatchString(r.CreatedAt) && isoDatetime.MatchString(r.ExpiresAt) &&
		r.PipelineState.Valid() &&
		conformQuality(r.Quality) &&
		conformLabel(r.Label) &&
		conformMatch(&r.Match) &&
		validKeys(r.Explanation.SupportingFields) &&
		(r.ImageRetention == "" || r.ImageRetention == contracts.ImageRetentionNone)
}

// conformAnswer is AnswerSchema.safeParse.
func conformAnswer(a contracts.Answer) bool {
	return a.Status.Valid() && validKeys(a.CitedFields)
}
