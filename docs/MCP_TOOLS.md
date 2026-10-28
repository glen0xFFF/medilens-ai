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
  each), compared by SHA-256 in constant time. A missing or wrong token is `401` with
  `WWW-Authenticate: Bearer` (RFC 6750); there is no OAuth metadata.
- The bearer token travels in clear over plain HTTP. For any non-loopback bind, terminate TLS in
  front of the server (a reverse proxy or the platform's load balancer).
- With no tokens configured the server **refuses to start** unless `MCP_ALLOW_NO_AUTH=1` **and**
  the address is loopback (checked before and after the bind). A non-loopback bind always needs
  tokens.
- This process has its **own analysis store**: an `analysis_id` from the REST API is unknown here,
  and the other way round. Analyses live 15 minutes.
- Shutdown on SIGINT/SIGTERM: calls in flight get 10 s, then their analyses are cancelled. An
  extract still running at that point ends the process with exit 1 and a "shutdown failed" log
  line; that is the ordinary path for a call cut off by shutdown, not a crash.
- It reads the same `.env` through the same loader as the API, which also validates the API-only
  `PORT`, `CORS_ORIGIN` and `TRUSTED_PROXIES`: a bad value for one of them stops the MCP server
  from starting too.
- There is no limit on concurrent requests beyond the bearer auth; each request body (up to
  30 MiB) is copied a few times while it is decoded. Set `GOMEMLIMIT` as for the API.

```bash
MCP_ALLOW_NO_AUTH=1 npm run dev:mcp                 # loopback, no auth (local use only)
MCP_API_TOKENS=<16+ char token> npm run dev:mcp     # bearer auth
```

Any MCP client that speaks Streamable HTTP can connect to `http://127.0.0.1:8788/mcp`, sending
`Authorization: Bearer <token>` when tokens are configured.

## Tools

All tools return typed structured content. Every output is capped at **64 KiB of JSON**; long
text is cut with the marker ` [truncated]`. The cap applies to the structured content; the SDK
repeats the same JSON as the text content, so a whole `tools/call` result can be about twice
that (about 128 KiB). A list too long to fit (for example a live brand search returning roughly
100 or more registry records to `compare_medication_evidence` or `lookup_medication_reference`)
is not cut: the call fails with `INTERNAL_ERROR` ("too large"). This fails closed; the REST API
returns the whole list. Arguments are validated by the input schema plus
explicit checks. When the SDK's schema check fails, its message (cut to 300 characters) is
returned and can quote the caller's own argument back. Operational failures (unknown or expired analysis, invalid image, budget
exhausted, provider error) return `isError` with a short safe message. **Refusals and unclear
answers are normal results, not errors.** Every output carries `isDemo`; `true` marks made-up
DEMO DATA.

| Tool | Side effect | Input | Output |
|---|---|---|---|
| `assess_image_quality` | none (photo not stored) | `{image_base64}` (≤ 8 MiB decoded) | `{ok, reasons, sharpness, luminance, glareFraction, nextAction}`; `nextAction` is `extract_medication_label` or `retake_photo` |
| `extract_medication_label` | creates a transient analysis (TTL 15 min); with `muse_spark`, a charged Meta call | `{images_base64: [1..3]}` or `{scenario_id}` (the request body is capped at 30 MiB, so three photos near 8 MiB each, about 32 MiB as base64, are refused with `413`) | `{analysis_id, pipelineState, imageKind, fields: [{key, value, legibility, evidenceText}], warnings, isDemo}` |
| `lookup_medication_reference` | none | `{analysis_id}` | `{status: ok \| unavailable \| not_attempted, candidates, advisories, limitations, isDemo}` |
| `compare_medication_evidence` | none | `{analysis_id}` | `MatchAssessment` fields `{status, matched, conflicting, missing, candidates, advisories, limitations, isDemo}` |
| `explain_verified_label` | none stored; on a live result an "explain this printed phrase" question may make a charged Muse Spark call | `{analysis_id, question}` | `Answer` `{status, text, spokenChunks, citedFields, safetyNotice, isDemo}` |
| `get_reference_details` | none | `{analysis_id, registration_number}` (must be one of the stored candidates) | `{sourceName, sourceUrl, record, checkedAt, limitations, isDemo}` |

Annotations: every tool has `destructiveHint: false`. `readOnlyHint` is true for all but
`extract_medication_label`. `openWorldHint` is true for `extract_medication_label` and
`explain_verified_label`, the two that can reach the configured providers.

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
daily spend cap applies. This process has its own meter, apart from the API's, so with both the
API and the MCP server on `muse_spark` the day's total spend can reach **twice**
`DAILY_SPEND_CAP_USD`; halve the cap for each process if that matters.

## Tests

`internal/mcptools` has in-memory tests (the SDK's in-memory transport) for every tool, including
refusals through `explain_verified_label`, output caps and error mapping, plus an HTTP test with a
bearer token (`internal/mcptools/http_test.go`); `services/mcp` tests the startup auth rules.
Results are in [TESTING.md](TESTING.md).
