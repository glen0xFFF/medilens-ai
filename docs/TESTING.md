# MediLens AI — Testing

Every result below was produced by a command that was actually run; the output is copied from
it (long listings shortened where marked). Anything not run says **NOT RUN** and who runs it.
Device, emulator, live smoke and eval runs are **NOT RUN — owner**.

Environment of the build-agent runs: Windows 11 Pro, Git Bash, Go 1.27.0 windows/amd64
(`CGO_ENABLED=0`, so no `-race`), Node v24.21.0, npm 11.19.0, branch `feat/go-port`,
2026-10-28. No make, no Docker, no Android SDK or emulator on this machine.

## Suites

| Suite | Runner | What it covers |
|---|---|---|
| Go unit and integration tests | `go test ./...` | domain rules, imaging, providers (against local fakes), pipeline, HTTP API, MCP tools, config, eval and smoke ports |
| Parity corpora | `go test ./...` | `fixtures/parity/*.jsonl` recorded from the Node TS suite, deep-equal (below) |
| Zod contract test | root `npm test` (`scripts/contract`) | builds the Go API, starts it in mock + fixture mode, validates every endpoint's response with the Zod schemas |
| Contracts | root `npm test` (Vitest) | the Zod schemas |
| Mobile | root `npm test` (jest-expo) | screens, API client, speech queue |

## Go gates

`gofmt -l .` — no output, exit 0.

`go vet ./...` — no output, exit 0.

`go test -count=1 ./...` — exit 0. 21 packages `ok`; 581 top-level tests and 399 subtests
passed, none failed or skipped (counted from `go test -count=1 -json ./...`, also exit 0; final
review fix wave, 2026-10-28, at `cfc540d`; it was 568 when this file was first written and 572
at `7233e29`):

```
ok  	github.com/medilens-ai/medilens/internal/ai	1.386s
ok  	github.com/medilens-ai/medilens/internal/application	2.253s
ok  	github.com/medilens-ai/medilens/internal/config	0.342s
ok  	github.com/medilens-ai/medilens/internal/contracts	10.201s
ok  	github.com/medilens-ai/medilens/internal/demo	0.141s
ok  	github.com/medilens-ai/medilens/internal/domain	13.433s
ok  	github.com/medilens-ai/medilens/internal/eval	0.189s
ok  	github.com/medilens-ai/medilens/internal/httpapi	2.717s
ok  	github.com/medilens-ai/medilens/internal/imaging	17.123s
ok  	github.com/medilens-ai/medilens/internal/jsregex	0.199s
ok  	github.com/medilens-ai/medilens/internal/mcptools	4.641s
ok  	github.com/medilens-ai/medilens/internal/metaapi	0.489s
ok  	github.com/medilens-ai/medilens/internal/middleware	0.237s
ok  	github.com/medilens-ai/medilens/internal/observability	0.216s
ok  	github.com/medilens-ai/medilens/internal/parity	0.492s
ok  	github.com/medilens-ai/medilens/internal/pipeline	4.477s
ok  	github.com/medilens-ai/medilens/internal/references	0.962s
ok  	github.com/medilens-ai/medilens/services/api	0.269s
ok  	github.com/medilens-ai/medilens/services/eval	0.322s
ok  	github.com/medilens-ai/medilens/services/mcp	0.374s
ok  	github.com/medilens-ai/medilens/services/smoke	0.219s
```

### staticcheck

Run as `go run honnef.co/go/tools/cmd/staticcheck@v0.8.2 ./...` (ruling R5; v0.8.2 is the latest
release tag listed by `go list -m -versions honnef.co/go/tools` on 2026-10-28; no `go.mod`
change). It built and ran under Go 1.27.0. First run, exit 1:

```
internal\domain\safety_test.go:363:9: string literal contains Unicode format characters, consider using escape sequences instead (ST1018)
internal\domain\safety_test.go:380:27: string literal contains the Unicode format character U+200B, consider using the '\u200b' escape sequence instead (ST1018)
internal\domain\safety_test.go:383:27: string literal contains the Unicode format character U+200B, consider using the '\u200b' escape sequence instead (ST1018)
```

