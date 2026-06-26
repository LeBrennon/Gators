#!/usr/bin/env node
// Build league-roster.json (batter bios for the live "1st AB" card) from the TCL
// gameday-roster text. The official roster arrives as a PDF; export it to a tab-
// delimited text file first (any PDF-to-text tool), then:
//
//   node scripts/parse-league-roster.js TCL_GAMEDAY_ROSTER_2026.txt
//
// Output: league-roster.json — { normalizedName: { t:team, s:school, c:class } }.
// Re-run whenever the league updates rosters. Season stats are NOT in the roster;
// the server joins those from the league hitting leaderboard at runtime.

const fs = require('fs');
const path = require('path');

const input = process.argv[2];
if (!input) { console.error('usage: node scripts/parse-league-roster.js <roster.txt>'); process.exit(1); }
const txt = fs.readFileSync(input, 'utf8');

const TEAM_SHORT = {
  'ABILENE FLYING BISON': 'Abilene', 'ACADIANA CANE CUTTERS': 'Acadiana',
  'BATON ROUGE ROUGAROU': 'Baton Rouge', 'BRAZOS VALLEY BOMBERS': 'Brazos Valley',
  'LAKE CHARLES GUMBEAUX GATORS': 'Gators', 'SAN ANTONIO RIVER MONSTERS': 'San Antonio',
  'SHERMAN SHADOWCATS': 'Sherman', 'VICTORIA GENERALS': 'Victoria',
};
const CLASS_RE = /\b(Freshman|Sophomore|Junior|Senior|Graduate|Grad)\b/i;

// Must match server.js normPlayerName(): "Last, First" -> "first last", drop
// suffixes/punctuation, lowercase, collapse spaces.
function norm(n) {
  let s = String(n || '').replace(/’/g, "'").trim();
  if (s.includes(',')) { const p = s.split(','); s = (p[1] + ' ' + p[0]).trim(); }
  return s.toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

const out = {}; let team = null, section = null, n = 0, dups = 0;
for (const raw of txt.split(/\r?\n/)) {
  const line = raw.replace(/’/g, "'").trimEnd(); const t = line.trim();
  if (!t) continue;
  let m = t.match(/^2026\s+(.+)$/); if (m) { team = TEAM_SHORT[m[1].trim()] || m[1].trim(); section = null; continue; }
  if (/^POSITION PLAYERS/i.test(t)) { section = 'pos'; continue; }
  if (/^PITCHERS/i.test(t)) { section = 'pit'; continue; }
  if (/^STAFF/i.test(t)) { section = 'staff'; continue; }
  if (/^#\s*\t?\s*NAME/i.test(t) || /^Updated for/i.test(t) || /^--\s*\d+\s*of\s*\d+/i.test(t)) continue;
  if (section === 'staff' || !team) continue;
  if (!/^\d+[\s\t]/.test(t)) continue; // player rows start with a jersey number
  const parts = line.split('\t').map(s => s.trim()).filter((s, i) => !(i > 0 && s === ''));
  if (parts.length < 2) continue;
  const name = parts[1]; if (!/^[A-Za-z]/.test(name)) continue;
  let cls = '', school = '';
  if (parts[3] && CLASS_RE.test(parts[3])) cls = parts[3];
  if (parts.length >= 5) school = parts[parts.length - 1];
  else if (parts.length === 4) school = cls ? '' : parts[3];
  const key = norm(name); if (out[key]) dups++;
  out[key] = { t: team, s: school, c: cls };
  n++;
}

const file = path.join(__dirname, '..', 'league-roster.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)} — ${Object.keys(out).length} players (${n} rows, ${dups} name collisions)`);
