---
name: game-onboarder
description: >
  Fully integrates a new HTML game into the Pickle Game Library launcher. Use this skill any time
  a freshly made game file needs to be added to the library — it reads the game code, designs
  appropriate stats and achievements, creates a custom illustrated cover, writes a description and
  tags, injects GameSDK tracking calls into the game HTML, updates games.json, and saves the cover
  SVG. Trigger on: "add this game to the launcher", "onboard this game", "integrate this into the
  library", "set up stats and achievements for my game", "give this game a cover", or any time a
  .html game file is handed over that needs launcher integration. Even if the user just says
  "I made a new game", offer this skill.
---

# Game Onboarder

This skill takes a new HTML game and fully wires it into the Pickle Game Library. By the end, it
will have stat tracking, achievements, a custom illustrated cover, description, and tags — all
working on first launch.

---

## The Launcher System (read this first)

**`games.json`** — the source of truth. Each entry:

```json
{
  "id": "my_game_v1",
  "title": "My Game",
  "fileName": "my_game_v1.html",
  "preferredWidth": 680,
  "preferredHeight": 800,
  "description": "One or two punchy sentences.",
  "party": "first",
  "hasCover": true,
  "coverConfig": {
    "bg": "#030e1a",
    "lineColor": "#3522aa",
    "titleColor": "#FFD700",
    "pattern": "lines",
    "icon": "🎮"
  },
  "tags": ["Action", "Single Player"],
  "stats": [
    { "key": "best_score",  "label": "Best Score",   "format": "number"   },
    { "key": "total_runs",  "label": "Total Runs",   "format": "number"   },
    { "key": "best_time",   "label": "Best Time",    "format": "seconds"  },
    { "key": "items_found", "label": "Items Found",  "format": "fraction", "total": 20 }
  ],
  "achievements": [
    { "id": "first_play", "label": "First Steps", "desc": "Play your first game", "icon": "👟" }
  ]
}
```

Key fields:
- `id` = fileName with the `.html` extension stripped (e.g. `"space_runner_v1"`)
- `party`: `"first"` for Pickle Originals, `"third"` for external games
- `format` options: `"number"`, `"seconds"` (displayed as `Xs`), `"fraction"` (needs `"total": N`)
- `coverConfig`: kept as a fallback for the launcher's built-in cover editor — set sensible values
  but the actual displayed cover will be the custom SVG you generate

**GameSDK** — auto-injected into every game window via Electron's preload. Call from any game JS:

```js
GameSDK.setStat('best_score', score)          // plain set
GameSDK.setStat('best_score', score, true)    // keepMax — only updates if new value is higher
GameSDK.incrementStat('total_runs')           // add 1
GameSDK.incrementStat('coins_earned', 5)      // add N
GameSDK.getStats()                            // returns current stats object
GameSDK.unlockAchievement('ach_id', 'Label') // safe to call repeatedly — idempotent
```

Stats persist under `localStorage` key `gl_<gameId>_stats`. Achievements under `gl_<gameId>_achievements`.
Don't use keys starting with `gl_` in the game's own code — those are reserved for the launcher.

**Tags** — 2–4 from: `Action`, `Strategy`, `Roguelite`, `Platformer`, `Battle`, `Casual`, `Puzzle`,
`Horror`, `RPG`, `Multiplayer`, `Single Player`, `WIP`

---

## Step 1: Read and Understand the Game

Read the game HTML in full. You need to know:

- **What it is**: genre, core loop, win/lose/end conditions
- **How scoring works**: what JS variables track score, kills, coins, levels, time, etc.
- **Key events**: game over, level complete, enemy killed, item collected, session start
- **Multiplayer?**: does it have a two-player mode, or is it always solo?
- **Visual palette**: what colors dominate the game's UI? (used for cover design)
- **Canvas/viewport size**: look for `C.width = 680` or `canvas.width`, CSS constraints on wrapper
  divs, etc. This becomes `preferredWidth` / `preferredHeight`. If there's a bottom info bar
  below the canvas (common: `#info-bar`), add ~36–50px to the height.
- **Existing localStorage**: check keys the game uses already, so you don't collide.

Also determine:
- `id`: fileName with `.html` stripped
- `title`: display name (from `<title>` tag or main heading)
- `party`: default `"first"` unless told otherwise

---

## Step 2: Design the Package

### Stats (3–6)

