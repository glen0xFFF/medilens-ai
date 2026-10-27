# MediLens AI — Safety

MediLens AI is an **accessibility reader for medicine labels**. It is not a medical device, not a
diagnostic tool, not a prescription generator, not a dosing calculator and not a pill
identifier. Users are told this in a spoken first-run disclaimer and on the Safety screen, and
every spoken summary ends with "Confirm with your pharmacist or doctor."

Privacy, secrets and data handling are in [PRIVACY.md](PRIVACY.md).

## What the AI does and does not decide

- **Meta Muse Spark transcribes** the printed label into structured fields, each with a
  legibility flag (clear, partial, unreadable) and the evidence text it read. Its only other job
  is the gated "explain this printed phrase" answer described below; it never decides a match,
  a verification status or whether a question is answered.
- **Verification is deterministic code**, not the model: parsers normalise strength and
  registration number, names and dosage forms are normalised, and a rule-based matcher compares
  them with the registry (rules in the base design spec §5.4). The expiry date is not parsed: it
  is read and spoken exactly as printed (only the offline accuracy eval parses its month and
  year).
- The spoken summary is a **deterministic template**.
- Questions are answered deterministically from the label. The only model use in answers is for
  "explain this printed phrase": the model sees only that printed field, and its explanation is
  used only if it passes a strict content gate (no numbers, units, populations, verdict or advice
  words); otherwise the printed text is quoted alone.
- A model response whose model id is missing, empty or contains "contributor" is discarded (Meta
  Model API terms, routing caveat).
- Claude is never a runtime model in MediLens; the only runtime model is Muse Spark, and only when
  `MODEL_PROVIDER=muse_spark`. There is no silent fallback from Muse Spark to any other model.

## The same rules in Go

The Go port re-implements the Node domain logic and is held to it, not re-derived: golden corpora
recorded from the TypeScript test suite (`fixtures/parity/`) must pass 100% in `go test`, and a
Go/TS difference counts as a Go bug. No safety rule was loosened to make a Go test pass. The
safety patterns use lookarounds that Go's RE2 lacks, so the Go build runs the **same pattern
text** through an ECMAScript-semantics matcher (`internal/jsregex`) instead of hand-translating
them. String handling that differs between Go and JS (NFKC, case mapping, `\p{Cf}`, word
boundaries, UTF-16 lengths) was re-implemented to the JS behaviour and is covered by non-ASCII
corpus cases.

The MCP tool `explain_verified_label` calls the same service method as
`POST /analyses/{id}/explanation`, so it runs the same gate; refusals are results, not errors.

## Honesty rules

- Never sound more certain than the evidence. Fields that are not clearly legible never count as
  matched and are spoken as unclear.
- Statuses are always conveyed in words and an icon, never by colour alone: "Matches FDA
  registry", "Partly matches", "Does not match registry", "Several possible matches", "No
  registry match", "Registry check unavailable", "Not checked", "Label unreadable", plus an
  "FDA advisory" marker when one exists.
- A conflict with the registry (for example label 500 mg, registry 250 mg) outranks every other
  status and is spoken with a warning.
- "No match" is spoken as: "No matching registration found. This does not mean the product is
  fake. Ask your pharmacist." The app never calls a product fake or counterfeit. The one
  exception is the fixed advisory sentence, used only when an FDA advisory's title mentions
  counterfeits: "The FDA has issued an advisory about counterfeit versions of this product. Check
  with your pharmacist." Printed pack text is read back verbatim.
- FDA advisories are a separate flag, never folded into a "verified" status.
- The registry's expiry date is the **registration certificate's** expiry. It is never read as
  the medicine's expiry; the medicine's expiry is read only from the pack.
- A loose tablet is never identified: "This looks like a loose tablet. I can't identify a medicine
  from how it looks. Please ask a pharmacist."
- Progress stages are reported only when a step actually runs; a skipped step is never shown as
  done.

## Question safety gate (default-deny)

Questions are classified by deterministic patterns before any answer is produced. Refusal
patterns run first: personal dosing, starting or stopping a medicine, diagnosis and symptoms,
pregnancy, children and other special populations, interactions, "is it safe for me", pill
identification and possible overdose. Anything that does not match an explicit allowed intent
(read the label, explain printed text, a printed field, which parts were unclear, the registry
result, repeat) is refused. Questions over 300 UTF-16 code units are refused before any pattern
runs. Refusals redirect to a pharmacist; possible-overdose wording, and the dose and safety
refusals, include "If someone has already taken too much, call 911." The app shows preset
questions as buttons because free-typed questions are often refused.

## Demo mode is simulated

Demo scenarios and the mock/fixture providers use **fixture (simulated) data**: fictional
products, fictional registry records, no calls to Meta or the FDA. Every such response has
`isDemo: true` and every demo screen shows **DEMO DATA**. A demo result is never a real
verification.

## External data sources

- **PH FDA verification search** (`verification.fda.gov.ph/api/search`) is an **undocumented
  endpoint and may change or stop working without notice**. It is called only by the server,
  with an honest `User-Agent` naming the project, a 5-second timeout, a 24-hour cache and at most
  two lookups per scan. If it fails, the result says the registry check is unavailable; the
  label is still read. The owner intends to request permission from PH FDA after the hackathon.
- **Meta Model API** (`muse-spark-1.3`, Standard mode). See
  [MUSE_SPARK_INTEGRATION.md](MUSE_SPARK_INTEGRATION.md).

## Abuse and cost controls

- Per-IP rate limits on the API: 30 writes and 240 reads per minute. A bounded worker pool (2
  running, 8 queued) answers `503 RATE_LIMITED` with `Retry-After` when full.
- A daily (UTC) spend cap on live model calls (`DAILY_SPEND_CAP_USD`, default 5); when reached,
  live analyses and explanations return `503 LIVE_BUDGET_EXHAUSTED` and the app suggests Demo
  Mode. The API and the MCP server each have their own meter, and a restart resets it.
- The MCP server needs bearer tokens off loopback, caps each tool output at 64 KiB, and has no
  free-text query, URL, browsing or shell tool.

## Out of scope

Meta glasses are **roadmap only and not implemented**. Voice input is not built.
