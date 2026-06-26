#!/usr/bin/env node
// Post-game report generator for the Gumbeaux Gators.
// Reconstructs one game from the daily seed's per-player logs and frames every
// line against the season baseline (season AVG/OBP/SLG + league rank + hot/cold
// trend for hitters; season ERA/WHIP + role + last-3 form for pitchers). Offline.
//
//   node scripts/postgame-report.js               # latest game -> markdown on stdout
//   node scripts/postgame-report.js "Jun 24"      # a specific date
//   node scripts/postgame-report.js 20260624_xxxx # a specific box id
//   node scripts/postgame-report.js latest --pdf   # branded one-page PDF in reports/postgame/
//   node scripts/postgame-report.js latest --write # also save the markdown there
//
// --pdf renders a Gumbeaux Gators-branded single-page PDF (team colors + logo)
// via the system Chromium (no repo dependency). The latest game can be partial
// until the daily seed finishes refreshing every log — the report flags this.

const fs = require('fs');
const path = require('path');
const S = require('./lib/season');
const { r2, r3, signed, ipStr } = S;

const FLAGS = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const WRITE = FLAGS.has('--write');
const PDF = FLAGS.has('--pdf');
const HTML = FLAGS.has('--html'); // write the intermediate HTML (debug / branding tweaks)
const target = args[0] || 'latest';

const game = S.resolveGame(target);
if (!game) { console.error(`No game found for "${target}". Try 'latest', a date like "Jun 24", or a box id.`); process.exit(1); }

const BAT_SEASON = S.indexBySlug(S.batters());
const PIT_SEASON = S.indexBySlug(S.pitchers());
const bat = S.gameBatting(game.id);
const pit = S.gamePitching(game.id);
const T = S.teamSummary(game.id);            // record/runs through this game
const SEASON = S.teamSummary();              // full-season staff baseline

// team totals for the night (summed from the per-player logs)
const tb = bat.reduce((a, b) => ({ ab: a.ab + b.ab, h: a.h + b.h, hr: a.hr + b.hr, rbi: a.rbi + b.rbi, bb: a.bb + b.bb, k: a.k + b.k }), { ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, k: 0 });
const tp = pit.reduce((a, p) => ({ outs: a.outs + p.outs, h: a.h + p.h, r: a.r + p.r, er: a.er + p.er, bb: a.bb + p.bb, k: a.k + p.k }), { outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0 });

// season staff command baseline (BB/9) for comparison
const staffIP = S.pitchers().reduce((a, x) => a + x.outs, 0) / 3;
const staffBB = S.pitchers().reduce((a, x) => a + x.bb, 0);
const staffBB9 = staffIP ? (staffBB * 9) / staffIP : null;
const gameBB9 = tp.outs ? (tp.bb * 27) / tp.outs : null;
const gameStrikeIP = tp.outs / 3;

const partial = game.win != null && tp.outs > 0 && tp.outs < 18; // < 6 IP recorded for a completed game

const L = []; const p = s => L.push(s);
const arrow = (cur, base, goodLow) => {
  if (cur == null || base == null) return '';
  const better = goodLow ? cur < base : cur > base;
  const same = Math.abs(cur - base) < 1e-9;
  return same ? ' ·' : better ? ' ▲' : ' ▼';
};
const trendTag = b => b.trend == null ? '' : (b.trend > 0.001 ? ` ▲${S.pts(b.trend)}` : b.trend < -0.001 ? ` ▼${S.pts(b.trend)}` : ' ·');

// ---- GM analytics ----------------------------------------------------------
const oppName = S.oppShort(game.opp).replace(/^@ /, '');
const r1 = x => (x == null || !isFinite(x)) ? '—' : x.toFixed(1);
const pct0 = x => (x == null || !isFinite(x)) ? '—' : (x * 100).toFixed(0) + '%';
const nm = m => `${m.meta && m.meta.num ? m.meta.num + ' ' : ''}${m.meta ? m.meta.name : ''}`;
// Compact tonight batting line: "2-4 · HR, 2 RBI".
function nightBat(b) { let s = `${b.h}-${b.ab}`; const x = []; if (b.hr) x.push(`${b.hr} HR`); if (b.rbi) x.push(`${b.rbi} RBI`); if (b.bb) x.push(`${b.bb} BB`); if (b.k) x.push(`${b.k} K`); return x.length ? `${s} · ${x.join(', ')}` : s; }