Fixed by writing the same characters as `\u200b` and `\u00ad` escapes (the strings are
unchanged; `go test ./internal/domain/` reported `(cached)`, the same compiled test). Second run:
no output, exit 0. `npm run go:lint` (vet + gofmt check + staticcheck) then exited 0.

`npm run go:fmt` negative control: with a deliberately unformatted file
`internal/eval/zz_unformatted.go` it printed the file name and exited 1; after deleting the file
it printed `gofmt -l .: no files` and exited 0.

### Parity corpora (100%)

Recorded from the Node build (tag `node-fallback-v1`) by `scripts/parity/record.ts`; every case
must deep-equal in Go. All pass in the `go test` run above.

| Corpus | Cases | Go tests that load it |
|---|---|---|
| `parsers.jsonl` | 865 | `internal/domain/parsers_test.go` |
| `matcher.jsonl` | 5,157 | `internal/domain/matcher_test.go`, `internal/contracts/contracts_test.go` |
| `safety.jsonl` | 3,002 | `internal/domain/safety_test.go` |
| `summary.jsonl` | 1,582 | `internal/domain/summary_test.go`, `internal/contracts/contracts_test.go` |
| `answers.jsonl` | 1,821 | `internal/domain/answers_test.go`, `internal/contracts/contracts_test.go` |
| `scenarios.jsonl` | 8 | `internal/httpapi/routes_test.go` (HTTP: `POST /demo/scenarios` → `/result` equals the Node output except ids and timestamps), `internal/application`, `internal/demo`, `internal/contracts` |

Further recorded sets: `fixtures/parity/images` (imaging, ±0.5 sharpness and luminance, ±0.005
glare, no verdict flip), `cmyk`, `providers` (Muse request bodies, zod `httpUrl` results, IDNA
hosts), `explain` (question limits) and `dotenv` (Node `.env` parser).

### Eval and smoke ports (task G12)

`internal/eval` and `services/eval` port `apps/server/src/eval/score.ts` and
`scripts/eval-labels.ts`; `services/smoke` ports `scripts/smoke-live.ts`. TDD record:

- RED: `go test ./internal/eval/` → `undefined: GroundTruth`, `undefined: ScoreLabel`, ...
  `[build failed]`; then for the smoke recorders `undefined: CompletionLog`, `undefined:
  IsContributorModel`, ...; `go test ./services/eval/` → `undefined: deps`, `undefined: run`;
  `go test ./services/smoke/` → `undefined: deps`, `undefined: run`.
- GREEN: `ok` for all four packages (in the run above).
- The score tests port the TS score tests case for case. The truth-file error texts were printed
  by the Node build's `GroundTruthSchema` (zod 4.6.7) for the same 20 inputs and are asserted
  verbatim. The extra cases beyond the TS suite (full month names, a no-break space, the other
  generic-name separators, `Sandoz`, `/contributor/i` on `U+0130`) were checked against the Node
  functions before being added.
- The command tests use local fakes serving the recorded synthetic Muse Spark and PH FDA
  fixtures: no network, no key.

## Root npm gates

Before the Node server was removed (contracts, mobile and server workspaces plus the contract
test), 2026-10-28:

`npm test` — exit 0:

```
> @medilens/contracts@0.1.0 test
 Test Files  2 passed (2)
      Tests  47 passed (47)
> @medilens/mobile@0.1.0 test
Test Suites: 17 passed, 17 total
Tests:       302 passed, 302 total
> @medilens/server@0.1.0 test
 Test Files  23 passed (23)
      Tests  3077 passed (3077)
> test:contract
 Test Files  1 passed (1)
      Tests  28 passed (28)
```

`npm run typecheck` — exit 0 (`tsc --noEmit` for contracts, mobile and server, plus
`scripts/parity` and `scripts/contract`, no errors).

`npm run lint` — exit 0 (`eslint .` printed no problems).

### After the Node server was removed

`apps/server` was removed only after the gates above were green (Go tests with the parity
corpora, the Zod contract test, the mobile tests). The Node build stays available at the tag
`node-fallback-v1`. Then, same day:

