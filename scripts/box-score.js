#!/usr/bin/env node
// Full box score for the Gumbeaux Gators — cold, hard facts only, no narrative.
// One branded letter page the coach can scan for mistakes: the line score plus
// both teams' complete batting and pitching tables (Gators first), with the
// box's notes (2B/3B/HR/E/DP/LOB...) underneath each side.
//
// The parsed box comes from the live app's /api/boxscore (it reaches PrestoSports;
// most other hosts are 403'd). Offline, point BOX_FIXTURE at a saved box-score
// HTML page and it's parsed locally via the app's own parseBoxscore.
//
//   node scripts/box-score.js                 # latest final game -> PDF in reports/box/
//   node scripts/box-score.js "Jun 27"        # a specific date
//   node scripts/box-score.js 20260627_5hqn   # a specific box id
//   BOX_FIXTURE=test/fixtures/boxscore.html node scripts/box-score.js --pdf   # offline
//
// Flags: --pdf (render PDF, default also prints the output path), --html (keep HTML).

const fs = require('fs');
const path = require('path');
const S = require('./lib/season');

const FLAGS = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const PDF = FLAGS.has('--pdf') || !FLAGS.has('--html'); // PDF is the default output
const KEEP_HTML = FLAGS.has('--html');
const target = args[0] || 'latest';

// Manual-data path: BOX_DATA points at a JSON file that fully specifies the game
// (header meta, record, line score, and the box tables) — used when the parsed
// box can't be fetched (offline / host not allowlisted) but the numbers are in
// hand. Shape: { game:{id,date,home,opp,gs,os,win}, record:{w,l}, line, box }.
const BOX_DATA = process.env.BOX_DATA ? JSON.parse(fs.readFileSync(process.env.BOX_DATA, 'utf8')) : null;

