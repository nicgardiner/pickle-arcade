#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
 * build-site.mjs — assembles the Pickle Arcade WEBSITE into site/
 *
 * Run from the project root (or anywhere: paths resolve relative to this
 * file's parent directory):   node web/build-site.mjs
 *
 * What it does:
 *   1. Copies the launcher files (index.html, style.css, renderer.js,
 *      feedback.js, lobby-sdk.js, games.json, changelog.json, assets/,
 *      covers/) into site/.
 *   2. Injects <script src="web-shim.js"> into the site copy of index.html
 *      (before feedback.js/renderer.js) — the app copy is untouched.
 *   3. Copies every game HTML listed in games.json (allowlist — stray dev
 *      HTML in the root never ships) and injects gamesdk-web.js into each,
 *      plus lobby-sdk.js for games in preload.js's ONLINE_MULTIPLAYER_GAMES
 *      allowlist (parsed from preload.js — single source of truth).
 *   4. External games (external:true): uses the local dev copy if present,
 *      otherwise downloads download.url; verifies sha256 either way.
 *   5. Generates covers/manifest.json ({gameId: contentHash}) for cache
 *      busting — the web equivalent of the app's list-covers IPC.
 *   6. Bakes package.json's version into web-shim.js (__SITE_VERSION__).
 *
 * No dependencies — plain Node 18+. CI runs this in
 * .github/workflows/deploy-pages.yml on every push to main.
 * ────────────────────────────────────────────────────────────────────────── */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');

const log = (msg) => console.log('  ' + msg);
const fail = (msg) => { console.error('✖ ' + msg); process.exit(1); };

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function readText(p)  { return fs.readFile(p, 'utf8'); }
async function writeText(p, s) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s, 'utf8'); }
async function copyFile(src, dest) { await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.copyFile(src, dest); }
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

// Inject script tags into an HTML string as early in <head> as safely
// possible: after <meta charset> if present (so the charset declaration stays
// in the first bytes), else right after <head>, else after <html>, else at
// the very top. Early injection preserves the preload.js contract: the SDK
// exists before any game script runs.
function injectScripts(html, tags) {
  const block = tags.join('');
  let m = html.match(/<meta[^>]*charset[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + block);
  m = html.match(/<head[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + block);
  m = html.match(/<html[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + block);
  return block + html;
}

// Parse the ONLINE_MULTIPLAYER_GAMES allowlist out of preload.js so the
// website injects lobby-sdk.js into exactly the same games as the app.
async function onlineGameIds() {
  const src = await readText(path.join(ROOT, 'preload.js'));
  const m = src.match(/ONLINE_MULTIPLAYER_GAMES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) fail('Could not find ONLINE_MULTIPLAYER_GAMES in preload.js');
  const ids = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
  if (!ids.length) fail('ONLINE_MULTIPLAYER_GAMES parsed empty — check preload.js');
  return new Set(ids);
}

async function main() {
  console.log('Building Pickle Arcade website → site/');

  // Fresh output dir
  await fs.rm(SITE, { recursive: true, force: true });
  await fs.mkdir(SITE, { recursive: true });

  const pkg = JSON.parse(await readText(path.join(ROOT, 'package.json')));
  const gamesData = JSON.parse(await readText(path.join(ROOT, 'games.json')));
  const games = Array.isArray(gamesData) ? gamesData : (gamesData.games || []);
  if (!games.length) fail('games.json has no games');
  const online = await onlineGameIds();

  // ── 1. Launcher core files ────────────────────────────────────────────────
  for (const f of ['style.css', 'renderer.js', 'feedback.js', 'lobby-sdk.js',
                   'games.json', 'changelog.json']) {
    await copyFile(path.join(ROOT, f), path.join(SITE, f));
  }
  log('launcher core copied');

  // index.html + web-shim injection (before feedback.js/renderer.js)
  let indexHtml = await readText(path.join(ROOT, 'index.html'));
  if (!indexHtml.includes('feedback.js')) fail('index.html: feedback.js script tag not found');
  indexHtml = indexHtml.replace('<script src="feedback.js"></script>',
    '<script src="web-shim.js"></script>\n<script src="feedback.js"></script>');
  await writeText(path.join(SITE, 'index.html'), indexHtml);
  log('index.html: web-shim.js injected');

  // web runtime, with version baked in
  const shim = (await readText(path.join(ROOT, 'web', 'web-shim.js')))
    .replaceAll('__SITE_VERSION__', pkg.version);
  if (!shim.includes("SITE_VERSION     = '" + pkg.version + "'")) fail('version bake failed');
  await writeText(path.join(SITE, 'web-shim.js'), shim);
  await copyFile(path.join(ROOT, 'web', 'gamesdk-web.js'), path.join(SITE, 'gamesdk-web.js'));
  log('web runtime copied (site version ' + pkg.version + ')');

  // ── 2. Assets & covers (+ manifest) ──────────────────────────────────────
  for (const dir of ['assets', 'covers']) {
    const srcDir = path.join(ROOT, dir);
    for (const f of await fs.readdir(srcDir)) {
      await copyFile(path.join(srcDir, f), path.join(SITE, dir, f));
    }
  }
  const manifest = {};
  for (const g of games) {
    const p = path.join(ROOT, 'covers', g.id + '.svg');
    if (await exists(p)) manifest[g.id] = sha256(await fs.readFile(p)).slice(0, 12);
  }
  await writeText(path.join(SITE, 'covers', 'manifest.json'), JSON.stringify(manifest, null, 1));
  log('assets + ' + Object.keys(manifest).length + ' cover versions');

  // ── 3. Game pages, with SDK injection ─────────────────────────────────────
  let bundled = 0;
  for (const g of games) {
    if (!g.fileName) fail('games.json entry missing fileName: ' + g.id);
    let html;
    const localPath = path.join(ROOT, g.fileName);

    if (g.external && g.download && g.download.url) {
      // External game: local dev copy if present, else download; verify hash.
      let buf;
      if (await exists(localPath)) {
        buf = await fs.readFile(localPath);
        if (g.download.sha256 && sha256(buf) !== g.download.sha256) {
          log(g.id + ': local copy hash mismatch — downloading release copy');
          buf = null;
        }
      }
      if (!buf) {
        log(g.id + ': downloading ' + g.download.url);
        const res = await fetch(g.download.url);
        if (!res.ok) fail(g.id + ': download failed (' + res.status + ')');
        buf = Buffer.from(await res.arrayBuffer());
        if (g.download.sha256 && sha256(buf) !== g.download.sha256) {
          fail(g.id + ': downloaded file sha256 mismatch');
        }
      }
      html = buf.toString('utf8');
    } else {
      if (!(await exists(localPath))) fail('game file missing: ' + g.fileName);
      html = await readText(localPath);
    }

    const tags = ['<script src="gamesdk-web.js"></script>'];
    if (online.has(g.id)) tags.push('<script src="lobby-sdk.js"></script>');
    await writeText(path.join(SITE, g.fileName), injectScripts(html, tags));
    bundled++;
  }
  log(bundled + ' games bundled (' + online.size + ' with lobby-sdk)');

  // ── 4. Pages niceties ──────────────────────────────────────────────────────
  await writeText(path.join(SITE, '.nojekyll'), '');

  console.log('✔ site/ ready');
}

main().catch(e => fail(e && e.stack || String(e)));
