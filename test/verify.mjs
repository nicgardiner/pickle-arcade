#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
 * test/verify.mjs — Pickle Arcade library verifier
 *
 * A single, dependency-free static audit of the shippable tree. It exists
 * because every scripted finding of the 2026-09 audit (achievement ids a game
 * unlocks but never declares, a stat declared but never written, a cover
 * filename whose case only works on Windows, an unused 150 MB dependency
 * riding along in every installer) went out through several releases with
 * nothing to catch it.
 *
 * HARD CONSTRAINT: no npm dependencies, and it must run with no node_modules
 * present — the GitHub Pages workflow runs it without `npm ci`.
 *
 *   node test/verify.mjs            # FAIL → exit 1, WARN → exit 0
 *   node test/verify.mjs --strict   # WARN counts as FAIL too
 *   node test/verify.mjs --quiet    # print failures only
 *
 * Adding a check: push an entry onto CHECKS with { name, run }, and inside
 * run() call fail(file, message) / warn(file, message). Nothing else.
 * ────────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const ARGS   = new Set(process.argv.slice(2));
const STRICT = ARGS.has('--strict');
const QUIET  = ARGS.has('--quiet');

/* vm.SourceTextModule is the only way to syntax-check an inline
 * <script type="module"> block without executing it, and it is gated behind
 * --experimental-vm-modules. Re-exec once with the flag so a plain
 * `npm test` (and the Pages workflow) still covers those blocks; if the
 * re-exec can't happen, check 6 degrades to a WARN and everything else runs
 * exactly the same. NODE_NO_WARNINGS keeps the ExperimentalWarning banner out
 * of the report. */
if (typeof vm.SourceTextModule !== 'function' && !process.env.PICKLE_VERIFY_REEXEC) {
  const r = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, PICKLE_VERIFY_REEXEC: '1', NODE_NO_WARNINGS: '1' } },
  );
  if (typeof r.status === 'number') process.exit(r.status);
}

/* ── finding collection ──────────────────────────────────────────────────── */

const findings = [];          // { check, level, where, msg }
let CURRENT = '(none)';

const fail = (where, msg) => findings.push({ check: CURRENT, level: 'FAIL', where, msg });
const warn = (where, msg) => findings.push({ check: CURRENT, level: 'WARN', where, msg });

/* ── small fs / text helpers ─────────────────────────────────────────────── */

const rel  = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

