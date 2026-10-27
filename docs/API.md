# MediLens AI — API

Base URL: the MediLens Go API (`services/api`), e.g. `http://localhost:8787`. All request and
response types are defined as Zod schemas in [`packages/contracts`](../packages/contracts) and
mirrored by Go structs with identical JSON keys in `internal/contracts`; this document summarises
them. Routes are implemented in `internal/httpapi`. The contract test (`scripts/contract`, run by
the root `npm test`) starts the Go API in mock + fixture mode and validates every endpoint's
response with the Zod schemas.

The Node routes (`/health`, `POST /labels/analyze`, `/labels/:id/explain`, `/references/:id`,
`POST /demo/scenario`) are **not** kept; this is the Go port's contract (Go port spec §4).

- `GET /healthz` and `GET /readyz` are at the root. Every other route is under **`/api/v1`**.
- Per-IP token buckets: **30 requests per minute** for writes (POST, DELETE) and **240 per
  minute** for reads (GET); past either, `429 RATE_LIMITED` with `Retry-After`. One phone polling
  every 750 ms uses 80 reads a minute, so about three phones behind one shared public address can
  reach the read limit; the app then waits out `Retry-After` (see Progress events).
- Every response carries a request id (`X-Request-Id`); errors include it in the body.
- JSON request bodies are limited to 16 KB. Uploads: at most 3 × 8 MiB + 64 KiB.

## Endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/healthz` | — | `200 {status: "ok"}`: liveness, no dependencies |
| GET | `/readyz` | — | `200 {status: "ready", checks: {model: "mock" \| "configured", references: "fixture" \| "ph_fda"}}`; never calls external services; `503` once shutdown has begun |
| GET | `/api/v1/config/capabilities` | — | `{modelProvider, modelId \| null, referenceProvider, maxImages: 3, maxImageBytes, ttlSeconds: 900, presets, demoScenarios: [{id, title, presetQuestion?}], streaming: {analysisEvents: true}}`. No secrets |
| POST | `/api/v1/analyses` | multipart/form-data, field **`images`**, 1–3 files, each ≤ 8 MiB, JPEG/PNG/WebP | `202 {id, status: "processing"}` |
| GET | `/api/v1/analyses/{id}` | — | `{id, status: "processing" \| "completed" \| "failed", stage, events, error?, isDemo}` |
| GET | `/api/v1/analyses/{id}/events` | optional `Last-Event-ID` | Server-Sent Events, see below |
| GET | `/api/v1/analyses/{id}/result` | — | `AnalysisResult`; `409 ANALYSIS_NOT_READY` while processing; the stored error on failure |
| POST | `/api/v1/analyses/{id}/explanation` | `{question: string}` (1–300 characters) | `Answer` |
| POST | `/api/v1/analyses/{id}/speak` | `{target: "summary"}` or `{target: "answer", text}` | `{language: "en-US", chunks: string[]}`; speech itself runs on the device |
| GET | `/api/v1/analyses/{id}/references` | — | `{candidates, advisories, limitations, checkedAt}`; `checkedAt` is null for demo data and when the registry was not reached |
| DELETE | `/api/v1/analyses/{id}` | — | `204`; the result and events are dropped |
| GET | `/api/v1/demo/scenarios` | — | `[{id, title, presetQuestion?}]`; only s7 has `presetQuestion`, which the app shows as a button on that result's ask screen |
| POST | `/api/v1/demo/scenarios` | `{scenarioId: string}` | `202 {id, status: "processing"}`; always available, whatever the providers and the budget |
| GET | `/api/v1/questions/presets` | — | `string[]` of preset questions |

### POST /analyses

The upload is validated synchronously: missing or too many photos is `400 VALIDATION_FAILED`, a
photo over 8 MiB `413 IMAGE_TOO_LARGE`, a file that is not a decodable JPEG/PNG/WebP (or over
40 MP) `415 INVALID_IMAGE`. With `MODEL_PROVIDER=muse_spark`, an exhausted daily budget is
`503 LIVE_BUDGET_EXHAUSTED` before the job is accepted. The analysis then runs in a bounded worker
pool (2 running, 8 queued); over that, `503 RATE_LIMITED` with `Retry-After`.

- `muse_spark` + `ph_fda`: the photos are normalised and quality-checked, read by Muse Spark and
  checked against the PH FDA registry.
- `mock` (default): the photos still get the real validation and quality check, then the label is
  read as **demo scenario s1 (simulated data)** and the result has `isDemo: true`,
  `provenance.model = "mock"`.

Unreadable labels, loose pills, no match, conflicts and an unavailable registry are **states
inside a completed `AnalysisResult`** (`stage: "needs_attention"` for the first three kinds), not
HTTP errors, so the user still hears whatever was read. `failed` means an error.

### Progress events

