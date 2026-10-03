// Minimalist cover template for the partner onboarder (SKILL.md, step 5b).
//   import { minimalistCover } from '../../../onboarder/minimalist-cover.mjs';
//   fs.writeFileSync('covers/<id>.minimalist.svg', minimalistCover({ ... }));
// gameId, title    — the title is drawn upper-case in the top bar
// stops            — 2-3 hex colours, lightest first, darkest last
// angle            — gradient direction in degrees (0 = left→right, 90 = top→bottom)
// titleColor       — title + accent lines
// symbolSvg        — the drawn symbol (PREFERRED): ~300-340 px wide, y 500-810, centred on x 340
// symbolDefs       — <defs> content the symbol needs; prefix every id with a short game tag
// icon             — emoji fallback, only when it passes the specific/unique/solid tests
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r3 = v => Math.round(v * 1000) / 1000;

export function minimalistCover({ gameId, title, stops, angle, titleColor, symbolSvg, symbolDefs = '', icon }) {
  const T = title.toUpperCase(), n = [...T].length;
  const [fs, gap] = n <= 6 ? [76, 240] : n <= 8 ? [68, 220] : n <= 10 ? [60, 200]
    : n <= 12 ? [54, 180] : n <= 15 ? [44, 140] : [36, 80];
  const lw = Math.max(0, Math.floor((680 - 96 - gap) / 2)), rs = 48 + lw + gap;
  const decor = lw > 15
    ? `<rect x="48" y="100" width="${lw}" height="1.5" fill="${titleColor}" opacity="0.5"/>` +
      `<rect x="${rs}" y="100" width="${lw}" height="1.5" fill="${titleColor}" opacity="0.5"/>`
    : '';
  const a = angle * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a);
  const [x1, y1, x2, y2] = [0.5 - dx / 2, 0.5 - dy / 2, 0.5 + dx / 2, 0.5 + dy / 2].map(r3);
  const stopsXml = stops.map((c, i) => `<stop offset="${r3(i / (stops.length - 1))}" stop-color="${c}"/>`).join('');
  const gid = 'g' + gameId.replace(/[^A-Za-z0-9]/g, '');
  if (!symbolSvg) {
    if (!icon) throw new Error('minimalistCover needs a drawn symbolSvg or an emoji icon');
    symbolSvg = `<text x="340" y="660" text-anchor="middle" dominant-baseline="central" font-size="300">${icon}</text>`;
  }
  const t = esc(T);
  return `<svg width="400" height="600" viewBox="0 0 680 1020" xmlns="http://www.w3.org/2000/svg">
<defs>
<linearGradient id="${gid}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stopsXml}</linearGradient>
${symbolDefs}</defs>
<rect width="680" height="1020" fill="url(#${gid})"/>
<rect x="0" y="0" width="680" height="148" fill="rgba(0,0,0,0.34)"/>
<line x1="0" y1="148" x2="680" y2="148" stroke="${titleColor}" stroke-width="1.2"/>
${decor}
<text x="343" y="135" text-anchor="middle" font-family="'Arial Black','Impact',sans-serif"
      font-weight="900" font-size="${fs}" fill="rgba(0,0,0,0.45)" letter-spacing="4">${t}</text>
<text x="340" y="132" text-anchor="middle" font-family="'Arial Black','Impact',sans-serif"
      font-weight="900" font-size="${fs}" fill="${titleColor}" letter-spacing="4">${t}</text>
${symbolSvg}
<rect x="0" y="988" width="680" height="32" fill="rgba(0,0,0,0.34)"/>
<line x1="0" y1="988" x2="680" y2="988" stroke="${titleColor}" stroke-width="0.8" opacity="0.3"/>
</svg>
`;
}