function readJSON(p) {
  try { return { ok: true, data: JSON.parse(read(p)) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

const ROOT_ENTRIES = fs.readdirSync(ROOT);
const ROOT_FILES   = new Set(ROOT_ENTRIES);            // EXACT case — see check 2
const COVER_FILES  = exists('covers')
  ? fs.readdirSync(path.join(ROOT, 'covers'))
  : [];

/* games.json is the spine of almost every check; load it once. */
const gamesRes = readJSON('games.json');
const GAMES_DATA = gamesRes.ok ? gamesRes.data : null;
const GAMES = GAMES_DATA
  ? (Array.isArray(GAMES_DATA) ? GAMES_DATA : (GAMES_DATA.games || []))
  : [];
const LOCAL_GAMES = GAMES.filter(g => g && !g.external && typeof g.fileName === 'string');

/* Game HTML is read by three separate checks — cache it. */
const htmlCache = new Map();
function gameHtml(g) {
  if (htmlCache.has(g.fileName)) return htmlCache.get(g.fileName);
  let txt = null;
  try { txt = read(g.fileName); } catch { txt = null; }
  htmlCache.set(g.fileName, txt);
  return txt;
}

/* Does `src` contain `needle` as a quoted string literal? */
function hasQuoted(src, needle) {
  return src.includes(`'${needle}'`) || src.includes(`"${needle}"`) || src.includes('`' + needle + '`');
}

/* All string-literal first arguments of `name(` in `src`.
 * The lookahead for `,` or `)` is what keeps a *computed* key out of the
 * results: `setStat('best_' + diff, …)` is not a literal key, and reporting
 * "best_" as an undeclared stat would be noise. */
function literalArgs(src, name) {
  const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\(\\s*([\'"`])([^\'"`\\n]*?)\\1\\s*(?=[,)])', 'g');
  const out = new Set();
  let m;
  while ((m = re.exec(src))) out.add(m[2]);
  return out;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/* ── <script> extraction (used by checks 6 and 7) ────────────────────────── */
/* A block ends at the first literal `</script`, case-insensitive — exactly the
 * rule a browser's HTML parser uses. That is what makes pippin.html's
 * `type="text/html"` iframe template (which contains `</body></html>`) come out
 * as one opaque block instead of leaking its tail into the document. */
function scriptBlocks(html) {
  const out = [];
  const open = /<script\b/gi;
  let m;
  while ((m = open.exec(html))) {
    const attrEnd = html.indexOf('>', m.index);
    if (attrEnd < 0) break;
    const attrs = html.slice(m.index + '<script'.length, attrEnd);
    const close = /<\/script/gi;
    close.lastIndex = attrEnd + 1;
    const cm = close.exec(html);
    const bodyEnd = cm ? cm.index : html.length;
    let blockEnd = html.length;
    if (cm) {
      const gt = html.indexOf('>', cm.index);
      blockEnd = gt < 0 ? html.length : gt + 1;
    }
    out.push({
      attrs,
      code: html.slice(attrEnd + 1, bodyEnd),
      codeStart: attrEnd + 1,
      blockStart: m.index,
      blockEnd,
    });
    open.lastIndex = blockEnd;
  }
  return out;
}

const JS_TYPES = new Set([
  '', 'text/javascript', 'application/javascript', 'application/x-javascript',
  'text/ecmascript', 'application/ecmascript', 'javascript',
]);

function scriptType(attrs) {
  const m = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  return (m ? (m[1] ?? m[2] ?? m[3]) : '').trim().toLowerCase();
}
const hasSrc = (attrs) => /\bsrc\s*=/i.test(attrs);

/* ── JS object-literal key scanner (check 8) ─────────────────────────────── */
/* Pulls the top-level property names out of an object literal starting at the
 * `{` at `start`. Depth-aware (so arrow-function bodies and argument lists
 * don't contribute keys) and string/comment-aware. Both preload.js's
 * electronAPI block and web-shim.js's are plain literals with no regex
 * literals at depth 1, which is all this needs to handle. */
function objectKeys(src, start) {
  const keys = [];
  let i = start + 1, depth = 1, expectKey = true;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 2; continue; }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '{' || c === '(' || c === '[') { depth++; i++; continue; }
    if (c === '}' || c === ')' || c === ']') { depth--; i++; continue; }
    if (depth === 1 && c === ',') { expectKey = true; i++; continue; }
    if (depth === 1 && expectKey && /[A-Za-z_$]/.test(c)) {
      const name = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))[0];
      let j = i + name.length;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === ':' || src[j] === '(') { keys.push(name); expectKey = false; }
      i += name.length;
      continue;
    }
    if (depth === 1 && !/\s/.test(c)) expectKey = false;
    i++;
  }
  return keys;
}

