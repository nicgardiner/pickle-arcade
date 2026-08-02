/* ──────────────────────────────────────────────────────────────────────────
 * web-shim.js — Browser implementation of window.electronAPI for the
 * Pickle Arcade WEBSITE build.
 *
 * The build script (web/build-site.mjs) injects this into the site copy of
 * index.html BEFORE feedback.js and renderer.js, so by the time they run:
 *   • window.__pickleWeb === true          (shared code branches on this)
 *   • <html> has class "web-mode"          (style.css hides app-only UI)
 *   • window.electronAPI is fully defined  (fetch/window.open backed)
 *
 * On the website the launcher and all games share ONE localStorage origin,
 * so the app's whole IPC sync layer collapses to:
 *   • cross-tab `storage` events → achievement toasts + live stat refresh
 *   • window.open + .closed polling → the game-closed playtime hook
 *
 * __SITE_VERSION__ is replaced with package.json's version at build time.
 * DO NOT add Electron/Node references here — this file runs on GitHub Pages.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const SITE_VERSION     = '__SITE_VERSION__';
  const APP_DOWNLOAD_URL = 'https://github.com/nicgardiner/pickle-arcade/releases/latest';

  // ── Console routing now lives in web/console-redirect.js ─────────────────
  // build-site.mjs injects that file as the FIRST script in <head>, so console
  // visitors are moved to xbox/ before this page paints. It used to be a bare
  // UA sniff right here, which ran far too late (this file is injected at the
  // bottom of <body>) and only caught browsers that admit to being a console.

  window.__pickleWeb = true;
  window.__pickleAppDownloadUrl = APP_DOWNLOAD_URL;
  try { document.documentElement.classList.add('web-mode'); } catch (e) {}

  /* ── "Get the Desktop App" → download the installer, don't sightsee ───────
     The Get-the-App links used to drop people on the releases page to hunt for
     the right file under Assets. They now go straight to the newest installer.
     There is no fixed URL for it: electron-builder puts the version in the
     filename (and the naming changed at 1.0.7), so GitHub's
     /releases/latest/download/<name> shortcut can't be used without pinning
     artifactName — which would only help future releases. So the newest .exe is
     looked up through the releases API and the links are upgraded in place.

     Written so it can only ever improve on the old behaviour: every link starts
     out pointing at the releases page, so with no JS, a blocked API, a rate
     limit (60/hr per IP unauthenticated), or a release with no .exe attached,
     the worst case is exactly what shipped before. The answer is cached per
     visitor so a normal session costs at most one API call. */
  const GH_RELEASES_API = 'https://api.github.com/repos/nicgardiner/pickle-arcade/releases/latest';
  const INSTALLER_CACHE = 'gl_installer_v1';
  const INSTALLER_TTL   = 6 * 60 * 60 * 1000;
  const CLICK_PATIENCE  = 2500;   // ms to wait on a cold click before giving up

  function cachedInstaller() {
    try {
      const c = JSON.parse(localStorage.getItem(INSTALLER_CACHE) || 'null');
      if (c && c.url && (Date.now() - c.ts) < INSTALLER_TTL) return c;
    } catch (e) {}
    return null;
  }

  let installerLookup = null;
  function resolveInstaller() {
    const hit = cachedInstaller();
    if (hit) return Promise.resolve(hit);
    if (installerLookup) return installerLookup;
    installerLookup = fetch(GH_RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
      .then(r => { if (!r.ok) throw new Error('releases API ' + r.status); return r.json(); })
      .then(rel => {
        // .blockmap files sit right next to the installer and also start with
        // the product name — match on the extension, not the prefix.
        const exes = (rel.assets || []).filter(a => /\.exe$/i.test(a.name || ''));
        const pick = exes.filter(a => /setup|install/i.test(a.name))[0] || exes[0];
        if (!pick) throw new Error('no .exe asset on ' + (rel.tag_name || 'latest'));
        const info = {
          url: pick.browser_download_url,
          name: pick.name,
          size: pick.size || 0,
          version: String(rel.tag_name || '').replace(/^v/, ''),
          ts: Date.now(),
        };
        try { localStorage.setItem(INSTALLER_CACHE, JSON.stringify(info)); } catch (e) {}
        return info;
      })
      .catch(err => { installerLookup = null; throw err; });
    return installerLookup;
  }

  const DOWNLOAD_SEL = 'a[href*="pickle-arcade/releases"]';
  function downloadLinks() {
    try { return Array.prototype.slice.call(document.querySelectorAll(DOWNLOAD_SEL)); }
    catch (e) { return []; }
  }
  function upgradeLink(a, info) {
    a.href = info.url;
    // A release asset is served as an attachment, so the browser downloads it
    // and stays on the page — a new tab would just be left blank behind it.
    a.removeAttribute('target');
    a.setAttribute('download', info.name);
    a.title = info.name + (info.size ? ' · ' + (info.size / 1048576).toFixed(0) + ' MB' : '') +
              (info.version ? ' · v' + info.version : '');
    a.dataset.directDownload = '1';
  }
  function upgradeAll(info) { downloadLinks().forEach(a => upgradeLink(a, info)); }

  // Clicks that land before the lookup finishes (or without one) still get the
  // installer: hold the click briefly, then send them wherever we got to.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const t = e.target;
    const a = t && t.closest ? t.closest(DOWNLOAD_SEL) : null;
    if (!a || a.dataset.directDownload === '1') return;   // already direct — let the browser have it
    e.preventDefault();
    let sent = false;
    const send = (url, direct) => {
      if (sent) return;
      sent = true;
      if (direct) window.location.href = url;
      else window.open(url, '_blank', 'noopener');
    };
    const giveUp = setTimeout(() => send(APP_DOWNLOAD_URL, false), CLICK_PATIENCE);
    resolveInstaller().then(info => {
      clearTimeout(giveUp);
      upgradeAll(info);
      send(info.url, true);
    }).catch(() => {
      clearTimeout(giveUp);
      send(APP_DOWNLOAD_URL, false);
    });
  }, true);

  // Warm it up in the background so the href is real before anyone clicks —
  // that also makes hover, "Copy link address" and "Save link as" behave.
  function warmInstaller() {
    resolveInstaller().then(upgradeAll).catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', warmInstaller);
  else warmInstaller();

  // ── games.json cache (single fetch serves getGames + getGlobalAchievements) ─
  let _gamesDataPromise = null;
  function gamesData() {
    if (!_gamesDataPromise) {
      _gamesDataPromise = fetch('games.json', { cache: 'no-cache' })
        .then(r => r.json())
        .catch(() => ({ games: [], globalAchievements: [] }));
    }
    return _gamesDataPromise;
  }

  // ── Game windows: open/focus/track, fire onGameClosed when they go away ────
  const gameWindows = new Map(); // gameId → WindowProxy
  let gameClosedCb = null;
  let toastCb = null;

  function enc(s) { return encodeURIComponent(s == null ? '' : String(s)); }

  function watchForClose(gameId, win) {
    const timer = setInterval(() => {
      if (win.closed) {
        clearInterval(timer);
        gameWindows.delete(gameId);
        // Same-origin storage is already shared — empty snapshot, nothing to apply.
        if (gameClosedCb) { try { gameClosedCb(gameId, {}); } catch (e) {} }
      }
    }, 1000);
  }

  // ── Cross-tab storage events → toasts + live stat refresh ─────────────────
  // Fires in THIS tab whenever a game tab writes localStorage. Mirrors the
  // app's achievement-toast IPC and its 'game-storage-sync' CustomEvent.
  window.addEventListener('storage', (e) => {
    if (!e.key) return;
    if (e.key === 'gl_toast_bus') {
      if (!toastCb || !e.newValue) return;
      try {
        const d = JSON.parse(e.newValue);
        if (d && d.achievementId) toastCb({ gameId: d.gameId, achievementId: d.achievementId });
      } catch (err) {}
    } else if (e.key.indexOf('gl_') === 0) {
      try {
        window.dispatchEvent(new CustomEvent('game-storage-sync', { detail: { key: e.key } }));
      } catch (err) {}
    }
  });

  // ── electronAPI ────────────────────────────────────────────────────────────
  window.electronAPI = {
    // Metadata
    getGames: () => gamesData().then(d => {
      const list = Array.isArray(d) ? d : (d.games || []);
      // Deep-copy so renderer mutations (favorites UI etc.) never poison the cache.
      return JSON.parse(JSON.stringify(list));
    }),
    getGlobalAchievements: () => gamesData().then(d =>
      (!Array.isArray(d) && d.globalAchievements) ? d.globalAchievements : []),
    getChangelog: () => fetch('changelog.json', { cache: 'no-cache' })
      .then(r => r.json())
      .then(data => ({ version: SITE_VERSION, releases: Array.isArray(data) ? data : (data.releases || []) }))
      .catch(() => ({ version: SITE_VERSION, releases: [] })),
    saveGames: () => Promise.resolve(false),  // library is read-only on the website
    scanGames: () => Promise.resolve([]),

    // Covers — static files under covers/, versions from the build manifest
    saveCover: () => Promise.resolve(false),
    coverExists: () => Promise.resolve(true),
    listCovers: () => fetch('covers/manifest.json', { cache: 'no-cache' })
      .then(r => r.json()).catch(() => ({})),

    // Game launching — new window on the SAME origin (shared localStorage)
    openGame(gameId, fileName, preferredWidth, preferredHeight /*, winConstraints */) {
      const existing = gameWindows.get(gameId);
      if (existing && !existing.closed) { existing.focus(); return Promise.resolve(); }

      const name   = (localStorage.getItem('gl_player_name')   || 'Player');
      const emblem = (localStorage.getItem('gl_player_emblem') || '🎮');
      const url = encodeURI(fileName) +
        '?gameId=' + enc(gameId) + '&playerName=' + enc(name) + '&playerEmblem=' + enc(emblem);
      const w = preferredWidth  || 1024;
      const h = preferredHeight || 768;
      const win = window.open(url, 'gl_' + gameId,
        'width=' + w + ',height=' + h + ',menubar=no,toolbar=no,location=no,status=no');
      if (!win) {
        alert('Your browser blocked the game window.\nPlease allow pop-ups for this site, then press Play again.');
        return Promise.resolve();
      }
      gameWindows.set(gameId, win);
      watchForClose(gameId, win);
      return Promise.resolve();
    },

    // Adding/removing games — desktop-app only (UI hidden via .web-mode CSS)
    pickGameFile: () => Promise.resolve(null),
    copyGameFile: () => Promise.resolve({ ok: false }),
    deleteGame: () => Promise.resolve({ ok: false }),

    // External (on-demand) games are bundled into the site at build time
    isGameInstalled: () => Promise.resolve(true),
    installGame: () => Promise.resolve({ ok: true }),
    onInstallProgress: () => {},

    // Events
    onAchievementToast: (cb) => { toastCb = cb; },
    onGameClosed: (cb) => { gameClosedCb = cb; },

    // localStorage passthrough — same origin, read it directly
    getLsKey: (key) => {
      try { return Promise.resolve(localStorage.getItem(key)); }
      catch (e) { return Promise.resolve(null); }
    },

    // Cover editing — desktop-app only (UI hidden via .web-mode CSS)
    selectNativeCover: () => Promise.resolve(false),
    listCoverVariants: () => Promise.resolve([]),
    saveCoverVariant: () => Promise.resolve(false),
    deleteCoverVariant: () => Promise.resolve(false),

    // Player data — localStorage IS the store on the web; nothing to restore.
    getPlayerData: () => Promise.resolve({}),
    syncLauncherStorage: () => {},
    notifyReady: () => {},

    // Updates — the website is always current; renderer swaps the update
    // button for a "Get the Desktop App" link when __pickleWeb is set.
    // (onUpdateStatus intentionally omitted: renderer feature-checks it.)
    checkForUpdates: () => Promise.resolve({ status: 'web' }),

    // App info — client:'web' tags feedback + user-presence records
    getAppInfo: () => Promise.resolve({ version: SITE_VERSION, isDev: false, client: 'web' }),

    // Town Builder saves — no filesystem on the web, so back them with localStorage
    // (one JSON blob keyed by file id). Mirrors the app's file-per-town behaviour.
    townbuilderList:   ()          => Promise.resolve(tbList()),
    townbuilderRead:   (file)      => Promise.resolve(tbAll()[tbId(file)] || null),
    townbuilderWrite:  (file, data) => Promise.resolve(tbWrite(file, data)),
    townbuilderDelete: (file)      => { const o = tbAll(); delete o[tbId(file)]; tbPut(o); return Promise.resolve({ ok: true }); },
    townbuilderRename: (file, name) => Promise.resolve(tbRename(file, name)),
    townbuilderCopy:   (file)      => Promise.resolve(tbCopy(file)),
    townbuilderExport: (file)      => Promise.resolve(tbExport(file)),
  };

  // ── Town Builder localStorage store (web fallback) ─────────────────────────
  const TB_KEY = 'tb_files_v1';
  function tbAll()  { try { return JSON.parse(localStorage.getItem(TB_KEY)) || {}; } catch (e) { return {}; } }
  function tbPut(o) { try { localStorage.setItem(TB_KEY, JSON.stringify(o)); } catch (e) {} }
  function tbId(f)  { return String(f == null ? '' : f).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 48) || 'town'; }
  function tbUniq(base, o, skip) { let id = tbId(base), i = 2; while (o[id] && id !== skip) id = tbId(base) + ' ' + (i++); return id; }
  function tbList() {
    const o = tbAll();
    return Object.keys(o).map(f => ({ file: f, name: (o[f] && o[f].name) || f, time: (o[f] && o[f].time) || 0, blockCount: (o[f] && Array.isArray(o[f].blocks)) ? o[f].blocks.length : 0 }));
  }
  function tbWrite(file, data) {
    const o = tbAll();
    const id = file ? tbId(file) : tbUniq((data && data.name) || 'town', o);
    o[id] = data; tbPut(o);
    return { ok: true, file: id, name: (data && data.name) || id };
  }
  function tbRename(file, name) {
    const o = tbAll(), id = tbId(file), d = o[id];
    if (!d) return { ok: false };
    const nid = tbUniq(name, o, id);
    d.name = String(name == null ? '' : name).trim().slice(0, 48) || 'town';
    delete o[id]; o[nid] = d; tbPut(o);
    return { ok: true, file: nid, name: d.name };
  }
  function tbCopy(file) {
    const o = tbAll(), d = o[tbId(file)];
    if (!d) return { ok: false };
    const name = String((d.name || 'town') + ' copy').slice(0, 48);
    const nid = tbUniq(name, o);
    o[nid] = Object.assign({}, d, { name, time: Date.now() }); tbPut(o);
    return { ok: true, file: nid, name };
  }
  function tbExport(file) {
    const o = tbAll(), id = tbId(file), d = o[id];
    if (!d) return { ok: false };
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = id + '.json';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) {}
    return { ok: true, web: true };
  }
})();
