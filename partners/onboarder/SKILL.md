---
name: partner-onboarder
description: "Prepares a partner's new HTML game for onboarding into Pickle Arcade, entirely inside partners/<partner>/<newId>/: reads the game, designs stats and achievements, writes the description and tags, makes the covers, writes patch.mjs (the Pickle integration layer: GameSDK calls, exit confirm, player chip, pause, --ui zoom, audio settings, vendored engines), entry.json and DEVLOG.md, builds it, and stops at ONBOARDING-PREVIEW.md for the partner to review. Use when a partner asks to prepare a game for onboarding, e.g. the prompt from the launcher's Submit for onboarding dialog."
---

# Partner Onboarder

This takes a finished game from your own `_dev/<project>/` and produces an **onboarding draft**:
one folder, `partners/<partner>/<newId>/`, that builds into a fully integrated Pickle Arcade game —
stats, achievements, covers, description, tags, exit confirm, player chip, pause, screen scaling,
audio settings, offline engines. Then it **stops** so the partner can review everything before the
onboarding request goes to Nic.

> **Run this only when the partner asks for it** — typically with the prompt the launcher's
> **Submit for onboarding** dialog produces:
> *Read partners/onboarder/SKILL.md and prepare `_dev/<project>` for onboarding as
> `partners/<partner>/<newId>/`. Cover: <attached path | "design one">. Stop after writing
> ONBOARDING-PREVIEW.md so I can review it.*
>
> Never send the onboarding request yourself. The partner reviews the preview, then clicks
> **Send onboarding request** in the launcher.

Read `partners/README.md` and `partners/<partner>/README.md` first. The partner's README is the
rulebook (what you may touch, the GameSDK contract, vendored engines); this skill assumes it.

---

## 0. Inputs, output and hard limits

**Inputs**
- `_dev/<project>/` — the game. Read its `DEVLOG.md` first if it has one.
- `<partner>` — the `partner` field of `_dev/partner.json`.
- `<newId>` — given in the prompt, or chosen by you (Step 1).
- Cover — an attached image path, or "design one".

**Output** — only this folder:

```
partners/<partner>/<newId>/
  source/                 the game exactly as the partner built it (untouched)
  patch.mjs               the integration layer: source/ → root <newId>.html
  entry.json              the games.json entry
  covers/                 <newId>.svg, <newId>.default.svg, <newId>.minimalist.svg (+ optional variants)
  DEVLOG.md
  ONBOARDING-PREVIEW.md   the review document (last step)
  work/                   scratch (gitignored): cover scripts, renders, notes
```

`node partners/build.mjs <partner> <newId>` then generates the root game file, copies the covers into
root `covers/`, and appends the entry to root `games.json` — that is what makes the draft playable in
the partner's launcher. Those generated files are never edited by hand.

**Hard limits — these are outside the partner's folder, so you cannot change them:**
`preload.js` (and its `LEADERBOARD_GAMES` / `ONLINE_MULTIPLAYER_GAMES` allowlists), `vendor/`, the
launcher files, `package.json`, other games, other `games.json` entries. If the game needs any of
them, record it as an open question in the preview (Step 10) — the partner asks Nic in the request's
**Notes & extras**. Never `npm install --save` anything.

---

## 1. Set up the folder

