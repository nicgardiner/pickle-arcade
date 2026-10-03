// Builds a partner's published games into the root of the repo.
//   node partners/build.mjs <partner> [gameId ...] [--check]
// For each partners/<partner>/<gameId>/ folder that has an entry.json:
//   patch.mjs → root <fileName> (skipped for "external": true), covers/* → root covers/,
//   entry.json → its object in root games.json (replaced in place, or appended for a new id).
// --check builds into a temp dir and exits 1 listing every output that differs from the working tree; writes nothing.
// No dependencies: runs under plain Node and under ELECTRON_RUN_AS_NODE=1 electron.exe. Does not run npm test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const [partner, ...only] = args.filter(a => a !== '--check');

let tmp = null;
const die = msg => {   // exit 2 = invalid input (vs 1 = --check found differences)
  console.error(`build: ${msg}`);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(2);
};
if (!partner || !/^[a-z0-9_-]+$/.test(partner)) die('usage: node partners/build.mjs <partner> [gameId ...] [--check]');
const PDIR = path.join(HERE, partner);
if (!fs.existsSync(PDIR)) die(`no folder partners/${partner}`);

let devName = partner[0].toUpperCase() + partner.slice(1);
try { devName = JSON.parse(fs.readFileSync(path.join(HERE, 'partners.json'), 'utf8'))[partner].name || devName; } catch {}

const ids = only.length ? only : fs.readdirSync(PDIR).filter(d => fs.existsSync(path.join(PDIR, d, 'entry.json'))).sort();
for (const id of ids) if (!fs.existsSync(path.join(PDIR, id, 'entry.json'))) die(`partners/${partner}/${id}/entry.json not found`);

// ---- games.json: splice entry text in, so the file's hand formatting survives byte-for-byte ----
// Returns [{ id, start, end, indent }] for each object in the top-level "games" array (end is exclusive).
function gameSpans(text) {
  const open = text.indexOf('[', text.indexOf('"games"'));
  const spans = [];
  let depth = 0, inStr = false, start = -1;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') { if (depth++ === 0) start = i; }
    else if (c === '}' || c === ']') {
      if (depth === 0) break;                       // the closing ] of "games"
      if (--depth === 0) {
        const lineStart = text.lastIndexOf('\n', start) + 1;
        spans.push({ id: JSON.parse(text.slice(start, i + 1)).id, start, end: i + 1, indent: text.slice(lineStart, start) });
      }
    }
  }
  return spans;
}

let games = fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8');
const before = JSON.parse(games).games;
const outputs = [];          // [rootRelPath, Buffer|string]
tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-build-'));
try {
  for (const id of ids) {
    const dir = path.join(PDIR, id);
    const raw = fs.readFileSync(path.join(dir, 'entry.json'), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
    let e;
    try { e = JSON.parse(raw); } catch (err) { die(`${id}/entry.json: ${err.message}`); }
    if (e.id !== id) die(`${id}/entry.json: id is "${e.id}", must equal the folder name`);
    if (e.party !== 'third') die(`${id}/entry.json: party must be "third"`);
    if (e.developer !== devName) die(`${id}/entry.json: developer must be "${devName}"`);
    if (typeof e.fileName !== 'string' || !/^[^/\\]+\.html$/.test(e.fileName)) die(`${id}/entry.json: fileName must be a plain <name>.html`);
    const owner = before.find(g => g.fileName === e.fileName);
    if (owner && owner.id !== id) die(`${id}/entry.json: fileName ${e.fileName} belongs to "${owner.id}"`);
    if (!owner && fs.existsSync(path.join(ROOT, e.fileName))) die(`${id}/entry.json: root ${e.fileName} already exists and is not this game's`);

    if (!e.external) {
      const out = path.join(tmp, e.fileName);
      try { execFileSync(process.execPath, [path.join(dir, 'patch.mjs'), out], { stdio: ['ignore', 'ignore', 'inherit'] }); }
      catch { die(`${id}/patch.mjs failed (its error is above)`); }
      outputs.push([e.fileName, fs.readFileSync(out)]);
    }
    const cdir = path.join(dir, 'covers');
    for (const f of fs.existsSync(cdir) ? fs.readdirSync(cdir).sort() : []) {
      if (!f.startsWith(id + '.')) die(`${id}/covers/${f}: cover files must be named ${id}.<variant>`);
      outputs.push([`covers/${f}`, fs.readFileSync(path.join(cdir, f))]);
    }

    const spans = gameSpans(games);
    const hit = spans.find(s => s.id === id);
    const ind = (hit || spans[spans.length - 1]).indent;
    const text = raw.split('\n').join('\n' + ind);
    games = hit ? games.slice(0, hit.start) + text + games.slice(hit.end)
                : games.slice(0, spans[spans.length - 1].end) + ',\n' + ind + text + games.slice(spans[spans.length - 1].end);
  }
  JSON.parse(games);   // never write a games.json that doesn't parse
  outputs.push(['games.json', games]);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const differs = outputs.filter(([rel, data]) => {
  const p = path.join(ROOT, rel);
  return !fs.existsSync(p) || !fs.readFileSync(p).equals(Buffer.from(data));
});
if (check) {
  for (const [rel] of differs) console.log(`differs: ${rel}`);
  console.log(`${partner}: ${ids.length} games, ${outputs.length} outputs — ${differs.length ? `CHECK FAILED, ${differs.length} differ` : 'check ok'}`);
  process.exit(differs.length ? 1 : 0);
}
for (const [rel, data] of differs) fs.writeFileSync(path.join(ROOT, rel), data);
console.log(`${partner}: ${ids.length} games, ${outputs.length} outputs — ${differs.length} written${differs.length ? ': ' + differs.map(d => d[0]).join(', ') : ''}`);
