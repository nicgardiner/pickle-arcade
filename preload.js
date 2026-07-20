const { contextBridge, ipcRenderer } = require('electron');

// ── Online Lobby SDK injection ─────────────────────────────────────────────
// Inject lobby-sdk.js into multiplayer game windows so games can call LobbySDK.*
const ONLINE_MULTIPLAYER_GAMES = new Set([
  'chess', 'checkers', 'connect4', 'battleship',
  'ultimate-tic-tac-toe', 'poke_clash_v7',
  'rhino-pile-up_v37', 'settlers', 'floe-fighters',
  'baseline', 'windward_isles',
]);
(function injectLobbySDK() {
  const params = new URLSearchParams(window.location.search);
  const gameId = params.get('gameId') || '';
  if (!ONLINE_MULTIPLAYER_GAMES.has(gameId)) return;
  // Expose player name + emblem so lobby-sdk.js can read them.
  // contextIsolation puts this preload in its OWN JS world — a plain
  // `window.x =` assignment never reaches the page, so games only ever saw
  // the 'Player' fallback. contextBridge is the sanctioned way across; the
  // direct assignment stays as a fallback for any window without isolation.
  const playerName   = params.get('playerName')   || 'Player';
  const playerEmblem = params.get('playerEmblem') || '🎮';
  try {
    contextBridge.exposeInMainWorld('__picklePlayerName', playerName);
    contextBridge.exposeInMainWorld('__picklePlayerEmblem', playerEmblem);
  } catch (e) {
    window.__picklePlayerName   = playerName;
    window.__picklePlayerEmblem = playerEmblem;
  }
  window.addEventListener('DOMContentLoaded', () => {
    const script = document.createElement('script');
    script.src = './lobby-sdk.js';
    document.head.appendChild(script);
  });
})();

