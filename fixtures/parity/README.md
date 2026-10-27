# Parity corpora

Golden cases recorded from the Node build (`apps/server`; tag `node-fallback-v1`). The Go port must reproduce every one of them exactly (Go port spec §6). They are generated files: do not edit them by hand. Re-record instead.

## Re-recording

```
npm run parity:record
```

`scripts/parity/record.ts` runs `scripts/parity/vitest.config.ts`:

- the whole server vitest suite (`apps/server/test/**/*.test.ts`);
- the recorder's own tests (`scripts/parity/*.test.ts`);
- the extra probe corpora (`scripts/parity/probes.parity.ts`).

The setup file `scripts/parity/setup.ts` replaces each domain module (`apps/server/src/domain/{parsers,matcher,safety,summary,answers}.ts`) with a copy whose exported functions record every call. It is loaded only by this config. The server's own `npm test` never loads it, and no production source changes. Then the script:

1. merges the raw output per corpus;
2. checks that every exported domain function has at least one case and that all 8 scenarios were recorded;
3. prints the counts;
4. fails if any corpus is over 20 MB.

Recording is deterministic. Three consecutive recordings gave byte-identical files.

After the Node server is removed (task G12), re-recording needs `git checkout node-fallback-v1` first (ruling R4).

## Files

| File | Functions |
|---|---|
| `parsers.jsonl` | `parseStrength`, `strengthsEqual`, `normalizeRegistrationNumber`, `normalizeName` |
| `matcher.jsonl` | `assessMatch`, `clearValue` |
| `safety.jsonl` | `classifyQuestion`, `extractExplainPhrase`, `askedFields` |
| `summary.jsonl` | `buildSummary`, `advisorySentence`, `verificationSentences` |
| `answers.jsonl` | `answerFromLabel`, `composeExplainAnswer`, `explanationAllowed`, `findPhraseInFields`, `explainQuote`, `quoteExplainable`, `explanationFits`, `notALabelAnswer`, `unclearAnswer`, `conflictWarning` |
| `scenarios.jsonl` | `POST /api/v1/demo/scenario`: the 8 demo scenarios through the Node app (ruling R3) |

## Line format

There is one JSON object per line, with LF endings (`.gitattributes` marks these files `-text`):

```
{"fn":"parseStrength","args":["500 mg"],"result":[{"amount":500,"unit":"mg"}]}
```

- `fn` is the exported TS function name. For scenarios, it is the route.
- `args` has exactly one entry per declared parameter of the function (its JS `length`):
  - Extra positional arguments are dropped. For example, `labels.map(normalizeName)` also passes `(index, array)`, which the function ignores.
  - A missing trailing argument is recorded as undefined.
  - No exported domain function has default or rest parameters or reads `arguments`, so this changes nothing about the call.
- `result` is the return value.
- Lines are deduplicated on `fn` + `args`. If the same call ever gives two different results, recording fails.
- Lines are sorted by `fn`, then by the `args` JSON text, using plain code-unit order.
- Object key order inside a line is the TS insertion order. Compare values, not text: `parity.Normalize` in Go re-encodes both sides canonically.

### Markers (ruling R8)

JSON has no `undefined` and no non-finite numbers, so the recorder writes markers:

| JS value | Recorded as |
|---|---|
| `undefined` (an argument, an array element or hole, a property present with the value undefined, or a return value) | `{"$undefined":true}` |
| `NaN`, `Infinity`, `-Infinity` | `{"$number":"NaN"}`, `{"$number":"Infinity"}`, `{"$number":"-Infinity"}` |

- A property that is absent stays absent, and `null` stays `null`.
- The recorder refuses anything else JSON cannot carry: functions, bigints, symbols, Maps, Sets, Dates, RegExps, Promises and class instances. It also refuses an object that already uses a marker key.
- In Go, use `parity.IsUndefined(raw)`.
- The current corpora contain no markers. The only JS undefined values seen were absent optional properties, which stay absent.

### Rounded float arguments

sharp's image-quality floats (`sharpness`, `luminance`, `glareFraction`) vary in the last digits from run to run, by about 1e-13. They reach `buildSummary` through the HTTP and pipeline tests.

To keep the corpus stable, every non-integer number in `args` is rounded to 10 significant digits. When rounding changes an argument, the recorded case is not the test's own call: the recorder calls the pure original again with the rounded arguments and records that call's result. Every line is therefore a real TS input/output pair. Results are never rounded.

## Extra probe corpora

