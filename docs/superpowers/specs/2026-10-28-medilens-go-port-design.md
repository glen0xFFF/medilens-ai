# MediLens AI: Go port, Go API + Go MCP server (design amendment)

Status: owner-directed (second master prompt, 2026-10-27; owner chose "port to Go test-for-test, keep Node as fallback"). This document amends `2026-10-27-medilens-design.md` (the base spec). Everything in the base spec still binds unless a section here replaces it: the product intent, the safety rules, the matcher rules §5.4, the spoken order §5.5, the screens §6, the demo scenarios §7, the honest Meta scope §8. The controller's ledger rulings (`.superpowers/sdd/2026-10-27-medilens-mvp/progress.md`) also still bind.

## 1. Intent of the port

- Replace the Node/Express server (`apps/server`) with a Go API service.
- Add a separate Go MCP server that exposes controlled tools over the same application services.
- Keep the Expo Android app, and move it to the new REST contract.

The Node build is tagged `node-fallback-v1` before the port starts. It stays runnable until the Go build reaches parity. A judge-facing demo must never depend on an unfinished port.

**Parity is the bar.** The Node domain logic took many review rounds to make safe: the default-deny safety gate, the strict matcher, the deterministic answers and the closed-vocabulary explanation gate. The Go port re-implements it and must reproduce it exactly. That is proved by a golden corpus recorded from the TypeScript test suite (§6), not by re-deriving the rules.

Anti-goals:
- A Go port that is "mostly" equivalent.
- Any loosening of a safety rule to make a Go test pass.
- A silent fallback from Muse Spark to any other model.
- Claude as a runtime model.
- Claiming that an emulator equals glasses.

## 2. Repository layout

```
go.mod                       module github.com/medilens-ai/medilens (Go 1.27)
services/api/main.go         REST + SSE API binary
services/mcp/main.go         MCP server binary (Streamable HTTP)
internal/config              env loading (stdlib .env loader), validation
internal/contracts           Go structs mirroring packages/contracts (json tags identical)
internal/domain              parsers, matcher, safety, summary, answers (pure, no I/O)
internal/imaging             validate, normalize, quality
internal/ai                  provider.go (interfaces), muse_spark.go, mock.go, factory.go
internal/metaapi             hand-written net/http client for api.meta.ai (chat completions)
internal/references          phfda.go, fixture.go, cache.go
internal/demo                the 8 scenarios (same data as apps/server/src/demo/scenarios.ts)
internal/application         AnalysisService: create, run pipeline, events, explain, speak, delete
internal/pipeline            analyze steps, result store (TTL), spend meter, event log
internal/httpapi             routes, handlers, error mapping, SSE
internal/middleware          request id, access log, CORS, rate limit, recover
internal/mcptools            MCP tool definitions (typed In/Out) calling application services
internal/observability       slog setup with redaction
fixtures/parity/             golden JSONL corpora recorded from the TS suite (§6)
apps/mobile                  Expo app (kept; client moves to the new contract)
packages/contracts           Zod schemas (kept; new endpoint types added; mobile still uses them)
apps/server                  Node server, kept until the parity gate, then removed
```

Toolchain facts:
- Go 1.27, `CGO_ENABLED=0`, so the race detector is unavailable here. The code is written race-free by construction, and `go vet` runs.
- Dependencies are pinned:
  - `github.com/modelcontextprotocol/go-sdk v1.8.0`
  - `golang.org/x/image v0.47.0`
  - `golang.org/x/time v0.16.0`
- Nothing else without a recorded ruling.

## 3. Runtime model and providers (replaces base §4.2)

- `MODEL_PROVIDER = mock | muse_spark`. Default `mock`.
  - `muse_spark` requires `MODEL_API_KEY`. Startup fails if it is missing.
  - There is no fallback between providers.
  - The active provider and model id are returned by `GET /api/v1/config/capabilities` and logged at startup.
- `REFERENCE_PROVIDER = fixture | ph_fda`. Default `fixture`.
- Interfaces live in `internal/ai`:
  - `LabelReader.Read(ctx, images [][]byte) (ReadResult, error)`. Muse Spark vision transcription is the OCR adapter.
    - Rationale, recorded in `docs/MUSE_SPARK_INTEGRATION.md`: on-device ML Kit needs an Expo dev build, Tesseract needs cgo, and a third-party cloud OCR adds a second vendor that receives health images.
    - The reader keeps rawText separate from fields, with legibility per field.
    - Confidence: Muse Spark exposes no numeric confidence, so none is invented. Legibility (`clear | partial | unreadable`) is the only uncertainty signal.
  - `PhraseExplainer.Explain(ctx, phrase string) (string, Usage, error)`. This is the only model text that reaches users, and it still passes the closed-vocabulary gate.
  - `QuestionAnswerer` is gone as a model concern. Answers are deterministic (`internal/domain/answers`), exactly as in Node after Task 7b.
