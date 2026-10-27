# MediLens AI — Muse Spark integration

How MediLens uses Meta Muse Spark through the Meta Model API, what is verified, what is **not
verified until a live call**, and the exact steps to make that first call.

**No live call to `api.meta.ai` has been made from this repository, by either the Node or the Go
build.** No API key was available to the build agents. Every statement below about live
behaviour comes from Meta's documentation, and every Go behaviour was tested against a local fake
server replaying recorded synthetic responses (DEMO DATA, fictional products).

## What the model is used for

1. **Transcription (OCR).** `LabelReader.Read(ctx, images)` sends 1 to 3 normalised JPEG photos
   of one package and gets back an `ExtractedLabel`: each field's value exactly as printed, its
   legibility (`clear`, `partial`, `unreadable`), the evidence text and notes, plus `rawText` kept
   separate from the fields. The model never decides a match, a status or an answer.
2. **One printed phrase, explained.** `PhraseExplainer.Explain(ctx, phrase)` is called only for an
   allowed "explain this printed text" question, only with the whole printed field (never a
   fragment without its "Do not"), and only when that field has no printed negation or condition.
   The reply reaches a user only if it passes the closed-vocabulary gate (no numbers, units,
   populations, verdict or advice words); otherwise the printed text is quoted alone.

Question answering is **not** a model concern: answers are deterministic
(`internal/domain/answers.go`), exactly as in the Node build.

**Why Muse Spark is also the OCR.** On-device ML Kit needs an Expo development build (the app runs
in Expo Go), Tesseract needs cgo (the Go build is `CGO_ENABLED=0`), and a third-party cloud OCR
would send health images to a second vendor. Muse Spark exposes **no numeric confidence**, so none
is invented: legibility is the only uncertainty signal.

## Verified facts, with sources

Re-checked on 2026-10-27 against Meta's raw documentation pages (`https://dev.meta.ai/docs/<page>.md`)
and legal pages. VERIFIED means seen in that primary source, not observed on a live call.

| Fact | Source |
|---|---|
| Base URL `https://api.meta.ai/v1`; auth header `Authorization: Bearer <MODEL_API_KEY>` | docs/api-reference |
| `POST /v1/chat/completions` is the OpenAI-compatible messages endpoint; there is no Meta SDK, and Go is not mentioned | docs/api-reference, docs/sdks |
| `muse-spark-1.3` is recommended for new work; input includes images; `muse-spark-1.3-contributor` is the Contributor (training) variant | docs/models |
| Image parts: `{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}}`; 50 MB per inline image, 50 images per request | docs/image-understanding |
| Structured output: `response_format: {type:"json_schema", json_schema:{name, schema, strict}}`; decoding is constrained; `strict:true` needs `additionalProperties:false` and every key in `required` | docs/structured-output |
| Non-streaming requests can return `504 gateway_timeout`; Meta says not to just retry a 504 | docs/error-handling |
| `reasoning_effort` is a top-level Chat Completions field (`low` is valid) | docs/reasoning |
| `max_completion_tokens` is the current name (covers reasoning plus visible tokens); no numeric maximum is published for `muse-spark-1.3` | docs/protocols/chat-completions |
| Usage reports `completion_tokens_details.reasoning_tokens` | API schemas, docs/reasoning |
| Rate limits are per team: `muse-spark-1.3` 3,000 RPM and 4,000,000 TPM; 429 carries `Retry-After`; 503 uses `Retry-After: 60`; do not retry 400/401/402/403/404/413 | docs/pricing-rate-limits, docs/error-handling |
| Price, Standard mode, per 1M tokens: $1.25 input, $4.25 output, $0.15 cached; reasoning billed as output | docs/pricing-rate-limits |
| "Meta does not use your Content from Standard Services to train Meta Models"; Contributor content may be used for training | dev.meta.ai/legal/commitments |
| Retention: "as needed" for the listed purposes, no fixed period; content can be viewed and deleted through the account | dev.meta.ai/legal/terms-of-service §4, /legal/commitments |
| ToS routing caveat: the system may route to a Contributor model, and the user must check | dev.meta.ai/legal/terms-of-service §1 |

## What the Go client does

