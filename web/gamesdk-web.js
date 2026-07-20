/* ──────────────────────────────────────────────────────────────────────────
 * gamesdk-web.js — Browser GameSDK for the Pickle Arcade WEBSITE build.
 *
 * The build script (web/build-site.mjs) injects this as the FIRST script in
 * every game page's <head>, mirroring what preload.js does in the Electron
 * app: it runs before the game's own scripts, so window.GameSDK is always
 * defined by the time game code feature-checks it.
 *
 * Differences from the app's preload GameSDK:
 *   • No IPC. On the website the launcher and every game share ONE
 *     localStorage origin, so stats/achievements/saves written here are
 *     immediately visible to the launcher tab — no sync layer needed.
 *   • Achievement toasts reach the launcher via the "toast bus": we write
 *     gl_toast_bus, and the launcher tab picks it up through the cross-tab
 *     `storage` event (see web-shim.js).
 *   • Player name/emblem for lobby-sdk.js are read straight from the shared
 *     localStorage (URL params are a fallback for deep links).
 *
 * DO NOT add Electron/Node references here — this file runs on GitHub Pages.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const gameId = params.get('gameId') || '';

  // ── Player identity for lobby-sdk.js (mirrors preload.js contract) ────────
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  window.__picklePlayerName =
    (lsGet('gl_player_name') || params.get('playerName') || 'Player').trim() || 'Player';
  window.__picklePlayerEmblem =
    (lsGet('gl_player_emblem') || params.get('playerEmblem') || '🎮').trim() || '🎮';

  const STATS_KEY = 'gl_' + gameId + '_stats';
  const ACH_KEY   = 'gl_' + gameId + '_achievements';
  const SAVE_KEY  = 'gl_' + gameId + '_save';
  const GLOBAL_ACH_KEY = 'gl_global_achievements';
  const TOAST_BUS_KEY  = 'gl_toast_bus';

  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); }
    catch (e) { return {}; }
  }
  function writeRaw(key, json) {
    try { localStorage.setItem(key, json); } catch (e) {}
  }

  // Ping the launcher tab (if open) so it can show its own achievement toast.
  // The `ts` field guarantees the storage event fires even for repeat writes.
  function toastBus(gid, achievementId) {
    try {
      localStorage.setItem(TOAST_BUS_KEY, JSON.stringify({
        gameId: gid, achievementId: achievementId, ts: Date.now(),
      }));
    } catch (e) {}
  }

  function showToast(label) {
    // In-game toast (identical to the app's preload version)
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
    toast.innerHTML = '<div style="color:#f5c518;font-weight:bold;margin-bottom:3px">🏆 Achievement Unlocked!</div><div>' + label + '</div>';
    const attach = () => {
      document.body.appendChild(toast);
      requestAnimationFrame(() => { toast.style.opacity = '1'; });
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 400);
      }, 3500);
    };
    if (document.body) attach();
    else window.addEventListener('DOMContentLoaded', attach);
  }

  window.GameSDK = {
    gameId: gameId,

    // Set a stat. Pass keepMax=true to only update if value > current.
    setStat(key, value, keepMax = false) {
      if (!gameId) return;
      const stats = readJSON(STATS_KEY);
      if (keepMax) {
        if (typeof stats[key] !== 'number' || value > stats[key]) {
          stats[key] = value;
          writeRaw(STATS_KEY, JSON.stringify(stats));
        }
      } else {
        stats[key] = value;
        writeRaw(STATS_KEY, JSON.stringify(stats));
      }
    },

    // Increment a numeric stat (creates it at 0 if missing).
    incrementStat(key, amount = 1) {
      if (!gameId) return;
      const stats = readJSON(STATS_KEY);
      stats[key] = (stats[key] || 0) + amount;
      writeRaw(STATS_KEY, JSON.stringify(stats));
    },

    // Get all stats for this game.
    getStats() {
      if (!gameId) return {};
      return readJSON(STATS_KEY);
    },

    // Unlock an achievement (idempotent — won't double-unlock).
    unlockAchievement(achievementId, label = achievementId) {
      if (!gameId) return;
      const ach = readJSON(ACH_KEY);
      if (ach[achievementId]) return; // already unlocked

      ach[achievementId] = { unlockedAt: Date.now() };
      writeRaw(ACH_KEY, JSON.stringify(ach));

      // Also track in global achievements
      const global = readJSON(GLOBAL_ACH_KEY);
      if (!global[gameId + '::' + achievementId]) {
        global[gameId + '::' + achievementId] = { gameId: gameId, achievementId: achievementId, unlockedAt: Date.now() };
        writeRaw(GLOBAL_ACH_KEY, JSON.stringify(global));
      }

      toastBus(gameId, achievementId); // launcher-tab toast
      showToast(label);                // in-game toast
    },

    // Get unlocked achievements for this game.
    getAchievements() {
      if (!gameId) return {};
      return readJSON(ACH_KEY);
    },

    // ── Durable game save ──────────────────────────────────────────────
    // On the website "durable" means this browser's localStorage — there is
    // no playerdata.json mirror. The welcome-modal disclaimer tells players
    // browser saves can be lost; the desktop app is the backed-up experience.
    saveGameData(data) {
      if (!gameId) return;
      let json;
      try { json = JSON.stringify(data); } catch (e) { return; }
      writeRaw(SAVE_KEY, json);
    },

    loadGameData() {
      if (!gameId) return {};
      return readJSON(SAVE_KEY);
    },

    // Unlock a global achievement (not tied to any specific game).
    unlockGlobalAchievement(achievementId, label = achievementId) {
      const global = readJSON(GLOBAL_ACH_KEY);
      if (global['global::' + achievementId]) return; // already unlocked

      global['global::' + achievementId] = { achievementId: achievementId, unlockedAt: Date.now() };
      writeRaw(GLOBAL_ACH_KEY, JSON.stringify(global));

      toastBus('global', achievementId);
      showToast(label);
    },
  };
})();
