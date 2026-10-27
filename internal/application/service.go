// Package application is the analysis service the Go API and the Go MCP
// server share (Go port spec §2, §4, §5): it accepts uploads and demo
// scenarios into a bounded worker pool, runs the real pipeline with
// genuine progress events, keeps each analysis in the 15-minute TTL store,
// and answers follow-up calls (status, result, events, explanation,
// speech, references, delete, capabilities). It holds no HTTP or MCP
// concern: errors are *pipeline.Error values with the contract code and a
// message a client may show.
//
// Concurrency: a fixed set of worker goroutines takes jobs from a buffered
// channel; that is the only place jobs run, and no goroutine is started
// per job or per subscriber. Every analysis has its own lock and event
// log; the store has its own lock. A job's context is cancelled when its
// analysis is deleted or dropped by the store (TTL or cap), and when the
// service is closed; Close waits for every worker to return.
//
// Ownership (Go port spec §4): an analysis id is a random UUIDv4 and the
// only capability; there are no accounts. Each process (API, MCP) has its
// own store.
package application

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"
	"uuid"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/config"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/domain"
	"github.com/medilens-ai/medilens/internal/imaging"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

const (
	// DefaultWorkers is how many analyses run at once (Go port spec §4).
	DefaultWorkers = 2
	// DefaultQueueSize is how many accepted analyses may wait for a
	// worker; past that, a create is refused with ErrQueueFull.
	DefaultQueueSize = 8
	// DefaultMaxEntries is the most analyses the store holds.
	DefaultMaxEntries = pipeline.MaxEntries
)

var (
	// ErrQueueFull: every worker is busy and the queue is full, so the
	// analysis was not accepted (RATE_LIMITED; the API answers 503 with
	// Retry-After). Compare with errors.Is.
	ErrQueueFull = pipeline.NewError(contracts.ErrRateLimited)
	// ErrClosed: the service was closed and accepts nothing.
	ErrClosed = errors.New("application: the service is closed")
)

// Options configure New. Zero values take the defaults.
type Options struct {
	// Providers are the configured providers (ai.NewFromConfig); uploads
	// run on them. Demo scenarios always run on the fixtures.
	Providers ai.Providers
	// Meter is the daily spend meter; required when the model provider is
	// muse_spark, unused for the mock.
	Meter *pipeline.SpendMeter
	// Now is the clock for results, events and the store; nil uses
	// time.Now.
	Now func() time.Time
	// NewID makes analysis ids; nil uses random UUIDv4s.
	NewID func() string
	// TTL is how long an analysis is kept; 0 means pipeline.ResultTTL.
	TTL time.Duration
	// MaxEntries caps the store; 0 means DefaultMaxEntries.
	MaxEntries int
	// Workers and QueueSize size the pool; 0 means the defaults.
	Workers   int
	QueueSize int
}

// State is the status of an analysis.
type State string

const (
	StateProcessing State = "processing"
	StateCompleted  State = "completed"
	StateFailed     State = "failed"
)

// Status is GET /analyses/{id}: {id, status, stage, events, error?,
// isDemo}. Error is set when the status is failed; its RequestID is left
// for the caller (the request that reads it) to fill in.
type Status struct {
	ID     string                 `json:"id"`
	Status State                  `json:"status"`
	Stage  pipeline.Stage         `json:"stage"`
	Events []pipeline.Event       `json:"events"`
	Error  *contracts.ErrorDetail `json:"error,omitempty"`
	IsDemo bool                   `json:"isDemo"`
}

// SpeakTarget is what Speak chunks.
type SpeakTarget string

const (
	// SpeakSummary is the stored spoken summary.
	SpeakSummary SpeakTarget = "summary"
	// SpeakAnswer is an answer text the client got from Explain.
	SpeakAnswer SpeakTarget = "answer"
)

// Speech is {language:"en-US", chunks}: text for the device's own speech
// engine, cut by the summary's splitter.
type Speech struct {
	Language string   `json:"language"`
	Chunks   []string `json:"chunks"`
}

// References is GET /analyses/{id}/references: the registry side of a
// result. CheckedAt is null when no registry data was retrieved.
type References struct {
	Candidates  []contracts.ReferenceRecord `json:"candidates"`
	Advisories  []contracts.Advisory        `json:"advisories"`
	Limitations []string                    `json:"limitations"`
	CheckedAt   *string                     `json:"checkedAt"`
}

// Streaming is the capabilities' streaming block.
type Streaming struct {
	AnalysisEvents bool `json:"analysisEvents"`
}

