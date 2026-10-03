// Applies the Pickle Game Library integration layer to Jertal's Pippin build.
// node partners/jertal/pippin/patch.mjs <outFile>   (partners/build.mjs runs it; source/pippin.html is Jertal's build)
//
// Pippin is two documents in one file: the SHELL (top-level page: run state, chip, exit confirm, stats) and the
// ROUND scene, a whole HTML page kept in <script id="tpl-round" type="text/html"> and mounted as the #f-round
// iframe's srcdoc (so its closing script tags are written <\/script>). The two talk over postMessage.
// GameSDK is injected into the shell only, so every stat/achievement call lives in the shell script.
//
// Converted 2026-10-03: Pippin was hand-patched until then. source/pippin.html was derived by taking these
// replacements back out of the shipped pippin.html, so it is our best reconstruction of Jertal's build, not
// a file he sent. When a real build from him arrives, drop it in source/ and fix whatever anchor throws.
import fs from 'node:fs';
const out = process.argv[2];
let h = fs.readFileSync(new URL('./source/pippin.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function rep(from, to) {
  const n = h.split(from).length - 1;
  if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${from.slice(0, 80)}`);
  h = h.replace(from, () => to);
}

// ---- shell <head>/<body>: chip + exit confirm styles, the --ui zoom for the shell's DOM chrome, the chip/confirm DOM
rep(`.jk.hot .glare{opacity:1;}
</style>
</head>
<body>
`, `.jk.hot .glare{opacity:1;}
/* ---- Pickle Game Library: player chip + Exit Game ---- */
#gl-player-chip{position:fixed;top:12px;left:12px;z-index:900;align-items:center;gap:7px;
  font-family:'Fredoka',sans-serif;font-weight:600;font-size:13px;letter-spacing:.02em;color:#ffe6c4;
  background:linear-gradient(180deg,#7a5330e0,#452c16e0);border:1.5px solid #c99a3f99;border-radius:999px;
  padding:5px 13px 5px 10px;opacity:.78;pointer-events:none;
  box-shadow:0 3px 10px #0008,inset 0 1px 0 #ffffff1c;}
/* No top-right Exit button: the 3D main menu's own "Leave" is the only way out,
   and it routes through this same confirm via __glExitShow(). */
#gl-exit-confirm{position:fixed;inset:0;z-index:1000;display:none;align-items:center;justify-content:center;
  background:#04050fb0;padding:20px;}
#gl-exit-confirm .glx-panel{background:linear-gradient(180deg,#2a1a0e,#1c1108);border:2px solid #c99a3f;
  border-radius:18px;width:min(340px,calc(100vw - 40px));padding:22px 24px;text-align:center;
  box-shadow:0 18px 44px #000b,inset 0 1px 0 #ffffff14;}
#gl-exit-confirm .glx-title{font-family:'Fredoka',sans-serif;font-weight:700;font-size:21px;color:#ffd97a;margin:0 0 8px;}
#gl-exit-confirm .glx-body{font-size:13px;line-height:1.5;color:#cdd8ff;margin:0 0 16px;}
#gl-exit-confirm .glx-body b{color:#ffd97a;}
#gl-exit-confirm .glx-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}
#gl-exit-confirm .glx-row .bigbtn{font-size:14px;padding:10px 18px;border-radius:14px;}
/* ===== PICKLE UI SCALE (2026-09-18) — re-apply after a rebuild, see the twin block in
   the #tpl-round <style> and the setUiScale() blocks in both scripts. The 3D table is
   framed by a CONSTANT horizontal FOV, so it magnifies with the window, while this DOM
   chrome is fixed-pixel CSS tuned at 1920x1080 — on a 2560x1440 monitor the board grew
   and the overlays stayed 1080p-sized. \`--ui\` is the window's size relative to 1080p
   (1 at or below it, so 1080p and smaller are untouched; capped at 2), set by
   setUiScale() in the script below. Applied as \`zoom\` to DOM chrome ONLY — never the
   #f-round iframe/.layer, which the scene sizes itself from. ===== */
:root{--ui:1;}
.ov,.popup .card,#fsbtn,#gl-player-chip,#gl-exit-confirm .glx-panel{zoom:var(--ui);}
</style>
<script>
/* PICKLE UI SCALE — see the --ui comment in the <style> above. */
(function(){
  var REF_W=1920, REF_H=1080, MAX=2, cur=1;
  function setUiScale(){
    var w=window.innerWidth||REF_W, h=window.innerHeight||REF_H;
    var s=Math.min(w/REF_W,h/REF_H);
    s=Math.max(1,Math.min(MAX,s)); s=Math.round(s*100)/100;
    if(s!==cur){ cur=s; document.documentElement.style.setProperty('--ui',String(s)); }
    return s;
  }
  setUiScale();
  addEventListener('resize',setUiScale);
})();
</script>
</head>
<body>
  <!-- ===== Pickle Game Library: player chip (main menu only) + Exit confirm ===== -->
  <div id="gl-player-chip" style="display:none"></div>
  <div id="gl-exit-confirm" style="display:none">
    <div class="glx-panel">
      <div class="glx-title">Exit Game?</div>
      <div class="glx-body">Your run is auto-saved at the last stage — <b>Continue</b> picks it back up.</div>
      <div class="glx-row">
        <button id="gl-exit-no" class="bigbtn ghost">Cancel</button>
        <button id="gl-exit-yes" class="bigbtn">Exit</button>
      </div>
    </div>
  </div>

`);

// confirm-dialog convention: cancel left, confirm right
rep(`        <button class="bigbtn" id="newrunYes">Start New Run</button>
        <button class="bigbtn ghost" id="newrunNo">Keep Playing</button>`,
`        <button class="bigbtn ghost" id="newrunNo">Keep Playing</button>
        <button class="bigbtn" id="newrunYes">Start New Run</button>`);

// ---- round scene <head>: engines ship with the app in vendor/ (works offline; see CLAUDE.md "Vendored engines")
rep(`<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"><\\/script>`, `<script src="./vendor/three-0.128.0/build/three.min.js"><\\/script>`);
rep(`<script src="https://cdnjs.cloudflare.com/ajax/libs/cannon.js/0.6.2/cannon.min.js"><\\/script>`, `<script src="./vendor/cannon-0.6.2/cannon.min.js"><\\/script>
<script>
/* GPU-reset guard. A GPU reset (driver hiccup, sleep/resume) wipes every GPU-backed canvas, and
   three.js re-uploads CanvasTextures from those wiped canvases -> blank cards, dice, tiles. A
   canvas that isn't on the page yet is almost always a texture source here; CPU backing
   (willReadFrequently) survives the reset. Visible canvases keep their normal backing. */
(function(){ const g=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(t,o){
    if(t==='2d'&&!this.isConnected)o=Object.assign({willReadFrequently:true},o);
    return g.call(this,t,o); }; })();
<\\/script>`);

// map/shop Gold plates drop clear of the fixed top-right controls
rep(`  #mapHud .plate{background:`, `  /* margin-top drops the Gold plate clear of the launcher chrome fixed at top:14px/height:38px
     (the 🔊 music toggle) — the title on the left keeps its original height */
  #mapHud .plate{margin-top:22px;background:`);
rep(`  #shopHud .plate{margin-left:auto;background:`, `  /* same clearance as #mapHud .plate — keep the two in step */
  #shopHud .plate{margin-left:auto;margin-top:22px;background:`);

// round scene --ui zoom (twin of the shell's)
rep(`#shopHud #leaveConfirm.on{pointer-events:auto;}
</style>`, `#shopHud #leaveConfirm.on{pointer-events:auto;}
/* ===== PICKLE UI SCALE (2026-09-18) — twin of the block in the outer page's <style>;
   re-apply both after a rebuild. \`--ui\` is set by setUiScale() next to resize() in the
   script below (window size vs 1920x1080, 1 at or below it, capped at 2) and zooms the
   STATIC DOM chrome only, so a 1440p/4K screen gets a bigger table AND bigger readouts.
   DELIBERATELY NOT ZOOMED, because their positions are written in real screen pixels by
   JS and \`zoom\` would scale those numbers a second time: #tally/.tpanel, .flypop, .pop,
   .spark, .cring, #tip (all placed from 3D projections or the pointer), and #mapHud /
   #shopHud (percentage anchors over the 3D boards plus FLIP animations that copy
   getBoundingClientRect() values into inline styles). Never the canvases. ===== */
:root{--ui:1;}
#hint,#cascade,#tallytotal,#skiphint,#cinebtns,#goldbreak,#wavepick,
.overlay,.popup .card{zoom:var(--ui);}
</style>`);

// liquid background: survive a GPU reset (rebuild the program on webglcontextrestored)
rep(`  const prog=gl.createProgram();
  gl.attachShader(prog,mk(gl.VERTEX_SHADER,vsSrc));
  gl.attachShader(prog,mk(gl.FRAGMENT_SHADER,fsSrc));
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog,gl.LINK_STATUS)){ fallback(); return; }
  gl.useProgram(prog);
  const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  const loc=gl.getAttribLocation(prog,'p');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
  const uRes=gl.getUniformLocation(prog,'u_res'),uTime=gl.getUniformLocation(prog,'u_time');
  const uC=[gl.getUniformLocation(prog,'u_c0'),gl.getUniformLocation(prog,'u_c1'),gl.getUniformLocation(prog,'u_c2'),gl.getUniformLocation(prog,'u_c3')];
`, `  let uRes,uTime,uC;
  function initGL(){
    const prog=gl.createProgram();
    gl.attachShader(prog,mk(gl.VERTEX_SHADER,vsSrc));
    gl.attachShader(prog,mk(gl.FRAGMENT_SHADER,fsSrc));
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog,gl.LINK_STATUS))return false;
    gl.useProgram(prog);
    const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    const loc=gl.getAttribLocation(prog,'p');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
    uRes=gl.getUniformLocation(prog,'u_res');uTime=gl.getUniformLocation(prog,'u_time');
    uC=[gl.getUniformLocation(prog,'u_c0'),gl.getUniformLocation(prog,'u_c1'),gl.getUniformLocation(prog,'u_c2'),gl.getUniformLocation(prog,'u_c3')];
    return true;
  }
  if(!initGL()){ fallback(); return; }
  // A GPU reset (driver hiccup, sleep/resume) loses the context; without preventDefault it never
  // comes back and the background stays black. On restore the program and buffer are gone: rebuild.
  lc.addEventListener('webglcontextlost',e=>e.preventDefault());
  lc.addEventListener('webglcontextrestored',()=>{ initGL(); gl.viewport(0,0,lc.width,lc.height); });
`);

// round scene messages: pause keys are swallowed while the shell's exit confirm is up
rep(`    else if(m.type==='togglePause'){ if(window.MENU && window.MENU.escToggle)window.MENU.escToggle(); }   // Escape forwarded from the shell (works in map/shop too)
`, `    else if(m.type==='togglePause'){ if(!window.__glExitOpen && window.MENU && window.MENU.escToggle)window.MENU.escToggle(); }   // Escape/P forwarded from the shell (works in map/shop too)
    else if(m.type==='glExit'){ window.__glExitOpen=!!m.open; }   // launcher Exit Game confirm is up → swallow pause keys in here too
`);

// round scene keys: P pauses too (library standard), never while typing, and Esc cancels the exit confirm
rep(`window.addEventListener('keydown',e=>{
  if(e.key==='Escape'||e.key==='Esc'){ if(window.MENU&&window.MENU.escToggle){ e.preventDefault(); window.MENU.escToggle(); } } });`,
`window.addEventListener('keydown',e=>{
  if(window.__glExitOpen){                                         // launcher Exit Game confirm owns the keyboard
    if(e.key==='Escape'||e.key==='Esc'){ e.preventDefault(); try{ send({type:'glExitCancel'}); }catch(_){} }
    return; }
  const t=e.target, tn=(t&&t.tagName||'').toLowerCase();
  if(tn==='input'||tn==='textarea'||(t&&t.isContentEditable)) return;
  if(e.key==='Escape'||e.key==='Esc'||e.key==='p'||e.key==='P'){ if(window.MENU&&window.MENU.escToggle){ e.preventDefault(); window.MENU.escToggle(); } } });`);

// round scene --ui: set alongside the renderer resize
rep(`function resize(){renderer.setSize(`, `/* ===== PICKLE UI SCALE — see the \`--ui\` comment at the end of this template's <style>.
   Chrome-only zoom, 1 at or below 1920x1080 so nothing there changes, capped at 2. Any
   JS that measures a zoomed element with offsetWidth/offsetHeight (its OWN, unzoomed
   pixels) would have to multiply by this; getBoundingClientRect already reports real
   screen pixels, so picking and the dice raycasts need no change. ===== */
var UI_REF_W=1920, UI_REF_H=1080, UI_MAX_SCALE=2, UI_SCALE=1;
function setUiScale(){
  var w=innerWidth||UI_REF_W, h=innerHeight||UI_REF_H;
  var s=Math.min(w/UI_REF_W,h/UI_REF_H);
  s=Math.max(1,Math.min(UI_MAX_SCALE,s)); s=Math.round(s*100)/100;
  if(s!==UI_SCALE){ UI_SCALE=s; document.documentElement.style.setProperty('--ui',String(s)); }
  return s;
}
function resize(){setUiScale();renderer.setSize(`);

// ---- shell script: stats & achievements (GameSDK lives in this top-level window)
rep(`PURIST_COMBO=null; }

function freshRun(){`, `PURIST_COMBO=null; }

/* ---------- Pickle Game Library: stats & achievements ----------
   The shell owns DC (the whole run), so every meaningful moment — run start,
   round won, floor advance, run won — is observable from right here. GameSDK is
   injected into this top-level window by the launcher's preload (and by the
   website build), so every call is feature-checked and safe standalone. */
function glSet(k,v,keepMax){ try{ if(window.GameSDK) GameSDK.setStat(k,v,!!keepMax); }catch(_){} }
function glInc(k,n){ try{ if(window.GameSDK) GameSDK.incrementStat(k, n==null?1:n); }catch(_){} }
function glAch(id,label){ try{ if(window.GameSDK) GameSDK.unlockAchievement(id,label); }catch(_){} }
function glFloor(n){ n=Math.max(1,n|0); glSet('best_floor', n, true);
  if(n>=3) glAch('floor_3','Second Wind');
  if(n>=5) glAch('floor_5','Halfway House'); }
const GL_CHAL_TOTAL=12;   // keep in step with CHAL above (and games.json's challenges_done total)
function glSyncChallenges(){ try{ const n=chalDoneSet().size; glSet('challenges_done', n);
  if(n>=GL_CHAL_TOTAL) glAch('all_challenges','House Rules'); }catch(_){} }

function freshRun(){`);
rep(`  if(DC.cards.length>DC.cardCap)DC.cards=DC.cards.slice(0,DC.cardCap); }`,
`  if(DC.cards.length>DC.cardCap)DC.cards=DC.cards.slice(0,DC.cardCap);
  glInc('total_runs'); glAch('first_run','Take a Seat'); glFloor(1); }`);
rep(`       else { localStorage.setItem(STD_STORE,'1'); } }catch(_){}
  pushChalState();`, `       else { localStorage.setItem(STD_STORE,'1'); } }catch(_){}
  glAch('graduated','Graduated');
  if(DC.challenge) glAch('chal_first','Rule Bender');
  glSyncChallenges();
  pushChalState();`);
rep(`function post(name,msg){
`, `function post(name,msg){
  try{ if(msg&&msg.type==='menuShow') glChipVis(true); else if(msg&&msg.type==='menuHide') glChipVis(false); }catch(_){}
`);
rep(`standard:stdDone()});   // 🏆 send challenge-completion stamps to the menu
`, `standard:stdDone()});   // 🏆 send challenge-completion stamps to the menu
glSyncChallenges();   // mirror the challenge-completion count into the launcher's stat panel
`);
rep(`function setActive(name){ currentMode=name; post(`, `function setActive(name){ currentMode=name; glChipVis(false); post(`);
rep(`DC.stageIdx=0;} saveRun(); goMap(); }`, `DC.stageIdx=0;} saveRun(); glFloor(DC.floorNum); goMap(); }`);
rep(`function gameOver(m){ clearRun();   // run is over — drop the auto-save
`, `function gameOver(m){ clearRun();   // run is over — drop the auto-save
  glFloor(DC.floorNum);
`);
rep(`      if(bossFight&&!finalWin){`, `      /* --- Pickle Game Library tracking: a round/boss was just cleared --- */
      glInc('rounds_won'); glSet('best_score', Math.round(m.score||0), true);
      if((m.score||0)>=100000) glAch('score_100k','Astronomical');
      if(bossFight){ glInc('bosses_beaten'); glAch('boss_down','House Cleaner'); }
      if((DC.cards||[]).length>=5) glAch('full_rail','Loaded Deck');
      if(bossFight&&!finalWin){`);

// main menu Leave → the library's Exit Game confirm (standalone, without the confirm DOM, it still closes)
rep(`    else if(m.type==='menuLeave'){ closeGame(); }
`, `    else if(m.type==='menuLeave'){ if(window.__glExitShow) window.__glExitShow(); else closeGame(); }   // Leave → same Exit Game confirmation as the top-right button
    else if(m.type==='glExitCancel'){ if(window.__glExitHide) window.__glExitHide(); }   // Escape inside the game frame while the confirm is up
`);

// ---- shell script: player chip + exit confirm, and P / input guard / confirm gate on the shell's key handler
rep(`// Escape works even when the shell (not the game iframe) holds keyboard focus — e.g. on the map or in the shop
window.addEventListener('keydown',e=>{
  if(e.key==='Escape'||e.key==='Esc'){ post('round',{type:'togglePause'}); }
});`, `/* ================= Pickle Game Library: player chip + Exit Game =================
   The main menu is drawn inside the 3D scene, so both live as DOM chrome on the
   shell (top-level document) — the only layer that survives every scene swap. */
function glChipVis(on){
  const chip=document.getElementById('gl-player-chip'); if(!chip)return;
  // The "built" flag lives on the element, not in a script-scope variable: post() calls
  // this before the declarations down here have run, and a \`var\`/\`let\` here would be
  // re-initialised afterwards and let the chip append its contents a second time.
  if(chip.dataset.built!=='1'){
    chip.dataset.built='1';
    try{
      const p=new URLSearchParams(location.search);
      const name=(p.get('playerName')||'').trim();
      if(name){
        const em=document.createElement('span'); em.textContent=p.get('playerEmblem')||'';
        chip.appendChild(em);
        chip.appendChild(document.createTextNode(' '+name));
        chip.dataset.ok='1';
      }
    }catch(_){}
  }
  chip.style.display=(on&&chip.dataset.ok==='1')?'inline-flex':'none';
}

var _glExitOpen=false;
(function(){
  const ov=document.getElementById('gl-exit-confirm'),
        yes=document.getElementById('gl-exit-yes'), no=document.getElementById('gl-exit-no');
  if(!ov||!yes||!no) return;
  function show(){ _glExitOpen=true; ov.style.display='flex'; post('round',{type:'glExit',open:true}); }
  function hide(){ _glExitOpen=false; ov.style.display='none'; post('round',{type:'glExit',open:false}); }
  window.__glExitIsOpen=()=>_glExitOpen;
  window.__glExitShow=show;   // the 3D main menu's Leave button is the only entry point
  window.__glExitHide=hide;   // Escape pressed while the game iframe holds focus
  no.addEventListener('click',hide);
  yes.addEventListener('click',function(){ window.close(); });
  document.addEventListener('keydown',function(e){
    if((e.key==='Escape'||e.key==='Esc') && _glExitOpen){ e.stopPropagation(); e.preventDefault(); hide(); }
  },true);
})();

// Escape / P work even when the shell (not the game iframe) holds keyboard focus — e.g. on the map or in the shop
window.addEventListener('keydown',e=>{
  if(_glExitOpen) return;                                     // the exit confirm owns the keyboard while it's up
  const t=e.target, tn=(t&&t.tagName||'').toLowerCase();
  if(tn==='input'||tn==='textarea'||(t&&t.isContentEditable)) return;
  if(e.key==='Escape'||e.key==='Esc'||e.key==='p'||e.key==='P'){ post('round',{type:'togglePause'}); }
});`);

if (!h.trimEnd().endsWith('</html>') || h.split('</html>').length !== 3) throw new Error('bad tail');   // the round template carries its own </html>
fs.writeFileSync(out, h);
console.log('ok', h.length);