function skipString(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return i + 1;
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      let d = 1; i += 2;
      while (i < src.length && d > 0) {
        if (src[i] === '{') d++;
        else if (src[i] === '}') d--;
        else if (src[i] === '"' || src[i] === "'" || src[i] === '`') { i = skipString(src, i); continue; }
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

/* Find `{` that opens the object passed to `marker`. */
function objectAfter(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const brace = src.indexOf('{', at + marker.length - 1);
  return brace < 0 ? null : brace;
}

/* ── syntax compilation helpers (check 6) ────────────────────────────────── */

const HAS_VM_MODULES = typeof vm.SourceTextModule === 'function';

function compileClassic(code, filename) {
  try { new vm.Script(code, { filename }); return null; }
  catch (e) { return e; }
}

function compileModule(code, filename) {
  if (!HAS_VM_MODULES) return { skipped: true };
  try { new vm.SourceTextModule(code, { identifier: filename }); return null; }
  catch (e) { return e; }
}

/* Standalone files go through `node --check`, which picks CommonJS vs ESM from
 * the extension — the right call for the .mjs build script. */
function nodeCheck(file) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' });
  if (r.status === 0) return null;
  const out = String(r.stderr || r.stdout || '').split('\n').filter(Boolean);
  const line = out.find(l => /Error/.test(l)) || out[0] || 'unknown parse error';
  return line.trim();
}

/* ────────────────────────────────────────────────────────────────────────────
 * CHECKS
 * ──────────────────────────────────────────────────────────────────────── */

const CHECKS = [];
const check = (name, run) => CHECKS.push({ name, run });

/* ── 1. games.json schema ────────────────────────────────────────────────── */
const COVER_TYPES = new Set(['default', 'classic', 'minimalist', 'night']);

check('games.json schema', () => {
  if (!gamesRes.ok) { fail('games.json', `does not parse: ${gamesRes.error}`); return; }
  if (!Array.isArray(GAMES) || !GAMES.length) {
    fail('games.json', '`games` must be a non-empty array');
    return;
  }

  const seenIds = new Set();
  for (const [i, g] of GAMES.entries()) {
    const at = `games.json[${i}]`;
    if (!g || typeof g !== 'object') { fail(at, 'entry is not an object'); continue; }

    const id = typeof g.id === 'string' && g.id ? g.id : null;
    if (!id) { fail(at, '`id` missing or not a string'); continue; }
    const where = `games.json:${id}`;
    if (seenIds.has(id)) fail(where, 'duplicate game id');
    seenIds.add(id);

    for (const k of ['title', 'fileName', 'description', 'party']) {
      if (typeof g[k] !== 'string' || !g[k]) fail(where, `\`${k}\` missing or not a non-empty string`);
    }
    if (!Array.isArray(g.tags)) fail(where, '`tags` must be an array');

    // stats
    if (!Array.isArray(g.stats)) fail(where, '`stats` must be an array');
    else {
      const seen = new Set();
      for (const s of g.stats) {
        if (!s || typeof s.key !== 'string' || !s.key) { fail(where, 'stat entry missing `key`'); continue; }
        if (seen.has(s.key)) fail(where, `duplicate stat key "${s.key}"`);
        seen.add(s.key);
        if (typeof s.label !== 'string' || !s.label) fail(where, `stat "${s.key}" missing \`label\``);
        if (typeof s.format !== 'string' || !s.format) fail(where, `stat "${s.key}" missing \`format\``);
      }
    }

    // achievements
    if (!Array.isArray(g.achievements)) fail(where, '`achievements` must be an array');
    else {
      const seen = new Set();
      for (const a of g.achievements) {
        if (!a || typeof a.id !== 'string' || !a.id) { fail(where, 'achievement entry missing `id`'); continue; }
        if (seen.has(a.id)) fail(where, `duplicate achievement id "${a.id}"`);
        seen.add(a.id);
        for (const k of ['label', 'desc', 'icon']) {
          if (typeof a[k] !== 'string' || !a[k]) fail(where, `achievement "${a.id}" missing \`${k}\``);
        }
      }
    }

    // cover type
    if (g.activeCoverType === undefined) warn(where, '`activeCoverType` not set (launcher falls back to default)');
    else if (!COVER_TYPES.has(g.activeCoverType)) {
      fail(where, `activeCoverType "${g.activeCoverType}" not one of ${[...COVER_TYPES].join('/')}`);
    }

    // leaderboard
    if (g.leaderboard !== undefined) {
      const lb = g.leaderboard;
      if (!lb || typeof lb !== 'object') fail(where, '`leaderboard` must be an object');
      else {
        if (typeof lb.label !== 'string' || !lb.label) fail(where, 'leaderboard missing `label`');
        if (Array.isArray(lb.modes)) {
          if (!lb.modes.length) fail(where, 'leaderboard `modes` is empty');
          // Per-mode contract (renderer.js lbModeCfgs): `id` and `label` are
          // required; `boardId` is optional and defaults to `<gameId>__<id>`
          // (Alien Alps relies on that); `localStatKey` is optional — without
          // it the card cannot show "your best" for that mode, so warn, and
          // when present it must name a declared stat.
          const statKeys = new Set((Array.isArray(g.stats) ? g.stats : []).map(s => s && s.key));
          for (const m of lb.modes) {
            const mid = m && typeof m.id === 'string' ? m.id : '?';
            for (const k of ['id', 'label']) {
              if (!m || typeof m[k] !== 'string' || !m[k]) fail(where, `leaderboard mode "${mid}" missing \`${k}\``);
            }
            if (!m) continue;
            if (m.boardId !== undefined && (typeof m.boardId !== 'string' || !m.boardId)) {
              fail(where, `leaderboard mode "${mid}" has a non-string \`boardId\``);
            }
            if (m.localStatKey === undefined) {
              warn(where, `leaderboard mode "${mid}" has no \`localStatKey\` (card cannot show your local best for it)`);
            } else if (typeof m.localStatKey !== 'string' || !statKeys.has(m.localStatKey)) {
              fail(where, `leaderboard mode "${mid}" localStatKey "${m.localStatKey}" is not a declared stat`);
            }
          }
        } else if (typeof lb.localStatKey !== 'string' || !lb.localStatKey) {
          fail(where, 'leaderboard needs either `modes[]` or `localStatKey`');
        }
      }
    }

    // external payload
    if (g.external === true) {
      const d = g.download;
      if (!d || typeof d !== 'object') fail(where, 'external game missing `download` block');
      else {
        if (typeof d.url !== 'string' || !/^https:\/\//.test(d.url)) fail(where, 'external `download.url` must be an https URL');
        if (typeof d.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(d.sha256)) fail(where, 'external `download.sha256` must be 64 hex chars');
      }
    }
  }
});

/* ── 2. Game files exist with exact case; no stray root games ────────────── */
check('game files', () => {
  for (const g of GAMES) {
    if (!g || typeof g.fileName !== 'string') continue;
    const where = `games.json:${g.id}`;
    if (ROOT_FILES.has(g.fileName)) continue;
    if (g.external) continue;                      // downloaded on demand
    // Windows' case-insensitive fs hides this; the Linux Pages build does not.
    const ci = ROOT_ENTRIES.find(f => f.toLowerCase() === g.fileName.toLowerCase());
    if (ci) fail(where, `fileName "${g.fileName}" differs in case from the file on disk ("${ci}") — the Linux Pages build 404s`);
    else fail(where, `fileName "${g.fileName}" does not exist in the project root`);
  }

  const referenced = new Set(GAMES.map(g => g && g.fileName).filter(Boolean));
  const launcher = new Set(['index.html', 'splash.html']);
  for (const f of ROOT_ENTRIES) {
    if (!/\.html$/i.test(f)) continue;
    if (launcher.has(f) || referenced.has(f)) continue;
    fail(f, 'stray root .html not referenced by games.json — main.js\'s migration would copy it into user profiles');
  }
});

/* ── 3. Covers ───────────────────────────────────────────────────────────── */
check('covers', () => {
  const ids = GAMES.map(g => g && g.id).filter(Boolean);
  const coverSet = new Set(COVER_FILES);

  for (const id of ids) {
    for (const suffix of ['.svg', '.default.svg']) {
      if (!coverSet.has(id + suffix)) fail(`covers/${id}${suffix}`, 'missing cover file');
    }
  }

  // Game ids can contain dots (coldmere_v1.0) — never split the filename on '.'
  for (const f of COVER_FILES) {
    if (!/\.svg$/i.test(f)) continue;
    if (!ids.some(id => f.startsWith(id + '.'))) {
      warn(`covers/${f}`, 'orphan cover — no game in games.json owns this id');
    }
  }

  for (const f of COVER_FILES) {
    if (!/\.svg$/i.test(f)) continue;
    const where = `covers/${f}`;
    let src;
    try { src = fs.readFileSync(path.join(ROOT, 'covers', f), 'utf8'); }
    catch (e) { fail(where, `unreadable: ${e.message}`); continue; }

    const head = src.replace(/^﻿/, '').trimStart();
    const body = head.replace(/^<\?xml[\s\S]*?\?>\s*/, '');
    if (!body.startsWith('<svg')) fail(where, 'does not start with <svg (after an optional XML declaration)');
    if (!src.trimEnd().endsWith('</svg>')) fail(where, 'does not end with </svg>');
    if (/<script/i.test(src)) fail(where, 'contains a <script> element');

    // `--` inside a comment is invalid XML: the card silently renders blank.
    const commentRe = /<!--([\s\S]*?)-->/g;
    let cm;
    const commentRanges = [];
    while ((cm = commentRe.exec(src))) {
      commentRanges.push([cm.index, cm.index + cm[0].length]);
      if (cm[1].includes('--')) fail(where, `"--" inside an XML comment at line ${lineOf(src, cm.index)} — blanks the card`);
    }
    const inComment = (i) => commentRanges.some(([a, b]) => i >= a && i < b);

    const ampRe = /&(?!(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);)/g;
    let am;
    while ((am = ampRe.exec(src))) {
      if (inComment(am.index)) continue;
      fail(where, `bare "&" (not a valid entity) at line ${lineOf(src, am.index)}`);
      break;                                   // one report per file is enough
    }
  }
});

/* ── 4. preload allowlists ───────────────────────────────────────────────── */
/* Parsed exactly the way web/build-site.mjs parses them, so the verifier and
 * the site build can never disagree about who is on a list. */
function parseAllowlist(src, name) {
  const m = src.match(new RegExp(name + '\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)'));
  if (!m) return null;
  return new Set([...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]));
}

let MP_SET = new Set(), LB_SET = new Set();

check('preload allowlists', () => {
  let src;
  try { src = read('preload.js'); } catch (e) { fail('preload.js', `unreadable: ${e.message}`); return; }

  const mp = parseAllowlist(src, 'ONLINE_MULTIPLAYER_GAMES');
  const lb = parseAllowlist(src, 'LEADERBOARD_GAMES');
  if (!mp) { fail('preload.js', 'ONLINE_MULTIPLAYER_GAMES not found (web/build-site.mjs would fail too)'); }
  if (!lb) { fail('preload.js', 'LEADERBOARD_GAMES not found (web/build-site.mjs would fail too)'); }
  MP_SET = mp || new Set();
  LB_SET = lb || new Set();
  if (mp && !mp.size) fail('preload.js', 'ONLINE_MULTIPLAYER_GAMES parsed empty');
  if (lb && !lb.size) fail('preload.js', 'LEADERBOARD_GAMES parsed empty');

  const ids = new Set(GAMES.map(g => g && g.id).filter(Boolean));
  for (const id of MP_SET) if (!ids.has(id)) fail('preload.js', `ONLINE_MULTIPLAYER_GAMES lists "${id}", which is not in games.json`);
  for (const id of LB_SET) if (!ids.has(id)) fail('preload.js', `LEADERBOARD_GAMES lists "${id}", which is not in games.json`);

  for (const g of LOCAL_GAMES) {
    const html = gameHtml(g);
    if (html == null) continue;                 // check 2 already reported it
    const where = g.fileName;

    const usesLobby = html.includes('LobbySDK');
    if (usesLobby && !MP_SET.has(g.id)) fail(where, `references LobbySDK but "${g.id}" is not in ONLINE_MULTIPLAYER_GAMES — window.LobbySDK will be undefined`);
    if (!usesLobby && MP_SET.has(g.id)) fail(where, `"${g.id}" is in ONLINE_MULTIPLAYER_GAMES but the game never references LobbySDK`);

    const usesBoard = html.includes('LeaderboardSDK');
    if (usesBoard && !LB_SET.has(g.id)) fail(where, `references LeaderboardSDK but "${g.id}" is not in LEADERBOARD_GAMES`);
    if (!usesBoard && LB_SET.has(g.id)) fail(where, `"${g.id}" is in LEADERBOARD_GAMES but the game never references LeaderboardSDK`);
    if (g.leaderboard && !usesBoard) fail(where, `games.json declares a \`leaderboard\` block but the game never references LeaderboardSDK`);
  }
});

/* ── 5. Achievements & stats declared vs written ─────────────────────────── */
/* An undeclared setStat/incrementStat key was the audit's loudest finding: the
 * value lands in gl_<id>_stats and the launcher card never shows it. The tree
 * is clean as of 2026-09-05, so this is a FAIL — flip it back to `warn` only
 * if a deliberate backlog of undeclared keys is ever reintroduced. */
const UNDECLARED_STAT_LEVEL = fail;

check('achievements & stats', () => {
  // Global achievement ids live in games.json AND renderer.js's own array.
  const globalIds = new Set(
    (GAMES_DATA && !Array.isArray(GAMES_DATA) && Array.isArray(GAMES_DATA.globalAchievements)
      ? GAMES_DATA.globalAchievements : [])
      .map(a => a && a.id).filter(Boolean)
  );
  try {
    const rsrc = read('renderer.js');
    const m = rsrc.match(/const\s+GLOBAL_ACHIEVEMENTS\s*=\s*\[([\s\S]*?)\n\];/);
    if (m) for (const x of m[1].matchAll(/\bid\s*:\s*['"]([^'"]+)['"]/g)) globalIds.add(x[1]);
    else warn('renderer.js', 'GLOBAL_ACHIEVEMENTS array not found — global achievement ids only checked against games.json');
  } catch (e) {
    warn('renderer.js', `unreadable: ${e.message}`);
  }

  for (const g of LOCAL_GAMES) {
    const html = gameHtml(g);
    if (html == null) continue;
    const where = g.fileName;
    const declaredAch  = new Set((g.achievements || []).map(a => a && a.id).filter(Boolean));
    const declaredStat = new Set((g.stats || []).map(s => s && s.key).filter(Boolean));

    // Any receiver: GameSDK.unlockAchievement(, sdk.unlockAchievement(, bare …
    for (const id of literalArgs(html, 'unlockAchievement')) {
      if (!declaredAch.has(id)) fail(where, `unlocks achievement "${id}", which is not declared in games.json`);
    }
    for (const id of declaredAch) {
      if (!hasQuoted(html, id)) fail(where, `games.json declares achievement "${id}", but the game never references it`);
    }
    for (const id of literalArgs(html, 'unlockGlobalAchievement')) {
      if (!globalIds.has(id)) fail(where, `unlocks global achievement "${id}", which is not declared in games.json or renderer.js`);
    }

    const written = new Set([...literalArgs(html, 'setStat'), ...literalArgs(html, 'incrementStat')]);
    for (const key of written) {
      if (!declaredStat.has(key)) UNDECLARED_STAT_LEVEL(where, `writes stat "${key}", which is not declared in games.json`);
    }
    for (const key of declaredStat) {
      if (!hasQuoted(html, key)) fail(where, `games.json declares stat "${key}", but the game never writes it`);
    }
  }
});

/* ── 6. JavaScript syntax ────────────────────────────────────────────────── */
const STANDALONE_JS = [
  'main.js', 'preload.js', 'renderer.js', 'feedback.js',
  'leaderboard-sdk.js', 'lobby-sdk.js', 'playerdata-store.js',
  'web/web-shim.js', 'web/gamesdk-web.js', 'web/console-redirect.js', 'web/build-site.mjs',
];

check('javascript syntax', () => {
  for (const f of STANDALONE_JS) {
    if (!exists(f)) { warn(f, 'not found — skipped'); continue; }
    const err = nodeCheck(f);
    if (err) fail(f, err);
  }

  for (const g of LOCAL_GAMES) {
    const html = gameHtml(g);
    if (html == null) continue;
    for (const b of scriptBlocks(html)) {
      if (hasSrc(b.attrs)) continue;
      const type = scriptType(b.attrs);
      const line = lineOf(html, b.codeStart);
      const at = `${g.fileName}:${line}`;
      if (type === 'module') {
        const r = compileModule(b.code, at);
        if (r && r.skipped) warn(at, 'module block not checked — vm.SourceTextModule unavailable (needs node --experimental-vm-modules)');
        else if (r) fail(at, `${r.name}: ${r.message}`);
        continue;
      }
      if (!JS_TYPES.has(type)) continue;         // text/html, importmap, x-shader/*, …
      const e = compileClassic(b.code, at);
      if (e) fail(at, `${e.name}: ${e.message}`);
    }
  }
});

/* ── 7. Document tails ───────────────────────────────────────────────────── */
/* A truncated game file is the launcher's classic silent failure (see the
 * Debugging note in CLAUDE.md). Scripts and comments are removed first, so a
 * `</body></html>` living inside pippin.html's text/html iframe template
 * doesn't count as the document's own. */
check('document tails', () => {
  for (const g of LOCAL_GAMES) {
    const html = gameHtml(g);
    if (html == null) continue;
    const where = g.fileName;

    let stripped = '';
    let cursor = 0;
    for (const b of scriptBlocks(html)) {
      stripped += html.slice(cursor, b.blockStart);
      cursor = b.blockEnd;
    }
    stripped += html.slice(cursor);
    stripped = stripped.replace(/<!--[\s\S]*?-->/g, '');

    const closes = [...stripped.matchAll(/<\/html\s*>/gi)];
    if (closes.length === 0) { fail(where, 'no </html> — file is truncated'); continue; }
    if (closes.length > 1) { fail(where, `${closes.length} </html> tags outside scripts/comments`); continue; }
    const last = closes[0];
    const tail = stripped.slice(last.index + last[0].length);
    if (/<\s*\/?\s*[A-Za-z!]/.test(tail)) fail(where, '</html> is not the last tag — markup follows it');
  }
});

/* ── 8. web-shim parity ──────────────────────────────────────────────────── */
check('web-shim parity', () => {
  let preloadSrc, shimSrc;
  try { preloadSrc = read('preload.js'); } catch (e) { fail('preload.js', `unreadable: ${e.message}`); return; }
  try { shimSrc = read('web/web-shim.js'); } catch (e) { fail('web/web-shim.js', `unreadable: ${e.message}`); return; }

  const pStart = objectAfter(preloadSrc, "exposeInMainWorld('electronAPI'");
  if (pStart == null) { fail('preload.js', "contextBridge.exposeInMainWorld('electronAPI', { … }) not found"); return; }
  const sStart = objectAfter(shimSrc, 'window.electronAPI =');
  if (sStart == null) { fail('web/web-shim.js', 'window.electronAPI = { … } not found'); return; }

  const pKeys = objectKeys(preloadSrc, pStart);
  const sKeys = new Set(objectKeys(shimSrc, sStart));
  if (!pKeys.length) { fail('preload.js', 'electronAPI object parsed with no methods'); return; }

  for (const k of pKeys) {
    if (!sKeys.has(k)) fail('web/web-shim.js', `electronAPI.${k} exists in preload.js but has no website counterpart`);
  }
});

/* ── 9. Versions ─────────────────────────────────────────────────────────── */
check('versions', () => {
  const pkgRes = readJSON('package.json');
  const clRes  = readJSON('changelog.json');
  if (!pkgRes.ok) { fail('package.json', `does not parse: ${pkgRes.error}`); return; }
  if (!clRes.ok)  { fail('changelog.json', `does not parse: ${clRes.error}`); return; }

  const releases = Array.isArray(clRes.data) ? clRes.data : (clRes.data.releases || []);
  if (!releases.length) { fail('changelog.json', 'no releases'); return; }

  if (releases[0].version !== pkgRes.data.version) {
    fail('changelog.json', `releases[0].version "${releases[0].version}" != package.json version "${pkgRes.data.version}" — What's New would show the wrong entry`);
  }

  const seen = new Set();
  for (const r of releases) {
    const v = r && r.version;
    const where = `changelog.json:${v || '?'}`;
    if (!v) { fail(where, 'release entry missing `version`'); continue; }
    if (seen.has(v)) fail(where, 'duplicate release version');
    seen.add(v);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date || ''))) warn(where, '`date` missing or not YYYY-MM-DD');
    if (!Array.isArray(r.notes) || !r.notes.length) warn(where, '`notes` missing or empty');
  }
});

