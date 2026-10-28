# MediLens AI — Privacy

Safety rules (what the AI decides, the question gate, honesty rules) are in
[SAFETY.md](SAFETY.md).

## Photos

- **Photos are never stored.** On the phone, photos exist only as temporary files in the app's
  cache directory until upload and are deleted after upload or on cancel; the app never writes
  to the photo gallery.
- On the server, uploads are read only through `MultipartReader` into memory: no
  `ParseMultipartForm`, `FormValue` or `FormFile`, which can spill to temporary files. A guard
  test points the temp directory at an empty folder and checks it stays empty. Images are
  normalised in memory and discarded when the analysis has read them.
- The MCP tools take images as base64 in the call and do not store them either.

## Results

- Analysis results (read text, match, summary) and their progress events are held **in server
  memory for 15 minutes** so follow-up questions work, then dropped. The store holds at most 500
  analyses (oldest evicted). There are no accounts, no scan history and no database.
- An analysis id is a random UUIDv4 and is the only capability to read it (the MVP ownership
  model; there are no accounts).
- `DELETE /api/v1/analyses/{id}` drops a result and its events at once. The app calls it when the
  user leaves a result (best effort).
- On the phone only settings (speech rate, contrast, text size) and the disclaimer
  acknowledgement are saved.

## Logs

- Server logs are `slog` JSON. The access log carries method, route pattern, status, duration
  and request id only.
- Image bytes, request bodies, read text, raw text, evidence, questions and keys are never logged:
  domain types log whitelisted fields only, and a redaction step replaces `rawText`, `question`,
  `evidenceText` and `authorization` if they ever reach a log call. Provider failures are logged
  by error kind and HTTP status only, never a response body.
- The smoke and eval commands print counts and metadata only; the eval writes aggregate counts
  only to `docs/eval-results.md` (photos and pack identities stay on the owner's machine).

## What leaves the server

- With `MODEL_PROVIDER=muse_spark`, the photos are sent to the **Meta Model API** for
  transcription, and one printed field may be sent for an explanation. Meta's commitments page
  says content from Standard services is not used to train Meta models; content is retained "as
  needed" with no fixed period (see [MUSE_SPARK_INTEGRATION.md](MUSE_SPARK_INTEGRATION.md)). A
  response from a Contributor model (which Meta may train on) is discarded, but the photo was
  still sent in that request.
- With `REFERENCE_PROVIDER=ph_fda`, the PH FDA lookup sends only a registration number or a
  normalised product name.
- With the defaults (`mock` + `fixture`), nothing leaves the server.

## Secrets

- The Meta Model API key lives only in the server environment (`MODEL_API_KEY`, in a git-ignored
  `.env` or the host's secret settings). It is held as a `config.Secret`, which prints
  `[redacted]` in every format, and configuration errors name the variable, never its value.
- MCP bearer tokens (`MCP_API_TOKENS`) are server-side too; only their SHA-256 hashes are kept in
  memory.
- The mobile app contains no keys and only talks to the MediLens API.
  `EXPO_PUBLIC_API_BASE_URL` is a public URL, not a secret.
- A secret scan is part of the submission checklist; the latest result is in
  [TESTING.md](TESTING.md).
