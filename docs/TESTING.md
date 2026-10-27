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

`go test -count=1 ./...` — exit 0. 21 packages `ok`; 568 top-level tests and 399 subtests
passed, none failed or skipped (counted from `go test -count=1 -json ./...`, also exit 0):

```
ok  	github.com/medilens-ai/medilens/internal/ai	1.398s
ok  	github.com/medilens-ai/medilens/internal/application	2.220s
ok  	github.com/medilens-ai/medilens/internal/config	0.217s
ok  	github.com/medilens-ai/medilens/internal/contracts	10.174s
ok  	github.com/medilens-ai/medilens/internal/demo	0.139s
ok  	github.com/medilens-ai/medilens/internal/domain	13.367s
ok  	github.com/medilens-ai/medilens/internal/eval	0.267s
ok  	github.com/medilens-ai/medilens/internal/httpapi	2.568s
ok  	github.com/medilens-ai/medilens/internal/imaging	17.200s
ok  	github.com/medilens-ai/medilens/internal/jsregex	0.177s
ok  	github.com/medilens-ai/medilens/internal/mcptools	4.932s
ok  	github.com/medilens-ai/medilens/internal/metaapi	0.510s
ok  	github.com/medilens-ai/medilens/internal/middleware	0.221s
ok  	github.com/medilens-ai/medilens/internal/observability	0.182s
ok  	github.com/medilens-ai/medilens/internal/parity	0.381s
ok  	github.com/medilens-ai/medilens/internal/pipeline	4.666s
ok  	github.com/medilens-ai/medilens/internal/references	0.925s
ok  	github.com/medilens-ai/medilens/services/api	0.350s
ok  	github.com/medilens-ai/medilens/services/eval	0.833s
ok  	github.com/medilens-ai/medilens/services/mcp	0.306s
ok  	github.com/medilens-ai/medilens/services/smoke	0.207s
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

Before the Node server was removed (all four workspaces present), 2026-10-28:

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

The results after the Node server was removed are recorded in the next section when that
removal is made.

## Android build check

`npx expo export --platform android --output-dir <scratch dir>` in `apps/mobile` — exit 0:

```
Android Bundled 9943ms node_modules\expo-router\entry.js (1322 modules)
› android bundles (1):
_expo/static/js/android/entry-9dbfa71e9b7f8a4f46a18b46963e713d.hbc (3.4MB)
› Files (1):
metadata.json (1.8KB)
```

(26 asset lines omitted.) This proves the JS bundle builds for Android; it is not a device run.

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

First run on 2026-10-28 (G12 changes staged) printed two fake test keys from earlier Go tasks:

```
internal/application/service_test.go:1297:		ModelAPIKey: config.Secret("sk-test-not-a-real-key-0123456789"), DailySpendCapUSD: 5,
internal/metaapi/client_test.go:17:const testKey = "sk-test-not-a-real-key-123"
```

Neither is a real key; they were renamed to `sk-test.not.a.real.key.0123456789` and
`sk-test.not.a.real.key.123` (the dots end the `sk-` run), and both packages still pass. Second
run: no output, exit 1 (git grep's "no match"). `git ls-files .env apps/mobile/.env` printed
nothing.

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
serving model id is missing or contains "contributor". Never run in CI.

- **NOT RUN — owner:** `npm run smoke:live -- <image> [fda-search-term]` (default term
  `biogesic`) with `MODEL_API_KEY` set. No key was available to the build agents. Paste the
  printed lines here, and use the `fdawebsite row keys` line to confirm the advisory field names
  assumed in `internal/references/phfda.go`.
- Checked without a key, by `services/smoke` tests against local fakes: usage line and exit 1 with
  no arguments; "MODEL_API_KEY is not set. The live smoke test needs it." and exit 1 with a blank
  key; "Image rejected: INVALID_IMAGE"; metadata-only report (no label or registry value in the
  output); exit 3 and no registry call for a contributor model.

## Accuracy eval

- **NOT RUN — owner:** 20 real packs by Oct 31; see [eval/README.md](../eval/README.md)
  (`npm run eval:labels`).

## EAS build

- **NOT RUN — owner:** replace `https://REPLACE-WITH-HOSTED-SERVER` in `apps/mobile/eas.json`
  with the hosted API URL, then `cd apps/mobile && eas build --profile preview --platform
  android` (APK, internal distribution) and install it on the phone.

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
