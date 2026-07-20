const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');

// ── GPU / rendering ────────────────────────────────
// Some machines (older laptops, integrated Intel GPUs, stale drivers) get put
// on Chromium's GPU blocklist and fall back to CPU/software rendering. That
// makes launcher SCROLLING stutter badly even though games (a single <canvas>)
// still run fine. Forcing acceleration back on restores smooth scrolling.
// These must run before app-ready. Safe and reversible: if a machine has a
// genuinely broken GPU driver, just delete these three lines.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

// ── Auto-updater ───────────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Forward every stage of the update lifecycle to the launcher window so the UI
// can show a progress bar and — importantly — surface errors instead of
// silently hanging on "Downloading…". launcherWin is assigned later; these
// closures only read it when an event fires, well after it's set.
function sendUpdateStatus(payload) {
  try {
    if (launcherWin && !launcherWin.isDestroyed()) {
      launcherWin.webContents.send('update-status', payload);
    }
  } catch {}
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus({ type: 'checking' }));
autoUpdater.on('update-available', (info) =>
  sendUpdateStatus({ type: 'available', version: info && info.version }));
autoUpdater.on('update-not-available', () => sendUpdateStatus({ type: 'none' }));
autoUpdater.on('download-progress', (p) => sendUpdateStatus({
  type: 'progress',
  percent: Math.round(p.percent || 0),
  transferred: p.transferred || 0,
  total: p.total || 0,
  bytesPerSecond: p.bytesPerSecond || 0,
}));