Choose stats a player would actually want to see. Every stat needs a corresponding injection point.

- **Best-of records**: high score, longest survival, highest level → `setStat(key, val, true)`
- **Cumulative counters**: total runs, total kills, coins → `incrementStat`
- **Session snapshots**: items collected, enemies beaten in a run → set at run end

Always include "total runs" or "games played" if there's a play-again loop.
Use `"seconds"` for time values, `"fraction"` when there's a known total, `"number"` otherwise.

### Achievements (5–8)

Build a progression ladder:
- **1–2 easy**: trigger on first play or first basic action
- **2–3 medium**: reach a meaningful milestone (score threshold, level, X total games)
- **1–2 hard**: something impressive but achievable
- **1 optional**: funny, secret, or rewarding of exploration

Rules:
- `id`: unique, snake_case (e.g. `"kill_100"`, `"first_play"`)
- `label`: 1–4 words, punchy
- `desc`: one sentence, "Do X" or "Achieve X"
- `icon`: one fitting emoji
- Don't design achievements that can never trigger through normal play

### Description

One or two sentences. Punchy, present-tense. Specific to what this game actually does.

---

## Step 3a: Generate the Minimalist Cover

Every native game needs a **minimalist cover** — a bold pattern + emoji SVG that gives the game
instant visual identity in the launcher. This is generated programmatically, but the choices you
make (pattern, colors, emoji) should be thoughtful and specific to this game. Don't just pick defaults.

**Think about the game's feel before choosing:**

| Game type        | Pattern idea     | Emoji idea      | Color vibe                         |
|------------------|------------------|-----------------|------------------------------------|
| Space shooter    | `dots` (stars)   | 🚀 / 👾         | Deep navy bg, cyan/blue title      |
| Mountain/climb   | `waves`          | 🐐 / 🏔️         | Dark forest green, lime accent     |
| Dungeon RPG      | `diamonds`       | ⚔️ / 🗡️         | Near-black bg, blood-red lines, gold title |
| Board game       | `grid`           | ♟️ / 🔴          | Dark warm bg, white/gold title     |
| Horror/maze      | `grid`           | 🚶 / 👁️          | Sickly yellowish-dark bg, amber    |
| Flying/dodge     | `waves`          | 🐦 / ✈️          | Dark sky blue bg, yellow title     |
| Magic/RPG        | `hexagons`       | ⚡ / 🔮          | Dark purple bg, lavender title     |
| Fighting/battle  | `lines`          | 🥊 / ⚡          | Dark red/maroon bg, orange title   |

**Available patterns**: `lines`, `grid`, `dots`, `scanlines`, `diamonds`, `hexagons`, `waves`, `none`

Generate the minimalist SVG in Python via bash using this template (port `gen_pattern` from renderer.js
or use the version from the session history). Call `gen_minimalist_cover()` with your chosen values:

```python
def gen_minimalist_cover(title, bg, line_color, title_color, pattern, icon):
    t = title.upper(); n = len(t)
    if   n <= 6:  fs, gap = 76, 240
    elif n <= 8:  fs, gap = 68, 220
    elif n <= 10: fs, gap = 60, 200
    elif n <= 12: fs, gap = 54, 180
    elif n <= 15: fs, gap = 44, 140
    else:         fs, gap = 36, 80
    lw = max(0, (680 - 96 - gap) // 2); rs = 48 + lw + gap
    decor = (f'<rect x="48" y="100" width="{lw}" height="1.5" fill="{title_color}" opacity="0.5"/>' +
             f'<rect x="{rs}" y="100" width="{lw}" height="1.5" fill="{title_color}" opacity="0.5"/>') if lw > 15 else ''
    pat = gen_pattern(pattern, line_color)
    return f'''<svg width="400" height="600" viewBox="0 0 680 1020" xmlns="http://www.w3.org/2000/svg">
<defs><clipPath id="cvclip"><rect width="680" height="1020"/></clipPath></defs>
<rect width="680" height="1020" fill="{bg}"/>
{pat}
<rect x="0" y="0" width="680" height="148" fill="rgba(0,0,0,0.52)"/>
<line x1="0" y1="148" x2="680" y2="148" stroke="{title_color}" stroke-width="1.2"/>
{decor}
<text x="343" y="135" text-anchor="middle" font-family="'Arial Black','Impact',sans-serif"
      font-weight="900" font-size="{fs}" fill="rgba(0,0,0,0.45)" letter-spacing="4">{t}</text>
<text x="340" y="132" text-anchor="middle" font-family="'Arial Black','Impact',sans-serif"
      font-weight="900" font-size="{fs}" fill="{title_color}" letter-spacing="4">{t}</text>
<text x="340" y="660" text-anchor="middle" dominant-baseline="central" font-size="300">{icon}</text>
<rect x="0" y="988" width="680" height="32" fill="rgba(0,0,0,0.52)"/>
<line x1="0" y1="988" x2="680" y2="988" stroke="{title_color}" stroke-width="0.8" opacity="0.3"/>
</svg>'''
```

