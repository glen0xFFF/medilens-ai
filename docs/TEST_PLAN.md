# MediLens AI — Test Plan

Automated suites run with `npm test`, `npm run typecheck` and `npm run lint` at the repo root
(contracts and server on Vitest, the mobile app on jest-expo).

## Manual device checks

These need the owner's Android phone (Expo Go, TalkBack). None has been run by the build agents.

- NOT RUN — owner to perform: in `apps/mobile`, run `npx expo start`, scan the QR code with Expo Go on the Android phone and confirm the app loads and shows "MediLens AI" (Task 11 scaffold).
- NOT RUN — owner to perform: copy `apps/mobile/.env.example` to `apps/mobile/.env` with `EXPO_PUBLIC_API_BASE_URL` set to the computer's LAN address, start the server, restart `npx expo start` and confirm the phone can reach the server (`/health`) once a screen calls it (Task 11 API client).
