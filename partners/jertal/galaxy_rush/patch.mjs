// Applies the Pickle Game Library integration layer to Jertal's Galaxy Rush build.
// node partners/jertal/galaxy_rush/patch.mjs <outFile>   (partners/build.mjs runs it; source/galaxy-rush.html is Jertal's untouched build)
import fs from 'node:fs';
const out = process.argv[2];
if (!out) throw new Error('usage: node patch.mjs <outFile>');
let h = fs.readFileSync(new URL('./source/galaxy-rush.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function rep(from, to) {
  const n = h.split(from).length - 1;
  if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${from.slice(0, 80)}`);
  h = h.replace(from, () => to);
}

// three.js ships with the app in vendor/ (works offline); see CLAUDE.md "Vendored engines". PeerJS stays on unpkg (co-op only).
rep(`<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>`, `<script src="./vendor/three-0.128.0/build/three.min.js"></script>`);
for (const f of ['postprocessing/EffectComposer', 'postprocessing/RenderPass', 'postprocessing/ShaderPass', 'shaders/CopyShader',
  'shaders/LuminosityHighPassShader', 'postprocessing/UnrealBloomPass', 'utils/BufferGeometryUtils'])
  rep(`https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/${f}.js`, `./vendor/three-0.128.0/examples/js/${f}.js`);

// styles: exit confirm (the game's own panel look), player chip, and the --ui zoom for the DOM menus on 1440p / 4K
rep(`</style>\n</head>`, `  /* Pickle Game Library */
  :root{--ui:1}
  #ui .panel,#warpbtn,#gl-exit-confirm .panel,#gl-player-chip{zoom:var(--ui)}
  #gl-exit-confirm{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100;background:radial-gradient(ellipse at center,rgba(40,10,90,.45),rgba(12,0,36,.85));font-family:'Lilita One','Arial Black',system-ui,sans-serif;color:#fff;letter-spacing:.5px}
  #gl-exit-confirm .panel{min-width:380px}
  #gl-exit-confirm h2{animation:none}
  #gl-player-chip{position:fixed;top:14px;left:16px;z-index:3;align-items:center;gap:8px;pointer-events:none;opacity:.8;font-family:'Lilita One','Arial Black',system-ui,sans-serif;font-size:18px;color:#ffe94a;-webkit-text-stroke:1px #1a0838;paint-order:stroke fill;letter-spacing:.5px}
</style>
</head>`);

// markup + the exit / chip / scale script, BEFORE the game script: its capture keydown runs ahead of the game's,
// and the game reads glUi() from its first resize()
rep(`<div id="ui"></div>\n`, `<div id="ui"></div>
<!-- Pickle Game Library -->
<div id="gl-player-chip" style="display:none"></div>
<div id="gl-exit-confirm" style="display:none"><div class="panel" role="dialog" aria-label="Exit Game">
  <h2>EXIT GAME?</h2>
  <div class="sub">Your hangar progress is saved.</div>
  <button class="btn pink" id="gl-exit-no">CANCEL</button><button class="btn big" id="gl-exit-yes">EXIT</button>
</div></div>
<script>
(function () {
  var ov = document.getElementById('gl-exit-confirm'), no = document.getElementById('gl-exit-no');
  var open = function () { return ov.style.display !== 'none'; }, hide = function () { ov.style.display = 'none'; };
  window.glExitShow = function () { ov.style.display = 'flex'; no.focus(); };
  no.addEventListener('click', hide);
  document.getElementById('gl-exit-yes').addEventListener('click', function () { window.close(); });
  ov.addEventListener('mousedown', function (e) { e.stopPropagation(); if (e.target === ov) hide(); });
  // while it is open no keydown reaches the game; Escape cancels. keyup still goes through, or a key held into the confirm sticks
  addEventListener('keydown', function (e) { if (!open()) return; e.stopImmediatePropagation(); if (e.code === 'Escape') { e.preventDefault(); hide(); } }, true);

  // player chip, title screen only
  var chip = document.getElementById('gl-player-chip'), chipOn = false;
  try { var q = new URLSearchParams(location.search), nm = (q.get('playerName') || '').trim();
    if (nm) { var em = document.createElement('span'); em.textContent = q.get('playerEmblem') || ''; chip.append(em, ' ' + nm); chipOn = true; } } catch (e) {}
  if (chipOn) setInterval(function () { chip.style.display = typeof state !== 'undefined' && state === 'title' && !open() ? 'inline-flex' : 'none'; }, 200);

  // UI scale: menus and the canvas HUD are tuned for 1080p; grow them with the window, 1 at 1080p and below, capped at 2
  var ui = 1;
  var setUi = function () { ui = Math.round(Math.max(1, Math.min(2, Math.min(innerWidth / 1920, innerHeight / 1080))) * 100) / 100; document.documentElement.style.setProperty('--ui', String(ui)); };
  window.glUi = function () { return ui; };
  addEventListener('resize', setUi); setUi();
})();
</script>
`);

// the canvas HUD is drawn at a fixed 2 px per unit; make that 2 * --ui (view size, draw transform, mouse mapping)
// (the mouse keeps its raw px so a resize that changes the scale re-maps it instead of leaving the aim off until it moves)
rep(`W=iw/2;H=ih/2;`, `W=iw/(2*glUi());H=ih/(2*glUi());if(mouse.cx!=null){mouse.x=mouse.cx/(2*glUi());mouse.y=mouse.cy/(2*glUi())}`);
rep(`ctx.setTransform(2*DPR,0,0,2*DPR,0,0);`, `ctx.setTransform(2*glUi()*DPR,0,0,2*glUi()*DPR,0,0);`);
rep(`mouse.x=e.clientX/2;mouse.y=e.clientY/2;`, `mouse.cx=e.clientX;mouse.cy=e.clientY;mouse.x=e.clientX/(2*glUi());mouse.y=e.clientY/(2*glUi());`);
// H*2 was the window height for the 3D point sprites (sparks, stars); it is not HUD space, so it must not shrink with --ui
rep(`const scale=H*2*.9;`, `const scale=innerHeight*.9;`);

// the title's QUIT and the pause menu's QUIT GAME go through the confirm
rep(`function quitGame(){try{window.close()}catch(e){}`, `function quitGame(){glExitShow();return;try{window.close()}catch(e){}`);
rep(`<button class="btn sm pink" data-act="quit">QUIT</button>`, `<button class="btn sm pink" id="gl-exit-btn" data-act="quit">EXIT GAME</button>`);

// co-op lobby names come off the network and went into innerHTML raw; with the public room list a stranger's host
// could inject script into every joiner. Strip markup characters.
rep("${p.name}${p.id===NET.myId?' (you)':''}", "${String(p.name||'').replace(/[<>&\"']/g,'')}${p.id===NET.myId?' (you)':''}");

// ---- Bug fixes in the game itself (review 2026-10-16). Jertal: fold these into your source; once a build has one,
// its rep() stops matching and throws, so delete that line here. ----
// a PeerJS signalling error mid-run (wifi blip, data channels still up) called showMP(), throwing the run away
rep(`peer.on('error',e=>{NET.status='Network error: '+(e.type||e);showMP()});`, `peer.on('error',e=>{NET.status='Network error: '+(e.type||e);if(state==='mp')showMP()});`);
rep(`'Network error: '+(e.type||e);showMP()})`, `'Network error: '+(e.type||e);if(state==='mp')showMP()})`);
// "room is full" was set, then wiped by netLeave() before it showed
rep(`NET.status='That room is full (4 players max) or already playing.';netLeave();showMP()`, `netLeave();NET.status='That room is full (4 players max) or already playing.';showMP()`);
// a refused joiner's state channel was bound with c=undefined and threw on every input message
// (and when that fast state channel dies on its own, both ends fall back to the reliable one instead of sending into it)
rep(`const c=NET.conns.find(x=>x.peer===conn.peer);if(c)c.stateC=conn;`, `const c=NET.conns.find(x=>x.peer===conn.peer);if(!c){conn.close();return}c.stateC=conn;conn.on('close',()=>{if(c.stateC===conn)c.stateC=null});`);
rep(`st.on('open',()=>{NET.stateC={send:d=>st.send(d)}});`, `st.on('open',()=>{NET.stateC={send:d=>st.send(d)}});st.on('close',()=>{if(NET.peer===peer)NET.stateC=null});`);
// a joiner whose input stopped arriving (tab hidden, channel dead) kept firing on the host forever
rep(`o.aim=d.a;o.fire=!!d.f;`, `o.aim=d.a;o.fire=!!d.f;o.inAt=performance.now();`);
rep(`o.cd-=dt;o.beam=null;if(o.fire){`, `o.cd-=dt;o.beam=null;if(o.fire&&performance.now()-(o.inAt||0)>500)o.fire=false;if(o.fire){`);
// a dropped joiner's astronaut stayed alive=true, so enemies that had it as a target kept aiming at empty space
rep(`if(G&&G.others)G.others=G.others.filter(o=>o.id!==c.id);lobbyBroadcast();`, `if(G&&G.others){for(const o of G.others)if(o.id===c.id)o.alive=false;G.others=G.others.filter(o=>o.id!==c.id)}lobbyBroadcast();`);
// a joiner whose hello landed after START got the run but no astronaut on the host (no input, no damage, no builds)
rep(`function hostStartGame(){
  startRun();G.others=NET.lobby.filter(p=>p.id!=='host').map(p=>({id:p.id,name:p.name,skin:SKINS[p.skin]?p.skin:'classic',hat:COS.hat.items[p.hat]?p.hat:'none',gun:p.gun,gunLv:p.gunLv,
    x:rand(-1,1),z:2.6,vx:0,vz:0,hp:100,maxhp:100,alive:true,respawn:0,cd:0,inv:2,hurtT:0,aim:-HPI,fire:false,fireT:0,thrust:0,pack:{scrap:0,crystal:0,goo:0},tp:0}));
  for(const c`, `function mkOther(p){return {id:p.id,name:p.name,skin:SKINS[p.skin]?p.skin:'classic',hat:COS.hat.items[p.hat]?p.hat:'none',gun:p.gun,gunLv:p.gunLv,
    x:rand(-1,1),z:2.6,vx:0,vz:0,hp:100,maxhp:100,alive:true,respawn:0,cd:0,inv:2,hurtT:0,aim:-HPI,fire:false,fireT:0,thrust:0,pack:{scrap:0,crystal:0,goo:0},tp:0}}
function hostStartGame(){
  startRun();G.others=NET.lobby.filter(p=>p.id!=='host').map(mkOther);
  for(const c`);
rep(`gunLv:Math.min(3,d.gunLv|0)});lobbyBroadcast();`, `gunLv:Math.min(3,d.gunLv|0)});if(G&&G.others&&!G.demo&&!G.others.some(o=>o.id===d.id))G.others.push(mkOther(NET.lobby.find(p=>p.id===d.id)));lobbyBroadcast();`);
// per-session net state survived netLeave: the next co-op run skipped its shader prewarm (hitch), dropped the joiner's
// first inputs (stale teleport counter) and never showed CONNECTION LOST again; also close the same-PC test channel
rep(`clockOff:undefined,lastSnapT:undefined});if(G)G.others=null}`, `clockOff:undefined,lastSnapT:undefined,myTp:undefined,warned:false,pwRegion:undefined,podsSent:undefined,sentPodsV:undefined});if(G)G.others=null}`);
rep(`try{NET.peer&&NET.peer.destroy()}catch(e){}`, `try{NET.peer&&NET.peer.destroy()}catch(e){}try{NET.hostConn&&NET.hostConn.close&&NET.hostConn.close()}catch(e){}`);
rep(`NET.serverT=h.t;NET.lastRecv=performance.now();`, `NET.serverT=h.t;NET.lastRecv=performance.now();NET.warned=false;`);
// closing the window just vanished: the host kept a ghost astronaut until PeerJS timed out (forever in same-PC mode)
rep(`function hostGone(){`, `addEventListener('pagehide',()=>{if(NET.role)netLeave()});\nfunction hostGone(){`);
// a joiner's ship ability fired along the HOST's cursor, and was dropped while the host was in a menu; it now carries
// the joiner's aim, and fires when the host's sim resumes. The host's own ult10 count no longer includes joiners'.
rep(`if(G.ultC>=1&&!G.ult)NET.hostConn.send({t:'ult'});`, `if(G.ultC>=1&&!G.ult){const mw=mouseWorld();NET.hostConn.send({t:'ult',a:r2(Math.atan2(mw.z,mw.x))})}`);
rep(`else if(d.t==='ult')activateUlt();`, `else if(d.t==='ult')activateUlt(d);`);
rep(`function activateUlt(){`, `function activateUlt(net){`);
rep(`if(state!=='play'||!['travel','boss'].includes(G.phase)`, `if((state!=='play'&&!(net&&['paused','cards','route','shop','inspect'].includes(state)))||!['travel','boss'].includes(G.phase)`);
rep(`a0:Math.atan2(mouseWorld().z,mouseWorld().x)};G.ultUses=(G.ultUses||0)+1;`, `a0:net&&isFinite(net.a)?+net.a:Math.atan2(mouseWorld().z,mouseWorld().x)};if(!net)G.ultUses=(G.ultUses||0)+1;`);
// one exception anywhere in the frame stopped the loop for good; schedule the next frame first
rep(`function frame(now){\n`, `function frame(now){requestAnimationFrame(frame);\n`);
rep(`  render(dt);requestAnimationFrame(frame);\n}`, `  render(dt);\n}`);
// freeze / tractor timers only counted down on ordinary enemies: a frozen boss moon, pirate, tentacle... stayed frozen
// (blue tint) forever, and Shatter's +40% applied to it permanently
rep(`function updateSpecial(e,dt){\n`, `function updateSpecial(e,dt){if(e.slowT>0)e.slowT-=dt;if(e.held>0)e.held-=dt;\n`);
// the heat Shield modifier replaced an elite's "shielded" affix instead of adding to it
rep(`e.shield=e.maxhp*G.D.shield;`, `e.shield=(e.shield||0)+e.maxhp*G.D.shield;`);
// buying / equipping a hat, pet, trail... jumped back to the Skins tab with a different item selected
rep(`saveMeta();sfx('build');showWardrobe()}`, `saveMeta();sfx('build');showHangar()}`);
// with Build rebound, the new key opened the trader but only E closed it
rep(`if(state==='shop'){if(e.code==='Escape'||e.code==='KeyE')closeShop();return}`, `if(state==='shop'){if(e.code==='Escape'||e.code===SET.binds.build)closeShop();return}`);
// unplugging the pad left the aim locked to the last stick angle until the mouse moved
rep(`if(!gp){PAD.fire=PAD.boost=PAD.steerL=PAD.steerR=false;PAD.lx=PAD.ly=0;return}`, `if(!gp){PAD.fire=PAD.boost=PAD.steerL=PAD.steerR=PAD.aiming=PAD.on=false;PAD.lx=PAD.ly=0;PAD.prev=[];return}`);
// non-standard pads (generic DirectInput) often report triggers / a Z axis resting at +-1 on axes 2-3, which read as a
// held right stick and stole the aim from the mouse every frame: prefer a standard-mapped pad, right stick only on one
rep(`for(const g of gps)if(g&&g.connected){gp=g;break}`, `for(const g of gps)if(g&&g.connected&&(!gp||g.mapping==='standard'&&gp.mapping!=='standard'))gp=g;`);
rep(`const rx=dz(gp.axes[2]||0),ry=dz(gp.axes[3]||0);`, `const std=gp.mapping==='standard',rx=std?dz(gp.axes[2]||0):0,ry=std?dz(gp.axes[3]||0):0;`);
// menu stick-repeat counted 1/60 per frame, so it ran 2.4x fast at 144 Hz
rep(`function pollPad(){`, `function pollPad(dt){`);
rep(`PAD.navT-=1/60;`, `PAD.navT-=dt||1/60;`);
rep(`  pollPad();\n`, `  pollPad(dt);\n`);
// tentacles got the generic rise on top of their own, surfacing (and slamming) ~3x sooner than tuned
rep(`e.rise=Math.min(1,e.rise+dt*2.5);`, `if(e.type!=='tentacle')e.rise=Math.min(1,e.rise+dt*2.5);`);
// trail particles were rolled once per FRAME, so 144 Hz made 2.4x as many (and missile puffs filled the 220 puff cap,
// starving explosion clouds); per-second rates matching the old 60 Hz look
rep(`e.face+=dt*3;if(Math.random()<.7)part(`, `e.face+=dt*3;if(Math.random()<dt*42)part(`);
rep(`e.face+=dt*2;if(Math.random()<.9)part(`, `e.face+=dt*2;if(Math.random()<dt*54)part(`);
rep(`if(Math.random()<.5)puff(e.x,.4,e.z,.18,'#ffffff',.3);`, `if(Math.random()<dt*30)puff(e.x,.4,e.z,.18,'#ffffff',.3);`);
rep(`if(Math.random()<.7)puff(s.x,s.h,s.z,.12,'#ffffff',.35)`, `if(Math.random()<dt*42)puff(s.x,s.h,s.z,.12,'#ffffff',.35)`);
// an alarm angle of exactly 0 read as "no alarm" and the boss came from the other side
rep(`a=G.alarmDirs[0]||-HPI;`, `a=G.alarmDirs.length?G.alarmDirs[0]:-HPI;`);
// props, saws, drills, stars, the hat propeller... kept moving behind the pause menu / card picks. A co-op joiner's
// world never pauses (the host runs it), so it keeps real time
rep(`  syncWorld(dt);`, `  syncWorld(state==='play'||G.demo||G.netClient?dt:0);`);
// cosmetic swaps leaked GPU memory: the skin's merged geometries and the heart shape's own material were never freed
rep(`if(mg)g.add(new THREE.Mesh(mg,b.mat))`, `if(mg){mg.userData.glOwn=1;g.add(new THREE.Mesh(mg,b.mat))}`);
rep(`skinShown=skn;scene.remove(playerModel);`, `skinShown=skn;scene.remove(playerModel);playerModel.traverse(o=>{if(o.isMesh&&o.geometry.userData.glOwn)o.geometry.dispose()});`);
rep(`if(ud.shapeG){ud.heart.remove(ud.shapeG);ud.shapeG=null}`, `if(ud.shapeG){ud.heart.remove(ud.shapeG);ud.shapeG=null;if(ud.hm&&ud.hm!==ud.hm0)ud.hm.dispose()}`);
// a chest whose wait ran out was pulled back to the tether edge every frame, so it never drifted off
rep(`if(d>L){c.x+=(-c.x/d)*Math.min(d-L,4*dt);`, `if(d>L&&c.hold>0){c.x+=(-c.x/d)*Math.min(d-L,4*dt);`);

// ---- SFX pass (2026-10-23): sounds for the moments that were silent. Same synth (tone/noise) and sfx() gating as the
// game's own table; host sfx() calls already replay on joiners through netWrap('sfx'), so new names reach co-op for free. ----
rep(`\n};\nconst lastSfx={};`, `
  ui:{gap:.04,play:t=>tone(t,'square',900,900,.03,.03)},
  hover:{gap:.03,play:t=>tone(t,'sine',1800,1800,.015,.018)},
  back:{gap:.06,play:t=>{tone(t,'square',900,600,.05,.035);tone(t+.05,'square',600,450,.05,.03)}},
  confirm:{gap:.06,play:t=>{tone(t,'square',700,700,.04,.045);tone(t+.05,'square',1050,1050,.06,.045)}},
  pause:{gap:.15,play:t=>{tone(t,'triangle',880,440,.12,.08);noise(t,.12,.03,1500)}},
  resume:{gap:.15,play:t=>tone(t,'triangle',440,880,.12,.08)},
  gameover:{gap:2,play:t=>{[392,330,262,196].forEach((f,i)=>tone(t+.25+i*.22,'square',f,f*.98,.22,.07));tone(t+1.1,'sawtooth',196,60,.9,.08)}},
  podhit:{gap:.12,play:t=>{noise(t,.07,.07,2400);tone(t,'square',160,70,.07,.05)}},
  ehit:{gap:.045,play:t=>tone(t,'square',520,260,.025,.018)},
  shielddown:{gap:.15,play:t=>{tone(t,'sine',2400,600,.18,.05);noise(t,.15,.05,6000)}},
  cards:{gap:.3,play:t=>{noise(t,.18,.05,5000);[784,988,1175].forEach((f,i)=>tone(t+i*.05,'triangle',f,f,.08,.05))}},
  aww:{gap:.5,play:t=>{tone(t,'triangle',392,370,.18,.07);tone(t+.2,'triangle',349,330,.18,.07);tone(t+.4,'triangle',311,240,.4,.07)}},
  ready:{gap:1,play:t=>[784,1046].forEach((f,i)=>tone(t+i*.1,'sine',f,f,.18,.08))},
  charged:{gap:1,play:t=>{tone(t,'sine',600,1800,.18,.06);tone(t+.16,'triangle',1800,1800,.2,.06)}},
  respawn:{gap:.5,play:t=>{tone(t,'sine',200,1200,.35,.08);noise(t,.3,.04,5000)}},
  weather:{gap:1,play:t=>{noise(t,1,.1,500);tone(t,'sine',70,50,1,.1)}},
  full:{gap:.3,play:t=>{tone(t,'square',300,300,.05,.04);tone(t+.08,'square',300,300,.05,.04)}},
  join:{gap:.3,play:t=>[659,988].forEach((f,i)=>tone(t+i*.08,'triangle',f,f,.12,.06))},
};
const lastSfx={};`);
// menu buttons: back (pink) / confirm (big) / plain click, a hover tick (mouse and pad focus), and a deny on locked items
rep(`ui.addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(!b||b.disabled)return;audioInit();sfx('select');`,
  `{let hov=null;ui.addEventListener('mouseover',e=>{const b=e.target.closest('[data-act]');if(b!==hov){hov=b;if(b&&!b.disabled)sfx('hover')}})}
ui.addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(!b&&e.target.closest('.locked')){audioInit();sfx('deny');return}if(!b||b.disabled)return;audioInit();sfx(b.classList.contains('pink')?'back':b.classList.contains('big')?'confirm':'select');`);
rep(`if(dir&&els[PAD.focus])els[PAD.focus].scrollIntoView(`, `if(dir)sfx('hover');if(dir&&els[PAD.focus])els[PAD.focus].scrollIntoView(`);
rep(`  if(on){state='paused';`, `  sfx(on?'pause':'resume');if(on){state='paused';`);
// run flow
rep(`G.phase='dead';G.phaseT=3.2;G.shake=1.2;`, `G.phase='dead';G.phaseT=3.2;G.shake=1.2;sfx('gameover');`);
rep(`state='over';if(won)sfx('win');`, `state='over';if(won)sfx('win');else if(G.phase!=='dead')sfx('gameover');`);
rep(`function clientOver(d){`, `function clientOver(d){if(d&&d.won)sfx('win');`);
rep(`G.prog=0;G.phase='travel';`, `if(G.region===0&&!G.demo)sfx('warp');G.prog=0;G.phase='travel';`);
rep(`function enterReady(){`, `function enterReady(){sfx('ready');`);
rep(`banner(def.name+'!',def.sub,2.4,def.col);markSeen('w_'+def.k)}`, `banner(def.name+'!',def.sub,2.4,def.col);sfx('weather');markSeen('w_'+def.k)}`);
rep(`sfx('explode');fxLight(e.x,e.z,6);comic(e.x,e.z,'KA-BLAMMO!'`, `sfx('explode');sfx('win');fxLight(e.x,e.z,6);comic(e.x,e.z,'KA-BLAMMO!'`);
// combat feedback
rep(`m.hp-=dmg;m.flash=.08;`, `m.hp-=dmg;m.flash=.08;sfx('podhit');`);
rep(`e.hp-=dmg;if(dmg>=2){`, `e.hp-=dmg;if(dmg>=2){sfx('ehit');`);
rep(`if(e.shield<=0){burst(e.x,e.z,e.maxhp<200?6:14,`, `if(e.shield<=0){sfx('shielddown');burst(e.x,e.z,e.maxhp<200?6:14,`);
rep(`p.inv=2;shock(0,0,2.5,'#4af0ff',.5)}return}`, `p.inv=2;shock(0,0,2.5,'#4af0ff',.5);sfx('respawn')}return}`);
rep(`ready=G.ultC>=1&&!G.ult;`, `ready=G.ultC>=1&&!G.ult;if(ready&&!G.ultRdy)sfx('charged');G.ultRdy=ready;`);
rep(`)G.packFullT=.3;`, `){if(!(G.packFullT>0))sfx('full');G.packFullT=.3}`);
// cards, events, co-op lobby
rep(`state='cards';G.cardKind=kind;`, `if(!again)sfx('cards');state='cards';G.cardKind=kind;`);
rep(`comic(n.x,n.z,'STAR - STAR - STAR','#ff6ad8',1.4);`, `comic(n.x,n.z,'STAR - STAR - STAR','#ff6ad8',1.4);sfx('chest');`);
rep(`comic(n.x,n.z,'GEAR - GEAR - GEAR','#4af0ff',1.4);`, `comic(n.x,n.z,'GEAR - GEAR - GEAR','#4af0ff',1.4);sfx('build');`);
rep(`comic(n.x,n.z,'AWW, NOTHING!','#c8b6ff',1.2)}`, `{comic(n.x,n.z,'AWW, NOTHING!','#c8b6ff',1.2);sfx('aww')}}`);
rep(`comic(n.x,n.z,'CHERRY - LEMON - BOOT','#c8b6ff',1.2);`, `comic(n.x,n.z,'CHERRY - LEMON - BOOT','#c8b6ff',1.2);sfx('aww');`);
rep(`n.saved=true;comic(n.x,n.z,'MY HERO!','#4af0ff',1.4);`, `n.saved=true;comic(n.x,n.z,'MY HERO!','#4af0ff',1.4);sfx('levelup');`);
rep(`if(!force)floatText(c.x,c.z,'IT GOT AWAY...','#ffe94a')`, `if(!force){floatText(c.x,c.z,'IT GOT AWAY...','#ffe94a');sfx('aww')}`);
rep(`if(!NET.lobby.find(p=>p.id===d.id))NET.lobby.push(`, `if(!NET.lobby.find(p=>p.id===d.id))sfx('join'),NET.lobby.push(`);
// per-hit ticks and the local "ability charged" cue are per machine; don't replay the host's on joiners
rep(`const SFX_SKIP=new Set(['pickup',`, `const SFX_SKIP=new Set(['ehit','charged','hover','ui','back','confirm','pause','resume','pickup',`);

// stats & achievements: mirrored from the hangar save every time the game writes it, so they back-fill from an
// existing save. Co-op wins come from the end-of-run hooks (host: endRun, joiner: clientOver); a co-op win is shared.
const GLUE = `<script>
/* Pickle Game Library: stats & achievements */
(function () {
  var last = {};
  function stat(S, k, v) { if (last[k] === v) return; last[k] = v; S.setStat(k, v, true); }
  function glSync() {
    var S = window.GameSDK;
    if (!S || !meta) return;
    try {
      var A = meta.ach || {}, n = Object.keys(A).length;
      stat(S, 'total_runs', meta.runs || 0);
      stat(S, 'wins', meta.wins || 0);
      stat(S, 'total_kills', meta.totalKills || 0);
      if (meta.bestHeat >= 0) stat(S, 'best_heat', meta.bestHeat);
      stat(S, 'achievements_earned', n);
      if ((meta.runs || 0) >= 1) S.unlockAchievement('liftoff', 'Liftoff');
      if (A.boss1) S.unlockAchievement('whale_watcher', 'Whale Watcher');
      if (A.casino) S.unlockAchievement('high_roller', 'High Roller');
      if ((meta.totalKills || 0) >= 1000) S.unlockAchievement('bonk_legend', 'Bonk Legend');
      if ((meta.wins || 0) >= 1) S.unlockAchievement('sorry_gerald', 'Sorry, Gerald');
      if (meta.bestHeat >= 10) S.unlockAchievement('too_hot', 'Too Hot to Handle');
      if (n >= 20) S.unlockAchievement('trophy_hunter', 'Trophy Hunter');
    } catch (e) {}
  }
  function coopWin() {
    var S = window.GameSDK; if (!S) return;
    S.incrementStat('online_wins');
    S.unlockAchievement('crew_goals', 'Crew Goals');
  }
  var save = saveMeta;
  saveMeta = function () { var r = save.apply(this, arguments); glSync(); return r; };
  var end = endRun;
  endRun = function (win) {
    var coop = NET.role === 'host' && NET.conns.length > 0 && (win || (G && G.won));
    var r = end.apply(this, arguments); if (coop) coopWin(); return r;
  };
  var over = clientOver;
  clientOver = function (d) { var r = over.apply(this, arguments); if (d && d.won) coopWin(); return r; };
  glSync();
})();
</script>
`;
// Library room browser (LobbySDK discovery only, pattern 3): a public host still in the lobby with a free seat is
// listed under OPEN ROOMS on everyone's co-op screen; private = code only. The game keeps its own PeerJS netcode;
// peerId = the bare room code, fed straight back into netJoin().
const ROOMS = `<script>
/* Pickle Game Library: co-op room browser */
(function () {
  var ad = { h: null, busy: false, code: '' }, rooms = null, roomsT = -1e9, roomsBusy = false;
  function glNetAd() {
    var sdk = window.LobbySDK;
    var want = sdk && sdk.advertiseRoom && NET.role === 'host' && !NET.local && !NET.glPriv && NET.peer && NET.peer.open
      && state === 'mp' && NET.lobby.length < 4 ? NET.code : '';
    if (ad.h && ad.code !== want) { ad.h.close(); ad.h = null; }
    if (want && !ad.h && !ad.busy) {
      ad.busy = true;
      sdk.advertiseRoom('galaxy_rush', want).then(function (h) { ad.busy = false; ad.h = h; ad.code = want; glNetAd(); }, function () { ad.busy = false; });
    }
  }
  addEventListener('beforeunload', function () { if (ad.h) ad.h.close(); });

  function drawRooms() {
    var box = document.getElementById('gl-rooms'); if (!box) return;
    var list = box.querySelector('.keygrid'); list.textContent = '';
    box.querySelector('.gl-rn').textContent = rooms ? rooms.length + ' open' : roomsBusy ? 'looking...' : 'unavailable';
    if (!rooms || !rooms.length) {
      var e = document.createElement('div'); e.className = 'hint';
      e.textContent = rooms ? 'No open rooms right now. Host one, or join a friend with their code.' : roomsBusy ? 'Looking for rooms...' : 'Room list unavailable.';
      list.appendChild(e); return;
    }
    rooms.forEach(function (r) {
      var row = document.createElement('div'); row.className = 'krow';
      var n = document.createElement('span'); n.textContent = '\\u{1F6F0}\\uFE0F ' + r.hostName + "'s room";
      var b = document.createElement('button'); b.className = 'btn'; b.style.cssText = 'margin:0;padding:4px 14px;font-size:15px'; b.textContent = 'JOIN ' + r.peerId;
      b.onclick = function () { var ni = document.getElementById('mpname'); if (ni) NET.name = ni.value.trim(); netJoin(r.peerId); };
      row.append(n, b); list.appendChild(row);
    });
  }
  function fetchRooms(force) {
    var sdk = window.LobbySDK;
    if (!sdk || !sdk.listRooms || roomsBusy || (!force && performance.now() - roomsT < 8000)) return;
    roomsBusy = true; drawRooms();
    sdk.listRooms('galaxy_rush').then(function (r) { rooms = r; }, function () { rooms = null; }).then(function () {
      roomsBusy = false; roomsT = performance.now(); drawRooms(); });
  }
  // refresh the list every 8 s while the join screen is up
  setInterval(function () { if (state === 'mp' && !NET.role && document.getElementById('gl-rooms')) fetchRooms(); }, 8000);

  var show = showMP;
  showMP = function () {
    var r = show.apply(this, arguments);
    var panel = document.querySelector('#ui .panel');
    if (panel && !NET.role && window.LobbySDK && !NET.local) {
      var box = document.createElement('div'); box.id = 'gl-rooms';
      box.innerHTML = '<div class="sect" style="display:flex;align-items:center;gap:10px">OPEN ROOMS <span class="dim gl-rn"></span>'
        + '<button class="btn" style="margin:0 0 0 auto;padding:3px 12px;font-size:13px">REFRESH</button></div><div class="keygrid" style="margin-top:6px;grid-template-columns:repeat(auto-fill,minmax(330px,1fr))"></div>';
      box.querySelector('button').onclick = function () { fetchRooms(true); };
      var at = panel.querySelector('.mpcs'); if (at) at.after(box); else panel.appendChild(box);
      drawRooms(); fetchRooms();
    }
    if (panel && NET.role === 'host' && !NET.local && window.LobbySDK) {
      var lab = document.createElement('label'); lab.className = 'hint'; lab.style.cssText = 'display:block;text-align:center';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !NET.glPriv;
      cb.onchange = function () { NET.glPriv = !cb.checked; glNetAd(); };
      lab.append(cb, ' List this room publicly (anyone can join from OPEN ROOMS; friends can always use the code)');
      var st = panel.querySelector('[data-act="mpstart"]'); if (st) st.before(lab); else panel.appendChild(lab);
    }
    glNetAd();
    return r;
  };
  var leave = netLeave;
  netLeave = function () { var r = leave.apply(this, arguments); glNetAd(); return r; };
  var start = hostStartGame;
  hostStartGame = function () { var r = start.apply(this, arguments); glNetAd(); return r; };
})();
</script>
`;
rep(`</script>\n</body>\n</html>`, `</script>\n${GLUE}${ROOMS}</body>\n</html>`);

if (!h.trimEnd().endsWith('</html>') || h.split('</html>').length !== 2) throw new Error('bad tail');
fs.writeFileSync(out, h);
console.log('ok', h.length);
