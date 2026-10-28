# MediLens Go Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the MediLens server to a Go API service plus a separate Go MCP server. Parity with the Node build is proved by golden corpora. Then the mobile app moves to the new contract and Node is retired.

**Architecture:** One Go module at the repo root, with two binaries (`services/api`, `services/mcp`) over shared `internal/application` services. Domain logic is pure Go, checked against TS-recorded golden JSONL. Contracts mirror the Zod schemas and are checked by a Node contract test.

**Tech Stack:** Go 1.27 (stdlib net/http, slog), golang.org/x/image v0.47.0, golang.org/x/time v0.16.0, github.com/modelcontextprotocol/go-sdk v1.8.0; Node only for parity recording and Zod contract tests; Expo app unchanged in stack.

**Spec:** `docs/superpowers/specs/2026-10-28-medilens-go-port-design.md`, which amends `docs/superpowers/specs/2026-10-27-medilens-design.md`.

## Global Constraints

- Every safety rule of the base spec and the ledger rulings binds unchanged. The Go port never loosens a rule to pass a test.
- Parity corpora (`fixtures/parity/*.jsonl`) must pass 100%. A divergence is a Go bug unless the controller rules that the TS output is wrong.
- `MODEL_PROVIDER=mock|muse_spark` (default mock), `REFERENCE_PROVIDER=fixture|ph_fda` (default fixture). There is no silent fallback. Muse Spark without `MODEL_API_KEY` is a startup error.
- Model `muse-spark-1.3`. Abort if the response model is empty or contains "contributor". `reasoning_effort:"low"`, `max_completion_tokens:4000`, timeout 45 s. Retry once only on 429/500/503; never retry 504.
- Uploads go through `MultipartReader` only. `ParseMultipartForm`, `FormValue` and `FormFile` are banned on upload routes. Images are never written to disk.
- Error body `{error:{code,message,requestId}}`, never with a stack. Logs never contain bodies, label values, questions or keys.
- Never output "fake" or "counterfeit" except the fixed advisory sentence, which is used only when the advisory title contains "counterfeit".
- Pinned dependencies only: `go-sdk v1.8.0`, `x/image v0.47.0`, `x/time v0.16.0`. Anything else needs a ruling.
- `gofmt -l .` must be empty, and `go vet ./...` must be clean. Run Go tests from Bash: `go test ./...`.
- Root `npm test`, `npm run typecheck` and `npm run lint` stay green until the Node removal task.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.

## Review Focus

1. A Go string function that is not Unicode-equivalent to JS: NFKC, `\p{Cf}`, case folding, `\b` word boundaries (JS `\b` is ASCII-only, while Go regexp `\b` is ASCII too, but `(?i)` and Unicode classes differ). Parity corpora must include non-ASCII cases. Test in G2/G3.
2. JSON shape drift: `null` vs omitted fields, empty arrays vs `null`. Go `nil` slices marshal as `null`, but the Zod schemas expect `[]`. The contract test (G9) and the corpus deep-equal (G2–G4) catch it.
3. A goroutine or SSE leak when the client disconnects or the server shuts down. Test in G8.
4. A multipart upload spilling to disk via a helper. There is a guard test in G8.
5. MCP tool output that bypasses the safety gate (`explain_verified_label` must run the same gate). Test in G10.

---

### Task G1: Tag fallback, Go module skeleton, parity recorder

**Files:** git tag `node-fallback-v1` at the current HEAD (after the final fix wave). Create:
- `go.mod` (module `github.com/medilens-ai/medilens`, go 1.27);
- `internal/contracts/*.go` (structs mirroring `packages/contracts`, with identical json tags; slices default to `[]` via constructors or MarshalJSON so they never emit `null` where Zod expects an array);
- `scripts/parity/record.ts` plus `scripts/parity/setup.ts` (a vitest setup that wraps the domain exports and appends `{fn,args,result}` lines);
- `fixtures/parity/{parsers,matcher,safety,summary,answers}.jsonl`;
- `fixtures/parity/README.md`;
- root npm script `parity:record`;
- `internal/parity/load.go` (a JSONL loader for Go tests);
- `.gitattributes` entry `fixtures/parity/*.jsonl -text`.

