# Jertal — partner contract

This folder is yours, Jeremy. You (and your Claude) may change anything inside `partners/jertal/`
and nothing outside it. Setup, the update loop and review are in `partners/README.md`; this file is
the rulebook for the folder itself.

## Your games

| Id | Title | Kind |
|---|---|---|
| `stations` | Stations | bundled |
| `blackout` | Blackout | bundled |
| `roblins` | Roblins | bundled |
| `starfall` | StarFall | bundled |
| `pippin` | Pippin | bundled |
| `black_knight_16` | Black Knight | external release asset — different flow, see below |

## Folder layout

```
partners/jertal/<gameId>/
  source/              your build, exactly as you ship it — no Pickle code in here
  patch.mjs            the Pickle integration layer: turns source/ into the root game file
  entry.json           the game's games.json entry, exactly as it appears there
  covers/              cover files, copied verbatim to root covers/
  DEVLOG.md            the game's running log (read first, update last)
  REQUEST-NOTES.md     optional: notes for Nic, prefilled into the Request update form
  ONBOARDING-PREVIEW.md  only in a new-game draft (written by partners/onboarder/SKILL.md)
  work/                scratch space, gitignored — never committed
```

- **`source/`** — your untouched game. Drop a new build in here, replacing the old one. Keep it
  free of Pickle integration: that is `patch.mjs`'s job, so a fresh build never loses it.
- **`patch.mjs`** — run as `node partners/jertal/<gameId>/patch.mjs <outFile>`. It reads `./source/`
  relative to its own file, applies the integration, and writes `<outFile>` (the build passes the
  root `<fileName>`). See "The integration layer" below.
- **`entry.json`** — the exact object that goes into root `games.json`: title, description, tags,
  stats, achievements, cover config, window size. Keep its key order and pretty-printing. `id` must
  equal the folder name, `party` must be `"third"`, `developer` must be `"Jertal"`, and `fileName` is
  a bare lowercase file name (no folders).
- **`covers/`** — every file here is copied as-is into root `covers/`. Every game needs
  `<id>.svg` (the active cover) and `<id>.default.svg`; `<id>.minimalist.svg` and
  `<id>.classic.svg` are optional variants. Covers are SVG; a painted cover is embedded as a WebP
  data URI inside an SVG `<image>` (see the existing files). An SVG must be valid XML: no `--` inside
  a comment, no bare `&`, no `<script>`.

### Generated files — never edit by hand
`node partners/build.mjs jertal [<gameId> ...]` produces, from your folders:
- the root game file for each bundled game (`stations.html`, `blackout.html`, `roblins.html`,
  `starfall.html`, `pippin.html`),
- the matching files in root `covers/`,
- your entries inside root `games.json`.

A hand edit to any of these is overwritten by the next build, and CI fails a PR whose committed
outputs differ from what your folder builds. Change the folder, rebuild, commit both.

## The integration layer (`patch.mjs`) — yours to keep working

`patch.mjs` belongs to you, the same as `source/`. When a new build moves code that `patch.mjs`
anchors on, the build fails and you fix `patch.mjs`. It carries everything that makes your game a
Pickle Arcade game:

- **Player chip** — `#gl-player-chip` on the title screen: emblem + name from the URL query
  (`playerName`, `playerEmblem`), set with `textContent` only, fully hidden when `playerName` is absent.
- **Exit confirm** — `#gl-exit-btn` opens `#gl-exit-confirm`; `#gl-exit-yes` calls `window.close()`,
  `#gl-exit-no` and Escape cancel. Games run fullscreen with no window frame, so this is the
  player's way out. Never a native `confirm()`.
- **Pause** — real-time games pause on Escape and P (never during an online match, never while the
  exit confirm is open).
- **GameSDK stat/achievement calls** — see the contract below.
- **`--ui` zoom** — fixed-pixel menus/HUD are scaled on 1440p/4K screens with a CSS `zoom:var(--ui)`
  on the chrome only (never on the canvas the game fits to the window).
- **Audio settings** — volume slider(s) reachable from the main menu and the pause menu, through
  one master gain, saved in localStorage.
- **Vendored engine paths** — engine `<script src>`/import-map URLs rewritten to `./vendor/…`.
- Game-specific glue where it exists (Stations' leaderboard panel, StarFall's LobbySDK adapter).

