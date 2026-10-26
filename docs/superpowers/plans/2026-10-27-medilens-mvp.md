# MediLens AI MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working scan → read → verify → speak → ask flow on Android (Expo Go), backed by an Express server with real Meta Muse Spark + PH FDA adapters and a deterministic demo mode covering 8 scenarios.

**Architecture:** npm-workspaces monorepo. `packages/contracts` holds Zod schemas shared by `apps/server` (Express 5 pipeline: validate → normalize → quality → read → parse → lookup → match → summarize → TTL store) and `apps/mobile` (Expo SDK 58, expo-router). Model output only transcribes; matching and summaries are deterministic code.

**Tech Stack:** Node 24, TypeScript strict, Zod 4, Express 5, multer 2 (memory storage), sharp, openai SDK (baseURL `https://api.meta.ai/v1`), express-rate-limit, pino, Vitest + supertest; Expo SDK 58 (RN 0.88), expo-router, expo-camera, expo-image-picker, expo-image-manipulator, expo-speech, @react-native-async-storage/async-storage, jest-expo + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-10-27-medilens-design.md`

## Global Constraints

- Deadline Nov 4 2026 21:00 ET; feature freeze Nov 3; first EAS APK Nov 2.
- Model id `muse-spark-1.3` only; abort if response `model` contains `contributor`.
- `reasoning_effort: "low"`, `max_tokens: 4000` on Muse Spark calls; never `"none"`.
- Upload: 1–3 images, ≤ 8 MB each, JPEG/PNG/WebP by magic bytes. Nothing written to disk.
- TTL store 15 min. Rate limit 30 req/min/IP on `/api/*`.
- PH FDA: `GET https://verification.fda.gov.ph/api/search?q=`, `User-Agent: MediLensAI/0.1 (+https://github.com/<owner>/medilens-ai)`, timeout 5000 ms, cache 24 h, ≤ 2 lookups per scan.
- Registry `expiry_date` is registration-certificate expiry; never spoken as product expiry.
- Never output the words "fake" or "counterfeit" about the user's pack except inside the fixed advisory sentence: "The FDA has issued an advisory about counterfeit versions of this product. Check with your pharmacist."
- Every demo response `isDemo: true`; every demo screen shows "DEMO DATA".
- No API keys in `apps/mobile`. `.env` git-ignored.
- English only. Final spoken line of every summary: "Confirm with your pharmacist or doctor."
- Error body `{error: {code, message, requestId}}`; never stack traces.

## Review Focus

1. A Muse Spark reply truncated by hidden reasoning (invalid JSON) → one retry, then `OCR_FAILED`, never a partial guess. Test in Task 7.
2. Label strength read `partial` but registry has a value → must not be "matched"; spoken with "unclear". Test in Task 4.
3. Safety-classifier bypass by rephrasing ("my mom is 70kg, how many tablets") → refused. Test in Task 5.
4. PH FDA returns 200 with HTML or empty body (block page) → `unavailable`, not `no_match`. Test in Task 8.
5. User submits a photo of something that is not medicine (`not_medicine`) → no lookup, clear spoken message. Test in Task 9.

---

### Task 1: Monorepo scaffold + contracts

**Files:**
- Create: `package.json` (workspaces `packages/*`, `apps/*`; scripts `test`, `typecheck`, `lint`), `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`), `.gitignore`, `.prettierrc`, `eslint.config.js`, `.env.example`, `LICENSE` (MIT)
- Create: `packages/contracts/package.json` (name `@medilens/contracts`, `main: src/index.ts`), `packages/contracts/src/index.ts`, `src/label.ts`, `src/match.ts`, `src/analysis.ts`, `src/errors.ts`, `src/answer.ts`
- Test: `packages/contracts/test/schemas.test.ts`

**Interfaces — Produces** (all `export const XSchema = z...; export type X = z.infer<typeof XSchema>`):
- `FieldKey` enum: `brandName genericNames strength dosageForm manufacturer registrationNumber directions warnings storage expiryDate batchNumber rxOrOtc`
- `Legibility`, `LabelField`, `ImageKind` (`label | loose_pill | not_medicine | unreadable`), `ExtractedLabel`, `QualityReason`, `QualityReport`, `ReferenceRecord`, `MatchStatus`, `MatchAssessment`, `Explanation`, `PipelineState`, `AnalysisResult`, `Answer`, `ErrorCode`, `ErrorBody`, `ExplainRequest` (`question` 1–300 chars, trimmed), `DemoScenarioRequest`, `DemoScenarioSummary` — shapes exactly as spec §5.3.

- [ ] **Step 1: Write failing tests**
```ts
test('LabelField allows null value but not missing key', () => {
  expect(LabelFieldSchema.safeParse({ key: 'strength', value: null, legibility: 'unreadable', evidenceText: null, imageIndex: null, notes: null }).success).toBe(true);
  expect(LabelFieldSchema.safeParse({ value: '500 mg', legibility: 'clear' }).success).toBe(false);
});
test('ExplainRequest rejects >300 chars and empty', () => {
  expect(ExplainRequestSchema.safeParse({ question: 'x'.repeat(301) }).success).toBe(false);
  expect(ExplainRequestSchema.safeParse({ question: '   ' }).success).toBe(false);
});
test('MatchStatus has exactly the 7 spec values', () => {
  expect(MatchStatusSchema.options).toEqual(['verified','partial','conflicting','ambiguous','no_match','unavailable','not_attempted']);
});
test('AnalysisResult imageRetention is literal none', () => { /* parse fixture with 'none' ok, 'temp' fails */ });
```
- [ ] **Step 2:** `npm install` at root, then `npx vitest run packages/contracts` → FAIL (module not found).
- [ ] **Step 3:** Implement schemas.
- [ ] **Step 4:** `npx vitest run packages/contracts` → PASS; `npm run typecheck` clean.
- [ ] **Step 5:** Commit `feat(contracts): shared zod schemas for label analysis`.

### Task 2: Label parsers

**Files:** Create `apps/server/package.json` (`@medilens/server`, type module), `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`, `apps/server/src/domain/parsers.ts`; Test `apps/server/test/domain/parsers.test.ts`

**Interfaces — Produces:**
- `parseStrength(s: string): { amount: number; unit: 'mg'|'mcg'|'g'|'mL'|'IU'|'%'; per?: { amount: number; unit: string } }[] | null` — handles `500mg`, `500 mg`, `250 mg/5 mL`, `Paracetamol 500mg + Caffeine 65mg`, `1,000 mg`, `0.5%`; `µg`→`mcg`.
- `strengthsEqual(a, b): boolean` — unit-normalized (`1 g` == `1000 mg`).
- `normalizeRegistrationNumber(s: string): string | null` — uppercase, strip spaces, accept `DR-`, `DRP-`, `DRHR-`, `DR-XY` + digits; else null.
- `normalizeName(s: string): string` — lowercase, strip ®™, collapse whitespace, drop dosage-form words.

- [ ] **Step 1: Failing tests** — table tests: `parseStrength('Paracetamol 500mg')` → `[{amount:500,unit:'mg'}]`; `'250 mg/5 mL'` → per `{amount:5,unit:'mL'}`; `'1,000 mg'` → 1000; `'abc'` → null; `strengthsEqual(parse('1 g'), parse('1000mg'))` true, `500mg` vs `250mg` false; `normalizeRegistrationNumber(' dr-xy 39670')` → `'DR-XY39670'`; `'12345'` → null; `normalizeName('Paracelin® 500 Tablet')` → `'paracelin 500'`.
- [ ] **Step 2:** `npx vitest run apps/server/test/domain/parsers.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat(server): strength, registration and name parsers`.

### Task 3: Image validation + quality analyzer

**Files:** Create `apps/server/src/imaging/validate.ts`, `apps/server/src/imaging/quality.ts`, `apps/server/src/config.ts` (thresholds + env, Zod); Test `apps/server/test/imaging/*.test.ts`, helper `apps/server/test/helpers/images.ts` (generate synthetic images with sharp: text-like noise pattern, blurred copy, dark copy, white-blown copy).

**Interfaces — Produces:**
- `validateImage(buf: Buffer): Promise<{ ok: true; format: 'jpeg'|'png'|'webp' } | { ok: false; code: 'INVALID_IMAGE' | 'IMAGE_TOO_LARGE' }>` — size ≤ `MAX_IMAGE_BYTES` (8 MB) checked first; format from `sharp(buf).metadata()`; any sharp throw ⇒ INVALID_IMAGE.
- `normalizeImage(buf: Buffer): Promise<Buffer>` — `.rotate()`, resize inside 2048, JPEG q85.
- `assessQuality(jpeg: Buffer, t = DEFAULT_THRESHOLDS): Promise<QualityReport>` — sharpness = `stats().sharpness` on a fresh greyscale instance; luminance = mean of greyscale channel; glareFraction = fraction of pixels ≥ 250. Thresholds `{ minSharpness: 12, minLuminance: 40, maxLuminance: 235, maxGlare: 0.08 }` (calibrate later; exported).

- [ ] **Step 1: Failing tests:** sharp pattern ok; blurred (`.blur(8)`) → reasons contains `BLURRY`; dark (`.linear(0.1)`) → `TOO_DARK`; 30% white patch → `GLARE`; 9 MB buffer → `IMAGE_TOO_LARGE`; `Buffer.from('GIF89a…')` / text file → `INVALID_IMAGE`; GIF real image → `INVALID_IMAGE`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `feat(server): image validation and quality checks`.

### Task 4: Matcher

**Files:** Create `apps/server/src/domain/matcher.ts`; Test `apps/server/test/domain/matcher.test.ts`

**Interfaces:**
- Consumes: Task 1 types; Task 2 parsers.
- Produces: `assessMatch(label: ExtractedLabel, search: ReferenceSearchResult): MatchAssessment`
- `ReferenceSearchResult = { kind: 'ok'; records: ReferenceRecord[]; advisories: {title:string;url:string}[] } | { kind: 'unavailable'; reason: string } | { kind: 'not_attempted' }` (define in `apps/server/src/providers/types.ts`).

Rules exactly spec §5.4. Comparison fields: brandName ↔ brandName (normalizeName equality or one contains other), genericNames ↔ genericName (set of normalized names), strength ↔ parsed from `strengthForm`, dosageForm ↔ form word in `strengthForm`. Ambiguity: >1 record with equal best score after filtering conflicts.

- [ ] **Step 1: Failing tests** (one per spec §5.4 rule 1–11): exact reg no + brand + strength clear and agree → `verified`; same but strength `partial` → `partial` (not verified); reg no `partial` → `partial`; registry strength-form text with no form word → form in `missing`, still `verified`; brand-only match without strength → `no_match`; conflict + reg-no match → `conflicting`; advisory present on verified record → status `verified` and `advisories.length > 0`; strength 500 vs 250 → `conflicting` with `{key:'strength', labelValue:'500 mg', referenceValue:'250 mg'}`; two equal candidates → `ambiguous` with both in `candidates`; zero → `no_match`; `unavailable` input → `unavailable` + limitation text; strength legibility `partial` and value equal → strength NOT in `matched`; advisories passed through; `limitations` always contains "Registration expiry is not the product's expiry date." when any record shown.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(server): deterministic label-to-registry matcher`.

### Task 5: Safety classifier + summary template

**Files:** Create `apps/server/src/domain/safety.ts`, `apps/server/src/domain/summary.ts`; Tests `test/domain/safety.test.ts`, `test/domain/summary.test.ts`

**Interfaces — Produces:**
- `classifyQuestion(q: string): { allowed: true; intent: 'read_label'|'explain_text'|'strength'|'unclear_parts'|'registry'|'other_label' } | { allowed: false; reason: 'personal_dose'|'start_stop'|'diagnosis'|'special_population'|'interaction'|'personal_safety'|'pill_identification' }`
- `REFUSAL_TEXT: Record<reason, string>` — each ends "Please ask a pharmacist or your doctor."
- `buildSummary(result: { label: ExtractedLabel; match: MatchAssessment; isDemo: boolean; pipelineState: PipelineState }): Explanation` — order spec §5.5; chunks ≤ 400 chars split at sentence boundaries; non-clear field values spoken as "<value>, but this part is unclear".

- [ ] **Step 1: Failing tests:**
  - refuse table (≥ 20 rows): "How many should I take for my headache?", "my mom is 70kg how many tablets", "Can I give this to my 3 year old?", "Is it safe while pregnant?", "Can I take it with ibuprofen?", "Should I stop taking it?", "What is this white round pill?", "Do I have a fever if…", "Is this safe for me?" → each `allowed:false` with expected reason.
  - allow table (≥ 10 rows): "Can you read this label?", "What does this warning mean?", "What strength is printed here?", "Explain the directions in simpler words", "Which parts were unclear?", "What did the FDA registry say?" → `allowed:true`.
  - summary: demo → first chunk starts "Demo data."; last chunk is "Confirm with your pharmacist or doctor."; loose_pill → exact loose-pill sentence and no field values; conflicting strength → contains "does not match the registry"; no_match → contains "does not mean the product is fake"; unavailable → "I couldn't check the FDA registry right now."; registry expiry never appears; every chunk ≤ 400 chars; no chunk contains "fake"/"counterfeit" except the two fixed sentences.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(server): question safety gate and spoken summary`.

### Task 6: Demo fixtures + demo providers

**Files:** Create `apps/server/src/providers/types.ts` (if not in Task 4), `apps/server/src/demo/scenarios.ts`, `apps/server/src/providers/fixture.ts`; Test `test/demo/scenarios.test.ts`

**Interfaces — Produces:**
- `interface LabelReader { read(images: Buffer[], ctx: { scenarioId?: string }): Promise<ReadResult> }`, `ReadResult = { ok: true; label: ExtractedLabel; model: string } | { ok: false; code: 'OCR_FAILED'; detail: string }`
- `interface ReferenceProvider { search(q: { registrationNumber?: string; name?: string }, ctx: { scenarioId?: string }): Promise<ReferenceSearchResult> }`
- `interface QuestionAnswerer { answer(input: { label: ExtractedLabel; match: MatchAssessment; question: string; intent: string }, ctx: { scenarioId?: string }): Promise<Answer> }`
- `DEMO_SCENARIOS: DemoScenario[]` with `{ id: 's1-clear'|'s2-blurry'|'s3-similar'|'s4-conflict'|'s5-nomatch'|'s6-loose-pill'|'s7-unsupported-question'|'s8-registry-down'; title; quality: QualityReport; label: ExtractedLabel; reference: ReferenceSearchResult; presetQuestion?: string; cannedAnswer?: Answer }`
- `FixtureLabelReader`, `FixtureReferenceProvider`, `FixtureAnswerer` implementing interfaces by `ctx.scenarioId`.

Fictional products only ("Paracelin 500", "Paracelin 250", "Paracelin-Forte 500", "Amoxivan 500"); registration numbers `DR-XY900001`… (synthetic range). Every fixture `notes` or title contains "DEMO DATA".

- [ ] **Step 1: Failing test:** for each scenario, `assessMatch(s.label, s.reference).status` equals the expected status table from spec §7 (s1 verified, s3 ambiguous, s4 conflicting, s5 no_match, s8 unavailable); s2 quality.ok false; s6 imageKind loose_pill; s7 `classifyQuestion(presetQuestion).allowed === false`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(server): eight deterministic demo scenarios`.

### Task 7: Muse Spark adapters

**Files:** Create `apps/server/src/providers/museSpark.ts`, `apps/server/src/providers/prompts.ts`; Test `test/providers/museSpark.test.ts`, fixtures `test/fixtures/muse/*.json` (synthetic recorded completions).

**Interfaces:**
- Consumes: `LabelReader`, `QuestionAnswerer` (Task 6).
- Produces: `createMuseSparkLabelReader(client: ChatClient, opts?: { model?: string }): LabelReader`; `createMuseSparkAnswerer(client: ChatClient): QuestionAnswerer`; `type ChatClient = Pick<OpenAI['chat']['completions'], 'create'>`; `createMetaClient(apiKey: string): ChatClient` (`new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey })`).

Reader: system prompt "transcribe only, copy exactly, mark unreadable, never infer, classify imageKind"; images as `data:image/jpeg;base64`; `response_format: { type: 'json_schema', json_schema: { name: 'medicine_label', schema: <JSON schema from z.toJSONSchema(ModelLabelSchema)> , strict: true } }`; validate with Zod; on parse failure or `finish_reason === 'length'` retry once; second failure → `{ok:false, code:'OCR_FAILED'}`. Reject `model` containing `contributor` → OCR_FAILED with detail `contributor_model`.
Answerer: input is the JSON of fields + match (no image); output schema `{ text, citedFields: FieldKey[] }`; post-check: `citedFields` non-empty and ⊆ fields with non-null value, else return `{status:'unclear', text:'I can only answer from what is printed on the label…'}`; if any cited field legibility ≠ clear, append "Part of this was unclear on the label."

- [ ] **Step 1: Failing tests (fake client):** valid JSON → label fields mapped; invalid JSON then valid → success with 2 calls; invalid twice → OCR_FAILED; `finish_reason:'length'` → retry; `model:'muse-spark-1.3-contributor'` → OCR_FAILED; request asserts `model === 'muse-spark-1.3'`, `reasoning_effort === 'low'`, `max_tokens === 4000`, image is data URL; answerer citing unknown field → `unclear`; citing partial field → text includes uncertainty sentence.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(server): muse spark label reader and grounded answerer`.

### Task 8: PH FDA reference provider

**Files:** Create `apps/server/src/providers/phFda.ts`, `apps/server/src/providers/cache.ts` (`TtlCache<K,V>` with injectable clock); Test `test/providers/phFda.test.ts`, fixture `test/fixtures/phfda/search-paracelin.json` (synthetic, same shape as real `cdrr` + `fdawebsite` arrays).

**Interfaces — Produces:** `createPhFdaProvider(deps: { fetch: typeof fetch; now: () => number; userAgent: string; timeoutMs?: number; cacheTtlMs?: number }): ReferenceProvider`; `class TtlCache<K, V> { constructor(ttlMs: number, now: () => number); get(k: K): V | undefined; set(k: K, v: V): void }`.

Query by registration number first, else brand name; map `cdrr` rows → `ReferenceRecord` (`registrationExpiry` from `expiry_date`, `sourceUrl` = `https://verification.fda.gov.ph/` search URL, `checkedAt` ISO); `fdawebsite` rows whose title matches the brand → advisories. Before implementing, fetch one real response manually (`curl -A "MediLensAI/0.1" "https://verification.fda.gov.ph/api/search?q=biogesic"`) to confirm field names; record field names (not data) in a code comment.

- [ ] **Step 1: Failing tests:** maps fixture; sends `User-Agent`; second identical query within TTL makes no fetch; after TTL refetches; timeout (fetch never resolves, fake timers) → `unavailable`; HTTP 403/429/500 → `unavailable`; 200 with HTML body → `unavailable`; 200 with `cdrr: []` → `ok` with zero records; at most 2 fetches per `search` call.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(server): ph fda registry provider with cache and timeout`.

### Task 9: Pipeline orchestrator + result store

**Files:** Create `apps/server/src/pipeline/analyze.ts`, `apps/server/src/pipeline/store.ts`; Test `test/pipeline/analyze.test.ts`

**Interfaces — Produces:**
- `createResultStore(now: () => number, ttlMs = 900_000): { put(r: AnalysisResult): void; get(id: string): AnalysisResult | undefined }`
- `analyzeImages(images: Buffer[], deps: PipelineDeps): Promise<AnalysisResult>`; `analyzeScenario(scenarioId: string, deps: PipelineDeps): Promise<AnalysisResult>` (skips steps 1–3, uses fixture quality, `isDemo: true`)
- `PipelineDeps = { reader: LabelReader; references: ReferenceProvider; store; now; newId: () => string; isDemo: boolean }`
- Throws `PipelineError(code: ErrorCode)` for whole-request failures (`INVALID_IMAGE`, `IMAGE_TOO_LARGE`, `OCR_FAILED`).

Branches: quality fail → `pipelineState:'label_unreadable'`, match `not_attempted`, no reader call. `imageKind` loose_pill / not_medicine / unreadable → no lookup, matching state. Otherwise lookup → match → summary → `explanation_ready`.

- [ ] **Step 1: Failing tests (stub deps with call counters):** blurry → reader not called; loose_pill → references not called, summary loose-pill text; not_medicine → references not called, summary "I couldn't find a medicine label in this photo."; happy path stored and retrievable; get after 15 min → undefined; `imageRetention === 'none'`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(server): analysis pipeline and ttl result store`.

### Task 10: HTTP API

**Files:** Create `apps/server/src/app.ts` (`createApp(deps): Express`), `apps/server/src/server.ts` (env → deps → listen), `apps/server/src/http/errors.ts`, `apps/server/src/http/logger.ts`, `apps/server/src/routes/{health,labels,references,demo}.ts`; Test `test/http/*.test.ts` (supertest).

**Interfaces — Produces:** routes per spec §5.1. Env (Zod, `config.ts`): `PORT=8787`, `PROVIDER_MODE=demo|live` (default demo), `MODEL_API_KEY` (required iff live), `PUBLIC_REPO_URL`, `CORS_ORIGIN` optional. Multer `memoryStorage`, `limits: { fileSize: 8 MB, files: 3 }`, field `images`. pino with `redact: ['req.headers.authorization', '*.rawText', '*.question', '*.evidenceText']`; never log bodies.

Also create `apps/server/src/pipeline/budget.ts`: `createSpendMeter(capUsd: number, now: () => number): { record(usage: { prompt_tokens: number; completion_tokens: number }): void; exhausted(): boolean; spentUsd(): number }` — prices $1.25/1M input, $4.25/1M output (completion includes reasoning), resets at UTC midnight. Env `DAILY_SPEND_CAP_USD` (default 5). Muse Spark adapters (Task 7) accept an optional `onUsage` callback wired to the meter here.

- [ ] **Step 1: Failing tests:** spend meter: 1M input + 1M output = $5.50; resets after UTC midnight with fake clock; live analyze when exhausted → 503 `LIVE_BUDGET_EXHAUSTED` while `/demo/scenario` still 200; `/health` 200 `{status:'ok', providerMode:'demo'}`; analyze with no file → 400 `VALIDATION_FAILED`; 9 MB → 413 `IMAGE_TOO_LARGE`; 4 files → 400; text file → 415 `INVALID_IMAGE`; demo scenario for each of 8 ids → 200 with expected `match.status`/`pipelineState`, `isDemo:true` — in both `PROVIDER_MODE=demo` and `live` (live with stub providers, asserting stubs not called); explain with s7 preset → `status:'refused'`; explain allowed question on s1 → `answered` with cited fields; explain unknown id → 404 `NOT_FOUND`; 31st request in a minute → 429 `RATE_LIMITED`; error bodies never contain `stack` or `at `; `vi.spyOn(fs, 'writeFile'|'writeFileSync'|'createWriteStream')` not called during analyze; live mode without key → `loadConfig` throws.
- [ ] **Step 2–4:** FAIL → implement → PASS; also `npm run typecheck`, `npm run lint`.
- [ ] **Step 5:** Commit `feat(server): http api with validation, rate limit and redacted logs`.

### Task 11: Mobile scaffold, API client, settings, theme

**Files:** Create `apps/mobile` via `npx create-expo-app@latest apps/mobile --template blank-typescript` then `npx expo install expo-router expo-camera expo-image-picker expo-image-manipulator expo-speech @react-native-async-storage/async-storage expo-constants react-native-safe-area-context react-native-screens`; `apps/mobile/app.json` (scheme, android permissions CAMERA), `metro.config.js` (workspace), `src/api/client.ts`, `src/state/settings.tsx`, `src/theme/theme.ts`; Test `apps/mobile/test/api/client.test.ts`.

**Interfaces — Produces:**
- `createApiClient(baseUrl: string, fetchImpl = fetch): { health(); analyze(images: {uri: string; type: string}[]): Promise<AnalysisResult>; scenario(id): Promise<AnalysisResult>; scenarios(): Promise<DemoScenarioSummary[]>; explain(id, question): Promise<Answer>; references(id) }` — parses every response with contracts schemas; non-2xx → throws `ApiError { code: ErrorCode; message }`; network failure → `ApiError('NETWORK', …)`.
- `SettingsProvider`, `useSettings(): { speechRate: number; highContrast: boolean; textScale: 1|1.25|1.5; setX… }` persisted in AsyncStorage key `medilens.settings.v1`, all reads/writes try/catch.
- `useTheme(): { colors, statusColors: Record<MatchStatus|'unreadable', {bg, fg, icon, label}> }` with normal + high-contrast palettes (contrast ≥ 7:1 in high contrast).

- [ ] **Step 1: Failing tests:** client parses valid result; invalid shape → throws; 429 body → `ApiError` code `RATE_LIMITED`; fetch rejection → code `NETWORK`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx jest` in apps/mobile). Confirm `npx expo start` boots and the blank app loads in Expo Go on the phone (manual; record result).
- [ ] **Step 5:** Commit `feat(mobile): expo app scaffold, api client, settings and theme`.

### Task 12: SpeechQueue

**Files:** Create `apps/mobile/src/speech/SpeechQueue.ts`, `apps/mobile/src/speech/useSpeech.ts`; Test `test/speech/SpeechQueue.test.ts`

**Interfaces — Produces:**
- `interface SpeechEngine { speak(text: string, opts: { rate: number; language: 'en-US'; onDone: () => void; onStopped: () => void; onError: (e: unknown) => void }): void; stop(): void }`
- `class SpeechQueue { constructor(engine: SpeechEngine); load(chunks: string[]): void; play(): void; pause(): void; resume(): void; repeat(): void; stop(): void; setRate(r: number): void; readonly state: 'idle'|'playing'|'paused'; readonly index: number; onChange(cb): () => void }`
- `useSpeech()` wraps with `expo-speech` engine.

- [ ] **Step 1: Failing tests (fake engine):** play speaks chunk 0, onDone advances to 1, last onDone → idle; pause calls engine.stop and keeps index; resume re-speaks current chunk; repeat restarts current chunk; stop → idle index 0; rate clamps to 0.5–1.5; load while playing stops first.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(mobile): chunked speech queue with pause and resume`.

### Task 13: Result screens + demo mode

**Files:** Create `apps/mobile/app/_layout.tsx`, `app/index.tsx` (welcome/first-run disclaimer then home), `app/demo.tsx`, `app/result/[id].tsx` (summary + speech controls), `app/result/[id]/fields.tsx`, `app/result/[id]/sources.tsx`, `app/result/[id]/ask.tsx`, `app/safety.tsx`, `app/settings.tsx`, `src/components/{StatusBadge,FieldRow,SpeechControls,DemoBanner,BigButton}.tsx`, `src/state/results.tsx` (in-memory map id → AnalysisResult); Tests `test/components/*.test.tsx`, `test/screens/result.test.tsx`.

**Interfaces — Consumes:** Tasks 11–12. **Produces:** `StatusBadge({status})`, `FieldRow({field})`, `SpeechControls({chunks})`, `DemoBanner()`, `BigButton({label, onPress, accessibilityHint})` (min 56dp height).

- [ ] **Step 1: Failing tests:** `StatusBadge` renders distinct text label for each of 7 statuses + `unreadable` (text, not colour only) and `accessibilityLabel` "Verification: …"; `StatusBadge({status:'verified', hasAdvisory:true})` shows "FDA advisory" marker and not the plain green style; `FieldRow` with `partial` shows "Unclear" chip and evidence text; result screen with `isDemo` shows "DEMO DATA"; s4 result shows conflicting row "500 mg on label, 250 mg in registry"; ask screen shows refusal text for refused answer; every pressable has `accessibilityRole="button"` and a label.
- [ ] **Step 2–4:** FAIL → implement → PASS. Manual: run all 8 scenarios in Expo Go against the dev server on LAN, with TalkBack on; record in TEST_PLAN.
- [ ] **Step 5:** Commit `feat(mobile): result, sources, ask, safety, settings and demo screens`.

### Task 14: Camera, preview, upload

**Files:** Create `app/scan.tsx` (CameraView, torch toggle, capture up to 3, permission states), `app/preview.tsx` (thumbnails, retake/remove, Analyze), `app/analyzing.tsx` (progress with announcements), `src/capture/prepare.ts` (`prepareImage(uri): Promise<{uri; type:'image/jpeg'}>` via `ImageManipulator.manipulate(uri).resize({width: 2048})` → `renderAsync()` → `saveAsync({format: SaveFormat.JPEG, compress: 0.85})`); gallery fallback on home ("Read existing photo") with `expo-image-picker`; Test `test/screens/scan.test.tsx` (permission denied state renders "Camera access is off" + Open settings button; camera unavailable state).

- [ ] **Step 1–4:** failing permission-state tests → implement → PASS. Manual on phone: capture a real pack in live mode against LAN server with `PROVIDER_MODE=live`; record outcome.
- [ ] **Step 5:** Commit `feat(mobile): camera capture, preview and upload`.

### Task 15: Live smoke + EAS + docs

**Files:** Create `apps/server/scripts/smoke-live.ts` (one Muse Spark call on a provided image path and one PH FDA lookup; prints model id, status, token usage incl. `reasoning_tokens`, no raw text), `apps/mobile/eas.json` (`preview.android.buildType: "apk"`), docs: `README.md`, `docs/PROJECT_PLAN.md`, `docs/ARCHITECTURE.md` (mermaid diagram), `docs/API_SPEC.md`, `docs/SAFETY_AND_PRIVACY.md`, `docs/TEST_PLAN.md` (automated + manual device + live smoke results), `docs/DEMO_SCRIPT.md` (≤3 min, timed), `docs/HACKATHON_CHECKLIST.md` (incl. eligibility confirmation item, credits claim, Discord rules check, repo public, secret scan, video link).
- [ ] **Step 1:** Run `npm test`, `npm run typecheck`, `npm run lint` at root; paste summaries into TEST_PLAN.
- [ ] **Step 2:** Owner runs smoke with key: `npx tsx apps/server/scripts/smoke-live.ts <image>`; record result (or "NOT RUN — no key yet").
- [ ] **Step 3:** Write docs; every mocked/simulated capability labelled; glasses = roadmap.
- [ ] **Step 4:** Secret scan: `git grep -nE "(sk-|MODEL_API_KEY=.+)"` returns nothing outside `.env.example`.
- [ ] **Step 5:** Commit `docs: project documentation and hackathon checklist`.

### Task 16: Accuracy eval harness

**Files:** Create `apps/server/scripts/eval-labels.ts`, `apps/server/src/eval/score.ts`, `eval/README.md` (how the owner adds packs), `.gitignore` entry `eval/packs/`; Test `apps/server/test/eval/score.test.ts`.

**Interfaces — Produces:** `scoreLabel(truth: GroundTruth, label: ExtractedLabel): { field: FieldKey; correct: boolean; legibility: Legibility; confidentlyWrong: boolean }[]`; `GroundTruth = { packId: string; images: string[]; brandName: string; genericNames: string[]; strength: string; dosageForm: string; registrationNumber: string | null; expiryDate: string | null }` (Zod, in `eval/packs/<id>/truth.json`). Strength compared with `strengthsEqual`; reg no via `normalizeRegistrationNumber`; expiry compared as month+year. `confidentlyWrong = !correct && legibility === 'clear'`.

- [ ] **Step 1: Failing tests:** wrong strength marked clear → `confidentlyWrong`; wrong strength marked partial → not confidently wrong; `1 g` vs `1000 mg` correct; expiry `EXP 03/2027` vs `2027-03` correct.
- [ ] **Step 2–4:** FAIL → implement → PASS. Script prints a per-field table and lists every confidently-wrong case; writes only aggregate counts to `docs/eval-results.md`.
- [ ] **Step 5:** Commit `feat(eval): label accuracy harness`. Owner runs on 20 packs by Oct 31.

Post-plan (owner-gated, not tasks): backend hosting choice, `eas build --profile preview`, public GitHub repo creation, video recording, submission.