// Pythagorean record from run differential — are we beating or trailing the
// record our run scoring/prevention "should" produce? A luck/clutch signal.
const pythPct = (T.rf || T.ra) ? (T.rf * T.rf) / (T.rf * T.rf + T.ra * T.ra) : 0;
const pythW = Math.round(pythPct * (T.w + T.l)), pythL = (T.w + T.l) - pythW, luck = T.w - pythW;

// Trailing-N-day pitcher workload as of this game (appearances + IP) — fatigue.
const gameDayMs = (() => { const m = String(game.id).match(/^(\d{4})(\d{2})(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; })();
function boxDayMs(g) { const m = String(S.boxId(g)).match(/^(\d{4})(\d{2})(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; }
function workload(slug, days) {
  const logs = (S.PC[slug] && S.PC[slug].glPit) || []; let apps = 0, outs = 0;
  if (gameDayMs != null) for (const g of logs) { const d = boxDayMs(g); if (d == null) continue; const ago = (gameDayMs - d) / 864e5; if (ago >= 0 && ago < days) { apps++; outs += S.i3(g.ip); } }
  return { apps, outs };
}

// Heuristic evaluation grade (a decision cue, not a verdict), gated on sample.
function hitGrade(s) {
  if (!s) return '—'; if (s.pa < 15) return 'Small sample';
  if (s.ops >= 0.900) return 'Elite';
  if (s.ops <= 0.600) return 'Struggling';
  if (s.trend != null && s.trend >= 0.060) return 'Hot';
  if (s.trend != null && s.trend <= -0.060) return 'Cold';
  return 'Solid';
}
function pitGrade(s) {
  if (!s) return '—'; if (s.ip < 5) return 'Small sample';
  if (s.era >= 6 && s.ip >= 8) return 'Struggling';
  if (s.bb9 != null && s.bb9 >= 5) return 'Wild';
  if (s.l3era != null && s.l3era + 1.5 < s.era) return 'Trending up';
  if (s.era <= 3.5 && (s.bb9 == null || s.bb9 <= 4)) return 'Reliable';
  return 'Steady';
}
const GRADE_GOOD = ['Elite', 'Hot', 'Reliable', 'Trending up'];
const GRADE_BAD = ['Struggling', 'Cold', 'Wild'];

// Roster-wide watch lists for the GM action section (whole roster, not just the
// players who appeared tonight, so bench/usage decisions are covered too).
const HB = S.batters(), PB = S.pitchers();
const watch = {
  upBats: HB.filter(b => b.pa >= 15 && b.trend != null && b.trend >= 0.05).sort((a, b) => b.trend - a.trend),
  coldBats: HB.filter(b => b.pa >= 15 && b.trend != null && b.trend <= -0.05).sort((a, b) => a.trend - b.trend),
  strugBats: HB.filter(b => b.pa >= 30 && b.ops <= 0.600).sort((a, b) => a.ops - b.ops),
  upArms: PB.filter(p => p.ip >= 8 && p.l3era != null && p.l3era + 1.5 < p.era).sort((a, b) => (a.l3era - a.era) - (b.l3era - b.era)),
  strugArms: PB.filter(p => p.ip >= 8 && p.era >= 6).sort((a, b) => b.era - a.era),
  heavyArms: PB.map(p => ({ p, wl: workload(p.slug, 7) })).filter(x => x.wl.apps >= 3).sort((a, b) => b.wl.apps - a.wl.apps),
};

// ---- header ----------------------------------------------------------------
const res = game.win == null ? '' : (game.win ? 'W' : 'L') + ` ${game.gs}-${game.os}`;
const where = game.home ? 'Home' : 'Away';
p(`# Post-Game Report — ${game.date}, 2026`);
p('');
p(`**Lake Charles Gumbeaux Gators ${game.home ? 'vs.' : '@'} ${oppName}** — ${where} · Record: ${T.w}-${T.l}`);
p(`**Final: ${res ? (game.win ? `Gators ${game.gs}, ${oppName} ${game.os}` : `${oppName} ${game.os}, Gators ${game.gs}`) : 'In progress'}${game.win == null ? '' : game.win ? ' — Win' : ' — Loss'}**`);
p('');
if (partial) { p('> ⚠️ **Partial data:** this game is still filling into the daily seed (only ' + ipStr(tp.outs) + ' IP of pitching logged so far). Re-run after the next refresh for the complete line.'); p(''); }

// ---- snapshot --------------------------------------------------------------
p('## Snapshot');
p('');
p(`- **Offense:** ${tb.h} H, ${tb.bb} BB, ${tb.k} K${tb.hr ? `, ${tb.hr} HR` : ''} (${T.rpg ? '' : ''}${game.gs} runs).`);
p(`- **Pitching:** ${ipStr(tp.outs)} IP, ${tp.er} ER, ${tp.bb} BB, ${tp.k} K.`);
if (gameBB9 != null && staffBB9 != null) {
  const verdict = gameBB9 <= staffBB9 ? 'better than' : 'worse than';
  p(`- **Command vs. season:** ${gameBB9.toFixed(1)} BB/9 tonight ${arrow(gameBB9, staffBB9, true).trim()} (${verdict} the ${staffBB9.toFixed(1)} staff baseline).`);
}
p('');

// ---- hitters ---------------------------------------------------------------
p('## Hitters — performance & trend');
p('');
p('PA = season sample size. ISO = isolated power (SLG−AVG). BB%/K% = plate discipline. TCL = league SLG rank. L5 = last-5 AVG with hot/cold arrow. Grade is a heuristic evaluation cue (see key).');
p('');
p('| Player | Tonight | PA | AVG/OBP/SLG | OPS | ISO | BB% | K% | TCL | L5 | Grade |');
p('|---|:--|--:|---|--:|--:|--:|--:|:--:|:--:|:--:|');
bat.forEach(b => {
  const s = BAT_SEASON[b.slug];
  const slash = s ? `${r3(s.avg)}/${r3(s.obp)}/${r3(s.slg)}` : '—';
  const rank = s && s.ranks && s.ranks.slg ? s.ranks.slg : '—';
  const l5 = s && s.l5avg != null ? r3(s.l5avg) + (trendTag(s) || '') : '—';
  p(`| ${nm(b)} | ${nightBat(b)} | ${s ? s.pa : '—'} | ${slash} | ${s ? r3(s.ops) : '—'} | ${s ? r3(s.iso) : '—'} | ${s ? pct0(s.bbp) : '—'} | ${s ? pct0(s.kp) : '—'} | ${rank} | ${l5} | ${hitGrade(s)} |`);
});
p('');

// ---- pitchers --------------------------------------------------------------
p('## Pitching — performance & workload');
p('');
p('K/9 · BB/9 · BAA = stuff and command. L3 = last-3-outing ERA (recent form). 7d = appearances in the last 7 days (workload). Grade is a heuristic cue (see key).');
p('');
p('| Pitcher | Tonight (IP-H-R-ER-BB-K) | Role | ERA/WHIP | K/9 | BB/9 | BAA | L3 ERA | 7d | Grade |');
p('|---|:--|:--:|:--:|--:|--:|--:|--:|:--:|:--:|');
pit.forEach(pr => {
  const s = PIT_SEASON[pr.slug];
  const tonight = `${pr.ipStr}-${pr.h}-${pr.r}-${pr.er}-${pr.bb}-${pr.k}`;
  const ew = s ? `${r2(s.era)}/${r2(s.whip)}` : '—';
  const wl = workload(pr.slug, 7);
  p(`| ${nm(pr)} | ${tonight} | ${s ? s.role : '—'} | ${ew} | ${s ? r1(s.k9) : '—'} | ${s ? r1(s.bb9) : '—'} | ${s && s.baa ? r3(s.baa) : '—'} | ${s && s.l3era != null ? r2(s.l3era) : '—'} | ${wl.apps || '—'} | ${pitGrade(s)} |`);
});
p('');

// ---- roster watch (GM action items) ----------------------------------------
p('## Roster Watch — for the GM');
p('');
const cap = (arr, n, f) => arr.length ? arr.slice(0, n).map(f).join('; ') : '—';
const upList = [
  ...watch.upBats.slice(0, 5).map(b => `${b.meta.name} (L5 ${S.pts(b.trend)})`),
  ...watch.upArms.slice(0, 3).map(x => `${x.meta.name} (L3 ${r2(x.l3era)} ERA)`),
];
const strugList = [
  ...watch.strugBats.map(b => `${b.meta.name} (${r3(b.ops)} OPS, ${b.pa} PA)`),
  ...watch.strugArms.map(x => `${x.meta.name} (${r2(x.era)} ERA)`),
];
p(`- **Trending up — ride / more reps:** ${upList.length ? upList.join('; ') : '—'}`);
p(`- **Cooling off — keep an eye on:** ${cap(watch.coldBats, 6, b => `${b.meta.name} (L5 ${S.pts(b.trend)})`)}`);
p(`- **Struggling — consider a change:** ${strugList.length ? strugList.slice(0, 8).join('; ') : '—'}`);
p(`- **Workload — rest candidates:** ${watch.heavyArms.length ? watch.heavyArms.map(x => `${x.p.meta.name} (${x.wl.apps} app / ${ipStr(x.wl.outs)} IP, last 7d)`).join('; ') : '—'}`);
p('');
p('_Grades: **Elite** ≥.900 OPS · **Hot/Cold** ±60 pts L5 vs season · **Struggling** ≤.600 OPS (≥30 PA) · pitching **Reliable** ≤3.50 ERA & ≤4.0 BB/9 · **Wild** ≥5 BB/9 · **Trending up** L3 ≥1.5 ERA better. Heuristic cues, gated on sample size._');
p('');

// ---- auto notes ------------------------------------------------------------
p('## Notes');
p('');
const topBat = bat.filter(b => b.ab > 0).slice(0, 1)[0];
if (topBat && topBat.h > 0) {
  const s = BAT_SEASON[topBat.slug];
  p(`- **Top bat:** ${topBat.meta.name} ${topBat.h}-for-${topBat.ab}${topBat.rbi ? `, ${topBat.rbi} RBI` : ''}${topBat.hr ? `, ${topBat.hr} HR` : ''}${s ? ` (season ${r3(s.avg)}${s.trend > 0.04 ? ', and heating up' : s.trend < -0.04 ? ', snapping a cold stretch' : ''}).` : '.'}`);
}
const rough = [...pit].sort((a, b) => (b.er / Math.max(1, b.outs)) - (a.er / Math.max(1, a.outs)))[0];
if (rough && rough.er >= 2) {
  const s = PIT_SEASON[rough.slug];
  p(`- **Toughest line:** ${rough.meta.name} ${rough.ipStr} IP, ${rough.er} ER, ${rough.bb} BB${s ? ` (season ${r2(s.era)} ERA).` : '.'}`);
}
const wild = pit.filter(pr => pr.outs > 0 && (pr.bb * 27) / pr.outs > 9).map(pr => pr.meta.name);
if (tb.h > 0) p(`- **Offense:** ${tb.h} hits and ${tb.bb} walks produced ${game.gs} runs.`);
if (wild.length) p(`- **Command flags:** ${wild.join(', ')} ran high walk rates — consistent with the staff's ${staffBB9 ? staffBB9.toFixed(1) : '—'} BB/9 season theme.`);
p('');

// ---- season context --------------------------------------------------------
p('## Season context (baseline)');
p('');
const allBat = S.batters();
const topBats = allBat.filter(b => b.pa >= 20).slice(0, 3).map(b => `${b.meta.name} (${r3(b.ops)} OPS)`).join(', ');
p(`- **Team:** ${T.w}-${T.l}, ${SEASON.diff >= 0 ? '+' : ''}${SEASON.diff} run differential; ${SEASON.last10} last 10, ${SEASON.streak || '—'} streak.`);
p(`- **Pythagorean:** ${pythW}-${pythL} expected from run differential — ${luck === 0 ? 'right on its record' : luck > 0 ? `+${luck} over (winning close ones / some luck)` : `${luck} under (underperforming the run diff)`}.`);
p(`- **Splits:** ${SEASON.hw}-${SEASON.hl} home, ${SEASON.aw}-${SEASON.al} away, ${SEASON.oneRun} in one-run games.`);
p(`- **Top bats:** ${topBats}.`);
p(`- **Staff command:** ${staffBB9 ? staffBB9.toFixed(1) : '—'} BB/9 season-wide — the recurring run-prevention story.`);
p('');
p(`_Generated by \`scripts/postgame-report.js ${target === 'latest' ? '' : '"' + target + '"'}\` from the daily seed (\`roster-seed.json\`). Full baselines: \`reports/season-reference-2026.md\`._`);
p('');

const md = L.join('\n');

// ===========================================================================
// Branded one-page PDF (Gumbeaux Gators colors + logo, matching the app). Built
// from the same computed data as the markdown. Rendered with the system Chromium
// so there's no heavy repo dependency.
// ===========================================================================
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const gradeHtml = t => `<span class='gd ${GRADE_GOOD.includes(t) ? 'good' : GRADE_BAD.includes(t) ? 'bad' : 'neu'}'>${esc(t)}</span>`;

function buildHtml() {
  const oppName = S.oppShort(game.opp).replace(/^@ /, '');
  const vs = game.home ? 'vs' : '@';
  const win = game.win;
  const badgeColor = win == null ? '#714ad2' : win ? '#1f9d57' : '#e0524a';
  const badge = win == null ? 'FINAL' : `FINAL · Gators ${game.gs}, ${esc(oppName)} ${game.os} · ${win ? 'W' : 'L'}`;
  const cmd = (gameBB9 != null && staffBB9 != null)
    ? `${gameBB9.toFixed(1)} BB/9 ${gameBB9 <= staffBB9 ? 'better than' : 'worse than'} the ${staffBB9.toFixed(1)} staff baseline`
    : '';
  const lead = `${win == null ? '' : win ? 'Won' : 'Lost'} ${game.gs}-${game.os}. Offense: <b class='w'>${tb.h} H</b>, ${tb.bb} BB, ${tb.k} K → ${game.gs} runs. Staff: <b class='w'>${ipStr(tp.outs)} IP</b>, ${tp.er} ER, ${tp.bb} BB, ${tp.k} K${cmd ? ` — command ${cmd}` : ''}.`;

  const topBat = bat.find(b => b.h > 0);
  const rough = [...pit].filter(pr => pr.outs > 0).sort((a, b) => (b.er / b.outs) - (a.er / a.outs))[0];
  const wild = pit.filter(pr => pr.outs > 0 && (pr.bb * 27) / pr.outs > 9).map(pr => pr.meta.name);
  const notes = [];
  if (topBat) { const s = BAT_SEASON[topBat.slug]; notes.push(`<b class='g'>Top bat</b> — ${esc(topBat.meta.name)} ${topBat.h}-for-${topBat.ab}${topBat.rbi ? `, ${topBat.rbi} RBI` : ''}${s ? ` (season ${r3(s.avg)})` : ''}.`); }
  if (rough && rough.er >= 2) { const s = PIT_SEASON[rough.slug]; notes.push(`<b class='g'>Toughest line</b> — ${esc(rough.meta.name)} ${rough.ipStr} IP, ${rough.er} ER${s ? ` (season ${r2(s.era)} ERA)` : ''}.`); }
  if (wild.length) notes.push(`<b class='g'>Command flags</b> — ${wild.map(esc).join(', ')} (staff ${staffBB9 ? staffBB9.toFixed(1) : '—'} BB/9 theme).`);
  notes.push(`<b class='g'>Offense</b> — ${tb.h} H + ${tb.bb} BB produced ${game.gs} runs.`);

  const topBats = S.batters().filter(b => b.pa >= 20).slice(0, 3).map(b => `${esc(b.meta.name)} (${r3(b.ops)})`).join(', ');

  const H = [];
  H.push(`<!doctype html><html><head><meta charset='utf-8'><style>
@page{size:letter;margin:0.42in 0.5in;}
*{box-sizing:border-box;margin:0;padding:0;}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{font-family:'Oswald','Arial Narrow',sans-serif;background:#16102b;color:#f0ede4;font-size:9px;line-height:1.32;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.hd{display:flex;align-items:center;gap:11px;border-bottom:2.5px solid #ecc913;padding-bottom:8px;margin-bottom:8px;}
.hd img{width:46px;height:46px;}
.t1{font-size:9px;letter-spacing:.22em;color:#ffd633;font-weight:700;text-transform:uppercase;}
h1{font-size:19px;font-weight:700;letter-spacing:.02em;color:#fff;line-height:1.05;text-transform:uppercase;}
.t3{font-size:9.5px;color:#b9a6ee;font-family:-apple-system,sans-serif;}
.res{margin-left:auto;text-align:right;}
.badge{display:inline-block;color:#fff;font-weight:700;font-size:10px;padding:3px 10px;border-radius:5px;letter-spacing:.03em;}
.rec{font-size:9px;color:#9a8cc4;margin-top:3px;font-family:-apple-system,sans-serif;}
h2{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#ffd633;margin:9px 0 4px;border-left:3px solid #714ad2;padding-left:7px;}
p{font-family:-apple-system,'Segoe UI',Helvetica,sans-serif;font-size:9px;margin:3px 0;color:#e7e2f3;}
.lead{background:#1e1640;border:1px solid #41327a;border-radius:6px;padding:6px 9px;}
b.g{color:#ffd633;}b.w{color:#fff;}
table{width:100%;border-collapse:collapse;margin:2px 0;font-family:-apple-system,'Segoe UI',sans-serif;font-size:8.3px;}
th{background:#2b1e5c;color:#cdbdf2;text-align:left;padding:3px 6px;font-size:7.4px;text-transform:uppercase;letter-spacing:.05em;}
td{padding:2.5px 6px;border-bottom:1px solid #2b2150;color:#ece8f7;}
tr:nth-child(even) td{background:#1a1338;}
.c{text-align:center;}.tn{font-weight:700;color:#fff;}.rk{font-weight:700;color:#ffd633;}.dn{color:#e0a0a0;}
.gd{font-weight:700;}.gd.good{color:#7BD88F;}.gd.bad{color:#e0a0a0;}.gd.neu{color:#b9a6ee;}
.watch{list-style:none;font-size:8.4px;font-family:-apple-system,sans-serif;color:#e7e2f3;margin:1px 0 4px;}.watch li{margin:1.5px 0;}.watch b{color:#ffd633;}
.totrow td{background:#241a4d;font-weight:700;color:#ffd633;border-top:1px solid #41327a;}
ol{margin:3px 0 3px 16px;font-family:-apple-system,sans-serif;font-size:9px;color:#e7e2f3;}
.cols{display:flex;gap:12px;}.cols>div{flex:1;}
.warn{background:#3a2150;border:1px solid #e0a0a0;color:#ffd0d0;border-radius:5px;padding:4px 8px;font-family:-apple-system,sans-serif;font-size:8px;margin:5px 0;}
.foot{margin-top:7px;border-top:1px solid #41327a;padding-top:5px;font-size:7.4px;color:#9a8cc4;font-family:-apple-system,sans-serif;font-style:italic;}
</style></head><body>`);
  H.push(`<div class='hd'><img src='${S.gatorsLogoDataUri()}'><div><div class='t1'>Gumbeaux Gators · Post-Game Report</div><h1>${esc(game.date)} · ${vs} ${esc(oppName)}</h1><div class='t3'>${game.home ? 'Home' : 'Away'} · ${T.w}-${T.l}</div></div><div class='res'><div class='badge' style='background:${badgeColor}'>${badge}</div><div class='rec'>Record ${T.w}–${T.l} · ${SEASON.diff >= 0 ? '+' : ''}${SEASON.diff} run diff</div></div></div>`);
  if (partial) H.push(`<div class='warn'>⚠️ Partial data — this game is still filling into the daily seed (${ipStr(tp.outs)} IP logged). Re-run after the next refresh for the complete line.</div>`);
  H.push(`<div class='lead'><p><b class='g'>Bottom line —</b> ${lead}</p></div>`);

  H.push(`<h2>Hitters — performance &amp; trend</h2><table><tr><th>Player</th><th class='c'>Last night</th><th class='c'>PA</th><th>AVG/OBP/SLG (OPS)</th><th class='c'>ISO</th><th class='c'>BB/K%</th><th class='c'>TCL</th><th class='c'>L5</th><th class='c'>Grade</th></tr>`);
  bat.forEach(b => {
    const s = BAT_SEASON[b.slug];
    const season = s ? `${r3(s.avg)}/${r3(s.obp)}/${r3(s.slg)} (${r3(s.ops)})` : '—';
    const rank = s && s.ranks && s.ranks.slg ? `<span class='rk'>${esc(s.ranks.slg)}</span>` : '—';
    const l5 = s && s.l5avg != null ? r3(s.l5avg) + (trendTag(s) || '') : '—';
    const disc = s ? `${pct0(s.bbp)}/${pct0(s.kp)}` : '—';
    H.push(`<tr><td>${esc(b.meta.name)}${b.meta.pos ? ', ' + esc(b.meta.pos) : ''}</td><td class='c tn'>${nightBat(b)}</td><td class='c'>${s ? s.pa : '—'}</td><td>${season}</td><td class='c'>${s ? r3(s.iso) : '—'}</td><td class='c'>${disc}</td><td class='c'>${rank}</td><td class='c'>${l5}</td><td class='c'>${gradeHtml(hitGrade(s))}</td></tr>`);
  });
  H.push(`<tr class='totrow'><td>TEAM</td><td class='c'>${tb.h} H · ${tb.rbi} RBI</td><td class='c'>—</td><td>${tb.bb} BB · ${tb.k} K · ${tb.ab} AB</td><td class='c'>—</td><td class='c'>—</td><td class='c'>—</td><td class='c'>—</td><td class='c'>—</td></tr></table>`);

  H.push(`<h2>Pitching — performance &amp; workload</h2><table><tr><th>Pitcher</th><th class='c'>Last night (IP-H-R-ER-BB-K)</th><th class='c'>Role</th><th class='c'>ERA/WHIP</th><th class='c'>K/9</th><th class='c'>BB/9</th><th class='c'>BAA</th><th class='c'>L3</th><th class='c'>7d</th><th class='c'>Grade</th></tr>`);
  pit.forEach(pr => {
    const s = PIT_SEASON[pr.slug];
    const tonight = `${pr.ipStr}-${pr.h}-${pr.r}-${pr.er}-${pr.bb}-${pr.k}`;
    const sev = s && s.era >= 6 ? ' dn' : '';
    const wl = workload(pr.slug, 7);
    H.push(`<tr><td>${esc(pr.meta.name)}</td><td class='c tn'>${tonight}</td><td class='c'>${s ? s.role : '—'}</td><td class='c${sev}'>${s ? `${r2(s.era)}/${r2(s.whip)}` : '—'}</td><td class='c'>${s ? r1(s.k9) : '—'}</td><td class='c'>${s ? r1(s.bb9) : '—'}</td><td class='c'>${s && s.baa ? r3(s.baa) : '—'}</td><td class='c${sev}'>${s && s.l3era != null ? r2(s.l3era) : '—'}</td><td class='c'>${wl.apps || '—'}</td><td class='c'>${gradeHtml(pitGrade(s))}</td></tr>`);
  });
  H.push(`<tr class='totrow'><td>TEAM</td><td class='c'>${ipStr(tp.outs)} IP · ${tp.h} H · ${tp.er} ER · ${tp.k} K</td><td class='c'>—</td><td class='c'>${tp.bb} BB${gameBB9 != null ? ` · ${gameBB9.toFixed(1)} BB/9` : ''}</td><td class='c'>—</td><td class='c'>—</td><td class='c'>—</td><td class='c'>—</td><td class='c'>—</td><td class='c'>—</td></tr></table>`);

  // Roster Watch — GM action items across the whole roster.
  const upHtml = [...watch.upBats.slice(0, 5).map(b => `${esc(b.meta.name)} (${S.pts(b.trend)})`), ...watch.upArms.slice(0, 3).map(x => `${esc(x.meta.name)} (L3 ${r2(x.l3era)})`)];
  const strHtml = [...watch.strugBats.map(b => `${esc(b.meta.name)} (${r3(b.ops)})`), ...watch.strugArms.map(x => `${esc(x.meta.name)} (${r2(x.era)} ERA)`)];
  const cold = watch.coldBats.slice(0, 6).map(b => `${esc(b.meta.name)} (${S.pts(b.trend)})`);
  H.push(`<h2>Roster Watch — for the GM</h2><ul class='watch'>`
    + `<li><b>Trending up (ride / more reps):</b> ${upHtml.length ? upHtml.join(' · ') : '—'}</li>`
    + `<li><b>Cooling off (watch):</b> ${cold.length ? cold.join(' · ') : '—'}</li>`
    + `<li><b>Struggling (consider a change):</b> ${strHtml.length ? strHtml.slice(0, 8).join(' · ') : '—'}</li>`
    + `<li><b>Workload (rest candidates):</b> ${watch.heavyArms.length ? watch.heavyArms.map(x => `${esc(x.p.meta.name)} (${x.wl.apps} app/${ipStr(x.wl.outs)} IP · 7d)`).join(' · ') : '—'}</li>`
    + `</ul>`);

  H.push(`<div class='cols'><div><h2>Notes</h2><ol>${notes.map(n => `<li>${n}</li>`).join('')}</ol></div><div><h2>Season context</h2><p>${T.w}–${T.l}, ${SEASON.diff >= 0 ? '+' : ''}${SEASON.diff} run diff · <b class='g'>Pythag ${pythW}-${pythL}</b> (${luck === 0 ? 'on its record' : luck > 0 ? `+${luck} over` : `${luck} under`}) · ${SEASON.last10} L10. Home ${SEASON.hw}-${SEASON.hl}, away ${SEASON.aw}-${SEASON.al}, 1-run ${SEASON.oneRun}. Top bats: ${topBats}. Staff <b class='g'>${staffBB9 ? staffBB9.toFixed(1) : '—'} BB/9</b>.</p></div></div>`);
  H.push(`<div class='foot'>Season slash, ISO, BB%/K%, TCL rank, K/9·BB/9·BAA and form are season-to-date from the daily seed. L5 = last-5-game AVG, L3 = last-3-outing ERA, 7d = appearances in the trailing 7 days. Grades are heuristic evaluation cues (Elite ≥.900 OPS · Hot/Cold ±60pts L5 · Struggling ≤.600 OPS or ≥6.00 ERA · Reliable ≤3.50 ERA &amp; ≤4 BB/9 · Wild ≥5 BB/9), gated on sample size — not official ratings.</div>`);
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
