// renderer.js — Game Library launcher logic
'use strict';

const api = window.electronAPI;
let allGames = [];
let globalAchievementDefs = [];
let currentGameId = null;
let activeParty = 'all';
let activeTag = 'all';
let activeDev = 'all';
let launchTime = null;
let launchingGameId = null;
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

  // External (on-demand) games: detect which are already downloaded (in parallel)
  await Promise.all(allGames.filter(g => g.external).map(async g => {
    try { installedExternal[g.id] = await api.isGameInstalled(g.fileName); }
    catch { installedExternal[g.id] = false; }
  }));
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
    const id = gameId || launchingGameId;
    if (id && launchTime) {
      const elapsed = Math.floor((Date.now() - launchTime) / 1000);
      const key = `gl_${id}_playtime`;
      const prev = parseInt(localStorage.getItem(key) || '0', 10);
      persistKey(key, String(prev + elapsed));
      launchTime = null;
      launchingGameId = null;
    }
    // A game session may have completed all achievements; re-render the grid so
    // the gold "100%" banner appears immediately instead of only after relaunch.
    renderGrid();
    if (currentGameId) refreshInfoModal(currentGameId);
  });

  // Real-time stat refresh: fires whenever a game syncs localStorage to the launcher
  window.addEventListener('game-storage-sync', (e) => {
    const key = e.detail && e.detail.key;
    if (!key) return;
    // Refresh stats panel if the synced key belongs to the currently open game modal
    if (currentGameId && (key === `gl_${currentGameId}_stats` || key === `gl_${currentGameId}_achievements`)) {
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
  const bar = document.getElementById('filter-bar');
  bar.querySelectorAll('[data-filter="tag"]:not([data-value="all"])').forEach(b => b.remove());
  [...tags].sort((a, b) => a === 'WIP' ? 1 : b === 'WIP' ? -1 : 0).forEach(tag => {
    const btn = document.createElement('button');
    btn.className = 'filter-chip';
    btn.dataset.filter = 'tag';
    btn.dataset.value = tag;
    btn.textContent = tag;
    bar.appendChild(btn);
  });
}

// ── Developer filter builder ───────────────────────────────────
function buildDevFilters() {
  const row = document.getElementById('filter-dev-row');
  if (!row) return;
  const devs = [...new Set(
    allGames.filter(g => g.party === 'third' && g.developer).map(g => g.developer)
  )].sort();
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
function isAllAchievementsUnlocked(game) {
  if (!game.achievements || game.achievements.length === 0) return false;
  const unlocked = readAchievements(game.id);
  return game.achievements.every(a => unlocked[a.id]);
}

function gameCardHTML(g) {
  const gold = isAllAchievementsUnlocked(g) ? ' card-gold' : '';
  const isWIP = (g.tags || []).includes('WIP');
  const nonWipTags = (g.tags || []).filter(t => t !== 'WIP');
  let visibleTagList;
  if (nonWipTags.includes('Multiplayer')) {
    const others = nonWipTags.filter(t => t !== 'Multiplayer').slice(0, 2);
    visibleTagList = [...others, 'Multiplayer'];
  } else {
    visibleTagList = nonWipTags.slice(0, 3);
  }
  const visibleTags = visibleTagList.map(t => `<span class="card-tag">${t}</span>`).join('');
  const needsInstall = g.external && !installedExternal[g.id];
  const playLabel = needsInstall ? '⬇ Install' : '▶ Play';
  const wipBar = isWIP ? `<div class="card-wip-bar">🚧 UNDER CONSTRUCTION 🚧</div>` : '';
  const goldBanner = gold ? `<div class="gold-banner"><span class="banner-trophy">🏆</span><span class="banner-text"> 100%</span></div>` : '';
  return `<div class="game-card${gold}" data-id="${g.id}">
    <div class="card-cover">
      <img src="covers://${g.id}.svg${(coverVersions[g.id] || g.coverVersion) ? '?v='+(coverVersions[g.id] || g.coverVersion) : ''}" alt="${g.title}" loading="lazy" onerror="if(this.src.indexOf('.svg')>-1){this.src='covers://${g.id}.png'}else{this.style.display='none'}">
      ${goldBanner}${wipBar}
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
    if (activeParty !== 'all' && g.party !== activeParty) return false;
    if (activeDev !== 'all' && g.developer !== activeDev) return false;
    if (activeTag !== 'all' && !(g.tags||[]).includes(activeTag)) return false;
    if (search) {
      const inTitle = g.title.toLowerCase().includes(search);
      const inDesc  = (g.description || '').toLowerCase().includes(search);
      if (!inTitle && !inDesc) return false;
    }
    return true;
  };

  // WIP games appear in main grid like any other game
  let mainGames = allGames.filter(g => passesFilters(g)).reverse();

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
  const partyNames = { all: 'All Games', first: 'Pickle Originals', third: 'Non-Pickle Games', imported: 'Imported' };
  let label = partyNames[activeParty] || 'All Games';
  if (activeTag !== 'all') label += ` · ${activeTag}`;
  const btn = document.getElementById('filter-btn');
  if (btn) {
    btn.textContent = `🏷 ${label} ▾`;
    btn.classList.toggle('active', activeParty !== 'all' || activeTag !== 'all');
  }
}

// ── Persist launcher-side localStorage to playerdata.json ─────
function persistKey(key, value) {
  try { localStorage.setItem(key, value); } catch {}
  if (api.syncLauncherStorage) api.syncLauncherStorage(key, value);
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
        : '▾ See all patch notes (' + releases.length + ')';
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

  // Panel open by default
  const _filterBtn   = document.getElementById('filter-btn');
  const _filterPanel = document.getElementById('filter-panel');

  // Panel starts open
  _filterBtn.classList.add('tab-open');

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
      if (devRow) devRow.style.display = activeParty === 'third' ? 'flex' : 'none';
      if (activeParty !== 'third') {
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
    _ctxMenu.style.left = x + 'px';
    _ctxMenu.style.top  = y + 'px';
    _ctxMenu.classList.add('open');
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
    const fav = isFavorite(_ctxGameId);
    document.getElementById('ctx-fav-label').textContent = fav ? 'Remove from Favorites' : 'Add to Favorites';
    const x = Math.min(e.clientX, window.innerWidth  - 190);
    const y = Math.min(e.clientY, window.innerHeight - 130);
    openCtxMenu(x, y);
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

  const ALL_TAGS = ['Action', 'Strategy', 'Roguelite', 'Platformer', 'Battle', 'Casual', 'Puzzle', 'Horror', 'RPG', 'Multiplayer', 'Single Player', 'WIP'];

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
    document.getElementById('modal-tag-opts').innerHTML = ALL_TAGS.map(t =>
      `<button class="tag-opt${(game.tags||[]).includes(t) ? ' selected' : ''}" data-tag="${t}">${t}</button>`
    ).join('');
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
    document.getElementById('modal-tags').innerHTML = (game.tags||[]).slice().sort((a,b) => a==='WIP'?1:b==='WIP'?-1:0).map(t => `<span class="modal-tag">${t}</span>`).join('');
    exitEditMode();
  });

  document.getElementById('modal-discard-btn').addEventListener('click', () => {
    const game = allGames.find(g => g.id === currentGameId);
    // Restore displayed values from the unchanged game object (nothing was committed).
    if (game) {
      document.getElementById('modal-title').textContent = game.title || '';
      document.getElementById('modal-desc').textContent = game.description || '';
      document.getElementById('modal-tags').innerHTML = (game.tags||[]).slice().sort((a,b) => a==='WIP'?1:b==='WIP'?-1:0).map(t => `<span class="modal-tag">${t}</span>`).join('');
    }
    exitEditMode();
  });

  document.getElementById('modal-delete-btn').addEventListener('click', async () => {
    const game = allGames.find(g => g.id === currentGameId);
    if (!game || game.party !== 'imported') return;
    if (!confirm(`Remove "${game.title}" from your library?`)) return;
    const gid = game.id;
    // Clear all launcher localStorage data for this game
    localStorage.removeItem(`gl_${gid}_stats`);
    localStorage.removeItem(`gl_${gid}_achievements`);
    localStorage.removeItem(`gl_${gid}_playtime`);
    try {
      const ga = JSON.parse(localStorage.getItem('gl_global_achievements') || '{}');
      Object.keys(ga).forEach(k => { if (k.startsWith(`${gid}::`)) delete ga[k]; });
      persistKey('gl_global_achievements', JSON.stringify(ga));
    } catch {}
    let recent = JSON.parse(localStorage.getItem('gl_recently_played') || '[]');
    recent = recent.filter(id => id !== gid);
    persistKey('gl_recently_played', JSON.stringify(recent));
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
  const SHARE_URL = 'https://github.com/nicgardiner/pickle-arcade/releases';

  function openShareModal() {
    if (shareModal) shareModal.classList.add('open');
    SFX.open();
  }
  function closeShareModal() {
    if (shareModal) shareModal.classList.remove('open');
  }

  if (shareBtn) shareBtn.addEventListener('click', openShareModal);
  if (shareClose) shareClose.addEventListener('click', closeShareModal);
  if (shareBackdrop) shareBackdrop.addEventListener('click', closeShareModal);
  if (shCopyBtn) shCopyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(SHARE_URL).then(() => {
      shCopyBtn.textContent = '✓ Copied!';
      if (shCopyStatus) shCopyStatus.textContent = 'Link copied to clipboard!';
      setTimeout(() => {
        shCopyBtn.textContent = 'Copy Link';
        if (shCopyStatus) shCopyStatus.textContent = '';
      }, 2500);
    }).catch(() => {
      if (shCopyStatus) shCopyStatus.textContent = 'Could not copy — select the link manually.';
    });
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
    if (delBtn) { e.stopPropagation(); deleteCoverListItem(delBtn.dataset.del); return; }
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
}

// ── Game launching ────────────────────────────────────────────
async function launchGame(id) {
  const game = allGames.find(g => g.id === id);
  if (!game) return;
  // External (on-demand) game that isn't downloaded yet → run the install flow instead.
  if (game.external && !installedExternal[id]) { installExternalGame(game); return; }
  SFX.launch();
  closeInfoModal();
  launchTime = Date.now();
  launchingGameId = id;
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

  document.getElementById('modal-title').textContent = game.title;
  document.getElementById('modal-desc').textContent = game.description || '';

  const partyEl = document.getElementById('modal-party');
  const thirdLabel = game.developer ? `◇ Made by ${game.developer}` : '◇ Non-Pickle Game';
  const partyMap = { first: ['◆ Pickle Original', 'party-first'], third: [thirdLabel, 'party-third'], imported: ['📥 Imported', 'party-imported'] };
  const [partyLabel, partyCls] = partyMap[game.party] || [thirdLabel, 'party-third'];
  partyEl.textContent = partyLabel;
  partyEl.className = 'party-badge ' + partyCls;

  document.getElementById('modal-tags').innerHTML = (game.tags||[]).slice().sort((a,b) => a==='WIP'?1:b==='WIP'?-1:0).map(t => `<span class="modal-tag">${t}</span>`).join('');
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
  coverWrap.innerHTML = `<img src="covers://${id}.svg${_cv ? '?v='+_cv : ''}" alt="${game.title}" onerror="if(this.src.indexOf('.svg')>-1){this.src='covers://${id}.png'}else{this.style.display='none'}">`;

  refreshInfoModal(id);

  // Imported games have no achievements — hide that tab and force Stats active.
  const achTab = document.querySelector('.modal-tab[data-tab="achievements"]');
  if (achTab) achTab.style.display = game.party === 'imported' ? 'none' : '';
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'stats'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-stats'));
  document.querySelector('.modal-body').dataset.tab = 'stats';

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
    if (val === undefined || val === null) val = 0;
    let display;
    if (def.format === 'seconds') display = val + 's';
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
      const ONLINE_GAMES = ['chess', 'checkers', 'connect4', 'battleship', 'ultimate-tic-tac-toe', 'poke_clash_v7'];
      return ONLINE_GAMES.some(gameId => {
        try {
          const stats = JSON.parse(localStorage.getItem(`gl_${gameId}_stats`) || '{}');
          return parseInt(stats.online_wins || '0') > 0;
        } catch {
          return false;
        }
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
    body.innerHTML = '<div class="modal-tabs"><button class="modal-tab active" data-tab="stats">📊 Stats</button><button class="modal-tab" data-tab="achievements">🏆 Achievements</button></div><div class="tab-pane active" id="tab-stats"></div><div class="tab-pane" id="tab-achievements"></div>';
    body.dataset.tab = 'stats';
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
const NATIVE_COVER_NAMES = { default: 'Default', minimalist: 'Minimalist' };

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
  // Built-in native variants first, in a sensible order
  ['default', 'minimalist'].forEach(k => {
    if (variantFiles.includes(k)) entries.push({ id: k, name: NATIVE_COVER_NAMES[k], builtin: true });
  });
  // Custom covers (from metadata, only those whose files exist on disk)
  (game.customCovers || []).forEach(cc => {
    if (variantFiles.includes(cc.id)) entries.push({ id: cc.id, name: cc.name, builtin: false });
  });
  coverListEntries = entries;
}

function renderCoverList(game) {
  const list = document.getElementById('cv-cover-list');
  if (!list) return;
  const canDelete = coverListEntries.length > 1; // never delete the only remaining cover
  list.innerHTML = coverListEntries.map(e => {
    const sel = e.id === coverListSelected ? ' selected' : '';
    const activeMark = e.id === game.activeCoverType ? '<span class="cv-list-active" title="Currently active">✓</span>' : '';
    const del = (!e.builtin && canDelete)
      ? `<button class="cv-list-del" data-del="${e.id}" title="Delete cover">🗑️</button>` : '';
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
    `<img src="covers://${game.id}.${variantId}.svg?v=${v}" alt="${entry ? entry.name : ''}" onerror="this.src='covers://${game.id}.svg?v=${v}'">`;
  document.getElementById('cover-preview-label').textContent = entry ? entry.name : 'Cover';
}

// "Choose Cover" — commit the highlighted variant as the active cover and close.
async function confirmCoverChoice() {
  if (!coverGameId || !coverListSelected) return;
  const game = allGames.find(g => g.id === coverGameId);
  if (!game) return;
  await api.selectNativeCover(coverGameId, coverListSelected); // copies variant → active .svg
  game.activeCoverType = coverListSelected;
  coverVersions[coverGameId] = Date.now();
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
      await api.selectNativeCover(game.id, fallback);
      game.activeCoverType = fallback;
      coverVersions[game.id] = Date.now();
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
  await api.selectNativeCover(coverGameId, 'default');
  const game = allGames.find(function(g) { return g.id === coverGameId; });
  if (game) game.activeCoverType = 'default';
  coverVersions[coverGameId] = Date.now();
  await api.saveGames(allGames);
  renderGrid();
  renderRecentlyPlayed();
  renderFavorites();
  closeCoverModal();
}

function updateCustomizePanelState() {
  const saved = localStorage.getItem('gl_cover_style') || '';
  document.getElementById('cust-opt-default').classList.toggle('active', saved === 'default' || saved === '');
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
  const sizes = { sm: '140px', md: '160px', lg: '200px' };
  document.documentElement.style.setProperty('--card-w', sizes[size] || '160px');
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
  for (const g of allGames) {
    if (!g.imported) {
      coverVersions[g.id] = Date.now();
      await window.electronAPI.selectNativeCover(g.id, style).catch(() => {});
    }
  }
  renderGrid();
  renderRecentlyPlayed();
  renderFavorites();
  updateCustomizePanelState();
}

init().catch(function(err) {
  console.error('Launcher init failed:', err);
  var ll = document.getElementById('launch-loading');
  if (ll) ll.querySelector('.ll-sub').textContent = 'ERROR — check console';
});
