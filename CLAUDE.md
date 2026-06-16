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

## Style Conventions
- Dark theme: CSS variables `--bg`, `--bg2`, `--bg3`, `--accent`, `--accent2`, `--gold`, `--text`, `--muted`
- Accent color is user-customizable (default: `#10b981` emerald)
- Game cards: `aspect-ratio: 2/3`, hover scales to 1.1 with drop shadow
- Filter panel (`#filter-panel`) collapses to 10px via `max-height` transition; content shifts via `#filter-panel-inner` translateY
- Right-click context menu: `#card-context-menu` (Play, Open Card, Favorite)