Save to: `covers/<gameId>.minimalist.svg`

Also update `coverConfig` in games.json to match the chosen bg / lineColor / titleColor / pattern / icon.

---

## Step 3b: Design the Custom Cover SVG

The cover is a **hand-crafted SVG** — an illustrated scene that captures the game's world.
Do NOT use the generic emoji/pattern system. Look at the existing covers for the quality bar:

- **Void Assault**: deep space, enemy sprites (crawler, floater, zigger, eyeball), player ship,
  star field, nebula wisps, title with blue glow
- **Mountain Goat Climber**: mountain landscape with sky gradient, pixel-art goat sprite,
  platforms, coins, snow caps, green title glow
- **Checkers**: zoomed-in rotated checkerboard, glowing king piece with 3D radial gradient,
  serif gold title, Georgian typography
- **Poke Clash**: radial speed lines, actual Pokémon sprites (Charmander, Jigglypuff) as SVG
  shapes, Pokéball watermark, yellow title glow

**What makes a great cover:**
1. The viewer should immediately know what kind of game this is before reading the title
2. Use actual visual elements from the game — characters, pieces, environment, items
3. The palette should reflect the game's actual colors, not generic dark blue
4. Layer depth: background → atmospheric effects/particles → main scene elements → title → accent

**SVG canvas**: `viewBox="0 0 680 1020" width="400" height="600"`

**Typical structure to follow:**

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 1020" width="400" height="600">
<defs>
  <!-- Gradients for background, pieces, glows -->
  <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">...</linearGradient>
  <radialGradient id="pieceShine" cx="36%" cy="30%" r="65%">...</radialGradient>
  <!-- Glow filter for title and key elements -->
  <filter id="titleGlow" x="-30%" y="-60%" width="160%" height="220%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur"/>
    <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>

<!-- 1. Background -->
<rect width="680" height="1020" fill="url(#bgGrad)"/>

<!-- 2. Atmospheric effects (stars, particles, lines, patterns) -->

<!-- 3. Main scene elements (characters, objects, environment) -->
<!-- Rendered as SVG shapes: polygons, ellipses, paths, rects -->
<!-- Use transform="translate(x,y) scale(s)" to position and size -->

<!-- 4. Title — at top (y ~100–220), large, with glow filter -->
<text x="340" y="140" font-family="'Arial Black', Arial, sans-serif" font-size="78"
      font-weight="900" text-anchor="middle" letter-spacing="5"
      fill="#88ccff" filter="url(#titleGlow)">GAME TITLE</text>

<!-- 5. Optional divider line, tagline, bottom label -->
</svg>
```

**Key SVG techniques to use:**
- `<linearGradient>` / `<radialGradient>` for 3D-looking objects and atmospheric backgrounds
- `feGaussianBlur` + `feMerge` filter for glowing text and elements (double-blur for stronger glow)
- `<g transform="translate(x,y) scale(s)">` to position and scale scene elements
- `opacity` on groups/elements for layering and depth
- `clip-path` if elements need to be clipped to the canvas boundary
- Render game characters/objects as combinations of basic shapes — don't try to trace every detail,
  but capture the silhouette and key colors. Think of it like pixel art scaled up: blocks of color
  that read clearly at a glance.

**For the `coverConfig`** in games.json: set values that roughly match the cover's palette (bg, a
dominant color, the title color) so the launcher's design editor gives a reasonable starting point
if someone tries to reskin it later.

---

## Step 4a: Add Thematic Background Gradient (if applicable)

Games with a fixed-size canvas leave a plain colored band around the game in fullscreen. If **both**
conditions are true, add a thematic gradient:

1. The game uses a fixed pixel canvas (`canvas.width = N` / `width="N"` in HTML) rather than filling
   the viewport dynamically.
2. The `body` background is a flat color (e.g. `background:#111`) — no gradient or visual effect
   already present.

