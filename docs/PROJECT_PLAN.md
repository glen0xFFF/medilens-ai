# MediLens AI — Project Plan

Binding design: [superpowers/specs/2026-10-27-medilens-design.md](superpowers/specs/2026-10-27-medilens-design.md),
amended by the Go port spec [superpowers/specs/2026-10-28-medilens-go-port-design.md](superpowers/specs/2026-10-28-medilens-go-port-design.md).
Task-level plans: [superpowers/plans/2026-10-27-medilens-mvp.md](superpowers/plans/2026-10-27-medilens-mvp.md) (Node MVP)
and [superpowers/plans/2026-10-28-medilens-go-port.md](superpowers/plans/2026-10-28-medilens-go-port.md) (Go port).

## Goal

A working scan → read → verify → speak flow on a physical Android phone, shown in a video of at
most 3 minutes, for the Meta Global AI Developer Hackathon (Indie track). Submission deadline:
**Nov 4 2026, 9:00 PM ET** (Nov 5, 10:00 AM Manila).

## Scope (MVP)

- Capture 1–3 photos (torch, retake) or pick an existing photo; reject blurry, dark or
  glare-heavy photos with a spoken reason.
- Read the label with Meta Muse Spark (`muse-spark-1.3`, Standard mode, transcription only).
- Check the read against the PH FDA registry with deterministic matcher rules and explicit
  statuses: verified, partial, conflicting, ambiguous, no match, unavailable, not attempted.
- Speak a deterministic, ordered summary with pause, resume, repeat, stop and rate control.
- Answer preset and typed questions from the label and registry only, behind a default-deny
  safety gate.
- Demo mode: eight scripted scenarios on **fixture (simulated) data**, every screen labelled
  DEMO DATA.
- Accessibility: TalkBack labels and roles, large targets, text scale, high-contrast theme,
  screen-reader announcements, spoken progress stages while a scan runs.
- Server in Go (owner-directed port, Oct 27-28): a REST + SSE API and a separate MCP server
  with six read-only, safety-gated tools over the same services. The Go build reproduces the
  Node build exactly (parity corpora, Zod contract test); the Node server is kept at tag
  `node-fallback-v1` and removed from the tree.

## Not in scope

- **Meta glasses: roadmap only, not implemented.** No code in this repository talks to glasses.
- Voice input (stretch; not built).
- Languages other than English; iOS; accounts; scan history; offline mode.

## Timeline

| Date (2026) | Milestone | Owner |
|---|---|---|
| Oct 27 | Design, plan, Node server pipeline, mobile app, docs | build agents |
| Oct 28 | Go port: Go API, Go MCP server, parity corpora, mobile client on the new contract, Node server retired | build agents |
| Oct 31 | Accuracy eval on 20 real packs (bar: zero confidently-wrong strengths or expiry dates) | owner |
| Nov 2 | First EAS preview APK | owner |
| Nov 3 | Feature freeze | owner |
| Nov 4, 21:00 ET | Submission (repo public, video ≤ 3 min) | owner |

## Owner-gated items

Not done by the build agents; tracked in [HACKATHON_SUBMISSION.md](HACKATHON_SUBMISSION.md):
written eligibility confirmation, API credits, backend hosting choice, the live smoke test with a
real key, the 20-pack eval, the EAS build, the manual device checks, making the repository
public, the video and the submission.

## Risks

| Risk | Mitigation |
|---|---|
| Eligibility ("government-affiliated" clause) unclear | Owner obtains written confirmation from Cerebral Valley before submitting. Build proceeds regardless. |
| PH FDA endpoint is undocumented and may change or block us | Server-only, honest User-Agent, 5 s timeout, 24 h cache; a failure is spoken as "unavailable", never as a match. |
| Model misreads a strength or expiry | Per-field legibility, deterministic matching, 20-pack eval with a zero confidently-wrong bar. |
| Public live access overspends | Daily spend cap (`DAILY_SPEND_CAP_USD`); then live scans return 503 and suggest Demo Mode. |
| No Android SDK or emulator on the build machine | Expo Go on the owner's phone for development, EAS cloud for the APK, `expo export --platform android` locally, manual checklist in TESTING. Emulator instructions are documented, not claimed as run. |
| Go port subtly diverges from the reviewed Node logic | Golden corpora recorded from the TS suite must pass 100%; HTTP-level scenario parity; Zod contract test against the Go binary; Node kept at tag `node-fallback-v1`. |
| No make or Docker on the build machine | Makefile, Dockerfiles and compose marked unverified; the npm scripts are the tested path. |

## Roadmap (after the hackathon)

- Meta glasses capture (Wearables Device Access Toolkit); not available for this build.
- The app on the SSE event stream instead of polling, once React Native streaming is verified.
- Spoken questions (Muse Voice Transcribe); Filipino/Tagalog output.
- Written permission from PH FDA for registry lookups.