**Interfaces, Produces:** Go types `contracts.{ExtractedLabel, LabelField, FieldKey, Legibility, ImageKind, QualityReport, ReferenceRecord, MatchAssessment, MatchStatus, Explanation, PipelineState, AnalysisResult, Answer, ErrorCode, ErrorBody}`, plus `parity.Load(t, file) []Case{Fn string; Args []json.RawMessage; Result json.RawMessage}`.

- [ ] Step 1: Write the recorder. Record from the full server vitest suite plus the extra probe corpora:
  - the matcher fuzz generator output (seeded);
  - `test/fixtures/explanationProbes.ts`;
  - the safety probe tables.
  
  Deduplicate on `fn + args`. Assert that the recorder captured at least one case per exported function, and print the counts.
- [ ] Step 2: Go test `internal/contracts`: round-trip each recorded `result` that is an `AnalysisResult`, `MatchAssessment` or `Answer` through the Go struct, and assert byte-equal normalized JSON. This catches tag or shape drift.
- [ ] Step 3: `go test ./...` and `go vet ./...` must pass, and `gofmt -l .` must be empty. The root npm gates must stay green.
- [ ] Step 4: Commit `chore(go): tag node fallback, go module, contracts and parity corpora`.

### Task G2: Parsers in Go

**Files:** `internal/domain/parsers.go`, `parsers_test.go`.
**Produces:** `ParseStrength(s string) *Strength`, `StrengthsEqual(a, b *Strength) bool`, `NormalizeRegistrationNumber(s string) *string`, `NormalizeName(s string) string`, and the exported word lists. These mirror `apps/server/src/domain/parsers.ts` exactly. Read it first; it holds invariants: NFKC normalisation, every digit consumed, `\p{Cf}` makes the result null.
- [ ] TDD against `fixtures/parity/parsers.jsonl`: every case deep-equal. Use `golang.org/x/text/unicode/norm` for NFKC. This needs a ruling: x/text is not on the pinned list. The ruling is **allowed: `golang.org/x/text` at the latest stable**.
- [ ] Commit `feat(go): label parsers with ts parity`.

### Task G3: Matcher and safety gate in Go

**Files:** `internal/domain/{matcher,safety}.go` plus tests.
**Produces:** `AssessMatch(label *contracts.ExtractedLabel, search references.SearchResult) contracts.MatchAssessment`, `ClassifyQuestion(q string) QuestionClass`, `ExtractExplainPhrase(q string) *string`, `RefusalText`, `AllowedQuestionExamples`.
- [ ] TDD against `matcher.jsonl` and `safety.jsonl`, 100% deep-equal. JS regex patterns must be translated carefully. Go RE2 has no lookahead or lookbehind, so any TS pattern that uses them must be re-expressed in code. List every such pattern in the report, with the equivalent Go logic. Add a performance test: a 10k-character question classifies in under 50 ms (median of 5).
- [ ] Commit `feat(go): matcher and default-deny safety gate with ts parity`.

### Task G4: Summary and deterministic answers in Go

**Files:** `internal/domain/{summary,answers}.go` plus tests.
**Produces:** `BuildSummary(in SummaryInput) contracts.Explanation`, `AnswerFromLabel(in AnswerInput) contracts.Answer`, `ExplanationAllowed(text string) bool`, `FindPhraseInFields`, `ComposeExplainAnswer`, `ChunkSpeech(text string) []string`.
- [ ] TDD against `summary.jsonl` and `answers.jsonl`, 100%.
- [ ] Commit `feat(go): spoken summary and deterministic answers with ts parity`.

### Task G5: Imaging in Go