/* ── 10. Dependencies & build exclusions ─────────────────────────────────── */
const ALLOWED_DEPS = new Set(['electron-updater']);
const REQUIRED_EXCLUSIONS = [
  '!_dev/**', '!web/**', '!site/**', '!console-site/**', '!.github/**',
  '!.claude/**', '!test/**', '!**/*.vbs', '!playerdata.json', '!black_knight_16.html',
];

check('dependencies & build.files', () => {
  const pkgRes = readJSON('package.json');
  if (!pkgRes.ok) { fail('package.json', `does not parse: ${pkgRes.error}`); return; }
  const pkg = pkgRes.data;

  for (const d of Object.keys(pkg.dependencies || {})) {
    // Everything in `dependencies` is packed into the installer verbatim. The
    // unused `firebase` package quietly added 116 MB to every download.
    if (!ALLOWED_DEPS.has(d)) fail('package.json', `runtime dependency "${d}" is not in the allowlist (${[...ALLOWED_DEPS].join(', ')}) — it ships in the installer`);
  }
  for (const d of ALLOWED_DEPS) {
    if (!(pkg.dependencies || {})[d]) fail('package.json', `required runtime dependency "${d}" is missing`);
  }

  const files = (pkg.build && pkg.build.files) || [];
  for (const ex of REQUIRED_EXCLUSIONS) {
    if (!files.includes(ex)) fail('package.json', `build.files is missing the exclusion "${ex}"`);
  }
});

