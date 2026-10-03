// Applies the Pickle Game Library integration layer to Jertal's Blackout build.
// node partners/jertal/blackout/patch.mjs <outFile>   (partners/build.mjs runs it; source/index.html is Jertal's untouched build)
import fs from 'node:fs';
const out = process.argv[2];
let h = fs.readFileSync(new URL('./source/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function rep(from, to) {
  const n = h.split(from).length - 1;
  if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${from.slice(0, 80)}`);
  h = h.replace(from, () => to);
}

// three.js ships with the app in vendor/ (works offline); see CLAUDE.md "Vendored engines". PeerJS stays on the CDN (online-only).
rep(`<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>`, `<script src="./vendor/three-0.128.0/build/three.min.js"></script>`);
for (const f of ['postprocessing/EffectComposer', 'postprocessing/RenderPass', 'postprocessing/ShaderPass', 'shaders/CopyShader', 'shaders/LuminosityHighPassShader', 'postprocessing/UnrealBloomPass'])
  rep(`https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/${f}.js`, `./vendor/three-0.128.0/examples/js/${f}.js`);

// styles: exit button + confirm (the pause panel's look), player chip, and the --ui zoom for the DOM HUD and
// panels on 1440p / 4K (the 3D view fills the window; world-tracked tags/prompts stay unzoomed)
rep(`</style>\n</head>`, `/* Pickle Game Library */
  :root { --ui: 1; }
  #hud-top, #minimap, #noise-meter, #hud-ammo, #hud-help, #net-hud, #dm-hud, #killfeed, #ach-pop, #toast, #prompt,
  #pause .panel, #death .panel, #station .panel, #dm-results .panel, #gl-exit-confirm .panel, #gl-player-chip { zoom: var(--ui); }
  #gl-exit-confirm { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.66);
    font: 17px/1.45 ui-monospace, Consolas, monospace; color: var(--g); cursor: default; z-index: 100; }
  #gl-exit-confirm .panel { position: relative; width: min(460px, calc(100vw - 32px)); box-sizing: border-box; padding: 20px 24px; background: #061008;
    border: 12px solid #2a2d31; border-radius: 16px; box-shadow: inset 0 0 40px rgba(0,0,0,.8), 0 0 0 2px #15171a, 0 20px 60px rgba(0,0,0,.8); }
  #gl-exit-confirm h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: .25em; color: var(--amber); text-shadow: 0 0 8px rgba(242,194,48,.5); }
  #gl-exit-confirm h1::before { content: '> '; color: var(--g); }
  #gl-exit-confirm .info { color: var(--g-dim); margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px dashed var(--line); }
  #gl-exit-confirm .row { display: flex; gap: 10px; }
  #gl-exit-confirm button { flex: 1; padding: 8px 12px; font: 700 17px ui-monospace, Consolas, monospace; letter-spacing: .08em; color: var(--g-hi);
    background: #0f1e12; border: 1px solid #3a6a3a; border-bottom-width: 3px; border-radius: 3px; cursor: pointer; }
  #gl-exit-confirm button:hover, #gl-exit-confirm button:focus-visible { background: var(--g); color: #061008; border-color: var(--g); outline: none; }
  #gl-exit-confirm #gl-exit-yes:hover, #gl-exit-confirm #gl-exit-yes:focus-visible { background: var(--red); border-color: var(--red); }
  #gl-player-chip { position: fixed; top: 14px; left: 16px; z-index: 30; align-items: center; gap: 8px; pointer-events: none; opacity: .8;
    font: 700 14px ui-monospace, Consolas, monospace; letter-spacing: .12em; color: var(--g); text-shadow: var(--glow); }
</style>
</head>`);

// markup + the exit / chip / scale script, BEFORE the game script so its capture keydown runs ahead of the game's
rep(`<div id="debug"></div>\n`, `<div id="debug"></div>
<!-- Pickle Game Library -->
<div id="gl-player-chip" style="display:none"></div>
<div id="gl-exit-confirm" style="display:none"><div class="panel" role="dialog" aria-label="Exit Game">
  <h1>EXIT GAME?</h1>
  <div class="info">Your operator file is saved.</div>
  <div class="row"><button id="gl-exit-no">CANCEL</button><button id="gl-exit-yes">EXIT</button></div>
