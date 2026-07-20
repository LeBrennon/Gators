#!/usr/bin/env node
'use strict';
// One-page "Path to the Playoffs" PDF: the live second-half standings, the
// current 4-team playoff picture, and exactly what the Gators need to do over
// their remaining games to lock a spot. Pulls live data from the running app
// (no local seed needed) so it's accurate to run any day the rest of the way.
//
//   node scripts/playoff-scenarios.js --pdf
//
// Math follows docs/tcl-playoff-rules.md: the second-half race ranks by games
// over .500 first, PCT second (see server.js rankSecondHalf). "Games over
// .500" is what all the win-differential thresholds below are computed
// against — not raw win totals — since that's the actual sort key.
const fs = require('fs');
const path = require('path');
const S = require('./lib/season');

const APP_BASE = (process.env.REPORT_APP_BASE || 'https://whatisthegatorscore.com').replace(/\/$/, '');
async function fetchJSON(pathname) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(APP_BASE + pathname, { headers: { accept: 'application/json' }, signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; } finally { clearTimeout(to); }
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const goa = r => (r.w2 | 0) - (r.l2 | 0);                 // games over .500 — the primary 2H sort key
const fmtGoa = n => (n > 0 ? '+' : '') + n;

// How many more games team A needs to win than team B, over N equal remaining
// games each, to (a) force a tie on games-over-.500 and (b) finish strictly
// ahead. See the module doc comment: ranking runs on GOA, not raw wins.
function winDiffNeeded(goaA, goaB) {
  const gap = goaB - goaA;             // B's current GOA lead over A (can be negative)
  if (gap <= 0) return { gap, tie: null, pass: 1 };  // A already level or ahead; +1 differential clears B outright
  const evenGap = gap % 2 === 0;
  return { gap, tie: evenGap ? gap / 2 : null, pass: Math.floor(gap / 2) + 1 };
}

// This season's Gators results against one opponent, from the Gators' own
// schedule feed (already the full season, not just what's left).
function seasonSeriesVs(games, oppShort) {
  const gs = games.filter(g => g.state === 'final' && g.opponent && g.opponent.short === oppShort);
  let w = 0, l = 0, rf = 0, ra = 0;
  for (const g of gs) {
    const us = g.gatorsHome ? g.home : g.away, them = g.gatorsHome ? g.away : g.home;
    if (us.score == null || them.score == null) continue;
    rf += us.score; ra += them.score;
    if (us.score > them.score) w++; else if (them.score > us.score) l++;
  }
  return { w, l, rf, ra, diff: rf - ra, games: gs.length };
}

async function main() {
  const [standings, schedule] = await Promise.all([fetchJSON('/api/standings'), fetchJSON('/api/schedule')]);
  if (!standings || !standings.rows || !standings.rows.length) { console.error('Could not load /api/standings from ' + APP_BASE); process.exit(1); }
  const rows = standings.rows, gatorsId = standings.gatorsId;
  const games = (schedule && schedule.games) || [];
  const gRow = rows.find(r => r.id === gatorsId);
  const rank = rows.findIndex(r => r.id === gatorsId) + 1;
  const remaining = games.filter(g => g.state === 'scheduled' || g.state === 'live')
    .sort((a, b) => a.sortKey - b.sortKey);

  // The two non-champion teams currently holding the 3/4 seed (or, if the
  // Gators already hold one, whoever's chasing them from below) — these are
  // the rivals the "what it takes" math is computed against.
  const nonChamp = rows.filter(r => !r.clinched);
  const gNci = nonChamp.findIndex(r => r.id === gatorsId);
  const holding = gNci >= 0 && gNci < 2;
  const rivals = holding
    ? nonChamp.slice(2, 3)                                  // the team chasing them for the spot
    : nonChamp.slice(0, 2).filter(r => r.id !== gatorsId);  // the team(s) they need to catch

  const rivalLines = rivals.map(r => {
    const equalGL = r.gamesLeft === gRow.gamesLeft;
    const wd = equalGL ? winDiffNeeded(goa(gRow), goa(r)) : null;
    const series = seasonSeriesVs(games, r.short);
    return { row: r, wd, series, equalGL };
  });

  const asOf = new Date(standings.updatedAt || Date.now());
  const asOfStr = asOf.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

  const html = buildHtml({ rows, gatorsId, gRow, rank, holding, rivalLines, remaining, playoffs: standings.playoffs, asOfStr });
  const outDir = path.join(__dirname, '..', 'reports', 'playoffs');
  fs.mkdirSync(outDir, { recursive: true });
  const stem = 'Playoff Picture ' + new Date().toISOString().slice(0, 10);
  const htmlPath = path.join(outDir, stem + '.html');
  fs.writeFileSync(htmlPath, html);
  if (process.argv.includes('--pdf')) {
    const pdfPath = path.join(outDir, stem + '.pdf');
    if (renderPdf(html, pdfPath)) { console.log('Wrote ' + pdfPath); fs.unlinkSync(htmlPath); }
  } else {
    console.log('Wrote ' + htmlPath);
  }
}

function findChromium() {
  const cands = [process.env.CHROMIUM_PATH, process.env.PUPPETEER_EXECUTABLE_PATH,
    '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  try { const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'; for (const d of fs.readdirSync(base)) { const p = path.join(base, d, 'chrome-linux', 'chrome'); if (fs.existsSync(p)) return p; } } catch (e) {}
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

function fmtOpp(g) { return (g.gatorsHome ? 'vs ' : 'at ') + g.opponent.short; }

function buildHtml({ rows, gatorsId, gRow, rank, holding, rivalLines, remaining, playoffs, asOfStr }) {
  const standingsRows = rows.map((r, i) => {
    const isG = r.id === gatorsId;
    const clin = r.clinched ? '<span class="tag clinch">1H</span>' : '';
    const out = r.eliminated ? '<span class="tag out">Out</span>' : '';
    return `<tr class="${isG ? 'g' : ''}${r.eliminated ? ' out' : ''}">
      <td>${i + 1}</td><td class="nm">${esc(r.short || r.name)}${clin}${out}</td>
      <td>${(r.w2 | 0)}-${(r.l2 | 0)}</td><td class="goa">${fmtGoa(goa(r))}</td>
      <td>${r.gb === 0 ? '&mdash;' : r.gb}</td><td>${(r.ws | 0)}-${(r.ls | 0)}</td><td>${r.gamesLeft}</td></tr>`;
  }).join('');
  const anyOut = rows.some(r => r.eliminated);

  const seeds = (playoffs && playoffs.seeds) || [];
  const seedHtml = seeds.map(s => {
    const t = s.team;
    const isG = t && t.id === gatorsId;
    return `<div class="seed${isG ? ' g' : ''}"><div class="seedn">${s.seed}</div>
      <div class="seedbody"><div class="seedteam">${t ? esc(t.short || t.name) : 'TBD'}</div>
      <div class="seednote">${esc(s.note || '')}${s.clinched ? ' &middot; clinched' : s.provisional ? ' &middot; provisional' : ''}</div></div></div>`;
  }).join('');

  const remRows = remaining.map(g => `<tr><td>${esc(g.dateLabel)}</td><td>${esc(fmtOpp(g))}</td><td class="mute">${esc(g.status || '')}</td></tr>`).join('');

  const rivalCards = rivalLines.map(({ row, wd, series, equalGL }) => {
    const verb = holding ? 'holding off' : 'catching';
    let math;
    if (!equalGL) {
      math = `Games-left counts differ (Gators ${gRow.gamesLeft} vs ${row.short} ${row.gamesLeft}) &mdash; ${row.gb} GB, no clean win-for-win comparison.`;
    } else if (wd.gap <= 0) {
      math = `Gators are already level or ahead on games-over-.500 &mdash; one more win than ${esc(row.short)} the rest of the way clears them outright.`;
    } else if (wd.tie != null) {
      math = `Win at least <b>${wd.tie}</b> more of their last games than ${esc(row.short)} does to force a tie (tiebreakers: head-to-head, then run differential) &mdash; <b>${wd.pass}</b>+ to clinch outright, no tiebreaker needed.`;
    } else {
      math = `Must out-win ${esc(row.short)} by at least <b>${wd.pass}</b> game${wd.pass === 1 ? '' : 's'} over the stretch to pass them &mdash; a tie on games-over-.500 isn't mathematically possible between these two.`;
    }
    const seriesLine = series.games
      ? `2026 season series: Gators ${series.w}-${series.l}${series.diff ? ` (${series.diff > 0 ? '+' : ''}${series.diff} runs)` : ''}.`
      : 'No meetings yet this season.';
    return `<div class="rival"><div class="rivalhead">${verb === 'holding off' ? 'Holding off' : 'Catching'} <b>${esc(row.short)}</b>
      <span class="mute">(${(row.w2 | 0)}-${(row.l2 | 0)}, ${fmtGoa(goa(row))} 2H)</span></div>
      <div class="rivalmath">${math}</div><div class="rivalseries mute">${esc(seriesLine)}</div></div>`;
  }).join('');

  const oppSet = [...new Set(remaining.map(g => g.opponent.short))];
  const noRivalGames = rivalLines.every(({ row }) => !oppSet.includes(row.short));

  const bottomLine = holding
    ? `Bottom line: the Gators are in a playoff spot right now. Win the games in front of them and the ${rivalLines.map(r => esc(r.row.short)).join(' / ')} chase becomes someone else's problem.`
    : `Bottom line: the Gators can't play their way past ${rivalLines.map(r => esc(r.row.short)).join(' or ')} on the field again this season &mdash; win out at home and on the road, then watch the scoreboard.`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:letter;margin:0;}
*{box-sizing:border-box;margin:0;padding:0;}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1b1e27;font-size:13.5px;padding:20px 40px 14px;height:100vh;display:flex;flex-direction:column;overflow:hidden;}
.band{display:flex;align-items:center;gap:16px;color:#fff;padding:14px 22px 14px 116px;border-radius:14px;border:2px solid #ecc913;position:relative;
  background:#3a2480;box-shadow:0 3px 11px rgba(58,36,128,.3),inset 0 0 0 1px rgba(255,255,255,.08);}
.band img{position:absolute;left:18px;top:50%;transform:translateY(-50%);width:78px;height:78px;}
.band .k{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#ffd633;font-weight:800;}
.band h1{font-size:25px;font-weight:900;line-height:1.1;margin:3px 0;}
.band .sub{font-size:12.5px;color:#e7dcff;margin-top:2px;}
.mute{color:#6a6480;}
h2.sec{font-size:11.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#fff;background:#3a2480;padding:5px 12px;border-radius:7px 7px 0 0;margin-top:9px;}
.grid{display:flex;gap:16px;margin-top:0;}
.col{flex:1;min-width:0;display:flex;flex-direction:column;}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;}
.sttbl{border:1px solid #e6def7;border-top:none;border-radius:0 0 7px 7px;overflow:hidden;}
.sttbl th,.sttbl td{padding:6px 8px;text-align:center;font-size:12px;border-bottom:1px solid #efeaf9;}
.sttbl th{background:#fff;color:#3a2480;font-weight:800;text-transform:uppercase;font-size:9.5px;letter-spacing:.03em;}
.sttbl td.nm,.sttbl th:nth-child(2){text-align:left;font-weight:700;}
.sttbl tr:nth-child(2n) td{background:#f6f2fc;}
.sttbl tr.g td{background:rgba(113,74,210,.16);}
.sttbl tr.g td.nm{color:#3a2480;font-weight:800;}
.sttbl tr.out td{opacity:.5;}
.sttbl .goa{font-weight:700;}
.tag{display:inline-block;font-size:8px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#6a6480;border:1px solid #d9d2ec;border-radius:999px;padding:1.5px 6px;margin-left:5px;}
.tag.clinch{color:#a3790c;border-color:#ecc913;background:#fff8e0;}
.tag.out{color:#8a1a4c;}
.legend{font-size:9.5px;color:#6a6480;margin-top:6px;line-height:1.5;}
.bracket{border:1px solid #e6def7;border-top:none;border-radius:0 0 7px 7px;padding:11px;display:flex;flex-direction:column;gap:8px;}
.seed{display:flex;align-items:center;gap:10px;border:1px solid #e6def7;border-radius:9px;padding:7px 10px;}
.seed.g{border-color:#3a2480;background:#f6f2fc;}
.seedn{font-family:'Helvetica Neue',Arial,sans-serif;font-weight:900;font-size:17px;color:#ecc913;background:#3a2480;width:25px;height:25px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;}
.seedteam{font-weight:800;font-size:13px;}
.seednote{font-size:9.5px;color:#6a6480;}
.bracketfoot{font-size:9.5px;color:#6a6480;margin-top:3px;line-height:1.5;}
.hostrule{font-size:9.5px;color:#4a416e;margin-top:6px;padding-top:6px;border-top:1px dashed #e6def7;line-height:1.5;}
.hostrule b{color:#3a2480;}
.path{border:1px solid #e6def7;border-top:none;border-radius:0 0 7px 7px;padding:11px;}
.pathstatus{font-size:14px;margin-bottom:11px;}
.pathstatus b{color:#3a2480;}
.rivals{display:flex;gap:12px;}
.rival{flex:1;border:1px solid #e6def7;border-radius:9px;padding:10px 12px;background:#faf8ff;}
.rivalhead{font-size:12.5px;margin-bottom:5px;}
.rivalmath{font-size:12px;line-height:1.5;}
.rivalseries{font-size:10.5px;margin-top:5px;}
.schedwrap{display:flex;gap:16px;margin-top:0;}
.sched{flex:1;}
.sched table{border:1px solid #e6def7;border-radius:7px;overflow:hidden;}
.sched th,.sched td{padding:5px 9px;font-size:11.5px;text-align:left;border-bottom:1px solid #efeaf9;}
.sched th{background:#3a2480;color:#fff;font-size:9px;text-transform:uppercase;letter-spacing:.03em;}
.sched tr:nth-child(2n) td{background:#f6f2fc;}
.note{flex:1;font-size:11.5px;line-height:1.55;background:#fff8e0;border:1px solid #ecc913;border-radius:9px;padding:11px 13px;}
.note b{color:#a3790c;}
.tiebreak{margin-top:9px;border:1px solid #e6def7;border-radius:9px;padding:8px 14px;background:#faf8ff;}
.tiebreak h3{font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#3a2480;margin-bottom:4px;}
.tbcols{display:flex;gap:18px;}
.tbcol{flex:1;font-size:10px;line-height:1.4;}
.tbcol ol{margin-left:15px;}
.bottomline{margin-top:7px;text-align:center;font-size:12px;font-weight:700;color:#3a2480;background:#f6f2fc;border:1px dashed #c9b8ef;border-radius:9px;padding:6px 14px;}
footer{margin-top:4px;padding-top:4px;border-top:1px solid #e6def7;font-size:8.5px;color:#8a84a0;display:flex;justify-content:space-between;}
</style></head><body>
<div class="band"><img src="${S.gatorsLogoDataUri()}">
  <div><div class="k">Gumbeaux Gators &middot; Path to the Playoffs</div>
  <h1>2026 Second-Half Race</h1>
  <div class="sub">Currently ${ordinal(rank)} place, ${(gRow.w2 | 0)}-${(gRow.l2 | 0)} (${fmtGoa(goa(gRow))} games over .500) &middot; ${gRow.gamesLeft} games left</div></div>
</div>

<div class="grid">
  <div class="col" style="flex:1.3">
    <h2 class="sec">Second-Half Standings</h2>
    <table class="sttbl"><tr><th>#</th><th>Team</th><th>2H</th><th>GOA</th><th>GB</th><th>Season</th><th>GL</th></tr>${standingsRows}</table>
    ${anyOut ? '<div class="legend"><span class="tag out">Out</span> mathematically eliminated from the second-half race &middot; <span class="tag clinch">1H</span> clinched via first-half title</div>' : '<div class="legend"><span class="tag clinch">1H</span> clinched a playoff spot by winning the first half &middot; every other team is still mathematically alive</div>'}
  </div>
  <div class="col">
    <h2 class="sec">Playoff Picture</h2>
    <div class="bracket">${seedHtml}
      <div class="bracketfoot">Best-of-3 (first to 2 wins) &middot; matchups are 1 vs 4 and 2 vs 3</div>
      <div class="hostrule"><b>Hosting:</b> the lower seed hosts Game 1; the higher seed (better record) hosts Game 2 and, if needed, Game 3.</div>
    </div>
  </div>
</div>

<h2 class="sec">What The Gators Need To Do</h2>
<div class="path">
  <div class="pathstatus">${holding
    ? `The Gators currently <b>hold</b> a second-half playoff spot (seed ${rank <= 2 ? rank : (rows.filter(r=>!r.clinched).findIndex(r=>r.id===gatorsId)+3)}). Protect it the rest of the way.`
    : `The Gators are currently <b>on the outside looking in</b> &mdash; ${gRow.gb === 0 ? 'tied' : gRow.gb + ' games back'} of the final spot with ${gRow.gamesLeft} left to play.`}</div>
  <div class="rivals">${rivalCards}</div>
</div>

<div class="schedwrap">
  <div class="sched">
    <h2 class="sec">Remaining Schedule (${remaining.length})</h2>
    <table><tr><th>Date</th><th>Opponent</th><th>Time</th></tr>${remRows}</table>
  </div>
  <div class="note">
    ${noRivalGames
      ? `<b>The Gators don’t play ${rivalLines.map(r=>esc(r.row.short)).join(' or ')} again this season</b> &mdash; every game above is against a team currently ${holding ? 'behind' : 'below'} them in the 2H race. There’s no head-to-head shortcut: the Gators have to take care of their own games and hope the race above shifts their way.`
      : `The Gators still play a team directly in this race &mdash; those head-to-head games are worth more than the standings alone suggest.`}
  </div>
</div>

<div class="tiebreak">
  <h3>If It Comes Down To A Tie</h3>
  <div class="tbcols">
    <div class="tbcol"><b>2 teams level:</b><ol><li>Games back</li><li>Win percentage</li><li>Head-to-head</li><li>Run differential</li><li>Run diff. in head-to-head games</li><li>Winner of the last regulation meeting</li></ol></div>
    <div class="tbcol"><b>3+ teams level:</b><ol><li>Head-to-head among the tied teams</li><li>Run differential</li><li>Run diff. in head-to-head games among the tied teams</li></ol><div style="margin-top:8px">Full seeding rules, including the both-halves overlap rule, live in <b>docs/tcl-playoff-rules.md</b>.</div></div>
  </div>
</div>

<div class="bottomline">${bottomLine}</div>

<footer><span>Data as of ${esc(asOfStr)} &middot; source: texasleaguestats.prestosports.com</span><span>whatisthegatorscore.com &middot; docs/tcl-playoff-rules.md</span></footer>
</body></html>`;
}

function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

main().catch(e => { console.error(e); process.exit(1); });
