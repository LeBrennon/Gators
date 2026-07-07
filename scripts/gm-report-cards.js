#!/usr/bin/env node
/*
 * GM Report Cards — renders the shareable GM game report in TWO layouts from
 * ONE game-data block, so both carry identical content, formatted differently:
 *
 *   • Computer version — letter, two-column, branded  → <stem>-computer.pdf
 *   • Mobile version    — one column, large text       → <stem>-mobile.png + .pdf
 *
 * Both use the club branding (croc-skin header, gold border, matched purples
 * #4e3191 dark / #714ad2 accent, red LOSS / green WIN badge).
 *
 * This is a hand-fed renderer: fill in the DATA block below from the game's
 * box score (scripts/postgame-report.js prints most of these numbers, and
 * /api/boxscore?id=<id> on the live site has the line score + box). It exists
 * because the daily seed lags a game, so on game night postgame-report.js
 * can't resolve the just-finished game yet — this renders straight from the
 * facts you paste in.
 *
 *   node scripts/gm-report-cards.js                 # both versions -> reports/postgame/
 *   node scripts/gm-report-cards.js /path/stem      # custom output stem
 *
 * The mobile PDF is measured to a single continuous page (no page break that
 * would slice a card). Requires Chromium (CHROMIUM_PATH or /opt/pw-browsers).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Args: an optional output stem (positional) and an optional `--data <file>`
// (or CARD_DATA_IN env) pointing at a JSON block emitted by
// scripts/postgame-report.js. With it, the cards render from that game's real
// facts instead of the hand-fed DEFAULT_DATA below — this is what the game-final
// workflow uses to auto-build the cards. Without it, the DEFAULT_DATA renders.
const _argv = process.argv.slice(2);
const _di = _argv.indexOf('--data');
const DATA_PATH = _di >= 0 ? _argv[_di + 1] : (process.env.CARD_DATA_IN || '');
if (_di >= 0) _argv.splice(_di, 2);              // drop the flag + its value
const stemArg = _argv.find(a => a && !a.startsWith('--'));

// ===========================================================================
// GAME DATA — replace this block for each game. Everything below is generic.
// (Values shown are the Jun 30, 2026 @ Brazos Valley report.)
// ===========================================================================
const DEFAULT_DATA = {
  fileStem: '06-30 LCGG @ BVB - GM Report',   // output filename stem
  date: 'Jun 30',
  headline: 'Jun 30 @ Brazos',                 // shown big in the header band
  oppName: 'Brazos Valley Bombers',
  sub: 'Road · 2nd-half opener · Record 0–1',
  result: 'LOSS',                              // 'WIN' | 'LOSS' | 'PLAYED'
  gatorScore: 3,
  oppScore: 9,
  lineScore: {
    // inning runs; use '–' where a team did not bat (home team, walk-off, etc.)
    gators: { name: 'Gators', inns: [0, 2, 0, 0, 0, 0, 0, 0, 1], r: 3, h: 4, e: 1 },
    opp: { name: 'Bombers', inns: [0, 1, 0, 1, 5, 0, 0, 2, '–'], r: 9, h: 10, e: 0 },
  },
  offense: [['.154', 'AVG'], ['4', 'Hits'], ['2', 'RBI'], ['10', 'Walks'], ['5', 'K'], ['9', 'Left On']],
  pitching: [['8.0', 'IP'], ['10', 'Hits'], ['9', 'Runs'], ['6', 'Walks'], ['4', 'K'], ['54%', 'Strike']],
  recap: [
    `The Gumbeaux Gators opened the second half with a <b>3–9 loss</b> at Brazos Valley. They jumped ahead <b>2–0</b> in the 2nd — Nathan McDonald doubled home Jaxon Landreneau and Andrew Ramos added a sacrifice fly — but the lead didn't hold.`,
    `Brazos tied it by the 4th and blew it open with a <b>five-run 5th</b> (RBI singles by Derrick Mitchell and Matt Scott around a three-run Kason Atkins double). Tiger Donnato's two-run homer in the 8th put it away.`,
  ],
  stoodOut: [
    `<b>On base in bulk, no payoff.</b> 10 walks and only 4 hits — the Gators put 14 men on, left 9 stranded, and scored 3. The first-half on-base-without-power signature in one night. Griffin Hebert alone walked 4 times.`,
    `<b>Ran into outs on the bases.</b> Three Gators were caught stealing — Ayden Sunday in the 2nd, then James Reina and Griffin Hebert in the same 3rd — wiping out baserunners a 10-walk night could least afford.`,
    `<b>The 5th decided it.</b> Tied 2–2 through four, Landon Richards gave up a five-spot — back-to-back RBI singles and a three-run Atkins double. That one inning was the game.`,
    `<b>Command wobbled.</b> The staff walked 6 — Corrales issued 4 over his four innings and Richards 2 more in his lone inning. Cannon Faulk was the exception: no walks over his 3.`,
    `<b>Atkins was the difference.</b> 3-for-3, 5 RBI (sac fly, RBI single, 3-run double). With Donnato's 2-run homer, two hitters drove in 7 of Brazos' 9.`,
  ],
  keyHitters: [
    `<b>Nathan McDonald</b> (C) — 1-for-3, RBI double; drove in the first run.`,
    `<b>Griffin Hebert</b> (DH) — 0-for-1 but reached base 4 times on walks; scored the Gators' final run in the 9th.`,
    `<b>James Reina</b> (SS) — 1-for-3 with a walk; .295 on the year.`,
    `<b>Bankston Lembcke</b> (3B) — 1-for-4 but left 4 on base; a top bat (.304) caught in the traffic jam.`,
  ],
  onMound: [
    `<b>Diego Corrales</b> (SP) — 4.0 IP, 3 H, 2 R (1 ER), 4 BB, 2 K, 64 pitches (53% strikes). Kept it even through four.`,
    `<b>Landon Richards</b> (RP) — 1.0 IP, 3 H, 5 R/ER, 2 BB, 1 K, 28 pitches. Came on for the 5th and never got out of it — the five-run rally that decided the game.`,
    `<b>Cannon Faulk</b> (RP) — 3.0 IP, 4 H, 2 R/ER, 0 BB, 1 K, 35 pitches (66% strikes). Steadied the staff over the last three; Donnato's 8th-inning homer was the only damage.`,
  ],
  season: `Second-half opener; the Gators fall to <b>0–1</b> in the second half (<b>12–12</b> overall). The 10-walk, 4-hit night mirrors the first half's on-base-without-power profile — the offense that led the league in walks needs the big hit to follow the traffic.`,
};

// ===========================================================================
// Generic rendering below — no per-game edits needed.
// ===========================================================================
const DATA = DATA_PATH ? JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) : DEFAULT_DATA;
const ROOT = path.join(__dirname, '..');
const b64 = (f, m) => 'data:' + m + ';base64,' + fs.readFileSync(path.join(ROOT, f)).toString('base64');
const logo = b64('gators-logo.png', 'image/png');
const croc = b64('bg-tile.jpg', 'image/jpeg');
const esc = s => String(s == null ? '' : s).replace(/&(?!amp;|lt;|gt;)/g, '&amp;'); // keep inline <b>
const badgeColor = { WIN: '#1f9d57', LOSS: '#c0392b', PLAYED: '#714ad2' }[DATA.result] || '#714ad2';

function findChromium() {
  const cands = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  try { const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'; for (const d of fs.readdirSync(base)) { const p = path.join(base, d, 'chrome-linux', 'chrome'); if (fs.existsSync(p)) return p; } } catch (e) {}
  throw new Error('No Chromium found. Set CHROMIUM_PATH.');
}
const BIN = findChromium();

const lsHead = `<tr class='hd'><th class='tm'></th>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => `<th>${i}</th>`).join('')}<th class='sep'>R</th><th>H</th><th>E</th></tr>`;
const lsRow = t => `<tr><th class='tm'>${esc(t.name)}</th>${t.inns.map(v => `<td>${v}</td>`).join('')}<td class='sep tot'>${t.r}</td><td class='tot'>${t.h}</td><td class='tot'>${t.e}</td></tr>`;
const lineScoreTable = `<table>${lsHead}${lsRow(DATA.lineScore.gators)}${lsRow(DATA.lineScore.opp)}</table>`;
const band = h1size => `<div class='band'><img src='${logo}'><div><div class='k'>Gumbeaux Gators · Game Report</div><h1 style='font-size:${h1size}'>${esc(DATA.headline)}</h1><div class='sub'>${esc(DATA.sub)}</div></div><div class='badge'><div class='r'>${esc(DATA.result)}</div><div class='sc'>${DATA.gatorScore}–${DATA.oppScore}</div></div></div>`;

// ---- MOBILE (one column, large text) --------------------------------------
function mobileHtml(pageHpx) {
  const W = 1080;
  const tile = ([v, k]) => `<div class='st'><b>${esc(v)}</b><span>${esc(k)}</span></div>`;
  const ul = arr => `<ul>${arr.map(t => `<li>${t}</li>`).join('')}</ul>`;
  const sec = (title, inner) => `<div><div class='slab'>${esc(title)}</div>${inner}</div>`;
  return `<!doctype html><html><head><meta charset='utf-8'><style>
@page{size:${W}px ${pageHpx}px;margin:0;}
*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
html,body{width:${W}px;}
body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1b1e27;background:#fff;padding:34px;display:flex;flex-direction:column;gap:24px;}
.band{color:#fff;border-radius:26px;border:5px solid #ecc913;padding:38px 40px;display:flex;align-items:center;gap:28px;background:linear-gradient(rgba(22,16,43,.02),rgba(22,16,43,.16)),url('${croc}') center/cover no-repeat;background-color:#4e3191;box-shadow:0 6px 22px rgba(78,49,145,.32);}
.band img{width:118px;height:118px;flex:none;}
.band .k{font-size:24px;letter-spacing:.16em;font-weight:800;color:#ffd633;text-transform:uppercase;text-shadow:0 1px 2px rgba(0,0,0,.5);}
.band h1{font-weight:900;line-height:1.02;margin:6px 0 8px;text-shadow:0 2px 4px rgba(0,0,0,.55);}
.band .sub{font-size:27px;font-weight:700;color:#efe7ff;text-shadow:0 1px 2px rgba(0,0,0,.5);}
.badge{margin-left:auto;text-align:center;flex:none;}
.badge .r{display:inline-block;background:${badgeColor};color:#fff;font-weight:900;font-size:34px;letter-spacing:.04em;padding:8px 26px;border-radius:12px;}
.badge .sc{font-size:70px;font-weight:900;margin-top:10px;line-height:1;}
.slab{font-size:28px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#fff;padding:13px 24px;border-radius:16px 16px 0 0;background:linear-gradient(rgba(22,16,43,.02),rgba(22,16,43,.16)),url('${croc}') center/cover no-repeat;background-color:#4e3191;}
.card{background:#faf9fe;border:2px solid #e6def7;border-top:none;border-radius:0 0 16px 16px;padding:26px 30px;}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;background:#e6def7;border:2px solid #e6def7;border-top:none;border-radius:0 0 16px 16px;overflow:hidden;}
.st{text-align:center;padding:22px 4px;background:#f7f4fd;}
.st b{display:block;font-size:52px;font-weight:900;color:#4e3191;line-height:1;}
.st span{display:block;font-size:22px;text-transform:uppercase;letter-spacing:.03em;color:#6b5ba0;font-weight:800;margin-top:9px;}
.ls{border:2px solid #e6def7;border-top:none;border-radius:0 0 16px 16px;overflow:hidden;}
.ls table{width:100%;border-collapse:collapse;font-size:31px;font-weight:700;color:#1b1e27;}
.ls th,.ls td{padding:16px 0;text-align:center;background:#f7f4fd;}
.ls .hd th{background:#efeafb;color:#6b5ba0;font-size:24px;font-weight:800;}
.ls .tm{text-align:left;padding-left:24px;width:206px;font-size:29px;font-weight:900;color:#4e3191;}
.ls .sep{border-left:3px solid #cdbff0;}
.ls .tot{color:#4e3191;font-weight:900;}
.ls tr+tr th,.ls tr+tr td{border-top:2px solid #eceaf6;}
.recap{font-size:39px;line-height:1.5;font-weight:600;}
.recap p+p{margin-top:20px;}
.recap b,.st b{color:#4e3191;}
ul{list-style:none;display:flex;flex-direction:column;gap:22px;}
li{position:relative;padding-left:42px;font-size:36px;line-height:1.42;font-weight:600;}
li:before{content:'';position:absolute;left:0;top:14px;width:20px;height:20px;border-radius:6px;background:#714ad2;}
li b{color:#4e3191;font-weight:900;}
</style></head><body>
${band('62px')}
${sec('Line Score', `<div class='ls'>${lineScoreTable}</div>`)}
${sec('Offense', `<div class='grid'>${DATA.offense.map(tile).join('')}</div>`)}
${sec('Pitching', `<div class='grid'>${DATA.pitching.map(tile).join('')}</div>`)}
${sec('Recap', `<div class='card recap'>${DATA.recap.map(p => `<p>${p}</p>`).join('')}</div>`)}
${sec('What Stood Out', `<div class='card'>${ul(DATA.stoodOut)}</div>`)}
${sec('Key Hitters', `<div class='card'>${ul(DATA.keyHitters)}</div>`)}
${sec('On the Mound', `<div class='card'>${ul(DATA.onMound)}</div>`)}
${sec('Season Context', `<div class='card recap'><p>${DATA.season}</p></div>`)}
</body></html>`;
}

// ---- COMPUTER (letter, two column) ----------------------------------------
function computerHtml() {
  const tiles = arr => `<div class='tiles'>${arr.map(([k, v]) => `<div class='st'><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}</div>`;
  const strip = (label, arr) => `<div class='strip'><div class='slab'>${esc(label)}</div>${tiles(arr)}</div>`;
  const ul = arr => `<ul>${arr.map(t => `<li>${t}</li>`).join('')}</ul>`;
  const blk = (title, inner) => `<div class='blk'><h2>${esc(title)}</h2>${inner}</div>`;
  return `<!doctype html><html><head><meta charset='utf-8'><style>
@page{size:letter;margin:0;}
*{box-sizing:border-box;margin:0;padding:0;}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{font-family:Georgia,'Times New Roman',serif;color:#1b1e27;font-size:13px;line-height:1.55;padding:24px 40px;min-height:100vh;display:flex;flex-direction:column;}
.band{display:flex;align-items:center;gap:16px;color:#fff;padding:18px 22px;border-radius:12px;border:2px solid #ecc913;background:linear-gradient(rgba(22,16,43,.02),rgba(22,16,43,.16)),url('${croc}') center center / cover no-repeat;background-color:#4e3191;box-shadow:0 4px 14px rgba(78,49,145,.3),inset 0 0 0 1px rgba(255,255,255,.08);}
.band img{width:62px;height:62px;}
.k{font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:#ffd633;font-weight:800;text-shadow:0 1px 2px rgba(0,0,0,.5);}
.band h1{font-family:'Helvetica Neue',Arial,sans-serif;font-weight:900;line-height:1.08;margin:2px 0;text-shadow:0 2px 4px rgba(0,0,0,.55);}
.band .sub{font-family:Arial,sans-serif;font-size:12px;font-weight:700;color:#efe7ff;text-shadow:0 1px 2px rgba(0,0,0,.5);}
.badge{margin-left:auto;text-align:center;font-family:'Helvetica Neue',Arial,sans-serif;}
.badge .r{display:inline-block;background:${badgeColor};color:#fff;font-weight:900;font-size:15px;letter-spacing:.04em;padding:5px 17px;border-radius:6px;}
.badge .sc{font-size:26px;color:#fff;margin-top:4px;font-weight:900;}
.ls{margin-top:10px;border:1px solid #e6def7;border-radius:8px;overflow:hidden;}
.ls table{width:100%;border-collapse:collapse;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:700;}
.ls th,.ls td{padding:7px 0;text-align:center;background:#f7f4fd;}
.ls .hd th{background:#efeafb;color:#6b5ba0;font-size:11px;font-weight:800;}
.ls .tm{text-align:left;padding-left:14px;width:120px;font-weight:900;color:#4e3191;}
.ls .sep{border-left:2px solid #cdbff0;}
.ls .tot{color:#4e3191;font-weight:900;}
.ls tr+tr th,.ls tr+tr td{border-top:1px solid #eceaf6;}
.strips{display:flex;gap:12px;margin-top:10px;}
.strip{flex:1;}
.slab{font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#fff;padding:6px 12px;border-radius:7px 7px 0 0;background:linear-gradient(rgba(22,16,43,.02),rgba(22,16,43,.16)),url('${croc}') center/cover no-repeat;background-color:#4e3191;}
.tiles{display:flex;border:1px solid #e6def7;border-top:none;border-radius:0 0 7px 7px;overflow:hidden;}
.st{flex:1;text-align:center;padding:11px 2px;background:#f7f4fd;border-right:1px solid #e6def7;}
.st:last-child{border-right:none;}
.st b{display:block;font-family:'Helvetica Neue',Arial,sans-serif;font-size:21px;color:#4e3191;}
.st span{display:block;font-family:Arial,sans-serif;font-size:8.5px;text-transform:uppercase;letter-spacing:.02em;color:#6b5ba0;font-weight:700;margin-top:2px;}
.cols{column-count:2;column-gap:26px;margin-top:12px;flex:1 0 auto;}
.blk{break-inside:avoid;margin-bottom:13px;}
h2{font-family:'Helvetica Neue',Arial,sans-serif;font-size:12.5px;text-transform:uppercase;letter-spacing:.1em;color:#714ad2;font-weight:800;border-bottom:2px solid #714ad2;padding-bottom:4px;margin-bottom:8px;}
p{margin:6px 0;}
ul{list-style:none;}
li{position:relative;padding:5.5px 0 5.5px 16px;border-bottom:1px solid #eee;}
li:last-child{border-bottom:none;}
li:before{content:'';position:absolute;left:0;top:12px;width:7px;height:7px;border-radius:2px;background:#714ad2;}
b{color:#4e3191;}
</style></head><body>
${band('27px')}
<div class='ls'>${lineScoreTable}</div>
<div class='strips'>${strip('Offense', DATA.offense)}${strip('Pitching', DATA.pitching)}</div>
<div class='cols'>
${blk('Recap', DATA.recap.map(p => `<p>${p}</p>`).join(''))}
${blk('What Stood Out', ul(DATA.stoodOut))}
${blk('Key Hitters', ul(DATA.keyHitters))}
${blk('On the Mound', ul(DATA.onMound))}
${blk('Season Context', `<p>${DATA.season}</p>`)}
</div>
</body></html>`;
}

function screenshot(htmlPath, out, w, h) {
  execFileSync(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', `--screenshot=${out}`, `--window-size=${w},${h}`, 'file://' + htmlPath], { stdio: 'ignore' });
}
function printPdf(htmlPath, out) {
  execFileSync(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${out}`, 'file://' + htmlPath], { stdio: 'ignore' });
}
// Measure rendered body height at width W via --dump-dom (a trailing script
// stamps scrollHeight into <title>). No image libraries needed.
function measureHeight(html, W) {
  const probe = html.replace('</body>', `<script>document.title=document.body.scrollHeight</script></body>`);
  const tmp = path.join(OUTDIR, '.probe.html');
  fs.writeFileSync(tmp, probe);
  const dom = execFileSync(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--dump-dom', `--window-size=${W},200`, 'file://' + path.resolve(tmp)], { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  const m = dom.match(/<title>(\d+)<\/title>/);
  if (!m) throw new Error('could not measure mobile height');
  return parseInt(m[1], 10);
}

const OUTDIR = stemArg ? path.dirname(path.resolve(stemArg)) : path.join(ROOT, 'reports', 'postgame');
const STEM = stemArg ? path.resolve(stemArg) : path.join(OUTDIR, DATA.fileStem);
if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

// Computer version
{
  const html = computerHtml();
  const tmp = STEM + '.computer.html';
  fs.writeFileSync(tmp, html);
  printPdf(path.resolve(tmp), STEM + ' (Computer).pdf');
  if (!process.env.KEEP_HTML) fs.unlinkSync(tmp);
}
// Mobile version — measure, screenshot tight, print single-page PDF with slack
{
  const W = 1080, SLACK = 80;
  const H = measureHeight(mobileHtml(3000), W);
  const shotHtml = STEM + '.mobile.html';
  fs.writeFileSync(shotHtml, mobileHtml(H + SLACK));
  screenshot(path.resolve(shotHtml), STEM + ' (Mobile).png', W, H + 6);
  printPdf(path.resolve(shotHtml), STEM + ' (Mobile).pdf');
  fs.unlinkSync(shotHtml);
}
console.log('Wrote to ' + OUTDIR + ':');
console.log('  ' + DATA.fileStem + ' (Computer).pdf');
console.log('  ' + DATA.fileStem + ' (Mobile).png');
console.log('  ' + DATA.fileStem + ' (Mobile).pdf');
