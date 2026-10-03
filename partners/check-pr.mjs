// CI scope check for a partner pull request.
//   node partners/check-pr.mjs --base <dir> --head <dir> --author <github-login>
// <base> and <head> are git checkouts of the PR's base and of the PR (CI: the merge commit and its
// first parent). Run the BASE copy of this file: the mapping (partners.json) and build.mjs come from
// <base>, the content under test from <head>. No dependencies.
// Exit 0 = pass or not a partner PR; 1 = a rule failed; 2 = bad usage.
// Writes a human-readable report to stdout, and markdown to $GITHUB_STEP_SUMMARY when set.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const opt = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1];
if (!opt.base || !opt.head || opt.author === undefined) {
  console.error('usage: node partners/check-pr.mjs --base <dir> --head <dir> --author <login>');
  process.exit(2);
}
const BASE = path.resolve(opt.base), HEAD = path.resolve(opt.head);
const lines = [];   // markdown report; stdout gets the same text
const out = s => { lines.push(s); console.log(s); };
const finish = code => {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  process.exit(code);
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel));

// ---- author → partner. A GitHub login has no "_", so placeholders like JERTAL_GITHUB_LOGIN never match.
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const partners = JSON.parse(read(BASE, 'partners/partners.json'));
const author = String(opt.author).toLowerCase();
const p = Object.keys(partners).find(k =>
  (partners[k].github || []).some(g => LOGIN.test(g) && g.toLowerCase() === author));
if (!p) { out(`### Partner check\nnot a partner PR (author \`${opt.author}\`) — partner checks skipped`); finish(0); }

const failures = [], warnings = [];
const PREFIX = `partners/${p}/`;

// ---- changed paths, base → head (tracked + untracked-not-ignored, so a local working tree works too)
const ls = root => new Set(execFileSync('git', ['-C', root, 'ls-files', '-coz', '--exclude-standard'], { maxBuffer: 1 << 26 })
  .toString().split('\0').filter(f => f && fs.existsSync(path.join(root, f))));
const baseFiles = ls(BASE), headFiles = ls(HEAD);
const changed = [...new Set([...baseFiles, ...headFiles])].sort().filter(f =>
  !baseFiles.has(f) || !headFiles.has(f) || !read(BASE, f).equals(read(HEAD, f)));

// ---- the partner's games and generated outputs in a tree (same rules as build.mjs)
function partnerTree(root) {
  const ids = new Set(), files = new Set();
  const dir = path.join(root, 'partners', p);
  for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!fs.existsSync(path.join(dir, id, 'entry.json'))) continue;
    ids.add(id);
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, id, 'entry.json'), 'utf8'));
      if (!e.external && typeof e.fileName === 'string' && /^[^/\\]+$/.test(e.fileName)) files.add(e.fileName);
    } catch {}   // build --check reports a broken entry.json
    const c = path.join(dir, id, 'covers');
    for (const f of fs.existsSync(c) ? fs.readdirSync(c) : []) files.add(`covers/${f}`);
  }
  return { ids, files };
}
const B = partnerTree(BASE), H = partnerTree(HEAD);
const mine = new Set([...B.files, ...H.files, 'games.json']);
const myIds = new Set([...B.ids, ...H.ids]);

// 1. scope
for (const f of changed) if (!f.startsWith(PREFIX) && !mine.has(f)) failures.push(`out of scope: \`${f}\``);

// 2. a new output must not land on an existing file that isn't his (case-insensitive: Windows/macOS checkouts)
const baseLower = new Set([...baseFiles].map(f => f.toLowerCase()));
for (const f of H.files) if (!B.files.has(f) && baseLower.has(f.toLowerCase()))
  failures.push(`\`${f}\` would overwrite an existing file that is not one of ${p}'s outputs`);

// 3. games.json: only his entries may change
let bj, hj;
try { bj = JSON.parse(read(BASE, 'games.json')); hj = JSON.parse(read(HEAD, 'games.json')); }
catch (e) { failures.push(`games.json does not parse: ${e.message}`); }
if (bj && hj) {
  for (const k of new Set([...Object.keys(bj), ...Object.keys(hj)])) if (k !== 'games' && JSON.stringify(bj[k]) !== JSON.stringify(hj[k]))
    failures.push(`games.json: top-level \`${k}\` changed`);
  const ids = hj.games.map(g => g.id);
  if (new Set(ids).size !== ids.length) failures.push('games.json: duplicate game ids');
  for (const id of H.ids) if (!B.ids.has(id) && bj.games.some(g => g.id === id))
    failures.push(`new game \`${id}\` reuses the id of an existing game`);
  for (const id of B.ids) if (!H.ids.has(id) && bj.games.some(g => g.id === id))
    failures.push(`deletes published game \`${PREFIX}${id}/\` (removing a game is Nic's call)`);
  const others = j => j.games.filter(g => !myIds.has(g.id));
  const bo = others(bj), ho = others(hj);
  const bm = new Map(bo.map(g => [g.id, JSON.stringify(g)])), hm = new Map(ho.map(g => [g.id, JSON.stringify(g)]));
  for (const id of new Set([...bm.keys(), ...hm.keys()])) {
    if (!hm.has(id)) failures.push(`games.json: entry \`${id}\` removed`);
    else if (!bm.has(id)) failures.push(`games.json: entry \`${id}\` added (not a ${p} game)`);
    else if (bm.get(id) !== hm.get(id)) failures.push(`games.json: entry \`${id}\` changed (not a ${p} game)`);
  }
  if (bo.map(g => g.id).join() !== ho.map(g => g.id).join() && bm.size === hm.size) failures.push('games.json: other games reordered');
}