autoUpdater.on('update-downloaded', (info) => {
  sendUpdateStatus({ type: 'downloaded', version: info && info.version });
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
  sendUpdateStatus({ type: 'error', message: (err && (err.message || String(err))) || 'Unknown error' });
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
// Per-game overrides for BUNDLED games (whose full metadata ships with the app and
// can't be rewritten). Stores user-customizable fields — currently the chosen cover
// (activeCoverType) and any designed custom covers (customCovers) — keyed by game id.
const USER_OVERRIDES_JSON = path.join(USERDATA_DIR, 'user-game-overrides.json');
const USER_COVERS_DIR = path.join(USERDATA_DIR, 'covers');  // all runtime covers live here
// Records the verified sha256 of each downloaded external game, keyed by fileName.
// Lets the launcher tell a current copy from a stale one without re-hashing big
// files on every launch, and auto-redownload when a game's sha256 changes.
const EXTERNAL_VERSIONS_JSON = path.join(USERDATA_DIR, 'external-versions.json');
// Town Builder saved worlds — one .json file per town, per user, survives updates.
const TOWNBUILDER_SAVES_DIR = path.join(USERDATA_DIR, 'townbuilder-saves');

function readExternalVersions() {
  try { return JSON.parse(fs.readFileSync(EXTERNAL_VERSIONS_JSON, 'utf8')) || {}; }
  catch { return {}; }
}
function writeExternalVersion(fileName, sha256) {
  try {
    const m = readExternalVersions();
    m[fileName] = String(sha256).toLowerCase();
    fs.writeFileSync(EXTERNAL_VERSIONS_JSON, JSON.stringify(m, null, 2));
  } catch {}
}
// Stream-hash a file → Promise<hex sha256>. Used to verify (and backfill the
// manifest for) external game files downloaded before versioning existed.
function hashFile(filePath) {
  return new Promise((resolve) => {
    try {
      const h = crypto.createHash('sha256');
      const s = fs.createReadStream(filePath);
      s.on('data', (c) => h.update(c));
      s.on('end', () => resolve(h.digest('hex').toLowerCase()));
      s.on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

// Ensure all user directories exist
for (const dir of [USERDATA_DIR, USER_GAMES_DIR, USER_COVERS_DIR, TOWNBUILDER_SAVES_DIR]) {
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

// ── Cover sync (every launch) ──────────────────────────────────
// covers:// serves from USER_COVERS_DIR, so a stale userData copy used to
// shadow every bundled-cover redesign (the old fix was a one-time reseed tag
// that had to be bumped by hand — and never was). Now, on every launch, any
// bundled cover whose CONTENT changed since the last sync is re-copied.
// Rules: user-authored custom covers (`*.custom*.svg`) are never touched, and
// a game's plain active `<id>.svg` is only refreshed while it actually shows
// default art — if it matches the minimalist variant (individually picked OR
// via the customize panel's display-only "all minimalist" mode, which by
// design does not write activeCoverType anywhere) it is left alone.
try {
  let games = [];
  try {
    const gd = JSON.parse(fs.readFileSync(GAMES_JSON, 'utf8'));
    games = Array.isArray(gd) ? gd : (gd.games || []);
  } catch {}
  // The user's chosen cover for BUNDLED games lives in USER_OVERRIDES_JSON,
  // not games.json — reading only games.json here once clobbered every
  // minimalist pick back to default art on relaunch.
  let ov = {};
  try { ov = JSON.parse(fs.readFileSync(USER_OVERRIDES_JSON, 'utf8')) || {}; } catch {}
  const coverType = {};   // id → 'default' | 'minimalist' | null (custom)
  for (const g of games) {
    const t = (ov[g.id] && ov[g.id].activeCoverType) || g.activeCoverType || 'default';
    coverType[g.id] = (t === 'default' || t === 'minimalist') ? t : null;
  }
  // Change detection is CONTENT-based (manifest of bundle hashes), NOT mtime:
  // Windows CopyFile preserves the source's mtime, so an active cover the user
  // just set from an old variant file *looks* older than the bundle and an
  // mtime rule would clobber their pick on every launch.
  const MANIFEST = path.join(USER_COVERS_DIR, '.bundle-sync.json');
  let man = {};
  try { man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) || {}; } catch {}
  const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
  const readOr = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
  let manDirty = false;
  for (const f of fs.readdirSync(COVERS_DIR)) {
    if (!/\.(svg|png)$/.test(f)) continue;
    if (/\.custom/.test(f)) continue;                 // never fight user art
    const bundleBuf = readOr(path.join(COVERS_DIR, f));
    if (!bundleBuf) continue;
    const bh = sha(bundleBuf);
    if (man[f] === bh) continue;                      // bundle art unchanged since last sync
    const dstPath = path.join(USER_COVERS_DIR, f);
    const isVariant = /\.(default|minimalist)\.svg$/.test(f);
    let write = true;
    if (!isVariant) {
      // plain `<id>.svg`/`<id>.png` doubles as the game's ACTIVE cover — leave
      // it alone unless the user is actually showing the default art
      const id = f.replace(/\.(svg|png)$/, '');
      const cur = readOr(dstPath);
      if (cur) {
        if (coverType[id] === null) write = false;    // custom cover equipped
        else {
          const minBuf = readOr(path.join(USER_COVERS_DIR, `${id}.minimalist.svg`));
          if (minBuf && minBuf.equals(cur)) write = false;  // displaying minimalist (incl. "all minimalist" mode)
        }
      }
    }
    if (write) {
      try {
        if (fs.existsSync(dstPath)) { try { fs.chmodSync(dstPath, 0o666); } catch {} }
        fs.copyFileSync(path.join(COVERS_DIR, f), dstPath);
        try { fs.chmodSync(dstPath, 0o666); } catch {}
      } catch {}
    }
    man[f] = bh; manDirty = true;
  }
  if (manDirty) { try { fs.writeFileSync(MANIFEST, JSON.stringify(man, null, 1)); } catch {} }
  // Invariant + self-heal: a game on a built-in variant must have its active
  // `<id>.svg` byte-equal to that variant. Repairs stale variants after a
  // bundle refresh, active covers clobbered in the past, and a bundle whose
  // plain `<id>.svg` shipped stale relative to its `.default.svg`.
  for (const g of games) {
    const t = coverType[g.id];
    if (!t) continue;                                 // custom cover equipped - never touched
    const vp = path.join(USER_COVERS_DIR, `${g.id}.${t}.svg`);
    const ap = path.join(USER_COVERS_DIR, `${g.id}.svg`);
    try {
      if (!fs.existsSync(vp)) continue;
      const v = fs.readFileSync(vp);
      const a = fs.existsSync(ap) ? fs.readFileSync(ap) : null;
      if (!a || !v.equals(a)) {
        // "all minimalist" is display-only (it never writes activeCoverType),
        // so a game reading as 'default' may legitimately be showing the
        // minimalist art - leave its active file alone in that case.
        if (t === 'default' && a) {
          const minBuf = readOr(path.join(USER_COVERS_DIR, `${g.id}.minimalist.svg`));
          if (minBuf && minBuf.equals(a)) continue;
        }
        if (a) { try { fs.chmodSync(ap, 0o666); } catch {} }   /* Windows copies propagate read-only */
        fs.copyFileSync(vp, ap);
        try { fs.chmodSync(ap, 0o666); } catch {}
      }
    } catch {}
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
    icon: path.join(__dirname, 'assets', 'icon.png'),
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
    icon: path.join(__dirname, 'assets', 'icon.png'),
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
  launcherWin.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      launcherWin.webContents.toggleDevTools();
    }
  });

  // Renderer calls api.notifyReady() after init() completes.
  // Show the main window immediately (it renders under the splash),
  // then close the splash after 500ms so it's fully settled.
  ipcMain.once('launcher-ready', () => {
    launcherWin.maximize();
    launcherWin.show();
    setTimeout(() => {
      if (!splashWin.isDestroyed()) splashWin.close();
    }, 500);
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
  protocol.handle('covers', async (request) => {
    // Without standard: true, url is opaque: 'covers://void_assault_v2.svg'
    // Strip scheme and any query string to get the bare filename.
    const raw = decodeURIComponent(request.url.replace(/^covers:\/\/\/?/, '').split('?')[0]);
    // Harden against path traversal: path.basename() strips any directory or
    // "../" components, so covers://../../<file> cannot escape the covers dirs.
    // Covers are only ever .svg / .png, so reject anything else.
    const fileName = path.basename(raw);
    if (!/\.(svg|png)$/i.test(fileName)) return new Response(null, { status: 400 });
    // Check userData covers first (user-saved or seeded), fall back to bundled covers dir
    const candidates = [
      path.join(USER_COVERS_DIR, fileName),
      path.join(COVERS_DIR, fileName),
    ];
    for (const filePath of candidates) {
      try {
        // Async read: a burst of 26 cover requests (fresh launch / style switch)
        // used to serialize through readFileSync on the main-process event loop,
        // so covers popped in one at a time. readFile lets them overlap.
        const data     = await fs.promises.readFile(filePath);
        const mimeType = filePath.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
        // Let Chromium cache the decoded cover so re-renders / scrolling don't
        // trigger fresh fetches + synchronous disk reads. Cache busting is handled
        // by the `?v=<timestamp>` query the renderer appends when a cover changes,
        // so a long max-age is safe (a different URL is requested after an edit).
        return new Response(data, {
          headers: {
            'Content-Type': mimeType,
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
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
  // Merge persisted per-game overrides (e.g. user-chosen cover) onto bundled metadata,
  // so customizations to bundled games survive relaunch.
  let overrides = {};
  try { overrides = JSON.parse(fs.readFileSync(USER_OVERRIDES_JSON, 'utf8')) || {}; } catch {}
  for (const g of bundled) {
    const o = overrides[g.id];
    if (o && typeof o === 'object') Object.assign(g, o);
  }
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

// ── IPC: App info (version + dev flag) ─────────────────────────
// Used by the feedback module: version is attached to submitted feedback,
// and isDev auto-enables owner/inbox mode when running from source.
ipcMain.handle('get-app-info', () => {
  return { version: app.getVersion(), isDev: !app.isPackaged };
});

ipcMain.handle('get-global-achievements', () => {
  try {
    const gamesData = JSON.parse(fs.readFileSync(GAMES_JSON, 'utf8'));
    return !Array.isArray(gamesData) && gamesData.globalAchievements ? gamesData.globalAchievements : [];
  } catch {}
  return [];
});

ipcMain.handle('save-games', (_, games) => {
  // Only persist user-imported entries in full; bundled game metadata ships with the app.
  const userGames = games.filter(g => g.party === 'imported');
  fs.writeFileSync(USER_GAMES_JSON, JSON.stringify(userGames, null, 2));
  // Bundled games can't be rewritten wholesale, but users can customize their cover.
  // Persist just those override fields per id so they survive relaunch (see get-games).
  const overrides = {};
  for (const g of games) {
    if (g.party === 'imported') continue;
    const o = {};
    if (g.activeCoverType && g.activeCoverType !== 'default') o.activeCoverType = g.activeCoverType;
    if (Array.isArray(g.customCovers) && g.customCovers.length) o.customCovers = g.customCovers;
    if (Object.keys(o).length) overrides[g.id] = o;
  }
  try { fs.writeFileSync(USER_OVERRIDES_JSON, JSON.stringify(overrides, null, 2)); } catch {}
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

// Batch cover lookup: one stat pass instead of N `cover-exists` round-trips.
// Returns { [gameId]: mtimeMs } for every game whose active `<id>.svg` exists.
// The mtime doubles as a cache-busting version: the renderer appends it as
// `?v=<mtime>` to each cover URL, so the URL changes exactly when the file
// changes — which makes the long-lived covers:// cache safe (a different URL is
// requested after any edit, in this session or a future one).
ipcMain.handle('list-covers', () => {
  let ids = [];
  try {
    const gamesData = JSON.parse(fs.readFileSync(GAMES_JSON, 'utf8'));
    const bundled = Array.isArray(gamesData) ? gamesData : (gamesData.games || []);
    ids = bundled.map(g => g.id);
  } catch {}
  try {
    const userGames = JSON.parse(fs.readFileSync(USER_GAMES_JSON, 'utf8'));
    ids = ids.concat(userGames.map(g => g.id));
  } catch {}
  const out = {};
  for (const id of ids) {
    if (!id) continue;
    for (const dir of [USER_COVERS_DIR, COVERS_DIR]) {
      try {
        out[id] = fs.statSync(path.join(dir, `${id}.svg`)).mtimeMs;
        break;
      } catch {}
    }
  }
  return out;
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
    // Games always launch fullscreen (windowed size below is only the
    // fallback if a window ever leaves fullscreen). Every game ships an
    // in-game "Exit Game" button (window.close()) as the way out.
    fullscreen: true,
    width: preferredWidth || 1024,
    height: preferredHeight || 768,
    ...(winConstraints.minWidth  != null && { minWidth:  winConstraints.minWidth }),
    ...(winConstraints.maxWidth  != null && { maxWidth:  winConstraints.maxWidth }),
    ...(winConstraints.minHeight != null && { minHeight: winConstraints.minHeight }),
    ...(winConstraints.maxHeight != null && { maxHeight: winConstraints.maxHeight }),
    title: gameId,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  gameWin.setMenuBarVisibility(false);
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

// ── IPC: External (on-demand) games ───────────────────────────
// Large games are excluded from the installer and downloaded the first time
// the player opens them. "Installed" = the file is present either in the
// bundled library dir (dev machine) or in the userData games dir (downloaded).
// Version-aware: a file counts as "installed" only if it's the CURRENT version.
// expectedHash is the game's download.sha256 from games.json. If a user has a
// stale copy (downloaded before the game was finalized, or before a later fix),
// its hash won't match → reported not-installed → the launcher re-downloads the
// good copy. Matching files are confirmed cheaply via the manifest; a present
// file with no/old manifest entry is hashed once and backfilled.
ipcMain.handle('is-game-installed', async (_, fileName, expectedHash) => {
  try {
    // Dev machines keep external games in the bundled library dir — trust those as-is.
    if (fs.existsSync(path.join(LIBRARY_DIR, fileName))) return true;

    const userPath = path.join(USER_GAMES_DIR, fileName);
    if (!fs.existsSync(userPath)) return false;

    // No expected hash to compare against → fall back to existence (legacy behavior).
    if (!expectedHash) return true;
    const want = String(expectedHash).toLowerCase();

    // Fast path: manifest already records this file's verified hash.
    const recorded = readExternalVersions()[fileName];
    if (recorded) return recorded === want;

    // Slow path (once): file present but unversioned → hash it to decide.
    const got = await hashFile(userPath);
    if (got && got === want) { writeExternalVersion(fileName, got); return true; }
    return false; // stale or unreadable → treat as not installed so it re-downloads
  } catch { return false; }
});

// Download a game's payload to USER_GAMES_DIR, streaming progress to the
// renderer and (optionally) verifying a sha256. Downloads to a temp file and
// only moves it into place on success, so a failed/partial download leaves
// nothing behind.
ipcMain.handle('install-game', async (evt, gameId, fileName, download) => {
  return await new Promise((resolve) => {
    if (!download || !download.url) { resolve({ ok: false, error: 'No download URL' }); return; }
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const tmpPath  = path.join(app.getPath('temp'), `${gameId}.download`);
    const destPath = path.join(USER_GAMES_DIR, fileName);
    let file;
    try { file = fs.createWriteStream(tmpPath); }
    catch (e) { done({ ok: false, error: String(e) }); return; }
    const cleanupTmp = () => { try { fs.unlinkSync(tmpPath); } catch {} };

    const request = net.request(download.url);
    let received = 0, total = 0;
    const hash = crypto.createHash('sha256');

    request.on('response', (response) => {
      // GitHub release asset URLs redirect; Electron's net follows redirects automatically.
      if (response.statusCode !== 200) {
        try { file.close(); } catch {}
        cleanupTmp();
        done({ ok: false, error: `HTTP ${response.statusCode}` });
        return;
      }
      total = parseInt(response.headers['content-length'] || '0', 10);
      response.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        file.write(chunk);
        if (evt.sender && !evt.sender.isDestroyed()) {
          evt.sender.send('install-progress', { gameId, received, total });
        }
      });
      response.on('end', () => {
        file.end(() => {
          const got = hash.digest('hex').toLowerCase();
          if (download.sha256 && got !== String(download.sha256).toLowerCase()) {
            cleanupTmp();
            done({ ok: false, error: 'Checksum mismatch — download was corrupted' });
            return;
          }
          // Remove any existing (possibly stale) copy first so the move can't
          // fail on Windows when the destination already exists.
          try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
          try {
            fs.renameSync(tmpPath, destPath);
          } catch {
            // cross-device move fallback
            try { fs.copyFileSync(tmpPath, destPath); cleanupTmp(); }
            catch (e) { cleanupTmp(); done({ ok: false, error: String(e) }); return; }
          }
          // Record the verified version so future launches trust this copy
          // without re-hashing, and detect when it later goes stale.
          writeExternalVersion(fileName, got);
          done({ ok: true });
        });
      });
      response.on('error', (err) => { try { file.close(); } catch {} cleanupTmp(); done({ ok: false, error: String(err) }); });
    });
    request.on('error', (err) => { try { file.close(); } catch {} cleanupTmp(); done({ ok: false, error: String(err) }); });
    request.end();
  });
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
// Returns the active file's mtimeMs (number) when the cover was actually
// rewritten, 'unchanged' when it already matched the requested variant (no
// copy, no mtime churn), or false when the variant file doesn't exist / the
// copy failed. This is what keeps cover loading instant: the renderer only
// cache-busts a card's ?v= when the file really changed, and it busts to the
// same mtime value list-covers will report on the next launch — so the URL
// stays identical across sessions and Chromium serves every cover straight
// from its year-long immutable covers:// cache.
ipcMain.handle('select-native-cover', (_, gameId, type) => {
  // type = 'default' | 'minimalist' | 'custom1' | …
  // Source variant can be in USER_COVERS_DIR (if previously saved there) or COVERS_DIR (bundled)
  const src = fs.existsSync(path.join(USER_COVERS_DIR, `${gameId}.${type}.svg`))
    ? path.join(USER_COVERS_DIR, `${gameId}.${type}.svg`)
    : path.join(COVERS_DIR, `${gameId}.${type}.svg`);
  const dst = path.join(USER_COVERS_DIR, `${gameId}.svg`);
  if (!fs.existsSync(src)) return false;
  try {
    // Skip the copy entirely when the active cover is already byte-identical
    // to the requested variant. This is the common case on every launch (the
    // wall-style re-assert loop) and on re-pressing an already-active style.
    const srcBuf = fs.readFileSync(src);
    try {
      if (fs.existsSync(dst) && srcBuf.equals(fs.readFileSync(dst))) return 'unchanged';
    } catch {}
    // NOTE: on Windows fs.copyFileSync preserves the source's read-only
    // attribute. A cover copied from a read-only bundled file therefore leaves
    // the active <id>.svg read-only, and the NEXT copy onto it fails with EPERM
    // — which is why some covers (e.g. a newly-onboarded game) appeared
    // impossible to select and were skipped by the "apply to all" toggle. Clear
    // the read-only flag on the destination before and after writing so
    // re-selecting a cover always succeeds.
    if (fs.existsSync(dst)) { try { fs.chmodSync(dst, 0o666); } catch {} }
    fs.copyFileSync(src, dst);
    try { fs.chmodSync(dst, 0o666); } catch {}
    // Report the new mtime so the renderer's ?v= matches what list-covers
    // returns next launch (same URL → cache hit instead of one more refetch).
    try { return fs.statSync(dst).mtimeMs; } catch { return Date.now(); }
  } catch (e) {
    console.error('[select-native-cover] copy failed for', gameId, type, '->', e && e.message);
    return false;
  }
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

// ── IPC: Manual update check ───────────────────────────────────
ipcMain.handle('check-for-updates-manual', async () => {
  if (!app.isPackaged) return { status: 'dev' };
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) return { status: 'up-to-date' };
    const latestVer = result.updateInfo.version;
    if (latestVer && latestVer !== app.getVersion()) {
      return { status: 'found', version: latestVer };
    }
    return { status: 'up-to-date' };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
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

// ── IPC: Town Builder saved worlds (file-backed, in userData/townbuilder-saves) ─
// Each town is one <file>.json holding { format, name, time, grid, blocks }.
// The `file` id passed across IPC is the base filename WITHOUT the .json extension.
// All names are sanitized to safe filenames; the display name is kept inside the JSON.
function tbSanitizeName(name) {
  const s = String(name == null ? '' : name)
    .replace(/[ -\\/:*?"<>|]/g, '')     // illegal Windows filename chars
    .replace(/[ -]/g, '')   // control chars
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')               // no leading dots
    .trim()
    .slice(0, 48);
  return s || 'town';
}
function tbFileId(file) {
  // Reduce any incoming id/path to a safe base filename (no dirs, no extension).
  return tbSanitizeName(path.basename(String(file == null ? '' : file)).replace(/\.json$/i, ''));
}
function tbPathFor(file) {
  return path.join(TOWNBUILDER_SAVES_DIR, tbFileId(file) + '.json');
}
function tbUniqueId(baseName, excludeId) {
  const base = tbSanitizeName(baseName);
  let id = base, i = 2;
  while (id !== excludeId && fs.existsSync(path.join(TOWNBUILDER_SAVES_DIR, id + '.json'))) {
    id = base + ' ' + (i++);
  }
  return id;
}

ipcMain.handle('tb-list-saves', () => {
  const out = [];
  try {
    for (const f of fs.readdirSync(TOWNBUILDER_SAVES_DIR)) {
      if (!/\.json$/i.test(f)) continue;
      const file = f.replace(/\.json$/i, '');
      try {
        const d = JSON.parse(fs.readFileSync(path.join(TOWNBUILDER_SAVES_DIR, f), 'utf8'));
        out.push({ file, name: d.name || file, time: d.time || 0, blockCount: Array.isArray(d.blocks) ? d.blocks.length : 0 });
      } catch { out.push({ file, name: file, time: 0, blockCount: 0 }); }
    }
  } catch {}
  return out;
});

ipcMain.handle('tb-read-save', (_, file) => {
  try { return JSON.parse(fs.readFileSync(tbPathFor(file), 'utf8')); }
  catch { return null; }
});

ipcMain.handle('tb-write-save', (_, file, data) => {
  try {
    const id = file ? tbFileId(file) : tbUniqueId((data && data.name) || 'town');
    fs.writeFileSync(path.join(TOWNBUILDER_SAVES_DIR, id + '.json'), JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, file: id, name: (data && data.name) || id };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('tb-delete-save', (_, file) => {
  try { fs.unlinkSync(tbPathFor(file)); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('tb-rename-save', (_, file, newName) => {
  try {
    const oldId = tbFileId(file);
    const oldPath = path.join(TOWNBUILDER_SAVES_DIR, oldId + '.json');
    const d = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    const name = String(newName == null ? '' : newName).trim().slice(0, 48) || 'town';
    const newId = tbUniqueId(name, oldId);
    d.name = name;
    fs.writeFileSync(path.join(TOWNBUILDER_SAVES_DIR, newId + '.json'), JSON.stringify(d, null, 2), 'utf8');
    if (newId !== oldId) { try { fs.unlinkSync(oldPath); } catch {} }
    return { ok: true, file: newId, name };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('tb-copy-save', (_, file) => {
  try {
    const d = JSON.parse(fs.readFileSync(tbPathFor(file), 'utf8'));
    const name = String((d.name || 'town') + ' copy').slice(0, 48);
    const newId = tbUniqueId(name);
    d.name = name; d.time = Date.now();
    fs.writeFileSync(path.join(TOWNBUILDER_SAVES_DIR, newId + '.json'), JSON.stringify(d, null, 2), 'utf8');
    return { ok: true, file: newId, name };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// Export a copy of a town's .json to the user's Downloads folder, then reveal it.
ipcMain.handle('tb-export-save', (_, file) => {
  try {
    const src = tbPathFor(file);
    if (!fs.existsSync(src)) return { ok: false, error: 'not found' };
    const downloads = app.getPath('downloads');
    const stem = tbFileId(file);
    let dest = path.join(downloads, stem + '.json'), i = 2;
    while (fs.existsSync(dest)) dest = path.join(downloads, stem + ' (' + (i++) + ').json');
    fs.copyFileSync(src, dest);
    try { fs.chmodSync(dest, 0o666); } catch {}
    try { shell.showItemInFolder(dest); } catch {}
    return { ok: true, path: dest };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
