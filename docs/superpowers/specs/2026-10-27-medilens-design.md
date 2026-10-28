# MediLens AI — Design

**Date:** 2026-10-27
**Status:** Approved (owner, 2026-10-27); amended by ledger rulings
**Research basis:** `docs/research/2026-10-27-decision-memo.md` (adversarially verified; tags VERIFIED / UNVERIFIED there apply here)

> MediLens AI — Medication Accessibility Assistant.
> *See the label. Hear the information. Understand with confidence.*

## 1. Intent

People with low vision, older adults, and anyone who struggles with small print cannot read medicine packaging reliably. MediLens lets them point an Android phone at a medicine package, then:

1. reads the printed label (Meta Muse Spark vision, structured output),
2. checks what it read against the Philippine FDA product registry,
3. speaks a clear, ordered summary aloud, and
4. answers follow-up questions **only from what is printed on the label or found in the registry**.

It is an **accessibility reader**, not a medical advisor. Its value is that it never sounds more certain than the evidence: every field carries a legibility flag and a verification status, and the app says "I can't read this clearly" rather than guess.

### Why now
Entry for the **Meta Global AI Developer Hackathon**, Indie track. Hard deadline **Nov 4 2026, 9:00 PM ET = Nov 5, 10:00 AM Manila**. Judging: Impact 30%, Use of Meta AI tooling 25%, Technical depth 20%, Demo 25% (VERIFIED in Official Rules). Theme fit: "Build for Your World".

### Success looks like
- A live, working scan → read → verify → speak flow on a physical Android phone, in a ≤3-minute video.
- Every one of the 8 demo scenarios (§7) behaves safely and visibly differently.
- No moment in the demo where the app states an unverified fact as verified.

## 2. Goals, non-goals, anti-goals

**Goals**
- G1. Capture or pick a photo; reject blurry, dark, or glare-heavy images with a specific spoken reason and retake prompt.
- G2. Extract label fields with per-field legibility and verbatim evidence; keep raw text.
- G3. Verify against the PH FDA registry with explicit statuses (§5.4); show source, URL, checked time, matched and conflicting fields.
- G4. Speak a deterministic, ordered summary; chunked playback with pause, resume, repeat, stop, and rate control.
- G5. Grounded typed Q&A over the scan's evidence, with a safety gate that refuses clinical questions and redirects to a pharmacist.
- G6. Deterministic demo mode (no API keys, no network to Meta/FDA) covering all 8 scenarios, every screen labelled **DEMO DATA**.
- G7. Accessibility: TalkBack labels, large targets (≥48dp), font scaling, high-contrast theme, status announcements.

**Non-goals (MVP)**
- Meta glasses integration (roadmap slide only; see §8).
- Voice input (stretch S1 only if time allows — never claimed unless shipped).
- Filipino/Tagalog output (English only).
- User accounts, scan history, cloud storage of photos.
- On-device OCR, offline mode.
- iOS.

**Anti-goals — failure even if it "works"**
- Reading back a strength, dose, or instruction as certain when the model marked it partial/unreadable or the registry conflicts.
- Any single green "verified" that hides partial/ambiguous/conflicting states.
- Identifying a loose pill from appearance.
- Diagnosing, prescribing, dose calculation, or "is this safe for me" answers.
- Calling a product "fake" or "counterfeit". (We may say "FDA has issued an advisory about counterfeit versions of this product; check with your pharmacist.")
- Reading the registry `expiry_date` as the medicine's expiry. It is the **registration certificate** expiry.
- Presenting a mocked response as a real external verification.
- An API key in the app bundle or the repo.
- Looking like a generic image-to-chatbot wrapper.

## 3. Constraints