// 4. the BASE build.mjs, run over the head tree, must find nothing to rebuild
const tmpBuild = path.join(HEAD, 'partners', `.check-build-${process.pid}.mjs`);
fs.copyFileSync(path.join(BASE, 'partners', 'build.mjs'), tmpBuild);
let r;
try { r = spawnSync(process.execPath, [tmpBuild, p, '--check'], { cwd: HEAD, encoding: 'utf8' }); }
finally { fs.rmSync(tmpBuild, { force: true }); }
const buildOut = `${r.stdout || ''}${r.stderr || ''}`.trim().replaceAll(path.basename(tmpBuild), 'build.mjs');
if (r.status !== 0) failures.push(`\`node partners/build.mjs ${p} --check\` exit ${r.status} — rebuild and commit the outputs:\n\`\`\`\n${buildOut}\n\`\`\``);

// 5. warnings: risky things NEW in his changed text files (count in head > count in base)
const PATTERNS = [
  ['electronAPI', /electronAPI/g], ['ipcRenderer', /ipcRenderer/g], ['require(', /\brequire\s*\(/g],
  ['child_process', /child_process/g], ['process.', /\bprocess\./g], ['eval(', /\beval\s*\(/g], ['new Function', /\bnew\s+Function\b/g],
];
const HOST = /https?:\/\/([a-z0-9.-]+)/gi;
const KEY = /localStorage\s*(?:\.\s*(?:getItem|setItem|removeItem)\s*\(\s*|\[\s*)(['"`])([^'"`]+)\1/g;
const all = (s, re, g = 0) => [...s.matchAll(re)].map(m => m[g]);
const ownKey = k => [...myIds].some(id => k.startsWith(`gl_${id}_`));
for (const f of changed) {
  if (!f.startsWith(PREFIX) || !headFiles.has(f)) continue;
  const hb = read(HEAD, f);
  if (hb.subarray(0, 8000).includes(0)) continue;   // binary
  const h = hb.toString('utf8'), b = baseFiles.has(f) ? read(BASE, f).toString('utf8') : '';
  const baseLines = new Set(b.split(/\r?\n/));
  const added = h.split(/\r?\n/).map((t, i) => [i + 1, t]).filter(([, t]) => !baseLines.has(t));
  for (const [name, re] of PATTERNS) {
    const n = all(h, re).length - all(b, re).length;
    if (n <= 0) continue;
    const at = added.filter(([, t]) => t.match(re)).slice(0, 3).map(([ln, t]) => {
      const i = t.search(re);
      return `L${ln}: \`${t.slice(Math.max(0, i - 50), i + 70).trim().replaceAll('`', "'")}\``;
    });
    warnings.push(`\`${f}\`: ${n} new \`${name}\`${at.length ? ' — ' + at.join(' · ') : ''}`);
  }
  const bh = new Set(all(b, HOST, 1).map(s => s.toLowerCase()));
  for (const host of new Set(all(h, HOST, 1).map(s => s.toLowerCase()))) if (!bh.has(host) && host !== 'www.w3.org') warnings.push(`\`${f}\`: new host \`${host}\``);
  const bk = new Set(all(b, KEY, 2));
  for (const k of new Set(all(h, KEY, 2))) if (!bk.has(k) && !ownKey(k)) warnings.push(`\`${f}\`: new localStorage key \`${k}\``);
}

// ---- report
out(`### Partner check — \`${p}\` (author \`${opt.author}\`): ${failures.length ? 'FAIL' : 'PASS'}`);
out(`${changed.length} changed path(s); build: ${buildOut.split('\n').pop()}`);
if (failures.length) { out('\n**Failures**'); for (const f of failures) out(`- ${f}`); }
if (warnings.length) { out('\n**Warnings — for review, not failures**'); for (const w of warnings) out(`- ${w}`); }
out('\n<details><summary>Changed paths</summary>\n');
for (const f of changed) out(`- \`${f}\``);
out('\n</details>');
finish(failures.length ? 1 : 0);
