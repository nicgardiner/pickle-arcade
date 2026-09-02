// renderer.js — Game Library launcher logic
'use strict';

const api = window.electronAPI;

// ── Website build detection ───────────────────────────────────
// True when running as the GitHub Pages website (web/web-shim.js is loaded
// before this file and sets the flag). App-only features (library editing,
// cover designer, auto-updates) are hidden via the html.web-mode CSS rules
// in style.css; use IS_WEB for any behavior that must branch in JS.
const IS_WEB = !!window.__pickleWeb;
// Cover image URL: privileged covers:// protocol in the app, plain static
// covers/ folder on the website.
const coverSrc = (name) => (IS_WEB ? 'covers/' : 'covers://') + name;

// ── Tag taxonomy ──────────────────────────────────────────────
// Genre tags render as rounded pills; multiplayer tags render in their own
// section with a chamfered (cut-corner) shape. MP_TAGS order is fixed.
const GENRE_TAGS = ['Action', 'Strategy', 'Roguelite', 'Platformer', 'Racing', 'Battle', 'Casual', 'Puzzle', 'Horror', 'RPG', 'Board Game', 'Card Game', 'Sandbox', 'WIP'];
const MP_TAGS = ['Local', 'Online', 'Co-op', 'PvP'];
const isMpTag = t => MP_TAGS.includes(t);

// Build the tag-picker buttons (genre pills + a divided multiplayer group).
// Used by the Add-Game modal and the per-game Edit-Tags editor.
function tagOptsHTML(selected) {
  const sel = selected || [];
  const mk = (t, extra) => `<button class="tag-opt${extra}${sel.includes(t) ? ' selected' : ''}" data-tag="${t}">${t}</button>`;
  const genre = GENRE_TAGS.map(t => mk(t, '')).join('');
  const mp = MP_TAGS.map(t => mk(t, ' mp-tag-opt')).join('');
  return genre + `<div class="tag-mp-group"><span class="tag-mp-label">Multiplayer</span>${mp}</div>`;
}

// Render a game's tags for display (info modal): genre pills first, then the
// multiplayer tags in their own chamfered section, separated by a break.
function tagDisplayHTML(tags) {
  const all = tags || [];
  const genre = all.filter(t => !isMpTag(t) && t !== 'WIP');
  if (all.includes('WIP')) genre.push('WIP');
  const mp = MP_TAGS.filter(t => all.includes(t));
  let html = genre.map(t => `<span class="modal-tag">${t}</span>`).join('');
  if (mp.length) {
    html += `<span class="modal-tag-sep"></span>` +
      mp.map(t => `<span class="modal-tag mp-modal-tag">${t}</span>`).join('');
  }
  return html;
}

let allGames = [];
let globalAchievementDefs = [];
let currentGameId = null;
let activeParty = 'all';
let activeTag = 'all';
let activeDev = 'all';
let sortMode = 'release';   // grid sort: release | alpha | playtime | achievements | updated
let sortDesc = false;       // false = each mode's natural order, true = flipped (Z–A, oldest first…)
let gameUpdates = {};       // gameId → last-update timestamp (ms), 0 = never/unknown
let gameBadges  = {};       // gameId → 'new' | 'updated' (corner badge on the card)
// (Playtime is no longer clocked here — main.js / web-shim.js own one clock per
// open game window and bank it every 30s, so a crash can't lose the session.)
let installedExternal = {}; // gameId → true once an external game's file is present on disk
let installingGames = {};   // gameId → true while a download is in flight

// Cover modal state
let coverGameId = null;
let coverCfg = { bg: '#329632', lineColor: '#000000', titleColor: '#FFD700', pattern: 'lines', icon: '🎮', showTitle: true, titleFont: 'Arial Black', titleSize: 0, titleUppercase: true, titleShadow: true, titleShade: true, titleLetterSpacing: 3, imageDataUrl: null };
let newGameCoverCfg = null; // cover config being designed for a not-yet-added game
let emojiPanelOpen = false;
let coverTabMode = 'design';
let coverVersions = {}; // gameId → timestamp, cache-busts card <img> after save
let coverListEntries = [];        // [{id, name, builtin}] for the cover list view
let coverListSelected = null;     // variant id currently highlighted in the list
let designerReturnToList = false; // true when the designer was opened via "Add new"
let _achCache = null;  // parsed achievement map, invalidated on game-closed

// ── Sound Effects ─────────────────────────────────────────────
const SFX = (() => {
  let _ctx = null;
  function ac() {
    if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
    return _ctx;
  }
  function tone(freq, type, vol, attack, decay, delay = 0) {
    try {
      const c = ac(), osc = c.createOscillator(), g = c.createGain();
      osc.connect(g); g.connect(c.destination);
      osc.type = type; osc.frequency.value = freq;
      const t = c.currentTime + delay;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + attack);
      g.gain.exponentialRampToValueAtTime(0.001, t + attack + decay);
      osc.start(t); osc.stop(t + attack + decay + 0.02);
    } catch {}
  }
  return {
    // Tiny tick for generic button presses
    click()   { tone(650, 'sine', 0.04, 0.004, 0.04); },
    // Soft upward two-note sweep for opening panels/modals
    open()    { tone(440, 'sine', 0.055, 0.008, 0.07); tone(600, 'sine', 0.04, 0.006, 0.07, 0.07); },
    // Three-note ascending fanfare for launching a game
    launch()  { tone(330, 'sine', 0.06, 0.006, 0.07); tone(440, 'sine', 0.06, 0.006, 0.07, 0.07); tone(550, 'sine', 0.07, 0.006, 0.1, 0.14); },
    // Bright ascending chime for saves/confirms
    success() { tone(523, 'sine', 0.07, 0.008, 0.09); tone(659, 'sine', 0.06, 0.008, 0.09, 0.09); tone(784, 'sine', 0.06, 0.008, 0.11, 0.18); },
  };
})();

// ── Initialization ─────────────────────────────────────────────
async function init() {
  // Fetch player data, game list, and global achievements in parallel
  const [_pd, loadedGames, loadedGlobalAch] = await Promise.all([
    api.getPlayerData(),
    api.getGames(),
    api.getGlobalAchievements(),
  ]);
  if (_pd && typeof _pd === 'object') {
    Object.entries(_pd).forEach(function(kv) {
      try { localStorage.setItem(kv[0], kv[1]); } catch {}
    });
  }
  // Fold renamed/retired game ids into their current keys. Must run AFTER the
  // restore above, or it would migrate an empty localStorage and then have the
  // orphans seeded back in on the next launch.
  runDataMigrations();
  // Ensure this profile has a stable unique ID (used by feedback, and later for
  // leaderboards). Assigned once and persisted; survives profile renames and
  // reinstalls. Runs AFTER the playerData restore above so a reinstall keeps the
  // original ID instead of minting a new one.
  if (!localStorage.getItem('gl_player_id')) {
    var _pid = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : ('usr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
    persistKey('gl_player_id', _pid);
  }
  allGames = loadedGames;
  // Normalize legacy "arcade" cover type → "minimalist" ("Arcade" is no longer a cover type)
  let _coverTypeMigrated = false;
  allGames.forEach(g => {
    if (g.activeCoverType === 'arcade') { g.activeCoverType = 'minimalist'; _coverTypeMigrated = true; }
  });
  if (_coverTypeMigrated) { api.saveGames(allGames).catch(() => {}); }
  globalAchievementDefs = loadedGlobalAch || [];

  // Cover metadata in a single IPC: { id → mtimeMs } for every cover on disk.
  // Seeding coverVersions with the file mtime means each card's <img> URL carries
  // `?v=<mtime>` — a version that only changes when the cover file changes — so the
  // long-lived covers:// cache never serves a stale image. Also tells us which
  // covers already exist, so generateMissingCovers can skip the per-game checks.
  let coverMeta = {};
  try { coverMeta = await api.listCovers() || {}; } catch {}
  Object.assign(coverVersions, coverMeta);

  // Re-assert a wall-wide native cover style ("all default"/"all minimalist").
  // The choice lives only in localStorage + the active cover files, so a
  // bundled-cover refresh in main can put default art back on some cards —
  // re-applying the style here makes it stick across launches.
  // selectNativeCover returns 'unchanged' when the active file already matches
  // the style (the normal case) — then we KEEP the stable mtime-based ?v= from
  // listCovers so every card is served from the immutable covers:// cache and
  // paints instantly. Only a cover whose file was actually rewritten gets a
  // fresh version (the file's new mtime, so the URL also survives relaunch).
  // (Busting all 26 with Date.now() on every launch was why covers
  // re-downloaded one by one on each start.)
  const wallStyle = localStorage.getItem('gl_cover_style');
  if (wallStyle === 'default' || wallStyle === 'minimalist') {
    for (const g of allGames) {
      if (g.party === 'imported') continue; // no native default/minimalist covers exist for imported games
      try {
        const r = await api.selectNativeCover(g.id, wallStyle);
        if (typeof r === 'number') coverVersions[g.id] = r;
      } catch {}
    }
  }

  // External (on-demand) games: detect which are already downloaded (in parallel)
  await Promise.all(allGames.filter(g => g.external).map(async g => {
    try { installedExternal[g.id] = await api.isGameInstalled(g.fileName, g.download && g.download.sha256); }
    catch { installedExternal[g.id] = false; }
  }));
  // Restore the grid sort choice (after the playerData → localStorage restore
  // above, so it survives reinstalls like every other preference).
  const savedSort = localStorage.getItem('gl_sort_mode');
  if (['release', 'alpha', 'playtime', 'achievements', 'updated'].includes(savedSort)) sortMode = savedSort;
  sortDesc = localStorage.getItem('gl_sort_desc') === '1';

  // Per-game "last updated" stamps (app: file fingerprints; web: baked from git)
  if (api.getGameUpdates) {
    try { gameUpdates = (await api.getGameUpdates()) || {}; } catch {}
  }
  // A games.json entry can also pin its own "updatedAt" (date string or ms) —
  // an authored stamp shipped with a release, so a game shows as freshly
  // updated everywhere at once without waiting for local trackers to notice.
  allGames.forEach(g => {
    if (!g.updatedAt) return;
    const t = typeof g.updatedAt === 'number' ? g.updatedAt : Date.parse(g.updatedAt);
    if (t && t > (gameUpdates[g.id] || 0)) gameUpdates[g.id] = t;
  });

  // NEW / UPDATED card badges. Needs gameUpdates settled above, and the
  // changelog for the first-launch cohort. loadChangelog() caches, so the
  // What's New button doesn't pay for this call twice.
  computeGameBadges(await loadChangelog());

  buildTagFilters();
  buildDevFilters();
  renderGrid();

  // Dismiss loading screen and signal main process to show the window.
  // The splash closes ~120ms after this, giving the main window a frame
  // to paint before the splash disappears.
  const ll = document.getElementById('launch-loading');
  if (ll) {
    ll.classList.add('ll-done');
    setTimeout(() => ll.remove(), 500);
  }
  api.notifyReady();

  setupListeners();

  // Smooth-scroll guard: while #main is actively scrolling, mark it so cards
  // ignore the cursor (see #main.is-scrolling in style.css). Stops the hover
  // zoom/sheen from firing on every card the pointer sweeps past mid-scroll — a
  // big scroll-smoothness win on machines without GPU acceleration. Capture phase
  // so the horizontal Recently-Played / Favorites rows count too; the flag clears
  // 140ms after scrolling stops.
  const _scrollHost = document.getElementById('main');
  if (_scrollHost) {
    let _scrollIdle = null;
    _scrollHost.addEventListener('scroll', () => {
      _scrollHost.classList.add('is-scrolling');
      if (_scrollIdle) clearTimeout(_scrollIdle);
      _scrollIdle = setTimeout(() => _scrollHost.classList.remove('is-scrolling'), 140);
    }, { passive: true, capture: true });
  }

  // Profile: show welcome modal if no name/emblem set yet, else update chip
  const hasProfile = localStorage.getItem('gl_player_name') && localStorage.getItem('gl_player_emblem');
  if (!hasProfile) {
    showWelcomeModal();
  } else {
    updateProfileChip();
  }

  // Apply saved customization settings
  applyCardSize(localStorage.getItem('gl_card_size') || 'md');
  const savedAccent = localStorage.getItem('gl_accent');
  const savedAccent2 = localStorage.getItem('gl_accent2');
  if (savedAccent) applyAccent(savedAccent, savedAccent2 || savedAccent);
  updateCustomizePanelState();
  renderRecentlyPlayed();
  renderFavorites();
  api.onAchievementToast(showAchievementToast);
  api.onGameClosed((gameId, lsSnapshot) => {
    // Apply game's synced localStorage to launcher before reading stats
    if (lsSnapshot && typeof lsSnapshot === 'object') {
      Object.entries(lsSnapshot).forEach(([k, v]) => {
        try { localStorage.setItem(k, v); } catch {}
      });
    }
    invalidateAchCache(); // stats may have changed — rebuild on next render
    // A game session may have completed all achievements; re-render the grid so
    // the gold "100%" banner appears immediately instead of only after relaunch.
    renderGrid();
    if (currentGameId) refreshInfoModal(currentGameId);
  });

  // Real-time stat refresh: fires whenever a game syncs localStorage to the launcher
  window.addEventListener('game-storage-sync', (e) => {
    const key = e.detail && e.detail.key;
    if (!key) return;
    // Refresh stats panel if the synced key belongs to the currently open game
    // modal (playtime included — it now ticks live while the game is open).
    if (currentGameId && (key === `gl_${currentGameId}_stats` ||
                          key === `gl_${currentGameId}_achievements` ||
                          key === `gl_${currentGameId}_playtime`)) {
      refreshInfoModal(currentGameId);
    }
    // If an achievements key changed, the game may have just hit 100% — rebuild
    // the cache and re-render the grid so the gold banner updates live, even
    // when no game modal is open.
    if (/^gl_.+_achievements$/.test(key)) {
      invalidateAchCache();
      renderGrid();
    }
  });

  // Generate any missing covers in the background after UI is shown.
  // Pass the cover map we already fetched so it skips the per-game existence IPC.
  generateMissingCovers(coverMeta);

  // Dev Shelf button (dev machine only; no-ops everywhere else)
  initDevShelf();
}

// ── Achievement toast ─────────────────────────────────────────
function showAchievementToast(data) {
  const game = allGames.find(g => g.id === (data && data.gameId));
  const ach  = (game && game.achievements || []).find(a => a.id === (data && data.achievementId));
  const label = ach ? `${ach.icon || '🏆'} ${ach.label}` : (data && data.achievementId) || 'Achievement';
  const body  = document.getElementById('toast-body');
  if (body) body.textContent = label;
  const toast = document.getElementById('ach-toast');
  if (!toast) return;
  toast.classList.add('show');
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 4500);
}

// ── Add-game modal ────────────────────────────────────────────
function openAddModal() {
  SFX.open();
  document.getElementById('add-title').value = 'My Game';
  document.getElementById('add-desc').value  = '';
  document.getElementById('add-file-path').textContent = 'No file selected…';
  document.querySelectorAll('#add-tags .tag-opt').forEach(b => b.classList.remove('selected'));
  newGameCoverCfg = { bg: '#329632', lineColor: '#000000', titleColor: '#FFD700', pattern: 'lines', icon: '🎮' };
  updateAddCoverPreview();
  document.getElementById('add-modal').classList.add('open');
}

function updateAddCoverPreview() {
  const el = document.getElementById('add-cover-preview');
  if (!el) return;
  const title = (document.getElementById('add-title') && document.getElementById('add-title').value.trim()) || 'My Game';
  const fakeGame = { id: '__new__', title, party: 'imported' };
  const cfg = newGameCoverCfg || { bg: '#329632', lineColor: '#000000', titleColor: '#FFD700', pattern: 'lines', icon: '🎮' };
  el.innerHTML = generateCoverSVG(fakeGame, cfg);
}

function closeAddModal() {
  document.getElementById('add-modal').classList.remove('open');
}

async function pickGameFile() {
  const filePath = await api.pickGameFile();
  if (filePath) document.getElementById('add-file-path').textContent = filePath;
}

async function confirmAddGame() {
  const filePath = document.getElementById('add-file-path').textContent.trim();
  const title    = document.getElementById('add-title').value.trim();
  const desc     = document.getElementById('add-desc').value.trim();
  if (!title || filePath === 'No file selected…') return;

  const selectedTags = [...document.querySelectorAll('#add-tags .tag-opt.selected')].map(b => b.dataset.tag);
  const fileName = await api.copyGameFile(filePath);
  if (!fileName) return;

  const id = fileName.replace(/\.html$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const game = { id, title, description: desc, tags: selectedTags, fileName, party: 'imported', stats: [], achievements: [] };

  // Generate and save a cover for the new game (generateCoverSVG handles embedded images)
  const cfg = newGameCoverCfg || { bg: '#329632', lineColor: '#000000', titleColor: '#FFD700', pattern: 'lines', icon: '🎮' };
  const svg = generateCoverSVG(game, cfg);
  const cfgToSave = Object.assign({}, cfg);
  delete cfgToSave.imageDataUrl;
  game.coverConfig = cfgToSave;
  await api.saveCover(id, svg);

  allGames.push(game);
  await api.saveGames(allGames);
  buildTagFilters();
  renderGrid();
  SFX.success();
  closeAddModal();
}

// ── Cover: SVG generator ───────────────────────────────────────
const EMOJI_CATEGORIES = [
  { label: '🎮 Gaming',   emojis: ['🎮','🕹️','🎯','🎲','🧩','🃏','♟️','🎰','👾','🏆','🥇','🎖️','🥈','🥉','🎳','🎱','🪀','🎴','🀄','🏅','👑'] },
  { label: '🚀 Space',    emojis: ['🚀','🛸','🌍','🪐','🌌','☄️','⭐','💫','🌟','🔭','🛰️','🌠','🌑','🌕','🌖','🌗','🪨','👽','🌝','🌛'] },
  { label: '🐉 Creatures',emojis: ['👻','💀','☠️','🤖','🧟','🧙','🐉','🦄','🦁','🐯','🦊','🐺','🦝','🐸','🦑','🐙','🦅','🦇','🐲','🦎','🧛','🧚','🧜','🧝','🦸','🦹','👹','👺','👽','🐍','🦂','🕷️','🦈'] },
  { label: '⚡ Elements', emojis: ['🔥','❄️','⚡','🌊','🌪️','🌋','🌈','☀️','🌙','💧','🌿','🍄','💨','🌫️','☁️','⛈️','🌩️','🌨️','🪵','🌱'] },
  { label: '⚔️ Combat',   emojis: ['⚔️','🗡️','🛡️','🏹','🔱','💣','🧨','⛏️','🪃','🥊','🪓','🔨','⚒️','🪖','🎯','🔫','💥','🩸','🤺','🥋'] },
  { label: '💎 Magic',    emojis: ['🔮','🧿','💎','💠','🌀','👑','🪄','✨','💥','🎭','📜','🪬','♾️','⚗️','🧪','🕯️','📿','🃏','♠️','♣️','♥️','♦️'] },
  { label: '🚗 Vehicles', emojis: ['🚗','🏎️','✈️','🚁','🏍️','🛩️','⛵','🚂','🚜','🛵','🚓','🚑','🚒','🚀','🛸','🚤','🛥️','🚲','🛹','🛼'] },
  { label: '🐐 Animals',  emojis: ['🐐','🦙','🐮','🐘','🐊','🐢','🦜','🐧','🦉','🦒','🦘','🐕','🐈','🦖','🦕','🐻','🐨','🐼','🦝','🦅','🦋','🐝','🐬','🐳','🦦','🦔','🐉'] },
  { label: '🎵 Other',    emojis: ['💊','⚗️','🎪','🎨','🎬','🎵','🎸','🥁','🎃','💰','🪙','🍕','🌮','🍄','🎷','🎺','🎻','🪕','🍔','🍩','🍺','🏰','🗿','⛩️','🏴‍☠️','🧭','🗺️','⏳'] },
];

function escXml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function genPattern(pattern, lineColor) {
  if (pattern === 'lines') {
    const cx = 340, cy = 680;
    let out = '';
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const ir = 55 + (i % 5) * 18;
      const sw = [22, 9, 15, 7, 28][i % 5];
      const op = [0.55, 0.28, 0.4, 0.22, 0.6][i % 5];
      const x1 = (cx + Math.cos(a) * ir).toFixed(1);
      const y1 = (cy + Math.sin(a) * ir).toFixed(1);
      const x2 = (cx + Math.cos(a) * 950).toFixed(1);
      const y2 = (cy + Math.sin(a) * 950).toFixed(1);
      out += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${lineColor}" stroke-width="${sw}" opacity="${op}"/>`;
    }
    return `<g clip-path="url(#cvclip)">${out}</g>`;
  }
  if (pattern === 'grid') {
    let out = '';
    for (let x = 0; x <= 680; x += 55) out += `<line x1="${x}" y1="148" x2="${x}" y2="988" stroke="${lineColor}" stroke-width="2.5" opacity="0.25"/>`;
    for (let y = 148; y <= 988; y += 55) out += `<line x1="0" y1="${y}" x2="680" y2="${y}" stroke="${lineColor}" stroke-width="2.5" opacity="0.25"/>`;
    return `<g>${out}</g>`;
  }
  if (pattern === 'dots') {
    let out = '';
    for (let x = 28; x < 680; x += 44) for (let y = 190; y < 988; y += 44)
      out += `<circle cx="${x}" cy="${y}" r="5.5" fill="${lineColor}" opacity="0.28"/>`;
    return `<g>${out}</g>`;
  }
  if (pattern === 'scanlines') {
    let out = '';
    for (let y = 160; y < 1020; y += 16) {
      const thick = y % 48 === 0;
      out += `<line x1="0" y1="${y}" x2="680" y2="${y}" stroke="${lineColor}" stroke-width="${thick ? 2 : 1}" opacity="${thick ? 0.32 : 0.13}"/>`;
    }
    return `<g>${out}</g>`;
  }
  if (pattern === 'diamonds') {
    let out = '';
    const s = 62;
    for (let row = -1; row < 32; row++) {
      for (let col = -1; col < 14; col++) {
        const cx = col * s + (row % 2 === 0 ? 0 : s / 2);
        const cy = 160 + row * s * 0.58;
        out += `<polygon points="${cx},${cy - s * 0.42} ${cx + s * 0.5},${cy} ${cx},${cy + s * 0.42} ${cx - s * 0.5},${cy}" stroke="${lineColor}" stroke-width="2.5" fill="none" opacity="0.22"/>`;
      }
    }
    return `<g clip-path="url(#cvclip)">${out}</g>`;
  }
  if (pattern === 'hexagons') {
    let out = '';
    const r = 34;
    const w = r * Math.sqrt(3);
    for (let row = -1; row < 20; row++) {
      for (let col = -1; col < 14; col++) {
        const cx = col * w + (row % 2 === 0 ? 0 : w / 2);
        const cy = 160 + row * r * 1.5;
        const pts = Array.from({length:6}, (_,a) => {
          const ang = Math.PI / 180 * (60 * a - 30);
          return `${(cx + r * Math.cos(ang)).toFixed(1)},${(cy + r * Math.sin(ang)).toFixed(1)}`;
        }).join(' ');
        out += `<polygon points="${pts}" stroke="${lineColor}" stroke-width="2.5" fill="none" opacity="0.21"/>`;
      }
    }
    return `<g clip-path="url(#cvclip)">${out}</g>`;
  }
  if (pattern === 'waves') {
    let out = '';
    for (let i = 0; i < 15; i++) {
      const y0 = 165 + i * 58;
      const amp = 16 + (i % 3) * 12;
      const phase = (i % 2) * Math.PI;
      let d = `M 0 ${y0}`;
      for (let x = 0; x <= 680; x += 12) {
        const wy = (y0 + Math.sin((x / 680) * Math.PI * 5 + phase) * amp).toFixed(1);
        d += ` L ${x} ${wy}`;
      }
      const sw = [2.5, 3, 3.5, 2.5][i % 4];
      const op = [0.16, 0.26, 0.32, 0.14][i % 4];
      out += `<path d="${d}" stroke="${lineColor}" stroke-width="${sw}" fill="none" opacity="${op}"/>`;
    }
    return `<g clip-path="url(#cvclip)">${out}</g>`;
  }
  if (pattern === 'triangles') {
    let out = '';
    const s = 70;
    const h = s * 0.866;
    for (let row = -1; row < 16; row++) {
      const y0 = 148 + row * h;
      for (let col = -1; col < 12; col++) {
        const x0 = col * s + (row % 2 === 0 ? 0 : s / 2);
        // upward triangle
        out += `<polygon points="${x0},${(y0 + h).toFixed(1)} ${(x0 + s / 2).toFixed(1)},${y0.toFixed(1)} ${(x0 + s).toFixed(1)},${(y0 + h).toFixed(1)}" stroke="${lineColor}" stroke-width="2.5" fill="none" opacity="0.2"/>`;
        // downward triangle
        out += `<polygon points="${(x0 + s / 2).toFixed(1)},${y0.toFixed(1)} ${(x0 + s).toFixed(1)},${(y0 + h).toFixed(1)} ${(x0 + s * 1.5).toFixed(1)},${y0.toFixed(1)}" stroke="${lineColor}" stroke-width="2.5" fill="none" opacity="0.2"/>`;
      }
    }
    return `<g clip-path="url(#cvclip)">${out}</g>`;
  }
  if (pattern === 'circuit') {
    let out = '';
    const g = 56;
    // grid traces
    for (let x = 28; x <= 680; x += g) out += `<line x1="${x}" y1="148" x2="${x}" y2="1020" stroke="${lineColor}" stroke-width="2" opacity="0.16"/>`;
    for (let y = 176; y <= 1020; y += g) out += `<line x1="0" y1="${y}" x2="680" y2="${y}" stroke="${lineColor}" stroke-width="2" opacity="0.16"/>`;
    // nodes + short stubs at intersections
    let seed = 7;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let x = 28; x <= 680; x += g) {
      for (let y = 176; y <= 1020; y += g) {
        if (rnd() > 0.45) {
          out += `<circle cx="${x}" cy="${y}" r="6" fill="${lineColor}" opacity="0.3"/>`;
          const dir = Math.floor(rnd() * 4);
          const len = g * 0.55;
          const dx = [len, -len, 0, 0][dir], dy = [0, 0, len, -len][dir];
          out += `<line x1="${x}" y1="${y}" x2="${(x + dx).toFixed(1)}" y2="${(y + dy).toFixed(1)}" stroke="${lineColor}" stroke-width="3.5" opacity="0.28"/>`;
        }
      }
    }
    return `<g clip-path="url(#cvclip)">${out}</g>`;
  }
  return '';
}