// Capabilities is GET /config/capabilities. It never carries a secret.
type Capabilities struct {
	ModelProvider     config.ModelProvider            `json:"modelProvider"`
	ModelID           *string                         `json:"modelId"`
	ReferenceProvider config.ReferenceProvider        `json:"referenceProvider"`
	MaxImages         int                             `json:"maxImages"`
	MaxImageBytes     int                             `json:"maxImageBytes"`
	TTLSeconds        int                             `json:"ttlSeconds"`
	Presets           []string                        `json:"presets"`
	DemoScenarios     []contracts.DemoScenarioSummary `json:"demoScenarios"`
	Streaming         Streaming                       `json:"streaming"`
}

// analysis is one stored analysis. The event log is the source of its
// state: the result or error is set before the terminal event is emitted,
// so whoever sees the terminal event finds it.
type analysis struct {
	id     string
	isDemo bool
	log    *pipeline.EventLog
	// cancel cancels the job's context; safe to call more than once.
	cancel context.CancelFunc

	mu     sync.Mutex
	result *contracts.AnalysisResult
	err    *pipeline.Error
}

// drop is what the store's eviction and Delete do: stop the job and
// close every subscriber.
func (a *analysis) drop() {
	a.cancel()
	a.log.Close()
}

func (a *analysis) outcome() (*contracts.AnalysisResult, *pipeline.Error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.result, a.err
}

// job is an accepted analysis waiting for, or running on, a worker.
type job struct {
	a   *analysis
	ctx context.Context
	// release frees the job's context once it has finished.
	release func()
	run     runFunc
}

// runFunc runs the pipeline of the analysis id.
type runFunc func(ctx context.Context, id string, deps pipeline.Deps) (contracts.AnalysisResult, error)

// Service is the analysis service. It is safe for concurrent use.
type Service struct {
	providers  ai.Providers
	meter      *pipeline.SpendMeter
	now        func() time.Time
	newID      func() string
	ttl        time.Duration
	provenance contracts.Provenance
	store      *pipeline.Store[*analysis]

	jobs chan *job
	base context.Context
	stop context.CancelFunc
	wg   sync.WaitGroup

	mu     sync.Mutex // admission and closing
	closed bool
}

// New starts a service and its workers. Close it to stop them.
func New(opts Options) (*Service, error) {
	p := opts.Providers
	if p.Reader == nil || p.References == nil || p.Explainer == nil {
		return nil, errors.New("application: the providers need a reader, an explainer and references")
	}
	modelID := ai.MockModel
	switch p.ModelProvider {
	case config.ModelMock:
	case config.ModelMuseSpark:
		if opts.Meter == nil {
			return nil, errors.New("application: muse_spark needs a spend meter")
		}
		if p.ModelID == "" {
			return nil, errors.New("application: muse_spark needs a model id")
		}
		modelID = p.ModelID
	default:
		return nil, fmt.Errorf("application: unknown model provider %q", p.ModelProvider)
	}
	switch p.ReferenceProvider {
	case config.ReferenceFixture, config.ReferencePHFDA:
	default:
		return nil, fmt.Errorf("application: unknown reference provider %q", p.ReferenceProvider)
	}
	if opts.Workers < 0 || opts.QueueSize < 0 || opts.MaxEntries < 0 || opts.TTL < 0 {
		return nil, errors.New("application: negative pool, store or TTL size")
	}

	s := &Service{
		providers:  p,
		meter:      opts.Meter,
		now:        opts.Now,
		newID:      opts.NewID,
		ttl:        cmp.Or(opts.TTL, pipeline.ResultTTL),
		provenance: contracts.Provenance{Model: modelID, References: string(p.ReferenceProvider)},
		jobs:       make(chan *job, cmp.Or(opts.QueueSize, DefaultQueueSize)),
	}
	if opts.Now == nil {
		s.now = time.Now
	}
	if opts.NewID == nil {
		s.newID = func() string { return uuid.NewV4().String() }
	}
	s.store = pipeline.NewStore(s.now, s.ttl, cmp.Or(opts.MaxEntries, DefaultMaxEntries), (*analysis).drop)
	s.base, s.stop = context.WithCancel(context.Background())
	for range cmp.Or(opts.Workers, DefaultWorkers) {
		s.wg.Go(s.worker)
	}
	return s, nil
}

