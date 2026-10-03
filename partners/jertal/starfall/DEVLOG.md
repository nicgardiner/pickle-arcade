# starfall — Dev Log

**Status:** Published (onboarded 2026-09-30). Root `starfall.html` is GENERATED from `source/starfall-standalone.html` by `patch.mjs` — never edit the root file.

## Now

## Next
- [ ] Live-test online over real PeerJS: app ↔ app and app ↔ website (lobby → crown pick → a full game → rematch → leave)
- [ ] Left deliberately (Nic's call, 2026-09-30): host doesn't validate guest prompt answers (dupes, min/max, option index) or declare mode; a double-click can send two resumes; Kaede's log line names the card taken into hand

## Done
- 2026-10-03 — source of truth moved here from Nic's private `_dev/starfall/` (partner portal); `node partners/build.mjs jertal starfall` reproduces the shipped `starfall.html` byte-for-byte
- 2026-09-30 — online guest gets weather (fxInit on the first state snapshot of each game)
- 2026-09-30 — rules/AI pass and review fixes, all in `patch.mjs` (Emira's discount covers star pieces, Ryogen's star-cost tax removed, 80-turn draw only AI-vs-AI, White Lions/Oni read P.prevCard, Jarl shuffles only the discard, Taraldon's 4★ bonus survives lit power tiers, host validates guest resolveDefense, hotseat pass screen opaque, …)
- 2026-09-30 — online moved onto the library's LobbySDK (legacy 1-1 pattern): Play online opens the room browser; Direct Connect stays the fallback when the SDK is absent (standalone file)
- 2026-09-30 — onboarding: exit confirm, player chip, volume sliders, menu hover, 5 stats + per-king win stats, 8 achievements, covers (yours as Classic)

## Notes
**A new build:** copy your standalone HTML over `source/starfall-standalone.html`, then from the repo root:
```
node partners/build.mjs jertal starfall
npm test
```
Every replacement in `patch.mjs` must match exactly once or it throws and names the anchor — fix that anchor
(or delete the replacement if your build now does the same thing itself). The source is ~15 MB; git stores it
byte-for-byte (`-text` in `.gitattributes`), so don't worry about line endings.

**Online:** the patch's GLUE builds a stand-in data channel (`send`/`close` → LobbySDK, `onopen`/`onmessage`/`onclose`
fired from the SDK callbacks) and hands it to your `netBind`, so all your netcode (redacted snapshots, guest `do`
requests) runs unchanged. Messages sent before onConnected are buffered, not dropped.

**Stats:** hooks live in one `<script>` after the game's own: `render` is wrapped and `watch()` runs after each render.
Seat = 0 vs AI, NET host 0 / guest 1; hotseat only counts games_played. Per-king win stat keys are a literal map
(`WIN_KEYS`) because `npm test` only sees literal stat keys. Turn-based, so no P-pause; Esc already opens your pause.

Achievement / stat ids must stay in step with `entry.json` (`npm test` checks both directions).
Nic's cover renderer (`shoot-cover.js`) stayed in his `_dev/starfall/tools/`.