- Muse Spark client (`internal/metaapi`): hand-written `net/http`, non-streaming.
  - Request: `POST https://api.meta.ai/v1/chat/completions` with model `muse-spark-1.3`, `reasoning_effort: "low"`, `max_completion_tokens: 4000`, and `response_format` json_schema strict.
  - Images are sent as data-URL `image_url` parts.
  - Timeout 45 s.
  - Retries: at most one, only on 429/500/503, honouring `Retry-After`. 504 is never retried.
  - Abort when the response `model` is empty or contains "contributor".
  - Invalid JSON gets one retry; then `OCR_FAILED`.
  - Usage feeds the spend meter. A missing `usage` is charged at the conservative estimate (4000 prompt + 4000 completion tokens).
  - Error name and status are logged; bodies are never logged.
- Mock provider:
  - deterministic;
  - returns the s1 label for any real upload, the same as Node demo mode;
  - every result made with it has `isDemo: true` and `provenance.model = "mock"`;
  - the app shows DEMO DATA, and the logs carry `provider=mock`.

## 4. REST contract (replaces base §5.1; Node routes are not kept in Go)

All JSON. Errors use the base `{error:{code,message,requestId}}` shape, and never include stacks. New error codes: `ANALYSIS_NOT_READY` (409), `ANALYSIS_FAILED` (stored on an analysis whose job was cut off before it finished, for example by shutdown; a failed pipeline step keeps its own stored code, such as `OCR_FAILED`, `INVALID_IMAGE` or `INTERNAL_ERROR`). *Amended 2026-10-28 in the final-review fix wave (ledger ruling R14), to match the implementation; the sentence first read "`ANALYSIS_FAILED` (stored on a failed analysis)".*

| Method & path | Behaviour |
|---|---|
| `GET /healthz` | `200 {status:"ok"}`: liveness, no dependencies |
| `GET /readyz` | `200 {status:"ready", checks:{model:"mock"\|"configured", references:"fixture"\|"ph_fda"}}`. It never calls external services, and returns 503 while shutting down |
| `GET /api/v1/config/capabilities` | `{modelProvider, modelId\|null, referenceProvider, maxImages:3, maxImageBytes, ttlSeconds:900, presets:[...], demoScenarios:[{id,title,presetQuestion?}], streaming:{analysisEvents:true}}`. No secrets |
| `POST /api/v1/analyses` | multipart `images` (1–3). Validation is synchronous (400/413/415). Returns `202 {id, status:"processing"}` and runs the pipeline in a bounded worker pool (2 concurrent; queue 8; over that, 503 `RATE_LIMITED` with Retry-After). Budget exhausted (muse_spark): 503 `LIVE_BUDGET_EXHAUSTED` before the job is accepted |
| `GET /api/v1/analyses/{id}` | `{id, status:"processing"\|"completed"\|"failed", stage, events:[...], error?:ErrorBody.error, isDemo}` |
| `GET /api/v1/analyses/{id}/events` | SSE. Replays stored events (each with `id:` seq), then live events. Honours `Last-Event-ID`. Event names `stage` and `completed` / `failed`. 15 s `: heartbeat` comments. The stream ends after the terminal event. It clears the write deadline and is closed on shutdown |
| `GET /api/v1/analyses/{id}/result` | `AnalysisResult` (base §5.3 plus an optional `provenance:{model, references}`). 409 `ANALYSIS_NOT_READY` while processing; the stored error on failure |
| `POST /api/v1/analyses/{id}/explanation` | `{question}` → `Answer`. Same logic as the Node explain route: safety gate first (default-deny), deterministic answers, explain_text through phrase-in-fields and the closed-vocabulary gate |
| `POST /api/v1/analyses/{id}/speak` | `{target:"summary"}` or `{target:"answer", text}` → `{language:"en-US", chunks:[...]}`. The summary comes from `explanation.spokenChunks`. Answer text is chunked by the same splitter. Speech itself runs on the device |
| `GET /api/v1/analyses/{id}/references` | `{candidates, advisories, limitations, checkedAt}`. `checkedAt` is null for demo |
| `DELETE /api/v1/analyses/{id}` | 204; the result and events are dropped |
| `GET /api/v1/demo/scenarios` | the list (also in capabilities) |
| `POST /api/v1/demo/scenarios` | `{scenarioId}` → `202 {id, status:"processing"}`. Runs the real pipeline with fixture providers, so the events are genuine. Always available, whatever the providers are |
| `GET /api/v1/questions/presets` | kept |

