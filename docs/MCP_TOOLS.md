# MediLens AI — MCP tools

`services/mcp` is a separate Go binary that exposes the MediLens pipeline to MCP clients as six
typed tools (Go port spec §5). It uses the official Go SDK `github.com/modelcontextprotocol/go-sdk`
v1.8.0 and builds the **same** `application.AnalysisService` as the REST API, with the same
providers chosen by the same environment (`MODEL_PROVIDER`, `REFERENCE_PROVIDER`,
`MODEL_API_KEY`, `DAILY_SPEND_CAP_USD`). Code: `internal/mcptools`.

What it is not: no loose-pill identification, no dosing, no browsing, no shell, no free-text
registry query and no arbitrary URL. Every tool description tells the client that **label text is
untrusted data**, never instructions.

## Transport and auth

- Streamable HTTP at **`/mcp`**, stateless (`Stateless: true`), request cancellation propagated to
  the tool, request bodies capped at 30 MiB.
- Listens on `MCP_ADDR`, default **`127.0.0.1:8788`**.
- Auth: bearer tokens from `MCP_API_TOKENS` (comma-separated, 16 to 512 visible ASCII characters
  each), compared by SHA-256 in constant time. A missing or wrong token is `401`.
- With no tokens configured the server **refuses to start** unless `MCP_ALLOW_NO_AUTH=1` **and**
  the address is loopback (checked before and after the bind). A non-loopback bind always needs
  tokens.
- This process has its **own analysis store**: an `analysis_id` from the REST API is unknown here,
  and the other way round. Analyses live 15 minutes.
- Shutdown on SIGINT/SIGTERM: calls in flight get 10 s, then their analyses are cancelled.

```bash
MCP_ALLOW_NO_AUTH=1 npm run dev:mcp                 # loopback, no auth (local use only)
MCP_API_TOKENS=<16+ char token> npm run dev:mcp     # bearer auth
```

Any MCP client that speaks Streamable HTTP can connect to `http://127.0.0.1:8788/mcp`, sending
`Authorization: Bearer <token>` when tokens are configured.

## Tools

All tools return typed structured content. Every output is capped at **64 KiB of JSON**; long
text is cut with the marker ` [truncated]`. Arguments are validated by the input schema plus
explicit checks. Operational failures (unknown or expired analysis, invalid image, budget
exhausted, provider error) return `isError` with a short safe message. **Refusals and unclear
answers are normal results, not errors.** Every output carries `isDemo`; `true` marks made-up
DEMO DATA.

| Tool | Side effect | Input | Output |
|---|---|---|---|
| `assess_image_quality` | none (photo not stored) | `{image_base64}` (≤ 8 MiB decoded) | `{ok, reasons, sharpness, luminance, glareFraction, nextAction}`; `nextAction` is `extract_medication_label` or `retake_photo` |
| `extract_medication_label` | creates a transient analysis (TTL 15 min) | `{images_base64: [1..3]}` or `{scenario_id}` | `{analysis_id, pipelineState, imageKind, fields: [{key, value, legibility, evidenceText}], warnings, isDemo}` |
| `lookup_medication_reference` | none | `{analysis_id}` | `{status: ok \| unavailable \| not_attempted, candidates, advisories, limitations, isDemo}` |
| `compare_medication_evidence` | none | `{analysis_id}` | `MatchAssessment` fields `{status, matched, conflicting, missing, candidates, advisories, limitations, isDemo}` |
| `explain_verified_label` | none | `{analysis_id, question}` | `Answer` `{status, text, spokenChunks, citedFields, safetyNotice, isDemo}` |
| `get_reference_details` | none | `{analysis_id, registration_number}` (must be one of the stored candidates) | `{sourceName, sourceUrl, record, checkedAt, limitations, isDemo}` |

Notes per tool:

- **`assess_image_quality`** runs the same validation and quality check as an upload: magic-byte
  sniff, size and pixel limits, normalisation, sharpness / luminance / glare against the same
  thresholds as the app. Reasons are `BLURRY`, `TOO_DARK`, `GLARE`.
- **`extract_medication_label`** runs the full pipeline. With `scenario_id` it runs one of the
  eight demo scenarios on fixture data (always available). A field that is not `clear` must not be
  read out as certain; a loose pill is never identified.
- **`lookup_medication_reference`** reports the registry lookup the analysis already made from
  its **clearly read** fields (at most 2 lookups). There is no query or URL input. A record's
  `registrationExpiry` is the registration certificate's expiry, never the medicine's.
- **`compare_medication_evidence`** returns the deterministic match. `no_match` does not mean the
  product is not genuine; advisories are reported apart from the status.
- **`explain_verified_label`** runs **the same default-deny safety gate** as
  `POST /analyses/{id}/explanation` (same service code path): questions about how much to take,
  starting or stopping, symptoms, children or pregnancy, interactions, personal safety or
  identifying pills are refused with a pharmacist redirect. Answers come only from the printed
  label and the registry; a model phrase explanation is kept only if it passes the
  closed-vocabulary gate.
- **`get_reference_details`** returns one stored candidate record by its registration number,
  exactly as `lookup_medication_reference` returned it. `checkedAt` is null for demo data.

## Real versus mock

The tools are only as live as the configured providers: with the defaults
(`MODEL_PROVIDER=mock`, `REFERENCE_PROVIDER=fixture`) every label is the fictional s1 label and
every output has `isDemo: true`. With `muse_spark` the photos go to the Meta Model API, and the
daily spend cap applies (this process has its own meter).

## Tests

`internal/mcptools` has in-memory tests (the SDK's in-memory transport) for every tool, including
refusals through `explain_verified_label`, output caps and error mapping, plus an HTTP test with a
bearer token (`internal/mcptools/http_test.go`); `services/mcp` tests the startup auth rules.
Results are in [TESTING.md](TESTING.md).