If either condition is false, skip this step.

**How to pick the gradient** — match the game's world; the background should feel like the game's
environment bled outward:

| Game feel            | Gradient idea                                                     |
|----------------------|-------------------------------------------------------------------|
| Mountain / outdoor   | `linear-gradient(160deg, night-sky → dark-forest-green)`         |
| Space / sci-fi       | `radial-gradient(ellipse at center, deep-navy → near-black)`     |
| Sky / flying         | `linear-gradient(180deg, sky-blue → light-clouds → grass-green)` |
| Dungeon / horror     | `radial-gradient(ellipse at center, dark-red → pure-black)`      |
| Ocean / underwater   | `linear-gradient(180deg, dark-teal → deep-navy-black)`           |
| Desert / adventure   | `linear-gradient(180deg, deep-orange-sky → warm-dark-brown)`     |
| Neon / cyberpunk     | `radial-gradient(ellipse at center, dark-purple → near-black)`   |

Keep the gradient **dark** — the canvas should remain the clear visual focus. The gradient is
ambiance, not decoration.

**Implementation:** find the `body { background: ... }` rule in the game's `<style>` block and
replace the flat color with the gradient. One surgical `Edit` call.

```css
/* before */
body { background: #111; ... }

/* after — example for a space game */
body { background: radial-gradient(ellipse at center, #0d0d2e 0%, #050518 50%, #000008 100%); ... }
```

---

## Step 4b: Inject GameSDK Calls

Edit the game HTML to add tracking. The GameSDK is already available — just call it.

**Find the right injection points:**
1. **Game over / run end** — best place for `setStat` (score, level, etc.) and achievement checks
2. **Kill / defeat handlers** — `incrementStat('total_kills')` and kill-count achievements
3. **Coin / item collection** — `incrementStat('coins_earned', amount)`
4. **Level up / wave complete** — level-based achievements
5. **Game start / session init** — `incrementStat('total_runs')` (or at game over)

**Pattern for "first time" achievements:**
```js
GameSDK.unlockAchievement('first_blood', 'First Blood');
```

**Pattern for threshold achievements** — check accumulated stats:
```js
const stats = GameSDK.getStats();
if ((stats.total_kills || 0) + 1 >= 100) {
  GameSDK.unlockAchievement('centurion', 'Centurion');
}
GameSDK.incrementStat('total_kills');
```

**Pattern for run-end stats:**
```js
GameSDK.setStat('best_score', finalScore, true);   // keepMax
GameSDK.incrementStat('total_runs');
GameSDK.setStat('best_wave', currentWave, true);
```

Make surgical edits — don't restructure the game's code, just add calls at the right moments.
If a clean injection point isn't obvious, add a comment `// TODO: inject X here` and tell the user.

---

## Step 5: Save All Files

### Update games.json
1. Read the current `games.json`
2. Append the new game object (set `"hasCover": true`)
3. Write it back

### Save the cover SVGs
Write to three paths:
- `covers/<gameId>.svg` — the active cover (start with the hand-crafted one)
- `covers/<gameId>.default.svg` — permanent reference to the hand-crafted cover (same as .svg initially)
- `covers/<gameId>.minimalist.svg` — the minimalist cover from Step 3a

The Game Library folder path in the shell is:
`/sessions/exciting-kind-pasteur/mnt/Game Library/`

(Note: if this path doesn't resolve, check your session's mount point with `ls /sessions/*/mnt/`.)

---

## Step 6: Confirm

Tell the user:
- What **stats** were added and where they're tracked in the game
- What **achievements** were designed and what triggers each one
- A brief description of the **cover scene** you created and the design choices
- The minimalist cover's emoji, pattern, and color choices — and why they fit the game
- That the game is in `games.json` and ready to launch

If any stat or achievement couldn't be wired up cleanly (no clear injection point), name which ones
and where in the game code to look.

---

## Stat key naming convention

Use descriptive snake_case:
- `best_score`, `best_time`, `best_wave`, `best_level`, `best_kills`
- `total_runs`, `total_games`, `matches_played`
- `total_kills`, `coins_total`, `items_owned`
- `p1_wins`, `ai_wins`, `pvp_matches`
