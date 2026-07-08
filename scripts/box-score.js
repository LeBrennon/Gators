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
// A bare PrestoSports box-score page can be passed directly as the target URL
// (fetched + parsed locally) or as a saved file via BOX_FIXTURE. In both cases
// the game header is derived from the parsed box itself (see deriveMeta).
const isUrl = /^https?:\/\//i.test(target);
const PARSE_SRC = isUrl ? target : (process.env.BOX_FIXTURE || null);

let game = null, T = null, oppName = '';
if (BOX_DATA && BOX_DATA.game) {
  game = BOX_DATA.game; T = BOX_DATA.record || null; oppName = String(game.opp || '').replace(/^@ /, '');
} else if (!PARSE_SRC) {
  game = S.resolveGame(target);
  if (!game) { console.error(`No game found for "${target}". Try 'latest', a date like "Jun 27", a box id, or a box-score URL.`); process.exit(1); }
  T = S.teamSummary(game.id);
  oppName = S.oppShort(game.opp).replace(/^@ /, '');
}
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Primary team colors for the league, used to brand each side's tables (the
// Gators stay purple; the opponent's tables take their color). Best-guess brand
// colors — adjust freely.
const TEAMS_INFO = [
  [/gator|gumbeaux/i, '#3a2480', 'Gators'],
  [/rougarou/i, '#1f7a34', 'Rougarou'],
  [/cane ?cutter|acadiana/i, '#b3122e', 'Cane Cutters'],
  [/flying ?bison|abilene/i, '#6b4f1d', 'Flying Bison'],
  [/bomber|brazos/i, '#14213d', 'Bombers'],
  [/river ?monster|san antonio/i, '#0e7c7b', 'River Monsters'],
  [/shadowcat|sherman/i, '#2d2a4a', 'Shadowcats'],
  [/general|victoria/i, '#1d3461', 'Generals'],
];
const GATORS_PURPLE = '#3a2480';
function teamColor(name) { for (const [re, c] of TEAMS_INFO) if (re.test(name || '')) return c; return GATORS_PURPLE; }
function teamShort(name) { for (const [re, , s] of TEAMS_INFO) if (re.test(name || '')) return s; return String(name || '').split(/\s+/).pop(); }

// ---- fetch the parsed box ---------------------------------------------------
async function getBox() {
  if (BOX_DATA) return { line: BOX_DATA.line || '', box: BOX_DATA.box || [], pbp: BOX_DATA.pbp || [] };
  if (PARSE_SRC) {
    const { parseBoxscore } = require('../server');
    let html;
    if (isUrl) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 25000);
          const r = await fetch(PARSE_SRC, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', accept: 'text/html,application/xhtml+xml' }, signal: ctl.signal });
          clearTimeout(to);
          if (!r.ok) { console.error(`[box] ${r.status} fetching ${PARSE_SRC} (try ${attempt}/3)`); if (attempt < 3) { await new Promise(s => setTimeout(s, 2000 * attempt)); continue; } return null; }
          html = await r.text(); break;
        } catch (e) { console.error(`[box] error fetching ${PARSE_SRC}: ${e.message} (try ${attempt}/3)`); if (attempt < 3) { await new Promise(s => setTimeout(s, 2000 * attempt)); continue; } return null; }
      }
    } else {
      html = fs.readFileSync(PARSE_SRC, 'utf8');
    }
    return html ? parseBoxscore(html) : null;
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
// Strip inert player links and the table's own caption (we add our own section
// headers), so the box tables render clean inside the PDF.
const cleanTable = h => String(h || '').replace(/<caption>[\s\S]*?<\/caption>/gi, '').replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '');
// The app appends a season batting-average column (each cell tagged class="bxavg")
// to every batting table. The printed box is a single-game sheet, so drop that
// column — header and data cells alike — before rendering.
const dropAvgCol = h => String(h || '').replace(/<t[hd]\b[^>]*class="[^"]*\bbxavg\b[^"]*"[^>]*>[\s\S]*?<\/t[hd]>/gi, '');
const txtOf = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const normName = n => String(n || '').toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();

