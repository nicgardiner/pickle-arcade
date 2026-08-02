# 🥒 Pickle Arcade — Console Edition (`/xbox/`)

The gamepad-native build of the Pickle Arcade website, made for playing on
consoles (Xbox Edge primarily). It ships as part of the main website:
`web/build-site.mjs` copies this folder to `site/xbox/`, so it deploys with
every normal push to `main` — no separate repo, no extra setup.

**Live URL:** `https://nicgardiner.github.io/pickle-arcade/xbox/`
Console browsers never need to type that: the main site
(`web/console-redirect.js`, injected at the top of `<head>`) sends them here
by user agent, by remembered preference, or by offering to switch when a
gamepad appears. `?console=1` forces it; `?noconsole=1` — on the main site or
on `xbox/` — opts out for good.

## ⚠️ Edge on Xbox: "Use game controls"

Edge boots in **cursor mode**, where the controller drives the browser pointer
and the page's Gamepad API sees *nothing*. The symptoms look like app bugs: A
and X do nothing, Y opens the address bar, look sticks are dead. The fix is in
the browser, not the site — press **☰ Menu** on the controller (or open the
**···** menu) and turn on **Use game controls**. The shell now detects the
situation and puts those instructions on screen a few seconds in; the hint-bar
status re-opens them.

That mode also **resets on every page load**, which is why games load into a
full-screen `<iframe>` inside the shell instead of navigating the tab. One
document for the whole session means the setting gets flipped once, not on
every launch and every exit.

Append `?pad=1` to any page here (shell or game) for a live controller readout
— pad id, mapping, every raw axis, buttons down — which is the fastest way to
tell cursor mode apart from a genuine input bug.

## What's in here

| File | Role |
|---|---|
| `index.html` | The arcade shell: game grid, first-visit name prompt, profile editor, game-info modal. Entirely drivable with a controller (D-pad/stick + A/B/X/Y), keyboard fallback (arrows/Enter/Esc/I). |
| `console.css` | Shell styles (10-foot UI, same palette as the launcher). |
| `console-pad.js` | Shared Gamepad API helper: `Pad` (buttons/axes/rumble), `PadNav` (spatial menu navigator), `PadGlyph` (Xbox button badges). Loaded by the shell and every game. |
| `console-sdk.js` | GameSDK for games (stats/achievements/saves in localStorage), player identity from the name prompt, and reroutes the standard exit contract (`window.close()`) up to the shell — or to `index.html` if a game is ever opened as a top-level page. |
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
it) → it lands here automatically. Turn on **Use game controls** (see above) —
once per session, since the shell never navigates away. First visit asks for a
name (Xbox on-screen keyboard) — that name feeds every game, including online
multiplayer. `window.close`-based exit buttons inside games return to the
arcade grid, as does the console's Back button.

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
