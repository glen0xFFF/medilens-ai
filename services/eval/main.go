// Command eval is the label accuracy eval (spec §5.1), the Go port of
// apps/server/scripts/eval-labels.ts (tag node-fallback-v1). It runs the
// LIVE Muse Spark reader over every pack in eval/packs/<id>/ (truth.json
// plus its images), prints a per-field table and every confidently-wrong
// case, and writes aggregate counts only to docs/eval-results.md. Photos
// and read text never leave this machine. It calls the real Meta Model
// API and costs money: run it by hand, never in CI or tests.
//
//	MODEL_API_KEY=... npm run eval:labels
//	(or: go run ./services/eval)
//
// MODEL_API_KEY and DAILY_SPEND_CAP_USD may be set in the repository-root
// .env (or the file ENV_FILE names); a variable set in the environment
// wins. The repository root is the first directory at or above the
// working directory that holds go.mod.
//
// Exit codes: 0 done (or no packs), 1 setup error, 2 the strength/expiry
// bar was missed.
//
// Differences from the Node script, all failing closed: an image name of
// "." or ".." is rejected with the other non-file names (Node let ".."
// through and then crashed reading a folder), and an image that passes
// validation but fails normalisation skips its pack (Node crashed the
// run).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/config"
	"github.com/medilens-ai/medilens/internal/domain"
	"github.com/medilens-ai/medilens/internal/eval"
	"github.com/medilens-ai/medilens/internal/imaging"
	"github.com/medilens-ai/medilens/internal/metaapi"
	"github.com/medilens-ai/medilens/internal/observability"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

// deps are what tests replace: the Meta API client options (a local fake)
// and the clock.
type deps struct {
	meta []metaapi.Option
	now  func() time.Time
}

func main() {
	wd, err := os.Getwd()
	if err == nil {
		var root string
		if root, err = eval.RepoRoot(wd); err == nil {
			envFile := filepath.Join(root, ".env")
			if p := domain.JSTrim(os.Getenv("ENV_FILE")); p != "" {
				envFile = p
			}
			if derr := config.LoadDotenv(envFile); derr != nil {
				fmt.Fprintln(os.Stderr, "Env file not loaded:", observability.ErrorName(derr))
			}
			ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
			code := run(ctx, root, os.Getenv, os.Stdout, os.Stderr, deps{now: time.Now})
			stop()
			os.Exit(code)
		}
	}
	fmt.Fprintln(os.Stderr, "Eval failed:", observability.ErrorName(err))
	os.Exit(1)
}

type skip struct{ dir, reason string }

type wrong struct {
	packID string
	field  string
	value  *string
}

// packDirs are the folders under packsDir that hold a truth.json, in JS
// sort order.
func packDirs(packsDir string) []string {
	entries, err := os.ReadDir(packsDir)
	if err != nil {
		return nil
	}
	var dirs []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(packsDir, e.Name(), "truth.json")); err == nil {
			dirs = append(dirs, e.Name())
		}
	}
	slices.SortFunc(dirs, eval.CompareUTF16)
	return dirs
}

// loadTruth reads and validates a pack's truth.json; a string is why the
// pack is skipped.
func loadTruth(dir string) (eval.GroundTruth, string) {
	b, err := os.ReadFile(filepath.Join(dir, "truth.json"))
	if err != nil {
		return eval.GroundTruth{}, "truth.json is not valid JSON"
	}
	truth, err := eval.ParseGroundTruth(b)
	if err != nil {
		return eval.GroundTruth{}, err.Error()
	}
	// image names must be plain file names inside the pack folder
	for _, name := range truth.Images {
		if filepath.Base(name) != name || name == "." || name == ".." {
			return eval.GroundTruth{}, "images must be file names inside the pack folder"
		}
	}
	return truth, ""
}

// loadImages prepares the images in memory as the live pipeline does:
// validate, then normalise. A string is why the pack is skipped.
func loadImages(dir string, names []string) ([][]byte, string) {
	var out [][]byte
	for _, name := range names {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if errors.Is(err, os.ErrNotExist) {
			return nil, "missing image " + name
		}
		if err != nil {
			return nil, name + ": unreadable file"
		}
		if _, err := imaging.Validate(b); err != nil {
			var ie *imaging.Error
			if errors.As(err, &ie) {
				return nil, name + ": " + string(ie.Code)
			}
			return nil, name + ": INVALID_IMAGE"
		}
		norm, err := imaging.Normalize(b)
		if err != nil {
			return nil, name + ": INVALID_IMAGE"
		}
		out = append(out, norm)
	}
	return out, ""
}

// backslash is a reverse solidus.
const backslash = string(rune(0x5c))

// jsonString is JSON.stringify of a string: no HTML escaping, and U+2028
// and U+2029 left as they are.
func jsonString(s string) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	out := strings.TrimSuffix(b.String(), "\n")
	ls, ps := string(rune(0x2028)), string(rune(0x2029))
	return strings.NewReplacer(backslash+"u2028", ls, backslash+"u2029", ps).Replace(out)
}

