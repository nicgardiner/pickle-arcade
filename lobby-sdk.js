/**
 * Pickle Arcade — Online Lobby SDK  v2.2
 *
 * v2.2 — lobby lifecycle hardening:
 *   • Tab flips / Cancel / Join now fully tear down any room you were hosting
 *     (doc + heartbeat + peer), so browsers never list you as a ghost host.
 *   • Async host setup is generation-guarded: navigating away mid-setup un-makes
 *     the half-built room instead of orphaning it (the "duplicate rooms" bug).
 *   • All Firestore calls carry timeouts (filtering proxies black-hole requests),
 *     deletes use keepalive so closing the window still removes your room, and
 *     the room browser sweeps this window's strays plus any room whose peer is
 *     confirmed dead on join. Blocked-network failures now say so in the UI.
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
 *   • onConnected(isHost, myIndex, oppName, oppEmblem) → fired once. The last two
 *                                   give the opponent's real account name/emblem
 *                                   (1-1 games). Older games using onConnected(isHost)
 *                                   keep working — the extra args are just ignored.
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
 *
 * ── Programmatic room API (v2.1, opt-in — no overlay) ───────────────────────
 * For games that draw their OWN lobby UI but still want the seat-based
 * transport above (Windward Isles). Requires init() first.
 *   await createRoom({ peerId, private, label }) → { peerId }
 *     Become the host (seat 0) and start accepting joiners. Unless `private`,
 *     the room is advertised in the public listing with an optional `label`
 *     (e.g. the world name). Pass a custom `peerId` (e.g. derived from a short
 *     lobby code) so friends can connect by code; omit for a random id.
 *     The room stays open/listed until closeLobby() — drop-in/drop-out.
 *   await joinRoom(peerId)   connect to a host; onConnected fires when seated,
 *                            onJoinFailed('full'|'unavailable') on failure.
 *   kick(index)              HOST: force-close one joiner seat.
 *   listRooms(gameId)        now also returns each room's `label`.
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
  let heartbeatTimer = null;     // keeps my open room "fresh" so joiners can tell it's still alive
  let callbacks     = {};
  let currentGameId = null;
  let maxPeers      = 1;          // how many JOINERS the host accepts (1 = legacy 1-1)
  let isHost        = false;
  let mySeat        = -1;         // 0 = host; joiners get 1,2,3… ; -1 = not in a match
  let started       = false;     // host has launched the match (lobby closed to new seats)

  // Generation counter for async lobby flows. Host setup awaits several network
  // steps (delete old doc → PeerJS open → create new doc); if the user switches
  // tabs mid-flight, the stale continuation used to finish anyway and register a
  // lobby doc nobody tracked — every Host↔Browse flip could mint another ghost
  // "Player's Room" that no refresh removed (readers only hide rooms once their
  // heartbeat is 2 min stale). Every navigation bumps the seq; an async flow
  // that wakes up to a stale seq must clean up whatever it created and stop.
  let setupSeq      = 0;

  // Every lobby doc this window has ever created. If a delete was missed
  // (network hiccup, interleaved setup), the room browser uses this to
  // recognize our own strays, hide them, and delete them on sight.
  const myDocIds    = new Set();

  // HOST side: connected joiners.  conns[i] = { conn, index, name, emblem }
  let conns         = [];
  let nextSeat      = 1;          // next seat number to hand out

  // JOINER side: the single connection back to the host
  let hostConn      = null;
  let peerName      = 'Player';   // (legacy) name of connected opponent in 1-1 UI
  let peerEmblem    = '';

  // ── Helpers ─────────────────────────────────────────────────────────────────
  // The launcher account name/emblem arrive two ways: preload exposes
  // __picklePlayerName/__picklePlayerEmblem into the page (contextBridge), and
  // the game window's URL carries ?playerName=&playerEmblem= (both app and
  // website). Prefer the window vars, fall back to the URL — so names survive
  // even if one bridge is unavailable.
  function getPlayerName() {
    let n = (window.__picklePlayerName || '').trim();
    if (!n) { try { n = (new URLSearchParams(window.location.search).get('playerName') || '').trim(); } catch (e) {} }
    return n || 'Player';
  }
  function getPlayerEmblem() {
    let em = (window.__picklePlayerEmblem || '').trim();
    if (!em) { try { em = (new URLSearchParams(window.location.search).get('playerEmblem') || '').trim(); } catch (e) {} }
    return em || '🎮';
  }
  function getPlayerDisplay() {
    return getPlayerEmblem() + ' ' + getPlayerName();
  }

  // HTML-escape anything from ANOTHER user before it touches innerHTML. Host
  // names, emblems and peer ids come off the Firestore room list or the P2P
  // handshake, so an unescaped display name like "<img src=x onerror=…>" would
  // run as script in every viewer's window (stored XSS in the room browser).
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Strict/office networks can black-hole HTTPS requests (a filtering proxy
  // accepts the connection, then never answers). A plain fetch then pends for
  // minutes, and everything awaiting it — tab switches, room teardown, host
  // setup — hangs with it, which is how half-made rooms pile up. Every lobby
  // request goes through this wrapper so it fails fast instead.
  function fsFetch(url, opts, timeoutMs) {
    const o = Object.assign({}, opts);
    try { o.signal = AbortSignal.timeout(timeoutMs || 8000); } catch (e) { /* very old runtime: no timeout */ }
    return fetch(url, o);
  }

  // Does this failure smell like a blocked/filtered network rather than a
  // normal "room is gone"? Used to add an honest hint to error messages.
  function looksBlocked(err) {
    const s = ((err && err.type) || '') + ' ' + ((err && err.message) || '');
    return /network|socket|server|timed? ?out|failed to fetch|abort|load PeerJS/i.test(s);
  }
  const BLOCKED_HINT =
    '<div class="lsdk-empty" style="margin-top:6px">A firewall or strict network (office/school Wi-Fi) may be blocking the multiplayer service.</div>';

  // The overlay UI appends BLOCKED_HINT via looksBlocked(). The PROGRAMMATIC API
  // (createRoom/joinRoom — used by games that draw their OWN lobby UI, like
  // Windward Isles) has no overlay to write to, so it carries the same signal to
  // the caller as a thrown error tagged { kind: 'net' }.
  function netError(e) {
    const err = new Error((e && e.message) || 'network unreachable');
    err.kind = 'net';
    return err;
  }

  // ── Firebase Anonymous Auth ─────────────────────────────────────────────────
  async function ensureAuth() {
    if (idToken) return;
    const res  = await fsFetch(AUTH_URL, {
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
    // NOTE: no server-side orderBy here. Filtering on gameId while ordering by a
    // *different* field (createdAt) requires a Firestore composite index; without
    // it, :runQuery returns a 400 {error} object, which silently became [] and
    // made every room browser show "no rooms". A single-field equality filter
    // needs no composite index, so we filter on the server and sort in JS.
    const res  = await fsFetch(FS_BASE + ':runQuery', {
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
          limit: 25,
        },
      }),
    });
    const rows = await res.json();
    // Firestore returns an array of {document} rows on success, or a single
    // {error} object on failure. Surface failures instead of swallowing them.
    if (!Array.isArray(rows)) {
      const msg = rows && rows.error && rows.error.message;
      throw new Error(msg || 'Firestore query failed');
    }
    // Hosts that crashed / alt-F4'd leave their lobby doc behind forever (no server TTL),
    // so a browser would pile up "Player's Room" ghosts where only the newest one connects.
    // A live host heartbeats its doc every ~15s; we HIDE anything not beaten recently so the
    // list only shows rooms you can actually join. TWO thresholds, and neither can ever nuke
    // a live room:
    //   • FRESH_MS — how recent a beat must be to SHOW a room. Deliberately generous: a host
    //     whose window is in the BACKGROUND has its setInterval heartbeat throttled by the
    //     browser/Electron (often to ~once a minute), and two players' clocks can differ by a
    //     few seconds. A tight 45s window hid these *live* rooms — the friend is hosting, yet
    //     "no open towns" shows. 2 minutes tolerates throttling + skew; a truly dead host
    //     still drops off within ~2 min.
    //   • PRUNE_MS — a doc is only DELETED once it's this stale, far past any live host or
    //     believable clock skew. A reader must never delete a room that's actually open:
    //     because the host's heartbeat PATCH would then re-create the doc WITHOUT its gameId
    //     (see touchLobby), it would never match a room query again — an invisible zombie that
    //     no refresh brings back. Beyond PRUNE_MS the host is unquestionably gone.
    const now = Date.now();
    const FRESH_MS = 120000;   // show a room beaten within the last 2 minutes
    const PRUNE_MS = 600000;   // only delete a doc untouched for 10 minutes
    return rows
      .filter(r => r.document)
      .map(r => {
        const f = r.document.fields || {};
        return {
          docId:    r.document.name.split('/').pop(),
          hostName: f.hostName?.stringValue || 'Player',
          peerId:   f.peerId?.stringValue   || '',
          label:    f.label?.stringValue    || '',
          createdAt: Number(f.createdAt?.integerValue || 0),
          heartbeat: Number(f.heartbeat?.integerValue || 0),
        };
      })
      .filter(room => {
        const beat = room.heartbeat || room.createdAt;     // pre-heartbeat docs fall back to createdAt
        const age  = beat ? (now - beat) : Infinity;       // age < 0 ⇒ host's clock runs ahead of ours: still alive
        if (age > PRUNE_MS) deleteLobby(room.docId);        // prune ONLY genuinely dead rooms (best-effort)
        return age < FRESH_MS;                              // ...but merely hide anything not beaten lately
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async function createLobby(gameId, peerId, label) {
    await ensureAuth();
    const fields = {
      gameId:    { stringValue: gameId },
      peerId:    { stringValue: peerId },
      hostName:  { stringValue: getPlayerDisplay() },
      createdAt: { integerValue: String(Date.now()) },
      heartbeat: { integerValue: String(Date.now()) },
    };
    // Optional room label (v2.1): e.g. the host's world/town name, shown in
    // room browsers. Old clients simply ignore the extra field.
    if (label) fields.label = { stringValue: String(label).slice(0, 64) };
    const res = await fsFetch(FS_BASE + '/lobbies', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fields }),
    });
    const doc = await res.json();
    if (doc.error) throw new Error(doc.error.message);
    const docId = doc.name.split('/').pop();
    myDocIds.add(docId);           // remember it so strays can be swept later
    return docId;
  }

  async function deleteLobby(docId) {
    if (!docId) return;
    try {
      await ensureAuth();
      // keepalive lets this delete finish even when fired from beforeunload —
      // without it the browser cancels the request as the window closes and
      // the room outlives the host as a ghost.
      await fsFetch(FS_BASE + '/lobbies/' + docId, {
        method: 'DELETE',
        headers: authHeaders(),
        keepalive: true,
      }, 5000);
    } catch (e) { /* best-effort */ }
  }

  // Stamp my open room as still-alive. PATCH with an updateMask touches only `heartbeat`.
  // currentDocument.exists=true makes this a pure UPDATE: if the doc was pruned, the PATCH
  // fails instead of RE-CREATING it holding only `heartbeat` (no gameId) — which would leave
  // an invisible zombie that never matches a room query again.
  async function touchLobby(docId) {
    if (!docId) return;
    try {
      await ensureAuth();
      await fsFetch(FS_BASE + '/lobbies/' + docId + '?updateMask.fieldPaths=heartbeat&currentDocument.exists=true', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ fields: { heartbeat: { integerValue: String(Date.now()) } } }),
      }, 5000);
    } catch (e) { /* best-effort */ }
  }
  function startHeartbeat(docId) {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => touchLobby(docId), 15000);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
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

  // Resolves { p, id }. Deliberately does NOT assign the global `peer`: two
  // interleaved setups would otherwise clobber each other's instance and the
  // loser could never be destroyed. The caller assigns `peer = p` only after
  // confirming its setupSeq is still current (destroying p otherwise).
  function createPeer(desiredId) {
    return new Promise((resolve, reject) => {
      // v2.1: an explicit id (e.g. built from a short lobby code) lets joiners
      // connect by code; PeerJS rejects with 'unavailable-id' if it's taken.
      const p = desiredId ? new window.Peer(desiredId) : new window.Peer();
      const t = setTimeout(() => { try { p.destroy(); } catch (e) {} reject(new Error('PeerJS timed out')); }, 12000);
      p.on('open', id => { clearTimeout(t); resolve({ p, id }); });
      p.on('error', err => { clearTimeout(t); reject(err); });
    });
  }

  // Fully stop being a host / advertised room: kill the heartbeat, delete the
  // lobby doc, destroy the peer, and reset seat bookkeeping. Called whenever
  // the user navigates away from hosting (Browse tab, Join click, Cancel) so a
  // room can never linger in the listing "as if you're still hosting".
  async function teardownHosting() {
    stopHeartbeat();
    const doc = myLobbyDocId; myLobbyDocId = null;
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
    conns = []; hostConn = null; nextSeat = 1; started = false;
    if (doc) await deleteLobby(doc);
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
          stopHeartbeat();
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
        // v2.1: programmatic joiners (no overlay) learn about the rejection too.
        if (callbacks.onJoinFailed) callbacks.onJoinFailed('full');
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
    const nameStr = peerName !== 'Player' ? ' — <strong>' + esc(displayPeer) + '</strong>' : '';
    setContent('<div class="lsdk-connecting" style="color:#4ade80">&#10003; Connected' + nameStr + '</div>');
    setTimeout(() => {
      const ov = document.getElementById('lsdk-overlay');
      if (ov) ov.style.display = 'none';
      // Pass the opponent's real account name/emblem so 1-1 games can label them
      // without each implementing their own name handshake.
      if (callbacks.onConnected) callbacks.onConnected(asHost, mySeat, peerName, peerEmblem);
    }, 900);
  }

  // ── Host panel ──────────────────────────────────────────────────────────────
  async function showHostPanel() {
    const seq = ++setupSeq;                  // this run owns lobby setup until the user navigates again
    setContent('<div class="lsdk-connecting">Setting up<span class="lsdk-dot">.</span><span class="lsdk-dot">.</span><span class="lsdk-dot">.</span></div>');
    try {
      await teardownHosting();
      if (seq !== setupSeq) return;          // user navigated away mid-teardown
      isHost = true; mySeat = 0;

      await loadPeerJS();
      if (seq !== setupSeq) return;
      const { p, id: myId } = await createPeer();
      if (seq !== setupSeq) { try { p.destroy(); } catch (e) {} return; }
      peer = p;
      const docId = await createLobby(currentGameId, myId);
      if (seq !== setupSeq) {
        // Stale continuation: the user already left the Host tab. Un-make the
        // room instead of registering it — this was the ghost-room factory.
        deleteLobby(docId);
        try { p.destroy(); } catch (e) {}
        if (peer === p) peer = null;
        return;
      }
      myLobbyDocId = docId;
      startHeartbeat(myLobbyDocId);          // keep the room listed as alive while we wait

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
      if (seq !== setupSeq) return;          // failure from a superseded run: stay quiet
      setContent('<div class="lsdk-error">Setup failed: ' + e.message + '</div>' +
        (looksBlocked(e) ? BLOCKED_HINT : '') +
        '<button class="lsdk-btn-sm" onclick="window._lsdkRetryHost()">Retry</button>');
      window._lsdkRetryHost = showHostPanel;
    }
  }

  // HOST (multi): operator pressed "Start match" in the overlay.
  window._lsdkHostStart = function () {
    if (started) return;
    started = true;
    stopHeartbeat();
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
      const rooms = (await listLobbies(currentGameId)).filter(r => {
        // Never show this window its own rooms. Anything we created that is no
        // longer the active lobby is a stray from a missed delete — sweep it.
        if (r.docId === myLobbyDocId) return false;
        if (myDocIds.has(r.docId)) { deleteLobby(r.docId); return false; }
        return true;
      });
      if (rooms.length === 0) {
        setContent(
          '<div class="lsdk-empty">No open rooms found. Host one!</div>' +
          '<button class="lsdk-btn-sm" onclick="window._lsdkRefreshJoin()">&#x1f504; Refresh</button>'
        );
      } else {
        // esc() every value from the room doc; the peerId rides in a data-
        // attribute (read back by the click handler) instead of being spliced
        // into an inline onclick string, so a crafted id can't break out.
        const items = rooms.map(r =>
          '<div class="lsdk-room">' +
            '<span class="lsdk-room-name">&#127918; ' + esc(r.hostName) + '\'s Room</span>' +
            '<button class="lsdk-join-btn" data-peer="' + esc(r.peerId) + '" data-doc="' + esc(r.docId) + '">Join</button>' +
          '</div>'
        ).join('');
        setContent(
          '<div class="lsdk-room-list">' + items + '</div>' +
          '<button class="lsdk-btn-sm" style="margin-top:10px" onclick="window._lsdkRefreshJoin()">&#x1f504; Refresh</button>'
        );
        const contentEl = document.getElementById('lsdk-content');
        if (contentEl) contentEl.querySelectorAll('.lsdk-join-btn').forEach(btn => {
          btn.addEventListener('click', () => window._lsdkJoin(btn.getAttribute('data-peer'), btn.getAttribute('data-doc')));
        });
      }
    } catch (e) {
      setContent('<div class="lsdk-error">Failed to load rooms: ' + e.message + '</div>' +
        (looksBlocked(e) ? BLOCKED_HINT : ''));
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

    // Account-name helpers so games can label both players with real names.
    //   myName()         → this player's launcher account name
    //   myEmblem()       → this player's emblem
    //   opponentName()   → the connected opponent's name (1-1 games); '' until known
    //   opponentEmblem() → the connected opponent's emblem
    myName()        { return getPlayerName(); },
    myEmblem()      { return getPlayerEmblem(); },
    opponentName()  { return (peerName && peerName !== 'Player') ? peerName : ''; },
    opponentEmblem(){ return peerEmblem || ''; },

    // HOST: lock the lobby and begin the match programmatically. Games that run
    // their own in-page lobby roster (e.g. Catan) call this from their own Start
    // button instead of the overlay's "Start match" button. Closes the overlay
    // and stops accepting new joiners. Safe to call once.
    startMatch() {
      if (!isHost || started) return;
      started = true;
      stopHeartbeat();
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
      setupSeq++;                            // abort any in-flight setup
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      stopHeartbeat();
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
      startHeartbeat(docId);                 // keep this discoverable room marked alive
      return {
        docId,
        close() { stopHeartbeat(); deleteLobby(docId); },
      };
    },
    async listRooms(gameId) {
      const rooms = await listLobbies(gameId);
      return rooms.map(r => ({ hostName: r.hostName, peerId: r.peerId, docId: r.docId, label: r.label }));
    },

    // ── PROGRAMMATIC ROOM API (v2.1) ─────────────────────────────────────────
    // The seat-based transport (welcome/handshake/seats/onPeerJoined/onData)
    // without the overlay UI — for games that draw their own lobby screens.
    // Requires init() first. The room stays open (and, if public, listed +
    // heartbeaten) until closeLobby(), so players can drop in and out.
    async createRoom(opts) {
      if (!currentGameId) throw new Error('LobbySDK: call init() first');
      const o = opts || {};
      setupSeq++;                            // supersede any pending overlay/join setup
      await teardownHosting();
      isHost = true; mySeat = 0;
      let myId;
      try {
        await loadPeerJS();
        const r = await createPeer(o.peerId);
        peer = r.p; myId = r.id;
      } catch (e) {
        // Broker/CDN unreachable → network block. A taken id ('unavailable-id')
        // is NOT network — rethrow raw so the caller can reroll the code.
        throw looksBlocked(e) ? netError(e) : e;
      }
      if (!o.private) {
        myLobbyDocId = await createLobby(currentGameId, myId, o.label || '');
        startHeartbeat(myLobbyDocId);
      }
      peer.on('connection', c => hostHandleConnection(c));
      return { peerId: myId };
    },

    // JOINER: connect to a host programmatically. Seating is confirmed via the
    // normal welcome flow (onConnected fires); a full/started room fires
    // onJoinFailed('full'), an unknown/expired id fires onJoinFailed('unavailable').
    async joinRoom(peerId) {
      isHost = false; mySeat = -1;
      try {
        await loadPeerJS();
        // A destroyed or broker-disconnected peer can't open new connections;
        // joining through one hangs forever. Make sure we hold a live one.
        if (peer && (peer.destroyed || peer.disconnected)) {
          try { peer.destroy(); } catch (e) {}
          peer = null;
        }
        if (!peer) { const { p } = await createPeer(); peer = p; }
      } catch (e) {
        // Couldn't even reach the broker/CDN → network block. Surface as a tagged
        // error so the game (which draws its own lobby UI) can say so.
        throw looksBlocked(e) ? netError(e) : e;
      }
      if (!peer._lsdkErrHooked) {
        peer._lsdkErrHooked = true;
        peer.on('error', (err) => {
          if (!callbacks.onJoinFailed) return;
          if (err && err.type === 'peer-unavailable') callbacks.onJoinFailed('unavailable');
          else if (looksBlocked(err)) callbacks.onJoinFailed('network');
        });
      }
      const c = peer.connect(peerId, { reliable: true });
      joinerSetupConn(c);
    },

    // HOST: force-close one joiner seat. Their side sees onDisconnected; the
    // host side sees onPeerLeft via the connection's normal drop handler.
    kick(index) {
      const r = conns.find(x => x.index === index);
      if (r) { try { r.conn.close(); } catch (e) {} }
    },
  };

  // Internal methods referenced by inline onclick handlers
  window._lsdkSwitchTab = async function(tab) {
    setupSeq++;                              // cancel any in-flight host/join setup
    document.querySelectorAll('.lsdk-tab').forEach(t => t.classList.remove('active'));
    const tabEl = document.getElementById('lsdk-tab-' + tab);
    if (tabEl) tabEl.classList.add('active');
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (tab === 'host') await showHostPanel();
    else {
      // Leaving the Host tab means you're no longer offering a room: close it.
      // Before this, the room (doc + heartbeat + peer) survived the switch, so
      // browsers kept listing you as a host while you were trying to join.
      await teardownHosting();
      await showJoinPanel();
    }
  };

  window._lsdkClose = function() {
    setupSeq++;                              // abort any in-flight setup
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    stopHeartbeat();
    if (myLobbyDocId) { deleteLobby(myLobbyDocId); myLobbyDocId = null; }
    if (peer && conns.length === 0 && !hostConn) { try { peer.destroy(); } catch(e){} peer = null; }
    const ov = document.getElementById('lsdk-overlay');
    if (ov) ov.style.display = 'none';
  };

  window._lsdkRefreshJoin = refreshJoinList;

  window._lsdkJoin = async function(peerId, docId) {
    const seq = ++setupSeq;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    isHost = false;
    setContent('<div class="lsdk-connecting">Connecting<span class="lsdk-dot">.</span><span class="lsdk-dot">.</span><span class="lsdk-dot">.</span></div>');
    try {
      // Joining means we're definitely not hosting: close any room we still
      // advertise, and drop the old host peer — reusing it left a stale
      // 'connection' listener attached, so someone joining OUR ghost room
      // mid-join scrambled both sides' state.
      await teardownHosting();
      if (seq !== setupSeq) return;
      await loadPeerJS();
      if (seq !== setupSeq) return;
      const { p } = await createPeer();
      if (seq !== setupSeq) { try { p.destroy(); } catch (e) {} return; }
      peer = p;
      peer.on('error', err => {
        // Dead room (host gone / doc was stale): say so right away instead of
        // spinning out the full 9s timeout — and sweep the ghost doc so the
        // room stops being advertised to everyone else too.
        if (err && err.type === 'peer-unavailable') {
          if (docId) deleteLobby(docId);
          if (seq === setupSeq) setContent(
            '<div class="lsdk-error">That room is gone — the host closed it.</div>' +
            '<button class="lsdk-btn-sm" onclick="window._lsdkSwitchTab(\'join\')">&#8592; Back</button>'
          );
          if (callbacks.onJoinFailed) callbacks.onJoinFailed('unavailable');
        }
      });
      const c = peer.connect(peerId, { reliable: true });
      joinerSetupConn(c);
      setTimeout(() => {
        if (seq !== setupSeq) return;        // user navigated away meanwhile
        if (!hostConn || !hostConn.open) {
          // The peer id existed but no data channel formed — the classic
          // signature of WebRTC being blocked (strict office/school networks).
          setContent(
            '<div class="lsdk-error">Could not connect. The room may be full or gone.</div>' +
            BLOCKED_HINT +
            '<button class="lsdk-btn-sm" onclick="window._lsdkSwitchTab(\'join\')">&#8592; Back</button>'
          );
        }
      }, 9000);
    } catch (e) {
      if (seq !== setupSeq) return;
      setContent(
        '<div class="lsdk-error">Connection failed: ' + e.message + '</div>' +
        (looksBlocked(e) ? BLOCKED_HINT : '') +
        '<button class="lsdk-btn-sm" onclick="window._lsdkSwitchTab(\'join\')">&#8592; Back</button>'
      );
    }
  };

  // Pre-fetch auth token silently on load
  ensureAuth().catch(() => {});

  // Auto-cleanup when window closes
  window.addEventListener('beforeunload', () => {
    stopHeartbeat();
    if (myLobbyDocId) deleteLobby(myLobbyDocId);
  });

})();
