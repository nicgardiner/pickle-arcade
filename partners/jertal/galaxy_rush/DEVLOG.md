# galaxy_rush — Dev Log

**Status:** Published (onboarded 2026-10-15, not yet released). Root `galaxy_rush.html` is GENERATED from `source/galaxy-rush.html` by `patch.mjs` — never edit the root file.

## Now

## Next
- [ ] Live-test online co-op from the launcher (app ↔ app, app ↔ website); confirm Co-op Wins / Crew Goals land on both machines, and that a hosted room shows under OPEN ROOMS on the other client

- [ ] (Jertal) Fold the "Bug fixes in the game itself" block of `patch.mjs` into the source, then delete those rep() lines
- [ ] (Jertal) Daily challenge isn't the same run for everyone: the seeded `Math.random` is also eaten by particles/comics and per-frame `random()<dt*k` gates, so 60 Hz and 144 Hz players diverge after frame 1. Give gameplay its own seeded RNG
- [ ] (Jertal, low) Net ids `++NETID%32000+1` are shared by enemies/pickups/nodes and wrap; in a very long session a new id can collide with a long-lived entity and the joiner merges the two

## Done
- 2026-10-23 — SFX pass, in `patch.mjs`'s labelled "SFX pass" block: 18 new synth sounds (same tone/noise style) for what was silent: back/confirm/hover menu sounds, hover on pad focus too, deny on locked items; pause/resume; game-over sting (heart popped / give up), win on a joiner's victory screen, launch whoosh at run start; ready-to-warp chime, weather rumble, boss-kill fanfare; pod-hit clank, enemy hit tick, shield-break, respawn, ability-charged ping, pack-full blip; card deal, casino perk/upgrade/nothing results, astronaut rescue, comet got away; host chime on a player joining. Also defined the `ui` sound the game already called but never defined. Host sounds replay on joiners through the game's existing `netWrap('sfx')`; per-machine ones (hit tick, charged, menu sounds) are added to `SFX_SKIP`. Verified with offline renders (no audible output) plus click/pause/cards/pod-hit routing in the pane
- 2026-10-16 — co-op + small-stuff pass, all in `patch.mjs`'s labelled block. Co-op: the state channel's close now falls back to the reliable channel (both ends); a joiner silent >500 ms stops firing on the host; a late `hello` gets an astronaut (`mkOther`, split out of `hostStartGame`); dropped joiners are marked dead; `netLeave` resets per-session NET fields and closes the same-PC channel; `pagehide` → `netLeave`; the joiner's ability carries its own aim and is accepted while the host is in a menu (fires on resume; no longer counts toward the host's ult10). Small: tentacle double rise, trail particles per second not per frame, alarm angle 0, standard-mapping pad preferred and right stick only on it, pad menu repeat uses dt, `syncWorld` gets dt=0 while the run is frozen (not for joiners), skin swaps dispose merged geometry, heart shapes dispose their material. Verified with a two-tab same-PC session (fire timeout, ult aim during cards, late hello, drop, pagehide) and solo runs. The repair `repAcc` "debt" is honest fractional accounting (≤1 scrap), left as is; pets use cached materials, so no pet leak
- 2026-10-16 — code review (4 agents) + fixes in `patch.mjs`. Patch bugs: sparks/stars drew at 1/glUi size (`H*2` point-sprite scale), aim stale after a resize changed the scale, exit confirm swallowed keyup (stuck keys). Security: co-op lobby names went into innerHTML raw — now stripped. Game bugs (see the labelled block): PeerJS error mid-run threw the run away, "room full" message wiped, refused joiner's state channel threw, frame loop died on any exception, freeze/tractor never expired on special enemies (permanent Shatter bonus), heat shield overwrote the shielded affix, cosmetic buy jumped to Skins, rebound Build key couldn't close the shop, pad unplug locked aim, chests never drifted off
- 2026-10-15 — library room browser (LobbySDK discovery only, pattern 3): the co-op screen lists OPEN ROOMS (refreshed every 8 s + REFRESH button, JOIN feeds the code to `netJoin`); a public host with a free seat in the lobby advertises its bare code under `galaxy_rush`; "List this room publicly" checkbox on the host screen (session only, default on). `galaxy_rush` added to `ONLINE_MULTIPLAYER_GAMES` in preload.js
- 2026-10-15 — onboarded by Nic: three.js r128 + 7 addons from `./vendor/three-0.128.0/` (BufferGeometryUtils.js newly vendored); exit confirm on the title's EXIT GAME and the pause menu's QUIT GAME; player chip on the title; `--ui` zoom for the DOM menus and the canvas HUD; GameSDK stats + achievements mirrored from the hangar save; covers (illustrated default + Heart-pod minimalist)

## Notes
**A new build:** copy your `galaxy-rush.html` over `source/galaxy-rush.html`, then from the repo root:
```
node partners/build.mjs jertal galaxy_rush
npm test
```
Every replacement in `patch.mjs` must match exactly once or it throws and names the anchor.

**What the patch does.**
- A small script right after `<div id="ui">`, BEFORE the game script: exit confirm (`glExitShow`), player chip (polls `state === 'title'`), `--ui` scale exposed as `glUi()`. It must stay before the game script: the game's first `resize()` calls `glUi()`, and its capture keydown blocks game keys while the confirm is open.
- HUD scale: the game draws its canvas HUD at a hard-coded 2 px per unit; the patch makes that `2 * glUi()` in three places (`W=iw/2;H=ih/2;`, `ctx.setTransform(2*DPR…)`, `mouse.x=e.clientX/2…`). If a build adds another `/2` HUD mapping (touch, gamepad cursor) it needs the same treatment.
- `quitGame()` opens the confirm (its old body is left unreachable); the title's QUIT button is relabelled EXIT GAME with id `gl-exit-btn`.
- Stats/achievements: one script after the game that wraps `saveMeta` (mirrors `meta.runs/wins/totalKills/bestHeat/ach` — back-fills from an existing save), `endRun` (host of a co-op room with ≥1 joiner) and `clientOver` (joiner) for `online_wins` + `crew_goals`. Co-op is shared, so both seats win together — no seat gating needed.
- The game's own audio settings (Music + Sound volume in OPTIONS, from the title and the pause menu, saved in `SET_KEY`) and its own P/Esc pause already meet the standard; nothing added. Its save key `xenocrawler_space_v1` is unchanged.
- Room browser: a second appended script wraps `showMP` (injects `#gl-rooms` after `.mpcs` on the join screen, the public checkbox before START on the host screen, then reconciles the ad), `netLeave` and `hostStartGame`. The ad is up only while `NET.role==='host'`, peer open, not same-PC mode, not private, `state==='mp'` and lobby < 4. The list updates in place so a half-typed room code isn't wiped.
- Game bug fixes (2026-10-16 review) sit in their own labelled block in `patch.mjs`; each one throws once Jertal's source has the fix, which is the cue to delete it. The point-sprite scale (`const scale=H*2*.9`) is a HUD-scale casualty like the three `/2` mappings: it is window height, not HUD units.
- Covers are generated by `work/make-default.mjs` + `work/make-minimalist.mjs` (`work/` is gitignored).
