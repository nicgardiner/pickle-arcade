const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { createPlayerDataStore } = require('./playerdata-store');

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
// Scribble Sled free-draw sketches — one .json per sketch, same file-backed shape.
const SLED_SAVES_DIR = path.join(USERDATA_DIR, 'scribblesled-saves');

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
for (const dir of [USERDATA_DIR, USER_GAMES_DIR, USER_COVERS_DIR, TOWNBUILDER_SAVES_DIR, SLED_SAVES_DIR]) {
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
      // games.json calls this field `fileName`. Reading `g.file` left bundledFiles EMPTY,
      // so this migration was copying every bundled game into USER_GAMES_DIR as well —
      // and open-game falls back to that copy whenever the LIBRARY_DIR file is missing.
      // Rename a game's file and the launcher would silently serve a months-old snapshot
      // instead of failing loudly. (That is how an early Vectordrome prototype ended up
      // shadowing the real game.)
      // lowercased, defensively: games.json and disk once disagreed on case for a
      // game (backrooms_Maze.html vs backrooms_maze.html — since renamed) and Windows
      // does not care, so an exact-match Set would treat such a game as un-bundled
      // and copy it anyway.
      if (g.fileName) bundledFiles.add(String(g.fileName).toLowerCase());
    });
  } catch {}
  const htmlFiles = fs.readdirSync(LIBRARY_DIR).filter(f =>
    f.endsWith('.html') && f !== 'index.html' && f !== 'splash.html' &&
    !bundledFiles.has(f.toLowerCase())
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
// survive localStorage clears, app updates, and reinstalls. It is the only
// durable copy of everything the player has earned, so the read/write side
// lives in playerdata-store.js: atomic (tmp + rename) writes, a known-good
// playerdata.bak snapshot, recovery-instead-of-overwrite when the file is
// damaged, and debounced writes so a game spamming stats doesn't hammer the
// main process with a full-file write per key.
//
// NOTE: playerDataStore.data is a STABLE object reference — playerData is only
// ever mutated (playerData[k] = v / delete playerData[k]), never reassigned, so
// everything holding it (get-playerdata, get-game-backup, get-player-identity,
// the playtime clocks) keeps seeing live data across a recovery load.
const playerDataStore = createPlayerDataStore(PLAYERDATA_JSON, {
  debounceMs: 250,
  maxDelayMs: 1000,
});
const playerData = playerDataStore.data;
playerDataStore.load();

// Marks the data dirty and schedules an atomic write ~250ms later (never more
// than ~1s after the first pending change). Same name/signature as the old
// synchronous writer, so every existing call site is unchanged.
function savePlayerData() { playerDataStore.save(); }

// Write immediately if anything is pending. Called when a game window closes
// and when the app quits, so the last stat of a session can't be lost.
function flushPlayerData(opts) { playerDataStore.flush(opts); }

// Push a launcher-side key to disk AND into the launcher window's localStorage,
// firing the same 'game-storage-sync' event a game's own stat write would.
function pushLauncherKey(key, value) {
  playerData[key] = value;
  lsCache[key] = value;
  savePlayerData();
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.executeJavaScript(
      `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});` +
      `window.dispatchEvent(new CustomEvent('game-storage-sync',{detail:{key:${JSON.stringify(key)}}}));`
    ).catch(() => {});
  }
}

// ── Playtime clocks (crash-proof) ──────────────────────────────
// Playtime used to be a single stopwatch variable in the launcher RENDERER,
// committed in one lump when the game window closed. Every hard exit dropped
// the whole session: PC shutdown, crash, task-kill, closing the launcher
// mid-game (that quits the app, so the close event had nobody to deliver to),
// or reloading the launcher. Two games open at once was worse — the single
// timer was overwritten, so one game got the other's minutes and the other got
// zero. The main process now keeps one clock per game window and flushes it to
// playerdata.json every tick, so a crash costs at most PLAYTIME_TICK_MS.
const PLAYTIME_TICK_MS  = 30000;
// A flush can never legitimately cover much more than one tick, so anything
// larger means the machine slept/hibernated with the game open — bank a tick
// and drop the gap rather than crediting eight hours of sleep as playtime.
const PLAYTIME_MAX_TICK = (PLAYTIME_TICK_MS / 1000) * 2;
const playtimeClocks = new Map(); // gameId -> { timer, last }

function flushPlaytime(gameId) {
  const clock = playtimeClocks.get(gameId);
  if (!clock) return;
  const now = Date.now();
  let elapsed = Math.floor((now - clock.last) / 1000);
  if (elapsed <= 0) return;
  clock.last += elapsed * 1000;              // keep the sub-second remainder
  if (elapsed > PLAYTIME_MAX_TICK) { elapsed = PLAYTIME_MAX_TICK; clock.last = now; }
  const key  = `gl_${gameId}_playtime`;
  const prev = parseInt(playerData[key] || '0', 10) || 0;
  pushLauncherKey(key, String(prev + elapsed));
}

function startPlaytimeClock(gameId) {
  stopPlaytimeClock(gameId);
  const clock = { last: Date.now(), timer: null };
  clock.timer = setInterval(() => flushPlaytime(gameId), PLAYTIME_TICK_MS);
  playtimeClocks.set(gameId, clock);
}

function stopPlaytimeClock(gameId) {
  const clock = playtimeClocks.get(gameId);
  if (!clock) return;
  flushPlaytime(gameId);
  clearInterval(clock.timer);
  playtimeClocks.delete(gameId);
}