Behaviour notes:
- **Event stages**, emitted only when the stage actually starts or finishes:
  1. `received`
  2. `quality`
  3. `reading`
  4. `reviewing_fields`
  5. `checking_references`
  6. `comparing`
  7. `explaining`
  8. `completed`, or `needs_attention` (a quality failure, loose pill or not-a-label is `completed` with that pipelineState, not `failed`; `failed` means an error)

  A stage is skipped, not faked, when it does not run. Payload: `{seq, stage, label (plain English for TTS), at}`.
- **IDs and ownership:** analysis ids are random UUIDv4, the only capability, with a 15-min TTL. Stores cap at 500 entries, oldest evicted. This is documented as the MVP ownership model; there are no accounts.
- **Rate limits:** per-IP token buckets. Write routes (POST/DELETE): 30/min. Read routes (GET): 240/min, so status polling is not throttled. `TRUSTED_PROXIES` is a CIDR list, empty by default, and only those hops' `X-Forwarded-For` is honoured.
- **Uploads:** `r.MultipartReader()` only, with `MaxBytesReader(3×8 MiB + 64 KiB)` and a per-part limit of 8 MiB + 1. `ParseMultipartForm`, `FormValue` and `FormFile` are banned on upload routes (they spill to disk). A guard test points TMPDIR at an empty dir and asserts it stays empty.
- **Imaging** (research-backed; matches the sharp thresholds 12 / 40–235 / 0.08):
  - magic-byte sniff;
  - per-format `DecodeConfig`, and w×h ≤ 40 MP before decode;
  - a 1-concurrent decode semaphore and `GOMEMLIMIT` guidance;
  - JPEG EXIF orientation;
  - Lanczos3 fit inside 2048, never enlarging;
  - JPEG q85;
  - quality measured on the re-decoded q85 JPEG (libvips-compatible greyscale, Laplacian sample std-dev).
  
  Numeric parity with Node is checked on the parity image set with a tolerance of ±0.5 on sharpness and luminance, and ±0.005 on glare. A verdict flip on any parity image fails the test.
- **Logging:** `slog` JSON, with domain types implementing `LogValue` whitelists. `ReplaceAttr` redacts `rawText`, `question`, `evidenceText` and `authorization`. Logs never include bodies or medication values. The access log carries method, route pattern, status, duration and requestId only.
- **CORS:** `CORS_ORIGIN`, exact match after trimming a trailing slash.
- **Shutdown:** SIGINT/SIGTERM → readyz 503 → `Shutdown(10s)`. `RegisterOnShutdown` closes SSE streams, and in-flight jobs get their context cancelled.

## 5. MCP server (new)

- Separate binary `services/mcp`, using go-sdk v1.8.0.
  - `NewStreamableHTTPHandler` with `{Stateless:true, PropagateRequestCancellation:true, MaxRequestBodyBytes: 30 MiB}` at `/mcp`.
  - It listens on `127.0.0.1:8788` by default. A non-loopback bind requires auth.
- **Auth:** `auth.RequireBearerToken` with a verifier over `MCP_API_TOKENS` (comma-separated). Tokens are compared by SHA-256 in constant time. `AllowMissingExpiration`. A bad token wraps `auth.ErrInvalidToken`, giving 401.
  - With no tokens configured, it refuses to start unless `MCP_ALLOW_NO_AUTH=1` AND the bind is loopback.
- **Shared code:** it builds the same `application.AnalysisService`, with the same providers chosen by the same env. Each process has its own store; this is documented.
- **Tools.** All return typed structured content. Every output is capped at 64 KiB of JSON, with long text truncated with a marker. Arguments are validated by schema plus explicit checks.