// Close stops the service: nothing more is accepted, the context of every
// running and queued job is cancelled, and Close waits for every worker
// to return (or for ctx to end, returning its error). Each analysis cut
// off this way ends failed with ANALYSIS_FAILED. Safe to call more than
// once.
func (s *Service) Close(ctx context.Context) error {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	s.stop()

	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
		return ctx.Err()
	}
	// no worker is left and nothing can be admitted: fail what is queued
	for {
		select {
		case j := <-s.jobs:
			s.finish(j.a, contracts.AnalysisResult{}, context.Canceled)
			j.release()
		default:
			return nil
		}
	}
}

func (s *Service) worker() {
	for {
		select {
		case <-s.base.Done():
			return
		case j := <-s.jobs:
			s.run(j)
		}
	}
}

// run runs one job on the calling worker. A panic in the pipeline or a
// provider fails the analysis with INTERNAL_ERROR and keeps the worker.
func (s *Service) run(j *job) {
	defer j.release()
	defer func() {
		if recover() != nil {
			s.finish(j.a, contracts.AnalysisResult{}, pipeline.NewError(contracts.ErrInternal))
		}
	}()
	if err := j.ctx.Err(); err != nil {
		s.finish(j.a, contracts.AnalysisResult{}, err)
		return
	}
	deps := pipeline.Deps{
		Now:     s.now,
		TTL:     s.ttl,
		Emit:    func(st pipeline.Stage) { j.a.log.Emit(st) },
		OnUsage: s.charge,
	}
	r, err := j.run(j.ctx, j.a.id, deps)
	s.finish(j.a, r, err)
}

// finish records the outcome, then emits the terminal event.
func (s *Service) finish(a *analysis, r contracts.AnalysisResult, err error) {
	if err != nil {
		pe := failure(err)
		a.mu.Lock()
		a.err = pe
		a.mu.Unlock()
		a.log.Fail(pe.Message)
		return
	}
	a.mu.Lock()
	a.result = &r
	a.mu.Unlock()
	// the result lives until its own expiresAt, as Node's put at completion
	if expires, perr := time.Parse(time.RFC3339Nano, r.ExpiresAt); perr == nil {
		s.store.Refresh(a.id, expires)
	}
	if r.PipelineState == contracts.PipelineExplanationReady {
		a.log.Emit(pipeline.StageCompleted)
	} else {
		a.log.Emit(pipeline.StageNeedsAttention)
	}
}

// failure is the stored error of a failed analysis: the pipeline's own,
// ANALYSIS_FAILED for a job whose context ended, else INTERNAL_ERROR.
func failure(err error) *pipeline.Error {
	var pe *pipeline.Error
	switch {
	case errors.As(err, &pe):
		return pe
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return pipeline.NewError(pipeline.CodeAnalysisFailed)
	default:
		return pipeline.NewError(contracts.ErrInternal)
	}
}

func (s *Service) charge(u ai.Usage) {
	if s.meter != nil {
		s.meter.Record(u)
	}
}

func (s *Service) live() bool { return s.providers.ModelProvider == config.ModelMuseSpark }

// admit accepts a job: it stores the analysis, emits received and queues
// the job, or refuses with ErrClosed or ErrQueueFull. The job's context
// derives from the service's, so Close cancels it at once (no goroutine
// relays it); the caller's context never reaches the job.
func (s *Service) admit(isDemo bool, run runFunc) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return "", ErrClosed
	}
	// only admit sends, under s.mu, and workers only take: a free place
	// seen here is still free at the send below, which never blocks
	if len(s.jobs) == cap(s.jobs) {
		return "", ErrQueueFull
	}
	jctx, cancel := context.WithCancel(s.base)
	a := &analysis{id: s.newID(), isDemo: isDemo, log: pipeline.NewEventLog(s.now), cancel: cancel}
	s.store.Put(a.id, a)
	a.log.Emit(pipeline.StageReceived)
	s.jobs <- &job{a: a, ctx: jctx, release: cancel, run: run}
	return a.id, nil
}