// Quitting closes game windows, but do a belt-and-braces flush in case a
// clock is still running when the app tears down. Bank the playtime FIRST
// (stopPlaytimeClock → pushLauncherKey → savePlayerData marks dirty), then
// force the pending write to disk and refresh the .bak snapshot.
app.on('before-quit', () => {
  for (const id of [...playtimeClocks.keys()]) stopPlaytimeClock(id);
  flushPlayerData({ backup: true });
});
// Belt and braces: 'will-quit' fires after 'before-quit' and covers anything
// that dirtied the data during teardown.
app.on('will-quit', () => {
  flushPlayerData({ backup: true });
});

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

  // ── Permissions: game allowlist ───────────────────────────────
  // Before these handlers existed Electron auto-granted everything, so the
  // allowlist has to keep the capabilities games already rely on: pointer lock,
  // fullscreen, and clipboard — plus 'media', which Electron denies for
  // getUserMedia in file:// windows unless the session says otherwise (Dub Club
  // and any future recording game need it). Everything else — geolocation,
  // notifications, midi, HID, … — stays denied. The check handler is what makes
  // enumerateDevices() return real device LABELS instead of blank strings.
  const GAME_PERMISSIONS = new Set(['media', 'pointerLock', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(GAME_PERMISSIONS.has(permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => GAME_PERMISSIONS.has(permission));

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

// ── IPC: Per-game update tracking ──────────────────────────────
// Fingerprints every game (its raw games.json / user-games.json entry plus
// the game file's bytes) and stamps the current time whenever a fingerprint
// changes, so the renderer can sort by "Recently updated". Stamps live in
// userData, so they survive app updates — which is exactly when they change.
const GAME_UPDATES_JSON = path.join(USERDATA_DIR, 'game-updates.json');
let gameUpdatesCache = null; // { gameId: updatedAt-ms }, computed once per run

ipcMain.handle('get-game-updates', () => {
  if (gameUpdatesCache) return gameUpdatesCache;
  let bundled = [];
  let userGames = [];
  try {
    const gamesData = JSON.parse(fs.readFileSync(GAMES_JSON, 'utf8'));
    bundled = Array.isArray(gamesData) ? gamesData : (gamesData.games || []);
  } catch {}
  try { userGames = JSON.parse(fs.readFileSync(USER_GAMES_JSON, 'utf8')) || []; } catch {}

  let stored = null;
  try { stored = JSON.parse(fs.readFileSync(GAME_UPDATES_JSON, 'utf8')); } catch {}
  // First run ever: baseline everything at 0 (unknown) instead of stamping the
  // whole library as freshly updated the day this feature arrives.
  const firstRun = !stored || typeof stored !== 'object';
  if (firstRun) stored = {};

  const next = {};
  const result = {};
  for (const g of [...bundled, ...userGames]) {
    if (!g || !g.id) continue;
    // User-customizable cover fields don't count as a game update.
    const { activeCoverType, customCovers, ...entry } = g;
    const h = crypto.createHash('sha256').update(JSON.stringify(entry));
    // External games update via their games.json entry (download.sha256
    // changes), so the entry alone is the fingerprint — hashing the local
    // file would stamp "updated" the moment the user merely installs it.
    if (!g.external && g.fileName) {
      for (const dir of [LIBRARY_DIR, USER_GAMES_DIR]) {
        try { h.update(fs.readFileSync(path.join(dir, g.fileName))); break; } catch {}
      }
    }
    const fp = h.digest('hex');
    const prev = stored[g.id];
    const at = (prev && prev.fp === fp) ? (prev.at || 0) : (firstRun ? 0 : Date.now());
    next[g.id] = { fp, at };
    result[g.id] = at;
  }
  try { fs.writeFileSync(GAME_UPDATES_JSON, JSON.stringify(next, null, 1)); } catch {}
  gameUpdatesCache = result;
  return result;
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

// ── IPC: Open a URL in the user's default browser ──────────────
// Deliberately narrow: http(s) only, so a compromised renderer can't hand
// shell.openExternal a file:// or custom-protocol URL and get code execution.
ipcMain.handle('open-external', async (_, url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'blocked-protocol' };
    await shell.openExternal(u.href);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
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
      autoplayPolicy: 'no-user-gesture-required', // game audio starts without a first click
    },
  });

  gameWin.setMenuBarVisibility(false);
  const playerName   = (playerData['gl_player_name']   || '').trim() || 'Player';
  const playerEmblem = (playerData['gl_player_emblem'] || '').trim() || '🎮';
  gameWin.loadFile(gamePath, { query: { gameId, playerName, playerEmblem } });
  gameWindows.set(gameId, gameWin);
  startPlaytimeClock(gameId);

  // Claim keyboard/wheel focus explicitly.
  // A window created with `fullscreen: true` on Windows can end up visible but
  // with an UNFOCUSED webContents: mouse-move events are routed by cursor
  // position, so hover states and clicks all look fine, while wheel and key
  // events — which go to the *focused* webContents — go nowhere. The user only
  // gets it back by clicking something in the window (which is why grabbing the
  // scrollbar, or opening and cancelling a file dialog, "fixes" scrolling).
  // Focusing the native window alone is not enough; the webContents needs it too.
  const claimFocus = () => {
    if (gameWin.isDestroyed()) return;
    gameWin.focus();
    gameWin.webContents.focus();
  };
  gameWin.once('ready-to-show', claimFocus);
  gameWin.webContents.once('did-finish-load', claimFocus);

  // (Durable backup is restored in preload.js via the synchronous
  // 'get-game-backup' IPC, before the game's own scripts run.)

  gameWin.on('closed', () => {
    gameWindows.delete(gameId);
    stopPlaytimeClock(gameId);   // banks the final partial tick
    flushPlayerData();           // the session's last stat write hits disk now
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

// ── IPC: Drop a key from playerdata.json ───────────────────────
// The counterpart to sync-launcher-storage. Without it a localStorage.removeItem
// in the renderer only lasted until the next launch, because startup re-seeds
// localStorage from playerdata.json — so removing a game left its stats behind
// forever. Used by the data migrations and by "remove from library".
ipcMain.on('remove-launcher-storage', (_, key) => {
  delete playerData[key];
  delete lsCache[key];
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

// ── IPC (sync): the launcher's online identity, for leaderboard game windows ──
// leaderboard-sdk.js signs in with the launcher's persistent anonymous Firebase
// user (refresh token minted by feedback.js) so a score posted from inside a
// game belongs to the same "you" the launcher shows. Game windows have their
// own localStorage origin, so preload copies these keys in before page JS runs.
ipcMain.on('get-player-identity', (event) => {
  const out = {};
  for (const k of ['gl_fb_refresh', 'gl_fb_uid', 'gl_player_id', 'gl_player_name', 'gl_player_emblem']) {
    if (playerData[k]) out[k] = playerData[k];
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
    // Windows CopyFile carries the SOURCE file's mtime onto the copy, so the
    // active cover comes back wearing its variant's timestamp — and covers
    // written in one pass share a timestamp (Windows' clock ticks every ~15ms):
    // a freshly onboarded game's `<id>.svg`/`.default.svg`/`.minimalist.svg`,
    // and EVERY cover seeded out of app.asar on a packaged build's first launch.
    // Switching such a game's cover could therefore hand back the exact mtime it
    // already had, leaving the renderer's `?v=` unchanged for art that did
    // change — a stale cover that only a relaunch clears. Stamp the active file
    // so its version always moves when its bytes do (the stamp is what
    // list-covers reports next launch, so the URL still stays stable across
    // sessions and covers keep coming from cache).
    try { const now = new Date(); fs.utimesSync(dst, now, now); } catch {}
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
    .replace(/[\x00-\x1f\\/:*?"<>|]/g, '')     // illegal Windows filename chars
    .replace(/[\x00-\x1f]/g, '')   // control chars
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

// ── IPC: generic per-game save folders (file-backed, one .json per save) ───────
// Same contract as the tb-* handlers above (which predate this helper and are
// left alone): the `file` id crossing IPC is the base filename WITHOUT .json,
// and the display name lives inside the JSON so renaming never loses a save.
//   registerSaveFolderIpc('ss', SLED_SAVES_DIR, 'sketch', d => ({ lineCount: … }))
// gives ss-list-saves / ss-read-save / ss-write-save / ss-delete-save /
//       ss-rename-save / ss-copy-save / ss-export-save.
function registerSaveFolderIpc(prefix, dir, fallbackName, metaOf) {
  const sanitize = (name) => {
    const s = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|]/g, '')        // illegal Windows filename chars
      .replace(/[\x00-\x1f]/g, '')          // control chars
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')                  // no leading dots
      .trim()
      .slice(0, 48);
    return s || fallbackName;
  };
  const fileId = (file) =>
    sanitize(path.basename(String(file == null ? '' : file)).replace(/\.json$/i, ''));
  const pathFor = (file) => path.join(dir, fileId(file) + '.json');
  const uniqueId = (baseName, excludeId) => {
    const base = sanitize(baseName);
    let id = base, i = 2;
    while (id !== excludeId && fs.existsSync(path.join(dir, id + '.json'))) id = base + ' ' + (i++);
    return id;
  };
  const meta = (d, file) => {
    let extra = {};
    try { extra = (metaOf && metaOf(d)) || {}; } catch {}
    return Object.assign({ file, name: (d && d.name) || file, time: (d && d.time) || 0 }, extra);
  };

  ipcMain.handle(prefix + '-list-saves', () => {
    const out = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/\.json$/i.test(f)) continue;
        const file = f.replace(/\.json$/i, '');
        try { out.push(meta(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), file)); }
        catch { out.push(meta(null, file)); }
      }
    } catch {}
    return out;
  });

  ipcMain.handle(prefix + '-read-save', (_, file) => {
    try { return JSON.parse(fs.readFileSync(pathFor(file), 'utf8')); }
    catch { return null; }
  });

  ipcMain.handle(prefix + '-write-save', (_, file, data) => {
    try {
      const id = file ? fileId(file) : uniqueId((data && data.name) || fallbackName);
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(data), 'utf8');
      return { ok: true, file: id, name: (data && data.name) || id };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle(prefix + '-delete-save', (_, file) => {
    try { fs.unlinkSync(pathFor(file)); return { ok: true }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle(prefix + '-rename-save', (_, file, newName) => {
    try {
      const oldId = fileId(file);
      const oldPath = path.join(dir, oldId + '.json');
      const d = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
      const name = String(newName == null ? '' : newName).trim().slice(0, 48) || fallbackName;
      const newId = uniqueId(name, oldId);
      d.name = name;
      fs.writeFileSync(path.join(dir, newId + '.json'), JSON.stringify(d), 'utf8');
      if (newId !== oldId) { try { fs.unlinkSync(oldPath); } catch {} }
      return { ok: true, file: newId, name };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle(prefix + '-copy-save', (_, file) => {
    try {
      const d = JSON.parse(fs.readFileSync(pathFor(file), 'utf8'));
      const name = String((d.name || fallbackName) + ' copy').slice(0, 48);
      const newId = uniqueId(name);
      d.name = name; d.time = Date.now();
      fs.writeFileSync(path.join(dir, newId + '.json'), JSON.stringify(d), 'utf8');
      return { ok: true, file: newId, name };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // Copy a save's .json into the user's Downloads folder, then reveal it.
  ipcMain.handle(prefix + '-export-save', (_, file) => {
    try {
      const src = pathFor(file);
      if (!fs.existsSync(src)) return { ok: false, error: 'not found' };
      const downloads = app.getPath('downloads');
      const stem = fileId(file);
      let dest = path.join(downloads, stem + '.json'), i = 2;
      while (fs.existsSync(dest)) dest = path.join(downloads, stem + ' (' + (i++) + ').json');
      fs.copyFileSync(src, dest);
      try { fs.chmodSync(dest, 0o666); } catch {}
      try { shell.showItemInFolder(dest); } catch {}
      return { ok: true, path: dest };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

// Scribble Sled: each sketch is { app:'scribble-sled', v, name, time, start, goal, lines }.
registerSaveFolderIpc('ss', SLED_SAVES_DIR, 'sketch',
  (d) => ({ lineCount: (d && Array.isArray(d.lines)) ? d.lines.length : 0 }));

// ── IPC: Dub Club — import limits + finished-clip export ─────────────────────
// Video for the Scene Studio comes from exactly two places now: a file the
// player picks themselves, and the YouTube importer further down. An Internet
// Archive importer used to live here too; it was removed in full — their API
// had multi-hour outages that left the panel staring at a spinner, and the
// browsable catalogue was rarely material anyone wanted to dub.
const DUB_MAX_BYTES = 250 * 1024 * 1024;   // hard cap on one imported video
const DUB_STALL_TIMEOUT = 25000;           // give up if a download delivers no bytes for this long

// Save a finished dub (webm bytes from MediaRecorder) to Downloads, then reveal
// it — same contract as the *-export-save handlers above.
ipcMain.handle('dub-export-clip', async (_, fileNameHint, data) => {
  try {
    if (!data) return { ok: false, error: 'no data' };
    const stem = String(fileNameHint == null ? '' : fileNameHint)
      .replace(/\.webm$/i, '')
      .replace(/[\\/:*?"<>|]/g, '')        // illegal Windows filename chars
      .replace(/[\x00-\x1f]/g, '')          // control chars
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')                  // no leading dots
      .trim()
      .slice(0, 48) || 'dub';
    const downloads = app.getPath('downloads');
    let dest = path.join(downloads, stem + '.webm'), i = 2;
    while (fs.existsSync(dest)) dest = path.join(downloads, stem + ' (' + (i++) + ').webm');
    fs.writeFileSync(dest, Buffer.from(data));
    try { fs.chmodSync(dest, 0o666); } catch {}
    try { shell.showItemInFolder(dest); } catch {}
    return { ok: true, path: dest };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// ── Dub Club — YouTube import, via yt-dlp ─────────────────────
// YouTube no longer hands out plain stream URLs. InnerTube returns SABR
// (`server_abr_streaming_url`) on every client, and the JS libraries that used
// to paper over this are gone — @distube/ytdl-core has been archived and
// read-only since Aug 2025. yt-dlp is the only implementation that still
// speaks the protocol, so this path shells out to it instead of fetching
// anything itself.
//
// Two constraints keep it from sprawling:
//   * Only PROGRESSIVE (muxed audio+video) formats are ever requested. Those
//     still carry an ordinary https URL, so there is no DASH merge step and
//     therefore no ffmpeg dependency. In practice that is format 18 — 640x360
//     h.264/AAC — small, but plenty for dubbing, and it downloads in seconds
//     rather than minutes.
//   * The binary is never bundled. YouTube breaks extractors every few months;
//     a copy frozen into an installer would rot between app releases. It is
//     fetched on first use and refreshed in the background instead.
//
// App-only by nature: it needs a subprocess, so on the website the game hides
// this UI entirely and leaves file import as the only way in (the game
// feature-checks the bridge). See the Dub Club block in preload.js.

const YTDLP_ASSET = process.platform === 'win32' ? 'yt-dlp.exe'
                  : process.platform === 'darwin' ? 'yt-dlp_macos'
                  : 'yt-dlp_linux';
const YTDLP_RELEASES = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const YTDLP_STALE_MS = 7 * 24 * 60 * 60 * 1000;   // re-check for a newer build weekly
const YTDLP_MAX_BYTES = 60 * 1024 * 1024;          // sanity ceiling on the binary itself

// Progressive only, best effort first. `18` is the near-universal 360p muxed
// mp4; the second clause catches anything else muxed and h.264; the last is a
// desperate "any single file with both tracks". If all three miss, the video
// is DASH-only and we say so rather than dragging in ffmpeg.
const DUB_YT_FORMAT = '18/' +
  'best[protocol^=http][vcodec^=avc1][acodec^=mp4a][ext=mp4]/' +
  'best[protocol^=http][acodec!=none][vcodec!=none]';

const DUB_YT_MAX_SECONDS = 3 * 60 * 60;

// Which InnerTube client yt-dlp extracts with, pinned deliberately. Left to
// itself it leads with `android_vr`, whose progressive URLs intermittently
// answer the media request with HTTP 403 — the probe succeeds (it only
// resolves a URL) and then the download dies, which is exactly the failure
// this pinning fixes. Measured over 5 videos x 2 rounds: `android` 10/10,
// default 8/10 with two 403s on videos that had worked minutes earlier.
// Order matters — the first client that yields a progressive format wins, and
// the other two are fallbacks for videos `android` has nothing for. Most other
// clients (web, ios, tv, mweb, web_embedded) are SABR-only and expose no
// progressive format at all.
const DUB_YT_CLIENTS = 'android,android_vr,tv_embedded';

function ytdlpDir()      { return path.join(app.getPath('userData'), 'tools'); }
function ytdlpExe()      { return path.join(ytdlpDir(), YTDLP_ASSET); }
function ytdlpMetaFile() { return path.join(ytdlpDir(), 'yt-dlp.json'); }

function ytdlpMeta() {
  try { return JSON.parse(fs.readFileSync(ytdlpMetaFile(), 'utf8')) || {}; } catch { return {}; }
}
function ytdlpSaveMeta(m) {
  try {
    fs.mkdirSync(ytdlpDir(), { recursive: true });
    fs.writeFileSync(ytdlpMetaFile(), JSON.stringify(m, null, 2));
  } catch {}
}

// GitHub wants a User-Agent and answers quickly or not at all, so this keeps a
// short leash rather than letting a dead connection hang the setup step.
async function ytdlpFetch(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await net.fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'PickleArcade', accept: 'application/octet-stream, application/json, text/plain' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  } finally { clearTimeout(timer); }
}

// Downloading an executable unattended is only defensible because every
// release publishes SHA2-256SUMS next to the binary. No checksum, no install.
async function ytdlpInstall(tag, notify) {
  const base = 'https://github.com/yt-dlp/yt-dlp/releases/download/' + encodeURIComponent(tag) + '/';

  const sums = await (await ytdlpFetch(base + 'SHA2-256SUMS')).text();
  const row = sums.split('\n')
    .map((l) => l.trim())
    .find((l) => l.endsWith(' ' + YTDLP_ASSET) || l.endsWith('*' + YTDLP_ASSET));
  const want = row ? String(row.split(/\s+/)[0] || '').toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(want)) throw new Error('ytdlp-nochecksum');

  const res = await ytdlpFetch(base + YTDLP_ASSET);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0, lastPct = -1;
  // The header timeout above is already spent by the time bytes start moving,
  // so the body needs its own stall watchdog or a mid-transfer hang from the
  // CDN would wedge the import dialog with no way out.
  for (;;) {
    let chunk;
    try {
      chunk = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ytdlp-stalled')), 30000)),
      ]);
    } catch (e) {
      try { await reader.cancel(); } catch {}
      throw e;
    }
    if (chunk.done) break;
    got += chunk.value.length;
    if (got > YTDLP_MAX_BYTES) { try { await reader.cancel(); } catch {} throw new Error('ytdlp-toobig'); }
    chunks.push(Buffer.from(chunk.value));
    const pct = total ? Math.min(99, Math.round((got / total) * 100)) : 0;
    if (notify && pct !== lastPct) { lastPct = pct; notify({ stage: 'setup', pct, bytes: got, total }); }
  }
  const buf = Buffer.concat(chunks, got);
  if (crypto.createHash('sha256').update(buf).digest('hex') !== want) throw new Error('ytdlp-badchecksum');

  fs.mkdirSync(ytdlpDir(), { recursive: true });
  const dest = ytdlpExe();
  const tmp = dest + '.new';
  fs.writeFileSync(tmp, buf);
  try { fs.chmodSync(tmp, 0o755); } catch {}
  try {
    fs.rmSync(dest, { force: true });
    fs.renameSync(tmp, dest);
  } catch (e) {
    // Windows refuses to replace a running exe. An older-but-working copy beats
    // failing the import, so keep it and try again on the next stale check.
    try { fs.rmSync(tmp, { force: true }); } catch {}
    if (!fs.existsSync(dest)) throw e;
    return dest;
  }
  ytdlpSaveMeta({ version: tag, checkedAt: Date.now(), installedAt: Date.now() });
  return dest;
}

async function ytdlpProvision(notify, force) {
  const exe = ytdlpExe();
  const meta = ytdlpMeta();
  const have = fs.existsSync(exe);
  if (have && !force && meta.checkedAt && (Date.now() - meta.checkedAt) < YTDLP_STALE_MS) return exe;

  let tag = null;
  try {
    const rel = await (await ytdlpFetch(YTDLP_RELEASES)).json();
    tag = rel && rel.tag_name ? String(rel.tag_name) : null;
  } catch {
    // Offline or GitHub having a moment. An installed copy still works fine —
    // only a first-ever run has nothing to fall back to.
    if (have) return exe;
    throw new Error('ytdlp-offline');
  }
  if (!tag) { if (have) return exe; throw new Error('ytdlp-offline'); }
  if (have && meta.version === tag) {
    ytdlpSaveMeta(Object.assign({}, meta, { checkedAt: Date.now() }));
    return exe;
  }
  if (notify) notify({ stage: 'setup', pct: 0 });
  try {
    return await ytdlpInstall(tag, notify);
  } catch (e) {
    // A failed refresh must not cost the player a working downloader. Only a
    // machine with nothing installed yet has to surface the error.
    if (have) {
      ytdlpSaveMeta(Object.assign({}, meta, { checkedAt: Date.now() }));
      return exe;
    }
    throw e;
  }
}

// One provisioning attempt at a time — two game windows importing at once must
// not race on the same file.
let ytdlpPending = null;
function ytdlpEnsure(notify, force) {
  if (!ytdlpPending) {
    ytdlpPending = ytdlpProvision(notify, force).finally(() => { ytdlpPending = null; });
  }
  return ytdlpPending;
}

// Every argument is passed as an array element with no shell, and the only
// player-supplied values that reach it are an 11-char video id validated by
// dubYtId and a scrubbed search phrase — so there is nothing to inject into.
// --ignore-config keeps a stray yt-dlp.conf on the machine from redirecting
// output or adding post-processors behind our back.
function ytdlpArgs() {
  return [
    '--ignore-config', '--no-playlist', '--no-warnings', '--no-color',
    '--socket-timeout', '15', '--retries', '3',
    '--extractor-args', 'youtube:player_client=' + DUB_YT_CLIENTS,
    '--cache-dir', path.join(ytdlpDir(), 'cache'),
  ];
}

function ytdlpSpawn(exe, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let child;
    try { child = spawn(exe, args, { windowsHide: true }); }
    catch (e) { resolve({ code: -1, out: '', err: String((e && e.message) || e) }); return; }

    let out = '', err = '', pending = '', settled = false;
    // A stall watchdog rather than a deadline: a big slow transfer is fine, a
    // silent process is not.
    let timer = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { try { child.kill(); } catch {} }, o.stallMs || 45000);
    };
    const done = (code, extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pending && o.onLine) { try { o.onLine(pending); } catch {} }
      resolve({ code, out, err: extra ? err + ' ' + extra : err });
    };
    arm();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      arm();
      if (out.length < 262144) out += d;
      if (o.onLine) {
        pending += d;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const l of lines) { try { o.onLine(l); } catch {} }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { arm(); if (err.length < 16384) err += d; });
    child.on('error', (e) => done(-1, String((e && e.message) || e)));
    child.on('close', (code) => done(code));
  });
}

// Accept every shape a player might paste, then throw the original string away:
// only the validated id is ever handed to yt-dlp, rebuilt into a canonical URL.
function dubYtId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const ok = (s) => (/^[A-Za-z0-9_-]{11}$/.test(s || '') ? s : null);
  if (!/[:/.]/.test(raw)) return ok(raw);              // bare video id
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') return ok(u.pathname.slice(1).split('/')[0]);
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  if (u.pathname === '/watch') return ok(u.searchParams.get('v'));
  const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
  return m ? ok(m[1]) : null;
}

function dubYtUrl(id) { return 'https://www.youtube.com/watch?v=' + id; }

// yt-dlp says why it failed in prose on stderr. Map the cases a player can act
// on; everything else is a generic failure that a binary refresh might fix.
function dubYtRunError(r) {
  const t = String(((r && r.err) || '') + ' ' + ((r && r.out) || ''));
  if (/Sign in to confirm|not a bot|confirm your age|age.?restricted|inappropriate for some users/i.test(t)) return 'yt-blocked';
  if (/Private video|members[- ]only|video is unavailable|has been removed|no longer available|account associated .* terminated|Video unavailable/i.test(t)) return 'yt-unavailable';
  if (/Requested format is not available/i.test(t)) return 'yt-no-progressive';
  if (/live event will begin|is currently live|premieres in/i.test(t)) return 'yt-live';
  if (/larger than max-filesize/i.test(t)) return 'too-big';
  // Must precede the network clause: yt-dlp words this as "unable to download
  // video data: HTTP Error 403: Forbidden", which would otherwise be reported
  // to the player as a dead internet connection.
  if (/HTTP Error 403|\bForbidden\b/i.test(t)) return 'yt-403';
  if (/Unable to download|Temporary failure|getaddrinfo|timed out|Connection (reset|refused|aborted)|Network is unreachable/i.test(t)) return 'yt-network';
  return 'yt-failed';
}

function dubYtSetupError(e) {
  const m = String((e && e.message) || e || '');
  if (/ytdlp-(offline|nochecksum|badchecksum|toobig)/.test(m)) return m.match(/ytdlp-\w+/)[0];
  return 'ytdlp-setup';
}

// A stale binary is the single most common cause of a mystery failure, so the
// recoverable errors get exactly one forced-refresh retry before giving up.
const DUB_YT_RETRYABLE = { 'yt-failed': 1, 'yt-no-progressive': 1, 'yt-blocked': 1 };

async function dubYtRun(notify, build, opts) {
  let exe;
  try { exe = await ytdlpEnsure(notify, false); }
  catch (e) { return { __setup: dubYtSetupError(e) }; }

  let r = await ytdlpSpawn(exe, build(), opts);

  // A 403 on the media URL is transient — the identical command frequently
  // succeeds on a second attempt — so it gets one cheap retry before any of
  // the heavier remedies below.
  if (r.code !== 0 && dubYtRunError(r) === 'yt-403') r = await ytdlpSpawn(exe, build(), opts);

  if (r.code !== 0 && DUB_YT_RETRYABLE[dubYtRunError(r)] && !ytdlpMeta().forcedAt) {
    try {
      ytdlpSaveMeta(Object.assign({}, ytdlpMeta(), { forcedAt: Date.now() }));
      exe = await ytdlpEnsure(notify, true);
      r = await ytdlpSpawn(exe, build(), opts);
    } catch {}
  }
  if (r.code === 0) { const m = ytdlpMeta(); if (m.forcedAt) { delete m.forcedAt; ytdlpSaveMeta(m); } }
  return r;
}

function dubNotifier(event) {
  return (payload) => {
    try {
      if (event.sender && !event.sender.isDestroyed()) event.sender.send('dub-scene-progress', payload);
    } catch {}
  };
}

// Look the video up without downloading it, so a wrong link or a two-hour
// feature is caught in the confirm step before any bytes move.
ipcMain.handle('dub-yt-probe', async (event, url) => {
  const id = dubYtId(url);
  if (!id) return { ok: false, error: 'not-youtube' };

  const r = await dubYtRun(dubNotifier(event), () => ytdlpArgs().concat([
    '--simulate', '-f', DUB_YT_FORMAT,
    '--print', '%(title)j',
    '--print', '%(duration)j',
    '--print', '%(filesize,filesize_approx)j',
    '--print', '%(is_live)j',
    '--print', '%(uploader)j',
    dubYtUrl(id),
  ]), { stallMs: 45000 });
  if (r.__setup) return { ok: false, error: r.__setup };
  if (r.code !== 0) return { ok: false, error: dubYtRunError(r) };

  const lines = r.out.split(/\r?\n/).filter((s) => s !== '');
  const at = (i) => { try { return JSON.parse(lines[i]); } catch { return null; } };
  const title = at(0), duration = Number(at(1)) || 0, size = Number(at(2)) || 0;
  if (at(3) === true) return { ok: false, error: 'yt-live' };
  if (duration > DUB_YT_MAX_SECONDS) return { ok: false, error: 'too-long' };
  if (size && size > DUB_MAX_BYTES) return { ok: false, error: 'too-big' };

  return {
    ok: true,
    id,
    title: String(title || id).slice(0, 200),
    lengthSeconds: Math.round(duration),
    sizeBytes: size,
    uploader: String(at(4) || '').slice(0, 120),
    thumbnail: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
  };
});

// Download to a scratch dir, hand the bytes back, delete the scratch dir. The
// game receives the bytes exactly as it would from a file the player picked,
// so both import paths land in its library through the same code.
ipcMain.handle('dub-yt-import', async (event, url) => {
  const id = dubYtId(url);
  if (!id) return { ok: false, error: 'not-youtube' };
  const notify = dubNotifier(event);

  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'dubclub-'));

    let lastPct = -1;
    const onLine = (line) => {
      const m = /^DUBPROG\s+(\d+|NA)\s+(\d+|NA)/.exec(line);
      if (!m) return;
      const bytes = m[1] === 'NA' ? 0 : Number(m[1]);
      const total = m[2] === 'NA' ? 0 : Number(m[2]);
      const pct = total
        ? Math.min(99, Math.round((bytes / total) * 100))
        : Math.min(95, Math.round((bytes / (40 * 1024 * 1024)) * 100));
      if (pct !== lastPct) { lastPct = pct; notify({ pct, bytes, total }); }
    };

    // Deliberately no --print here. It implies --simulate (and --quiet), which
    // turns the whole download into a no-op that still exits 0 — verified. The
    // title comes from the probe step the game already ran.
    const r = await dubYtRun(notify, () => ytdlpArgs().concat([
      '-f', DUB_YT_FORMAT,
      '--max-filesize', String(DUB_MAX_BYTES),
      '--no-part', '--no-mtime', '--newline',
      '--progress-template', 'DUBPROG %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s',
      '-o', path.join(dir, 'scene.%(ext)s'),
      dubYtUrl(id),
    ]), { stallMs: DUB_STALL_TIMEOUT, onLine });

    if (r.__setup) return { ok: false, error: r.__setup };
    if (r.code !== 0) return { ok: false, error: dubYtRunError(r) };

    const files = fs.readdirSync(dir).filter((f) => /\.(mp4|m4v|webm|mkv)$/i.test(f));
    if (!files.length) return { ok: false, error: 'yt-failed' };
    const file = path.join(dir, files[0]);
    const size = fs.statSync(file).size;
    if (size > DUB_MAX_BYTES) return { ok: false, error: 'too-big' };

    const buffer = fs.readFileSync(file);
    notify({ pct: 100, bytes: buffer.length, total: buffer.length });
    return { ok: true, buffer, id };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
});

// Search, so players can find something to dub without leaving the game. Flat
// mode means one cheap listing request and no per-video extraction.
ipcMain.handle('dub-yt-search', async (event, opts) => {
  const o = opts || {};
  const terms = String(o.query || '').replace(/[\x00-\x1f"]/g, ' ').trim().slice(0, 80);
  if (!terms) return { ok: false, error: 'empty-query' };
  const rows = Math.min(24, Math.max(1, Number(o.rows) || 12));

  const r = await dubYtRun(dubNotifier(event), () => ytdlpArgs().concat([
    '--flat-playlist', '--skip-download',
    '--print', '%(id)j', '--print', '%(title)j', '--print', '%(duration)j', '--print', '%(channel,uploader)j',
    'ytsearch' + rows + ':' + terms,
  ]), { stallMs: 45000 });
  if (r.__setup) return { ok: false, error: r.__setup };
  if (r.code !== 0) return { ok: false, error: dubYtRunError(r) };

  const lines = r.out.split(/\r?\n/).filter((s) => s !== '');
  const items = [];
  for (let i = 0; i + 3 < lines.length; i += 4) {
    const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
    const id = parse(lines[i]);
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(id || ''))) continue;
    const secs = Number(parse(lines[i + 2])) || 0;
    items.push({
      id,
      title: String(parse(lines[i + 1]) || id).slice(0, 200),
      seconds: Math.round(secs),
      note: String(parse(lines[i + 3]) || '').slice(0, 60),
      thumb: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
    });
  }
  return { ok: true, items };
});

// ── IPC: Dev Shelf (dev machine only) ─────────────────────────
// A launcher view over the in-development projects in _dev/. Only exists when
// running from source (_dev never ships and app.isPackaged builds hide the
// whole feature). Per-project metadata (emoji, hidden, pinned) lives in
// _dev/devshelf.json — inside _dev on purpose, so it's gitignored and never
// bundled. Folder names are the project ids; they're validated with
// path.basename before touching disk so IPC can't escape _dev.
const DEV_DIR        = path.join(LIBRARY_DIR, '_dev');
const DEVSHELF_JSON  = path.join(DEV_DIR, 'devshelf.json');
const DEVNOTES_JSON  = path.join(DEV_DIR, 'devshelf-notes.json');

function readDevShelfMeta() {
  try { return JSON.parse(fs.readFileSync(DEVSHELF_JSON, 'utf8')) || {}; } catch { return {}; }
}

// ── DEVLOG.md — the cross-chat progress record ────────────────
// Each project can carry a DEVLOG.md at its root. It lives as plain markdown
// *inside the project folder* on purpose: the Dev Shelf edits it, and any
// future chat can just read the file to pick up where the last one left off.
// Shape (round-trips through parse → edit → serialize):
//
//   # <Project> — Dev Log
//   **Status:** one-line summary
//   ## Now      - [ ] item
//   ## Next     - [ ] item
//   ## Done     - 2026-08-27 — item
//   ## Notes    free text
function devLogPath(name) { return path.join(DEV_DIR, name, 'DEVLOG.md'); }

function parseDevLog(text) {
  const log = { status: '', now: [], next: [], done: [], notes: '' };
  if (!text) return log;
  let section = '';
  const notes = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { section = h[1].toLowerCase(); continue; }
    if (/^#\s/.test(line)) { section = ''; continue; }
    const st = line.match(/^\*\*Status:\*\*\s*(.*)$/i);
    if (st) { log.status = st[1].trim(); continue; }
    if (section === 'now' || section === 'next') {
      const it = line.match(/^\s*-\s*\[[ xX]\]\s*(.*)$/);
      if (it && it[1].trim()) log[section].push(it[1].trim());
    } else if (section === 'done') {
      const it = line.match(/^\s*-\s*(.*)$/);
      if (it && it[1].trim()) log.done.push(it[1].trim());
    } else if (section === 'notes') {
      notes.push(raw);
    }
  }
  log.notes = notes.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return log;
}

function serializeDevLog(name, log) {
  const list = (arr) => (arr || []).map(s => `- [ ] ${String(s).trim()}`).join('\n');
  const out = [
    `# ${name} — Dev Log`,
    '',
    `**Status:** ${String(log.status || '').trim()}`,
    '',
    '## Now',
    list(log.now) || '- [ ] ',
    '',
    '## Next',
    list(log.next),
    '',
    '## Done',
    (log.done || []).map(s => `- ${String(s).trim()}`).join('\n'),
    '',
    '## Notes',
    String(log.notes || '').trim(),
    '',
  ];
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function readDevLog(name) {
  try { return parseDevLog(fs.readFileSync(devLogPath(name), 'utf8')); } catch { return null; }
}

// Build/output/dependency dirs are skipped: their mtimes just mirror source
// edits (or worse, npm installs), and node_modules alone would make the scan
// minutes instead of milliseconds.
const DS_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'tmp']);
const DS_MAX_FILES = 5000;   // per-project cap so one asset dump can't wedge the scan
const DS_MAX_DEPTH = 6;

function dsWalkProject(root) {
  const files = [];
  let count = 0, bytes = 0, capped = false;
  const stack = [{ dir: root, depth: 0, rel: '' }];
  while (stack.length) {
    const { dir, depth, rel } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (DS_SKIP_DIRS.has(e.name.toLowerCase())) continue;
        if (depth < DS_MAX_DEPTH) stack.push({ dir: path.join(dir, e.name), depth: depth + 1, rel: r });
      } else if (e.isFile()) {
        if (count >= DS_MAX_FILES) { capped = true; continue; }
        let st;
        try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
        count++; bytes += st.size;
        files.push({ rel: r, mtime: st.mtimeMs, size: st.size });
      }
    }
  }
  return { files, count, bytes, capped };
}

// Playable-file hunt. Deliberately does NOT skip dist/build the way the stats
// walk does: several projects (Pickle Racer, Turbo Derby…) are bundled by a
// build script and the only playable file lives in their dist/ folder.
const DS_HTML_SKIP = new Set(['node_modules', 'coverage', 'tmp', '.git']);
function dsHtmlFiles(root) {
  const out = [];
  const stack = [{ dir: root, depth: 0, rel: '' }];
  while (stack.length && out.length < 200) {
    const { dir, depth, rel } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (DS_HTML_SKIP.has(e.name.toLowerCase())) continue;
        if (depth < 5) stack.push({ dir: path.join(dir, e.name), depth: depth + 1, rel: r });
      } else if (e.isFile() && /\.html?$/i.test(e.name)) {
        let st; try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
        out.push({ rel: r, mtime: st.mtimeMs, size: st.size });
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function dsProjectInfo(name) {
  const root = path.join(DEV_DIR, name);
  const { files, count, bytes, capped } = dsWalkProject(root);
  files.sort((a, b) => b.mtime - a.mtime);
  let last = files.length ? files[0].mtime : 0;
  if (!last) { try { last = fs.statSync(root).mtimeMs; } catch {} }
  // Activity sparkline: how many files were last touched on each of the past
  // 14 days (index 13 = today). mtime-based, so it's edits-per-day, roughly.
  const days = new Array(14).fill(0);
  const now = Date.now();
  for (const f of files) {
    const d = Math.floor((now - f.mtime) / 86400000);
    if (d >= 0 && d < 14) days[13 - d]++;
  }
  const log = readDevLog(name);
  let logMtime = 0;
  try { logMtime = fs.statSync(devLogPath(name)).mtimeMs; } catch {}
  return {
    name,
    lastActivity: last,
    fileCount: count,
    totalBytes: bytes,
    capped,
    htmlFiles: dsHtmlFiles(root),
    // Card-face summary only; the full log is fetched on demand when the
    // editor opens (dev-shelf-log-read).
    log: log ? {
      status: log.status,
      now: log.now.length, next: log.next.length, done: log.done.length,
      nowTop: log.now.slice(0, 2),
      updated: logMtime,
    } : null,
    days,
  };
}

ipcMain.handle('dev-shelf-available', () => {
  return !app.isPackaged && fs.existsSync(DEV_DIR);
});

ipcMain.handle('dev-shelf-scan', () => {
  if (app.isPackaged) return null;
  let dirents;
  try { dirents = fs.readdirSync(DEV_DIR, { withFileTypes: true }); } catch { return null; }
  const meta = readDevShelfMeta();
  const projects = [];
  for (const e of dirents) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || DS_SKIP_DIRS.has(e.name.toLowerCase())) continue;
    let info;
    try { info = dsProjectInfo(e.name); } catch { continue; }
    const m = meta[e.name] || {};
    info.emoji  = typeof m.emoji === 'string' ? m.emoji : null;
    // Underscore-prefixed folders (backups, _to_delete…) start hidden; an
    // explicit hidden flag in devshelf.json always wins either way.
    info.hidden = typeof m.hidden === 'boolean' ? m.hidden : e.name.startsWith('_');
    // Second hide step: buried cards drop below the Hidden strip and render
    // small. Buried always implies hidden, whatever the file says.
    info.buried = !!m.buried && info.hidden;
    info.pinned = !!m.pinned;
    // Rough build complexity, Nic's call — everything starts at medium.
    info.complexity = ['low', 'medium', 'high'].includes(m.complexity) ? m.complexity : 'medium';
    // Explicit play target; falls back to the newest .html when unset or stale.
    info.playFile = typeof m.playFile === 'string' && info.htmlFiles.some(f => f.rel === m.playFile)
      ? m.playFile
      : (info.htmlFiles[0] ? info.htmlFiles[0].rel : null);
    info.playPinned = info.playFile != null && info.playFile === m.playFile;
    projects.push(info);
  }
  return { dir: DEV_DIR, projects };
});

ipcMain.handle('dev-shelf-set-meta', (_, name, patch) => {
  const safe = path.basename(String(name || ''));
  if (!safe || safe !== name) return false;
  const meta = readDevShelfMeta();
  const cur = meta[safe] && typeof meta[safe] === 'object' ? meta[safe] : {};
  if (patch && typeof patch === 'object') {
    if (typeof patch.emoji === 'string') cur.emoji = patch.emoji.slice(0, 8);
    if (patch.emoji === null) delete cur.emoji;   // back to auto-assigned
    if (typeof patch.hidden === 'boolean') {
      cur.hidden = patch.hidden;
      if (!patch.hidden) delete cur.buried;   // unhiding always un-buries too
    }
    if (typeof patch.buried === 'boolean') {
      cur.buried = patch.buried;
      if (patch.buried) cur.hidden = true;
    }
    if (typeof patch.pinned === 'boolean') cur.pinned = patch.pinned;
    if (['low', 'medium', 'high'].includes(patch.complexity)) cur.complexity = patch.complexity;
    if (typeof patch.playFile === 'string') cur.playFile = patch.playFile.slice(0, 300);
    if (patch.playFile === null) delete cur.playFile;   // back to newest-html
  }
  meta[safe] = cur;
  try { fs.writeFileSync(DEVSHELF_JSON, JSON.stringify(meta, null, 2)); return true; }
  catch { return false; }
});

// Open a project folder in File Explorer.
ipcMain.handle('dev-shelf-open', async (_, name) => {
  const safe = path.basename(String(name || ''));
  if (!safe || safe !== name) return false;
  const p = path.join(DEV_DIR, safe);
  try { if (!fs.statSync(p).isDirectory()) return false; } catch { return false; }
  const err = await shell.openPath(p);
  return !err;
});

// Reveal one file inside a project (Explorer window with the file selected).
ipcMain.handle('dev-shelf-reveal', (_, name, rel) => {
  const safe = path.basename(String(name || ''));
  if (!safe || safe !== name) return false;
  const root = path.join(DEV_DIR, safe);
  const target = path.resolve(root, String(rel || ''));
  if (target !== root && !target.startsWith(root + path.sep)) return false;  // no traversal
  if (!fs.existsSync(target)) return false;
  shell.showItemInFolder(target);
  return true;
});

// Resolve "project + optional rel path" to a real file inside _dev/<project>.
function dsResolveFile(name, rel) {
  const safe = path.basename(String(name || ''));
  if (!safe || safe !== name) return null;
  const root = path.join(DEV_DIR, safe);
  const target = path.resolve(root, String(rel || ''));
  if (!target.startsWith(root + path.sep)) return null;   // no traversal
  try { if (!fs.statSync(target).isFile()) return null; } catch { return null; }
  return target;
}

// Play an in-development build straight from the shelf. Deliberately NO
// preload: an un-onboarded game has no games.json entry, so letting GameSDK
// attach would write stats/achievements for a gameId that doesn't exist.
// Windowed (not fullscreen) and F12 opens DevTools — this is a test run.
const devWindows = new Map();
ipcMain.handle('dev-shelf-play', (_, name, rel) => {
  if (app.isPackaged) return false;
  const file = dsResolveFile(name, rel);
  if (!file) return false;

  const key = name + '::' + rel;
  const existing = devWindows.get(key);
  if (existing && !existing.isDestroyed()) { existing.focus(); return true; }

  const win = new BrowserWindow({
    width: 1280, height: 800,
    title: `${name} — ${rel}`,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#111',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(file);
  devWindows.set(key, win);

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  // Dev games get no crash reporting anywhere else, so a "it crashed after a few minutes"
  // report has nothing behind it. Say what happened, in the launcher's own console.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[dev-shelf] ${key} renderer gone:`, JSON.stringify(details));
  });
  win.webContents.on('unresponsive', () => console.error(`[dev-shelf] ${key} unresponsive`));
  win.webContents.on('responsive', () => console.error(`[dev-shelf] ${key} responsive again`));

  win.on('closed', () => devWindows.delete(key));
  return true;
});

// Full DEVLOG.md for the log editor (null = no log file yet).
ipcMain.handle('dev-shelf-log-read', (_, name) => {
  const safe = path.basename(String(name || ''));
  if (!safe || safe !== name) return null;
  return readDevLog(safe);
});

ipcMain.handle('dev-shelf-log-write', (_, name, log) => {
  const safe = path.basename(String(name || ''));
  if (!safe || safe !== name || !log || typeof log !== 'object') return false;
  const dir = path.join(DEV_DIR, safe);
  try { if (!fs.statSync(dir).isDirectory()) return false; } catch { return false; }
  const clean = (arr) => (Array.isArray(arr) ? arr : [])
    .map(s => String(s).replace(/\r?\n/g, ' ').trim()).filter(Boolean).slice(0, 200);
  const doc = {
    status: String(log.status || '').replace(/\r?\n/g, ' ').slice(0, 300),
    now: clean(log.now), next: clean(log.next), done: clean(log.done),
    notes: String(log.notes || ''),
  };
  try { fs.writeFileSync(devLogPath(safe), serializeDevLog(safe, doc), 'utf8'); return true; }
  catch { return false; }
});

// ── Idea notes ────────────────────────────────────────────────
// A flat pile of note cards, stored beside the shelf metadata in _dev so it's
// gitignored and never bundled. Not per-project: an idea can outlive (or
// predate) any folder, and cards carry an optional project link instead.
ipcMain.handle('dev-shelf-notes-read', () => {
  if (app.isPackaged) return { cards: [] };
  try {
    const j = JSON.parse(fs.readFileSync(DEVNOTES_JSON, 'utf8'));
    return { cards: Array.isArray(j && j.cards) ? j.cards : [] };
  } catch { return { cards: [] }; }
});

ipcMain.handle('dev-shelf-notes-write', (_, cards) => {
  if (app.isPackaged || !Array.isArray(cards)) return false;
  const safe = cards.slice(0, 2000).map(c => ({
    id:      String(c && c.id || ''),
    title:   String(c && c.title || '').slice(0, 200),
    body:    String(c && c.body || '').slice(0, 40000),
    project: c && typeof c.project === 'string' ? path.basename(c.project) : '',
    created: Number(c && c.created) || 0,
    updated: Number(c && c.updated) || 0,
  })).filter(c => c.id);
  try { fs.writeFileSync(DEVNOTES_JSON, JSON.stringify({ cards: safe }, null, 2), 'utf8'); return true; }
  catch { return false; }
});
