// Package pipeline is the analysis pipeline (base spec §4.1, Go port spec
// §4), a port of apps/server/src/pipeline: steps 1 to 3 (validate,
// normalise, quality) run on the uploaded bytes in memory; steps 4 to 8
// (read, review the fields, look up, match, summarise) are shared with the
// demo scenarios, which supply their own quality report. The model only
// transcribes: the registry query, the match and the summary are
// deterministic code. The package also holds the result store, the
// progress events, the spend meter and the follow-up question flow.
//
// Unlike Node, the pipeline does not store its result: the application
// service runs it in a worker pool and records the outcome.
package pipeline

import (
	"context"
	"errors"
	"time"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/domain"
	"github.com/medilens-ai/medilens/internal/imaging"
	"github.com/medilens-ai/medilens/internal/references"
)

const (
	// MinImages and MaxImages bound one scan (1 to 3 sides of a box).
	MinImages = 1
	MaxImages = 3
	// NotEnoughTextNote is the limitation of a label with no clear text to
	// search the registry for.
	NotEnoughTextNote = "Not enough clear text to search the registry."
)

// Deps are what one analysis runs with.
type Deps struct {
	// Reader and References are the configured providers. AnalyzeScenario
	// ignores them: demo scenarios always run on the fixtures.
	Reader     ai.LabelReader
	References references.Provider
	// Now is the clock for createdAt and expiresAt; nil uses time.Now.
	Now func() time.Time
	// TTL sets expiresAt = createdAt + TTL; <= 0 means ResultTTL.
	TTL time.Duration
	// IsDemo marks the results of AnalyzeImages as demo data (made-up
	// label or registry rows). AnalyzeScenario results are always demo.
	IsDemo bool
	// Provenance, when set, is copied into AnalyzeImages results.
	Provenance *contracts.Provenance
	// Emit is called as each stage starts; nil ignores the stages.
	Emit func(Stage)
	// OnUsage receives the usage of every reader call, a failed or cut-off
	// one included, for the spend meter; nil ignores it.
	OnUsage func(ai.Usage)
}

func (d Deps) now() time.Time {
	if d.Now == nil {
		return time.Now()
	}
	return d.Now()
}

func (d Deps) ttl() time.Duration {
	if d.TTL <= 0 {
		return ResultTTL
	}
	return d.TTL
}

func (d Deps) emit(s Stage) {
	if d.Emit != nil {
		d.Emit(s)
	}
}

func (d Deps) charge(u ai.Usage) {
	if d.OnUsage != nil && u != (ai.Usage{}) {
		d.OnUsage(u)
	}
}

const sendPhotos = `Send 1 to 3 photos in the "images" field.`

// ValidateUploads is the synchronous upload check (Go port spec §4: the
// POST answers 400/413/415 before a job is accepted): 1 to 3 images, each
// at most 8 MiB, a JPEG, PNG or WebP by its magic bytes, with a header
// size within the pixel cap. It decodes nothing; a body that fails to
// decode later fails the job with INVALID_IMAGE.
func ValidateUploads(images [][]byte) error {
	if len(images) < MinImages || len(images) > MaxImages {
		return &Error{Code: contracts.ErrValidationFailed, Message: sendPhotos}
	}
	for _, img := range images {
		if _, err := imaging.Validate(img); err != nil {
			var ie *imaging.Error
			if errors.As(err, &ie) {
				return NewError(ie.Code)
			}
			return NewError(contracts.ErrInvalidImage)
		}
	}
	return nil
}

