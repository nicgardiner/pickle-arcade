// ── playerdata-store.js ────────────────────────────────────────────────────
// Durable, crash-safe store for playerdata.json — the ONLY persistent copy of
// every stat, achievement, favorite, playtime total and the player's anonymous
// Firebase identity (gl_fb_refresh / gl_fb_uid). Losing it loses everything, so
// this module exists to make three old failure modes impossible:
//
//   1. Torn writes. The old code did a bare fs.writeFileSync straight onto the
//      real file; a crash, power cut or full disk mid-write left a truncated
//      file. Now every write goes to <file>.tmp and is renamed into place, so
//      the target is only ever a complete document.
//   2. Silent total loss. The old loader swallowed a parse error and left the
//      in-memory object empty — and the very next save happily overwrote the
//      damaged (but possibly recoverable) file with {}. Now a non-empty file
//      that won't parse is NEVER overwritten: it's renamed aside for forensics
//      and we fall back to the known-good .bak snapshot.
//   3. Write amplification. Every single stat write from every game triggered a
//      synchronous full-file write on the main process. Writes are now
//      debounced (with a hard cap so a long burst still lands promptly), and
//      flushed synchronously at the moments that matter (game close, app quit).
//
// Deliberately plain CommonJS with no Electron imports — the file path comes in
// through the factory, so this is unit-testable with a plain temp directory.

const fs   = require('fs');
const path = require('path');

/**
 * @param {string} filePath  Absolute path to playerdata.json.
 * @param {object} [opts]
 * @param {number} [opts.debounceMs=250]  Quiet period after the last save() before writing.
 * @param {number} [opts.maxDelayMs=1000] Hard cap: a burst can never postpone the write
 *                                        more than this long past the FIRST dirty mark.
 * @param {object} [opts.log=console]     Anything with .warn/.error.
 */
