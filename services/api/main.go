// Command api is the MediLens REST + SSE API (Go port spec §2, §4): it
// loads the .env file (ENV_FILE, else .env in the working directory; the
// environment wins), validates the configuration (MODEL_PROVIDER=muse_spark
// without MODEL_API_KEY is a startup error, exit 1), builds the providers
// with no fallback between them, and serves on PORT (default 8787) until
// SIGINT or SIGTERM, then shuts down gracefully (readyz 503, event streams
// closed, 10 s to drain, analyses in flight cancelled).
//
// Memory: up to 10 accepted analyses hold their photos (3 x 8 MiB each,
// kept at their exact size) while they wait or run; an upload being read
// briefly holds up to twice its size, and uploads being read at the same
// time are bounded only by the write rate limit; one photo is decoded at a
// time, which can take a few hundred MB within the 40 MP cap. Set GOMEMLIMIT to the
// container's memory limit (less some headroom) so the garbage collector
// works before the limit is reached; the runtime reads it from the
// environment.
package main

import (
	"context"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/application"
	"github.com/medilens-ai/medilens/internal/config"
	"github.com/medilens-ai/medilens/internal/httpapi"
	"github.com/medilens-ai/medilens/internal/observability"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

func main() {
	logger := observability.New(os.Stdout)
	// a missing file is not an error; an unreadable one is reported by its
	// error type and the environment alone is used, as in Node
	if err := config.LoadDotenv(config.DotenvPath(os.Getenv)); err != nil {
		logger.Warn("env file not loaded", "errorName", observability.ErrorName(err))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Getenv, logger, net.Listen)
	stop()
	os.Exit(code)
}

// run is the API's life: configure, listen, serve until ctx ends, shut
// down. It returns the exit code.
func run(ctx context.Context, getenv func(string) string, logger *slog.Logger, listen func(network, address string) (net.Listener, error)) int {
	cfg, err := config.Load(getenv)
	if err != nil {
		// the message names each invalid variable, never a value
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
		cctx, cancel := context.WithTimeout(context.Background(), httpapi.DefaultShutdownGrace)
		defer cancel()
		_ = svc.Close(cctx)
	}
	api, err := httpapi.New(httpapi.Options{
		Service: svc, Logger: logger, CORSOrigin: cfg.CORSOrigin, TrustedProxies: cfg.TrustedProxies,
	})
	if err != nil {
		closeService()
		logger.Error("startup failed", "errorName", observability.ErrorName(err))
		return 1
	}
	// bind first: a port in use is a fatal startup error (Node listen.ts)
	ln, err := listen("tcp", ":"+strconv.Itoa(cfg.Port))
	if err != nil {
		closeService()
		logger.Error("listen failed", "errorName", observability.ErrorName(err), "port", cfg.Port)
		return 1
	}
	modelID := providers.ModelID
	if modelID == "" {
		modelID = ai.MockModel
	}
	logger.Info("listening",
		"port", cfg.Port,
		"provider", string(cfg.ModelProvider),
		"modelProvider", string(cfg.ModelProvider),
		"modelId", modelID,
		"referenceProvider", string(cfg.ReferenceProvider),
		"demoData", providers.Demo(),
	)
	if err := httpapi.Serve(ctx, httpapi.NewServer(api), ln, api, svc.Close, httpapi.DefaultShutdownGrace); err != nil {
		logger.Error("shutdown failed", "errorName", observability.ErrorName(err))
		return 1
	}
	logger.Info("stopped")
	return 0
}
