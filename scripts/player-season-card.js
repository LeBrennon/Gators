#!/usr/bin/env node
/*
 * Player Season Card — renders a one-page, letter-size, branded PDF of one
 * player's summer: identity block, season-totals strip, four advanced-stat
 * panels (Savant-style: run prevention, command & rates, hitters-against,
 * pitch profile), and a game-by-game table with totals + column labels.
 * Club branding per docs/HANDOFF.md: croc-skin bands (hue-locked to the
 * #4e3191 family via scripts/assets/croc-band.jpg), gold border, purples
 * #4e3191 dark / #714ad2 accent, gold #ecc913/#ffd633.
 *
 * This is a hand-fed renderer: fill in the DATA block below for the player
 * and run it. Everything below DATA is generic — do not edit it per player.
 * Counting stats come from the official box scores; advanced metrics
 * (BF, K%/BB%, AVG/OBP/SLG/OPS against, BABIP, extra-base hits allowed,
 * FPS%, SwStr%, GB/FB/LD/PU) are computed from TCL play-by-play text.
 * FIP uses the FanGraphs formula ((13*HR + 3*(BB+HBP) - 2*K)/IP + 3.10).
 *
 *   node scripts/player-season-card.js                 # -> reports/players/
 *   node scripts/player-season-card.js /path/stem      # custom output stem
 *
 * Photo: drops in photos/<photoSlug>.<ext> automatically (photoSlug defaults
 * to the player's slug). Layout is a fixed single letter page — it never
 * spills to a second page (tested with a 10-tile strip, 4 panels x 8 stats,
 * and a 13-column log; keep roughly to that budget).
 *
 * Requires Chromium (CHROMIUM_PATH, /opt/pw-browsers, a Playwright install,
 * or Mac Chrome). No other dependencies.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const stemArg = process.argv.slice(2).find(a => a && !a.startsWith('--'));

// ===========================================================================
// PLAYER DATA — replace this block for each player. Everything below is generic.
// (Values shown are Brayden Guillory's 2026 summer: counting stats from the
// official TCL box scores, advanced metrics computed from play-by-play text
// because his Presto player page is an all-dashes placeholder.)
// ===========================================================================
const DATA = {
  "name": "Brayden Guillory",
  "num": "47",
  "pos": "RHP",
  "bt": "R/R",
  "cls": "R-Freshman",
  "school": "Southern University",
  "home": "Kinder, LA",
  "htwt": "6-2 · 200",
  "bday": "11/17/2005",
  "photoSlug": "braydenguillory",
  "seasonTitle": "Season Totals — Pitching",
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
      "IP",
      "11.0"
    ],
    [
      "BF",
      "60"
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
      "FIP",
      "8.83"
    ],
    [
      "K",
      "3"
    ],
    [
      "BB",
      "9"
    ],
    [
      "H",
      "16"
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
          "HR",
          "3"
        ],
        [
          "HR/9",
          "2.5"
        ],
        [
          "H",
          "16"
        ],
        [
          "R",
          "19"
        ],
        [
          "ER",
          "18"
        ]
      ]
    ],
    [
      "COMMAND & RATES",
      [
        [
          "K%",
          "5.0"
        ],
        [
          "BB%",
          "15.0"
        ],
        [
          "K−BB%",
          "−10.0"
        ],
        [
          "K/9",
          "2.5"
        ],
        [
          "BB/9",
          "7.4"
        ],
        [
          "H/9",
          "13.1"
        ],
        [
          "K:BB",
          "0.33"
        ],
        [
          "P/BF",
          "3.5"
        ]
      ]
    ],
    [
      "HITTERS VS. GUILLORY",
      [
        [
          "AVG",
          ".333"
        ],
        [
          "OBP",
          ".441"
        ],
        [
          "SLG",
          ".562"
        ],
        [
          "OPS",
          "1.003"
        ],
        [
          "ISO",
          ".229"
        ],
        [
          "BABIP",
          ".302"
        ],
        [
          "2B",
          "2"
        ],
        [
          "3B",
          "0"
        ]
      ]
    ],
    [
      "PITCH PROFILE",
      [
        [
          "#P",
          "212"
        ],
        [
          "S%",
          "52"
        ],
        [
          "FPS%",
          "60.0"
        ],
        [
          "SwStr%",
          "7.9"
        ],
        [
          "P/IP",
          "19.3"
        ],
        [
          "GB%",
          "40"
        ],
        [
          "FB%",
          "36"
        ],
        [
          "LD% / PU%",
          "4 / 20"
        ]
      ]
    ]
  ],
  "logTitle": "Game by Game",
  "logCols": [
    "Date",
    "Opponent",
    "Result",
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
      "Jul 1",
      "at Brazos Valley",
      "W, 10-8",
      "3.1",
      "12",
      "1",
      "2",
      "2",
      "1",
      "3",
      "41",
      "41",
      "5.40"
    ],
    [
      "Jul 7",
      "at Acadiana",
      "L, 4-7",
      "0.2",
      "3",
      "1",
      "0",
      "0",
      "1",
      "0",
      "14",
      "43",
      "0.00"
    ],
    [
      "Jul 12",
      "at San Antonio",
      "L, 4-8",
      "3.1",
      "17",
      "5",
      "5",
      "5",
      "1",
      "0",
      "56",
      "63",
      "13.50"
    ],
    [
      "Jul 15",
      "at Baton Rouge",
      "L, 2-9",
      "1.2",
      "11",
      "3",
      "5",
      "4",
      "1",
      "0",
      "41",
      "54",
      "21.60"
    ],
    [
      "Jul 19",
      "Brazos Valley",
      "W, 14-11",
      "0.2",
      "7",
      "3",
      "5",
      "5",
      "2",
      "0",
      "23",
      "57",
      "67.50"
    ],
    [
      "Jul 23",
      "Sherman",
      "W, 8-7",
      "1.0",
      "6",
      "2",
      "2",
      "2",
      "1",
      "0",
      "21",
      "52",
      "18.00"
    ],
    [
      "Jul 26",
      "Abilene",
      "W, 5-4",
      "0.1",
      "4",
      "1",
      "0",
      "0",
      "2",
      "0",
      "16",
      "44",
      "0.00"
    ]
  ],
  "totals": [
    "TOTAL",
    "7 G",
    "",
    "11.0",
    "60",
    "16",
    "19",
    "18",
    "9",
    "3",
    "212",
    "52",
    "14.73"
  ],
  "note": "BF (batters faced), K%/BB% (per BF), AVG/OBP/SLG/OPS/ISO against, BABIP, 2B/3B/HR allowed, FPS% (first-pitch strike), SwStr% (swinging strikes per pitch) and the GB/FB/LD/PU profile are computed from official TCL play-by-play text; FIP uses the FanGraphs formula ((13·HR + 3·(BB+HBP) − 2·K)/IP + 3.10). IP, H/R/ER/BB/K, #P and S% are the scorer's official box-score figures. Statcast-only metrics (exit velocity, spin rate, barrels) are not captured at this level."
};
// ===========================================================================

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports', 'players');
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
const croc = b64('scripts/assets/croc-band.jpg', 'image/jpeg');   // hue-locked croc band
const photo = findPhoto(DATA.photoSlug || (DATA.name || '').toLowerCase().replace(/[^a-z]/g, ''));

const seasonTiles = DATA.season.map(([k, v]) => `<div class="stat"><div class="sv">${esc(v)}</div><div class="sl">${esc(k)}</div></div>`).join('');
const panels = (DATA.groups || []).map(([title, rows]) =>
  `<div class="panel"><div class="ptitle">${esc(title)}</div><div class="sg">` +
  rows.map(([l, v]) => `<div class="sr"><span class="sl2">${esc(l)}</span><span class="sv2">${esc(v)}</span></div>`).join('') +
  `</div></div>`).join('');
const headCells = DATA.logCols.map((c, i) => `<th${i < 3 ? ' class="l"' : ''}>${esc(c)}</th>`).join('');
const bodyRows = DATA.log.map(r => {
  const cells = r.map((v, i) => {
    if (i < 2) return `<td class="l">${esc(v)}</td>`;
    if (i === 2) return `<td class="l res">${esc(v)}</td>`;
    if (i === r.length - 1) return `<td><b>${esc(v)}</b></td>`;
    return `<td>${esc(v)}</td>`;
  }).join('');
  return `<tr>${cells}</tr>`;
}).join('');
const labCells = DATA.logCols.map((c, i) => i < 3 ? '<td></td>' : `<td>${esc(c)}</td>`).join('');
const totCells = DATA.totals.map((v, i) => {
  if (i < 3) return `<td class="l">${esc(v)}</td>`;
  if (i === DATA.totals.length - 1) return `<td><b>${esc(v)}</b></td>`;
  return `<td>${esc(v)}</td>`;
}).join('');

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(DATA.name)} — 2026 Summer Stats</title>
<style>
@page { size: letter; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: "Helvetica Neue", Arial, sans-serif; color: #16102b; }
.page { width: 816px; height: 1056px; position: relative; overflow: hidden; background: #f4f2ec; }
.band { position: relative; height: 118px; overflow: hidden; }
.band img.texture { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 35%; }
.band .shade { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(22,16,43,.38); }
.band .inner { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; padding: 0 45px; }
.band img.mark { width: 96px; height: 96px; object-fit: contain; margin-right: 22px; }
.band .org { font-family: Georgia, serif; font-weight: 800; font-size: 23px; color: #ecc913; letter-spacing: 1.2px; }
.band .sub { font-size: 11px; color: #cfc6ea; letter-spacing: 2.2px; text-transform: uppercase; margin-top: 6px; }
.goldline { height: 6px; background: linear-gradient(90deg, #ecc913, #ffd633 55%, #b89b0e); }
.id { display: flex; padding: 22px 45px 10px; }
.id .ph { width: 118px; height: 118px; border-radius: 9px; object-fit: cover; border: 4px solid #ecc913; background: #ddd; }
.id .who { margin-left: 22px; flex: 1; }
.id h1 { font-family: Georgia, serif; font-size: 33px; font-weight: 800; color: #4e3191; white-space: nowrap; }
.id .role { font-size: 14px; font-weight: 700; color: #714ad2; letter-spacing: 1.4px; margin-top: 3px; }
.meta { display: flex; flex-wrap: wrap; margin-top: 10px; }
.meta div { font-size: 11px; color: #443a66; margin-right: 22px; line-height: 1.6; }
.meta b { color: #16102b; font-size: 9px; text-transform: uppercase; letter-spacing: .7px; display: block; }
.striptitle { margin: 12px 45px 0; font-size: 10.5px; font-weight: 700; letter-spacing: 2.2px; color: #714ad2; text-transform: uppercase; }
.strip { margin: 6px 45px 0; background: #4e3191; border-radius: 8px; padding: 13px 6px; display: flex; justify-content: space-around; border: 2px solid #ecc913; }
.strip .stat { text-align: center; }
.strip .sv { font-family: Georgia, serif; font-size: 21px; font-weight: 800; color: #ffd633; }
.strip .sl { font-size: 8.5px; color: #cfc6ea; letter-spacing: 1.2px; margin-top: 3px; }
.grid { display: flex; flex-wrap: wrap; margin: 8px 40px 0; }
.panel { width: 50%; padding: 4px 5px; }
.ptitle { font-size: 9.5px; font-weight: 800; letter-spacing: 1.8px; color: #4e3191; border-bottom: 1.5px solid #ecc913; padding-bottom: 3px; margin-bottom: 5px; }
.sg { display: flex; flex-wrap: wrap; }
.sr { width: 50%; display: flex; justify-content: space-between; padding: 2.5px 8px 2.5px 2px; font-size: 11px; }
.sl2 { color: #6d6391; font-weight: 700; letter-spacing: .5px; }
.sv2 { color: #16102b; font-weight: 800; font-variant-numeric: tabular-nums; }
.logwrap { margin: 8px 45px 0; }
h2 { font-family: Georgia, serif; font-size: 15px; color: #4e3191; border-bottom: 1.9px solid #ecc913; padding-bottom: 4px; margin-bottom: 6px; }
table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
th { background: #4e3191; color: #fff; font-size: 8px; letter-spacing: .8px; text-transform: uppercase; padding: 7px 4px; text-align: right; }
th.l, td.l { text-align: left; }
td { padding: 6.5px 4px; border-bottom: .9px solid #d9d4e8; text-align: right; font-variant-numeric: tabular-nums; }
tr:nth-child(even) td { background: #ece9f6; }
td.res { font-weight: 700; }
tr.tot td { background: #16102b; color: #ffd633; font-weight: 800; border-bottom: none; }
tr.totlab td { color: #714ad2; font-size: 7.5px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; border-bottom: none; padding-top: 3px; }
.note { margin: 8px 45px 0; font-size: 8.6px; color: #6d6391; line-height: 1.5; }
.foot { position: absolute; bottom: 0; left: 0; width: 100%; height: 40px; overflow: hidden; }
.foot img { width: 100%; height: 100%; object-fit: cover; object-position: center 70%; }
.foot .shade { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(22,16,43,.5); display: flex; align-items: center; justify-content: center; }
.foot .shade span { color: #cfc6ea; font-size: 9px; letter-spacing: 1.6px; text-transform: uppercase; }
</style></head>
<body><div class="page">
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
<div class="goldline"></div>
<div class="id">
  <img class="ph" src="${photo}" alt="">
  <div class="who">
    <h1>${esc(DATA.name.toUpperCase())}</h1>
    <div class="role">#${esc(DATA.num)} &middot; ${esc(DATA.pos)} &middot; B/T: ${esc(DATA.bt)}</div>
    <div class="meta">
      <div><b>Class</b>${esc(DATA.cls)}</div>
      <div><b>School</b>${esc(DATA.school)}</div>
      <div><b>Hometown</b>${esc(DATA.home)}</div>
      <div><b>Ht / Wt</b>${esc(DATA.htwt)}</div>
      <div><b>Born</b>${esc(DATA.bday)}</div>
    </div>
  </div>
</div>
<div class="striptitle">${esc(DATA.seasonTitle)}</div>
<div class="strip">${seasonTiles}</div>
<div class="grid">${panels}</div>
<div class="logwrap">
<h2>${esc(DATA.logTitle)}</h2>
<table>
<thead><tr>${headCells}</tr></thead>
<tbody>${bodyRows}<tr class="tot">${totCells}</tr><tr class="totlab">${labCells}</tr></tbody>
</table>
<div class="note">${esc(DATA.note)}</div>
</div>
<div class="foot">
  <img src="${croc}" alt="">
  <div class="shade"><span>whatisthegatorscore.com</span></div>
</div>
</div></body></html>`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const stem = stemArg || path.join(OUT_DIR, DATA.name + ' - 2026 Summer Stats');
const tmp = path.join(require('os').tmpdir(), 'player-season-card-' + Date.now() + '.html');
fs.writeFileSync(tmp, html);
const out = stem.endsWith('.pdf') ? stem : stem + '.pdf';
execFileSync(findChromium(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', '--print-to-pdf=' + out, 'file://' + path.resolve(tmp)], { stdio: 'ignore' });
try { fs.unlinkSync(tmp); } catch (e) {}
console.log('wrote ' + out);
