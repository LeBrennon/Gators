// Shared season-stats library for the Gumbeaux Gators reporting scripts.
// Loads the committed roster-seed.json (season totals + per-game logs + league
// ranks, refreshed daily by the seed workflow) and the roster in server.js, and
// exposes computed season lines, recent-form trends, and per-game lookups.
// Pure offline computation — no network. Used by season-report.js (season
// reference) and postgame-report.js (single-game report framed vs. the baseline).

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

// ---- data ------------------------------------------------------------------
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

// Players who appear in historical game logs but have since left the roster (so
// they're no longer in server.js). Keeps their real name in past-game reports
// instead of a raw slug. Add an entry when a player is removed mid-season.
const ALUMNI = {
  asathompsonz8vo: { name: 'Asa Thompson', num: 33, pos: 'P', slug: 'asathompsonz8vo' },
};
// Title-case fallback for any unknown slug (strips the trailing 4-char hash).
const prettySlug = slug => { const base = String(slug).replace(/[a-z0-9]{4}$/i, ''); return base ? base.charAt(0).toUpperCase() + base.slice(1) : slug; };
const metaFor = slug => ROSTER[slug] || ALUMNI[slug] || { name: prettySlug(slug), num: '', pos: '', slug };

// ---- helpers ---------------------------------------------------------------
const num = v => { if (v == null) return 0; const s = String(v).trim(); if (s === '' || s === '-' || s === '·') return 0; const n = parseFloat(s); return isFinite(n) ? n : 0; };
const i3 = v => { const s = String(v == null ? '' : v).trim(); if (!s || s === '-') return 0; const p = s.split('.'); return (parseInt(p[0], 10) || 0) * 3 + (p[1] ? parseInt(p[1][0], 10) || 0 : 0); }; // IP -> outs
const ipStr = outs => `${Math.floor(outs / 3)}.${outs % 3}`;
const r3 = x => (x == null || !isFinite(x)) ? '—' : x.toFixed(3).replace(/^0(\.\d)/, '$1');
const r2 = x => (x == null || !isFinite(x)) ? '—' : x.toFixed(2);
const pct = x => (x == null || !isFinite(x)) ? '—' : (x * 100).toFixed(1) + '%';
const signed = x => (x > 0 ? '+' : '') + x;
const pts = x => signed(+(x * 1000).toFixed(0)); // batting-average delta in "points"

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
      g.home = !/\bat\b/i.test(String(g.opp || ''));
    }
  });
  return arr;
}
const SCHED = buildSchedule();

// ---- team record / form ----------------------------------------------------
// throughId: optional box id to compute the record/runs only up to and including
// that game (used by the post-game report). Omit for season-to-date.
function teamSummary(throughId) {
  const games = throughId ? SCHED.filter(g => g.id <= throughId) : SCHED;
  let w = 0, l = 0, rf = 0, ra = 0, hw = 0, hl = 0, aw = 0, al = 0;
  games.forEach(g => {
    if (g.win == null) return;
    if (g.win) w++; else l++;
    rf += g.gs; ra += g.os;
    if (g.home) { g.win ? hw++ : hl++; } else { g.win ? aw++ : al++; }
  });
  const last = games.filter(g => g.win != null);
  const lastN = n => { const s = last.slice(-n); const ww = s.filter(g => g.win).length; return `${ww}-${s.length - ww}`; };
  let streak = '';
  for (let k = last.length - 1; k >= 0; k--) { const c = last[k].win ? 'W' : 'L'; if (!streak) streak = c + '1'; else if (streak[0] === c) streak = c + (parseInt(streak.slice(1)) + 1); else break; }
  const oneRun = last.filter(g => Math.abs(g.diff) === 1); const orW = oneRun.filter(g => g.win).length;
  const gp = w + l || 1;
  return { w, l, rf, ra, hw, hl, aw, al, gp: w + l, last5: lastN(5), last10: lastN(10), streak,
    oneRun: `${orW}-${oneRun.length - orW}`, diff: rf - ra, rpg: rf / gp, rapg: ra / gp };
}

// ---- batting (season lines + last-5 trend) ---------------------------------
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
    const logs = (rec.glBat || []).slice().sort(byBox); const l5 = logs.slice(-5);
    const s = l5.reduce((a, g) => ({ ab: a.ab + num(g.ab), h: a.h + num(g.h), hr: a.hr + num(g.hr), rbi: a.rbi + num(g.rbi), bb: a.bb + num(g.bb), k: a.k + num(g.k) }), { ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, k: 0 });
    const l5avg = s.ab ? s.h / s.ab : null;
    out.push({ meta, slug, h, ab, hh, bb, pa, k, avg, obp, slg, ops, iso, ranks,
      hr: num(h.hr), rbi: num(h.rbi), r: num(h.r), sb: num(h.sb), d2: num(h['2b']), t3: num(h['3b']),
      bbp: pa ? bb / pa : null, kp: pa ? k / pa : null, gp: num(h.gp),
      l5avg, l5line: `${s.h}-${s.ab}`, l5hr: s.hr, l5rbi: s.rbi, l5bb: s.bb, l5k: s.k,
      trend: (l5avg != null && avg) ? l5avg - avg : null });
  }
  out.sort((a, b) => b.ops - a.ops);
  return out;
}

