# blackout — Dev Log

**Status:** Published (onboarded 2026-10-02). Root `blackout.html` is GENERATED from `source/index.html` by `patch.mjs` — never edit the root file.

## Now

## Next
- [ ] Live-test the library room browser (app ↔ app, app ↔ website)

## Done
- 2026-10-03 — source of truth moved here from Nic's private `_dev/blackout/` (partner portal); `node partners/build.mjs jertal blackout` reproduces the shipped `blackout.html` byte-for-byte
- 2026-10-03 — library room browser (LobbySDK discovery only): the radio TV has Room visibility (PUBLIC default / PRIVATE, session only) and OPEN ROOMS (refetched at most every 8 s while the radio is drawn); a public, non-full host advertises its bare code under `blackout`
- 2026-10-02 — three.js r128 + its six post-processing files load from the library's `./vendor/three-0.128.0/` (starts offline); PeerJS stays on cdnjs (online play only)
- 2026-10-02 — covers: v2 Default (art lifted, facility map below), your original cover kept as `covers/blackout.classic.svg`
- 2026-10-02 — onboarding: exit confirm, player chip, `--ui` zoom for the HUD/panels on 1440p/4K, GameSDK stats + achievements mirrored from the operator file

## Notes
**A new build:** copy your `index.html` over `source/index.html`, then from the repo root:
```
node partners/build.mjs jertal blackout
npm test
```
Every replacement in `patch.mjs` must match exactly once or it throws and names the anchor — fix that anchor
(or drop the replacement if your build now does the same thing itself).

**What the patch does.** One classic `<script>` (not a module), so its top-level functions are reachable from other scripts.
- A small script BEFORE the game script: exit confirm (`glExitShow`), player chip (main menu only, `body.in-menu`), `--ui` scale.
  It must stay before the game script: its capture keydown has to run ahead of the game's own capture listeners.
  Overlay mousedown is stopped so the 3D terminal underneath (window mousedown → `menuClick`) never sees it.
- The terminal's QUIT row and the pause menu's QUIT GAME both open the exit confirm (there is no separate exit button).
- A script AFTER the game script wraps `saveMeta()` and derives every stat/achievement from `meta`
  (meta.stats + the game's own `meta.achievements`), so they back-fill from existing saves. Skipped while
  `net.viewingHost` (that is the co-op host's file). `online_wins` = `meta.stats.dmWins`.
- Old Hand = 5 escapes and Exterminator = 200 kills (Nic's thresholds; the game's own are 10 / 500).
- Room browser: `glNetAd` / `glNetRooms` use `LobbySDK.advertiseRoom` / `listRooms` for discovery only; the netcode
  (PeerJS 5-letter codes) is yours, unchanged. That is why `blackout` is in preload's ONLINE_MULTIPLAYER_GAMES.
- Pause: your Esc pause menu is kept; **P cycles the pixel size**, so it is not bound to pause. Audio sliders untouched.

Achievement / stat ids must stay in step with `entry.json` (`npm test` checks both directions).
Nic's Electron harness + cover pipeline for this game stayed in his `_dev/blackout/` (it needs his local static server).
