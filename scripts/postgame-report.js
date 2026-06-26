#!/usr/bin/env node
// Post-game report generator for the Gumbeaux Gators — written for the GM.
// Reads like a one-page write-up: a plain-English recap, a few simple charts, and
// clear takeaways. Light on raw numbers by design (the GM wants the story and the
// decisions, not a stat sheet). Reconstructed offline from the daily seed.
//
//   node scripts/postgame-report.js               # latest game -> markdown on stdout
//   node scripts/postgame-report.js "Jun 24"      # a specific date
//   node scripts/postgame-report.js latest --pdf   # branded one-page PDF in reports/postgame/
//   node scripts/postgame-report.js latest --write # also save the markdown there
//
// --pdf renders a Gumbeaux Gators-branded page via the system Chromium.

const fs = require('fs');
const path = require('path');
const S = require('./lib/season');
const { r2, r3, ipStr } = S;

const FLAGS = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const WRITE = FLAGS.has('--write');
const PDF = FLAGS.has('--pdf');
const HTML = FLAGS.has('--html');
const target = args[0] || 'latest';

const game = S.resolveGame(target);
if (!game) { console.error(`No game found for "${target}". Try 'latest', a date like "Jun 24", or a box id.`); process.exit(1); }

const BAT_SEASON = S.indexBySlug(S.batters());
const PIT_SEASON = S.indexBySlug(S.pitchers());
const bat = S.gameBatting(game.id);
const pit = S.gamePitching(game.id);
const T = S.teamSummary(game.id);
const SEASON = S.teamSummary();

const tb = bat.reduce((a, b) => ({ ab: a.ab + b.ab, h: a.h + b.h, hr: a.hr + b.hr, rbi: a.rbi + b.rbi, bb: a.bb + b.bb, k: a.k + b.k }), { ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, k: 0 });
const tp = pit.reduce((a, p) => ({ outs: a.outs + p.outs, h: a.h + p.h, r: a.r + p.r, er: a.er + p.er, bb: a.bb + p.bb, k: a.k + p.k }), { outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0 });

const staffIP = S.pitchers().reduce((a, x) => a + x.outs, 0) / 3;
const staffBB = S.pitchers().reduce((a, x) => a + x.bb, 0);
const staffBB9 = staffIP ? (staffBB * 9) / staffIP : null;
const gameBB9 = tp.outs ? (tp.bb * 27) / tp.outs : null;
const partial = game.win != null && tp.outs > 0 && tp.outs < 18;

// ===========================================================================
// Analytics under the hood — used to WRITE the words, not shown as a stat dump.
// ===========================================================================
const oppName = S.oppShort(game.opp).replace(/^@ /, '');
const list = a => !a.length ? '' : a.length === 1 ? a[0] : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];

// Pythagorean record from run differential — a simple over/under-luck read.
const pythPct = (T.rf || T.ra) ? (T.rf * T.rf) / (T.rf * T.rf + T.ra * T.ra) : 0;
const pythW = Math.round(pythPct * (T.w + T.l)), pythL = (T.w + T.l) - pythW, luck = T.w - pythW;

