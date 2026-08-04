// Shared print renderer for the one-page-per-side player season cards.
//
// Both card templates (player-season-card-batter.js for hitters,
// player-season-card.js for pitchers) carry nothing but a DATA block and a call
// into here — scripts/render-batch.py splices DATA in and runs the template, so
// the layout lives in exactly one place and the two sides cannot drift apart.
//
// The card is TWO letter pages:
//   page 1 — identity band, profile row, season-totals strip, and every stat
//            panel. Nothing competes with the log for room, so the type is set
//            as large as the page allows.
//   page 2 — the game-by-game log, full width, one row per game.
// Each page auto-fits independently: page 1 binary-searches a "spread" factor
// that loosens padding and type until it fills the page, page 2 searches a
// scale factor on the table. Neither is allowed to overflow.
//
// Club branding per docs/HANDOFF.md: croc-skin bands (hue-locked to the #4e3191
// family via scripts/assets/croc-band.jpg), gold border, purples #4e3191 dark /
// #714ad2 accent, gold #ecc913.
//
// Requires Chromium (CHROMIUM_PATH, /opt/pw-browsers, a Playwright install, or
// Mac Chrome). No other dependencies.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'reports', 'players');
const TARGET = 1010;   // 1056px letter page minus the 46px bottom padding

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

// A wide row is hoisted out of its panel into a full-width panel of its own, so
// the half panels keep their 2x2 pairing. An untagged one is a platoon split;
// "wide:TITLE" opens a panel with that title (batted ball, count splits).
const wideTitle = w => { const s = String(w || ''); return s.includes(':') ? s.slice(s.indexOf(':') + 1) : 'PLATOON SPLITS'; };