How it is written: each change is an exact string replacement that must match **exactly once**,
or the script throws — so a moved anchor fails loudly instead of silently dropping a feature:

```js
function rep(from, to) {
  const n = h.split(from).length - 1;
  if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${from.slice(0, 80)}`);
  h = h.replace(from, () => to);
}
```

Keep anchors small, and keep the bulk of the integration in one appended `<script>` after the
game's own code that wraps or observes your functions. When a fix belongs in the game itself, put
it in `source/` rather than in `patch.mjs`.

**Always feature-check the SDKs** (`if (window.GameSDK) …`, `if (window.LobbySDK) …`). The page
also runs where they don't exist — opened as a plain file — and a bare `GameSDK.setStat(...)` there
throws out of your game loop and freezes the game.

## What CI enforces on your PRs

- Every changed path is under `partners/jertal/`, or is one of your generated outputs.
- `node partners/build.mjs jertal --check` passes: the committed outputs match your folder.
- Every `games.json` entry that isn't yours is unchanged; a new game doesn't reuse an existing id or
  file name; no published game's folder is deleted (removing a game is Nic's call).
- `npm test` passes (a separate "library" job; on an onboarding PR it can stay red until Nic adds a
  `preload.js` allowlist entry or a `vendor/` file for you). For your games that means, among other checks: `entry.json` has the required
  fields; the root file exists with exactly the `fileName` case; `covers/<id>.svg` and
  `covers/<id>.default.svg` exist and are valid; every inline `<script>` parses; the file ends with
  exactly one `</html>`; the GameSDK contract below holds; no engine loads from a CDN.
- Warnings for Nic's review (they don't fail the PR): a new `electronAPI`, `ipcRenderer`, `require(`,
  `child_process`, `process.`, `eval(`, `new Function`, http(s) host, or localStorage key outside
  `gl_<gameId>_*` in a file you changed. If one of these is intentional, say why in Notes & extras.

## GameSDK contract — stats and achievements

The launcher provides `window.GameSDK` to every game:

```js
GameSDK.setStat('best_score', score)          // set
GameSDK.setStat('best_score', score, true)    // keep the max
GameSDK.incrementStat('total_runs')           // +1
GameSDK.incrementStat('coins_earned', 5)      // +N
GameSDK.getStats()                            // current stats object
GameSDK.unlockAchievement('first_win', 'First Win')   // idempotent
```

Stats and achievements are declared in `entry.json` (`stats`: `{ key, label, format }` with format
`number`, `seconds` or `fraction` + `total`; `achievements`: `{ id, label, desc, icon }`). `npm test`
enforces:

1. **Ids and stat keys are string literals at the call site.** The verifier reads the source. A
   computed key is allowed only when every value it can resolve to is declared.
2. **Declared ⇄ used, both ways.** Every achievement id passed to `unlockAchievement` and every
   literal key passed to `setStat`/`incrementStat` must be declared in `entry.json`; every declared
   id and key must appear in the game. Internal bookkeeping you don't want on the card must use a
   computed key, not a literal.
3. **Global achievements** (library-wide ids in `games.json`'s `globalAchievements`, e.g.
   `online_first_match`) go through `GameSDK.unlockGlobalAchievement('<id>')`, never
   `unlockAchievement`.
4. **Online games: gate every win-based stat and achievement to the local seat.** Both clients run
   the same end-of-game code, so an ungated `if (winner) unlock…` fires on the loser's machine too.
   Compare the winning seat to the seat this client actually plays (the host/guest seat from your
   netcode, or the human seat against a bot).
5. **An online game writes exactly one of `online_wins` or `mp_wins`** on an online win (gated per
   rule 4). The launcher's global "Online Victory" achievement reads either one.

Stats and achievements live under `gl_<gameId>_stats` / `gl_<gameId>_achievements`, which the
launcher owns — never write those keys yourself. Keep your games' existing save keys
(`stations-v1`, `lightsOutLab.*`, `gobjob.*`, `starfall.*`) unchanged: renaming one loses every
player's save. CI's localStorage warning is informational; mention a new key in Notes & extras.

## Vendored engines

Every 3D/physics engine ships inside the app in root `vendor/`, so games start offline. Games load
it as **`./vendor/…`** — always the `./` prefix, never a leading `/`, never a CDN URL:

```html
<script type="importmap">
{ "imports": { "three": "./vendor/three-0.160.0/build/three.module.min.js",
               "three/addons/": "./vendor/three-0.160.0/examples/jsm/" } }
</script>
<script src="./vendor/three-0.128.0/build/three.min.js"></script>
```

Available today: `vendor/three-0.160.0/` (ES module build + the `examples/jsm` addons in use),
`vendor/three-0.128.0/` (classic build + `examples/js` addons), `vendor/cannon-0.6.2/`. Your source
can keep its CDN URLs; `patch.mjs` rewrites them. `npm test` fails any game that loads three.js or
cannon from a CDN, or references a `./vendor/…` file that doesn't exist. Need a different version or
an addon that isn't there? `vendor/` is outside your folder — ask in Notes & extras. Google Fonts and
PeerJS may stay on their CDNs.

## Leaderboards and online multiplayer

A global leaderboard (`LeaderboardSDK`) or the shared online lobby (`LobbySDK`) only reaches a game
whose id is in an allowlist in `preload.js` (`LEADERBOARD_GAMES`, `ONLINE_MULTIPLAYER_GAMES`), and
`npm test` fails a game that references either SDK without being listed (or is listed without
referencing it). Only Nic edits `preload.js`, so:

- Keep existing integrations working (Stations' leaderboard, StarFall's online lobby).
- To add one to another game, ask in **Notes & extras**. Nic adds the allowlist entry; your PR adds
  the game-side code.
- In partner mode leaderboard posts are no-ops, so your test runs never hit the live board.
- Blackout and Roblins run their own PeerJS netcode and don't use `LobbySDK`; rule 4 above still
  applies to them.

## Black Knight (`black_knight_16`)

Black Knight isn't bundled: it is a separate GitHub release asset the launcher downloads on demand,
so its folder has no `source/` or `patch.mjs`. Its flow — fetching the current build, submitting a
new one through `SUBMISSION.json` — is described in `partners/jertal/black_knight_16/README.md`.

## Asking for things outside this folder

Allowlist entries, `vendor/` additions, launcher tweaks, new tags, questions: put them in
`REQUEST-NOTES.md` (it prefills the request form) or straight into the PR's **Notes & extras**.

## For your Claude

These are the working rules for any Claude session in this repo. Nic's own `CLAUDE.md` is not in
the repo; this section replaces it for partner work.

1. **Stay inside `partners/jertal/`.** Never edit a root file by hand — the root game files,
   `covers/` and `games.json` entries for these games are generated, and everything else at the
   root belongs to Nic. Scratch files go in the game's `work/` folder (gitignored).
2. **Read the game's `DEVLOG.md` first** — before searching the code or asking what state it's in.
3. **After every change, rebuild and verify:**
   ```bash
   node partners/build.mjs jertal <gameId>
   npm test
   ```
   `npm test` must pass before you hand back. If `patch.mjs` throws `expected 1 match`, an anchor
   moved in the new source: fix the anchor in `patch.mjs`, don't edit the output.
4. **Keep the integration layer intact.** Player chip, exit confirm, pause, GameSDK calls, `--ui`
   zoom, audio settings and `./vendor/…` paths must all still work after your change. Follow the
   GameSDK contract above when adding or changing stats/achievements, and update `entry.json` in the
   same change.
5. **Write anything for Nic into `REQUEST-NOTES.md`** in the game folder: what changed, anything that
   needs a change outside this folder, anything he should test. The launcher's Request update form
   prefills from it.
6. **Update `DEVLOG.md` last:** move finished items into `## Done` with today's date (newest first),
   refresh `**Status:**`, and put anything a future session would waste time rediscovering into
   `## Notes`. Keep its shape — the launcher parses it:
   ```markdown
   # <gameId> — Dev Log

   **Status:** one line on where this stands right now

   ## Now
   - [ ] what's actively being worked on

   ## Next
   - [ ] planned, not started

   ## Done
   - 2026-10-03 — what got finished, newest first

   ## Notes
   Free text: decisions, gotchas, verification commands.
   ```
7. **Onboarding a new game** follows `partners/onboarder/SKILL.md`, and stops at
   `ONBOARDING-PREVIEW.md` for Jeremy's review.
8. **No `npm install --save`** of anything: the app's runtime dependencies are fixed and `npm test`
   fails on a new one. Inline small libraries into the game instead.