// Approximate character width as fraction of font-size (used for auto-wrap)
const FONT_WIDTH = {
  'Arial Black': 0.72, 'Impact': 0.48, 'Trebuchet MS': 0.58,
  'Georgia': 0.60, 'Courier New': 0.62, 'Comic Sans MS': 0.64,
  'Verdana': 0.66, 'Times New Roman': 0.52, 'Palatino Linotype': 0.56,
  'Lucida Console': 0.62, 'Tahoma': 0.58, 'Garamond': 0.48,
  'Brush Script MT': 0.42, 'Copperplate': 0.66,
};

function wrapCoverTitle(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (test.length <= maxChars) { cur = test; }
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function generateCoverSVG(game, cfg) {
  const showTitle    = cfg.showTitle !== false;
  const rawTitle     = game.title || '';
  const t            = (cfg.titleUppercase !== false) ? rawTitle.toUpperCase() : rawTitle;
  const titleFont    = cfg.titleFont || 'Arial Black';
  const spacing      = typeof cfg.titleLetterSpacing === 'number' ? cfg.titleLetterSpacing : 3;
  const widthFactor  = FONT_WIDTH[titleFont] || 0.65;
  const AVAIL        = 640; // usable title width in px
  const FONT_SIZES   = [82, 74, 66, 58, 50, 42, 34, 28];

  let lines = [], fs = 50;
  if (showTitle && t) {
    const fixedSize = cfg.titleSize && cfg.titleSize > 0 ? cfg.titleSize : 0;
    if (fixedSize) {
      fs = fixedSize;
      const mc = Math.max(1, Math.floor(AVAIL / (fs * widthFactor + spacing)));
      lines = wrapCoverTitle(t, mc).slice(0, 3);
    } else {
      let chosen = null;
      for (const tryFs of FONT_SIZES) {
        const mc = Math.max(1, Math.floor(AVAIL / (tryFs * widthFactor + spacing)));
        const wrapped = wrapCoverTitle(t, mc);
        if (wrapped.length <= 3) { chosen = { lines: wrapped, fs: tryFs }; break; }
      }
      if (!chosen) {
        const mc = Math.max(1, Math.floor(AVAIL / (28 * widthFactor + spacing)));
        chosen = { lines: wrapCoverTitle(t, mc).slice(0, 3), fs: 28 };
      }
      lines = chosen.lines; fs = chosen.fs;
    }
  }

  const lineH     = Math.round(fs * 1.25);
  const padding   = 20;
  const hdrH      = (showTitle && lines.length) ? Math.max(148, lines.length * lineH + padding * 2) : 0;
  const textBaseY = padding + fs;

  // Decor accent lines flanking a single-line title
  let decorLines = '';
  if (showTitle && lines.length === 1) {
    const approxW = lines[0].length * fs * widthFactor;
    const lw = Math.max(0, Math.floor((680 - approxW) / 2) - 48);
    if (lw > 20) {
      const ry = Math.round(textBaseY - fs * 0.35);
      decorLines =
        '<rect x="48" y="' + ry + '" width="' + lw + '" height="1.5" fill="' + cfg.titleColor + '" opacity="0.5"/>' +
        '<rect x="' + (680-48-lw) + '" y="' + ry + '" width="' + lw + '" height="1.5" fill="' + cfg.titleColor + '" opacity="0.5"/>';
    }
  }

  // Title text elements
  let textEls = '';
  if (showTitle && lines.length) {
    lines.forEach(function(line, i) {
      const y  = textBaseY + i * lineH;
      const ff = titleFont + ', sans-serif';
      if (cfg.titleShadow !== false) {
        const off = Math.max(3, Math.round(fs * 0.06));
        textEls += '<text x="' + (340 + off) + '" y="' + (y + off) + '" text-anchor="middle" font-family="' + ff + '" font-weight="900" font-size="' + fs + '" fill="rgba(0,0,0,0.7)" letter-spacing="' + spacing + '">' + escXml(line) + '</text>';
      }
      textEls += '<text x="340" y="' + y + '" text-anchor="middle" font-family="' + ff + '" font-weight="900" font-size="' + fs + '" fill="' + cfg.titleColor + '" letter-spacing="' + spacing + '">' + escXml(line) + '</text>';
    });
  }

  // Background: embedded image or pattern
  let bgLayer;
  if (cfg.imageDataUrl) {
    bgLayer = '<image href="' + cfg.imageDataUrl + '" x="0" y="0" width="680" height="1020" preserveAspectRatio="xMidYMid slice"/>';
  } else {
    const pat = genPattern(cfg.pattern, cfg.lineColor);
    bgLayer = '<rect width="680" height="1020" fill="' + cfg.bg + '"/>' + pat;
  }

  // Icon (only without image bg)
  const iconEl = cfg.imageDataUrl ? '' :
    '<text x="340" y="660" text-anchor="middle" dominant-baseline="central" font-size="300">' + cfg.icon + '</text>';

  // Header overlay bar behind title
  const showShade = cfg.titleShade !== false;
  const hdrOverlay = (showTitle && hdrH > 0)
    ? (showShade
        ? '<rect x="0" y="0" width="680" height="' + hdrH + '" fill="rgba(0,0,0,0.62)"/>' +
          '<line x1="0" y1="' + hdrH + '" x2="680" y2="' + hdrH + '" stroke="' + cfg.titleColor + '" stroke-width="1.2"/>'
        : '') +
      decorLines
    : '';

  const footerY = 988;
  return '<svg width="400" height="600" viewBox="0 0 680 1020" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
    '<defs><clipPath id="cvclip"><rect width="680" height="1020"/></clipPath></defs>' +
    bgLayer + iconEl + hdrOverlay + textEls +
    '<rect x="0" y="' + footerY + '" width="680" height="32" fill="rgba(0,0,0,0.52)"/>' +
    '<line x1="0" y1="' + footerY + '" x2="680" y2="' + footerY + '" stroke="' + cfg.titleColor + '" stroke-width="0.8" opacity="0.3"/>' +
    '</svg>';
}

// ── Cover: auto-generate missing covers ───────────────────────
async function generateMissingCovers(coverMeta) {
  if (!allGames.length) return; // safety: never save an empty game list
  const have = coverMeta || {}; // { id → mtime } of covers already on disk
  let changed = false;
  for (const g of allGames) {
    if (have[g.id]) continue; // cover already exists — skip (no per-game IPC)
    const cfg = {
      bg: g.coverConfig?.bg || '#030e1a',
      lineColor: g.coverConfig?.lineColor || '#3522aa',
      titleColor: g.coverConfig?.titleColor || '#FFD700',
      pattern: g.coverConfig?.pattern || 'lines',
      icon: g.coverConfig?.icon || '🎮',
    };
    const svg = generateCoverSVG(g, cfg);
    await api.saveCover(g.id, svg);
    coverVersions[g.id] = Date.now(); // bust the card so the new cover shows
    g.hasCover = true;
    changed = true;
  }
  if (changed) {
    await api.saveGames(allGames);
    // A card may have shown a broken/placeholder cover before generation — re-render.
    renderGrid();
    renderRecentlyPlayed();
    renderFavorites();
  }
}

// ── Tag filter builder ────────────────────────────────────────
function buildTagFilters() {
  const tags = new Set();
  allGames.forEach(g => (g.tags || []).forEach(t => tags.add(t)));

  // Genre tags → main filter bar (rounded pills), ordered by how many games
  // carry each tag (desc), ties broken alphabetically, with WIP pinned last.
  const bar = document.getElementById('filter-bar');
  bar.querySelectorAll('[data-filter="tag"]:not([data-value="all"])').forEach(b => b.remove());
  const tagCounts = new Map();
  allGames.forEach(g => (g.tags || []).forEach(t => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)));
  [...tags].filter(t => !isMpTag(t))
    .sort((a, b) =>
      a === 'WIP' ? 1 : b === 'WIP' ? -1 :
      (tagCounts.get(b) - tagCounts.get(a)) || a.localeCompare(b))
    .forEach(tag => {
      const btn = document.createElement('button');
      btn.className = 'filter-chip';
      btn.dataset.filter = 'tag';
      btn.dataset.value = tag;
      btn.textContent = tag;
      bar.appendChild(btn);
    });

  // Multiplayer tags → their own row below, in fixed order, chamfered shape
  const mpBar = document.getElementById('filter-mp-bar');
  if (mpBar) {
    mpBar.querySelectorAll('[data-filter="tag"]').forEach(b => b.remove());
    const mpInUse = MP_TAGS.filter(t => tags.has(t));
    mpBar.style.display = mpInUse.length ? '' : 'none';
    mpInUse.forEach(tag => {
      const btn = document.createElement('button');
      btn.className = 'filter-chip mp-chip';
      btn.dataset.filter = 'tag';
      btn.dataset.value = tag;
      btn.textContent = tag;
      mpBar.appendChild(btn);
    });
  }
}

// The developer a game is attributed to. First-party (Pickle) games are all
// credited to "Picklesguy"; third-party games carry their own developer.
function devOf(g) {
  if (g.party === 'first') return 'Picklesguy';
  return g.developer || null;
}

// ── Developer filter builder ───────────────────────────────────
function buildDevFilters() {
  const row = document.getElementById('filter-dev-row');
  if (!row) return;
  // Tally games per developer (Picklesguy + each third-party dev)…
  const counts = new Map();
  allGames.forEach(g => {
    const d = devOf(g);
    if (d) counts.set(d, (counts.get(d) || 0) + 1);
  });
  // …then order by game count (desc), breaking ties alphabetically.
  const devs = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
  row.querySelectorAll('[data-filter="dev"]').forEach(b => b.remove());
  const allBtn = document.createElement('button');
  allBtn.className = 'filter-chip active';
  allBtn.dataset.filter = 'dev';
  allBtn.dataset.value = 'all';
  allBtn.textContent = 'All';
  row.appendChild(allBtn);
  devs.forEach(dev => {
    const btn = document.createElement('button');
    btn.className = 'filter-chip';
    btn.dataset.filter = 'dev';
    btn.dataset.value = dev;
    btn.textContent = dev;
    row.appendChild(btn);
  });
}

// ── Card helpers ──────────────────────────────────────────────
// ── NEW / UPDATED card badges ─────────────────────────────────
// The one cover decoration painted at rest (the gold 100% ribbon and the WIP
// bar are hover-only): its job is to catch the eye while you scan the grid,
// not to reward a card you've already picked.
const BADGE_KEY    = 'gl_badge_state';
const BADGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // a badge you never act on fades after a week

function readBadgeState() {
  try { return JSON.parse(localStorage.getItem(BADGE_KEY) || 'null'); } catch { return null; }
}

// Fills gameBadges with { gameId → 'new' | 'updated' }.
// Per game we store { ack, shown }: `ack` is the newest change the player has
// acknowledged (bumped when they launch it), `shown` is when the current badge
// first appeared, so it can time out on its own.
function computeGameBadges(changelog) {
  const now = Date.now();
  let state = readBadgeState();

  // First launch — a fresh install, or the first run after this feature ships.
  // Every game is technically unseen, which would light the whole grid up, so
  // acknowledge the entire library up front EXCEPT the games the running
  // version's release notes name as new. A first launch then points at the
  // newest arrivals and nothing else.
  if (!state) {
    const releases = (changelog && changelog.releases) || [];
    const running  = (changelog && changelog.version) || '';
    const rel   = releases.find(r => r.version === running) || releases[0];
    const fresh = new Set((rel && rel.newGames) || []);
    state = {};
    allGames.forEach(g => {
      if (fresh.has(g.id)) return;    // no entry = unseen = badges as NEW below
      state[g.id] = { ack: Math.max(gameUpdates[g.id] || 0, now) };
    });
    persistKey(BADGE_KEY, JSON.stringify(state));
  }

  const badges = {};
  let dirty = false;
  allGames.forEach(g => {
    const entry     = state[g.id];
    const changedAt = gameUpdates[g.id] || 0;
    let kind = null;
    if (!entry) kind = 'new';                                  // arrived since the last launch
    else if (changedAt > (entry.ack || 0)) kind = 'updated';   // same game, new contents
    if (!kind) return;

    const rec = state[g.id] || (state[g.id] = { ack: 0 });
    if (!rec.shown) { rec.shown = now; dirty = true; }
    if (now - rec.shown > BADGE_TTL_MS) {
      // Timed out. Acknowledge it so the badge stops showing, but leave the
      // slot ready — the NEXT update to this game starts a fresh window.
      rec.ack = Math.max(changedAt, now);
      delete rec.shown;
      dirty = true;
      return;
    }
    badges[g.id] = kind;
  });
  if (dirty) persistKey(BADGE_KEY, JSON.stringify(state));
  gameBadges = badges;
}

// Playing a game is the acknowledgement — drop its badge and repaint the rows
// it appears in.
function clearGameBadge(gameId) {
  if (!gameBadges[gameId]) return;
  const state = readBadgeState() || {};
  state[gameId] = { ack: Math.max(gameUpdates[gameId] || 0, Date.now()) };
  persistKey(BADGE_KEY, JSON.stringify(state));
  delete gameBadges[gameId];
  renderGrid();
  renderFavorites();
  renderRecentlyPlayed();
}

// The bulk version, for when you've scanned the grid and don't want to open (or
// right-click) every badged game one at a time. Same acknowledgement per game,
// so the NEXT change to any of them starts a fresh badge window as usual.
function clearAllGameBadges() {
  const ids = Object.keys(gameBadges);
  if (!ids.length) return;
  const state = readBadgeState() || {};
  const now = Date.now();
  ids.forEach(id => { state[id] = { ack: Math.max(gameUpdates[id] || 0, now) }; });
  persistKey(BADGE_KEY, JSON.stringify(state));
  gameBadges = {};
  renderGrid();
  renderFavorites();
  renderRecentlyPlayed();
}

// The button only exists while there's something to clear — the count doubles
// as an unseen tally, and it leaves the header rather than sitting there greyed
// out. Called from renderGrid(), which every badge change already goes through.
function updateMarkAllSeenBtn() {
  const btn = document.getElementById('mark-all-seen-btn');
  if (!btn) return;
  const n = Object.keys(gameBadges).length;
  btn.style.display = n ? '' : 'none';
  btn.textContent = `✓ Mark all seen (${n})`;
}

function isAllAchievementsUnlocked(game) {
  if (!game.achievements || game.achievements.length === 0) return false;
  const unlocked = readAchievements(game.id);
  return game.achievements.every(a => unlocked[a.id]);
}

function gameCardHTML(g) {
  const gold = isAllAchievementsUnlocked(g) ? ' card-gold' : '';
  const isWIP = (g.tags || []).includes('WIP');
  const allTags = (g.tags || []).filter(t => t !== 'WIP');
  // Up to 2 genre pills, then the multiplayer tags (chamfered) as their own group.
  const genreTags = allTags.filter(t => !isMpTag(t)).slice(0, 2);
  const mpTags = MP_TAGS.filter(t => allTags.includes(t));
  const visibleTags =
    genreTags.map(t => `<span class="card-tag">${t}</span>`).join('') +
    mpTags.map(t => `<span class="card-tag mp-card-tag">${t}</span>`).join('');
  const needsInstall = g.external && !installedExternal[g.id];
  const playLabel = needsInstall ? '⬇ Install' : '▶ Play';
  const wipBar = isWIP ? `<div class="card-wip-bar">🚧 UNDER CONSTRUCTION 🚧</div>` : '';
  const goldBanner = gold ? `<div class="gold-banner"><span class="banner-trophy">🏆</span><span class="banner-text"> 100%</span></div>` : '';
  // Top-left corner: the only spot the gold ribbon's 45° rotation never reaches.
  // WIP games wear a full-width bar there on hover, so the badge steps down.
  const badgeKind = gameBadges[g.id];
  const badge = badgeKind
    ? `<div class="card-badge card-badge-${badgeKind}${isWIP ? ' card-badge-wip' : ''}">${badgeKind === 'new' ? 'NEW' : 'UPDATED'}</div>`
    : '';
  return `<div class="game-card${gold}" data-id="${g.id}">
    <div class="card-cover">
      <img src="${coverSrc(g.id + '.svg')}${(coverVersions[g.id] || g.coverVersion) ? '?v='+(coverVersions[g.id] || g.coverVersion) : ''}" alt="${g.title}" loading="lazy" onerror="if(this.src.indexOf('.svg')>-1){this.src='${coverSrc(g.id + '.png')}'}else{this.style.display='none'}">
      ${goldBanner}${wipBar}${badge}
      <div class="card-overlay">
        <div class="card-tag-row">${visibleTags}</div>
        <button class="card-play-btn" data-action="play" data-id="${g.id}">${playLabel}</button>
      </div>
    </div>
  </div>`;
}

// ── Grid rendering ────────────────────────────────────────────
function renderGrid() {
  const search = document.getElementById('search-input').value.toLowerCase().trim();

  const passesFilters = g => {
    // 'all' and 'sortdev' show every game; only 'imported' narrows by party.
    if (activeParty === 'imported' && g.party !== 'imported') return false;
    if (activeDev !== 'all' && devOf(g) !== activeDev) return false;
    if (activeTag !== 'all' && !(g.tags||[]).includes(activeTag)) return false;
    if (search) {
      const inTitle = g.title.toLowerCase().includes(search);
      const inDesc  = (g.description || '').toLowerCase().includes(search);
      // Tags and developer are searchable too — "puzzle", "co-op" and a studio
      // name are all things you'd reasonably type into a game search.
      const inTags  = (g.tags || []).some(t => t.toLowerCase().includes(search));
      const inDev   = (devOf(g) || '').toLowerCase().includes(search);
      if (!inTitle && !inDesc && !inTags && !inDev) return false;
    }
    return true;
  };

  // WIP games appear in main grid like any other game.
  // .reverse() = release order, newest first — the default. The other modes
  // re-sort on top of it; sort() is stable, so ties keep release order.
  let mainGames = allGames.filter(g => passesFilters(g)).reverse();

  const playtimeOf = g => parseInt(localStorage.getItem(`gl_${g.id}_playtime`) || '0', 10) || 0;
  if (sortMode === 'alpha') {
    mainGames.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sortMode === 'playtime') {
    mainGames.sort((a, b) => playtimeOf(b) - playtimeOf(a));
  } else if (sortMode === 'achievements') {
    const achCount = g => Object.keys(readAchievements(g.id)).length;
    mainGames.sort((a, b) => achCount(b) - achCount(a));
  } else if (sortMode === 'updated') {
    mainGames.sort((a, b) => (gameUpdates[b.id] || 0) - (gameUpdates[a.id] || 0));
  }
  // Flip button: reverse whatever the chosen mode produced (ties included).
  // Done before the search pass so title matches still float to the top.
  if (sortDesc) mainGames.reverse();

  // Title matches sort first when searching
  if (search) {
    mainGames.sort((a, b) => {
      const aT = a.title.toLowerCase().includes(search);
      const bT = b.title.toLowerCase().includes(search);
      return (aT === bT) ? 0 : aT ? -1 : 1;
    });
  }

  const grid = document.getElementById('game-grid');
  grid.innerHTML = mainGames.length
    ? mainGames.map(g => gameCardHTML(g)).join('')
    : '<div class="empty-state"><div class="big-icon">🔍</div><div>No games match your filters</div></div>';
  updateMarkAllSeenBtn();
}

// ── Recently Played ───────────────────────────────────────────
function updateRecentlyPlayed(gameId) {
  let recent = JSON.parse(localStorage.getItem('gl_recently_played') || '[]');
  recent = recent.filter(id => id !== gameId);
  recent.unshift(gameId);
  recent = recent.slice(0, 7);
  persistKey('gl_recently_played', JSON.stringify(recent));
}

