#!/usr/bin/env node
// Post-game report generator for the Gumbeaux Gators — written for the GM.
// A one-page write-up in plain English: what happened and how players/teams are
// trending. Facts only — no recommendations, no charts.
//
// Most of it is reconstructed offline from the daily seed. A few command stats
// (first-pitch strikes, strike %, three-ball counts) and shutdown innings need
// the box score's play-by-play, so when possible the script fetches the box for
// the game being reported; if that's unavailable (offline, or the league didn't
// publish pitch sequences) those lines are simply omitted.
//
//   node scripts/postgame-report.js               # latest game -> markdown on stdout
//   node scripts/postgame-report.js "Jun 24"      # a specific date
//   node scripts/postgame-report.js latest --pdf   # branded one-page PDF in reports/postgame/
//   node scripts/postgame-report.js latest --write # also save the markdown there

const fs = require('fs');
const path = require('path');
const S = require('./lib/season');
const { r2, r3, ipStr } = S;

const FLAGS = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const WRITE = FLAGS.has('--write');
const PDF = FLAGS.has('--pdf');
const HTML = FLAGS.has('--html');
const NOBOX = FLAGS.has('--no-box'); // skip the box-score fetch (force offline)
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

const oppName = S.oppShort(game.opp).replace(/^@ /, '');
const list = a => !a.length ? '' : a.length === 1 ? a[0] : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Trailing-7-day pitcher workload as of this game (a usage fact).
const gameDayMs = (() => { const m = String(game.id).match(/^(\d{4})(\d{2})(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; })();
function boxDayMs(g) { const m = String(S.boxId(g)).match(/^(\d{4})(\d{2})(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; }
function workload(slug, days) {
  const logs = (S.PC[slug] && S.PC[slug].glPit) || []; let apps = 0, outs = 0;
  if (gameDayMs != null) for (const g of logs) { const d = boxDayMs(g); if (d == null) continue; const ago = (gameDayMs - d) / 864e5; if (ago >= 0 && ago < days) { apps++; outs += S.i3(g.ip); } }
  return { apps, outs };
}

const HB = S.batters(), PB = S.pitchers();
const hotBats = HB.filter(b => b.pa >= 15 && b.l5avg != null && b.trend != null && b.trend >= 0.05).sort((a, b) => b.trend - a.trend).slice(0, 4);
const coldBats = HB.filter(b => b.pa >= 15 && b.l5avg != null && b.trend != null && b.trend <= -0.05).sort((a, b) => a.trend - b.trend).slice(0, 4);
const highEra = PB.filter(p => p.ip >= 8 && p.era >= 5.5).sort((a, b) => b.era - a.era).slice(0, 4);
const heavyArms = PB.map(p => ({ p, wl: workload(p.slug, 7) })).filter(x => x.wl.apps >= 3).sort((a, b) => b.wl.apps - a.wl.apps);
const recentGames = S.SCHED.filter(g => g.win != null).slice(-6);

// ===========================================================================
// Box-score command stats (need play-by-play; fetched at run time when possible).
// All measure the GATORS pitching staff: pitch sequences come from the half-
// innings where the OPPONENT is batting (i.e. the Gators are on the mound).
// ===========================================================================
const txt = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

async function getBoxStats() {
  if (NOBOX) return null;
  // Test/offline hook: read a saved box-score HTML instead of fetching.
  if (process.env.BOX_FIXTURE) { try { const html = fs.readFileSync(process.env.BOX_FIXTURE, 'utf8'); return computeBoxStats(halvesFromHtml(html), html); } catch (e) { return null; } }
  const id = String(game.id);
  if (!/^\d{8}_[a-z0-9]+$/i.test(id)) return null;
  // Fetch the box THROUGH the app (Render reaches PrestoSports; GitHub's runner
  // IPs are 403'd by the stats site). /api/boxscore returns the parsed box with
  // play-by-play + line score.
  const appBase = (process.env.REPORT_APP_BASE || 'https://gators.onrender.com').replace(/\/$/, '');
  const url = `${appBase}/api/boxscore?id=${encodeURIComponent(id)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(url, { headers: { 'user-agent': 'gators-report', accept: 'application/json' }, signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) { let body = ''; try { body = (await r.text()).slice(0, 200); } catch (e) {} console.error(`[report] /api/boxscore ${r.status} for ${id}: ${body} (try ${attempt}/3)`); if (attempt < 3) { await new Promise(s => setTimeout(s, 2000 * attempt)); continue; } return null; }
      const data = await r.json();
      if (!data || data.error) { console.error(`[report] /api/boxscore returned no data for ${id}${data && data.error ? ': ' + data.error : ''}`); return null; }
      const halves = (data.pbp || []).map(pp => ({ side: /top/i.test(pp.title || '') ? 'top' : 'bot', html: pp.html || '' }));
      const stats = computeBoxStats(halves, data.line || '');
      if (stats.firstPitchStrikePct == null && stats.shutdown == null) console.error(`[report] box fetched (${(data.pbp || []).length} pbp halves) but no pitch sequences or line score parsed for ${id}`);
      return stats;
    } catch (e) { console.error(`[report] /api/boxscore error for ${id}: ${e.message} (try ${attempt}/3)`); if (attempt < 3) { await new Promise(s => setTimeout(s, 2000 * attempt)); continue; } return null; }
  }
  return null;
}

// Split a raw box-score page into half-inning chunks (used by the BOX_FIXTURE
// offline hook). Each play-by-play table is one half; its side comes from the
// "Top/Bottom of ... Inning" text.
function halvesFromHtml(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  const halves = [];
  for (const t of tables) {
    const m = txt(t).match(/(Top|Bottom) of[^]*?Inning/i);
    if (!m) continue;
    halves.push({ side: /top/i.test(m[1]) ? 'top' : 'bot', html: t });
  }
  return halves;
}

// Gators-staff command stats from the half-innings they pitched (the opponent's
// halves: top when the Gators are home, bottom when away) plus shutdown innings
// from the line score. `halves` = [{side:'top'|'bot', html}].
function computeBoxStats(halves, lineHtml) {
  const out = { firstPitchStrikePct: null, strikePct: null, threeBall: null, shutdown: null };
  const fielding = game.home ? 'top' : 'bot';
  let pa = 0, fpStrike = 0, balls = 0, strikes = 0, threeBall = 0;
  for (const h of halves) {
    if (h.side !== fielding) continue;
    const seqs = (h.html || '').match(/\(\s*\d+-\d+\s+[A-Za-z]+\s*\)/g) || [];
    for (const raw of seqs) {
      const seq = (raw.match(/\d+-\d+\s+([A-Za-z]+)/) || [])[1]; if (!seq) continue;
      pa++;
      if (!/[BH]/i.test(seq[0])) fpStrike++;             // first pitch a strike?
      let b = 0; for (const ch of seq) { if (/[BH]/i.test(ch)) b++; else strikes++; }
      balls += b;
      if (b >= 3) threeBall++;
    }
  }
  if (pa > 0) {
    out.firstPitchStrikePct = fpStrike / pa;
    out.threeBall = threeBall;
    out._fp = { fpStrike, pa };
    if (strikes + balls > 0) out.strikePct = strikes / (strikes + balls);
  }
  // ---- shutdown innings from the score-by-innings line ---------------------
  const grid = lineGrid(lineHtml);
  if (grid) {
    const gators = grid.find(r => /gator/i.test(r.name));
    const opp = grid.find(r => !/gator/i.test(r.name));
    if (gators && opp) {
      let sd = 0;
      const N = Math.max(gators.innings.length, opp.innings.length);
      for (let i = 0; i < N; i++) {
        const gRuns = gators.innings[i] || 0;
        if (gRuns <= 0) continue;
        if (game.home) {                              // Gators bat bottom; next half = top of i+1
          if (i + 1 < N && (opp.innings[i + 1] || 0) === 0 && i + 1 < opp.innings.length) sd++;
        } else {                                      // Gators bat top; next half = bottom of i
          if (i < opp.innings.length && (opp.innings[i] || 0) === 0) sd++;
        }
      }
      out.shutdown = sd;
    }
  }
  return out;
}

function lineGrid(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const t of tables) {
    const rows = t.match(/<tr[\s\S]*?<\/tr>/gi) || []; if (rows.length < 3) continue;
    const head = (rows[0].match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(c => txt(c).toUpperCase());
    if (head.length < 5) continue;
    if (head[head.length - 3] !== 'R' || head[head.length - 2] !== 'H' || head[head.length - 1] !== 'E') continue;
    if (!head.includes('1')) continue;            // needs inning columns
    const teams = [];
    for (const r of rows.slice(1)) {
      const c = (r.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(txt);
      if (c.length < 5) continue;
      const name = c[0]; if (!name || /^final$/i.test(name)) continue;
      const innings = c.slice(1, c.length - 3).map(x => parseInt(x, 10) || 0);
      teams.push({ name, innings });
    }
    if (teams.length >= 2) return teams;
  }
  return null;
}

// ---- the words (facts only) ------------------------------------------------
const resultWord = game.win == null ? 'played' : game.win ? 'won' : 'lost';

const recap = [];
recap.push(`The Gumbeaux Gators ${resultWord} ${game.gs}–${game.os} ${game.home ? 'at home' : 'on the road'} against ${oppName} on ${game.date}. They are now ${T.w}–${T.l}.`);
{
  const off = `The offense had ${plural(tb.h, 'hit')} and scored ${plural(game.gs, 'run')}${tb.bb ? `, with ${plural(tb.bb, 'walk')}` : ''}${tb.hr ? ` and ${plural(tb.hr, 'home run')}` : ''}.`;
  const overPace = gameBB9 != null && staffBB9 != null && gameBB9 > staffBB9 * 1.15;
  const pitch = `The pitching staff allowed ${plural(tp.r, 'run')} (${tp.er} earned) over ${ipStr(tp.outs)} innings and issued ${plural(tp.bb, 'walk')}${overPace ? ', above the season pace' : ''}.`;
  recap.push(off + ' ' + pitch);
}

const keyFacts = [];
const multiHit = bat.filter(b => b.h >= 2).sort((a, b) => b.h - a.h || b.rbi - a.rbi);
multiHit.forEach(b => { const s = BAT_SEASON[b.slug]; keyFacts.push(`${b.meta.name} went ${b.h}-for-${b.ab}${b.rbi ? `, ${b.rbi} RBI` : ''}${b.hr ? `, ${plural(b.hr, 'home run')}` : ''}${s ? ` (batting ${r3(s.avg)} on the season)` : ''}.`); });
if (!multiHit.length && tb.h > 0) { const tBat = bat.filter(b => b.h > 0).sort((a, b) => b.h - a.h)[0]; if (tBat) keyFacts.push(`${tBat.meta.name} had ${plural(tBat.h, 'hit')} to lead the offense.`); }
const longOuting = [...pit].sort((a, b) => b.outs - a.outs)[0];
if (longOuting && longOuting.outs > 0) { const s = PIT_SEASON[longOuting.slug]; keyFacts.push(`${longOuting.meta.name} threw ${longOuting.ipStr} innings (${longOuting.h} H, ${longOuting.r} R, ${longOuting.bb} BB, ${longOuting.k} K)${s ? `, and carries a ${r2(s.era)} ERA` : ''}.`); }
if (tp.bb >= 5 && staffBB9 != null) keyFacts.push(`The staff walked ${tp.bb} batters, against a season average of about ${staffBB9.toFixed(1)} per nine innings.`);

const trends = [];
if (hotBats.length) trends.push(`Hot at the plate (last 5 games): ${list(hotBats.map(b => `${b.meta.name} ${r3(b.l5avg)} (season ${r3(b.avg)})`))}.`);
if (coldBats.length) trends.push(`Cold at the plate (last 5 games): ${list(coldBats.map(b => `${b.meta.name} ${r3(b.l5avg)} (season ${r3(b.avg)})`))}.`);
if (highEra.length) trends.push(`Highest ERAs on the staff: ${list(highEra.map(p => `${p.meta.name} ${r2(p.era)}`))}.`);
if (heavyArms.length) trends.push(`Most-used arms in the last week: ${list(heavyArms.map(x => `${x.p.meta.name} (${plural(x.wl.apps, 'appearance')})`))}.`);
if (recentGames.length) trends.push(`Last ${recentGames.length} games: ${recentGames.map(g => `${g.win ? 'W' : 'L'} ${g.gs}-${g.os}`).join(', ')}.`);

const seasonLine = `Record ${T.w}–${T.l}, ${SEASON.diff >= 0 ? '+' : ''}${SEASON.diff} run differential, ${SEASON.last10} over the last 10 games.`;

// Pitching-detail facts, filled from the box score when available.
function pitchingFacts(box) {
  const f = [];
  if (!box) return f;
  const pct = x => Math.round(x * 100) + '%';
  if (box.firstPitchStrikePct != null) f.push(`First-pitch strikes: ${pct(box.firstPitchStrikePct)} — the staff threw a first-pitch strike in ${box._fp.fpStrike} of ${box._fp.pa} plate appearances.`);
  if (box.strikePct != null) f.push(`Strike percentage: ${pct(box.strikePct)} of the staff's pitches were strikes.`);
  if (box.threeBall != null) f.push(`Three-ball counts: ${box.threeBall} hitter${box.threeBall === 1 ? ' was' : 's were'} taken to a three-ball count.`);
  if (box.shutdown != null) f.push(`Shutdown innings: ${box.shutdown} — the staff held the opponent scoreless the half-inning right after the Gators scored.`);
  return f;
}

// ===========================================================================
// Render (markdown + branded PDF). Wrapped so the box-score fetch can finish.
// ===========================================================================
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildMarkdown(pitchFacts) {
  const L = []; const p = s => L.push(s);
  p(`# Gators Game Report — ${game.date}, 2026`);
  p('');
  p(`**${resultWord.toUpperCase()} ${game.gs}–${game.os}** · ${game.home ? 'Home' : 'Away'} vs ${oppName} · Record ${T.w}–${T.l}`);
  p('');
  if (partial) { p('> Heads up: tonight\'s box score is still coming in, so a few details may fill in later.'); p(''); }
  p('## Recap'); p('');
  recap.forEach(s => { p(s); p(''); });
  p('## Key Facts'); p('');
  keyFacts.forEach(t => p(`- ${t}`));
  p('');
  if (pitchFacts.length) { p('## Pitching Detail'); p(''); pitchFacts.forEach(t => p(`- ${t}`)); p(''); }
  p('## Trends'); p('');
  trends.forEach(t => p(`- ${t}`));
  p('');
  p('## Season'); p('');
  p(`- ${seasonLine}`);
  p('');
  p(`_Built from the season stats and the game's play-by-play. “Last 5 games” is a player's batting average over his five most recent games. A shutdown inning is a scoreless half-inning thrown right after the Gators scored._`);
  p('');
  return L.join('\n');
}

function buildHtml(pitchFacts) {
  const win = game.win;
  const resColor = win == null ? '#714ad2' : win ? '#1f9d57' : '#c0392b';
  const resWord = win == null ? 'PLAYED' : win ? 'WIN' : 'LOSS';
  const section = (title, items) => items.length ? `<h2>${esc(title)}</h2><ul class='facts'>${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '';
  const H = [];
  H.push(`<!doctype html><html><head><meta charset='utf-8'><style>
@page{size:letter;margin:0.6in 0.7in;}
*{box-sizing:border-box;margin:0;padding:0;}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{font-family:Georgia,'Times New Roman',serif;color:#23262f;font-size:13px;line-height:1.6;}
.band{display:flex;align-items:center;gap:14px;background:#16102b;color:#fff;padding:15px 18px;border-radius:9px;}
.band img{width:52px;height:52px;}
.k{font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#ffd633;font-weight:700;}
.band h1{font-family:'Helvetica Neue',Arial,sans-serif;font-size:22px;font-weight:800;line-height:1.12;margin:1px 0;}
.band .sub{font-family:Arial,sans-serif;font-size:12px;color:#cdbdf2;}
.badge{margin-left:auto;text-align:center;font-family:'Helvetica Neue',Arial,sans-serif;}
.badge .r{display:inline-block;background:${resColor};color:#fff;font-weight:800;font-size:16px;letter-spacing:.05em;padding:6px 16px;border-radius:6px;}
.badge .sc{font-size:15px;color:#fff;margin-top:5px;font-weight:700;}
h2{font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:#5b3fb0;border-bottom:2px solid #ecc913;padding-bottom:4px;margin:20px 0 10px;}
p{margin:9px 0;}
.lead p{font-size:13.5px;}
ul.facts{list-style:none;}
ul.facts li{position:relative;padding:7px 0 7px 24px;border-bottom:1px solid #eee;}
ul.facts li:last-child{border-bottom:none;}
ul.facts li:before{content:'';position:absolute;left:3px;top:13px;width:8px;height:8px;border-radius:2px;background:#714ad2;}
.warn{background:#fff5f5;border:1px solid #f0b8b8;color:#9b2c2c;border-radius:7px;padding:8px 11px;font-family:Arial,sans-serif;font-size:10.5px;margin:10px 0;}
.foot{margin-top:18px;border-top:1px solid #ddd;padding-top:8px;font-family:Arial,sans-serif;font-size:9px;color:#9a9aa3;font-style:italic;}
</style></head><body>`);
  H.push(`<div class='band'><img src='${S.gatorsLogoDataUri()}'><div><div class='k'>Gumbeaux Gators · Game Report</div><h1>${esc(game.date)} vs ${esc(oppName)}</h1><div class='sub'>${game.home ? 'Home game' : 'Road game'} · Record now ${T.w}–${T.l}</div></div><div class='badge'><div class='r'>${resWord}</div><div class='sc'>${game.gs}–${game.os}</div></div></div>`);
  if (partial) H.push(`<div class='warn'>⚠️ Heads up — tonight's box score is still coming in, so a few details may fill in later.</div>`);
  H.push(`<h2>Recap</h2><div class='lead'>${recap.map(s => `<p>${esc(s)}</p>`).join('')}</div>`);
  H.push(section('Key Facts', keyFacts));
  H.push(section('Pitching Detail', pitchFacts));
  H.push(section('Trends', trends));
  H.push(section('Season', [seasonLine]));
  H.push(`<div class='foot'>Built from the season stats and the game's play-by-play. “Last 5 games” is a player's batting average over his five most recent games. A shutdown inning is a scoreless half-inning thrown right after the Gators scored.</div>`);
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

const outDir = path.join(__dirname, '..', 'reports', 'postgame');
const stem = `${game.id.slice(0, 8)}-${S.oppShort(game.opp).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
function ensureDir() { if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true }); }

async function main() {
  const box = await getBoxStats();
  if (!NOBOX && !box) console.error('[report] box-score command stats unavailable (offline or no play-by-play) — Pitching Detail omitted.');
  if (box) console.error('[report] pitch stats: ' + JSON.stringify(box));
  const pitchFacts = pitchingFacts(box);
  const md = buildMarkdown(pitchFacts);

  if (PDF || HTML) {
    ensureDir();
    const html = buildHtml(pitchFacts);
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
}

if (require.main === module) main();
module.exports = { computeBoxStats, halvesFromHtml, lineGrid };