// AnalyzeImages is analyzeImages: validate, normalise and check the
// quality of 1 to 3 uploads, then read, review, look up, match and
// summarise. It returns a *Error for a failed analysis, or ctx's error
// when ctx ended first (nothing after the cut-off stage runs).
func AnalyzeImages(ctx context.Context, id string, images [][]byte, deps Deps) (contracts.AnalysisResult, error) {
	if err := ctx.Err(); err != nil {
		return contracts.AnalysisResult{}, err
	}
	// 1. validate every upload before decoding any of them further
	if err := ValidateUploads(images); err != nil {
		return contracts.AnalysisResult{}, err
	}

	deps.emit(StageQuality)
	// 2. normalise (in memory only); any failure is INVALID_IMAGE, as in Node
	normalized := make([][]byte, len(images))
	for i, img := range images {
		n, err := imaging.Normalize(img)
		if err != nil {
			return contracts.AnalysisResult{}, NewError(contracts.ErrInvalidImage)
		}
		normalized[i] = n
		if err := ctx.Err(); err != nil {
			return contracts.AnalysisResult{}, err
		}
	}

	// 3. quality: any failing photo fails the scan, so a blurry side is
	// never half-read
	var quality *contracts.QualityReport
	for _, img := range normalized {
		q, err := imaging.AssessWith(img, imaging.DefaultThresholds())
		if err != nil {
			return contracts.AnalysisResult{}, NewError(contracts.ErrInvalidImage)
		}
		if quality == nil || (quality.OK && !q.OK) {
			quality = &q
		}
		if err := ctx.Err(); err != nil {
			return contracts.AnalysisResult{}, err
		}
	}

	r, err := readMatch(ctx, id, normalized, *quality, deps.Reader, deps.References, deps, deps.IsDemo)
	if err != nil {
		return contracts.AnalysisResult{}, err
	}
	if deps.Provenance != nil {
		p := *deps.Provenance
		r.Provenance = &p
	}
	return r, nil
}

// AnalyzeScenario is analyzeScenario: steps 1 to 3 are skipped and the
// fixture's quality report is used. It always reads and looks up with the
// scenario's fixtures (never deps.Reader or deps.References) and the
// result is always demo data. An unknown scenario is NOT_FOUND.
func AnalyzeScenario(ctx context.Context, id, scenarioID string, deps Deps) (contracts.AnalysisResult, error) {
	s, ok := demo.Get(scenarioID)
	if !ok {
		return contracts.AnalysisResult{}, &Error{Code: contracts.ErrNotFound, Message: UnknownScenarioMessage}
	}
	if err := ctx.Err(); err != nil {
		return contracts.AnalysisResult{}, err
	}
	return readMatch(ctx, id, nil, s.Quality,
		ai.FixtureReader{ScenarioID: scenarioID}, references.Fixture{ScenarioID: scenarioID}, deps, true)
}

// UnknownScenarioMessage is the NOT_FOUND message for a scenario id that
// does not exist (the Node demo route's).
const UnknownScenarioMessage = "Unknown demo scenario."

// readMatch is readMatchStore without the store: steps 4 to 8. A quality
// failure short-circuits before the reader is called.
func readMatch(ctx context.Context, id string, images [][]byte, quality contracts.QualityReport,
	reader ai.LabelReader, refs references.Provider, deps Deps, isDemo bool,
) (contracts.AnalysisResult, error) {
	var label *contracts.ExtractedLabel
	var match contracts.MatchAssessment
	var state contracts.PipelineState

	if !quality.OK {
		state = contracts.PipelineLabelUnreadable
		match = notAttempted(domain.NotAttemptedNote)
	} else {
		deps.emit(StageReading)
		read, err := reader.Read(ctx, images)
		deps.charge(read.Usage)
		if err != nil {
			return contracts.AnalysisResult{}, err
		}
		if err := ctx.Err(); err != nil {
			return contracts.AnalysisResult{}, err
		}
		if !read.OK {
			return contracts.AnalysisResult{}, NewError(contracts.ErrOCRFailed)
		}
		l := read.Label

		deps.emit(StageReviewingFields)
		switch l.ImageKind {
		case contracts.ImageKindLoosePill:
			state = contracts.PipelineLoosePill
			l = withoutValues(l)
			match = domain.AssessMatch(&l, contracts.SearchResult{Kind: contracts.SearchNotAttempted})
		case contracts.ImageKindNotMedicine:
			state = contracts.PipelineNotALabel
			l = withoutValues(l)
			match = domain.AssessMatch(&l, contracts.SearchResult{Kind: contracts.SearchNotAttempted})
		case contracts.ImageKindUnreadable:
			state = contracts.PipelineLabelUnreadable
			l = withoutValues(l)
			match = domain.AssessMatch(&l, contracts.SearchResult{Kind: contracts.SearchNotAttempted})
		case contracts.ImageKindLabel:
			if q, ok := registryQuery(&l); !ok {
				match = notAttempted(NotEnoughTextNote)
			} else {
				deps.emit(StageCheckingReferences)
				found := search(ctx, refs, q)
				if err := ctx.Err(); err != nil {
					return contracts.AnalysisResult{}, err
				}
				deps.emit(StageComparing)
				match = domain.AssessMatch(&l, found)
			}
			state = contracts.PipelineExplanationReady
		default:
			// a reader that breaks the contract (Node: the schema check)
			return contracts.AnalysisResult{}, NewError(contracts.ErrInternal)
		}
		label = &l
	}

	deps.emit(StageExplaining)
	explanation := domain.BuildSummary(domain.SummaryInput{
		Label: label, Quality: quality, Match: match, IsDemo: isDemo, PipelineState: state,
	})
	created := deps.now()
	result := contracts.AnalysisResult{
		ID:             id,
		IsDemo:         isDemo,
		CreatedAt:      contracts.FormatTime(created),
		ExpiresAt:      contracts.FormatTime(created.Add(deps.ttl())),
		PipelineState:  state,
		Quality:        quality,
		Label:          label,
		Match:          match,
		Explanation:    explanation,
		ImageRetention: contracts.ImageRetentionNone,
	}
	if !conformResult(&result) {
		return contracts.AnalysisResult{}, NewError(contracts.ErrInternal)
	}
	return result, nil
}

