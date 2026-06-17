const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// ── Auto-updater ───────────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Update ready',
    message: 'A new version of Pickle Arcade has been downloaded. It will be installed when you quit.',
    buttons: ['Restart now', 'Later']
  }).then(({ response }) => {
    if (response === 0) autoUpdater.quitAndInstall();
  });
});

autoUpdater.on('error', (err) => {
  console.error('Auto-updater error:', err);
});

// Set display name before any getPath calls so userData folder is named correctly
app.setName('Pickle Arcade');

// Register covers:// as a privileged scheme so the renderer can load cover images
// from userData (user covers) or the app bundle (bundled covers).
// Must be called before app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'covers', privileges: { secure: true, supportFetchAPI: true, bypassCSP: true } },
]);

// ── Directory constants ────────────────────────────────────────
const LIBRARY_DIR     = __dirname;
const COVERS_DIR      = path.join(LIBRARY_DIR, 'covers');   // bundled covers (read-only in prod)
const GAMES_JSON      = path.join(LIBRARY_DIR, 'games.json'); // bundled game list
const CHANGELOG_JSON  = path.join(LIBRARY_DIR, 'changelog.json'); // What's New / patch notes

// User-writable data — survives every app update and reinstall
const USERDATA_DIR    = app.getPath('userData'); // e.g. AppData\Roaming\Pickle Arcade
const PLAYERDATA_JSON = path.join(USERDATA_DIR, 'playerdata.json');
const USER_GAMES_DIR  = path.join(USERDATA_DIR, 'games');   // imported game HTML files
const USER_GAMES_JSON = path.join(USERDATA_DIR, 'user-games.json');
const USER_COVERS_DIR = path.join(USERDATA_DIR, 'covers');  // all runtime covers live here

// Ensure all user directories exist
for (const dir of [USERDATA_DIR, USER_GAMES_DIR, USER_COVERS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── One-time migrations ────────────────────────────────────────
// playerdata: move from old app-folder location to userData
const LEGACY_PLAYERDATA = path.join(LIBRARY_DIR, 'playerdata.json');
if (!fs.existsSync(PLAYERDATA_JSON) && fs.existsSync(LEGACY_PLAYERDATA)) {
  try { fs.copyFileSync(LEGACY_PLAYERDATA, PLAYERDATA_JSON); } catch {}
}

// Migrate legacy "arcade" cover variant → "minimalist" (the variant was briefly
// named "arcade"; "Arcade" is no longer a cover type). Rename any leftover
// "*.arcade.svg" in the user covers dir to "*.minimalist.svg" (don't clobber an
// existing minimalist cover).
try {
  for (const f of fs.readdirSync(USER_COVERS_DIR)) {
    if (!f.endsWith('.arcade.svg')) continue;
    const minimalistName = f.replace(/\.arcade\.svg$/, '.minimalist.svg');
    const minimalistPath = path.join(USER_COVERS_DIR, minimalistName);
    const arcadePath = path.join(USER_COVERS_DIR, f);
    if (!fs.existsSync(minimalistPath)) fs.renameSync(arcadePath, minimalistPath);
    else fs.unlinkSync(arcadePath);
  }
} catch {}

// Bundled covers → USER_COVERS_DIR (copy any that aren't there yet so user covers
// survive updates; a user-customised cover already in USER_COVERS_DIR is never overwritten)
try {
  const bundledCovers = fs.readdirSync(COVERS_DIR).filter(f => /\.(svg|png)$/.test(f));
  for (const f of bundledCovers) {
    const dest = path.join(USER_COVERS_DIR, f);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(COVERS_DIR, f), dest);
  }
} catch {}

// Imported game files: if any HTML files in LIBRARY_DIR aren't bundled games,
// move them to USER_GAMES_DIR so they survive the first update.
try {
  let bundledFiles = new Set();
  try {
    const gamesData = JSON.parse(fs.readFileSync(GAMES_JSON, 'utf8'));
    const gamesList = Array.isArray(gamesData) ? gamesData : (gamesData.games || []);
    gamesList.forEach(g => {
      if (g.file) bundledFiles.add(g.file);
    });
  } catch {}
  const htmlFiles = fs.readdirSync(LIBRARY_DIR).filter(f =>
    f.endsWith('.html') && f !== 'index.html' && f !== 'splash.html' && !bundledFiles.has(f)
  );
  for (const f of htmlFiles) {
    const dest = path.join(USER_GAMES_DIR, f);
    if (!fs.existsSync(dest)) {
      try { fs.copyFileSync(path.join(LIBRARY_DIR, f), dest); } catch {}
    }
  }
} catch {}

let launcherWin = null;
const gameWindows = new Map(); // gameId -> BrowserWindow
const lsCache = {}; // mirrors localStorage keys synced from game windows

// ── Persistent player data ─────────────────────────────────────
// playerData mirrors all gl_* localStorage keys to disk so stats/achievements
// survive localStorage clears, app updates, and reinstalls.
let playerData = {};
try {
  playerData = JSON.parse(fs.readFileSync(PLAYERDATA_JSON, 'utf8'));
} catch {}

function savePlayerData() {
  try { fs.writeFileSync(PLAYERDATA_JSON, JSON.stringify(playerData, null, 2)); } catch {}
}

// ── Single-instance lock ───────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // A second instance was launched — show a notice then quit immediately
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: 'info',
      title: 'Pickle Arcade Already Running',
      message: 'Pickle Arcade is already open.',
      detail: 'Only one instance can run at a time. Check your taskbar.',
      buttons: ['OK'],
    });
  });
  app.quit();
}

