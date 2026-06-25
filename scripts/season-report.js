#!/usr/bin/env node
// Season reference generator for the Gumbeaux Gators GM.
// Reads the committed roster-seed.json (season totals + per-game logs + league
// ranks, refreshed daily by the seed workflow) and the roster in server.js, then
// emits a season-to-date reference (reports/season-reference-2026.md) used as the
// baseline for post-game reports. Pure offline computation — no network needed.
//
//   node scripts/season-report.js            # write reports/season-reference-2026.md
//   node scripts/season-report.js --stdout   # print to stdout instead

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---- load data -------------------------------------------------------------
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'roster-seed.json'), 'utf8'));
const PC = seed.playerCache || {};
const RS = seed.rosterStats || {};

// roster (num/name/pos/class) parsed straight from server.js so names/positions
// stay the single source of truth.
function loadRoster() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const re = /\{ num: (\d+),\s*name: '([^']+)',\s*slug: '([^']+)',\s*pos: '([^']+)',\s*cls: '([^']+)'/g;
  const out = {}; let m;
  while ((m = re.exec(src))) out[m[3]] = { num: +m[1], name: m[2], pos: m[4], cls: m[5], slug: m[3] };
  return out;
}
const ROSTER = loadRoster();

// ---- small helpers ---------------------------------------------------------
const num = v => { if (v == null) return 0; const s = String(v).trim(); if (s === '' || s === '-' || s === '·') return 0; const n = parseFloat(s); return isFinite(n) ? n : 0; };
const i3 = v => { const s = String(v == null ? '' : v).trim(); if (!s || s === '-') return 0; const p = s.split('.'); return (parseInt(p[0], 10) || 0) * 3 + (p[1] ? parseInt(p[1][0], 10) || 0 : 0); }; // IP -> outs
const ipStr = outs => `${Math.floor(outs / 3)}.${outs % 3}`;
const r3 = x => (x == null || !isFinite(x)) ? '—' : x.toFixed(3).replace(/^0(\.\d)/, '$1');
const r2 = x => (x == null || !isFinite(x)) ? '—' : x.toFixed(2);
const pct = x => (x == null || !isFinite(x)) ? '—' : (x * 100).toFixed(1) + '%';
const signed = x => (x > 0 ? '+' : '') + x;

// box id is the chronological key (YYYYMMDD_xxxx); sort logs by it.
const boxId = row => { const m = String(row.boxUrl || '').match(/(\d{8}_[a-z0-9]+)/); return m ? m[1] : (row.date || ''); };
const byBox = (a, b) => (boxId(a) < boxId(b) ? -1 : boxId(a) > boxId(b) ? 1 : 0);

const oppShort = o => String(o || '').replace('at ', '@ ')
  .replace('Acadiana Cane Cutters', 'Acadiana').replace('Baton Rouge Rougarou', 'Baton Rouge')
  .replace('Abilene Flying Bison', 'Abilene').replace('Brazos Valley Bombers', 'Brazos Valley')
  .replace('San Antonio River Monsters', 'San Antonio').replace('Sherman Shadowcats', 'Sherman')
  .replace('Victoria Generals', 'Victoria');

// ---- schedule (union of every player's game logs) --------------------------
function buildSchedule() {
  const games = {};
  for (const slug in PC) {
    const r = PC[slug] || {};
    ['glBat', 'glPit'].forEach(k => (r[k] || []).forEach(g => {
      const id = boxId(g);
      if (!games[id]) games[id] = { id, date: g.date, opp: g.opp, score: g.score };
    }));
  }
  const arr = Object.values(games).sort((a, b) => (a.id < b.id ? -1 : 1));
  // parse score "W, 11-1" / "L, 7-3" -> gators/opp runs (winner-first high-low).
  arr.forEach(g => {
    const m = String(g.score || '').match(/([WL]),?\s*(\d+)\s*-\s*(\d+)/i);
    if (m) {
      const win = /w/i.test(m[1]), hi = Math.max(+m[2], +m[3]), lo = Math.min(+m[2], +m[3]);
      g.win = win; g.gs = win ? hi : lo; g.os = win ? lo : hi; g.diff = g.gs - g.os;
      g.home = !/^at |^@ /.test(String(g.opp || '')) && !/^at/i.test(g.opp || '');
      g.home = !/\bat\b/i.test(String(g.opp || ''));
    }
  });
  return arr;
}
const SCHED = buildSchedule();

// ---- team record / form ----------------------------------------------------
function teamSummary() {
  let w = 0, l = 0, rf = 0, ra = 0, hw = 0, hl = 0, aw = 0, al = 0;
  SCHED.forEach(g => {
    if (g.win == null) return;
    if (g.win) w++; else l++;
    rf += g.gs; ra += g.os;
    const home = !/\bat\b/i.test(String(g.opp || ''));
    if (home) { g.win ? hw++ : hl++; } else { g.win ? aw++ : al++; }
  });
  const last = SCHED.filter(g => g.win != null);
  const lastN = n => { const s = last.slice(-n); const ww = s.filter(g => g.win).length; return `${ww}-${s.length - ww}`; };
  // current streak
  let streak = '';
  for (let k = last.length - 1; k >= 0; k--) { const c = last[k].win ? 'W' : 'L'; if (!streak) streak = c + '1'; else if (streak[0] === c) streak = c + (parseInt(streak.slice(1)) + 1); else break; }
  // one-run games
  const oneRun = last.filter(g => Math.abs(g.diff) === 1); const orW = oneRun.filter(g => g.win).length;
  return { w, l, rf, ra, hw, hl, aw, al, gp: w + l, last5: lastN(5), last10: lastN(10), streak,
    oneRun: `${orW}-${oneRun.length - orW}`, diff: rf - ra, rpg: rf / (w + l), rapg: ra / (w + l) };
}

// ---- batting ---------------------------------------------------------------
function batters() {
  const out = [];
  for (const slug in ROSTER) {
    const meta = ROSTER[slug]; const rec = PC[slug] || RS[slug] || {}; const h = rec.hit; if (!h) continue;
    if (meta.pos === 'P') continue; // pitchers' token at-bats aren't a GM hitting concern
    const ab = num(h.ab), hh = num(h.h), bb = num(h.bb), hbp = num(h.hbp), sf = num(h.sf), tb = num(h.tb);
    const pa = num(h.pa) || (ab + bb + hbp + sf), k = num(h.k);
    const avg = num(h.avg);
    // The league seed sometimes omits OBP/SLG for two-way/secondary bats; rebuild
    // them from components so OPS isn't a misleading .000.
    const obp = num(h.obp) || ((ab + bb + hbp + sf) ? (hh + bb + hbp) / (ab + bb + hbp + sf) : 0);
    const slg = num(h.slg) || (ab ? (tb || hh) / ab : 0); // TB missing -> singles floor (= AVG)
    const ops = obp + slg, iso = slg - avg;
    const ranks = (rec.hitRanks && Object.keys(rec.hitRanks).length) ? rec.hitRanks : (RS[slug] && RS[slug].hitRanks) || {};
    // last-5 from game logs
    const logs = (rec.glBat || []).slice().sort(byBox); const l5 = logs.slice(-5);
    const s = l5.reduce((a, g) => ({ ab: a.ab + num(g.ab), h: a.h + num(g.h), hr: a.hr + num(g.hr), rbi: a.rbi + num(g.rbi), bb: a.bb + num(g.bb), k: a.k + num(g.k) }), { ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, k: 0 });
    const l5avg = s.ab ? s.h / s.ab : null;
    out.push({ meta, h, ab, hh, bb, pa, k, avg, obp, slg, ops, iso, ranks,
      hr: num(h.hr), rbi: num(h.rbi), r: num(h.r), sb: num(h.sb), d2: num(h['2b']), t3: num(h['3b']),
      bbp: pa ? bb / pa : null, kp: pa ? k / pa : null, gp: num(h.gp),
      l5avg, l5line: `${s.h}-${s.ab}`, l5hr: s.hr, l5rbi: s.rbi, l5bb: s.bb, l5k: s.k,
      trend: (l5avg != null && avg) ? l5avg - avg : null });
  }
  // qualified = most PA; sort by OPS among those with >= 20 PA, then the rest
  out.sort((a, b) => b.ops - a.ops);
  return out;
}

// ---- pitching --------------------------------------------------------------
function pitchers() {
  const out = [];
  for (const slug in ROSTER) {
    const meta = ROSTER[slug]; const rec = PC[slug] || RS[slug] || {}; const p = rec.pit; if (!p) continue;
    const outs = i3(p.ip), ip = outs / 3, era = num(p.era), whip = num(p.whip);
    const bb = num(p.bb), k = num(p.k), hh = num(p.h), er = num(p.er), app = num(p.app), gs = num(p.gs);
    const k9 = ip ? (k * 9) / ip : null, bb9 = ip ? (bb * 9) / ip : null, kbb = bb ? k / bb : null;
    const role = gs >= Math.max(1, app * 0.5) ? 'SP' : (gs > 0 ? 'SwingP' : 'RP');
    const logs = (rec.glPit || []).slice().sort(byBox); const l3 = logs.slice(-3);
    const s = l3.reduce((a, g) => ({ outs: a.outs + i3(g.ip), er: a.er + num(g.er), r: a.r + num(g.r), bb: a.bb + num(g.bb), k: a.k + num(g.k), h: a.h + num(g.h) }), { outs: 0, er: 0, r: 0, bb: 0, k: 0, h: 0 });
    const l3era = s.outs ? (s.er * 27) / s.outs : null;
    out.push({ meta, p, ip, outs, era, whip, bb, k, hh, er, app, gs, role,
      w: num(p.w), l: num(p.l), sv: num(p.sv), k9, bb9, kbb, baa: num(p.baa),
      l3ip: ipStr(s.outs), l3era, l3bb: s.bb, l3k: s.k, l3r: s.r, apps: logs.length });
  }
  out.sort((a, b) => b.outs - a.outs);
  return out;
}

// ---- per-game team trend (sum player logs by game) -------------------------
function teamGameTrends() {
  const games = {};
  for (const slug in PC) {
    const r = PC[slug] || {};
    (r.glBat || []).forEach(g => { const id = boxId(g); (games[id] = games[id] || { id, date: g.date, opp: g.opp, score: g.score, bh: 0, bab: 0, bbb: 0, bk: 0, bhr: 0, pip: 0, per: 0, pbb: 0, pk: 0, ph: 0 }); games[id].bh += num(g.h); games[id].bab += num(g.ab); games[id].bbb += num(g.bb); games[id].bk += num(g.k); games[id].bhr += num(g.hr); });
    (r.glPit || []).forEach(g => { const id = boxId(g); (games[id] = games[id] || { id, date: g.date, opp: g.opp, score: g.score, bh: 0, bab: 0, bbb: 0, bk: 0, bhr: 0, pip: 0, per: 0, pbb: 0, pk: 0, ph: 0 }); games[id].pip += i3(g.ip); games[id].per += num(g.er); games[id].pbb += num(g.bb); games[id].pk += num(g.k); games[id].ph += num(g.h); });
  }
  return Object.values(games).sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ===========================================================================
// render
// ===========================================================================
function build() {
  const T = teamSummary();
  const BAT = batters();
  const PIT = pitchers();
  const TG = teamGameTrends();
  const updated = seed.rosterUpdated ? new Date(seed.rosterUpdated).toISOString().slice(0, 10) : '—';
  const L = [];
  const p = s => L.push(s);

  p('# Gumbeaux Gators — Season Reference (2026)');
  p('');
  p(`_Season-to-date baseline for post-game reports. Auto-generated by \`scripts/season-report.js\` from \`roster-seed.json\`. Stats through **${updated}** (${T.gp} games)._`);
  p('');

  // ---- team snapshot
  p('## Team snapshot');
  p('');
  p('| | |');
  p('|---|---|');
  p(`| Record | **${T.w}-${T.l}** (${(T.w / T.gp).toFixed(3).replace(/^0/, '')}) |`);
  p(`| Home / Away | ${T.hw}-${T.hl} home · ${T.aw}-${T.al} away |`);
  p(`| Last 10 / Last 5 | ${T.last10} / ${T.last5} |`);
  p(`| Current streak | ${T.streak} |`);
  p(`| Runs for / against | ${T.rf} / ${T.ra} (**${signed(T.diff)}** diff) |`);
  p(`| Runs per game | ${T.rpg.toFixed(1)} scored · ${T.rapg.toFixed(1)} allowed |`);
  p(`| One-run games | ${T.oneRun} |`);
  p('');

  // ---- key trends / GM flags
  p('## Key trends & flags');
  p('');
  const topBat = BAT.filter(b => b.pa >= 20).slice(0, 3).map(b => `${b.meta.name} (${r3(b.ops)} OPS)`).join(', ');
  const hot = BAT.filter(b => b.trend != null && b.pa >= 15 && b.trend > 0.04).sort((a, b) => b.trend - a.trend).slice(0, 3);
  const cold = BAT.filter(b => b.trend != null && b.pa >= 15 && b.trend < -0.04).sort((a, b) => a.trend - b.trend).slice(0, 3);
  const wildStaff = PIT.reduce((a, p2) => a + p2.bb, 0);
  const totK = PIT.reduce((a, p2) => a + p2.k, 0);
  const totIP = PIT.reduce((a, p2) => a + p2.outs, 0) / 3;
  p(`- **Top bats:** ${topBat || '—'}.`);
  if (hot.length) p(`- **Heating up (last 5 vs season AVG):** ${hot.map(b => `${b.meta.name} ${b.l5line}, ${signed(+(b.trend * 1000).toFixed(0))} pts`).join('; ')}.`);
  if (cold.length) p(`- **Cooling off:** ${cold.map(b => `${b.meta.name} ${b.l5line}, ${(b.trend * 1000).toFixed(0)} pts`).join('; ')}.`);
  p(`- **Staff command:** ${wildStaff} walks vs ${totK} K over ${totIP.toFixed(1)} IP (${(bb9All())} BB/9). Walks are the recurring run-prevention story — track team strike% each game.`);
  p(`- **Close-game record:** ${T.oneRun} in one-run games — bullpen leverage and late offense swing the season.`);
  p('');

  // ---- hitters
  p('## Hitters — season lines');
  p('');
  p('Sorted by OPS. **L5** = last 5 games; **Trend** = last-5 AVG minus season AVG (▲ hot / ▼ cold). Rank = Texas Collegiate League rank.');
  p('');
  p('| # | Player | Pos | G | AVG/OBP/SLG | OPS | HR | RBI | SB | BB% | K% | L5 | Trend |');
  p('|---|---|---|--:|---|--:|--:|--:|--:|--:|--:|---|:--:|');
  BAT.forEach(b => {
    const tr = b.trend == null ? '—' : (b.trend > 0.001 ? '▲ ' : b.trend < -0.001 ? '▼ ' : '· ') + signed(+(b.trend * 1000).toFixed(0));
    const rk = k => b.ranks && b.ranks[k] ? ` _(${b.ranks[k]})_` : '';
    p(`| ${b.meta.num} | ${b.meta.name} | ${b.meta.pos} | ${b.gp} | ${r3(b.avg)}/${r3(b.obp)}/${r3(b.slg)} | **${r3(b.ops)}**${rk('slg')} | ${b.hr} | ${b.rbi} | ${b.sb} | ${pct(b.bbp)} | ${pct(b.kp)} | ${b.l5line} | ${tr} |`);
  });
  p('');

  // ---- pitchers
  p('## Pitchers — season lines');
  p('');
  p('Sorted by innings. **Role** SP/RP/Swing from GS share. **L3** = last 3 outings. ERA shown next to last-3 ERA to flag hot/cold arms.');
  p('');
  p('| # | Pitcher | Role | App | IP | W-L | SV | ERA | WHIP | K/9 | BB/9 | K | BB | L3 IP/ERA |');
  p('|---|---|:--:|--:|--:|:--:|--:|--:|--:|--:|--:|--:|--:|---|');
  PIT.forEach(p2 => {
    const l3 = p2.l3era == null ? '—' : `${p2.l3ip} / ${r2(p2.l3era)}`;
    p(`| ${p2.meta.num} | ${p2.meta.name} | ${p2.role} | ${p2.app} | ${ipStr(p2.outs)} | ${p2.w}-${p2.l} | ${p2.sv} | ${r2(p2.era)} | ${r2(p2.whip)} | ${p2.k9 == null ? '—' : p2.k9.toFixed(1)} | ${p2.bb9 == null ? '—' : p2.bb9.toFixed(1)} | ${p2.k} | ${p2.bb} | ${l3} |`);
  });
  p('');

  // ---- game-by-game team trend
  p('## Game-by-game (team)');
  p('');
  p('Team batting (H/BB/K) and pitching (ER/BB/K allowed) summed from individual player game logs, with result. Use to spot scoring droughts and command spikes.');
  p('');
  p('> **Data note:** these rows are reconstructed by summing per-player logs, which refresh once daily with the seed. The **most recent game can be partial** until every player\'s log catches up (a row whose pitching IP is well under the game length is still filling in). Season lines, ranks, and the run totals above come straight from the league/player pages and are authoritative.');
  p('');
  p('| Date | Opp | Result | Bat: H-BB-K | HR | Pitch: IP-ER-BB-K |');
  p('|---|---|:--:|---|--:|---|');
  TG.forEach(g => {
    const sg = SCHED.find(x => x.id === g.id) || {};
    const res = g.score || '';
    p(`| ${g.date} | ${oppShort(g.opp)} | ${res} | ${g.bh}-${g.bbb}-${g.bk} | ${g.bhr} | ${ipStr(g.pip)}-${g.per}-${g.pbb}-${g.pk} |`);
  });
  p('');

  p('## Glossary (for the report)');
  p('');
  p('- **AVG / OBP / SLG** — batting average · on-base % · slugging %. **OPS** = OBP + SLG (one-number bat value; ~.750 is solid, .900+ is excellent).');
  p('- **ISO** (Isolated Power) = SLG − AVG — raw power independent of singles.');
  p('- **BB% / K%** — walk and strikeout rate per plate appearance (process/discipline).');
  p('- **L5 / L3** — totals over the last 5 games (bat) / 3 outings (pitch); the recent-form window.');
  p('- **Trend** — last-5 AVG minus season AVG, in points (▲ hot / ▼ cold). Filters small-sample noise from real swings.');
  p('- **ERA / WHIP** — earned runs per 9 IP · baserunners (H+BB) per IP. **K/9, BB/9** — strikeouts and walks per 9 IP (lower BB/9 = better command).');
  p('- **Role** — SP starter · RP reliever · SwingP both, inferred from games-started share.');
  p('');

  p('## How to use this in a post-game report');
  p('');
  p('- **Frame each line vs. the season baseline** above (e.g. "2-for-4 raises X from .250 → .268" or "the 5 BB matches a season-long command theme").');
  p('- **Cite the Trend column** to call a player genuinely hot/cold vs. small-sample noise.');
  p('- **Pitching:** compare the night\'s strike% and BB to the staff BB/9 baseline; flag arms whose L3 ERA diverges from season ERA.');
  p('- **Regenerate** after the seed refreshes: `node scripts/season-report.js`.');
  p('');

  function bb9All() { const ip = PIT.reduce((a, x) => a + x.outs, 0) / 3; const bb = PIT.reduce((a, x) => a + x.bb, 0); return ip ? ((bb * 9) / ip).toFixed(1) : '—'; }

  return L.join('\n') + '\n';
}

const md = build();
if (process.argv.includes('--stdout')) {
  process.stdout.write(md);
} else {
  const dir = path.join(ROOT, 'reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'season-reference-2026.md');
  fs.writeFileSync(file, md);
  console.log('wrote', path.relative(ROOT, file), `(${md.length} bytes)`);
}
