/* ──────────────────────────────────────────────────────────────────────────
 * feedback.js — Bug Report / Feedback for Pickle Arcade
 *
 * Self-contained launcher module. Loaded by index.html.
 *
 *   • For everyone: a "Send Feedback" form that writes a message to the shared
 *     Firestore backend (same project the multiplayer lobby uses).
 *   • For the OWNER (you): an Inbox that lists every received message and lets
 *     you read or delete them.
 *
 * OWNER MODE
 *   This machine becomes the owner/inbox when EITHER:
 *     (a) it is running from source (npm start, app not packaged), or
 *     (b) the owner unlock key below was entered once via the "Developer access"
 *         link at the bottom of the feedback form. That sets gl_is_owner, which
 *         is persisted to playerdata.json and survives reinstalls.
 *
 *   To change the key, edit OWNER_UNLOCK_KEY below.
 *
 * UNIQUE USER ID
 *   Every profile is assigned a persistent gl_player_id (random UUID) the first
 *   time this module loads. It is saved to playerdata.json so the same person is
 *   trackable even if they rename their profile — usable later for leaderboards.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── Owner unlock key — change this to whatever you like ─────────────────────
  const OWNER_UNLOCK_KEY = 'pickle-owner-Zx9q';

  // ── Firestore config (same backend as lobby-sdk.js) ─────────────────────────
  const API_KEY    = 'AIzaSyDu8OygdH9Fft-3XcHD5Vzp8SnXgKt6mXk';
  const PROJECT_ID = 'pickle-arcade-lobbies';
  const FS_BASE    = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';
  const AUTH_URL   = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + API_KEY;
  const TOKEN_URL  = 'https://securetoken.googleapis.com/v1/token?key=' + API_KEY;
  const COLLECTION = 'feedback';

  // Persisted auth — keeps a STABLE Firebase UID across launches/reinstalls so
  // the owner's UID can be locked down in Firestore security rules.
  const FB_REFRESH_KEY = 'gl_fb_refresh'; // refresh token (durable identity)
  const FB_UID_KEY     = 'gl_fb_uid';     // this machine's Firebase UID

  // ── State ───────────────────────────────────────────────────────────────────
  let idToken     = null;
  let myUid       = null;  // this client's Firebase UID (the owner UID, on your machine)
  let APP_VERSION = '';
  let IS_DEV      = false;
  let inited      = false;

  // ── Small persistence helper (mirrors renderer.js persistKey) ───────────────
  function persist(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
    try {
      if (window.electronAPI && window.electronAPI.syncLauncherStorage) {
        window.electronAPI.syncLauncherStorage(key, value);
      }
    } catch (e) {}
  }

  function makeId() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    return 'usr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // Ensure this profile has a stable unique ID. Runs for new and existing
  // profiles alike; only assigns one if missing.
  function ensurePlayerId() {
    let id = localStorage.getItem('gl_player_id');
    if (!id) {
      id = makeId();
      persist('gl_player_id', id);
    }
    return id;
  }

  function playerName()   { return (localStorage.getItem('gl_player_name')   || 'Anonymous').trim() || 'Anonymous'; }
  function playerEmblem() { return (localStorage.getItem('gl_player_emblem') || '🎮').trim() || '🎮'; }

  function isOwner() {
    return IS_DEV || localStorage.getItem('gl_is_owner') === '1';
  }

  // ── Firestore REST helpers ──────────────────────────────────────────────────
  // Persistent anonymous auth. First run: anonymous sign-up, then store the
  // refresh token. Later runs: exchange the refresh token for a fresh idToken —
  // this keeps the SAME UID, so the owner's UID is stable and can be hard-coded
  // in Firestore rules. Falls back to a fresh sign-up if the refresh token is
  // missing or rejected.
  async function ensureAuth() {
    if (idToken) return;

    const storedRefresh = localStorage.getItem(FB_REFRESH_KEY);
    if (storedRefresh) {
      try {
        const res = await fetch(TOKEN_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    'grant_type=refresh_token&refresh_token=' + encodeURIComponent(storedRefresh),
        });
        const data = await res.json();
        if (!data.error && data.id_token) {
          idToken = data.id_token;
          myUid   = data.user_id || localStorage.getItem(FB_UID_KEY) || null;
          if (data.refresh_token) persist(FB_REFRESH_KEY, data.refresh_token);
          if (myUid) persist(FB_UID_KEY, myUid);
          return;
        }
        // else: token revoked/invalid → fall through to a fresh sign-up
      } catch (e) { /* network issue → fall through */ }
    }

    // Fresh anonymous sign-up (first run, or recovery from a bad refresh token).
    const res  = await fetch(AUTH_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ returnSecureToken: true }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    idToken = data.idToken;
    myUid   = data.localId || null;
    if (data.refreshToken) persist(FB_REFRESH_KEY, data.refreshToken);
    if (myUid) persist(FB_UID_KEY, myUid);
  }

  function authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (idToken) h['Authorization'] = 'Bearer ' + idToken;
    return h;
  }

  async function submitFeedback(message) {
    await ensureAuth();
    const body = {
      fields: {
        message:      { stringValue: message },
        playerName:   { stringValue: playerName() },
        playerId:     { stringValue: ensurePlayerId() },
        playerEmblem: { stringValue: playerEmblem() },
        appVersion:   { stringValue: APP_VERSION || '' },
        createdAt:    { integerValue: String(Date.now()) },
        status:       { stringValue: 'new' },
      },
    };
    const res = await fetch(FS_BASE + '/' + COLLECTION, {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify(body),
    });
    const doc = await res.json();
    if (doc.error) throw new Error(doc.error.message);
    return doc;
  }

  async function listFeedback() {
    await ensureAuth();
    // No filter, single-field ordering done client-side → no composite index needed.
    const res  = await fetch(FS_BASE + '/' + COLLECTION + '?pageSize=300', { headers: authHeaders() });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return (data.documents || []).map(doc => {
      const f = doc.fields || {};
      return {
        docId:        doc.name.split('/').pop(),
        message:      (f.message      && f.message.stringValue)      || '',
        playerName:   (f.playerName   && f.playerName.stringValue)   || 'Anonymous',
        playerId:     (f.playerId     && f.playerId.stringValue)     || '',
        playerEmblem: (f.playerEmblem && f.playerEmblem.stringValue) || '🎮',
        appVersion:   (f.appVersion   && f.appVersion.stringValue)   || '',
        createdAt:    Number((f.createdAt && f.createdAt.integerValue) || 0),
      };
    }).sort((a, b) => b.createdAt - a.createdAt);
  }

  async function deleteFeedback(docId) {
    await ensureAuth();
    const res = await fetch(FS_BASE + '/' + COLLECTION + '/' + docId, {
      method:  'DELETE',
      headers: authHeaders(),
    });
    if (res.status >= 400) {
      let msg = 'Delete failed';
      try { const d = await res.json(); if (d.error) msg = d.error.message; } catch (e) {}
      throw new Error(msg);
    }
  }

  // ── Utilities ───────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtDate(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(); } catch (e) { return ''; }
  }

  function $(id) { return document.getElementById(id); }

  // ── Modal control ───────────────────────────────────────────────────────────
  function open() {
    const modal = $('feedback-modal');
    if (!modal) return;
    // Decide which pane to show.
    if (isOwner()) showInbox();
    else           showSubmit();
    modal.classList.add('open');
    // Close any open header dropdowns/panels.
    const dd = $('profile-dropdown'); if (dd) dd.classList.remove('open');
    const cp = $('customize-panel');  if (cp) cp.classList.remove('open');
  }

  function close() {
    const modal = $('feedback-modal');
    if (modal) modal.classList.remove('open');
  }

  function showSubmit() {
    const submit = $('fb-submit-pane');
    const inbox  = $('fb-inbox-pane');
    if (submit) submit.style.display = '';
    if (inbox)  inbox.style.display  = 'none';
    const msg = $('fb-message');
    if (msg) msg.value = '';
    const status = $('fb-submit-status');
    if (status) { status.textContent = ''; status.className = 'fb-status'; }
    const keyRow = $('fb-key-row');
    if (keyRow) keyRow.style.display = 'none';
    const keyInput = $('fb-key-input');
    if (keyInput) keyInput.value = '';
    const sendBtn = $('fb-send');
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
  }

  function showInbox() {
    const submit = $('fb-submit-pane');
    const inbox  = $('fb-inbox-pane');
    if (submit) submit.style.display = 'none';
    if (inbox)  inbox.style.display  = '';
    loadInbox();
  }

  // ── Submit flow ─────────────────────────────────────────────────────────────
  async function onSend() {
    const msgEl  = $('fb-message');
    const status = $('fb-submit-status');
    const sendBtn = $('fb-send');
    const message = (msgEl && msgEl.value || '').trim();
    if (!message) {
      if (status) { status.textContent = 'Please type a message first.'; status.className = 'fb-status fb-status-err'; }
      if (msgEl) msgEl.focus();
      return;
    }
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }
    if (status)  { status.textContent = ''; status.className = 'fb-status'; }
    try {
      await submitFeedback(message);
      if (msgEl) msgEl.value = '';
      if (status) { status.textContent = '✓ Thank you! Your feedback was sent.'; status.className = 'fb-status fb-status-ok'; }
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
    } catch (e) {
      if (status) { status.textContent = '⚠ Could not send (' + (e && e.message ? e.message : 'network error') + '). Please try again.'; status.className = 'fb-status fb-status-err'; }
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
    }
  }

  // ── Owner unlock ────────────────────────────────────────────────────────────
  // The owner-key field is hidden from normal users. It is revealed only by a
  // secret gesture: 5 quick clicks on the 🐞 icon in the submit header. This
  // keeps the form clean for everyone else while still letting you claim owner
  // mode on an installed (non-dev) machine.
  let _secretClicks = 0;
  let _secretTimer  = null;
  function onSecretTap() {
    _secretClicks++;
    clearTimeout(_secretTimer);
    _secretTimer = setTimeout(() => { _secretClicks = 0; }, 1500);
    if (_secretClicks >= 5) {
      _secretClicks = 0;
      const keyRow = $('fb-key-row');
      if (keyRow) {
        keyRow.style.display = 'flex';
        const i = $('fb-key-input'); if (i) i.focus();
      }
    }
  }

  function onKeySubmit() {
    const input  = $('fb-key-input');
    const status = $('fb-submit-status');
    const val = (input && input.value || '').trim();
    if (val === OWNER_UNLOCK_KEY) {
      persist('gl_is_owner', '1');
      if (status) { status.textContent = '✓ Owner mode unlocked — opening your inbox…'; status.className = 'fb-status fb-status-ok'; }
      setTimeout(showInbox, 600);
    } else {
      if (status) { status.textContent = '⚠ Incorrect key.'; status.className = 'fb-status fb-status-err'; }
      if (input) { input.value = ''; input.focus(); }
    }
  }

  // ── Inbox flow ──────────────────────────────────────────────────────────────
  // Shows your Firebase UID so you can paste it into the Firestore security rules.
  function renderOwnerUid() {
    const el = $('fb-owner-uid');
    if (!el) return;
    if (!myUid) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML =
      '<span class="fb-uid-label">Your Owner UID</span>' +
      '<code class="fb-uid-val" id="fb-uid-val">' + esc(myUid) + '</code>' +
      '<button class="fb-uid-copy" id="fb-uid-copy">Copy</button>';
    const btn = $('fb-uid-copy');
    if (btn) btn.addEventListener('click', () => {
      try {
        navigator.clipboard.writeText(myUid);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      } catch (e) {}
    });
  }

  async function loadInbox() {
    const list  = $('fb-list');
    const count = $('fb-inbox-count');
    if (!list) return;
    list.innerHTML = '<div class="fb-inbox-empty">Loading…</div>';
    if (count) count.textContent = '';
    // Authenticate first so we can show the owner UID even if the read is denied.
    try { await ensureAuth(); } catch (e) {}
    renderOwnerUid();
    try {
      const items = await listFeedback();
      if (count) count.textContent = items.length + (items.length === 1 ? ' message' : ' messages');
      if (!items.length) {
        list.innerHTML = '<div class="fb-inbox-empty">No feedback yet.</div>';
        return;
      }
      list.innerHTML = items.map(renderItem).join('');
      // Wire delete buttons.
      list.querySelectorAll('.fb-del-btn').forEach(btn => {
        btn.addEventListener('click', () => onDelete(btn.getAttribute('data-id')));
      });
    } catch (e) {
      const msg = (e && e.message) ? e.message : 'network error';
      if (/permission|insufficient|denied|PERMISSION/i.test(msg)) {
        list.innerHTML = '<div class="fb-inbox-empty fb-status-err">🔒 Inbox locked.<br>' +
          'Add the Owner UID above to your Firestore rules, publish, then hit Refresh.</div>';
      } else {
        list.innerHTML = '<div class="fb-inbox-empty fb-status-err">⚠ Could not load feedback (' +
          esc(msg) + ').</div>';
      }
    }
  }

  function renderItem(it) {
    const ver = it.appVersion ? '<span class="fb-item-ver">v' + esc(it.appVersion) + '</span>' : '';
    return (
      '<div class="fb-item" data-id="' + esc(it.docId) + '">' +
        '<div class="fb-item-head">' +
          '<span class="fb-item-emblem">' + esc(it.playerEmblem) + '</span>' +
          '<span class="fb-item-name">' + esc(it.playerName) + '</span>' +
          ver +
          '<span class="fb-item-date">' + esc(fmtDate(it.createdAt)) + '</span>' +
          '<button class="fb-del-btn" data-id="' + esc(it.docId) + '" title="Delete">🗑️</button>' +
        '</div>' +
        '<div class="fb-item-msg">' + esc(it.message) + '</div>' +
        '<div class="fb-item-uid">ID: ' + esc(it.playerId || '—') + '</div>' +
      '</div>'
    );
  }

  async function onDelete(docId) {
    if (!docId) return;
    const node = document.querySelector('.fb-item[data-id="' + (window.CSS && CSS.escape ? CSS.escape(docId) : docId) + '"]');
    if (!confirm('Delete this feedback message?')) return;
    if (node) node.style.opacity = '0.4';
    try {
      await deleteFeedback(docId);
      if (node) node.remove();
      // Refresh the count.
      const remaining = document.querySelectorAll('#fb-list .fb-item').length;
      const count = $('fb-inbox-count');
      if (count) count.textContent = remaining + (remaining === 1 ? ' message' : ' messages');
      const list = $('fb-list');
      if (list && !remaining) list.innerHTML = '<div class="fb-inbox-empty">No feedback yet.</div>';
    } catch (e) {
      if (node) node.style.opacity = '1';
      alert('Could not delete: ' + (e && e.message ? e.message : 'network error'));
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  function wire() {
    if (inited) return;
    inited = true;

    const btn = $('feedback-btn');
    if (btn) btn.addEventListener('click', open);

    const closeBtn = $('feedback-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const backdrop = $('feedback-backdrop');
    if (backdrop) backdrop.addEventListener('click', close);

    const sendBtn = $('fb-send');
    if (sendBtn) sendBtn.addEventListener('click', onSend);

    const spark = $('fb-spark-submit');
    if (spark) spark.addEventListener('click', onSecretTap);
    const keyBtn = $('fb-key-submit');
    if (keyBtn) keyBtn.addEventListener('click', onKeySubmit);
    const keyInput = $('fb-key-input');
    if (keyInput) keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') onKeySubmit(); });

    const refreshBtn = $('fb-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', loadInbox);

    // Close on Escape.
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const modal = $('feedback-modal');
        if (modal && modal.classList.contains('open')) close();
      }
    });
  }

  async function init() {
    // Note: the authoritative gl_player_id assignment happens in renderer.js
    // init() right after it restores localStorage from playerdata.json, so we do
    // NOT assign it here (that would race the restore and could mint a new ID on
    // reinstall). submitFeedback() still calls ensurePlayerId() as a safety net.
    try {
      if (window.electronAPI && window.electronAPI.getAppInfo) {
        const info = await window.electronAPI.getAppInfo();
        if (info) { APP_VERSION = info.version || ''; IS_DEV = !!info.isDev; }
      }
    } catch (e) {}
    wire();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose a tiny API in case other code wants it.
  window.Feedback = { open, close };
})();