function createPlayerDataStore(filePath, opts = {}) {
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : 250;
  const maxDelayMs = Number.isFinite(opts.maxDelayMs) ? opts.maxDelayMs : 1000;
  const log = opts.log || console;

  const dir  = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath)); // 'playerdata'
  const tmpPath = filePath + '.tmp';
  const bakPath = path.join(dir, base + '.bak');

  // THE live object. main.js holds this exact reference and only ever mutates
  // it (playerData[k] = v / delete playerData[k]), never reassigns it — so
  // load() must fill this object in place rather than swapping in a new one.
  const data = {};

  let dirty = false;
  let timer = null;
  let firstDirtyAt = 0;
  let writeCount = 0;              // real disk writes, for tests/diagnostics
  let startupSnapshot = '{}';      // JSON at load time, to know if .bak is stale

  function corruptPath() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-'); // filename-safe
    return path.join(dir, `${base}.corrupt-${stamp}.json`);
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function replaceData(obj) {
    for (const k in data) delete data[k];
    Object.assign(data, obj);
  }

  // Copy the CURRENT on-disk playerdata.json to playerdata.bak. Only ever
  // called when we know the source file parsed, so .bak is always a snapshot
  // that was valid at some point.
  function backupNow() {
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile() || st.size === 0) return false;
      fs.copyFileSync(filePath, bakPath);
      return true;
    } catch (e) {
      log.warn('[playerdata] could not refresh backup:', e && e.message);
      return false;
    }
  }

  // Read + parse a file, returning a plain object or null.
  function readObject(p) {
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
    if (!raw || !raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw);
      return isPlainObject(parsed) ? parsed : null;
    } catch { return null; }
  }

  /**
   * Populate `data` from disk. Returns a small report:
   *   { status: 'fresh' | 'ok' | 'recovered' | 'lost', corruptPath?, keys }
   */
  function load() {
    let st = null;
    try { st = fs.statSync(filePath); } catch {}

    // Missing or 0-byte → fresh install. No warning, no backup.
    if (!st || !st.isFile() || st.size === 0) {
      replaceData({});
      startupSnapshot = '{}';
      return { status: 'fresh', keys: 0 };
    }

    const good = readObject(filePath);
    if (good) {
      replaceData(good);
      startupSnapshot = JSON.stringify(data);
      backupNow(); // .bak is now a snapshot that definitely parsed
      return { status: 'ok', keys: Object.keys(data).length };
    }

    // Non-empty but unparseable (or not an object). NEVER overwrite it —
    // move it aside so a human can still pick it apart later.
    let kept = null;
    try {
      kept = corruptPath();
      fs.renameSync(filePath, kept);
    } catch (e) {
      // If we can't even rename it, at least refuse to clobber it: leave the
      // file alone and let the caller carry on with whatever we recover.
      log.error('[playerdata] could not quarantine corrupt file:', e && e.message);
      kept = null;
    }

    const recovered = readObject(bakPath);
    if (recovered) {
      replaceData(recovered);
      startupSnapshot = JSON.stringify(data);
      log.warn(
        `[playerdata] playerdata.json was unreadable and has been kept as ` +
        `${kept ? path.basename(kept) : '(in place)'}; recovered ` +
        `${Object.keys(data).length} keys from ${path.basename(bakPath)}.`
      );
      return { status: 'recovered', corruptPath: kept, keys: Object.keys(data).length };
    }

    replaceData({});
    startupSnapshot = '{}';
    log.warn(
      `[playerdata] playerdata.json was unreadable and no usable ` +
      `${path.basename(bakPath)} exists — starting empty. The damaged file was kept as ` +
      `${kept ? path.basename(kept) : '(in place)'}.`
    );
    return { status: 'lost', corruptPath: kept, keys: 0 };
  }

  // Atomic: full document to <file>.tmp, then rename over the target.
  function writeNow() {
    let json;
    try { json = JSON.stringify(data, null, 2); }
    catch (e) { log.error('[playerdata] could not serialize:', e && e.message); return false; }

    try {
      fs.writeFileSync(tmpPath, json);
    } catch (e) {
      log.error('[playerdata] temp write failed:', e && e.message);
      try { fs.unlinkSync(tmpPath); } catch {}
      return false;
    }

    try {
      // On Windows renameSync replaces an existing target; if the target is
      // momentarily locked it can still throw EPERM/EACCES/EEXIST.
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      try {
        fs.copyFileSync(tmpPath, filePath);
        try { fs.unlinkSync(tmpPath); } catch {}
      } catch (e2) {
        log.error('[playerdata] could not commit write:', e2 && e2.message);
        try { fs.unlinkSync(tmpPath); } catch {}
        return false;
      }
    }
    writeCount++;
    return true;
  }

  function clearTimer() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function onTimer() {
    timer = null;
    if (!dirty) return;
    dirty = false;
    firstDirtyAt = 0;
    writeNow();
  }

  /**
   * Mark dirty and schedule a write. Drop-in replacement for the old
   * synchronous savePlayerData() — same name, same call sites, no return value
   * anyone depended on.
   */
  function save() {
    dirty = true;
    const now = Date.now();
    if (!firstDirtyAt) firstDirtyAt = now;
    // Never let a burst push the write past maxDelayMs from the first mark.
    const budget = maxDelayMs - (now - firstDirtyAt);
    const wait = Math.max(0, Math.min(debounceMs, budget));
    clearTimer();
    timer = setTimeout(onTimer, wait);
    // A pending save must never keep the Electron process alive after quit.
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * Write synchronously right now if anything is pending, and cancel the timer.
   * @param {object} [o]
   * @param {boolean} [o.backup]  Also refresh playerdata.bak if the data changed
   *                              since load() — used on the app-quit flush.
   */
  function flush(o = {}) {
    clearTimer();
    let wrote = false;
    if (dirty) {
      dirty = false;
      firstDirtyAt = 0;
      wrote = writeNow();
    }
    if (o.backup) {
      let snap;
      try { snap = JSON.stringify(data); } catch { snap = null; }
      if (snap !== null && snap !== startupSnapshot) {
        if (backupNow()) startupSnapshot = snap;
      }
    }
    return wrote;
  }

  return {
    data,
    load,
    save,
    flush,
    backupNow,
    // paths + counters, handy for diagnostics and tests
    filePath, tmpPath, bakPath,
    get writeCount() { return writeCount; },
    get isDirty() { return dirty; },
  };
}

module.exports = { createPlayerDataStore };
