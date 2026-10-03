# pippin — Dev Log

**Status:** Published. Root `pippin.html` is GENERATED from `source/pippin.html` by `patch.mjs` — never edit the root file. The source is a RECONSTRUCTION (see Notes) until your next real build replaces it.

## Now

## Next
- [ ] Send your current Pippin build: drop it over `source/pippin.html`, run the build, fix whatever anchor throws
- [ ] The Sell confirm (`#sellConfirm`, shop) still has Sell on the left; the library rule is cancel left / confirm right (the New Run confirm is swapped by the patch)

## Done
- 2026-10-03 — converted to the patch-script model and moved here (partner portal). Before this, Pippin was hand-patched in place. `source/pippin.html` = the shipped file with the library layer taken out; `patch.mjs` puts it back; `node partners/build.mjs jertal pippin` reproduces the shipped `pippin.html` byte-for-byte
- 2026-10-02 — three.js r128 + cannon.js 0.6.2 load from the library's `./vendor/` (starts offline)
- 2026-09-24 — (shipped in v1.1.6) GPU-reset guards (blank cards/dice after sleep/resume; black liquid background)
- 2026-09-18 — UI scale for 1440p/4K (`--ui` zoom on the DOM chrome of both documents)

## Notes
**A new build:** copy your build over `source/pippin.html`, then from the repo root:
```
node partners/build.mjs jertal pippin
npm test
```
Every replacement in `patch.mjs` must match exactly once or it throws and names the anchor — fix that anchor
(or delete the replacement if your build now does the same thing itself).

**How source/pippin.html was made (2026-10-03).** No untouched copy of your build was kept, so the source was derived by
running every `patch.mjs` replacement backwards over the shipped `pippin.html`. What came out (= what `patch.mjs` adds):
- shell `<head>`/`<body>`: player chip + exit confirm CSS and DOM, the "PICKLE UI SCALE" `--ui` style + setUiScale script
- New Run confirm buttons put back to confirm-first (the library swapped them to cancel-left)
- round template: three.js / cannon.js CDN URLs (→ `./vendor/`), the GPU-reset `getContext` guard, the liquid background's
  `initGL()` refactor + `webglcontextlost/restored` handlers, the "PICKLE UI SCALE" style twin + `setUiScale()` in `resize()`
- map/shop Gold plates: `margin-top:22px` + their two comments (clearance under the top-right buttons — not certain this
  was ours rather than yours; if your build has it, delete those two replacements)
- round messages: `togglePause` gated on `__glExitOpen`, the `glExit` message
- round keydown: exit-confirm gate, input-field guard, P as a second pause key (yours was Escape only)
- shell script: `glSet/glInc/glAch/glFloor/glSyncChallenges` + every call site (freshRun, onRunWon, boot, advanceStage,
  gameOver, the roundWon handler), `glChipVis` in `post()`/`setActive()`, `menuLeave` → exit confirm (yours called
  `closeGame()` directly), the `glExitCancel` message, the chip + exit-confirm block
- shell keydown: exit-confirm gate, input-field guard, P (yours was Escape only)
Comments on the lines that changed (e.g. "Escape forwarded from the shell") are best guesses at your originals.

**Architecture:** two documents in one file — the SHELL (top-level page: run state DC, chip, exit confirm, stats) and the
ROUND scene, a whole HTML page inside `<script id="tpl-round" type="text/html">` mounted as the `#f-round` iframe's srcdoc
(so its script tags close as `<\/script>`). They talk over postMessage. GameSDK is injected into the shell only, so every
stat/achievement call lives there. Saves: `dicero.run.v1`, `dicero.challenges.v1`, `dicero.standard.v1`.
`GL_CHAL_TOTAL` (12) must match the number of challenges and entry.json's `challenges_done` total.

Achievement / stat ids must stay in step with `entry.json` (`npm test` checks both directions).
