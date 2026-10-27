# MediLens AI — Hackathon Checklist

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

- [ ] Run the live smoke test with a real key and paste its output into
  [TEST_PLAN.md](TEST_PLAN.md): `npx tsx apps/server/scripts/smoke-live.ts <image>`.
- [ ] **Accuracy eval on 20 real packs by Oct 31** ([eval/README.md](../eval/README.md));
  bar: zero confidently-wrong strengths or expiry dates. Commit only `docs/eval-results.md`.
- [ ] **Choose the backend host** (stable, always-on HTTPS) and deploy the server with
  `PROVIDER_MODE=live`, `MODEL_API_KEY`, `DAILY_SPEND_CAP_USD` and `PUBLIC_REPO_URL`.
- [ ] Replace `https://REPLACE-WITH-HOSTED-SERVER` in `apps/mobile/eas.json` with the hosted
  server URL.
- [ ] **EAS preview APK by Nov 2**: `cd apps/mobile && eas build --profile preview --platform android`;
  install on the phone and run the manual device checks in [TEST_PLAN.md](TEST_PLAN.md).
- [ ] **Feature freeze Nov 3.** After that, fixes only.

## Repository

- [ ] Create the public GitHub repository and push (all commits dated Oct 26 or later).
- [ ] Set `PUBLIC_REPO_URL` to it (used in the PH FDA User-Agent).
- [ ] **Secret scan** before making it public: `git grep -nE "(sk-|MODEL_API_KEY=.+)"` must
  show nothing but placeholders and test fixtures (see the latest result in
  [TEST_PLAN.md](TEST_PLAN.md)); also confirm `.env` is not tracked (`git ls-files .env`).
- [ ] README states: demo mode is simulated data, PH FDA endpoint is undocumented, Muse Spark
  only transcribes, glasses are roadmap only. (Written in this commit; re-check before submit.)

## Video and submission

- [ ] Record the **demo video, 3 minutes or less**, following [DEMO_SCRIPT.md](DEMO_SCRIPT.md).
- [ ] Upload the video; video link: _(to fill in)_
- [ ] **Submit before Nov 4, 21:00 ET** with the repo link, video link and description.
