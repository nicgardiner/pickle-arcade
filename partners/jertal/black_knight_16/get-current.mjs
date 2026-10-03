// Downloads the Black Knight build the library ships today into ./work/ and checks its sha256.
//   node partners/jertal/black_knight_16/get-current.mjs
// Source of truth: entry.json "download" (url + sha256). A file already in work/ with the right hash is kept,
// so re-running costs nothing. work/ is gitignored — never commit the 90 MB build.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const entry = JSON.parse(fs.readFileSync(new URL('./entry.json', import.meta.url), 'utf8'));
const { url, sha256 } = entry.download;
const dir = new URL('./work/', import.meta.url);
const file = new URL(entry.fileName, dir);
const hash = buf => createHash('sha256').update(buf).digest('hex');

fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(file) && hash(fs.readFileSync(file)) === sha256) {
  console.log(`work/${entry.fileName} is already the current build (sha256 ok)`);
  process.exit(0);
}
console.log(`downloading ${url} …`);
const res = await fetch(url);
if (!res.ok) { console.error(`download failed: HTTP ${res.status}`); process.exit(1); }
const buf = Buffer.from(await res.arrayBuffer());
const got = hash(buf);
if (got !== sha256) { console.error(`sha256 mismatch: got ${got}, entry.json says ${sha256} — not saved`); process.exit(1); }
fs.writeFileSync(file, buf);
console.log(`saved work/${entry.fileName} (${(buf.length / 1048576).toFixed(1)} MB, sha256 ok)`);