// ---- name-cell normalization ------------------------------------------------
// Each box row's first cell mixes a lowercase position span ("rf"), an optional
// substitute letter span ("a-"), and the player name — and the name arrives in
// three shapes: a bare text node, a <span> (positionless players + every
// pitcher), or two adjacent spans with no space ("dh"+"Jackson Beddoe"). A blanket
// `span{text-transform:uppercase}` in the print CSS used to SHOUT every one of
// those name spans (JACOB BAKER, JOHN SHADAR, DHJACKSON BEDDOE). We instead rebuild
// the cell here: uppercase ONLY the position, space it off the name, keep the sub
// letter, and title-case a name that arrives all-caps (leaving intentional inner
// caps like "LaCava" alone).
const BOX_POS = new Set(['1b', '2b', '3b', 'ss', 'lf', 'cf', 'rf', 'c', 'dh', 'of', 'p', 'ph', 'pr', 'dp', 'fl', 'util']);
// A short slash/hyphen-joined token where every part is a fielding position
// (covers combos like "3b/2b", "2b-rf") — as opposed to a player name.
const isPosToken = t => { const s = String(t).trim().toLowerCase(); return s.length <= 6 && s.split(/[/-]/).every(p => BOX_POS.has(p)); };
// Title-case a name only where a whole word (or hyphen-part) is ALL-CAPS, so a
// SHOUTED "BEDDOE" / "SALAZAR-SANCHEZ" is fixed but a real "LaCava"/"DeShields"
// (which already carries a lowercase letter) is left untouched.
const fixNameCaps = name => String(name).replace(/[A-Za-z][A-Za-z'’.]*/g, w => (/[a-z]/.test(w) || w.length < 2) ? w : (w[0] + w.slice(1).toLowerCase()));
function normalizeNameCell(row) {
  return row.replace(/<th\b([^>]*)>([\s\S]*?)<\/th>/i, (full, attrs, inner) => {
    const plain = txtOf(inner);
    if (!plain || /^(hitters|pitchers|totals?)$/i.test(plain)) return full; // header / totals row
    let sublet = '';
    let content = inner
      .replace(/<span[^>]*class="sublet"[^>]*>\s*([a-z+])-?\s*<\/span>/i, (m, l) => { sublet = l; return ''; })
      .replace(/<\/?div[^>]*>/gi, '')
      .replace(/<a\b[^>]*>|<\/a>/gi, '');
    let pos = '';
    content = content.replace(/^\s*<span[^>]*>\s*([^<]{1,6})\s*<\/span>/i, (m, t) => { if (isPosToken(t)) { pos = t.trim().toUpperCase(); return ''; } return m; });
    const name = fixNameCaps(txtOf(content));
    let out = '';
    if (pos) out += `<span class='pos'>${esc(pos)}</span> `;
    if (sublet) out += `<span class='sub'>${esc(sublet)}-</span>`;
    out += esc(name);
    return `<th${attrs}>${out}</th>`;
  });
}
const normalizeNames = html => String(html || '').replace(/<tr\b[\s\S]*?<\/tr>/gi, normalizeNameCell);
// Keep a long pitcher name on one line by shortening the first name to an initial
// (Michael Salazar-Sanchez -> M. Salazar-Sanchez) instead of letting the narrow
// pitching name column wrap it. Short names stay in full, matching the rest of
// the staff. Applied to pitching only — the batting name column is wide enough.
function abbreviateLongName(name, maxLen) {
  const n = String(name || '').trim();
  if (n.length <= maxLen) return n;
  const parts = n.split(/\s+/);
  if (parts.length < 2 || !parts[0]) return n;                 // single token — can't abbreviate
  return parts[0].charAt(0).toUpperCase() + '. ' + parts.slice(1).join(' ');
}
function abbreviatePitcherNames(html, maxLen) {
  return String(html || '').replace(/<tr\b[\s\S]*?<\/tr>/gi, row => row.replace(/<th\b([^>]*)>([\s\S]*?)<\/th>/i, (full, attrs, inner) => {
    const nm = txtOf(inner);
    if (!nm || /^(pitchers|totals?)$/i.test(nm)) return full;
    const abbr = abbreviateLongName(nm, maxLen);
    return abbr === nm ? full : `<th${attrs}>${esc(abbr)}</th>`;
  }));
}
// Backfill a missing fielding position from the play-by-play. Presto sometimes
// drops the position on a player caught in a mid-inning double-switch — e.g. a
// starter pinch-hit for who then re-enters on defense — leaving a positionless
// 0-for-0 line (that's why Kumagami showed up bare). The feed still announces
// "<name> to <pos> for <other>", so map each such player to the last position he
// took and inject it where the box omitted one, so his row reads like the rest.
function pbpPositions(pbp) {
  const map = {};
  (pbp || []).forEach(h => (String(h.html || '').match(/<tr[\s\S]*?<\/tr>/gi) || []).forEach(r => {
    const m = txtOf(r).match(/^(.+?) to ([a-z0-9]+) for /i);
    if (m && BOX_POS.has(m[2].toLowerCase())) map[normName(m[1])] = m[2].toUpperCase();
  }));
  return map;
}
// Drop a pitcher's row from the batting table only when he never came to the
// plate. In a DH league a reliever gets listed with an empty 0-for-0 line (the
// source span-wraps his name so the app's own pitcher filter misses him); a
// pitcher who actually hit in the DH slot has real numbers, so he's kept.
function dropIdlePitchers(battingHtml, pitchingHtml) {
  const pitchers = new Set();
  (String(pitchingHtml || '').match(/<tr\b[\s\S]*?<\/tr>/gi) || []).forEach(r => {
    const first = (r.match(/<t[hd]\b[\s\S]*?<\/t[hd]>/i) || [''])[0];
    const nm = normName(txtOf(first));
    if (nm && nm !== 'pitchers' && nm !== 'totals') pitchers.add(nm);
  });
  if (!pitchers.size) return battingHtml;
  const nameOf = cell => normName(txtOf(String(cell).replace(/<span class=['"](?:pos|sub)['"]>[^<]*<\/span>/gi, '')));
  return String(battingHtml || '').replace(/<tr\b[\s\S]*?<\/tr>/gi, row => {
    const cells = row.match(/<t[hd]\b[\s\S]*?<\/t[hd]>/gi) || [];
    if (cells.length < 2) return row;
    const nm = nameOf(cells[0]);
    if (!nm || nm === 'hitters' || nm === 'totals') return row;
    if (!pitchers.has(nm)) return row;                                   // position player — keep
    const batted = cells.slice(1).some(c => (parseInt(txtOf(c), 10) || 0) > 0);
    return batted ? row : '';                                            // pitcher, never batted — drop
  });
}
function fillMissingPositions(html, posMap) {
  if (!posMap || !Object.keys(posMap).length) return html;
  return String(html || '').replace(/<tr\b[\s\S]*?<\/tr>/gi, row => row.replace(/<th\b([^>]*)>([\s\S]*?)<\/th>/i, (full, attrs, inner) => {
    if (/class=['"][^'"]*\bpos\b/.test(inner)) return full;          // already carries a position
    const nm = txtOf(inner).replace(/^[a-z+]-\s*/i, '');             // drop any leading sub letter
    if (!nm || /^(hitters|totals?)$/i.test(nm)) return full;         // header / totals row
    const pos = posMap[normName(nm)];
    if (!pos) return full;
    const injected = inner.replace(/^(\s*(?:<span class='sub'>[^<]*<\/span>)?)/i, `$1<span class='pos'>${esc(pos)}</span> `);
    return `<th${attrs}>${injected}</th>`;
  }));
}
const ordinal = n => { const v = n % 100, s = ['th', 'st', 'nd', 'rd']; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
// How each substitute entered, read from the play-by-play announcements the same
// way the app builds its own sub legend — the first "X pinch hit/ran for Y" or
// "X to <pos> for Y" for each player. Keyed by normalized name.
function pbpSubInfo(pbp) {
  const info = {};
  const set = (nm, v) => { const k = normName(nm); if (k && !info[k]) info[k] = v; };
  (pbp || []).forEach(h => {
    const im = (h.title || '').match(/(?:Top|Bottom) of (\d+)/i); const inn = im ? +im[1] : 0;
    (String(h.html || '').match(/<tr[\s\S]*?<\/tr>/gi) || []).forEach(r => {
      const t = txtOf(r);
      let m = t.match(/^(.+?) pinch hit for (.+?)\.?$/i); if (m) { set(m[1], { type: 'ph', forName: m[2].trim(), inn }); return; }
      m = t.match(/^(.+?) pinch ran for (.+?)\.?$/i); if (m) { set(m[1], { type: 'pr', forName: m[2].trim(), inn }); return; }
      m = t.match(/^(.+?) to ([a-z0-9]+) for (.+?)\.?$/i);
      if (m && BOX_POS.has(m[2].toLowerCase())) set(m[1], { type: 'def', pos: m[2], forName: m[3].trim(), inn });
    });
  });
  return info;
}
// Mark substitutes the app's own detector missed. It flags a sub when a batter's
// position repeats one already in the lineup, but it can't when the source left
// the position blank (Kumagami). Now that fillMissingPositions has restored those
// positions, re-run that "repeated position = sub" rule for any row not already
// flagged: indent it, give it the next alphabet letter, and add a legend entry
// (its entry read from the play-by-play), exactly like the subs the app caught.
function markMissedSubs(html, subInfo, legend) {
  const out = legend ? legend.slice() : [];
  const seenPos = new Set();
  const newHtml = String(html || '').replace(/<tr\b[\s\S]*?<\/tr>/gi, row => {
    const thm = row.match(/<th\b([^>]*)>([\s\S]*?)<\/th>/i);
    if (!thm) return row;
    const attrs = thm[1], inner = thm[2], plain = txtOf(inner);
    if (!plain || /^(hitters|totals?)$/i.test(plain)) return row;
    if (/\bbxsub\b/.test(attrs)) return row;                              // already flagged by the app
    const posM = inner.match(/<span class='pos'>([^<]*)<\/span>/i);
    const first = posM ? posM[1].trim().toLowerCase().split(/[/-]/)[0] : '';
    const isSub = first === 'ph' || first === 'pr' || (first && seenPos.has(first));
    if (!isSub) { if (first) seenPos.add(first); return row; }            // a starter — record his slot
    const name = txtOf(inner.replace(/<span class='(?:pos|sub)'>[^<]*<\/span>/gi, ''));
    const letter = String.fromCharCode(97 + out.length);
    const info = subInfo[normName(name)];
    const verb = info ? (info.type === 'pr' ? 'ran for ' : info.type === 'ph' ? 'pinch-hit for ' : 'in for ') : '';
    const text = info ? verb + info.forName + (info.inn ? ' in the ' + ordinal(info.inn) : '') : '';
    out.push({ letter, name, forName: info ? info.forName : '', text });
    const newAttrs = /class=/i.test(attrs)
      ? attrs.replace(/class=(['"])([^'"]*)\1/i, (m, q, c) => `class=${q}${c} bxsub${q}`)
      : attrs + " class='bxsub'";
    const newInner = posM
      ? inner.replace(/(<span class='pos'>[^<]*<\/span>)\s*/i, `$1 <span class='sub'>${letter}-</span>`)
      : `<span class='sub'>${letter}-</span>` + inner;
    return row.replace(thm[0], `<th${newAttrs}>${newInner}</th>`);
  });
  return { html: newHtml, legend: out };
}

function groupTeams(box) {
  const order = [], by = {};
  for (const e of box) {
    const tm = teamOf(e.label);
    if (!by[tm]) { by[tm] = { team: tm, gators: /gator|gumbeaux/i.test(tm), batting: null, pitching: null, legend: null, notes: null }; order.push(tm); }
    by[tm][kindOf(e.label)] = normalizeNames(dropAvgCol(cleanTable(e.html)));
    if (e.legend && e.legend.length) by[tm].legend = e.legend;
    if (e.notes) by[tm].notes = e.notes;
  }
  return order.map(tm => by[tm]).sort((a, b) => (b.gators ? 1 : 0) - (a.gators ? 1 : 0));
}

// HBP isn't a column in the PrestoSports pitching table, so derive it from the
// play-by-play: walk the halves in order, track each side's current pitcher
// (starter first, advanced on "X to p for Y" changes), and credit a hit-by-pitch
// to whoever is on the mound. Then inject an HBP column into each pitching table.
function pitcherRowNames(html) {
  const rows = (String(html || '').match(/<tr[\s\S]*?<\/tr>/gi) || []).slice(1);
  const out = [];
  for (const r of rows) { const c = (r.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(txtOf); const nm = c[0]; if (!nm || /^totals?$/i.test(nm)) continue; out.push(nm.replace(/\s*\([^)]*\)\s*$/, '').trim()); }
  return out;
}
function addHbpColumn(html, hbpMap) {
  const rows = String(html || '').match(/<tr[\s\S]*?<\/tr>/gi) || []; if (!rows.length) return html;
  const head = rows[0].match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
  const kIdx = head.findIndex(c => txtOf(c).toUpperCase() === 'K'); if (kIdx < 0) return html;
  const insAt = kIdx + 1;
  const rebuilt = [];
  const cell = (val, header) => `<${header ? 'th' : 'td'}>${val}</${header ? 'th' : 'td'}>`;
  rebuilt.push((() => { const cs = head.slice(); cs.splice(insAt, 0, cell('HBP', true)); return '<tr>' + cs.join('') + '</tr>'; })());
  let total = 0;
  for (const r of rows.slice(1)) {
    const cs = r.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
    const name = txtOf(cs[0]);
    let v = 0;
    if (/^totals?$/i.test(name)) v = total;
    else { for (const k in hbpMap) { if (normName(k) === normName(name)) { v = hbpMap[k]; break; } } total += v; }
    cs.splice(insAt, 0, cell(String(v), false));
    rebuilt.push('<tr>' + cs.join('') + '</tr>');
  }
  return String(html).replace(/<tr[\s\S]*?<\/tr>/gi, () => rebuilt.shift());
}
function injectHBP(teams, pbp) {
  teams.forEach(t => { t._pitchers = pitcherRowNames(t.pitching); t._hbp = {}; t._cur = 0; });
  if (Array.isArray(pbp)) {
    for (const pp of pbp) {
      const title = txtOf(pp.title);
      const bat = teams.find(t => t.team && title.includes(t.team));
      const field = teams.find(t => t !== bat);
      if (!field) continue;
      for (const r of (String(pp.html || '').match(/<tr[\s\S]*?<\/tr>/gi) || [])) {
        const tx = txtOf(r);
        const ch = tx.match(/^(.+?) to p for /i);
        if (ch) { const idx = field._pitchers.findIndex(p => normName(p) === normName(ch[1])); if (idx >= 0) field._cur = idx; }
        if (/hit by pitch/i.test(tx)) { const cur = field._pitchers[field._cur]; if (cur) field._hbp[cur] = (field._hbp[cur] || 0) + 1; }
      }
    }
  }
  teams.forEach(t => { if (t.pitching) t.pitching = addHbpColumn(t.pitching, t._hbp); });
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
  // Split the column's vertical space between the two tables in proportion to
  // their row counts, so rows stay roughly the same height in both — i.e. a long
  // pitching list (many arms) gets more room instead of staying tiny while the
  // batting table hogs the space.
  const rc = html => (String(html || '').match(/<tr/gi) || []).length || 1;
  const sections = [];
  if (t.batting) {
    sections.push(`<div class='tcap bat'>${cap} — BATTING</div><div class='tbl bat' style='flex:${rc(t.batting)} 1 0'>${t.batting}</div>`);
    // Substitution ledger: the alphabet legend keyed to the "a-/b-" letters on the
    // substitute rows above (pinch-hit/ran/defensive replacements), matching the
    // in-app box score. Only rendered when this side actually made a substitution.
    if (t.legend && t.legend.length) {
      const items = t.legend.map(s => `<span class='litem'><b>${esc(s.letter)}-</b> ${esc(s.text || ('for ' + (s.forName || '')))}</span>`).join('');
      sections.push(`<div class='sublegend'>${items}</div>`);
    }
    // Box notes (2B/3B/HR/SB/CS/E …) under the batting table, same stat set the
    // in-app box score lists — the batting columns don't carry these. Errors (E)
    // get their own row beneath the offensive notes so the fielders credited with
    // an error stay grouped together instead of trailing off a wrapped line.
    const offensive = {}, errNotes = {};
    for (const k in (t.notes || {})) { (String(k).toUpperCase() === 'E' ? errNotes : offensive)[k] = t.notes[k]; }
    const notesRows = [];
    const oLine = notesLine(offensive); if (oLine) notesRows.push(`<div>${oLine}</div>`);
    const eLine = notesLine(errNotes); if (eLine) notesRows.push(`<div>${eLine}</div>`);
    if (notesRows.length) sections.push(`<div class='boxnotes'>${notesRows.join('')}</div>`);
  }
  if (t.pitching) sections.push(`<div class='tcap pit'>${cap} — PITCHING</div><div class='tbl pit' style='flex:${rc(t.pitching)} 1 0'>${t.pitching}</div>`);
  // Brand the column to the team's color (Gators purple by default).
  const color = t.gators ? GATORS_PURPLE : teamColor(t.team);
  return `<div class='teamcol' style='--teamc:${color}'>${sections.join('')}</div>`;
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
  // Remove relievers listed with an empty batting line (they never hit); a
  // pitcher who actually batted in the DH slot has real numbers and stays.
  teams.forEach(t => { if (t.batting && t.pitching) t.batting = dropIdlePitchers(t.batting, t.pitching); });
  const posMap = pbpPositions(data.pbp);   // backfill positions Presto dropped in double-switches
  teams.forEach(t => { if (t.batting) t.batting = fillMissingPositions(t.batting, posMap); });
  // With positions restored, flag any substitute the app missed (its position was
  // blank in the source) so it indents under its starter with an alphabet letter
  // and a legend entry, like the subs the app already caught.
  const subInfo = pbpSubInfo(data.pbp);
  teams.forEach(t => { if (t.batting) { const r = markMissedSubs(t.batting, subInfo, t.legend); t.batting = r.html; t.legend = r.legend; } });
  injectHBP(teams, data.pbp);   // derive + add the HBP pitching column from the play-by-play
  teams.forEach(t => { if (t.pitching) t.pitching = abbreviatePitcherNames(t.pitching, 15); });   // long name -> "F. Last" (one line)
  const croc = S.crocSkinDataUri();
  // Score/result/opponent from the line score when present; seed game otherwise.
  let gs = game.gs, os = game.os, win = game.win, opp = oppName;
  const lt = parseLineTeams(data.line);
  if (lt) { const G = lt.find(t => t.gators), O = lt.find(t => !t.gators); if (G && O) { gs = G.r; os = O.r; win = gs > os ? true : gs < os ? false : null; opp = O.name.replace(/^(lake charles|the)\s+/i, '').trim() || oppName; } }
  // Neutral scoreline for the badge (handed to both coaches): each team + its
  // score, visitor on top. The leading team's score is gold (a fact, not "WIN").
  const gName = (lt && lt.find(t => t.gators)) ? lt.find(t => t.gators).name : 'Lake Charles Gumbeaux Gators';
  const oName = (lt && lt.find(t => !t.gators)) ? lt.find(t => !t.gators).name : (game.opp || opp);
  const gShort = teamShort(gName), oShort = teamShort(oName);
  // Tint the opponent's name cell in the line score to their team color (the
  // Gators' stays purple), matching their table headers.
  let lineHtml = cleanTable(data.line);
  if (lineHtml && lt) { const oTeam = lt.find(t => !t.gators); if (oTeam) { const oc = teamColor(oTeam.name); const safe = oTeam.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); lineHtml = lineHtml.replace(new RegExp('<th>(\\s*' + safe + '\\s*)</th>', 'i'), `<th style="background:${oc}">$1</th>`); } }
  const line = data.line ? `<div class='linewrap'>${lineHtml}</div>` : '';
  // Innings played = the line score's inning columns (a team row's <td>s minus R/H/E).
  const innings = (() => { const rows = String(lineHtml || '').match(/<tr[\s\S]*?<\/tr>/gi) || []; for (const r of rows.slice(1)) { const n = (r.match(/<td[\s\S]*?<\/td>/gi) || []).length; if (n >= 4) return n - 3; } return 9; })();
  // Adaptive row density: the tallest column (batting + pitching rows) sets the
  // vertical cell padding so a long lineup + a deep bullpen still fit one page
  // without clipping the Totals row. Roomy for a normal box, tighter as rows grow.
  const rcount = html => (String(html || '').match(/<tr/gi) || []).length || 1;
  // Budget accounts for the per-column fixed overhead the rows share the page
  // with — two section captions, the sub legend, and the notes block — so a tall
  // lineup + bullpen still lands its Totals rows on the page instead of clipping.
  const maxRows = Math.max(1, ...teams.map(t => rcount(t.batting) + rcount(t.pitching)));
  const padV = Math.max(3, Math.min(7, Math.floor((540 / maxRows - 15) / 2)));
  const H = [];
  H.push(`<!doctype html><html><head><meta charset='utf-8'><style>
@page{size:letter;margin:0;}
*{box-sizing:border-box;margin:0;padding:0;}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1b1e27;font-size:12px;padding:22px 34px;height:100vh;display:flex;flex-direction:column;overflow:hidden;--padv:${padV}px;}
.band{position:relative;display:flex;align-items:center;gap:14px;color:#fff;padding:10px 20px 10px 112px;border-radius:12px;border:2px solid #ecc913;
background:linear-gradient(rgba(22,16,43,.02),rgba(22,16,43,.16))${croc ? `,url('${croc}') center center / cover no-repeat` : ''};
background-color:#3a2480;box-shadow:0 3px 11px rgba(58,36,128,.3),inset 0 0 0 1px rgba(255,255,255,.08);}
/* Absolutely positioned so its size doesn't stretch the band — the band height
   stays driven by the text, and the logo is enlarged within it. */
.band img{position:absolute;left:16px;top:50%;transform:translateY(-50%);width:78px;height:78px;}
.k{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#ffd633;font-weight:800;text-shadow:0 1px 2px rgba(0,0,0,.5);}
.band h1{font-size:21px;font-weight:900;line-height:1.05;margin:2px 0;text-shadow:0 2px 4px rgba(0,0,0,.55);white-space:nowrap;}
.band h1 .hdate{display:block;font-size:12.5px;font-weight:700;letter-spacing:.01em;color:#efe7ff;margin-bottom:1px;}
.band .sub{font-size:12px;font-weight:700;color:#efe7ff;text-shadow:0 1px 2px rgba(0,0,0,.5);}
/* Scoreboard card: a self-contained panel (team name left, score right, winner
   in gold, a FINAL footer) so it reads as a scoreboard rather than loose text. */
.badge{margin-left:auto;display:flex;flex-direction:column;justify-content:center;gap:2px;min-width:196px;padding:8px 14px;border-radius:10px;background:rgba(14,8,32,.34);border:1px solid rgba(255,214,51,.30);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05);}
.badge .sbrow{display:flex;align-items:baseline;justify-content:space-between;gap:22px;}
.badge .snm{font-size:14px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#e4d9ff;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.5);}
.badge .sval{font-size:24px;font-weight:900;line-height:1;color:#fff;font-variant-numeric:tabular-nums;text-shadow:0 2px 4px rgba(0,0,0,.5);}
.badge .win .snm{color:#fff;}
.badge .win .sval{color:#ffd633;}
.badge .bstat{margin-top:4px;padding-top:5px;border-top:1px solid rgba(255,255,255,.16);text-align:center;font-size:10px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#e7dcff;text-shadow:0 1px 2px rgba(0,0,0,.5);}
.linewrap{margin:11px 0 3px;}
.linewrap table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;}
.linewrap th,.linewrap td{border:1px solid #d9d2ec;padding:6px 10px;text-align:center;font-size:14px;}
.linewrap th{background:#3a2480;color:#fff;font-weight:800;text-transform:uppercase;letter-spacing:.03em;}
.linewrap th:first-child,.linewrap td:first-child{text-align:left;font-weight:800;white-space:nowrap;}
.linewrap td:first-child{background:#f3f0fb;}
.linewrap td:nth-last-child(-n+3){font-weight:800;background:#faf8ff;}
.cols{display:flex;gap:16px;margin-top:10px;flex:1;min-height:0;}
.teamcol{flex:1;min-width:0;display:flex;flex-direction:column;}
.tcap{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#fff;background:var(--teamc,#3a2480);padding:5px 11px;border-radius:6px 6px 0 0;}
.tcap.pit{margin-top:9px;}
.tbl{border:1px solid #e6def7;border-top:none;border-radius:0 0 6px 6px;overflow:hidden;min-height:0;}
.tbl table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;height:100%;table-layout:fixed;}
.tbl th,.tbl td{padding:var(--padv,8px) 5px;text-align:center;font-size:12.5px;font-weight:400;border-bottom:1px solid #efeaf9;}
/* Vertical column dividers. */
.tbl table th:not(:last-child),.tbl table td:not(:last-child){border-right:1px solid #e6def7;}
/* Pitching has more columns (IP..S%) than batting, so tighten it to fit the
   half-width column, and let it size each column to its own content (below). */
.tbl.pit table{table-layout:auto;}
.tbl.pit th,.tbl.pit td{padding-left:4px;padding-right:4px;font-size:11px;white-space:nowrap;}
/* Column-header row only — PrestoSports also marks each per-row name cell as a <th>,
   so the header style must not leak onto those (it was shading + upper-casing names). */
.tbl table tr:first-child th{background:#fff;color:var(--teamc,#3a2480);font-weight:800;text-transform:uppercase;letter-spacing:.02em;font-size:10.5px;}
.tbl.pit table tr:first-child th{font-size:9px;letter-spacing:0;}
.tbl th:first-child,.tbl td:first-child{text-align:left;white-space:nowrap;width:44%;}
/* Auto layout sizes each stat column to its own header/content, so no label
   (HBP, ERA, #P, S%) ever clips; only the name column gets a width hint and wraps. */
.tbl.pit th:first-child,.tbl.pit td:first-child{width:25%;white-space:nowrap;}
/* A little extra room for the last column so its label isn't cramped at the edge. */
.tbl.bat th:last-child,.tbl.bat td:last-child{width:11%;}
.tbl tr:not(:first-child) th:first-child{color:#2a2150;font-weight:600;}
/* Only the fielding-position prefix is upper-cased — never the player name (the
   old blanket span rule SHOUTED pitcher + positionless names). */
.tbl .pos{text-transform:uppercase;color:#6a5aa8;font-weight:700;}
.tbl .sub{color:#8a1a4c;font-weight:700;}  /* the a-/b- substitute reference letter */
/* Substitutes (pinch-hit/ran, defensive replacements) are indented under the
   starter they replaced, MLB Gameday / ESPN style — the box lists them in that
   starter's slot, so the indent alone reads as "came in for the man above". */
.tbl th.bxsub{padding-left:22px;font-weight:400;}
.tbl th.bxsub .pos{color:#8b83a8;}
.tbl a{color:inherit;text-decoration:none;}
/* Substitution ledger under a team's batting table — the alphabet legend. */
.sublegend{font-size:9px;line-height:1.45;color:#4a416e;padding:5px 3px 1px;}
.sublegend .litem{display:inline-block;margin:0 11px 2px 0;}
.sublegend b{color:var(--teamc,#3a2480);font-weight:800;}
/* Box notes (2B/3B/HR/SB/CS/E) under the batting table — the extra-base hits,
   steals, and errors the batting columns don't carry, like the in-app box. */
.boxnotes{font-size:9px;line-height:1.5;color:#3a3358;padding:6px 3px 1px;border-top:1px solid #ece6f8;margin-top:2px;}
.boxnotes > div + div{margin-top:2px;}
.boxnotes b{color:var(--teamc,#3a2480);font-weight:800;letter-spacing:.02em;}
/* Zebra striping for readability (every other data row), like the league box. */
.tbl table tr:nth-child(2n) th,.tbl table tr:nth-child(2n) td{background:#f0eafa;}
.tbl tr:last-child th,.tbl tr:last-child td{background:#faf8ff;font-weight:800;border-bottom:none;}
</style></head><body>`);
  H.push(`<div class='band'><img src='${S.gatorsLogoDataUri()}'><div><div class='k'>Gumbeaux Gators · Official Box Score</div><h1><span class='hdate'>${esc(game.date)}, 2026</span>${game.home ? 'vs' : 'at'} ${esc(opp)}</h1>${T ? `<div class='sub'>Record ${T.w}-${T.l}</div>` : ''}</div><div class='badge'><div class='sbrow${gs > os ? ' win' : ''}'><span class='snm'>${esc(gShort)}</span><span class='sval'>${gs}</span></div><div class='sbrow${os > gs ? ' win' : ''}'><span class='snm'>${esc(oShort)}</span><span class='sval'>${os}</span></div><div class='bstat'>${innings === 9 ? 'Final' : 'Final &middot; ' + innings + ' inn'}</div></div></div>`);
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

// When the box is parsed from a URL/file (no seed game), build the header meta
// from the parsed line score: teams + runs, plus date/id from the source name.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function deriveMeta(data) {
  const lt = parseLineTeams(data.line) || [];
  const gRow = lt.find(t => t.gators), oRow = lt.find(t => !t.gators);
  const idm = String(PARSE_SRC || '').match(/(\d{8})_([a-z0-9]+)/i);
  const id = idm ? (idm[1] + '_' + idm[2]) : '';
  const ymd = id.slice(0, 8);
  const date = /^\d{8}$/.test(ymd) ? `${MONTHS[+ymd.slice(4, 6) - 1] || ''} ${+ymd.slice(6, 8)}`.trim() : '';
  const visitorGators = lt.length > 0 && lt[0].gators;   // line score lists the visitor first
  game = { id, date, home: !visitorGators, opp: oRow ? oRow.name : 'Opponent',
    gs: gRow ? gRow.r : 0, os: oRow ? oRow.r : 0, win: (gRow && oRow) ? (gRow.r > oRow.r ? true : gRow.r < oRow.r ? false : null) : null };
  oppName = (oRow ? oRow.name : '').replace(/^(lake charles|the)\s+/i, '');
  T = null;   // record isn't in the box score; omit it from the header
}

async function main() {
  const data = await getBox();
  if (!data || !data.box || !data.box.length) { console.error(`[box] no box score available${game ? ' for ' + game.id : ''} (offline? host not allowlisted? game not final yet?).`); process.exit(2); }
  if (!game) deriveMeta(data);
  const stem = buildStem(data);
  const html = buildHtml(data);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  if (KEEP_HTML) { const hf = path.join(outDir, `${stem}.html`); fs.writeFileSync(hf, html); console.error('wrote', path.relative(path.join(__dirname, '..'), hf)); }
  if (PDF) { const out = path.join(outDir, `${stem}.pdf`); if (renderPdf(html, out)) console.log('wrote', path.relative(path.join(__dirname, '..'), out)); else process.exit(1); }
}

if (require.main === module) main();
module.exports = { groupTeams, notesLine };
