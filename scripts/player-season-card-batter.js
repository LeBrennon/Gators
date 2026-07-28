#!/usr/bin/env node
/*
 * Player Season Card (BATTER) — renders a one-page, letter-size, branded PDF of one
 * player's summer: identity block, season-totals strip, four advanced-stat
 * panels (Savant-style: run prevention, command & rates, hitters-against,
 * pitch profile), and a game-by-game table with totals + column labels.
 * Club branding per docs/HANDOFF.md: croc-skin bands (hue-locked to the
 * #4e3191 family via scripts/assets/croc-band.jpg), gold border, purples
 * #4e3191 dark / #714ad2 accent, gold #ecc913/#ecc913.
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
  "name": "Ayden Sunday",
  "num": "17",
  "pos": "OF",
  "bt": "R/R",
  "cls": "Freshman",
  "school": "Lamar University",
  "home": "Nederland, TX",
  "htwt": "6-0 \u00b7 185",
  "bday": "\u2014",
  "photoSlug": "aydensundayyp1j",
  "seasonTitle": "Season Totals \u2014 Hitting",
  "season": [
    [
      "G",
      "41"
    ],
    [
      "PA",
      "185"
    ],
    [
      "AVG",
      ".286"
    ],
    [
      "OBP",
      ".438"
    ],
    [
      "SLG",
      ".471"
    ],
    [
      "OPS",
      ".909"
    ],
    [
      "HR",
      "3"
    ],
    [
      "RBI",
      "36"
    ],
    [
      "SB",
      "14"
    ]
  ],
  "groups": [
    [
      "PRODUCTION",
      [
        [
          "AVG",
          ".286"
        ],
        [
          "OBP",
          ".438"
        ],
        [
          "SLG",
          ".471"
        ],
        [
          "OPS",
          ".909"
        ],
        [
          "ISO",
          ".186"
        ],
        [
          "BABIP",
          ".339"
        ],
        [
          "XBH",
          "16"
        ],
        [
          "TB",
          "66"
        ],
        [
          "vs LHP (52 PA)",
          ".289/.385/.333",
          "wide",
          "AVG \u00b7 OBP \u00b7 SLG \u2014 OPS .718"
        ],
        [
          "vs RHP (133 PA)",
          ".284/.459/.537",
          "wide",
          "AVG \u00b7 OBP \u00b7 SLG \u2014 OPS .995"
        ]
      ]
    ],
    [
      "PLATE DISCIPLINE",
      [
        [
          "BB%",
          "15.1"
        ],
        [
          "K%",
          "17.3"
        ],
        [
          "BB:K",
          "0.88"
        ],
        [
          "PA",
          "185"
        ],
        [
          "BB",
          "28"
        ],
        [
          "K",
          "32"
        ],
        [
          "HBP",
          "13"
        ],
        [
          "SF",
          "4"
        ]
      ]
    ],
    [
      "HIT BREAKDOWN",
      [
        [
          "H",
          "40"
        ],
        [
          "1B",
          "24"
        ],
        [
          "2B",
          "9"
        ],
        [
          "3B",
          "4"
        ],
        [
          "HR",
          "3"
        ],
        [
          "RBI",
          "36"
        ],
        [
          "R",
          "35"
        ],
        [
          "GIDP",
          "1"
        ]
      ]
    ],
    [
      "BASE RUNNING & TCL RANKS",
      [
        [
          "SB",
          "14"
        ],
        [
          "CS",
          "3"
        ],
        [
          "SB%",
          "82.4"
        ],
        [
          "SB-ATT",
          "14-17"
        ],
        [
          "League ranks",
          "RBI 2nd \u00b7 3B 2nd \u00b7 R 3rd",
          "wide",
          "TCL BATTERS"
        ],
        [
          "Also",
          "PA 3rd \u00b7 TB 5th \u00b7 H 5th",
          "wide",
          "TCL BATTERS"
        ]
      ]
    ]
  ],
  "key": [
    [
      "OBP",
      "on-base pct (H+BB+HBP per PA)"
    ],
    [
      "SLG",
      "total bases per AB"
    ],
    [
      "OPS",
      "OBP + SLG"
    ],
    [
      "ISO",
      "isolated power (SLG \u2212 AVG)"
    ],
    [
      "BABIP",
      "batting avg on balls in play"
    ],
    [
      "BB% / K%",
      "walks / strikeouts per PA"
    ],
    [
      "XBH \u00b7 TB",
      "extra-base hits \u00b7 total bases"
    ],
    [
      "SB%",
      "stolen-base success (SB \u00f7 attempts)"
    ],
    [
      "SF",
      "sacrifice flies (not an AB)"
    ]
  ],
  "logTitle": "Game by Game \u2014 Hitting",
  "logCols": [
    "Date",
    "Opponent",
    "Result",
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
      "Jun 2",
      "Abilene",
      "W, 11-1",
      "1",
      "1",
      "0",
      "1",
      "0",
      "0",
      "0",
      "1",
      "1.000"
    ],
    [
      "Jun 4",
      "Baton Rouge",
      "L, 18-5",
      "4",
      "4",
      "0",
      "1",
      "1",
      "0",
      "1",
      "1",
      ".250"
    ],
    [
      "Jun 5",
      "at Baton Rouge",
      "W, 14-1",
      "7",
      "4",
      "2",
      "2",
      "1",
      "2",
      "0",
      "1",
      ".500"
    ],
    [
      "Jun 6",
      "at Baton Rouge",
      "L, 9-8",
      "6",
      "2",
      "2",
      "0",
      "1",
      "1",
      "2",
      "0",
      ".000"
    ],
    [
      "Jun 7",
      "at Baton Rouge",
      "L, 5-4",
      "5",
      "4",
      "2",
      "1",
      "0",
      "1",
      "1",
      "0",
      ".250"
    ],
    [
      "Jun 9",
      "Baton Rouge",
      "W, 3-1",
      "4",
      "4",
      "0",
      "2",
      "1",
      "0",
      "0",
      "0",
      ".500"
    ],
    [
      "Jun 10",
      "Baton Rouge",
      "W, 8-7",
      "5",
      "3",
      "0",
      "0",
      "1",
      "1",
      "2",
      "1",
      ".000"
    ],
    [
      "Jun 11",
      "at Acadiana",
      "L, 4-3",
      "1",
      "1",
      "0",
      "0",
      "0",
      "0",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 12",
      "Acadiana",
      "W, 16-15",
      "5",
      "3",
      "3",
      "1",
      "2",
      "1",
      "2",
      "0",
      ".333"
    ],
    [
      "Jun 13",
      "at Victoria",
      "L, 7-6",
      "6",
      "5",
      "1",
      "2",
      "4",
      "0",
      "0",
      "0",
      ".400"
    ],
    [
      "Jun 14",
      "at Victoria",
      "L, 10-3",
      "5",
      "3",
      "0",
      "0",
      "0",
      "2",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 16",
      "Acadiana",
      "L, 9-5",
      "5",
      "3",
      "1",
      "0",
      "0",
      "2",
      "2",
      "1",
      ".000"
    ],
    [
      "Jun 17",
      "Acadiana",
      "L, 11-7",
      "5",
      "5",
      "1",
      "0",
      "0",
      "0",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 18",
      "at Acadiana",
      "L, 4-2",
      "1",
      "1",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      ".000"
    ],
    [
      "Jun 19",
      "at Acadiana",
      "W, 6-3",
      "5",
      "4",
      "1",
      "0",
      "0",
      "1",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 20",
      "at Sherman",
      "W, 8-1",
      "5",
      "4",
      "1",
      "2",
      "2",
      "1",
      "1",
      "2",
      ".500"
    ],
    [
      "Jun 21",
      "at Sherman",
      "W, 12-11",
      "6",
      "3",
      "0",
      "0",
      "0",
      "2",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 23",
      "Victoria",
      "W, 6-5",
      "5",
      "4",
      "1",
      "1",
      "2",
      "1",
      "1",
      "0",
      ".250"
    ],
    [
      "Jun 24",
      "Victoria",
      "L, 7-3",
      "4",
      "4",
      "1",
      "2",
      "1",
      "0",
      "0",
      "0",
      ".500"
    ],
    [
      "Jun 25",
      "at Brazos Valley",
      "W, 7-0",
      "2",
      "1",
      "0",
      "0",
      "0",
      "1",
      "0",
      "1",
      ".000"
    ],
    [
      "Jun 26",
      "at Brazos Valley",
      "L, 10-8",
      "5",
      "4",
      "1",
      "3",
      "2",
      "0",
      "0",
      "0",
      ".750"
    ],
    [
      "Jun 27",
      "Baton Rouge",
      "W, 7-6",
      "5",
      "3",
      "0",
      "0",
      "1",
      "0",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 28",
      "at Baton Rouge",
      "W, 8-5",
      "4",
      "3",
      "1",
      "0",
      "0",
      "0",
      "1",
      "0",
      ".000"
    ],
    [
      "Jun 30",
      "at Brazos Valley",
      "L, 9-3",
      "4",
      "3",
      "0",
      "1",
      "0",
      "1",
      "1",
      "0",
      ".333"
    ],
    [
      "Jul 1",
      "at Brazos Valley",
      "W, 10-8",
      "5",
      "5",
      "1",
      "3",
      "2",
      "0",
      "0",
      "1",
      ".600"
    ],
    [
      "Jul 2",
      "San Antonio",
      "W, 16-0",
      "6",
      "6",
      "2",
      "2",
      "0",
      "0",
      "0",
      "0",
      ".333"
    ],
    [
      "Jul 3",
      "San Antonio",
      "W, 9-7",
      "4",
      "3",
      "1",
      "2",
      "6",
      "0",
      "0",
      "0",
      ".667"
    ],
    [
      "Jul 4",
      "Brazos Valley",
      "W, 7-3",
      "5",
      "5",
      "1",
      "2",
      "1",
      "0",
      "1",
      "1",
      ".400"
    ],
    [
      "Jul 7",
      "at Acadiana",
      "L, 7-4",
      "5",
      "4",
      "0",
      "2",
      "1",
      "1",
      "0",
      "1",
      ".500"
    ],
    [
      "Jul 8",
      "Acadiana",
      "W, 15-6",
      "5",
      "2",
      "0",
      "0",
      "0",
      "3",
      "1",
      "0",
      ".000"
    ],
    [
      "Jul 9",
      "at Abilene",
      "L, 5-4",
      "4",
      "4",
      "0",
      "0",
      "0",
      "0",
      "3",
      "0",
      ".000"
    ],
    [
      "Jul 10",
      "at Abilene",
      "L, 4-3",
      "4",
      "4",
      "1",
      "1",
      "0",
      "0",
      "1",
      "0",
      ".250"
    ],
    [
      "Jul 12 G1",
      "at San Antonio",
      "W, 3-2",
      "4",
      "3",
      "0",
      "1",
      "0",
      "1",
      "0",
      "0",
      ".333"
    ],
    [
      "Jul 12 G2",
      "at San Antonio",
      "L, 8-4",
      "4",
      "4",
      "1",
      "1",
      "0",
      "0",
      "1",
      "0",
      ".250"
    ],
    [
      "Jul 14",
      "Baton Rouge",
      "W, 5-4",
      "5",
      "3",
      "0",
      "0",
      "1",
      "1",
      "1",
      "0",
      ".000"
    ],
    [
      "Jul 15",
      "at Baton Rouge",
      "L, 9-2",
      "4",
      "4",
      "0",
      "1",
      "1",
      "0",
      "0",
      "0",
      ".250"
    ],
    [
      "Jul 16",
      "Baton Rouge",
      "W, 10-2",
      "5",
      "3",
      "1",
      "1",
      "2",
      "1",
      "0",
      "1",
      ".333"
    ],
    [
      "Jul 18",
      "Brazos Valley",
      "W, 11-8",
      "5",
      "3",
      "4",
      "3",
      "1",
      "2",
      "0",
      "1",
      "1.000"
    ],
    [
      "Jul 19",
      "Brazos Valley",
      "W, 14-11",
      "6",
      "3",
      "2",
      "0",
      "1",
      "1",
      "1",
      "0",
      ".000"
    ],
    [
      "Jul 21",
      "at Victoria",
      "W, 12-7",
      "5",
      "4",
      "3",
      "2",
      "1",
      "1",
      "1",
      "1",
      ".500"
    ],
    [
      "Jul 22",
      "at Victoria",
      "L, 6-0",
      "4",
      "4",
      "0",
      "0",
      "0",
      "0",
      "2",
      "0",
      ".000"
    ]
  ],
  "totals": [
    "TOTAL",
    "41 G",
    "",
    "185",
    "140",
    "35",
    "40",
    "36",
    "28",
    "32",
    "14",
    ".286"
  ]
};;;
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
const tcl = b64('scripts/assets/tcl-logo-transparent.png', 'image/png');
const fPop7 = b64('scripts/assets/fonts/poppins-700.ttf', 'font/ttf');
const fPop8 = b64('scripts/assets/fonts/poppins-800.ttf', 'font/ttf');
const fLek = b64('scripts/assets/fonts/leckerli-one-400.ttf', 'font/ttf');

// Relievers never start — hide the GS tile entirely when it's 0.
const seasonTiles = DATA.season.filter(([k, v]) => !(k === 'GS' && String(v) === '0')).map(([k, v]) => `<div class="stat"><div class="sv">${esc(v)}</div><div class="sl">${esc(k)}</div></div>`).join('');
const keyRow = (DATA.key || []).length
  ? `<div class="keytitle">Advanced Metrics Key</div><div class="key">` +
    DATA.key.map(([a, m]) => `<span class="ki"><b>${esc(a)}</b> ${esc(m)}</span>`).join('<span class="ksep">&middot;</span> ') + `</div>`
  : '';
const mkPanel = ([title, rows, legend], full) =>
  `<div class="panel${full ? ' full' : ''}"><div class="ptitle">${esc(title)}</div>${legend ? `<div class="pleg">` + legend.split(' \u00b7 ').map(d => `<span class="ld">${esc(d)}</span>`).join('<span class="lsep">\u00b7</span> ') + `</div>` : ''}<div class="sg">` +
  rows.map(([l, v, w, sub]) =>
    `<div class="sr${w === 'wide' ? ' w' : ''}"><span class="sl2">${esc(l)}</span>` +
    (sub
      ? `<span class="sv2sub"><span class="sv2">${esc(v)}</span><span class="svsub">${esc(sub)}</span></span>`
      : `<span class="sv2">${esc(v)}</span>`) +
    `</div>`).join('') +
  `</div></div>`;
// Print layout: pull wide split rows out of their panels into one full-width
// PLATOON SPLITS panel between the row pairs — keeps the 2x2 pairing balanced.
const halfGroups = []; const splitRows = [];
(DATA.groups || []).forEach(g => {
  const half = g[1].filter(r => r[2] !== 'wide');
  const wide = g[1].filter(r => r[2] === 'wide');
  if (half.length) halfGroups.push([g[0], half, g[2]]);
  splitRows.push(...wide);
});
// Hitters: synthesize a Total split row from the season tiles (pitchers already have one)
const seasonMap = Object.fromEntries(DATA.season || []);
if (splitRows.length && !splitRows.some(r => /^Total/.test(r[0])))
  splitRows.unshift([`Total (${seasonMap['PA'] || ''} PA)`, `${seasonMap['AVG']}/${seasonMap['OBP']}/${seasonMap['SLG']}`, 'wide', `AVG \u00b7 OBP \u00b7 SLG \u2014 OPS ${seasonMap['OPS']}`]);
// Order: Total, then RH side, then LH side
splitRows.sort((a, b) => (/^Total/.test(a[0]) ? 0 : a[0].includes('RH') ? 1 : 2) - (/^Total/.test(b[0]) ? 0 : b[0].includes('RH') ? 1 : 2));
// Horizontal cells stretch the splits across the full panel width
const splitCells = splitRows.map(([l, v, , sub]) =>
  `<div class="splitcell"><span class="sl2">${esc(l)}</span><span class="sv2sub"><span class="sv2">${esc(v)}</span><span class="svsub">${esc(sub)}</span></span></div>`).join('');
const splitPanelHtml = `<div class="panel full"><div class="ptitle">PLATOON SPLITS</div><div class="sg splitrow">${splitCells}</div></div>`;
const units = halfGroups.map(g => ({ html: mkPanel(g), full: false }));
if (splitRows.length) units.splice(Math.min(2, units.length), 0, { html: splitPanelHtml, full: true });
let panels = '';
for (let i = 0; i < units.length;) {
  if (units[i].full) { panels += `<div class="prow">${units[i].html}</div>`; i++; }
  else if (i + 1 < units.length && !units[i + 1].full) { panels += `<div class="prow">${units[i].html}${units[i + 1].html}</div>`; i += 2; }
  else { panels += `<div class="prow">${units[i].html}</div>`; i++; }
}
function buildHtml(sp, cmp) {
const spread = sp;
const compact = cmp !== undefined ? cmp : DATA.log.length > 20;
const headCells = DATA.logCols.map((c, i) => `<th${i < 3 ? ' class="l"' : ''}>${esc(c)}</th>`).join('');
const logTable = (rows, withTotals) => {
  const body = rows.map(r => '<tr>' + r.map((v, i) => {
    if (i < 2) return `<td class="l">${esc(v)}</td>`;
    if (i === 2) return `<td class="l res">${esc(v)}</td>`;
    if (i === r.length - 1) return `<td><b>${esc(v)}</b></td>`;
    return `<td>${esc(v)}</td>`;
  }).join('') + '</tr>').join('');
  const tot = withTotals
    ? `<tr class="tot">${totCells}</tr><tr class="totlab">${labCells}</tr>` : '';
  return `<table><thead><tr>${headCells}</tr></thead><tbody>${body}${tot}</tbody></table>`;
};
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
@font-face { font-family: 'Poppins'; font-weight: 700; src: url(data:font/ttf;base64,${fPop7}) format('truetype'); }
@font-face { font-family: 'Poppins'; font-weight: 800; src: url(data:font/ttf;base64,${fPop8}) format('truetype'); }
@font-face { font-family: 'Leckerli One'; font-weight: 400; src: url(data:font/ttf;base64,${fLek}) format('truetype'); }
@page { size: letter; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: "Helvetica Neue", Arial, sans-serif; color: #020200; }
.page { width: 816px; height: 1056px; position: relative; overflow: hidden; background: #f4f2ec; padding-bottom: 46px; display: flex; flex-direction: column; justify-content: space-between; }
.page > * { flex-shrink: 0; }
.band { position: relative; height: 118px; overflow: hidden; margin: 18px 45px 0; border-radius: 12px; border: 2.5px solid #ecc913; }
.band img.texture { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 35%; }
.band .shade { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(22,16,43,.38); }
.band .inner { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; padding: 0 30px; }
.band img.mark { width: 102px; height: 102px; object-fit: contain; margin-right: 22px; }
.band .org { font-family: 'Poppins', Georgia, serif; font-weight: 800; font-size: 23px; color: #ffd633; letter-spacing: 1.2px; }
.band .sub { font-family: 'Leckerli One', cursive; font-size: 14px; font-weight: 700; color: #cfc6ea; letter-spacing: 1px; margin-top: 6px; }
.id { display: flex; padding: 16px 45px 8px; }
.id .ph { margin-left: 16px; width: 132px; height: 132px; border-radius: 9px; object-fit: cover; object-position: center 15%; border: 4px solid #ecc913; background: #ddd; }
.id .who { margin-left: 22px; flex: 1; text-align: center; }
.id .tclid { height: 118px; width: auto; align-self: center; margin-left: 24px; margin-right: 16px; }
.id h1 { font-family: 'Poppins', Georgia, serif; font-size: 35px; font-weight: 800; color: #33205e; white-space: nowrap; }
.id .role { font-size: 14px; font-weight: 700; color: #33205e; letter-spacing: 1.4px; margin-top: 3px; }
.meta { display: flex; flex-wrap: wrap; justify-content: center; margin-top: 14px; }
.meta div { font-size: 11.5px; color: #33205e; margin-right: 24px; line-height: 1.7; }
.meta b { color: #33205e; font-size: 9px; text-transform: uppercase; letter-spacing: .7px; display: block; }
.striptitle { font-family: 'Poppins', Georgia, serif; margin: 12px 45px 0; font-size: 10.5px; font-weight: 700; letter-spacing: 2.2px; color: #33205e; text-transform: uppercase; }
.strip { margin: 6px 45px 0; background: #33205e; border-radius: 8px; padding: 11px 6px; display: flex; justify-content: space-around; border: 2px solid #ecc913; }
.strip .stat { text-align: center; }
.strip .sv { font-family: Georgia, serif; font-size: 23px; font-weight: 800; color: #ecc913; }
.strip .sl { font-size: 8.5px; color: #fcef9d; letter-spacing: 1.2px; margin-top: 3px; }
.keytitle { font-family: 'Poppins', Georgia, serif; margin: 8px 45px 0; font-size: 8px; font-weight: 800; letter-spacing: 2px; color: #33205e; text-transform: uppercase; }
.key { margin: 2px 45px 0; font-size: 9.2px; color: #33205e; line-height: 1.5; }
.key .ki { white-space: nowrap; }
.key .ki b { color: #33205e; letter-spacing: .3px; }
.key .ksep { color: #fcef9d; margin: 0 5px; font-weight: 800; }
.grid { margin: 8px 40px 0; }
.prow { display: flex; }
.panel { padding: 4px 5px; width: 50%; min-width: 0; }
.panel.full { width: 100%; }
.ptitle { font-family: 'Poppins', Georgia, serif; font-size: 10px; font-weight: 800; letter-spacing: 1.8px; color: #33205e; border-bottom: 1.5px solid #ecc913; padding-bottom: 4px; margin-bottom: 7px; }
.pleg { font-size: 9px; line-height: 1.6; color: #33205e; margin: -3px 0 7px; }
.ld { white-space: nowrap; }
.lsep { color: #ecc913; margin-right: 3px; }
.sg { display: flex; flex-wrap: wrap; }
.sr { width: 50%; display: flex; justify-content: flex-start; gap: 4px; padding: 3.2px 8px 3.2px 2px; font-size: 13px; }
.sr.w { width: 100%; padding: 4.5px 8px 4.5px 2px; }
.sg.splitrow { display: flex; gap: 10px; font-size: 13px; }
.splitcell { flex: 1; display: flex; gap: 8px; align-items: flex-start; justify-content: center; padding: 3px 2px; }
.splitcell .sl2 { min-width: 0; }
.sl2 { color: #33205e; font-weight: 700; letter-spacing: .5px; display: inline-block; min-width: 58px; white-space: nowrap; }
.sr.w .sl2 { min-width: 126px; }
.sv2 { color: #020200; font-weight: 800; font-variant-numeric: tabular-nums; }
.sv2sub { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.25; }
.svsub { font-size: 7.5px; color: #33205e; font-weight: 700; letter-spacing: 1.2px; }
.logwrap { margin: 8px 45px 0; }
h2 { font-family: 'Poppins', Georgia, serif; font-size: 16px; color: #33205e; border-bottom: 1.9px solid #ecc913; padding-bottom: 4px; margin-bottom: 6px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { background: #33205e; color: #fff; font-size: 8.5px; letter-spacing: .8px; text-transform: uppercase; padding: 8px 4px; text-align: center; }
th.l, td.l { text-align: left; }
td { padding: 5.6px 4px; border-bottom: .9px solid #e5e0f0; text-align: center; font-variant-numeric: tabular-nums; }
tr:nth-child(even) td { background: #e5e0f0; }
td.res { font-weight: 700; }
tr.tot td { background: #33205e; color: #ecc913; font-weight: 800; border-bottom: none; }
/* compact (long logs): two side-by-side tables, tighter rows */
.log2col { display: flex; gap: 10px; }
.log2col table { width: 50%; }
.compact .logwrap { margin-top: 4px; }
.compact .log2col table { font-size: 8.8px; }
.compact .log2col th { font-size: 6.5px; padding: 4px 2px; }
.compact .log2col td { padding: 2.2px 2px; line-height: 1.15; }
.compact h2 { font-size: 12.5px; margin-bottom: 3px; padding-bottom: 3px; }
.compact .sr { padding: 2.3px 8px 2.3px 2px; font-size: 11.6px; }
.compact .sg.splitrow { font-size: 11.6px; }
.compact .band { height: 100px; margin-top: 12px; }
.compact .band img.mark { width: 86px; height: 86px; }
.compact .id { padding: 14px 45px 8px; }
.compact .id .ph { width: 112px; height: 112px; }
.compact .striptitle { margin-top: 10px; }
.compact .strip { padding: 10px 6px; }
.compact .strip .sv { font-size: 20px; }
.compact .keytitle { margin-top: 6px; }
.compact .key { font-size: 8.4px; line-height: 1.45; }
.compact .grid { margin-top: 6px; }
.compact .ptitle { margin-bottom: 5px; padding-bottom: 3px; }
.compact .svsub { font-size: 6.4px; }
${spread > 0 ? `
/* spread (short logs): loosen everything so the page doesn't end in blank space */
.spread .band { height: calc(118px + ${(spread * 30).toFixed(0)}px); margin-top: calc(18px + ${(spread * 12).toFixed(0)}px); }
.spread .id { padding-top: calc(16px + ${(spread * 18).toFixed(0)}px); padding-bottom: calc(8px + ${(spread * 14).toFixed(0)}px); }
.spread .id .ph { width: calc(132px + ${(spread * 30).toFixed(0)}px); height: calc(132px + ${(spread * 30).toFixed(0)}px); }
.spread .id h1 { font-size: calc(37px + ${(spread * 10).toFixed(0)}px); }
.spread .id .sub { font-size: calc(15px + ${(spread * 4).toFixed(0)}px); }
.spread .id .meta { font-size: calc(11px + ${(spread * 2).toFixed(0)}px); margin-top: calc(7px + ${(spread * 6).toFixed(0)}px); }
.spread .striptitle { font-family: 'Poppins', Georgia, serif; margin-top: calc(12px + ${(spread * 12).toFixed(0)}px); }
.spread .strip { padding: calc(11px + ${(spread * 10).toFixed(0)}px) 6px; }
.spread .strip .sv { font-size: calc(23px + ${(spread * 8).toFixed(0)}px); }
.spread .strip .sl { font-size: calc(8.5px + ${(spread * 1.5).toFixed(0)}px); }
.spread .keytitle { font-family: 'Poppins', Georgia, serif; margin-top: calc(8px + ${(spread * 8).toFixed(0)}px); }
.spread .key { font-size: calc(9.2px + ${(spread * 1.8).toFixed(0)}px); line-height: calc(1.5 + ${(spread * 0.4).toFixed(2)}); }
.spread .grid { margin-top: calc(8px + ${(spread * 10).toFixed(0)}px); row-gap: calc(10px + ${(spread * 8).toFixed(0)}px); }
.spread .panel { padding: calc(11px + ${(spread * 8).toFixed(0)}px) 13px calc(8px + ${(spread * 8).toFixed(0)}px); }
.spread .ptitle { font-family: 'Poppins', Georgia, serif; font-size: calc(12.5px + ${(spread * 2.5).toFixed(0)}px); margin-bottom: calc(7px + ${(spread * 5).toFixed(0)}px); }
.spread .sr { padding-top: calc(3.2px + ${(spread * 4.5).toFixed(1)}px); padding-bottom: calc(3.2px + ${(spread * 4.5).toFixed(1)}px); font-size: calc(13px + ${(spread * 2).toFixed(0)}px); }
.spread .sg.splitrow { font-size: calc(13px + ${(spread * 2).toFixed(0)}px); }
.spread .logwrap { margin-top: calc(8px + ${(spread * 12).toFixed(0)}px); }
.spread h2 { font-size: calc(16px + ${(spread * 4).toFixed(0)}px); margin-bottom: calc(5px + ${(spread * 6).toFixed(0)}px); padding-bottom: calc(4px + ${(spread * 3).toFixed(0)}px); }
.spread table { font-size: calc(11.5px + ${(spread * 3).toFixed(0)}px); }
.spread th { font-size: calc(7.5px + ${(spread * 1.5).toFixed(0)}px); padding: calc(7px + ${(spread * 5).toFixed(0)}px) 4px; }
.spread td { padding: calc(5.6px + ${(spread * 12).toFixed(0)}px) 4px; }
.spread tr.totlab td { padding-top: calc(3px + ${(spread * 4).toFixed(0)}px); }
` : ''}
tr.totlab td { color: #33205e; font-size: 8px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; border-bottom: none; padding-top: 4px; }
</style></head>
<body><div class="page${compact ? ' compact' : ''}${spread > 0 ? ' spread' : ''}">
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
    <h1 style="font-size: ${Math.round(35 * Math.min(1, 16 / DATA.name.length) * 10) / 10}px; white-space: nowrap;">${esc(DATA.name.toUpperCase())}</h1>
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
${keyRow}<div class="grid">${panels}</div>
<div class="logwrap">
<h2>${esc(DATA.logTitle)}</h2>
${compact
  ? `<div class="log2col">${logTable(DATA.log.slice(0, Math.ceil(DATA.log.length / 2)), false)}${logTable(DATA.log.slice(Math.ceil(DATA.log.length / 2)), true)}</div>`
  : `<table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}<tr class="tot">${totCells}</tr><tr class="totlab">${labCells}</tr></tbody></table>`}
</div>
</div><script>window.addEventListener('load',function(){document.title=String(document.querySelector('.page').scrollHeight)})</script></body></html>`;
return html;
}

// Auto-fit: measure content height at spread 0 and 1, then pick the spread that fills the page
// exactly down to the bottom padding (no clipped content, no blank bottom).
function heightOf(htmlStr, tag) {
  const f = path.join(require('os').tmpdir(), `psc-${process.pid}-${tag}.html`);
  // measure natural content height: unpin the fixed page height so scrollHeight reports content
  fs.writeFileSync(f, htmlStr.replace('</style>', '.page{height:auto !important;}\n</style>'));
  const dom = execFileSync(findChromium(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=5000', '--dump-dom', 'file://' + path.resolve(f)], { encoding: 'utf8', maxBuffer: 1 << 26 });
  try { fs.unlinkSync(f); } catch (e) {}
  const m = dom.match(/<title>(\d+)<\/title>/);
  return m ? +m[1] : 0;
}
const TARGET = 1010;  // 1056 - 46px bottom padding
let cmp;
let h0 = heightOf(buildHtml(0), 's0');
if (h0 > TARGET) {  // doesn't fit at natural size: fall back to the compact two-column log
  cmp = true;
  h0 = heightOf(buildHtml(0, true), 's0c');
}
let sp = 0;
if (h0 < TARGET && h0 > 0) {
  const h1 = heightOf(buildHtml(1, cmp), 's1');
  if (h1 <= TARGET) { sp = 1; }  // even max spread under-fills: use it, space-between does the rest
  else {
    // growth vs spread is nonlinear (rows/panels wrap at thresholds): binary search the best fit
    let lo = 0, hi = 1;
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      if (heightOf(buildHtml(mid, cmp), 'bs' + i) <= TARGET) { sp = mid; lo = mid; } else { hi = mid; }
    }
  }
}
const html = buildHtml(sp, cmp);

fs.mkdirSync(OUT_DIR, { recursive: true });
const stem = stemArg || path.join(OUT_DIR, DATA.name + ' - 2026 Summer Stats');
const tmp = path.join(require('os').tmpdir(), 'player-season-card-' + Date.now() + '.html');
fs.writeFileSync(tmp, html);
const out = stem.endsWith('.pdf') ? stem : stem + '.pdf';
execFileSync(findChromium(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', '--print-to-pdf=' + out, 'file://' + path.resolve(tmp)], { stdio: 'ignore' });
try { fs.unlinkSync(tmp); } catch (e) {}
console.log('wrote ' + out);
