# Black Knight — how updates work (it's different)

Black Knight is an **external** game (`"external": true` in `entry.json`). Its build is ~90 MB, too big for git, so
there is no `source/` and no `patch.mjs` here, and the repo never contains the HTML. The launcher downloads the file
from a GitHub release asset on first play and checks it against the sha256 in `entry.json`; the website build does
the same when it bundles it. The asset ships exactly as you built it — the library adds no integration layer.

This folder holds only what IS in git: `entry.json` (its games.json entry), `covers/`, this README, `DEVLOG.md`,
`get-current.mjs`, and `SUBMISSION.json` when you send a new build.

## Sending a new build

1. Get the build the library ships today, if you want to start from it:
   ```
   node partners/jertal/black_knight_16/get-current.mjs
   ```
   It downloads `entry.json`'s `download.url` into `work/black_knight_16.html` and checks the sha256.
   `work/` is gitignored — edit or rebuild there freely.
2. Host your new build as a **release asset on your own GitHub repo** (any repo of yours; a release with the
   `.html` attached). Copy the asset's download URL.
3. Hash it: `node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('work/black_knight_16.html')).digest('hex'))"`
   (from this folder), or `certutil -hashfile work\black_knight_16.html SHA256` on Windows.
4. Write `SUBMISSION.json` here:
   ```json
   {
     "url": "https://github.com/<you>/<repo>/releases/download/<tag>/black_knight_16.html",
     "sha256": "<64 hex chars>",
     "notes": "what changed in this build"
   }
   ```
5. Open the PR as usual (`[jertal] Update Black Knight`). Do **not** edit `download` in `entry.json` yourself —
   it must keep pointing at the copy Nic hosts.

## What Nic does with it

Downloads your asset, verifies the sha256, plays it, then re-hosts it on the pickle-arcade releases as
`game-black-knight-vN` (N = next version) and updates `download.url`, `download.sha256` (and `installSizeMB`) in
`entry.json`, then runs `node partners/build.mjs jertal black_knight_16` and deletes `SUBMISSION.json`. The website
picks it up on the next deploy; installed launchers get the new games.json with the next launcher release, notice the
changed sha256 and re-download the game.

## Stats and achievements

The library can only track what the game itself reports through `window.GameSDK` (feature-check it — it is undefined
when the file is opened on its own). Ids must be declared in `entry.json`'s `stats` / `achievements`. The verifier
(`npm test`) can't read an external file, so double-check the ids by hand.
