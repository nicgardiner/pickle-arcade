# roblins — Dev Log

**Status:** Published (onboarded 2026-10-02). Root `roblins.html` is GENERATED from `source/` (index.html + data.js + sim.js) by `patch.mjs` — never edit the root file.

## Now

## Next
- [ ] Fold the bug fixes the patch carries into your own code (Notes → "Fixes carried by the patch"); each one's anchor then stops matching and its `rep()` gets deleted
- [ ] Live-test crew co-op + the library room browser (app ↔ app, app ↔ website), incl. a PeerJS broker reconnect
- [ ] Pick from the open review suggestions (Notes)

## Done
- 2026-10-03 — source of truth moved here from Nic's private `_dev/roblins/` (partner portal); `node partners/build.mjs jertal roblins` reproduces the shipped `roblins.html` byte-for-byte
- 2026-10-03 — library room browser (LobbySDK discovery only): Crew page has a Public crew checkbox (default on; session only) and an Open crews list; a public, live, non-full host advertises its bare code under `roblins`
- 2026-10-03 — six improvements in the patch: crew-join Cancel + "Aboard, waiting for the host"; Frenzy tag revived; Records.load defaults every field; PeerJS reconnect on broker drop; 12 s client watchdog (host gone); item models cached per kind and cloned
- 2026-10-02 — code review: 10 bug fixes added to the patch (listed in Notes)
- 2026-10-02 — onboarding: data.js/sim.js inlined, three r128 → `./vendor/three-0.128.0`, Quit → exit confirm, P pause, player chip, `--ui` zoom for HUD + title sign, stats/achievements derived from the game's saves, covers

## Notes
**A new build:** copy your `index.html`, `data.js`, `sim.js` into `source/`, then from the repo root:
```
node partners/build.mjs jertal roblins
npm test
```
Every replacement in `patch.mjs` must match exactly once or it throws and names the anchor — fix that anchor
(or delete the replacement if your build now does the same thing itself).

**What the patch does.**
- data.js and sim.js are inlined (the launcher and website ship one HTML per game). Throws if either ever contains `</script`.
- A script BEFORE the game scripts: exit confirm (`glExitShow`, styled as one of the sign's `.page`s, outside `#menu`),
  player chip (top-right, title only), P key, `--ui` scale. Its capture keydown must stay ahead of the game's listeners.
- The sign's own Quit plank opens the exit confirm.
- Pause: the game pauses on pointer-lock loss (Esc). P = `exitPointerLock()` while playing, `#resume.click()` while paused.
- Stats/achievements: `Records.save` and `saveUnlock` call `glSync()`, which re-reads `gobjob.records` + `gobjob.unlocks`
  with keepMax, so they back-fill from existing saves. Cosmetic unlocks drive five achievements (earring = Cut paid,
  eyepatch = died, crown = Frenzy beats the Cut, nemes = sarcophagus lid, bloodglass = Blood Moon). Crew clients only keep deaths.
- `--ui` zoom on the DOM HUD + sign/pages/hint. `#bars`/`#holdBar`/`#micMeter` are NOT zoomed (the game sizes them with `pixScale()`).
- Room browser: `glAd` / `glRooms` use `LobbySDK.advertiseRoom` / `listRooms` for discovery only; the crew netcode is
  yours, unchanged. That is why `roblins` is in preload's ONLINE_MULTIPLAYER_GAMES.

**Fixes carried by the patch** (bug fixes in your code that live in `patch.mjs` so every build keeps them):
monsters freezing in a blocking prop's cell (flowField `from`); Ranger arrow hitting through walls/shut doors; two crabs
carrying one item; noise sounds cut short + clicking (non-looping 2 s buffer at a random offset → `s.loop = true`); Spore
Phantom + arrow geometry never disposed; Ranger mic stream never stopped on off; voice mic left live after leaving a crew /
unticking voice (new `Voice.stop`); denied voice mic re-requested on every ring; roster lost by goblins who joined while the
host was on the title; a pending crew client could start a solo night that saved nothing. Plus the 2026-10-03 improvements block.
Under `?net=local` a join says "Aboard" even with no host (BroadcastChannel can't tell).

**Review suggestions (still open)** — EASY: Giant/Gashadokuro grab ignores flash-powder blindness (every other melee
monster respects it — your call); clear `$('error')` on a successful pointer lock; positional `Sound.crackle` for warren
torches; sand/sandstone footstep sounds; cap Knight-spot retries; treasureSpot distance check from goblins.
MEDIUM: auto-drop tools when lifting two-handed loot; `buy` with full hands → put it on deck; prune dead monsters from state.monsters.

Achievement / stat ids must stay in step with `entry.json` (`npm test` checks both directions).
`GOBDEV.capture` posts to 127.0.0.1:8178 — a dev hook, only when called. Nic's Electron harness + cover pipeline stayed in his `_dev/roblins/`.