These come from `scripts/parity/probes.parity.ts`. All of it is synthetic DEMO DATA.

1. **Matcher fuzz.** Seeded mulberry32, seed `20261028`, 4000 label × registry cases through `assessMatch`.
   - The generator covers:
     - registration numbers with spacing, case, fullwidth and zero-width variants;
     - brand, generic, strength and dosage-form variants, including non-ASCII ones;
     - partial and unreadable fields, duplicated keys, loose-pill and unreadable image kinds;
     - 0 to 3 registry records;
     - `unavailable` and `not_attempted` lookups;
     - neutral and counterfeit advisories, and `advisoriesUnchecked`.
   - Every 4th case also runs `buildSummary`, `verificationSentences` and `clearValue`.
   - Every 8th case also runs `answerFromLabel` with a preset question and its intent.
   - No matcher fuzz generator existed in the repository (the "6,560 cases" in the Node ledger was an uncommitted run), so this one was written for the corpus.
2. **Safety sweep.** The preset questions plus refusal and explain-phrase questions go through `classifyQuestion`, `extractExplainPhrase` and `askedFields`. Each question is also run under these variants:
   - case;
   - fullwidth;
   - NBSP and narrow NBSP;
   - zero-width space and soft hyphen;
   - tabs and newlines;
   - padding;
   - a Cyrillic look-alike;
   - a combining accent;
   - curly quotes;
   - dotted capital I and the Kelvin sign;
   - the fi ligature;
   - a fullwidth question mark;
   - an en dash.

   It also covers the empty, 300-character and 301-character limits. The review-round probe tables in `apps/server/test/domain/safety.test.ts` are recorded through the suite itself.
3. **Parser sweep.** Strengths, names and registration numbers under the same variants, plus `strengthsEqual` over every pair of the plain strengths.
4. **Explanation probes.** `ROUND2_PROBE_CASES` (`apps/server/test/fixtures/explanationProbes.ts`) and some accepted explanations go through:
   - `explanationAllowed`, `explanationFits` and `quoteExplainable`;
   - `composeExplainAnswer` on a label with a partly unclear field and a strength conflict;
   - `findPhraseInFields` and `explainQuote` under phrase variants;
   - `notALabelAnswer` for every image kind.
5. **Scenarios (ruling R3).** Each of the 8 scenario ids is posted to the in-process Node app (supertest, `apps/server/test/http/helpers.ts` `makeApp`). The body is checked against `AnalysisResultSchema`, and then these fields are stripped because they differ per run or per server:
   - `id`;
   - `createdAt`;
   - `expiresAt`.

   Nothing else is stripped. Registry `checkedAt` in the demo fixtures is a constant.

## Go probe data (task G3)

`npx tsx scripts/parity/go-probes.ts` records more reference output from the Node build into the Go packages' `testdata`. These files target the places where JS and Go differ by construction. Like the corpora above, recording is deterministic (seeded, sorted), and after task G12 it needs `git checkout node-fallback-v1` first.

| File | What V8 recorded |
|---|---|
| `internal/jsregex/testdata/v8_probes.jsonl` | Hand-written and seeded random RegExp probes, with the `exec` index and every capture. They check the Go JS-semantics matcher. |
| `internal/domain/testdata/safety_adversarial.jsonl` | `classifyQuestion`, `extractExplainPhrase` and `askedFields` on seeded adversarial variants of every corpus question: casing, confusables, zero-width and format characters, whitespace, punctuation, digits, and long inputs around the 300 code-unit limit. |
| `internal/domain/testdata/safety_regexps.json` | Every flagless RegExp the safety module ran, literal or constructed, with its `test` result on every text any of them saw, plus `exec` results for the two `exec` patterns. |
| `internal/domain/testdata/js_unicode.json` | JS `\s`, `\p{Cf}`, `\p{L}`, `\p{N}`, `\p{Pd}`, the safety gate's invisible class, `toLowerCase` and NFKC, `\p{Cased}`, `\p{Case_Ignorable}`, and the Final_Sigma context of `toLowerCase` (the Σ of `AΣc`, `AΣcA`, `cΣ` and `AcΣ`), recorded per code point. |
| `internal/domain/testdata/matcher_regexps.jsonl` | The matcher's `i`- and `u`-flag RegExps on every matcher corpus string plus Unicode edge cases. |
| `internal/domain/testdata/unicode_runs.jsonl` | NFKC and `toLowerCase` on strings with runs of more than 30 combining marks or case-ignorables, where golang.org/x/text is bounded and ICU is not (Stream-Safe U+034F insertion, Final_Sigma look-ahead). Also `classifyQuestion`, `extractExplainPhrase`, `askedFields`, `normalizeName`, `parseStrength` and `assessMatch` on inputs built from such runs, including questions that normalise to exactly 299, 300 and 301 code units. |