| Tool | Side effect | Input | Output |
|---|---|---|---|
| `assess_image_quality` | none | `{image_base64}` (≤ 8 MiB decoded) | `{ok, reasons, sharpness, luminance, glareFraction, nextAction}` |
| `extract_medication_label` | creates a transient analysis (TTL 15 min) | `{images_base64[1..3]}` or `{scenario_id}` | `{analysis_id, pipelineState, imageKind, fields[{key,value,legibility,evidenceText}], warnings, isDemo}` |
| `lookup_medication_reference` | none (registry read via the configured provider, at most 2 lookups) | `{analysis_id}` (uses the stored clear fields; there are no free-text URL or query inputs) | `{status: ok\|unavailable\|not_attempted, candidates, advisories, limitations}` |
| `compare_medication_evidence` | none | `{analysis_id}` | `MatchAssessment` |
| `explain_verified_label` | none | `{analysis_id, question}` | `Answer` (same gate; refusals are results, not errors) |
| `get_reference_details` | none | `{analysis_id, registration_number}` (must be one of the stored candidates) | `{sourceName, sourceUrl, record, checkedAt, limitations}` |

  There is no loose-pill identification, no dosing, no browsing, no shell, and no arbitrary query. Tool descriptions state that label text is untrusted data. Operational failures return `IsError` with a safe message. Refusals and unclear answers are normal results.

## 6. Parity method

1. `scripts/parity/record.ts` runs the TypeScript vitest suite with a setup file. The file wraps the exported domain functions and writes every call as `{fn, args, result}` to JSONL, one file per module:
   - `parseStrength`, `strengthsEqual`, `normalizeRegistrationNumber`, `normalizeName`
   - `assessMatch`
   - `classifyQuestion`, `extractExplainPhrase`
   - `buildSummary`
   - `answerFromLabel`, `explanationAllowed`, `findPhraseInFields`, `composeExplainAnswer`
2. Extra probe corpora are added: the fuzz matcher corpus, the safety probe sweeps from the review rounds, and the explanation probes.
3. The corpora are committed under `fixtures/parity/`.
4. The Go tests load each corpus and assert deep-equal results (JSON-normalised).
5. Any Go divergence is a bug in Go. If the TS output itself is wrong, that is a controller ruling with a TS fix first, then a re-record.
6. HTTP-level parity: the 8 scenarios through Go `POST /demo/scenarios` → `/result` must equal the Node `POST /demo/scenario` output, except for id and timestamps.
7. A Node contract test validates every Go endpoint response with the Zod schemas, with the Go binary started via `go run` in mock/fixture mode.

## 7. Mobile changes

- The client moves to the new paths. `analyze()` becomes:
  1. POST `/analyses`;
  2. poll `GET /analyses/{id}` every 750 ms (the read bucket allows it);
  3. GET `/result`.
  
  The analyzing screen shows and announces the real `stage` labels. SSE stays a server capability for MCP, web and future clients. Ruling: React Native EventSource / expo fetch streaming was not verified, and polling is honest and reliable.
- `explain` → `/explanation`. Capabilities replace health for mode detection: `modelProvider: "mock"` shows "Server is in demo mode". Delete is called when the user leaves a result (best effort).
- Everything else is unchanged.

## 8. Dev workflow

- **Root npm scripts** (tested on Windows): `go:test` (`go test ./...`), `go:vet`, `go:fmt` (`gofmt -l` must be empty), `go:lint` (vet + gofmt + staticcheck via `go run honnef.co/go/tools/cmd/staticcheck@<pinned>`), `dev:api`, `dev:mcp`, `demo` (api in mock+fixture mode).
- **Makefile:** thin wrappers over the same commands. It is marked "unverified on the dev machine (no make installed)" until run somewhere.
- **Dockerfile** for the API (multi-stage, distroless static) and `docker-compose.yml` for api + mcp. These are marked unverified locally (no Docker); EAS and the host build them.
- **Android:** no local SDK or emulator. Validation is jest + typecheck + `expo export --platform android` locally, plus EAS cloud builds. The emulator instructions are documented, not claimed as run.

## 9. Docs (replaces base §10 list)

README, docs/PROJECT_PLAN.md, ARCHITECTURE.md (mermaid), API.md, MCP_TOOLS.md, MUSE_SPARK_INTEGRATION.md (verified facts with sources, what is unverified until a live call, exact steps), SAFETY.md, PRIVACY.md, TESTING.md (real command output only), DEMO_SCRIPT.md, HACKATHON_SUBMISSION.md.

Existing docs are merged into these, and nothing true is dropped. Real versus mock is stated per capability.

## 10. Done means

The base spec's done criteria, plus:
- the Go API and MCP server run separately;
- the parity corpora pass 100%;
- the Zod contract test passes against Go;
- the mobile app passes jest and typecheck on the new client;
- MCP tools pass in-memory tests plus one authenticated HTTP test;
- the Node server is removed only after all of the above (Node fallback tag kept);
- docs are honest.
