// Cover helper for the partner onboarder. Needs only the repo's own Electron (npm install).
//   npx electron partners/onboarder/cover-tool.cjs wrap <image.png|jpg|webp> <out.svg>
//     crops the image to 2:3, encodes it as a 1080x1620 WebP and wraps it in a launcher-ready SVG
//   npx electron partners/onboarder/cover-tool.cjs shot <cover.svg> <out.png>
//     renders the cover at 400x600 and at card size 150x225 side by side, so you can look at it;
//     exits 1 if the SVG doesn't render (invalid XML shows as a blank card in the launcher)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [cmd, inp, out] = process.argv.slice(process.argv.findIndex(a => a.endsWith('cover-tool.cjs')) + 1);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

// runs in the page: returns a data: URL, or throws if the image doesn't decode
const PAGE = {
  wrap: `async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const W = 1080, H = 1620, c = document.createElement('canvas'); c.width = W; c.height = H;
    const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    c.getContext('2d').drawImage(img, (W - img.naturalWidth * s) / 2, (H - img.naturalHeight * s) / 2,
      img.naturalWidth * s, img.naturalHeight * s);
    return c.toDataURL('image/webp', 0.9);
  }`,
  shot: `async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    if (!img.naturalWidth) throw new Error('SVG did not render');
    const c = document.createElement('canvas'); c.width = 590; c.height = 640;
    const g = c.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, 590, 640);
    g.drawImage(img, 20, 20, 400, 600); g.drawImage(img, 430, 20, 150, 225);
    return c.toDataURL('image/png');
  }`,
};

if (!PAGE[cmd] || !inp || !out) {
  console.error('usage: npx electron partners/onboarder/cover-tool.cjs wrap|shot <in> <out>');
  process.exit(2);
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    const mime = MIME[path.extname(inp).toLowerCase()];
    if (!mime) throw new Error('unsupported input type: ' + inp);
    const src = `data:${mime};base64,` + fs.readFileSync(inp).toString('base64');
    const win = new BrowserWindow({ show: false });
    await win.loadURL('data:text/html,<body></body>');
    const url = await win.webContents.executeJavaScript(`(${PAGE[cmd]})(${JSON.stringify(src)})`);
    const b64 = url.slice(url.indexOf(',') + 1);
    if (cmd === 'wrap') {
      fs.writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 680 1020">\n` +
        `<image href="data:image/webp;base64,${b64}" x="0" y="0" width="680" height="1020" preserveAspectRatio="xMidYMid slice"/>\n</svg>\n`);
    } else {
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    }
    console.log('wrote ' + out);
  } catch (e) {
    console.error('cover-tool: ' + ((e && e.message) || 'image did not decode (for an SVG: invalid XML?)'));
    code = 1;
  }
  app.exit(code);
});