- **Time:** ~9 days. Feature freeze Nov 3. First EAS APK by Nov 2.
- **Machine:** Windows, Node 24.21, no Java/Android SDK/Docker. Mobile dev via Expo Go on the owner's physical Android phone; demo build via EAS cloud (free tier: 15 Android builds/month).
- **Repo:** new public repo, all commits from Oct 26 onward (strictest reading of unverified Discord rules).
- **Meta tooling:** Meta Model API at `https://api.meta.ai/v1` (OpenAI-SDK compatible), model `muse-spark-1.3` **Standard** mode only. Every response's `model` field is checked; a `*contributor*` model aborts the request (ToS §1 routing caveat). Hidden reasoning counts toward `max_tokens`; `reasoning_effort: "none"` is rejected.
- **Privacy:** no persistent storage of photos or extracted text. Images processed in memory; nothing written to disk. Results held in an in-memory TTL store (15 min) only so follow-up calls work.
- **Safety policy:** Meta acceptable-use policy forbids unlicensed practice of medicine and reliance on outputs for health decisions without qualified review → app is framed as a label reader with a spoken first-run disclaimer.
- **PH FDA endpoint:** `GET https://verification.fda.gov.ph/api/search?q=<term>` — undocumented, rate-limit header 15, honest `User-Agent: MediLensAI/0.1 (+repo URL)`, backend-only, ≤2 lookups per scan, 24h cache, 5s timeout. Owner to request permission post-hackathon.
- **Eligibility risk:** owner unsure whether the "government-affiliated" exclusion applies. Owner obtains written confirmation from Cerebral Valley before submission. Build proceeds regardless.

## 4. Architecture

npm-workspaces monorepo (my call — shared contracts between app and server without publishing):

```
medilens-ai/
  packages/contracts/   Zod schemas + inferred TS types shared by app and server
  apps/server/          Node 24, TypeScript strict, Express 5
  apps/mobile/          Expo SDK 58, React Native 0.88, expo-router, TypeScript strict
  docs/                 spec, plan, research, required project docs
```

### 4.1 Server pipeline (one synchronous request)

```
POST /api/v1/labels/analyze (multipart, 1–3 images)
  1. validate     size ≤ 8 MB each, type by magic bytes (JPEG/PNG/WebP) via sharp metadata
  2. normalize    sharp: auto-rotate, resize to max 2048 px long edge, JPEG q85
  3. quality      sharpness (Laplacian std-dev), mean luminance, glare fraction (near-white pixel %) → QualityReport
                  fail ⇒ status LABEL_UNREADABLE with reasons; no model call
  4. read         LabelReader adapter → ExtractedLabel (+ imageKind: label | loose_pill | not_medicine | unreadable)
  5. normalize    deterministic parsers: strength ("500mg" → {amount:500, unit:"mg"}), registration number, dates
  6. lookup       ReferenceProvider adapter → candidates (or UNAVAILABLE)
  7. match        pure deterministic matcher → MatchAssessment
  8. summarize    deterministic template → Explanation (display text + spoken chunks)
  9. store        TTL store (15 min, in memory) → returns AnalysisResult with id
```

Model output is **never** authoritative about medication facts. The model only transcribes. The matcher and summary are deterministic code.

### 4.2 Provider adapters (all behind interfaces; selected by env)

| Interface | Real | Demo |
|---|---|---|
| `LabelReader.read(images) → ReadResult` | `MuseSparkLabelReader` (json_schema response_format, transcribe-only prompt, validate with Zod, one retry on invalid JSON, contributor-model guard) | `FixtureLabelReader` keyed by scenario id |
| `ReferenceProvider.search(query) → ReferenceSearchResult` | `PhFdaReferenceProvider` (timeout, cache, UA, rate-limit aware, maps `cdrr` records; surfaces `fdawebsite` advisories) | `FixtureReferenceProvider` |
| `QuestionAnswerer.answer(evidence, question) → Answer` | `MuseSparkAnswerer` (evidence-only prompt, must cite field keys; uncited answer ⇒ fallback refusal) | `FixtureAnswerer` |
| `GlassesBridge` | **not built** — roadmap only. Amended (final review): no `GlassesBridge` interface or `UnavailableGlassesBridge` stub exists in the code; glasses appear only on the roadmap slide | — |

`PROVIDER_MODE=live|demo` governs **only** `/labels/analyze` and `/labels/:id/explain` for scanned results. `/demo/*` endpoints are always available and always use fixture providers, so one deployed backend serves both the 8 scenarios and live scans (my call; result `isDemo` decides which answerer handles `/explain`). Live mode without `MODEL_API_KEY` fails fast at startup (env validated with Zod). Demo mode needs no keys. RxNav spelling correction for generic names is optional (`RXNAV_ENABLED`, default off) — my call, cut first if time is short.

### 4.3 Safety gate for questions (deterministic first, then model)