let game, T;
if (BOX_DATA && BOX_DATA.game) {
  game = BOX_DATA.game;
  T = BOX_DATA.record || { w: 0, l: 0 };
} else {
  game = S.resolveGame(target);
  if (!game) { console.error(`No game found for "${target}". Try 'latest', a date like "Jun 27", or a box id.`); process.exit(1); }
  T = S.teamSummary(game.id);
}
const oppName = (BOX_DATA && BOX_DATA.game) ? String(game.opp || '').replace(/^@ /, '') : S.oppShort(game.opp).replace(/^@ /, '');
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- fetch the parsed box ---------------------------------------------------
async function getBox() {
  if (BOX_DATA) return { line: BOX_DATA.line || '', box: BOX_DATA.box || [] };
  if (process.env.BOX_FIXTURE) {
    const { parseBoxscore } = require('../server');
    const html = fs.readFileSync(process.env.BOX_FIXTURE, 'utf8');
    return parseBoxscore(html);
  }
  const id = String(game.id);
  if (!/^\d{8}_[a-z0-9]+$/i.test(id)) return null;
  const base = (process.env.REPORT_APP_BASE || 'https://gators.onrender.com').replace(/\/$/, '');
  const url = `${base}/api/boxscore?id=${encodeURIComponent(id)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(url, { headers: { 'user-agent': 'gators-box', accept: 'application/json' }, signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) { console.error(`[box] /api/boxscore ${r.status} for ${id} (try ${attempt}/3)`); if (attempt < 3) { await new Promise(s => setTimeout(s, 2000 * attempt)); continue; } return null; }
      const d = await r.json();
      if (!d || d.error) { console.error(`[box] no data for ${id}${d && d.error ? ': ' + d.error : ''}`); return null; }
      return d;
    } catch (e) { console.error(`[box] error for ${id}: ${e.message} (try ${attempt}/3)`); if (attempt < 3) { await new Promise(s => setTimeout(s, 2000 * attempt)); continue; } return null; }
  }
  return null;
}

// ---- group the box entries by team, Gators first ----------------------------
// Each box entry's label is "<Team> — Batting" / "<Team> — Pitching". Strip any
// inert player links so names render as plain text in the PDF.
const DASH = '—';
function teamOf(label) { return String(label || '').split(DASH)[0].trim(); }
function kindOf(label) { return /pitching/i.test(label) ? 'pitching' : 'batting'; }
const stripLinks = h => String(h || '').replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '');

function groupTeams(box) {
  const order = [], by = {};
  for (const e of box) {
    const tm = teamOf(e.label);
    if (!by[tm]) { by[tm] = { team: tm, gators: /gator|gumbeaux/i.test(tm), batting: null, pitching: null, legend: null, notes: null }; order.push(tm); }
    by[tm][kindOf(e.label)] = stripLinks(e.html);
    if (e.legend && e.legend.length) by[tm].legend = e.legend;
    if (e.notes) by[tm].notes = e.notes;
  }
  return order.map(tm => by[tm]).sort((a, b) => (b.gators ? 1 : 0) - (a.gators ? 1 : 0));
}

// Notes object -> compact "2B: ... · HR: ... · E: ..." string (skip empties).
const NOTE_ORDER = ['2B', '3B', 'HR', 'HBP', 'SB', 'CS', 'SF', 'SH', 'GDP', 'DP', 'LOB', 'E', 'PB', 'WP'];
function notesLine(notes) {
  if (!notes || typeof notes !== 'object') return '';
  const keys = [...NOTE_ORDER, ...Object.keys(notes).filter(k => !NOTE_ORDER.includes(k))];
  const seen = new Set(); const parts = [];
  for (const k of keys) { if (seen.has(k)) continue; seen.add(k); const v = notes[k]; if (v != null && String(v).trim() !== '') parts.push(`<b>${esc(k)}</b> ${esc(v)}`); }
  return parts.join(' &nbsp;·&nbsp; ');
}

// ---- render -----------------------------------------------------------------
function teamBlock(t) {
  const cap = t.gators ? 'GATORS' : esc(t.team.toUpperCase());
  const sections = [];
  if (t.batting) sections.push(`<div class='tcap bat'>${cap} — BATTING</div><div class='tbl bat'>${t.batting}</div>`);
  if (t.pitching) sections.push(`<div class='tcap pit'>${cap} — PITCHING</div><div class='tbl pit'>${t.pitching}</div>`);
  return `<div class='teamcol'>${sections.join('')}</div>`;
}

// Pull the teams + R/H/E from the line-score table so the header score/matchup
// always agrees with the box body (the line score is the authoritative final).
function parseLineTeams(html) {
  if (!html) return null;
  const txt = s => String(s).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || []; if (rows.length < 2) return null;
  const out = [];
  for (const r of rows.slice(1)) {
    const c = (r.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(txt);
    if (c.length < 4) continue;
    const name = c[0]; if (!name || /^final$/i.test(name)) continue;
    out.push({ name, r: parseInt(c[c.length - 3], 10) || 0, gators: /gator|gumbeaux/i.test(name) });
  }
  return out.length >= 2 ? out : null;
}

function buildHtml(data) {
  const teams = groupTeams(data.box || []);
  const croc = S.crocSkinDataUri();
  // Score/result/opponent from the line score when present; seed game otherwise.
  let gs = game.gs, os = game.os, win = game.win, opp = oppName;
  const lt = parseLineTeams(data.line);
  if (lt) { const G = lt.find(t => t.gators), O = lt.find(t => !t.gators); if (G && O) { gs = G.r; os = O.r; win = gs > os ? true : gs < os ? false : null; opp = O.name.replace(/^(lake charles|the)\s+/i, '').trim() || oppName; } }
  const resWord = win == null ? 'FINAL' : win ? 'WIN' : 'LOSS';
  const resColor = win == null ? '#714ad2' : win ? '#1f9d57' : '#c0392b';
  const line = data.line ? `<div class='linewrap'>${data.line}</div>` : '';
  const H = [];
  H.push(`<!doctype html><html><head><meta charset='utf-8'><style>
@page{size:letter;margin:0;}
*{box-sizing:border-box;margin:0;padding:0;}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1b1e27;font-size:12px;padding:32px 36px;height:100vh;display:flex;flex-direction:column;overflow:hidden;}
.band{display:flex;align-items:center;gap:18px;color:#fff;padding:18px 24px;border-radius:13px;border:2px solid #ecc913;
background:linear-gradient(rgba(22,16,43,.02),rgba(22,16,43,.16))${croc ? `,url('${croc}') center center / cover no-repeat` : ''};
background-color:#3a2480;box-shadow:0 3px 11px rgba(58,36,128,.3),inset 0 0 0 1px rgba(255,255,255,.08);}
.band img{width:66px;height:66px;}
.k{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#ffd633;font-weight:800;text-shadow:0 1px 2px rgba(0,0,0,.5);}
.band h1{font-size:28px;font-weight:900;line-height:1.08;margin:3px 0;text-shadow:0 2px 4px rgba(0,0,0,.55);}
.band .sub{font-size:13px;font-weight:700;color:#efe7ff;text-shadow:0 1px 2px rgba(0,0,0,.5);}
.badge{margin-left:auto;text-align:center;}
.badge .r{display:inline-block;background:${resColor};color:#fff;font-weight:900;font-size:15px;letter-spacing:.04em;padding:5px 18px;border-radius:7px;}
.badge .sc{font-size:30px;color:#fff;margin-top:5px;font-weight:900;}
.badge .sc .dsh{font-weight:600;font-size:.62em;vertical-align:.18em;margin:0 6px;opacity:.9;}
.linewrap{margin:18px 0 4px;}
.linewrap table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;}
.linewrap th,.linewrap td{border:1px solid #d9d2ec;padding:9px 10px;text-align:center;font-size:15px;}
.linewrap th{background:#3a2480;color:#fff;font-weight:800;text-transform:uppercase;letter-spacing:.03em;}
.linewrap th:first-child,.linewrap td:first-child{text-align:left;font-weight:800;white-space:nowrap;}
.linewrap td:first-child{background:#f3f0fb;}
.linewrap td:nth-last-child(-n+3){font-weight:800;background:#faf8ff;}
.cols{display:flex;gap:22px;margin-top:18px;flex:1;min-height:0;}
.teamcol{flex:1;min-width:0;display:flex;flex-direction:column;}
.tcap{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#fff;background:linear-gradient(180deg,#714ad2,#4e3191);padding:8px 11px;border-radius:6px 6px 0 0;}
.tcap.pit{margin-top:16px;}
.tbl{border:1px solid #e6def7;border-top:none;border-radius:0 0 6px 6px;overflow:hidden;}
.teamcol .tbl.bat{flex:1;min-height:0;}
.tbl table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;height:100%;}
.tbl th,.tbl td{padding:8.5px 5px;text-align:right;font-size:12.5px;border-bottom:1px solid #efeaf9;}
.tbl th{background:#f0ebfb;color:#4e3191;font-weight:800;text-transform:uppercase;letter-spacing:.02em;font-size:10.5px;}
/* Pitching has more columns (IP..S%) than batting, so tighten it to fit the half-width column. */
.tbl.pit th,.tbl.pit td{padding-left:3px;padding-right:3px;font-size:11px;}
.tbl.pit th{font-size:9px;letter-spacing:0;}
.tbl th:first-child,.tbl td:first-child{text-align:left;white-space:nowrap;}
.tbl a{color:inherit;text-decoration:none;}
.tbl tr:last-child td{border-bottom:none;}
.tbl td:first-child{color:#2a2150;font-weight:600;}
.tbl tr:last-child td{background:#faf8ff;font-weight:800;}
</style></head><body>`);
  H.push(`<div class='band'><img src='${S.gatorsLogoDataUri()}'><div><div class='k'>Gumbeaux Gators · Official Box Score</div><h1>${esc(game.date)}, 2026 ${DASH} ${game.home ? 'vs' : 'at'} ${esc(opp)}</h1><div class='sub'>${game.home ? 'Home' : 'Road'} · Record ${T.w}${DASH}${T.l}</div></div><div class='badge'><div class='r'>${resWord}</div><div class='sc'>${gs}<span class='dsh'>&ndash;</span>${os}</div></div></div>`);
  H.push(line);
  H.push(`<div class='cols'>${teams.map(teamBlock).join('')}</div>`);
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

const outDir = path.join(__dirname, '..', 'reports', 'box');
// File name: "<date> <away initials> @ <home initials>" (e.g. "Jun 28 2026 LCGG @ BRR").
// Initials are the first letter of each word in the team name; away/home order
// follows the game (Gators away -> LCGG first).
const teamInitials = name => String(name || '').trim().split(/\s+/).map(w => w[0] || '').join('').toUpperCase().replace(/[^A-Z]/g, '');
function buildStem(data) {
  const lt = parseLineTeams(data.line) || [];
  const gName = (lt.find(t => t.gators) || {}).name || 'Lake Charles Gumbeaux Gators';
  const oName = (lt.find(t => !t.gators) || {}).name || String(game.opp || 'Opponent');
  const gi = teamInitials(gName) || 'LCGG', oi = teamInitials(oName) || 'OPP';
  const away = game.home ? oi : gi, home = game.home ? gi : oi;
  const year = String(game.id || '').slice(0, 4) || '';
  return `${[game.date, year].filter(Boolean).join(' ')} ${away} @ ${home}`.trim();
}

async function main() {
  const data = await getBox();
  if (!data || !data.box || !data.box.length) { console.error(`[box] no box score available for ${game.id} (offline? game not final yet?).`); process.exit(2); }
  const stem = buildStem(data);
  const html = buildHtml(data);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  if (KEEP_HTML) { const hf = path.join(outDir, `${stem}.html`); fs.writeFileSync(hf, html); console.error('wrote', path.relative(path.join(__dirname, '..'), hf)); }
  if (PDF) { const out = path.join(outDir, `${stem}.pdf`); if (renderPdf(html, out)) console.log('wrote', path.relative(path.join(__dirname, '..'), out)); else process.exit(1); }
}

if (require.main === module) main();
module.exports = { groupTeams, notesLine };
