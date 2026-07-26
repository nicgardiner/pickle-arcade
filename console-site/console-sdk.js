/* ──────────────────────────────────────────────────────────────────────────
 * console-sdk.js — GameSDK for the Pickle Arcade CONSOLE website build.
 *
 * Injected as the FIRST script in every game page's <head> (same contract as
 * preload.js in the app and gamesdk-web.js on the website): window.GameSDK is
 * always defined before any game code runs.
 *
 * Console-build specifics:
 *   • No launcher, no player accounts. Player identity is just the name the
 *     player typed on the arcade front page (gl_player_name in localStorage),
 *     with a controller emblem default. lobby-sdk.js picks these up through
 *     window.__picklePlayerName / __picklePlayerEmblem exactly like the app
 *     and website builds, so cross-play rooms show the right name.
 *   • Games are opened by NAVIGATION in the same tab (Xbox Edge dislikes
 *     pop-ups), so the standard exit contract (`window.close()`) is rerouted:
 *     window.close now returns to the arcade front page.
 *
 * DO NOT add Electron/Node references here — this file runs on GitHub Pages.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const gameId = params.get('gameId') || '';

  window.__pickleConsole = true;

  // ── Exit contract: window.close() → back to the arcade shell ─────────────
  // Every game's gl-exit-yes handler calls window.close(); on the console
  // site that must land back on the front page instead of closing the tab
  // (a tab opened by the user can't script-close itself anyway).
  try {
    window.close = function () { window.location.replace('index.html'); };
  } catch (e) {}

  // ── Player identity (mirrors preload.js / gamesdk-web.js contract) ────────
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  window.__picklePlayerName =
    (lsGet('gl_player_name') || params.get('playerName') || 'Player').trim() || 'Player';
  window.__picklePlayerEmblem =
    (lsGet('gl_player_emblem') || params.get('playerEmblem') || '🎮').trim() || '🎮';

  const STATS_KEY = 'gl_' + gameId + '_stats';
  const ACH_KEY   = 'gl_' + gameId + '_achievements';
  const SAVE_KEY  = 'gl_' + gameId + '_save';
  const GLOBAL_ACH_KEY = 'gl_global_achievements';

  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); }
    catch (e) { return {}; }
  }
  function writeRaw(key, json) {
    try { localStorage.setItem(key, json); } catch (e) {}
  }

  function showToast(label) {
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

    incrementStat(key, amount = 1) {
      if (!gameId) return;
      const stats = readJSON(STATS_KEY);
      stats[key] = (stats[key] || 0) + amount;
      writeRaw(STATS_KEY, JSON.stringify(stats));
    },

    getStats() {
      if (!gameId) return {};
      return readJSON(STATS_KEY);
    },

    unlockAchievement(achievementId, label = achievementId) {
      if (!gameId) return;
      const ach = readJSON(ACH_KEY);
      if (ach[achievementId]) return;

      ach[achievementId] = { unlockedAt: Date.now() };
      writeRaw(ACH_KEY, JSON.stringify(ach));

      const global = readJSON(GLOBAL_ACH_KEY);
      if (!global[gameId + '::' + achievementId]) {
        global[gameId + '::' + achievementId] = { gameId: gameId, achievementId: achievementId, unlockedAt: Date.now() };
        writeRaw(GLOBAL_ACH_KEY, JSON.stringify(global));
      }
      showToast(label);
    },

    getAchievements() {
      if (!gameId) return {};
      return readJSON(ACH_KEY);
    },

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

    unlockGlobalAchievement(achievementId, label = achievementId) {
      const global = readJSON(GLOBAL_ACH_KEY);
      if (global['global::' + achievementId]) return;
      global['global::' + achievementId] = { achievementId: achievementId, unlockedAt: Date.now() };
      writeRaw(GLOBAL_ACH_KEY, JSON.stringify(global));
      showToast(label);
    },
  };
})();