1. Deterministic classifier (patterns) catches: dose for a person ("how much should I take", weight/age dosing), start/stop/switch, diagnosis/symptoms, pregnancy/child suitability, interactions with other drugs, "is it safe for me", pill identification by appearance. ⇒ `UNSUPPORTED_REQUEST` with fixed refusal + pharmacist redirect.
2. Allowed intents: read label, explain a printed warning/instruction in simpler words, what strength is printed, which parts were unclear, what the registry says.
3. Model answer must reference only evidence field keys present in the scan; server rejects answers that cite unknown keys or none.
4. Any answer about a field whose legibility ≠ `clear` must include the uncertainty sentence.

### 4.4 Mobile app

- expo-router, screens (§6). State: React context + reducer; settings persisted with AsyncStorage (in Expo Go).
- Camera: `expo-camera` `CameraView` with torch toggle; `takePictureAsync({quality: 0.9})`; resize via `expo-image-manipulator` to at most 2048 px on the long edge; gallery fallback `expo-image-picker`.
- Speech: `SpeechQueue` pure-TS module over an injected engine (`expo-speech` in app, fake in tests). Chunks ≤ `Speech.maxSpeechInputLength`; pause = stop + remember chunk index; resume = restart chunk; repeat; rate 0.5–1.5.
- `AccessibilityInfo.announceForAccessibility` for state changes; all controls have `accessibilityLabel`/`accessibilityRole`; ≥48dp targets; respects font scale; high-contrast theme.
- Backend URL from `EXPO_PUBLIC_API_BASE_URL` (not a secret). No keys in the app.

## 5. Contracts

### 5.1 Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{status, version, providerMode}` |
| POST | `/api/v1/labels/analyze` | multipart `images[]` (1–3) → `AnalysisResult` |
| GET | `/api/v1/labels/:id` | stored `AnalysisResult` (404 after TTL) |
| POST | `/api/v1/labels/:id/explain` | `{question: string ≤ 300 chars}` → `Answer` |
| GET | `/api/v1/references/:id` | reference candidates + metadata for a stored analysis |
| GET | `/api/v1/demo/scenarios` | list scenario ids + titles (always on, fixture providers) |
| POST | `/api/v1/demo/scenario` | `{scenarioId}` → `AnalysisResult` through the real pipeline with demo providers, **steps 4–8 only**: stages 1–3 are skipped and `quality` is fixture-supplied, `isDemo: true` |

**Public live access (owner decision):** anyone with the APK may scan live during judging. Spend is capped by a server-side daily budget: each Muse Spark call's `usage` (input, output incl. reasoning) is priced at $1.25 / $4.25 per 1M tokens and summed per UTC day; when `DAILY_SPEND_CAP_USD` (default 5, my call — owner may change) is reached, live `/analyze` and `/explain` return `503 LIVE_BUDGET_EXHAUSTED` with a spoken message suggesting Demo Mode. Demo endpoints stay available. Requires a stable always-on HTTPS host (choice pending).

Rate limit: 30 req/min/IP on API routes (express-rate-limit, in memory). Request ids on every response. Logs are structured JSON with image bytes, raw text, and questions redacted.

### 5.2 Error codes
`INVALID_IMAGE, IMAGE_TOO_LARGE, LIVE_BUDGET_EXHAUSTED, LABEL_UNREADABLE, OCR_FAILED, REFERENCE_UNAVAILABLE, NO_RELIABLE_MATCH, CONFLICTING_MATCH, UNSUPPORTED_REQUEST, RATE_LIMITED, NOT_FOUND, VALIDATION_FAILED, INTERNAL_ERROR`. Body: `{error: {code, message, requestId}}`. No stack traces.

Note: `LABEL_UNREADABLE`, `NO_RELIABLE_MATCH`, `CONFLICTING_MATCH`, `REFERENCE_UNAVAILABLE` are normally **states inside a 200 `AnalysisResult`**, not HTTP errors — the user still gets whatever was read. They are HTTP errors only where no result can be produced.

### 5.3 Core types (Zod in `packages/contracts`)

- `Legibility = "clear" | "partial" | "unreadable"`
- `LabelField = {key, value: string|null, legibility, evidenceText: string|null, imageIndex: number|null, notes: string|null}`
  keys: `brandName, genericNames, strength, dosageForm, manufacturer, registrationNumber, directions, warnings, storage, expiryDate, batchNumber, rxOrOtc`