- `npm install --prefer-offline --no-audit --no-fund` — exit 0, `removed 101 packages`; the
  lockfile no longer lists `apps/server`. npm printed an `EPERM` cleanup warning for sharp's
  `libvips-42.dll`: a Node dev server started on 2026-10-27 at 14:57 from `apps/server`
  (`tsx src/server.ts`, not started by this task) still had it loaded, and it also keeps the now
  empty, untracked `apps/server` folder open. It was left running.
- `npm test` — exit 0:

  ```
  > @medilens/contracts@0.1.0 test
   Test Files  2 passed (2)
        Tests  47 passed (47)
  > @medilens/mobile@0.1.0 test
  Test Suites: 17 passed, 17 total
  Tests:       302 passed, 302 total
  > test:contract
   Test Files  1 passed (1)
        Tests  28 passed (28)
  ```

- `npm run typecheck` — exit 0 (`tsc --noEmit` for contracts and mobile, and
  `scripts/contract`). `scripts/parity` was dropped from it (ruling R4):
  `npx tsc --noEmit -p scripts/parity` now exits 2 with 47 errors, the first
  `scripts/parity/go-probes-answers.ts(321,32): error TS2307: Cannot find module '../../apps/server/src/domain/answers'`.
- `npm run lint` — exit 0 (`eslint .` still lints `scripts/parity`; it needs no exclusion).
- `gofmt -l .` no output; `go vet ./...` no output; `go test -count=1 ./...` exit 0 with all 21
  packages `ok` (the Go build never read `apps/server`).
- Secret scan (below), with the removal staged: no output, exit 1.

### Final review fix wave (2026-10-28)

Each fix commit was gated (`gofmt -l .`, `go vet ./...`, `go test -count=1 ./...`, `npm test`,
`npm run typecheck`, `npm run lint`: all exit 0, `gofmt` with no output). Latest `npm test`,
exit 0:

```
> @medilens/contracts@0.1.0 test
 Test Files  2 passed (2)
      Tests  48 passed (48)
> @medilens/mobile@0.1.0 test
Test Suites: 17 passed, 17 total
Tests:       315 passed, 315 total
> test:contract
 Test Files  1 passed (1)
      Tests  28 passed (28)
```

What changed in the tests (each new test was seen failing first):

- Mobile polling (final review I1, `apps/mobile/test/api/client.test.ts`): a failing poll is
  retried after 1.5 s, 3 s and 6 s (or a longer `Retry-After`), up to 3 failures in a row, then
  the client gives up with a best-effort `DELETE`; recovery after one NETWORK, TIMEOUT, proxy
  502/503 page or 429; a run of failures resets on success; a failing `/result` still runs out;
  NOT_FOUND ends without a delete; an abort during a backoff deletes.
- Smoke tool (I2 ruling R17, M13): an empty model id aborts with exit 3 and no PH FDA call; a
  usage count of `1e400` prints `Infinity` instead of panicking.
- API (M1, M3, M8): speak text that says fake or counterfeit (also fullwidth, or split by a soft
  hyphen or zero-width space) is `VALIDATION_FAILED`; a Node-era `PROVIDER_MODE` is a startup
  error; an uploaded photo keeps no spare capacity (an 8 MiB part had a 16 MiB capacity).
- MCP (M9): a 401 carries `WWW-Authenticate: Bearer`; `explain_verified_label` has
  `openWorldHint: true`.
- Analyzing screen (M12): a real server stage stays on screen; the reminder comes 15 s after the
  last stage and names it.
- Server (M15): `CORS_ORIGIN` is trimmed and an IPv6 zone refused; an encode failure's 500 body
  carries the request id; values under a sensitive slog group are redacted.
- Imaging (M14): the VP8X EXIF flag and a LONG Orientation follow sharp; an animated WebP is
  refused by `Validate`. The known imaging gaps are listed in
  [fixtures/parity/README.md](../fixtures/parity/README.md).
- Contracts (M16): `maxImages` is `z.literal(3)` and `ttlSeconds` `z.literal(900)`.

## Android build check

`npx expo export --platform android --output-dir <scratch dir>` in `apps/mobile` — exit 0:

```
Android Bundled 9943ms node_modules\expo-router\entry.js (1322 modules)
› android bundles (1):
_expo/static/js/android/entry-9dbfa71e9b7f8a4f46a18b46963e713d.hbc (3.4MB)
› Files (1):
metadata.json (1.8KB)
```