function renderRecentlyPlayed() {
  const recent = JSON.parse(localStorage.getItem('gl_recently_played') || '[]');
  const section = document.getElementById('recently-played');
  const games = recent.map(id => allGames.find(g => g.id === id)).filter(Boolean);
  if (!games.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  document.getElementById('recent-row').innerHTML = games.map(g => gameCardHTML(g)).join('');
}

function renderFavorites() {
  const favs = readFavorites();
  const section = document.getElementById('favorites-section');
  const games = favs.map(id => allGames.find(g => g.id === id)).filter(Boolean);
  if (!games.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  document.getElementById('favorites-row').innerHTML = games.map(g => gameCardHTML(g)).join('');
}

// ── Event listeners ───────────────────────────────────────────
function updateFilterBtn() {
  const partyNames = { all: 'All Games', sortdev: 'By Developer', imported: 'Imported' };
  let label = partyNames[activeParty] || 'All Games';
  if (activeDev !== 'all') label += ` · ${activeDev}`;
  if (activeTag !== 'all') label += ` · ${activeTag}`;
  const btn = document.getElementById('filter-btn');
  if (btn) {
    btn.textContent = `🏷 ${label} ▾`;
    btn.classList.toggle('active', activeParty !== 'all' || activeTag !== 'all' || activeDev !== 'all');
  }
}

// ── Persist launcher-side localStorage to playerdata.json ─────
function persistKey(key, value) {
  try { localStorage.setItem(key, value); } catch {}
  if (api.syncLauncherStorage) api.syncLauncherStorage(key, value);
}

// Drop a key everywhere. localStorage.removeItem alone isn't enough in the app:
// startup re-seeds localStorage from playerdata.json, so a key removed without
// this would reappear on the next launch.
function unpersistKey(key) {
  try { localStorage.removeItem(key); } catch {}
  if (api.removeLauncherStorage) api.removeLauncherStorage(key);
}

// ── One-time data migrations ──────────────────────────────────
// Stats live under `gl_{gameId}_*`, so renaming a game's id in games.json
// orphans everything it had earned — the launcher just starts that game over
// at zero while the old history sits in playerdata.json under a key nothing
// reads. These are the renames that already happened; add a line here for any
// future one, bump DATA_MIGRATION_VERSION, and history follows the rename.
const GAME_ID_ALIASES = {
  catan: 'settlers',            // "Catan" → "Settlers" (v1.0.8)
  floe_fighters: 'floe-fighters', // underscore → hyphen
};
// Games pulled from the library for good — purge every trace so they can't
// haunt the achievement totals or the recently-played row.
const RETIRED_GAME_IDS = ['death_ring_z'];
const DATA_MIGRATION_VERSION = 1;

function migrateGameId(from, to) {
  // Playtime: additive, so sum the two clocks.
  const oldPt = parseInt(localStorage.getItem(`gl_${from}_playtime`) || '0', 10) || 0;
  if (oldPt) {
    const newPt = parseInt(localStorage.getItem(`gl_${to}_playtime`) || '0', 10) || 0;
    persistKey(`gl_${to}_playtime`, String(newPt + oldPt));
  }
  // Stats / durable save: adopt the old blob only if the new id has none —
  // stat keys mean different things per game, so never merge field by field.
  ['stats', 'save'].forEach(suffix => {
    const oldVal = localStorage.getItem(`gl_${from}_${suffix}`);
    if (oldVal && localStorage.getItem(`gl_${to}_${suffix}`) === null) {
      persistKey(`gl_${to}_${suffix}`, oldVal);
    }
  });
  // Achievements: a plain union, keeping the earlier unlock time.
  try {
    const oldAch = JSON.parse(localStorage.getItem(`gl_${from}_achievements`) || '{}');
    if (Object.keys(oldAch).length) {
      const newAch = JSON.parse(localStorage.getItem(`gl_${to}_achievements`) || '{}');
      Object.entries(oldAch).forEach(([id, rec]) => {
        if (!newAch[id] || (rec && rec.unlockedAt < newAch[id].unlockedAt)) newAch[id] = rec;
      });
      persistKey(`gl_${to}_achievements`, JSON.stringify(newAch));
    }
  } catch {}
  ['stats', 'achievements', 'playtime', 'save'].forEach(s => unpersistKey(`gl_${from}_${s}`));
  // Global achievement ledger is keyed `${gameId}::${achievementId}`.
  try {
    const ga = JSON.parse(localStorage.getItem('gl_global_achievements') || '{}');
    let touched = false;
    Object.keys(ga).forEach(k => {
      if (k.indexOf(`${from}::`) !== 0) return;
      const moved = `${to}::${k.slice(from.length + 2)}`;
      if (!ga[moved]) ga[moved] = Object.assign({}, ga[k], { gameId: to });
      delete ga[k];
      touched = true;
    });
    if (touched) persistKey('gl_global_achievements', JSON.stringify(ga));
  } catch {}
  // Lists that store bare ids.
  ['gl_recently_played', 'gl_favorites'].forEach(listKey => {
    try {
      const list = JSON.parse(localStorage.getItem(listKey) || '[]');
      if (!list.includes(from)) return;
      const next = list.map(id => (id === from ? to : id))
                       .filter((id, i, a) => a.indexOf(id) === i);
      persistKey(listKey, JSON.stringify(next));
    } catch {}
  });
}

function purgeGameId(gid) {
  ['stats', 'achievements', 'playtime', 'save'].forEach(s => unpersistKey(`gl_${gid}_${s}`));
  try {
    const ga = JSON.parse(localStorage.getItem('gl_global_achievements') || '{}');
    let touched = false;
    Object.keys(ga).forEach(k => {
      if (k.indexOf(`${gid}::`) === 0) { delete ga[k]; touched = true; }
    });
    if (touched) persistKey('gl_global_achievements', JSON.stringify(ga));
  } catch {}
  ['gl_recently_played', 'gl_favorites'].forEach(listKey => {
    try {
      const list = JSON.parse(localStorage.getItem(listKey) || '[]');
      if (!list.includes(gid)) return;
      persistKey(listKey, JSON.stringify(list.filter(id => id !== gid)));
    } catch {}
  });
}

function runDataMigrations() {
  const done = parseInt(localStorage.getItem('gl_data_migration') || '0', 10) || 0;
  if (done >= DATA_MIGRATION_VERSION) return;
  try {
    Object.entries(GAME_ID_ALIASES).forEach(([from, to]) => migrateGameId(from, to));
    RETIRED_GAME_IDS.forEach(purgeGameId);
  } catch {}
  persistKey('gl_data_migration', String(DATA_MIGRATION_VERSION));
}

// ── What's New / changelog ────────────────────────────────────
let _changelogCache = null; // { version, releases }

async function loadChangelog() {
  if (_changelogCache) return _changelogCache;
  try {
    _changelogCache = (api.getChangelog ? await api.getChangelog() : null) || { version: '', releases: [] };
  } catch {
    _changelogCache = { version: '', releases: [] };
  }
  return _changelogCache;
}

let _wnExpanded = false; // false = show latest only; true = full history

function renderReleaseHTML(rel, i) {
  const notes = (rel.notes || []).map(n => '<li>' + escapeHtmlWN(n) + '</li>').join('');
  const latest = i === 0 ? '<span class="wn-latest-tag">Latest</span>' : '';
  const date = rel.date ? '<span class="wn-date">' + escapeHtmlWN(rel.date) + '</span>' : '';
  const title = rel.title ? ('<span class="wn-rel-title">' + escapeHtmlWN(rel.title) + '</span>') : '';
  return (
    '<div class="wn-release">' +
      '<div class="wn-rel-head">' +
        '<span class="wn-version">v' + escapeHtmlWN(rel.version || '') + '</span>' +
        title + latest + date +
      '</div>' +
      '<ul class="wn-notes">' + notes + '</ul>' +
    '</div>'
  );
}

function renderWhatsNew(data) {
  const verEl = document.getElementById('wn-current-version');
  if (verEl) verEl.textContent = data.version ? ('Version ' + data.version) : '';
  const body = document.getElementById('wn-body');
  const modal = document.getElementById('whatsnew-modal');
  if (!body) return;
  const releases = (data.releases || []).slice();
  if (!releases.length) {
    body.innerHTML = '<div class="wn-empty">No release notes yet.</div>';
    const ft = document.getElementById('wn-footer');
    if (ft) ft.style.display = 'none';
    return;
  }
  // Newest → oldest (changelog.json is authored newest-first).
  const shown = _wnExpanded ? releases : releases.slice(0, 1);
  body.innerHTML = shown.map((rel, i) => renderReleaseHTML(rel, i)).join('');
  if (modal) modal.classList.toggle('wn-expanded', _wnExpanded);

  // Footer toggle — only meaningful when there's more than one release.
  const footer = document.getElementById('wn-footer');
  const toggle = document.getElementById('wn-toggle-all');
  if (footer && toggle) {
    if (releases.length > 1) {
      toggle.style.display = '';
      toggle.textContent = _wnExpanded
        ? '▲ Show latest only'
        : '▾ See all patch notes';
    } else {
      toggle.style.display = 'none';
    }
  }
}

function escapeHtmlWN(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function openWhatsNew() {
  const data = await loadChangelog();
  _wnExpanded = false; // always start collapsed (latest only)
  renderWhatsNew(data);
  const m = document.getElementById('whatsnew-modal');
  if (m) m.classList.add('open');
  // Mark the current version as seen so the badge clears.
  if (data.version) persistKey('gl_whatsnew_seen_version', data.version);
  const badge = document.querySelector('.whatsnew-badge');
  if (badge) badge.remove();
  // Close the profile dropdown if it's open
  const dd = document.getElementById('profile-dropdown');
  if (dd) dd.classList.remove('open');
}

function closeWhatsNew() {
  const m = document.getElementById('whatsnew-modal');
  if (m) m.classList.remove('open');
}

// Auto-open What's New the first time the app runs a version the user hasn't
// seen notes for (i.e. right after an auto-update).
async function maybeShowWhatsNewOnUpdate() {
  const data = await loadChangelog();
  if (!data.version || !(data.releases || []).length) return;
  const seen = localStorage.getItem('gl_whatsnew_seen_version');
  if (seen === data.version) return;
  // Show a small badge on the What's New button regardless.
  const whatsnewBtn = document.getElementById('whatsnew-btn');
  if (whatsnewBtn && !whatsnewBtn.querySelector('.whatsnew-badge')) {
    const dot = document.createElement('span');
    dot.className = 'whatsnew-badge';
    whatsnewBtn.appendChild(dot);
  }
  // On a genuine version change (not first-ever launch), pop the modal once.
  if (seen) {
    setTimeout(() => openWhatsNew(), 1200);
  } else {
    // First-ever launch: don't interrupt the welcome flow, just record baseline.
    persistKey('gl_whatsnew_seen_version', data.version);
    const badge = document.querySelector('.whatsnew-badge');
    if (badge) badge.remove();
  }
}

function setupListeners() {
  // Generic click sound — fires in capture phase for all buttons and filter chips
  document.addEventListener('click', e => {
    if (e.target.closest('button, .filter-chip')) SFX.click();
  }, true);

  document.getElementById('search-input').addEventListener('input', renderGrid);

  // Grid sort dropdown (next to the search bar)
  const sortDD    = document.getElementById('sort-dd');
  const sortTrig  = document.getElementById('sort-trigger');
  const sortLabel = document.getElementById('sort-trigger-label');
  const sortDirBtn = document.getElementById('sort-dir');
  // What "flipped" actually means depends on the mode — say so in the tooltip.
  const SORT_DIR_LABELS = {
    release:      ['Newest first',       'Oldest first'],
    alpha:        ['A–Z',                'Z–A'],
    playtime:     ['Most played first',  'Least played first'],
    achievements: ['Most earned first',  'Fewest earned first'],
    updated:      ['Most recent first',  'Least recent first'],
  };
  // Custom tooltip instead of the native title="" — same portal trick as
  // .sort-menu, since #filter-panel's overflow:hidden would clip it.
  const sortTip     = document.getElementById('sort-tip');
  const sortTipMain = document.getElementById('sort-tip-main');
  if (sortTip) document.body.appendChild(sortTip);
  const placeSortTip = () => {
    if (!sortTip || !sortDirBtn) return;
    const r = sortDirBtn.getBoundingClientRect();
    const h = sortTip.offsetHeight, w = sortTip.offsetWidth;
    const flip = window.innerHeight - r.bottom < h + 14;  // no room below → sit above
    sortTip.classList.toggle('flip', flip);
    sortTip.style.top = (flip ? r.top - h - 9 : r.bottom + 9) + 'px';
    // Centre on the button, but keep the whole box on screen.
    const left = r.left + r.width / 2 - w / 2;
    sortTip.style.left = Math.max(8, Math.min(left, window.innerWidth - w - 8)) + 'px';
  };
  const paintSortDir = () => {
    if (!sortDirBtn) return;
    const pair = SORT_DIR_LABELS[sortMode] || ['Ascending', 'Descending'];
    const label = pair[sortDesc ? 1 : 0];
    sortDirBtn.classList.toggle('desc', sortDesc);
    sortDirBtn.setAttribute('aria-label', `Sort order: ${label}. Click to reverse.`);
    sortDirBtn.setAttribute('aria-pressed', sortDesc ? 'true' : 'false');
    if (sortTipMain) sortTipMain.textContent = label;
    // Re-centre: the label width changes with the mode, and it may be showing.
    if (sortTip && sortTip.classList.contains('open')) placeSortTip();
  };
  if (sortDirBtn) {
    const showTip = () => { if (sortTip) { sortTip.classList.add('open'); placeSortTip(); } };
    const hideTip = () => { if (sortTip) sortTip.classList.remove('open'); };
    sortDirBtn.addEventListener('mouseenter', showTip);
    sortDirBtn.addEventListener('mouseleave', hideTip);
    sortDirBtn.addEventListener('blur', hideTip);
    sortDirBtn.addEventListener('focus', () => {
      // Keyboard focus only — a click already focuses the button, and the
      // pointer path handles that case.
      if (sortDirBtn.matches(':focus-visible')) showTip();
    });
    window.addEventListener('resize', () => { if (sortTip && sortTip.classList.contains('open')) placeSortTip(); });
    document.addEventListener('scroll', () => { if (sortTip && sortTip.classList.contains('open')) placeSortTip(); }, true);
    sortDirBtn.addEventListener('click', () => {
      sortDesc = !sortDesc;
      persistKey('gl_sort_desc', sortDesc ? '1' : '0');
      paintSortDir();
      renderGrid();
    });
    paintSortDir();
  }
  if (sortDD && sortTrig && sortLabel) {
    const opts = [...sortDD.querySelectorAll('.sort-opt')];
    const paint = () => {
      opts.forEach(o => {
        const on = o.dataset.value === sortMode;
        o.classList.toggle('selected', on);
        o.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) sortLabel.textContent = o.textContent;
      });
      paintSortDir();
    };
    // The menu lives on <body>: #filter-panel has overflow:hidden (collapse
    // animation), which would clip an absolutely-positioned child.
    const sortMenu = document.getElementById('sort-menu');
    document.body.appendChild(sortMenu);

    const placeDD = () => {
      const r = sortTrig.getBoundingClientRect();
      sortMenu.style.width = r.width + 'px';
      sortMenu.style.left = r.left + 'px';
      const h = sortMenu.offsetHeight;
      const below = window.innerHeight - r.bottom;
      sortMenu.style.top = (below < h + 12 && r.top > h + 12 ? r.top - h - 6 : r.bottom + 6) + 'px';
    };
    const closeDD = () => {
      sortDD.classList.remove('open');
      sortMenu.classList.remove('open');
      sortTrig.setAttribute('aria-expanded', 'false');
    };
    paint();

    sortTrig.addEventListener('click', e => {
      e.stopPropagation();
      const opening = !sortDD.classList.contains('open');
      sortDD.classList.toggle('open', opening);
      sortMenu.classList.toggle('open', opening);
      sortTrig.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (opening) placeDD();
    });
    window.addEventListener('resize', () => { if (sortDD.classList.contains('open')) placeDD(); });
    document.addEventListener('scroll', () => { if (sortDD.classList.contains('open')) placeDD(); }, true);
    opts.forEach(o => o.addEventListener('click', () => {
      sortMode = o.dataset.value;
      persistKey('gl_sort_mode', sortMode);
      paint();
      closeDD();
      renderGrid();
    }));
    document.addEventListener('click', e => {
      if (!sortDD.contains(e.target) && !sortMenu.contains(e.target)) closeDD();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDD(); });
  }

  // Panel open by default
  const _filterBtn   = document.getElementById('filter-btn');
  const _filterPanel = document.getElementById('filter-panel');

  // Panel starts open
  _filterBtn.classList.add('tab-open');

  const _markAllBtn = document.getElementById('mark-all-seen-btn');
  if (_markAllBtn) _markAllBtn.addEventListener('click', () => clearAllGameBadges());

  _filterBtn.addEventListener('click', () => {
    const closing = !_filterPanel.classList.contains('collapsed');
    _filterPanel.classList.toggle('collapsed', closing);
    _filterBtn.classList.toggle('tab-open', !closing);
    updateFilterBtn();
    _filterBtn.blur();
  });

  document.querySelectorAll('[data-filter="party"]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeParty = btn.dataset.value;
      document.querySelectorAll('[data-filter="party"]').forEach(b => b.classList.toggle('active', b === btn));
      const devRow = document.getElementById('filter-dev-row');
      if (devRow) devRow.style.display = activeParty === 'sortdev' ? 'flex' : 'none';
      if (activeParty !== 'sortdev') {
        activeDev = 'all';
        document.querySelectorAll('[data-filter="dev"]').forEach(b => b.classList.toggle('active', b.dataset.value === 'all'));
      }
      updateFilterBtn();
      renderGrid();
    });
  });

  document.getElementById('filter-panel').addEventListener('click', e => {
    const btn = e.target.closest('[data-filter="dev"]');
    if (!btn) return;
    activeDev = btn.dataset.value;
    document.querySelectorAll('[data-filter="dev"]').forEach(b => b.classList.toggle('active', b === btn));
    updateFilterBtn();
    renderGrid();
  });

  document.getElementById('filter-panel').addEventListener('click', e => {
    const btn = e.target.closest('[data-filter="tag"]');
    if (!btn) return;
    activeTag = btn.dataset.value;
    document.querySelectorAll('[data-filter="tag"]').forEach(b => b.classList.toggle('active', b === btn));
    updateFilterBtn();
    renderGrid();
  });

  // ── Right-click context menu ──────────────────────────────────
  const _ctxMenu = document.getElementById('card-context-menu');
  const _mainEl  = document.getElementById('main');
  let _ctxGameId = null;

  function openCtxMenu(x, y) {
    _ctxMenu.classList.add('open');
    // Align the first button's center with the cursor, so the title sits above it.
    // (Adding .open before measuring is safe — no paint happens mid-handler.)
    const playBtn = document.getElementById('ctx-play');
    const yOff = playBtn.offsetTop + playBtn.offsetHeight / 2;
    x = Math.min(x, window.innerWidth  - _ctxMenu.offsetWidth  - 8);
    y = Math.min(Math.max(y - yOff, 8), window.innerHeight - _ctxMenu.offsetHeight - 8);
    _ctxMenu.style.left = x + 'px';
    _ctxMenu.style.top  = y + 'px';
    _mainEl.style.overflow = 'hidden';
    document.body.classList.add('ctx-menu-open');
  }
  function closeCtxMenu() {
    _ctxMenu.classList.remove('open');
    _mainEl.style.overflow = '';
    document.body.classList.remove('ctx-menu-open');
  }

  document.getElementById('main').addEventListener('contextmenu', e => {
    const card = e.target.closest('.game-card');
    if (!card) return;
    e.preventDefault();
    SFX.click();
    _ctxGameId = card.dataset.id;
    const ctxGame = allGames.find(g => g.id === _ctxGameId);
    document.getElementById('ctx-game-title').textContent = ctxGame ? ctxGame.title : '';
    const fav = isFavorite(_ctxGameId);
    document.getElementById('ctx-fav-label').textContent = fav ? 'Remove from Favorites' : 'Add to Favorites';
    // Badge-clearing row only exists for a card that's actually wearing one.
    // Set before openCtxMenu — it measures the menu to clamp it on screen.
    const badgeKind  = gameBadges[_ctxGameId];
    const badgeCount = Object.keys(gameBadges).length;
    // The bulk row is only worth offering when it would clear something the
    // single-card row above it wouldn't — otherwise the two rows do the same job.
    const showMarkAll = badgeCount - (badgeKind ? 1 : 0) > 0;
    document.getElementById('ctx-badge-label').textContent =
      badgeKind === 'updated' ? 'Clear UPDATED badge' : 'Clear NEW badge';
    document.getElementById('ctx-mark-all-label').textContent = `Mark all as seen (${badgeCount})`;
    document.getElementById('ctx-clear-badge').style.display  = badgeKind ? '' : 'none';
    document.getElementById('ctx-mark-all-seen').style.display = showMarkAll ? '' : 'none';
    document.getElementById('ctx-badge-sep').style.display    = (badgeKind || showMarkAll) ? '' : 'none';
    openCtxMenu(e.clientX, e.clientY);
  });

  document.getElementById('ctx-play').addEventListener('click', () => {
    closeCtxMenu();
    if (_ctxGameId) launchGame(_ctxGameId);
  });
  document.getElementById('ctx-open').addEventListener('click', () => {
    closeCtxMenu();
    if (_ctxGameId) openInfoModal(_ctxGameId);
  });
  document.getElementById('ctx-favorite').addEventListener('click', () => {
    if (_ctxGameId) {
      const wasAlreadyFav = isFavorite(_ctxGameId);
      if (!wasAlreadyFav) {
        // Animate before closing so the button rect is still measurable
        favPopAnimation(document.getElementById('ctx-favorite'));
        playFavSound();
      }
      closeCtxMenu();
      toggleFavorite(_ctxGameId);
      renderFavorites();
    } else {
      closeCtxMenu();
    }
  });

  document.getElementById('ctx-clear-badge').addEventListener('click', () => {
    closeCtxMenu();
    if (_ctxGameId) clearGameBadge(_ctxGameId);
  });

  document.getElementById('ctx-mark-all-seen').addEventListener('click', () => {
    closeCtxMenu();
    clearAllGameBadges();
  });

  document.addEventListener('click', () => closeCtxMenu());
  document.addEventListener('contextmenu', e => {
    if (!e.target.closest('.game-card')) closeCtxMenu();
  });

  document.getElementById('main').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (btn.dataset.action === 'play') launchGame(id);
      else openInfoModal(id);
      return;
    }
    const card = e.target.closest('.game-card');
    if (card) openInfoModal(card.dataset.id);
  });

  document.getElementById('info-backdrop').addEventListener('click', closeInfoModal);
  document.getElementById('info-close').addEventListener('click', closeInfoModal);
  document.getElementById('modal-play-btn').addEventListener('click', () => {
    if (editModeActive) return; // locked while editing the game
    launchGame(currentGameId);
  });
  document.getElementById('modal-fav-btn').addEventListener('click', () => {
    if (editModeActive) return; // locked while editing the game
    if (!currentGameId) return;
    const wasAlreadyFav = isFavorite(currentGameId);
    toggleFavorite(currentGameId);
    updateFavBtn(currentGameId);
    renderFavorites();
    if (!wasAlreadyFav) {
      // Only animate when adding a favorite
      const btn = document.getElementById('modal-fav-btn');
      favPopAnimation(btn);
      playFavSound();
    }
  });
  document.getElementById('modal-edit-btn').addEventListener('click', () => {
    if (editModeActive) return; // locked while editing the game
    const id = currentGameId;
    if (id) { closeInfoModal(); openCoverModal(id); }
  });

  document.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      document.querySelector('.modal-body').dataset.tab = tab.dataset.tab;
    });
  });

  document.getElementById('add-game-btn').addEventListener('click', openAddModal);
  document.getElementById('add-backdrop').addEventListener('click', closeAddModal);
  document.getElementById('add-close').addEventListener('click', closeAddModal);
  document.getElementById('add-cancel').addEventListener('click', closeAddModal);
  document.getElementById('add-file-btn').addEventListener('click', pickGameFile);
  document.getElementById('add-confirm').addEventListener('click', confirmAddGame);
  document.getElementById('add-title').addEventListener('input', updateAddCoverPreview);
  document.getElementById('add-customize-cover-btn').addEventListener('click', () => openCoverModal('__new__'));
  document.getElementById('add-tags').addEventListener('click', e => {
    const btn = e.target.closest('.tag-opt');
    if (btn) btn.classList.toggle('selected');
  });

  // ── Edit Game mode ──────────────────────────────────────────
  // "Edit Game" reveals the inline tag/description editors plus the
  // top-right delete button, and swaps itself for Save/Discard Changes.
  // While active, the Customize Cover button is locked.
  document.getElementById('modal-editgame-btn').addEventListener('click', () => {
    const game = allGames.find(g => g.id === currentGameId);
    if (!game) return;
    enterEditMode(game);
  });

  document.getElementById('modal-edit-title-btn').addEventListener('click', () => {
    document.getElementById('modal-title').style.display = 'none';
    document.getElementById('modal-edit-title-btn').style.display = 'none';
    document.getElementById('modal-title-editor').style.display = '';
    document.getElementById('modal-title-editor').focus();
  });

  document.getElementById('modal-edit-desc-btn').addEventListener('click', () => {
    document.getElementById('modal-desc').style.display = 'none';
    document.getElementById('modal-edit-desc-btn').style.display = 'none';
    document.getElementById('modal-desc-editor').style.display = '';
  });

  document.getElementById('modal-edit-tags-btn').addEventListener('click', () => {
    const game = allGames.find(g => g.id === currentGameId);
    if (!game) return;
    document.getElementById('modal-tag-opts').innerHTML = tagOptsHTML(game.tags || []);
    document.getElementById('modal-tags').style.display = 'none';
    document.getElementById('modal-edit-tags-btn').style.display = 'none';
    document.getElementById('modal-tag-editor').style.display = '';
  });
  document.getElementById('modal-tag-opts').addEventListener('click', e => {
    const btn = e.target.closest('.tag-opt');
    if (btn) btn.classList.toggle('selected');
  });

  document.getElementById('modal-save-btn').addEventListener('click', async () => {
    const game = allGames.find(g => g.id === currentGameId);
    if (!game) return;
    // Commit title (if its editor is open), description, and tags.
    if (document.getElementById('modal-title-editor').style.display !== 'none') {
      const newTitle = document.getElementById('modal-title-editor').value.trim();
      if (newTitle) game.title = newTitle;
    }
    if (document.getElementById('modal-desc-editor').style.display !== 'none') {
      game.description = document.getElementById('modal-desc-editor').value.trim();
    }
    if (document.getElementById('modal-tag-editor').style.display !== 'none') {
      game.tags = [...document.querySelectorAll('#modal-tag-opts .tag-opt.selected')].map(b => b.dataset.tag);
    }
    await api.saveGames(allGames);
    buildTagFilters();
    renderGrid();
    // Refresh the displayed values, then leave edit mode.
    document.getElementById('modal-title').textContent = game.title || '';
    document.getElementById('modal-desc').textContent = game.description || '';
    document.getElementById('modal-tags').innerHTML = tagDisplayHTML(game.tags || []);
    exitEditMode();
  });

  document.getElementById('modal-discard-btn').addEventListener('click', () => {
    const game = allGames.find(g => g.id === currentGameId);
    // Restore displayed values from the unchanged game object (nothing was committed).
    if (game) {
      document.getElementById('modal-title').textContent = game.title || '';
      document.getElementById('modal-desc').textContent = game.description || '';
      document.getElementById('modal-tags').innerHTML = tagDisplayHTML(game.tags || []);
    }
    exitEditMode();
  });

  document.getElementById('modal-delete-btn').addEventListener('click', async () => {
    const game = allGames.find(g => g.id === currentGameId);
    if (!game || game.party !== 'imported') return;
    if (!confirm(`Remove "${game.title}" from your library?`)) return;
    const gid = game.id;
    // Clear every trace of this game — stats, achievements, playtime, durable
    // save, and its entries in the global ledger / recently-played / favorites.
    // (purgeGameId unpersists, so playerdata.json can't re-seed it next launch.)
    purgeGameId(gid);
    allGames = allGames.filter(g => g.id !== gid);
    await api.saveGames(allGames);
    await api.deleteGame(gid, game.fileName);
    closeInfoModal();
    buildTagFilters();
    renderGrid();
    renderRecentlyPlayed();
  });

  document.getElementById('achievements-btn').addEventListener('click', showGlobalAchievements);

  // ── Share ────────────────────────────────────────────────────
  const shareBtn = document.getElementById('share-btn');
  const shareModal = document.getElementById('share-modal');
  const shareClose = document.getElementById('share-close');
  const shareBackdrop = document.getElementById('share-backdrop');
  const shCopyBtn = document.getElementById('sh-copy-btn');
  const shCopyStatus = document.getElementById('sh-copy-status');
  const shWebOpen = document.getElementById('sh-web-open');
  const shWebCopy = document.getElementById('sh-web-copy');
  const SHARE_URL = 'https://github.com/nicgardiner/pickle-arcade/releases';
  const SITE_URL = 'https://nicgardiner.github.io/pickle-arcade/';

  function openShareModal() {
    if (shareModal) shareModal.classList.add('open');
    SFX.open();
  }
  function closeShareModal() {
    if (shareModal) shareModal.classList.remove('open');
  }

  // Copy any URL and flash confirmation on the button that was clicked.
  function shCopy(btn, url) {
    navigator.clipboard.writeText(url).then(() => {
      btn.textContent = '✓ Copied!';
      if (shCopyStatus) shCopyStatus.textContent = 'Link copied to clipboard!';
      setTimeout(() => {
        btn.textContent = 'Copy Link';
        if (shCopyStatus) shCopyStatus.textContent = '';
      }, 2500);
    }).catch(() => {
      if (shCopyStatus) shCopyStatus.textContent = 'Could not copy — select the link manually.';
    });
  }

  if (shareBtn) shareBtn.addEventListener('click', openShareModal);
  if (shareClose) shareClose.addEventListener('click', closeShareModal);
  if (shareBackdrop) shareBackdrop.addEventListener('click', closeShareModal);
  if (shCopyBtn) shCopyBtn.addEventListener('click', () => shCopy(shCopyBtn, SHARE_URL));
  if (shWebCopy) shWebCopy.addEventListener('click', () => shCopy(shWebCopy, SITE_URL));

  // Open the website in the user's real browser. In the app that's an IPC hop
  // to shell.openExternal (window.open would just spawn another Electron
  // window); on the website build the section is hidden, but window.open is
  // still the correct fallback if it ever isn't.
  if (shWebOpen) shWebOpen.addEventListener('click', async () => {
    SFX.click && SFX.click();
    try {
      if (window.electronAPI && window.electronAPI.openExternal) {
        const r = await window.electronAPI.openExternal(SITE_URL);
        if (r && r.ok === false) throw new Error(r.error || 'open failed');
      } else {
        window.open(SITE_URL, '_blank', 'noopener');
      }
    } catch {
      if (shCopyStatus) shCopyStatus.textContent = 'Could not open the browser — copy the link instead.';
    }
  });

  // ── What's New ──────────────────────────────────────────────
  const whatsnewBtn = document.getElementById('whatsnew-btn');
  if (whatsnewBtn) whatsnewBtn.addEventListener('click', () => openWhatsNew());
  const wnClose = document.getElementById('whatsnew-close');
  if (wnClose) wnClose.addEventListener('click', closeWhatsNew);
  const wnBackdrop = document.getElementById('whatsnew-backdrop');
  if (wnBackdrop) wnBackdrop.addEventListener('click', closeWhatsNew);
  const wnToggle = document.getElementById('wn-toggle-all');
  if (wnToggle) wnToggle.addEventListener('click', async () => {
    _wnExpanded = !_wnExpanded;
    renderWhatsNew(await loadChangelog());
    // When collapsing, scroll back to the top of the notes.
    if (!_wnExpanded) {
      const body = document.getElementById('wn-body');
      if (body) body.scrollTop = 0;
    }
  });
  // Manual update check button
  const wnCheckBtn = document.getElementById('wn-check-updates');
  if (wnCheckBtn) {
    wnCheckBtn.addEventListener('click', async () => {
      wnCheckBtn.disabled = true;
      wnCheckBtn.textContent = '⏳ Checking…';
      try {
        const result = await window.electronAPI.checkForUpdates();
        if (result.status === 'dev') {
          wnCheckBtn.textContent = '🛠 Dev mode — updates disabled';
        } else if (result.status === 'up-to-date') {
          wnCheckBtn.textContent = '✓ You\'re up to date!';
        } else if (result.status === 'found') {
          wnCheckBtn.textContent = `⬇ Downloading v${result.version}…`;
          // Dialog will appear when download completes; keep button disabled
          return;
        } else {
          wnCheckBtn.textContent = '⚠ Check failed — try again';
          wnCheckBtn.disabled = false;
          return;
        }
      } catch {
        wnCheckBtn.textContent = '⚠ Check failed — try again';
        wnCheckBtn.disabled = false;
        return;
      }
      setTimeout(() => {
        wnCheckBtn.textContent = '🔄 Check for Updates';
        wnCheckBtn.disabled = false;
      }, 4000);
    });
  }

  // Live update status → drive the progress bar, completion, and error states.
  // This is what makes a download visible instead of the button hanging silently.
  if (window.electronAPI.onUpdateStatus) {
    const wnProgress      = document.getElementById('wn-update-progress');
    const wnProgressBar   = document.getElementById('wn-progress-bar');
    const wnProgressLabel = document.getElementById('wn-progress-label');
    const showProgress = (on) => { if (wnProgress) wnProgress.style.display = on ? 'block' : 'none'; };
    const mb = (n) => (Number(n) / 1048576).toFixed(1);
    window.electronAPI.onUpdateStatus((s) => {
      const btn = document.getElementById('wn-check-updates');
      if (!s || !s.type) return;
      if (s.type === 'checking') {
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Checking…'; }
      } else if (s.type === 'available') {
        if (btn) { btn.disabled = true; btn.textContent = `⬇ Downloading v${s.version || ''}…`; }
        if (wnProgressBar)   wnProgressBar.style.width = '0%';
        if (wnProgressLabel) wnProgressLabel.textContent = 'Starting download…';
        showProgress(true);
      } else if (s.type === 'progress') {
        showProgress(true);
        if (wnProgressBar) wnProgressBar.style.width = s.percent + '%';
        const speed = s.bytesPerSecond ? ` · ${mb(s.bytesPerSecond)} MB/s` : '';
        if (wnProgressLabel) wnProgressLabel.textContent = `${s.percent}% — ${mb(s.transferred)} / ${mb(s.total)} MB${speed}`;
        if (btn) { btn.disabled = true; btn.textContent = `⬇ Downloading… ${s.percent}%`; }
      } else if (s.type === 'downloaded') {
        if (wnProgressBar)   wnProgressBar.style.width = '100%';
        if (wnProgressLabel) wnProgressLabel.textContent = 'Downloaded — restart to install.';
        if (btn) { btn.disabled = false; btn.textContent = '✓ Downloaded — restart to install'; }
      } else if (s.type === 'none') {
        showProgress(false);
        if (btn) {
          btn.textContent = '✓ You\'re up to date!';
          setTimeout(() => { btn.textContent = '🔄 Check for Updates'; btn.disabled = false; }, 4000);
        }
      } else if (s.type === 'error') {
        showProgress(false);
        if (wnProgressLabel) wnProgressLabel.textContent = '';
        if (btn) { btn.disabled = false; btn.textContent = '⚠ Update failed — ' + (s.message || 'try again'); }
        console.error('Update error:', s.message);
      }
    });
  }

  // Auto-show the What's New modal once after an update to a new version.
  maybeShowWhatsNewOnUpdate();

  // ── Customize UI panel ──────────────────────────────────────
  const customizeBtn   = document.getElementById('customize-btn');
  const customizePanel = document.getElementById('customize-panel');

  customizeBtn.addEventListener('click', e => {
    e.stopPropagation();
    const open = customizePanel.classList.toggle('open');
    customizeBtn.classList.toggle('panel-open', open);
    if (open) {
      // Close profile dropdown if open
      const dd = document.getElementById('profile-dropdown');
      if (dd) dd.classList.remove('open');
      updateCustomizePanelState();
    }
  });

  // Accent color swatches
  document.querySelectorAll('.cust-accent-swatch').forEach(sw => {
    sw.addEventListener('click', () => setAccent(sw.dataset.accent, sw.dataset.accent2));
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if (!customizePanel.contains(e.target) && e.target !== customizeBtn) {
      customizePanel.classList.remove('open');
      customizeBtn.classList.remove('panel-open');
    }
  });

  document.getElementById('cover-backdrop').addEventListener('click', closeCoverModal);
  document.getElementById('cover-close').addEventListener('click', closeCoverModal);
  document.getElementById('cover-save').addEventListener('click', saveCoverAndClose);
  document.getElementById('cover-restore').addEventListener('click', restoreDefaultCover);
  // Cover list view (Choose Cover / Cancel / Add new / Back to list)
  document.getElementById('cover-choose').addEventListener('click', confirmCoverChoice);
  document.getElementById('cover-list-cancel').addEventListener('click', closeCoverModal);
  document.getElementById('cv-add-new').addEventListener('click', addNewCoverFromList);
  document.getElementById('cover-design-back').addEventListener('click', backToList);
  document.getElementById('cv-cover-list').addEventListener('click', e => {
    const delBtn = e.target.closest('.cv-list-del');
    if (delBtn) {
      e.stopPropagation();
      if (delBtn.classList.contains('disabled')) return; // equipped cover can't be deleted
      deleteCoverListItem(delBtn.dataset.del);
      return;
    }
    const row = e.target.closest('.cv-list-row');
    if (!row) return;
    const game = allGames.find(g => g.id === coverGameId);
    if (game) selectCoverListItem(row.dataset.variant, game);
  });
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchCoverTab(btn.dataset.tab));
  });
  // Image import tab
  document.getElementById('cv-image-drop').addEventListener('click', () => document.getElementById('cv-image-input').click());
  document.getElementById('cv-image-change-btn').addEventListener('click', () => document.getElementById('cv-image-input').click());
  document.getElementById('cv-image-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      coverCfg.imageDataUrl = ev.target.result;
      document.getElementById('cv-image-preview').src = coverCfg.imageDataUrl;
      document.getElementById('cv-image-preview').style.display = 'block';
      document.getElementById('cv-image-placeholder').style.display = 'none';
      document.getElementById('cv-image-change-btn').style.display = '';
      renderCoverPreview();
      e.target.value = '';
    };
    reader.readAsDataURL(file);
  });

  // ── Title Design Panel listeners ────────────────────────────
  document.getElementById('cv-show-title').addEventListener('change', function() {
    coverCfg.showTitle = this.checked;
    document.getElementById('cv-title-opts').style.opacity = this.checked ? '1' : '0.4';
    renderCoverPreview();
  });
  document.getElementById('cv-title-font').addEventListener('change', function() {
    coverCfg.titleFont = this.value;
    renderCoverPreview();
  });
  document.getElementById('cv-title-color').addEventListener('input', function() {
    coverCfg.titleColor = this.value;
    document.getElementById('cv-title').value = this.value;
    renderCoverPreview();
  });
  document.getElementById('cv-title-size').addEventListener('input', function() {
    coverCfg.titleSize = parseInt(this.value, 10);
    document.getElementById('cv-title-size-label').textContent = coverCfg.titleSize > 0 ? coverCfg.titleSize : 'Auto';
    renderCoverPreview();
  });
  document.getElementById('cv-title-spacing').addEventListener('input', function() {
    coverCfg.titleLetterSpacing = parseInt(this.value, 10);
    document.getElementById('cv-spacing-label').textContent = this.value;
    renderCoverPreview();
  });
  document.getElementById('cv-title-uppercase').addEventListener('change', function() {
    coverCfg.titleUppercase = this.checked;
    renderCoverPreview();
  });
  document.getElementById('cv-title-shadow').addEventListener('change', function() {
    coverCfg.titleShadow = this.checked;
    renderCoverPreview();
  });
  document.getElementById('cv-title-shade').addEventListener('change', function() {
    coverCfg.titleShade = this.checked;
    renderCoverPreview();
  });

  document.getElementById('cv-bg').addEventListener('input', e => { coverCfg.bg = e.target.value; renderCoverPreview(); });
  document.getElementById('cv-line').addEventListener('input', e => { coverCfg.lineColor = e.target.value; renderCoverPreview(); });
  document.getElementById('cv-title').addEventListener('input', e => { coverCfg.titleColor = e.target.value; document.getElementById('cv-title-color').value = e.target.value; renderCoverPreview(); });
  document.getElementById('cv-patterns').addEventListener('click', e => {
    const btn = e.target.closest('.pattern-btn');
    if (!btn) return;
    coverCfg.pattern = btn.dataset.pattern;
    document.querySelectorAll('#cv-patterns .pattern-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderCoverPreview();
  });
  document.getElementById('cv-icon-btn').addEventListener('click', toggleEmojiPanel);
  document.getElementById('cv-icon-display').addEventListener('click', toggleEmojiPanel);
  document.getElementById('emoji-panel').addEventListener('click', e => {
    const btn = e.target.closest('.emoji-btn');
    if (!btn) return;
    coverCfg.icon = btn.dataset.emoji;
    document.getElementById('cv-icon-display').textContent = coverCfg.icon;
    emojiPanelOpen = false;
    document.getElementById('emoji-panel').style.display = 'none';
    renderCoverPreview();
  });

  // ── Escape closes the topmost overlay ─────────────────────────
  // One handler for every layer, ordered top-down, closing exactly one thing
  // per press so nested overlays (emoji panel → cover modal → info modal)
  // peel back one at a time instead of all at once.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const isOpen = id => {
      const el = document.getElementById(id);
      return !!el && el.classList.contains('open');
    };

    // The welcome modal is a first-run gate — it has no dismiss path by design.
    // (It shows via inline display, not the .open class every other modal uses.)
    const wm = document.getElementById('welcome-modal');
    if (wm && wm.style.display && wm.style.display !== 'none') return;
    // The feedback modal owns its own Escape handling in feedback.js.
    if (isOpen('feedback-modal')) return;
    // The sort dropdown already closes itself on Escape; don't also close
    // whatever is behind it on the same keypress.
    if (isOpen('sort-dd')) return;

    if (document.getElementById('card-context-menu').classList.contains('open')) {
      closeCtxMenu();
    } else if (emojiPanelOpen) {
      emojiPanelOpen = false;
      document.getElementById('emoji-panel').style.display = 'none';
    } else if (isOpen('cover-modal')) {
      closeCoverModal();
    } else if (isOpen('add-modal')) {
      closeAddModal();
    } else if (isOpen('profile-modal')) {
      closeProfileModal();
    } else if (isOpen('share-modal')) {
      closeShareModal();
    } else if (isOpen('whatsnew-modal')) {
      closeWhatsNew();
    } else if (isOpen('info-modal')) {
      // Locked mid-edit: unsaved title/description/tag edits are only meant to
      // leave through Save or Discard, so Escape stays inert here.
      if (editModeActive) return;
      // Click the real close button rather than calling closeInfoModal() —
      // the All Achievements panel swaps in its own handler there to tear the
      // panel down and restore the normal modal body.
      document.getElementById('info-close').click();
    } else if (isOpen('customize-panel')) {
      document.getElementById('customize-panel').classList.remove('open');
      document.getElementById('customize-btn').classList.remove('panel-open');
    } else if (isOpen('profile-dropdown')) {
      document.getElementById('profile-dropdown').classList.remove('open');
    }
  });
}

