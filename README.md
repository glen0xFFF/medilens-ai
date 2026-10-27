# MediLens AI

**Medication Accessibility Assistant.** *See the label. Hear the information. Understand with confidence.*

MediLens AI is an Android app for people with low vision, older adults and anyone who struggles
with small print on medicine packaging. Point the phone at a medicine pack and MediLens:

1. reads the printed label with **Meta Muse Spark** (vision, structured output; it only
   **transcribes** the text),
2. checks what it read against the **Philippine FDA product registry**, using
   **deterministic code** (the model never decides whether a product matches),
3. speaks a clear, ordered summary aloud, with pause, resume, repeat, stop and rate controls, and
4. answers follow-up questions **only from what is printed on the label or found in the
   registry**.

Every field carries a legibility flag (clear, partial, unreadable) and every scan carries a
verification status. When MediLens cannot read something clearly, it says so instead of guessing.

Built for the Meta Global AI Developer Hackathon (Indie track). Eligibility confirmation from the
organisers is **pending** (owner); see [docs/HACKATHON_CHECKLIST.md](docs/HACKATHON_CHECKLIST.md).

## What it is not

- **Not a diagnostic tool**, not a prescription generator and not a dosing calculator. Questions
  such as "how many should I take" are refused with a pointer to a pharmacist.
- **Not a pill identifier.** A photo of a loose tablet is never identified.
- **Not an authenticity checker.** "No registry match" does not mean a product is fake.
- **No Meta glasses support.** Glasses are on the roadmap only; nothing in this repository talks
  to glasses.
- No accounts, no scan history, no cloud storage of photos. English only. Android only.

## Demo mode is simulated data

Demo mode runs eight scripted scenarios on **fixture (simulated) data**: fictional products
(for example "Paracelin 500"), fictional registry records and no network calls to Meta or the
FDA. Every demo response has `isDemo: true` and every demo screen shows a **DEMO DATA** banner.
Demo results are never a real verification. Live mode is the only mode that reads a real pack
and queries the real registry.

## Quick start

Requirements: Node 24 or newer, npm, and an Android phone with **Expo Go** on the same Wi-Fi as
your computer.

```bash
npm install

# 1. Server in demo mode (no API key needed)
cp .env.example .env            # PROVIDER_MODE=demo is the default
npm run dev -w @medilens/server # listens on http://localhost:8787
curl http://localhost:8787/health

# 2. App in Expo Go
cp apps/mobile/.env.example apps/mobile/.env
# edit apps/mobile/.env: EXPO_PUBLIC_API_BASE_URL=http://<your computer's LAN IP>:8787
cd apps/mobile && npx expo start   # scan the QR code with Expo Go
```

Open **Demo mode** in the app to run the eight scenarios. To scan real packs, set
`PROVIDER_MODE=live` and `MODEL_API_KEY` in the root `.env` and restart the server.

Checks: `npm test`, `npm run typecheck`, `npm run lint` at the repo root. Results and the manual
device checklist are in [docs/TEST_PLAN.md](docs/TEST_PLAN.md).

An installable APK is built in the cloud with EAS (`eas build --profile preview` in
`apps/mobile`); before building, replace the placeholder `EXPO_PUBLIC_API_BASE_URL` in
`apps/mobile/eas.json` with the hosted server's HTTPS address.

## Environment variables

Server (root `.env`, git-ignored; template in [.env.example](.env.example)):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port the server listens on. |
| `PROVIDER_MODE` | `demo` | `demo` = fixture providers only; `live` = Muse Spark + PH FDA. |
| `MODEL_API_KEY` | (empty) | Meta Model API key. Server-only secret; required when `live`. |
| `DAILY_SPEND_CAP_USD` | `5` | Daily (UTC) cap on live model spend; then live scans return `503 LIVE_BUDGET_EXHAUSTED`. |
| `PUBLIC_REPO_URL` | (empty) | Repository URL used in the honest PH FDA `User-Agent`. |
| `CORS_ORIGIN` | (empty) | Optional allowed CORS origin. |
| `TRUST_PROXY` | `1` if `NODE_ENV=production`, else `false` | Proxy hops trusted for the client address the per-IP rate limit uses. Behind a hosting proxy keep `1`; with `false` all users share one bucket. Never `true`. |

The spend meter lives in server memory: **a restart starts the day's total at zero again**, so
the cap holds only while the process keeps running. A model call that reports no token usage
(or times out, or fails with a 5xx) is charged a conservative 4,000 input + 4,000 output tokens.
Requests already in flight when the cap is reached can each still finish one call.

App (`apps/mobile/.env`, git-ignored; template in `apps/mobile/.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | `http://localhost:8787` | MediLens server address. Not a secret. |

The app holds **no API keys** and never calls Meta or the FDA directly.

## Architecture

npm-workspaces monorepo: `packages/contracts` (shared Zod schemas), `apps/server` (Node,
Express 5), `apps/mobile` (Expo, expo-router). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the diagram and pipeline, and [docs/API_SPEC.md](docs/API_SPEC.md) for the HTTP API.

## Safety and privacy summary

- Muse Spark only transcribes. Matching, verification status, the spoken summary and most
  answers are **deterministic code**.
- Questions pass a **default-deny** safety gate: only label-reading questions are answered;
  dosing, diagnosis, interactions and "is it safe for me" are refused with a pharmacist redirect.
- Uncertainty is spoken: unclear fields are marked unclear; a conflict with the registry is
  spoken with a warning; no single green "verified" hides a partial or conflicting result.
- The registry's expiry date is the **registration certificate's** expiry, never the medicine's.
- Photos are processed in memory and **never stored**; results live in server memory for
  15 minutes so follow-up questions work. Logs redact images, read text and questions.
- The PH FDA endpoint is **undocumented and may change**; it is used from the server only, with
  an honest `User-Agent`, a 5 s timeout and a 24 h cache.

Full detail: [docs/SAFETY_AND_PRIVACY.md](docs/SAFETY_AND_PRIVACY.md).

## More documentation

- [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) — scope, timeline, roadmap
- [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) — the 3-minute demo video script
- [docs/HACKATHON_CHECKLIST.md](docs/HACKATHON_CHECKLIST.md) — submission checklist
- [eval/README.md](eval/README.md) — label accuracy eval on real packs

## License

[MIT](LICENSE)