(26 asset lines omitted.) Re-run after the Node server was removed and the lockfile refreshed:
exit 0, `Android Bundled 7536ms node_modules\expo-router\entry.js (1322 modules)`, the same
bundle hash. This proves the JS bundle builds for Android; it is not a device run.

## Dev workflow checks

- `npm run demo` with `PORT=18787 MODEL_PROVIDER=muse_spark` in the shell: the API started in mock
  mode anyway (the script forces mock + fixture). `GET /readyz` returned
  `{"status":"ready","checks":{"model":"mock","references":"fixture"}}`; capabilities returned
  `"modelProvider":"mock","modelId":null,"referenceProvider":"fixture"`; the startup log line had
  `"provider":"mock","modelId":"mock","demoData":true`. Stopped afterwards.
- `npm run dev:mcp` with no tokens: exit 1 with
  `"reason":"MCP_API_TOKENS: required; set MCP_ALLOW_NO_AUTH=1 to serve without auth on a loopback address"`.
- `MCP_ADDR=127.0.0.1:18788 MCP_ALLOW_NO_AUTH=1 npm run dev:mcp`: started
  (`"auth":"none (loopback only)"`); a `tools/list` JSON-RPC POST to `/mcp` returned HTTP 200.
  Stopped afterwards.
- **Makefile, `Dockerfile.api`, `Dockerfile.mcp`, `docker-compose.yml`: unverified on the dev
  machine (no make, no Docker).** The build step inside both Dockerfiles was checked outside
  Docker on a copy of only `go.mod`, `go.sum`, `internal/` and `services/` (the Docker build
  context): `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"` of `./services/api` and
  `./services/mcp` both succeeded.

## Secret scan

```
git grep -nE "sk-[A-Za-z0-9_-]{20,}|MODEL_API_KEY=[\"']?[A-Za-z0-9_-]"
```

First run on 2026-10-28, before the docs commit (G12 changes staged): two hits, both fake test
keys from earlier Go tasks, in `internal/application/service_test.go` (line 1297, a 33-character
`sk-test-...` value in `TestCapabilitiesOfMuseSparkNameTheModelAndNoSecret`) and
`internal/metaapi/client_test.go` (line 17, the 26-character `testKey` constant). They are
described here, not copied, so this file does not match the scan. Neither was a real key; both
were renamed so that a dot ends the `sk-` run (`sk-test.not.a.real.key...`), and both packages
still pass. Second run: no output, exit 1 (git grep's "no match"). `git ls-files .env
apps/mobile/.env` printed nothing.

That docs commit then quoted the two old values in this file, so the scan matched this file
there. Corrected in the Node-removal commit (this text). Run after that correction, with the
removal staged: see "After the Node server was removed" above.

Negative control (same pattern, `grep -nE` over a scratch file outside the repo, values described
rather than copied): it matched an env line assigning 12 letters and digits to `MODEL_API_KEY` and
a 24-character `sk-proj-` token in a quoted string; it did not match `MODEL_API_KEY=...`, an empty
`MODEL_API_KEY=` or the dotted `sk-test.` test value.

Not covered: a key of another shape pasted somewhere other than a `MODEL_API_KEY=` line, and a
`MODEL_API_KEY` line with spaces around `=` or in JSON/YAML form. Before making the repository
public the owner re-runs the scan, confirms `.env` is not tracked, and searches for the first few
characters of the real key.

## Live smoke test

One Muse Spark label read on a real photo plus one PH FDA lookup, through the production Go
adapters. Prints model id, finish reason, token usage (including `reasoning_tokens` when
reported), HTTP status and response key names; never the read text. Aborts (exit 3) if the
serving model id is missing, empty or contains "contributor" (the empty case follows the Go port
spec, not the Node script, per the final-review ruling). Never run in CI.

- **RUN 2026-10-28** with the owner's key from `.env` (`go run ./services/smoke
  fixtures/parity/images/blue.jpg biogesic`), on a synthetic image with no label. Output after
  the `post_link` fix (the registry key list line is shortened here):

  ```
  Muse Spark call 1: model=muse-spark-1.3 finish_reason=stop prompt_tokens=2021 completion_tokens=723 total_tokens=2744 reasoning_tokens=356
  Label read: ok (imageKind=not_medicine, fields with a value: 0/12, clear: 12)
  PH FDA request 1: HTTP 200; top-level keys: ...; fdawebsite row keys: category, content, date_posted, post_link, title
  PH FDA lookup: ok (records: 13, advisories: 32)
  ```

  Before the fix the same run printed `advisories: 0, advisories unchecked`: the advisory link is
  `post_link`, which the client did not read. The first run also hit the 5 s PH FDA timeout once
  (a slow first response, about 17 s by curl); later runs answered in under a second.
- **NOT RUN — owner:** the smoke test on a real medicine photo (reading accuracy).
- Checked without a key, by `services/smoke` tests against local fakes: usage line and exit 1 with
  no arguments; "MODEL_API_KEY is not set. The live smoke test needs it." and exit 1 with a blank
  key; "Image rejected: INVALID_IMAGE"; metadata-only report (no label or registry value in the
  output); exit 3 and no registry call for a contributor model or an empty model id.

## Accuracy eval

- **NOT RUN — owner:** 20 real packs by Oct 31; see [eval/README.md](../eval/README.md)
  (`npm run eval:labels`).

## EAS build

- `apps/mobile/eas.json` points at the hosted API, `https://medilens-api.glenox.net`.
- **NOT RUN — owner:** `cd apps/mobile && eas build --profile preview --platform android` (APK,
  internal distribution) and install it on the phone.

## Hosted deployment (2026-10-28)

- API: `https://medilens-api.glenox.net`, live mode (`MODEL_PROVIDER=muse_spark`,
  `REFERENCE_PROVIDER=ph_fda`, `DAILY_SPEND_CAP_USD=5`). Landing page: `https://medilens.glenox.net`.
- Host: the owner's Ubuntu 24.04 server behind its Coolify Traefik proxy (Let's Encrypt) and
  Cloudflare (proxied, SSL mode strict). The API image was built on the host from
  `Dockerfile.api` at commit `2db0030`; this is the first time that Dockerfile has been built.
