/**
 * Pickle Arcade — Online Lobby SDK  v2.0
 *
 * Injected by preload.js into every multiplayer game window.
 * Provides:
 *   • Firebase Anonymous Auth + Firestore lobby listing (via REST, no bundler needed)
 *   • PeerJS P2P connection management (loaded from CDN)
 *   • Lobby overlay UI (host / join)
 *   • Player name display in lobby listings
 *
 * ── Topology ────────────────────────────────────────────────────────────────
 * STAR. One HOST holds up to (maxPeers-1) joiner connections and acts as the hub;
 * joiners only ever talk to the host. The host is seat 0; joiners are numbered
 * 1,2,3… in join order. This matches how Catan and Rhino are host-authoritative:
 * the host runs the one true simulation and relays to everyone.
 *
 * ── Backward compatibility ──────────────────────────────────────────────────
 * maxPeers defaults to 1, meaning "one joiner" — i.e. exactly the old 1-1
 * behavior. Games that never pass maxPeers (Chess, Connect4, Battleship,
 * Checkers, Ultimate TTT, Poke Clash) behave byte-for-byte as before:
 *   • init(gameId, cbs)            → still works
 *   • send(data)                  → sends to the single peer (or, on a joiner, to host)
 *   • onConnected(isHost)         → fired once, as before
 *   • onData(data)                → receives game data, as before
 *
 * ── Multi-connection API (opt-in) ───────────────────────────────────────────
 *   init(gameId, cbs, { maxPeers: 6 })
 *   Callbacks (all optional):
 *     onConnected(isHost, myIndex)         once this peer is in the match
 *     onPeerJoined(index, name, emblem)    HOST only: a joiner took a seat
 *     onPeerLeft(index)                    HOST only: a joiner dropped
 *     onData(data, fromIndex)              data arrived; fromIndex = sender's seat
 *     onDisconnected()                     this peer's link to the match is gone
 *   Methods:
 *     broadcast(data)        HOST: send same data to every joiner
 *     sendTo(index, data)    HOST: send data to one specific joiner seat
 *     sendToHost(data)       JOINER: send data to the host
 *     send(data)             compatibility shim:
 *                              • HOST  → broadcast(data)
 *                              • JOINER→ sendToHost(data)
 *     getPeers()             HOST: [{index,name,emblem}] of connected joiners
 *     myIndex()              this peer's seat (0 = host)
 */