// ── Game launching ────────────────────────────────────────────
async function launchGame(id) {
  const game = allGames.find(g => g.id === id);
  if (!game) return;
  // External (on-demand) game that isn't downloaded yet → run the install flow instead.
  if (game.external && !installedExternal[id]) { installExternalGame(game); return; }
  SFX.launch();
  closeInfoModal();
  clearGameBadge(id);   // playing it is the acknowledgement
  updateRecentlyPlayed(id);
  renderRecentlyPlayed();
  const winConstraints = {};
  if (game.minWidth  != null) winConstraints.minWidth  = game.minWidth;
  if (game.maxWidth  != null) winConstraints.maxWidth  = game.maxWidth;
  if (game.minHeight != null) winConstraints.minHeight = game.minHeight;
  if (game.maxHeight != null) winConstraints.maxHeight = game.maxHeight;
  if (game.windowMaximized)   winConstraints.maximize  = true;
  await api.openGame(id, game.fileName, game.preferredWidth, game.preferredHeight, winConstraints);
}

// ── External game install (download on demand) ────────────────
function setInstallProgressUI(id, pct) {
  const label = `⬇ ${pct}%`;
  document.querySelectorAll(`.card-play-btn[data-id="${id}"]`).forEach(b => {
    b.textContent = label;
    b.classList.add('installing');
  });
  if (currentGameId === id) {
    const m = document.getElementById('modal-play-btn');
    if (m) m.textContent = label;
  }
}

function syncPlayBtnState(id) {
  // Re-render the grid (card labels) and the modal Play/Install button to match install state.
  renderGrid();
  const game = allGames.find(g => g.id === id);
  if (game && currentGameId === id) {
    const m = document.getElementById('modal-play-btn');
    if (m) m.textContent = (game.external && !installedExternal[id])
      ? `⬇ Install (${game.installSizeMB || '?'} MB)` : '▶ Play';
  }
}

async function installExternalGame(game) {
  if (installingGames[game.id]) return; // already downloading
  const dl = game.download;
  if (!dl || !dl.url) { alert('This game has no download configured yet.'); return; }
  installingGames[game.id] = true;
  api.onInstallProgress(d => {
    if (!d || d.gameId !== game.id) return;
    const pct = d.total ? Math.floor((d.received / d.total) * 100) : 0;
    setInstallProgressUI(game.id, pct);
  });
  setInstallProgressUI(game.id, 0);
  let res;
  try { res = await api.installGame(game.id, game.fileName, dl); }
  catch (e) { res = { ok: false, error: String(e) }; }
  installingGames[game.id] = false;
  if (res && res.ok) {
    installedExternal[game.id] = true;
    SFX.success();
    syncPlayBtnState(game.id);
    launchGame(game.id); // now installed → launches normally
  } else {
    syncPlayBtnState(game.id);
    alert('Install failed: ' + ((res && res.error) || 'unknown error') + '\n\nCheck your internet connection and try again.');
  }
}

// ── Info modal ────────────────────────────────────────────────
let editModeActive = false;

// Enter "Edit Game" mode: reveal tag/description/delete editors, swap the
// Edit Game button for Save/Discard, and lock the Customize Cover button.
function enterEditMode(game) {
  editModeActive = true;
  // Title editor starts hidden; "Edit Title" button reveals it.
  document.getElementById('modal-title-editor').value = game.title || '';
  document.getElementById('modal-title-editor').style.display = 'none';
  document.getElementById('modal-title').style.display = '';
  document.getElementById('modal-edit-title-btn').style.display = '';
  // Pre-fill the description editor (kept hidden until "Edit Description" is clicked).
  document.getElementById('modal-desc-editor').value = game.description || '';
  document.getElementById('modal-desc-editor').style.display = 'none';
  document.getElementById('modal-desc').style.display = '';
  document.getElementById('modal-edit-desc-btn').style.display = '';
  // Tag editor starts collapsed; the "Edit Tags" button reveals it.
  document.getElementById('modal-tag-editor').style.display = 'none';
  document.getElementById('modal-tags').style.display = '';
  document.getElementById('modal-edit-tags-btn').style.display = '';
  document.getElementById('modal-delete-btn').style.display = '';
  document.getElementById('modal-editgame-btn').style.display = 'none';
  document.getElementById('modal-save-btn').style.display = '';
  document.getElementById('modal-discard-btn').style.display = '';
  // Lock the cover, play, and favorite buttons.
  document.getElementById('modal-edit-btn').classList.add('disabled');
  document.getElementById('modal-cover-btn-wrap').classList.add('cover-locked');
  document.getElementById('modal-play-btn').classList.add('disabled');
  document.getElementById('modal-play-btn-wrap').classList.add('cover-locked');
  document.getElementById('modal-fav-btn').classList.add('disabled');
  document.getElementById('modal-fav-btn-wrap').classList.add('cover-locked');
}

