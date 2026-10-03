# stations — Dev Log

**Status:** Published (onboarded 2026-10-02). Root `stations.html` is GENERATED from `source/index.html` by `patch.mjs` — never edit the root file.

## Now

## Next

## Done
- 2026-10-03 — source of truth moved here from Nic's private `_dev/stations/` (partner portal); `node partners/build.mjs jertal stations` reproduces the shipped `stations.html` byte-for-byte
- 2026-10-03 — flip the station (Tab / F / ⇅) while attaching an expansion pod (the build gated flipping on `canPlay()`, false in pod mode): pod-mode branches in keydown + bFlip, `setView` clears `podMode.key` so the ghost redraws on the new side
- 2026-10-02 — three.js 0.160 + addons load from the library's `./vendor/three-0.160.0/` (the patch rewrites the importmap) so the game starts offline; fonts still come from Google
- 2026-10-02 — UI scale for 1440p/4K (`--ui` zoom on the DOM chrome), global Endless Drift leaderboard (board id `stations`), onboarding: exit confirm, player chip, GameSDK stats + achievements, covers

## Notes
**A new build:** copy your `index.html` over `source/index.html`, then from the repo root:
```
node partners/build.mjs jertal stations
npm test
```
Every replacement in `patch.mjs` must match exactly once or it throws and names the anchor — fix that anchor
(or drop the replacement if your build now does the same thing itself).

**What the patch does.** The game is ONE `<script type="module">`, so nothing outside it can reach its functions:
the integration is a block inserted inside the module just before `applySettings(); showTitle(); tick();`.
- `ACT.exit` → the library's exit confirm (title button, pause menu and the 3D holo menu all route through ACT).
  Exit calls the game's own `exitGame()` (autosave + window.close).
- `persist()` calls `glSync()`, which derives stars_earned / stations_cleared / best_endless and the star / endless
  achievements from `SAVE`, so they back-fill from an existing save.
- `sfx` is wrapped: 'place' → modules_placed, 'merge' → landmarks_built + first_landmark, 'shot' → photographer.
- Flight School unlocks only on the tutorial's final step.
- Pause: Esc opens your pause menu; **P is photo mode**, so it is not bound to pause. Audio sliders are yours, untouched.
- Leaderboard: 🏅 button on the title menu + endless run report; posts on a new high score.
- `--ui` zoom: `zoom` multiplies vw/vh caps on zoomed chrome, so the patch restates them as `100vh / var(--ui)`;
  3D-anchored labels get `scale(glUi)` instead of zoom.

Achievement / stat ids must stay in step with `entry.json` (`npm test` checks both directions).
Nic's Electron screenshot harness for this game stayed in his `_dev/stations/tools/` (it needs his local static server).