// If a second instance tries to launch, focus the existing window
app.on('second-instance', () => {
  if (launcherWin) {
    if (launcherWin.isMinimized()) launcherWin.restore();
    launcherWin.focus();
  }
});

// Ensure covers directory exists
if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR);

function createLauncher() {
  // ── Splash window — shown immediately, closed once launcher is ready ──
  const splashWin = new BrowserWindow({
    width: 380,
    height: 280,
    frame: false,
    transparent: false,
    resizable: false,
    center: true,
    backgroundColor: '#0a0a0f',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  splashWin.loadFile('splash.html');
  splashWin.setMenuBarVisibility(false);
  splashWin.setAlwaysOnTop(true); // stays visible while main window renders underneath

  // ── Main launcher window — hidden until renderer signals ready ──
  launcherWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Pickle Arcade',
    backgroundColor: '#0a0a0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  launcherWin.loadFile('index.html');
  launcherWin.setMenuBarVisibility(false);

  // Renderer calls api.notifyReady() after init() completes.
  // Show the main window immediately (it renders under the splash),
  // then close the splash after 500ms so it's fully settled.
  ipcMain.once('launcher-ready', () => {
    setTimeout(() => {
      launcherWin.maximize();
      launcherWin.show();
      setTimeout(() => {
        if (!splashWin.isDestroyed()) splashWin.close();
      }, 500);
    }, 1000);
  });

  launcherWin.on('closed', () => {
    launcherWin = null;
    if (!splashWin.isDestroyed()) splashWin.close();
    app.quit();
  });
}

app.whenReady().then(() => {
  // Check for updates (only runs in packaged production builds)
  if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify();

  // covers:// protocol — serves from USER_COVERS_DIR (user-customised or seeded bundled covers).
  // This keeps cover loading working in production where __dirname is inside a read-only asar.
  protocol.handle('covers', (request) => {
    // Without standard: true, url is opaque: 'covers://void_assault_v2.svg'
    // Strip scheme and any query string to get the bare filename.
    const fileName = decodeURIComponent(request.url.replace(/^covers:\/\/\/?/, '').split('?')[0]);
    // Check userData covers first (user-saved or seeded), fall back to bundled covers dir
    const candidates = [
      path.join(USER_COVERS_DIR, fileName),
      path.join(COVERS_DIR, fileName),
    ];
    for (const filePath of candidates) {
      try {
        const data     = fs.readFileSync(filePath);
        const mimeType = filePath.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
        return new Response(data, { headers: { 'Content-Type': mimeType } });
      } catch {}
    }
    return new Response(null, { status: 404 });
  });

  createLauncher();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!launcherWin) createLauncher(); });

// ── IPC: Games metadata ────────────────────────────────────────
ipcMain.handle('get-games', () => {
  let bundled = [];
  let userGames = [];
  try {
    const gamesData = JSON.parse(fs.readFileSync(GAMES_JSON, 'utf8'));
    bundled = Array.isArray(gamesData) ? gamesData : (gamesData.games || []);
  } catch {}
  try { userGames = JSON.parse(fs.readFileSync(USER_GAMES_JSON, 'utf8')); } catch {}
  return [...bundled, ...userGames];
});

// ── IPC: What's New / changelog ────────────────────────────────
// Returns { version, releases }. `version` is the running app version so the
// renderer can flag the newest release as unseen on first launch after update.
ipcMain.handle('get-changelog', () => {
  let releases = [];
  try {
    const data = JSON.parse(fs.readFileSync(CHANGELOG_JSON, 'utf8'));
    releases = Array.isArray(data) ? data : (data.releases || []);
  } catch {}
  return { version: app.getVersion(), releases };
});

ipcMain.handle('get-global-achievements', () => {
  try {
    const gamesData = JSON.parse(fs.readFileSync(GAMES_JSON, 'utf8'));
    return !Array.isArray(gamesData) && gamesData.globalAchievements ? gamesData.globalAchievements : [];
  } catch {}
  return [];
});

ipcMain.handle('save-games', (_, games) => {
  // Only persist user-imported entries; bundled game metadata ships with the app.
  const userGames = games.filter(g => g.party === 'imported');
  fs.writeFileSync(USER_GAMES_JSON, JSON.stringify(userGames, null, 2));
});

ipcMain.handle('scan-games', () => {
  const fromLibrary = fs.readdirSync(LIBRARY_DIR).filter(f =>
    f.endsWith('.html') && f !== 'index.html' && f !== 'splash.html'
  );
  let fromUser = [];
  try { fromUser = fs.readdirSync(USER_GAMES_DIR).filter(f => f.endsWith('.html')); } catch {}
  return [...new Set([...fromLibrary, ...fromUser])];
});

// ── IPC: Cover art ─────────────────────────────────────────────
// All runtime covers (bundled + user) are written to USER_COVERS_DIR so they
// survive app updates. Bundled covers are seeded there on first launch (above).
ipcMain.handle('save-cover', (_, gameId, data) => {
  if (typeof data === 'string' && data.trimStart().startsWith('<svg')) {
    const filePath = path.join(USER_COVERS_DIR, `${gameId}.svg`);
    fs.writeFileSync(filePath, data, 'utf8');
    return filePath;
  }
  // Legacy PNG data URL
  const base64 = data.replace(/^data:image\/png;base64,/, '');
  const filePath = path.join(USER_COVERS_DIR, `${gameId}.png`);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return filePath;
});

ipcMain.handle('cover-exists', (_, gameId) => {
  return fs.existsSync(path.join(USER_COVERS_DIR, `${gameId}.svg`));
});

// List the cover *variant* keys that have a file on disk for a game.
// e.g. files "chess.default.svg" / "chess.minimalist.svg" / "chess.custom1.svg"
// → returns ['default','minimalist','custom1']. The active copy ("chess.svg") is excluded.
ipcMain.handle('list-cover-variants', (_, gameId) => {
  const esc = String(gameId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + esc + '\\.(.+)\\.svg$');
  const variants = new Set();
  for (const dir of [USER_COVERS_DIR, COVERS_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(re);
        if (m) variants.add(m[1]);
      }
    } catch {}
  }
  return [...variants];
});

