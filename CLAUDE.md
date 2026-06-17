# Pickle Arcade — Project Notes for Claude

## CRITICAL: File Writing Rule
**Always use the `Edit` or `Write` tools to modify files. Never use bash `cat >>`, `echo >>`, `sed -i`, or any shell-based file writes.**

The project files live on a Windows filesystem mounted into a Linux sandbox. Bash writes go through the mount layer; Edit/Write use the Windows API directly. When both are mixed, the Windows file ends up with duplicate or stale fragments that cause silent runtime errors (the bash `node --check` passes but Electron loads the corrupted Windows version). This has caused repeated hard-to-debug truncation bugs.

If a file is too large to edit in one call, use multiple `Edit` calls — never fall back to shell appends.

---

## Project Overview
**Pickle Arcade** — an Electron-based game launcher for a personal collection of HTML games.

- **Entry point:** `main.js` (Electron main process)
- **UI:** `index.html` + `style.css` + `renderer.js` (renderer process)
- **Bridge:** `preload.js` (contextBridge, exposes `electronAPI` and `GameSDK`)
- **Game data:** `games.json`
- **Player data:** `playerdata.json` (persists stats/achievements across sessions)
- **Covers:** `covers/` folder — SVG files named `{gameId}.svg`

## Architecture Notes
- `ipcMain.handle` / `ipcRenderer.invoke` for all main↔renderer communication
- `GameSDK` (in preload.js) is the SDK games call to record stats and achievements
- Game windows have a separate localStorage origin — stats sync via `sync-game-storage` IPC
- `playerdata.json` mirrors all `gl_*` localStorage keys so data survives reinstalls

## Recurring Truncation Warning
Files — especially `renderer.js`, `preload.js`, `index.html`, `style.css` — have been silently truncated in the past, likely due to the bash/Windows mount divergence described above. If the launcher hangs on load, check these files for truncation by reading their last ~20 lines. Common symptoms: `Unexpected token '}'`, `Unexpected end of input`, or missing `</html>`.

## Debugging
To open DevTools temporarily, add this line to `main.js` after `setMenuBarVisibility`:
```js
launcherWin.webContents.openDevTools();
```
Remove it once the issue is diagnosed.

## Distribution & Auto-Updates

The app is distributed via GitHub Releases with `electron-builder` + `electron-updater`.

- **Repo:** https://github.com/nicgardiner/pickle-arcade
- **Current version:** check `"version"` in `package.json`
- **Build tool:** `electron-builder` (devDependency), config is in `package.json` under `"build"`
- **Update logic:** `electron-updater` in `main.js` — checks for updates on launch (packaged builds only), auto-downloads, prompts "Restart now / Later" when ready

### To ship a new release
1. Bump `"version"` in `package.json` (e.g. `"1.0.0"` → `"1.0.1"`)
2. Run `npm run dist` in cmd from the Game Library folder — produces a `dist/` folder
3. Go to https://github.com/nicgardiner/pickle-arcade/releases → Draft a new release
4. Tag it `v1.0.1` (must match the version number with a `v` prefix)
5. Upload these three files from `dist/`:
   - `Pickle Arcade Setup X.X.X.exe`
   - `Pickle Arcade Setup X.X.X.exe.blockmap`
   - `latest.yml`
6. Publish — users get an auto-update prompt on next launch

### Users installing fresh
Direct them to: https://github.com/nicgardiner/pickle-arcade/releases — download and run the `.exe`.

---

## Style Conventions
- Dark theme: CSS variables `--bg`, `--bg2`, `--bg3`, `--accent`, `--accent2`, `--gold`, `--text`, `--muted`
- Accent color is user-customizable (default: `#10b981` emerald)
- Game cards: `aspect-ratio: 2/3`, hover scales to 1.1 with drop shadow
- Filter panel (`#filter-panel`) collapses to 10px via `max-height` transition; content shifts via `#filter-panel-inner` translateY
- Right-click context menu: `#card-context-menu` (Play, Open Card, Favorite)