// withoutValues (final review I2): a loose pill, a photo with no medicine
// or a label with no readable text keeps no transcribed text, so nothing
// downstream (Q&A, the Label fields screen) can show a value the summary
// never speaks, such as a tablet imprint the model copied into the fields.
// Every field keeps its key with value, evidence and notes null and
// legibility unreadable; rawText is emptied. The photo notes (warnings)
// are about the photo and stay.
func withoutValues(l contracts.ExtractedLabel) contracts.ExtractedLabel {
	fields := make([]contracts.LabelField, len(l.Fields))
	for i, f := range l.Fields {
		fields[i] = contracts.LabelField{Key: f.Key, Legibility: contracts.LegibilityUnreadable}
	}
	l.Fields = fields
	l.RawText = ""
	return l
}

// registryQuery is the registry query from clear label text only: the
// registration number when clear and well formed, and the brand name when
// clear, else the generic name when clear. False when there is nothing
// clear to search for.
func registryQuery(l *contracts.ExtractedLabel) (references.Query, bool) {
	var q references.Query
	if reg := domain.ClearValue(l, contracts.FieldRegistrationNumber); reg != nil {
		if n := domain.NormalizeRegistrationNumber(*reg); n != nil {
			q.RegistrationNumber = *n
		}
	}
	name := domain.ClearValue(l, contracts.FieldBrandName)
	if name == nil {
		name = domain.ClearValue(l, contracts.FieldGenericNames)
	}
	if name != nil {
		q.Name = *name
	}
	return q, q.RegistrationNumber != "" || q.Name != ""
}

// search is the registry lookup. A provider that panics is reported as
// unavailable (Node: a registry that throws), so the user still gets what
// was read.
func search(ctx context.Context, refs references.Provider, q references.Query) (found contracts.SearchResult) {
	defer func() {
		if recover() != nil {
			found = contracts.SearchResult{Kind: contracts.SearchUnavailable, Reason: "Registry lookup failed."}
		}
	}()
	return refs.Search(ctx, q)
}

func notAttempted(limitation string) contracts.MatchAssessment {
	return contracts.MatchAssessment{
		Status:      contracts.MatchNotAttempted,
		Matched:     []contracts.FieldKey{},
		Conflicting: []contracts.FieldConflict{},
		Missing:     []contracts.FieldKey{},
		Candidates:  []contracts.ReferenceRecord{},
		Advisories:  []contracts.Advisory{},
		Limitations: []string{limitation},
	}
}