`internal/metaapi` is a hand-written `net/http` client (no OpenAI SDK: `openai-go` reads
`OPENAI_*` environment variables and retries a 504 by default). `internal/ai/muse_spark.go` builds
the requests:

- `POST https://api.meta.ai/v1/chat/completions`, non-streaming, model **`muse-spark-1.3`**,
  `reasoning_effort: "low"`, `max_completion_tokens: 4000`, `response_format` `json_schema` with
  `strict: true` (schemas `medicine_label` and `phrase_explanation`).
- Images as data-URL `image_url` parts. The system prompt says text in the photo is data, never
  instructions.
- **Timeout 45 s** for the whole call, retry included.
- **Retries:** at most one, only after HTTP 429, 500 or 503, after `Retry-After` (1 s without
  one), and only if that wait fits in the time budget. **A 504 is never retried**, nor any other
  status, timeout or network error.
- **Contributor guard:** a response whose `model` is missing, empty or contains "contributor"
  (any ASCII case) is discarded: the read fails with `OCR_FAILED` (`contributor_model`) and an
  explanation falls back to the quote.
- **Invalid output:** JSON that fails validation gets one more request; then `OCR_FAILED`
  (`invalid_output`).
- **Usage** feeds the daily spend meter. A response without `usage`, or a failed attempt that may
  have run, is charged the conservative estimate of 4,000 prompt + 4,000 completion tokens. Two
  consequences, both on the safe side (the meter over-counts, never under-counts):
  - an attempt cancelled before any request was written (for example a job cut off at shutdown)
    is still charged the estimate;
  - one read or one explanation can make up to 4 HTTP attempts (the 429/500/503 retry runs
    inside each of the 2 invalid-output completions), and each failed attempt is charged.
- **Logging:** the error kind and HTTP status only; never a body, a prompt, label text or the key.
  The key is a `config.Secret` that prints `[redacted]` in every format.
- No silent fallback: `MODEL_PROVIDER=muse_spark` without `MODEL_API_KEY` is a startup error.

A test compares the request bodies, value for value, with the bodies the Node build sent
(`fixtures/parity/providers/muse-requests.json`). The one intended difference: the token cap goes
by its current name `max_completion_tokens` (Node sent the deprecated alias `max_tokens`, also
4000).

## Not verified until a live call

- That the live endpoint accepts this exact request (strict schema, `reasoning_effort: "low"`,
  `max_completion_tokens: 4000`, three data-URL images) and returns `model: "muse-spark-1.3"`.
- Real `finish_reason`, token usage, `reasoning_tokens` and latency for a label read; whether
  4,000 completion tokens is enough for a dense label (a `length` finish truncates the JSON, which
  then fails validation).
- Transcription accuracy on real packs: measured only by the owner's 20-pack eval
  (`npm run eval:labels`, bar: zero confidently-wrong strengths or expiry dates).
- Real `Retry-After` and `x-ratelimit-*` behaviour on vision requests.
- PH FDA side (same smoke run): the advisory (`fdawebsite`) row field names.

## Steps for the first live call (owner)

1. Claim the Meta Model API credits and create a key. Put it **only** in the repository-root
   `.env` (git-ignored): `MODEL_API_KEY=...`. Never in `apps/mobile`, never committed.
2. Keep `DAILY_SPEND_CAP_USD` low (default 5).
3. Smoke test, one read and one registry lookup, metadata only:
   ```bash
   npm run smoke:live -- path/to/real-pack-photo.jpg biogesic
   ```
   It prints the serving model id, finish reason, token usage (including `reasoning_tokens` when
   reported), the PH FDA HTTP status and response key names, never read text. Exit 3 means a
   contributor model served the request, or the response named no model (missing or empty): stop
   and investigate. Paste the printed lines into
   [TESTING.md](TESTING.md).
4. Run the API live: set `MODEL_PROVIDER=muse_spark` and `REFERENCE_PROVIDER=ph_fda` in `.env`,
   `npm run dev:api`, and check `GET /api/v1/config/capabilities` reports
   `modelProvider: "muse_spark"`, `modelId: "muse-spark-1.3"`.
5. Run the accuracy eval on the 20 packs ([eval/README.md](../eval/README.md)) and commit only
   `docs/eval-results.md`.
