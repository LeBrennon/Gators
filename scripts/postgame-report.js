#!/usr/bin/env node
// Post-game report generator for the Gumbeaux Gators.
// Reconstructs one game from the daily seed's per-player logs and frames every
// line against the season baseline (season AVG/OBP/SLG + league rank + hot/cold
// trend for hitters; season ERA/WHIP + role + last-3 form for pitchers). Offline.
//
//   node scripts/postgame-report.js              # latest game -> stdout
//   node scripts/postgame-report.js "Jun 24"     # a specific date
//   node scripts/postgame-report.js 20260624_xxxx # a specific box id
//   node scripts/postgame-report.js latest --write # also save under reports/postgame/
//
// Note: the latest game can be partial until the daily seed finishes refreshing
// every player's log — the report flags this when the pitching IP looks short.

const fs = require('fs');
const path = require('path');
const S = require('./lib/season');
const { r2, r3, signed, ipStr } = S;

const args = process.argv.slice(2).filter(a => a !== '--write');
const WRITE = process.argv.includes('--write');
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

// ---- header ----------------------------------------------------------------
const res = game.win == null ? '' : (game.win ? 'W' : 'L') + ` ${game.gs}-${game.os}`;
const where = game.home ? 'Home' : 'Away';
p(`# Post-Game Report — ${game.date}, 2026`);
p('');
p(`**Lake Charles Gumbeaux Gators ${game.win ? '' : ''}vs. ${S.oppShort(game.opp).replace(/^@ /, '')}** — ${where}`);
p(`**Final: ${res ? (game.win ? `Gators ${game.gs}, ${S.oppShort(game.opp).replace(/^@ /, '')} ${game.os}` : `${S.oppShort(game.opp).replace(/^@ /, '')} ${game.os}, Gators ${game.gs}`) : '—'} — ${game.win ? 'Win' : 'Loss'} · Record: ${T.w}-${T.l}**`);
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
p('## Hitters — tonight vs. season');
p('');
p('Trend = season hot/cold (last-5 AVG vs season). AVG→ = running average before→after this game.');
p('');
p('| Player | Tonight | HR | RBI | BB | K | Season AVG/OBP/SLG (OPS) | Rank | Trend | AVG→ |');
p('|---|:--:|--:|--:|--:|--:|---|:--:|:--:|--:|');
bat.forEach(b => {
  const s = BAT_SEASON[b.slug];
  const line = `${b.h}-${b.ab}`;
  const season = s ? `${r3(s.avg)}/${r3(s.obp)}/${r3(s.slg)} (${r3(s.ops)})` : '—';
  const rank = s && s.ranks && s.ranks.slg ? s.ranks.slg : '—';
  const mv = b.avgAfter != null ? (b.avgBefore != null ? `${r3(b.avgBefore)}→${r3(b.avgAfter)}` : r3(b.avgAfter)) : '—';
  p(`| ${b.meta.num ? b.meta.num + ' ' : ''}${b.meta.name} | ${line} | ${b.hr || ''} | ${b.rbi || ''} | ${b.bb || ''} | ${b.k || ''} | ${season} | ${rank} | ${s ? trendTag(s).trim() || '·' : '—'} | ${mv} |`);
});
p('');

// ---- pitchers --------------------------------------------------------------
p('## Pitching — tonight vs. season');
p('');
p('Role/ERA/WHIP are season-to-date. L3 = last-3-outing form. ERA→ = running ERA before→after this game.');
p('');
p('| Pitcher | Tonight (IP-H-R-ER-BB-K) | Season ERA/WHIP | Role | L3 ERA | ERA→ |');
p('|---|:--:|:--:|:--:|--:|--:|');
pit.forEach(pr => {
  const s = PIT_SEASON[pr.slug];
  const tonight = `${pr.ipStr}-${pr.h}-${pr.r}-${pr.er}-${pr.bb}-${pr.k}`;
  const season = s ? `${r2(s.era)}/${r2(s.whip)}` : '—';
  const role = s ? s.role : '—';
  const l3 = s && s.l3era != null ? r2(s.l3era) : '—';
  const mv = pr.eraAfter != null ? (pr.eraBefore != null ? `${r2(pr.eraBefore)}→${r2(pr.eraAfter)}` : r2(pr.eraAfter)) : '—';
  p(`| ${pr.meta.num ? pr.meta.num + ' ' : ''}${pr.meta.name} | ${tonight} | ${season} | ${role} | ${l3} | ${mv} |`);
});
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
p(`- **Team:** ${T.w}-${T.l}, ${SEASON.diff >= 0 ? '+' : ''}${SEASON.diff} run differential on the season; ${SEASON.last10} last 10.`);
p(`- **Top bats:** ${topBats}.`);
p(`- **Staff command:** ${staffBB9 ? staffBB9.toFixed(1) : '—'} BB/9 season-wide — the recurring run-prevention story.`);
p('');
p(`_Generated by \`scripts/postgame-report.js ${target === 'latest' ? '' : '"' + target + '"'}\` from the daily seed (\`roster-seed.json\`). Full baselines: \`reports/season-reference-2026.md\`._`);
p('');

const md = L.join('\n');
if (WRITE) {
  const dir = path.join(__dirname, '..', 'reports', 'postgame');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const day = game.id.slice(0, 8); // YYYYMMDD
  const file = path.join(dir, `${day}-${S.oppShort(game.opp).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`);
  fs.writeFileSync(file, md + '\n');
  console.error('wrote', path.relative(path.join(__dirname, '..'), file));
}
process.stdout.write(md + '\n');