/* ── 11. Root shippability ───────────────────────────────────────────────── */
/* build.files starts with "**\/*", so anything sitting in the root is a
 * candidate for the installer. Scratch files landing here is how dev junk has
 * shipped before. */
const ROOT_ALWAYS = new Set([
  // launcher
  'index.html', 'splash.html', 'style.css', 'renderer.js', 'preload.js', 'main.js',
  'feedback.js', 'leaderboard-sdk.js', 'lobby-sdk.js', 'playerdata-store.js',
  // data
  'games.json', 'changelog.json', 'playerdata.json', 'firestore.rules',
  'package.json', 'package-lock.json',
  // repo furniture
  'CLAUDE.md', 'README.md', '.gitignore', '.gitattributes',
  // dev copy of an external game main.js looks for in LIBRARY_DIR
  'black_knight_16.html',
  // directories
  'covers', 'assets', 'vendor', 'build', 'node_modules', 'dist', 'site', 'test',
  '_dev', '_to_delete', '.git', '.github', '.claude', 'web', 'console-site',
]);

check('root shippability', () => {
  const gameFiles = new Set(GAMES.map(g => g && g.fileName).filter(Boolean));
  for (const f of ROOT_ENTRIES) {
    if (ROOT_ALWAYS.has(f) || gameFiles.has(f)) continue;
    warn(f, 'unexpected file in the project root — scratch work belongs in _dev/');
  }
});

