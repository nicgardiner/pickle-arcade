// Applies the Pickle Game Library integration layer to Jertal's Roblins build.
// node partners/jertal/roblins/patch.mjs <outFile>   (partners/build.mjs runs it)
// (source/ holds Jertal's untouched index.html, data.js and sim.js; the two scripts are inlined so the game is one file)
import fs from 'node:fs';
const out = process.argv[2];
const read = f => fs.readFileSync(new URL('./source/' + f, import.meta.url), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
let h = read('index.html');

function rep(from, to) {
  const n = h.split(from).length - 1;
  if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${from.slice(0, 80)}`);
  h = h.replace(from, () => to);
}

// data.js + sim.js inline (the launcher and the website ship one HTML file per game)
for (const f of ['data.js', 'sim.js']) {
  const js = read(f);
  if (/<\/script/i.test(js)) throw new Error(`${f} contains </script`);
  rep(`<script src="${f}"></script>`, `<script>/* ${f} */\n${js}\n</script>`);
}

// three.js ships with the app in vendor/ (works offline); see CLAUDE.md "Vendored engines". PeerJS stays on the CDN (online-only).
rep(`<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>`, `<script src="./vendor/three-0.128.0/build/three.min.js"></script>`);

// ---- bug fixes in Jertal's code (review 2026-10-02; listed in DEVLOG.md to pass on). If a new drop fixes one, its anchor
// stops matching and rep() throws: delete that fix.
// monsters: a monster standing in a blocking prop's cell (it walked into a blocked goal cell) found no path out and froze
rep(`function flowField(w, target, height, mode) {`, `function flowField(w, target, height, mode, from) {`);
rep(`if (dist[n] >= 0 || (g.block[n] && mode !== 'fly') || !monsterCell(w, n, height, mode) || !monsterEdge(w, g, n, c, mode)) continue;`,
    `if (dist[n] >= 0 || (n !== from && ((g.block[n] && mode !== 'fly') || !monsterCell(w, n, height, mode))) || !monsterEdge(w, g, n, c, mode)) continue;`);
rep(`m.flow = flowField(w, c, height, mode); }`, `m.flow = flowField(w, c, height, mode, cellAt(w, m.x, m.z)); }`);
// the Ranger's arrow hit through walls and shut doors (its aim follows sounds during the draw)
rep(`if (!hit && Math.hypot(p.x - m.aim.x, p.z - m.aim.z) < R.arrowHitRadius) hit = p;`,
    `if (!hit && Math.hypot(p.x - m.aim.x, p.z - m.aim.z) < R.arrowHitRadius && lineOfSight(w, m.x, m.z, p.x, p.z)) hit = p;`);
// two crabs could carry the same item (it teleported between them)
rep(`if (!it2.handled || it2.gone || it2.holder !== null || it2.flying || it2.inCube != null || it2.inCart || it2.tool) return;`,
    `if (!it2.handled || it2.gone || it2.holder !== null || it2.flying || it2.inCube != null || it2.inCart || it2.tool) return;
      if (state.monsters.some(function (o) { return o !== m && !o.dead && o.carry === it2.id; })) return; // another crab has it`);
// noise sounds longer than ~0.5-2 s were cut off (and clicked): a 2 s one-shot buffer started at a random offset
rep(`g.connect(dry); g.connect(send || reverb);\n      s.start(t, Math.random() * 1.5, dur + 0.05);`, `g.connect(dry); g.connect(send || reverb);\n      s.loop = true; s.start(t, Math.random() * 1.5, dur + 0.05);`);
rep(`g.connect(out); s.start(t, Math.random() * 1.5, dur + 0.05);`, `g.connect(out); s.loop = true; s.start(t, Math.random() * 1.5, dur + 0.05);`);
// GPU leaks: Spore Phantom models and Ranger arrows were removed without disposing their geometry
rep(`view.group.remove(phantomViews[id].group); delete phantomViews[id];`, `view.group.remove(phantomViews[id].group); disposeTree(phantomViews[id].group); delete phantomViews[id];`);
rep(`arrows.forEach(function (a) { scene.remove(a.g); }); arrows = [];`, `arrows.forEach(function (a) { scene.remove(a.g); disposeTree(a.g); }); arrows = [];`);
// microphones left live: turning the Ranger mic off never stopped its stream (each off/on leaked one), and leaving a crew
// or unticking voice chat kept the voice mic open (the OS mic light stayed on)
rep(`function disableMic() { micAnalyser = null; }`, `function disableMic() { if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; micAnalyser = null; }`);
rep(`micStream = stream;`, `disableMic(); micStream = stream;`);
rep(`    speaking: function (pid) {`, `    stop: function () { Object.keys(Voice.peers).forEach(Voice.drop); if (Voice.stream) Voice.stream.getTracks().forEach(function (tr) { tr.stop(); }); Voice.stream = null; Voice.analyser = null; Voice.out = null; Voice.failed = false; },
    speaking: function (pid) {`);
rep(`var t = crew.transport; crew = null;\n    Object.keys(Voice.peers).forEach(Voice.drop);`, `var t = crew.transport; crew = null;\n    Voice.stop();`);
rep(`if (!this.checked) Object.keys(Voice.peers).forEach(Voice.drop);`, `if (!this.checked) Voice.stop();`);
// a denied/missing voice mic was asked for again on every incoming ring (every 10 s)
rep(`if (Voice.out || Voice.starting || !ctx) { if (done) done(!!Voice.out); return; }`, `if (Voice.out || Voice.starting || Voice.failed || !ctx) { if (done) done(!!Voice.out); return; }`);
// goblins who joined while the host sat on the title screen dropped the roster (no pid yet) and never got it again: no voice
rep(`else crew.transport.send(k, { t: 'place', camp: link.state.campaign, place: link.world.tombId });\n    }`,
    `else crew.transport.send(k, { t: 'place', camp: link.state.campaign, place: link.world.tombId });\n    }\n    sendRoster();`);
// a goblin waiting to be welcomed into a crew could still start a solo night, which then saved nothing
rep(`  function begin(camp) {\n`, `  function begin(camp) {\n    if (crew && crew.role === 'client') { $('error').textContent = 'Waiting for the host to start the night.'; return; }\n`);

// ---- improvements (2026-10-03, Nic's picks from the review)
// a pending crew join says when it's aboard, and can be cancelled (it used to need a reload)
rep(`<p id="crewInfo" class="crewinfo" title="Click to copy the code"></p>`,
    `<p id="crewInfo" class="crewinfo" title="Click to copy the code"></p>\n      <button id="crewCancel" type="button" class="secondary" hidden>Cancel</button>`);
rep(`$('crewInfo').textContent = 'Looking for crew ' + code + '…';`, `$('crewInfo').textContent = 'Looking for crew ' + code + '…'; pendingUi(true);`);
rep(`if (msg.t === 'full') { $('crewInfo').textContent = 'That crew is full (4 goblins).';`, `if (msg.t === 'full') { pendingUi(false); $('crewInfo').textContent = 'That crew is full (4 goblins).';`);
rep(`if (msg.t === 'welcome') { crew.pid = msg.pid;`, `if (msg.t === 'welcome') { crew.pid = msg.pid; pendingUi(false);`);
rep(`t.join(code, function () {}, function (err) {`,
    `t.join(code, function () { if (crew && crew.transport === t && !crew.pid) $('crewInfo').textContent = 'Aboard crew ' + code + '. Waiting for the host to start the night.'; }, function (err) {`);
rep(`if (t.peer) t.peer.destroy(); if (t.bc) t.bc.close();\n      crew = null;`, `if (t.peer) t.peer.destroy(); if (t.bc) t.bc.close();\n      crew = null; pendingUi(false);`);
rep(`  function leaveCrew() {\n    if (!crew) return;`, `  // while a join waits for the host: only Cancel (Host and Join would do nothing)
  function pendingUi(on) { $('crewCancel').hidden = !on; $('crewHost').hidden = on; $('crewJoin').hidden = on || running; }
  $('crewCancel').addEventListener('click', function () { leaveCrew(); });
  function leaveCrew() {
    if (!crew) return;
    pendingUi(false);`);
// the Frenzy tag was dead (state.frenzy is never set): show it on a Frenzy day at Craig's and over the clouds, when it matters
rep(`<div id="frenzyTag" hidden>Frenzy · tonight's haul pays 150%</div>`, `<div id="frenzyTag" hidden>Frenzy · last night's haul pays 150%</div>`);
rep(`$('frenzyTag').hidden = !st.frenzy;`, `$('frenzyTag').hidden = !((st.sky || st.warren) && st.terms && st.terms.frenzy);`);
// records from an older build missing a field threw on the first sale/death (and skipped the campaign save after it)
rep(`      r.running = r.running || {};\n      return r;`, `      r.running = r.running || {}; r.best = r.best || {}; r.campaigns = Array.isArray(r.campaigns) ? r.campaigns : [];
      r.totals = r.totals || {}; ['campaigns', 'nights', 'deaths', 'earned'].forEach(function (k) { r.totals[k] = r.totals[k] || 0; });
      ['causes', 'tombs', 'sold'].forEach(function (k) { r.totals[k] = r.totals[k] || {}; });
      return r;`);
// PeerJS broker drop (wifi blip, sleep): reconnect, or nobody new can join the code and voice calls can't ring
const RECONNECT = `this.peer.on('disconnected', function () { setTimeout(function () { if (crew && crew.transport === self && self.peer && !self.peer.destroyed && self.peer.disconnected) self.peer.reconnect(); }, 2000); });\n    `;
rep(`this.peer.on('open', function () { ready(); });`, `${RECONNECT}this.peer.on('open', function () { ready(); });`);
rep(`this.peer.on('error', function (e) { fail(e.type === 'peer-unavailable'`, `${RECONNECT}this.peer.on('error', function (e) { fail(e.type === 'peer-unavailable'`);
// a host that lost its network without closing left its crew frozen until WebRTC gave up (if ever): 12 s of silence = gone
rep(`    this.snapAge = (this.snapAge || 0) + dt;\n`, `    this.snapAge = (this.snapAge || 0) + dt;
    if (this.snapAge > 12 && !this.stale && crew && crew.role === 'client' && crew.transport.onLeave) { crew.transport.onLeave('host'); return []; }\n`);
// item models: built once per kind and cloned (clones share geometry + materials), instead of fresh geometry for every
// piece in every hold/deck/hand/shop rebuild; the shared geometry is never disposed
rep(`  function makeItemMesh(defId) {\n`, `  var itemProto = {};
  function makeItemMesh(defId) {
    var p = itemProto[defId];
    if (!p) { p = itemProto[defId] = buildItemMesh(defId); p.traverse(function (o) { if (o.geometry) o.geometry.userData.keep = true; }); }
    return p.clone();
  }
  function buildItemMesh(defId) {\n`);
rep(`function disposeTree(obj) { obj.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }`,
    `function disposeTree(obj) { obj.traverse(function (o) { if (o.geometry && !o.geometry.userData.keep) o.geometry.dispose(); }); }`);
rep(`          if (o.geometry) o.geometry.dispose();\n          if (o.isInstancedMesh`, `          if (o.geometry && !o.geometry.userData.keep) o.geometry.dispose();\n          if (o.isInstancedMesh`);

// styles: exit confirm (one of the sign's pages), player chip, and the --ui zoom for the DOM HUD and the
// title sign on 1440p / 4K (the 3D view fills the window; the HUD and sign are fixed px, capped clamp()s)
rep(`</style>\n</head>`, `/* Pickle Game Library */
:root { --ui: 1; }
/* (#bars, #holdBar, #micMeter are pixel canvases the game already sizes with its own pixScale(): not zoomed) */
#where, #clockBox, #prompt, #caption, #load, #slots, #stance, #tapeOsd, #spectate, #death > div, #goldPop,
#menu .sign, #menu .pages, #menu .hint, #gl-exit-confirm .page, #gl-player-chip { zoom: var(--ui); }
.page { max-height: calc((100vh - clamp(56px, 14vh, 144px)) / var(--ui)); }
#gl-exit-confirm { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(4, 6, 14, 0.6); z-index: 100; }
#gl-exit-confirm .page { width: min(440px, calc(100vw - 32px)); max-height: none; animation: none; }
#gl-exit-confirm .row { margin: 6px 0 0; }
#gl-exit-confirm .row button { flex: 1; font-family: var(--display); font-size: 26px; }
#gl-exit-confirm #gl-exit-yes:hover, #gl-exit-confirm #gl-exit-yes:focus-visible { border-color: var(--blood); color: #ffb3a8; }
#crewCancel { margin-top: 14px; }
.crewrooms { margin: 0 0 10px; font-size: 17px; color: var(--muted); }
.crewrooms button.secondary { font-size: 20px; }
#gl-player-chip { position: fixed; top: 16px; right: 20px; z-index: 5; align-items: center; gap: 8px; pointer-events: none; opacity: 0.8;
  font-family: var(--mono); font-size: 15px; letter-spacing: 0.06em; color: var(--paint); text-shadow: 2px 2px 0 #000; }
</style>
</head>`);

// markup + the exit / chip / P / scale script, BEFORE the game scripts so its capture keydown runs ahead of the game's
rep(`\n<script src="./vendor/three-0.128.0/build/three.min.js"></script>`, `
<!-- Pickle Game Library -->
<div id="gl-player-chip" style="display:none"></div>
<div id="gl-exit-confirm" style="display:none"><section class="page" role="dialog" aria-label="Exit Game">
  <h2>Exit Game?</h2>
  <p class="blurb">Your campaign is saved as it stood when this day began.</p>
  <div class="row"><button id="gl-exit-no" type="button">Cancel</button><button id="gl-exit-yes" type="button">Exit</button></div>
</section></div>
<script>
(function () {
  var ov = document.getElementById('gl-exit-confirm'), no = document.getElementById('gl-exit-no');
  var open = function () { return ov.style.display !== 'none'; }, hide = function () { ov.style.display = 'none'; };
  window.glExitShow = function () { ov.style.display = 'flex'; no.focus(); };
  no.addEventListener('click', hide);
  document.getElementById('gl-exit-yes').addEventListener('click', function () { window.close(); });
  ov.addEventListener('mousedown', function (e) { if (e.target === ov) hide(); });
  // while it is open no key reaches the game; Escape cancels (registered before the game's own listeners)
  addEventListener('keydown', function (e) { if (!open()) return; e.stopImmediatePropagation(); if (e.code === 'Escape') { e.preventDefault(); hide(); } }, true);
  addEventListener('keyup', function (e) { if (open()) e.stopImmediatePropagation(); }, true);

  // P pauses like Esc (Esc releases the pointer lock, which is the game's pause) and resumes like "Back to the job"
  addEventListener('keydown', function (e) {
    if (e.code !== 'KeyP' || e.repeat || open()) return;
    var t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    var menu = document.getElementById('menu'), resume = document.getElementById('resume');
    if (document.pointerLockElement) document.exitPointerLock();
    else if (!menu.hidden && menu.classList.contains('paused') && !resume.hidden) resume.click();
  });

  // player chip on the title sign (not over the paused night)
  var chip = document.getElementById('gl-player-chip'), chipOn = false;
  try { var q = new URLSearchParams(location.search), nm = (q.get('playerName') || '').trim();
    if (nm) { var em = document.createElement('span'); em.textContent = q.get('playerEmblem') || ''; chip.append(em, ' ' + nm); chipOn = true; } } catch (e) {}
  var chipVis = function () { var m = document.getElementById('menu'); chip.style.display = chipOn && m && !m.hidden && !m.classList.contains('paused') ? 'inline-flex' : 'none'; };
  addEventListener('DOMContentLoaded', function () {
    new MutationObserver(chipVis).observe(document.getElementById('menu'), { attributes: true, attributeFilter: ['class', 'hidden'] }); chipVis();
  });

  // UI scale: the HUD is tuned for 1080p; grow it with the window, 1 at 1080p and below, capped at 2
  var setUi = function () { var s = Math.max(1, Math.min(2, Math.min(innerWidth / 1920, innerHeight / 1080))); document.documentElement.style.setProperty('--ui', String(Math.round(s * 100) / 100)); };
  addEventListener('resize', setUi); setUi();
})();
</script>
<script src="./vendor/three-0.128.0/build/three.min.js"></script>`);

// the title sign's Quit plank goes through the confirm
rep(`  $('quit').addEventListener('click', function () {\n    running = false;`,
    `  $('quit').addEventListener('click', function () {\n    if (window.glExitShow) return glExitShow();\n    running = false;`);

// stats & achievements: re-derived from the game's own saves (records + cosmetics) every time it writes them
rep(`save: function (r) { try { localStorage.setItem('gobjob.records', JSON.stringify(r)); } catch (e) { /* ignore */ } },`,
    `save: function (r) { try { localStorage.setItem('gobjob.records', JSON.stringify(r)); } catch (e) { /* ignore */ } if (window.glSync) glSync(); },`);
rep(`try { localStorage.setItem('gobjob.unlocks', JSON.stringify(u)); } catch (e) { /* ignore */ }`,
    `try { localStorage.setItem('gobjob.unlocks', JSON.stringify(u)); } catch (e) { /* ignore */ } if (window.glSync) glSync();`);

// Library room browser (LobbySDK discovery only, pattern 3): a public crew is listed under "Open crews"; private =
// code only. The game keeps its own PeerJS crew netcode; the listing's peerId is the bare 5-letter code.
rep(`<button id="host" type="button" class="secondary">Host a crew</button>\n      </div>`,
    `<button id="host" type="button" class="secondary">Host a crew</button>\n      </div>
      <label class="lessons" id="crewPublicRow"><input type="checkbox" id="crewPublic" checked> Public crew <small>listed under Open crews for anyone to join. Off: friends need the code.</small></label>`);
rep(`<button id="join" type="button">Join</button></div>\n      </div>`,
    `<button id="join" type="button">Join</button></div>
        <div id="crewBrowse" hidden><label class="lbl">Open crews</label><div id="crewRooms" class="crewrooms"></div><button id="crewRefresh" type="button">Refresh</button></div>
      </div>`);
rep(`  function showCrew() {\n`, `  var glAdH = null, glAdBusy = false, glAdCode = '';
  function glAd() {
    $('crewPublicRow').hidden = !!crew && crew.role !== 'host';
    var want = crew && crew.role === 'host' && crew.live && $('crewPublic').checked && Object.keys(crew.peers).length < 3 &&
      NET_KIND === 'peer' && window.LobbySDK && LobbySDK.advertiseRoom ? crew.code : '';   // (full crews drop off the list)
    if (glAdH && glAdCode !== want) { glAdH.close(); glAdH = null; }
    if (want && !glAdH && !glAdBusy) {
      glAdBusy = true;
      LobbySDK.advertiseRoom('roblins', want).then(function (h) { glAdBusy = false; glAdH = h; glAdCode = want; glAd(); }, function () { glAdBusy = false; });
    }
  }
  addEventListener('beforeunload', function () { if (glAdH) glAdH.close(); });
  $('crewPublic').addEventListener('change', glAd);
  function glRooms() {
    var box = $('crewRooms'), sdk = window.LobbySDK;
    $('crewBrowse').hidden = !(sdk && sdk.listRooms && NET_KIND === 'peer');
    if ($('crewBrowse').hidden) return;
    box.textContent = 'Looking…';
    sdk.listRooms('roblins').then(function (rooms) {
      box.textContent = rooms.length ? '' : 'No open crews right now.';
      rooms.forEach(function (r) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'secondary';
        b.textContent = r.hostName + '\\'s crew · ' + r.peerId;
        b.addEventListener('click', function () { if (!crew && !running) joinCrew(r.peerId); });
        box.appendChild(b);
      });
    }, function () { box.textContent = 'Couldn\\'t reach the crew list.'; });
  }
  $('crewRefresh').addEventListener('click', glRooms);
  function showCrew() {
    glAd();
`);
rep(`function pendingUi(on) { $('crewCancel').hidden = !on;`, `function pendingUi(on) { glAd(); $('crewCancel').hidden = !on;`);
rep(`if (name === 'records') fillRecords();`, `if (name === 'records') fillRecords();\n    if (name === 'crew') glRooms();`);

// A crew client keeps only its own deaths (the host owns the campaign's records), same as the game's Records page.
const GLUE = `<script>
/* Pickle Game Library: stats & achievements */
(function () {
  var last = {};
  function stat(S, k, v) { if (last[k] === v) return; last[k] = v; S.setStat(k, v, true); }
  window.glSync = function () {
    var S = window.GameSDK;
    if (!S) return;
    try {
      var r = JSON.parse(localStorage.getItem('gobjob.records') || 'null') || {}, T = r.totals || {}, B = r.best || {};
      var u = JSON.parse(localStorage.getItem('gobjob.unlocks') || '[]'), C = (window.GOB && GOB.Data && GOB.Data.cosmetics) || {};
      var has = function (id) { return u.indexOf(id) >= 0 || (C[id] && u.indexOf(C[id].name) >= 0); };   // older saves kept names
      var best = function (k) { return (B[k] && B[k].v) || 0; };
      stat(S, 'tomb_nights', T.nights || 0);
      stat(S, 'gold_earned', T.earned || 0);
      stat(S, 'campaigns', T.campaigns || 0);
      stat(S, 'best_days', best('days'));
      stat(S, 'best_haul', best('night'));
      stat(S, 'deaths', T.deaths || 0);
      if ((T.nights || 0) >= 1) S.unlockAchievement('home_by_dawn', 'Home by Dawn');
      if (has('earring')) S.unlockAchievement('paid_up', 'Paid Up');
      if (has('eyepatch')) S.unlockAchievement('mostly_the_same', 'Mostly the Same');
      if (has('crown')) S.unlockAchievement('spare_crown', 'Spare Crown');
      if (has('nemes')) S.unlockAchievement('pharaohs_headcloth', "Pharaoh's Headcloth");
      if (has('bloodglass')) S.unlockAchievement('blood_moon', 'Blood Moon');
      if ((T.nights || 0) >= 25) S.unlockAchievement('tomb_regular', 'Tomb Regular');
      if ((T.earned || 0) >= 2500) S.unlockAchievement('golden_goblin', 'Golden Goblin');
    } catch (e) {}
  };
  glSync();
})();
</script>
`;
rep(`})();\n</script>\n</body>\n</html>`, `})();\n</script>\n${GLUE}</body>\n</html>`);

if (!h.trimEnd().endsWith('</html>') || h.split('</html>').length !== 2) throw new Error('bad tail');
fs.writeFileSync(out, h);
console.log('ok', h.length);
