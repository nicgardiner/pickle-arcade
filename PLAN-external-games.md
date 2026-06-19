# Plan: On-Demand "External" Games (Black Knight)

**Goal:** Keep large games (Black Knight, 200MB+) *listed* in the library but
**out of the installer**. When the user opens the card, they get an **Install**
button; clicking it downloads a zip from a dedicated GitHub release, unpacks it,
and the card flips to **Play**.

**Decisions locked in:**
- Hosting: **dedicated GitHub release/tag** per big game (fixed URL, no re-upload on launcher updates).
- On-disk format: **zip downloaded + unpacked** (single-file `.html` handled as a trivial special case).
- This is a **plan only** — no code has been changed.

---

## Why this fits your launcher almost for free

The existing `open-game` handler (`main.js` ~line 348) already resolves a game by
checking the **bundled library dir first, then the userData games dir**:

```js
let gamePath = path.join(LIBRARY_DIR, fileName);
if (!fs.existsSync(gamePath)) gamePath = path.join(USER_GAMES_DIR, fileName);
```

`USER_GAMES_DIR` is `%APPDATA%\Pickle Arcade\games\` — the same place imported
games already live and which **never ships in the installer**. So if we download
and unpack Black Knight into `USER_GAMES_DIR`, **the launch path needs no changes
at all** — it just works the moment the file exists. All the new work is: (1) a
flag in games.json, (2) an Install button + download IPC, (3) excluding the heavy
file from the build, (4) hosting the zip on GitHub.

GitHub Releases allow assets up to **2GB each**, so a 200MB zip is well within limits.

---

## 1. games.json schema additions

Add a few fields to the Black Knight entry (and any future big game). The card
metadata (cover, title, description, tags) stays in games.json and ships normally
— only the heavy HTML payload is held back.

```jsonc
{
  "id": "black_knight_16",
  "title": "Black Knight",
  "fileName": "black_knight_16.html",   // resolved in USER_GAMES_DIR after install
  "external": true,                      // NEW: not bundled; install on demand
  "installSizeMB": 210,                  // NEW: shown on the Install button
  "download": {                          // NEW: where to fetch the payload
    "url": "https://github.com/nicgardiner/pickle-arcade/releases/download/game-black-knight-v1/black-knight.zip",
    "type": "zip",                       // "zip" | "html"
    "entry": "black_knight_16.html"      // file to launch after unpack (zip only)
  }
  // ...existing stats, achievements, tags unchanged
}
```

Notes:
- `external: true` is the only flag the renderer needs to branch on.
- For a single self-contained HTML game you could set `"type": "html"` and point
  `url` straight at the `.html` asset — the installer just saves it as
  `fileName`. Black Knight uses `zip`.
- `entry` lets the zip contain a folder of assets while still telling the
  launcher which file to load.

---

## 2. "Installed?" state (renderer + a tiny manifest)

We need to know, per machine, whether an external game is installed. Two options;
recommend **B** for robustness.

**A. localStorage flag** — `gl_installed_black_knight_16 = "1"`. Simple, but can
drift from reality if the user clears the userData games folder.

**B. (recommended) Truth = does the file exist in `USER_GAMES_DIR`?** Add one IPC,
`is-game-installed(fileName)` → `fs.existsSync(path.join(USER_GAMES_DIR, fileName))`.
The renderer asks at card-render time. No drift, no stale flags. Optionally cache
the answer in memory for the session.

Card / modal logic:
- `external && !installed` → show **⬇ Install (210 MB)** button.
- `external && installed`  → show normal **▶ Play** button.
- non-external → unchanged.

The Play buttons live in `renderer.js` (card at ~line 541, modal play at ~line 856).
We branch there on `g.external` + the install check.

---

## 3. Download + unpack IPC (main.js)

New handler `install-game`, modeled on the existing `copy-game-file` /
`open-game` patterns. Uses Electron's `net`/`https` for the download (you already
ship `electron-updater`, so HTTPS downloads are familiar) and unzips into
`USER_GAMES_DIR`.

```js
// pseudocode — real version uses Edit, never bash writes
ipcMain.handle('install-game', async (evt, gameId, download) => {
  const tmp = path.join(app.getPath('temp'), `${gameId}.download`);
  // 1. stream download.url -> tmp, emitting progress to the renderer:
  //    evt.sender.send('install-progress', { gameId, received, total })
  // 2. verify size (and ideally a sha256 from games.json) before trusting it
  // 3. if download.type === 'zip': extract tmp -> USER_GAMES_DIR/<gameId>/ (or root)
  //    if download.type === 'html': copy tmp -> USER_GAMES_DIR/<fileName>
  // 4. clean up tmp; return { ok: true }
});
```

Implementation choices to confirm at build time:
- **Unzip dependency:** add a small lib (e.g. `extract-zip` or `adm-zip`) as a
  dependency, OR shell out to the OS. `extract-zip` is the cleanest cross-version
  pick. (One new dependency.)
- **Where the zip unpacks:** simplest is to unpack a flat `black_knight_16.html`
  (plus any sibling assets) directly into `USER_GAMES_DIR`, so the existing
  resolver finds it with no path changes. If the game needs an asset subfolder,
  unpack into `USER_GAMES_DIR/black_knight_16/` and set `entry` accordingly — but
  that would require the resolver to also check that subfolder (a ~2-line tweak).
  **Recommend flat-into-USER_GAMES_DIR if Black Knight is one HTML file with
  inlined assets** (most of your games are), which keeps `open-game` untouched.
- **Integrity:** put a `sha256` next to the download URL in games.json and verify
  after download. Cheap insurance against a corrupt/partial 200MB transfer.

### Progress UI
Renderer listens for `install-progress` and shows a bar on the card/modal
(0–100%). On completion, re-check `is-game-installed` and swap to Play. On
failure, restore the Install button and show a retry.

---

## 4. preload.js bridge

Expose the two new IPCs on `electronAPI`:

```js
installGame: (gameId, download) => ipcRenderer.invoke('install-game', gameId, download),
isGameInstalled: (fileName)     => ipcRenderer.invoke('is-game-installed', fileName),
onInstallProgress: (cb)         => ipcRenderer.on('install-progress', (_, d) => cb(d)),
```

---

## 5. Keep Black Knight OUT of the installer (release-pusher + build.files)

Today `package.json` → `build.files` is `"**/*"` with `!` exclusions, so
**every root `.html` ships**. To exclude the big game's payload from the
installer, add an exclusion:

```jsonc
"!black_knight_16.html"
```

…to both `package.json` → `build.files` **and** `.gitignore` (so the 200MB file
isn't committed/pushed to the repo either — it lives only as a release asset).

**release-pusher interaction (important):** that skill has a Step 1b guard that
flags any root `.html` *not* listed in games.json as a "stray import" to exclude.
Black Knight **is** in games.json, so the skill would currently treat it as a
bundled game that must ship — the opposite of what we want. The plan therefore
includes a **small change to release-pusher's logic**: treat a game as
"don't ship the file" when its games.json entry has `"external": true`, even
though it stays in games.json. Concretely, Step 1b/Step 2 gain a rule:

> A root `.html` ships **only if** it appears in games.json **and** that entry is
> not `external: true`. An `external` game's `.html`/zip must be excluded from
> `build.files` and `.gitignore`, and its payload uploaded as a release asset
> instead.

This keeps the existing "never ship imported games" protection intact while
adding "never ship external games' payloads."

---

## 6. Hosting on GitHub (your manual step at release time)

Per the locked-in decision, big games get their **own tag**, separate from the
launcher's `vX.Y.Z` releases, so you don't re-upload 200MB every launcher update:

1. Zip the finished game: `black-knight.zip` (the `.html` + any assets).
2. On GitHub → Releases → **Draft a new release**.
3. Tag it `game-black-knight-v1` (bump to `-v2` only when the *game* changes).
4. Upload `black-knight.zip` as the asset.
5. Publish. The asset URL is then the fixed
   `…/releases/download/game-black-knight-v1/black-knight.zip` you put in
   games.json's `download.url`.

When you later update Black Knight, cut `game-black-knight-v2`, upload the new
zip, and bump the URL (and `sha256`) in games.json — that games.json change rides
along in the *next normal launcher release*, which is tiny.

---

## 7. Edge cases to handle in the build

- **Offline / failed download:** keep Install button, show error + Retry. No
  partial file left behind (download to temp, move into place only on success).
- **Re-install / update:** if a newer `game-black-knight-v2` URL appears, detect
  version mismatch and offer "Update" (same flow, overwrites).
- **Uninstall:** optional — a context-menu "Uninstall" that deletes the file from
  `USER_GAMES_DIR` to reclaim space, reverting the card to Install.
- **First-run import sweep:** `main.js` already moves loose root `.html` files
  into `USER_GAMES_DIR` on launch (lines 85–106). Since Black Knight won't be in
  the bundle, this sweep won't touch it — good. Just confirm the sweep doesn't
  treat a *downloaded* Black Knight as something to re-process.

---

## Summary of changes when we implement

| File | Change |
|---|---|
| `games.json` | Add `external`, `installSizeMB`, `download{url,type,entry,sha256}` to Black Knight |
| `main.js` | New `install-game` + `is-game-installed` IPC; download+unzip into `USER_GAMES_DIR` |
| `preload.js` | Expose `installGame` / `isGameInstalled` / `onInstallProgress` |
| `renderer.js` | Install button + progress UI; branch Play vs Install on `external` + installed check |
| `package.json` | `"!black_knight_16.html"` in `build.files`; add `extract-zip` dependency |
| `.gitignore` | Exclude `black_knight_16.html` (and zip) from the repo |
| `release-pusher/SKILL.md` | Add rule: `external: true` games stay in games.json but their payload is excluded from the build |
| GitHub (manual) | Create `game-black-knight-v1` release, upload `black-knight.zip` |

**No change needed** to the `open-game` launch path — the existing
library→userData fallback handles installed external games automatically.