/* ── 12. Vendored engines ────────────────────────────────────────────────── */
/* three.js / cannon ship in vendor/ so 3D games start offline (2026-10-02).
 * Games reference them as ./vendor/<lib>-<version>/… (script src or importmap).
 * Every reference must exist with exact case (the Pages build is Linux), and
 * so must every `three/addons/…` import mapped into vendor/ and every relative
 * import inside the vendored files themselves. A game loading an engine from a
 * CDN fails: it would show a black screen offline. */
const ENGINE_CDN = /https?:\/\/[^"'`\s)]*(?:three(?:\.js\/|@|\.module|\.min)|cannon)[^"'`\s)]*/gi;

function existsExact(rel) {
  let dir = ROOT;
  for (const seg of rel.split('/')) {
    let names; try { names = fs.readdirSync(dir); } catch { return false; }
    if (!names.includes(seg)) return false;
    dir = path.join(dir, seg);
  }
  return true;
}
function walk(rel) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }))
    (e.isDirectory() ? out.push(...walk(rel + '/' + e.name)) : out.push(rel + '/' + e.name));
  return out;
}

check('vendored engines', () => {
  const used = new Set();
  const want = (where, rel) => { used.add(rel); if (!existsExact(rel)) fail(where, `references ${rel}, which is not in vendor/ (check the path and its case)`); };

  for (const g of LOCAL_GAMES) {
    const html = gameHtml(g); if (!html) continue;
    for (const m of html.matchAll(ENGINE_CDN)) fail(g.fileName, `loads ${m[0]} from a CDN — vendor it (CLAUDE.md "Vendored engines")`);
    for (const m of html.matchAll(/\.\/vendor\/[^"'`\s)]+/g)) if (!m[0].endsWith('/')) want(g.fileName, m[0].slice(2));
    // importmap prefixes pointing into vendor/ (e.g. "three/addons/") → every import that uses them
    for (const b of html.matchAll(/<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      let imports; try { imports = JSON.parse(b[1]).imports || {}; } catch { fail(g.fileName, 'importmap is not valid JSON'); continue; }
      for (const [k, v] of Object.entries(imports)) {
        if (!k.endsWith('/') || !v.startsWith('./vendor/')) continue;
        for (const m of html.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g))
          if (m[1].startsWith(k)) want(g.fileName, v.slice(2) + m[1].slice(k.length));
      }
    }
  }
  if (!existsExact('vendor')) return;
  const files = walk('vendor');
  // relative imports inside vendored modules (OrbitControls → nothing, EffectComposer → ./Pass.js, …)
  for (let i = 0; i < files.length; i++) {
    const f = files[i]; if (!f.endsWith('.js') || !used.has(f)) continue;
    for (const m of read(f).matchAll(/(?:from\s*|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (!used.has(rel)) { want(f, rel); i = -1; }   // newly used file: rescan so its own imports count
    }
  }
  for (const f of files) if (!used.has(f) && !/\/LICENSE$/.test(f)) warn(f, 'no game uses this vendored file — delete it');
});

/* ────────────────────────────────────────────────────────────────────────────
 * RUN + REPORT
 * ──────────────────────────────────────────────────────────────────────── */

for (const c of CHECKS) {
  CURRENT = c.name;
  try { c.run(); }
  catch (e) { fail('(verifier)', `check threw: ${e && e.stack ? e.stack.split('\n')[0] : e}`); }
}

const isFail = (f) => f.level === 'FAIL' || (STRICT && f.level === 'WARN');
const fails = findings.filter(isFail);
const warns = findings.filter(f => !isFail(f));

const out = [];
out.push('');
out.push(`Pickle Arcade library verifier — ${CHECKS.length} checks, ${GAMES.length} games` +
         (STRICT ? '  [--strict]' : ''));
out.push('─'.repeat(72));

for (const c of CHECKS) {
  const mine  = findings.filter(f => f.check === c.name);
  const bad   = mine.filter(isFail);
  const meh   = mine.filter(f => !isFail(f));
  if (QUIET && !bad.length) continue;
  const status = bad.length ? 'FAIL' : (meh.length ? 'WARN' : ' ok ');
  const tally  = bad.length || meh.length
    ? `  (${bad.length} fail, ${meh.length} warn)` : '';
  out.push(`[${status}] ${c.name}${tally}`);
  for (const f of bad) out.push(`       FAIL  ${f.where}: ${f.msg}`);
  if (!QUIET) for (const f of meh) out.push(`       warn  ${f.where}: ${f.msg}`);
}

out.push('─'.repeat(72));
out.push(fails.length
  ? `${fails.length} failure(s), ${warns.length} warning(s)`
  : `PASS — 0 failures, ${warns.length} warning(s)${STRICT ? '' : '  (run --strict to fail on warnings)'}`);
out.push('');

console.log(out.join('\n'));
process.exit(fails.length ? 1 : 0);