1. **Pick `<newId>`** (if the prompt didn't): lowercase snake_case, from the game's title
   (`"Moon Miner"` → `moon_miner`). It must not already be an `id` in `games.json` or a folder under
   `partners/`. The root file will be `<newId>.html` — `fileName` is always the lowercase id plus
   `.html` (the website's Linux build is case-sensitive; a case mismatch is a 404).
2. **Copy the game into `source/`** unchanged — the HTML plus any local `.js`/`.css` it loads. Never
   edit `source/`; it is what the partner replaces wholesale with each new build.
   The root output is **one HTML file**: `patch.mjs` inlines any local script/style files (Step 6.0).
   Images, audio or other asset files loaded by URL from the game folder will not exist next to the
   root file — they must already be inlined (data URIs) in the build, or list it as an open question.
3. **Start `DEVLOG.md`** in the fixed shape the launcher parses:
   ```markdown
   # <newId> — Dev Log

   **Status:** onboarding draft — not yet sent; root <newId>.html is GENERATED from source/ by patch.mjs

   ## Now
   - [ ] Partner review of ONBOARDING-PREVIEW.md

   ## Next
   - [ ] Send onboarding request from the launcher (Published tab)

   ## Done
   - <today> — onboarding draft prepared (partners/onboarder/SKILL.md)

   ## Notes
   New build: copy it over source/, then `node partners/build.mjs <partner> <newId>` and `npm test`.
   Every patch.mjs replacement must match exactly once, so a moved anchor fails loudly.
   ```

---

## 2. Read and understand the game

Read the game in full. You need to know:

- **What it is**: genre, core loop, win/lose/end conditions
- **How scoring works**: what JS variables track score, kills, coins, levels, time, etc.
- **Key events**: game over, level complete, enemy killed, item collected, session start
- **Multiplayer?**: local two-player, online (and through what netcode), or solo only
- **Visual palette**: the colours that dominate the game's UI (used for the covers)
- **Canvas/viewport size**: `canvas.width = 680`, CSS constraints on wrapper divs, etc. This becomes
  `preferredWidth` / `preferredHeight`. If there's a bottom info bar below the canvas, add ~36–50px
  to the height. Games that fill the window typically use 1600 × 900.
- **Existing localStorage**: the keys the game already uses (never rename them; never use `gl_…`).
- **External scripts**: every `https://` in `<script src>`, an import map, or `import … from`.

Also determine `title` (from `<title>` or the main heading). `party` is always `"third"` and
`developer` is the partner's display name from `partners/partners.json`.

---

## 3. Design the package

### Stats (3–6)

Choose stats a player would actually want to see. Every stat needs an injection point.

- **Best-of records**: high score, longest survival, highest level → `setStat(key, val, true)`
- **Cumulative counters**: total runs, total kills, coins → `incrementStat`
- **Session snapshots**: items collected, enemies beaten in a run → set at run end

Always include "total runs" or "games played" if there's a play-again loop.
`format`: `"seconds"` for time values (shown as `Xs`), `"fraction"` with `"total": N` when there's a
known total, `"number"` otherwise. Naming: descriptive snake_case — `best_score`, `best_time`,
`best_wave`, `total_runs`, `matches_played`, `total_kills`, `coins_total`, `p1_wins`, `ai_wins`.

### Achievements (5–8)

Build a progression ladder:
- **1–2 easy**: first play or first basic action
- **2–3 medium**: a meaningful milestone (score threshold, level, X total games)
- **1–2 hard**: impressive but achievable
- **1 optional**: funny, secret, or rewarding exploration

Rules: `id` unique snake_case (`kill_100`, `first_play`); `label` 1–4 punchy words; `desc` one
sentence, "Do X" / "Achieve X"; `icon` one fitting emoji. Nothing that can't trigger in normal play.

### Description

One or two sentences. Punchy, present tense, specific to what this game actually does.

### Tags

Pick 2–4, only from the launcher's own lists (`GENRE_TAGS` and `MP_TAGS` near the top of
`renderer.js` — anything else can't be selected in the app). Today:
genre — Action, Strategy, Roguelite, Platformer, Racing, Battle, Casual, Puzzle, Horror, RPG,
Board Game, Card Game, Sandbox, WIP; multiplayer (only if the game really has that mode) — Local,
Online, Co-op, PvP.

---

## 4. Stats & achievements contract (enforced by `npm test`)

Everything designed in Step 3 and injected in Step 6b must satisfy these. The first three fail
`npm test`; the last two caused real player-visible bugs (Connect 4 handed the loser the winner's
achievements).

**1. Every id and key is a string literal at the call site.** The verifier reads the *source*: it
collects the literal first argument of every `unlockAchievement(`, `unlockGlobalAchievement(`,
`setStat(` and `incrementStat(` and cross-checks it against the entry.

```js
GameSDK.unlockAchievement('wave_10', 'Wave Ten');   // ✅ seen and checked
GameSDK.setStat('best_' + diff, v, true);           // ⚠️ computed — skipped by the verifier
```

A computed key is allowed **only** when every value it can resolve to is declared. List every such
key in the preview — nothing will catch a typo in one.

**2. Declared ⇄ written, both directions.** Every declared achievement id and stat key must appear in
the game, and every literal id/key the game writes must be declared (an undeclared literal stat key
fails `npm test`). A declared-but-never-written stat is a permanent 0 on the card; an undeclared
achievement pops a toast the card can't name.

**3. Global achievements go through `unlockGlobalAchievement`.** Library-wide ids (in `games.json`'s
`globalAchievements`, e.g. `online_first_match`) use `GameSDK.unlockGlobalAchievement('id')`, never
`unlockAchievement`.

**4. In a game with an online mode, gate every win-based achievement and stat to the LOCAL player's
seat.** Both clients run the same end-of-game code:

```js
// ❌ both machines unlock it
if (winner === RED) GameSDK.unlockAchievement('first_win', 'First Win');

// ✅ only the machine that actually won
if (winner === mySeatColor) {
  GameSDK.unlockAchievement('first_win', 'First Win');
  GameSDK.incrementStat('online_wins');
}
```

Apply it to wins, streaks, "flawless victory" achievements, and any stat that means "I did X". In bot
mode compare against the human seat.

**5. An online game writes exactly one of `online_wins` or `mp_wins`.** The launcher's global
**Online Victory** achievement reads either on a game tagged `Online`. Pick one, declare it, write it
(gated per rule 4) — never both.

---

## 5. Covers

Every game needs `covers/<newId>.svg` (the active cover) and `covers/<newId>.default.svg` (the same
file — the permanent "Default" variant), plus a minimalist cover `covers/<newId>.minimalist.svg`.
Optional extra variants: `<newId>.classic.svg`, `<newId>.night.svg`. All covers are SVG, 2:3:
`width="400" height="600" viewBox="0 0 680 1020"`.

**Every cover must be valid XML**, or the card renders blank in the launcher even though some
previews look fine: no `--` inside a `<!-- comment -->`, no bare `&` (write `&amp;`), no `<script>`,
the file starts with `<svg` and ends with `</svg>`. `npm test` checks all of that.

**Look at every cover before you finish** — render it at full size and at card size (150 × 225)
with the helper in this folder (it uses the repo's own Electron; exits 1 if the SVG doesn't render):

```bash
npx electron partners/onboarder/cover-tool.cjs shot partners/<partner>/<newId>/covers/<newId>.minimalist.svg partners/<partner>/<newId>/work/minimalist.png
```

Then open the PNG and look at it. Iterate until it's right.

### 5a. The partner attached a cover image

Use it as the default cover. Wrap it into a launcher-ready SVG (cropped to 2:3 from the centre,
encoded as a 1080 × 1620 WebP inside an SVG `<image>`):

```bash
npx electron partners/onboarder/cover-tool.cjs wrap <image.png|jpg|webp> partners/<partner>/<newId>/covers/<newId>.svg
```

Copy the result to `covers/<newId>.default.svg` too, render it with `shot`, and check the crop
didn't cut off the title or the subject — if it did, note it in the preview's open questions rather
than editing the partner's art. Likewise, if the art carries marketing copy the text rule in 5c
forbids (taglines, feature lists), don't remove it yourself: list it as an open question. Then make
the minimalist cover (5b). Skip 5c.

### 5b. The minimalist cover (always)

A bold **gradient** background + one big centre symbol that gives the game instant identity.

#### The relevance bar

**The symbol must look extremely relevant to *this specific game*.** Someone who has played it
should see the cover and think "that's my game" — not "that's a generic puzzle icon." A symbol that
merely gestures at the genre is a failure, even if it's pretty.

**Default to a hand-drawn SVG symbol. An emoji is the exception.** Only use an emoji if it passes
all three tests:

1. **Specific** — it depicts the game's actual signature object, not its category.
   💥 for a tank-shell ricochet game ✅. 🌊 for a radio-dial guessing game ❌ (it's just the name).
   👽 for a snowboarding game ❌ (the sport is missing). 🏘️ for a town builder whose buildings look
   nothing like those houses ❌.
2. **Unique** — no other game in the library uses it. List every `coverConfig.icon` in `games.json`
   first.
3. **Solid on the gradient** — it renders as a filled colour glyph, not a thin black outline
   (⛀ ⛁ ⛂ ⛃ and most line-art glyphs fail).

If the closest emoji only *sort of* fits — wrong object, wrong sport, wrong architecture, or it takes
two ideas to express — **draw the symbol**. Two ideas that can't be one emoji (alien + snowboard,
dial + needle) is the clearest signal to draw.

#### Keep it minimal — relevance is not licence to add detail

These are **minimalist** covers: one object, read in a quarter second, still legible as a 150 px
card. Every element past the silhouette makes it worse.

- **One object, no environment.** No waves, clouds, ground line or background props. The gradient
  *is* the environment.
- **Simplify repeated features aggressively.** Windows, ticks, teeth, panels, studs: the fewest that
  still say what the object is, each one bigger. Four large windows read as a building; a dozen small
  ones read as noise.
- **Cut scoring/target/UI overlays.** A gauge doesn't need coloured scoring bands; arc, ticks and
  needle already say "dial."
- **Trim the cast.** Three of a thing, not five.
- **Small accessories don't survive the card size.** A dock, a flagpole, a spray of snow becomes an
  unidentifiable stub at 150 px. Cut them unless they're the point.
- **Leave the symbol a little smaller than feels right.** Breathing room reads as deliberate.

The test: describe the symbol in one short phrase ("a tuning dial", "an alien on a snowboard").
Anything in the SVG that isn't carrying that phrase gets deleted.

#### Drawing the symbol

Build it from basic shapes (circles, polygons, paths) in **the game's own palette** — pull the real
hex colours off the thing you're drawing in the game's code.

- Occupy roughly **300–340 px wide**, spanning about **y 500 → 810**, centred on **x ≈ 340**.
- Wrap it in one `<g>` with a **soft drop shadow**: a dark ellipse at ~0.32–0.36 opacity under the
  symbol, optionally blurred with `feGaussianBlur`.
- **Outline the major shapes** with a dark stroke (4–6 px) so the silhouette survives at card size.
- Prefix every `id` in `<defs>` with a short game tag (`aa`, `mm`) — covers are inlined next to each
  other and bare ids like `sky` or `glow` collide.
- Tilt for motion when the subject moves; keep it level when it doesn't.

Common failures `shot` catches: low-opacity white shapes on a dark gradient turn grey and muddy
(drop them or make them opaque); parts that float apart instead of reading as one object;
pastel-on-pastel; and most often **too much detail** — invisible at 400 × 600, mush at 150 × 225.
If the small render looks busy, delete elements, don't shrink them.

#### The gradient

A **2–3 stop linear gradient** matching the game's theme, **no pattern overlay**: richer mid-tones on
top, falling off to a dark stop at the bottom so the title bar and symbol stay readable.

| Game type        | Gradient vibe (top → bottom)                  | Symbol to draw (or emoji, if it passes the bar) |
|------------------|-----------------------------------------------|-------------------------------------------------|
| Space shooter    | electric navy → deep blue → near-black        | the player's own ship / the enemy silhouette    |
| Mountain/climb   | slate-blue → forest green → dark green        | the climber's animal, mid-hop on its ledge      |
| Dungeon RPG      | warm bronze → dark brown → near-black         | the signature weapon as it looks in-game        |
| Board game       | rich slate/red/blue → its dark tone           | the actual piece, drawn (⛀-style glyphs fail)   |
| Horror/maze      | muted amber or maroon → black                 | the door/eye/light source the game centres on   |
| Flying/dodge     | bright sky-blue → dusk blue → dark            | the bird/craft the player controls              |
| Party/guessing   | hot pink → violet → near-black                | the dial, buzzer, or card the round runs on     |
| Naval/strategy   | teal → deep sea → near-black                  | the ship class or island the game builds        |

#### Generate it

`partners/onboarder/minimalist-cover.mjs` holds the template (title bar, accent lines, gradient,
footer bar — identical across the library). Write a small script in `work/` that calls it with your
drawn symbol, e.g. `work/make-minimalist.mjs`:

```js
import fs from 'node:fs';
import { minimalistCover } from '../../../onboarder/minimalist-cover.mjs';

const DEFS = `<radialGradient id="aaHead" cx="35%" cy="26%" r="78%">
<stop offset="0" stop-color="#a6f78d"/><stop offset="0.55" stop-color="#63d94e"/><stop offset="1" stop-color="#2f8a2a"/></radialGradient>
<linearGradient id="aaDeck" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#19e0ad"/><stop offset="1" stop-color="#0b7a5e"/></linearGradient>
<filter id="aaSoft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="12"/></filter>`;

// Alien Alps: the green alien head planted on its teal snowboard, tilted mid-carve. Nothing else.
const SYMBOL = `<g>
  <ellipse cx="348" cy="846" rx="200" ry="28" fill="#000" opacity="0.36" filter="url(#aaSoft)"/>
  <g transform="translate(344 706) rotate(-15)">
    <g transform="translate(0 78)">   <!-- the board -->
      <path d="M -216 0 q 26 -42 68 -42 h 296 q 42 0 68 42 q -26 42 -68 42 h -296 q -42 0 -68 -42 Z"
            fill="url(#aaDeck)" stroke="#053b30" stroke-width="6" stroke-linejoin="round"/>
      <rect x="-132" y="-34" width="76" height="36" rx="9" fill="#1a222c"/>   <!-- bindings -->
      <rect x="58" y="-34" width="76" height="36" rx="9" fill="#1a222c"/>
    </g>
    <g transform="translate(4 -80)"> <!-- the head, sitting right on the deck -->
      <ellipse cx="0" cy="0" rx="118" ry="138" fill="url(#aaHead)" stroke="#1d5c1c" stroke-width="6"/>
      <ellipse cx="-42" cy="-10" rx="32" ry="51" fill="#0a0e13" transform="rotate(-15 -42 -10)"/>
      <ellipse cx="54" cy="-4" rx="32" ry="51" fill="#0a0e13" transform="rotate(11 54 -4)"/>
    </g>
  </g>
</g>`;

fs.writeFileSync(new URL('../covers/alien_alps.minimalist.svg', import.meta.url),
  minimalistCover({ gameId: 'alien_alps', title: 'Alien Alps',
    stops: ['#24406e', '#0e1c3e', '#04070f'], angle: 120, titleColor: '#7dffa0',
    symbolSvg: SYMBOL, symbolDefs: DEFS }));
```

`angle` is the gradient direction in degrees (0 = left → right, 90 = top → bottom; e.g. 145 for a
diagonal). `stops` go lightest first, darkest last. Pass `icon: '🎲'` instead of `symbolSvg` only for
an emoji that cleared all three tests.

**Reference symbols in the library** (open `covers/<id>.minimalist.svg` to study them):
`ac130_spectre` (the AC-130's targeting reticle and gun ports), `hanbun` (a paper disc cut clean in
two, halves drifting apart along a white slash), `checkers` (a red king disc with grooves and a gold
crown), `poke_clash_v7` (a Poké Ball), `settlers` (a golden resource hex with a red number token),
`samewave` (a tuning dial: dark arc, a dozen chunky ticks, one needle — its scoring wedges were tried
and cut), `alien_alps` (above), `windward_isles` (three tall pastel townhouses on a bare sand isle —
water and a dock were tried and cut), `stations` (one neon station tower on its deck). Emoji, only
because they're genuinely the object: 💥 `shellshock`, 🎙️ `dub_club`, 🎾 `baseline`.

### 5c. The custom illustrated cover (when no image was attached)

The default cover is a **hand-crafted SVG scene** that captures the game's world. Study the existing
covers for the quality bar (`covers/<id>.svg`):

- **`black_knight_16`** ⭐ *(the primary quality reference)*: near-black dungeon with a deep crimson
  arch-glow, a fully drawn armoured knight (helmet, visor, pauldrons, gauntlets, greaves, shield —
  all SVG shapes with radial gradients and highlight passes), stone floor, bones, torchlight
  particles, parchment-toned title with gold lettering. A complex character with 3D shading, layered
  lighting and environment dressing that says genre and tone before the title is read.
- **`hedgerows`** ⭐ and **`busy_byways`** ⭐: the game's own world, drawn in the game's own visual
  language — not an illustration *about* the game. Busy Byways was generated by a script from the
  game's real geometry (one world unit = one tile), so roads, buildings and cars sit exactly as in
  play; Hedgerows renders its tiles on a warm paper ground with grain and vignette. Both use the
  in-game wordmark as the title. When a game has a distinctive board or tile look, generating the
  cover from its real geometry beats hand-drawing an approximation (put the generator in `work/`).
- `void_assault_v2` (deep space, enemy sprites, player ship, nebula, glowing title),
  `mountain_goat_climber_v2` (mountain, pixel-art goat, platforms, coins), `checkers` (rotated
  board, glowing 3D king piece, serif gold title), `poke_clash_v7` (speed lines, sprites as shapes).

**What makes a great cover:**
1. The viewer knows what kind of game this is before reading the title.
2. It uses actual visual elements from the game — characters, pieces, environment, items.
3. The palette is the game's actual colours, not generic dark blue.
4. Layered depth: background → atmosphere/particles → main scene → title → accent.

Typical structure:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 1020" width="400" height="600">
<defs>
  <linearGradient id="mmBg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#1b2a6b"/><stop offset="1" stop-color="#02030f"/>
  </linearGradient>
  <filter id="mmGlow" x="-30%" y="-60%" width="160%" height="220%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur"/>
    <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<!-- 1. background -->
<rect width="680" height="1020" fill="url(#mmBg)"/>
<!-- 2. atmosphere: stars, particles, light -->
<!-- 3. main scene: characters, objects, environment, positioned with translate/scale groups -->
<!-- 4. title, large, near the top, with the glow filter -->
<text x="340" y="140" font-family="'Arial Black', Arial, sans-serif" font-size="78"
      font-weight="900" text-anchor="middle" letter-spacing="5"
      fill="#88ccff" filter="url(#mmGlow)">MOON MINER</text>
</svg>
```

Techniques: `linearGradient`/`radialGradient` for 3D objects and atmosphere; `feGaussianBlur` +
`feMerge` for glow (double the blur node for a stronger glow); `<g transform="translate(x,y)
scale(s)">` to place elements; group `opacity` for depth; `clip-path` to clip to the frame. Render
characters/objects as blocks of colour that capture silhouette and key colours — like pixel art
scaled up — rather than tracing every detail. Prefix ids with the game tag here too.

#### Text rule: the title, and almost nothing else

A cover carries **the game's title and no marketing copy**. Do NOT add:

- hype triplets — `STRATEGIC · RECURSIVE · RUTHLESS`, `STACK · CLIMB · CONQUER`
- genre labels — `CLASSIC BOARD GAME`, `A DICE ROGUELITE`
- feature/stat callouts — `20 MISSIONS · 4-PLAYER ONLINE`, `50 LEVELS AWAIT`
- flavour lines — `YOU ARE NOT ALONE IN HERE`
- a bottom label bar of any kind, or a library/publisher stamp (`PICKLE ORIGINALS`)

**Two things may accompany the title:**

1. **A real subtitle** — part of the game's name or its single defining descriptor, set large
   (roughly 26–40px on the 680 × 1020 canvas), one line, directly under the title or anchored at the
   bottom. Shipped examples: `A DESKTOP DESCENT` (Cursored), `ARMORED RICOCHET COMBAT` (Shellshock),
   `ARCADE TENNIS` (Baseline), `DEATH FROM ABOVE` (Spectre), `FIND THE WAVE` (Samewave). If you can't
   name one that's genuinely part of the game's identity, ship the title alone.
2. **Words that are part of the illustration** — an EXIT sign in the maze, `ON AIR` on a studio lamp,
   `VS` in a clash burst. Drawn objects, not copy.

Rule of thumb: a line under ~24px that isn't painted onto an object in the scene doesn't belong.
Spend the freed space on the artwork.

Save the scene as both `covers/<newId>.svg` and `covers/<newId>.default.svg` (identical), and `shot`
it.

### 5d. `coverConfig`

`entry.json` carries a `coverConfig` — a seed for the launcher's built-in cover editor, not what's
displayed. Record the minimalist design in it:

```json
"coverConfig": {
  "bg": "#02030f",
  "titleColor": "#9fd2ff",
  "pattern": "none",
  "icon": "🚀",
  "gradient": { "angle": 145, "stops": ["#1b2a6b", "#0a1140", "#02030f"] }
}
```

`bg` is the darkest stop; `icon` is a sensible representative emoji even when the symbol is drawn.

---

## 6. The integration layer — `patch.mjs`

Every change the game needs to become a Pickle Arcade game goes into `patch.mjs`, never into
`source/`. The partner will replace `source/` with each new build; `patch.mjs` re-applies the
integration to it.

### 6.0 Structure

Run as `node partners/<partner>/<newId>/patch.mjs <outFile>`. It reads `./source/` relative to its
own file and writes `<outFile>` (the build passes the root `<newId>.html`). Each change is an exact
string replacement that must match **exactly once**, or the script throws — so when a new build moves
an anchor it fails loudly instead of silently dropping a feature:

```js
// Pickle Arcade integration layer for <Title>.
// node partners/<partner>/<newId>/patch.mjs <outFile>
import fs from 'node:fs';
const out = process.argv[2];
if (!out) throw new Error('usage: node patch.mjs <outFile>');
const src = name => fs.readFileSync(new URL('./source/' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let h = src('<game>.html');

function rep(from, to) {
  const n = h.split(from).length - 1;
  if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${from.slice(0, 80)}`);
  h = h.replace(from, () => to);
}