// ---- pitching (season lines + last-3 form) ---------------------------------
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
    out.push({ meta, slug, p, ip, outs, era, whip, bb, k, hh, er, app, gs, role,
      w: num(p.w), l: num(p.l), sv: num(p.sv), k9, bb9, kbb, baa: num(p.baa),
      l3ip: ipStr(s.outs), l3era, l3bb: s.bb, l3k: s.k, l3r: s.r, apps: logs.length });
  }
  out.sort((a, b) => b.outs - a.outs);
  return out;
}

const indexBySlug = arr => arr.reduce((m, x) => (m[x.slug] = x, m), {});

// The official Gumbeaux Gators logo (base64 PNG) is embedded in server.js for the
// app; reuse it as a data URI so branded PDFs carry the real mark, no network.
function gatorsLogoDataUri() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const m = src.match(/GATORS_LOGO_B64\s*=\s*'([A-Za-z0-9+/=]+)'/);
    return m ? 'data:image/png;base64,' + m[1] : '';
  } catch (e) { return ''; }
}

// ---- per-game team trend (sum player logs by game) -------------------------
function teamGameTrends() {
  const games = {};
  const blank = (id, g) => ({ id, date: g.date, opp: g.opp, score: g.score, bh: 0, bab: 0, bbb: 0, bk: 0, bhr: 0, pip: 0, per: 0, pbb: 0, pk: 0, ph: 0 });
  for (const slug in PC) {
    const r = PC[slug] || {};
    (r.glBat || []).forEach(g => { const id = boxId(g); games[id] = games[id] || blank(id, g); games[id].bh += num(g.h); games[id].bab += num(g.ab); games[id].bbb += num(g.bb); games[id].bk += num(g.k); games[id].bhr += num(g.hr); });
    (r.glPit || []).forEach(g => { const id = boxId(g); games[id] = games[id] || blank(id, g); games[id].pip += i3(g.ip); games[id].per += num(g.er); games[id].pbb += num(g.bb); games[id].pk += num(g.k); games[id].ph += num(g.h); });
  }
  return Object.values(games).sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ---- single-game lookups (for the post-game report) ------------------------
// Resolve 'latest' | a 'Jun 24'-style date | a box id to a schedule game.
function resolveGame(target) {
  if (!target || target === 'latest') return SCHED[SCHED.length - 1];
  const t = String(target);
  return SCHED.find(g => g.id === t) || SCHED.find(g => g.date === t)
    || SCHED.find(g => g.id.startsWith(t)) || null;
}

// Per-player batting lines for one game. The game-log `avg` field is the SINGLE-
// GAME average, not cumulative, so the running AVG (before/after this game) is
// computed by summing the player's logs up to that point.
function gameBatting(id) {
  const rows = [];
  for (const slug in PC) {
    const logs = (PC[slug].glBat || []).slice().sort(byBox);
    const idx = logs.findIndex(g => boxId(g) === id); if (idx < 0) continue;
    const g = logs[idx]; const meta = metaFor(slug);
    if (meta.pos === 'P') continue;
    const cum = upto => { let h = 0, ab = 0; for (let k = 0; k <= upto; k++) { h += num(logs[k].h); ab += num(logs[k].ab); } return ab ? h / ab : null; };
    rows.push({ slug, meta, ab: num(g.ab), h: num(g.h), hr: num(g.hr), rbi: num(g.rbi), bb: num(g.bb), k: num(g.k),
      avgAfter: cum(idx), avgBefore: idx > 0 ? cum(idx - 1) : null });
  }
  // most impactful first: hits, then HR, then RBI, then AB
  rows.sort((a, b) => b.h - a.h || b.hr - a.hr || b.rbi - a.rbi || b.ab - a.ab);
  return rows;
}

function gamePitching(id) {
  const rows = [];
  for (const slug in PC) {
    const logs = (PC[slug].glPit || []).slice().sort(byBox);
    const idx = logs.findIndex(g => boxId(g) === id); if (idx < 0) continue;
    const g = logs[idx]; const meta = metaFor(slug);
    // game-log `era` is single-game; compute running ERA by summing ER/IP to date.
    const cum = upto => { let er = 0, outs = 0; for (let k = 0; k <= upto; k++) { er += num(logs[k].er); outs += i3(logs[k].ip); } return outs ? (er * 27) / outs : null; };
    rows.push({ slug, meta, outs: i3(g.ip), ipStr: ipStr(i3(g.ip)), h: num(g.h), r: num(g.r), er: num(g.er), bb: num(g.bb), k: num(g.k),
      eraAfter: cum(idx), eraBefore: idx > 0 ? cum(idx - 1) : null });
  }
  rows.sort((a, b) => b.outs - a.outs); // starter (most IP) first
  return rows;
}

module.exports = {
  seed, PC, RS, ROSTER, SCHED,
  num, i3, ipStr, r3, r2, pct, signed, pts, boxId, byBox, oppShort,
  teamSummary, batters, pitchers, teamGameTrends, indexBySlug,
  resolveGame, gameBatting, gamePitching, gatorsLogoDataUri,
};
