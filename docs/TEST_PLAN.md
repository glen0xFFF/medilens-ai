# MediLens AI — Test Plan

Automated suites run with `npm test`, `npm run typecheck` and `npm run lint` at the repo root
(contracts and server on Vitest, the mobile app on jest-expo).

## Manual device checks

These need the owner's Android phone (Expo Go, TalkBack). None has been run by the build agents.

- NOT RUN — owner to perform: in `apps/mobile`, run `npx expo start`, scan the QR code with Expo Go on the Android phone and confirm the app loads and shows "MediLens AI" (Task 11 scaffold).
- NOT RUN — owner to perform: copy `apps/mobile/.env.example` to `apps/mobile/.env` with `EXPO_PUBLIC_API_BASE_URL` set to the computer's LAN address, start the server, restart `npx expo start` and confirm the phone can reach the server (`/health`) once a screen calls it (Task 11 API client).
- NOT RUN — owner to perform: on the Android phone (Expo Go), once a screen uses `useSpeech`, confirm spoken chunks play in order in English, Pause stops speech mid-chunk, Resume restarts that chunk from its start, Repeat restarts the current chunk, Stop ends speech, a rate change is heard from the next chunk, and leaving the screen stops speech; repeat with TalkBack on (Task 12 speech queue).
- NOT RUN — owner to perform: with the server running on the LAN in demo mode and `EXPO_PUBLIC_API_BASE_URL` set, open the app in Expo Go on the Android phone, acknowledge the first-run disclaimer (confirm it is spoken once and not shown on the next launch), open Demo mode and run all 8 scenarios s1–s8. For each, confirm the DEMO DATA banner, the status badge text (s1 "Matches FDA registry", s2 "Label unreadable", s3 "Several possible matches", s4 "Does not match registry" with the row "500 mg on label, 250 mg Tablet in registry", s5 "No registry match", s6 "Not checked", s8 "Registry check unavailable"), that the summary auto-plays, and that Label fields, Verification and sources ("Registration certificate valid until") and Ask a question work; on s7 tap Ask a question, type "How many should I take for my headache?" and confirm the refusal is shown and spoken (Task 13 result and demo screens).
- NOT RUN — owner to perform: repeat the 8 demo scenarios with TalkBack on: every button is announced with its label and role, the status is announced as "Verification: …" when a result opens, answers are announced on the ask screen, and speech from the result screen stops when another screen is opened on top of it (Task 13 accessibility).
- NOT RUN — owner to perform: in Settings, switch on High contrast and each text size (Normal, Large, Extra large) and confirm the result, fields, sources and ask screens stay readable with no clipped buttons; confirm "Server mode" shows demo or live from the server (Task 13 settings).