**Files:** `internal/imaging/{validate,normalize,quality,exif,lanczos}.go` plus tests, and `fixtures/parity/images/` (synthetic test images plus Node sharp reference metrics recorded by `scripts/parity/record-images.ts`).
**Produces:** `Validate(b []byte) (Format, error)` (magic bytes, 8 MiB, DecodeConfig ≤ 40 MP), `Normalize(b []byte) ([]byte, error)` (EXIF orientation, Lanczos3 fit 2048 without enlarging, JPEG q85), `Assess(jpeg []byte) contracts.QualityReport`.
- [ ] Follow the research notes: `C:\Users\025gl\AppData\Local\Temp\claude\G---gnox--METAPROJECT\0496b293-53ce-41df-82de-2fa802754eb4\scratchpad\go-research\imaging.md`. Its scratch code is in `scratchpad\go-research\imgtest\`.
- [ ] Tests:
  - Parity per image: sharpness ±0.5, luminance ±0.5, glare ±0.005, and the verdict exactly equal.
  - A decompression bomb (a header of 7000×7000) is rejected before decode.
  - A WebP decodes.
  - EXIF 6 rotates.
- [ ] Commit `feat(go): image validation, normalization and quality with sharp parity`.

### Task G6: Providers (Muse Spark client, mock, PH FDA, fixtures, demo)

**Files:**
- `internal/metaapi/client.go`
- `internal/ai/{provider,muse_spark,mock,factory}.go`
- `internal/references/{phfda,fixture,cache}.go`
- `internal/demo/scenarios.go`
- tests with an httptest fake Meta server and fake PH FDA, using the recorded fixtures from `apps/server/test/fixtures/{muse,phfda}`.

**Produces:** `ai.LabelReader`, `ai.PhraseExplainer`, `ai.NewFromConfig(cfg) (Providers, error)`, `references.Provider`, `demo.Scenarios`.
- [ ] Port behaviour from the Node providers. Read `museSpark.ts`, `phFda.ts`, `fixture.ts`, `scenarios.ts` and the Node tests. Port each Node provider test case to Go.
- [ ] Spec §3 client rules:
  - one retry, only on 429/500/503;
  - 504 not retried;
  - contributor or empty model aborts;
  - invalid JSON gets one retry, then OCR_FAILED;
  - missing usage is charged at the estimate;
  - advisory and record rows are validated against the contract rules (`httpUrl`); bad rows are dropped and the advisory is flagged unchecked.
- [ ] Commit `feat(go): muse spark client, mock provider, ph fda and demo fixtures`.

### Task G7: Application service and pipeline

**Files:** `internal/pipeline/{analyze,store,events,budget}.go`, `internal/application/service.go` plus tests.
**Produces:** `application.Service` with:
- `Create(ctx, images [][]byte) (id, error)`
- `CreateDemo(ctx, scenarioID) (id, error)`
- `Status(id)`
- `Result(id)`
- `Subscribe(id, afterSeq) (<-chan Event, cancel)`
- `Explain(id, question)`
- `Speak(id, target, text)`
- `References(id)`
- `Delete(id)`
- `Capabilities()`

Plus a bounded worker pool (2 workers, queue 8), the TTL store (15 min, cap 500), and a spend meter matching Node (UTC-midnight reset, prices $1.25 per 1M input and $4.25 per 1M output).
- [ ] Tests:
  - All 8 demo scenarios through `CreateDemo` must give a `Result` deep-equal to the Node `/demo/scenario` output, excluding id and timestamps. Record this in G1 if missing; otherwise add a recorder for it here.
  - Events are genuine and ordered, and stages are skipped (not faked) when they do not run.
  - A cancelled ctx stops the job.
  - Queue full returns the error.
  - Budget exhausted rejects before the job is accepted.
  - TTL and cap eviction.
- [ ] Commit `feat(go): analysis service with genuine progress events`.

### Task G8: HTTP API service

**Files:** `internal/httpapi/*.go`, `internal/middleware/*.go`, `internal/observability/log.go`, `internal/config/config.go`, `services/api/main.go` plus tests (httptest).
- [ ] Implement every route in spec §4, including the error mapping, rate limits (write 30/min, read 240/min, `TRUSTED_PROXIES`), CORS, request id, access log, redaction and graceful shutdown.
- [ ] Tests:
  - every route's happy path and error path;
  - the TMPDIR guard (largest allowed upload leaves an empty dir) plus a negative control showing that `ParseMultipartForm` would spill;
  - SSE: replay, `Last-Event-ID`, heartbeat (injectable interval), terminal close, client disconnect frees the subscriber, shutdown closes streams;
  - no stack text in any error body;
  - logs contain no label values or questions (log sink capture);
  - capabilities expose no secrets;
  - `MODEL_PROVIDER=muse_spark` without a key makes the config fail.
- [ ] Commit `feat(go): rest api with sse progress, limits and redacted logs`.

### Task G9: Cross-language contract test

**Files:** `scripts/contract/go-contract.test.ts` (vitest under the root, or `packages/contracts/test`). It builds and starts `go run ./services/api` on a free port in mock and fixture mode, waits for `/readyz`, and calls every route. It validates each response with the Zod schemas; new endpoint schemas are added to `packages/contracts/src/api.ts`. The Go-vs-Node HTTP diff covers the 8 scenarios, comparing Node's `/api/v1/demo/scenario` output, started the same way, against Go `/result`.
- [ ] Commit `test(contract): go api responses validated against zod contracts`.

### Task G10: MCP server

**Files:** `internal/mcptools/*.go`, `services/mcp/main.go` plus tests.
- [ ] Per spec §5:
  - Stateless Streamable HTTP with `PropagateRequestCancellation`.
  - Bearer auth over hashed `MCP_API_TOKENS`, with the loopback / `MCP_ALLOW_NO_AUTH` rule.
  - 6 typed tools on `application.Service`.
  - 64 KiB output cap.
  - Input checks: base64 size ≤ 8 MiB decoded; `registration_number` must be a stored candidate.
- [ ] Tests:
  - in-memory transport for every tool's happy and error paths;
  - `explain_verified_label` refuses a dose question exactly as the API does;
  - one httptest Streamable HTTP test with a valid token (200) and an invalid token (401);
  - the server refuses to start on a non-loopback bind with no tokens.
- [ ] Commit `feat(go): mcp server with typed read-only tools over shared services`.

### Task G11: Mobile client on the new contract

**Files:** `apps/mobile/src/api/client.ts`, `apps/mobile/app/analyzing.tsx`, the demo, ask and sources screens, and settings (mode detection via capabilities). Tests are updated.
- [ ] `analyze()` and `scenario()` = POST, then poll `GET /analyses/{id}` every 750 ms with the real stage labels announced, then GET `/result`. Abort on unmount. Best-effort `DELETE` when the result screen is left for home. The capabilities `modelProvider` drives the "Server is in demo mode" notice.
- [ ] Jest tests: polling sequence, failed analysis, network failure, `ANALYSIS_NOT_READY` retry, abort on unmount. Root gates must stay green.
- [ ] Commit `feat(mobile): client on go api contract with real progress stages`.

### Task G12: Dev workflow, deploy files, docs, Node removal

**Files:**
- root npm scripts (`go:test`, `go:vet`, `go:fmt`, `go:lint`, `dev:api`, `dev:mcp`, `demo`);
- `Makefile` (wrappers, marked unverified locally);
- `Dockerfile.api`, `Dockerfile.mcp`, `docker-compose.yml` (marked unverified locally);
- `.env.example` (all vars per component);
- docs per spec §9 (merging the existing docs);
- the `eval` harness ported to `cmd/eval` or kept: **ruling: port `score` to Go (`internal/eval`) and `scripts/eval-labels` to `services/eval/main.go`, parity with the TS score tests**;
- `smoke-live` ported to `services/smoke/main.go`;
- delete `apps/server` once G1–G11 are green;
- update root scripts, lint config and `docs/TEST_PLAN.md` → `docs/TESTING.md` with real outputs.

- [ ] Run the following and paste the real output into TESTING.md:
  - `gofmt -l .`
  - `go vet ./...`
  - `go test ./...`
  - staticcheck
  - root `npm test` / `npm run typecheck` / `npm run lint`
  - `npx expo export --platform android` in `apps/mobile`
  
  Device, emulator, live smoke and eval runs are "NOT RUN — owner".
- [ ] Commit `docs: go architecture, mcp tools, muse spark integration and submission docs` and `chore: retire node server after go parity`.