// Return the info modal to its read-only "view" state.
function exitEditMode() {
  editModeActive = false;
  document.getElementById('modal-title').style.display = '';
  document.getElementById('modal-title-editor').style.display = 'none';
  document.getElementById('modal-edit-title-btn').style.display = 'none';
  document.getElementById('modal-desc').style.display = '';
  document.getElementById('modal-desc-editor').style.display = 'none';
  document.getElementById('modal-edit-desc-btn').style.display = 'none';
  document.getElementById('modal-tags').style.display = '';
  document.getElementById('modal-tag-editor').style.display = 'none';
  document.getElementById('modal-edit-tags-btn').style.display = 'none';
  document.getElementById('modal-delete-btn').style.display = 'none';
  document.getElementById('modal-save-btn').style.display = 'none';
  document.getElementById('modal-discard-btn').style.display = 'none';
  // editgame-btn visibility is set by openInfoModal (imported games only).
  const game = allGames.find(g => g.id === currentGameId);
  document.getElementById('modal-editgame-btn').style.display = (game && game.party === 'imported') ? '' : 'none';
  document.getElementById('modal-edit-btn').classList.remove('disabled');
  document.getElementById('modal-cover-btn-wrap').classList.remove('cover-locked');
  document.getElementById('modal-play-btn').classList.remove('disabled');
  document.getElementById('modal-play-btn-wrap').classList.remove('cover-locked');
  document.getElementById('modal-fav-btn').classList.remove('disabled');
  document.getElementById('modal-fav-btn-wrap').classList.remove('cover-locked');
}

function openInfoModal(id) {
  currentGameId = id;
  const game = allGames.find(g => g.id === id);
  if (!game) return;
  clearGameBadge(id);   // opening the card counts as seeing it

  document.getElementById('modal-title').textContent = game.title;
  document.getElementById('modal-desc').textContent = game.description || '';

  const partyEl = document.getElementById('modal-party');
  const thirdLabel = game.developer ? `◇ Made by ${game.developer}` : '◇ Non-Pickle Game';
  const partyMap = { first: ['◆ Pickle Original', 'party-first'], third: [thirdLabel, 'party-third'], imported: ['📥 Imported', 'party-imported'] };
  const [partyLabel, partyCls] = partyMap[game.party] || [thirdLabel, 'party-third'];
  partyEl.textContent = partyLabel;
  partyEl.className = 'party-badge ' + partyCls;

  document.getElementById('modal-tags').innerHTML = tagDisplayHTML(game.tags || []);
  // Reset to non-edit ("view") state on every open. Edit controls are gated by the
  // "Edit Game" button and are only available for imported games.
  exitEditMode();
  const showEditGame = game.party === 'imported';
  document.getElementById('modal-editgame-btn').style.display = showEditGame ? '' : 'none';
  // Edit Game group carries the right-anchor margin when present; otherwise the
  // Customize Cover button anchors right on its own (normal games).
  document.querySelector('.modal-actions').classList.toggle('editgame-shown', showEditGame);

  const coverWrap = document.getElementById('modal-cover-wrap');
  const _cv = coverVersions[id] || game.coverVersion;
  coverWrap.innerHTML = `<img src="${coverSrc(id + '.svg')}${_cv ? '?v='+_cv : ''}" alt="${game.title}" onerror="if(this.src.indexOf('.svg')>-1){this.src='${coverSrc(id + '.png')}'}else{this.style.display='none'}">`;

  refreshInfoModal(id);

  // Achievements is the default tab. Imported games have no achievements —
  // hide that tab and fall back to Stats.
  const achTab = document.querySelector('.modal-tab[data-tab="achievements"]');
  const hideAch = game.party === 'imported';
  if (achTab) achTab.style.display = hideAch ? 'none' : '';
  // Leaderboard tab only for games that declare one in games.json.
  const lbTab = document.querySelector('.modal-tab[data-tab="leaderboard"]');
  if (lbTab) lbTab.style.display = game.leaderboard ? '' : 'none';
  const defaultTab = hideAch ? 'stats' : 'achievements';
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === defaultTab));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + defaultTab));
  document.querySelector('.modal-body').dataset.tab = defaultTab;

  const _mpb = document.getElementById('modal-play-btn');
  _mpb.style.display = '';
  _mpb.textContent = (game.external && !installedExternal[id])
    ? `⬇ Install (${game.installSizeMB || '?'} MB)` : '▶ Play';
  document.getElementById('modal-edit-btn').style.display = '';
  updateFavBtn(id);
  SFX.open();
  document.getElementById('info-modal').classList.add('open');
}

function refreshInfoModal(id) {
  const game = allGames.find(g => g.id === id);
  if (!game) return;
  renderStats(game);
  renderAchievements(game);
  if (game.leaderboard) renderLeaderboard(game);
}

function closeInfoModal() {
  document.getElementById('info-modal').classList.remove('open');
  currentGameId = null;
}

function updateFavBtn(gameId) {
  const btn = document.getElementById('modal-fav-btn');
  const fav = isFavorite(gameId);
  btn.textContent = fav ? '★ Favorited' : '☆ Favorite';
  btn.classList.toggle('modal-fav-btn-active', fav);
}

// ── Stats & Achievements ──────────────────────────────────────
// "Is this stat a personal best?" — every seconds-format stat is a time, and the rest
// are recognised by the naming every game already uses (best_/fastest_/top_/longest_…).
// Only these get a dash instead of a meaningless zero.
function statIsBest(def) {
  return def.format === 'seconds'
    || /^(best|fastest|longest|highest|top|max|most|biggest|record)_/.test(def.key || '')
    || /\b(best|fastest|longest|largest|biggest|highest|deepest|record)\b/i.test(def.label || '');
}

function renderStats(game) {
  const statsData = readStats(game.id);
  let extra = {};
  if (game.id === 'mountain_goat_climber_v2') {
    try { extra = JSON.parse(localStorage.getItem('mgc_save5') || '{}'); } catch {}
  }

  const el = document.getElementById('tab-stats');
  const defs = game.stats || [];
  const rows = defs.map(def => {
    let val = statsData[def.key];
    if (val === undefined && extra[def.key] !== undefined) val = extra[def.key];
    if (val === undefined && game.id === 'mountain_goat_climber_v2') {
      if (def.key === 'best_score') val = extra.highScore;
      if (def.key === 'coins_total') val = extra.coins;
      if (def.key === 'items_owned') val = (extra.owned || []).length;
    }
    const missing = (val === undefined || val === null);
    if (missing) val = 0;
    let display;
    // A personal best that was never set reads as "0s" / "0", which looks like a real
    // result you scored. Times and bests show a dash until there's something to show;
    // plain counters keep their honest zero.
    if (statIsBest(def) && (missing || Number(val) === 0)) display = '—';
    else if (def.format === 'seconds') display = val + 's';
    else if (def.format === 'fraction') {
      const count = Array.isArray(val) ? val.length : (parseInt(val) || 0);
      display = `${count} / ${def.total || '?'}`;
    }
    else display = String(val);
    return `<tr><td>${def.label}</td><td>${display}</td></tr>`;
  }).filter(Boolean);

  const playtimeSec = parseInt(localStorage.getItem(`gl_${game.id}_playtime`) || '0', 10);
  const playtimeStr = formatPlaytime(playtimeSec);
  const playtimeRow = playtimeStr ? `<tr><td>Playtime</td><td>${playtimeStr}</td></tr>` : '';

  el.innerHTML = (playtimeRow || rows.length)
    ? `<table class="stats-table"><tbody>${playtimeRow}${rows.join('')}</tbody></table>`
    : '<div class="no-data">Play the game to start tracking stats!</div>';
}

function renderAchievements(game) {
  const unlocked = readAchievements(game.id);
  const el = document.getElementById('tab-achievements');
  const defs = game.achievements || [];
  if (!defs.length) { el.innerHTML = '<div class="no-data">No achievements defined yet.</div>'; return; }
  el.innerHTML = '<div class="ach-grid">' + defs.map(a => {
    const u = unlocked[a.id];
    const cls = u ? 'unlocked' : 'ach-locked';
    const date = u ? `<div class="ach-date">Unlocked ${new Date(u.unlockedAt).toLocaleDateString()}</div>` : '';
    return `<div class="ach-card ${cls}">
      <div class="ach-icon">${a.icon || '🏆'}</div>
      <div><div class="ach-label">${a.label}</div><div class="ach-desc">${a.desc}</div>${date}</div>
    </div>`;
  }).join('') + '</div>';
}

// ── Leaderboard tab ───────────────────────────────────────────
// Global top 10 + your own entry, fetched live through leaderboard-sdk.js.
// Games opt in with a `leaderboard` block in games.json:
//   { label, unit, metaLabel, metaKey, localStatKey }
// A game with several boards (Sandfall: one per mode) adds a `modes` array:
//   { label, unit, modes: [ { id, label, boardId, localStatKey, ... } ] }
// Each mode inherits the outer block's label/unit/meta fields unless it sets
// its own, posts to `boardId` (default `<gameId>__<id>`) and renders as one
// column of the tab. Without `modes` the block is a single board keyed on the
// game id — Vectordrome's shape, unchanged.
// The dev-only "show all entries" button is gated on getAppInfo().isDev,
// which is only ever true when the launcher runs from source.
let _lbAppInfo = null;
let _lbSeq = 0;
async function lbAppInfo() {
  if (_lbAppInfo) return _lbAppInfo;
  try {
    _lbAppInfo = (window.electronAPI && window.electronAPI.getAppInfo)
      ? (await window.electronAPI.getAppInfo()) || {} : {};
  } catch { _lbAppInfo = {}; }
  return _lbAppInfo;
}
function lbEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Time boards (Coldmere, Minefield): the fastest time wins, but the store only
// knows "higher is better", so the game posts (timeBase − seconds) and every
// display path here converts back. cfg: { scoreType:'time', timeBase: <seconds> }.
function lbIsTime(cfg) { return !!cfg && cfg.scoreType === 'time'; }
function lbFmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p2 = n => String(n).padStart(2, '0');
  return h ? `${h}:${p2(m)}:${p2(r)}` : `${m}:${p2(r)}`;
}
// A raw local stat (a time, for time boards) → the score the board would hold.
function lbLocalScore(localBest, cfg) {
  const v = Number(localBest) || 0;
  if (!lbIsTime(cfg)) return v;
  return v > 0 ? Math.max(0, (Number(cfg.timeBase) || 0) - v) : 0;
}
function lbLocalStr(localBest, cfg) {
  if (lbIsTime(cfg)) return lbEsc(lbFmtDur(localBest));
  return (Number(localBest) || 0).toLocaleString() + (cfg.unit ? ' ' + lbEsc(cfg.unit) : '');
}
function lbScore(v, cfg) {
  if (lbIsTime(cfg)) return lbEsc(lbFmtDur((Number(cfg.timeBase) || 0) - (Number(v) || 0)));
  return (Number(v) || 0).toLocaleString() + (cfg.unit ? '<span class="lb-unit">' + lbEsc(cfg.unit) + '</span>' : '');
}
function lbMeta(e, cfg) {
  if (!cfg.metaKey || !e.meta || e.meta[cfg.metaKey] == null) return '';
  return '<span class="lb-meta">' + lbEsc(cfg.metaLabel || cfg.metaKey) + ' ' + lbEsc(e.meta[cfg.metaKey]) + '</span>';
}
function lbRow(i, e, cfg, extra) {
  const rank = i + 1;
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : String(rank);
  if (!e) {
    return `<tr class="lb-empty"><td class="lb-rank">${medal}</td><td class="lb-who"><span class="lb-name">—</span></td><td class="lb-score">—</td>${extra ? '<td></td>' : ''}</tr>`;
  }
  const cls = ['lb-r' + Math.min(rank, 4), e.isMe ? 'lb-me' : ''].join(' ');
  const devCols = extra
    ? `<td class="lb-dev-col"><div>${lbEsc(e.playerId || '—')}</div><div>${lbEsc(e.uid)} · ${lbEsc(e.client || 'app')} · ${e.updatedAt ? new Date(e.updatedAt).toLocaleString() : ''}</div></td>`
    : '';
  return `<tr class="${cls}">
    <td class="lb-rank">${medal}</td>
    <td class="lb-who"><span class="lb-emblem">${lbEsc(e.emblem)}</span><span class="lb-name">${lbEsc(e.name)}</span>${e.isMe ? '<span class="lb-you">you</span>' : ''}</td>
    <td class="lb-score">${lbScore(e.score, cfg)}${lbMeta(e, cfg)}</td>${devCols}
  </tr>`;
}
function lbTable(entries, cfg, slots, extra) {
  const n = slots ? Math.max(slots, entries.length) : entries.length;
  let rows = '';
  for (let i = 0; i < n; i++) rows += lbRow(i, entries[i] || null, cfg, extra);
  return `<table class="lb-table${extra ? ' lb-table-dev' : ''}"><thead><tr><th>#</th><th>Player</th><th>${lbEsc(cfg.label || 'Score')}</th>${extra ? '<th>Player ID · UID · client · posted</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`;
}
// "Your entry" card under a board. `data` is the SDK's { top, me, rank, total }.
function lbMeCard(data, cfg, localBest) {
  const me = data.me;
  const localScore = lbLocalScore(localBest, cfg);
  if (me) {
    return `<div class="lb-mecard">
        <div class="lb-mecard-rank">${data.rank ? '#' + data.rank : '—'}</div>
        <div class="lb-mecard-body">
          <div class="lb-mecard-name"><span class="lb-emblem">${lbEsc(me.emblem)}</span>${lbEsc(me.name)}<span class="lb-you">you</span></div>
          <div class="lb-mecard-sub">${data.rank ? 'Ranked #' + data.rank : 'Your best'}${lbMeta(me, cfg) ? ' · ' + lbMeta(me, cfg) : ''}</div>
        </div>
        <div class="lb-mecard-score">${lbScore(me.score, cfg)}</div>
      </div>` +
      (localScore > me.score
        ? `<div class="lb-note">Your local best (${lbLocalStr(localBest, cfg)}) hasn't been posted yet — it syncs next time you open the game.</div>`
        : '');
  }
  return `<div class="lb-mecard lb-mecard-none">
      <div class="lb-mecard-rank">—</div>
      <div class="lb-mecard-body">
        <div class="lb-mecard-name">No score posted yet</div>
        <div class="lb-mecard-sub">${localScore > 0
          ? 'Your local best (' + lbLocalStr(localBest, cfg) + ') posts next time you open the game.'
          : 'Finish a run to claim a spot on the board.'}</div>
      </div>
    </div>`;
}
// The per-mode config: the outer block's fields with the mode's on top.
function lbModeCfgs(game, cfg) {
  return (cfg.modes || []).map(m => Object.assign({}, cfg, m, {
    modes: undefined,
    boardId: m.boardId || (game.id + '__' + m.id),
  }));
}

// Multi-board tab: one column per mode, each with its top 10 and your entry.
async function renderLeaderboardModes(game, cfg, seq) {
  const el = document.getElementById('tab-leaderboard');
  const modes = lbModeCfgs(game, cfg);
  const head = (total) => `<div class="lb-head">
      <div><div class="lb-title">🌐 Global Top 10 · ${modes.length} modes</div><div class="lb-sub">${lbEsc(cfg.label || 'Score')}</div></div>
      <button class="lb-refresh" title="Refresh">↻</button>
    </div>`;
  const wire = () => {
    const r = el.querySelector('.lb-refresh');
    if (r) r.addEventListener('click', () => renderLeaderboard(game));
  };

  el.innerHTML = `<div class="lb-wrap lb-multi">${head(null)}<div class="lb-loading">Fetching scores…</div></div>`;
  wire();
  if (!window.LeaderboardSDK) {
    el.innerHTML = `<div class="lb-wrap lb-multi">${head(null)}<div class="no-data">Leaderboards aren't available in this build.</div></div>`;
    return;
  }

  const results = await Promise.all(modes.map(m =>
    window.LeaderboardSDK.board(m.boardId, { limit: 10 }).then(d => ({ d }), err => ({ err }))));
  if (seq !== _lbSeq) return;
  if (!results.some(r => r.d)) {
    el.innerHTML = `<div class="lb-wrap lb-multi">${head(null)}<div class="lb-offline">Couldn't reach the leaderboard.<br><span>Check your connection, then hit ↻ to retry.</span></div></div>`;
    wire();
    return;
  }
  const info = await lbAppInfo();
  if (seq !== _lbSeq) return;

  const stats = readStats(game.id) || {};
  let total = 0, anyTotal = false;
  const cols = modes.map((m, i) => {
    const r = results[i];
    let body;
    if (r.d) {
      if (r.d.total != null) { total += r.d.total; anyTotal = true; }
      const localBest = Number(stats[m.localStatKey]) || 0;
      body = lbTable(r.d.top, m, 10, false) + `<div class="lb-mehead">Your entry</div>` + lbMeCard(r.d, m, localBest);
    } else {
      body = `<div class="lb-offline">Couldn't reach this board.</div>`;
    }
    // player totals are deliberately not shown here — only the dev panel lists counts
    return `<div class="lb-col"><div class="lb-col-head"><span class="lb-col-name">${lbEsc(m.label || m.id)}</span></div>${body}</div>`;
  }).join('');

  const devBtn = info.isDev
    ? `<div class="lb-dev-row"><button class="lb-dev-btn">🛠 Dev: show every entry</button><span class="lb-dev-hint">dev machine only · all modes</span></div>`
    : '';
  el.innerHTML = `<div class="lb-wrap lb-multi">${head(anyTotal ? total : null)}<div class="lb-modes">${cols}</div>${devBtn}</div>`;
  wire();

  const dev = el.querySelector('.lb-dev-btn');
  if (dev) {
    dev.addEventListener('click', async () => {
      dev.disabled = true;
      dev.textContent = 'Loading…';
      const all = await Promise.all(modes.map(m =>
        window.LeaderboardSDK.all(m.boardId).then(rows => ({ rows }), err => ({ err }))));
      if (seq !== _lbSeq) return;
      if (all.every(a => a.err)) { dev.disabled = false; dev.textContent = '🛠 Failed — retry'; return; }
      const wrap = el.querySelector('.lb-wrap');
      const panel = document.createElement('div');
      panel.className = 'lb-devpanel';
      panel.innerHTML = modes.map((m, i) => {
        const a = all[i];
        const body = a.err ? '<div class="lb-offline">Couldn\'t reach this board.</div>'
          : (a.rows.length ? lbTable(a.rows, m, 0, true) : '<div class="no-data">Nothing posted yet.</div>');
        return `<div class="lb-mehead">${lbEsc(m.label || m.id)} · all entries · ${a.err ? '?' : a.rows.length} · <code>${lbEsc(m.boardId)}</code></div>${body}`;
      }).join('');
      const old = wrap.querySelector('.lb-devpanel');
      if (old) old.remove();
      wrap.appendChild(panel);
      dev.disabled = false;
      dev.textContent = '🛠 Dev: reload every entry';
    });
  }
}

async function renderLeaderboard(game) {
  const el = document.getElementById('tab-leaderboard');
  const cfg = game.leaderboard;
  if (!el || !cfg) return;
  const seq = ++_lbSeq;
  if (Array.isArray(cfg.modes) && cfg.modes.length) return renderLeaderboardModes(game, cfg, seq);
  const head = (total) => `<div class="lb-head">
      <div><div class="lb-title">🌐 Global Top 10</div><div class="lb-sub">${lbEsc(cfg.label || 'Score')}</div></div>
      <button class="lb-refresh" title="Refresh">↻</button>
    </div>`;
  const wire = () => {
    const r = el.querySelector('.lb-refresh');
    if (r) r.addEventListener('click', () => renderLeaderboard(game));
  };

  el.innerHTML = `<div class="lb-wrap">${head(null)}<div class="lb-loading">Fetching scores…</div></div>`;
  wire();
  if (!window.LeaderboardSDK) {
    el.innerHTML = `<div class="lb-wrap">${head(null)}<div class="no-data">Leaderboards aren't available in this build.</div></div>`;
    return;
  }

  let data;
  try {
    data = await window.LeaderboardSDK.board(game.id, { limit: 10 });
  } catch (e) {
    if (seq !== _lbSeq) return;
    el.innerHTML = `<div class="lb-wrap">${head(null)}<div class="lb-offline">Couldn't reach the leaderboard.<br><span>Check your connection, then hit ↻ to retry.</span></div></div>`;
    wire();
    return;
  }
  if (seq !== _lbSeq) return;
  const info = await lbAppInfo();
  if (seq !== _lbSeq) return;

  const localBest = Number((readStats(game.id) || {})[cfg.localStatKey]) || 0;
  const meHtml = lbMeCard(data, cfg, localBest);

  const devBtn = info.isDev
    ? `<div class="lb-dev-row"><button class="lb-dev-btn">🛠 Dev: show every entry</button><span class="lb-dev-hint">dev machine only</span></div>`
    : '';

  el.innerHTML = `<div class="lb-wrap">${head(data.total)}${lbTable(data.top, cfg, 10, false)}<div class="lb-mehead">Your entry</div>${meHtml}${devBtn}</div>`;
  wire();

  const dev = el.querySelector('.lb-dev-btn');
  if (dev) {
    dev.addEventListener('click', async () => {
      dev.disabled = true;
      dev.textContent = 'Loading…';
      let allRows;
      try { allRows = await window.LeaderboardSDK.all(game.id); }
      catch (e) { dev.disabled = false; dev.textContent = '🛠 Failed — retry'; return; }
      if (seq !== _lbSeq) return;
      const wrap = el.querySelector('.lb-wrap');
      const panel = document.createElement('div');
      panel.className = 'lb-devpanel';
      panel.innerHTML = `<div class="lb-mehead">All entries · ${allRows.length}</div>` +
        (allRows.length ? lbTable(allRows, cfg, 0, true) : '<div class="no-data">Nothing posted yet.</div>');
      const old = wrap.querySelector('.lb-devpanel');
      if (old) old.remove();
      wrap.appendChild(panel);
      dev.disabled = false;
      dev.textContent = '🛠 Dev: reload every entry';
    });
  }
}

// ── localStorage helpers ──────────────────────────────────────
function readStats(gameId) {
  try { return JSON.parse(localStorage.getItem(`gl_${gameId}_stats`) || '{}'); } catch { return {}; }
}
function readAchievements(gameId) {
  if (!_achCache) {
    // Build cache on first call: parse every game's achievements key in one pass
    _achCache = {};
    allGames.forEach(g => {
      try { _achCache[g.id] = JSON.parse(localStorage.getItem(`gl_${g.id}_achievements`) || '{}'); }
      catch { _achCache[g.id] = {}; }
    });
  }
  return _achCache[gameId] || {};
}
function invalidateAchCache() { _achCache = null; }
function readFavorites() {
  try { return JSON.parse(localStorage.getItem('gl_favorites') || '[]'); } catch { return []; }
}
function isFavorite(gameId) {
  return readFavorites().includes(gameId);
}
function favPopAnimation(btn) {
  // Button bounce
  btn.classList.remove('fav-popping');
  void btn.offsetWidth; // reflow to restart animation
  btn.classList.add('fav-popping');
  btn.addEventListener('animationend', () => btn.classList.remove('fav-popping'), { once: true });

  // Star particles bursting out from the button
  const rect = btn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const STARS = ['⭐', '✨', '💛', '⭐', '✨', '🌟'];
  STARS.forEach((icon, i) => {
    const el = document.createElement('span');
    el.className = 'fav-particle';
    el.textContent = icon;
    const angle = (i / STARS.length) * Math.PI * 2 - Math.PI / 2;
    const dist = 38 + Math.random() * 24;
    const tx = Math.round(Math.cos(angle) * dist);
    const ty = Math.round(Math.sin(angle) * dist);
    const dur = (0.42 + Math.random() * 0.18).toFixed(2) + 's';
    el.style.cssText = `left:${cx}px;top:${cy}px;--tx:${tx}px;--ty:${ty}px;--dur:${dur};margin-left:-0.55em;margin-top:-0.55em;`;
    document.body.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
  });
}

function playFavSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Bright ascending sparkle: C5 → E5 → G5 in quick succession
    [[523.25, 0], [659.25, 0.09], [783.99, 0.17]].forEach(([freq, delay]) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + delay;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.22, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  } catch { /* AudioContext unavailable */ }
}

function toggleFavorite(gameId) {
  let favs = readFavorites();
  if (favs.includes(gameId)) {
    favs = favs.filter(id => id !== gameId);
  } else {
    favs.push(gameId);
  }
  persistKey('gl_favorites', JSON.stringify(favs));
  return favs.includes(gameId);
}
function formatPlaytime(seconds) {
  if (!seconds || seconds < 60) return seconds > 0 ? `${seconds}s` : null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Global Achievements ───────────────────────────────────────
const GLOBAL_ACHIEVEMENTS = [
  {
    id: 'global_first_game',
    label: 'First Launch',
    desc: 'Play your first game',
    icon: '🎮',
    check: () => allGames.some(g => parseInt(localStorage.getItem(`gl_${g.id}_playtime`) || '0') > 0),
  },
  {
    id: 'global_one_hour',
    label: 'Dedicated Player',
    desc: 'Play games for 1 hour total',
    icon: '⏱️',
    check: () => allGames.reduce((s, g) => s + parseInt(localStorage.getItem(`gl_${g.id}_playtime`) || '0'), 0) >= 3600,
  },
  {
    id: 'global_ten_achievements',
    label: 'Achievement Hunter',
    desc: 'Earn 10 total achievements',
    icon: '🏅',
    check: () => allGames.reduce((s, g) => s + Object.keys(readAchievements(g.id)).length, 0) >= 10,
  },
  {
    id: 'global_completionist',
    label: 'Completionist',
    desc: 'Complete all achievements for a game',
    icon: '⭐',
    check: () => allGames.some(g => (g.achievements||[]).length > 0 && isAllAchievementsUnlocked(g)),
  },
  {
    id: 'global_ten_games',
    label: 'World Tour',
    desc: 'Play 10 different games',
    icon: '🌍',
    check: () => allGames.filter(g => parseInt(localStorage.getItem(`gl_${g.id}_playtime`) || '0') > 0).length >= 10,
  },
  {
    id: 'global_first_import',
    label: 'Curator',
    desc: 'Import your first game into the library',
    icon: '📥',
    check: () => allGames.some(g => g.party === 'imported'),
  },
  {
    id: 'online_first_match',
    label: 'Online Victory',
    desc: 'Win your first online multiplayer match',
    icon: '🌐',
    check: () => {
      // Candidates come from the "Online" tag, not a hardcoded id list — that
      // list froze at six games and never picked up any online game shipped
      // after it. Only these two stat keys count: both unambiguously mean an
      // ONLINE win. Keys like `wins` / `total_wins` / `duel_wins` are excluded
      // on purpose — those games also count bot and local-couch wins, which
      // would unlock this without anyone ever going online.
      const ONLINE_WIN_KEYS = ['online_wins', 'mp_wins'];
      return allGames
        .filter(g => (g.tags || []).includes('Online'))
        .some(g => {
          const stats = readStats(g.id);
          return ONLINE_WIN_KEYS.some(k => (parseInt(stats[k], 10) || 0) > 0);
        });
    },
  },
];

function readGlobalAchievements() {
  try { return JSON.parse(localStorage.getItem('global_achievements') || '{}'); } catch { return {}; }
}

function checkAndSaveGlobalAchievements() {
  const stored = readGlobalAchievements();
  let changed = false;
  for (const a of GLOBAL_ACHIEVEMENTS) {
    if (!stored[a.id] && a.check()) {
      stored[a.id] = { unlockedAt: Date.now() };
      changed = true;
    }
  }
  if (changed) persistKey('global_achievements', JSON.stringify(stored));
  return stored;
}

function buildGameAchSections(sortOrder) {
  // Build sorted list of games that have achievements
  let games = allGames.filter(g => (g.achievements || []).length > 0);
  if (sortOrder === 'alpha') {
    games = games.slice().sort((a, b) => a.title.localeCompare(b.title));
  } else if (sortOrder === 'recent') {
    const recent = JSON.parse(localStorage.getItem('gl_recently_played') || '[]');
    games = games.slice().sort((a, b) => {
      const ai = recent.indexOf(a.id), bi = recent.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  } else if (sortOrder === 'playtime') {
    games = games.slice().sort((a, b) =>
      parseInt(localStorage.getItem('gl_' + b.id + '_playtime') || '0') -
      parseInt(localStorage.getItem('gl_' + a.id + '_playtime') || '0')
    );
  } else if (sortOrder === 'progress') {
    games = games.slice().sort((a, b) => {
      const ua = readAchievements(a.id), ub = readAchievements(b.id);
      const pa = Object.keys(ua).length / (a.achievements.length || 1);
      const pb = Object.keys(ub).length / (b.achievements.length || 1);
      return pb - pa;
    });
  }
  return games.map(g => {
    const unlocked = readAchievements(g.id);
    const defs = g.achievements || [];
    const count = defs.filter(a => unlocked[a.id]).length;
    const cards = defs.map(a => {
      const u = unlocked[a.id];
      const cls = u ? 'unlocked' : 'ach-locked';
      const date = u ? '<div class="ach-date">Unlocked ' + new Date(u.unlockedAt).toLocaleDateString() + '</div>' : '';
      return '<div class="ach-card ' + cls + '"><div class="ach-icon">' + (a.icon||'🏆') + '</div><div><div class="ach-label">' + a.label + '</div><div class="ach-desc">' + a.desc + '</div>' + date + '</div></div>';
    }).join('');
    return '<div class="ach-section-label">' + g.title + ' — ' + count + '/' + defs.length + '</div><div class="ach-grid">' + cards + '</div>';
  }).join('');
}

function showGlobalAchievements() {
  const globalUnlocked = checkAndSaveGlobalAchievements();
  const globalCount = GLOBAL_ACHIEVEMENTS.filter(a => globalUnlocked[a.id]).length;

  const globalCards = GLOBAL_ACHIEVEMENTS.map(a => {
    const u = globalUnlocked[a.id];
    const cls = u ? 'unlocked' : 'ach-locked';
    const date = u ? '<div class="ach-date">Unlocked ' + new Date(u.unlockedAt).toLocaleDateString() + '</div>' : '';
    return '<div class="ach-card ' + cls + '"><div class="ach-icon">' + a.icon + '</div><div><div class="ach-label">' + a.label + '</div><div class="ach-desc">' + a.desc + '</div>' + date + '</div></div>';
  }).join('');

  const modalBox = document.querySelector('.modal-box');
  const modalTop = document.querySelector('.modal-top');
  const body = document.querySelector('.modal-body');

  modalTop.style.display = 'none';
  body.style.display = 'none';

  const panel = document.createElement('div');
  panel.id = 'global-ach-panel';
  panel.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;';

  let sortOrder = 'alpha';

  function renderPanel() {
    const gameSections = buildGameAchSections(sortOrder);
    panel.innerHTML =
      '<div class="global-ach-header"><span>🏆</span><h2>All Achievements</h2></div>' +
      '<div class="ach-sort-bar">' +
        '<span class="ach-sort-label">Sort:</span>' +
        '<button class="ach-sort-btn' + (sortOrder==='alpha'?' active':'') + '" data-sort="alpha">A–Z</button>' +
        '<button class="ach-sort-btn' + (sortOrder==='recent'?' active':'') + '" data-sort="recent">Recently Played</button>' +
        '<button class="ach-sort-btn' + (sortOrder==='playtime'?' active':'') + '" data-sort="playtime">Most Playtime</button>' +
        '<button class="ach-sort-btn' + (sortOrder==='progress'?' active':'') + '" data-sort="progress">Most Progress</button>' +
      '</div>' +
      '<div class="global-ach-body">' +
        '<div class="ach-section-label">🌐 Global — ' + globalCount + '/' + GLOBAL_ACHIEVEMENTS.length + '</div>' +
        '<div class="ach-grid">' + globalCards + '</div>' +
        gameSections +
      '</div>';
    panel.querySelectorAll('.ach-sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        sortOrder = btn.dataset.sort;
        renderPanel();
      });
    });
  }

  renderPanel();
  modalBox.appendChild(panel);

  document.getElementById('info-modal').classList.add('open');
  currentGameId = null;

  document.getElementById('info-close').onclick = () => {
    panel.remove();
    modalTop.style.display = '';
    body.style.display = '';
    body.innerHTML = '<div class="modal-tabs"><button class="modal-tab active" data-tab="achievements">🏆 Achievements</button><button class="modal-tab" data-tab="stats">📊 Stats</button><button class="modal-tab" data-tab="leaderboard" style="display:none">🏅 Leaderboard</button></div><div class="tab-pane active" id="tab-achievements"></div><div class="tab-pane" id="tab-stats"></div><div class="tab-pane" id="tab-leaderboard"></div>';
    body.dataset.tab = 'achievements';
    document.querySelectorAll('.modal-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
        body.dataset.tab = tab.dataset.tab;
      });
    });
    document.getElementById('info-modal').classList.remove('open');
    document.getElementById('info-close').onclick = closeInfoModal;
  };
}

// ── Cover Modal ───────────────────────────────────────────────
function switchCoverTab(mode) {
  coverTabMode = mode;

  // Designer tabs: 'design', 'image', or 'title'
  const isDesign = mode === 'design';
  const isImage  = mode === 'image';
  const isTitle  = mode === 'title';

  // Preview always shows the composite SVG (image tab included)
  document.getElementById('cover-preview-svg').style.display  = '';
  document.getElementById('cover-original-img').style.display = 'none';
  document.getElementById('cv-design-panel').style.display    = isDesign ? '' : 'none';
  document.getElementById('cv-image-panel').style.display     = isImage  ? '' : 'none';
  document.getElementById('cv-title-panel').style.display     = isTitle  ? '' : 'none';
  const cvOrigPanel = document.getElementById('cv-original-panel');
  if (cvOrigPanel) cvOrigPanel.style.display = 'none';
  document.getElementById('cover-save').style.display         = '';
  document.getElementById('cover-restore').style.display      = 'none';
  document.getElementById('cover-preview-label').textContent  = isImage ? 'Cover Preview' : 'Design Preview';
  document.querySelectorAll('[data-tab]').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === mode)
  );
  if (isDesign || isImage || isTitle) renderCoverPreview();
}


function syncTitleControls() {
  document.getElementById('cv-show-title').checked    = coverCfg.showTitle !== false;
  document.getElementById('cv-title-font').value      = coverCfg.titleFont || 'Arial Black';
  document.getElementById('cv-title-size').value      = coverCfg.titleSize || 0;
  document.getElementById('cv-title-size-label').textContent = coverCfg.titleSize > 0 ? coverCfg.titleSize : 'Auto';
  document.getElementById('cv-title-spacing').value   = coverCfg.titleLetterSpacing || 3;
  document.getElementById('cv-spacing-label').textContent   = coverCfg.titleLetterSpacing || 3;
  document.getElementById('cv-title-color').value       = coverCfg.titleColor     || '#FFD700';
  document.getElementById('cv-title-uppercase').checked = coverCfg.titleUppercase !== false;
  document.getElementById('cv-title-shadow').checked    = coverCfg.titleShadow    !== false;
  document.getElementById('cv-title-shade').checked     = coverCfg.titleShade     !== false;
  const optsEl = document.getElementById('cv-title-opts');
  if (optsEl) optsEl.style.opacity = coverCfg.showTitle !== false ? '1' : '0.4';
}
const COVER_CFG_DEFAULTS = {
  bg: '#329632', lineColor: '#000000', titleColor: '#FFD700', pattern: 'lines', icon: '🎮',
  showTitle: true, titleFont: 'Arial Black', titleSize: 0, titleUppercase: true,
  titleShadow: true, titleShade: true, titleLetterSpacing: 3, imageDataUrl: null,
};
const NATIVE_COVER_NAMES = { default: 'Default', classic: 'Classic', minimalist: 'Minimalist' };
// Display order for the built-in covers in the "Choose Cover" list: Default, then
// Minimalist, then everything else native (Classic, plus any future built-ins).
// Custom covers are appended after these — see buildCoverListEntries().
const NATIVE_COVER_ORDER = ['default', 'minimalist'].concat(
  Object.keys(NATIVE_COVER_NAMES).filter(k => k !== 'default' && k !== 'minimalist')
);

function openCoverModal(gameId) {
  coverGameId = gameId;
  // '__new__' sentinel: designing a cover for a game being imported (not yet in allGames).
  // This opens the designer directly (no list) — the cover is committed on import.
  if (gameId === '__new__') {
    designerReturnToList = false;
    document.getElementById('cv-list-ui').style.display = 'none';
    document.getElementById('cv-designer-actions').style.display = 'none';
    openDesigner(newGameCoverCfg, '🎨 Design Cover');
    SFX.open();
    document.getElementById('cover-modal').classList.add('open');
    return;
  }
  const game = allGames.find(g => g.id === gameId);
  if (!game) return;
  SFX.open();
  document.getElementById('cover-modal').classList.add('open');
  openCoverListView(game);
}

// Open the shared cover designer (used by the import flow and by "Add new").
// cfgSource: a coverConfig to seed from, or null for fresh defaults.
function openDesigner(cfgSource, titleText) {
  document.getElementById('cv-imported-ui').style.display = '';
  document.getElementById('cv-list-ui').style.display = 'none';
  document.getElementById('cover-modal-title').textContent = titleText;
  coverCfg = Object.assign({}, COVER_CFG_DEFAULTS, cfgSource || {});
  coverCfg.imageDataUrl = (cfgSource && cfgSource.imageDataUrl) || null;
  document.getElementById('cv-bg').value    = coverCfg.bg;
  document.getElementById('cv-line').value  = coverCfg.lineColor;
  document.getElementById('cv-title').value = coverCfg.titleColor;
  document.getElementById('cv-icon-display').textContent = coverCfg.icon;
  document.querySelectorAll('#cv-patterns .pattern-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.pattern === coverCfg.pattern)
  );
  emojiPanelOpen = false;
  document.getElementById('cv-image-preview').style.display = 'none';
  document.getElementById('cv-image-placeholder').style.display = '';
  document.getElementById('cv-image-change-btn').style.display = 'none';
  document.getElementById('emoji-panel').style.display = 'none';
  syncTitleControls();
  switchCoverTab('design');
  renderCoverPreview();
}

// Show the vertical list of available covers for a game.
async function openCoverListView(game) {
  document.getElementById('cv-imported-ui').style.display = 'none';
  document.getElementById('cv-list-ui').style.display = '';
  document.getElementById('cv-designer-actions').style.display = 'none';
  document.getElementById('cover-modal-title').textContent = '🎨 Choose Cover';
  designerReturnToList = false;
  // Left pane: show the selected-cover image, hide the live design preview & its buttons
  document.getElementById('cover-preview-svg').style.display  = 'none';
  document.getElementById('cover-original-img').style.display = '';
  document.getElementById('cover-save').style.display    = 'none';
  document.getElementById('cover-restore').style.display = 'none';

  await buildCoverListEntries(game);
  const active = game.activeCoverType;
  coverListSelected = coverListEntries.some(e => e.id === active)
    ? active
    : (coverListEntries[0] && coverListEntries[0].id) || null;
  renderCoverList(game);
  if (coverListSelected) selectCoverListItem(coverListSelected, game);
}

// Imported games have no Default/Minimalist — migrate their existing cover to "Custom Cover 1".
async function ensureCustomCoversMigrated(game) {
  if (game.party !== 'imported') return;
  if (game.customCovers && game.customCovers.length) return;
  const cfg = Object.assign({}, COVER_CFG_DEFAULTS, game.coverConfig || {});
  const svg = generateCoverSVG(game, cfg);
  await api.saveCoverVariant(game.id, 'custom1', svg);
  const cfgToSave = Object.assign({}, cfg);
  delete cfgToSave.imageDataUrl;
  game.customCovers = [{ id: 'custom1', name: 'Custom Cover 1', config: cfgToSave }];
  if (!game.activeCoverType || game.activeCoverType === 'default') game.activeCoverType = 'custom1';
  await api.saveGames(allGames);
}

async function buildCoverListEntries(game) {
  await ensureCustomCoversMigrated(game);
  let variantFiles = [];
  try { variantFiles = await api.listCoverVariants(game.id) || []; } catch { variantFiles = []; }
  const entries = [];
  // Built-in native variants first, in NATIVE_COVER_ORDER
  NATIVE_COVER_ORDER.forEach(k => {
    if (variantFiles.includes(k)) entries.push({ id: k, name: NATIVE_COVER_NAMES[k], builtin: true });
  });
  // Custom covers (from metadata, only those whose files exist on disk)
  (game.customCovers || []).forEach(cc => {
    if (NATIVE_COVER_NAMES[cc.id]) return; // native variant already listed above (e.g. a stale "classic" metadata entry)
    if (variantFiles.includes(cc.id)) entries.push({ id: cc.id, name: cc.name, builtin: false });
  });
  // Self-heal: recover custom cover FILES that exist on disk but are missing from
  // metadata (e.g. saved by an older build that didn't persist customCovers for
  // bundled games). Re-register them so they reappear and persist on next save.
  const known = new Set(entries.map(e => e.id));
  let recovered = false;
  variantFiles.filter(v => /^custom\d+$/.test(v) && !known.has(v)).forEach(v => {
    const name = 'Custom Cover ' + v.replace('custom', '');
    entries.push({ id: v, name, builtin: false });
    game.customCovers = (game.customCovers || []).concat([{ id: v, name, config: {} }]);
    recovered = true;
  });
  if (recovered) { try { await api.saveGames(allGames); } catch {} }
  coverListEntries = entries;
}

function renderCoverList(game) {
  const list = document.getElementById('cv-cover-list');
  if (!list) return;
  const canDelete = coverListEntries.length > 1; // never delete the only remaining cover
  list.innerHTML = coverListEntries.map(e => {
    const sel = e.id === coverListSelected ? ' selected' : '';
    const isActiveCover = e.id === game.activeCoverType;
    const activeMark = isActiveCover ? '<span class="cv-list-active" title="Currently active">✓</span>' : '';
    // The equipped cover can't be deleted — show a greyed-out button with an explanatory tooltip.
    const del = (!e.builtin && canDelete)
      ? (isActiveCover
          ? `<button class="cv-list-del disabled" data-del="${e.id}" title="You can't delete your currently equipped cover">🗑️</button>`
          : `<button class="cv-list-del" data-del="${e.id}" title="Delete cover">🗑️</button>`)
      : '';
    return `<div class="cv-list-row${sel}" data-variant="${e.id}">`
      + `<span class="cv-list-name">${e.name}</span>`
      + `<span class="cv-list-right">${activeMark}${del}</span>`
      + `</div>`;
  }).join('');
}

function selectCoverListItem(variantId, game) {
  coverListSelected = variantId;
  document.querySelectorAll('#cv-cover-list .cv-list-row').forEach(r =>
    r.classList.toggle('selected', r.dataset.variant === variantId)
  );
  const v = Date.now();
  const entry = coverListEntries.find(e => e.id === variantId);
  document.getElementById('cover-original-img').innerHTML =
    `<img src="${coverSrc(game.id + '.' + variantId + '.svg')}?v=${v}" alt="${entry ? entry.name : ''}" onerror="this.src='${coverSrc(game.id + '.svg')}?v=${v}'">`;
  document.getElementById('cover-preview-label').textContent = entry ? entry.name : 'Cover';
}

// "Choose Cover" — commit the highlighted variant as the active cover and close.
async function confirmCoverChoice() {
  if (!coverGameId || !coverListSelected) return;
  const game = allGames.find(g => g.id === coverGameId);
  if (!game) return;
  const r = await api.selectNativeCover(coverGameId, coverListSelected); // copies variant → active .svg
  game.activeCoverType = coverListSelected;
  if (typeof r === 'number') coverVersions[coverGameId] = r; // 'unchanged' = already showing this art; keep the cached URL
  await api.saveGames(allGames);
  renderGrid();
  renderRecentlyPlayed();
  renderFavorites();
  SFX.success();
  closeCoverModal();
}

async function deleteCoverListItem(variantId) {
  const game = allGames.find(g => g.id === coverGameId);
  if (!game) return;
  if (game.activeCoverType === variantId) return; // can't delete the currently equipped cover
  if (coverListEntries.length <= 1) return; // safety: must keep at least one cover
  const entry = coverListEntries.find(e => e.id === variantId);
  if (!confirm(`Delete "${entry ? entry.name : 'this cover'}"?`)) return;
  await api.deleteCoverVariant(game.id, variantId);
  game.customCovers = (game.customCovers || []).filter(c => c.id !== variantId);
  // If we deleted the active cover, fall back to the first remaining one
  if (game.activeCoverType === variantId) {
    const remaining = coverListEntries.filter(e => e.id !== variantId);
    const fallback = remaining[0] ? remaining[0].id : null;
    if (fallback) {
      const rf = await api.selectNativeCover(game.id, fallback);
      game.activeCoverType = fallback;
      if (typeof rf === 'number') coverVersions[game.id] = rf;
    }
  }
  await api.saveGames(allGames);
  renderGrid();
  renderRecentlyPlayed();
  renderFavorites();
  SFX.click && SFX.click();
  await openCoverListView(game);
}

// "Add new" — open the shared designer for a fresh custom cover.
function addNewCoverFromList() {
  designerReturnToList = true;
  openDesigner(null, '🎨 Design Cover');
  document.getElementById('cv-designer-actions').style.display = '';
  document.getElementById('cover-save').style.display = '';
}

// "Back to list" from the designer (discards the in-progress design).
async function backToList() {
  const game = allGames.find(g => g.id === coverGameId);
  if (game) await openCoverListView(game);
}

// ── Cover modal helpers ────────────────────────────────────────
function closeCoverModal() {
  document.getElementById('cover-modal').classList.remove('open');
  coverGameId = null;
  emojiPanelOpen = false;
  designerReturnToList = false;
  document.getElementById('emoji-panel').style.display = 'none';
  const da = document.getElementById('cv-designer-actions');
  if (da) da.style.display = 'none';
}

function renderCoverPreview() {
  let game;
  if (coverGameId === '__new__') {
    const title = (document.getElementById('add-title') && document.getElementById('add-title').value.trim()) || 'My Game';
    game = { id: '__new__', title, party: 'imported' };
  } else {
    game = allGames.find(g => g.id === coverGameId);
  }
  if (!game) return;
  document.getElementById('cover-preview-svg').innerHTML = generateCoverSVG(game, coverCfg);
}

function toggleEmojiPanel() {
  emojiPanelOpen = !emojiPanelOpen;
  const panel = document.getElementById('emoji-panel');
  if (emojiPanelOpen) {
    if (!panel.children.length) {
      panel.innerHTML = EMOJI_CATEGORIES.map(function(cat) {
        var btns = cat.emojis.map(function(e) { return '<button class="emoji-btn" data-emoji="' + e + '">' + e + '</button>'; }).join('');
        return '<div class="emoji-cat-label">' + cat.label + '</div>' + btns;
      }).join('');
    }
    panel.style.display = 'flex';
    panel.style.flexWrap = 'wrap';
  } else {
    panel.style.display = 'none';
  }
}

