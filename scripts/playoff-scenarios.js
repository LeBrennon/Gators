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
// Baseball-style PCT: three decimals, no leading zero (.588, not 0.588) — the
// secondary 2H sort key, only reached as a tiebreak when GOA is exactly equal.
const fmtPct = p => (p == null ? '' : p.toFixed(3).replace(/^0/, ''));

// How many more games team A needs to win than team B, over N equal remaining
// games each, to (a) force a tie on games-over-.500 and (b) finish strictly
// ahead. See the module doc comment: ranking runs on GOA, not raw wins.
function winDiffNeeded(goaA, goaB) {
  const gap = goaB - goaA;             // B's current GOA lead over A (can be negative)
  if (gap <= 0) return { gap, tie: null, pass: 1 };  // A already level or ahead; +1 differential clears B outright
  const evenGap = gap % 2 === 0;
  return { gap, tie: evenGap ? gap / 2 : null, pass: Math.floor(gap / 2) + 1 };
}

// Every way the Gators' remaining games can go, and what each combination
// means for the 2nd-half race. Games against a rival still alive for one of
// the 2 open spots are branched by win count (0..k) — order doesn't change
// the final standings math, so a 2-game set collapses to 3 outcomes, not 4.
// Games against a team that's clinched or already eliminated only move the
// Gators' own total, not the race, so they're folded into a +/-1-per-game
// range instead of a separate branch. Rivals not on the Gators' remaining
// schedule get the same win-out/lose-out range, held constant across every
// branch. This is the same conservative ceiling/floor idea as the app's own
// computeElimination (server.js) — just in GOA terms, to match how
// rankSecondHalf actually sorts the second-half race.
function buildScenarioTree({ rows, gatorsId, gRow, remaining }) {
  const rivalRows = rows.filter(r => r.id !== gatorsId && !r.clinched && !r.eliminated);
  if (!rivalRows.length) return null;

  const byOpp = new Map(); // opponent short -> { row, count }
  for (const g of remaining) {
    const row = rivalRows.find(r => (r.short || r.name) === g.opponent.short);
    if (!row) continue;
    const e = byOpp.get(g.opponent.short) || { row, count: 0 };
    e.count++; byOpp.set(g.opponent.short, e);
  }
  const tracked = [...byOpp.values()].sort((a, b) => b.count - a.count);
  const trackedGames = tracked.reduce((s, o) => s + o.count, 0);

  // Cap the branch count so the table stays readable: keep adding tracked
  // opponents (highest game count first) while the combined outcome count
  // stays reasonable; fold anything past that into the neutral range.
  const branchOpp = [], foldedOpp = [];
  let product = 1;
  for (const o of tracked) {
    const next = product * (o.count + 1);
    if (branchOpp.length === 0 || next <= 30) { branchOpp.push(o); product = next; }
    else foldedOpp.push(o);
  }
  const extraNeutral = (remaining.length - trackedGames) + foldedOpp.reduce((s, o) => s + o.count, 0);

  const staticRivals = rivalRows
    .filter(r => !branchOpp.some(o => o.row === r))
    .map(r => ({ row: r, lo: goa(r) - r.gamesLeft, hi: goa(r) + r.gamesLeft }));

  function* combos(list, i = 0, acc = []) {
    if (i === list.length) { yield acc; return; }
    for (let w = 0; w <= list[i].count; w++) yield* combos(list, i + 1, [...acc, w]);
  }

  const branches = [];
  for (const wins of combos(branchOpp)) {
    const totalWins = wins.reduce((s, w) => s + w, 0);
    const rivalDelta = 2 * totalWins - trackedGames; // Gators' wins-minus-losses in these games
    const gLow = goa(gRow) + rivalDelta - extraNeutral;
    const gHigh = goa(gRow) + rivalDelta + extraNeutral;

    const branchRivals = branchOpp.map((o, i) => {
      const oppWins = o.count - wins[i], oppLosses = wins[i]; // opponent's own record in this head-to-head
      const otherGames = o.row.gamesLeft - o.count;
      const base = goa(o.row) + (oppWins - oppLosses);
      return { row: o.row, lo: base - otherGames, hi: base + otherGames };
    });
    const allRivals = [...branchRivals, ...staticRivals];

    // Worst case for the Gators (gLow) vs. each rival's best case (hi): anyone
    // who could still pass them is a live threat. Best case for the Gators
    // (gHigh) vs. each rival's floor (lo): anyone guaranteed ahead regardless.
    const threats = allRivals.filter(r => r.hi > gLow);
    const guaranteedAhead = allRivals.filter(r => r.lo > gHigh);
    const nm = r => esc(r.row.short || r.row.name);
    let status, note;
    if (guaranteedAhead.length >= 2) {
      status = 'out';
      note = guaranteedAhead.map(nm).join(' and ') + ' finish ahead no matter what happens the rest of the way.';
    } else if (threats.length <= 1) {
      status = 'clinch';
      note = threats.length
        ? `Only ${nm(threats[0])} could still catch them, and even then the Gators hold the 2nd spot.`
        : 'Locks a spot no matter what else happens.';
    } else {
      status = 'alive';
      note = threats.map(nm).join(', ') + ' still mathematically in it.';
    }
    branches.push({ wins, gLow, gHigh, status, note });
  }
  branches.sort((a, b) => b.gHigh - a.gHigh || b.gLow - a.gLow);
  return { branchOpp, extraNeutral, branches };
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

  const scenarioTree = buildScenarioTree({ rows, gatorsId, gRow, remaining });

  const asOf = new Date(standings.updatedAt || Date.now());
  const asOfStr = asOf.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

  const html = buildHtml({ rows, gatorsId, gRow, rank, holding, rivalLines, remaining, playoffs: standings.playoffs, asOfStr, scenarioTree });
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

function buildHtml({ rows, gatorsId, gRow, rank, holding, rivalLines, remaining, playoffs, asOfStr, scenarioTree }) {
  const standingsRows = rows.map((r, i) => {
    const isG = r.id === gatorsId;
    const clin = r.clinched ? '<span class="tag clinch">1H</span>' : '';
    const out = r.eliminated ? '<span class="tag out">Out</span>' : '';
    return `<tr class="${isG ? 'g' : ''}${r.eliminated ? ' out' : ''}">
      <td>${i + 1}</td><td class="nm">${esc(r.short || r.name)}${clin}${out}</td>
      <td>${(r.w2 | 0)}-${(r.l2 | 0)}</td><td class="goa">${fmtGoa(goa(r))}</td><td>${fmtPct(r.pct)}</td>
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

  // If the Gators and a rival finish level on games-over-.500 AND PCT (the two
  // teams truly tied, not just close), the next tie-break step is head-to-head
  // (docs/tcl-playoff-rules.md). Spell out which way that actually breaks —
  // this is the difference between finishing 2nd (in) and 3rd (out), not just
  // seeding, when only one spot separates two teams.
  function tieBreakNote(row, series) {
    const stillToPlay = remaining.some(g => g.opponent.short === row.short);
    const locked = stillToPlay ? '' : ' &mdash; locked in, they don’t play again this season';
    if (!series.games) return `They haven’t played this season, so a tie would fall straight to run differential.`;
    if (series.w > series.l) return `In a tie, head-to-head decides it: Gators lead the season series ${series.w}-${series.l}${locked}, so the tie breaks <b>for</b> the Gators &mdash; they'd finish 2nd, ${esc(row.short)} 3rd.`;
    if (series.w < series.l) return `In a tie, head-to-head decides it: ${esc(row.short)} lead the season series ${series.l}-${series.w}${locked}, so the tie breaks <b>against</b> the Gators &mdash; they'd finish 3rd, ${esc(row.short)} 2nd.`;
    return `The season series is even (${series.w}-${series.w}), so a tie would fall to run differential next.`;
  }

  const rivalCards = rivalLines.map(({ row, wd, series, equalGL }) => {
    const verb = holding ? 'holding off' : 'catching';
    let math;
    if (!equalGL) {
      math = `Games-left counts differ (Gators ${gRow.gamesLeft} vs ${row.short} ${row.gamesLeft}) &mdash; ${row.gb} GB, no clean win-for-win comparison.`;
    } else if (wd.gap <= 0) {
      math = `Gators are already level or ahead on games-over-.500 &mdash; one more win than ${esc(row.short)} the rest of the way clears them outright. ${tieBreakNote(row, series)}`;
    } else if (wd.tie != null) {
      math = `Win at least <b>${wd.tie}</b> more of their last games than ${esc(row.short)} does to force a tie &mdash; <b>${wd.pass}</b>+ to clinch outright, no tiebreaker needed. ${tieBreakNote(row, series)}`;
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

  const bottomLine = holding
    ? `Bottom line: the Gators are in a playoff spot right now. Win the games in front of them and the ${rivalLines.map(r => esc(r.row.short)).join(' / ')} chase becomes someone else's problem.`
    : `Bottom line: the Gators can't play their way past ${rivalLines.map(r => esc(r.row.short)).join(' or ')} on the field again this season &mdash; win out at home and on the road, then watch the scoreboard.`;

  const scenarioPage = (() => {
    if (!scenarioTree) {
      return `<h2 class="sec">Scenario Tree</h2>
        <div class="path"><div class="pathstatus">Nobody else in the second-half race is still mathematically alive to contest these two spots &mdash; there's no branching left to show.</div></div>`;
    }
    const { branchOpp, extraNeutral, branches } = scenarioTree;
    const branchGames = branchOpp.reduce((s, o) => s + o.count, 0);
    const branchSummary = branchOpp.map(o => `${o.count} vs ${esc(o.row.short || o.row.name)}`).join(' and ');
    const oppHeaders = branchOpp.map(o => `<th>vs ${esc(o.row.short || o.row.name)}</th>`).join('');
    const bodyRows = branches.map(b => {
      const oppCells = branchOpp.map((o, i) => `<td>${b.wins[i]}-${o.count - b.wins[i]}</td>`).join('');
      const goaCell = b.gLow === b.gHigh ? fmtGoa(b.gLow) : `${fmtGoa(b.gLow)} to ${fmtGoa(b.gHigh)}`;
      const badge = b.status === 'clinch' ? '<span class="stbadge st-clinch">Clinches</span>'
        : b.status === 'out' ? '<span class="stbadge st-out">Eliminated</span>'
        : '<span class="stbadge st-alive">Still Alive</span>';
      return `<tr class="st-${b.status}">${oppCells}<td class="goa">${goaCell}</td><td>${badge}</td><td class="stnote">${b.note}</td></tr>`;
    }).join('');
    const neutralNote = extraNeutral
      ? `The other ${extraNeutral} game${extraNeutral === 1 ? '' : 's'} left on the schedule ${extraNeutral === 1 ? "doesn't" : "don't"} change anyone else's position (already-clinched or already-eliminated opponents), so each row's GOA is a range depending on how ${extraNeutral === 1 ? 'that one goes' : 'those go'}.`
      : `Every remaining game is accounted for above &mdash; no other games left to swing the range.`;
    return `<h2 class="sec">Scenario Tree &mdash; The Final Stretch</h2>
    <div class="stintro">Of the Gators' ${branchGames + extraNeutral} games left, <b>${branchSummary}</b> decide the second-half race directly &mdash; both teams' positions move together on those games. Every combination of how they go is broken out below, best case first. ${neutralNote}</div>
    <table class="sttree"><tr>${oppHeaders}<th>Gators GOA</th><th>Status</th><th>What It Means</th></tr>${bodyRows}</table>
    <div class="legend" style="margin-top:6px;"><span class="stbadge st-clinch">Clinches</span> a spot no matter what else happens &middot; <span class="stbadge st-alive">Still Alive</span> in the mix, outcome depends on other results &middot; <span class="stbadge st-out">Eliminated</span> mathematically done in that branch</div>`;
  })();

  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:letter;margin:0;}
*{box-sizing:border-box;margin:0;padding:0;}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1b1e27;font-size:13.5px;}
.page{padding:20px 40px 14px;}
.page1{height:100vh;display:flex;flex-direction:column;overflow:hidden;page-break-after:always;}
.page2{display:flex;flex-direction:column;}
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
.path{border:1px solid #e6def7;border-top:none;border-radius:0 0 7px 7px;padding:9px 11px;}
.pathstatus{font-size:13px;margin-bottom:8px;}
.pathstatus b{color:#3a2480;}
.rivals{display:flex;gap:12px;}
.rival{flex:1;border:1px solid #e6def7;border-radius:9px;padding:8px 11px;background:#faf8ff;}
.rivalhead{font-size:12px;margin-bottom:4px;}
.rivalmath{font-size:11px;line-height:1.42;}
.rivalseries{font-size:10px;margin-top:4px;}
.sched table{border:1px solid #e6def7;border-radius:7px;overflow:hidden;}
.sched th,.sched td{padding:5px 9px;font-size:11.5px;text-align:left;border-bottom:1px solid #efeaf9;}
.sched th{background:#3a2480;color:#fff;font-size:9px;text-transform:uppercase;letter-spacing:.03em;}
.sched tr:nth-child(2n) td{background:#f6f2fc;}
.tiebreak{margin-top:9px;border:1px solid #e6def7;border-radius:9px;padding:8px 14px;background:#faf8ff;}
.tiebreak h3{font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#3a2480;margin-bottom:4px;}
.tbcols{display:flex;gap:18px;}
.tbcol{flex:1;font-size:10px;line-height:1.4;}
.tbcol ol{margin-left:15px;}
.bottomline{margin-top:7px;text-align:center;font-size:12px;font-weight:700;color:#3a2480;background:#f6f2fc;border:1px dashed #c9b8ef;border-radius:9px;padding:6px 14px;}
footer{margin-top:4px;padding-top:4px;border-top:1px solid #e6def7;font-size:8.5px;color:#8a84a0;display:flex;justify-content:space-between;}
.stintro{font-size:11.5px;line-height:1.5;background:#faf8ff;border:1px solid #e6def7;border-radius:9px;padding:9px 12px;margin-top:8px;}
.sttree{margin-top:9px;border:1px solid #e6def7;border-radius:7px;overflow:hidden;}
.sttree th,.sttree td{padding:6px 9px;font-size:11px;text-align:center;border-bottom:1px solid #efeaf9;}
.sttree th{background:#3a2480;color:#fff;font-size:9px;text-transform:uppercase;letter-spacing:.03em;}
.sttree td.goa{font-weight:700;font-variant-numeric:tabular-nums;}
.sttree td.stnote{text-align:left;font-size:10.5px;color:#3a2480;}
.sttree tr:nth-child(2n) td{background:#f6f2fc;}
.sttree tr.st-out td{opacity:.55;}
.stbadge{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;border-radius:999px;padding:2px 8px;white-space:nowrap;}
.st-clinch{color:#1c7a3f;background:#e4f6ea;border:1px solid #bfe8cc;}
.st-alive{color:#a3790c;background:#fff8e0;border:1px solid #ecc913;}
.st-out{color:#8a1a4c;background:#fbe6ef;border:1px solid #eec0d6;}
</style></head><body>
<div class="page page1">
<div class="band"><img src="${S.gatorsLogoDataUri()}">
  <div><div class="k">Gumbeaux Gators &middot; Path to the Playoffs</div>
  <h1>2026 Second-Half Race</h1>
  <div class="sub">Currently ${ordinal(rank)} place, ${(gRow.w2 | 0)}-${(gRow.l2 | 0)} (${fmtGoa(goa(gRow))} games over .500) &middot; ${gRow.gamesLeft} games left</div></div>
</div>

<div class="grid">
  <div class="col" style="flex:1.3">
    <h2 class="sec">Second-Half Standings</h2>
    <table class="sttbl"><tr><th>#</th><th>Team</th><th>2H</th><th>GOA</th><th>PCT</th><th>GB</th><th>Season</th><th>GL</th></tr>${standingsRows}</table>
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

<div class="sched">
  <h2 class="sec">Remaining Schedule (${remaining.length})</h2>
  <table><tr><th>Date</th><th>Opponent</th><th>Time</th></tr>${remRows}</table>
</div>

<div class="tiebreak">
  <h3>If It Comes Down To A Tie</h3>
  <div class="tbcols">
    <div class="tbcol"><b>2 teams level:</b><ol><li>Games back</li><li>Win percentage</li><li>Head-to-head</li><li>Run differential</li><li>Run diff. in head-to-head games</li><li>Winner of the last regulation meeting</li></ol></div>
    <div class="tbcol"><b>3+ teams level:</b><ol><li>Head-to-head among the tied teams</li><li>Run differential</li><li>Run diff. in head-to-head games among the tied teams</li></ol></div>
  </div>
</div>

<div class="bottomline">${bottomLine}</div>

<footer><span>Data as of ${esc(asOfStr)} &middot; source: texasleaguestats.prestosports.com</span><span>whatisthegatorscore.com &middot; docs/tcl-playoff-rules.md</span></footer>
</div>
<div class="page page2">
${scenarioPage}
<footer style="margin-top:auto;"><span>Data as of ${esc(asOfStr)} &middot; source: texasleaguestats.prestosports.com</span><span>whatisthegatorscore.com &middot; docs/tcl-playoff-rules.md</span></footer>
</div>
</body></html>`;
}

function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

main().catch(e => { console.error(e); process.exit(1); });
