# MediLens AI — Hackathon submission

Meta Global AI Developer Hackathon, Indie track. **Submission deadline: Nov 4 2026, 21:00 ET
(Nov 5, 10:00 Manila).** Every item below is owner-gated unless marked done; none is done yet
unless it says so.

## Eligibility and rules

- [ ] **Written eligibility confirmation from Cerebral Valley** about the "government-affiliated"
  exclusion clause. Keep the email. **Status: pending (owner).** Do not submit without it.
- [ ] Check the hackathon Discord **#rules** channel for any rules not in the Official Rules
  (repo creation date, commit window, video requirements); record findings here.
- [ ] Confirm the account was accepted into the hackathon.

## Accounts and credits

- [ ] Claim the Meta Model API hackathon credits (can take up to 2 business days).
- [ ] Put `MODEL_API_KEY` only in the server's environment (root `.env` or the host's secret
  settings). Never in `apps/mobile`, never committed.

## Build and verification

- [x] Run the live smoke test with a real key (done 2026-10-28 on a synthetic image; still
  run it once on a real pack photo) and paste its output into
  [TESTING.md](TESTING.md): `npm run smoke:live -- <image> [fda-search-term]`
  (steps in [MUSE_SPARK_INTEGRATION.md](MUSE_SPARK_INTEGRATION.md)).
- [ ] **Accuracy eval on 20 real packs by Oct 31** ([eval/README.md](../eval/README.md));
  bar: zero confidently-wrong strengths or expiry dates. Commit only `docs/eval-results.md`.
- [ ] **Choose the backend host** (stable, always-on HTTPS) and deploy the Go API
  (`Dockerfile.api`, or `CGO_ENABLED=0 go build ./services/api` and run the binary) with
  `MODEL_PROVIDER=muse_spark`, `REFERENCE_PROVIDER=ph_fda`, `MODEL_API_KEY`,
  `DAILY_SPEND_CAP_USD` and `PUBLIC_REPO_URL`. Set `TRUSTED_PROXIES` to the host proxy's CIDR
  range so the rate limits are per user behind it (empty: every user shares the proxy's bucket).
  Set `GOMEMLIMIT` to the container's memory limit less headroom. The Dockerfiles and compose
  file are **unverified** (no Docker on the dev machine): build them once on the host first.
- [ ] Replace `https://REPLACE-WITH-HOSTED-SERVER` in `apps/mobile/eas.json` with the hosted
  API URL.
- [ ] **EAS preview APK by Nov 2**: `cd apps/mobile && eas build --profile preview --platform android`;
  install on the phone and run the manual device checks in [TESTING.md](TESTING.md).
- [ ] **Feature freeze Nov 3.** After that, fixes only.

## Repository

- [ ] Create the public GitHub repository and push (all commits dated Oct 26 or later). Push the
  `node-fallback-v1` tag too if the Node fallback should be visible.
- [ ] Set `PUBLIC_REPO_URL` to it (used in the PH FDA User-Agent).
- [ ] **Secret scan** before making it public: `git grep -nE "sk-[A-Za-z0-9_-]{20,}|MODEL_API_KEY=[\"']?[A-Za-z0-9_-]"` must
  print nothing (it skips placeholders such as `MODEL_API_KEY=...` and short test values; see the latest result in
  [TESTING.md](TESTING.md)); also confirm `.env` is not tracked (`git ls-files .env apps/mobile/.env`).
- [ ] README states: demo mode is simulated data, PH FDA endpoint is undocumented, Muse Spark
  transcribes (plus one gated phrase explanation), glasses are roadmap only, and real versus mock
  per capability. (Re-check before submit.)

## Video and submission

- [ ] Record the **demo video, 3 minutes or less**, following [DEMO_SCRIPT.md](DEMO_SCRIPT.md).
- [ ] Upload the video; video link: _(to fill in)_
- [ ] **Submit before Nov 4, 21:00 ET** with the repo link, video link and description.

## Submission description (draft)

Edit before submitting; every claim here must still be true on the day.

> **MediLens AI — see the label, hear the information, understand with confidence.**
>
> MediLens AI is an Android accessibility reader for medicine labels, for people with low vision,
> older adults and anyone who cannot read small print. Photograph a medicine pack and MediLens
> reads it with **Meta Muse Spark** (`muse-spark-1.3`, vision with structured output), checks
> what it read against the **Philippine FDA registry** with deterministic rules, and speaks an
> ordered summary aloud. Every field carries a legibility flag, and when MediLens cannot read
> something clearly it says so instead of guessing.
>
> Muse Spark only transcribes the label (and, on request, explains one printed phrase, kept only
> if it passes a strict content gate). Matching, verification status, the summary and every
> answer are deterministic code. A default-deny safety gate refuses dosing, diagnosis,
> interaction and "is it safe for me" questions with a pharmacist redirect. It never identifies
> loose pills and never calls a product fake; it only relays an FDA counterfeit advisory when the
> FDA has published one.
>
> The backend is Go: a REST + SSE API with real progress events and a separate MCP server whose
> six safety-gated tools run the same pipeline and the same safety gate. The app is Expo
> (React Native) with TalkBack support, large text, high contrast and adjustable speech.
>
> Honest scope: demo mode uses simulated data and is labelled DEMO DATA; the PH FDA endpoint is
> undocumented; Meta glasses are on the roadmap only.

Before submitting, add what was actually measured: the live smoke result, the 20-pack eval
counts, and the device checks that passed. Leave out anything not run.
