// Applies the Pickle Game Library integration layer to Jertal's StarFall build.
// node partners/jertal/starfall/patch.mjs <outFile>   (partners/build.mjs runs it; source/starfall-standalone.html is Jertal's untouched build)
import fs from 'node:fs';
const out = process.argv[2];
let h = fs.readFileSync(new URL('./source/starfall-standalone.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function rep(from, to) {
  const n = h.split(from).length - 1;
  if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${from.slice(0, 80)}`);
  h = h.replace(from, () => to);
}

// menu: the Quit button becomes the library's Exit Game (confirmed)
rep(`<button class="mbtn" data-action="exit">Quit</button>`,
    `<button class="mbtn danger" id="gl-exit-btn" data-action="glexit">Exit Game</button>`);

// confirm-dialog convention: cancel left, confirm right
rep(`<div class="ovfoot"><button class="primary" data-action="quityes">Leave</button><button data-action="quitno">Keep playing</button></div>`,
    `<div class="ovfoot"><button data-action="quitno">Keep playing</button><button class="primary" data-action="quityes">Leave</button></div>`);

// audio: volume sliders beside the Sound / Music toggles
rep(`const SET_DEF={fx:true,ai:1,preview:true,sound:true,music:true,intro:true};`,
    `const SET_DEF={fx:true,ai:1,preview:true,sound:true,music:true,intro:true,sfxVol:100,musicVol:100};`);
rep(`\${row('Sound','Card slaps, chimes, the clash and the coin',tgl('sound',SET.sound))}`,
    `\${row('Sound','Card slaps, chimes, the clash and the coin',tgl('sound',SET.sound)+\`<input type="range" class="glvol" min="0" max="100" data-k="sfxVol" value="\${SET.sfxVol}" aria-label="Sound volume">\`)}`);
rep(`\${row('Music','The theme, looping quietly under the game',tgl('music',SET.music))}`,
    `\${row('Music','The theme, looping quietly under the game',tgl('music',SET.music)+\`<input type="range" class="glvol" min="0" max="100" data-k="musicVol" value="\${SET.musicVol}" aria-label="Music volume">\`)}`);
rep(`  vol:.8,\n  play(name){`, `  get vol(){ return .8*SET.sfxVol/100; },\n  play(name){`);
rep(`const MUSIC={el:null,vol:.12,introVol:.085,`,
    `const MUSIC={el:null,get vol(){ return .12*SET.musicVol/100; },get introVol(){ return .085*SET.musicVol/100; },`);

// F (fullscreen) must not fire while typing a connect code or nudging a slider
rep(`addEventListener('keydown',e=>{ if((e.key==='f'||e.key==='F')&&`,
    `addEventListener('keydown',e=>{ if(e.target&&e.target.closest&&e.target.closest('input,textarea')) return; if((e.key==='f'||e.key==='F')&&`);

// online: Play online opens the library's LobbySDK room browser (handler in GLUE); without the
// SDK (standalone file) it falls back to Jertal's copy-paste Direct Connect screen
rep(`<button class="mbtn" data-action="goto" data-s="online">Play online</button>`,
    `<button class="mbtn" data-action="glonline">Play online</button>`);
// backing out of the online crown select must actually hang up, not just forget the role
rep(`if(s==='menu'){ NET.role=null;`, `if(s==='menu'){ if(NET.ch) netLeave(); NET.role=null;`);

// ---- bug fixes to Jertal's code (review 2026-09-30) ----
// Taraldon's 4★ "+1 power for the rest of the game" was wiped by any lit power tier on a non-Charge card
rep(`if(t.power!=null) e.power=t.power+(d.charge?(c.bonus||0):0);`, `if(t.power!=null) e.power=t.power+(c.bonus||0);`);
// a stale AI timer from a left game cleared the NEW game's AI flags, which could loop the AI turn forever
// ...and the AI now waits while the pause / settings / leave-confirm overlay is up
rep(`const step=()=>{ if(UI.game!==g){ UI.aiBusy=false; UI.aiStep=null; return; }`,
    `const step=()=>{ if(UI.game!==g) return; if(UI.paused||UI.settings||UI.confirmQuit){ setTimeout(step,250); return; }`);
// hotseat: the old viewer's hand showed through the semi-transparent "Pass to" screen
rep("if(UI.pass) return `<div class=\"ov\">", "if(UI.pass) return `<div class=\"ov\" style=\"background:#100a09\">");
// online: the host resolved a guest-sent defense even when the guest was the attacker
rep(`else if(m.fn==='resolveDefense'){ act(()=>g.resolveDefense(1,a[1])); }`,
    `else if(m.fn==='resolveDefense'){ if(g.s.phase==='defense'&&g.s.active===0&&!g.pending) act(()=>g.resolveDefense(1,a[1])); }`);
// online: a drop in the crown lobby or on the result screen went unnoticed; the other side waited forever
rep(`ch.onclose=()=>{ NET.open=false; NET.note='disconnected'; if(UI.screen==='game'&&UI.game&&UI.game.s.phase!=='gameover') UI.netLost=true; render(); };`,
    `ch.onclose=()=>{ NET.open=false; NET.note='disconnected'; if(NET.role&&(UI.screen==='setup'||UI.screen==='game')) UI.netLost=true; render(); };`);
rep(`if(UI.netLost&&UI.screen==='game') return`, `if(UI.netLost&&(UI.screen==='game'||UI.screen==='setup')) return`);
// a new session starts clean: no stale lost-link flag, no sealed Random crown left over from a local game
rep(`ch.onopen=()=>{ NET.open=true; NET.note='connected'; UI.hotseat=false;`,
    `ch.onopen=()=>{ NET.open=true; NET.note='connected'; UI.hotseat=false; UI.netLost=false; UI.rand=[false,false];`);
// online: confirming before touching a crown started the game with the host's leftover AI crown for you
rep(`function netReady(on){ if(!NET.role) return; const me=NET.role==='guest'?1:0;`,
    `function netReady(on){ if(!NET.role) return; const me=NET.role==='guest'?1:0; if(on&&!NET.picked[me]) return;`);
// online: the host's crown echo reset the guest's view of the host's "confirmed" flag
rep(`if(m.t==='king'){ UI.kings[m.i]=m.id; NET.picked[m.i]=true; NET.ready[m.i]=false;`,
    `if(m.t==='king'){ if(UI.kings[m.i]!==m.id) NET.ready[m.i]=false; UI.kings[m.i]=m.id; NET.picked[m.i]=true;`);

// ---- rules fixes (Nic, 2026-09-30) ----
// Emira's "your purchases cost 2 less" now covers star pieces (starCost read a never-set starDiscount),
// and Ryogen's undocumented +1/+2 tax on the opponent's star pieces is gone
rep(`cost-=P.starDiscount; cost=Math.max(1,cost); const ry=this.hasCourtier(1-p,'ryogen'); if(ry) cost+=this.lit(1-p,4)?2:1; return`,
    `cost-=P.purchaseDiscount; cost=Math.max(1,cost); return`);
// the 80-turn draw was meant for AI-vs-AI sims only
rep(`if(s.turn>=CFG.maxTurns){`, `if(s.turn>=CFG.maxTurns&&this.isAI(0)&&this.isAI(1)){`);
// White Lions / Oni: "the card before this" is the last card resolved, including a Ryogen borrow or
// an Ember Vow burn (played[len-2] skipped both). prevCard/lastCard live in state, reset each turn.
rep(`*gResolveCard(p,c,borrowed){ const s=this.s, P=this.P(p); P.cardsPlayed++;`,
    `*gResolveCard(p,c,borrowed){ const s=this.s, P=this.P(p); P.cardsPlayed++; P.prevCard=P.lastCard||null; P.lastCard=c;`);
rep(`purchaseDiscount:0,starDiscount:0,finalized:false,burned:0`, `purchaseDiscount:0,starDiscount:0,finalized:false,lastCard:null,prevCard:null,burned:0`);
rep(`fx:function*(g,p,c){ const P=g.P(p); const prev=P.played[P.played.length-2]; if(!prev) return;`,
    `fx:function*(g,p,c){ const P=g.P(p); const prev=P.prevCard; if(!prev) return;`);
rep(`fx:function*(g,p){ const P=g.P(p); const prev=P.played[P.played.length-2]; if(prev&&D(prev).cost>=8)`,
    `fx:function*(g,p){ const P=g.P(p); const prev=P.prevCard; if(prev&&D(prev).cost>=8)`);
// Jarl: only the discard pile is shuffled, under the deck - a card set on top this turn stays on top
rep(`P.deck=shuffle(P.deck.concat(P.discard)); P.discard=[];`, `P.deck=P.deck.concat(shuffle(P.discard)); P.discard=[];`);
// Hakim: with the unit deck empty the "swap" pulled the same card straight back and still paid out
rep(`command:function*(g,p){ const row=g.s.unitRow; if(!row.length) return; const [c]=yield* g.pick(p,{prompt:'The units row: send one away.`,
    `commandOK:(g,p)=>!!g.s.unitRow.length&&!!g.s.unitDeck.length,
  command:function*(g,p){ const row=g.s.unitRow; if(!row.length||!g.s.unitDeck.length) return; const [c]=yield* g.pick(p,{prompt:'The units row: send one away.`);
rep(`if(id==='hakim') ok=g.s.unitRow.length>0;`, `if(id==='hakim') ok=g.s.unitRow.length>0&&g.s.unitDeck.length>0;`);

// ---- online polish ----
// a predicted unit buy that refills the row drew from the guest's blanked unit deck: a phantom Levy
rep(`if(fn==='buyUnit'||fn==='buyCourtier'||fn==='buyStar') return true;`,
    `if(fn==='buyUnit') return P.bought.unit+1>=g.unitBuysMax(p);
  if(fn==='buyCourtier'||fn==='buyStar') return true;`);
// an unchanged snapshot cleared SYNCING without redrawing, so the pill stayed up
rep(`if(raw&&raw===NET.lastRecv&&!UI.predicted){ UI.netWait=0; return; }`,
    `if(raw&&raw===NET.lastRecv&&!UI.predicted){ if(UI.netWait){ UI.netWait=0; render(); } return; }`);

// the guest never runs startGame, so it never started the weather: start it on the first snapshot of a game
rep(`UI.screen='game'; UI.viewer=1; UI.pass=false; UI.netWait=0;`,
    `UI.screen='game'; UI.viewer=1; UI.pass=false; UI.netWait=0; if(!prev) fxInit(UI.game.kingDef(0).realm,UI.game.kingDef(1).realm);`);

// ---- hidden hands: the opponent's deck and discard open ONE list of every card they own ----
// Deck contents minus what's public used to give away their exact hand. Online, the host sends the guest
// that list (deck + hand, sorted) as players[0].owned and blanks the deck itself.
rep(`c.players[0].deck=c.players[0].deck.slice().sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:a.uid-b.uid);`,
    `c.players[0].owned=c.players[0].deck.concat(structuredClone(s.players[0].hand)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:a.uid-b.uid);
  c.players[0].deck=blank(c.players[0].deck);`);
rep(`let cards=v.z==='deck'?P.deck.slice():P.discard.slice().reverse(); let note='';`,
    `if(!mine){ const all=(P.owned||P.deck.concat(P.hand)).concat(P.discard,P.played).sort((a,b)=>D(a).cost-D(b).cost||D(a).name.localeCompare(D(b).name));
    return \`<div class="ov" data-action="pileclose"><div class="box" data-action="pilebox"><h2>\${who} deck · \${all.length} card\${all.length===1?'':'s'}</h2>
    <div class="pilelist">\${all.length?all.map(c=>cardHTML(c,p,{cls:'mini'})).join(''):'<span class="empty">EMPTY</span>'}</div>
    <div class="pilenote">EVERY CARD THEY OWN · HAND, DECK AND DISCARD TOGETHER</div><div class="actions"><button class="primary" data-action="pileclose">Close</button></div></div></div>\`; }
  let cards=v.z==='deck'?P.deck.slice():P.discard.slice().reverse(); let note='';`);
// ...and hover / inspect can find those cards on the guest
rep(`for(const z of [P.hand,P.discard,P.played,P.court,P.deck,P.exiled]){ const c=z.find`,
    `for(const z of [P.hand,P.discard,P.played,P.court,P.deck,P.exiled,P.owned||[]]){ const c=z.find`);
rep(`for(const z of [P.hand,P.discard,P.played,P.court,P.deck,P.exiled]) if(z.some`,
    `for(const z of [P.hand,P.discard,P.played,P.court,P.deck,P.exiled,P.owned||[]]) if(z.some`);

// ---- small polish ----
// the weather rAF loop ran forever on the menu after the first game
rep(`function leaveGame(){ if(NET.role) netLeave();`, `function leaveGame(){ if(NET.role) netLeave(); fxStop();`);
rep(`function playAgain(){ UI.game=null;`, `function playAgain(){ fxStop(); UI.game=null;`);
// no auto-fullscreen on the first click: in the launcher it takes over the window (F and Settings still toggle it)
rep(`(function(){ const go=()=>{ goFullscreen();
    removeEventListener('pointerdown',go,true); removeEventListener('keydown',go,true); };
  addEventListener('pointerdown',go,true); addEventListener('keydown',go,true); })();`, ``);

// Compendium: left click opens the inspector too (handler is in GLUE)
rep(`<span>Right-click a card to see it full size · hover`, `<span>Click a card to see it full size · hover`);

// styles for the added pieces
rep(`</style>\n</head>`, `/* Pickle Game Library */
.glvol{width:110px;margin-left:10px;vertical-align:middle;accent-color:var(--gold);cursor:pointer}
/* primary/danger are always gold/red, so the generic button:hover changed nothing on Play / Exit Game */
.mbtn.primary,.mbtn.danger{filter:brightness(.82);transition:filter .15s,box-shadow .15s}
.mbtn.primary:hover,.mbtn.danger:hover{filter:brightness(1.2);color:#fff}
.mbtn.primary:hover{box-shadow:0 0 18px rgba(232,194,106,.45),0 4px 10px rgba(0,0,0,.5)}
.mbtn.danger:hover{border-color:var(--danger);box-shadow:0 0 18px rgba(255,107,74,.45),0 4px 10px rgba(0,0,0,.5)}
.galgrid .c{cursor:zoom-in}
#gl-exit-confirm{position:fixed;inset:0;z-index:1000;align-items:center;justify-content:center;background:rgba(8,5,4,.72)}
#gl-player-chip{position:fixed;left:18px;top:14px;z-index:900;align-items:center;gap:8px;font-family:Cinzel,Georgia,serif;
  font-size:13px;letter-spacing:.14em;color:var(--parch);opacity:.72;pointer-events:none;text-shadow:0 2px 6px #000}
</style>
</head>`);

// the integration layer, after the game's own script
const GLUE = `
<!-- Pickle Game Library: exit confirm, player chip, volume, stats & achievements -->
<div id="gl-player-chip" style="display:none"></div>
<div id="gl-exit-confirm" style="display:none"><div class="ovbox">
  <h3>EXIT GAME?</h3>
  <p class="ovtext">The window closes. A game in progress is not saved.</p>
  <div class="ovfoot"><button id="gl-exit-no">Cancel</button><button class="primary" id="gl-exit-yes">Exit</button></div>
</div></div>
<script>
(function(){
  // exit confirm (the menu button is re-rendered, so its click is delegated)
  var ov=document.getElementById('gl-exit-confirm');
  function show(){ ov.style.zoom=String(Math.max(1,UI.scale||1)); ov.style.display='flex'; }
  function hide(){ ov.style.display='none'; }
  document.addEventListener('click',function(e){ if(e.target.closest&&e.target.closest('#gl-exit-btn')) show(); });
  document.getElementById('gl-exit-no').addEventListener('click',hide);

  // online through LobbySDK (legacy 1-1 pattern): a stand-in data channel so Jertal's netBind /
  // netSend / netPush / netRecv run unchanged. Host = seat 0, joiner = seat 1, exactly as before.
  document.addEventListener('click',function(e){
    if(!(e.target.closest&&e.target.closest('[data-action="glonline"]'))) return;
    if(!window.LobbySDK){ UI.screen='online'; render(); return; }
    if(NET.ch) netLeave();
    // closed: we hung up ourselves, so the SDK's disconnect is not a lost link
    var closed=false, ch={send:function(s){ LobbySDK.send(s); }, close:function(){ closed=true; LobbySDK.closeLobby(); }}, early=[];
    function deliver(d){ ch.onmessage({data:typeof d==='string'?d:JSON.stringify(d)}); }
    LobbySDK.init('starfall',{
      onConnected:function(isHost){ NET.role=isHost?'host':'guest'; NET.pc=null; netBind(ch); ch.onopen();
        early.splice(0).forEach(deliver);
        // the SDK reports the host's connect ~1 s late; a joiner who dropped inside that gap is already gone
        if(isHost&&!LobbySDK.getPeers().length) ch.onclose(); },
      // the host's opening crown can land before our own onConnected: hold it, don't drop it
      onData:function(d){ if(NET.ch===ch) deliver(d); else if(!NET.ch) early.push(d); },
      onDisconnected:function(){ if(NET.ch===ch&&!closed) ch.onclose(); }
    });
    LobbySDK.openLobby();
  });

  // Compendium: left click opens the card inspector, same as the game's right click
  document.addEventListener('click',function(e){
    if(UI.screen!=='cards'||INSP.classList.contains('open')) return;
    var el=e.target.closest&&e.target.closest('.galgrid .c[data-cid],.galgrid .c[data-kid]');
    if(el) openInspect(el);
  });
  ov.addEventListener('click',function(e){ if(e.target===ov) hide(); });
  document.getElementById('gl-exit-yes').addEventListener('click',function(){ try{ MUSIC.halt(); }catch(e){} window.close(); });
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&ov.style.display!=='none'){ e.stopPropagation(); hide(); }
  },true);

  // player chip, main menu only
  var chip=document.getElementById('gl-player-chip'), chipOn=false;
  try{ var q=new URLSearchParams(location.search), nm=(q.get('playerName')||'').trim();
    if(nm){ var em=document.createElement('span'); em.textContent=q.get('playerEmblem')||'';
      chip.appendChild(em); chip.appendChild(document.createTextNode(' '+nm)); chipOn=true; } }catch(e){}

  // volume sliders: live while dragging; the slider always wins over the mute toggle
  document.addEventListener('input',function(e){
    var el=e.target; if(!el.classList||!el.classList.contains('glvol')) return;
    var k=el.dataset.k; SET[k]=+el.value;
    var flip=k==='sfxVol'?'sound':'music';
    if(!SET[flip]){ SET[flip]=true; var b=el.parentNode.querySelector('.tgl'); if(b){ b.classList.add('on'); b.textContent='On'; } }
    setSave();
    if(k==='musicVol'){ var a=MUSIC.el; if(a&&!a.paused&&(MUSIC.wanted||MUSIC.introing)){ clearInterval(MUSIC._f); a.volume=MUSIC.introing?MUSIC.introVol:MUSIC.vol; } MUSIC.apply(); }
  });
  document.addEventListener('change',function(e){ if(e.target.classList&&e.target.classList.contains('glvol')&&e.target.dataset.k==='sfxVol') SFX.play('buy'); });

  // stats & achievements. Seat 0 is the human against the AI; online it is the seat this
  // machine plays. Hotseat has no "me", so it only counts games played.
  var doneGid=null, WIN_KEYS={galendor:'wins_galendor',akha:'wins_akha',rulentia:'wins_rulentia',
    yoren:'wins_yoren',fjord:'wins_fjord',alutep:'wins_alutep'};
  function seat(){ if(UI.hotseat) return -1; if(NET.role) return NET.role==='host'?0:1; return 0; }
  function watch(){
    chip.style.display=chipOn&&UI.screen==='menu'&&!INTRO.active?'inline-flex':'none';
    var SDK=window.GameSDK, g=UI.game; if(!SDK||!g||UI.screen!=='game') return;
    var s=g.s, me=seat();
    if(me>=0){
      if(g.P(me).stars>=6) SDK.unlockAchievement('six_stars','Full Constellation');
      var c=s.clash; if(c&&c.hit&&c.a===me&&c.total>=100) SDK.unlockAchievement('starbreaker','Starbreaker');
    }
    if(s.phase!=='gameover'||doneGid===s.gid) return; doneGid=s.gid;
    SDK.incrementStat('games_played');
    SDK.unlockAchievement('first_game','The Star Falls');
    if(me<0) return;
    var P=g.P(me);
    if(s.winner!==me) return;
    if(NET.role){ SDK.incrementStat('online_wins'); SDK.unlockAchievement('online_victory','Across the Void'); }
    else SDK.unlockAchievement('first_victory','Crowned');
    if(!P.livesLost) SDK.unlockAchievement('flawless','Unbroken Walls');
    // wins vs AI and online, per king
    if(WIN_KEYS[P.king]) SDK.incrementStat(WIN_KEYS[P.king]);
    var st=SDK.getStats()||{}, total=0, kings=0;
    for(var k in WIN_KEYS){ var w=st[WIN_KEYS[k]]||0; total+=w; if(w>0) kings++; }
    if(total>=10) SDK.unlockAchievement('warlord','Warlord of the Realms');
    if(kings>=6) SDK.unlockAchievement('all_crowns','Six Crowns');
  }
  render=(function(r){ return function(){ r.apply(this,arguments); try{ watch(); }catch(e){} }; })(render);
  watch();
})();
</script>
</body>`;
rep(`probeArt(); render(); INTRO.maybePlay();\n</script>\n</body>`, `probeArt(); render(); INTRO.maybePlay();\n</script>${GLUE}`);

if (!h.trimEnd().endsWith('</html>') || h.split('</html>').length !== 2) throw new Error('bad tail');
fs.writeFileSync(out, h);
console.log('ok', h.length);
