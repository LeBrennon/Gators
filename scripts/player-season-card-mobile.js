#!/usr/bin/env node
/*
 * Player Season Card — MOBILE VERSION
 * Same DATA block as player-season-card.js. Renders a responsive HTML page
 * plus a shareable PNG screenshot.
 *
 *   node scripts/player-season-card-mobile.js              # -> reports/players-mobile/
 *   node scripts/player-season-card-mobile.js /path/stem   # custom output stem
 *
 * Outputs: <stem>.html  (responsive web page)
 *          <stem>.png   (1080×1920 screenshot for sharing)
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
    ["APP","7"],["GS","0"],["IP","11.0"],["BF","60"],
    ["ERA","14.73"],["WHIP","2.27"],["FIP","8.83"],
    ["K","3"],["BB","9"],["H","16"]
  ],
  "groups": [
    ["RUN PREVENTION",[
      ["ERA","14.73"],["WHIP","2.27"],["FIP","8.83"],["BABIP",".302"],
      ["AVG",".333","wide"],["OBP",".441","wide","vs LHB .222 / vs RHB .400"],
      ["SLG",".562","wide","vs LHB .444 / vs RHB .633"]
    ]],
    ["COMMAND & RATES",[
      ["K%","5.0"],["BB%","15.0"],["K:BB","0.33"],["FPS%","60.0"],
      ["K/9","2.5"],["BB/9","7.4"],["H/9","13.1"],["P/BF","3.5"]
    ]],
    ["HITTERS AGAINST",[
      ["AB","48"],["2B","2"],["HR","3"],["HBP","1"],
      ["SF","1"],["OPS","1.003"],["ISO",".229"],["P/IP","19.3"]
    ]],
    ["PITCH PROFILE",[
      ["#P","212"],["S%","52"],["GB%","40"],["FB%","36"],
      ["LD%","4"],["PU%","20"],["",""],["",""]
    ]]
  ],
  "key": [
    ["ERA","Earned Run Average"],
    ["WHIP","Walks + Hits per Inning"],
    ["FIP","Fielding Independent Pitching"],
    ["BABIP","Batting Avg on Balls In Play"],
    ["FPS%","First Pitch Strike"],
    ["ISO","Isolated Power"],
    ["K:BB","Strikeout to Walk ratio"]
  ],
  "logTitle": "Game Log — Pitching",
  "logCols": ["Date","Opp","Res","IP","H","R","ER","BB","K","HR","HBP","BF","#P"],
  "log": [
    ["6/4","vs BOM","L 4-10","1.0","3","4","4","2","0","1","0","10","28"],
    ["6/7","vs BUR","L 3-8","1.0","1","1","1","0","0","0","0","5","18"],
    ["6/11","vs WAC","L 6-10","2.0","3","3","3","1","1","0","0","11","38"],
    ["6/15","vs SA","L 5-9","2.0","2","2","2","1","0","0","1","10","32"],
    ["6/19","vs BOM","L 2-14","2.0","3","5","4","2","1","1","0","13","42"],
    ["6/25","vs WAC","L 3-12","1.0","2","2","2","1","0","0","0","6","22"],
    ["7/7","vs BOM","L 1-13","2.0","2","1","1","2","1","1","0","5","32"]
  ],
  "totals": ["Total","0-7","—","11.0","16","19","18","9","3","3","1","60","212"]
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
const croc = b64('scripts/assets/croc-band.jpg', 'image/jpeg');
const photo = findPhoto(DATA.photoSlug || (DATA.name || '').toLowerCase().replace(/[^a-z]/g, ''));

const seasonTiles = DATA.season.filter(([k, v]) => !(k === 'GS' && String(v) === '0')).map(([k, v]) =>
  `<div class="stat"><div class="sv">${esc(v)}</div><div class="sl">${esc(k)}</div></div>`).join('');

const keyRow = (DATA.key || []).length
  ? `<div class="keytitle">Advanced Metrics Key</div><div class="key">` +
    DATA.key.map(([a, m]) => `<span class="ki"><b>${esc(a)}</b> ${esc(m)}</span>`).join('<span class="ksep">&middot;</span> ') +
    `</div>` : '';

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
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>${esc(DATA.name)} — 2026 Summer Stats</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; color: #16102b; background: #f4f2ec; }
.wrap { max-width: 600px; margin: 0 auto; padding: 16px 16px 32px; }

/* Header band */
.band { position: relative; height: 110px; overflow: hidden; border-radius: 14px; border: 2.5px solid #ecc913; margin-bottom: 20px; }
.band img.texture { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 35%; }
.band .shade { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(22,16,43,.42); }
.band .inner { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; padding: 0 18px; }
.band img.mark { width: 80px; height: 80px; object-fit: contain; margin-right: 14px; }
.band .org { font-family: Georgia, serif; font-weight: 800; font-size: 20px; color: #ffd633; letter-spacing: 1px; }
.band .sub { font-size: 10px; color: #cfc6ea; letter-spacing: 2px; text-transform: uppercase; margin-top: 4px; }

/* Identity */
.id { display: flex; gap: 16px; margin-bottom: 20px; align-items: flex-start; }
.id .ph { width: 100px; height: 100px; border-radius: 12px; object-fit: cover; border: 3px solid #ecc913; background: #ddd; flex-shrink: 0; }
.id .who { flex: 1; min-width: 0; }
.id h1 { font-family: Georgia, serif; font-size: 26px; font-weight: 800; color: #4e3191; line-height: 1.1; margin-bottom: 4px; }
.id .role { font-size: 13px; font-weight: 700; color: #714ad2; letter-spacing: 1.2px; margin-bottom: 10px; }
.meta { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; }
.meta div { font-size: 12px; color: #6d6391; line-height: 1.4; }
.meta b { color: #4e3191; font-size: 9px; text-transform: uppercase; letter-spacing: .6px; display: block; margin-bottom: 1px; }

/* Season strip */
.striptitle { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 2px; color: #714ad2; text-transform: uppercase; }
.strip-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -16px 20px; padding: 0 16px; }
.strip { background: #4e3191; border-radius: 12px; padding: 14px 10px; display: inline-flex; gap: 16px; min-width: 100%; border: 2px solid #ecc913; justify-content: space-around; }
.strip .stat { text-align: center; min-width: 52px; }
.strip .sv { font-family: Georgia, serif; font-size: 22px; font-weight: 800; color: #ffd633; }
.strip .sl { font-size: 9px; color: #cfc6ea; letter-spacing: 1px; margin-top: 3px; text-transform: uppercase; }

/* Key */
.keytitle { margin: 0 0 6px; font-size: 9px; font-weight: 800; letter-spacing: 1.8px; color: #714ad2; text-transform: uppercase; }
.key { font-size: 11px; color: #6d6391; line-height: 1.5; margin-bottom: 16px; }
.key .ki { white-space: nowrap; }
.key .ki b { color: #4e3191; letter-spacing: .3px; }
.key .ksep { color: #cfc6ea; margin: 0 4px; font-weight: 800; }

/* Panels */
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
.panel { background: #fff; border-radius: 10px; padding: 12px; border: 1px solid #e5e0f0; }
.ptitle { font-size: 10px; font-weight: 800; letter-spacing: 1.6px; color: #4e3191; border-bottom: 1.5px solid #ecc913; padding-bottom: 5px; margin-bottom: 8px; }
.sg { display: flex; flex-direction: column; gap: 6px; }
.sr { display: flex; justify-content: space-between; align-items: center; font-size: 13px; padding: 3px 0; border-bottom: 1px solid #f4f2ec; }
.sr:last-child { border-bottom: none; }
.sr.w { grid-column: 1 / -1; }
.sl2 { color: #6d6391; font-weight: 700; letter-spacing: .4px; font-size: 11px; }
.sv2 { color: #16102b; font-weight: 800; font-variant-numeric: tabular-nums; font-size: 14px; }
.sv2sub { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.2; }
.svsub { font-size: 9px; color: #6d6391; font-weight: 700; letter-spacing: .8px; margin-top: 1px; }

/* Game log */
h2 { font-family: Georgia, serif; font-size: 16px; color: #4e3191; border-bottom: 2px solid #ecc913; padding-bottom: 5px; margin-bottom: 10px; }
.log-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -16px; padding: 0 16px; }
table { width: 100%; min-width: 640px; border-collapse: collapse; font-size: 12px; background: #fff; border-radius: 10px; overflow: hidden; border: 1px solid #e5e0f0; }
th { background: #4e3191; color: #fff; font-size: 9px; letter-spacing: .7px; text-transform: uppercase; padding: 10px 6px; text-align: right; font-weight: 700; }
th.l, td.l { text-align: left; }
td { padding: 8px 6px; border-bottom: 1px solid #e5e0f0; text-align: right; font-variant-numeric: tabular-nums; }
tr:nth-child(even) td { background: #f9f8f5; }
td.res { font-weight: 700; color: #4e3191; }
tr.tot td { background: #16102b; color: #ffd633; font-weight: 800; border-bottom: none; }
tr.totlab td { color: #714ad2; font-size: 8px; font-weight: 700; letter-spacing: .8px; text-transform: uppercase; border-bottom: none; padding-top: 4px; background: transparent; }

/* Responsive tweaks */
@media (max-width: 480px) {
  .id { flex-direction: column; align-items: center; text-align: center; }
  .id .ph { width: 120px; height: 120px; }
  .meta { grid-template-columns: 1fr 1fr; text-align: left; width: 100%; }
  .grid { grid-template-columns: 1fr; }
  .band .org { font-size: 17px; }
  .band img.mark { width: 64px; height: 64px; }
}
@media (min-width: 481px) and (max-width: 600px) {
  .grid { grid-template-columns: 1fr 1fr; }
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
<div class="strip-scroll"><div class="strip">${seasonTiles}</div></div>
${keyRow}
<div class="grid">${panels}</div>
<h2>${esc(DATA.logTitle)}</h2>
<div class="log-scroll">
<table>
<thead><tr>${headCells}</tr></thead>
<tbody>${bodyRows}<tr class="tot">${totCells}</tr><tr class="totlab">${labCells}</tr></tbody>
</table>
</div>
</div></body></html>`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const stem = stemArg || path.join(OUT_DIR, DATA.name + ' - 2026 Summer Stats (Mobile)');
const tmp = path.join(require('os').tmpdir(), 'player-season-card-mobile-' + Date.now() + '.html');
fs.writeFileSync(tmp, html);

// Write HTML
const outHtml = stem + '.html';
fs.copyFileSync(tmp, outHtml);

// Screenshot PNG at 1080×1920 (9:16 phone aspect) for sharing
const outPng = stem + '.png';
const chromium = findChromium();
execFileSync(chromium, [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  '--window-size=1080,1920',
  '--hide-scrollbars',
  '--screenshot=' + outPng,
  'file://' + path.resolve(tmp)
], { stdio: 'ignore' });

try { fs.unlinkSync(tmp); } catch (e) {}
console.log('wrote ' + outHtml);
console.log('wrote ' + outPng);
