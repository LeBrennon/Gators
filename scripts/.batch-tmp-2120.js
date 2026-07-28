#!/usr/bin/env node
/*
 * Player Season Card — MOBILE VERSION (no horizontal scroll)
 * Same DATA block as player-season-card.js. Renders a responsive HTML page
 * plus a shareable PNG screenshot. Everything fits within phone width.
 *
 *   node scripts/player-season-card-mobile.js              # -> reports/players-mobile/
 *   node scripts/player-season-card-mobile.js /path/stem   # custom output stem
 *
 * Outputs: <stem>.html  (responsive web page)
 *          <stem>.png   (1080x1920 screenshot for sharing)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const stemArg = process.argv.slice(2).find(a => a && !a.startsWith('--'));

// ===========================================================================
// PLAYER DATA — copy this block from player-season-card.js for each player
// ===========================================================================
const DATA = {
  "name": "Brayden Guillory",
  "num": "47",
  "pos": "P",
  "bt": "R/R",
  "cls": "R-Fr",
  "school": "Southern",
  "home": "Kinder, TX",
  "htwt": "6-2 \u00b7 200",
  "bday": "\u2014",
  "photoSlug": "braydenguillory",
  "seasonTitle": "Season Totals \u2014 Pitching",
  "season": [
    [
      "APP",
      "7"
    ],
    [
      "GS",
      "0"
    ],
    [
      "W",
      "0"
    ],
    [
      "L",
      "0"
    ],
    [
      "SV",
      "0"
    ],
    [
      "ERA",
      "14.73"
    ],
    [
      "WHIP",
      "2.27"
    ],
    [
      "K",
      "3"
    ],
    [
      "BB",
      "9"
    ]
  ],
  "groups": [
    [
      "RUN PREVENTION",
      [
        [
          "ERA",
          "14.73"
        ],
        [
          "WHIP",
          "2.27"
        ],
        [
          "FIP",
          "8.83"
        ],
        [
          "BABIP",
          ".302"
        ],
        [
          "AVG",
          ".333"
        ],
        [
          "OBP",
          ".426"
        ],
        [
          "SLG",
          ".562"
        ],
        [
          "OPS",
          ".989"
        ]
      ],
      "FIP = fielding-independent pitching (HR, BB, K) \u00b7 BABIP = avg on balls in play \u00b7 WHIP = walks + hits per IP \u00b7 ERA = earned runs per 9 IP"
    ],
    [
      "COMMAND & RATES",
      [
        [
          "K%",
          "4.9"
        ],
        [
          "BB%",
          "14.8"
        ],
        [
          "K:BB",
          "0.33"
        ],
        [
          "K/9",
          "2.45"
        ],
        [
          "BB/9",
          "7.36"
        ],
        [
          "H/9",
          "13.09"
        ],
        [
          "HR/9",
          "2.45"
        ],
        [
          "P/IP",
          "19.3"
        ]
      ],
      "K% = strikeouts per batter faced \u00b7 BB% = walks per batter faced \u00b7 P/IP = pitches per inning"
    ],
    [
      "HITTERS AGAINST",
      [
        [
          "BF",
          "61"
        ],
        [
          "AB",
          "48"
        ],
        [
          "H",
          "16"
        ],
        [
          "2B",
          "2"
        ],
        [
          "3B",
          "0"
        ],
        [
          "HR",
          "3"
        ],
        [
          "HBP",
          "1"
        ],
        [
          "SF",
          "1"
        ],
        [
          "Total (60 PA)",
          ".333/.426/.562",
          "wide",
          "AVG \u00b7 OBP \u00b7 SLG"
        ],
        [
          "vs LHB (21 PA)",
          ".222/.333/.444",
          "wide",
          "AVG \u00b7 OBP \u00b7 SLG"
        ],
        [
          "vs RHB (39 PA)",
          ".400/.500/.633",
          "wide",
          "AVG \u00b7 OBP \u00b7 SLG"
        ]
      ],
      "BF = batters faced"
    ],
    [
      "WORKLOAD",
      [
        [
          "APP",
          "7"
        ],
        [
          "IP",
          "11"
        ],
        [
          "IP/APP",
          "1.6"
        ],
        [
          "BF",
          "61"
        ],
        [
          "R",
          "19"
        ],
        [
          "ER",
          "18"
        ],
        [
          "#P",
          "212"
        ],
        [
          "W-L",
          "0-0"
        ]
      ],
      "IP/APP = innings per appearance \u00b7 #P = total pitches"
    ]
  ],
  "key": [],
  "logTitle": "Game by Game \u2014 Pitching",
  "logCols": [
    "Date",
    "Opp",
    "Res",
    "IP",
    "BF",
    "H",
    "R",
    "ER",
    "BB",
    "K",
    "#P",
    "S%",
    "ERA"
  ],
  "log": [
    [
      "7/1",
      "at BV",
      "W 10-8",
      "3.1",
      "12",
      "1",
      "2",
      "2",
      "1",
      "3",
      "41",
      "41%",
      "5.40"
    ],
    [
      "7/7",
      "at ACA",
      "L 7-4",
      "0.2",
      "4",
      "1",
      "0",
      "0",
      "1",
      "0",
      "14",
      "43%",
      "0.00"
    ],
    [
      "7/12",
      "at SA",
      "L 8-4",
      "3.1",
      "16",
      "5",
      "5",
      "5",
      "1",
      "0",
      "56",
      "63%",
      "13.50"
    ],
    [
      "7/15",
      "at BR",
      "L 9-2",
      "1.2",
      "9",
      "3",
      "5",
      "4",
      "1",
      "0",
      "41",
      "54%",
      "21.60"
    ],
    [
      "7/19",
      "vs BV",
      "W 14-11",
      "0.2",
      "7",
      "3",
      "5",
      "5",
      "2",
      "0",
      "23",
      "57%",
      "67.50"
    ],
    [
      "7/23",
      "vs SHE",
      "W 8-7",
      "1.0",
      "6",
      "2",
      "2",
      "2",
      "1",
      "0",
      "21",
      "52%",
      "18.00"
    ],
    [
      "7/26",
      "vs ABI",
      "W 5-4",
      "0.1",
      "4",
      "1",
      "0",
      "0",
      "2",
      "0",
      "16",
      "44%",
      "0.00"
    ]
  ],
  "totals": [
    "TOTAL",
    "7 APP",
    "",
    "11",
    "58",
    "16",
    "19",
    "18",
    "9",
    "3",
    "212",
    "53%",
    "14.73"
  ]
};
// ===========================================================================
// GENERIC RENDERING — do not edit below this line
// ===========================================================================
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports', 'players-mobile');
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function b64(file, mime) {
  try { return 'data:' + mime + ';base64,' + fs.readFileSync(path.join(ROOT, file)).toString('base64'); }
  catch (e) { return ''; }
}
function findPhoto(slug) {
  for (const ext of ['webp', 'jpg', 'jpeg', 'png', 'avif']) {
    const p = 'photos/' + slug + '.' + ext;
    if (fs.existsSync(path.join(ROOT, p))) return b64(p, ext === 'jpg' ? 'image/jpeg' : 'image/' + ext);
  }
  return '';
}
function findChromium() {
  const cands = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', process.env.HOME + '/.cache/ms-playwright'].filter(Boolean)) {
    try { for (const d of fs.readdirSync(base)) { const p = path.join(base, d, 'chrome-linux', 'chrome'); if (fs.existsSync(p)) return p; } } catch (e) {}
  }
  throw new Error('No Chromium found. Set CHROMIUM_PATH.');
}

const logo = b64('gg-logo.png', 'image/png');
const tcl = b64('scripts/assets/tcl-logo-transparent.png', 'image/png');
const fPop7 = b64('scripts/assets/fonts/poppins-700.ttf', 'font/ttf');
const fPop8 = b64('scripts/assets/fonts/poppins-800.ttf', 'font/ttf');
const fLek = b64('scripts/assets/fonts/leckerli-one-400.ttf', 'font/ttf');
const croc = b64('scripts/assets/croc-band.jpg', 'image/jpeg');
const crocDark = b64('scripts/assets/croc-tile.jpg', 'image/jpeg');
const photo = findPhoto(DATA.photoSlug || (DATA.name || '').toLowerCase().replace(/[^a-z]/g, ''));

const seasonArr = DATA.season.filter(([k, v]) => !(k === 'GS' && String(v) === '0'));
const stripCols = Math.min(5, Math.ceil(seasonArr.length / Math.ceil(seasonArr.length / 5)));
const seasonTiles = seasonArr.map(([k, v]) =>
  `<div class="stat"><div class="sv">${esc(v)}</div><div class="sl">${esc(k)}</div></div>`).join('');

const keyRow = (DATA.key || []).length
  ? `<div class="keytitle">Advanced Metrics Key</div><div class="key">` +
    DATA.key.map(([a, m]) => `<span class="ki"><b>${esc(a)}</b> ${esc(m)}</span>`).join('<span class="ksep">&middot;</span> ') +
    `</div>` : '';

const panels = (DATA.groups || []).map(([title, rows, legend]) =>
  `<div class="panel"><div class="ptitle">${esc(title)}</div>${legend ? `<div class="pleg">` + legend.split(' \u00b7 ').map(d => `<span class="ld">${esc(d)}</span>`).join('<span class="lsep">\u00b7</span> ') + `</div>` : ''}<div class="sg">` +
  rows.map(([l, v, w, sub]) =>
    `<div class="sr${w === 'wide' ? ' w' : ''}"><span class="sl2">${esc(l)}</span>` +
    (sub
      ? `<span class="sv2sub"><span class="sv2">${esc(v)}</span><span class="svsub">${esc(sub)}</span></span>`
      : `<span class="sv2">${esc(v)}</span>`) +
    `</div>`).join('') +
  `</div></div>`).join('');

const evenCols = n => (n % 5 === 0 ? 5 : n % 4 === 0 ? 4 : n % 3 === 0 ? 3 : 4);
const gameLogCards = DATA.log.map(r => {
  const date = esc(r[0]), opp = esc(r[1]), res = esc(r[2]);
  const stats = r.slice(3);
  const labels = DATA.logCols.slice(3);
  const statCells = stats.map((v, i) => 
    `<div class="gcard-stat"><div class="gv">${esc(v)}</div><div class="gl">${esc(labels[i])}</div></div>`
  ).join('');
  return `<div class="gcard">
    <div class="gcard-header">
      <div><span class="gcard-date">${date}</span> <span class="gcard-opp">${opp}</span></div>
      <div class="gcard-res">${res}</div>
    </div>
    <div class="gcard-stats" style="grid-template-columns: repeat(${evenCols(stats.length)}, 1fr);">${statCells}</div>
  </div>`;
}).join('');

const totArr = DATA.totals.slice(2);
const totStats = totArr.map((v, i) => 
  `<div class="totcard-stat"><div class="tv">${esc(v)}</div><div class="tl">${esc(DATA.logCols[i+2])}</div></div>`
).join('');

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>${esc(DATA.name)} — 2026 Summer Stats</title>
<style>
@font-face { font-family: 'Poppins'; font-weight: 700; src: url(data:font/ttf;base64,${fPop7}) format('truetype'); }
@font-face { font-family: 'Poppins'; font-weight: 800; src: url(data:font/ttf;base64,${fPop8}) format('truetype'); }
@font-face { font-family: 'Leckerli One'; font-weight: 400; src: url(data:font/ttf;base64,${fLek}) format('truetype'); }
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
html { background-color: #16102b; min-height: 100vh; }
body { position: relative; margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; color: #020200; background-color: #16102b; min-height: 100vh; }
.wrap { width: 100%; max-width: 100%; margin: 0 auto; padding: 12px 12px 24px; }

/* Header band */
.band { position: relative; height: 90px; overflow: hidden; border-radius: 20px; border: 2px solid #ecc913; margin-bottom: 16px; background: linear-gradient(rgba(22,16,43,.42), rgba(22,16,43,.42)), url(${croc}) center 35% / cover no-repeat #241a4e; }
.band img.texture { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 35%; }
.band .shade { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(22,16,43,.45); }
.band .inner { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; padding: 0 10px; }
.band img.mark { width: 64px; height: 64px; object-fit: contain; margin-right: 10px; }
.band .org { font-family: 'Poppins', Georgia, serif; font-weight: 800; font-size: 13px; color: #ffd633; letter-spacing: .5px; white-space: nowrap; }
.band .sub { font-family: 'Poppins', Georgia, serif; font-size: 7.5px; font-weight: 700; color: #f0ede4; letter-spacing: 1px; text-transform: uppercase; margin-top: 5px; white-space: nowrap; }

/* Identity */
.id { display: flex; gap: 12px; margin-bottom: 16px; align-items: center; }
.id .who { flex: 1; text-align: center; }
.id .tclid { height: 82px; width: auto; align-self: center; margin-left: 14px; margin-right: 10px; flex-shrink: 0; background: #fff; border-radius: 10px; padding: 6px; box-sizing: content-box; }
.id .ph { margin-left: 10px; width: 90px; height: 90px; border-radius: 10px; object-fit: cover; object-position: center 15%; border: 3px solid #ecc913; background: #ddd; flex-shrink: 0; }
.id .who { flex: 1; min-width: 0; }
.id h1 { font-family: 'Poppins', Georgia, serif; font-size: 22px; font-weight: 800; color: #f0ede4; line-height: 1.1; margin-bottom: 3px; }
.id .role { font-size: 12px; font-weight: 700; color: #ecc913; letter-spacing: 1px; margin-bottom: 8px; }
.meta { display: grid; grid-template-columns: auto auto; gap: 4px 22px; justify-content: center; text-align: left; }
.meta div { font-size: 11px; color: #f0ede4; line-height: 1.3; }
.meta b { color: #9a8cc4; font-size: 8px; text-transform: uppercase; letter-spacing: .5px; display: block; margin-bottom: 1px; }

/* Season strip - wraps naturally, no horizontal scroll */
.striptitle { font-family: 'Poppins', Georgia, serif; margin: 0 0 6px; font-size: 10px; font-weight: 700; letter-spacing: 1.8px; color: #b9a6ee; text-transform: uppercase; }
.strip { background: linear-gradient(rgba(22,16,43,.45), rgba(22,16,43,.45)), url(${croc}) center 35% / cover no-repeat #33205e; border-radius: 18px; padding: 10px 6px; display: grid; grid-template-columns: repeat(${stripCols}, 1fr); gap: 8px 4px; border: 2px solid #ecc913; }
.strip .stat { text-align: center; min-width: 48px; }
.strip .sv { font-family: Georgia, serif; font-size: 20px; font-weight: 800; color: #ecc913; }
.strip .sl { font-size: 8px; color: #e5e0f0; letter-spacing: .8px; margin-top: 2px; text-transform: uppercase; }

/* Key */
.keytitle { font-family: 'Poppins', Georgia, serif; margin: 10px 0 4px; font-size: 8px; font-weight: 800; letter-spacing: 1.5px; color: #33205e; text-transform: uppercase; }
.key { font-size: 10px; color: #33205e; line-height: 1.4; margin-bottom: 12px; }
.key .ki { white-space: nowrap; }
.key .ki b { color: #33205e; letter-spacing: .3px; }
.key .ksep { color: #e5e0f0; margin: 0 3px; font-weight: 800; }

/* Panels */
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
.panel { background: #1e1640; border-radius: 14px; padding: 10px; border: 1px solid #41327a; }
.ptitle { font-family: 'Poppins', Georgia, serif; font-size: 9px; font-weight: 800; letter-spacing: 1.4px; color: #ecc913; border-bottom: 1.5px solid #ecc913; padding-bottom: 4px; margin-bottom: 6px; }
.pleg { font-size: 8.5px; line-height: 1.6; color: #9a8cc4; margin: -3px 0 7px; }
.ld { white-space: nowrap; }
.lsep { color: #ecc913; margin-right: 3px; }
.sg { display: flex; flex-direction: column; gap: 4px; }
.sr { display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 2px 0; border-bottom: 1px solid rgba(65,50,122,.55); }
.sr:last-child { border-bottom: none; }
.sr.w { grid-column: 1 / -1; }
.sl2 { color: #9a8cc4; font-weight: 700; letter-spacing: .3px; font-size: 10px; }
.sv2 { color: #f0ede4; font-weight: 800; font-variant-numeric: tabular-nums; font-size: 13px; }
.sv2sub { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.15; }
.svsub { font-size: 8px; color: #9a8cc4; font-weight: 700; letter-spacing: .6px; margin-top: 1px; }

/* Game log - card layout, no table, no horizontal scroll */
h2 { font-family: 'Poppins', Georgia, serif; font-size: 15px; color: #b9a6ee; border-bottom: 2px solid #ecc913; padding-bottom: 4px; margin-bottom: 8px; }
.glog { display: flex; flex-direction: column; gap: 6px; }
.gcard { background: #1e1640; border-radius: 14px; padding: 8px 10px; border: 1px solid #41327a; }
.gcard-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; padding-bottom: 4px; border-bottom: 1px solid rgba(65,50,122,.55); }
.gcard-date { font-size: 12px; font-weight: 800; color: #ecc913; }
.gcard-opp { font-size: 11px; color: #b9a6ee; }
.gcard-res { font-size: 12px; font-weight: 800; color: #ecc913; }
.gcard-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 6px; }
.gcard-stat { text-align: center; }
.gcard-stat .gv { font-size: 15px; font-weight: 800; color: #f0ede4; font-variant-numeric: tabular-nums; }
.gcard-stat .gl { font-size: 8.5px; color: #9a8cc4; text-transform: uppercase; letter-spacing: .5px; }

/* Totals card */
.totcard { background: linear-gradient(rgba(22,16,43,.45), rgba(22,16,43,.45)), url(${croc}) center 35% / cover no-repeat #33205e; border-radius: 14px; padding: 10px; margin-top: 6px; border: 2px solid #ecc913; }
.totcard-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,.15); }
.totcard-header .tlabel { font-size: 13px; font-weight: 800; color: #ecc913; }
.totcard-header .trec { font-size: 12px; font-weight: 800; color: #ecc913; }
.totcard-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 6px; }
.totcard-stat { text-align: center; }
.totcard-stat .tv { font-size: 14px; font-weight: 800; color: #ecc913; font-variant-numeric: tabular-nums; }
.totcard-stat .tl { font-size: 8px; color: #e5e0f0; text-transform: uppercase; letter-spacing: .5px; }

/* Responsive */
@media (max-width: 380px) {
  .id { flex-direction: column; align-items: center; text-align: center; }
  .id .ph { width: 100px; height: 100px; }
  .meta { text-align: left; width: 100%; }
  .grid { grid-template-columns: 1fr; }
  .band .org { font-size: 11.5px; }
  .band img.mark { width: 52px; height: 52px; }
  .gcard-stats { grid-template-columns: repeat(3, 1fr); }
  .totcard-stats { grid-template-columns: repeat(3, 1fr); }
}
</style></head>
<body><div class="wrap">
<div class="band">
  <div class="inner">
    <img class="mark" src="${logo}" alt="">
    <div>
      <div class="org">LAKE CHARLES GUMBEAUX GATORS</div>
      <div class="sub">2026 Summer Season &middot; Texas Collegiate League</div>
    </div>
  </div>
</div>
<div class="id">
  <img class="ph" src="${photo}" alt="">
  <div class="who">
    <h1>${esc(DATA.name.toUpperCase())}</h1>
    <div class="role">#${esc(DATA.num)} &middot; ${esc(DATA.pos)} &middot; B/T: ${esc(DATA.bt)}</div>
    <div class="meta">${[['Class', DATA.cls], ['School', DATA.school], ['Hometown', DATA.home], ['Ht / Wt', DATA.htwt], ['Born', DATA.bday]]
      .filter(([, v]) => v && String(v).trim() !== '' && String(v).trim() !== '—' && String(v).trim().toUpperCase() !== 'N/A')
      .map(([k, v]) => `<div><b>${k}</b>${esc(v)}</div>`).join('')}
    </div>
  </div>
  <img class="tclid" src="${tcl}" alt="">
</div>
<div class="striptitle">${esc(DATA.seasonTitle)}</div>
<div class="strip">${seasonTiles}</div>
${keyRow}
<div class="grid">${panels}</div>
<h2>${esc(DATA.logTitle)}</h2>
<div class="glog">
${gameLogCards}
  <div class="totcard">
    <div class="totcard-header">
      <span class="tlabel">${esc(DATA.totals[0])}</span>
      <span class="trec">${esc(DATA.totals[1])}</span>
    </div>
    <div class="totcard-stats" style="grid-template-columns: repeat(${evenCols(totArr.length)}, 1fr);">${totStats}</div>
  </div>
</div>
</div></body></html>`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const stem = stemArg || path.join(OUT_DIR, DATA.name + ' - 2026 Summer Stats (Mobile)');
const tmp = path.join(require('os').tmpdir(), 'player-season-card-mobile-' + Date.now() + '.html');
fs.writeFileSync(tmp, html);

const outHtml = stem + '.html';
fs.copyFileSync(tmp, outHtml);

try { fs.unlinkSync(tmp); } catch (e) {}
console.log('wrote ' + outHtml);