// ...one rep() per change, each with a comment saying why...

fs.writeFileSync(out, h);
```

- **Keep anchors small**, and put the bulk of the integration (GameSDK hooks, exit confirm, chip,
  settings) in **one appended block** inserted just before `</body>`, after the game's own scripts,
  that wraps or observes the game's functions (`const orig = window.gameOver; window.gameOver =
  function(...a){ … return orig.apply(this, a); }`) rather than many edits inside its code. Fewer
  anchors for the next build to break.
- **Inline local files** so the output is one HTML file:
  `rep('<script src="sim.js"></script>', '<script>\n' + src('sim.js') + '\n</script>')`. An inlined
  script must not contain the text `</script>` (split it as `<\/script>` if it does).
- **Deterministic output**: no timestamps, random values or absolute paths — building an unchanged
  folder must produce zero `git diff`.
- **Feature-check the SDKs** everywhere: `if (window.GameSDK) …`. The page also runs where they don't
  exist (opened as a plain file); a bare `GameSDK.setStat(...)` there throws out of the game loop and
  freezes the game.
- The output ends with exactly one `</html>`, nothing after it.
- Reference implementations: `partners/jertal/stations/patch.mjs`,
  `partners/jertal/starfall/patch.mjs`, `partners/jertal/blackout/patch.mjs`.

### 6a. Thematic background gradient (if applicable)

Games with a fixed-size canvas leave a plain coloured band around the game in fullscreen. If **both**
are true — the game uses a fixed pixel canvas (not one that fills the viewport) **and** the `body`
background is a flat colour — replace the flat colour with a dark gradient that feels like the game's
world bleeding outward. Otherwise skip.

| Game feel            | Gradient idea                                                     |
|----------------------|-------------------------------------------------------------------|
| Mountain / outdoor   | `linear-gradient(160deg, night-sky → dark-forest-green)`         |
| Space / sci-fi       | `radial-gradient(ellipse at center, deep-navy → near-black)`     |
| Sky / flying         | `linear-gradient(180deg, sky-blue → light-clouds → grass-green)` |
| Dungeon / horror     | `radial-gradient(ellipse at center, dark-red → pure-black)`      |
| Ocean / underwater   | `linear-gradient(180deg, dark-teal → deep-navy-black)`           |
| Desert / adventure   | `linear-gradient(180deg, deep-orange-sky → warm-dark-brown)`     |
| Neon / cyberpunk     | `radial-gradient(ellipse at center, dark-purple → near-black)`   |

Keep it **dark** — the canvas stays the focus. One `rep()` on the `body { background: … }` rule:

```css
body { background: radial-gradient(ellipse at center, #0d0d2e 0%, #050518 50%, #000008 100%); }
```

### 6b. GameSDK calls

The launcher (and the website) provide `window.GameSDK`:

```js
GameSDK.setStat('best_score', score)          // plain set
GameSDK.setStat('best_score', score, true)    // keepMax — only updates if higher
GameSDK.incrementStat('total_runs')           // +1
GameSDK.incrementStat('coins_earned', 5)      // +N
GameSDK.getStats()                            // current stats object
GameSDK.unlockAchievement('ach_id', 'Label')  // idempotent
```

Stats persist under `gl_<gameId>_stats`, achievements under `gl_<gameId>_achievements`; the `gl_`
prefix is the launcher's — the game never writes such keys itself.

Injection points: **game over / run end** (`setStat` for score/level + achievement checks), **kill /
defeat handlers**, **coin / item collection**, **level up / wave complete**, **game start**
(`incrementStat('total_runs')`, or at game over).

```js
// threshold achievement off an accumulated stat
const stats = GameSDK.getStats();
if ((stats.total_kills || 0) + 1 >= 100) GameSDK.unlockAchievement('centurion', 'Centurion');
GameSDK.incrementStat('total_kills');

// run end
GameSDK.setStat('best_score', finalScore, true);
GameSDK.incrementStat('total_runs');
```

Re-read the contract (Step 4) before writing a single call. If a clean injection point isn't
obvious, leave it out and list it in the preview's open questions — don't guess.

### 6c. Frame-rate dependency (if needed)

Games that drive movement with `requestAnimationFrame` **and** fixed per-frame increments (no
`dt`/elapsed-time scaling) run 2–3× too fast on 120/144 Hz monitors. Safe (skip): the loop takes a
timestamp and scales movement by elapsed time, or the game is turn-based. Affected: `function loop()
{ … }` with `bird.vy += GRAVITY; bird.y += bird.vy;` and no `dt` anywhere.

Fix: cap logic updates at ~60 fps with a 14 ms guard (`_lastFrame`; use `_rafLastFrame` if the name is
taken). Schedule RAF before the guard (and before any try block) so the loop never stalls:

```js
// A — RAF at the end
let _lastFrame = 0;
function loop(ts = 0) {
  requestAnimationFrame(loop);
  if (ts - _lastFrame < 14) return;
  _lastFrame = ts;
  update(); render();
}

// B — state-machine tick with RAF in several branches
let _lastFrame = 0;
function tick(ts = 0) {
  if (ts - _lastFrame < 14) { requestAnimationFrame(tick); return; }
  _lastFrame = ts;
  // ... rest unchanged
}

// C — loop deliberately stops on death (no RAF in that branch — keep it that way)
let _lastFrame = 0;
function gameLoop(ts = 0) {
  if (!G || G.dead) { renderFrame(); return; }
  if (ts - _lastFrame < 14) { requestAnimationFrame(gameLoop); return; }
  _lastFrame = ts;
  update(); render(); requestAnimationFrame(gameLoop);
}
```

### 6d. Exit Game button (required)

Games launch fullscreen with no title bar, so this button is the player's way out. Don't add any
`requestFullscreen()` call — the launcher already opens games fullscreen.

Exact ids (checks depend on them):
- `gl-exit-btn` — the button, labelled "Exit Game" (an icon prefix is fine)
- `gl-exit-confirm` — full-viewport confirm overlay, hidden at load via inline `display:none`
- `gl-exit-yes` — handler is exactly `window.close();` (closes the game window in the app and the tab
  on the website). Never native `confirm()`/`alert()`.
- `gl-exit-no` — cancels. **Escape** also cancels — only while the overlay is visible, with a
  capture-phase listener + `stopPropagation()` if the game has its own Escape handling.

Placement: a DOM main menu → the LAST button in its stack, reusing the game's button classes in a
muted/red-tinted variant. Multiplayer games: main menu only, never in-match. Canvas-drawn menu or no
menu → a small fixed top-right button in the game's palette, ~0.7 opacity (1 on hover). The confirm
panel matches the game's own modal look: title "Exit Game?", one short line (claim "progress is
saved" only if it is), Exit + Cancel (Cancel on the left, Exit on the right). Its z-index must clear
the game's highest. Never put the button/overlay inside a container whose `innerHTML` the game
rewrites, or inside a transformed (scaled) wrapper — `position:fixed` breaks there.

```html
<div id="gl-exit-confirm" style="display:none">
  <div class="glx-panel">
    <div class="glx-title">Exit Game?</div>
    <div class="glx-body">Your progress is saved automatically.</div>
    <div class="glx-row">
      <button id="gl-exit-no">Cancel</button>
      <button id="gl-exit-yes">Exit</button>
    </div>
  </div>
</div>
<script>
(function(){
  function init(){
    var btn=document.getElementById('gl-exit-btn'), ov=document.getElementById('gl-exit-confirm'),
        yes=document.getElementById('gl-exit-yes'), no=document.getElementById('gl-exit-no');
    if(!btn||!ov||!yes||!no) return;
    function show(){ ov.style.display='flex'; }
    function hide(){ ov.style.display='none'; }
    btn.addEventListener('click', show);
    no.addEventListener('click', hide);
    yes.addEventListener('click', function(){ window.close(); });
    document.addEventListener('keydown', function(e){
      if(e.key==='Escape' && ov.style.display!=='none'){ e.stopPropagation(); hide(); }
    }, true);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
</script>
```

### 6e. Pause standard and player chip (required)

**Pause — Escape AND P both toggle it** (real-time games only; turn-based/untimed games: N/A).
- Game already has a pause → bind whichever of Esc/P is missing to the SAME toggle.
- No pause → add a minimal one: freeze the loop/timers and show `gl-pause-overlay` ("Paused" + "Esc
  or P to resume"; clicking it also resumes), in the game's palette. If a safe freeze isn't obvious,
  skip it and list it as an open question.
- P already a gameplay key → don't bind it; Esc alone is fine; note the conflict.
- Guards, all of them: never toggle while `gl-exit-confirm` is open (attach WITHOUT capture — the exit
  overlay's capture handler swallows Esc while open; check its `display` for P); ignore keydowns in
  `input`/`textarea`/contenteditable; **never pause an online match**; only during actual gameplay.
- Pointer-lock games: the browser reserves Esc to release the lock — make lock-loss land in the paused
  state.

**Player chip — single-player games only** (online games already show names in-match).
Container id exactly `gl-player-chip`: emblem then name, read from the URL query
(`playerName` / `playerEmblem` — the app and the website both pass them), rendered with
`textContent` only (user-controlled values — never `innerHTML`). No `playerName` → fully hidden, no
"Player" fallback. On the title/main menu only, small and slightly transparent, top-LEFT when the
exit button is top-right.

```html
<div id="gl-player-chip" style="display:none"></div>
<script>
(function(){
  try {
    var p = new URLSearchParams(location.search);
    var name = (p.get('playerName')||'').trim();
    if(!name) return;
    var chip = document.getElementById('gl-player-chip');
    var em = document.createElement('span'); em.textContent = p.get('playerEmblem')||'';
    chip.appendChild(em);
    chip.appendChild(document.createTextNode(' ' + name));
    chip.style.display = 'inline-flex';
  } catch(e){}
})();
</script>
```

### 6f. Screen-size scaling — the `--ui` check (required)

Games run fullscreen on 1920×1080, 2560×1440, 3440×1440 and 3840×2160 monitors. Classify the game:

| Class | Play surface | Chrome / HUD | Verdict |
|-------|--------------|--------------|---------|
| **A** | Fills the window, or a fixed canvas the game scales to the viewport | Drawn inside the canvas, or DOM in viewport units / a computed scale | ✅ nothing to do |
| **B** | Fixed natural size, centred, never scaled | DOM in fixed px | ⚠️ consistently small on big monitors; acceptable for a small arcade game |
| **C** | Scaled/fitted to the window | DOM in fixed px (`font-size:11px`, `width:278px`) | ❌ the board grows, the chrome doesn't — must fix |

Quick greps: `innerWidth|innerHeight|clientWidth|setSize` (surface sizing),
`vw|vh|vmin|clamp\(|zoom:|transform:\s*scale` (already relative), `font-size:\s*[0-9.]+px` (dozens of
these beside a fitted canvas = class C).

**The class C fix — a `--ui` zoom on the chrome only** (full reference: `sandfall.html`, search
`UI SCALE`):

1. One scale factor relative to 1080p, floored at 1 (1080p is byte-identical), capped at 2:
   ```js
   let UI_SCALE = 1;
   function setUiScale() {
     const s = Math.max(1, Math.min(2, Math.min(innerWidth / 1920, innerHeight / 1080)));
     UI_SCALE = Math.round(s * 100) / 100;
     document.documentElement.style.setProperty('--ui', String(UI_SCALE));
   }
   setUiScale();
   window.addEventListener('resize', () => { setUiScale(); /* then re-fit the board */ });
   ```
   Also call it at the top of the game's own fit function.
2. Apply it as CSS `zoom` to the chrome selectors only — panels, HUD bars, menus, dialogs, toasts:
   ```css
   :root{--ui:1}
   #title,.panel,#hudBar,#menu,.overlay,.pop{zoom:var(--ui)}
   ```
   `zoom`, not `transform:scale`, so zoomed panels push their neighbours. **Never zoom the element the
   fit function measures** (the canvas, its bezel, or the row holding both) — it would scale twice.
3. Make the fit function zoom-aware: `offsetWidth`/`offsetHeight` and CSS custom properties on a zoomed
   element report its own unzoomed pixels (multiply by `UI_SCALE`); `getBoundingClientRect()` reports
   zoomed screen pixels. Rects of unzoomed elements are always real.
4. Overlays with `inset:0` or percentages keep their place; absolute px offsets from an unzoomed
   parent drift — convert them.

**Verify at 1920×1080, 2560×1440 and 3840×2160** (browser devtools device emulation on the built root
file, reloading after each resize), reading numbers rather than eyeballing:

```js
({ ui: getComputedStyle(document.documentElement).getPropertyValue('--ui'),
   board: document.querySelector('canvas').getBoundingClientRect().height,
   panel: document.querySelector('.panel').getBoundingClientRect().width,
   overflow: document.documentElement.scrollHeight > innerHeight
          || document.documentElement.scrollWidth > innerWidth })
```

Pass: `--ui` is 1 at 1080p with an unchanged layout; at 1440p and 4K panels and HUD grow by the same
factor as the board; `overflow` is false. Check the pause, game-over and menu overlays at 1440p too.
Class A games: still check once at 1440p — fixed-px DOM readouts beside a fullscreen 3D view are
class C in disguise.

### 6g. Audio settings (required for every game that makes sound)

The player controls audio from **both the main menu and the pause menu**. Grep
`AudioContext|new Audio\(|<audio|type=["']range` plus `mute|volume|music|sfx`. If volume sliders
are already reachable from both menus, leave them. Otherwise add:

1. **Routing** — every sound through one master `GainNode` (loops and drones too — one-shot helpers
   that connect straight to `ctx.destination` are the usual leak). Mute/volume ramp that gain over
   ~20 ms; never "don't play if muted", which leaves running loops audible.
2. **Controls** — a Settings panel with a Volume slider (0–100); separate Music and SFX sliders (each
   its own gain under the master) if the game has both. An existing M-to-mute key stays, but the
   slider always wins: dragging it while muted unmutes.
3. **Access** — a Settings button on the main menu AND in the pause menu (6e); with no pause menu, a
   small ⚙ button in the in-game UI that pauses real-time play while open. Opening settings never
   starts a game, unpauses, or disturbs an online match; Back returns where the player came from;
   keys on a focused slider don't reach game input.
4. **Persistence** — localStorage under a game-specific key (not `gl_…`).
5. **Look** — the game's own fonts, colours and buttons; fits without scrolling at 1366×768 and
   1920×1080.

### 6h. Vendored engines — no engine from a CDN (required)

Every 3D/physics engine ships inside the app in root `vendor/`, so games start with no internet, and
`npm test` fails any game that loads three.js or cannon from a URL. Find the game's external
engines (every `https://` in `<script src>`, an import map, `import … from`). Leave Google Fonts and
PeerJS alone.

Available (one folder per library version, npm layout):

| Folder | Holds | Loaded as |
|---|---|---|
| `vendor/three-0.160.0/` | `build/three.module.min.js`, `examples/jsm/…` (addons in use) | ES module via importmap |
| `vendor/three-0.128.0/` | `build/three.min.js`, `examples/js/…` | classic `<script src>` |
| `vendor/cannon-0.6.2/` | `cannon.min.js` | classic `<script src>` |

If the game uses one of these exact versions, `rep()` its URLs to `./vendor/…` — always the `./`
prefix (import maps reject other relative forms; a leading `/` breaks the app and the website):

```html
<script type="importmap">
{ "imports": { "three": "./vendor/three-0.160.0/build/three.module.min.js",
               "three/addons/": "./vendor/three-0.160.0/examples/jsm/" } }
</script>
<script src="./vendor/three-0.128.0/build/three.min.js"></script>
```

Never change the engine version a game uses to fit an existing folder. If the version, or an addon
it imports, isn't in `vendor/` (check the folder), you can't add it — `vendor/` is outside the
partner's folder. Leave the CDN URL, record it as a **blocker** in the preview (`npm test` will fail
"vendored engines" until Nic adds the files), with the exact URLs the game loads. A page built in a
`srcdoc` iframe can use `./vendor/…` too; one built from a `blob:` URL needs an absolute URL computed
from `location.href`.

### 6i. Leaderboards and online lobbies

`npm test` fails a game that references `LeaderboardSDK` or `LobbySDK` without being in the matching
`preload.js` allowlist — which only Nic edits. So in a draft:
- Don't add leaderboard code. If the partner wants a global leaderboard, list it in open questions.
- A game written against `LobbySDK` is a **blocker** until Nic allowlists it — say so in the
  preview. A game with its own PeerJS netcode works as is (rule 4 of the contract still applies).

---

## 7. `entry.json`

The exact object that will sit in `games.json`. Use the same key order and formatting as an existing
partner entry (e.g. `partners/jertal/stations/entry.json`):

`developer`, `id`, `title`, `fileName`, `preferredWidth`, `preferredHeight`, `description`, `party`,
`hasCover`, `activeCoverType`, `coverConfig`, `tags`, `stats`, `achievements`

- `developer` — the partner's name from `partners/partners.json`
- `id` — `<newId>` (must equal the folder name); `fileName` — `<newId>.html`
- `party` — `"third"`; `hasCover` — `true`; `activeCoverType` — `"default"`
- `stats` — `{ "key", "label", "format" }` (+ `"total"` for `fraction`)
- `achievements` — `{ "id", "label", "desc", "icon" }`

The game will also appear on the website once Nic merges it — nothing extra to do for that; the
site build injects the browser GameSDK.

---

## 8. Build and verify

```bash
node partners/build.mjs <partner> <newId>
npm test
```

`npm test` must pass, except for blockers you recorded (6h, 6i) — name each failing check in the
preview. Fix everything else and re-run. Typical failures: an undeclared or unused stat/achievement
id, a missing `covers/<newId>.default.svg`, `--` in an SVG comment, a script that no longer parses
after a `rep()`, more than one `</html>`.

Then play it: launch the launcher (`npm start`) and start the game from the library, or use **Build &
play** on the Published tab. Confirm: the toasts for the easy achievements fire; Exit Game opens the
confirm and Cancel/Escape close it; Esc and P pause; the player chip shows your name; the volume
slider changes the sound and survives a reload; with the network off the engine still loads. Write
what you checked into the preview.

---

## 9. Update `DEVLOG.md`

Record what was built under `## Done` (today's date), set `**Status:**` to "onboarding draft ready for
review", and put anything a future session needs in `## Notes` — the anchors that were fiddly, which
functions the appended block wraps, any computed stat keys.

---

## 10. Write `ONBOARDING-PREVIEW.md` and STOP

Write `partners/<partner>/<newId>/ONBOARDING-PREVIEW.md` listing **everything** the onboarding
produced, in a form the partner can review line by line (it becomes the `## Onboarding` section of
the request):

```markdown
# <Title> — onboarding preview

**Id:** `<newId>` · **File:** `<newId>.html` · **Window:** <w> × <h>
**Tags:** Action, Roguelite
**Description:** <the description>

## Stats
| Key | Label | Format | Written where |
|---|---|---|---|
| `best_score` | Best Score | number | run end (`gameOver` wrapper), keepMax |

## Achievements
| Id | Icon | Name | Description | Triggered when (in code) |
|---|---|---|---|---|
| `first_play` | 👟 | First Steps | Play your first game | first `startRun()` |

## Covers
- `covers/<newId>.svg` / `.default.svg` — <the partner's image wrapped | the illustrated scene: what it shows>
- `covers/<newId>.minimalist.svg` — <the symbol, the gradient stops, why it fits>
- Renders: `work/default.png`, `work/minimalist.png`

## Integration (patch.mjs)
- Exit Game — <where the button is>
- Pause — <Esc + P / Esc only (P conflict) / N/A turn-based>
- Player chip — <where / skipped: online game>
- Screen scaling — class <A/B/C>; <selectors zoomed, numbers at 1080p / 1440p / 4K>
- Audio — <sliders, where they're reached, localStorage key / already present>
- Engines — <vendor folders used / none>
- Frame-rate fix — <loop patched / not needed>
- Background gradient — <applied / skipped>
- Online — <seat gating applied to …; writes online_wins|mp_wins / no online mode>

## Checks
- `npm test` — <passed / failing checks and why>
- Played in the launcher — <what was checked>

## Open questions and requests for Nic
- <anything outside the partner's folder: allowlist entries, vendor files, a new tag>
- <computed stat keys, injection points you couldn't find, cover crop/text issues>
```

**Then stop.** Do not commit, push or open a pull request. Tell the partner:

> The onboarding draft for <Title> is ready in `partners/<partner>/<newId>/`. Review
> `ONBOARDING-PREVIEW.md` — the draft is on the Dev Shelf's **Published** tab, where you can
> **Build & play** it. Ask me for any changes (stats, achievements, wording, covers). When you're
> happy, click **Send onboarding request** there.

If the partner asks for changes, make them (in `entry.json`, `patch.mjs`, `covers/`), rebuild,
re-run `npm test`, update the preview so it matches, and stop again.
