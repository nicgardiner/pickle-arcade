# `test/` — the library verifier

One file, `verify.mjs`. It is a **static audit of the shippable tree**: it never
launches Electron, never opens a browser, never touches the network, and has
**no npm dependencies** — it must run on a machine with no `node_modules`,
because the GitHub Pages workflow runs it without `npm ci`.

It exists because every scripted finding of the 2026-09 audit — achievement ids
a game unlocked but never declared, a stat declared but never written, a cover
filename whose case only worked on Windows, an unused 150 MB dependency riding
along in every installer — went out through several releases with nothing in
the project able to notice.

## Running it

```bash
npm test                      # → node test/verify.mjs
node test/verify.mjs
node test/verify.mjs --strict # WARN counts as FAIL too
node test/verify.mjs --quiet  # print failing checks only
```

Exit code is **1** if anything FAILed, **0** otherwise. Findings are grouped by
check, each one tagged with a file (or a `games.json:<gameId>` locator) and a
one-line message.

`--experimental-vm-modules` is handled automatically: if `vm.SourceTextModule`
is missing, the script re-execs itself once with the flag so inline
`<script type="module">` blocks get syntax-checked too. If that can't happen it
degrades to a WARN and everything else runs unchanged.

## Where it runs

| | |
|---|---|
| `.github/workflows/deploy-pages.yml` | step **Verify library**, before `Build site` — a failure stops the deploy |
| `.claude/skills/release-pusher/SKILL.md` | Step 2.5 — a non-zero exit **aborts the release** |

## The checks

| # | Check | What it catches |
|---|---|---|
| 1 | `games.json schema` | malformed/duplicate ids, missing stat `label`/`format`, missing achievement `label`/`desc`/`icon`, bad `activeCoverType` (missing = WARN), a `leaderboard` block with neither `modes[]` nor `localStatKey`, an `external` game with no https `download.url` + 64-hex `sha256` |
| 2 | `game files` | a `fileName` that doesn't exist, or exists **with different case** (invisible on Windows, a 404 on the Linux Pages build); stray root `*.html` not in games.json, which main.js's migration would copy into user profiles |
| 3 | `covers` | missing `covers/<id>.svg` / `<id>.default.svg`; orphan covers (WARN); SVGs that don't open with `<svg` or end with `</svg>`, contain `<script`, contain `--` inside an XML comment (blanks the card), or a bare `&`. Game ids can contain dots (`coldmere_v1.0`), so covers are matched with `startsWith(id + '.')`, never by splitting on `.` |
| 4 | `preload allowlists` | `ONLINE_MULTIPLAYER_GAMES` / `LEADERBOARD_GAMES` entries with no game; a game that references `LobbySDK`/`LeaderboardSDK` but isn't allowlisted (the SDK would be `undefined` at runtime) or vice versa; a `leaderboard` block on a game that never calls the SDK. Parsed with the exact regex `web/build-site.mjs` uses, so the two can't disagree |
| 5 | `achievements & stats` | ids passed to `unlockAchievement(` that games.json doesn't declare, and declared ids the game never mentions; `unlockGlobalAchievement(` ids not in games.json `globalAchievements` or renderer.js's `GLOBAL_ACHIEVEMENTS`; stat keys written but not declared, and declared but never written. Only *literal* first arguments count — `setStat('best_' + diff, …)` is a computed key and is skipped |
| 6 | `javascript syntax` | a `SyntaxError` in any inline `<script>` block of a game, or in main.js / preload.js / renderer.js / feedback.js / the two SDKs / playerdata-store.js / `web/*.js` / `web/build-site.mjs`. Blocks with `src=` and non-JS `type`s (`text/html`, `importmap`, `x-shader/*`, …) are skipped |
| 7 | `document tails` | the truncated-file failure from CLAUDE.md's Debugging note — zero `</html>`, more than one, or markup after it. Scripts and HTML comments are removed first, so `pippin.html`'s `</body></html>` inside a `type="text/html"` iframe template doesn't count |
| 8 | `web-shim parity` | an `electronAPI` method in preload.js with no counterpart in `web/web-shim.js` — how the website breaks silently after a launcher feature lands |
| 9 | `versions` | `changelog.json` `releases[0].version` disagreeing with `package.json` (What's New would show the wrong entry), duplicate versions, bad dates / empty notes (WARN) |
| 10 | `dependencies & build.files` | anything in `dependencies` other than `electron-updater` — the unused `firebase` package added 116 MB to every installer — and any missing `build.files` exclusion (`!_dev/**`, `!web/**`, `!test/**`, …) |
| 11 | `root shippability` | files in the project root that aren't launcher files, games from games.json, or known infra. `build.files` starts with `**/*`, so scratch work left in the root ships (WARN) |

| 12 | `vendored engines` | a game loading three.js or cannon from a CDN (it would be a black screen offline); a `./vendor/…` path, a `three/addons/…` import mapped into `vendor/`, or a relative import inside a vendored file that doesn't exist with exact case; vendored files no game uses (WARN, LICENSE files exempt). See CLAUDE.md "Vendored engines" |

### Known deviation

Check 1 requires every leaderboard **mode** to carry `boardId` and
`localStatKey`. `renderer.js` will default `boardId` to `<gameId>__<modeId>`,
so a missing one is a convention violation rather than a crash — but a missing
`localStatKey` genuinely makes the card's "your best" line read 0.

## Adding a check

```js
check('my new check', () => {
  // fail(where, message)  → exit 1
  // warn(where, message)  → exit 0 (exit 1 under --strict)
  if (somethingBad) fail('games.json:someGame', 'one line saying what is wrong');
});
```

`check(name, run)` appends to `CHECKS`; the runner catches throws and reports
them as a FAIL against that check, so a check can't take the whole run down.
Helpers already in the file: `read` / `exists` / `readJSON` (root-relative),
`ROOT_ENTRIES` / `ROOT_FILES` (exact-case root listing), `GAMES` /
`LOCAL_GAMES`, `gameHtml(game)` (cached), `literalArgs(src, fnName)`,
`hasQuoted(src, needle)`, `scriptBlocks(html)`, and `objectKeys(src, braceIdx)`.

Keep messages to one line and always name a file or id — the output is read
mid-release, under time pressure.
