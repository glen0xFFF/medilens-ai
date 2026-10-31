package contracts

import "log/slog"

// Log whitelists (Go port spec §4, Logging): what a domain value shows
// when it is passed to slog. Only states, keys, flags and counts; never a
// printed value, raw text, evidence, a registry row, an answer or summary
// text, a question, or an analysis id (the id is the only capability to
// read a result, so it stays out of the logs too). JSON is unchanged.

// LogValue logs the result's demo flag, states and field count.
func (r AnalysisResult) LogValue() slog.Value {
	fields := 0
	if r.Label != nil {
		fields = len(r.Label.Fields)
	}
	return slog.GroupValue(
		slog.Bool("isDemo", r.IsDemo),
		slog.String("pipelineState", string(r.PipelineState)),
		slog.String("matchStatus", string(r.Match.Status)),
		slog.Bool("qualityOk", r.Quality.OK),
		slog.Int("fields", fields),
	)
}

// LogValue logs the image kind and how many fields and warnings were read.
func (l ExtractedLabel) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("imageKind", string(l.ImageKind)),
		slog.Int("fields", len(l.Fields)),
		slog.Int("warnings", len(l.Warnings)),
	)
}

// LogValue logs the field's key, legibility and whether it has a value.
func (f LabelField) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("key", string(f.Key)),
		slog.String("legibility", string(f.Legibility)),
		slog.Bool("hasValue", f.Value != nil),
	)
}

// LogValue logs the match status and counts.
func (m MatchAssessment) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("status", string(m.Status)),
		slog.Int("matched", len(m.Matched)),
		slog.Int("conflicting", len(m.Conflicting)),
		slog.Int("missing", len(m.Missing)),
		slog.Int("candidates", len(m.Candidates)),
		slog.Int("advisories", len(m.Advisories)),
	)
}

// LogValue logs the answer's status and how many fields it cites.
func (a Answer) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("status", string(a.Status)),
		slog.Int("citedFields", len(a.CitedFields)),
	)
}

// LogValue logs the question's length only.
func (e ExplainRequest) LogValue() slog.Value {
	return slog.GroupValue(slog.Int("questionBytes", len(e.Question)))
}