(function () {
  // ── Config ──────────────────────────────────────────────────────────────────
  const API_KEY    = 'AIzaSyDu8OygdH9Fft-3XcHD5Vzp8SnXgKt6mXk';
  const PROJECT_ID = 'pickle-arcade-lobbies';
  const FS_BASE    = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';
  const AUTH_URL   = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + API_KEY;

  // ── State ───────────────────────────────────────────────────────────────────
  let idToken       = null;
  let peer          = null;
  let myLobbyDocId  = null;
  let refreshTimer  = null;
  let callbacks     = {};
  let currentGameId = null;
  let maxPeers      = 1;          // how many JOINERS the host accepts (1 = legacy 1-1)
  let isHost        = false;
  let mySeat        = -1;         // 0 = host; joiners get 1,2,3… ; -1 = not in a match
  let started       = false;     // host has launched the match (lobby closed to new seats)

  // HOST side: connected joiners.  conns[i] = { conn, index, name, emblem }
  let conns         = [];
  let nextSeat      = 1;          // next seat number to hand out

  // JOINER side: the single connection back to the host
  let hostConn      = null;
  let peerName      = 'Player';   // (legacy) name of connected opponent in 1-1 UI
  let peerEmblem    = '';

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function getPlayerName() {
    return (window.__picklePlayerName || 'Player').trim() || 'Player';
  }
  function getPlayerEmblem() {
    return (window.__picklePlayerEmblem || '🎮').trim() || '🎮';
  }
  function getPlayerDisplay() {
    return getPlayerEmblem() + ' ' + getPlayerName();
  }

  // ── Firebase Anonymous Auth ─────────────────────────────────────────────────
  async function ensureAuth() {
    if (idToken) return;
    const res  = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    idToken = data.idToken;
  }

  function authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (idToken) h['Authorization'] = 'Bearer ' + idToken;
    return h;
  }

  // ── Firestore Helpers ───────────────────────────────────────────────────────
  async function listLobbies(gameId) {
    await ensureAuth();
    const res  = await fetch(FS_BASE + ':runQuery', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'lobbies' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'gameId' },
              op: 'EQUAL',
              value: { stringValue: gameId },
            },
          },
          orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
          limit: 10,
        },
      }),
    });
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : [])
      .filter(r => r.document)
      .map(r => {
        const f = r.document.fields || {};
        return {
          docId:    r.document.name.split('/').pop(),
          hostName: f.hostName?.stringValue || 'Player',
          peerId:   f.peerId?.stringValue   || '',
        };
      });
  }

  async function createLobby(gameId, peerId) {
    await ensureAuth();
    const res = await fetch(FS_BASE + '/lobbies', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        fields: {
          gameId:    { stringValue: gameId },
          peerId:    { stringValue: peerId },
          hostName:  { stringValue: getPlayerDisplay() },
          createdAt: { integerValue: String(Date.now()) },
        },
      }),
    });
    const doc = await res.json();
    if (doc.error) throw new Error(doc.error.message);
    return doc.name.split('/').pop();
  }

  async function deleteLobby(docId) {
    if (!docId) return;
    try {
      await ensureAuth();
      await fetch(FS_BASE + '/lobbies/' + docId, {
        method: 'DELETE',
        headers: authHeaders(),
      });
    } catch (e) { /* best-effort */ }
  }

  // ── PeerJS ──────────────────────────────────────────────────────────────────
  function loadPeerJS() {
    return new Promise((resolve, reject) => {
      if (window.Peer) { resolve(); return; }
      const s = document.createElement('script');
      s.src    = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      s.onload  = resolve;
      s.onerror = () => reject(new Error('Failed to load PeerJS'));
      document.head.appendChild(s);
    });
  }

  function createPeer() {
    return new Promise((resolve, reject) => {
      const p = new window.Peer();
      const t = setTimeout(() => reject(new Error('PeerJS timed out')), 12000);
      p.on('open', id => { clearTimeout(t); peer = p; resolve(id); });
      p.on('error', err => { clearTimeout(t); reject(err); });
    });
  }

  // ── HOST: accept an incoming joiner connection ──────────────────────────────
  function hostHandleConnection(c) {
    c.on('open', () => {
      // Reject if the match already started or all joiner seats are taken.
      if (started || conns.length >= maxPeers) {
        try { c.send({ type: '__lsdk_full' }); } catch (e) {}
        setTimeout(() => { try { c.close(); } catch (e) {} }, 200);
        return;
      }
      const seat = nextSeat++;
      const rec  = { conn: c, index: seat, name: 'Player', emblem: '' };
      conns.push(rec);

      // Tell the joiner its seat number and the host's identity.
      try {
        c.send({ type: '__lsdk_welcome', index: seat,
                 hostName: getPlayerName(), hostEmblem: getPlayerEmblem() });
      } catch (e) {}

      // For the legacy 1-1 overlay: surface "someone joined".
      const status = document.querySelector('#lsdk-content .lsdk-status');
      if (status) status.textContent = 'A player joined!';

      // In legacy single-peer mode, a join means "start the match" — fire onConnected
      // for the host and hide the overlay, exactly like the old setupConn flow.
      if (maxPeers === 1) {
        // wait briefly for the handshake so the name is known
        setTimeout(() => {
          started = true;
          if (myLobbyDocId) { deleteLobby(myLobbyDocId); myLobbyDocId = null; }
          closeOverlayAndStart(true);
        }, 400);
      }
    });

    c.on('data', data => {
      if (data && data.type === '__lsdk_handshake') {
        const rec = conns.find(r => r.conn === c);
        if (rec) { rec.name = data.playerName || 'Player'; rec.emblem = data.playerEmblem || ''; }
        peerName   = data.playerName   || 'Player';   // legacy 1-1 display
        peerEmblem = data.playerEmblem || '';
        const status = document.querySelector('#lsdk-content .lsdk-status');
        if (status) status.textContent = peerName + ' joined!';
        if (callbacks.onPeerJoined && rec) callbacks.onPeerJoined(rec.index, rec.name, rec.emblem);
        return;
      }
      const rec = conns.find(r => r.conn === c);
      const from = rec ? rec.index : -1;
      if (callbacks.onData) callbacks.onData(data, from);
    });

    const drop = () => {
      const i = conns.findIndex(r => r.conn === c);
      if (i >= 0) {
        const gone = conns[i].index;
        conns.splice(i, 1);
        if (callbacks.onPeerLeft) callbacks.onPeerLeft(gone);
      }
      // In legacy 1-1 mode, losing the one peer means the match is over.
      if (maxPeers === 1 && callbacks.onDisconnected) callbacks.onDisconnected();
    };
    c.on('close', drop);
    c.on('error', drop);
  }

  // ── JOINER: wire the single connection to the host ──────────────────────────
  function joinerSetupConn(c) {
    hostConn = c;
    c.on('open', () => {
      c.send({ type: '__lsdk_handshake', playerName: getPlayerName(), playerEmblem: getPlayerEmblem() });
    });
    c.on('data', data => {
      if (!data) return;
      if (data.type === '__lsdk_welcome') {
        mySeat     = data.index;
        peerName   = data.hostName   || 'Player';
        peerEmblem = data.hostEmblem || '';
        // Joiner is now seated. Fire onConnected and hide the overlay.
        closeOverlayAndStart(false);
        return;
      }
      if (data.type === '__lsdk_full') {
        setContent('<div class="lsdk-error">That room is full or already started.</div>' +
          '<button class="lsdk-btn-sm" onclick="window._lsdkSwitchTab(\'join\')">&#8592; Back</button>');
        hostConn = null;
        return;
      }
      // Real game data: fromIndex 0 (the host) on the joiner side.
      if (callbacks.onData) callbacks.onData(data, 0);
    });
    const drop = () => {
      hostConn = null;
      if (callbacks.onDisconnected) callbacks.onDisconnected();
    };
    c.on('close', drop);
    c.on('error', drop);
  }

  // ── Overlay UI helpers ──────────────────────────────────────────────────────
  function setContent(html) {
    const c = document.getElementById('lsdk-content');
    if (c) c.innerHTML = html;
  }

  function closeOverlayAndStart(asHost) {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    const displayPeer = (peerEmblem ? peerEmblem + ' ' : '') + peerName;
    const nameStr = peerName !== 'Player' ? ' — <strong>' + displayPeer + '</strong>' : '';
    setContent('<div class="lsdk-connecting" style="color:#4ade80">&#10003; Connected' + nameStr + '</div>');
    setTimeout(() => {
      const ov = document.getElementById('lsdk-overlay');
      if (ov) ov.style.display = 'none';
      if (callbacks.onConnected) callbacks.onConnected(asHost, mySeat);
    }, 900);
  }

  // ── Host panel ──────────────────────────────────────────────────────────────
  async function showHostPanel() {
    setContent('<div class="lsdk-connecting">Setting up<span class="lsdk-dot">.</span><span class="lsdk-dot">.</span><span class="lsdk-dot">.</span></div>');
    try {
      if (myLobbyDocId) { await deleteLobby(myLobbyDocId); myLobbyDocId = null; }
      if (peer) { try { peer.destroy(); } catch(e){} peer = null; }
      conns = []; nextSeat = 1; started = false;
      isHost = true; mySeat = 0;

      await loadPeerJS();
      const myId = await createPeer();
      myLobbyDocId = await createLobby(currentGameId, myId);

      if (maxPeers === 1) {
        setContent(
          '<div class="lsdk-status">Your room is open — waiting for opponent</div>' +
          '<div class="lsdk-dots-row"><span class="lsdk-dot">●</span><span class="lsdk-dot">●</span><span class="lsdk-dot">●</span></div>'
        );
      } else {
        setContent(
          '<div class="lsdk-status">Your room is open — waiting for players (up to ' + maxPeers + ')</div>' +
          '<div class="lsdk-dots-row"><span class="lsdk-dot">●</span><span class="lsdk-dot">●</span><span class="lsdk-dot">●</span></div>' +
          '<button class="lsdk-btn-sm" style="margin-top:14px" onclick="window._lsdkHostStart()">Start match</button>'
        );
      }

      peer.on('connection', c => hostHandleConnection(c));
    } catch (e) {
      setContent('<div class="lsdk-error">Setup failed: ' + e.message + '</div><button class="lsdk-btn-sm" onclick="window._lsdkRetryHost()">Retry</button>');
      window._lsdkRetryHost = showHostPanel;
    }
  }

  // HOST (multi): operator pressed "Start match" in the overlay.
  window._lsdkHostStart = function () {
    if (started) return;
    started = true;
    if (myLobbyDocId) { deleteLobby(myLobbyDocId); myLobbyDocId = null; }
    const ov = document.getElementById('lsdk-overlay');
    if (ov) ov.style.display = 'none';
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (callbacks.onConnected) callbacks.onConnected(true, 0);
  };

  // ── Join panel ──────────────────────────────────────────────────────────────
  async function showJoinPanel() {
    isHost = false;
    await refreshJoinList();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshJoinList, 5000);
  }

  async function refreshJoinList() {
    const container = document.getElementById('lsdk-content');
    if (!container) return;
    try {
      const rooms = await listLobbies(currentGameId);
      if (rooms.length === 0) {
        setContent(
          '<div class="lsdk-empty">No open rooms found. Host one!</div>' +
          '<button class="lsdk-btn-sm" onclick="window._lsdkRefreshJoin()">&#x1f504; Refresh</button>'
        );
      } else {
        const items = rooms.map(r =>
          '<div class="lsdk-room">' +
            '<span class="lsdk-room-name">&#127918; ' + r.hostName + '\'s Room</span>' +
            '<button class="lsdk-join-btn" onclick="window._lsdkJoin(\'' + r.peerId + '\')">Join</button>' +
          '</div>'
        ).join('');
        setContent(
          '<div class="lsdk-room-list">' + items + '</div>' +
          '<button class="lsdk-btn-sm" style="margin-top:10px" onclick="window._lsdkRefreshJoin()">&#x1f504; Refresh</button>'
        );
      }
    } catch (e) {
      setContent('<div class="lsdk-error">Failed to load rooms: ' + e.message + '</div>');
    }
  }

  // ── UI injection ─────────────────────────────────────────────────────────────
  function injectUI() {
    const style = document.createElement('style');
    style.textContent = [
      '#lsdk-overlay{position:fixed;inset:0;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;z-index:999999;font-family:"Segoe UI",sans-serif}',
      '#lsdk-box{background:#0d1a26;border:1.5px solid #1e3d5e;border-radius:16px;padding:30px 34px 26px;width:420px;max-width:90vw;box-shadow:0 10px 50px rgba(0,0,0,.8);color:#d0e4f0}',
      '#lsdk-title{font-size:1.2rem;font-weight:700;color:#5ac8f5;text-align:center;margin-bottom:18px;letter-spacing:.04em}',
      '.lsdk-tabs{display:flex;gap:8px;margin-bottom:20px}',
      '.lsdk-tab{flex:1;padding:9px;border-radius:8px;border:1.5px solid #1e3d5e;background:#0a141e;color:#7aaccc;cursor:pointer;font-size:.92rem;text-align:center;transition:all .18s;user-select:none}',
      '.lsdk-tab.active{background:#163650;color:#5ac8f5;border-color:#2a6898}',
      '.lsdk-tab:hover:not(.active){background:#0f1f30;color:#a0c8e0}',
      '#lsdk-content{min-height:110px}',
      '.lsdk-status{text-align:center;color:#7aaccc;padding:12px 0 6px;font-size:.93rem}',
      '.lsdk-connecting{text-align:center;color:#5ac8f5;padding:28px 0;font-size:.95rem}',
      '.lsdk-dots-row{text-align:center;color:#5ac8f5;font-size:1.2rem;letter-spacing:8px;padding:4px 0 12px}',
      '.lsdk-dot{display:inline-block;animation:lsdk-blink 1.2s infinite}',
      '.lsdk-dot:nth-child(2){animation-delay:.3s}',
      '.lsdk-dot:nth-child(3){animation-delay:.6s}',
      '@keyframes lsdk-blink{0%,80%,100%{opacity:.15}40%{opacity:1}}',
      '.lsdk-error{color:#f87171;text-align:center;font-size:.9rem;padding:14px 0}',
      '.lsdk-empty{color:#5a8ab0;text-align:center;font-size:.9rem;padding:14px 0}',
      '.lsdk-room-list{display:flex;flex-direction:column;gap:7px}',
      '.lsdk-room{display:flex;align-items:center;justify-content:space-between;background:#0a141e;border:1px solid #1e3d5e;border-radius:8px;padding:9px 13px}',
      '.lsdk-room-name{color:#b0d0e8;font-size:.92rem}',
      '.lsdk-join-btn{background:#144a78;color:#8cd0f8;border:none;border-radius:6px;padding:5px 13px;cursor:pointer;font-size:.83rem;transition:background .15s}',
      '.lsdk-join-btn:hover{background:#1a6aaa}',
      '.lsdk-btn-sm{display:block;width:100%;margin-top:10px;padding:8px;border-radius:7px;background:#0a141e;border:1px solid #1e3d5e;color:#5a8ab0;cursor:pointer;font-size:.87rem;transition:all .15s}',
      '.lsdk-btn-sm:hover{background:#0f1f30;color:#90b8d0}',
      '#lsdk-cancel-btn{display:block;width:100%;margin-top:16px;padding:9px;border-radius:8px;background:transparent;border:1px solid #1e3d5e;color:#4a7a98;cursor:pointer;font-size:.88rem;transition:all .15s}',
      '#lsdk-cancel-btn:hover{background:#0a141e;color:#80b0c8}',
    ].join('');
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'lsdk-overlay';
    overlay.innerHTML =
      '<div id="lsdk-box">' +
        '<div id="lsdk-title">&#127760; Online Multiplayer</div>' +
        '<div class="lsdk-tabs">' +
          '<div class="lsdk-tab active" id="lsdk-tab-host" onclick="_lsdkSwitchTab(\'host\')">&#127968; Host a Room</div>' +
          '<div class="lsdk-tab" id="lsdk-tab-join" onclick="_lsdkSwitchTab(\'join\')">&#128269; Browse Rooms</div>' +
        '</div>' +
        '<div id="lsdk-content"></div>' +
        '<button id="lsdk-cancel-btn" onclick="_lsdkClose()">&#10005; Cancel</button>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  window.LobbySDK = {
    init(gameId, cbs, opts) {
      currentGameId = gameId;
      callbacks     = cbs || {};
      maxPeers      = Math.max(1, (opts && opts.maxPeers) ? (opts.maxPeers - 1) : 1);
      // NOTE: opts.maxPeers is TOTAL players incl. host; joiner seats = total-1.
      // When omitted → 1 joiner seat → legacy 1-1 behavior.
    },

    // HOST: same payload to every joiner.
    broadcast(data) {
      for (const r of conns) { if (r.conn && r.conn.open) { try { r.conn.send(data); } catch (e) {} } }
    },

    // HOST: payload to one specific joiner seat (1,2,3…).
    sendTo(index, data) {
      const r = conns.find(x => x.index === index);
      if (r && r.conn && r.conn.open) { try { r.conn.send(data); } catch (e) {} }
    },

    // JOINER: payload to the host.
    sendToHost(data) {
      if (hostConn && hostConn.open) { try { hostConn.send(data); } catch (e) {} }
    },

    // Compatibility shim used by the legacy 1-1 games and convenient elsewhere:
    //   host → broadcast, joiner → sendToHost.
    send(data) {
      if (isHost) this.broadcast(data);
      else this.sendToHost(data);
    },

    getPeers() {
      return conns.map(r => ({ index: r.index, name: r.name, emblem: r.emblem }));
    },

    myIndex() { return mySeat; },

    // HOST: lock the lobby and begin the match programmatically. Games that run
    // their own in-page lobby roster (e.g. Catan) call this from their own Start
    // button instead of the overlay's "Start match" button. Closes the overlay
    // and stops accepting new joiners. Safe to call once.
    startMatch() {
      if (!isHost || started) return;
      started = true;
      if (myLobbyDocId) { deleteLobby(myLobbyDocId); myLobbyDocId = null; }
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      const ov = document.getElementById('lsdk-overlay');
      if (ov) ov.style.display = 'none';
    },

    // openLobby('host'|'join'). Defaults to 'host' (legacy behavior). A game that
    // wants to join existing rooms (e.g. Catan's Join button) passes 'join' to
    // land directly on the Browse Rooms tab.
    openLobby(startTab) {
      if (!currentGameId) { console.warn('[LobbySDK] call init() first'); return; }
      peerName = 'Player'; peerEmblem = '';
      const existing = document.getElementById('lsdk-overlay');
      if (!existing) injectUI(); else existing.style.display = 'flex';
      if (startTab === 'join') { window._lsdkSwitchTab('join'); }
      else { window._lsdkSwitchTab('host'); }
    },

    closeLobby() {
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      if (myLobbyDocId) { deleteLobby(myLobbyDocId); myLobbyDocId = null; }
      if (peer) { try { peer.destroy(); } catch(e){} peer = null; }
      conns = []; hostConn = null; started = false; mySeat = -1; nextSeat = 1;
    },

    // ── DISCOVERY-ONLY API ───────────────────────────────────────────────────
    // For realtime games (e.g. Floe Fighters) that manage their OWN PeerJS
    // connection — typically an unordered/unreliable channel the SDK's reliable
    // transport would degrade. These methods use ONLY the Firebase room-listing
    // layer: the game still creates its own Peer and calls connect() itself.
    //
    //   const handle = await LobbySDK.advertiseRoom(gameId, myPeerId);
    //     → writes a discoverable lobby doc; returns { close() } to remove it.
    //   const rooms  = await LobbySDK.listRooms(gameId);
    //     → [{ hostName, peerId }] of open rooms to display in the game's own UI.
    // No overlay, no PeerJS, no callbacks — pure matchmaking data.
    async advertiseRoom(gameId, peerId) {
      const docId = await createLobby(gameId, peerId);
      return {
        docId,
        close() { deleteLobby(docId); },
      };
    },
    async listRooms(gameId) {
      const rooms = await listLobbies(gameId);
      return rooms.map(r => ({ hostName: r.hostName, peerId: r.peerId, docId: r.docId }));
    },
  };

  // Internal methods referenced by inline onclick handlers
  window._lsdkSwitchTab = async function(tab) {
    document.querySelectorAll('.lsdk-tab').forEach(t => t.classList.remove('active'));
    const tabEl = document.getElementById('lsdk-tab-' + tab);
    if (tabEl) tabEl.classList.add('active');
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (tab === 'host') await showHostPanel();
    else await showJoinPanel();
  };

  window._lsdkClose = function() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (myLobbyDocId) { deleteLobby(myLobbyDocId); myLobbyDocId = null; }
    if (peer && conns.length === 0 && !hostConn) { try { peer.destroy(); } catch(e){} peer = null; }
    const ov = document.getElementById('lsdk-overlay');
    if (ov) ov.style.display = 'none';
  };

  window._lsdkRefreshJoin = refreshJoinList;

  window._lsdkJoin = async function(peerId) {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    isHost = false;
    setContent('<div class="lsdk-connecting">Connecting<span class="lsdk-dot">.</span><span class="lsdk-dot">.</span><span class="lsdk-dot">.</span></div>');
    try {
      await loadPeerJS();
      if (!peer) await createPeer();
      const c = peer.connect(peerId, { reliable: true });
      joinerSetupConn(c);
      setTimeout(() => {
        if (!hostConn || !hostConn.open) {
          setContent(
            '<div class="lsdk-error">Could not connect. The room may be full or gone.</div>' +
            '<button class="lsdk-btn-sm" onclick="window._lsdkSwitchTab(\'join\')">&#8592; Back</button>'
          );
        }
      }, 9000);
    } catch (e) {
      setContent(
        '<div class="lsdk-error">Connection failed: ' + e.message + '</div>' +
        '<button class="lsdk-btn-sm" onclick="window._lsdkSwitchTab(\'join\')">&#8592; Back</button>'
      );
    }
  };

  // Pre-fetch auth token silently on load
  ensureAuth().catch(() => {});

  // Auto-cleanup when window closes
  window.addEventListener('beforeunload', () => {
    if (myLobbyDocId) deleteLobby(myLobbyDocId);
  });

})();