- `ExtractedLabel = {imageKind, fields: LabelField[], rawText, warnings: string[]}` — absent fields have `value: null`, never invented.
- `QualityReport = {ok, sharpness, luminance, glareFraction, reasons: ("BLURRY"|"TOO_DARK"|"GLARE")[]}`
- `ReferenceRecord = {provider, sourceUrl, registrationNumber, brandName, genericName, strengthForm, manufacturer, classification, registrationExpiry, checkedAt}`
- `MatchStatus = "verified" | "partial" | "conflicting" | "ambiguous" | "no_match" | "unavailable" | "not_attempted"`
- `MatchAssessment = {status, matched: FieldKey[], conflicting: {key, labelValue, referenceValue}[], missing: FieldKey[], candidates: ReferenceRecord[], advisories: {title, url}[], limitations: string[]}`
- `Explanation = {displayText, spokenChunks: string[], safetyNotices: string[], supportingFields: FieldKey[]}`
- `AnalysisResult = {id, isDemo, createdAt, expiresAt, pipelineState, quality, label, match, explanation, imageRetention: "none"}`
- `PipelineState = "label_unreadable" | "not_a_label" | "loose_pill" | "text_extracted" | "explanation_ready"` (+ match status gives the verification state)
- `Answer = {status: "answered"|"refused"|"unclear", text, spokenChunks, citedFields: FieldKey[], safetyNotice: string|null}`

### 5.4 Matcher rules (deterministic)

1. Registration number read `clear` and found exactly → candidate set = that record.
2. Else search by brand (then generic) name; candidates compared on brand, generic, strength (numeric amount+unit), dosage form.
3. `verified` (my call, strict): registration number `clear` and matches **and** brand `clear` and matches **and** strength `clear` and matches **and** no field conflicts. Dosage form must match when both sides state it; if the registry text has no comparable form it goes to `missing` and does not block `verified`. Anything less → at most `partial`.
4. `partial`: no conflicts, and either (a) brand-or-generic **plus** strength matched with `clear` legibility, or (b) registration number `clear` and matched exactly **plus** brand-or-generic matched (identity established; an unclear strength is then spoken as unclear). Less than that → `no_match` (if no candidate fits) or `ambiguous`. *(Amended 2026-10-27, controller ruling during Task 4.)*
5. A candidate "fits" when brand or generic name matches and it has no conflicting field.
6. `conflicting`: any compared field disagrees (e.g. label 500 mg, record 250 mg) — conflict listed, strength spoken with a warning. Conflict outranks every other status.
7. `ambiguous`: >1 candidate fits with equal matched-field count → list them, choose none.
8. `no_match`: none fits. Spoken as "No matching registration found. This does not mean the product is fake. Ask your pharmacist."
9. `unavailable`: provider timeout/error/non-JSON body. Spoken as "I couldn't check the FDA registry right now."
10. Fields with legibility ≠ clear never count as matched; they go to `missing`.
11. FDA advisories are a separate flag (`advisories[]`), never folded into the status. When present, the badge for *any* status shows an amber "FDA advisory" marker next to it and the spoken advisory sentence plays — `verified` is never shown as plain green when an advisory exists.

### 5.5 Spoken summary order (deterministic template)
DEMO DATA notice (demo only) → product name + strength + form (with "unclear" markers) → verification status sentence → registry advisory sentence if any → directions as printed → warnings as printed → expiry as printed on pack → unclear-fields sentence → "Confirm with your pharmacist or doctor."
Loose pill: "This looks like a loose tablet. I can't identify a medicine from how it looks. Please ask a pharmacist." No fields read.

## 6. Screens

1. Welcome / first-run disclaimer (spoken once)
2. Home: Scan medicine · Read existing photo · Demo mode · Settings
3. Camera (torch, capture, up to 3 shots of different sides)
4. Preview / quality check with retake
5. Analysis progress (announced states)
6. Results — summary card with status badge (distinct colour + icon + text per status), speech controls
7. Label fields (each with legibility chip and evidence text)
8. Verification & sources (candidates, matched/conflicting fields, URL, checked time, limitations)
9. Ask a question (typed; preset question buttons)
10. Safety & limitations
11. Settings: speech rate, high contrast, text size, privacy statement, provider mode display
12. Demo scenario picker (DEMO DATA banner)

## 7. Demo scenarios (fixtures, synthetic, labelled DEMO DATA)