async function saveCoverAndClose() {
  // '__new__' sentinel: save config back to newGameCoverCfg and update add-modal preview
  if (coverGameId === '__new__') {
    newGameCoverCfg = Object.assign({}, coverCfg);
    SFX.success();
    closeCoverModal();
    updateAddCoverPreview();
    return;
  }
  const game = allGames.find(function(g) { return g.id === coverGameId; });
  if (!game) return;
  const svg = generateCoverSVG(game, coverCfg);
  // Don't bloat games.json with the image data URL — strip it before saving config
  const cfgToSave = Object.assign({}, coverCfg);
  delete cfgToSave.imageDataUrl;

  // Designing a brand-new custom cover for an existing game (via "Add new"):
  // store it as the next "Custom Cover N" variant and return to the list.
  const existing = game.customCovers || [];
  let n = 1;
  while (existing.some(c => c.id === 'custom' + n)) n++;
  const variantId = 'custom' + n;
  const name = 'Custom Cover ' + n;
  await api.saveCoverVariant(game.id, variantId, svg);
  game.customCovers = existing.concat([{ id: variantId, name, config: cfgToSave }]);
  await api.saveGames(allGames);
  SFX.success();
  designerReturnToList = false;
  document.getElementById('cv-designer-actions').style.display = 'none';
  await openCoverListView(game);
  selectCoverListItem(variantId, game);
}

async function restoreDefaultCover() {
  if (!coverGameId) return;
  const r = await api.selectNativeCover(coverGameId, 'default');
  const game = allGames.find(function(g) { return g.id === coverGameId; });
  if (game) game.activeCoverType = 'default';
  if (typeof r === 'number') coverVersions[coverGameId] = r;
  await api.saveGames(allGames);
  renderGrid();
  renderRecentlyPlayed();
  renderFavorites();
  closeCoverModal();
}

function updateCustomizePanelState() {
  // Unset/empty defaults to "preferred": the natural state where every game
  // shows its own stored cover.
  const saved = localStorage.getItem('gl_cover_style') || 'preferred';
  const prefBtn = document.getElementById('cust-opt-preferred');
  if (prefBtn) prefBtn.classList.toggle('active', saved === 'preferred');
  document.getElementById('cust-opt-default').classList.toggle('active', saved === 'default');
  document.getElementById('cust-opt-minimalist').classList.toggle('active', saved === 'minimalist');

  const sz = localStorage.getItem('gl_card_size') || 'md';
  ['sm','md','lg'].forEach(s => {
    const el = document.getElementById('cust-size-' + s);
    if (el) el.classList.toggle('active', s === sz);
  });

  const accent = localStorage.getItem('gl_accent') || '#10b981';
  document.querySelectorAll('.cust-accent-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.accent === accent);
  });

}

function applyCardSize(size) {
  const sizes = { sm: '160px', md: '180px', lg: '200px' };
  document.documentElement.style.setProperty('--card-w', sizes[size] || '180px');
}

function applyAccent(accent, accent2) {
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent2', accent2);
}

function setCardSize(size) {
  persistKey('gl_card_size', size);
  applyCardSize(size);
  updateCustomizePanelState();
}

function setAccent(accent, accent2) {
  persistKey('gl_accent', accent);
  persistKey('gl_accent2', accent2);
  applyAccent(accent, accent2);
  updateCustomizePanelState();
}

// ── Profile & Welcome ─────────────────────────────────────────

const EMBLEM_LIST = [
  '🥒','🎮','👾','🎲','🏆','⚡','🔥','🌟','🎯','🦊',
  '🐺','🐸','🐉','🦁','🐧','🤖','👻','💀','🎭','🦄',
  '🍄','🌈','⚔️','🛡️','🏹','🪄','🚀','🌙','🎪','☄️',
  '🐯','🐻','🐨','🐼','🦝','🦅','🦉','🦇','🐙','🦑',
  '🦖','🐢','🦎','🐍','🦂','🕷️','🦋','🐝','🦈','🐬',
  '👽','🛸','🪐','🌍','🔮','💎','👑','🗡️','🔱','🪓',
  '💣','🧨','🎃','💜','💚','❄️','🌊','🌋','🍀','🎵',
  '🎸','🥁','🃏','♟️','🕹️','🥇','🧙','🧛','🧟','🦸',
];

let _welcomeEmblem = '';
let _pmEmblem      = '';

function buildEmblemGrid(containerId, currentEmblem, onSelect) {
  const grid = document.getElementById(containerId);
  if (!grid) return;
  grid.innerHTML = '';
  EMBLEM_LIST.forEach(em => {
    const btn = document.createElement('button');
    btn.className = 'wm-emblem-btn' + (em === currentEmblem ? ' selected' : '');
    btn.textContent = em;
    btn.type = 'button';
    btn.onclick = () => {
      grid.querySelectorAll('.wm-emblem-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      onSelect(em);
    };
    grid.appendChild(btn);
  });
}

// ── Welcome modal ──────────────────────────────────────────────
function showWelcomeModal() {
  _welcomeEmblem = '';
  buildEmblemGrid('wm-emblem-grid', '', em => {
    _welcomeEmblem = em;
    updateWmConfirmBtn();
  });
  const nameEl = document.getElementById('wm-name');
  if (nameEl) {
    nameEl.value = '';
    nameEl.addEventListener('input', updateWmConfirmBtn);
  }
  updateWmConfirmBtn();
  const modal = document.getElementById('welcome-modal');
  if (modal) modal.style.display = 'flex';
}

function updateWmConfirmBtn() {
  const name = (document.getElementById('wm-name')?.value || '').trim();
  const btn  = document.getElementById('wm-confirm');
  if (btn) btn.disabled = !(name.length > 0 && _welcomeEmblem);
}

function confirmWelcome() {
  const name = (document.getElementById('wm-name')?.value || '').trim();
  if (!name || !_welcomeEmblem) {
    const err = document.getElementById('wm-err');
    if (err) { err.textContent = 'Please enter a name and pick an emblem.'; setTimeout(() => { err.textContent = ''; }, 2500); }
    return;
  }
  persistKey('gl_player_name', name);
  persistKey('gl_player_emblem', _welcomeEmblem);
  const modal = document.getElementById('welcome-modal');
  if (modal) { modal.style.opacity = '0'; modal.style.transition = 'opacity .3s'; setTimeout(() => { modal.style.display = 'none'; }, 310); }
  updateProfileChip();
  SFX.success();
}

// ── Profile chip ───────────────────────────────────────────────
function updateProfileChip() {
  const name    = localStorage.getItem('gl_player_name') || '';
  const emblem  = localStorage.getItem('gl_player_emblem') || '🎮';
  const eEl = document.getElementById('profile-btn-emblem');
  const nEl = document.getElementById('profile-btn-name');
  if (eEl) eEl.textContent = emblem;
  if (nEl) nEl.textContent = name;
}

function toggleProfileDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById('profile-dropdown');
  const open = dd?.classList.toggle('open');
  if (open) {
    // Close customize panel if open
    const customizePanel = document.getElementById('customize-panel');
    const customizeBtn = document.getElementById('customize-btn');
    if (customizePanel) customizePanel.classList.remove('open');
    if (customizeBtn) customizeBtn.classList.remove('panel-open');
  }
}

// Close dropdown when clicking away
document.addEventListener('click', () => {
  const dd = document.getElementById('profile-dropdown');
  if (dd) dd.classList.remove('open');
});

// ── Profile edit modal ─────────────────────────────────────────
function openProfileModal() {
  const dd = document.getElementById('profile-dropdown');
  if (dd) dd.classList.remove('open');
  _pmEmblem = localStorage.getItem('gl_player_emblem') || EMBLEM_LIST[0];
  const nameEl = document.getElementById('pm-name');
  if (nameEl) nameEl.value = localStorage.getItem('gl_player_name') || '';
  buildEmblemGrid('pm-emblem-grid', _pmEmblem, em => {
    _pmEmblem = em;
    updatePmPreview();
  });
  updatePmPreview();
  const modal = document.getElementById('profile-modal');
  if (modal) modal.classList.add('open');
  SFX.open();
}

function closeProfileModal() {
  const modal = document.getElementById('profile-modal');
  if (modal) modal.classList.remove('open');
}

function onPmNameInput(value) {
  updatePmPreview();
}

function updatePmPreview() {
  const name = (document.getElementById('pm-name')?.value || '').trim();
  const eEl  = document.getElementById('pm-emblem-preview');
  const nEl  = document.getElementById('pm-name-preview');
  if (eEl) eEl.textContent = _pmEmblem || '🎮';
  if (nEl) nEl.textContent = name || 'Your name here';
}

function saveProfile() {
  const name = (document.getElementById('pm-name')?.value || '').trim();
  if (!name) {
    document.getElementById('pm-name')?.focus();
    return;
  }
  persistKey('gl_player_name', name);
  persistKey('gl_player_emblem', _pmEmblem);
  closeProfileModal();
  updateProfileChip();
  SFX.success();
}

let _nameDebounce = null;
function onPlayerNameInput(value) {
  clearTimeout(_nameDebounce);
  _nameDebounce = setTimeout(() => {
    persistKey('gl_player_name', value.trim());
    updateProfileChip();
  }, 600);
}

async function setAllCovers(style) {
  persistKey('gl_cover_style', style);
  // Only covers whose file actually changes get a new ?v= (selectNativeCover
  // returns the rewritten file's mtime, or 'unchanged'). Re-pressing the
  // active style, or games already displaying the target art, keep their
  // stable URL → served from the covers:// cache instantly instead of
  // re-fetching all 26 files. Changed covers bust to the new mtime, which is
  // the same version listCovers reports next launch → still cached then.
  for (const g of allGames) {
    if (style === 'preferred') {
      // Restore every game to the cover it individually stores. Imported games
      // count too — their preferred cover is whatever activeCoverType holds.
      const pref = g.activeCoverType || 'default';
      try {
        const r = await window.electronAPI.selectNativeCover(g.id, pref);
        if (typeof r === 'number') coverVersions[g.id] = r;
      } catch {}
    } else {
      // Apply a native style to the *displayed* cover only. We deliberately do
      // NOT touch g.activeCoverType or save games.json, so each game's stored
      // pick survives — clicking "Preferred" puts everything back.
      if (g.party === 'imported') continue; // imported games have no native default/minimalist cover
      try {
        const r = await window.electronAPI.selectNativeCover(g.id, style);
        if (typeof r === 'number') coverVersions[g.id] = r;
      } catch {}
    }
  }
  renderGrid();
  renderRecentlyPlayed();
  renderFavorites();
  updateCustomizePanelState();
}

// ── Dev Shelf ─────────────────────────────────────────────────
// Card view over the in-development projects in _dev/. Dev machine only:
// initDevShelf() reveals the header button only when the main process reports
// _dev exists and the app is unpackaged. Never rendered on the website.
let dsProjects = null;   // last scan result, null = never scanned
let dsDir = '';          // absolute path of _dev (for Copy Path)
let dsOpen = false;
let dsScanning = false;
let dsSort = localStorage.getItem('gl_ds_sort') === 'name' ? 'name' : 'recent';
let dsSearch = '';
let dsTab = localStorage.getItem('gl_ds_tab') === 'ideas' ? 'ideas' : 'projects';

// Idea cards (the Ideas tab) — a flat pile in _dev/devshelf-notes.json.
// Sorted longest-first by default: the fattest note piles are the ones with
// enough thinking behind them to be worth picking up.
let dsNotes = null;      // null = not loaded yet
let dsNoteSort = localStorage.getItem('gl_ds_nsort') === 'recent' ? 'recent' : 'lines';
let dsNoteEditing = null;   // id of the card open in the editor, '' = new

// Auto-assigned symbol when a project has no emoji picked yet: stable hash of
// the folder name into a curated set, so cards keep their symbol between scans.
const DS_AUTO_EMOJI = ['🎮','🚀','🧪','🌊','🏰','🎯','🧩','⚔️','🐸','🌵','🦉','🍄','🎲','🐳','🌋','🛶','🪁','🤖','🦖','🛸','🎪','🧨','🪐','🏝'];
function dsAutoEmoji(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return DS_AUTO_EMOJI[h % DS_AUTO_EMOJI.length];
}

// Picker choices for the emoji popover (plus an "auto" reset entry).
const DS_EMOJI_CHOICES = [
  '🎮','🕹','👾','🎯','🎲','🧩','♟','🃏','🎪','🎨','🖌','✏️','📐','🔧','⚒','🧰','🧪','⚗️','🔬','💡',
  '🚗','🏎','🏁','🐎','🚀','✈️','🛩','🚁','⛵','🛶','🚂','🛰','🛸','🪂','🎢','🛷','⛷','🏂','🚲','🛼',
  '⚔️','🗡','🛡','🏹','💣','🧨','🔫','💥','🏴‍☠️','👻','💀','🧟','🧙','🧛','🐉','👽','🤖','🦾','🕷','🦂',
  '🌊','🌋','🏔','🌵','🏜','🏝','🌲','🍄','⛺','🏰','🗿','⏳','🔥','⚡','❄️','🌪','🌙','☀️','🌈','⭐',
  '🦖','🦕','🐙','🦑','🦈','🐊','🦅','🦉','🐺','🦊','🐻','🐸','🐍','🦩','🦜','🐳','🪰','🦋','🐢','🦀',
  '🎸','🎹','🥁','🎺','🎙','🎧','🎬','📽','📸','📻','🏀','⚽','🏈','⚾','🎾','🏐','🏓','🥊','⛳','🎳',
];

function dsPrettyName(name) {
  return name.replace(/^_+/, '').replace(/[-_]+/g, ' ').trim()
    .replace(/\b\w/g, c => c.toUpperCase()) || name;
}

function dsAgo(ms) {
  if (!ms) return '—';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 60) return Math.floor(s / 86400) + 'd ago';
  return Math.floor(s / (86400 * 30)) + 'mo ago';
}

function dsAgoShort(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 86400 * 60) return Math.floor(s / 86400) + 'd';
  return Math.floor(s / (86400 * 30)) + 'mo';
}

function dsFmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Freshness class for the activity dot: touched today / this week / dormant.
function dsFreshClass(ms) {
  const age = Date.now() - ms;
  if (age < 86400000) return 'ds-fresh-hot';
  if (age < 7 * 86400000) return 'ds-fresh-warm';
  return 'ds-fresh-cold';
}

function dsProject(name) {
  return (dsProjects || []).find(p => p.name === name) || null;
}

const DS_CX_LABEL = { low: '● Low', medium: '●● Medium', high: '●●● High' };
const DS_CX_NEXT  = { low: 'medium', medium: 'high', high: 'low' };

function dsCardHTML(p) {
  const esc = escapeHtmlWN;
  const emoji = p.emoji || dsAutoEmoji(p.name);
  const cx = p.complexity || 'medium';

  // Play row: the resolved build (pinned file, else newest .html in the folder).
  const play = p.playFile
    ? `<button class="ds-play" title="Play ${esc(p.playFile)}">
         <span class="ds-play-glyph">▶</span>
         <span class="ds-play-file">${esc(p.playFile)}</span>
         ${p.playPinned ? '<span class="ds-play-pin" title="Pinned to this file">📌</span>' : ''}
       </button>
       <button class="ds-play-edit" title="Play a different file">✎</button>`
    : `<div class="ds-play-none">no .html to play</div>
       <button class="ds-play-edit" title="Pick a file">✎</button>`;

  // Dev log summary — click opens the editor for _dev/<name>/DEVLOG.md.
  const log = p.log;
  const logStatus = log && log.status
    ? `<span class="ds-log-status">${esc(log.status)}</span>`
    : `<span class="ds-log-status ds-log-empty">${log ? 'log started — no status yet' : 'no dev log yet — click to start one'}</span>`;
  const logChips = log
    ? `<span class="ds-log-chips">
         ${log.now  ? `<span class="ds-log-chip ds-chip-now" title="In progress">▶ ${log.now}</span>` : ''}
         ${log.next ? `<span class="ds-log-chip" title="Planned">⏭ ${log.next}</span>` : ''}
         ${log.done ? `<span class="ds-log-chip ds-chip-done" title="Finished">✓ ${log.done}</span>` : ''}
       </span>`
    : '';

  const maxDay = Math.max(1, ...(p.days || []));
  const bars = (p.days || []).map((d, i) => {
    const h = d ? Math.max(12, Math.round((d / maxDay) * 100)) : 4;
    const label = d + ' file' + (d === 1 ? '' : 's') + (i === 13 ? ' today' : ' — ' + (13 - i) + 'd ago');
    return `<span class="ds-bar${d ? ' ds-bar-on' : ''}" style="height:${h}%" title="${label}"></span>`;
  }).join('');
  // Hidden cards trade the Pin button for the second hide step — pinning does
  // nothing down there, since the hidden strips never sort pinned-first.
  const midAct = !p.hidden
    ? `<button class="ds-act" data-act="pin">${p.pinned ? '📌 Unpin' : '📌 Pin'}</button>`
    : p.buried
      ? '<button class="ds-act" data-act="bury" title="Back up to Hidden">⬆ Raise</button>'
      : '<button class="ds-act" data-act="bury" title="Hide it further — small card, bottom of the shelf">🙈🙈 Bury</button>';

  // On a visible card, Bury is normally a two-step trip (hide first, then bury
  // from the Hidden strip). Hovering Hide pops a shortcut out above it.
  const hideBtn = `<button class="ds-act" data-act="hide">${p.hidden ? '👁 Unhide' : '🙈 Hide'}</button>`;
  const hideAct = p.hidden ? hideBtn : `<div class="ds-hide-wrap">
        <button class="ds-act ds-bury-fly" data-act="bury" title="Skip straight to buried — small card, bottom of the shelf">🙈🙈 Bury</button>
        ${hideBtn}
      </div>`;

  return `
  <div class="ds-card${p.pinned && !p.hidden ? ' ds-pinned' : ''}${p.buried ? ' ds-mini' : ''}" data-name="${esc(p.name)}" title="Open ${esc(p.name)} in Explorer">
    ${p.pinned && !p.hidden ? '<span class="ds-pin-badge" title="Pinned">📌</span>' : ''}
    <div class="ds-card-top">
      <button class="ds-emoji" title="Change symbol">${emoji}</button>
      <div class="ds-title-wrap">
        <div class="ds-title"><span class="ds-dot ${dsFreshClass(p.lastActivity)}"></span>${esc(dsPrettyName(p.name))}</div>
        <div class="ds-sub">
          <span>${dsAgo(p.lastActivity)}</span>
          <button class="ds-cx ds-cx-${cx}" title="Build complexity — click to change">${DS_CX_LABEL[cx]}</button>
        </div>
      </div>
    </div>
    <div class="ds-play-row">${play}</div>
    <button class="ds-log-strip" title="Open the dev log">${logStatus}${logChips}</button>
    <div class="ds-foot-row">
      <div class="ds-foot">${p.fileCount}${p.capped ? '+' : ''} files · ${dsFmtBytes(p.totalBytes)}</div>
      <div class="ds-spark" title="Files touched, last 14 days">${bars}</div>
    </div>
    <div class="ds-actions">
      ${hideAct}
      ${midAct}
      <button class="ds-act" data-act="copy">📋 Path</button>
    </div>
  </div>`;
}