// Save an SVG as a named cover variant: "{gameId}.{variantId}.svg".
ipcMain.handle('save-cover-variant', (_, gameId, variantId, data) => {
  const filePath = path.join(USER_COVERS_DIR, `${gameId}.${variantId}.svg`);
  fs.writeFileSync(filePath, data, 'utf8');
  return filePath;
});

// Delete a named cover variant file.
ipcMain.handle('delete-cover-variant', (_, gameId, variantId) => {
  try {
    const p = path.join(USER_COVERS_DIR, `${gameId}.${variantId}.svg`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch { return false; }
});

// ── IPC: Opening games ─────────────────────────────────────────
ipcMain.handle('open-game', (_, gameId, fileName, preferredWidth, preferredHeight, winConstraints = {}) => {
  // If already open, focus it
  if (gameWindows.has(gameId)) {
    const existing = gameWindows.get(gameId);
    if (!existing.isDestroyed()) {
      existing.focus();
      return;
    }
  }

  // Resolve game file — check bundled library first, then user games folder
  let gamePath = path.join(LIBRARY_DIR, fileName);
  if (!fs.existsSync(gamePath)) gamePath = path.join(USER_GAMES_DIR, fileName);
  if (!fs.existsSync(gamePath)) {
    dialog.showErrorBox('Game Not Found', `Could not find: ${fileName}`);
    return;
  }

  const gameWin = new BrowserWindow({
    width: preferredWidth || 1024,
    height: preferredHeight || 768,
    ...(winConstraints.minWidth  != null && { minWidth:  winConstraints.minWidth }),
    ...(winConstraints.maxWidth  != null && { maxWidth:  winConstraints.maxWidth }),
    ...(winConstraints.minHeight != null && { minHeight: winConstraints.minHeight }),
    ...(winConstraints.maxHeight != null && { maxHeight: winConstraints.maxHeight }),
    title: gameId,
    backgroundColor: '#111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  gameWin.setMenuBarVisibility(false);
  gameWin.maximize();
  const playerName   = (playerData['gl_player_name']   || '').trim() || 'Player';
  const playerEmblem = (playerData['gl_player_emblem'] || '').trim() || '🎮';
  gameWin.loadFile(gamePath, { query: { gameId, playerName, playerEmblem } });
  gameWindows.set(gameId, gameWin);

  // (Durable backup is restored in preload.js via the synchronous
  // 'get-game-backup' IPC, before the game's own scripts run.)

  gameWin.on('closed', () => {
    gameWindows.delete(gameId);
    // Send snapshot of all synced localStorage so launcher applies it synchronously
    if (launcherWin && !launcherWin.isDestroyed()) {
      launcherWin.webContents.send('game-closed', gameId, { ...lsCache });
    }
  });
});

// ── IPC: Add game (file picker + copy) ────────────────────────
ipcMain.handle('pick-game-file', async () => {
  const result = await dialog.showOpenDialog(launcherWin, {
    title: 'Select a Game File',
    filters: [{ name: 'HTML Games', extensions: ['html'] }],
    properties: ['openFile'],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('copy-game-file', (_, srcPath) => {
  const fileName = path.basename(srcPath);
  const destPath = path.join(USER_GAMES_DIR, fileName);
  fs.copyFileSync(srcPath, destPath);
  return fileName;
});

// ── IPC: Achievement notifications (game → launcher) ──────────
ipcMain.on('achievement-unlocked', (event, gameId, achievementId) => {
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.send('achievement-toast', { gameId, achievementId });
  }
});

// ── IPC: Sync game localStorage → launcher localStorage ────────
// Game windows have a separate localStorage origin from the launcher.
// Games call sync-game-storage so stats/achievements appear in the launcher.
ipcMain.on('sync-game-storage', (event, key, value) => {
  lsCache[key] = value; // cache so we can send a reliable snapshot on game-close
  playerData[key] = value; // persist to disk
  savePlayerData();
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.executeJavaScript(
      `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});` +
      `window.dispatchEvent(new CustomEvent('game-storage-sync',{detail:{key:${JSON.stringify(key)}}}));`
    ).catch(() => {});
  }
});

// ── IPC: Sync launcher-side localStorage keys → playerdata.json ──
// Called by renderer when it writes keys that don't come from game windows
// (recently played, favorites, playtime, global achievements, etc.)
ipcMain.on('sync-launcher-storage', (_, key, value) => {
  playerData[key] = value;
  savePlayerData();
});

// ── IPC: Load playerdata → used by renderer to seed localStorage ──
ipcMain.handle('get-playerdata', () => playerData);

// ── IPC (sync): game preload pulls this game's durable backup before page JS ──
// Returns only this game's mirrored keys (gl_<gameId>_*) plus global
// achievements, so the game window can restore stats/achievements/save on a
// fresh install. Synchronous so it completes before the game's scripts run.
ipcMain.on('get-game-backup', (event, gameId) => {
  const out = {};
  if (gameId) {
    const prefix = `gl_${gameId}_`;
    for (const k in playerData) {
      if (k.startsWith(prefix) || k === 'gl_global_achievements') out[k] = playerData[k];
    }
  }
  event.returnValue = out;
});

// ── IPC: Select a cover variant (copy {gameId}.{type}.svg → {gameId}.svg) ───
ipcMain.handle('select-native-cover', (_, gameId, type) => {
  // type = 'default' | 'minimalist' | 'custom1' | …
  // Source variant can be in USER_COVERS_DIR (if previously saved there) or COVERS_DIR (bundled)
  const src = fs.existsSync(path.join(USER_COVERS_DIR, `${gameId}.${type}.svg`))
    ? path.join(USER_COVERS_DIR, `${gameId}.${type}.svg`)
    : path.join(COVERS_DIR, `${gameId}.${type}.svg`);
  const dst = path.join(USER_COVERS_DIR, `${gameId}.svg`);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    return true;
  }
  return false;
});

// ── IPC: Delete imported game ──────────────────────────────────
ipcMain.handle('delete-game', (_, gameId, fileName) => {
  try {
    // Game file lives in user games dir; also check legacy LIBRARY_DIR just in case
    for (const dir of [USER_GAMES_DIR, LIBRARY_DIR]) {
      const p = path.join(dir, fileName);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    // Covers always in USER_COVERS_DIR now
    for (const ext of ['svg', 'png']) {
      const p = path.join(USER_COVERS_DIR, `${gameId}.${ext}`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch {}
});

// ── IPC: Stats (read localStorage from launcher context) ───────
ipcMain.handle('get-ls-key', async (_, key) => {
  if (!launcherWin || launcherWin.isDestroyed()) return null;
  try {
    const result = await launcherWin.webContents.executeJavaScript(
      `JSON.parse(localStorage.getItem(${JSON.stringify(key)}) || 'null')`
    );
    return result;
  } catch {
    return null;
  }
});