// Create validates 1 to 3 uploads synchronously and accepts their
// analysis: it returns the analysis id at once, and the pipeline runs on a
// worker. The checks run in the Node order: the image count, each size,
// the daily budget (muse_spark only), then each format (magic bytes and
// header). Over the queue it is ErrQueueFull. ctx is only checked on the
// call: the accepted job goes on after ctx ends (an HTTP request ends with
// its 202) and stops on Delete, store eviction or Close.
func (s *Service) Create(ctx context.Context, images [][]byte) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if s.isClosed() {
		return "", ErrClosed
	}
	if len(images) < pipeline.MinImages || len(images) > pipeline.MaxImages {
		return "", pipeline.ValidateUploads(images)
	}
	for _, img := range images {
		if len(img) > imaging.MaxImageBytes {
			return "", pipeline.NewError(contracts.ErrImageTooLarge)
		}
	}
	// checked before the job is accepted; demo scenarios stay available
	if s.live() && s.meter.Exhausted() {
		return "", pipeline.NewError(contracts.ErrLiveBudgetExhausted)
	}
	if err := pipeline.ValidateUploads(images); err != nil {
		return "", err
	}
	deps := pipeline.Deps{
		Reader:     s.providers.Reader,
		References: s.providers.References,
		IsDemo:     s.providers.Demo(),
		Provenance: &s.provenance,
	}
	return s.admit(deps.IsDemo, func(ctx context.Context, id string, d pipeline.Deps) (contracts.AnalysisResult, error) {
		d.Reader, d.References, d.IsDemo, d.Provenance = deps.Reader, deps.References, deps.IsDemo, deps.Provenance
		return pipeline.AnalyzeImages(ctx, id, images, d)
	})
}

// CreateDemo accepts the analysis of a demo scenario: the real pipeline
// on the scenario's fixtures, so its events are genuine. It is available
// whatever the providers and the budget. An empty id is VALIDATION_FAILED
// and an unknown one NOT_FOUND.
func (s *Service) CreateDemo(ctx context.Context, scenarioID string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if s.isClosed() {
		return "", ErrClosed
	}
	if scenarioID == "" {
		return "", &pipeline.Error{Code: contracts.ErrValidationFailed, Message: `Send {"scenarioId": "<id>"}.`}
	}
	if _, ok := demo.Get(scenarioID); !ok {
		return "", &pipeline.Error{Code: contracts.ErrNotFound, Message: pipeline.UnknownScenarioMessage}
	}
	return s.admit(true, func(ctx context.Context, id string, d pipeline.Deps) (contracts.AnalysisResult, error) {
		return pipeline.AnalyzeScenario(ctx, id, scenarioID, d)
	})
}

func (s *Service) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

func notFound() *pipeline.Error { return pipeline.NewError(contracts.ErrNotFound) }

func (s *Service) get(id string) (*analysis, error) {
	a, ok := s.store.Get(id)
	if !ok {
		return nil, notFound()
	}
	return a, nil
}

// Status is the analysis's state, current stage and events so far.
func (s *Service) Status(id string) (Status, error) {
	a, err := s.get(id)
	if err != nil {
		return Status{}, err
	}
	events := a.log.Events()
	st := Status{ID: a.id, Status: StateProcessing, Events: events, IsDemo: a.isDemo}
	if len(events) > 0 {
		st.Stage = events[len(events)-1].Stage
	}
	switch st.Stage {
	case pipeline.StageCompleted, pipeline.StageNeedsAttention:
		st.Status = StateCompleted
	case pipeline.StageFailed:
		st.Status = StateFailed
		if _, e := a.outcome(); e != nil {
			st.Error = &contracts.ErrorDetail{Code: e.Code, Message: e.Message}
		}
	}
	return st, nil
}

// completed is the stored result, or NOT_FOUND, ANALYSIS_NOT_READY while
// processing, or the stored error of a failed analysis.
func (s *Service) completed(id string) (contracts.AnalysisResult, error) {
	a, err := s.get(id)
	if err != nil {
		return contracts.AnalysisResult{}, err
	}
	r, e := a.outcome()
	switch {
	case e != nil:
		return contracts.AnalysisResult{}, &pipeline.Error{Code: e.Code, Message: e.Message}
	case r == nil:
		return contracts.AnalysisResult{}, pipeline.NewError(pipeline.CodeAnalysisNotReady)
	}
	return clone(*r)
}

// clone is a deep copy, so no caller can change a stored result.
func clone(r contracts.AnalysisResult) (contracts.AnalysisResult, error) {
	b, err := json.Marshal(r)
	if err != nil {
		return contracts.AnalysisResult{}, pipeline.NewError(contracts.ErrInternal)
	}
	var out contracts.AnalysisResult
	if err := json.Unmarshal(b, &out); err != nil {
		return contracts.AnalysisResult{}, pipeline.NewError(contracts.ErrInternal)
	}
	return out, nil
}

// Result is the AnalysisResult of a completed analysis (a copy).
func (s *Service) Result(id string) (contracts.AnalysisResult, error) {
	return s.completed(id)
}

// Subscribe streams the analysis's events with a seq above afterSeq: the
// stored ones first, then live ones; the channel is closed after the
// terminal event, when the analysis is dropped, or by cancel.
func (s *Service) Subscribe(id string, afterSeq int) (<-chan pipeline.Event, func(), error) {
	a, err := s.get(id)
	if err != nil {
		return nil, func() {}, err
	}
	ch, cancel := a.log.Subscribe(afterSeq)
	return ch, cancel, nil
}