// Trailing-7-day pitcher workload as of this game.
const gameDayMs = (() => { const m = String(game.id).match(/^(\d{4})(\d{2})(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; })();
function boxDayMs(g) { const m = String(S.boxId(g)).match(/^(\d{4})(\d{2})(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; }
function workload(slug, days) {
  const logs = (S.PC[slug] && S.PC[slug].glPit) || []; let apps = 0, outs = 0;
  if (gameDayMs != null) for (const g of logs) { const d = boxDayMs(g); if (d == null) continue; const ago = (gameDayMs - d) / 864e5; if (ago >= 0 && ago < days) { apps++; outs += S.i3(g.ip); } }
  return { apps, outs };
}
// Plain-English read on a hitter's season.
function formWord(s) {
  if (!s || s.pa < 15) return 'still getting going';
  if (s.ops >= 0.900) return 'one of the team’s best hitters';
  if (s.ops <= 0.600) return 'scuffling at the plate';
  if (s.trend != null && s.trend >= 0.060) return 'swinging a hot bat lately';
  if (s.trend != null && s.trend <= -0.060) return 'in a bit of a slump';
  return 'a steady contributor';
}

const HB = S.batters(), PB = S.pitchers();
const watch = {
  upBats: HB.filter(b => b.pa >= 15 && b.trend != null && b.trend >= 0.05).sort((a, b) => b.trend - a.trend),
  coldBats: HB.filter(b => b.pa >= 15 && b.trend != null && b.trend <= -0.05).sort((a, b) => a.trend - b.trend),
  strugBats: HB.filter(b => b.pa >= 30 && b.ops <= 0.600).sort((a, b) => a.ops - b.ops),
  strugArms: PB.filter(p => p.ip >= 8 && p.era >= 6).sort((a, b) => b.era - a.era),
  heavyArms: PB.map(p => ({ p, wl: workload(p.slug, 7) })).filter(x => x.wl.apps >= 3).sort((a, b) => b.wl.apps - a.wl.apps),
};

// ---- the words -------------------------------------------------------------
const resultWord = game.win == null ? 'played' : game.win ? 'won' : 'lost';
const recordMove = game.win == null ? `The team sits at ${T.w}–${T.l}.`
  : game.win ? `They’re now ${T.w}–${T.l}.` : `That drops them to ${T.w}–${T.l}.`;

const recap = [];
recap.push(`The Gumbeaux Gators ${resultWord} ${game.gs}–${game.os} ${game.home ? 'at home' : 'on the road'} against ${oppName} on ${game.date}. ${recordMove}`);
{
  let off;
  if (tb.h >= 10 || game.gs >= 7) off = `The bats came alive for ${tb.h} hits and ${game.gs} runs.`;
  else if (tb.h <= 5) off = `The offense was quiet, scratching out just ${tb.h} hits.`;
  else off = `The offense did enough at the plate with ${tb.h} hits.`;
  if (tb.hr) off += ` ${tb.hr === 1 ? 'A home run' : `${tb.hr} home runs`} gave the lineup some pop.`;
  let arms;
  const wildNight = gameBB9 != null && staffBB9 != null && gameBB9 > staffBB9 * 1.15;
  if (wildNight) arms = `On the mound, control was the story again — ${tp.bb} walks handed out, the same issue that's followed the staff much of the season.`;
  else if (tp.er <= 2) arms = `The pitching staff kept the opponent in check, allowing just ${tp.er} earned runs.`;
  else arms = `The pitching gave up ${tp.r} runs on the night.`;
  recap.push(off + ' ' + arms);
}

const takeaways = [];
const tBat = bat.filter(b => b.h > 0).sort((a, b) => b.h - a.h || b.rbi - a.rbi)[0];
if (tBat) { const s = BAT_SEASON[tBat.slug]; takeaways.push(`${tBat.meta.name} led the way at the plate (${tBat.h} hit${tBat.h > 1 ? 's' : ''}${tBat.rbi ? `, ${tBat.rbi} RBI` : ''})${s ? ` — he’s ${formWord(s)}` : ''}.`); }
if (tp.bb >= 5) takeaways.push(`Walks hurt again — the staff put ${tp.bb} runners on base for free. Throwing more strikes is the clearest way to better results.`);
if (watch.upBats[0]) takeaways.push(`${watch.upBats[0].meta.name} has been red-hot lately and has earned more at-bats.`);
const strug = watch.strugBats[0] || watch.strugArms[0];
if (strug) takeaways.push(`${strug.meta.name} has been struggling for a while now — it may be time for a change or some rest.`);
if (watch.heavyArms[0]) { const x = watch.heavyArms[0]; takeaways.push(`${x.p.meta.name} has pitched ${x.wl.apps} times in the last week — worth keeping his arm fresh.`); }
takeaways.push(`At ${T.w}–${T.l}, the club is ${luck < -1 ? 'actually playing a little better than the record shows' : luck > 1 ? 'winning the close ones' : 'right about where its play suggests'}.`);

// "Who to watch" plain-English groupings.
const hotNames = watch.upBats.slice(0, 3).map(b => b.meta.name);
const coldNames = [...new Set([...watch.coldBats.slice(0, 3).map(b => b.meta.name), ...watch.strugBats.slice(0, 2).map(b => b.meta.name)])].slice(0, 4);
const hitArms = watch.strugArms.slice(0, 3).map(p => p.meta.name);
const tiredArms = watch.heavyArms.map(x => x.p.meta.name);
const watchProse = [];
if (hotNames.length) watchProse.push({ k: 'Swinging hot bats', v: `${list(hotNames)} — reward them with at-bats.` });
if (coldNames.length) watchProse.push({ k: 'Going through a rough patch', v: `${list(coldNames)} — a breather or a lineup tweak could help.` });
if (hitArms.length) watchProse.push({ k: 'Arms getting hit hard', v: `${list(hitArms)}.` });
if (tiredArms.length) watchProse.push({ k: 'Pitched a lot this week', v: `${list(tiredArms)} — keep them rested.` });
if (!watchProse.length) watchProse.push({ k: 'Steady all around', v: 'No major roster concerns coming out of this one.' });

// Chart data: top hitters by average (with form), and the last several games.
const chartBats = HB.filter(b => b.pa >= 20).sort((a, b) => b.avg - a.avg).slice(0, 7);
const recentGames = S.SCHED.filter(g => g.win != null).slice(-8);

// ===========================================================================
// Markdown (plain text version of the same write-up).
// ===========================================================================
const L = []; const p = s => L.push(s);
p(`# Gators Game Report — ${game.date}, 2026`);
p('');
p(`**${resultWord.toUpperCase()} ${game.gs}–${game.os}** · ${game.home ? 'Home' : 'Away'} vs ${oppName} · Record ${T.w}–${T.l}`);
p('');
if (partial) { p('> Heads up: tonight\'s box score is still coming in, so a few details may fill in later.'); p(''); }
p('## The Story');
p('');
recap.forEach(s => { p(s); p(''); });
p('## Key Takeaways');
p('');
takeaways.forEach(t => p(`- ${t}`));
p('');
p('## Who\'s Hitting (recent form)');
p('');
chartBats.forEach(b => {
  const arrow = b.trend >= 0.03 ? ' — heating up ▲' : b.trend <= -0.03 ? ' — cooling off ▼' : '';
  p(`- **${b.meta.name}** — batting ${r3(b.avg)}${arrow}`);
});
p('');
p('## Last Games');
p('');
p(recentGames.map(g => `${g.win ? 'W' : 'L'} ${g.gs}-${g.os}`).join('  ·  ') || '—');
p('');
p('## Who to Watch');
p('');
watchProse.forEach(w => p(`- **${w.k}:** ${w.v}`));
p('');
p(`_A plain-language summary built from the season stats. “Recent form” = how a player has hit over his last five games._`);
p('');
const md = L.join('\n');

// ===========================================================================
// Branded one-page PDF — a clean, document-style read with simple charts.
// ===========================================================================
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function chartHittersHtml() {
  if (!chartBats.length) return '';
  const max = Math.max(...chartBats.map(b => b.avg), 0.300);
  const bars = chartBats.map(b => {
    const w = Math.round((b.avg / max) * 100);
    const col = b.trend >= 0.03 ? '#1f9d57' : b.trend <= -0.03 ? '#c0392b' : '#b8860b';
    const arrow = b.trend >= 0.03 ? ' ▲' : b.trend <= -0.03 ? ' ▼' : '';
    return `<div class='bar'><span class='nm'>${esc(b.meta.name)}</span><span class='track'><span class='fill' style='width:${w}%;background:${col}'></span></span><span class='vv'>${r3(b.avg)}${arrow}</span></div>`;
  }).join('');
  return `<div class='chart'><div class='ct'>Who's Hitting</div>${bars}<div class='cap'>Longer bar = higher batting average. Green ▲ heating up · Red ▼ cooling off.</div></div>`;
}
function chartGamesHtml() {
  if (!recentGames.length) return '';
  const max = Math.max(...recentGames.map(g => g.gs), 6);
  const cols = recentGames.map(g => {
    const h = Math.max(Math.round((g.gs / max) * 100), 7);
    const col = g.win ? '#1f9d57' : '#c0392b';
    const opp = S.oppShort(g.opp).replace(/^@ /, '').slice(0, 3);
    return `<div class='gcol'><div class='gwrap'><div class='gb' style='height:${h}%;background:${col}'></div></div><div class='gl'>${esc(opp)}<br>${g.gs}-${g.os}</div></div>`;
  }).join('');
  return `<div class='chart'><div class='ct'>Last ${recentGames.length} Games</div><div class='cols2'>${cols}</div><div class='cap'>Each bar is a game — green = win, red = loss. Taller = more runs scored.</div></div>`;
}

function buildHtml() {
  const win = game.win;
  const resColor = win == null ? '#714ad2' : win ? '#1f9d57' : '#c0392b';
  const resWord = win == null ? 'PLAYED' : win ? 'WIN' : 'LOSS';
  const H = [];
  H.push(`<!doctype html><html><head><meta charset='utf-8'><style>
@page{size:letter;margin:0.55in 0.65in;}
*{box-sizing:border-box;margin:0;padding:0;}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{font-family:Georgia,'Times New Roman',serif;color:#23262f;font-size:12.5px;line-height:1.55;}
.band{display:flex;align-items:center;gap:14px;background:#16102b;color:#fff;padding:14px 18px;border-radius:9px;}
.band img{width:50px;height:50px;}
.k{font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#ffd633;font-weight:700;}
.band h1{font-family:'Helvetica Neue',Arial,sans-serif;font-size:21px;font-weight:800;line-height:1.12;margin:1px 0;}
.band .sub{font-family:Arial,sans-serif;font-size:12px;color:#cdbdf2;}
.badge{margin-left:auto;text-align:center;font-family:'Helvetica Neue',Arial,sans-serif;}
.badge .r{display:inline-block;background:${resColor};color:#fff;font-weight:800;font-size:15px;letter-spacing:.05em;padding:6px 16px;border-radius:6px;}
.badge .sc{font-size:14px;color:#fff;margin-top:5px;font-weight:700;}
h2{font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#5b3fb0;border-bottom:2px solid #ecc913;padding-bottom:3px;margin:17px 0 9px;}
p{margin:8px 0;}
.lead p{font-size:13px;}
ul.take{list-style:none;}
ul.take li{position:relative;padding:6px 0 6px 24px;border-bottom:1px solid #eee;font-size:12.5px;}
ul.take li:last-child{border-bottom:none;}
ul.take li:before{content:'';position:absolute;left:3px;top:11px;width:9px;height:9px;border-radius:2px;background:#714ad2;}
.charts{display:flex;gap:18px;margin:4px 0;}
.chart{flex:1;background:#f7f4fd;border:1px solid #e7e0f7;border-radius:9px;padding:11px 13px;}
.ct{font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:800;color:#5b3fb0;text-transform:uppercase;letter-spacing:.06em;margin-bottom:9px;}
.cap{font-family:Arial,sans-serif;font-size:9.5px;color:#7a7a85;margin-top:9px;font-style:italic;}
.bar{display:flex;align-items:center;gap:8px;margin:5px 0;font-family:Arial,sans-serif;font-size:11px;}
.bar .nm{width:96px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bar .track{flex:1;background:#e7e2f0;border-radius:3px;height:11px;}
.bar .fill{display:block;height:11px;border-radius:3px;}
.bar .vv{width:46px;text-align:right;color:#555;font-variant-numeric:tabular-nums;}
.cols2{display:flex;gap:7px;align-items:flex-end;height:84px;}
.gcol{flex:1;display:flex;flex-direction:column;align-items:center;}
.gwrap{display:flex;align-items:flex-end;height:64px;width:100%;justify-content:center;}
.gcol .gb{width:72%;border-radius:3px 3px 0 0;}
.gcol .gl{font-family:Arial,sans-serif;font-size:8.5px;color:#666;margin-top:4px;text-align:center;line-height:1.2;}
.watch p{margin:6px 0;}.watch b{color:#5b3fb0;}
.foot{margin-top:16px;border-top:1px solid #ddd;padding-top:7px;font-family:Arial,sans-serif;font-size:9px;color:#9a9aa3;font-style:italic;}
.warn{background:#fff5f5;border:1px solid #f0b8b8;color:#9b2c2c;border-radius:7px;padding:8px 11px;font-family:Arial,sans-serif;font-size:10.5px;margin:9px 0;}
</style></head><body>`);
  H.push(`<div class='band'><img src='${S.gatorsLogoDataUri()}'><div><div class='k'>Gumbeaux Gators · Game Report</div><h1>${esc(game.date)} vs ${esc(oppName)}</h1><div class='sub'>${game.home ? 'Home game' : 'Road game'} · Record now ${T.w}–${T.l}</div></div><div class='badge'><div class='r'>${resWord}</div><div class='sc'>${game.gs}–${game.os}</div></div></div>`);
  if (partial) H.push(`<div class='warn'>⚠️ Heads up — tonight's box score is still coming in, so a few details may fill in later.</div>`);

  H.push(`<h2>The Story</h2><div class='lead'>${recap.map(s => `<p>${esc(s)}</p>`).join('')}</div>`);
  H.push(`<h2>Key Takeaways</h2><ul class='take'>${takeaways.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`);
  H.push(`<h2>At a Glance</h2><div class='charts'>${chartHittersHtml()}${chartGamesHtml()}</div>`);
  H.push(`<h2>Who to Watch</h2><div class='watch'>${watchProse.map(w => `<p><b>${esc(w.k)}:</b> ${esc(w.v)}</p>`).join('')}</div>`);
  H.push(`<div class='foot'>A plain-language summary built from the season stats. “Recent form” = how a player has hit over his last five games. This is the quick read, not the full box score.</div>`);
  H.push(`</body></html>`);
  return H.join('\n');
}

function findChromium() {
  const cands = [process.env.CHROMIUM_PATH, process.env.PUPPETEER_EXECUTABLE_PATH,
    '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  try { const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'; for (const d of fs.readdirSync(base)) { const pth = path.join(base, d, 'chrome-linux', 'chrome'); if (fs.existsSync(pth)) return pth; } } catch (e) {}
  return null;
}

function renderPdf(html, outPath) {
  const bin = findChromium();
  const tmp = outPath.replace(/\.pdf$/, '') + '.tmp.html';
  fs.writeFileSync(tmp, html);
  if (!bin) { console.error('No Chromium found for --pdf. Set CHROMIUM_PATH. HTML left at ' + tmp); return false; }
  try {
    require('child_process').execFileSync(bin,
      ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${outPath}`, 'file://' + path.resolve(tmp)],
      { stdio: 'ignore' });
    fs.unlinkSync(tmp);
    return true;
  } catch (e) { console.error('Chromium PDF render failed:', e.message, '\nHTML left at ' + tmp); return false; }
}

// ---- output ----------------------------------------------------------------
const outDir = path.join(__dirname, '..', 'reports', 'postgame');
const stem = `${game.id.slice(0, 8)}-${S.oppShort(game.opp).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
function ensureDir() { if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true }); }

if (PDF || HTML) {
  ensureDir();
  const html = buildHtml();
  if (HTML) { const hf = path.join(outDir, `${stem}.html`); fs.writeFileSync(hf, html); console.error('wrote', path.relative(path.join(__dirname, '..'), hf)); }
  if (PDF) { const out = path.join(outDir, `${stem}.pdf`); if (renderPdf(html, out)) console.log('wrote', path.relative(path.join(__dirname, '..'), out)); }
}
if (WRITE) {
  ensureDir();
  const file = path.join(outDir, `${stem}.md`);
  fs.writeFileSync(file, md + '\n');
  console.error('wrote', path.relative(path.join(__dirname, '..'), file));
}
if (!PDF) process.stdout.write(md + '\n');
