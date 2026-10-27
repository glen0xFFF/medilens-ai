// Package httpapi is the Go REST API (Go port spec §4): every route over
// the application service, the error mapping to the contract body
// {error: {code, message, requestId}}, the analysis event stream (SSE),
// readiness and graceful shutdown. It replaces the Node Express app; the
// Node routes are not kept.
//
// Requests pass the middleware chain (internal/middleware) in this order:
// request id, access log, panic recovery, CORS, rate limits, then the
// mux. Upload bodies are read only through MultipartReader (upload.go),
// so no image is ever written to disk; JSON bodies are read as Node's
// express.json({limit: '16kb'}) read them (body.go).
package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/medilens-ai/medilens/internal/application"
	"github.com/medilens-ai/medilens/internal/config"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/middleware"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

// DefaultHeartbeat is the interval of the SSE heartbeat comment.
const DefaultHeartbeat = 15 * time.Second

// Service is what the API needs of the application service
// (*application.Service implements it).
type Service interface {
	Create(ctx context.Context, images [][]byte) (string, error)
	CreateDemo(ctx context.Context, scenarioID string) (string, error)
	Status(id string) (application.Status, error)
	Result(id string) (contracts.AnalysisResult, error)
	Subscribe(id string, afterSeq int) (<-chan pipeline.Event, func(), error)
	Explain(ctx context.Context, id, question string) (contracts.Answer, error)
	Speak(id string, target application.SpeakTarget, text string) (application.Speech, error)
	References(id string) (application.References, error)
	Delete(id string) error
	Capabilities() application.Capabilities
}

// Options configure New.
type Options struct {
	// Service runs the analyses (required).
	Service Service
	// Logger receives the access log and the error lines (required).
	Logger *slog.Logger
	// CORSOrigin is the one browser origin answered for CORS ("" for none).
	CORSOrigin string
	// TrustedProxies are the proxies whose X-Forwarded-For the rate limits
	// honour.
	TrustedProxies []netip.Prefix
	// Heartbeat is the SSE heartbeat interval; 0 means DefaultHeartbeat.
	Heartbeat time.Duration
	// Now is the rate limiter's clock; nil is time.Now.
	Now func() time.Time
	// NewRequestID makes request ids; nil makes random UUIDv4s.
	NewRequestID func() string
}

// API is the HTTP API. It is safe for concurrent use.
type API struct {
	svc       Service
	log       *slog.Logger
	heartbeat time.Duration
	checks    readyChecks
	handler   http.Handler

	notReady    atomic.Bool
	streamsDone chan struct{}
	closeOnce   sync.Once
}

// readyChecks is the checks block of GET /readyz.
type readyChecks struct {
	Model      string `json:"model"`
	References string `json:"references"`
}

// New builds the API and its handler chain.
func New(opts Options) (*API, error) {
	if opts.Service == nil || opts.Logger == nil {
		return nil, errors.New("httpapi: a service and a logger are required")
	}
	a := &API{
		svc:         opts.Service,
		log:         opts.Logger,
		heartbeat:   opts.Heartbeat,
		streamsDone: make(chan struct{}),
	}
	if a.heartbeat <= 0 {
		a.heartbeat = DefaultHeartbeat
	}
	caps := opts.Service.Capabilities()
	a.checks = readyChecks{Model: "configured", References: string(caps.ReferenceProvider)}
	if caps.ModelProvider == config.ModelMock {
		a.checks.Model = "mock"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.healthz)
	mux.HandleFunc("GET /readyz", a.readyz)
	mux.HandleFunc("GET /api/v1/config/capabilities", a.capabilities)
	mux.HandleFunc("POST /api/v1/analyses", a.createAnalysis)
	mux.HandleFunc("GET /api/v1/analyses/{id}", a.status)
	mux.HandleFunc("GET /api/v1/analyses/{id}/events", a.events)
	mux.HandleFunc("GET /api/v1/analyses/{id}/result", a.result)
	mux.HandleFunc("POST /api/v1/analyses/{id}/explanation", a.explanation)
	mux.HandleFunc("POST /api/v1/analyses/{id}/speak", a.speak)
	mux.HandleFunc("GET /api/v1/analyses/{id}/references", a.references)
	mux.HandleFunc("DELETE /api/v1/analyses/{id}", a.deleteAnalysis)
	mux.HandleFunc("GET /api/v1/demo/scenarios", a.demoScenarios)
	mux.HandleFunc("POST /api/v1/demo/scenarios", a.createDemo)
	mux.HandleFunc("GET /api/v1/questions/presets", a.presets)
	// every other path, and every other method on a known path (the mux
	// would answer 405 in plain text), is a JSON 404 as in Node
	mux.HandleFunc("/", a.notFound)

	limiter := middleware.NewRateLimiter(middleware.RateLimitOptions{TrustedProxies: opts.TrustedProxies, Now: opts.Now})
	var h http.Handler = limiter.Middleware(mux)
	h = middleware.CORS(opts.CORSOrigin, h)
	h = middleware.Recover(opts.Logger, h)
	h = middleware.AccessLog(opts.Logger, h)
	a.handler = middleware.RequestID(opts.NewRequestID, h)
	return a, nil
}

// Handler is the API's handler with its middleware.
func (a *API) Handler() http.Handler { return a.handler }

// SetNotReady makes GET /readyz answer 503: the first step of a shutdown.
func (a *API) SetNotReady() { a.notReady.Store(true) }

// CloseStreams ends every open event stream, and every stream opened
// later at once (http.Server.RegisterOnShutdown: Shutdown waits for open
// handlers, and a stream would otherwise hold it until its deadline).
// Safe to call more than once.
func (a *API) CloseStreams() { a.closeOnce.Do(func() { close(a.streamsDone) }) }
