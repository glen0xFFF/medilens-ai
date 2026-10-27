# MediLens AI — Safety and Privacy

MediLens AI is an **accessibility reader for medicine labels**. It is not a medical device, not a
diagnostic tool, not a prescription generator, not a dosing calculator and not a pill
identifier. Users are told this in a spoken first-run disclaimer and on the Safety screen, and
every spoken summary ends with "Confirm with your pharmacist or doctor."

## What the AI does and does not decide

- **Meta Muse Spark transcribes** the printed label into structured fields, each with a
  legibility flag (clear, partial, unreadable) and the evidence text it read. Its only other job
  is the gated "explain this printed phrase" answer described below; it never decides a match,
  a verification status or whether a question is answered.
- **Verification is deterministic code**, not the model: parsers normalise strength and
  registration number, names and dosage forms are normalised, and a rule-based matcher compares
  them with the registry (rules in the design spec §5.4). The expiry date is not parsed: it is
  read and spoken exactly as printed (only the offline accuracy eval parses its month and year).
- The spoken summary is a **deterministic template**.
- Questions are answered deterministically from the label. The only model use in answers is for
  "explain this printed phrase": the model sees only that printed field, and its explanation is
  used only if it passes a strict content gate (no numbers, units, populations, verdict or advice
  words); otherwise the printed text is quoted alone.
- A model response from any model id containing "contributor" is discarded (Meta Model API
  terms, routing caveat).

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
  exception is the fixed advisory sentence used when the FDA itself has published an advisory:
  "The FDA has issued an advisory about counterfeit versions of this product. Check with your
  pharmacist." Printed pack text is read back verbatim.
- FDA advisories are a separate flag, never folded into a "verified" status.
- The registry's expiry date is the **registration certificate's** expiry. It is never read as
  the medicine's expiry; the medicine's expiry is read only from the pack.
- A loose tablet is never identified: "This looks like a loose tablet. I can't identify a medicine
  from how it looks. Please ask a pharmacist."

## Question safety gate (default-deny)

Questions are classified by deterministic patterns before any answer is produced. Refusal
patterns run first: personal dosing, starting or stopping a medicine, diagnosis and symptoms,
pregnancy, children and other special populations, interactions, "is it safe for me", pill
identification and possible overdose. Anything that does not match an explicit allowed intent
(read the label, explain printed text, a printed field, which parts were unclear, the registry
result, repeat) is refused. Refusals redirect to a pharmacist; possible-overdose wording, and
the dose and safety refusals, include "If someone has already taken too much, call 911."
The app shows preset questions as buttons because free-typed questions are often refused.

## Demo mode is simulated

Demo mode uses **fixture (simulated) data**: fictional products, fictional registry records, no
calls to Meta or the FDA. Every demo response has `isDemo: true` and every demo screen shows
**DEMO DATA**. A demo result is never a real verification.

## External data sources

- **PH FDA verification search** (`verification.fda.gov.ph/api/search`) is an **undocumented
  endpoint and may change or stop working without notice**. It is called only by the server,
  with an honest `User-Agent` naming the project, a 5-second timeout, a 24-hour cache and at most
  two lookups per scan. If it fails, the result says the registry check is unavailable; the
  label is still read. The owner intends to request permission from PH FDA after the hackathon.
- **Meta Model API** (`muse-spark-1.3`, Standard mode).

## Privacy

- **Photos are never stored.** On the phone, photos exist only as temporary files in the app's
  cache directory until upload and are deleted after upload or on cancel; the app never writes
  to the photo gallery. On the server, uploads are held in memory (no disk writes) and discarded
  after the request.
- Analysis results (read text, match, summary) are held **in server memory for 15 minutes** so
  follow-up questions work, then dropped. There are no accounts, no scan history and no database.
- On the phone only settings (speech rate, contrast, text size) and the disclaimer
  acknowledgement are saved.
- Server logs contain method, path, status, duration and request id only; image bytes, read
  text, evidence and questions are not logged.
- Live mode sends the photos to the Meta Model API for transcription; the PH FDA lookup sends
  only a registration number or product name.

## Secrets

- The Meta Model API key lives only in the server environment (`MODEL_API_KEY`, in a git-ignored
  `.env`). The mobile app contains no keys and only talks to the MediLens server.
- `EXPO_PUBLIC_API_BASE_URL` is a public URL, not a secret.
- A secret scan is part of the submission checklist.

## Abuse and cost controls

- 30 requests per minute per IP on the API.
- A daily (UTC) spend cap on live model calls (`DAILY_SPEND_CAP_USD`, default 5); when reached,
  live scans and live explanations return `503 LIVE_BUDGET_EXHAUSTED` and the app suggests Demo
  Mode.

## Out of scope

Meta glasses are **roadmap only and not implemented**. Voice input is not built.
