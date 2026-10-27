# Parity recorder (Node side)

These scripts recorded the golden corpora in `fixtures/parity/` from the Node
build: they import `apps/server`, which was removed from the tree after the Go
port reached parity (task G12).

**Re-recording needs `git checkout node-fallback-v1` first** (ruling R4): that
tag has the Node server and its dependencies. Then `npm install` and
`npm run parity:record`. See `fixtures/parity/README.md` for the format.

On the current tree these scripts no longer compile (their imports point at
the removed server), so they are left out of the root `npm run typecheck`.
They are kept as the record of how each corpus was made.
