# Parity recorder (Node side)

These scripts recorded the golden corpora in `fixtures/parity/` from the Node
build: they import `apps/server`, which was removed from the tree after the Go
port reached parity (task G12).

On the current tree these scripts no longer compile (their imports point at
the removed server), so they are left out of the root `npm run typecheck`.
They are kept as the record of how each corpus was made, and as the way to
re-record one (Go port spec §6.5: fix the TS first, then re-record).

## Re-recording

Do **not** check out the whole tag `node-fallback-v1`. The tag points at
`ea97cd6`, which predates the Go port: it has no `scripts/` directory, and its
root `package.json` has no `parity:record` script. A whole-tree checkout of it
has no recorder, and `npm run parity:record` fails with a missing-script error.

Instead, restore only `apps/server` from the tag onto the current branch. The
Node server is unchanged between the tag and the last commit that still had
it (`git diff --stat ea97cd6 3e14a2f -- apps/server` prints nothing), so this
is the same reference build. From the repository root:

```
git -c core.autocrlf=false checkout node-fallback-v1 -- apps/server
npm install
npm run parity:record
```

- `-c core.autocrlf=false` keeps the restored files byte for byte (LF).
  `record-providers.ts` copies the Node provider fixtures byte for byte, so a
  CRLF checkout (Windows, `core.autocrlf=true`) rewrites
  `fixtures/parity/providers/**` with CRLF endings.
- `npm install` brings back the server's dependencies through the `apps/*`
  workspace, including `tsx`, which the root `parity:record` script runs.
- `npm run parity:record` writes the corpora `fixtures/parity/*.jsonl`. The
  other recorders run the same way with `npx tsx scripts/parity/<name>.ts`
  (`go-probes`, `go-probes-answers`, `record-images`, `record-cmyk-lut`,
  `record-providers`, `record-question-limits`). See
  `fixtures/parity/README.md` for what each one writes and the file formats.

If the re-recording follows a fix to the TS (spec §6.5), make that fix in the
restored `apps/server` before recording. The restored server is discarded
below, so describe the TS fix in the commit that carries the new corpora.
When done, discard the restored server and the lockfile change:

```
git rm -r -q -f apps/server
git checkout -- package-lock.json
npm install
```

The last `npm install` prunes the server's dependencies again. It fails with
`EBUSY` (or warns `EPERM`) if a Node process still has sharp loaded from
`apps/server`; stop that process first.

On 2026-10-28 (task G12 review round 1) this procedure was run on
`feat/go-port` at `174d8cb`: `npm run parity:record` (3116 server tests
passed) and the six `npx tsx` recorders above all exited 0, and
`git status` showed no change under `fixtures/` or `internal/*/testdata`.
A first run without `-c core.autocrlf=false` rewrote the 12 files under
`fixtures/parity/providers/muse` and `phfda` with CRLF endings (no other
change), which is why the flag is there. The final `npm install` failed with
`EBUSY` on sharp's `.node` file, held by a Node dev server started from
`apps/server` on 2026-10-27, so that machine's `node_modules` still has the
server's packages as extraneous; the lockfile and the tracked tree are clean.
