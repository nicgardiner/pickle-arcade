/* ──────────────────────────────────────────────────────────────────────────
 * leaderboard-sdk.js — Global leaderboards for Pickle Arcade
 *
 * ONE file, three homes:
 *   • the launcher (index.html loads it; renderer.js draws the Leaderboard tab)
 *   • game windows in the app (preload.js injects it for games in its
 *     LEADERBOARD_GAMES allowlist, exactly like lobby-sdk.js)
 *   • the website (web/build-site.mjs injects it into the same games and
 *     copies it next to index.html)
 *
 * Backend: the same Firebase project feedback.js / lobby-sdk.js already use,
 * via the Firestore REST API — no bundler, no SDK download.
 *
 * DATA MODEL — one score per player per game:
 *   leaderboards/{gameId}/scores/{firebaseUid}
 *     score        number   the player's best (higher is better)
 *     meta         map      optional game-specific extras (Vectordrome: zone)
 *     playerName   string   launcher profile name at the time of the score
 *     playerEmblem string   launcher profile emblem
 *     playerId     string   gl_player_id (stable per install / profile)
 *     client       'app' | 'web'
 *     updatedAt    ms timestamp
 *
 *   The doc id IS the Firebase UID, so the security rules can pin every write
 *   to its owner (uid == request.auth.uid) and refuse a lower score on update.
 *   The per-game sub-collection keeps the top-N query on a single-field index
 *   (orderBy score desc) — no composite index to create in the console.
 *
 * IDENTITY — the same anonymous Firebase user everywhere:
 *   feedback.js mints a persistent anonymous account for the launcher and keeps
 *   its refresh token under gl_fb_refresh (mirrored to playerdata.json). This
 *   module reuses those keys, so launcher and game agree on "you". In the app,
 *   game windows have their own localStorage origin, so preload.js copies the
 *   identity keys in before the game's scripts run. On the website everything
 *   shares one origin and nothing needs copying.
 *
 * PUBLIC API (all async, all safe offline — they resolve with what they have
 * and set `ok:false` / throw a tagged error rather than hanging):
 *   LeaderboardSDK.submit(gameId, score, meta?)       → { ok, submitted, score, rank }
 *   LeaderboardSDK.top(gameId, limit=10)              → [entry]
 *   LeaderboardSDK.mine(gameId)                       → entry | null
 *   LeaderboardSDK.rankOf(gameId, score)              → number (1-based) | null
 *   LeaderboardSDK.count(gameId)                      → number | null
 *   LeaderboardSDK.board(gameId, { limit })           → { top, me, rank, total }
 *   LeaderboardSDK.all(gameId)                        → [entry]   (every doc — dev use)
 *   LeaderboardSDK.remove(gameId, uid)                → deletes a doc (rules: owner/self only)
 *   LeaderboardSDK.myUid()                            → uid string | null (no network)
 *   LeaderboardSDK.bestRank(gameId)                   → best rank seen | null (no network)
 *   LeaderboardSDK.identity()                         → { name, emblem, playerId }
 *
 * Every entry: { uid, playerId, name, emblem, score, meta, client, updatedAt, isMe }
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.LeaderboardSDK) return; // idempotent (launcher + injected copies)

  // ── Firebase config (same backend as feedback.js / lobby-sdk.js) ──────────
  const API_KEY    = 'AIzaSyDu8OygdH9Fft-3XcHD5Vzp8SnXgKt6mXk';
  const PROJECT_ID = 'pickle-arcade-lobbies';
  const FS_BASE    = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';
  const AUTH_URL   = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + API_KEY;
  const TOKEN_URL  = 'https://securetoken.googleapis.com/v1/token?key=' + API_KEY;
  const ROOT       = 'leaderboards';
  const SUB        = 'scores';

  // Shared identity keys (owned by feedback.js in the launcher).
  const FB_REFRESH_KEY = 'gl_fb_refresh';
  const FB_UID_KEY     = 'gl_fb_uid';

  const TIMEOUT_MS = 9000;
  const NAME_MAX   = 24;
  const ALL_PAGE   = 1000;

  let idToken   = null;
  let tokenExp  = 0;      // ms; Firebase id tokens live 1h
  let myUid     = null;
  let authInFlight = null;

  // ── Small helpers ──────────────────────────────────────────────────────────
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function persist(k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
    // Mirror into playerdata.json when we can (launcher AND app game windows both
    // have electronAPI). On the web localStorage already IS the store.
    try {
      if (window.electronAPI && window.electronAPI.syncLauncherStorage) {
        window.electronAPI.syncLauncherStorage(k, v);
      }
    } catch (e) {}
  }
  function isWeb() { return !!window.__pickleWeb || !window.electronAPI; }

  function netError(msg) {
    const e = new Error(msg || 'network unreachable');
    e.kind = 'net';
    return e;
  }
  async function fetchT(url, opts) {
    const ctl = ('AbortController' in window) ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    try {
      return await fetch(url, Object.assign({}, opts || {}, ctl ? { signal: ctl.signal } : {}));
    } catch (e) {
      throw netError();
    } finally {
      if (t) clearTimeout(t);
    }
  }
  async function readJson(res) {
    try { return await res.json(); } catch (e) { throw netError(); }
  }

  function identity() {
    const q = new URLSearchParams(window.location.search);
    let name = window.__picklePlayerName || lsGet('gl_player_name') || q.get('playerName') || 'Player';
    let emblem = window.__picklePlayerEmblem || lsGet('gl_player_emblem') || q.get('playerEmblem') || '🎮';
    name = String(name).trim().slice(0, NAME_MAX) || 'Player';
    emblem = String(emblem).trim().slice(0, 8) || '🎮';
    const playerId = lsGet('gl_player_id') || '';
    return { name, emblem, playerId };
  }

  // ── Auth: reuse the launcher's persistent anonymous user ───────────────────
  async function ensureAuth() {
    if (idToken && Date.now() < tokenExp - 60000) return;
    if (authInFlight) return authInFlight;
    authInFlight = (async () => {
      const refresh = lsGet(FB_REFRESH_KEY);
      if (refresh) {
        try {
          const res = await fetchT(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refresh),
          });
          const data = await readJson(res);
          if (!data.error && data.id_token) {
            idToken  = data.id_token;
            tokenExp = Date.now() + (Number(data.expires_in) || 3600) * 1000;
            myUid    = data.user_id || lsGet(FB_UID_KEY) || null;
            if (data.refresh_token && data.refresh_token !== refresh) persist(FB_REFRESH_KEY, data.refresh_token);
            if (myUid) persist(FB_UID_KEY, myUid);
            return;
          }
        } catch (e) { /* fall through to sign-up */ }
      }
      const res  = await fetchT(AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }),
      });
      const data = await readJson(res);
      if (data.error) throw new Error(data.error.message);
      if (!data.idToken) throw netError();
      idToken  = data.idToken;
      tokenExp = Date.now() + (Number(data.expiresIn) || 3600) * 1000;
      myUid    = data.localId || null;
      if (data.refreshToken) persist(FB_REFRESH_KEY, data.refreshToken);
      if (myUid) persist(FB_UID_KEY, myUid);
    })();
    try { await authInFlight; } finally { authInFlight = null; }
  }
  function authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (idToken) h['Authorization'] = 'Bearer ' + idToken;
    return h;
  }
  function myUidSync() { return myUid || lsGet(FB_UID_KEY) || null; }

  // ── Firestore value (de)serialisation ─────────────────────────────────────
  function toVal(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') {
      return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    }
    if (typeof v === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toVal) } };
    if (typeof v === 'object') {
      const fields = {};
      for (const k in v) fields[k] = toVal(v[k]);
      return { mapValue: { fields } };
    }
    return { stringValue: String(v) };
  }
  function fromVal(f) {
    if (!f) return null;
    if ('integerValue' in f) return Number(f.integerValue);
    if ('doubleValue' in f)  return Number(f.doubleValue);
    if ('stringValue' in f)  return f.stringValue;
    if ('booleanValue' in f) return !!f.booleanValue;
    if ('nullValue' in f)    return null;
    if ('arrayValue' in f)   return ((f.arrayValue && f.arrayValue.values) || []).map(fromVal);
    if ('mapValue' in f) {
      const out = {}, fl = (f.mapValue && f.mapValue.fields) || {};
      for (const k in fl) out[k] = fromVal(fl[k]);
      return out;
    }
    return null;
  }
  function docToEntry(doc) {
    const f = doc.fields || {};
    const uid = String(doc.name || '').split('/').pop();
    const me = myUidSync();
    return {
      uid,
      playerId:  fromVal(f.playerId) || '',
      name:      String(fromVal(f.playerName) || 'Player').slice(0, NAME_MAX),
      emblem:    String(fromVal(f.playerEmblem) || '🎮').slice(0, 8),
      score:     Number(fromVal(f.score)) || 0,
      meta:      fromVal(f.meta) || {},
      client:    fromVal(f.client) || '',
      updatedAt: Number(fromVal(f.updatedAt)) || 0,
      isMe:      !!me && uid === me,
    };
  }
  function sortEntries(list) {
    // score desc, then earliest holder first (ties go to whoever got there first)
    return list.sort((a, b) => (b.score - a.score) || (a.updatedAt - b.updatedAt));
  }

  // ── Top-10 witness ────────────────────────────────────────────────────────
  // The launcher's "Top Ten" global achievement can't poll every board on every
  // launch, so whenever we learn where YOU sit on a board we stamp the best rank
  // we've seen under gl_<boardId>_lb_rank. That gl_<boardId>_ prefix is the one
  // main.js mirrors into playerdata.json and seeds back into game windows, so a
  // rank earned inside a game reaches the launcher exactly like a stat does.
  // Mode boards use `<gameId>__<mode>` ids, which still carry the game prefix.
  function rankKey(gameId) { return 'gl_' + gameId + '_lb_rank'; }
  function noteRank(gameId, rank, score) {
    if (!gameId) return;
    const r = Math.round(Number(rank));
    if (!isFinite(r) || r < 1) return;
    let cur = null;
    try { cur = JSON.parse(lsGet(rankKey(gameId)) || 'null'); } catch (e) {}
    if (cur && typeof cur.best === 'number' && cur.best <= r) return; // never worsen
    persist(rankKey(gameId), JSON.stringify({ best: r, score: Number(score) || 0, at: Date.now() }));
  }
  function bestRank(gameId) {
    try {
      const v = JSON.parse(lsGet(rankKey(gameId)) || 'null');
      return v && typeof v.best === 'number' ? v.best : null;
    } catch (e) { return null; }
  }

  function colPath(gameId) { return FS_BASE + '/' + ROOT + '/' + encodeURIComponent(gameId); }
  function docPath(gameId, uid) { return colPath(gameId) + '/' + SUB + '/' + encodeURIComponent(uid); }

  // ── Reads (rules allow public reads; we still send auth when we have it) ───
  async function softAuth() { try { await ensureAuth(); } catch (e) {} }

  async function runQuery(gameId, structuredQuery) {
    const res = await fetchT(colPath(gameId) + ':runQuery', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ structuredQuery }),
    });
    const data = await readJson(res);
    throwIfError(res, data);
    const out = [];
    for (const row of (Array.isArray(data) ? data : [])) {
      if (row && row.document) out.push(docToEntry(row.document));
    }
    return out;
  }

  // runQuery / runAggregationQuery answer with a JSON ARRAY, and on failure the
  // error object rides inside that array ([{error:{…}}]) rather than at the top
  // level — so an unpublished rule (403) used to look like an empty board.
  function throwIfError(res, data) {
    const err = (data && data.error) || (Array.isArray(data) && data[0] && data[0].error);
    if (err) { const e = new Error(err.message || 'Firestore error'); e.code = err.code; throw e; }
    if (res && res.status >= 400) throw new Error('HTTP ' + res.status);
  }

  async function top(gameId, limit) {
    await softAuth();
    const n = Math.max(1, Math.min(100, limit || 10));
    const list = sortEntries(await runQuery(gameId, {
      from: [{ collectionId: SUB }],
      orderBy: [{ field: { fieldPath: 'score' }, direction: 'DESCENDING' }],
      limit: n,
    }));
    const mineIdx = list.findIndex(e => e.isMe);
    if (mineIdx >= 0) noteRank(gameId, mineIdx + 1, list[mineIdx].score);
    return list;
  }

  async function all(gameId) {
    await softAuth();
    const out = [];
    let pageToken = '';
    for (let guard = 0; guard < 20; guard++) {
      const url = colPath(gameId) + '/' + SUB + '?pageSize=' + ALL_PAGE + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      const res  = await fetchT(url, { headers: authHeaders() });
      const data = await readJson(res);
      if (data.error) throw new Error(data.error.message);
      for (const d of (data.documents || [])) out.push(docToEntry(d));
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }
    return sortEntries(out);
  }

  async function mine(gameId) {
    await softAuth();
    const uid = myUidSync();
    if (!uid) return null;
    const res = await fetchT(docPath(gameId, uid), { headers: authHeaders() });
    if (res.status === 404) return null;
    const data = await readJson(res);
    if (data.error) {
      if (data.error.code === 404 || data.error.status === 'NOT_FOUND') return null;
      throw new Error(data.error.message);
    }
    return docToEntry(data);
  }

  async function aggregateCount(gameId, where) {
    const structuredQuery = { from: [{ collectionId: SUB }] };
    if (where) structuredQuery.where = where;
    const res = await fetchT(colPath(gameId) + ':runAggregationQuery', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ structuredAggregationQuery: { structuredQuery, aggregations: [{ count: {}, alias: 'c' }] } }),
    });
    const data = await readJson(res);
    throwIfError(res, data);
    const row = Array.isArray(data) ? data.find(r => r && r.result) : null;
    const af = row && row.result && row.result.aggregateFields;
    return af && af.c ? Number(fromVal(af.c)) : null;
  }

  async function rankOf(gameId, score) {
    if (typeof score !== 'number') return null;
    await softAuth();
    try {
      const above = await aggregateCount(gameId, {
        fieldFilter: { field: { fieldPath: 'score' }, op: 'GREATER_THAN', value: toVal(score) },
      });
      return above === null ? null : above + 1;
    } catch (e) { return null; }
  }

  async function count(gameId) {
    await softAuth();
    try { return await aggregateCount(gameId, null); } catch (e) { return null; }
  }

  async function board(gameId, opts) {
    const limit = (opts && opts.limit) || 10;
    const [topList, me] = await Promise.all([top(gameId, limit), mine(gameId).catch(() => null)]);
    let rank = null, total = null;
    if (me) {
      const inTop = topList.findIndex(e => e.uid === me.uid);
      rank = inTop >= 0 ? inTop + 1 : await rankOf(gameId, me.score);
      noteRank(gameId, rank, me.score);
    }
    total = await count(gameId);
    return { top: topList, me, rank, total };
  }

  // ── Writes ────────────────────────────────────────────────────────────────
  async function submit(gameId, score, meta) {
    if (!gameId) throw new Error('gameId required');
    const s = Math.round(Number(score));
    if (!isFinite(s)) throw new Error('score must be a finite number');
    // Partner mode (an outside dev's test run, set by preload): never post to the live boards.
    if (window.__picklePartner) return { ok: true, submitted: false, partner: true, score: s, rank: null };
    await ensureAuth();
    if (!idToken || !myUid) throw netError('not signed in');

    // Never lower a score; the rules refuse it anyway, this just saves a round trip.
    let current = null;
    try { current = await mine(gameId); } catch (e) {}
    if (current && current.score >= s) {
      const keptRank = await rankOf(gameId, current.score);
      noteRank(gameId, keptRank, current.score);
      return { ok: true, submitted: false, score: current.score, rank: keptRank };
    }

    const id = identity();
    const body = { fields: {
      score:        toVal(s),
      meta:         toVal(meta && typeof meta === 'object' ? meta : {}),
      playerName:   toVal(id.name),
      playerEmblem: toVal(id.emblem),
      playerId:     toVal(id.playerId),
      client:       toVal(isWeb() ? 'web' : 'app'),
      updatedAt:    toVal(Date.now()),
    } };
    const res  = await fetchT(docPath(gameId, myUid), { method: 'PATCH', headers: authHeaders(), body: JSON.stringify(body) });
    const data = await readJson(res);
    if (data.error) throw new Error(data.error.message);
    const rank = await rankOf(gameId, s);
    noteRank(gameId, rank, s);
    return { ok: true, submitted: true, score: s, rank };
  }

  async function remove(gameId, uid) {
    if (window.__picklePartner) throw new Error('disabled in partner mode');
    await ensureAuth();
    const res = await fetchT(docPath(gameId, uid), { method: 'DELETE', headers: authHeaders() });
    if (res.status >= 400) {
      let msg = 'Delete failed';
      try { const d = await res.json(); if (d.error) msg = d.error.message; } catch (e) {}
      throw new Error(msg);
    }
    return true;
  }

  window.LeaderboardSDK = {
    submit, top, mine, rankOf, count, board, all, remove,
    myUid: myUidSync,
    identity,
    bestRank,   // best rank we've ever seen you hold on a board (no network)
    isAvailable: () => typeof fetch === 'function',
  };
})();