## Go probe data (task G4)

`npx tsx scripts/parity/go-probes-answers.ts` records reference output for the Go port of `summary.ts` and `answers.ts` into `internal/domain/testdata`. It is deterministic (seeded, sorted) and, after task G12, needs `git checkout node-fallback-v1` first.

| File | What V8 recorded |
|---|---|
| `answers_casefold.json` | The `iu` RegExp semantics the phrase lookup relies on, per code point: which code points `/^[\p{L}\p{N}]$/iu` matches, and, for every code point with a case mapping, which others a `/^\u{c}$/iu` literal matches. |
| `answers_regexps.json` | The source and flags of every RegExp V8 ran inside the summary and answer functions below. The Go test checks that each pattern answers.go compiles from a TS source is one of them, with the same flags. |
| `answers_unicode.jsonl` | Corpus-format lines for `findPhraseInFields`, `explainQuote`, `composeExplainAnswer`, `explanationAllowed`, `explanationFits`, `quoteExplainable`, `answerFromLabel` and `buildSummary` on non-ASCII inputs: case-fold variants (Kelvin sign, long s, final sigma, ypogegrammeni, dotted and dotless i, sharp s, Deseret), NFKC compatibility forms, format characters, typographic quotes and dashes, and long printed values with astral characters (UTF-16 lengths in the 400-unit chunker). A probe whose result would contain a lone surrogate is not recorded. |

## Image parity (task G5)

`npx tsx scripts/parity/record-images.ts` writes `fixtures/parity/images/`: synthetic images and `reference.json`, which records what the Node imaging code (`apps/server/src/imaging`, sharp 0.35.5 / libvips 8.18.7) returns for each of them. Every image is synthetic: text-like block patterns, solid colours and gradients. None is a real medicine photo. The image bytes are deterministic. Metric floats are rounded to 10 significant digits, because sharp varies by about 1e-13 between runs. After task G12, re-recording needs `git checkout node-fallback-v1` first.

Per image, `reference.json` holds:

- `validate`: `validateImage` as returned;
- `assess`: `assessQuality` on the upload itself, or null (16-bit, alpha, rejected, and the large images);
- `normalized`: `normalizeImage`, then `assessQuality` on the JPEG it returns (what the pipeline measures), with the output size, channel count and `grid`, the 4x4 block means of its greyscale.

`fit` lists input sizes with the size sharp's fit-inside resize gives them: rounding edge cases plus a seeded sample.

| Images | What they cover |
|---|---|
| `sharp`, `blurred`, `dark`, `glare`, `blue`, `green`, `wide` (3000x1000), `orient6.jpg`, `sharp.gif`, `huge.png` (7000x7000) | the Node tests' own images (`apps/server/test/helpers/images.ts`) |
| `sharp.png`, `sharp.webp`, `sharp-lossless.webp`, `progressive.jpg`, `grey16.png`, `alpha.png`, `tiny.jpg` (1x1) | formats and decoder paths |
| `colour.*`, `colour-444.jpg`, `colour-p3.jpg`, `sharp-p3.jpg`, `cmyk.jpg` | colour to grey conversion, chroma subsampling, ICC profiles |
| `orient6.png`, `orient6.webp`, `cells-o1.jpg` to `cells-o8.jpg` | EXIF orientation in PNG and WebP, and all eight orientations (block means) |
| `tall.jpg`, `large-*` | the resize: Lanczos3, JPEG shrink-on-load (1/2, 1/4, 1/8), libvips' box shrink, and libwebp's scaled decode for WebP over 2048 |

The Go test (`internal/imaging/parity_test.go`) requires sharpness within 0.5, luminance within 0.5 and glare within 0.005, with the same `ok` and `reasons`. It also requires the same output size and block means within 3 grey levels. Two images are listed as known gaps, each with a bound just above the measured difference and the verdict still exactly equal:

- `cmyk.jpg`: sharp converts CMYK through lcms with libvips' CMYK profile, and Go has no ICC support;
- `colour-p3.jpg`: the block means of its saturated corner, for the same reason. Its metrics are within the tolerance.
