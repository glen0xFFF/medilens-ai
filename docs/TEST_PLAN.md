# MediLens AI — Test Plan

Automated suites run with `npm test`, `npm run typecheck` and `npm run lint` at the repo root
(contracts and server on Vitest, the mobile app on jest-expo).

## Automated results

Run by the build agent on 2026-10-27 after the final-review fix waves, with the mobile Jest
budget change described below in the working tree (three consecutive root runs, all identical).
Node v24.21.0, Windows, branch `feat/mvp`. Summary lines copied from the real output:

`npm test` (exit 0):

```
> @medilens/contracts@0.1.0 test
 Test Files  1 passed (1)
      Tests  27 passed (27)
> @medilens/mobile@0.1.0 test
Test Suites: 17 passed, 17 total
Tests:       284 passed, 284 total
> @medilens/server@0.1.0 test
 Test Files  23 passed (23)
      Tests  3077 passed (3077)
```

`npm run typecheck` (exit 0): `tsc --noEmit` passed for `@medilens/contracts`, `@medilens/mobile`
and `@medilens/server` with no errors.

`npm run lint` (exit 0): `eslint .` printed no problems.

Mobile test budget: the mobile Jest project allows 15 s per test (`testTimeout` in
`apps/mobile/package.json`; Jest's default is 5 s). In 2 of 9 root runs during the mobile fix
wave, the first test of a screen file (`scan.test.tsx`, and once also `result.test.tsx`) went
past 5 s and failed. That test pays the first expo-router render in its Jest worker and
normally takes 0.7 to 1.4 s; the overruns happened while all 17 suites ran in parallel.
`renderRouter` switches on fake timers, so the cold render could not be timed from inside the
test, and a warm-up render in `beforeAll` would carry those fake timers into the first test.
With the 15 s budget, three consecutive root runs passed.

Earlier result, for reference (Task 15, before the final review): contracts 26, mobile 254,
server 2926 tests passed.

## Live smoke test

One Muse Spark label read on a real photo plus one PH FDA lookup, through the production
adapters. Prints model id, finish reason, token usage (including `reasoning_tokens` when
reported), HTTP status and response key names; never the read text. Aborts (exit 3) if the
serving model id contains "contributor". Never run in CI.

- NOT RUN — owner to run: `npx tsx apps/server/scripts/smoke-live.ts <image>` with
  `MODEL_API_KEY` set (optional second argument: FDA search term, default `biogesic`). No key
  was available to the build agent. Paste the printed lines here, and use the
  `fdawebsite row keys` line to confirm the advisory field names assumed in
  `apps/server/src/providers/phFda.ts`.
- Checked by the build agent without a key (no network calls): with no arguments it prints the
  usage line and exits 1; with an image path and no `MODEL_API_KEY` it prints
  "MODEL_API_KEY is not set. The live smoke test needs it." and exits 1.

## Secret scan

The scan pattern was tightened in the final review (Minor 35). The old pattern,
`(sk-|MODEL_API_KEY=.+)`, matched every placeholder, the scan command itself and words such as
"task-by-task", so it gave 25 hits on 2026-10-27, none of them a key, and was easy to stop
reading. The new pattern matches a value assigned to `MODEL_API_KEY` in env-file form (bare or
double-quoted) and any `sk-` token of 20 or more characters:

```
git grep -nE "sk-[A-Za-z0-9_-]{20,}|MODEL_API_KEY=\"?[A-Za-z0-9_-]"
```

Run on 2026-10-27 over the tracked files with this file's changes in the working tree: no
output, exit 1 (git grep's "no match"). It does not match its own text, the
`MODEL_API_KEY=...` placeholders, the empty `MODEL_API_KEY=` in `.env.example`, or the short fake
`sk-secret-value-123` in `apps/server/test/config.test.ts`.

Negative control, same pattern with `grep -nE` over a scratch file outside the repo (its planted
values are described here, not copied, so this file does not match the scan): it matched an
env line assigning 12 letters and digits to `MODEL_API_KEY`, one assigning a double-quoted value,
and a 24-character `sk-proj-` token in a quoted string; it did not match `MODEL_API_KEY=...`, an
empty `MODEL_API_KEY=` or `sk-secret-value-123`.

Not covered: a key of another shape pasted somewhere other than a `MODEL_API_KEY=` line. Before
making the repository public the owner re-runs the scan, also confirms `.env` is not tracked
(`git ls-files .env apps/mobile/.env` must print nothing), and searches for the first few
characters of the real key.

## EAS build

- NOT RUN — owner to run: replace `https://REPLACE-WITH-HOSTED-SERVER` in
  `apps/mobile/eas.json` with the hosted server URL, then `cd apps/mobile && eas build --profile
  preview --platform android` (APK, internal distribution) and install it on the phone.

## Accuracy eval

- NOT RUN — owner to run on 20 real packs by Oct 31; see `eval/README.md`.

## Manual device checks

These need the owner's Android phone (Expo Go, TalkBack). None has been run by the build agents.

- NOT RUN — owner to perform: in `apps/mobile`, run `npx expo start`, scan the QR code with Expo Go on the Android phone and confirm the app loads and shows "MediLens AI" (Task 11 scaffold).
- NOT RUN — owner to perform: copy `apps/mobile/.env.example` to `apps/mobile/.env` with `EXPO_PUBLIC_API_BASE_URL` set to the computer's LAN address, start the server, restart `npx expo start` and confirm the phone can reach the server (`/health`) once a screen calls it (Task 11 API client).
- NOT RUN — owner to perform: on the Android phone (Expo Go), once a screen uses `useSpeech`, confirm spoken chunks play in order in English, Pause stops speech mid-chunk, Resume restarts that chunk from its start, Repeat restarts the current chunk, Stop ends speech, a rate change is heard from the next chunk, and leaving the screen stops speech; repeat with TalkBack on (Task 12 speech queue).
- NOT RUN — owner to perform: with the server running on the LAN in demo mode and `EXPO_PUBLIC_API_BASE_URL` set, open the app in Expo Go on the Android phone, acknowledge the first-run disclaimer (confirm it is spoken once and not shown on the next launch), open Demo mode and run all 8 scenarios s1–s8. For each, confirm the DEMO DATA banner, the status badge text (s1 "Matches FDA registry", s2 "Label unreadable", s3 "Several possible matches", s4 "Does not match registry" with the row "500 mg on label, 250 mg Tablet in registry", s5 "No registry match", s6 "Not checked", s8 "Registry check unavailable"), that the summary auto-plays, and that Label fields, Verification and sources ("Registration certificate valid until") and Ask a question work; on s7 tap Ask a question, tap the "How many should I take for my headache?" button (shown first, above the server presets) and confirm the refusal is shown and spoken (Task 13 result and demo screens; final review Minor 20).
- NOT RUN — owner to perform: repeat the 8 demo scenarios with TalkBack on: every button is announced with its label and role, the status is announced as "Verification: …" when a result opens, answers are announced on the ask screen, and speech from the result screen stops when another screen is opened on top of it (Task 13 accessibility).
- NOT RUN — owner to perform: in Settings, switch on High contrast and each text size (Normal, Large, Extra large) and confirm the result, fields, sources and ask screens stay readable with no clipped buttons; confirm "Server mode" shows demo or live from the server (Task 13 settings).
- NOT RUN — owner to perform: start the server on the LAN with `PROVIDER_MODE=live` and a model key, set `EXPO_PUBLIC_API_BASE_URL` to the computer's LAN address, open the app in Expo Go, tap Scan medicine, photograph a real medicine pack you own (1–3 sides, torch on if dim), check the preview, tap Analyze and record the outcome (status shown, summary spoken, time taken) here (Task 14 live capture).
- NOT RUN — owner to perform: camera permission states on the Android phone: on first open the "Allow camera access" button shows the system prompt; deny it twice so Android stops asking and confirm "Camera access is off" with "Open settings" opening the app's settings page; allow it there and confirm the camera shows on return (Task 14 permissions).
- NOT RUN — owner to perform: on the camera screen confirm "Torch: On" lights the phone torch, a 4th photo cannot be taken after 3, "Retake photo N" replaces only that photo, "Remove photo N" removes it, and "Read existing photo" (home and camera screens) lets you choose at most the free slots; with 4 chosen, only the first 3 are kept and the message is spoken (Task 14 capture limits).
- NOT RUN — owner to perform: with TalkBack on, confirm each photo taken is announced ("Photo 1 of 3 taken."), the analyzing screen announces "Sending N photos and reading the label…" and, on a slow network, "Still reading the label. Please wait." every 15 seconds; switch the phone to airplane mode and confirm the "couldn't reach the MediLens server" message is shown and spoken with Try again and Back to photos (Task 14 progress and errors).
- NOT RUN — owner to perform: after a scan completes or is cancelled, confirm no MediLens photos appear in the phone gallery (the app never writes to the media library) (Task 14 privacy).
- NOT RUN — owner to perform: with the server in demo mode, confirm Home and the camera screen show and TalkBack reads "Server is in demo mode: scans return a made-up example."; with the server in live mode, confirm the notice is gone (final review Minor 17).
- NOT RUN — owner to perform: on a live server, double-tap Analyze and confirm only one "Sending…" announcement and one request in the server log; start an upload, press the Android Back button within a few seconds and confirm the preview returns with the photos kept and no result screen opens later (final review Minor 22).
- NOT RUN — owner to perform: pick a tall gallery image (for example a long screenshot) and confirm it uploads and is read; the app resizes its long edge to 2048 px (final review Minor 26).
- NOT RUN — owner to perform: open demo s2, confirm a "Retake photos" button under the summary opens the camera; on a live scan of a loose tablet, confirm Label fields says "This looks like a loose tablet, not a label, so no label fields are shown." (final review Minor 24, I2).
