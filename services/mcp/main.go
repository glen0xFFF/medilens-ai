// Command mcp is the MediLens MCP server (Go port spec §5): the six
// mcptools tools over the same application service as the API, built from
// the same environment (MODEL_PROVIDER, REFERENCE_PROVIDER, MODEL_API_KEY,
// DAILY_SPEND_CAP_USD; MODEL_PROVIDER=muse_spark without MODEL_API_KEY is
// a startup error), served over stateless Streamable HTTP at /mcp.
//
// It listens on MCP_ADDR (default 127.0.0.1:8788) behind bearer tokens
// from MCP_API_TOKENS. With no tokens it refuses to start unless
// MCP_ALLOW_NO_AUTH=1 and the address is loopback, checked before and
// after the bind. It stops on SIGINT or SIGTERM: in-flight calls get 10 s,
// then their connections close (their analyses are cancelled and
// deleted), then the service's jobs are cancelled.
//
// This process has its own analysis store: an analysis_id from the API is
// unknown here, and the other way round.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/application"
	"github.com/medilens-ai/medilens/internal/config"
	"github.com/medilens-ai/medilens/internal/mcptools"
	"github.com/medilens-ai/medilens/internal/observability"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

// shutdownGrace is how long a shutdown waits for calls in flight, and
// then for the service's workers (as the API: Shutdown(10s)).
const shutdownGrace = 10 * time.Second

func main() {
	logger := observability.New(os.Stdout)
	// a missing file is not an error; an unreadable one is reported by its
	// error type and the environment alone is used
	if err := config.LoadDotenv(config.DotenvPath(os.Getenv)); err != nil {
		logger.Warn("env file not loaded", "errorName", observability.ErrorName(err))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Getenv, logger, net.Listen)
	stop()
	os.Exit(code)
}

// run is the server's life: configure, check the auth rule, listen, serve
// until ctx ends, shut down. It returns the exit code.
func run(ctx context.Context, getenv func(string) string, logger *slog.Logger, listen func(network, address string) (net.Listener, error)) int {
	cfg, cerr := config.Load(getenv)
	mcfg, merr := mcptools.LoadConfig(getenv)
	if err := errors.Join(cerr, merr); err != nil {
		// the messages name each invalid variable, never a value
		logger.Error("startup failed", "reason", err.Error())
		return 1
	}
	if err := mcfg.CheckBind(); err != nil {
		logger.Error("startup failed", "reason", err.Error())
		return 1
	}
	providers, err := ai.NewFromConfig(cfg, ai.WithOnModelError(func(f ai.RequestFailure) {
		// how it failed and the HTTP status only: never a body
		logger.Warn("model request failed", "errorKind", f.Kind, "status", f.Status)
	}))
	if err != nil {
		logger.Error("startup failed", "errorName", observability.ErrorName(err))
		return 1
	}
	svc, err := application.New(application.Options{
		Providers: providers,
		Meter:     pipeline.NewSpendMeter(cfg.DailySpendCapUSD, time.Now),
	})
	if err != nil {
		logger.Error("startup failed", "errorName", observability.ErrorName(err))
		return 1
	}
	closeService := func() {
		cctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		_ = svc.Close(cctx)
	}
	handler, err := mcptools.NewHTTPHandler(mcptools.NewServer(svc, mcptools.Options{Logger: logger}), mcfg)
	if err != nil {
		closeService()
		logger.Error("startup failed", "reason", err.Error())
		return 1
	}
	ln, err := listen("tcp", mcfg.Addr)
	if err != nil {
		closeService()
		logger.Error("listen failed", "errorName", observability.ErrorName(err))
		return 1
	}
	if err := mcfg.CheckListener(ln.Addr()); err != nil {
		_ = ln.Close()
		closeService()
		logger.Error("startup failed", "reason", err.Error())
		return 1
	}

	mux := http.NewServeMux()
	mux.Handle(mcptools.Path, handler)
	srv := &http.Server{
		Handler: mux,
		// as the API: 10 s for the headers, 60 s for a body of up to
		// 30 MiB, 120 s idle, 32 KiB of headers. No write timeout: a call
		// can wait on the queue and two 45 s model calls; it ends with
		// its pipeline (every provider call has its own timeout) or when
		// the client goes (its cancellation reaches the tool).
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	authMode := "bearer"
	if !mcfg.AuthRequired() {
		authMode = "none (loopback only)"
	}
	modelID := providers.ModelID
	if modelID == "" {
		modelID = ai.MockModel
	}
	logger.Info("listening",
		"addr", ln.Addr().String(),
		"path", mcptools.Path,
		"auth", authMode,
		"tokens", mcfg.TokenCount(),
		"provider", string(cfg.ModelProvider),
		"modelProvider", string(cfg.ModelProvider),
		"modelId", modelID,
		"referenceProvider", string(cfg.ReferenceProvider),
		"demoData", providers.Demo(),
	)
	if err := serve(ctx, srv, ln, svc.Close, shutdownGrace); err != nil {
		logger.Error("shutdown failed", "errorName", observability.ErrorName(err))
		return 1
	}
	logger.Info("stopped")
	return 0
}

// serve serves srv on ln until ctx ends, then shuts down: srv.Shutdown
// closes the listener and waits up to grace for the calls in flight (then
// closes their connections, which cancels them), and closeService cancels
// the analyses still running and waits for its workers.
func serve(ctx context.Context, srv *http.Server, ln net.Listener, closeService func(context.Context) error, grace time.Duration) error {
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	var serveErr error
	select {
	case serveErr = <-served:
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	shutdownErr := srv.Shutdown(sctx)
	if shutdownErr != nil {
		_ = srv.Close()
	}
	if serveErr == nil {
		if err := <-served; !errors.Is(err, http.ErrServerClosed) {
			serveErr = err
		}
	}
	cctx, ccancel := context.WithTimeout(context.Background(), grace)
	defer ccancel()
	return errors.Join(serveErr, shutdownErr, closeService(cctx))
}