- The key is in a root-only env file on the host (mode 600), not in the image or the repository.
- Checked after deploy: `GET /healthz` 200, `GET /api/v1/config/capabilities` reports
  `muse_spark` / `muse-spark-1.3` / `ph_fda`, `POST /api/v1/demo/scenarios` 202, landing page 200.
- Known gap: behind Cloudflare the API sees Cloudflare edge addresses, so the per-client rate
  limits are per edge address, not per user. The daily spend cap still bounds the cost.

## Emulator (documented, not run)

No Android SDK or emulator exists on the build machine. With Android Studio installed: create a
Pixel AVD, start it, run the Go API (`npm run demo`), set
`EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:8787` in `apps/mobile/.env` (the emulator's alias for
the host), then `cd apps/mobile && npx expo start --android`. **NOT RUN.** An emulator run is not
a phone run and never a glasses run.

## Manual device checks

These need the owner's Android phone (Expo Go, TalkBack). **None has been run by the build
agents.** The API is the Go API (`npm run demo` for demo mode, `npm run dev:api` with
`MODEL_PROVIDER=muse_spark` and `REFERENCE_PROVIDER=ph_fda` for live mode).

- NOT RUN — owner to perform: in `apps/mobile`, run `npx expo start`, scan the QR code with Expo Go on the Android phone and confirm the app loads and shows "MediLens AI".
- NOT RUN — owner to perform: copy `apps/mobile/.env.example` to `apps/mobile/.env` with `EXPO_PUBLIC_API_BASE_URL` set to the computer's LAN address, start the Go API, restart `npx expo start` and confirm the phone reaches the server (Home shows the demo-mode notice when the API is in mock mode).
- NOT RUN — owner to perform: on the Android phone, confirm spoken chunks play in order in English, Pause stops speech mid-chunk, Resume restarts that chunk from its start, Repeat restarts the current chunk, Stop ends speech, a rate change is heard from the next chunk, and leaving the screen stops speech; repeat with TalkBack on.
- NOT RUN — owner to perform: with the API running on the LAN in demo mode, open the app in Expo Go, acknowledge the first-run disclaimer (confirm it is spoken once and not shown on the next launch), open Demo mode and run all 8 scenarios s1–s8. For each, confirm the DEMO DATA banner, the status badge text (s1 "Matches FDA registry", s2 "Label unreadable", s3 "Several possible matches", s4 "Does not match registry" with the row "500 mg on label, 250 mg Tablet in registry", s5 "No registry match", s6 "Not checked", s8 "Registry check unavailable"), that the summary auto-plays, and that Label fields, Verification and sources ("Registration certificate valid until") and Ask a question work; on s7 tap Ask a question, tap the "How many should I take for my headache?" button (shown first, above the server presets) and confirm the refusal is shown and spoken.
- NOT RUN — owner to perform: repeat the 8 demo scenarios with TalkBack on: every button is announced with its label and role, the status is announced as "Verification: …" when a result opens, answers are announced on the ask screen, and speech from the result screen stops when another screen is opened on top of it.
- NOT RUN — owner to perform: during a scan or demo run, confirm the analyzing screen shows and TalkBack announces the real stage labels in order ("Request received.", "Checking the photo quality.", "Reading the label.", ...), with skipped stages not announced.
- NOT RUN — owner to perform: in Settings, switch on High contrast and each text size (Normal, Large, Extra large) and confirm the result, fields, sources and ask screens stay readable with no clipped buttons; confirm "Server mode" shows demo or live from the server.
- NOT RUN — owner to perform: start the Go API on the LAN in live mode with a model key, set `EXPO_PUBLIC_API_BASE_URL` to the computer's LAN address, open the app in Expo Go, tap Scan medicine, photograph a real medicine pack you own (1–3 sides, torch on if dim), check the preview, tap Analyze and record the outcome (status shown, summary spoken, time taken) here.
- NOT RUN — owner to perform: camera permission states: on first open the "Allow camera access" button shows the system prompt; deny it twice so Android stops asking and confirm "Camera access is off" with "Open settings" opening the app's settings page; allow it there and confirm the camera shows on return.
- NOT RUN — owner to perform: on the camera screen confirm "Torch: On" lights the phone torch, a 4th photo cannot be taken after 3, "Retake photo N" replaces only that photo, "Remove photo N" removes it, and "Read existing photo" (home and camera screens) lets you choose at most the free slots; with 4 chosen, only the first 3 are kept and the message is spoken.
- NOT RUN — owner to perform: with TalkBack on, confirm each photo taken is announced ("Photo 1 of 3 taken."); switch the phone to airplane mode and confirm the "couldn't reach the MediLens server" message is shown and spoken with Try again and Back to photos.
- NOT RUN — owner to perform: after a scan completes or is cancelled, confirm no MediLens photos appear in the phone gallery (the app never writes to the media library).
- NOT RUN — owner to perform: with the API in demo mode, confirm Home and the camera screen show and TalkBack reads "Server is in demo mode: scans return a made-up example."; with the API in live mode, confirm the notice is gone.
- NOT RUN — owner to perform: on a live API, double-tap Analyze and confirm only one upload in the API log; start an upload, press the Android Back button within a few seconds and confirm the preview returns with the photos kept and no result screen opens later.
- NOT RUN — owner to perform: leave a result screen and confirm the API log shows a `DELETE /api/v1/analyses/{id}` for it.
- NOT RUN — owner to perform: pick a tall gallery image (for example a long screenshot) and confirm it uploads and is read; the app resizes its long edge to 2048 px.
- NOT RUN — owner to perform: open demo s2, confirm a "Retake photos" button under the summary opens the camera; on a live scan of a loose tablet, confirm Label fields says "This looks like a loose tablet, not a label, so no label fields are shown."

## Earlier results, for reference

Node build, 2026-10-27, branch `feat/mvp` after the final-review fix waves: contracts 27, mobile
284, server 3077 tests passed; typecheck and lint clean. The mobile Jest project allows 15 s per
test (`testTimeout` in `apps/mobile/package.json`), because the first expo-router render in a
worker occasionally passed Jest's default 5 s while all suites ran in parallel.