// Explain answers a question about a completed analysis
// (pipeline.Explain): the safety gate first, deterministic answers, and
// for a live result the configured explainer behind the daily budget. The
// id is checked before the question.
func (s *Service) Explain(ctx context.Context, id, question string) (contracts.Answer, error) {
	r, err := s.completed(id)
	if err != nil {
		return contracts.Answer{}, err
	}
	return pipeline.Explain(ctx, r, question, pipeline.ExplainDeps{
		Live:                pipeline.NewLiveAnswerer(s.providers.Explainer),
		LiveBudgetExhausted: func() bool { return s.live() && s.meter.Exhausted() },
		OnUsage:             s.charge,
	})
}

// Speak returns text for the device's speech engine: the stored spoken
// summary, or an answer text cut by the same splitter. The answer text is
// the client's own; one that says "fake" or "counterfeit" outside the fixed
// sentences is refused (final review M1), so no server path speaks those
// words except the fixed advisory and no-match sentences.
func (s *Service) Speak(id string, target SpeakTarget, text string) (Speech, error) {
	r, err := s.completed(id)
	if err != nil {
		return Speech{}, err
	}
	switch target {
	case SpeakSummary:
		return Speech{Language: "en-US", Chunks: slices.Clone(r.Explanation.SpokenChunks)}, nil
	case SpeakAnswer:
		if pipeline.MentionsFakeFolded(text) {
			return Speech{}, &pipeline.Error{
				Code:    contracts.ErrValidationFailed,
				Message: "This text cannot be read aloud. Send the text of an answer MediLens gave.",
			}
		}
		if domain.JSTrim(text) != "" {
			return Speech{Language: "en-US", Chunks: domain.ChunkSpeech(text)}, nil
		}
	}
	return Speech{}, &pipeline.Error{
		Code:    contracts.ErrValidationFailed,
		Message: `Send {"target": "summary"} or {"target": "answer", "text": "..."}.`,
	}
}

// References is the registry side of a completed analysis.
func (s *Service) References(id string) (References, error) {
	r, err := s.completed(id)
	if err != nil {
		return References{}, err
	}
	return References{
		Candidates:  nonNil(r.Match.Candidates),
		Advisories:  nonNil(r.Match.Advisories),
		Limitations: nonNil(r.Match.Limitations),
		CheckedAt:   checkedAt(r),
	}, nil
}

func nonNil[T any](xs []T) []T {
	if xs == nil {
		return []T{}
	}
	return xs
}

// checkedAt is when registry data was retrieved (Node routes/
// references.ts): the newest candidate's check time, or the analysis time
// when the registry answered with no candidates; null when the registry
// was not checked or could not be reached, and null for every demo
// result, whose registry rows are made up (final review Minor 18).
func checkedAt(r contracts.AnalysisResult) *string {
	if r.IsDemo {
		return nil
	}
	if r.Match.Status == contracts.MatchNotAttempted || r.Match.Status == contracts.MatchUnavailable {
		return nil
	}
	if len(r.Match.Candidates) == 0 {
		return contracts.Ptr(r.CreatedAt)
	}
	times := make([]string, len(r.Match.Candidates))
	for i, c := range r.Match.Candidates {
		times[i] = c.CheckedAt
	}
	// JS sort() compares UTF-16 code units; the times are ASCII, so a
	// byte-wise sort is the same
	slices.Sort(times)
	return contracts.Ptr(times[len(times)-1])
}

// Delete drops an analysis: its result and events go, its job (if still
// running) is cancelled and its subscribers are closed.
func (s *Service) Delete(id string) error {
	a, ok := s.store.Delete(id)
	if !ok {
		return notFound()
	}
	a.drop()
	return nil
}

// Capabilities describes the configured service. No secrets.
func (s *Service) Capabilities() Capabilities {
	var modelID *string
	if s.live() {
		modelID = contracts.Ptr(s.providers.ModelID)
	}
	return Capabilities{
		ModelProvider:     s.providers.ModelProvider,
		ModelID:           modelID,
		ReferenceProvider: s.providers.ReferenceProvider,
		MaxImages:         pipeline.MaxImages,
		MaxImageBytes:     imaging.MaxImageBytes,
		TTLSeconds:        int(s.ttl / time.Second),
		Presets:           slices.Clone(domain.AllowedQuestionExamples),
		DemoScenarios:     demo.Summaries(),
		Streaming:         Streaming{AnalysisEvents: true},
	}
}
