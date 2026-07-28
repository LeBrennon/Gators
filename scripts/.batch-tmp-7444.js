#!/usr/bin/env node
/*
 * Player Season Card — MOBILE BATTER VERSION (no horizontal scroll)
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
  "name": "Jay Michael Stelly",
  "num": "",
  "pos": "3B",
  "bt": "R/R",
  "cls": "Fr",
  "school": "Sulphur HS (LA)",
  "home": "Sulphur, LA",
  "htwt": "5-10 \u00b7 200",
  "bday": "\u2014",
  "photoSlug": "jaymichaelstelly1o33",
  "seasonTitle": "Season Totals \u2014 Hitting",
  "season": [
    [
      "G",
      "5"
    ],
    [
      "PA",
      "23"
    ],
    [
      "AVG",
      ".263"
    ],
    [
      "OBP",
      ".304"
    ],
    [
      "SLG",
      ".316"
    ],
    [
      "OPS",
      ".620"
    ],
    [
      "HR",
      "0"
    ],
    [
      "RBI",
      "5"
    ],
    [
      "SB",
      "2"
    ]
  ],
  "groups": [
    [
      "PRODUCTION",
      [
        [
          "AVG",
          ".263"
        ],
        [
          "OBP",
          ".304"
        ],
        [
          "SLG",
          ".316"
        ],
        [
          "OPS",
          ".620"
        ],
        [
          "ISO",
          ".053"
        ],
        [
          "BABIP",
          ".417"
        ],
        [
          "XBH",
          "1"
        ],
        [
          "TB",
          "6"
        ],
        [
          "vs LHP (3 PA)",
          "1.000/1.000/2.000",
          "wide",
          "AVG \u00b7 OBP \u00b7 SLG \u2014 OPS 3.000"
        ],
        [
          "vs RHP (14 PA)",
          ".083/.083/.083",
          "wide",
          "AVG \u00b7 OBP \u00b7 SLG \u2014 OPS .167"
        ]
      ],
      "OBP = on-base pct (H+BB+HBP per PA) \u00b7 SLG = total bases per AB \u00b7 OPS = OBP + SLG \u00b7 ISO = isolated power (SLG \u2212 AVG) \u00b7 BABIP = batting avg on balls in play \u00b7 XBH = extra-base hits \u00b7 TB = total bases"
    ],
    [
      "PLATE DISCIPLINE",
      [
        [
          "BB%",
          "4.3"
        ],
        [
          "K%",
          "30.4"
        ],
        [
          "BB:K",
          "0.14"
        ],
        [
          "PA",
          "23"
        ],
        [
          "BB",
          "1"
        ],
        [
          "K",
          "7"
        ],
        [
          "HBP",
          "1"
        ],
        [
          "SF",
          "0"
        ]
      ],
      "BB% = walks per PA \u00b7 K% = strikeouts per PA \u00b7 SF = sacrifice flies (not an AB)"
    ],
    [
      "HIT BREAKDOWN",
      [
        [
          "H",
          "5"
        ],
        [
          "1B",
          "4"
        ],
        [
          "2B",
          "1"
        ],
        [
          "3B",
          "0"
        ],
        [
          "HR",
          "0"
        ],
        [
          "RBI",
          "5"
        ],
        [
          "R",
          "5"
        ],
        [
          "GIDP",
          "0"
        ]
      ]
    ],
    [
      "BASE RUNNING",
      [
        [
          "SB",
          "2"
        ],
        [
          "CS",
          "0"
        ],
        [
          "SB%",
          "100.0"
        ],
        [
          "SB-ATT",
          "2-2"
        ]
      ],
      "SB% = stolen-base success (SB \u00f7 attempts)"
    ]
  ],
  "key": [],
  "logTitle": "Game by Game \u2014 Hitting",
  "logCols": [
    "Date",
    "Opp",
    "Res",
    "PA",
    "AB",
    "R",
    "H",
    "RBI",
    "BB",
    "K",
    "SB",
    "AVG"
  ],
  "log": [
    [
      "7/19",
      "vs BV",
      "W 14-11",
      "4",
      "1",
      "2",
      "1",
      "2",
      "1",
      "0",
      "0",
      "1.000"
    ],
    [
      "7/21",
      "at VIC",
      "W 12-7",
      "5",
      "4",
      "1",
      "0",
      "0",
      "0",
      "2",
      "1",
      ".000"
    ],
    [
      "7/24",
      "vs SHE",
      "W 6-2",
      "4",
      "4",
      "0",
      "0",
      "0",
      "0",
      "2",
      "0",
      ".000"
    ],
    [
      "7/25",
      "vs ABI",
      "W 21-12",
      "5",
      "5",
      "2",
      "3",
      "2",
      "0",
      "1",
      "1",
      ".600"
    ],
    [
      "7/26",
      "vs ABI",
      "W 5-4",
      "5",
      "5",
      "0",
      "1",
      "1",
      "0",
      "2",
      "0",
      ".200"
    ]
  ],
  "totals": [
    "TOTAL",
    "5 G",
    "",
    "23",
    "19",
    "5",
    "5",
    "5",
    "1",
    "7",
    "2",
    ".263"
  ]
};;;
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
const croc = b64('scripts/assets/croc-band.jpg', 'image/jpeg');
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
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; color: #020200; background: #f4f2ec; }
.wrap { width: 100%; max-width: 100%; margin: 0 auto; padding: 12px 12px 24px; }

/* Header band */
.band { position: relative; height: 90px; overflow: hidden; border-radius: 20px; border: 2px solid #ecc913; margin-bottom: 16px; }
.band img.texture { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 35%; }
.band .shade { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(22,16,43,.45); }
.band .inner { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; padding: 0 10px; }
.band img.mark { width: 64px; height: 64px; object-fit: contain; margin-right: 10px; }
.band .org { font-family: Georgia, serif; font-weight: 800; font-size: 13.5px; color: #ffd633; letter-spacing: .5px; white-space: nowrap; }
.band .sub { font-size: 9px; color: #cfc6ea; letter-spacing: 1.5px; text-transform: uppercase; margin-top: 3px; }

/* Identity */
.id { display: flex; gap: 12px; margin-bottom: 16px; align-items: flex-start; }
.id .ph { width: 90px; height: 90px; border-radius: 10px; object-fit: cover; object-position: center 15%; border: 3px solid #ecc913; background: #ddd; flex-shrink: 0; }
.id .who { flex: 1; min-width: 0; }
.id h1 { font-family: Georgia, serif; font-size: 22px; font-weight: 800; color: #4e3191; line-height: 1.1; margin-bottom: 3px; }
.id .role { font-size: 12px; font-weight: 700; color: #714ad2; letter-spacing: 1px; margin-bottom: 8px; }
.meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
.meta div { font-size: 11px; color: #714ad2; line-height: 1.3; }
.meta b { color: #4e3191; font-size: 8px; text-transform: uppercase; letter-spacing: .5px; display: block; margin-bottom: 1px; }

/* Season strip - wraps naturally, no horizontal scroll */
.striptitle { margin: 0 0 6px; font-size: 10px; font-weight: 700; letter-spacing: 1.8px; color: #714ad2; text-transform: uppercase; }
.strip { background: #231745; border-radius: 18px; padding: 10px 6px; display: grid; grid-template-columns: repeat(${stripCols}, 1fr); gap: 8px 4px; border: 2px solid #ecc913; }
.strip .stat { text-align: center; min-width: 48px; }
.strip .sv { font-family: Georgia, serif; font-size: 20px; font-weight: 800; color: #ecc913; }
.strip .sl { font-size: 8px; color: #fcef9d; letter-spacing: .8px; margin-top: 2px; text-transform: uppercase; }

/* Key */
.keytitle { margin: 10px 0 4px; font-size: 8px; font-weight: 800; letter-spacing: 1.5px; color: #714ad2; text-transform: uppercase; }
.key { font-size: 10px; color: #714ad2; line-height: 1.4; margin-bottom: 12px; }
.key .ki { white-space: nowrap; }
.key .ki b { color: #4e3191; letter-spacing: .3px; }
.key .ksep { color: #fcef9d; margin: 0 3px; font-weight: 800; }

/* Panels */
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
.panel { background: #fff; border-radius: 16px; padding: 10px; border: 1px solid #fcef9d; }
.ptitle { font-size: 9px; font-weight: 800; letter-spacing: 1.4px; color: #4e3191; border-bottom: 1.5px solid #ecc913; padding-bottom: 4px; margin-bottom: 6px; }
.pleg { font-size: 7.5px; line-height: 1.6; color: #4e3191; margin: -3px 0 7px; }
.ld { white-space: nowrap; }
.lsep { color: #ecc913; margin-right: 3px; }
.sg { display: flex; flex-direction: column; gap: 4px; }
.sr { display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 2px 0; border-bottom: 1px solid #f4f2ec; }
.sr:last-child { border-bottom: none; }
.sr.w { grid-column: 1 / -1; }
.sl2 { color: #714ad2; font-weight: 700; letter-spacing: .3px; font-size: 10px; }
.sv2 { color: #020200; font-weight: 800; font-variant-numeric: tabular-nums; font-size: 13px; }
.sv2sub { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.15; }
.svsub { font-size: 8px; color: #714ad2; font-weight: 700; letter-spacing: .6px; margin-top: 1px; }

/* Game log - card layout, no table, no horizontal scroll */
h2 { font-family: Georgia, serif; font-size: 15px; color: #4e3191; border-bottom: 2px solid #ecc913; padding-bottom: 4px; margin-bottom: 8px; }
.glog { display: flex; flex-direction: column; gap: 6px; }
.gcard { background: #fff; border-radius: 14px; padding: 8px 10px; border: 1px solid #fcef9d; }
.gcard-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; padding-bottom: 4px; border-bottom: 1px solid #fcef9d; }
.gcard-date { font-size: 12px; font-weight: 800; color: #4e3191; }
.gcard-opp { font-size: 11px; color: #714ad2; }
.gcard-res { font-size: 12px; font-weight: 800; color: #4e3191; }
.gcard-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 6px; }
.gcard-stat { text-align: center; }
.gcard-stat .gv { font-size: 15px; font-weight: 800; color: #020200; font-variant-numeric: tabular-nums; }
.gcard-stat .gl { font-size: 8.5px; color: #714ad2; text-transform: uppercase; letter-spacing: .5px; }

/* Totals card */
.totcard { background: #16102b; border-radius: 14px; padding: 10px; margin-top: 6px; border: 2px solid #ecc913; }
.totcard-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,.15); }
.totcard-header .tlabel { font-size: 13px; font-weight: 800; color: #ecc913; }
.totcard-header .trec { font-size: 12px; font-weight: 800; color: #ecc913; }
.totcard-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 6px; }
.totcard-stat { text-align: center; }
.totcard-stat .tv { font-size: 14px; font-weight: 800; color: #ecc913; font-variant-numeric: tabular-nums; }
.totcard-stat .tl { font-size: 8px; color: #fcef9d; text-transform: uppercase; letter-spacing: .5px; }

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
  <img class="texture" src="${croc}" alt="">
  <div class="shade"></div>
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
    <h1 style="font-size: ${Math.round(22 * Math.min(1, 16 / DATA.name.length) * 10) / 10}px; white-space: nowrap;">${esc(DATA.name.toUpperCase())}</h1>
    <div class="role">#${esc(DATA.num)} &middot; ${esc(DATA.pos)} &middot; B/T: ${esc(DATA.bt)}</div>
    <div class="meta">${[['Class', DATA.cls], ['School', DATA.school], ['Hometown', DATA.home], ['Ht / Wt', DATA.htwt], ['Born', DATA.bday]]
      .filter(([, v]) => v && String(v).trim() !== '' && String(v).trim() !== '—' && String(v).trim().toUpperCase() !== 'N/A')
      .map(([k, v]) => `<div><b>${k}</b>${esc(v)}</div>`).join('')}
    </div>
  </div>
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
