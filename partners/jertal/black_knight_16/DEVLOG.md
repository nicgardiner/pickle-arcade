# black_knight_16 — Dev Log

**Status:** Published as an external release asset (`game-black-knight-v1`). Updates go through `SUBMISSION.json` — see README.md.

## Now

## Next

## Done
- 2026-10-03 — partner folder created (partner portal): entry.json, covers, README.md, get-current.mjs

## Notes
The shipped build is byte-identical to the release asset (sha256 in `entry.json`). Its Forge confirm has confirm-on-left,
against the library's cancel-left / confirm-right rule — it was left alone because changing it needs a new build from you.
React/Babel load from unpkg, so the game needs internet; bundling them is a candidate for your next build.
