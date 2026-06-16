/**
 * Pickle Arcade — Online Lobby SDK  v1.1
 *
 * Injected by preload.js into every multiplayer game window.
 * Provides:
 *   • Firebase Anonymous Auth + Firestore lobby listing (via REST, no bundler needed)
 *   • PeerJS P2P connection management (loaded from CDN)
 *   • Lobby overlay UI (host / join)
 *   • Player name display in lobby listings
 *
 * Games call:
 *   window.LobbySDK.init(gameId, { onConnected, onData, onDisconnected })
 *   window.LobbySDK.send(data)
 *   window.LobbySDK.openLobby()
 *   window.LobbySDK.closeLobby()
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
  let conn          = null;
  let myLobbyDocId  = null;
  let refreshTimer  = null;
  let callbacks     = {};
  let currentGameId = null;
  let peerName      = 'Player'; // name of the connected opponent
  let peerEmblem    = '';       // emblem of the connected opponent

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

  function setupConn(c) {
    conn = c;
    c.on('open', () => {
      // Exchange names + emblems immediately on connection
      c.send({ type: '__handshake', playerName: getPlayerName(), playerEmblem: getPlayerEmblem() });
    });
    c.on('data', data => {
      if (data && data.type === '__handshake') {
        peerName   = data.playerName   || 'Player';
        peerEmblem = data.playerEmblem || '';
        // Update host panel if still visible
        const status = document.querySelector('#lsdk-content .lsdk-status');
        if (status) status.textContent = peerName + ' joined!';
        return;
      }
      if (callbacks.onData) callbacks.onData(data);
    });
    c.on('close', () => {
      conn = null;
      if (callbacks.onDisconnected) callbacks.onDisconnected();
    });
    c.on('error', () => {
      conn = null;
      if (callbacks.onDisconnected) callbacks.onDisconnected();
    });
  }

  // ── Overlay UI helpers ──────────────────────────────────────────────────────
  function setContent(html) {
    const c = document.getElementById('lsdk-content');
    if (c) c.innerHTML = html;
  }

  function closeOverlayAndStart(isHost) {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    const displayPeer = (peerEmblem ? peerEmblem + ' ' : '') + peerName;
    const nameStr = peerName !== 'Player' ? ' — <strong>' + displayPeer + '</strong>' : '';
    setContent('<div class="lsdk-connecting" style="color:#4ade80">&#10003; Connected' + nameStr + '</div>');
    setTimeout(() => {
      const ov = document.getElementById('lsdk-overlay');
      if (ov) ov.style.display = 'none';
      if (callbacks.onConnected) callbacks.onConnected(isHost);
    }, 900);
  }

  // ── Host panel ──────────────────────────────────────────────────────────────
  async function showHostPanel() {
    setContent('<div class="lsdk-connecting">Setting up<span class="lsdk-dot">.</span><span class="lsdk-dot">.</span><span class="lsdk-dot">.</span></div>');
    try {
      if (myLobbyDocId) { await deleteLobby(myLobbyDocId); myLobbyDocId = null; }
      if (peer) { try { peer.destroy(); } catch(e){} peer = null; conn = null; }

      await loadPeerJS();
      const myId = await createPeer();
      myLobbyDocId = await createLobby(currentGameId, myId);

      setContent(
        '<div class="lsdk-status">Your room is open — waiting for opponent</div>' +
        '<div class="lsdk-dots-row"><span class="lsdk-dot">●</span><span class="lsdk-dot">●</span><span class="lsdk-dot">●</span></div>'
      );

      peer.on('connection', c => {
        if (myLobbyDocId) { deleteLobby(myLobbyDocId); myLobbyDocId = null; }
        setupConn(c);
        c.on('open', () => {
          // Small delay so handshake arrives before we display the name
          setTimeout(() => closeOverlayAndStart(true), 400);
        });
      });
    } catch (e) {
      setContent('<div class="lsdk-error">Setup failed: ' + e.message + '</div><button class="lsdk-btn-sm" onclick="window._lsdkRetryHost()">Retry</button>');
      window._lsdkRetryHost = showHostPanel;
    }
  }

  // ── Join panel ──────────────────────────────────────────────────────────────
  async function showJoinPanel() {
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

  // ── Public API ──────────────────────────────────────────────────────────────
  window.LobbySDK = {
    init(gameId, cbs) {
      currentGameId = gameId;
      callbacks     = cbs;
    },

    send(data) {
      if (conn && conn.open) conn.send(data);
    },

    openLobby() {
      if (!currentGameId) { console.warn('[LobbySDK] call init() first'); return; }
      peerName   = 'Player'; // reset peer info for new session
      peerEmblem = '';
      const existing = document.getElementById('lsdk-overlay');
      if (existing) { existing.style.display = 'flex'; showHostPanel(); return; }
      injectUI();
      showHostPanel();
    },

    closeLobby() {
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      if (myLobbyDocId) { deleteLobby(myLobbyDocId); myLobbyDocId = null; }
      if (peer) { try { peer.destroy(); } catch(e){} peer = null; }
      conn = null;
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
    if (peer && !conn) { try { peer.destroy(); } catch(e){} peer = null; }
    const ov = document.getElementById('lsdk-overlay');
    if (ov) ov.style.display = 'none';
  };

  window._lsdkRefreshJoin = refreshJoinList;

  window._lsdkJoin = async function(peerId) {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    setContent('<div class="lsdk-connecting">Connecting<span class="lsdk-dot">.</span><span class="lsdk-dot">.</span><span class="lsdk-dot">.</span></div>');
    try {
      await loadPeerJS();
      if (!peer) await createPeer();
      const c = peer.connect(peerId, { reliable: true });
      setupConn(c);
      c.on('open', () => closeOverlayAndStart(false));
      setTimeout(() => {
        if (!conn || !conn.open) {
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

  // ── Inject UI ────────────────────────────────────────────────────────────────
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

  // Pre-fetch auth token silently on load
  ensureAuth().catch(() => {});

  // Auto-cleanup when window closes
  window.addEventListener('beforeunload', () => {
    if (myLobbyDocId) deleteLobby(myLobbyDocId);
  });

})();