Stages, emitted only when the step actually starts or finishes: `received`, `quality`, `reading`,
`reviewing_fields`, `checking_references`, `comparing`, `explaining`, then `completed` or
`needs_attention` (or `failed`). A stage that does not run is skipped, never faked. Each event is
`{seq, stage, label, at}`; `label` is plain English for text-to-speech (for example "Reading the
label.").

`GET /analyses/{id}/events` replays the stored events (each with `id: <seq>`), then streams live
ones. It honours `Last-Event-ID`. Event names are `stage`, `completed` and `failed`. A
`: heartbeat` comment is sent every 15 s. The stream ends after the terminal event, when the
analysis is deleted or expires, and on shutdown. The Android app polls `GET /analyses/{id}`
instead (every 750 ms). A live read takes about 40 to 120 polls, so a poll (or the `/result`
fetch) that fails for a passing reason (no network, a 15 s timeout, a `429`, or a `5xx` whose body
is not this API's error body, such as a proxy's page) is retried after 1.5 s, 3 s and then 6 s, or
after the `429`'s `Retry-After` when that is longer (capped at 30 s). The app gives up after 3
such failures in a row; an answered poll starts the count again. When the app gives up on an
analysis the server may still be running (retries used up, an answer it cannot read, or the user
leaving), it sends a best-effort `DELETE /analyses/{id}`, which stops the server's work. A failed
analysis and a `404 NOT_FOUND` end the wait without a delete (`apps/mobile/src/api/client.ts`,
`follow`).

### POST /analyses/{id}/explanation

Same logic as the Node explain route. The question first passes a **default-deny** safety gate:
only questions matching an allowed intent (read the label, explain printed text, what a printed
field says, which parts were unclear, what the registry says, repeat) are answered. Everything
else returns a 200 `Answer` with `status: "refused"` and a pharmacist redirect. Answers are built
deterministically from the label and the registry; only "explain this printed phrase" may use the
model, and its text is dropped unless it passes the closed-vocabulary gate. The app offers
`GET /questions/presets` as buttons; free text is secondary.

### GET /analyses/{id}/references

`checkedAt` is when registry data was retrieved. A candidate's `registrationExpiry` is the
**registration certificate's** expiry, not the medicine's.

### Demo scenarios

`POST /demo/scenarios` runs the real pipeline from the read step onwards with fixture providers.
Scenario ids:

| Id | Scenario | Expected status |
|---|---|---|
| `s1-clear` | Clear package, registration number matches | `verified` |
| `s2-blurry` | Blurry photo with glare | `label_unreadable` (BLURRY, GLARE) |
| `s3-similar` | Two similar products | `ambiguous` |
| `s4-conflict` | Label strength 500 mg vs registry 250 mg | `conflicting` |
| `s5-nomatch` | Unknown product | `no_match` |
| `s6-loose-pill` | Loose pill | `loose_pill`, nothing identified |
| `s7-unsupported-question` | Unsupported dosing question | answer `refused` |
| `s8-registry-down` | Registry unavailable | `unavailable` |

An unknown id returns `404 NOT_FOUND`. All demo data is **fixture (simulated)** data about
fictional products. The `/result` of each scenario equals the recorded Node output except for
ids and timestamps (`fixtures/parity/scenarios.jsonl`).

## Core types (summary)

- `AnalysisResult = {id, isDemo, createdAt, expiresAt, pipelineState, quality, label, match, explanation, imageRetention: "none", provenance?: {model, references}}`; `label` is `null` when the photo failed the quality check.
- `PipelineState = "label_unreadable" | "not_a_label" | "loose_pill" | "text_extracted" | "explanation_ready"`
- `LabelField = {key, value: string | null, legibility: "clear" | "partial" | "unreadable", evidenceText, imageIndex, notes}`
- `MatchAssessment = {status, matched, conflicting: {key, labelValue, referenceValue}[], missing, candidates, advisories: {title, url}[], limitations}`;
  `status` is one of `verified | partial | conflicting | ambiguous | no_match | unavailable | not_attempted`.
- `Explanation = {displayText, spokenChunks, safetyNotices, supportingFields}`
- `Answer = {status: "answered" | "refused" | "unclear", text, spokenChunks, citedFields, safetyNotice}`

## Errors

Body: `{"error": {"code", "message", "requestId"}}`. Messages are fixed, short and safe to speak.
No stack traces.

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Missing or too many photos, bad JSON body, bad id or question |
| `NOT_FOUND` | 404 | Unknown route or method, unknown scenario, expired or unknown analysis id |
| `ANALYSIS_NOT_READY` | 409 | `/result` while the analysis is still processing |
| `IMAGE_TOO_LARGE` | 413 | A photo over 8 MiB (or the whole upload over its cap) |
| `INVALID_IMAGE` | 415 | Not a JPEG, PNG or WebP, undecodable, or over 40 MP |
| `RATE_LIMITED` | 429 / 503 | Over the per-IP budget (429), or the worker queue is full (503 with `Retry-After`) |
| `OCR_FAILED` | 502 | The live reader failed or returned invalid output (stored on the failed analysis) |
| `LIVE_BUDGET_EXHAUSTED` | 503 | Daily live spend cap reached; demo endpoints still work |
| `ANALYSIS_FAILED` | 500 | Stored on an analysis that was cancelled (for example by shutdown) |
| `INTERNAL_ERROR` | 500 | Anything unexpected |

`LABEL_UNREADABLE`, `NO_RELIABLE_MATCH`, `CONFLICTING_MATCH`, `REFERENCE_UNAVAILABLE` and
`UNSUPPORTED_REQUEST` exist in the `ErrorCode` enum; in normal operation these situations are
reported inside a 200 response, as described above.

## External services (server only)

- **Meta Model API** (`https://api.meta.ai/v1/chat/completions`, OpenAI-compatible), model
  `muse-spark-1.3`, through the hand-written client in `internal/metaapi`. Used to transcribe the
  label and, for "explain this printed phrase" questions only, to explain that printed text. See
  [MUSE_SPARK_INTEGRATION.md](MUSE_SPARK_INTEGRATION.md).
- **PH FDA verification search** (`https://verification.fda.gov.ph/api/search?q=<term>`).
  **Undocumented and may change without notice.** Response field names were confirmed by the
  Node build against one real response on 2026-10-27 for registry rows; advisory (`fdawebsite`)
  row field names are not yet confirmed (`npm run smoke:live` prints them).
