// Command smoke is the live smoke test (spec §9), the Go port of
// apps/server/scripts/smoke-live.ts (tag node-fallback-v1): one Muse Spark
// label read on a photo you provide and one PH FDA registry lookup, both
// through the production adapters. It prints the serving model id, finish
// reason, token usage (reasoning_tokens when the API reports them), HTTP
// status and response key names. It never prints read text, raw text,
// evidence or registry values. Run it by hand with a key; never in CI or
// tests (they use local fakes).
//
//	MODEL_API_KEY=... go run ./services/smoke <image> [fda-search-term]
//	(or: npm run smoke:live -- <image> [fda-search-term])
//
// The FDA term defaults to "biogesic". MODEL_API_KEY and PUBLIC_REPO_URL
// may be set in the repository-root .env (or the file ENV_FILE names); a
// variable set in the environment wins.
//
// Exit codes: 0 done, 1 setup or request error, 3 aborted because a
// contributor model served the request.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/config"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/domain"
	"github.com/medilens-ai/medilens/internal/eval"
	"github.com/medilens-ai/medilens/internal/imaging"
	"github.com/medilens-ai/medilens/internal/metaapi"
	"github.com/medilens-ai/medilens/internal/observability"
	"github.com/medilens-ai/medilens/internal/references"
)

// deps are what tests replace: the Meta API client options and the PH FDA
// search URL prefix (local fakes).
type deps struct {
	meta     []metaapi.Option
	phfdaURL string
}

func main() {
	if wd, err := os.Getwd(); err == nil {
		if root, err := eval.RepoRoot(wd); err == nil {
			envFile := filepath.Join(root, ".env")
			if p := domain.JSTrim(os.Getenv("ENV_FILE")); p != "" {
				envFile = p
			}
			if err := config.LoadDotenv(envFile); err != nil {
				fmt.Fprintln(os.Stderr, "Env file not loaded:", observability.ErrorName(err))
			}
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr, deps{})
	stop()
	os.Exit(code)
}

// run is the smoke test: it returns the exit code.
func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer, d deps) int {
	fail := func(msg string) int {
		fmt.Fprintln(stderr, msg)
		return 1
	}
	if len(args) < 1 {
		return fail("Usage: go run ./services/smoke <image> [fda-search-term]")
	}
	imagePath, term := args[0], "biogesic"
	if len(args) > 1 {
		term = args[1]
	}
	key := domain.JSTrim(getenv("MODEL_API_KEY"))
	if key == "" {
		return fail("MODEL_API_KEY is not set. The live smoke test needs it.")
	}
	raw, err := os.ReadFile(imagePath)
	if errors.Is(err, os.ErrNotExist) {
		return fail("Image file not found.")
	}
	if err != nil {
		return fail("Smoke test failed: " + observability.ErrorName(err))
	}
	if _, err := imaging.Validate(raw); err != nil {
		code := contracts.ErrInvalidImage
		var ie *imaging.Error
		if errors.As(err, &ie) {
			code = ie.Code
		}
		return fail("Image rejected: " + string(code))
	}
	img, err := imaging.Normalize(raw)
	if err != nil {
		return fail("Image rejected: " + string(contracts.ErrInvalidImage))
	}

	var completions eval.CompletionLog
	metaOpts := append([]metaapi.Option{metaapi.WithHTTPClient(&http.Client{Transport: completions.Transport(nil)})}, d.meta...)
	client, err := metaapi.New(key, metaOpts...)
	if err != nil {
		return fail("Smoke test failed: " + observability.ErrorName(err))
	}
	read, err := ai.NewMuseSpark(client, ai.MuseSparkOptions{}).Read(ctx, [][]byte{img})
	if err != nil {
		return fail("Smoke test failed: " + observability.ErrorName(err))
	}

	first, aborted := eval.RenderSmokeReport(eval.SmokeReportInput{Completions: completions.Records(), Read: read})
	if aborted {
		for _, line := range first {
			fmt.Fprintln(stdout, line)
		}
		return 3
	}

	// the repository URL alone, as the Node script read it
	cfg, err := config.Load(func(k string) string {
		if k == "PUBLIC_REPO_URL" {
			return getenv(k)
		}
		return ""
	})
	if err != nil {
		return fail(err.Error())
	}
	var fetches eval.FetchLog
	fda := references.NewPHFDA(references.PHFDAOptions{
		UserAgent:  cfg.UserAgent(),
		HTTPClient: &http.Client{Transport: fetches.Transport(nil)},
		APIURL:     d.phfdaURL,
	}).Search(ctx, references.Query{Name: term})

	report, _ := eval.RenderSmokeReport(eval.SmokeReportInput{
		Completions: completions.Records(), Read: read, Fetches: fetches.Records(), FDA: &fda,
	})
	for _, line := range report {
		fmt.Fprintln(stdout, line)
	}
	if !read.OK || fda.Kind != contracts.SearchOK {
		return 1
	}
	return 0
}