function renderDevShelf() {
  const grid = document.getElementById('ds-grid');
  const hiddenGrid = document.getElementById('ds-hidden-grid');
  const hiddenSec = document.getElementById('ds-hidden-sec');
  const buriedGrid = document.getElementById('ds-buried-grid');
  const buriedSec = document.getElementById('ds-buried-sec');
  const count = document.getElementById('ds-count');
  if (!grid) return;

  document.getElementById('ds-sort-recent').classList.toggle('active', dsSort === 'recent');
  document.getElementById('ds-sort-name').classList.toggle('active', dsSort === 'name');
  document.getElementById('ds-nsort-lines').classList.toggle('active', dsNoteSort === 'lines');
  document.getElementById('ds-nsort-recent').classList.toggle('active', dsNoteSort === 'recent');

  if (dsTab === 'ideas') { renderDsNotes(); return; }

  if (dsProjects === null) {
    grid.innerHTML = `<div class="empty-state"><div class="big-icon">🛠</div><div>${dsScanning ? 'Scanning _dev…' : 'Nothing here yet'}</div></div>`;
    hiddenSec.style.display = 'none';
    buriedSec.style.display = 'none';
    count.textContent = '';
    return;
  }

  const q = dsSearch.trim().toLowerCase();
  const match = p => !q || p.name.toLowerCase().includes(q) || dsPrettyName(p.name).toLowerCase().includes(q);
  const sortFn = dsSort === 'name'
    ? (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    : (a, b) => b.lastActivity - a.lastActivity;

  const visible = dsProjects.filter(p => !p.hidden && match(p))
    .sort((a, b) => (b.pinned - a.pinned) || sortFn(a, b));
  const hidden = dsProjects.filter(p => p.hidden && !p.buried && match(p)).sort(sortFn);
  const buried = dsProjects.filter(p => p.hidden && p.buried && match(p)).sort(sortFn);

  count.textContent = dsScanning ? 'rescanning…'
    : visible.length + ' project' + (visible.length === 1 ? '' : 's')
      + (hidden.length ? ' · ' + hidden.length + ' hidden' : '')
      + (buried.length ? ' · ' + buried.length + ' buried' : '');

  grid.innerHTML = visible.length ? visible.map(dsCardHTML).join('')
    : `<div class="empty-state"><div class="big-icon">🛠</div><div>${q ? 'No projects match "' + escapeHtmlWN(dsSearch) + '"' : 'No projects in _dev'}</div></div>`;
  hiddenSec.style.display = hidden.length ? '' : 'none';
  hiddenGrid.innerHTML = hidden.map(dsCardHTML).join('');
  buriedSec.style.display = buried.length ? '' : 'none';
  buriedGrid.innerHTML = buried.map(dsCardHTML).join('');
}

// Ideas tab. Default order is longest-first — line count is the cheapest
// proxy for "how much thinking is already banked here".
function renderDsNotes() {
  const grid = document.getElementById('ds-notes-grid');
  const count = document.getElementById('ds-count');
  if (!grid) return;

  if (dsNotes === null) {
    grid.innerHTML = '<div class="empty-state"><div class="big-icon">💡</div><div>Loading…</div></div>';
    count.textContent = '';
    return;
  }

  const q = dsSearch.trim().toLowerCase();
  const cards = dsNotes.filter(c => !q
    || (c.title || '').toLowerCase().includes(q)
    || (c.body || '').toLowerCase().includes(q)
    || (c.project || '').toLowerCase().includes(q));
  cards.sort(dsNoteSort === 'recent'
    ? (a, b) => (b.updated || b.created) - (a.updated || a.created)
    : (a, b) => dsNoteLines(b) - dsNoteLines(a) || (b.updated || 0) - (a.updated || 0));

  count.textContent = cards.length + ' card' + (cards.length === 1 ? '' : 's');
  grid.innerHTML = cards.length ? cards.map(dsNoteCardHTML).join('')
    : `<div class="empty-state"><div class="big-icon">💡</div><div>${
        q ? 'No notes match "' + escapeHtmlWN(dsSearch) + '"' : 'No idea cards yet — hit 📥 Dump Notes'}</div></div>`;
}

async function dsScan() {
  if (dsScanning) return;
  dsScanning = true;
  renderDevShelf();
  try {
    const r = await api.devShelfScan();
    if (r && Array.isArray(r.projects)) { dsDir = r.dir; dsProjects = r.projects; }
  } catch {}
  dsScanning = false;
  renderDevShelf();
}

async function dsSetMeta(name, patch) {
  const p = dsProject(name);
  if (!p) return;
  Object.assign(p, patch);
  renderDevShelf();
  try { await api.devShelfSetMeta(name, patch); } catch {}
}

function dsCloseEmojiPop() {
  const pop = document.getElementById('ds-emoji-pop');
  if (pop) pop.classList.remove('open');
}

function dsOpenEmojiPop(anchorBtn, name) {
  const pop = document.getElementById('ds-emoji-pop');
  if (!pop) return;
  const p = dsProject(name);
  pop.innerHTML = '<button class="ds-emo ds-emo-auto" data-emoji="">✨ Auto</button>' +
    DS_EMOJI_CHOICES.map(e =>
      `<button class="ds-emo${p && p.emoji === e ? ' active' : ''}" data-emoji="${e}">${e}</button>`).join('');
  pop.dataset.name = name;
  pop.classList.add('open');
  // Position below the clicked emoji button, clamped to the shelf width.
  // #dev-shelf is position:relative and doesn't scroll itself (#main does),
  // so plain rect deltas give the right absolute offsets.
  const host = document.getElementById('dev-shelf');
  const hr = host.getBoundingClientRect();
  const br = anchorBtn.getBoundingClientRect();
  const popW = 292;
  const left = Math.max(0, Math.min(br.left - hr.left, host.clientWidth - popW - 4));
  pop.style.left = left + 'px';
  pop.style.top = (br.bottom - hr.top + 6) + 'px';
}

function toggleDevShelf(open) {
  dsOpen = typeof open === 'boolean' ? open : !dsOpen;
  document.body.classList.toggle('devshelf-open', dsOpen);
  const btn = document.getElementById('devshelf-btn');
  if (btn) {
    btn.textContent = dsOpen ? '🎮 Back to Arcade' : '🛠 Dev Shelf';
    btn.classList.toggle('devshelf-btn-active', dsOpen);
  }
  dsCloseEmojiPop();
  if (dsOpen) {
    document.getElementById('main').scrollTop = 0;
    dsScan();   // fresh mtimes every time the shelf opens
  }
}

function dsGridClick(e) {
  const card = e.target.closest('.ds-card');
  if (!card) return;
  const name = card.dataset.name;

  const act = e.target.closest('.ds-act');
  if (act) {
    const p = dsProject(name);
    if (!p) return;
    // Unhiding also un-buries — a card can never sit buried but visible.
    if (act.dataset.act === 'hide') dsSetMeta(name, p.hidden ? { hidden: false, buried: false } : { hidden: true });
    else if (act.dataset.act === 'bury') dsSetMeta(name, { buried: !p.buried, hidden: true });
    else if (act.dataset.act === 'pin') dsSetMeta(name, { pinned: !p.pinned });
    else if (act.dataset.act === 'copy') {
      const path = dsDir + '\\' + name;
      try { navigator.clipboard.writeText(path); } catch {}
      act.textContent = '✓ Copied';
      setTimeout(() => { act.textContent = '📋 Path'; }, 1200);
    }
    return;
  }

  const emojiBtn = e.target.closest('.ds-emoji');
  if (emojiBtn) {
    const pop = document.getElementById('ds-emoji-pop');
    if (pop.classList.contains('open') && pop.dataset.name === name) dsCloseEmojiPop();
    else dsOpenEmojiPop(emojiBtn, name);
    return;
  }

  const cxBtn = e.target.closest('.ds-cx');
  if (cxBtn) {
    const p = dsProject(name);
    if (p) dsSetMeta(name, { complexity: DS_CX_NEXT[p.complexity || 'medium'] });
    return;
  }

  if (e.target.closest('.ds-play')) {
    const p = dsProject(name);
    if (p && p.playFile) api.devShelfPlay(name, p.playFile).catch(() => {});
    return;
  }

  const playEdit = e.target.closest('.ds-play-edit');
  if (playEdit) {
    const pop = document.getElementById('ds-play-pop');
    if (pop.classList.contains('open') && pop.dataset.name === name) dsClosePlayPop();
    else dsOpenPlayPop(playEdit, name);
    return;
  }

  if (e.target.closest('.ds-log-strip')) { dsOpenLog(name); return; }

  api.devShelfOpen(name).catch(() => {});
}

// ── Play-file picker ──────────────────────────────────────────
// Lists every .html in the project (newest first, dist/ and build/ included —
// several projects only produce a playable file after a bundle step).
function dsClosePlayPop() {
  const pop = document.getElementById('ds-play-pop');
  if (pop) pop.classList.remove('open');
}

function dsOpenPlayPop(anchorBtn, name) {
  const pop = document.getElementById('ds-play-pop');
  const p = dsProject(name);
  if (!pop || !p) return;
  const esc = escapeHtmlWN;
  const files = p.htmlFiles || [];
  pop.innerHTML =
    '<div class="ds-pp-head">Which file should ▶ Play open?</div>' +
    `<button class="ds-pp-item${p.playPinned ? '' : ' active'}" data-rel="">
       <span class="ds-pp-rel ds-pp-auto">✨ Newest .html (auto)</span>
     </button>` +
    (files.length
      ? files.map(f => `<button class="ds-pp-item${p.playPinned && p.playFile === f.rel ? ' active' : ''}" data-rel="${esc(f.rel)}">
           <span class="ds-pp-rel">${esc(f.rel)}</span>
           <span class="ds-pp-time">${dsAgoShort(f.mtime)}</span>
         </button>`).join('')
      : '<div class="ds-pp-none">No .html files in this project.</div>');
  pop.dataset.name = name;
  pop.classList.add('open');
  const host = document.getElementById('dev-shelf');
  const hr = host.getBoundingClientRect();
  const br = anchorBtn.getBoundingClientRect();
  const popW = 340;
  pop.style.left = Math.max(0, Math.min(br.right - hr.left - popW, host.clientWidth - popW - 4)) + 'px';
  pop.style.top  = (br.bottom - hr.top + 6) + 'px';
}

// ── Dev log editor ────────────────────────────────────────────
// Reads/writes _dev/<project>/DEVLOG.md. The file is the real record; this
// modal is just a comfortable way to keep it current between sessions.
let dsLogName = null;
let dsLog = null;

async function dsOpenLog(name) {
  const p = dsProject(name);
  if (!p) return;
  dsCloseEmojiPop(); dsClosePlayPop();
  dsLogName = name;
  let log = null;
  try { log = await api.devShelfLogRead(name); } catch {}
  dsLog = log || { status: '', now: [], next: [], done: [], notes: '' };

  document.getElementById('ds-log-emoji').textContent = p.emoji || dsAutoEmoji(name);
  document.getElementById('ds-log-title').textContent = dsPrettyName(name) + ' — Dev Log';
  document.getElementById('ds-log-path').textContent = '_dev\\' + name + '\\DEVLOG.md' + (log ? '' : '  (will be created)');
  document.getElementById('ds-log-status').value = dsLog.status || '';
  document.getElementById('ds-log-notes').value = dsLog.notes || '';
  document.getElementById('ds-log-save-status').textContent = '';
  document.getElementById('ds-log-now-add').value = '';
  document.getElementById('ds-log-next-add').value = '';
  dsRenderLogLists();
  document.getElementById('ds-log-modal').classList.add('open');
  document.getElementById('ds-log-status').focus();
}

function dsRenderLogLists() {
  const esc = escapeHtmlWN;
  const rows = (key, done) => (dsLog[key] || []).map((t, i) =>
    `<div class="ds-item" data-list="${key}" data-i="${i}">
       ${done ? '' : '<button class="ds-item-check" title="Mark done">✓</button>'}
       <span class="ds-item-text">${esc(t)}</span>
       <button class="ds-item-del" title="Remove">✕</button>
     </div>`).join('');
  document.getElementById('ds-log-now').innerHTML  = rows('now', false);
  document.getElementById('ds-log-next').innerHTML = rows('next', false);
  document.getElementById('ds-log-done').innerHTML = rows('done', true);
  document.getElementById('ds-log-done-count').textContent =
    dsLog.done.length ? `(${dsLog.done.length})` : '';
}

function dsLogListClick(e) {
  const row = e.target.closest('.ds-item');
  if (!row) return;
  const list = row.dataset.list;
  const i = Number(row.dataset.i);
  if (e.target.closest('.ds-item-del')) {
    dsLog[list].splice(i, 1);
  } else if (e.target.closest('.ds-item-check')) {
    // Ticking a Now/Next item files it under Done, dated.
    const text = dsLog[list].splice(i, 1)[0];
    const d = new Date();
    const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    dsLog.done.unshift(stamp + ' — ' + text);
  } else return;
  dsRenderLogLists();
}

async function dsSaveLog() {
  if (!dsLogName || !dsLog) return;
  dsLog.status = document.getElementById('ds-log-status').value;
  dsLog.notes  = document.getElementById('ds-log-notes').value;
  const st = document.getElementById('ds-log-save-status');
  let ok = false;
  try { ok = await api.devShelfLogWrite(dsLogName, dsLog); } catch {}
  st.textContent = ok ? '✓ Saved to DEVLOG.md' : '✕ Could not write DEVLOG.md';
  if (!ok) return;
  // Refresh the card face (status line + counts) without a full re-scan.
  const p = dsProject(dsLogName);
  if (p) {
    p.log = { status: dsLog.status, now: dsLog.now.length, next: dsLog.next.length,
              done: dsLog.done.length, nowTop: dsLog.now.slice(0, 2), updated: Date.now() };
    renderDevShelf();
  }
  setTimeout(() => document.getElementById('ds-log-modal').classList.remove('open'), 450);
}

// ── Idea cards ────────────────────────────────────────────────
function dsNoteLines(c) {
  return ((c.title ? c.title + '\n' : '') + (c.body || ''))
    .split('\n').filter(l => l.trim()).length;
}

async function dsLoadNotes() {
  if (dsNotes !== null) return;
  dsNotes = [];
  try {
    const r = await api.devShelfNotesRead();
    if (r && Array.isArray(r.cards)) dsNotes = r.cards;
  } catch {}
  renderDevShelf();
}

async function dsSaveNotes() {
  try { await api.devShelfNotesWrite(dsNotes || []); } catch {}
}

function dsNoteCardHTML(c) {
  const esc = escapeHtmlWN;
  const n = dsNoteLines(c);
  return `
  <div class="ds-note-card" data-id="${esc(c.id)}">
    <div class="ds-note-head">
      <div class="ds-note-title">${esc(c.title || 'Untitled')}</div>
      <span class="ds-note-lines" title="${n} line${n === 1 ? '' : 's'} of notes">${n}L</span>
    </div>
    ${c.body ? `<div class="ds-note-body">${esc(c.body)}</div>` : ''}
    <div class="ds-note-foot">
      ${c.project ? `<span class="ds-note-proj">${esc(dsPrettyName(c.project))}</span>` : ''}
      <span class="ds-note-when">${dsAgo(c.updated || c.created)}</span>
    </div>
  </div>`;
}

function dsProjectOptions(sel, selected) {
  const names = (dsProjects || []).map(p => p.name).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }));
  sel.innerHTML = '<option value="">— none —</option>' + names.map(n =>
    `<option value="${escapeHtmlWN(n)}"${n === selected ? ' selected' : ''}>${escapeHtmlWN(dsPrettyName(n))}</option>`).join('');
}

function dsOpenNote(id) {
  const c = id ? (dsNotes || []).find(x => x.id === id) : null;
  dsNoteEditing = c ? c.id : '';
  document.getElementById('ds-note-title').value = c ? c.title : '';
  document.getElementById('ds-note-body').value  = c ? c.body  : '';
  document.getElementById('ds-note-meta').textContent = c
    ? dsNoteLines(c) + ' lines · edited ' + dsAgo(c.updated || c.created)
    : 'New card';
  document.getElementById('ds-note-status').textContent = '';
  document.getElementById('ds-note-delete').style.display = c ? '' : 'none';
  dsProjectOptions(document.getElementById('ds-note-project'), c ? c.project : '');
  document.getElementById('ds-note-modal').classList.add('open');
  document.getElementById('ds-note-title').focus();
}

async function dsSaveNote() {
  const title = document.getElementById('ds-note-title').value.trim();
  const body  = document.getElementById('ds-note-body').value;
  const proj  = document.getElementById('ds-note-project').value;
  if (!title && !body.trim()) { document.getElementById('ds-note-status').textContent = 'Nothing to save.'; return; }
  const now = Date.now();
  if (dsNoteEditing) {
    const c = dsNotes.find(x => x.id === dsNoteEditing);
    if (c) Object.assign(c, { title, body, project: proj, updated: now });
  } else {
    dsNotes.unshift({ id: 'n' + now.toString(36) + Math.random().toString(36).slice(2, 7),
                      title: title || body.trim().split('\n')[0].slice(0, 90),
                      body, project: proj, created: now, updated: now });
  }
  await dsSaveNotes();
  document.getElementById('ds-note-modal').classList.remove('open');
  renderDevShelf();
}

async function dsDeleteNote() {
  if (!dsNoteEditing) return;
  dsNotes = dsNotes.filter(c => c.id !== dsNoteEditing);
  await dsSaveNotes();
  document.getElementById('ds-note-modal').classList.remove('open');
  renderDevShelf();
}

// ── Note dump → cards ─────────────────────────────────────────
// Turns a pasted wall of text into separate cards. Five slicing modes so an
// organized page and an unorganized brain-dump both land sensibly.
let dsDumpMode = 'blank';

function dsSplitNotes(text, mode) {
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return [];
  let blocks;
  if (mode === 'one') {
    blocks = [t];
  } else if (mode === 'line') {
    blocks = t.split('\n');
  } else if (mode === 'heading') {
    // Start a new block at a markdown heading or a --- / === rule.
    blocks = [];
    let cur = [];
    for (const line of t.split('\n')) {
      if (/^\s*(#{1,6}\s+\S|-{3,}\s*$|={3,}\s*$)/.test(line)) {
        if (cur.length) blocks.push(cur.join('\n'));
        cur = /^\s*[-=]{3,}\s*$/.test(line) ? [] : [line];
      } else cur.push(line);
    }
    if (cur.length) blocks.push(cur.join('\n'));
  } else if (mode === 'bullet') {
    // A new block at each unindented bullet; indented lines stay with it.
    blocks = [];
    let cur = [];
    for (const line of t.split('\n')) {
      if (/^[-*•]\s+\S/.test(line) || /^\d+[.)]\s+\S/.test(line)) {
        if (cur.length) blocks.push(cur.join('\n'));
        cur = [line];
      } else cur.push(line);
    }
    if (cur.length) blocks.push(cur.join('\n'));
  } else {
    blocks = t.split(/\n\s*\n+/);
  }

  // Horizontal rules (--- / === / ***) are separators, never content — drop
  // them everywhere so they can't become a card titled "--".
  const RULE = /^\s*(?:-{3,}|={3,}|\*{3,}|_{3,})\s*$/;
  return blocks.map(b => b.split('\n').filter(l => !RULE.test(l)).join('\n').replace(/\s+$/, ''))
    .filter(b => b.trim())
    .map(b => {
      const lines = b.split('\n');
      let ti = lines.findIndex(l => l.trim());
      if (ti < 0) ti = 0;
      const title = lines[ti].replace(/^\s*#{1,6}\s*/, '').replace(/^\s*[-*•]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '').replace(/[*_`]/g, '').trim().slice(0, 120);
      const body = lines.slice(ti + 1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
      return { title: title || 'Untitled', body };
    });
}

function dsRenderDumpPreview() {
  const parts = dsSplitNotes(document.getElementById('ds-dump-text').value, dsDumpMode);
  const box = document.getElementById('ds-dump-preview');
  document.getElementById('ds-dump-count').textContent =
    parts.length ? `— ${parts.length} card${parts.length === 1 ? '' : 's'}` : '';
  box.innerHTML = parts.length
    ? parts.slice(0, 60).map((p, i) => {
        const n = ((p.title ? p.title + '\n' : '') + p.body).split('\n').filter(l => l.trim()).length;
        return `<div class="ds-dump-chip"><span class="ds-dump-chip-n">${i + 1}</span>
                  <span class="ds-dump-chip-t">${escapeHtmlWN(p.title)}</span>
                  <span class="ds-dump-chip-l">${n}L</span></div>`;
      }).join('') + (parts.length > 60 ? `<div class="ds-dump-empty">…and ${parts.length - 60} more</div>` : '')
    : '<div class="ds-dump-empty">Paste some notes above to see the cards.</div>';
}

function dsOpenDump() {
  document.getElementById('ds-dump-text').value = '';
  dsDumpMode = 'blank';
  document.querySelectorAll('#ds-dump-modal .ds-split-mode')
    .forEach(b => b.classList.toggle('active', b.dataset.mode === 'blank'));
  dsProjectOptions(document.getElementById('ds-dump-project'), '');
  dsRenderDumpPreview();
  document.getElementById('ds-dump-modal').classList.add('open');
  document.getElementById('ds-dump-text').focus();
}

async function dsAddDump() {
  const parts = dsSplitNotes(document.getElementById('ds-dump-text').value, dsDumpMode);
  if (!parts.length) return;
  const proj = document.getElementById('ds-dump-project').value;
  const now = Date.now();
  if (dsNotes === null) dsNotes = [];
  parts.forEach((p, i) => {
    dsNotes.unshift({ id: 'n' + (now + i).toString(36) + Math.random().toString(36).slice(2, 7),
                      title: p.title, body: p.body, project: proj, created: now, updated: now });
  });
  await dsSaveNotes();
  document.getElementById('ds-dump-modal').classList.remove('open');
  dsSetTab('ideas');
}

function dsSetTab(tab) {
  dsTab = tab === 'ideas' ? 'ideas' : 'projects';
  persistKey('gl_ds_tab', dsTab);
  const ideas = dsTab === 'ideas';
  document.getElementById('ds-tab-projects').classList.toggle('active', !ideas);
  document.getElementById('ds-tab-ideas').classList.toggle('active', ideas);
  document.getElementById('ds-view-projects').style.display = ideas ? 'none' : '';
  document.getElementById('ds-view-ideas').style.display = ideas ? '' : 'none';
  document.getElementById('ds-tools-projects').style.display = ideas ? 'none' : '';
  document.getElementById('ds-tools-ideas').style.display = ideas ? '' : 'none';
  document.getElementById('ds-search').placeholder = ideas ? 'Search notes…' : 'Search projects…';
  dsCloseEmojiPop(); dsClosePlayPop();
  if (ideas) dsLoadNotes();
  renderDevShelf();
}

async function initDevShelf() {
  if (IS_WEB || !api || !api.devShelfAvailable) return;
  let ok = false;
  try { ok = await api.devShelfAvailable(); } catch {}
  if (!ok) return;

  const btn = document.getElementById('devshelf-btn');
  btn.style.display = '';
  btn.addEventListener('click', () => toggleDevShelf());

  document.getElementById('ds-grid').addEventListener('click', dsGridClick);
  document.getElementById('ds-hidden-grid').addEventListener('click', dsGridClick);
  document.getElementById('ds-buried-grid').addEventListener('click', dsGridClick);
  document.getElementById('ds-refresh').addEventListener('click', dsScan);
  document.getElementById('ds-sort-recent').addEventListener('click', () => {
    dsSort = 'recent'; persistKey('gl_ds_sort', 'recent'); renderDevShelf();
  });
  document.getElementById('ds-sort-name').addEventListener('click', () => {
    dsSort = 'name'; persistKey('gl_ds_sort', 'name'); renderDevShelf();
  });
  document.getElementById('ds-search').addEventListener('input', (e) => {
    dsSearch = e.target.value; renderDevShelf();
  });

  const pop = document.getElementById('ds-emoji-pop');
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('.ds-emo');
    if (!b) return;
    const name = pop.dataset.name;
    dsSetMeta(name, { emoji: b.dataset.emoji || null });
    dsCloseEmojiPop();
  });

  // Play-file picker: empty data-rel resets to auto (newest .html).
  const ppop = document.getElementById('ds-play-pop');
  ppop.addEventListener('click', (e) => {
    const b = e.target.closest('.ds-pp-item');
    if (!b) return;
    const name = ppop.dataset.name;
    const rel = b.dataset.rel || null;
    const p = dsProject(name);
    if (p) {
      p.playPinned = !!rel;
      p.playFile = rel || (p.htmlFiles[0] ? p.htmlFiles[0].rel : null);
    }
    dsSetMeta(name, { playFile: rel });
    dsClosePlayPop();
  });

  // Any click outside a popover (or the buttons that open them) closes them.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ds-emoji-pop') && !e.target.closest('.ds-emoji')) dsCloseEmojiPop();
    if (!e.target.closest('#ds-play-pop') && !e.target.closest('.ds-play-edit')) dsClosePlayPop();
  });

  // ── Tabs ──
  document.getElementById('ds-tab-projects').addEventListener('click', () => dsSetTab('projects'));
  document.getElementById('ds-tab-ideas').addEventListener('click', () => dsSetTab('ideas'));
  document.getElementById('ds-nsort-lines').addEventListener('click', () => {
    dsNoteSort = 'lines'; persistKey('gl_ds_nsort', 'lines'); renderDevShelf();
  });
  document.getElementById('ds-nsort-recent').addEventListener('click', () => {
    dsNoteSort = 'recent'; persistKey('gl_ds_nsort', 'recent'); renderDevShelf();
  });
  document.getElementById('ds-note-new').addEventListener('click', () => dsOpenNote(null));
  document.getElementById('ds-note-dump').addEventListener('click', dsOpenDump);
  document.getElementById('ds-notes-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.ds-note-card');
    if (card) dsOpenNote(card.dataset.id);
  });

  // ── Dev log modal ──
  document.getElementById('ds-log-save').addEventListener('click', dsSaveLog);
  ['now', 'next', 'done'].forEach(k =>
    document.getElementById('ds-log-' + k).addEventListener('click', dsLogListClick));
  ['now', 'next'].forEach(k => {
    const inp = document.getElementById('ds-log-' + k + '-add');
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !inp.value.trim()) return;
      e.preventDefault();
      dsLog[k].push(inp.value.trim());
      inp.value = '';
      dsRenderLogLists();
    });
  });

  // ── Idea card modal ──
  document.getElementById('ds-note-save').addEventListener('click', dsSaveNote);
  document.getElementById('ds-note-delete').addEventListener('click', dsDeleteNote);

  // ── Dump modal ──
  document.getElementById('ds-dump-text').addEventListener('input', dsRenderDumpPreview);
  document.getElementById('ds-dump-add').addEventListener('click', dsAddDump);
  document.querySelectorAll('#ds-dump-modal .ds-split-mode').forEach(b =>
    b.addEventListener('click', () => {
      dsDumpMode = b.dataset.mode;
      document.querySelectorAll('#ds-dump-modal .ds-split-mode')
        .forEach(x => x.classList.toggle('active', x === b));
      dsRenderDumpPreview();
    }));

  // Shared modal dismissal (backdrop, ✕, Cancel, Esc).
  document.querySelectorAll('.ds-modal').forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target.closest('[data-ds-close]')) m.classList.remove('open');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.ds-modal.open');
    if (open) { open.classList.remove('open'); e.stopPropagation(); }
  }, true);

  dsSetTab(dsTab);
}

init().catch(function(err) {
  console.error('Launcher init failed:', err);
  var ll = document.getElementById('launch-loading');
  if (ll) ll.querySelector('.ll-sub').textContent = 'ERROR — check console';
});
