# MediLens AI

**Medication Accessibility Assistant.** *See the label. Hear the information. Understand with confidence.*

MediLens AI is an Android app for people with low vision, older adults and anyone who struggles
with small print on medicine packaging. Point the phone at a medicine pack and MediLens:

1. reads the printed label with **Meta Muse Spark** (vision, structured output; it
   **transcribes** the text, and its only other job is a short explanation of one printed
   phrase, kept only if it passes a strict content gate),
2. checks what it read against the **Philippine FDA product registry**, using
   **deterministic code** (the model never decides whether a product matches),
3. speaks a clear, ordered summary aloud, with pause, resume, repeat, stop and rate controls, and
4. answers follow-up questions **only from what is printed on the label or found in the
   registry**.

Every field carries a legibility flag (clear, partial, unreadable) and every scan carries a
verification status. When MediLens cannot read something clearly, it says so instead of guessing.

The server side is written in **Go**: a REST + SSE API (`services/api`) and a separate
**MCP server** (`services/mcp`) that exposes the same pipeline as read-only, safety-gated tools.
The original Node/Express server was ported to Go test for test and retired once the Go build
reproduced it exactly (see [Parity](#parity-with-the-node-build)); it is kept at the git tag
`node-fallback-v1`.

Built for the Meta Global AI Developer Hackathon (Indie track). Eligibility confirmation from the
organisers is **pending** (owner); see [docs/HACKATHON_SUBMISSION.md](docs/HACKATHON_SUBMISSION.md).

## What it is not

- **Not a diagnostic tool**, not a prescription generator and not a dosing calculator. Questions
  such as "how many should I take" are refused with a pointer to a pharmacist.
- **Not a pill identifier.** A photo of a loose tablet is never identified.
- **Not an authenticity checker.** "No registry match" does not mean a product is fake.
- **No Meta glasses support.** Glasses are on the roadmap only; nothing in this repository talks
  to glasses, and an emulator or phone run is never presented as a glasses run.
- No accounts, no scan history, no cloud storage of photos. English only. Android only.

## Real versus mock, per capability

| Capability | Real (live) | Mock / fixture (demo) | Verified so far |
|---|---|---|---|
| Label reading | Muse Spark `muse-spark-1.3` via the Meta Model API (`MODEL_PROVIDER=muse_spark`) | Mock reader: the fictional s1 label for any upload (`MODEL_PROVIDER=mock`, the default) | Mock: automated tests. Live: **no live call has been made** (no key yet); Go client tested against local fakes with recorded synthetic responses |
| Phrase explanation | Muse Spark, behind the closed-vocabulary gate | None: the printed text is quoted alone | Same as above |
| Registry check | PH FDA verification search (`REFERENCE_PROVIDER=ph_fda`), undocumented endpoint | Fixture registry rows (`REFERENCE_PROVIDER=fixture`, the default) | Node build: field names confirmed against one real response on 2026-10-27. Go client: tested against local fakes only |
| Photo quality check | Real in every mode (Go imaging, parity with the Node sharp pipeline) | Same | Automated tests on the parity image set |
| Matching, summary, answers, safety gate | Deterministic Go code in every mode | Same | Parity corpora recorded from the Node suite: 100% pass |
| Demo scenarios s1 to s8 | Always fixture data (fictional products), whatever the providers | Same | Automated tests; HTTP output equals the recorded Node output |
| Speech (TTS) | On the phone (`expo-speech`) | Same | jest tests; **not yet heard on a device** (owner) |
| Android app | Expo app on a phone | Same | jest, typecheck and `expo export --platform android`; **no device or emulator run yet** (owner) |
| MCP tools | Over the configured providers | Mock/fixture by default | In-memory tool tests and one authenticated HTTP test |

Any result made with a mock or fixture provider has `isDemo: true` and the app shows a
**DEMO DATA** banner. There is no silent fallback: if `MODEL_PROVIDER=muse_spark` is set without
`MODEL_API_KEY`, the server refuses to start rather than switching to the mock.

## Quick start

Requirements: Go 1.27, Node 24 or newer with npm (for the app, the shared contracts and the
checks), and an Android phone with **Expo Go** on the same Wi-Fi as your computer.

```bash
npm install

# 1. API in demo mode (mock model + fixture registry, no key needed)
cp .env.example .env
npm run demo                     # Go API on http://localhost:8787
curl http://localhost:8787/readyz
curl http://localhost:8787/api/v1/config/capabilities

# 2. App in Expo Go
cp apps/mobile/.env.example apps/mobile/.env
# edit apps/mobile/.env: EXPO_PUBLIC_API_BASE_URL=http://<your computer's LAN IP>:8787
cd apps/mobile && npx expo start   # scan the QR code with Expo Go
```

Open **Demo mode** in the app to run the eight scenarios. To scan real packs, set
`MODEL_PROVIDER=muse_spark`, `MODEL_API_KEY` and `REFERENCE_PROVIDER=ph_fda` in the root `.env`
and start the API with `npm run dev:api` (the `demo` script always forces mock + fixture).

MCP server (separate process, own analysis store):

```bash
# loopback without auth, for local tools only
MCP_ALLOW_NO_AUTH=1 npm run dev:mcp      # http://127.0.0.1:8788/mcp
# anything else needs bearer tokens
MCP_API_TOKENS=<16+ character token> npm run dev:mcp
```

On Windows `cmd.exe`, put those variables in `.env` instead of the command line. See
[docs/MCP_TOOLS.md](docs/MCP_TOOLS.md).

## Commands

| Command | What it runs |
|---|---|
| `npm run go:test` | `go test ./...` (includes the parity corpora) |
| `npm run go:vet` | `go vet ./...` |
| `npm run go:fmt` | fails if `gofmt -l .` lists any file |
| `npm run go:lint` | vet + gofmt + staticcheck (`honnef.co/go/tools/cmd/staticcheck@v0.8.2` via `go run`) |
| `npm run dev:api` / `npm run dev:mcp` | the Go API / MCP server with the `.env` settings |
| `npm run demo` | the Go API with `MODEL_PROVIDER=mock REFERENCE_PROVIDER=fixture` forced |
| `npm test`, `npm run typecheck`, `npm run lint` | contracts (Vitest), mobile (jest-expo), the Go-vs-Zod contract test, TypeScript and ESLint |
| `npm run eval:labels` | live accuracy eval on your own packs (costs money; [eval/README.md](eval/README.md)) |
| `npm run smoke:live -- <image> [term]` | one live Muse Spark read + one PH FDA lookup, metadata only (costs money) |

A `Makefile`, `Dockerfile.api`, `Dockerfile.mcp` and `docker-compose.yml` wrap the same commands.
They are **unverified on the dev machine** (no make and no Docker there); the Go builds inside them
were run outside Docker. Results of every check are in [docs/TESTING.md](docs/TESTING.md).

An installable APK is built in the cloud with EAS (`eas build --profile preview` in
`apps/mobile`); before building, replace the placeholder `EXPO_PUBLIC_API_BASE_URL` in
`apps/mobile/eas.json` with the hosted API's HTTPS address.

## Environment variables

Server (root `.env`, git-ignored; every variable is described in [.env.example](.env.example)):

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `MODEL_PROVIDER` | `mock` | api, mcp | `mock` or `muse_spark`. No fallback between them. |
| `REFERENCE_PROVIDER` | `fixture` | api, mcp | `fixture` or `ph_fda`. |
| `MODEL_API_KEY` | (empty) | api, mcp, eval, smoke | Meta Model API key. Server-only secret; required for `muse_spark`. |
| `DAILY_SPEND_CAP_USD` | `5` | api, mcp, eval | Daily (UTC) cap on live model spend; then `503 LIVE_BUDGET_EXHAUSTED`. |
| `PUBLIC_REPO_URL` | (empty) | api, mcp, smoke | Repository URL in the honest PH FDA `User-Agent`. |
| `PORT` | `8787` | api | Listening port. |
| `CORS_ORIGIN` | (empty) | api | The one browser origin that gets CORS headers. |
| `TRUSTED_PROXIES` | (empty) | api | CIDR list of proxies whose `X-Forwarded-For` the rate limits honour. |
| `MCP_ADDR` | `127.0.0.1:8788` | mcp | Listen address. |
| `MCP_API_TOKENS` | (empty) | mcp | Comma-separated bearer tokens. Required off loopback. |
| `MCP_ALLOW_NO_AUTH` | (empty) | mcp | `1` allows no tokens, on a loopback address only. |
| `ENV_FILE` | `.env` | all | Another env file to read. |

The spend meter lives in process memory: **a restart starts the day's total at zero again**, and
the API and the MCP server each have their own meter. A model call that reports no token usage
(or fails after it may have run) is charged a conservative 4,000 input + 4,000 output tokens.

App (`apps/mobile/.env`, git-ignored; template in `apps/mobile/.env.example`):
`EXPO_PUBLIC_API_BASE_URL` (default `http://localhost:8787`), a URL and not a secret. The app
holds **no API keys** and never calls Meta or the FDA directly.

## Architecture

```
services/api       Go REST + SSE API binary
services/mcp       Go MCP server binary (Streamable HTTP, go-sdk v1.8.0)
services/eval      live label accuracy eval (owner-run)
services/smoke     live smoke test (owner-run)
internal/...       config, contracts, domain rules, imaging, providers, pipeline, HTTP, MCP tools
packages/contracts Zod schemas shared by the app and the contract test
apps/mobile        Expo app (expo-router)
fixtures/parity    golden corpora recorded from the Node build
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the diagram and pipeline,
[docs/API.md](docs/API.md) for the HTTP API and [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) for the
MCP tools.

## Parity with the Node build

The Node domain logic (default-deny safety gate, strict matcher, deterministic answers,
closed-vocabulary explanation gate) took many review rounds. The Go port re-implements it and is
held to it by golden corpora recorded from the TypeScript test suite (12,427 recorded domain calls plus
the 8 demo scenarios, `fixtures/parity/`), deep-equal in `go test`. A Go/TS difference is a Go
bug. Re-recording restores only `apps/server` from that tag onto the current branch (a whole-tree
checkout of the tag has no recorder); see [scripts/parity/README.md](scripts/parity/README.md#re-recording)
and [fixtures/parity/README.md](fixtures/parity/README.md).

## Safety and privacy summary

- Muse Spark transcribes the label; its only other use is explaining one printed phrase on
  request, kept only if it passes a strict content gate. Matching, verification status, the
  spoken summary and every other answer are **deterministic code**.
- Questions pass a **default-deny** safety gate: only label-reading questions are answered;
  dosing, diagnosis, interactions and "is it safe for me" are refused with a pharmacist redirect.
  The MCP tool `explain_verified_label` runs the same gate.
- Uncertainty is spoken: unclear fields are marked unclear; a conflict with the registry is
  spoken with a warning; no single green "verified" hides a partial or conflicting result.
- The registry's expiry date is the **registration certificate's** expiry, never the medicine's.
- Photos are processed in memory and **never stored** (uploads are never spilled to disk);
  analyses live in server memory for 15 minutes so follow-up questions work, and the app deletes
  its analysis when you leave a result. Logs never contain images, read text, questions or keys.
- The PH FDA endpoint is **undocumented and may change**; it is used from the server only, with
  an honest `User-Agent`, a 5 s timeout and a 24 h cache.

Full detail: [docs/SAFETY.md](docs/SAFETY.md) and [docs/PRIVACY.md](docs/PRIVACY.md).

## More documentation

- [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md): scope, timeline, roadmap
- [docs/MUSE_SPARK_INTEGRATION.md](docs/MUSE_SPARK_INTEGRATION.md): what is verified about the Meta Model API, what is not, and the steps for the first live call
- [docs/TESTING.md](docs/TESTING.md): every check with its real output, and what is not run
- [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md): the 3-minute demo video script
- [docs/HACKATHON_SUBMISSION.md](docs/HACKATHON_SUBMISSION.md): submission checklist and description
- [eval/README.md](eval/README.md): label accuracy eval on real packs

## License

[MIT](LICENSE)
