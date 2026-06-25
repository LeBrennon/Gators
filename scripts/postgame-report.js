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

// ===========================================================================
// Branded one-page PDF (Gumbeaux Gators colors + logo, matching the app). Built
// from the same computed data as the markdown. Rendered with the system Chromium
// so there's no heavy repo dependency.
// ===========================================================================
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function nightBat(b) { let s = `${b.h}-${b.ab}`; const x = []; if (b.hr) x.push(`${b.hr} HR`); if (b.rbi) x.push(`${b.rbi} RBI`); if (b.bb) x.push(`${b.bb} BB`); if (b.k) x.push(`${b.k} K`); return x.length ? `${s} · ${x.join(', ')}` : s; }

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
.totrow td{background:#241a4d;font-weight:700;color:#ffd633;border-top:1px solid #41327a;}
ol{margin:3px 0 3px 16px;font-family:-apple-system,sans-serif;font-size:9px;color:#e7e2f3;}
.cols{display:flex;gap:12px;}.cols>div{flex:1;}
.warn{background:#3a2150;border:1px solid #e0a0a0;color:#ffd0d0;border-radius:5px;padding:4px 8px;font-family:-apple-system,sans-serif;font-size:8px;margin:5px 0;}
.foot{margin-top:7px;border-top:1px solid #41327a;padding-top:5px;font-size:7.4px;color:#9a8cc4;font-family:-apple-system,sans-serif;font-style:italic;}
</style></head><body>`);
  H.push(`<div class='hd'><img src='${S.gatorsLogoDataUri()}'><div><div class='t1'>Gumbeaux Gators · Post-Game Report</div><h1>${esc(game.date)} · ${vs} ${esc(oppName)}</h1><div class='t3'>${game.home ? 'Home' : 'Away'} · ${T.w}-${T.l}</div></div><div class='res'><div class='badge' style='background:${badgeColor}'>${badge}</div><div class='rec'>Record ${T.w}–${T.l} · ${SEASON.diff >= 0 ? '+' : ''}${SEASON.diff} run diff</div></div></div>`);
  if (partial) H.push(`<div class='warn'>⚠️ Partial data — this game is still filling into the daily seed (${ipStr(tp.outs)} IP logged). Re-run after the next refresh for the complete line.</div>`);
  H.push(`<div class='lead'><p><b class='g'>Bottom line —</b> ${lead}</p></div>`);

  H.push(`<h2>Hitters — last night vs. season</h2><table><tr><th>Player</th><th class='c'>Last night</th><th>Season AVG/OBP/SLG (OPS)</th><th class='c'>TCL</th><th class='c'>Last 5</th></tr>`);
  bat.forEach(b => {
    const s = BAT_SEASON[b.slug];
    const season = s ? `${r3(s.avg)}/${r3(s.obp)}/${r3(s.slg)} (${r3(s.ops)})` : '—';
    const rank = s && s.ranks && s.ranks.slg ? `<span class='rk'>${esc(s.ranks.slg)}</span>` : '—';
    const l5 = s && s.l5avg != null ? r3(s.l5avg) : '—';
    H.push(`<tr><td>${esc(b.meta.name)}${b.meta.pos ? ', ' + esc(b.meta.pos) : ''}</td><td class='c tn'>${nightBat(b)}</td><td>${season}</td><td class='c'>${rank}</td><td class='c'>${l5}</td></tr>`);
  });
  H.push(`<tr class='totrow'><td>TEAM</td><td class='c'>${tb.h} H · ${tb.rbi} RBI</td><td>${tb.bb} BB · ${tb.k} K · ${tb.ab} AB</td><td class='c'>—</td><td class='c'>—</td></tr></table>`);

  H.push(`<h2>Pitching — last night vs. season</h2><table><tr><th>Pitcher</th><th class='c'>Last night (IP-H-R-ER-BB-K)</th><th class='c'>Season ERA/WHIP</th><th class='c'>Role</th><th class='c'>L3 ERA</th></tr>`);
  pit.forEach(pr => {
    const s = PIT_SEASON[pr.slug];
    const tonight = `${pr.ipStr}-${pr.h}-${pr.r}-${pr.er}-${pr.bb}-${pr.k}`;
    const sev = s && s.era >= 6 ? ' dn' : '';
    H.push(`<tr><td>${esc(pr.meta.name)}</td><td class='c tn'>${tonight}</td><td class='c${sev}'>${s ? `${r2(s.era)} / ${r2(s.whip)}` : '—'}</td><td class='c'>${s ? s.role : '—'}</td><td class='c${sev}'>${s && s.l3era != null ? r2(s.l3era) : '—'}</td></tr>`);
  });
  H.push(`<tr class='totrow'><td>TEAM</td><td class='c'>${ipStr(tp.outs)} IP · ${tp.h} H · ${tp.er} ER · ${tp.k} K</td><td class='c'>${tp.bb} BB${gameBB9 != null ? ` · ${gameBB9.toFixed(1)} BB/9` : ''}</td><td class='c'>—</td><td class='c'>—</td></tr></table>`);

  H.push(`<div class='cols'><div><h2>Notes</h2><ol>${notes.map(n => `<li>${n}</li>`).join('')}</ol></div><div><h2>Season context</h2><p>${T.w}–${T.l}, ${SEASON.diff >= 0 ? '+' : ''}${SEASON.diff} diff, ${SEASON.last10} last 10. Top bats: ${topBats}. Lever stays <b class='g'>strike-throwing</b> (${staffBB9 ? staffBB9.toFixed(1) : '—'} BB/9).</p></div></div>`);
  H.push(`<div class='foot'>Lines reconstructed from the daily seed (roster-seed.json); season AVG/OBP/SLG, TCL ranks, and Last-5 form are season-to-date. “Last 5” = batting average over the last five games (recent-form context, not a grade on tonight). OPS=OBP+SLG · L3=last 3 outings.</div>`);
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
