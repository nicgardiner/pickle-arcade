// Applies the Pickle Game Library integration layer to Jertal's Stations build.
// node partners/jertal/stations/patch.mjs <outFile>   (partners/build.mjs runs it; source/index.html is Jertal's untouched build)
import fs from 'node:fs';
const out = process.argv[2];
let h = fs.readFileSync(new URL('./source/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function rep(from, to) {
  const n = h.split(from).length - 1;
  if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${from.slice(0, 80)}`);
  h = h.replace(from, () => to);
}

// styles: exit confirm, player chip, and the --ui zoom for the DOM chrome on 1440p / 4K
// (the 3D view fills the window, the HUD and menus are fixed px; labels track 3D points so they stay unzoomed)
rep(`</style>\n<script type="importmap">`, `/* Pickle Game Library */
:root{--ui:1}
#scorePanel,#tools,#bLaunch,#info,#contracts,#markKey,#coach,#hint,#hand,.modal .box,#toast,#banner,#photoBar,#menuCaption,#skipIntro,#title .decal,#title .menu,#levels>*,#bye>*,#gl-player-chip{zoom:var(--ui)}
/* zoom multiplies vw/vh caps on the zoomed chrome as well, so divide them back out (else #info runs into #contracts at 4K) */
@media (min-width:761px){ #tools{max-width:calc(100vw / var(--ui) - 390px)} #hand{max-width:calc(100vw / var(--ui) - 32px)}
  #info{max-height:max(220px,calc(100vh / var(--ui) - 600px))} .modal .box{max-height:calc(92vh / var(--ui))} #levelGrid{max-height:calc(70vh / var(--ui))} }
/* the title logo isn't zoomed (the intro animates it in px), so scale its font instead */
@media (min-height:781px){ #title h1{font-size:calc(clamp(56px,10vw,132px) * var(--ui))} }
#title{padding-left:calc(clamp(20px,8vw,120px) * var(--ui))}
/* 3D-anchored labels scale about their anchor point (placeLabels appends scale(glUi)) */
.lbl{transform-origin:50% 100%}
#gl-exit-confirm{z-index:60} #gl-exit-confirm .box{max-width:460px}
#gl-player-chip{position:fixed;left:18px;top:14px;z-index:35;align-items:center;gap:8px;font-family:'Rajdhani','Exo 2',sans-serif;font-weight:600;
  font-size:14px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);opacity:.8;pointer-events:none;text-shadow:0 1px 6px #000}
#gl-lb{z-index:40} #gl-lb .box{max-width:520px}
#gl-lb-rows{margin:4px 0 10px;text-align:left}
.gl-r{display:grid;grid-template-columns:34px 1fr 64px 76px;gap:8px;align-items:center;padding:5px 10px;border-bottom:1px solid var(--line);font-size:15px}
.gl-r span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gl-r .n,.gl-r .t,.gl-r .s{font-family:'Rajdhani';font-weight:700} .gl-r .t,.gl-r .s{text-align:right} .gl-r .t{color:var(--muted)} .gl-r .s{font-size:18px}
.gl-r.hd{font-family:'Rajdhani';font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:var(--muted);border-bottom-color:var(--line2)}
.gl-r.hd span{font-weight:600;font-size:11px;color:var(--muted)}
.gl-r.empty{opacity:.3} .gl-r.g1 .n{color:#ffd54a} .gl-r.g2 .n{color:#cfd8e2} .gl-r.g3 .n{color:#e09a5c}
.gl-r.me{background:rgba(77,227,255,.1);box-shadow:inset 3px 0 0 var(--cyan)}
#gl-lb-me{font-family:'Rajdhani';font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)} #gl-lb-me b{color:var(--cyan);font-size:18px}
</style>
<script type="importmap">`);

// three.js ships with the app in vendor/ (works offline); see CLAUDE.md "Vendored engines"
rep(`{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}`,
    `{"imports":{"three":"./vendor/three-0.160.0/build/three.module.min.js","three/addons/":"./vendor/three-0.160.0/examples/jsm/"}}`);

// the title's Exit game button is the library's (the pause menu and 3D holo menu route through ACT.exit too)
rep(`<button class="big danger" data-a="exit">Exit game</button>\n  </div>\n</div>`,
    `<button class="big danger" data-a="exit" id="gl-exit-btn">Exit game</button>\n  </div>\n</div>`);
rep(`exit:exitGame, totitle:`, `exit:glExitShow, totitle:`);

// global Endless Drift leaderboard: a title button (shown once LeaderboardSDK turns up), a run-report
// button, and a post whenever a run sets a new high score
rep(`<div id="endlessInfo"></div>\n`, `<div id="endlessInfo"></div>\n    <button class="big ghost" data-a="gllb" id="gl-lb-btn" style="display:none">🏅 Leaderboard</button>\n`);
rep(`bestTargets:Math.max(rec.bestTargets||0,sim.rounds)}; persist();`,
    `bestTargets:Math.max(rec.bestTargets||0,sim.rounds)}; persist(); if(nb) glLB.best(sim.score,sim.rounds);`);
rep(`<button class="big primary" data-a="endless">New run</button><button class="big ghost" data-a="totitle">Title</button></div>\`;`,
    `<button class="big primary" data-a="endless">New run</button>\${glLB.on()?'<button class="big ghost" data-a="gllb">🏅 Leaderboard</button>':''}<button class="big ghost" data-a="totitle">Title</button></div>\`;`);

// markup for the added pieces, beside the game's own toast
rep(`<div id="toast"></div>\n`, `<div id="toast"></div>
<!-- Pickle Game Library -->
<div id="gl-player-chip" style="display:none"></div>
<div id="gl-exit-confirm" class="modal" style="display:none"><div class="box panel">
  <div class="tag">System</div><h3>Exit Game?</h3>
  <div class="sub">Your station is autosaved.</div>
  <div class="row"><button class="big ghost" id="gl-exit-no">Cancel</button><button class="big danger" id="gl-exit-yes">Exit</button></div>
</div></div>
<div id="gl-lb" class="modal hidden"><div class="box panel">
  <div class="tag">Endless Drift · all stations</div><h3>Leaderboard</h3>
  <div class="sub" id="gl-lb-st">Syncing…</div>
  <div id="gl-lb-rows"></div>
  <div id="gl-lb-me"></div>
  <div class="row"><button class="big ghost" id="gl-lb-ref">↻ Refresh</button><button class="big primary" id="gl-lb-close">Back</button></div>
</div></div>
`);

// score preview / chips / pops grow with the UI scale too, pinned at their 3D anchor
rep("a.el.style.transform=`translate(${(vtmp.x+1)/2*w}px,${(1-vtmp.y)/2*h}px) translate(-50%,-100%)`;",
    "a.el.style.transform=`translate(${(vtmp.x+1)/2*w}px,${(1-vtmp.y)/2*h}px) translate(-50%,-100%) scale(${glUi})`;");

// stats & achievements read SAVE whenever the game persists it (stars, bests, endless record)
rep(`const persist=()=>{ try{ localStorage.setItem('stations-v1',JSON.stringify(SAVE)); }catch(e){} };`,
    `const persist=()=>{ try{ localStorage.setItem('stations-v1',JSON.stringify(SAVE)); }catch(e){} try{ glSync(); }catch(e){} };`);
// Flight School only for finishing the tutorial, not for skipping it
rep(`if(st.final){ SAVE.tutorialDone=true; persist(); }`,
    `if(st.final){ SAVE.tutorialDone=true; persist(); if(window.GameSDK) GameSDK.unlockAchievement('flight_school','Flight School'); }`);

// flip the station (Tab / F / ⇅ button) while attaching an expansion pod; the ghost redraws on the new side
rep(`  if(inGame&&mode==='pod'&&!OV.length&&(e.key==='r'||e.key==='R')){ rotatePod(); return; }`,
    `  if(inGame&&mode==='pod'&&!OV.length&&(e.key==='r'||e.key==='R')){ rotatePod(); return; }
  if(inGame&&mode==='pod'&&!OV.length&&!photo&&(e.key==='Tab'||e.key==='f'||e.key==='F')){ setView(view==='top'?'bot':'top'); return; }`);
rep(`$('bFlip').onclick=()=>{ if(!canPlay()) return;`,
    `$('bFlip').onclick=()=>{ if(inGame&&mode==='pod'&&!OV.length&&!photo){ setView(view==='top'?'bot':'top'); return; } if(!canPlay()) return;`);
rep(`function setView(v){\n  view=v;`, `function setView(v){\n  view=v; if(podMode) podMode.key='';`);
rep(`<kbd>R</kbd> or right-click to rotate ·`, `<kbd>R</kbd> or right-click to rotate · <kbd>Tab</kbd> to flip ·`);

const GLUE = `
/* =====================================================================
   Pickle Game Library: exit confirm, player chip, UI scale, stats & achievements
   ===================================================================== */
function glExitShow(){ $('gl-exit-confirm').style.display='flex'; }
let glUi=1;
{
  const ov=$('gl-exit-confirm'), hide=()=>{ ov.style.display='none'; };
  $('gl-exit-no').onclick=()=>{ sfx('ui'); hide(); };
  $('gl-exit-yes').onclick=()=>{ hide(); exitGame(); };
  ov.addEventListener('click',e=>{ if(e.target===ov) hide(); });
  // while it is open no key reaches the game; Escape cancels
  addEventListener('keydown',e=>{ if(ov.style.display==='none') return; e.stopImmediatePropagation(); if(e.key==='Escape') hide(); },true);

  // player chip on the title screen
  const chip=$('gl-player-chip'); let chipOn=false;
  try{ const q=new URLSearchParams(location.search), nm=(q.get('playerName')||'').trim();
    if(nm){ const em=document.createElement('span'); em.textContent=q.get('playerEmblem')||''; chip.append(em,' '+nm); chipOn=true; } }catch(e){}
  const chipVis=()=>{ const t=$('title'); chip.style.display=chipOn&&!t.classList.contains('hidden')&&!t.classList.contains('intro')?'inline-flex':'none'; };
  new MutationObserver(chipVis).observe($('title'),{attributes:true,attributeFilter:['class']}); chipVis();

  // UI scale: the layout is tuned for 1080p; grow the chrome with the window, 1 at 1080p and below, capped at 2
  const setUi=()=>{ glUi=Math.round(Math.max(1,Math.min(2,Math.min(innerWidth/1920,innerHeight/1080)))*100)/100; document.documentElement.style.setProperty('--ui',String(glUi)); };
  addEventListener('resize',setUi); setUi();

  // per-placement counters ride on the game's own sound cues
  sfx=(f=>function(n){ const S=window.GameSDK;
    if(S) try{
      if(n==='place'&&inGame&&!demo) S.incrementStat('modules_placed');
      else if(n==='merge'){ S.incrementStat('landmarks_built'); S.unlockAchievement('first_landmark','Landmark'); }
      else if(n==='shot') S.unlockAchievement('photographer','Postcard from Orbit');
    }catch(e){}
    return f.apply(this,arguments); })(sfx);
}
function glSync(){
  const S=window.GameSDK; if(!S) return;
  const lv=Object.values(SAVE.levels||{}), stars=lv.reduce((a,r)=>a+(r.stars||0),0), cleared=lv.filter(r=>r.stars>=1).length;
  S.setStat('stars_earned',stars,true); S.setStat('stations_cleared',cleared,true);
  if(cleared>=1) S.unlockAchievement('first_star','Stabilised');
  if(lv.some(r=>r.stars>=3)) S.unlockAchievement('legendary','Legendary Station');
  if(cleared>=LEVELS.length) S.unlockAchievement('all_stations','Grand Architect');
  if(stars>=LEVELS.length*3) S.unlockAchievement('all_stars','Every Star');
  const en=SAVE.endless; if(!en) return;
  S.setStat('best_endless',en.best||0,true);
  if((en.bestTargets||0)>=20) S.unlockAchievement('deep_drift','Deep Drift');
}
try{ glSync(); }catch(e){}

/* global Endless Drift leaderboard (leaderboard-sdk.js; the app preload appends it after this module runs,
   so poll for it — absent when opened standalone, and then nothing shows) */
const glLB=(()=>{
  const ID='stations', st=$('gl-lb-st'), rows=$('gl-lb-rows'), meEl=$('gl-lb-me');
  let SDK=null, seq=0, posting=null;
  const local=()=>SAVE.endless?SAVE.endless.best||0:0;
  const row=(cls,cells)=>{ const r=document.createElement('div'); r.className='gl-r '+cls;
    for(const[c,t] of cells){ const s=document.createElement('span'); s.className=c; s.textContent=t; r.appendChild(s); } return r; };
  function render(d){
    rows.replaceChildren(row('hd',[['n','#'],['p','Commander'],['t','Targets'],['s','Score']]));
    for(let i=0;i<10;i++){ const e=d&&d.top[i];
      rows.appendChild(e?row((i<3?'g'+(i+1):'')+(e.isMe?' me':''),[['n',i+1],['p',((e.emblem||'')+' '+(e.name||'Pilot')).trim()],['t',e.meta&&e.meta.targets!=null?e.meta.targets:'—'],['s',e.score]])
                       :row('empty',[['n',i+1],['p','—'],['t',''],['s','']])); }
    meEl.replaceChildren();
    if(d&&d.me){ const b=document.createElement('b'); b.textContent='#'+d.rank; meEl.append('Your rank ',b,' · best '+d.me.score); }
    else meEl.textContent=local()?'Your best '+local()+' has not posted yet':'Finish an Endless Drift run to get on the board';
  }
  function post(score,meta){
    if(!posting) posting=SDK.submit(ID,score,meta||{}).then(r=>!!(r&&r.ok),()=>false).finally(()=>{ posting=null; });
    return posting;
  }
  async function refresh(){
    if(!SDK) return; const s=++seq; st.textContent='Syncing…';
    let d; try{ d=await SDK.board(ID,{limit:10}); }catch(e){ if(s!==seq) return; if(!rows.children.length) render(null); st.textContent='Offline — the board could not be reached'; return; }
    if(s!==seq) return; render(d); st.textContent='Live';
    // a local best the board hasn't seen (pre-leaderboard runs, an offline post) goes up now
    if(local()>(d.me?d.me.score:0)){ st.textContent='Posting…';
      if(!await post(local())){ if(s===seq) st.textContent='Post failed — will retry'; return; }
      try{ d=await SDK.board(ID,{limit:10}); if(s===seq){ render(d); st.textContent='Live'; } }catch(e){} }
  }
  $('gl-lb-ref').onclick=()=>{ sfx('ui'); refresh(); };
  $('gl-lb-close').onclick=()=>{ sfx('ui'); closeOv('gl-lb'); };
  $('gl-lb').addEventListener('click',e=>{ if(e.target.id==='gl-lb') closeOv('gl-lb'); });
  ACT.gllb=()=>{ if(!SDK) return; openOv('gl-lb'); refresh(); };
  let tries=0; const find=()=>{ if(window.LeaderboardSDK){ SDK=window.LeaderboardSDK; $('gl-lb-btn').style.display=''; refresh(); } else if(++tries<50) setTimeout(find,100); };
  find();
  return { on:()=>!!SDK, best:(score,targets)=>{ if(SDK) post(score,{targets}); } };
})();
`;
rep(`applySettings();\nshowTitle();\ntick();\n</script>`, `${GLUE}applySettings();\nshowTitle();\ntick();\n</script>`);

if (!h.trimEnd().endsWith('</html>') || h.split('</html>').length !== 2) throw new Error('bad tail');
fs.writeFileSync(out, h);
console.log('ok', h.length);