function render(DATA, stemArg) {
  const logo = b64('gg-logo.png', 'image/png');
  const croc = b64('scripts/assets/croc-band.jpg', 'image/jpeg');   // hue-locked croc band
  const tcl = b64('scripts/assets/tcl-logo-transparent.png', 'image/png');
  const photo = findPhoto(DATA.photoSlug || (DATA.name || '').toLowerCase().replace(/[^a-z]/g, ''));
  const fPop7 = b64('scripts/assets/fonts/poppins-700.ttf', 'font/ttf');
  const fPop8 = b64('scripts/assets/fonts/poppins-800.ttf', 'font/ttf');
  const fLek = b64('scripts/assets/fonts/leckerli-one-400.ttf', 'font/ttf');

  // Relievers never start — hide the GS tile entirely when it's 0.
  const seasonTiles = DATA.season.filter(([k, v]) => !(k === 'GS' && String(v) === '0'))
    .map(([k, v]) => `<div class="stat"><div class="sv">${esc(v)}</div><div class="sl">${esc(k)}</div></div>`).join('');
  const keyRow = (DATA.key || []).length
    ? `<div class="keytitle">Advanced Metrics Key</div><div class="key">` +
      DATA.key.map(([a, m]) => `<span class="ki"><b>${esc(a)}</b> ${esc(m)}</span>`).join('<span class="ksep">&middot;</span> ') + `</div>`
    : '';
  // Every panel's legend is hoisted into one full-width key block at the foot of
  // the page. Four ragged blocks inside half-width panels cost far more height
  // than one paragraph that wraps across the whole page, and that height is what
  // sets how large the numbers can be printed.
  const legends = [];
  const mkPanel = ([title, rows, legend]) => {
    if (legend) legends.push([title, legend]);
    return `<div class="panel"><div class="ptitle">${esc(title)}</div>` +
    `<div class="sg">` +
    rows.map(([l, v, w, sub]) =>
      `<div class="sr"><span class="sl2">${esc(l)}</span>` +
      (sub
        ? `<span class="sv2sub"><span class="sv2">${esc(v)}</span><span class="svsub">${esc(sub)}</span></span>`
        : `<span class="sv2">${esc(v)}</span>`) +
      `</div>`).join('') +
    `</div></div>`;
  };

  const halfGroups = []; const wideGroups = new Map();
  (DATA.groups || []).forEach(g => {
    const half = [];
    g[1].forEach(r => {
      if (!String(r[2] || '').startsWith('wide')) { half.push(r); return; }
      const t = wideTitle(r[2]);
      if (!wideGroups.has(t)) wideGroups.set(t, []);
      wideGroups.get(t).push(r);
    });
    if (half.length) halfGroups.push([g[0], half, g[2]]);
  });
  // Hitters: synthesize a Total split row from the season tiles (pitchers already have one)
  const seasonMap = Object.fromEntries(DATA.season || []);
  const splitRows = wideGroups.get('PLATOON SPLITS') || [];
  if (splitRows.length && !splitRows.some(r => /^Total/.test(r[0])))
    splitRows.unshift([`Total (${seasonMap['PA'] || ''} PA)`, `${seasonMap['AVG']}/${seasonMap['OBP']}/${seasonMap['SLG']}`,
                       'wide', `AVG · OBP · SLG — OPS ${seasonMap['OPS']}`]);
  // Order: Total, then RH side, then LH side
  const splitOrder = r => (/^Total/.test(r[0]) ? 0 : r[0].includes('RH') ? 1 : 2);
  splitRows.sort((a, b) => splitOrder(a) - splitOrder(b));
  // Horizontal cells stretch the rows across the full panel width. Platoon
  // splits read label-then-slash-line on one line; the shorter buckets stack so
  // five of them still fit across the page.
  const mkWidePanel = (title, rows) =>
    `<div class="panel full"><div class="ptitle">${esc(title)}</div>` +
    `<div class="sg splitrow${title === 'PLATOON SPLITS' ? '' : ' stack'}">` +
    rows.map(([l, v, , sub]) =>
      `<div class="splitcell"><span class="sl2">${esc(l)}</span><span class="sv2sub"><span class="sv2">${esc(v)}</span>` +
      (sub ? `<span class="svsub">${esc(sub)}</span>` : '') + `</span></div>`).join('') +
    `</div></div>`;

  const units = halfGroups.map(g => ({ html: mkPanel(g), full: false }));
  if (splitRows.length) units.splice(Math.min(2, units.length), 0, { html: mkWidePanel('PLATOON SPLITS', splitRows), full: true });
  for (const [t, rows] of wideGroups) if (t !== 'PLATOON SPLITS') units.push({ html: mkWidePanel(t, rows), full: true });
  let panels = '';
  for (let i = 0; i < units.length;) {
    if (units[i].full) { panels += `<div class="prow">${units[i].html}</div>`; i++; }
    else if (i + 1 < units.length && !units[i + 1].full) { panels += `<div class="prow">${units[i].html}${units[i + 1].html}</div>`; i += 2; }
    else { panels += `<div class="prow">${units[i].html}</div>`; i++; }
  }
  const legendBlock = legends.length
    ? `<div class="legends">` + legends.map(([t, l]) =>
        `<span class="lgrp"><b>${esc(t)}</b> ` +
        l.split(' · ').map(d => `<span class="ld">${esc(d)}</span>`).join('<span class="lsep">·</span> ') +
        `</span>`).join('') + `</div>`
    : '';

  // Columns up to and including Result are text, left-aligned, and carry no
  // label in the repeated header under the totals. Count them rather than
  // assuming three — a card spanning two clubs adds a Tm column, and hardcoding
  // the count left "RESULT" printed as a stat label on Matt Scott's card.
  const lead = (DATA.logCols.findIndex(c => /^Res/.test(c)) + 1) || 3;
  const headCells = DATA.logCols.map((c, i) => `<th${i < lead ? ' class="l"' : ''}>${esc(c)}</th>`).join('');
  const bodyRows = DATA.log.map(r => '<tr>' + r.map((v, i) => {
    if (i < lead - 1) return `<td class="l">${esc(v)}</td>`;
    if (i === lead - 1) return `<td class="l res">${esc(v)}</td>`;
    if (i === r.length - 1) return `<td><b>${esc(v)}</b></td>`;
    return `<td>${esc(v)}</td>`;
  }).join('') + '</tr>').join('');
  const labCells = DATA.logCols.map((c, i) => i < lead ? '<td></td>' : `<td>${esc(c)}</td>`).join('');
  const totCells = DATA.totals.map((v, i) => {
    if (i < lead) return `<td class="l">${esc(v)}</td>`;
    if (i === DATA.totals.length - 1) return `<td><b>${esc(v)}</b></td>`;
    return `<td>${esc(v)}</td>`;
  }).join('');

  // sp scales the stat panels on page 1; f and p scale the log's type and row
  // height on page 2. All three are plain multipliers on a comfortable base
  // size, so a page that runs long shrinks and a page with room to spare grows.
  function buildHtml(sp, f, p) {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(DATA.name)} — 2026 Summer Stats</title>
<style>
@font-face { font-family: 'Poppins'; font-weight: 700; src: url(data:font/ttf;base64,${fPop7}) format('truetype'); }
@font-face { font-family: 'Poppins'; font-weight: 800; src: url(data:font/ttf;base64,${fPop8}) format('truetype'); }
@font-face { font-family: 'Leckerli One'; font-weight: 400; src: url(data:font/ttf;base64,${fLek}) format('truetype'); }
@page { size: letter; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: "Helvetica Neue", Arial, sans-serif; color: #020200; }
.page { width: 816px; height: 1056px; position: relative; overflow: hidden; background: #f4f2ec; padding-bottom: 46px; display: flex; flex-direction: column; }
.page.p1 { justify-content: space-between; }
.page.p2 { justify-content: flex-start; }
.page + .page { page-break-before: always; break-before: page; }
.page > * { flex-shrink: 0; }
.band { position: relative; height: 118px; overflow: hidden; margin: 18px 45px 0; border-radius: 12px; border: 2.5px solid #ecc913; }
.band img.texture { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 35%; }
.band .shade { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(22,16,43,.38); }
.band .inner { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; padding: 0 30px; }
.band img.mark { width: 102px; height: 102px; object-fit: contain; margin-right: 22px; }
.band .org { font-family: 'Poppins', Georgia, serif; font-weight: 800; font-size: 23px; color: #ffd633; letter-spacing: 1.2px; }
.band .sub { font-family: 'Leckerli One', cursive; font-size: 14px; font-weight: 700; color: #cfc6ea; letter-spacing: 1px; margin-top: 6px; }
/* page 2 repeats the branding in a slimmer band and names the player again */
.band.slim { height: 86px; }
.band.slim img.mark { width: 66px; height: 66px; margin-right: 16px; }
.band.slim .org { font-size: 16.5px; letter-spacing: 1px; }
.band.slim .sub { font-size: 11px; margin-top: 3px; }
.band.slim .who2 { margin-left: auto; text-align: right; }
.band.slim .who2 .nm { font-family: 'Poppins', Georgia, serif; font-weight: 800; font-size: 21px; color: #fff; letter-spacing: .6px; }
.band.slim .who2 .rl { font-size: 10.5px; font-weight: 700; color: #ecc913; letter-spacing: 1.6px; margin-top: 4px; text-transform: uppercase; }
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
.p1 { --s: ${sp.toFixed(3)}; }
.keytitle { font-family: 'Poppins', Georgia, serif; margin: calc(8px * var(--s)) 45px 0; font-size: 8px; font-weight: 800; letter-spacing: 2px; color: #33205e; text-transform: uppercase; }
.key { margin: 2px 45px 0; font-size: calc(9.5px * var(--s)); color: #33205e; line-height: 1.5; }
.key .ki { white-space: nowrap; }
.key .ki b { color: #33205e; letter-spacing: .3px; }
.key .ksep { color: #fcef9d; margin: 0 5px; font-weight: 800; }
.grid { margin: calc(14px * var(--s)) 40px 0; }
.prow { display: flex; margin-bottom: calc(4px * var(--s)); }
.panel { padding: calc(7px * var(--s)) 9px calc(6px * var(--s)); width: 50%; min-width: 0; }
.panel.full { width: 100%; }
.ptitle { font-family: 'Poppins', Georgia, serif; font-size: calc(12px * var(--s)); font-weight: 800; letter-spacing: 1.8px; color: #33205e; border-bottom: 1.5px solid #ecc913; padding-bottom: 4px; margin-bottom: calc(7px * var(--s)); }
/* A legend is one long sentence per panel, so it has to wrap inside its half.
   Its size is deliberately NOT scaled: it is reference text, and letting it
   grow with the panel would take the room away from the numbers. */
.legends { margin: calc(6px * var(--s)) 49px 0; font-size: 8.2px; line-height: 1.55; color: #33205e; }
.legends .lgrp { display: inline; }
.legends .lgrp b { font-family: 'Poppins', Georgia, serif; letter-spacing: .8px; }
.legends .lgrp + .lgrp:before { content: ''; display: block; }
.ld { white-space: nowrap; }
.lsep { color: #ecc913; margin-right: 3px; }
.sg { display: flex; flex-wrap: wrap; }
.sr { width: 50%; display: flex; justify-content: flex-start; gap: 4px; padding: calc(4px * var(--s)) 8px; font-size: calc(14px * var(--s)); }
.sg.splitrow { display: flex; gap: 10px; font-size: calc(14px * var(--s)); }
.splitcell { flex: 1; display: flex; gap: 8px; align-items: flex-start; justify-content: center; padding: calc(4px * var(--s)) 2px; min-width: 0; }
.splitcell .sl2 { min-width: 0; }
/* five count buckets across the page only fit if the label sits above the value */
.sg.splitrow.stack .splitcell { flex-direction: column; align-items: center; gap: 2px; text-align: center; }
.sg.splitrow.stack .sv2sub { align-items: center; }
.sl2 { color: #33205e; font-weight: 700; letter-spacing: .5px; display: inline-block; min-width: calc(62px * var(--s)); white-space: nowrap; }
.sv2 { color: #020200; font-weight: 800; font-variant-numeric: tabular-nums; }
.sv2sub { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.25; }
.svsub { font-size: calc(8px * var(--s)); color: #33205e; font-weight: 700; letter-spacing: 1.1px; }
/* A short log can't fill the page by type alone — a 13-column table runs out of
   width long before it runs out of height. So the log has two scales: --f sizes
   the type up to whatever the page is wide enough for, and --p opens the rows
   up to fill what's left. Whatever slack remains centers the table. */
.logbox { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; }
.logwrap { margin: 16px 45px 0; }
.p2 { --f: ${f.toFixed(3)}; --p: ${p.toFixed(3)}; }
.p2 h2 { font-family: 'Poppins', Georgia, serif; font-size: calc(15px * var(--f)); color: #33205e; border-bottom: 1.9px solid #ecc913; padding-bottom: calc(4px * var(--f)); margin-bottom: calc(6px * var(--f)); }
.p2 table { width: 100%; border-collapse: collapse; font-size: calc(11px * var(--f)); }
.p2 th { background: #33205e; color: #fff; font-size: calc(8px * var(--f)); letter-spacing: .8px; text-transform: uppercase; padding: calc(6px * var(--p)) 4px; text-align: center; }
.p2 th.l, .p2 td.l { text-align: left; }
.p2 td { padding: calc(4.4px * var(--p)) 4px; border-bottom: .9px solid #e5e0f0; text-align: center; font-variant-numeric: tabular-nums; white-space: nowrap; }
.p2 tr:nth-child(even) td { background: #e5e0f0; }
.p2 td.res { font-weight: 700; }
.p2 tr.tot td { background: #33205e; color: #ecc913; font-weight: 800; border-bottom: none; }
.p2 tr.totlab td { color: #33205e; font-size: calc(7.5px * var(--f)); font-weight: 700; letter-spacing: 1px; text-transform: uppercase; border-bottom: none; padding-top: calc(3px * var(--p)); background: none; }
</style></head>
<body>
<div class="page p1">
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
${keyRow}<div class="grid">${panels}</div>${legendBlock}
</div>
<div class="page p2">
<div class="band slim">
  <img class="texture" src="${croc}" alt="">
  <div class="shade"></div>
  <div class="inner">
    <img class="mark" src="${logo}" alt="">
    <div>
      <div class="org">LAKE CHARLES GUMBEAUX GATORS</div>
      <div class="sub">2026 Summer Season &middot; Texas Collegiate League</div>
    </div>
    <div class="who2">
      <div class="nm">${esc(DATA.name.toUpperCase())}</div>
      <div class="rl">#${esc(DATA.num)} &middot; ${esc(DATA.pos)}</div>
    </div>
  </div>
</div>
<div class="logbox"><div class="logwrap">
<h2>${esc(DATA.logTitle)}</h2>
<table>
<thead><tr>${headCells}</tr></thead>
<tbody>${bodyRows}<tr class="tot">${totCells}</tr><tr class="totlab">${labCells}</tr></tbody>
</table>
</div></div>
</div>
<script>window.addEventListener('load',function(){
  var pages=[].slice.call(document.querySelectorAll('.page')).map(function(p){return p.scrollHeight});
  // A table is allowed to grow past its container, so its own scrollWidth never
  // reports the overflow — compare it to the wrapper that is pinned to the page.
  var over=[].slice.call(document.querySelectorAll('table')).some(function(t){
    return t.getBoundingClientRect().width > t.parentElement.clientWidth + 1; });
  document.title=pages.join(',')+','+(over?1:0);
})</script></body></html>`;
  }

  // Auto-fit, in two passes over a headless measuring run:
  //   pass 1 — page 1's panel scale (height) and page 2's type scale (width).
  //            These are independent of each other, so they share the same calls.
  //   pass 2 — page 2's row height, now that the type size is settled.
  function measure(htmlStr, tag) {
    const f = path.join(os.tmpdir(), `psc-${process.pid}-${tag}.html`);
    // unpin the fixed page height so scrollHeight reports natural content height
    fs.writeFileSync(f, htmlStr.replace('</style>', '.page{height:auto !important;}\n</style>'));
    const dom = execFileSync(findChromium(), ['--headless=new', '--no-sandbox', '--disable-gpu',
      '--virtual-time-budget=5000', '--dump-dom', 'file://' + path.resolve(f)], { encoding: 'utf8', maxBuffer: 1 << 26 });
    try { fs.unlinkSync(f); } catch (e) {}
    const m = dom.match(/<title>(\d+),(\d+),(\d)<\/title>/);
    return m ? { h1: +m[1], h2: +m[2], over: m[3] === '1' } : { h1: 0, h2: 0, over: false };
  }

  let sp = 0.5, f = 0.55, p = 0.6;            // known-good floor for both pages
  const floor = measure(buildHtml(sp, f, p), 'floor');
  if (floor.h1 > TARGET) console.error('  WARN: page 1 overflows even at its smallest (' + floor.h1 + 'px)');
  if (floor.h2 > TARGET) console.error('  WARN: page 2 overflows even at its smallest (' + floor.h2 + 'px)');
  // Type size is bounded by BOTH: the page's width (a 13-column log runs out of
  // width first on a short season) and its height (a 44-game log runs out of
  // height first). Measuring at the row floor separates the two — whatever
  // height the type leaves is what pass 2 has to give back to the rows.
  let lo1 = sp, hi1 = 1.9, lo2 = f, hi2 = 1.7;
  for (let i = 0; i < 8; i++) {
    const m1 = (lo1 + hi1) / 2, m2 = (lo2 + hi2) / 2;
    const r = measure(buildHtml(m1, m2, p), 'a' + i);
    if (r.h1 <= TARGET) { sp = m1; lo1 = m1; } else { hi1 = m1; }
    if (!r.over && r.h2 <= TARGET) { f = m2; lo2 = m2; } else { hi2 = m2; }
  }
  // Rows open up to fill what the type left over, but only so far: past this a
  // short log reads as a handful of stripes floating on an empty page, and the
  // leftover space looks better as margin around a centered table.
  let lo3 = p, hi3 = 2.6;
  for (let i = 0; i < 7; i++) {
    const m3 = (lo3 + hi3) / 2;
    if (measure(buildHtml(sp, f, m3), 'b' + i).h2 <= TARGET) { p = m3; lo3 = m3; } else { hi3 = m3; }
  }
  // Last word: a page that still overflows is a page with content cut off it,
  // and the PDF gives no sign of that — it is still two pages. Fail the card.
  const final = measure(buildHtml(sp, f, p), 'final');
  if (final.h1 > TARGET || final.h2 > TARGET || final.over) {
    console.error(`  OVERFLOW ${DATA.name}: page 1 ${final.h1}px, page 2 ${final.h2}px` +
      (final.over ? ', log wider than the page' : '') + ` (limit ${TARGET}px)`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stem = stemArg || path.join(OUT_DIR, DATA.name + ' - 2026 Summer Stats');
  const tmp = path.join(os.tmpdir(), 'player-season-card-' + Date.now() + '.html');
  fs.writeFileSync(tmp, buildHtml(sp, f, p));
  const out = stem.endsWith('.pdf') ? stem : stem + '.pdf';
  execFileSync(findChromium(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer',
    '--print-to-pdf=' + out, 'file://' + path.resolve(tmp)], { stdio: 'ignore' });
  // PSC_KEEP_HTML=1 leaves the rendered HTML next to the PDF — the only way to
  // eyeball the layout in an environment with no PDF viewer.
  if (process.env.PSC_KEEP_HTML) fs.copyFileSync(tmp, out.replace(/\.pdf$/, '.html'));
  try { fs.unlinkSync(tmp); } catch (e) {}
  console.log('wrote ' + out + `  (page 1 ${sp.toFixed(2)}, page 2 type ${f.toFixed(2)} rows ${p.toFixed(2)})`);
}

module.exports = { render };