// run is the eval: it returns the exit code.
func run(ctx context.Context, root string, getenv func(string) string, stdout, stderr io.Writer, d deps) int {
	fail := func(msg string) int {
		fmt.Fprintln(stderr, msg)
		return 1
	}
	packsDir := filepath.Join(root, "eval", "packs")
	resultsFile := filepath.Join(root, "docs", "eval-results.md")

	dirs := packDirs(packsDir)
	if len(dirs) == 0 {
		fmt.Fprintln(stdout, "No packs found")
		return 0
	}
	key := domain.JSTrim(getenv("MODEL_API_KEY"))
	if key == "" {
		return fail("MODEL_API_KEY is not set. The accuracy eval runs the live Muse Spark reader and needs it.")
	}
	// the spend cap alone, as the Node script read it
	cfg, err := config.Load(func(k string) string {
		if k == "DAILY_SPEND_CAP_USD" {
			return getenv(k)
		}
		return ""
	})
	if err != nil {
		return fail(err.Error())
	}
	capUSD := cfg.DailySpendCapUSD

	meter := pipeline.NewSpendMeter(capUSD, d.now)
	client, err := metaapi.New(key, d.meta...)
	if err != nil {
		return fail("Eval failed: " + observability.ErrorName(err))
	}
	reader := ai.NewMuseSpark(client, ai.MuseSparkOptions{})

	var scored [][]eval.FieldScore
	var confidentlyWrong []wrong
	var skipped []skip
	attempted := 0
	for _, dir := range dirs {
		if meter.Exhausted() {
			fmt.Fprintf(stderr, "Daily spend cap of $%s reached; stopping before pack %s.\n", strconv.FormatFloat(capUSD, 'f', -1, 64), dir)
			break
		}
		attempted++
		packDir := filepath.Join(packsDir, dir)
		truth, reason := loadTruth(packDir)
		if reason != "" {
			skipped = append(skipped, skip{dir, reason})
			continue
		}
		images, reason := loadImages(packDir, truth.Images)
		if reason != "" {
			skipped = append(skipped, skip{dir, reason})
			continue
		}
		read, err := reader.Read(ctx, images)
		meter.Record(read.Usage)
		if err != nil {
			return fail("Eval failed: " + observability.ErrorName(err))
		}
		if !read.OK {
			skipped = append(skipped, skip{dir, string(read.Code()) + " (" + read.Detail + ")"})
			continue
		}
		scores := eval.ScoreLabel(truth, read.Label)
		scored = append(scored, scores)
		for _, s := range scores {
			if !s.ConfidentlyWrong {
				continue
			}
			var value *string
			for _, f := range read.Label.Fields {
				if f.Key == s.Field {
					value = f.Value
					break
				}
			}
			confidentlyWrong = append(confidentlyWrong, wrong{truth.PackID, string(s.Field), value})
		}
		fmt.Fprintln(stdout, "Scored "+truth.PackID)
	}

	for _, s := range skipped {
		fmt.Fprintf(stderr, "Skipped %s: %s\n", s.dir, s.reason)
	}
	if len(scored) == 0 {
		return fail("No pack could be scored; docs/eval-results.md was not written.")
	}

	summary := eval.Summarize(scored)
	// skipped and unattempted packs are counted, so a run with failures
	// never reads as a clean pass (final review Minor 31)
	runInfo := eval.Run{Found: len(dirs), Attempted: attempted, Skipped: len(skipped)}
	fmt.Fprintf(stdout, "\nPacks found: %d   attempted: %d   scored: %d   skipped: %d   Spent: $%.4f\n\n",
		runInfo.Found, runInfo.Attempted, summary.Packs, runInfo.Skipped, meter.SpentUSD())
	tw := tabwriter.NewWriter(stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "field\tcorrect\tunreadable\tconfidentlyWrong")
	for _, f := range summary.Fields {
		fmt.Fprintf(tw, "%s\t%d/%d\t%d\t%d\n", f.Field, f.Correct, f.Total, f.Unreadable, f.ConfidentlyWrong)
	}
	_ = tw.Flush()

	if len(confidentlyWrong) == 0 {
		fmt.Fprintln(stdout, "No confidently-wrong fields.")
	} else {
		fmt.Fprintln(stdout, "Confidently wrong (value wrong while legibility was clear):")
		for _, c := range confidentlyWrong {
			v := "(null)"
			if c.value != nil {
				v = jsonString(*c.value)
			}
			fmt.Fprintf(stdout, "  %s  %s  read: %s\n", c.packID, c.field, v)
		}
	}

	md := eval.RenderResultsMarkdown(summary, d.now().UTC().Format("2006-01-02"), runInfo)
	if err := os.WriteFile(resultsFile, []byte(md), 0o644); err != nil {
		return fail("Eval failed: " + observability.ErrorName(err))
	}
	fmt.Fprintf(stdout, "\nWrote aggregate counts to %s\n", resultsFile)
	bar := eval.MeetsBar(summary)
	verdict := "NOT MET"
	if bar {
		verdict = "MET"
	}
	fmt.Fprintln(stdout, "Bar (zero confidently-wrong strengths or expiry dates): "+verdict)
	if !bar {
		return 2
	}
	return 0
}
