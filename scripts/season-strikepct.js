#!/usr/bin/env node
// Season team strike% for the Gumbeaux Gators pitching staff.
// Strike% is not in roster-seed.json — it only exists in box-score play-by-play.
// This fetches every game's box THROUGH the app (Render reaches PrestoSports;
// other hosts get 403'd) and aggregates pitches/balls across the season.
//
// Strike% = (total pitches − total balls) / total pitches, counted only over the
// half-innings the Gators pitched (opponent batting). Mirrors the per-game logic
// in scripts/postgame-report.js so the season number matches the game reports.
//
//   REPORT_APP_BASE=https://gators.onrender.com node scripts/season-strikepct.js
//   node scripts/season-strikepct.js --json   # machine-readable line for CI

const S = require('./lib/season');

const APP_BASE = (process.env.REPORT_APP_BASE || 'https://gators.onrender.com').replace(/\/$/, '');
const JSON_OUT = process.argv.includes('--json');

const txt = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

// Gators staff pitch count for one game, from the box pitching table's #P column.
function gatorsPitchesNP(box) {
  if (!Array.isArray(box)) return 0;
  const t = box.find(b => /gator|gumbeaux/i.test(b.label || '') && /pitching/i.test(b.label || ''));
  if (!t) return 0;
  const rows = (t.html || '').match(/<tr[\s\S]*?<\/tr>/gi) || []; if (!rows.length) return 0;
  const head = (rows[0].match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(c => txt(c).toUpperCase());
  let idx = head.indexOf('#P'); if (idx < 0) idx = head.indexOf('NP'); if (idx < 0) return 0;
  let np = 0;
  for (const r of rows.slice(1)) {
    const c = (r.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(txt);
    if (/total/i.test(c[0] || '')) continue;
    np += parseInt(c[idx], 10) || 0;
  }
  return np;
}

// Balls + first-pitch strikes from the half-innings the Gators pitched.
function gatorsCommand(halves, home) {
  const fielding = home ? 'top' : 'bot'; // opponent bats in the Gators' fielding half
  let pa = 0, fpStrike = 0, balls = 0;
  for (const h of halves) {
    if (h.side !== fielding) continue;
    const seqs = (h.html || '').match(/\(\s*\d+-\d+\s+[A-Za-z]+\s*\)/g) || [];
    for (const raw of seqs) {
      const seq = (raw.match(/\d+-\d+\s+([A-Za-z]+)/) || [])[1]; if (!seq) continue;
      pa++;
      if (!/[BH]/i.test(seq[0])) fpStrike++;
      for (const ch of seq) { if (/[BH]/i.test(ch)) balls++; }
    }
  }
  return { pa, fpStrike, balls };
}

async function fetchBox(id) {
  const url = `${APP_BASE}/api/boxscore?id=${encodeURIComponent(id)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(url, { headers: { 'user-agent': 'gators-report', accept: 'application/json' }, signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) { if (attempt < 3) { await new Promise(s => setTimeout(s, 2000 * attempt)); continue; } return null; }
      const data = await r.json();
      if (!data || data.error) return null;
      return data;
    } catch (e) { if (attempt < 3) { await new Promise(s => setTimeout(s, 2000 * attempt)); continue; } return null; }
  }
  return null;
}

(async () => {
  const games = S.SCHED.filter(g => g.win != null);
  let totNP = 0, totBalls = 0, totPA = 0, totFP = 0, used = 0, missing = [];
  for (const g of games) {
    const data = await fetchBox(g.id);
    if (!data) { missing.push(g.id); continue; }
    const halves = (data.pbp || []).map(pp => ({ side: /top/i.test(pp.title || '') ? 'top' : 'bot', html: pp.html || '' }));
    const np = gatorsPitchesNP(data.box);
    const cmd = gatorsCommand(halves, g.home);
    if (!np || !cmd.pa) { missing.push(g.id); continue; }
    totNP += np; totBalls += cmd.balls; totPA += cmd.pa; totFP += cmd.fpStrike; used++;
    if (!JSON_OUT) console.error(`  ${g.date}  np=${np} balls=${cmd.balls} strike%=${(((np - cmd.balls) / np) * 100).toFixed(1)}  fp%=${((cmd.fpStrike / cmd.pa) * 100).toFixed(1)}`);
  }
  const strikePct = totNP ? (totNP - totBalls) / totNP : null;
  const fpPct = totPA ? totFP / totPA : null;
  const result = {
    games: games.length, used, missing,
    pitches: totNP, balls: totBalls,
    strikePct: strikePct == null ? null : +(strikePct * 100).toFixed(1),
    firstPitchStrikePct: fpPct == null ? null : +(fpPct * 100).toFixed(1),
  };
  if (JSON_OUT) { console.log('SEASON_STRIKEPCT ' + JSON.stringify(result)); }
  else {
    console.error('');
    console.log(`Season team strike%: ${result.strikePct}%  (${totNP - totBalls} strikes / ${totNP} pitches, ${used}/${games.length} games)`);
    console.log(`Season first-pitch strike%: ${result.firstPitchStrikePct}%`);
    if (missing.length) console.log(`Missing boxes (${missing.length}): ${missing.join(', ')}`);
  }
})();
