# MediLens AI — API Specification

Base URL: the MediLens server, e.g. `http://localhost:8787`. All request and response types are
defined as Zod schemas in [`packages/contracts`](../packages/contracts); this document summarises
them. The routes are implemented in `apps/server/src/routes/`.

- `GET /health` is at the root. Every other route is under **`/api/v1`**.
- `/api/*` is rate limited to **30 requests per minute per IP** (`429 RATE_LIMITED`).
- Every response carries a request id; errors include it in the body.
- JSON request bodies are limited to 16 KB.

## Endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/health` | — | `{status: "ok", version, providerMode: "demo" \| "live"}` |
| POST | `/api/v1/labels/analyze` | multipart/form-data, field **`images`**, 1–3 files, each ≤ 8 MB, JPEG/PNG/WebP | `AnalysisResult` |
| GET | `/api/v1/labels/:id` | — | stored `AnalysisResult` (404 after 15 minutes) |
| POST | `/api/v1/labels/:id/explain` | `{question: string}` (1–300 characters) | `Answer` |
| GET | `/api/v1/references/:id` | — | `{candidates: ReferenceRecord[], advisories: {title, url}[], limitations: string[], checkedAt: string \| null}` |
| GET | `/api/v1/demo/scenarios` | — | `DemoScenarioSummary[]` = `{id, title, presetQuestion?}[]`; only s7 has `presetQuestion`, which the app shows as a button on that result's ask screen |
| POST | `/api/v1/demo/scenario` | `{scenarioId: string}` | `AnalysisResult` with `isDemo: true` |
| GET | `/api/v1/questions/presets` | — | `string[]` of preset questions |

### POST /labels/analyze

- `PROVIDER_MODE=live`: the photos are validated, normalised and quality-checked, read by Muse
  Spark and checked against the PH FDA registry. Before the model is called, the daily spend cap
  is checked (`503 LIVE_BUDGET_EXHAUSTED` when reached).
- `PROVIDER_MODE=demo`: the photos still get real validation and quality checks, then the label
  is read as **demo scenario s1 (simulated data)** and the result has `isDemo: true`.
- Unreadable labels, no match, conflicts and an unavailable registry are **states inside a 200
  `AnalysisResult`**, not HTTP errors, so the user still hears whatever was read.

### POST /labels/:id/explain

The question first passes a **default-deny** safety gate: only questions matching an allowed
intent (read the label, explain printed text, what a printed field says, which parts were
unclear, what the registry says, repeat) are answered. Everything else returns a 200 `Answer`
with `status: "refused"` and a pharmacist redirect. The app should offer
`GET /questions/presets` as buttons; free text is secondary. Demo results (`isDemo: true`) are
always answered by the deterministic fixture answerer.

### GET /references/:id

`checkedAt` is when registry data was retrieved; `null` when the registry was not checked or
could not be reached. A candidate's `registrationExpiry` is the **registration certificate's**
expiry, not the medicine's.

### POST /demo/scenario

Runs the real pipeline from the read step onwards with fixture providers. Scenario ids:

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

An unknown id returns `404 NOT_FOUND`. All demo data is **fixture (simulated)**
data about fictional products.

## Core types (summary)

- `AnalysisResult = {id, isDemo, createdAt, expiresAt, pipelineState, quality, label, match, explanation, imageRetention: "none"}`; `label` is `null` when the photo failed the quality check.
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
| `VALIDATION_FAILED` | 400 | Missing photos, bad JSON body, bad id |
| `NOT_FOUND` | 404 | Unknown route, unknown scenario, expired or unknown result id |
| `IMAGE_TOO_LARGE` | 413 | A photo over 8 MB |
| `INVALID_IMAGE` | 415 | Not a JPEG, PNG or WebP, or undecodable |
| `RATE_LIMITED` | 429 | Over 30 requests per minute |
| `OCR_FAILED` | 502 | The live reader failed or returned invalid output |
| `LIVE_BUDGET_EXHAUSTED` | 503 | Daily live spend cap reached; demo endpoints still work |
| `INTERNAL_ERROR` | 500 | Anything unexpected |

`LABEL_UNREADABLE`, `NO_RELIABLE_MATCH`, `CONFLICTING_MATCH`, `REFERENCE_UNAVAILABLE` and
`UNSUPPORTED_REQUEST` exist in the `ErrorCode` enum; in normal operation these situations are
reported inside a 200 response, as described above.

## External services (server only)

- **Meta Model API** (`https://api.meta.ai/v1`, OpenAI-compatible), model `muse-spark-1.3`.
  Used to transcribe the label and, for "explain this printed phrase" questions only, to explain
  that printed text. A response from a model whose id contains "contributor" is discarded.
- **PH FDA verification search** (`https://verification.fda.gov.ph/api/search?q=<term>`).
  **Undocumented and may change without notice.** Response field names were confirmed against
  one real response on 2026-10-27 for registry rows; advisory (`fdawebsite`) row field names are
  not yet confirmed (the live smoke script prints them).