</div></div>
<script>
(function () {
  var ov = document.getElementById('gl-exit-confirm'), no = document.getElementById('gl-exit-no');
  var open = function () { return ov.style.display !== 'none'; }, hide = function () { ov.style.display = 'none'; };
  window.glExitShow = function () { ov.style.display = 'flex'; no.focus(); };
  no.addEventListener('click', hide);
  document.getElementById('gl-exit-yes').addEventListener('click', function () { window.close(); });
  // clicks on the overlay never reach the game's window mousedown (the terminal under it would take them)
  ['mousedown', 'mouseup', 'click'].forEach(function (t) { ov.addEventListener(t, function (e) { e.stopPropagation(); if (t === 'mousedown' && e.target === ov) hide(); }); });
  // while it is open no key reaches the game; Escape cancels (registered before the game's own capture listeners)
  addEventListener('keydown', function (e) { if (!open()) return; e.stopImmediatePropagation(); if (e.code === 'Escape') { e.preventDefault(); hide(); } }, true);
  addEventListener('keyup', function (e) { if (open()) e.stopImmediatePropagation(); }, true);

  // player chip on the main menu (the security terminal)
  var chip = document.getElementById('gl-player-chip'), chipOn = false;
  try { var q = new URLSearchParams(location.search), nm = (q.get('playerName') || '').trim();
    if (nm) { var em = document.createElement('span'); em.textContent = q.get('playerEmblem') || ''; chip.append(em, ' ' + nm); chipOn = true; } } catch (e) {}
  var chipVis = function () { chip.style.display = chipOn && document.body.classList.contains('in-menu') ? 'inline-flex' : 'none'; };
  new MutationObserver(chipVis).observe(document.body, { attributes: true, attributeFilter: ['class'] }); chipVis();

  // UI scale: the HUD is tuned for 1080p; grow it with the window, 1 at 1080p and below, capped at 2
  var setUi = function () { var s = Math.max(1, Math.min(2, Math.min(innerWidth / 1920, innerHeight / 1080))); document.documentElement.style.setProperty('--ui', String(Math.round(s * 100) / 100)); };
  addEventListener('resize', setUi); setUi();
})();
</script>
`);

// the terminal's QUIT row and the pause menu's QUIT GAME go through the confirm
rep(`act: () => { window.close(); menu.note = 'Press Alt+F4 to quit (or close the tab).'; menu.dirty = true; }, hint:`,
    `act: () => glExitShow(), hint:`);
rep(`document.getElementById('pause-quit').onclick = () => {
  window.close();   // works in the launcher's kiosk window; a normal tab won't let a page close it
  setTimeout(() => { document.getElementById('pause-note').textContent = 'Press Alt+F4 to quit (or close the tab).'; }, 200);
};`, `document.getElementById('pause-quit').onclick = () => glExitShow();`);

// Library room browser (LobbySDK discovery only, pattern 3): a public room is listed on every radio's OPEN ROOMS;
// private = code only (net.priv, default public). The game keeps its own PeerJS netcode; peerId = the bare code.
rep(`const netReady = () => typeof Peer !== 'undefined';\n`, `const netReady = () => typeof Peer !== 'undefined';
const glAd = { h: null, busy: false, code: '' };
function glNetAd() {
  const sdk = window.LobbySDK, want = net.mode === 'host' && !net.priv && net.conns.length < NET_MAX - 1 && sdk && sdk.advertiseRoom ? net.code : '';   // (full rooms drop off the list)
  if (glAd.h && glAd.code !== want) { glAd.h.close(); glAd.h = null; }
  if (want && !glAd.h && !glAd.busy) {
    glAd.busy = true;
    sdk.advertiseRoom('blackout', want).then(h => { glAd.busy = false; glAd.h = h; glAd.code = want; glNetAd(); }, () => { glAd.busy = false; });
  }
}
addEventListener('beforeunload', () => { if (glAd.h) glAd.h.close(); });
function glNetRooms() {   // refetched at most every 8 s while the radio is drawn; redraws when it lands
  const sdk = window.LobbySDK;
  if (!sdk || !sdk.listRooms || net.roomsBusy || performance.now() - (net.roomsT || -1e9) < 8000) return;
  net.roomsBusy = true;
  sdk.listRooms('blackout').then(r => { net.rooms = r; }, () => { net.rooms = null; }).then(() => {
    net.roomsBusy = false; net.roomsT = performance.now(); if (game.ui === 'radio') renderStation(); });
}
`);
rep(`net.mode = 'host'; net.code = code; net.myId = 0;`, `net.mode = 'host'; net.code = code; net.myId = 0; glNetAd();`);
rep(`net.conns.push(conn);`, `net.conns.push(conn); glNetAd();`);
rep(`net.conns = net.conns.filter(c => c !== conn);`, `net.conns = net.conns.filter(c => c !== conn); glNetAd();`);
rep(`Object.assign(net, { mode: 'solo', peer: null, conns: [], host: null, code: '', myId: 0 });`,
    `Object.assign(net, { mode: 'solo', peer: null, conns: [], host: null, code: '', myId: 0 }); glNetAd();`);
rep(`  if (act === 'net-host') { netHost(); return; }`, `  if (act === 'net-vis') { net.priv = !net.priv; glNetAd(); renderStation(); return; }
  if (act === 'net-room') { netJoin(id); return; }
  if (act === 'net-rooms') { net.roomsT = 0; glNetRooms(); return; }
  if (act === 'net-host') { netHost(); return; }`);
// the radio TV: a visibility row (solo and hosting) and OPEN ROOMS (solo)
rep(`  const nameItem = { id: 'name', name: 'Your call sign', mark: '·', right: tvEsc(myName()) };\n`,
    `  const nameItem = { id: 'name', name: 'Your call sign', mark: '·', right: tvEsc(myName()) };
  const visItem = { id: 'vis', name: 'Room visibility', mark: '·', right: net.priv ? 'PRIVATE' : 'PUBLIC', enter: net.priv ? 'make public' : 'make private' };
  if (!inRoom) glNetRooms();
  const rooms = (net.rooms || []).map(r => ({ id: 'r:' + r.peerId, name: \`\${r.hostName}'s room\`, mark: '·', right: tvEsc(r.peerId), enter: 'join' }));
  const roomsGroup = { title: 'OPEN ROOMS', note: net.rooms ? \`\${rooms.length} open\` : net.roomsBusy ? 'looking...' : 'unavailable',
    items: rooms.length ? rooms : [{ id: 'rooms', name: net.rooms ? 'No open rooms' : net.roomsBusy ? 'Looking...' : 'Room list unavailable', mark: '·', cls: 'locked', enter: 'refresh' }] };
`);
rep(`items: [{ id: 'room', name: \`Room \${net.code || '.....'}\`, mark: '►', cls: 'on', right: host ? 'HOSTING' : 'JOINED' }] },`,
    `items: [{ id: 'room', name: \`Room \${net.code || '.....'}\`, mark: '►', cls: 'on', right: host ? 'HOSTING' : 'JOINED' }, ...(host ? [visItem] : [])] },`);
rep(`right: net.joinDraft ? tvEsc(net.joinDraft) : 'enter a code', enter: 'join' }] },\n      { title: 'YOU', items: [nameItem] }];`,
    `right: net.joinDraft ? tvEsc(net.joinDraft) : 'enter a code', enter: 'join' }, visItem] },\n      roomsGroup, { title: 'YOU', items: [nameItem] }];`);
rep(`    if (it.id === 'name') return \`<div class="tv-h">Your call sign</div>\``, `    if (it.id === 'vis') return \`<div class="tv-h">Room visibility</div>\` + tvTags([[net.priv ? 'PRIVATE' : 'PUBLIC', 'amb']]) +
      \`<div class="tv-p">\${net.priv ? 'Private: your room is not listed. Friends join with its code.' : "Public: your room shows under OPEN ROOMS on everyone's radio while it has space. Friends can still use the code."}</div>\` +
      \`<div class="tv-act"><button data-act="net-vis" data-primary>\${net.priv ? 'MAKE PUBLIC' : 'MAKE PRIVATE'}</button></div>\`;
    if (it.id === 'rooms') return \`<div class="tv-h">Open rooms</div><div class="tv-p">Public rooms other players are hosting show here. Host your own, or join a friend's with its code.</div>\` +
      \`<div class="tv-act"><button data-act="net-rooms" data-primary>REFRESH</button></div>\`;
    if (it.id.startsWith('r:')) { const r = (net.rooms || []).find(x => 'r:' + x.peerId === it.id) || { hostName: '?', peerId: it.id.slice(2) };
      return \`<div class="tv-h">\${tvEsc(r.hostName)}'s room</div>\` + tvTags([['OPEN', 'amb'], 'PUBLIC']) + tvKv('CODE', tvEsc(r.peerId)) + tvKv('GAME VERSION', NET_VERSION) +
        \`<div class="tv-note">Everyone needs the same version of the game.</div><div class="tv-act"><button data-act="net-room" data-id="\${tvEsc(r.peerId)}" data-primary>JOIN</button><button data-act="net-rooms">REFRESH</button></div>\`; }
    if (it.id === 'name') return \`<div class="tv-h">Your call sign</div>\``);

// stats & achievements: derived from the operator file every time the game saves it, so they back-fill from
// an existing save. Max across the three files (keepMax). dmWins is already counted only for the local winner.
const GLUE = `<script>
/* Pickle Game Library: stats & achievements */
(function () {
  var last = {};
  function stat(S, k, v) { if (last[k] === v) return; last[k] = v; S.setStat(k, v, true); }
  function glSync() {
    var S = window.GameSDK;
    if (!S || !meta || !meta.stats || (net && net.viewingHost)) return;   // (viewing a co-op host's bunker: that's their file)
    try {
      var s = meta.stats, A = meta.achievements || {}, n = Object.keys(A).length;
      stat(S, 'total_runs', s.runs || 0);
      stat(S, 'escapes', s.escapes || 0);
      stat(S, 'total_kills', s.kills || 0);
      stat(S, 'missions_done', s.missions || 0);
      stat(S, 'achievements_earned', n);
      stat(S, 'online_wins', s.dmWins || 0);
      if ((s.escapes || 0) >= 1) S.unlockAchievement('first_escape', 'Clocked Out');
      if ((s.escapes || 0) >= 5) S.unlockAchievement('old_hand', 'Old Hand');
      if ((s.escapesBrutal || 0) >= 1) S.unlockAchievement('graveyard_shift', 'Graveyard Shift');
      if (A.o_clean) S.unlockAchievement('clean_hands', 'Clean Hands');
      if (A.m_zero) S.unlockAchievement('patient_zero', 'Patient Zero');
      if (A.m_heart) S.unlockAchievement('heartbreaker', 'Heartbreaker');
      if ((s.kills || 0) >= 200) S.unlockAchievement('exterminator', 'Exterminator');
      if (A.a_all) S.unlockAchievement('facility_map', 'Facility Map');
      if (A.b_all) S.unlockAchievement('back_in_business', 'Back in Business');
      if (A.w_arsenal) S.unlockAchievement('arsenal', 'Arsenal');
      if (n >= 30) S.unlockAchievement('trophy_case', 'Trophy Case');
    } catch (e) {}
  }
  var save = saveMeta;
  saveMeta = function () { var r = save.apply(this, arguments); glSync(); return r; };
  glSync();
})();
</script>
`;
rep(`</script>\n</body>\n</html>`, `</script>\n${GLUE}</body>\n</html>`);

if (!h.trimEnd().endsWith('</html>') || h.split('</html>').length !== 2) throw new Error('bad tail');
fs.writeFileSync(out, h);
console.log('ok', h.length);