// ── electronAPI: exposed to ALL windows (launcher + games) ─────
contextBridge.exposeInMainWorld('electronAPI', {
  // Metadata
  getGames: () => ipcRenderer.invoke('get-games'),
  getGlobalAchievements: () => ipcRenderer.invoke('get-global-achievements'),
  getChangelog: () => ipcRenderer.invoke('get-changelog'),
  saveGames: (games) => ipcRenderer.invoke('save-games', games),
  scanGames: () => ipcRenderer.invoke('scan-games'),

  // Covers
  saveCover: (gameId, dataUrl) => ipcRenderer.invoke('save-cover', gameId, dataUrl),
  coverExists: (gameId) => ipcRenderer.invoke('cover-exists', gameId),
  listCovers: () => ipcRenderer.invoke('list-covers'),

  // Game launching
  openGame: (gameId, fileName, preferredWidth, preferredHeight, winConstraints) =>
    ipcRenderer.invoke('open-game', gameId, fileName, preferredWidth, preferredHeight, winConstraints),

  // Adding games
  pickGameFile: () => ipcRenderer.invoke('pick-game-file'),
  copyGameFile: (srcPath) => ipcRenderer.invoke('copy-game-file', srcPath),

  // External (on-demand) games: check if downloaded, and download/install
  isGameInstalled: (fileName, expectedHash) => ipcRenderer.invoke('is-game-installed', fileName, expectedHash),
  installGame: (gameId, fileName, download) => ipcRenderer.invoke('install-game', gameId, fileName, download),
  onInstallProgress: (cb) => {
    ipcRenderer.removeAllListeners('install-progress');
    ipcRenderer.on('install-progress', (_, d) => cb(d));
  },

  // Events (launcher only) — removeAllListeners first so re-registering never stacks up
  onAchievementToast: (cb) => {
    ipcRenderer.removeAllListeners('achievement-toast');
    ipcRenderer.on('achievement-toast', (_, data) => cb(data));
  },
  onGameClosed: (cb) => {
    ipcRenderer.removeAllListeners('game-closed');
    ipcRenderer.on('game-closed', (_, gameId, lsSnapshot) => cb(gameId, lsSnapshot));
  },

  // localStorage passthrough (launcher reads stats after game closes)
  getLsKey: (key) => ipcRenderer.invoke('get-ls-key', key),

  // Remove an imported game from disk
  deleteGame: (gameId, fileName) => ipcRenderer.invoke('delete-game', gameId, fileName),

  // Native cover selection: copies .default.svg or .minimalist.svg → .svg
  selectNativeCover: (gameId, type) => ipcRenderer.invoke('select-native-cover', gameId, type),

  // Cover variants (named covers: default / minimalist / custom1 …)
  listCoverVariants: (gameId) => ipcRenderer.invoke('list-cover-variants', gameId),
  saveCoverVariant: (gameId, variantId, data) => ipcRenderer.invoke('save-cover-variant', gameId, variantId, data),
  deleteCoverVariant: (gameId, variantId) => ipcRenderer.invoke('delete-cover-variant', gameId, variantId),

  // Persistent player data — survives localStorage clears and reinstalls
  getPlayerData: () => ipcRenderer.invoke('get-playerdata'),
  syncLauncherStorage: (key, value) => ipcRenderer.send('sync-launcher-storage', key, value),
  notifyReady: () => ipcRenderer.send('launcher-ready'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates-manual'),
  // Live update lifecycle (checking / available / progress / downloaded / none / error)
  onUpdateStatus: (cb) => {
    ipcRenderer.removeAllListeners('update-status');
    ipcRenderer.on('update-status', (_, data) => cb(data));
  },

  // App info (version + dev flag) — used by the feedback module
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  // Town Builder saved worlds — one .json file per town in userData/townbuilder-saves.
  // `file` is the base filename (no .json). Games feature-check these before using them.
  townbuilderList:   () => ipcRenderer.invoke('tb-list-saves'),
  townbuilderRead:   (file) => ipcRenderer.invoke('tb-read-save', file),
  townbuilderWrite:  (file, data) => ipcRenderer.invoke('tb-write-save', file, data),
  townbuilderDelete: (file) => ipcRenderer.invoke('tb-delete-save', file),
  townbuilderRename: (file, newName) => ipcRenderer.invoke('tb-rename-save', file, newName),
  townbuilderCopy:   (file) => ipcRenderer.invoke('tb-copy-save', file),
  townbuilderExport: (file) => ipcRenderer.invoke('tb-export-save', file),
});

// ── GameSDK: exposed to all windows so games can call it ───────
// Works in game windows; safe no-op in launcher window.
// Games call: GameSDK.setStat('best_score', 1500)
//             GameSDK.unlockAchievement('first_blood')
// GameId is read from the URL query string (set by main.js on open).

contextBridge.exposeInMainWorld('GameSDK', (() => {
  const params = new URLSearchParams(window.location.search);
  const gameId = params.get('gameId') || '';

  // ── Restore durable backup BEFORE the game's own scripts run ──
  // Preload executes before page JS and shares the game window's localStorage
  // origin. On a fresh install / data-clear that origin is empty, so we pull
  // this game's mirrored gl_* keys (stats, achievements, durable save) from
  // playerdata.json via a synchronous IPC and write any that are missing.
  // Only missing keys are seeded, so a newer on-disk value is never clobbered.
  if (gameId) {
    try {
      const backup = ipcRenderer.sendSync('get-game-backup', gameId) || {};
      for (const k in backup) {
        try { if (localStorage.getItem(k) === null) localStorage.setItem(k, backup[k]); } catch {}
      }
    } catch {}
  }

  const STATS_KEY = `gl_${gameId}_stats`;
  const ACH_KEY   = `gl_${gameId}_achievements`;
  const SAVE_KEY  = `gl_${gameId}_save`;
  const GLOBAL_ACH_KEY = 'gl_global_achievements';

  function readStats() {
    try { return JSON.parse(localStorage.getItem(STATS_KEY) || '{}'); }
    catch { return {}; }
  }

  function writeStats(obj) {
    const json = JSON.stringify(obj);
    try { localStorage.setItem(STATS_KEY, json); } catch {}
    // Sync to launcher window (separate localStorage origin)
    try { ipcRenderer.send('sync-game-storage', STATS_KEY, json); } catch {}
  }

  function readAch() {
    try { return JSON.parse(localStorage.getItem(ACH_KEY) || '{}'); }
    catch { return {}; }
  }

  function readGlobalAch() {
    try { return JSON.parse(localStorage.getItem(GLOBAL_ACH_KEY) || '{}'); }
    catch { return {}; }
  }

  function showToast(label) {
    // In-game toast (shows even outside the launcher, e.g. browser)
    const toast = document.createElement('div');
    toast.style.cssText = [
      'position:fixed', 'top:18px', 'right:18px',
      'background:#1a1a2e', 'border:1.5px solid #6c63ff',
      'border-radius:10px', 'padding:12px 18px',
      'color:#e0e0f0', 'font-family:Segoe UI,sans-serif', 'font-size:13px',
      'z-index:999999', 'box-shadow:0 4px 20px rgba(108,99,255,0.4)',
      'opacity:0', 'transition:opacity 0.3s',
      'pointer-events:none',
    ].join(';');
    toast.innerHTML = `<div style="color:#f5c518;font-weight:bold;margin-bottom:3px">🏆 Achievement Unlocked!</div><div>${label}</div>`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 400);
    }, 3500);
  }

  return {
    gameId,

    // Set a stat. Pass keepMax=true to only update if value > current.
    setStat(key, value, keepMax = false) {
      if (!gameId) return;
      const stats = readStats();
      if (keepMax) {
        if (typeof stats[key] !== 'number' || value > stats[key]) {
          stats[key] = value;
          writeStats(stats);
        }
      } else {
        stats[key] = value;
        writeStats(stats);
      }
    },

    // Increment a numeric stat (creates it at 0 if missing).
    incrementStat(key, amount = 1) {
      if (!gameId) return;
      const stats = readStats();
      stats[key] = (stats[key] || 0) + amount;
      writeStats(stats);
    },

    // Get all stats for this game.
    getStats() {
      if (!gameId) return {};
      return readStats();
    },

    // Unlock an achievement (idempotent — won't double-unlock).
    unlockAchievement(achievementId, label = achievementId) {
      if (!gameId) return;
      const ach = readAch();
      if (ach[achievementId]) return; // already unlocked

      ach[achievementId] = { unlockedAt: Date.now() };
      const achJson = JSON.stringify(ach);
      try { localStorage.setItem(ACH_KEY, achJson); } catch {}
      try { ipcRenderer.send('sync-game-storage', ACH_KEY, achJson); } catch {}

      // Also track in global achievements
      const global = readGlobalAch();
      if (!global[`${gameId}::${achievementId}`]) {
        global[`${gameId}::${achievementId}`] = { gameId, achievementId, unlockedAt: Date.now() };
        const globalJson = JSON.stringify(global);
        try { localStorage.setItem(GLOBAL_ACH_KEY, globalJson); } catch {}
        try { ipcRenderer.send('sync-game-storage', GLOBAL_ACH_KEY, globalJson); } catch {}
      }

      // Notify main process → launcher toast
      ipcRenderer.send('achievement-unlocked', gameId, achievementId);

      // Show in-game toast too
      showToast(label);
    },

    // Get unlocked achievements for this game.
    getAchievements() {
      if (!gameId) return {};
      return readAch();
    },

    // ── Durable game save ──────────────────────────────────────────────
    // Persist the game's OWN progression (coins, owned items, equipped
    // cosmetics, permanent upgrades, etc.) under a gl_-namespaced key so it
    // is mirrored to playerdata.json and survives localStorage clears, app
    // updates, and reinstalls — exactly like stats/achievements.
    //
    // Pass any JSON-serializable object. It is merged-by-replacement (the
    // whole blob is stored), so call it with your complete save state.
    saveGameData(data) {
      if (!gameId) return;
      let json;
      try { json = JSON.stringify(data); } catch { return; }
      try { localStorage.setItem(SAVE_KEY, json); } catch {}
      try { ipcRenderer.send('sync-game-storage', SAVE_KEY, json); } catch {}
    },

    // Read the durable save blob back (returns {} if none). On a fresh
    // install the launcher seeds this key from playerdata.json before the
    // game loads, so loadGameData() returns the player's restored progress.
    loadGameData() {
      if (!gameId) return {};
      try { return JSON.parse(localStorage.getItem(SAVE_KEY) || '{}'); }
      catch { return {}; }
    },

    // Unlock a global achievement (not tied to any specific game).
    unlockGlobalAchievement(achievementId, label = achievementId) {
      const global = readGlobalAch();
      if (global[`global::${achievementId}`]) return; // already unlocked

      global[`global::${achievementId}`] = { achievementId, unlockedAt: Date.now() };
      const globalJson = JSON.stringify(global);
      try { localStorage.setItem(GLOBAL_ACH_KEY, globalJson); } catch {}
      try { ipcRenderer.send('sync-game-storage', GLOBAL_ACH_KEY, globalJson); } catch {}

      // Notify main process → launcher toast
      ipcRenderer.send('achievement-unlocked', 'global', achievementId);

      // Show in-game toast
      showToast(label);
    },
  };
})());
