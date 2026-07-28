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
 * FPS%, GB/FB/LD/PU) are computed from TCL play-by-play text.
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
        ],
        [
          "vs LHB (21 PA)",
          ".222/.333/.444",
          "wide",
          "AVG · OBP · SLG"
        ],
        [
          "vs RHB (39 PA)",
          ".400/.500/.633",
          "wide",
          "AVG · OBP · SLG"
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
  "key": [
    [
      "BF",
      "batters faced"
    ],
    [
      "K% / BB%",
      "strikeouts / walks per BF"
    ],
    [
      "K/9 · BB/9 · H/9 · HR/9",
      "per 9 innings"
    ],
    [
      "FIP",
      "fielding independent pitching"
    ],
    [
      "AVG / OBP / SLG / OPS",
      "hitters' slash line against"
    ],
    [
      "vs LHB / vs RHB",
      "AVG/OBP/SLG by batter side (switch bats left vs RHP)"
    ],
    [
      "ISO",
      "isolated power (SLG − AVG)"
    ],
    [
      "BABIP",
      "batting avg on balls in play"
    ],
    [
      "#P",
      "total pitches"
    ],
    [
      "S%",
      "strike percentage"
    ],
    [
      "FPS%",
      "first-pitch strikes"
    ],
    [
      "P/IP · P/BF",
      "pitches per inning / batter"
    ],
    [
      "GB / FB / LD / PU",
      "ground ball / fly ball / line drive / popup % (outs)"
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
  ]
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

// Relievers never start — hide the GS tile entirely when it's 0.
const seasonTiles = DATA.season.filter(([k, v]) => !(k === 'GS' && String(v) === '0')).map(([k, v]) => `<div class="stat"><div class="sv">${esc(v)}</div><div class="sl">${esc(k)}</div></div>`).join('');
const keyRow = (DATA.key || []).length
  ? `<div class="keytitle">Advanced Metrics Key</div><div class="key">` +
    DATA.key.map(([a, m]) => `<span class="ki"><b>${esc(a)}</b> ${esc(m)}</span>`).join('<span class="ksep">&middot;</span> ') + `</div>`
  : '';
const panels = (DATA.groups || []).map(([title, rows]) =>
  `<div class="panel"><div class="ptitle">${esc(title)}</div><div class="sg">` +
  rows.map(([l, v, w, sub]) =>
    `<div class="sr${w === 'wide' ? ' w' : ''}"><span class="sl2">${esc(l)}</span>` +
    (sub
      ? `<span class="sv2sub"><span class="sv2">${esc(v)}</span><span class="svsub">${esc(sub)}</span></span>`
      : `<span class="sv2">${esc(v)}</span>`) +
    `</div>`).join('') +
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
.band { position: relative; height: 118px; overflow: hidden; margin: 18px 45px 0; border-radius: 12px; border: 2.5px solid #ecc913; }
.band img.texture { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 35%; }
.band .shade { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(22,16,43,.38); }
.band .inner { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; padding: 0 30px; }
.band img.mark { width: 102px; height: 102px; object-fit: contain; margin-right: 22px; }
.band .org { font-family: Georgia, serif; font-weight: 800; font-size: 23px; color: #ffd633; letter-spacing: 1.2px; }
.band .sub { font-size: 11px; color: #cfc6ea; letter-spacing: 2.2px; text-transform: uppercase; margin-top: 6px; }
.id { display: flex; padding: 24px 45px 12px; }
.id .ph { width: 118px; height: 118px; border-radius: 9px; object-fit: cover; border: 4px solid #ecc913; background: #ddd; }
.id .who { margin-left: 22px; flex: 1; }
.id h1 { font-family: Georgia, serif; font-size: 35px; font-weight: 800; color: #4e3191; white-space: nowrap; }
.id .role { font-size: 14px; font-weight: 700; color: #714ad2; letter-spacing: 1.4px; margin-top: 3px; }
.meta { display: flex; flex-wrap: wrap; margin-top: 14px; }
.meta div { font-size: 11.5px; color: #6d6391; margin-right: 24px; line-height: 1.7; }
.meta b { color: #4e3191; font-size: 9px; text-transform: uppercase; letter-spacing: .7px; display: block; }
.striptitle { margin: 16px 45px 0; font-size: 10.5px; font-weight: 700; letter-spacing: 2.2px; color: #714ad2; text-transform: uppercase; }
.strip { margin: 7px 45px 0; background: #4e3191; border-radius: 8px; padding: 15px 6px; display: flex; justify-content: space-around; border: 2px solid #ecc913; }
.strip .stat { text-align: center; }
.strip .sv { font-family: Georgia, serif; font-size: 23px; font-weight: 800; color: #ffd633; }
.strip .sl { font-size: 8.5px; color: #cfc6ea; letter-spacing: 1.2px; margin-top: 3px; }
.keytitle { margin: 10px 45px 0; font-size: 8px; font-weight: 800; letter-spacing: 2px; color: #714ad2; text-transform: uppercase; }
.key { margin: 3px 45px 0; font-size: 9.2px; color: #6d6391; line-height: 1.6; }
.key .ki { white-space: nowrap; }
.key .ki b { color: #4e3191; letter-spacing: .3px; }
.key .ksep { color: #cfc6ea; margin: 0 5px; font-weight: 800; }
.grid { display: flex; flex-wrap: wrap; margin: 10px 40px 0; }
.panel { width: 50%; padding: 4px 5px; }
.ptitle { font-size: 10px; font-weight: 800; letter-spacing: 1.8px; color: #4e3191; border-bottom: 1.5px solid #ecc913; padding-bottom: 4px; margin-bottom: 7px; }
.sg { display: flex; flex-wrap: wrap; }
.sr { width: 50%; display: flex; justify-content: space-between; padding: 2.9px 8px 2.9px 2px; font-size: 12px; }
.sr.w { width: 100%; }
.sl2 { color: #6d6391; font-weight: 700; letter-spacing: .5px; }
.sv2 { color: #16102b; font-weight: 800; font-variant-numeric: tabular-nums; }
.sv2sub { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.25; }
.svsub { font-size: 7px; color: #6d6391; font-weight: 700; letter-spacing: 1.2px; }
.logwrap { margin: 10px 45px 0; }
h2 { font-family: Georgia, serif; font-size: 16px; color: #4e3191; border-bottom: 1.9px solid #ecc913; padding-bottom: 4px; margin-bottom: 6px; }
table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
th { background: #4e3191; color: #fff; font-size: 8.5px; letter-spacing: .8px; text-transform: uppercase; padding: 8px 4px; text-align: right; }
th.l, td.l { text-align: left; }
td { padding: 6.5px 4px; border-bottom: .9px solid #e5e0f0; text-align: right; font-variant-numeric: tabular-nums; }
tr:nth-child(even) td { background: #e5e0f0; }
td.res { font-weight: 700; }
tr.tot td { background: #16102b; color: #ffd633; font-weight: 800; border-bottom: none; }
tr.totlab td { color: #714ad2; font-size: 8px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; border-bottom: none; padding-top: 4px; }
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
${keyRow}<div class="grid">${panels}</div>
<div class="logwrap">
<h2>${esc(DATA.logTitle)}</h2>
<table>
<thead><tr>${headCells}</tr></thead>
<tbody>${bodyRows}<tr class="tot">${totCells}</tr><tr class="totlab">${labCells}</tr></tbody>
</table>
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