| # | Scenario | Expected outcome |
|---|---|---|
| 1 | Clear package, reg no. matches | `verified`, full summary |
| 2 | Blurry/glare | `label_unreadable`, reasons BLURRY/GLARE, retake prompt |
| 3 | Two similar products | `ambiguous`, both candidates listed, none chosen |
| 4 | Label strength 500 mg vs record 250 mg | `conflicting`, strength read with warning |
| 5 | Unknown product | `no_match`, "does not mean fake" sentence |
| 6 | Loose pill | `loose_pill`, no identification |
| 7 | "How many should I take for my headache?" | `refused`, pharmacist redirect |
| 8 | Registry unavailable | `unavailable`, label still read, marked unverified |

Fixture product names are fictional (e.g. "Paracelin 500") to avoid implying real-product verification. Live-mode demo uses a real pack the owner owns.

## 8. Meta integration — honest scope

- **Real:** Muse Spark 1.3 (vision transcription with JSON schema; grounded Q&A). Shown live.
- **Stretch S1 (real):** Muse Voice Transcribe for spoken questions, only if `expo-audio` can produce WAV/PCM in Expo Go on the owner's phone.
- **Stretch S2:** multi-image (up to 3 sides of a box) in one Muse Spark request — already in the contract; prompt merges sides.
- **Not built:** glasses (Wearables Device Access Toolkit is native-only, not fully available in the Philippines, apps unpublishable). Roadmap slide only: no `GlassesBridge` interface or stub was built (amended in the final review). No footage implies glasses.

## 9. Testing

- `packages/contracts`, `apps/server`: Vitest + supertest. Unit: strength/registration parsers, quality thresholds, matcher (every status + legibility rule), safety classifier (refuse/allow tables), summary template, contributor-model guard, Muse Spark adapter against recorded synthetic responses (no network), PH FDA mapper against a saved synthetic response. Integration: analyze → explain over HTTP in demo mode for all 8 scenarios; oversized/unsupported/malformed uploads; rate limit; no files written to disk during analyze.
- `apps/mobile`: jest-expo + @testing-library/react-native: SpeechQueue (pause/resume/repeat), status badge per MatchStatus, results screen renders uncertainty, accessibility labels present.
- Manual: physical-phone checklist with TalkBack on (documented separately from automated tests; no emulator available).
- Live smoke: one scripted call to Muse Spark and PH FDA, run manually with keys, output recorded in TEST_PLAN.md — never in CI.
- **Accuracy eval (owner decision):** owner photographs 20 real packs by Oct 31 and writes ground truth (brand, generic, strength, form, registration no., expiry) per pack. An eval script runs the live reader and reports per-field accuracy and every "confidently wrong" case (value wrong while legibility `clear`). **Bar: zero confidently-wrong strengths or expiry dates.** If missed, prompts/thresholds are tuned; if still missed, the video shows live mode only with that caveat stated. Photos stay on the owner's machine in a git-ignored folder; only aggregate results are committed.

## 10. Deliverable docs
README, PROJECT_PLAN, ARCHITECTURE (with diagram), API_SPEC, SAFETY_AND_PRIVACY, TEST_PLAN, DEMO_SCRIPT (≤3 min), HACKATHON_CHECKLIST, LICENSE (MIT — my call), `.env.example`.

## 11. Decided by owner
- Indie track; English only; Meta Model API (Muse Spark) as the AI provider (owner's key already works); Android phone available, no glasses; new repo at `G:\_gnox\_METAPROJECT\medilens-ai`.
- Public live access during judging with a daily spend cap; 20-pack accuracy eval by Oct 31 with a zero-confidently-wrong bar for strength and expiry.
- Stack defaults from the brief: Expo + TypeScript app, Node + Express + Zod backend, mocks so no paid service is needed for development.

## 12. My calls (owner may override)
- Monorepo with npm workspaces; Vitest for server/contracts, jest-expo for mobile.
- Synchronous analyze (no job queue); in-memory 15-min TTL store; no disk writes.
- Deterministic summary template; model only transcribes and answers grounded questions.
- PH FDA endpoint used in live mode with honest UA, cache, timeout.
- RxNav optional and off by default; openFDA not used (US data would mislead for PH brands).
- Fictional product names in fixtures.
- MIT license.
- Express-rate-limit in memory; no Redis, no Docker.

## 13. Left to the builder
Exact quality thresholds (calibrate on owner's photos; start sharpness ≥ 12, luminance 40–235, glare ≤ 0.08), visual design details, component structure, prompt wording (within §4.3/§5.5 rules), hosting choice for the demo APK backend (owner decision pending; LAN during development).
