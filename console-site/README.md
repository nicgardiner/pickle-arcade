# 🥒 Pickle Arcade — Console Edition (`/xbox/`)

The gamepad-native build of the Pickle Arcade website, made for playing on
consoles (Xbox Edge primarily). It ships as part of the main website:
`web/build-site.mjs` copies this folder to `site/xbox/`, so it deploys with
every normal push to `main` — no separate repo, no extra setup.

**Live URL:** `https://nicgardiner.github.io/pickle-arcade/xbox/`
Console browsers never need to type that: the main site (`web-shim.js`)
detects an Xbox/PlayStation user agent and redirects there automatically.
Append `?noconsole=1` to the main site URL to bypass the redirect when
testing.

## What's in here

| File | Role |
|---|---|
| `index.html` | The arcade shell: game grid, first-visit name prompt, profile editor, game-info modal. Entirely drivable with a controller (D-pad/stick + A/B/X/Y), keyboard fallback (arrows/Enter/Esc/I). |
| `console.css` | Shell styles (10-foot UI, same palette as the launcher). |
| `console-pad.js` | Shared Gamepad API helper: `Pad` (buttons/axes/rumble), `PadNav` (spatial menu navigator), `PadGlyph` (Xbox button badges). Loaded by the shell and every game. |
| `console-sdk.js` | GameSDK for games (stats/achievements/saves in localStorage), player identity from the name prompt, and reroutes the standard exit contract (`window.close()`) back to `index.html`. |
| `lobby-sdk.js` | Unmodified copy of the arcade's online lobby SDK — Windward Isles and Floe Fighters cross-play with app/website players in the same rooms. Names come from the name prompt. |
| `games.json` | The six-game library metadata (feeds the shell). |
| `*.html` (6 games) | Console conversions: full Gamepad-API controls, Xbox button prompts everywhere (keyboard/mouse still work silently), pad-drivable menus and exit dialogs. |
| `covers/`, `assets/` | Cover art + logo. |

Because it's the same origin as the regular website, saves, stats,
achievements and the player name are shared between the two versions in the
same browser.

## Updating a console game

The console copies here are separate files from the root (desktop-web)
versions — a change to a root game does NOT flow here automatically. To
update one, re-apply the change to the copy in this folder (keeping the
gamepad integration blocks intact), then push as usual.

## On the Xbox

Open Edge on the Xbox → go to `nicgardiner.github.io/pickle-arcade` (favorite
it) → it lands here automatically. First visit asks for a name (Xbox
on-screen keyboard) — that name feeds every game, including online
multiplayer. `window.close`-based exit buttons inside games return to the
arcade shell.

## Controls at a glance (shell)

- **D-pad / left stick** — move the focus ring
- **A** — play the focused game / activate
- **X** — game info (description, your stats, achievements)
- **Y** — edit name/emblem
- **B** — back / close

Per-game control maps are shown inside each game (all prompts are Xbox
buttons). Windward Isles uses the custom build scheme: left stick pans,
right stick moves the styled build cursor, RT places, LT deletes, A/B
raise/lower build height.
