/* ============================================================================
 * Gators GameTracker — Cloud (lite)
 * One file. Polls the Texas League schedule (server-rendered, no browser),
 * pulls the Gators' live score + inning, serves the app, and pushes alerts on
 * runs, lead changes, and final. Fits a free host. Node 18+ (built-in fetch).
 * ==========================================================================*/
'use strict';
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const compression = require('compression');
const fs = require('fs');
const zlib = require('zlib');
let webpush = null; try { webpush = require('web-push'); } catch (e) {}
let nodemailer = null; try { nodemailer = require('nodemailer'); } catch (e) {}

// One-line error logger for the background pollers. Their catch blocks keep the
// last-good data on purpose, but used to swallow the cause silently — this leaves
// a breadcrumb (function name + message) without dumping stacks on every blip.
function logErr(where, e) { console.error('[' + where + '] ' + ((e && e.message) || e)); }

const PORT         = process.env.PORT || 8787;
const POLL_MS      = Number(process.env.POLL_MS || 15000);
// Deployed-build identity so it's possible to tell at a glance which commit is
// actually live (Render exposes these env vars; locally they fall back to dev).
// Surfaced in /health, /api/version, and a small footer in the app.
const BUILD = {
  commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'dev',
  branch: process.env.RENDER_GIT_BRANCH || '',
  bootedAt: new Date().toISOString(),
};
const BUILD_LABEL = 'build ' + BUILD.commit + (BUILD.branch ? ' · ' + BUILD.branch : '');
// Manual incident banner shown atop the live tracker. Empty string hides it —
// clear this out once Brazos confirms their scorekeeper/feed is caught up.
const SITE_NOTICE = '';
// Manual score override for the featured game, used when the source feed lags
// behind a confirmed final. Clear gameId to null once the feed catches up to
// the same score to fall back to the scraped data.
const MANUAL_OVERRIDE = {
  gameId: '20260701_jzkh',
  awayRuns: 10,
  homeRuns: 8,
  note: 'Box score will be fully updated soon. Final score is correct.',
};
// Manual cancellation override for the featured game. When gameId matches the
// featured game, force it to a cancelled state — this ends the live gamecast
// (score strip, at-bat/pitching cards, play-by-play) and shows only the
// cancellation. Set gameId to null once the game is off the board.
const MANUAL_CANCEL = {
  gameId: '20260705_17i2',
};
// Manual pitcher-name override for the live feed, used when the source scorer has
// a pitcher entered as a placeholder — e.g. Presto's "Emergency Player #0" — and
// we know the real player. Each entry matches the feed's raw pitcher name
// (case-insensitive), optionally scoped to a single gameId, and rewrites the live
// "Pitching" card, the box-score pitching row, and pitch-count matching so the
// real name shows everywhere. Clear an entry once the scorekeeper fixes the name
// in Presto.
const MANUAL_PITCHER_OVERRIDES = [
  { gameId: null, from: 'Emergency Player', name: 'Cameron Carlile', uni: '21' },
];
// Manual doubleheader labels. The schedule feed lists both games of a same-day
// doubleheader without saying which is game 1 vs game 2, and a seven-inning
// doubleheader final can read as a plain "Final" instead of "Final/7". Pin the
// game number (label) and, when the feed under-annotates it, the regulation
// status by game id — both flow to the hero card and the schedule list. Order
// is by which game was played first (game 1 finishes first). Clear entries once
// the doubleheader is off the board.
const MANUAL_DOUBLEHEADER = {
  '20260712_85ki': { label: 'Doubleheader · Game 1', status: 'Final/7' },
  '20260712_7mnj': { label: 'Doubleheader · Game 2', status: 'Final/7' },
};
const LIVE_POLL_MS = Number(process.env.LIVE_POLL_MS || 4000); // tight enough that the live count/score/pitch-count track pitch-by-pitch
const SCHEDULE_URL = process.env.SCHEDULE_URL || 'https://texasleaguestats.prestosports.com/sports/bsb/2026/schedule';
const SITE_URL     = (process.env.SITE_URL || 'https://whatisthegatorscore.com').replace(/\/$/, '');
// Secret key gating the private analytics page (/stats). When unset, it's
// locked entirely (private by default).
const REPORT_KEY   = process.env.REPORT_KEY || '';
// Gmail (app-password) sender for the daily visitor-analytics digest.
const MAIL_USER    = process.env.GMAIL_USER || '';
const MAIL_PASS    = process.env.GMAIL_APP_PASSWORD || '';
const mailReady    = !!(nodemailer && MAIL_USER && MAIL_PASS);
// Daily unique-visitor analytics: digest recipient + a salt for hashing IPs
// (we never store raw IPs). Same-day dedupe stays stable across restarts.
const STATS_TO     = (process.env.STATS_TO || 'brennonmoore11@gmail.com').split(',').map(s => s.trim()).filter(Boolean);
const STATS_SALT   = process.env.STATS_SALT || 'gators-visits-v1';
// End-of-inning text alert: reuses the same Gmail sender to email an address
// that a carrier turns into a text — e.g. 5551234567@vtext.com (Verizon),
// @txt.att.net (AT&T), @tmomail.net (T-Mobile). Comma-separated, same
// convention as STATS_TO; empty (the default) leaves the feature off.
const INNING_ALERT_TO = (process.env.INNING_ALERT_TO || '').split(',').map(s => s.trim()).filter(Boolean);
const VAPID_PUB    = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIV   = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_MAIL   = process.env.VAPID_CONTACT || 'mailto:you@example.com';
const pushReady    = Boolean(webpush && VAPID_PUB && VAPID_PRIV);
if (pushReady) webpush.setVapidDetails(VAPID_MAIL, VAPID_PUB, VAPID_PRIV);

// Live-situation feed (StatView "liveupdate"). We derive the per-game event id
// and access hash from each game's boxscore page, then poll the feed.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SPORT_BASE = (() => { try { const u = new URL(SCHEDULE_URL); return u.origin + u.pathname.replace(/\/schedule.*$/, ''); } catch (e) { return ''; } })();
const ORIGIN = (() => { try { return new URL(SCHEDULE_URL).origin; } catch (e) { return ''; } })();
const boxscoreUrl = id => SPORT_BASE + '/boxscores/' + id + '.xml';
const STANDINGS_URL = SPORT_BASE + '/standings';
// ----- league teams (by PrestoSports logo/team id) --------------------------
const TEAMS = {
  et1bt9sixrz5lnnl: { name: 'Lake Charles Gumbeaux Gators', short: 'Gators' },
  cz8qei0rxijys6nm: { name: 'Acadiana Cane Cutters',        short: 'Cane Cutters' },
  z10kgms3gvy1eszs: { name: 'Baton Rouge Rougarou',         short: 'Rougarou' },
  ij0lwtvjsx2mi1nh: { name: 'Abilene Flying Bison',         short: 'Flying Bison' },
  z7w5th537gur3z15: { name: 'Brazos Valley Bombers',        short: 'Bombers' },
  do9ibktaduhyld7f: { name: 'San Antonio River Monsters',   short: 'River Monsters' },
  w43rx8i07fn44cyl: { name: 'Sherman Shadowcats',           short: 'Shadowcats' },
  jm9r4btii24hhtfp: { name: 'Victoria Generals',            short: 'Generals' },
};
// Host city/region per team id — used for the "Away @ <city>" label and for
// matching games to TCL TV (Vewbie) stream slugs. Regional brands (Acadiana,
// Brazos Valley) intentionally use the region name.
const CITY = {
  et1bt9sixrz5lnnl: 'Lake Charles',
  cz8qei0rxijys6nm: 'Acadiana',
  z10kgms3gvy1eszs: 'Baton Rouge',
  ij0lwtvjsx2mi1nh: 'Abilene',
  z7w5th537gur3z15: 'Brazos Valley',
  do9ibktaduhyld7f: 'San Antonio',
  w43rx8i07fn44cyl: 'Sherman',
  jm9r4btii24hhtfp: 'Victoria',
};
// Team name as it reads after the city — the bold mascot part of the scoreboard
// "<city> <mascot>" label. Equals `.short` for every team except the Gators,
// whose mascot is two words ("Gumbeaux Gators") that `.short` trims to "Gators";
// rendering `city + short` there would drop "Gumbeaux".
const NICK = {};
for (const id in TEAMS) {
  const c = CITY[id], n = TEAMS[id].name;
  NICK[id] = (c && n.toLowerCase().startsWith(c.toLowerCase() + ' ')) ? n.slice(c.length).trim() : TEAMS[id].short;
}
// Each team's official home website (TCL teams page).
const TEAM_SITE = {
  et1bt9sixrz5lnnl: 'https://gumbeauxgators.com/',
  cz8qei0rxijys6nm: 'https://canecuttersbaseball.com/',
  z10kgms3gvy1eszs: 'https://www.brrougarou.com/',
  ij0lwtvjsx2mi1nh: 'https://abileneflyingbison.com/',
  z7w5th537gur3z15: 'https://bvbombers.com/',
  do9ibktaduhyld7f: 'https://www.rivermonstersbaseball.com/',
  w43rx8i07fn44cyl: 'https://shermanshadowcats.com/',
  jm9r4btii24hhtfp: 'https://victoriagenerals.com/',
};
const HOME_VENUE = 'Joe Miller Ballpark';
const GATORS_ID = 'et1bt9sixrz5lnnl';
// Scoreboard/board city prefix. The Gators are "our" team — show just the bold
// mascot ("Gumbeaux Gators"), no dim city. Every other team keeps its city.
const boardCity = id => id === GATORS_ID ? '' : (CITY[id] || '');
// Split-season tracking. The TCL plays two halves; each half's winner clinches a
// playoff berth. Standings shown below reflect the current half, with clinched
// teams tagged "x-" regardless of where their (reset) second-half record sits.
// Playoff seeding + tie-breaker rules (half champions seed 1-2, top-2 of the 2nd
// half seed 3-4, overlap/next-best rules, and the 2- and 3+-team tie-breakers)
// are recorded in docs/tcl-playoff-rules.md for end-of-season resolution.
const SEASON_HALF = 2;            // 1 = first half, 2 = second half
// Team ids that have already clinched a playoff spot, with the reason shown in
// the Standings legend. Victoria & Acadiana won the first half.
const CLINCHED_PLAYOFF = {
  jm9r4btii24hhtfp: '1st-half champion',   // Victoria Generals
  cz8qei0rxijys6nm: '1st-half champion',   // Acadiana Cane Cutters
};
// First-half FINAL records (frozen). The live feed reports full-season W-L, so
// the second-half record is derived as (season − first-half). Captured the day
// the second half opened, when every team was 0-0 in the 2H — i.e. these equal
// each team's full-season record at that moment.
const FIRST_HALF_FINAL = {
  jm9r4btii24hhtfp: { w: 17, l: 7 },    // Victoria Generals
  cz8qei0rxijys6nm: { w: 13, l: 10 },   // Acadiana Cane Cutters
  do9ibktaduhyld7f: { w: 11, l: 10 },   // San Antonio River Monsters
  et1bt9sixrz5lnnl: { w: 12, l: 11 },   // Lake Charles Gumbeaux Gators
  z10kgms3gvy1eszs: { w: 10, l: 12 },   // Baton Rouge Rougarou
  ij0lwtvjsx2mi1nh: { w: 9,  l: 11 },   // Abilene Flying Bison
  z7w5th537gur3z15: { w: 10, l: 13 },   // Brazos Valley Bombers
  w43rx8i07fn44cyl: { w: 6,  l: 14 },   // Sherman Shadowcats
};
// 2026 home-game themed nights (promotions), keyed by game date (yyyymmdd).
const THEMES = {
  '20260602': 'Mardi Party',
  '20260604': 'Youth Sports',
  '20260612': 'Fireworks / Rock Night',
  '20260627': 'Princess / Superhero',
  '20260702': 'Visit Lake Charles',
  '20260703': 'Fireworks',
  '20260704': 'Red, White, & Blue Fireworks',
  '20260716': 'Salute To Service',
  '20260718': 'Cheer & Dance',
  '20260719': 'Faith & Family',
  '20260724': 'Fireworks / KIX Night',
  '20260725': 'Christmas in July',
  '20260726': 'Host Fam / Helicopter',
};
// Home games with free admission (no tickets sold), keyed by date -> sponsor.
const FREE_ADMISSION = {
  '20260627': 'Southside Machine Works',
};
// Recurring nightly concession promos by weekday (0=Sun..6=Sat). Home games
// only — these run at Joe Miller Ballpark. No Monday game day.
const PROMOS = {
  0: { emoji: '🎟️', name: '4 for $40',         detail: '4 tickets, 4 hot dogs & 4 regular soft drinks for $40' },
  2: { emoji: '🌭', name: 'Twos-Day',          detail: '$2 hot dogs, $2 popcorn & $2 regular soft drinks' },
  3: { emoji: '⏱️', name: 'Beat the Clock',     detail: '50% off concessions 6:00–6:30pm, 25% off 6:30–7:00pm' },
  4: { emoji: '🍻', name: 'Thirsty Thursday',   detail: '2-for-1 on all adult beverages' },
  5: { emoji: '🎆', name: 'Fireworks Friday',   detail: 'Fireworks during the 7th-inning stretch' },
  6: { emoji: '🎶', name: 'Party at the Park',  detail: 'Live music & 2-for-1 happy hour on adult beverages, 6:00–7:00pm' },
};
function promoFor(g) {
  if (!g || !g.gatorsHome || !g.date || (g.state !== 'scheduled' && g.state !== 'live')) return null;
  const dow = new Date(Date.UTC(+g.date.slice(0, 4), +g.date.slice(4, 6) - 1, +g.date.slice(6, 8), 12)).getUTCDay();
  // Party at the Park's happy hour runs 6:00–7:00pm; once it's past 7pm Central on
  // game day the tagline is stale, so drop it.
  if (dow === 6 && g.date === todayCentralYmd() && centralHourNow() >= 19) return null;
  return PROMOS[dow] || null;
}
// One-off special events (date -> {emoji, name, detail}), shown as their own
// badge + line on top of the recurring weekday promo.
const SPECIALS = {
  '20260708': { emoji: '🎓', name: 'College Night', detail: 'Free admission with student ID + a free bag of popcorn for all students' },
};
const GATORS_LOGO_BUF = fs.readFileSync(__dirname + '/gators-logo.png');
const TCL_LOGO_BUF = fs.readFileSync(__dirname + '/tcl-logo.png');
const GG_LOGO_BUF = fs.readFileSync(__dirname + '/gg-logo.png');
// Preload the on-disk social/PWA images once at boot rather than fs.readFileSync
// on every request (icon-512 is ~200 KB; reading it sync per hit blocks the loop).
const readAssetSafe = f => { try { return fs.readFileSync(__dirname + '/' + f); } catch (e) { return null; } };
const OG_BUF = readAssetSafe('og.jpg');
const ICON_512_BUF = readAssetSafe('icon-512.png');
const ICON_192_BUF = readAssetSafe('icon-192.png');

// ---- Finished-game box score + full play-by-play (parsed from the ?view=plays page) ----
function bsClean(t) {
  return t
    .replace(/<img[^>]*>/gi, '')
    .replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '')
    .replace(/<\/?(?:thead|tbody|tfoot)\b[^>]*>/gi, '')
    .replace(/<strong\b[^>]*>/gi, '<b>').replace(/<\/strong>/gi, '</b>')
    .replace(/\s+(?:class|style|id|href|width|height|align|valign|scope|role|title|target|rel|aria-[a-z-]+|data-[a-z-]+)="[^"]*"/gi, '')
    .replace(/[\t\r\n]+/g, ' ').replace(/>\s+</g, '><').trim();
}
function bsText(t) { return t.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim(); }
function bsLineTeams(lineHtml) {
  if (!lineHtml) return [];
  const rows = lineHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  const names = [];
  for (const row of rows) {
    const cells = row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || [];
    if (!cells.length) continue;
    const first = bsText(cells[0]);
    if (first && !/^final$/i.test(first) && !/^\d+$/.test(first)) names.push(first);
  }
  return names;
}
// Position of a Hitters-table row, read from the <span> in the player cell.
function bsRowPos(row) {
  const cell = (row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/i) || [''])[0];
  const m = cell.match(/<span\b[^>]*>([^<]*)<\/span>/i);
  return m ? m[1].trim().toLowerCase() : '';
}
// Player name from a box-score row's first cell: drop the position <span>, any
// (W, 1-0)-style decision, punctuation and case — for cross-table matching.
function bsRowName(row) {
  let cell = (row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/i) || [''])[0];
  cell = cell.replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, ' ');
  return bsText(cell).replace(/\([^)]*\)/g, ' ').replace(/[^a-z\s]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
// Names listed in a Pitchers table (excluding the header and totals rows).
function bsPitcherNames(tableHtml) {
  const names = new Set();
  for (const r of (tableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || [])) {
    const n = bsRowName(r);
    if (n && n !== 'pitchers' && n !== 'totals') names.add(n);
  }
  return names;
}
// Every TCL game uses a DH, so a pitcher never bats. Drop a Hitters-table row
// when its position reads "p" or its player appears in the Pitchers table —
// relievers list as blank-position 0-for-0 lines the position filter misses.
function bsDropPitchers(tableHtml, pitchers) {
  const rows = tableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  let out = tableHtml;
  for (const r of rows) {
    const name = bsRowName(r);
    if (bsRowPos(r) === 'p' || (pitchers && name && name !== 'totals' && pitchers.has(name))) out = out.replace(r, '');
  }
  return out;
}
// The boxscore table captions read "<City Mascot> Batters/Pitchers"; trim the
// city so headings show just the mascot ("Gators Batters", "Rougarou Pitchers").
const TEAM_SHORT_BY_NAME = {};
for (const id in TEAMS) TEAM_SHORT_BY_NAME[TEAMS[id].name.replace(/\s+/g, ' ').trim().toLowerCase()] = TEAMS[id].short;
function bsMascot(name) {
  const k = String(name || '').replace(/\s+/g, ' ').trim();
  if (TEAM_SHORT_BY_NAME[k.toLowerCase()]) return TEAM_SHORT_BY_NAME[k.toLowerCase()];
  for (const id in CITY) { const c = CITY[id]; if (k.toLowerCase().startsWith(c.toLowerCase() + ' ')) return k.slice(c.length).trim(); }
  return k;
}
function bsShortenCaption(html) {
  return html.replace(/(<caption>\s*<h2>)([\s\S]*?)(<span>)/i, (m, a, name, b) => a + bsMascot(name) + ' ' + b);
}
// Extract a batting row's player name (text between the position <span> and the
// row's closing </div>), stripping any link wrapper bsLinkGators added.
function bsSubName(thInner) {
  const m = thInner.match(/<\/span>([\s\S]*?)(?:<\/div>|<\/th>|$)/i);
  return (m ? bsText(m[1]) : bsText(thInner)).trim();
}
// Mark substitute batters (pinch hitters/runners and defensive subs) so the box
// score can indent them under the starter they replaced, like MLB Gameday. Among
// the nine starters every fielding position is distinct, so a batter is a sub if
// its position is ph/pr or repeats a position already listed in the lineup.
// Also seed the MLB-style reference legend: each sub takes the batting slot of
// the player listed directly above it (fallback "for"); bsAttachSubLegend later
// enriches each entry with the play result + inning from the play-by-play.
// Returns { html, legend:[{letter, name, pos, forName, text}] }.
function bsMarkSubs(tableHtml) {
  const seen = new Set();
  const legend = [];
  let n = 0, prevName = '';   // substitute order within this team -> a, b, c...
  const html = tableHtml.replace(/<tr\b[\s\S]*?<\/tr>/gi, row => {
    const th = row.match(/<th\b([^>]*)>([\s\S]*?)<\/th>/i);
    if (!th) return row;
    const sp = th[2].match(/<span>([\s\S]*?)<\/span>/i);
    if (!sp) return row;                       // "Hitters" header / "Totals" carry no position
    const first = bsText(sp[1]).toLowerCase().split(/[-/ ]/)[0];
    const nm = bsSubName(th[2]);
    let sub = false;
    if (first === 'ph' || first === 'pr') sub = true;
    else if (seen.has(first)) sub = true;
    else seen.add(first);
    if (!sub) { if (nm) prevName = nm; return row; }
    const letter = n < 26 ? String.fromCharCode(97 + n) : '+'; n++;
    const verb = first === 'ph' ? 'pinch-hit for' : first === 'pr' ? 'pinch-ran for' : 'in for';
    legend.push({ letter, name: nm, pos: first, forName: prevName, text: prevName ? verb + ' ' + prevName : verb });
    prevName = nm;                             // a later sub in this slot replaced this one
    let out = row.replace(/<th\b([^>]*)>/i, (m, a) => /class=/i.test(a)
      ? m.replace(/class="([^"]*)"/i, 'class="$1 bxsub"')
      : '<th' + a + ' class="bxsub">');
    // Prefix the name with the reference letter (after the position span).
    return out.replace(/(<\/span>\s*)/i, '$1<span class="sublet">' + letter + '-</span>');
  });
  return { html, legend };
}
// Inning ordinal (1->1st, 2->2nd, 7->7th, 11->11th).
function bsOrd(n) { const v = n % 100, s = ['th', 'st', 'nd', 'rd']; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
// A play row's leading text is the batter; these verbs mark a plate appearance.
// "out at first" is a plate appearance (batter thrown out at first on his
// grounder); "out at second/third/home" is a baserunning out (the batter had
// already reached base and was retired while running), so it's NOT listed as an
// at-bat result.
const BS_PA_RE = /^(singled|doubled|tripled|homered|home run|walked|intentionally walked|struck out|grounded|flied|popped|lined|reached|hit by pitch|hit into|fouled|sacrific|infield fly|bunt|out at first|grounded into)\b/i;
// Tidy a play description toward MLB legend wording: drop the pitch-count
// parenthetical and trailing clauses, spell out fielder abbreviations.
function bsNormRes(s) {
  s = s.replace(/\s*\([^)]*\)/g, '').split(/[;,]/)[0].replace(/\.\s*$/, '').trim();
  // Double/triple plays: drop the fielder chain ("ss to second to first") — the
  // MLB legend just says "grounded into double play".
  s = s.replace(/\binto (?:a\s+)?(double|triple) play\b.*/i, 'into $1 play');
  s = s.replace(/\bto 1b\b/gi, 'to first').replace(/\bto 2b\b/gi, 'to second').replace(/\bto 3b\b/gi, 'to third')
       .replace(/\bto ss\b/gi, 'to short').replace(/\bto lf\b/gi, 'to left').replace(/\bto cf\b/gi, 'to center')
       .replace(/\bto rf\b/gi, 'to right').replace(/\bto p\b/gi, 'to pitcher').replace(/\bto c\b/gi, 'to catcher');
  s = s.replace(/\b(right|left|center) field\b/gi, '$1');
  s = s.replace(/^(out at (?:first|second|third|home))\b.*/i, '$1');
  return s.trim();
}
// Enrich each batting table's sub legend with "<result> for <player> in the
// <inning>th", read from play-by-play substitution announcements ("X pinch hit
// for Y", "X to cf for Y") plus the sub's first plate appearance. Falls back to
// the seeded "for <player>" text when a sub has no announcement in the feed.
function bsAttachSubLegend(box, pbp) {
  const plays = [];
  (pbp || []).forEach(p => {
    const m = (p.title || '').match(/(?:Top|Bottom) of (\d+)/i); const inn = m ? +m[1] : 0;
    (p.html.match(/<tr\b[\s\S]*?<\/tr>/gi) || []).forEach(r => {
      const tx = bsText(r);
      if (tx && !/Inning Summary/i.test(tx) && !/(?:Top|Bottom) of \d+ Inning/i.test(tx)) plays.push({ inn, tx });
    });
  });
  const POS = /^(?:1b|2b|3b|ss|lf|cf|rf|c|dh|of|ph|pr)$/i;
  const ann = {};
  for (const p of plays) {
    let m = p.tx.match(/^(.+?) pinch hit for (.+?)\.?$/i); if (m) { ann[m[1].trim()] = { repl: m[2].trim(), type: 'ph', inn: p.inn }; continue; }
    m = p.tx.match(/^(.+?) pinch ran for (.+?)\.?$/i); if (m) { ann[m[1].trim()] = { repl: m[2].trim(), type: 'pr', inn: p.inn }; continue; }
    m = p.tx.match(/^(.+?) to ([a-z0-9]+) for (.+?)\.?$/i);
    if (m && POS.test(m[2]) && /^[A-Z]/.test(m[3].trim())) ann[m[1].trim()] = { repl: m[3].trim(), type: 'def', inn: p.inn };
  }
  const findPA = (nm, minInn) => {
    for (const p of plays) {
      if (p.inn < minInn || p.tx.indexOf(nm + ' ') !== 0) continue;
      const rest = p.tx.slice(nm.length).trim();
      if (BS_PA_RE.test(rest)) return { inn: p.inn, res: bsNormRes(rest) };
    }
    return null;
  };
  for (const b of box) {
    if (!b.legend) continue;
    for (const it of b.legend) {
      const a = ann[it.name]; if (!a) continue;   // no feed announcement -> keep seeded "for <player>"
      if (a.type === 'pr') { it.text = 'ran for ' + a.repl + ' in the ' + bsOrd(a.inn); continue; }
      const pa = findPA(it.name, a.inn);
      it.text = pa ? pa.res + ' for ' + a.repl + ' in the ' + bsOrd(pa.inn)
                   : (a.type === 'ph' ? 'pinch-hit for ' : 'in for ') + a.repl + ' in the ' + bsOrd(a.inn);
    }
  }
  return box;
}
// Append a Strike% column to each pitching table. The source has NP (pitches)
// but no strikes; play-by-play pitch sequences "(1-2 KKB)" record every BALL
// (a ball can't be put in play) — only the contact pitch (always a strike) is
// omitted — so strikes = NP - balls. Walk the feed tallying balls per pitcher
// (B/H letters), tracking the current pitcher per side through "X to p for Y"
// changes. Home pitches the top halves, away the bottom; since which table is
// which isn't labeled, try both pairings and keep the one whose per-pitcher
// tallies stay consistent (balls <= NP and >= 4*BB, since each walk is 4 balls).
function bsPitcherName(cell) { return bsText(cell || '').replace(/\s*\(.*$/, '').trim(); }
function bsAttachStrikePct(box, pbp) {
  const pit = box.filter(b => /Pitching/i.test(b.label));
  if (pit.length !== 2 || !(pbp && pbp.length)) return box;
  const parse = entry => {
    const rows = entry.html.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    const head = (rows[0].match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || []).map(c => bsText(c).toUpperCase());
    const npIdx = head.indexOf('NP'), bbIdx = head.indexOf('BB');
    const pitchers = [];
    rows.slice(1).forEach(r => {
      const cells = r.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || [];
      const name = bsPitcherName(cells[0]);
      if (!name || /^totals$/i.test(name)) return;
      pitchers.push({ name, np: parseInt(bsText(cells[npIdx] || ''), 10) || 0, bb: parseInt(bsText(cells[bbIdx] || ''), 10) || 0 });
    });
    return { npIdx, pitchers };
  };
  const a = parse(pit[0]), b = parse(pit[1]);
  if (a.npIdx < 0 || b.npIdx < 0 || a.npIdx !== b.npIdx) return box;
  const allP = a.pitchers.concat(b.pitchers);
  const walk = (topStarter, botStarter) => {
    const cur = { top: topStarter, bot: botStarter }, balls = {};
    pbp.forEach(p => {
      const mm = (p.title || '').match(/(Top|Bottom) of/i); const side = mm && /top/i.test(mm[1]) ? 'top' : 'bot';
      (p.html.match(/<tr\b[\s\S]*?<\/tr>/gi) || []).forEach(r => {
        const tx = bsText(r);
        const sub = tx.match(/^(.+?) to p for .+?\.?$/i); if (sub) { cur[side] = sub[1].trim(); return; }
        const seq = tx.match(/\(\d+-\d+\s+([A-Z]+)\)/);
        if (seq) { let n = 0; for (const ch of seq[1]) if (ch === 'B' || ch === 'H') n++; if (cur[side]) balls[cur[side]] = (balls[cur[side]] || 0) + n; }
      });
    });
    return balls;
  };
  const score = balls => allP.reduce((s, p) => { const v = balls[p.name] || 0; return s + (v <= p.np && v >= 4 * p.bb ? 1 : 0); }, 0);
  const A = walk(a.pitchers[0] && a.pitchers[0].name, b.pitchers[0] && b.pitchers[0].name);
  const B = walk(b.pitchers[0] && b.pitchers[0].name, a.pitchers[0] && a.pitchers[0].name);
  const balls = score(A) >= score(B) ? A : B;
  const inject = (entry, info) => {
    const np = {}, bb = {}; info.pitchers.forEach(p => { np[p.name] = p.np; bb[p.name] = p.bb; });
    let first = true;
    entry.html = entry.html.replace(/<tr\b[\s\S]*?<\/tr>/gi, row => {
      const open = (row.match(/^<tr\b[^>]*>/i) || ['<tr>'])[0];
      const cells = row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || [];
      if (!cells.length) return row;
      let cell;
      if (first) { first = false; cell = '<th>S%</th>'; }
      else {
        const name = bsPitcherName(cells[0]);
        let n, bl, w;
        if (/^totals$/i.test(name)) {
          n = info.pitchers.reduce((s, p) => s + p.np, 0); w = info.pitchers.reduce((s, p) => s + p.bb, 0);
          bl = info.pitchers.reduce((s, p) => s + (balls[p.name] || 0), 0);
        } else { n = np[name] || 0; w = bb[name] || 0; bl = balls[name]; }
        const ok = bl != null && n > 0 && bl <= n && bl >= 4 * w;
        cell = '<td>' + (ok ? Math.round((n - bl) / n * 100) : '-') + '</td>';
      }
      cells.push(cell);
      return open + cells.join('') + '</tr>';
    });
  };
  inject(pit[0], a); inject(pit[1], b);
  return box;
}
// A box-score batting row's player name, cleaned for season-stat matching: drop
// the position <span>, any (decision) parenthetical, and a trailing bare position
// token (some rows append the position as plain text instead of a span).
function bsBatterName(cell) {
  let s = String(cell || '').replace(/<span\b[\s\S]*?<\/span>/gi, ' ');
  s = bsText(s).replace(/\([^)]*\)/g, ' ');
  s = s.replace(/\s+(?:1b|2b|3b|ss|lf|cf|rf|dh|ph|pr|of|util|c|p)$/i, '');
  return s.trim();
}
// name -> Presto slug for every hitter in a RAW (pre-bsClean) Hitters table, read
// straight from each row's <a href=".../players/slug"> — the same link every
// player's own profile page lives at. Lets the box score pull opponents' season
// AVG from their own Presto page (like Gators) instead of only the league
// leaderboard, which is unreliable for players who aren't hitting leaders.
function bsBattingSlugs(rawTableHtml) {
  const map = {};
  for (const row of (rawTableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || [])) {
    const cells = row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || [];
    if (!cells.length) continue;
    const a = cells[0].match(/<a\b[^>]*href="([^"]*)"[^>]*>/i);
    if (!a) continue;
    const slug = slugFromHref(a[1]); if (!slug) continue;
    const key = normPlayerName(bsBatterName(cells[0])); if (!key) continue;
    map[key] = slug;
  }
  return map;
}
// Append a season batting-average (AVG) column to one box-score batting table, so
// every hitter's season-to-date average shows in the box for live and past games
// — opponents "just like ours". Each hitter's own Presto player page (via slugMap,
// built from the box score's own player links — see bsBattingSlugs) is tried
// first, since it's exact; that covers opponents the same way rosterStats covers
// Gators. Falls back to the league leaderboard (via seasonAvgFor), then a
// last-name + first-initial fallback for box pages that abbreviate the first name
// ("Smith, J"). Injected fresh on each request (never cached) so the figure
// tracks the current season, not first-view.
function bsAddSeasonAvg(html, slugMap) {
  const idx = {};   // "firstInitial|lastname" -> avg, for the abbreviated-name fallback
  const add = (nm, avg) => { const k = normPlayerName(nm); if (!k) return; const p = k.split(' '); if (p.length < 2) return;
    const li = p[0][0] + '|' + p[p.length - 1]; if (!(li in idx)) idx[li] = avg; };
  const usable = h => h && h.avg != null && h.avg !== '' && h.avg !== '-';
  for (const k in leagueHitterStats) { const h = leagueHitterStats[k]; if (usable(h)) add(k, String(h.avg)); }
  for (const key in GATOR_BY_NORM) { const g = GATOR_BY_NORM[key]; const h = (rosterStats[g.slug] || {}).hit; if (usable(h)) add(key, String(h.avg)); }
  const resolve = raw => {
    const key = normPlayerName(raw);
    const slug = (slugMap && key) ? slugMap[key] : null;
    const bySlug = slug ? (rosterStats[slug] || {}).hit : null;
    if (usable(bySlug)) return String(bySlug.avg);
    const a = seasonAvgFor(raw); if (a != null) return a;
    if (!key) return null; const p = key.split(' '); if (p.length < 2) return null;
    return idx[p[0][0] + '|' + p[p.length - 1]] || null;
  };
  let first = true;
  return html.replace(/<tr\b[\s\S]*?<\/tr>/gi, row => {
    const cells = row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || [];
    if (!cells.length) return row;
    const open = (row.match(/^<tr\b[^>]*>/i) || ['<tr>'])[0];
    let cell;
    if (first) { first = false; cell = '<th class="bxavg">AVG</th>'; }
    else if (/^totals$/i.test(bsText(cells[0]).trim())) cell = '<td class="bxavg"></td>';
    else { const avg = resolve(bsBatterName(cells[0])); cell = '<td class="bxavg">' + (avg || '-') + '</td>'; }
    cells.push(cell);
    return open + cells.join('') + '</tr>';
  });
}
// Turn Gators players' names in the box score into links that open their roster
// profile. Matches the box-score name against the roster (built lazily since
// ROSTER is defined later) and wraps it in an <a data-slug> the client handles.
let _gatorNameSlug = null;
function gatorNameSlug() {
  if (!_gatorNameSlug) { _gatorNameSlug = {}; for (const p of ROSTER) _gatorNameSlug[p.name.toLowerCase().replace(/\s+/g, ' ').trim()] = p.slug; }
  return _gatorNameSlug;
}
function bsLinkGators(tableHtml) {
  const map = gatorNameSlug();
  const link = (name, slug) => '<a class="bxp" data-slug="' + slug + '">' + name + '</a>';
  return tableHtml.replace(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi, (full, attrs, inner) => {
    if (/<span>/i.test(inner)) {                 // batting: name sits between </span> and </div>
      return full.replace(/(<\/span>)([\s\S]*?)(<\/div>)/i, (m, a, mid, b) => {
        const name = bsText(mid); const slug = map[name.toLowerCase()];
        if (!slug) return m;
        return a + mid.match(/^\s*/)[0] + link(name, slug) + mid.match(/\s*$/)[0] + b;
      });
    }
    const paren = inner.indexOf('(');            // pitching: " Name (W, 1-0) " — link the leading name
    const namePart = paren >= 0 ? inner.slice(0, paren) : inner;
    const name = bsText(namePart); const slug = map[name.toLowerCase()];
    if (!slug) return full;
    return '<th' + attrs + '>' + namePart.match(/^\s*/)[0] + link(name, slug) + namePart.match(/\s*$/)[0] + (paren >= 0 ? inner.slice(paren) : '') + '</th>';
  });
}
// Rename the strikeout column header from "SO" to "K" (batting and pitching).
function bsRenameK(html) { return html.replace(/(<th\b[^>]*>)\s*SO\s*(<\/th>)/gi, '$1K$2'); }
// Append a game-ERA column to a pitching box table, computed from each line's
// ER and IP (the source box has no ERA column).
function bsPitchERA(html) {
  const head = html.match(/<tr\b[\s\S]*?<\/tr>/i);
  if (!head) return html;
  const heads = (head[0].match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || []).map(c => bsText(c).toLowerCase());
  const ipI = heads.indexOf('ip'), erI = heads.indexOf('er'), hrI = heads.indexOf('hr');
  if (ipI < 0 || erI < 0 || heads.indexOf('era') >= 0) return html; // not pitching, or already has ERA
  const after = hrI >= 0 ? hrI : heads.length - 1; // MLB puts ERA right after HR
  let first = true;
  return html.replace(/<tr\b[\s\S]*?<\/tr>/gi, row => {
    const open = (row.match(/^<tr\b[^>]*>/i) || ['<tr>'])[0];
    const cells = row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || [];
    if (!cells.length) return row;
    let cell;
    if (first) { first = false; cell = '<th>ERA</th>'; }
    else {
      const outs = ipToOuts(bsText(cells[ipI] || '')), er = parseInt(bsText(cells[erI] || ''), 10);
      cell = '<td>' + ((outs > 0 && !isNaN(er)) ? (er * 27 / outs).toFixed(2) : '-') + '</td>';
    }
    cells.splice(after + 1, 0, cell);
    return open + cells.join('') + '</tr>';
  });
}
// Wrap a pitcher's decision (W/L/S/H...) in a span so it can be tinted gold.
function bsPitchDecision(html) {
  return html.replace(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi, (full, attrs, inner) => {
    const m = inner.match(/\(\s*(?:W|L|SV|S|H|HLD|BS)\b[^)]*\)/i);
    return m ? '<th' + attrs + '>' + inner.replace(m[0], '<span class="dec">' + m[0] + '</span>') + '</th>' : full;
  });
}
// Comma-separated player list from a stats-summary <span>, tidied (keeps any
// trailing count like "Jacob Keys (2)").
function bsNotesClean(spanHtml) {
  return bsText(spanHtml).split(',').map(s => s.trim()).filter(Boolean).join(', ');
}
// The box score lists 2B/3B/HR (Batting), SB/CS (Baserunning) and E (Fielding) as
// per-team note blocks rather than table columns. Parse them, one entry per
// team in the same order as the batting tables.
const BOX_NOTE_LABELS = ['2B', '3B', 'HR', 'SB', 'CS', 'E'];
function parseBoxNotes(html) {
  const teams = []; let cur = null;
  const capRe = /<div class="caption">\s*([^<]*?)\s*<\/div>([\s\S]*?)(?=<div class="caption">|<table|<caption|$)/gi;
  let m;
  while ((m = capRe.exec(html))) {
    const cap = m[1].trim().toLowerCase(), chunk = m[2];
    if (cap === 'batting') { cur = {}; teams.push(cur); }
    if (!cur || (cap !== 'batting' && cap !== 'baserunning' && cap !== 'fielding')) continue;
    const sRe = /<strong>\s*([^:<]*?):\s*<\/strong>\s*<span>([\s\S]*?)<\/span>/gi;
    let s;
    while ((s = sRe.exec(chunk))) {
      const lab = s[1].trim().toUpperCase();
      if (BOX_NOTE_LABELS.indexOf(lab) !== -1) cur[lab] = bsNotesClean(s[2]);
    }
  }
  return teams.map(t => { const o = {}; for (const k of BOX_NOTE_LABELS) if (t[k]) o[k] = t[k]; return o; });
}
// Drop columns (by header label, case-insensitive) from a box-score table.
function bsDropCols(tableHtml, drop) {
  const rows = tableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi);
  if (!rows) return tableHtml;
  const head = rows[0].match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || [];
  const di = new Set();
  head.forEach((c, i) => { if (drop.indexOf(bsText(c).trim().toUpperCase()) !== -1) di.add(i); });
  if (!di.size) return tableHtml;
  let out = tableHtml;
  for (const row of rows) {
    const open = (row.match(/^<tr\b[^>]*>/i) || ['<tr>'])[0];
    const cells = row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || [];
    out = out.replace(row, open + cells.filter((c, i) => !di.has(i)).join('') + '</tr>');
  }
  return out;
}
function parseBoxscore(html) {
  const tables = html.match(/<table\b[\s\S]*?<\/table>/gi) || [];
  let line = null; const batting = [], battingSlugs = [], pitching = [], pbp = [], types = [];
  for (const t of tables) {
    const tx = bsText(t);
    let type = 'other';
    if (/(?:Top|Bottom) of /i.test(tx) && /Inning/i.test(tx)) {
      type = 'pbp';
      const m = tx.match(/(.*?(?:Top|Bottom) of .*?Inning)/i);
      pbp.push({ title: m ? m[1].trim() : 'Inning', html: bsClean(t) });
    } else if (/\bHitters\b/i.test(tx)) { type = 'batting'; batting.push(bsClean(t)); battingSlugs.push(bsBattingSlugs(t)); }
    else if (/\bPitchers\b/i.test(tx)) { type = 'pitching'; pitching.push(bsDropCols(bsClean(t), ['WP', 'AB'])); }
    // The line score is a finished game's R/H/E table. PrestoSports now prefixes
    // it with an offscreen "Line Score" caption, so bsText reads "Line Score
    // Final …"; older pages read just "Final …". Accept either lead-in.
    else if (/^(?:Line Score\s+)?Final\b/i.test(tx) && /\bR\b/.test(tx) && !line) { type = 'line'; line = bsClean(t); }
    types.push({ type, head: tx.slice(0, 60) });
  }
  // Pitchers never hit (DH league): drop every pitcher's row from the Hitters
  // tables, matching on name across both teams' Pitchers tables.
  const pitchers = new Set();
  for (const p of pitching) for (const n of bsPitcherNames(p)) pitchers.add(n);
  const battingClean = batting.map(b => bsDropPitchers(b, pitchers));
  const notes = parseBoxNotes(html);
  const teams = bsLineTeams(line);
  const lab = i => teams[i] || ('Team ' + (i + 1));
  // Most visitors are Gators fans, so list the Gators' tables first. Identify
  // the Gators side from the table caption (the line score's team names don't
  // always parse), then put that index ahead of the opponent.
  const capName = h => { const m = h.match(/<caption>[\s\S]*?<h2>([\s\S]*?)<span>/i); return m ? bsText(m[1]) : ''; };
  const gi = battingClean.findIndex(h => /gator/i.test(capName(h)));
  const order = n => { const a = [...Array(n).keys()]; return (gi >= 0 && gi < n) ? [gi, ...a.filter(x => x !== gi)] : a; };
  const box = [];
  // Group each team's tables together (batting then pitching), Gators first.
  // HR/BF are dropped from pitching after bsPitchERA, which needs HR to place ERA.
  order(battingClean.length).forEach(i => {
    const sub = bsMarkSubs(bsLinkGators(bsRenameK(bsShortenCaption(battingClean[i]))));
    box.push({ label: lab(i) + ' \u2014 Batting', html: sub.html, legend: sub.legend, notes: notes[i] || null, slugs: battingSlugs[i] || {} });
    if (pitching[i] != null) box.push({ label: lab(i) + ' \u2014 Pitching', html: bsDropCols(bsPitchDecision(bsPitchERA(bsLinkGators(bsRenameK(bsShortenCaption(pitching[i]))))), ['HR', 'BF']) });
  });
  bsAttachSubLegend(box, pbp);
  bsAttachStrikePct(box, pbp);   // reads the "NP" header; rename it only afterward
  for (const b of box) if (/Pitching/i.test(b.label)) b.html = b.html.replace(/(<th\b[^>]*>)\s*NP\s*(<\/th>)/i, '$1#P$2');
  return { line, teams, box, pbp,
    counts: { tables: tables.length, line: line ? 1 : 0, batting: batting.length, pitching: pitching.length, pbp: pbp.length }, types };
}

const BG_BUF  = fs.readFileSync(__dirname + '/bg-tile.jpg');
const BG_PATH = '/bg-' + crypto.createHash('md5').update(BG_BUF).digest('hex').slice(0, 10) + '.jpg';
const logo = id => id === GATORS_ID ? '/gators-logo.png' : 'https://cdn.prestosports.com/action/cdn/logos/id/' + id + '.png';
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function dateFromId(yyyymmdd) {
  const y = +yyyymmdd.slice(0,4), m = +yyyymmdd.slice(4,6), d = +yyyymmdd.slice(6,8);
  const dt = new Date(Date.UTC(y, m-1, d, 12));
  return { iso: y+'-'+yyyymmdd.slice(4,6)+'-'+yyyymmdd.slice(6,8), label: DOW[dt.getUTCDay()]+' '+m+'/'+d, sortKey: +yyyymmdd };
}
// League first pitch is 7:05pm Central every day. The schedule page's listed
// times are unreliable, so use the fixed league start time instead.
function gameTimeCDT(yyyymmdd) {
  return '7:05 PM CDT';
}
// ----- helpers --------------------------------------------------------------
function ordinal(n){ const s=['th','st','nd','rd'], v=n%100; return n + (s[(v-20)%10] || s[v] || s[0]); }
function cap(w){ return w ? w.charAt(0).toUpperCase()+w.slice(1).toLowerCase() : w; }
// Opponent names arrive from the box-score feed SHOUTING in all caps
// ("MARTINEZ, ANDREW" / "DYLAN BOHLKE"), while the Gators' own names come from
// the roster in proper case. Title-case any word that is entirely uppercase so
// opposing lineups read the same as ours. Words that already carry a lowercase
// letter — "DeHoyos", "McDonald", "O'Brien" from a properly-cased source — are
// left untouched, and hyphen/apostrophe compounds are cased part-by-part.
function deshout(name){
  return String(name || '').replace(/[A-Za-z][A-Za-z'’-]*/g, w =>
    /[a-z]/.test(w) ? w : w.replace(/[A-Za-z]+/g, s => cap(s)));
}
// Opponent schools in the league dataset are sometimes stored SHOUTING
// ("ODESSA COLL", "MISSISSIPPI COLLEGE") while the Gators' own read in proper
// case. Title-case each fully-uppercase word so a bio's school reads like the
// rest of the card, but leave genuine initialisms ("UTSA", "LSU", "CC") in caps
// and lowercase joiner words. Words that already carry a lowercase letter are
// left untouched, so proper-cased schools pass through unchanged.
const SCHOOL_ACRONYMS = new Set(['UTSA','UTRGV','UIW','UNO','UL','UT','TAMU','TX','SFA','PRCC','BPCC','LSU','LSUA','LSUE','CC','JC','HS','N']);
const SCHOOL_JOINERS = new Set(['of','the','and','at']);
function deshoutSchool(school){
  return String(school || '').replace(/[A-Za-z][A-Za-z'’]*/g, w => {
    if (/[a-z]/.test(w)) return w;            // already properly cased
    if (SCHOOL_ACRONYMS.has(w)) return w;     // genuine initialism, keep caps
    const c = cap(w);
    return SCHOOL_JOINERS.has(c.toLowerCase()) ? c.toLowerCase() : c;
  });
}
// The name spellings a play narrative might use for a player ("HUNTER HAM",
// "HAM, HUNTER"), so a SHOUTING opponent name in the feed's free text can be
// found and title-cased without touching the rest of the sentence.
function nameForms(pl){
  const out = [];
  const push = v => { const s = String(v || '').trim(); if (s) out.push(s); };
  push(pl.name); push(pl.shortname);
  const rv = String(pl.revname || '');
  if (rv.indexOf(',') !== -1) { const c = rv.split(','); const last = (c[0] || '').trim(), first = (c[1] || '').trim(); if (last) push((first ? first + ' ' : '') + last); }
  return out;
}
// Every fully-uppercase multi-word player name across both teams, longest first
// so "HUNTER HAM" is replaced before a bare "HAM" could match inside it. Only
// multi-word forms are kept, so a lone last name never corrupts another word.
function shoutingNames(json){
  const set = new Set();
  for (const t of ((json && json.team) || [])) for (const pl of (t.player || []))
    for (const f of nameForms(pl)) if (f.indexOf(' ') !== -1 && /[A-Z]/.test(f) && f === f.toUpperCase()) set.add(f);
  return [...set].sort((a, b) => b.length - a.length);
}
// Title-case the SHOUTING player names inside a play narrative, leaving position
// codes ("rf"), pitch sequences ("BFBS"), and "RBI" untouched.
function deshoutPlayText(text, names){
  let s = String(text || '');
  for (const n of names) if (s.indexOf(n) !== -1) s = s.split(n).join(deshout(n));
  return s;
}
// Names/short labels prefer the known-team map, but fall back to the scraped
// link text so an unrecognized opponent never blanks out a game.
function fullName(id, name){ return (TEAMS[id] && TEAMS[id].name) || String(name||'').trim() || 'TBD'; }
function shortName(id, name){
  if (TEAMS[id]) return TEAMS[id].short;
  const p = String(name||'').trim().split(/\s+/);
  return p.length > 2 ? p.slice(-2).join(' ') : (p[p.length-1] || 'TBD');
}
// First numeric-only tag (a plausible run total, 0..50) in s[from..to).
function scoreBetween(s, from, to){
  const re = />\s*(\d{1,3})\s*</g; re.lastIndex = Math.max(0, from|0);
  let m;
  while ((m = re.exec(s)) !== null){
    if (to != null && m.index >= to) break;
    const n = +m[1];
    if (n >= 0 && n <= 50) return n;
  }
  return null;
}

function classify(text) {
  if (/Postponed/i.test(text))  return { state: 'postponed', status: 'Postponed' };
  if (/Suspended/i.test(text))  return { state: 'suspended', status: 'Suspended' };
  if (/Cancell?ed/i.test(text)) return { state: 'cancelled', status: 'Cancelled' };
  if (/Forfeit/i.test(text))    return { state: 'final',     status: 'Forfeit' };
  if (/\bFinal\b/i.test(text)) {
    // Only annotate when the source explicitly calls out a non-regulation
    // inning count (extra innings, or a mercy-rule/rain-shortened game); a
    // plain "Final" with no annotation means a regulation 9-inning game.
    const ex = text.match(/Final[^<0-9]*?(\d+)\s*innings?/i);
    return { state: 'final', status: (ex && ex[1] !== '9') ? 'Final/' + ex[1] : 'Final' };
  }
  const live = text.match(/\b(Top|Bottom|Mid(?:dle)?|End)\b\s*(?:of\s*)?(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (live) {
    const half = /^mid/i.test(live[1]) ? 'Mid' : cap(live[1]);
    return { state: 'live', status: half + ' of ' + ordinal(+live[2]) };
  }
  if (/\bDelay(ed)?\b/i.test(text)) return { state: 'live', status: 'Delay' };
  const t = text.match(/(\d{1,2}:\d{2}\s*[AP]M(?:\s*[A-Z]{2,4})?)/i);
  if (t) return { state: 'scheduled', status: t[1].replace(/\s+/g,' ').trim() };
  return { state: 'scheduled', status: 'Scheduled' };
}

// Identify the two teams from the team-name links that sit just before the
// box-score link. We take the LAST two teamId links in the chunk so nav/filter
// links earlier on the page can't be mistaken for a matchup. Team identity and
// names come from the link itself, so the known-team map is optional.
// Identify the two teams from the team-logo images that sit just before the
// box-score link. IDs come from the logo URL (/logos/id/<id>.png) and names from
// the image alt text ("<Name> team logo"), so we depend only on the logo markup,
// not on how the name link is nested. We take the LAST two logos in the chunk so
// header/nav logos can't be mistaken for a matchup. The known-team map is
// optional — an unrecognized opponent still resolves from its alt text.
const LOGO = /\/logos\/id\/([a-z0-9]+)\.png/gi;
function altNameNear(chunk, idx) {
  // Look at the <img ...> tag containing this logo and read its alt attribute.
  const lt = chunk.lastIndexOf('<', idx);
  const gt = chunk.indexOf('>', idx);
  const tag = chunk.slice(lt < 0 ? 0 : lt, gt < 0 ? chunk.length : gt + 1);
  const alt = tag.match(/alt\s*=\s*"([^"]*)"/i) || tag.match(/alt\s*=\s*'([^']*)'/i);
  return alt ? alt[1].replace(/\s*team logo\s*$/i, '').replace(/\s+/g, ' ').trim() : '';
}
function teamsFromChunk(chunk) {
  const hits = []; let m; LOGO.lastIndex = 0;
  while ((m = LOGO.exec(chunk)) !== null)
    hits.push({ id: m[1], at: m.index, name: altNameNear(chunk, m.index) });
  if (hits.length < 2) return null;
  const a = hits[hits.length - 2], h = hits[hits.length - 1];
  const mk = (t, from, to) => ({
    id: t.id, name: fullName(t.id, t.name), short: shortName(t.id, t.name),
    logo: logo(t.id), score: scoreBetween(chunk, from, to),
  });
  return { away: mk(a, a.at, h.at), home: mk(h, h.at, null) };
}

function parseSchedule(html) {
  const re = /\/sports\/bsb\/\d{4}\/boxscores\/(\d{8})_([a-z0-9]+)\.xml/gi;
  const links = []; let m;
  while ((m = re.exec(html)) !== null) links.push({ id: m[1]+'_'+m[2], date: m[1], idx: m.index });
  const out = []; let prevEnd = 0;
  for (const link of links) {
    const chunk = html.slice(prevEnd, link.idx); prevEnd = link.idx + 1;
    const t = teamsFromChunk(chunk); if (!t) continue;
    if (t.away.id !== GATORS_ID && t.home.id !== GATORS_ID) continue;
    const when = dateFromId(link.date), cls = classify(chunk), gatorsHome = t.home.id === GATORS_ID;
    const opp = gatorsHome ? t.away : t.home;
    out.push({ id: link.id, date: link.date, dateLabel: when.label, sortKey: when.sortKey, state: cls.state, status: cls.state === 'scheduled' ? gameTimeCDT(link.date) : cls.status,
      gatorsHome, opponent: { name: opp.name, short: opp.short, logo: opp.logo }, away: t.away, home: t.home });
  }
  const seen = new Set();
  return out.filter(g => (seen.has(g.id) ? false : seen.add(g.id))).sort((a,b) => a.sortKey - b.sortKey);
}

// Today's date (yyyymmdd) in the league's timezone (US Central).
function todayCentralYmd() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => (p.find(x => x.type === t) || {}).value;
  return '' + g('year') + g('month') + g('day');
}
// Current hour (0–23) in the league's timezone (US Central).
function centralHourNow() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago',
    hour12: false, hour: '2-digit' }).formatToParts(new Date());
  let h = +(p.find(x => x.type === 'hour') || {}).value;
  return h === 24 ? 0 : h; // some runtimes emit "24" at midnight
}

// Scoreboard ordering: live games first, then finals, then scheduled; the
// Gators game leads its group.
function sortBoard(games) {
  const rank = s => s === 'live' ? 0 : s === 'final' ? 1 : 2;
  return games.sort((a, b) => rank(a.state) - rank(b.state)
    || (b.isGators ? 1 : 0) - (a.isGators ? 1 : 0) || a.id.localeCompare(b.id));
}
// Every league game on a given day (yyyymmdd) — same chunking as parseSchedule
// but without the Gators-only filter — for the around-the-league scoreboard.
function parseLeagueScoreboard(html, dateStr) {
  const re = /\/sports\/bsb\/\d{4}\/boxscores\/(\d{8})_([a-z0-9]+)\.xml/gi;
  const links = []; let m;
  while ((m = re.exec(html)) !== null) links.push({ id: m[1]+'_'+m[2], date: m[1], idx: m.index });
  const out = []; let prevEnd = 0; const seen = new Set();
  for (const link of links) {
    const chunk = html.slice(prevEnd, link.idx); prevEnd = link.idx + 1;
    if (dateStr && link.date !== dateStr) continue;
    if (seen.has(link.id)) continue;
    const t = teamsFromChunk(chunk); if (!t) continue;
    seen.add(link.id);
    const cls = classify(chunk);
    out.push({ id: link.id, date: link.date, state: cls.state, status: cls.state === 'scheduled' ? gameTimeCDT(link.date) : cls.status,
      isGators: t.away.id === GATORS_ID || t.home.id === GATORS_ID, url: boxscoreUrl(link.id),
      away: { id: t.away.id, short: t.away.short, logo: t.away.logo, score: t.away.score },
      home: { id: t.home.id, short: t.home.short, logo: t.home.logo, score: t.home.score } });
  }
  return sortBoard(out);
}

// ----- live situation feed --------------------------------------------------
const val = x => Array.isArray(x) ? x[0] : x;            // status fields arrive as 1-element arrays
const has = x => { const v = val(x); return v != null && String(v).trim() !== ''; };

// The boxscore page embeds the liveupdate event id + access hash that the live
// widget uses. Pull them out so we can call the feed ourselves.
function extractEventAuth(html) {
  const clean = String(html || '').replace(/&amp;/g, '&');
  // The access hash is a base64 value, so it can contain / + = on top of the
  // url-safe _ - alphabet — the character class must allow all of them or a hash
  // like "WKIEpkL/Kb6z…" is silently dropped (the feed then 400s as "Empty
  // event ID code parameter"). Callers must URL-encode it before use.
  const B64 = 'A-Za-z0-9_+/=\\-';
  // Older format: a complete liveupdate URL carrying both params.
  let m = clean.match(new RegExp('liveupdate\\?e=([a-z0-9]+)&h=([' + B64 + ']+)', 'i'));
  if (m) return { e: m[1], h: m[2], how: 'liveupdate-url' };
  // 2026 PrestoSports gameday config: conf.eventId + conf.eventIdHashCode
  // (the [:=] guard keeps `eventId` from matching inside `eventIdHashCode`).
  const e = (clean.match(/eventId\s*[:=]\s*["']([A-Za-z0-9]{8,})["']/i) || [])[1]
         || (clean.match(/liveupdate\?e=([A-Za-z0-9]+)/i) || [])[1];
  const h = (clean.match(new RegExp('(?:eventIdHashCode|gamedayHashCode|liveHash|hashCode|hash)\\s*[:=]\\s*["\']([' + B64 + ']{16,})["\']', 'i')) || [])[1]
         || (clean.match(new RegExp('liveupdate\\?e=[A-Za-z0-9]+&(?:amp;)?h=([' + B64 + ']{16,})', 'i')) || [])[1]
         || null;
  // The feed requires the hash; the entry-point URL no longer carries it inline,
  // so it's read from conf.eventIdHashCode above. Returning e without a hash is a
  // last-resort fallback (it lets the auth cache/diagnostics show the event id).
  if (e) return { e, h: h || null, how: h ? 'gameday-conf' : 'gameday-conf-nohash' };
  return { e: null, h: null, how: 'not-found' };
}

function snippetAround(html, needle, span = 180) {
  const i = String(html || '').search(new RegExp(needle, 'i'));
  if (i < 0) return null;
  return String(html).slice(Math.max(0, i - span), i + span).replace(/\s+/g, ' ').trim();
}

// Read-only diagnostics: probe the raw page for anything that looks like the
// live feed's event id / hash, so we can see the real markup without guessing.
function scanForAuth(html) {
  const s = String(html || '');
  const out = { length: s.length, keywords: {}, patterns: {} };
  const keywords = ['liveupdate', 'live-update', 'live_update', 'livestats', 'live-stats',
    'action/sports', 'gamecenter', 'genId', 'eventId', 'event_id', 'data-event', 'data-hash',
    'data-e=', 'data-h=', 'presto', 'sidearm', 'rsObserver', 'iframe', 'feed', '&h=', '?e=', 'hash'];
  const low = s.toLowerCase();
  for (const k of keywords) {
    const i = low.indexOf(k.toLowerCase());
    if (i >= 0) out.keywords[k] = { at: i, snip: s.slice(Math.max(0, i - 120), i + 160).replace(/\s+/g, ' ').trim() };
  }
  const grab = (src, max = 6) => {
    const hits = []; let m, n = 0;
    const r = new RegExp(src, 'ig');
    while ((m = r.exec(s)) && n < max) { hits.push(m[0].slice(0, 140)); n++; }
    return hits;
  };
  out.patterns.actionSports = grab('action/sports/[a-z]+\\?[^"\'<>\\s]{0,160}');
  out.patterns.eParam = grab('[?&]e=[a-z0-9]{8,}');
  out.patterns.hParam = grab('[?&]h=[A-Za-z0-9_\\-]{8,}');
  out.patterns.dataAttrs = grab('data-[a-z]*(?:event|hash|game)[a-z]*\\s*=\\s*["\'][^"\']{6,}["\']');
  // How the live widget actually loads: script srcs, iframes, inline setup code.
  const scriptSrc = []; { let m; const r = /<script[^>]+src\s*=\s*["']([^"']+)["']/ig; while ((m = r.exec(s)) && scriptSrc.length < 40) scriptSrc.push(m[1]); }
  out.scripts = scriptSrc;
  const iframes = []; { let m; const r = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/ig; while ((m = r.exec(s)) && iframes.length < 10) iframes.push(m[1]); }
  out.iframes = iframes;
  const inlineHits = []; {
    let m; const r = /<script\b[^>]*>([\s\S]*?)<\/script>/ig;
    const kw = /live|update|event|hash|poll|genId|widget|socket|statbroadcast|sidearm|\.json/i;
    while ((m = r.exec(s)) && inlineHits.length < 10) {
      const body = m[1]; const k = body.search(kw);
      if (k >= 0) inlineHits.push(body.slice(Math.max(0, k - 60), k + 240).replace(/\s+/g, ' ').trim());
    }
  }
  out.inlineHits = inlineHits;
  // htmx drives Presto's live updates — capture its request attributes and any live URLs.
  out.hx = grab('hx-(?:get|post|trigger|target|swap|vals)\\s*=\\s*["\'][^"\']{0,200}["\']', 25);
  out.endpoints = grab('(?:hx-get|hx-post|data-url|data-hx-get|src|href)\\s*=\\s*["\'][^"\']*(?:action/|live|update|poll|broadcast|dec=|\\.json)[^"\']*["\']', 25);
  return out;
}

// ----- one gateway for every Presto request ---------------------------------
// All scraping funnels through fetchCore so timeout, network-error retry, and
// throttle backoff live in one place instead of being re-implemented (or
// forgotten) per caller. Two shared pieces:
//   throttledUntil — a soft circuit breaker. When ANY request sees a throttle
//     status (429/503/459/403), every LATER background request waits until it
//     clears, so we back off as one instead of each subsystem discovering the
//     throttle independently and hammering through it.
//   netLimit — a global concurrency cap for FAN-OUT scrapes (the roster poll,
//     opponent-lineup warming, box-score enrichment). Foreground singles (the
//     live poll, the current batter, a profile tap) pass { priority:true } /
//     bypass the limiter so a cold roster scrape can't stall a live frame.
let throttledUntil = 0;
const netBackoff = a => Math.min(8000, 700 * Math.pow(2, a));  // 700, 1400, 2800…
function pLimit(max) {
  let active = 0; const queue = [];
  const run = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; run(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); run(); });
}
const netLimit = pLimit(Number(process.env.SCRAPE_CONCURRENCY || 6));
async function fetchCore(url, { headers, timeout = 12000, tries = 3, priority = false } = {}) {
  let lastErr;
  for (let a = 0; a < tries; a++) {
    // Background requests wait out an active throttle; the live poll doesn't —
    // it's the one request that must always go through.
    if (!priority) { const wait = throttledUntil - Date.now(); if (wait > 0) await sleep(Math.min(wait, 8000)); }
    const ctl = new AbortController();
    const to = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, timeout);
    try {
      const res = await fetch(url, { headers, signal: ctl.signal });
      if (isThrottle(res.status)) throttledUntil = Date.now() + netBackoff(a);  // signal everyone to back off
      return res;  // HTTP errors (incl. throttle) come back as-is; callers read .status
    } catch (e) {
      lastErr = e; if (a < tries - 1) await sleep(netBackoff(a));  // network error / timeout → retry
    } finally { clearTimeout(to); }
  }
  throw lastErr;
}

async function fetchText(url, referer, opts = {}) {
  const headers = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', 'cache-control': 'no-cache' };
  if (referer) headers.referer = referer;
  const res = await fetchCore(url, { headers, timeout: opts.timeout, tries: opts.tries, priority: opts.priority });
  const body = await res.text();
  return { ok: res.ok, status: res.status, contentType: res.headers.get('content-type') || '', body };
}

async function fetchLiveUpdate(e, h, referer) {
  // h is base64 (may contain / + =), so it must be percent-encoded for the query.
  const url = ORIGIN + '/action/sports/liveupdate?e=' + encodeURIComponent(e) + (h ? '&h=' + encodeURIComponent(h) : '');
  const headers = { 'user-agent': UA, 'accept': 'application/json, text/javascript, */*; q=0.01',
    'x-requested-with': 'XMLHttpRequest', 'cache-control': 'no-cache' };
  if (referer) headers.referer = referer;
  // The live poll is latency-critical and one request: short timeout, and priority
  // so it never waits behind a throttle backoff or the scrape limiter.
  const res = await fetchCore(url, { headers, timeout: 8000, priority: true });
  const text = await res.text();
  let json = null, parseError = null;
  try { json = JSON.parse(text); } catch (err) { parseError = err.message; }
  return { url, ok: res.ok, status: res.status, contentType: res.headers.get('content-type') || '', length: text.length, json, parseError, head: text.slice(0, 200) };
}

// Join an active batter/pitcher name to its per-player game line from
// team[].player[] (jersey, position, and this-game stat line) so the live
// panel can show stats GameTracker-style, not just a name.
function activePlayerLine(json, name, kind) {
  if (!name) return null;
  const nm = String(name).trim();
  const players = [].concat(...((json.team || []).map(t => t.player || [])));
  const p = players.find(pl => pl && [pl.name, pl.shortname, pl.revname]
    .some(n => n && String(n).trim() === nm));
  const info = { name: deshout(nm), uni: p && p.uni ? String(p.uni) : null,
    pos: p && p.pos ? String(p.pos).toUpperCase() : null, line: null, pitches: null };
  if (!p) return info;
  const n = x => Number(x) || 0;
  if (kind === 'pitcher') {
    const g = (p.pitching && p.pitching[0]) || {};
    const parts = [];
    if (g.ip != null) parts.push(g.ip + ' IP');
    if (g.er != null) parts.push(n(g.er) + ' ER');
    if (g.so != null) parts.push(n(g.so) + ' K');
    if (g.bb != null) parts.push(n(g.bb) + ' BB');
    info.line = parts.join(', ') || null;
    info.outs = g.ip != null ? ipToOuts(String(g.ip)) : null; // outs recorded this game (0 == just entered)
    info.pitches = g.pitches != null ? n(g.pitches) : null;
    // The feed gives total pitches and strikes; balls is the remainder.
    info.strikes = (info.pitches != null && g.strikes != null) ? n(g.strikes) : null;
    info.balls = (info.pitches != null && info.strikes != null) ? Math.max(0, info.pitches - info.strikes) : null;
  } else {
    const h = p.hitting || {};
    // Keep the H-AB hitting line, then append the extras a batter actually has
    // (extra-base hits first, then RBI/K) — anything at zero is dropped.
    if (h.ab != null) {
      let s = n(h.h) + ' - ' + n(h.ab);
      if (n(h.double) > 0) s += ', ' + n(h.double) + ' 2B';
      if (n(h.triple) > 0) s += ', ' + n(h.triple) + ' 3B';
      if (n(h.hr) > 0) s += ', ' + n(h.hr) + ' HR';
      if (n(h.rbi) > 0) s += ', ' + n(h.rbi) + ' RBI';
      if (n(h.so) > 0) s += ', ' + n(h.so) + ' K';
      info.line = s;
    }
  }
  return info;
}

// Boil the feed's status block down to the live game situation. Every element
// in this feed can arrive as a 1-element array (the same convention val() peels
// off the scalar fields), so unwrap an array-wrapped <status> too.
function summarizeLive(json) {
  const s = json && (Array.isArray(json.status) ? json.status[0] : json.status);
  if (!s) return null;
  const battingHome = val(s.vh) === 'H';
  return {
    complete: val(s.complete) === 'Y',
    inning: val(s.inning),
    schedInn: parseInt(val(json.venue && json.venue.schedinn) || 9, 10) || 9,
    half: battingHome ? 'Bottom' : 'Top',
    battingTeam: String(val(s.batting) || '').trim(),
    outs: Number(val(s.outs)) || 0,
    balls: Number(val(s.b)) || 0,
    strikes: Number(val(s.s)) || 0,
    count: (val(s.b) || '0') + '-' + (val(s.s) || '0'),
    abPitches: Number(val(s.np)) || 0, // pitches in the current at-bat (updates per pitch; resets each batter)
    batter: has(s.batter) ? val(s.batter) : null,
    pitcher: has(s.pitcher) ? val(s.pitcher) : null,
    batterInfo: has(s.batter) ? activePlayerLine(json, val(s.batter), 'batter') : null,
    pitcherInfo: has(s.pitcher) ? activePlayerLine(json, val(s.pitcher), 'pitcher') : null,
    bases: { first: has(s.first), second: has(s.second), third: has(s.third) },
    runners: { first: val(s.first) || null, second: val(s.second) || null, third: val(s.third) || null },
  };
}

// Flatten the feed's play-by-play into a chronological list of narrated plays
// (skips runner-only sub-rows with no narrative). Each: inning, half, team,
// outs (the out count at the START of the play), outsMade (how many outs the
// play recorded — 1 for a routine out, 2/3 for a double/triple play, 0 for a
// hit/walk), scored flag, and the human-readable text.
function summarizePlays(json) {
  const root = json && json.plays;
  if (!root || !Array.isArray(root.inning)) return [];
  // Gather every half in order first, so we can tell whether a half is "closed"
  // (a later half exists -> the inning is over, so its last out brought the
  // count to 3). outsMade is derived from the out count, not the narrative:
  // each play row carries the out count at its start, and the feed advances that
  // count on the following row, so (next row's outs - this row's outs) is the
  // number of outs this play made — which also handles double/triple plays.
  const halves = [];
  for (const inn of root.inning) {
    const num = +val(inn.number) || 0;
    for (const half of (inn.batting || [])) halves.push({ num, half });
  }
  // Live situation from the status block, so the newest play in the current
  // (still-open) half can be labeled the instant it's entered — before any
  // following row exists to advance the out count. The status carries the count
  // that already reflects that play.
  const st = json && (Array.isArray(json.status) ? json.status[0] : json.status);
  const live = st ? { inning: +val(st.inning) || 0, side: val(st.vh) === 'H' ? 'bot' : 'top',
    outs: Number(val(st.outs)) || 0, complete: val(st.complete) === 'Y' } : null;
  const out = [];
  halves.forEach(({ num, half }, hi) => {
    const side = half.vh === 'H' ? 'bot' : 'top';
    const team = String(half.id || '').trim();
    const rows = half.play || [];
    const closed = hi < halves.length - 1;
    const startOuts = r => Number(val(r.outs)) || 0;
    // Out count after the last play of THIS half when no following row exists:
    // 3 for a closed half (inning over), the live count for the current half
    // (the newest play, labeled at once), else unknown -> no out inferred.
    let lastAfter = null;
    if (closed) lastAfter = 3;
    else if (live && live.complete) lastAfter = 3;
    else if (live && live.inning === num && live.side === side) lastAfter = live.outs;
    // The feed flips the status block to the next half the instant the 3rd out
    // lands — a beat before it appends that half to the play-by-play. During that
    // beat this (just-finished) half is still the last in the array (not "closed"),
    // yet the live situation already sits ahead of it, so it's over: its last out
    // brought the count to 3. Without this the final out would score 0 outs-made.
    else if (live && (live.inning * 2 + (live.side === 'bot' ? 1 : 0)) >
                      (num * 2 + (side === 'bot' ? 1 : 0))) lastAfter = 3;
    for (let i = 0; i < rows.length; i++) {
      const p = rows[i];
      const text = (p.narrative && val(p.narrative.text)) ? String(val(p.narrative.text)).trim() : '';
      if (!text) continue;
      const before = startOuts(p);
      const after = (i + 1 < rows.length) ? startOuts(rows[i + 1]) : (lastAfter == null ? before : lastAfter);
      const outsMade = Math.max(0, Math.min(3 - before, after - before));
      out.push({ inning: num, half: side, team, outs: before, outsMade,
        // isPa marks a plate-appearance result (vs a baserunning/scoring row like
        // a passed ball, wild pitch, steal, or balk). The live "Last play" bubble
        // uses it to keep surfacing a mid-at-bat run even with the batter still up.
        isPa: isPaLine(text),
        scored: /\bscored\b|homer|grand slam/i.test(text), text });
    }
  });
  return out;
}

// The current batter's completed plate appearances earlier in THIS game, read
// from the play-by-play. Each play's narrative leads with the batter's name
// ("Bankston Lembcke lined out to cf ..."), so a play belongs to this batter
// when its text starts with their name AND the remainder opens with a plate-
// appearance verb (BS_PA_RE) — which skips baserunning sub-rows ("stole second",
// "advanced to third", "out at second" after reaching base). Powers the "what
// they've done today" line on the live
// at-bat card. Returns [{ inn: '2nd', res: 'Struck out' }, ...] in order.
function batterPriorPAs(plays, batterName) {
  const nm = String(batterName || '').trim();
  if (!nm || !Array.isArray(plays)) return [];
  const out = [];
  for (const p of plays) {
    const t = String(p.text || '').trim();
    if (t.slice(0, nm.length) !== nm) continue;
    const rest = t.slice(nm.length).trim();
    if (!BS_PA_RE.test(rest)) continue;
    out.push({ inn: bsOrd(p.inning), res: cap(bsNormRes(rest)) });
  }
  return out;
}

function teamLineScores(json) {
  return (json && json.team || []).map(t => ({
    vh: t.vh, name: t.name, teamId: t.teamId, isGators: t.teamId === GATORS_ID,
    runs: t.linescore && t.linescore.runs, hits: t.linescore && t.linescore.hits, errs: t.linescore && t.linescore.errs,
    innings: ((t.linescore && t.linescore.lineinn) || []).map(x => {
      const v = val(x.score); const n = parseInt(v, 10); return isNaN(n) ? (v === '' ? null : v) : n;
    }),
  }));
}

// Event id + hash don't change during a game, so cache them per boxscore id —
// the tight live poll then only needs the lightweight liveupdate JSON.
const liveAuthCache = {};
// Full chain: boxscore page -> event id + hash -> live feed -> summary.
async function fetchLiveForGame(boxscoreId, wantRaw) {
  const boxUrl = boxscoreUrl(boxscoreId);
  const out = { boxscoreId, boxUrl };
  let auth = liveAuthCache[boxscoreId];
  if (auth) { out.auth = { e: auth.e, h: auth.h, how: 'cached' }; }
  else {
    const page = await fetchText(boxUrl, SCHEDULE_URL);
    out.boxPage = { ok: page.ok, status: page.status, length: page.body.length };
    auth = extractEventAuth(page.body);
    out.auth = { e: auth.e, h: auth.h, how: auth.how };
    if (auth.e) liveAuthCache[boxscoreId] = { e: auth.e, h: auth.h || null };
    if (!auth.e) {
      out.snippet = snippetAround(page.body, 'liveupdate') || snippetAround(page.body, 'eventId') || snippetAround(page.body, 'gamecenter');
      return out;
    }
  }
  const feed = await fetchLiveUpdate(auth.e, auth.h, boxUrl);
  out.feed = { url: feed.url, ok: feed.ok, status: feed.status, contentType: feed.contentType, length: feed.length, parseError: feed.parseError, head: feed.json ? undefined : feed.head };
  if (feed.json) {
    out.live = summarizeLive(feed.json); out.teams = teamLineScores(feed.json); out.plays = summarizePlays(feed.json); out.lineups = lineupsFromFeed(feed.json); out.pitchers = pitchersFromFeed(feed.json); out.feedSource = feed.json.source;
    // Rewrite any placeholder pitcher name (e.g. Presto's "Emergency Player") to
    // the real player before the enrichment passes below key off it.
    applyPitcherOverrides(boxscoreId, out.live, out.pitchers);
    // Show the batter's earlier at-bats this game on the live at-bat card; on his
    // FIRST plate appearance (no prior PAs) there's no game line yet, so swap in
    // his school/class + season AVG/RBI/(HR|SB|H) instead.
    if (out.live && out.live.batterInfo && out.live.batter) {
      out.live.batterInfo.prev = batterPriorPAs(out.plays, out.live.batter);
      if (!out.live.batterInfo.prev.length) {
        // The batting team (Top = visitor, Bottom = home) lets firstAbStats read
        // that team's own player-page stats, so an opponent bat the league
        // leaderboard omits still shows a season line here.
        const battingVH = out.live.half === 'Bottom' ? 'H' : 'V';
        const bt = (out.lineups || []).find(t => t && t.vh === battingVH);
        // Eager fill: if this is an opponent bat we don't have cached yet, fetch his
        // player page NOW so the card shows a season line on THIS frame instead of
        // next poll. Bounded to one page, bypasses the scrape limiter, and capped
        // so a slow page never stalls the live frame — it keeps loading in the
        // background and the next poll picks it up.
        if (bt && bt.teamId && bt.teamId !== GATORS_ID) {
          const bkey = normPlayerName(out.live.batter);
          let byName = teamRosterSlugs[bt.teamId] && teamRosterSlugs[bt.teamId].byName;
          if (!byName) { try { byName = await ensureTeamRoster(bt.teamId); } catch (e) {} }
          const bslug = byName && byName[bkey];
          if (bslug && (!rosterStats[bslug] || !recFresh(playerCache[bslug]))) {
            await Promise.race([fetchOpponentAvg(bslug), sleep(2500)]);
          }
        }
        Object.assign(out.live.batterInfo, firstAbStats(out.live.batter, bt && bt.teamId));
        const pinch = pinchFor(out.plays, out.live.batter);
        if (pinch) out.live.batterInfo.pinch = pinch;
      }
    }
    // When a new pitcher has just entered, swap his card to a "New pitcher" badge
    // with his school/class + summer line (ERA/IP/K), like the batter's 1st-AB card.
    if (out.live && out.live.pitcherInfo && out.live.pitcher) {
      const np = newPitcherInfo(out.live.pitcherInfo, out.plays, out.live.pitcher, out.pitchers);
      if (np) Object.assign(out.live.pitcherInfo, np);
    }
    // Make the current pitcher's pitch count climb pitch-by-pitch (the feed's
    // cumulative only updates at each at-bat's end).
    if (out.live && out.pitchers) applyLivePitchCount(boxscoreId, out.live, out.pitchers);
    // Per-team pitching totals row (after the live pitch-count adjustment above).
    if (out.pitchers) out.pitchers.forEach(t => { t.totals = pitchingTotals(t.rows); });
    // Opponent names SHOUT in the play narratives too ("HUNTER HAM flied out
    // ..."). Title-case just the known player names for display — done last, so
    // every parser above that keys off the raw narrative text saw it verbatim.
    if (out.plays && out.plays.length) {
      const shout = shoutingNames(feed.json);
      if (shout.length) out.plays.forEach(p => { p.text = deshoutPlayText(p.text, shout); });
    }
    // Fill in each lineup substitute's legend ("a- pinch-hit for X in the 7th")
    // from the (now de-SHOUTED) play narratives, so the live lineup carries the
    // same alphabet substitution ledger as the box score.
    if (out.lineups && out.plays) attachLineupSubLegend(out.lineups, out.plays);
    // Pull the opponent lineup's season AVGs from their own player pages (via
    // their team page) so non-leaderboard bats still show an average. Fire-and-
    // forget: the values land in rosterStats and the next poll's lineup shows them.
    if (out.lineups) {
      const opp = out.lineups.find(t => t && !t.isGators && t.teamId && t.teamId !== GATORS_ID);
      if (opp && opp.rows) loadOpponentLineupAvgs(opp.teamId, opp.rows.map(r => r.full || r.name));
      // And, once per game, warm the opponent's WHOLE hitting roster — not just the
      // nine in the lineup — so a pinch hitter or due-up bat is already cached when
      // he steps in, instead of the eager per-batter fetch above having to block.
      if (opp && opp.teamId) warmOpponentRoster(boxscoreId, opp.teamId);
    }
    // Diagnostics only: when the situation block can't be parsed (live === null)
    // we can't tell from afar where the feed moved it. Surface the feed's
    // top-level keys, and the full payload on request, so /debug/live shows the
    // real shape without hauling it through the normal live-poll path.
    out.feedKeys = Object.keys(feed.json);
    if (wantRaw) out.raw = feed.json;
  }
  return out;
}

// Build each team's current batting-order lineup card: spot, position,
// jersey, name, bats hand, and today's hits/at-bats. The order comes from
// batords (live, reflects substitutions); per-game hitting is joined from
// the player[] records by jersey, then name.
function lineupsFromFeed(json) {
  const teams = (json && json.team) || [];
  return teams.map(t => {
    const players = t.player || [];
    const byUni = {}, byName = {};
    players.forEach(p => {
      if (p.uni != null) byUni[String(p.uni)] = p;
      if (p.name) byName[String(p.name).trim()] = p;
    });
    const order = (t.batords && t.batords.batord) || (t.starters && t.starters.starter) || [];
    // Mark substitute batters so the lineup can indent them under the player
    // they replaced, like the box score: a batter is a sub if his lineup spot
    // already appeared above him (the starter or an earlier sub holds it) or
    // he's flagged PH/PR. Each sub also gets the box score's alphabet reference
    // letter (a-, b-, …) and a legend seed keyed to it — the player he replaced
    // is the one listed directly above him — so the live lineup shows the same
    // MLB-style substitution ledger the box does. attachLineupSubLegend later
    // fills in the play result + inning ("a- pinch-hit for X in the 7th").
    const seenSpot = new Set();
    const legendSeed = [];
    let subN = 0, prevFull = '';
    // The batting-order entry's name (o.name) is unreliable — some feeds send it
    // garbled ("B. ton Lembcke") or as a bare initial ("G."). The player record's
    // revname ("Lembcke, Bankston") is canonical (it's what the box-score notes
    // use), so prefer it, rebuilt as "First Last"; fall back to p.name, then o.name.
    const dispName = (p, fallback) => {
      if (p && p.revname && String(p.revname).indexOf(',') !== -1) {
        const c = String(p.revname).split(',');
        const last = (c[0] || '').trim(), first = (c[1] || '').trim();
        if (last) return (first ? first + ' ' : '') + last;
      }
      if (p && p.name && String(p.name).trim()) return String(p.name).trim();
      return String(fallback || '').trim();
    };
    // Abbreviate to ESPN-style "F. Last" on the SERVER so the display name arrives
    // already formatted — the browser just prints it, which keeps a stale/cached
    // page from showing the wrong thing. Handles "Last, First" and a trailing
    // generational suffix; a single-token name is returned as-is.
    const abbrev = nm => {
      let s = String(nm || '').trim(); if (!s) return '';
      if (s.indexOf(',') > -1) { const c = s.split(','); const l = (c[0] || '').trim(), f = (c[1] || '').trim(); s = (f ? f + ' ' : '') + l; }
      const p = s.split(/\s+/); if (p.length < 2) return s;
      let last = p[p.length - 1];
      if (/^(jr|sr|ii|iii|iv|v)\.?$/i.test(last) && p.length > 2) last = p[p.length - 2];
      return p[0].charAt(0).toUpperCase() + '. ' + last;
    };
    const rows = order.map(o => {
      const p = byUni[String(o.uni)] || byName[String(o.name || '').trim()] || {};
      const h = p.hitting || {};
      const n0 = v => Number(v) || 0;
      // Field names vary across feed versions; pick the first present spelling.
      const pick = ks => { for (const k of ks) if (h[k] != null && h[k] !== '') return h[k]; return 0; };
      const ab = h.ab != null && h.ab !== '' ? Number(h.ab) || 0 : null;
      const hits = h.h != null ? Number(h.h) || 0 : null;
      const spot = o.spot != null ? Number(o.spot) : null;
      const pos = String(o.pos || p.pos || '').toUpperCase();
      const firstPos = pos.split(/[-/ ]/)[0];
      let sub = firstPos === 'PH' || firstPos === 'PR';
      if (spot != null) { if (seenSpot.has(spot)) sub = true; else seenSpot.add(spot); }
      const full = dispName(p, o.name);
      // Alphabet reference letter for a substitute, seeded with a "for <player
      // above>" fallback that attachLineupSubLegend enriches from the play-by-play.
      let letter = '';
      if (sub) {
        letter = subN < 26 ? String.fromCharCode(97 + subN) : '+'; subN++;
        const fp = firstPos.toLowerCase();
        const verb = fp === 'ph' ? 'pinch-hit for' : fp === 'pr' ? 'pinch-ran for' : 'in for';
        legendSeed.push({ letter, name: full, pos: fp, forName: prevFull, text: prevFull ? verb + ' ' + prevFull : verb });
      }
      prevFull = full;   // a later sub in this slot replaced this batter
      return {
        spot,
        pos,
        letter,
        uni: o.uni != null ? String(o.uni) : (p.uni != null ? String(p.uni) : ''),
        // name = display ("F. Last", server-formatted); full = full name kept for
        // profile-link matching and current-batter highlighting on the client.
        name: deshout(abbrev(full)),
        full,
        bats: String(p.bats || '').toUpperCase(),
        seasonAvg: seasonAvgFor(full, t.teamId),   // season-to-date AVG for the lineup
        today: ab == null ? '—' : (hits + ' for ' + ab),
        // ESPN-style box line (game). null for a batter who hasn't come up yet.
        ab,
        runs: ab == null ? null : n0(pick(['r', 'runs'])),
        hits: ab == null ? null : n0(h.h),
        rbi: ab == null ? null : n0(pick(['rbi', 'rbis'])),
        bb: ab == null ? null : n0(pick(['bb', 'walks'])),
        k: ab == null ? null : n0(pick(['so', 'k', 'k_'])),
        sub,
      };
    });
    // Every TCL game uses a DH, so the pitcher never bats — leave them out.
    const battingRows = rows.filter(r => r.pos !== 'P');
    // Box-score note lines (2B/3B/HR/SB/CS/E): scan every player on the team
    // so defensive subs and pinch runners are counted, not just starters.
    const lastName = p => deshout(p.revname ? String(p.revname).split(',')[0].trim()
      : String(p.name || '').trim().split(/\s+/).slice(-1)[0] || '');
    const notes = { '2B': [], '3B': [], 'HR': [], 'SB': [], 'CS': [], 'E': [] };
    players.forEach(p => {
      const h = p.hitting || {}, fl = p.fielding || {};
      const add = (k, v) => { const n = Number(v) || 0; if (n > 0) notes[k].push({ name: lastName(p), n }); };
      add('2B', h.double); add('3B', h.triple); add('HR', h.hr); add('SB', h.sb); add('CS', h.cs); add('E', fl.e);
    });
    // Team batting totals (sum of every batter who came up, starters + subs).
    const sum = k => battingRows.reduce((a, r) => a + (r[k] || 0), 0);
    const totals = { ab: sum('ab'), runs: sum('runs'), hits: sum('hits'), rbi: sum('rbi'), bb: sum('bb'), k: sum('k') };
    return { vh: t.vh, name: t.name, teamId: t.teamId, isGators: t.teamId === GATORS_ID, rows: battingRows, totals, notes, subLegend: legendSeed };
  }).filter(t => t.rows.length);
}
// Enrich each live lineup's substitute legend with "<result> for <player> in the
// <inning>th", read from the play narratives — the same MLB-style reference the
// parsed box score shows (see bsAttachSubLegend), so the live lineup tells you
// WHEN a pinch hitter/runner or defensive sub entered, not just that he did.
// Works from the already-summarized plays (plain text) instead of box HTML.
function attachLineupSubLegend(lineups, plays) {
  if (!Array.isArray(lineups) || !Array.isArray(plays)) return lineups;
  const POS = /^(?:1b|2b|3b|ss|lf|cf|rf|c|dh|of|ph|pr)$/i;
  const ann = {};       // sub (normalized name) -> { repl, type, inn }
  const paRows = [];     // every plate-appearance narrative, in order, for findPA
  for (const p of plays) {
    const tx = String(p.text || '').trim(); if (!tx) continue;
    const inn = Number(p.inning) || 0;
    paRows.push({ inn, tx });
    let m = tx.match(/^(.+?) pinch hit for (.+?)\.?$/i); if (m) { ann[normPlayerName(m[1])] = { repl: m[2].trim(), type: 'ph', inn }; continue; }
    m = tx.match(/^(.+?) pinch ran for (.+?)\.?$/i); if (m) { ann[normPlayerName(m[1])] = { repl: m[2].trim(), type: 'pr', inn }; continue; }
    m = tx.match(/^(.+?) to ([a-z0-9]+) for (.+?)\.?$/i);
    if (m && POS.test(m[2]) && /^[A-Z]/.test(m[3].trim())) ann[normPlayerName(m[1])] = { repl: m[3].trim(), type: 'def', inn };
  }
  // The sub's first plate appearance at or after he entered — its result becomes
  // the legend verb ("singled for X in the 7th"), matching the box.
  const findPA = (full, minInn) => {
    for (const p of paRows) {
      if (p.inn < minInn || p.tx.indexOf(full + ' ') !== 0) continue;
      const rest = p.tx.slice(full.length).trim();
      if (BS_PA_RE.test(rest)) return { inn: p.inn, res: bsNormRes(rest) };
    }
    return null;
  };
  for (const t of lineups) {
    if (!t.subLegend || !t.subLegend.length) continue;
    for (const it of t.subLegend) {
      const a = ann[normPlayerName(it.name)]; if (!a) continue;   // no announcement -> keep seeded "for <player>"
      if (a.type === 'pr') { it.text = 'ran for ' + a.repl + ' in the ' + bsOrd(a.inn); continue; }
      const pa = findPA(it.name, a.inn);
      it.text = pa ? pa.res + ' for ' + a.repl + ' in the ' + bsOrd(pa.inn)
                   : (a.type === 'ph' ? 'pinch-hit for ' : 'in for ') + a.repl + ' in the ' + bsOrd(a.inn);
    }
  }
  return lineups;
}

// Per-team pitching line for the live box: each pitcher who has taken the mound,
// with IP/H/R/ER/BB/K and pitch count. The pitching record is read defensively
// (it arrives as a 1-element array elsewhere) and field names are matched across
// the spellings the feed has used, so a renamed key shows the stat, not a 0.
function pitchersFromFeed(json) {
  const teams = (json && json.team) || [];
  const num = x => Number(x) || 0;
  const pickv = (o, ks) => { for (const k of ks) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
  // The current pitcher (from the status block) is shown the instant he's
  // announced, even before throwing a pitch, so a pitching change appears
  // in the box right away.
  const s = json && (Array.isArray(json.status) ? json.status[0] : json.status);
  const curPitcher = s ? String(val(s.pitcher) || '').trim() : '';
  return teams.map(t => {
    const rows = [];
    for (const p of (t.player || [])) {
      const pgRaw = (p.pitching && (Array.isArray(p.pitching) ? p.pitching[0] : p.pitching)) || null;
      const isCurrent = curPitcher && [p.name, p.shortname, p.revname].some(n => n && String(n).trim() === curPitcher);
      if (!pgRaw && !isCurrent) continue;
      const pg = pgRaw || {};
      const ip = pickv(pg, ['ip']);
      const pitches = pickv(pg, ['pitches', 'np', 'pitchcount', 'pc']);
      // List pitchers who have appeared (recorded outs, thrown a pitch, or faced
      // a batter), plus the just-entered current pitcher — not every rostered arm.
      const appeared = isCurrent || (ip != null && parseFloat(ip) > 0) || num(pitches) > 0 || num(pickv(pg, ['bf', 'batters'])) > 0;
      if (!appeared) continue;
      const np = pitches != null ? num(pitches) : null;
      // Strike%: prefer a strikes count from the feed; else derive it from balls
      // (strikes = pitches - balls). Null when neither is available.
      let strikes = pickv(pg, ['strikes', 'st', 'stk', 'strike']);
      if (strikes == null) { const balls = pickv(pg, ['balls', 'ball', 'bl']); if (balls != null && np != null) strikes = np - num(balls); }
      const sp = (np && strikes != null) ? Math.round(num(strikes) / np * 100) : null;
      rows.push({
        name: deshout(String(p.name || p.shortname || '').trim()),
        uni: p.uni != null ? String(p.uni) : '',
        ip: ip != null ? String(ip) : '0.0',
        h: num(pickv(pg, ['h', 'hits'])),
        r: num(pickv(pg, ['r', 'runs'])),
        er: num(pickv(pg, ['er', 'earned'])),
        bb: num(pickv(pg, ['bb', 'walks'])),
        k: num(pickv(pg, ['so', 'k', 'strikeouts'])),
        hbp: num(pickv(pg, ['hbp', 'hb', 'hp'])),
        np: np,
        sp: sp,
        dec: String(pickv(pg, ['dec', 'decision', 'wls']) || '').trim(),
      });
    }
    return { vh: t.vh, name: t.name, teamId: t.teamId, isGators: t.teamId === GATORS_ID, rows };
  }).filter(t => t.rows.length);
}

// The feed only bumps a pitcher's cumulative `pitches` at each at-bat's end, so
// the box lagged a full at-bat behind. status.np (live.abPitches) counts the
// current at-bat's pitches and updates per pitch, so the live total for the
// CURRENT pitcher = cumulative + current-at-bat pitches. Boundary guard: at an
// at-bat's end the cumulative absorbs the finished at-bat one tick before
// status.np resets to 0, which would briefly double-count — so when the
// cumulative jumps for the same pitcher, drop the in-flight at-bat for that tick.
// Recomputed from authoritative cumulative each poll, so any blip self-heals.
const livePitchMem = {}; // gameId -> { name, cum }
function applyLivePitchCount(gameId, live, pitchers) {
  if (!live || !live.pitcher) return;
  // Match against the deshouted display name — pitcher rows store it title-cased.
  const name = deshout(String(live.pitcher).trim());
  let row = null;
  for (const t of (pitchers || [])) { const r = (t.rows || []).find(x => x.name === name); if (r) { row = r; break; } }
  const cum = row && row.np != null ? row.np : 0;
  const mem = livePitchMem[gameId];
  const boundary = !!(mem && mem.name === name && cum > mem.cum);
  livePitchMem[gameId] = { name, cum };
  const abNp = boundary ? 0 : (live.abPitches || 0);
  if (abNp <= 0) return;
  const abBalls = Math.min(live.balls || 0, abNp);
  const abStrikes = abNp - abBalls;
  if (row) row.np = cum + abNp;
  const pi = live.pitcherInfo;
  if (pi && deshout(String(pi.name || '').trim()) === name && pi.pitches != null) {
    pi.pitches = pi.pitches + abNp;
    if (pi.strikes != null) { pi.strikes = pi.strikes + abStrikes; pi.balls = pi.pitches - pi.strikes; }
  }
}

// Swap placeholder pitcher names (see MANUAL_PITCHER_OVERRIDES) across the live
// situation and the pitching box, so the real pitcher shows on the "Pitching"
// card, the box-score row, and pitch-count matching. Runs before the new-pitcher
// and pitch-count passes so those key off the real name. Names are compared
// deshouted + lowercased, since the feed SHOUTs opponent names.
function applyPitcherOverrides(gameId, live, pitchers, overrides = MANUAL_PITCHER_OVERRIDES) {
  for (const ov of (overrides || [])) {
    if (!ov || !ov.from || !ov.name) continue;
    if (ov.gameId && ov.gameId !== gameId) continue;
    const from = deshout(String(ov.from).trim()).toLowerCase();
    const matches = n => n != null && deshout(String(n).trim()).toLowerCase() === from;
    if (live && matches(live.pitcher)) live.pitcher = ov.name;
    if (live && live.pitcherInfo && matches(live.pitcherInfo.name)) {
      live.pitcherInfo.name = ov.name;
      if (ov.uni) live.pitcherInfo.uni = ov.uni;
    }
    for (const t of (pitchers || [])) {
      for (const r of (t.rows || [])) {
        if (matches(r.name)) { r.name = ov.name; if (ov.uni) r.uni = ov.uni; }
      }
    }
  }
}

// Team pitching totals for the box's "Totals" row. IP sums by outs (the .1/.2
// are thirds of an inning, not decimals); H/R/ER/BB/K/P sum straight; S% is
// recomputed from each line's strikes (derived from its own S% and pitch count).
function pitchingTotals(rows) {
  const num = x => Number(x) || 0;
  let outs = 0, h = 0, r = 0, er = 0, bb = 0, k = 0, hbp = 0, np = 0, strikes = 0, hasNp = false;
  for (const x of (rows || [])) {
    const m = String(x.ip == null ? '' : x.ip).match(/^(\d+)(?:\.(\d))?$/);
    if (m) outs += num(m[1]) * 3 + num(m[2]);
    h += num(x.h); r += num(x.r); er += num(x.er); bb += num(x.bb); k += num(x.k); hbp += num(x.hbp);
    if (x.np != null) { hasNp = true; np += num(x.np); if (x.sp != null) strikes += Math.round(num(x.sp) / 100 * num(x.np)); }
  }
  return { ip: Math.floor(outs / 3) + '.' + (outs % 3), h, r, er, bb, k, hbp,
    np: hasNp ? np : null, sp: (hasNp && np) ? Math.round(strikes / np * 100) : null };
}

function inningParts(status) {
  const half = /top|mid/i.test(status) ? 'top' : 'bottom';
  const m = (status||'').match(/\d+/);
  return { inning: m ? +m[0] : 0, half };
}
function normalizeFeatured(g) {
  const status = g.state === 'live' ? 'live' : g.state === 'final' ? 'final' : g.state === 'cancelled' ? 'cancelled' : 'pregame';
  const ip = inningParts(g.status);
  return {
    id: g.id, date: g.date, status, statusText: g.status, dateLabel: g.dateLabel,
    inning: ip.inning, half: ip.half,
    inningLabel: status === 'live' ? g.status : status === 'final' ? (g.status || 'Final') : status === 'cancelled' ? 'Cancelled' : g.status,
    gatorsHome: g.gatorsHome, opponent: g.opponent,
    location: gameLocation(g), watchUrl: watchUrlFor(g), replayUrl: replayUrlFor(g), ticketUrl: ticketIndex[g.id] || null, theme: THEMES[g.date] || null, freeAdmission: FREE_ADMISSION[g.date] || null, promo: promoFor(g), special: SPECIALS[g.date] || null,
    away: { name: g.away.name, short: g.away.short, logo: g.away.logo, runs: g.away.score || 0, record: recordStr(g.away), site: TEAM_SITE[g.away.id] || null },
    home: { name: g.home.name, short: g.home.short, logo: g.home.logo, runs: g.home.score || 0, record: recordStr(g.home), site: TEAM_SITE[g.home.id] || null },
  };
}

// ----- state ----------------------------------------------------------------
let games = [], featured = null, prevFeatured = null;
// Last Gators game we saw pitching for via the live feed. Kept so the rest chart
// survives the live→final→scraped-box handoff even after `featured` rotates to the
// next game and before Presto's (bot-gated) final box XML can be scraped.
let lastGatorsFeedGame = null;
let lastHtml = '', lastFetchAt = 0;
const sseClients = new Set(), subscribers = new Set(), startedAnnounced = new Set();

// How long a finished game stays featured: 10 hours past the game's end.
const FINAL_WINDOW_MS = 10 * 60 * 60 * 1000;
// When we first observe a game as final ≈ when it ended; stamped per game id.
const finalSeenAt = {};
function noteFinals(list, nowMs) {
  nowMs = nowMs != null ? nowMs : Date.now();
  for (const g of list) if (g.state === 'final' && finalSeenAt[g.id] == null) finalSeenAt[g.id] = nowMs;
}
// Fallback end time when we never saw the game finalize (e.g. after a restart):
// ~10pm Central on the game date. Summer league, so always CDT (UTC-5);
// 10pm CDT = 03:00 UTC the next day.
function assumedEndMs(ymd) {
  return Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), 22 + 5, 0, 0);
}
function finalAnchorMs(g) {
  // Anchor to the earlier of the observed-final time and the assumed ~10pm end.
  // On a cold restart noteFinals() stamps every already-final game with "now";
  // the min discards that bogus late stamp so an old final doesn't get a fresh
  // 10-hour window just because the server happened to restart.
  const assumed = assumedEndMs(g.date);
  return finalSeenAt[g.id] != null ? Math.min(finalSeenAt[g.id], assumed) : assumed;
}
// A finished game stays featured for 10 hours after it ended.
function finalIsFresh(g, nowMs) {
  return nowMs - finalAnchorMs(g) < FINAL_WINDOW_MS;
}

// ---- instant post-game report trigger --------------------------------------
// When a Gators game first goes final, ping GitHub's repository_dispatch so the
// Actions workflow rebuilds the seed, renders the branded one-page PDF, and
// emails it to the recipients — within a couple minutes of the last out. The PDF
// can't be rendered here (no Chromium on the host), so GitHub does it. Personal
// delivery only; nothing is served on the website. Configure on the server with
// GH_DISPATCH_TOKEN (a GitHub token with repo "contents: write"); without it the
// trigger is simply off.
const GH_DISPATCH_TOKEN = process.env.GH_DISPATCH_TOKEN || '';
const GH_DISPATCH_REPO  = process.env.GH_DISPATCH_REPO  || 'LeBrennon/Gators';
const DISPATCH_SENT_FILE = (process.env.CACHE_DIR || '.') + '/report-dispatched.json';
const reportDispatched = new Set();
let reportDispatchSeeded = false;
(function loadReportDispatched() {
  try { const a = JSON.parse(fs.readFileSync(DISPATCH_SENT_FILE, 'utf8')); if (Array.isArray(a)) a.forEach(id => reportDispatched.add(id)); } catch (e) {}
  reportDispatchSeeded = reportDispatched.size > 0;
})();
function saveReportDispatched() { try { fs.writeFileSync(DISPATCH_SENT_FILE, JSON.stringify([...reportDispatched])); } catch (e) {} }
function isGatorsGame(g) {
  return !!(g && (g.isGators || (g.home && g.home.id === GATORS_ID) || (g.away && g.away.id === GATORS_ID)));
}
async function dispatchFinalReport() {
  const finals = (games || []).filter(g => g.state === 'final' && isGatorsGame(g));
  // First poll after a (re)start: mark every already-final game as handled so a
  // restart never re-fires reports for the back catalogue.
  if (!reportDispatchSeeded) { finals.forEach(g => reportDispatched.add(g.id)); reportDispatchSeeded = true; saveReportDispatched(); return; }
  if (!GH_DISPATCH_TOKEN) return;   // trigger not configured — instant email path is off
  for (const g of finals) {
    if (reportDispatched.has(g.id)) continue;
    try {
      const res = await fetch('https://api.github.com/repos/' + GH_DISPATCH_REPO + '/dispatches', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + GH_DISPATCH_TOKEN, accept: 'application/vnd.github+json',
          'content-type': 'application/json', 'user-agent': 'gators-report' },
        body: JSON.stringify({ event_type: 'gators-final', client_payload: { id: g.id } }),
      });
      if (res.ok || res.status === 204) { reportDispatched.add(g.id); saveReportDispatched(); process.stdout.write('\n[report] triggered build for ' + g.id + '\n'); }
      else process.stdout.write('\n[report] trigger failed ' + res.status + ' for ' + g.id + '\n');
    } catch (e) { logErr('dispatchFinalReport', e); /* retry next poll */ }
  }
}
// Detect a finished game straight from the live feed, before PrestoSports flips
// its "complete" flag or the schedule text says "Final" (both lag): three outs
// in the final scheduled inning (or later) with a team ahead means it's over.
function feedGameOver(L, awayRuns, homeRuns) {
  if (!L) return false;
  if (L.complete) return true;
  const inn = parseInt(L.inning, 10) || 0, reg = L.schedInn || 9;
  if (inn < reg || (L.outs || 0) < 3) return false;
  const a = Number(awayRuns) || 0, h = Number(homeRuns) || 0;
  if (a === h) return false;                  // still tied → extra innings
  return L.half === 'Bottom' ? a > h : h > a; // 3rd out with a leader = final
}
// Choose the featured game: a live game, else the most recent final still
// inside its 10-hour post-game window, else the next scheduled game, else the
// latest final.
function pick(list, nowMs) {
  const live = list.find(g => g.state === 'live'); if (live) return live;
  nowMs = nowMs != null ? nowMs : Date.now();
  const finals = list.filter(g => g.state === 'final');
  const sticky = finals.filter(g => finalIsFresh(g, nowMs)).sort((a, b) => a.sortKey - b.sortKey).pop();
  if (sticky) return sticky;
  const sched = list.filter(g => g.state === 'scheduled'); if (sched.length) return sched[0];
  if (finals.length) return finals[finals.length - 1];
  return list[0] || null;
}
let lastBroadcastGame = null;   // JSON of the last game frame pushed, to suppress no-op re-sends
function broadcastRaw(json) { const line = 'data: ' + json + '\n\n'; sseClients.forEach(r => { try { r.write(line); } catch (e) {} }); }
function broadcast(o) { broadcastRaw(JSON.stringify(o)); }
function notify(title, body, tag) {
  broadcast({ type: 'alert', title, body, tag });
  if (!pushReady) return;
  const payload = JSON.stringify({ title, body, tag });
  subscribers.forEach(s => webpush.sendNotification(s, payload).catch(err => { if (err.statusCode === 404 || err.statusCode === 410) subscribers.delete(s); }));
}
function diffAlert(cur) {
  if (!prevFeatured || prevFeatured.id !== cur.id) return;
  // Game start: fire once when this game flips from pregame to live.
  if (cur.status === 'live' && prevFeatured.status === 'pregame' && !startedAnnounced.has(cur.id)) {
    notify('Game starting \u26BE', 'Gators ' + (cur.gatorsHome ? 'vs ' : 'at ') + cur.opponent.short, 'start');
    startedAnnounced.add(cur.id);
  }
  if (cur.status === 'pregame') return;
  const g = x => x.gatorsHome ? x.home.runs : x.away.runs, o = x => x.gatorsHome ? x.away.runs : x.home.runs;
  const sc = g(cur) + '\u2013' + o(cur), opp = cur.opponent.short;
  if (g(cur) > g(prevFeatured)) notify('Gators score! \uD83D\uDC0A', 'Gators ' + sc + ' ' + opp, 'run');
  if (o(cur) > o(prevFeatured)) notify(opp + ' score', 'Gators ' + sc + ' ' + opp, 'run');
  const lead = x => g(x) === o(x) ? 0 : (g(x) > o(x) ? 1 : -1);
  if (lead(cur) !== lead(prevFeatured) && lead(cur) !== 0)
    notify('Lead change \uD83D\uDCE3', (lead(cur) === 1 ? 'Gators' : opp) + ' lead, ' + sc, 'lead');
  if (cur.status === 'final' && prevFeatured.status !== 'final')
    notify(g(cur) > o(cur) ? 'Gators win! \uD83D\uDC0A' : 'Final', 'Gators ' + sc + ' ' + opp, 'final');
}
// ---- end-of-inning text alert -----------------------------------------------
// Kat (social media) asked for a text at end of 3rd/6th plus the final so she
// doesn't have to pull up the site mid-inning while she's at an away game.
// Fires once per game per boundary (innings 3 & 6, and the final), persisted to
// disk (same pattern as reportDispatched) so a Render restart never re-sends
// or, worse, backfires for a boundary already passed.
const INNING_ALERT_INNINGS = [3, 6];
const INNING_ALERT_SENT_FILE = (process.env.CACHE_DIR || '.') + '/inning-alert-sent.json';
const inningAlertSent = new Set(); // "gameId:inning" already texted
let inningAlertSeeded = false;
(function loadInningAlertSent() {
  try { const a = JSON.parse(fs.readFileSync(INNING_ALERT_SENT_FILE, 'utf8')); if (Array.isArray(a)) a.forEach(k => inningAlertSent.add(k)); } catch (e) {}
})();
function saveInningAlertSent() { try { fs.writeFileSync(INNING_ALERT_SENT_FILE, JSON.stringify([...inningAlertSent])); } catch (e) {} }
// Inning n is fully in the past once the game has moved on to a later inning,
// or it ended (walk-off / mercy rule) during or before inning n.
function inningComplete(norm, n) {
  const inn = parseInt(norm.inning, 10) || 0;
  return inn > n || (inn === n && norm.status === 'final');
}
function inningAlertText(norm, n) {
  const g = norm.gatorsHome ? norm.home.runs : norm.away.runs;
  const o = norm.gatorsHome ? norm.away.runs : norm.home.runs;
  let box = '';
  const ls = norm.lineScore || [];
  const away = ls.find(t => t.vh === 'V'), home = ls.find(t => t.vh === 'H');
  if (away && home) {
    const row = t => (t.isGators ? 'Gators' : t.name) + ' ' + t.innings.slice(0, n).map(v => (v == null ? '-' : v)).join(' ');
    box = '\n' + row(away) + '\n' + row(home);
  }
  return 'End of ' + ordinal(n) + ': Gators ' + g + '-' + o + ' ' + norm.opponent.short + box;
}
// End-of-game text: the full line score plus a W/L/T tag, keyed ':final' so it
// fires exactly once per game, independent of the inning boundaries.
function finalAlertText(norm) {
  const g = norm.gatorsHome ? norm.home.runs : norm.away.runs;
  const o = norm.gatorsHome ? norm.away.runs : norm.home.runs;
  const wl = g > o ? 'W' : g < o ? 'L' : 'T';
  let box = '';
  const ls = norm.lineScore || [];
  const away = ls.find(t => t.vh === 'V'), home = ls.find(t => t.vh === 'H');
  if (away && home) {
    const row = t => (t.isGators ? 'Gators' : t.name) + ' ' + t.innings.map(v => (v == null ? '-' : v)).join(' ');
    box = '\n' + row(away) + '\n' + row(home);
  }
  return 'FINAL (' + wl + '): Gators ' + g + '-' + o + ' ' + norm.opponent.short + box;
}
function sendAlertText(norm, text, label) {
  const t = getMailer(); if (!t || !INNING_ALERT_TO.length) return Promise.resolve(false);
  return t.sendMail({ from: 'Gators GameTracker <' + MAIL_USER + '>', to: INNING_ALERT_TO.join(', '), text })
    .then(() => { process.stdout.write('\n[inning-alert] sent ' + label + ' for ' + norm.id + '\n'); return true; })
    .catch(e => { logErr('sendInningAlert', e); return false; });
}
// Fire one boundary's alert, committing the "sent" flag only once the send
// actually succeeds. Marking sent *before* the send (the old behavior) meant a
// single transient SMTP hiccup at the moment a boundary was first detected
// permanently swallowed that text — the 4s live poll never retried it. Now:
//  - an in-flight guard stops overlapping polls from double-sending;
//  - success persists the flag to disk (survives a Render restart);
//  - failure leaves the flag unset so the next poll retries, bounded so a hard
//    mailer outage doesn't attempt every 4s for the rest of the game.
const inningAlertInFlight = new Set();  // keys with a send currently in flight
const inningAlertAttempts = new Map();  // key -> failed send attempts so far
const INNING_ALERT_MAX_ATTEMPTS = 6;
function dispatchInningAlert(norm, key, text, label) {
  if (inningAlertInFlight.has(key)) return;
  if ((inningAlertAttempts.get(key) || 0) >= INNING_ALERT_MAX_ATTEMPTS) return;
  inningAlertInFlight.add(key);
  sendAlertText(norm, text, label).then(ok => {
    inningAlertInFlight.delete(key);
    if (ok) { inningAlertSent.add(key); inningAlertAttempts.delete(key); saveInningAlertSent(); }
    else inningAlertAttempts.set(key, (inningAlertAttempts.get(key) || 0) + 1);
  });
}
function checkInningAlerts(norm) {
  if (!INNING_ALERT_TO.length || norm.status === 'pregame' || norm.status === 'cancelled') return;
  const isFinal = norm.status === 'final';
  // First live/final game seen after boot: mark any boundary already in the
  // past (including the final, if the game is already over) as sent instead of
  // firing (or re-firing) for it.
  if (!inningAlertSeeded) {
    inningAlertSeeded = true;
    for (const n of INNING_ALERT_INNINGS) if (inningComplete(norm, n)) inningAlertSent.add(norm.id + ':' + n);
    if (isFinal) inningAlertSent.add(norm.id + ':final');
    saveInningAlertSent();
    return;
  }
  for (const n of INNING_ALERT_INNINGS) {
    const key = norm.id + ':' + n;
    if (inningAlertSent.has(key) || !inningComplete(norm, n)) continue;
    dispatchInningAlert(norm, key, inningAlertText(norm, n), 'end-of-' + n);
  }
  const fkey = norm.id + ':final';
  if (isFinal && !inningAlertSent.has(fkey))
    dispatchInningAlert(norm, fkey, finalAlertText(norm), 'final');
}
async function pollSchedule() {
  try {
    const res = await fetch(SCHEDULE_URL, { headers: {
      'cache-control': 'no-cache',
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    } });
    if (!res.ok) throw new Error('schedule HTTP ' + res.status);
    const body = await res.text();
    lastHtml = body; lastFetchAt = Date.now();
    const parsed = parseSchedule(body);
    // Don't wipe a known-good schedule on a transient empty/garbled response.
    if (parsed.length) games = parsed;
    else if (!games.length) games = parsed;
    else process.stdout.write('\r[poll] kept ' + games.length + ' cached games (empty parse)        ');
    await refreshFeatured();
    try {
      const date = (featured && featured.date) || todayCentralYmd();
      await refreshLeagueLiveScores(parseLeagueScoreboard(lastHtml, date), featured && featured.id);
    } catch (e) { logErr('pollSchedule', e); /* board still works from schedule scores */ }
    try { await dispatchFinalReport(); } catch (e) { /* report trigger is best-effort */ }
  } catch (err) { process.stdout.write('\r[poll error] ' + err.message + '        '); }
}
// For a live game, pull the league's live feed for the at-bat situation
// (count/outs/bases/batter/pitcher), the line score, and the play-by-play, and
// use the feed's runs as the scoreboard (the schedule page reads 0-0 mid-game).
// Fresh-final Gators games we've already pulled the feed for (to capture final
// pitch counts once), so we don't re-fetch every schedule poll for 10 hours.
const finalFeedDone = new Set();
async function enrichLive(norm) {
  // Always enrich a live game. Also pull the feed ONCE for a just-final Gators
  // game so the rest chart gets its final pitch counts — Presto gates the final
  // box XML behind a bot challenge and the schedule flips to "final" before the
  // box is available, so the feed is the only timely source.
  const freshFinal = norm.status === 'final' && !finalFeedDone.has(norm.id)
    && norm.gatorsHome != null && finalIsFresh(norm, Date.now());
  if (norm.status !== 'live' && !freshFinal) return;
  try {
    const lf = await fetchLiveForGame(norm.id);
    // Mark the fresh-final feed pulled only once it actually yields pitching, so a
    // transient feed failure retries on the next poll instead of being skipped.
    if (freshFinal && lf && lf.pitchers && lf.pitchers.length) finalFeedDone.add(norm.id);
    if (lf && lf.live) norm.live = lf.live;
    // The schedule page can lag the live feed by up to a half-inning. Since the
    // feed already drives the at-bat, count, and play-by-play, derive the header
    // inning/half from it too so the whole card shows one inning, not two.
    if (lf && lf.live && parseInt(lf.live.inning, 10)) {
      const inn = parseInt(lf.live.inning, 10);
      norm.inning = inn;
      norm.half = lf.live.half === 'Bottom' ? 'bottom' : 'top';
      norm.inningLabel = lf.live.half + ' of ' + ordinal(inn);
    }
    if (lf && lf.teams && lf.teams.length) {
      norm.lineScore = lf.teams;
      const v = lf.teams.find(t => t.vh === 'V'), h = lf.teams.find(t => t.vh === 'H');
      if (v && v.runs != null && v.runs !== '') norm.away.runs = Number(v.runs) || 0;
      if (h && h.runs != null && h.runs !== '') norm.home.runs = Number(h.runs) || 0;
    }
    if (lf && lf.plays && lf.plays.length) norm.plays = lf.plays;
    if (lf && lf.lineups && lf.lineups.length) norm.lineups = lf.lineups;
    if (lf && lf.pitchers && lf.pitchers.length) norm.pitchers = lf.pitchers;
    // The feed knows the last out has been made before the schedule says
    // "Final"; flip to the final screen now and anchor the post-game window.
    if (feedGameOver(norm.live, norm.away.runs, norm.home.runs)) {
      norm.status = 'final';
      const inn = parseInt(norm.live.inning, 10) || 0;
      norm.inningLabel = (inn && inn !== 9) ? ('Final/' + inn) : 'Final';
      if (finalSeenAt[norm.id] == null) finalSeenAt[norm.id] = Date.now();
    }
  } catch (e) { logErr('enrichLive', e); /* keep score-only view if the feed is unavailable */ }
}
// Live scores for in-progress NON-featured league games, refreshed each scrape
// so the around-the-league board shows real scores (the schedule reads 0-0
// mid-game). Auth is cached per game, so each refresh is one light feed request.
const liveScoreCache = {}; // id -> { away, home, at }
const LEAGUE_LIVE_CAP = 10; // safety cap on live-game feeds fetched per cycle
async function refreshLeagueLiveScores(board, featuredId) {
  const live = board.filter(g => g.state === 'live' && g.id !== featuredId);
  if (live.length > LEAGUE_LIVE_CAP)
    process.stdout.write('\r[league-live] ' + live.length + ' live games; refreshing first ' + LEAGUE_LIVE_CAP + '        ');
  // Fetch the capped set concurrently — each game writes its own cache key and is
  // independent, so awaiting them in parallel cuts a multi-game refresh from the
  // sum of the feed latencies to the slowest single one.
  await Promise.all(live.slice(0, LEAGUE_LIVE_CAP).map(async g => {
    try {
      const lf = await fetchLiveForGame(g.id);
      if (lf && lf.teams && lf.teams.length) {
        const v = lf.teams.find(t => t.vh === 'V'), h = lf.teams.find(t => t.vh === 'H');
        const num = x => (x && x.runs != null && x.runs !== '') ? (Number(x.runs) || 0) : null;
        const away = num(v), home = num(h);
        // The feed may show the game over before the schedule says "Final".
        const over = feedGameOver(lf.live, away, home);
        const inn = lf.live ? (parseInt(lf.live.inning, 10) || 0) : 0;
        liveScoreCache[g.id] = { away, home, at: Date.now(), over, label: over ? ((inn && inn !== 9) ? 'Final/' + inn : 'Final') : null,
          outs: lf.live ? lf.live.outs : null, bases: lf.live ? lf.live.bases : null };
      }
    } catch (e) { logErr('refreshLeagueLiveScores', e); /* keep the last cached score for this game */ }
  }));
}
// Overlay live scores onto in-progress games (the featured game's own live data,
// or the league-live cache); finals keep their authoritative schedule score and
// shed any stale cache entry.
function applyLiveScores(games, feat) {
  for (const g of games) {
    if (g.state === 'final') { delete liveScoreCache[g.id]; continue; }
    if (g.state !== 'live') continue;
    if (feat && g.id === feat.id) {
      if (feat.away && feat.away.runs != null) g.away.score = feat.away.runs;
      if (feat.home && feat.home.runs != null) g.home.score = feat.home.runs;
      // Outs + base runners for the scoreboard diamond (from the featured feed).
      if (feat.live) { g.outs = feat.live.outs; g.bases = feat.live.bases; }
      // Match the main screen: if we flipped the featured game to final
      // (feed game-over before the schedule says so), mark it here too.
      if (feat.status === 'final') { g.state = 'final'; g.status = feat.inningLabel || 'Final'; }
    } else {
      const c = liveScoreCache[g.id];
      if (c) {
        if (c.away != null) g.away.score = c.away;
        if (c.home != null) g.home.score = c.home;
        // Outs + base runners for the scoreboard diamond (from the per-game feed).
        if (c.outs != null) g.outs = c.outs;
        if (c.bases) g.bases = c.bases;
        if (c.over) { g.state = 'final'; g.status = c.label || 'Final'; }
      }
    }
  }
  return games;
}
// Around-the-league board for the featured game's day, live scores overlaid.
// Pure read of cached data — no network.
function buildLeagueBoard() {
  const date = (featured && featured.date) || todayCentralYmd();
  const raw = lastHtml ? sortBoard(applyLiveScores(parseLeagueScoreboard(lastHtml, date), featured)) : [];
  const games = raw.map(g => {
    // Mirror the featured game's manual cancellation onto the board so the same
    // game reads "Cancelled" here too (the schedule/feed may still report it as
    // live or scheduled). Blank the scores so the card shows logo-vs-logo.
    const cancelled = MANUAL_CANCEL.gameId && g.id === MANUAL_CANCEL.gameId;
    return Object.assign({}, g, cancelled ? { state: 'cancelled', status: 'Cancelled' } : null, {
      away: Object.assign({}, g.away, { city: boardCity(g.away && g.away.id), nick: NICK[g.away && g.away.id] || (g.away && g.away.short) || '', score: cancelled ? null : g.away && g.away.score }),
      home: Object.assign({}, g.home, { city: boardCity(g.home && g.home.id), nick: NICK[g.home && g.home.id] || (g.home && g.home.short) || '', score: cancelled ? null : g.home && g.home.score }),
    });
  });
  return { date, dateLabel: dateFromId(date).label, updatedAt: lastFetchAt, games };
}
// Recompute the featured game from the cached schedule, enrich it if live, and
// broadcast. Used by both the schedule poll and the tighter live poll.
async function refreshFeatured() {
  noteFinals(games);
  const chosen = pick(games);
  if (!chosen) return;
  const norm = normalizeFeatured(chosen);
  await enrichLive(norm);
  if (MANUAL_OVERRIDE.gameId && norm.id === MANUAL_OVERRIDE.gameId) {
    norm.away.runs = MANUAL_OVERRIDE.awayRuns;
    norm.home.runs = MANUAL_OVERRIDE.homeRuns;
    norm.status = 'final';
    norm.inningLabel = 'Final';
    norm.heroNote = MANUAL_OVERRIDE.note;
  }
  if (MANUAL_CANCEL.gameId && norm.id === MANUAL_CANCEL.gameId) {
    norm.status = 'cancelled';
    norm.inningLabel = 'Cancelled';
    // Blank the runs so the jumbo shows logo-vs-logo (no 0-0) for a game that
    // never played, matching how pregame renders.
    norm.away.runs = null;
    norm.home.runs = null;
  }
  const dh = MANUAL_DOUBLEHEADER[norm.id];
  if (dh) {
    norm.dhLabel = dh.label;
    // Only pin the shortened-final status once the game is actually final, so a
    // still-live nightcap keeps its live inning label.
    if (norm.status === 'final' && dh.status) norm.inningLabel = dh.status;
  }
  prevFeatured = featured; featured = norm;
  // The instant a game is final, warm its box score in the background (retried on
  // each schedule poll until the real tables land) so the "Box Score" button
  // serves from a hot cache the moment someone taps it — see warmFinalBox.
  if (norm.status === 'final' && finalIsFresh(norm, Date.now())) warmFinalBox(norm.id);
  // Snapshot the Gators' own game's live-feed pitching (live or just-final) so the
  // rest chart can keep showing tonight's outings after featured rotates away.
  if (norm && (norm.status === 'live' || norm.status === 'final') && Array.isArray(norm.pitchers)) {
    const side = norm.pitchers.find(t => t.isGators);
    if (side && Array.isArray(side.rows) && side.rows.length) {
      lastGatorsFeedGame = { id: norm.id, date: norm.date || String(norm.id).slice(0, 8), dateLabel: norm.dateLabel,
        oppShort: (norm.opponent && (norm.opponent.short || norm.opponent.name)) || '',
        gatorsHome: !!norm.gatorsHome, live: norm.status === 'live', rows: side.rows };
    }
  }
  diffAlert(norm);
  try { checkInningAlerts(norm); } catch (e) { logErr('checkInningAlerts', e); }
  // Only push to SSE clients when the game actually changed. During a slow
  // half-inning the 4s live poll would otherwise fan out ~15 identical frames a
  // minute to every open tab. New clients still get the current state on connect.
  const line = JSON.stringify({ type: 'game', game: norm });
  if (line !== lastBroadcastGame) { lastBroadcastGame = line; broadcastRaw(line); }
  process.stdout.write('\r[' + new Date().toLocaleTimeString() + '] ' + norm.away.short + ' ' + norm.away.runs + '-' + norm.home.runs + ' ' + norm.home.short + '  (' + norm.inningLabel + ')        ');
}
// Tighter refresh while a game is live: re-pull just the live feed (event auth
// is cached, so this is one lightweight JSON request) and re-broadcast.
async function pollLive() {
  if (!featured || featured.status !== 'live') return;
  try { await refreshFeatured(); } catch (e) { logErr('pollLive', e); }
}

// ===== Roster + player season stats =========================================
// Official gameday roster (TCL gameday sheet, updated 7/4). Bios are static;
// season stats are pulled live from the league stats site and cached.
const GATORS_SLUG = 'lakecharlesgumbeauxgators';
const playerUrl = slug => SPORT_BASE + '/players/' + slug;
const leagueStatsUrl = pos => SPORT_BASE + '/players?view=&r=0&pos=' + pos + '&sort=' + (pos === 'p' ? 'era' : 'avg');

const ROSTER = [
  { num: 2,  name: 'Jaxon Landreneau', slug: 'jaxonlandreneautqp8',  pos: 'Utility', cls: 'Junior',       ht: '5-10', wt: '190', b: 'R', t: 'R', bday: '10/20/2004', home: 'Lake Charles, LA', school: 'LSU-Eunice' },
  // Recently activated (6/25 sheet); placeholder slug until his Presto player page
  // exists, so the `note` shows on his profile instead of stats until his first game.
  { num: 3,  name: 'Griffin Hebert',   slug: 'griffinhebertqmlk',    pos: 'Utility', cls: 'Sophomore',    ht: '5-11', wt: '200', b: 'L', t: 'R', bday: '12/30/2006',   home: 'Lake Charles, LA', school: 'Lamar', note: 'Recently activated — season stats will appear after his first game.' },
  { num: 5,  name: 'Davis Duhon',      slug: 'davisduhons0vw',       pos: 'P',       cls: 'Junior',       ht: '6-0',  wt: '185', b: 'L', t: 'L', bday: '03/12/2005', home: 'Katy, TX',         school: 'Louisiana Christian' },
  // Added off the 6/28 gameday sheet; real Presto slug now set directly (was findSlug-matched by name).
  { num: 8,  name: 'Cade Robin',       slug: 'caderobinnu4m',        pos: 'P',       cls: 'Junior',       ht: '6-1',  wt: '200', b: 'R', t: 'R', bday: '03/15/2005', home: 'Arnaudville, LA',  school: 'LSU-Shreveport' },
  // #35 off the 7/3 official roster (replaced #9 James Reina, who dropped off it). He'd
  // already played 9 games (.207 AVG), but findSlug never resolved him because the league
  // leaderboard lists him as "J Torres", which doesn't match "Jeremiah Torres" via
  // normPlayerName — so his real Presto slug is set directly and stats flow.
  { num: 35, name: 'Jeremiah Torres',  slug: 'jeremiahtorrescsuy',   pos: 'IF',      cls: 'Junior',       ht: '6-0',  wt: '210', b: 'R', t: 'R', bday: '05/10/2006', home: 'Klein, TX',        school: 'Southern Indiana' },
  // Added off the 6/30 second-half roster; real Presto slug now set directly. He'd
  // already played 9 games (.217 AVG), but findSlug never resolved him because the
  // league leaderboard lists him as "K Martin", which doesn't match "Kash Martin" via normPlayerName.
  { num: 10, name: 'Kash Martin',      slug: 'kashmartin44sc',       pos: 'Utility', cls: 'Sophomore',    ht: '5-10', wt: '185', b: 'R', t: 'R', bday: '11/09/2006', home: 'Westlake, LA',     school: 'Bossier Parish CC' },
  { num: 11, name: 'Diego Corrales',   slug: 'diegocorrales91v5',    pos: 'P',       cls: 'Junior',       ht: '5-8',  wt: '185', b: 'L', t: 'L', bday: '08/01/2005', home: 'Lake Charles, LA', school: 'McNeese State' },
  // On the official roster; real Presto slug set directly (resolved from the Gators
  // team roster page). No game action yet, so the note shows until his first game.
  { num: 15, name: 'Reed Dupre',       slug: 'reeddupremvk3',        pos: 'P',       cls: 'Freshman',     ht: '5-10', wt: '150', b: 'R', t: 'R', bday: '',           home: 'Iowa, LA',         school: 'Southern Univ of New Orleans', note: 'Recently added — season stats will appear after his first game.' },
  { num: 16, name: 'Daniel Midkiff',   slug: 'danielmidkifffqkb',    pos: 'P',       cls: 'Sophomore',    ht: '6-2',  wt: '208', b: 'R', t: 'R', bday: '05/20/2007', home: 'Buna, TX',         school: 'Lamar' },
  { num: 17, name: 'Ayden Sunday',     slug: 'aydensundayyp1j',      pos: 'OF',      cls: 'Sophomore',    ht: '6-0',  wt: '185', b: 'R', t: 'R', bday: '09/07/2006', home: 'Nederland, TX',    school: 'Lamar' },
  { num: 21, name: 'Bankston Lembcke', slug: 'bankstonlembckeoxyb',  pos: 'IF',      cls: 'Junior',       ht: '5-11', wt: '205', b: 'R', t: 'R', bday: '11/14/2005', home: 'Klein, TX',        school: 'Bradley' },
  // Dropped off the 7/14 gameday sheet (Andrew Ramos, #28) — removed to match the active roster.
  // Added off the 6/28 gameday sheet; real Presto slug now set directly (was findSlug-matched by name).
  { num: 34, name: 'Brenyn Ebarb',     slug: 'brenynebarb6uqv',      pos: 'P',       cls: 'Graduate',     ht: '6-1',  wt: '195', b: 'R', t: 'R', bday: '05/04/2004', home: 'Zwolle, LA',       school: 'LSU-Alexandria', note: 'Recently added — season stats will appear after his first game.' },
  { num: 36, name: 'Jake Rider',       slug: 'jakeridergyu4',        pos: 'P',       cls: 'Junior',       ht: '6-4',  wt: '220', b: 'R', t: 'R', bday: '10/11/2005', home: 'Lake Charles, LA', school: 'Nunez CC' },
  // Added off the 6/30 second-half roster; now playing, so his real Presto slug is set directly and stats flow.
  { num: 38, name: 'Gabe Guidry',      slug: 'gabeguidryfktf',       pos: 'Utility', cls: 'R-Sophomore',  ht: '6-3',  wt: '200', b: 'R', t: 'R', bday: '01/26/2005',  home: 'Lake Charles, LA', school: 'Bossier Parish CC' },
  { num: 42, name: 'Kale Cropper',     slug: 'kalecropperuden',      pos: 'P',       cls: 'Sophomore',    ht: '6-4',  wt: '210', b: 'R', t: 'R', bday: '08/25/2006', home: 'Port Neches, TX',  school: 'Hill College' },
  { num: 45, name: 'Cannon Faulk',     slug: 'cannonfaulk0l9x',      pos: 'P',       cls: 'R-Sophomore',  ht: '6-4',  wt: '225', b: 'L', t: 'L', bday: '12/02/2005', home: 'Port Neches, TX',  school: 'Angelina College' },
  // On the official roster and already pitching; real Presto slug set directly
  // (resolved from the Gators team roster page) so his season stats flow in.
  { num: 47, name: 'Brayden Guillory', slug: 'braydenguilloryagcn',  pos: 'P',       cls: 'R-Freshman',   ht: '6-2',  wt: '200', b: 'R', t: 'R', bday: '11/17/2005', home: 'Kinder, LA',       school: 'Southern University' },
  // Assigned #39 on the 6/30 second-half roster; now playing, so his real Presto slug is
  // set directly and stats flow. Headshot populates once a photo is bundled.
  { num: 39, name: 'Yuichiro Kumagami', slug: 'yuichirokumagamisa54', pos: 'C', cls: 'Junior', ht: '5-11', wt: '200', b: 'R', t: 'R', bday: '07/16/2005', home: 'Miyagi, Japan', school: 'Mount Hood CC' },
  // Added off the 7/3 official roster; the 7/4 sheet assigns #24 and lists him as a
  // pitcher (was catcher/TBD). Real Presto slug set directly (resolved from the
  // Gators team roster page); he has pitched, so his season stats flow in.
  { num: 24, name: 'Pierce Boles', slug: 'piercebolesgu20', pos: 'P', cls: 'Sophomore', ht: '6-2', wt: '190', b: 'R', t: 'R', bday: '', home: 'Mandeville, LA', school: 'LSU-Eunice' },
  // Added off the 6/30 second-half roster. Hollier has TWO namesake pages on the
  // Gators team roster: an inactive #98 duplicate (taylorhollierj0t9, all dashes)
  // and the active #12 page (taylorholliervl4b) that actually carries his season
  // line and game log. An earlier fix picked the dashes-only #98 page, so his card
  // stayed at a phantom 0.00 ERA / 0.0 IP even after he pitched — point the slug at
  // the active #12 page so his real stats (ERA/IP/K) flow. Degeyter hasn't pitched
  // yet, so his note shows until his first appearance.
  { num: 12, name: 'Taylor Hollier',  slug: 'taylorholliervl4b',  pos: 'P', cls: 'Freshman', ht: '6-0', wt: '155', b: 'L', t: 'L', bday: '', home: 'Opelousas, LA', school: 'Belhaven' },
  { num: 43, name: 'Hunter Degeyter', slug: 'hunterdegeyterv7xl', pos: 'P', cls: 'HS Senior', ht: '6-1', wt: '170', b: 'R', t: 'R', bday: '', home: 'Lafayette, LA', school: 'Belhaven University', note: 'Recently added — season stats will appear after his first game.' },
  // Added off the 7/4 official roster; real Presto slug set directly (resolved from
  // the Gators team roster page). No game action yet, so the note shows for now.
  { num: 48, name: 'Marco Bandiero', slug: 'marcobandieroddnu', pos: 'IF', cls: 'Freshman', ht: '6-1', wt: '245', b: 'L', t: 'L', bday: '', home: 'Orange, TX', school: 'Angelina College', note: 'Recently added — season stats will appear after his first game.' },
  // Added off the 7/7 official roster. The sheet listed Victorian at #28 (a duplicate of
  // Andrew Ramos); Coach Carl confirmed his real number is #18. findSlug resolves his real
  // Presto page by name once it exists, and the note shows until his first game.
  { num: 18, name: 'Landon Victorian', slug: 'landonvictorian', pos: 'P', cls: 'Sophomore', ht: '6-3', wt: '180', b: 'R', t: 'R', bday: '11/02/2005', home: 'Lake Charles, LA', school: 'Louisiana Lafayette', findSlug: true, note: 'Recently added — season stats will appear after his first game.' },
  // Added off the 7/7 official roster as unnumbered position players; jersey numbers per
  // Coach Carl (Cooley #7, Beddoe #13, Sparks #9). Bio details filled in
  // from their college roster pages (LSU-Eunice, Pearl River CC, Lamar). findSlug resolves
  // each real Presto page by name once it exists, and the note shows until their first game.
  { num: 7,  name: 'Griffin Cooley', slug: 'griffincooley', pos: 'OF',      cls: 'R-Sophomore', ht: '6-2',  wt: '179', b: 'L', t: 'L', bday: '',           home: 'Kinder, LA',   school: 'LSU-Eunice',      findSlug: true, note: 'Recently added — season stats will appear after his first game.' },
  { num: 13, name: 'Jackson Beddoe', slug: 'jacksonbeddoe', pos: 'IF',      cls: 'Freshman',    ht: '5-11', wt: '185', b: 'R', t: 'R', bday: '',           home: 'Sulphur, LA',  school: 'Pearl River CC',  findSlug: true, note: 'Recently added — season stats will appear after his first game.' },
  { num: 9,  name: 'Lane Sparks', slug: 'lanesparks', pos: 'OF', cls: 'Junior', ht: '6-0', wt: '175', b: 'L', t: 'L', bday: '12/28/2004', home: 'Brenham, TX', school: 'Lamar', findSlug: true, note: 'Recently added — season stats will appear after his first game.' },
  // Added off the 7/10 official roster (#26, position players). Catcher at Nunez CC (Nunez
  // Pelicans, Chalmette LA); a Class of 2025 grad out of Alfred M. Barbe HS (Lake Charles),
  // so 2025-26 is his freshman year. Bio (ht/wt, bats/throws, hometown, HS) from his Perfect
  // Game profile; headshot cropped from his Nunez commitment announcement. No public DOB, so
  // bday stays blank. findSlug resolves his real Presto page by name once it exists.
  { num: 26, name: 'Shyler Smith', slug: 'shylersmith', pos: 'C', cls: 'Freshman', ht: '5-8', wt: '157', b: 'R', t: 'R', bday: '', home: 'Lake Charles, LA', school: 'Nunez CC', findSlug: true, note: 'Recently added — season stats will appear after his first game.' },
  // Added off the 7/14 gameday sheet (position players). Snider's bio is per the sheet
  // (Junior, Louisiana Tech, DOB). Real Presto slug set directly (reidsnidern8g1, resolved
  // from the team roster page) so his bundled headshot shows and season stats flow in; the
  // note shows until his first game.
  { num: 25, name: 'Reid Snider',   slug: 'reidsnidern8g1',   pos: 'Utility', cls: 'Junior',   ht: '6-4', wt: '210', b: 'R', t: 'R', bday: '08/30/2004', home: 'Lake Charles, LA', school: 'Louisiana Tech', note: 'Recently added — season stats will appear after his first game.' },
  // Scott's row was name-only on the sheet; bio (OF, Freshman, 6-4/190, Lake Charles, DOB
  // 07/17/2005) is from the official Presto team roster. He's a Klein Oak HS / Texas transfer
  // committed to McNeese, identity matched by the exact 07/17/2005 DOB. He joined the Gators
  // MID-SUMMER from the Brazos Valley Bombers, and Presto does NOT merge a transferred player's
  // line — his Gators page (matthewscott79tr) is empty, while his full summer batting line lives
  // on his Bombers page (slug mattscottjzw4, listed there as "Matt Scott" #8, now Inactive). So
  // his stats slug points at the Bombers page; his bundled headshot is keyed to that slug too.
  // (Gators live/box matching is by name, so this only changes where his season stats come from.)
  { num: 22, name: 'Matthew Scott', slug: 'mattscottjzw4', pos: 'OF', cls: 'Freshman', ht: '6-4', wt: '190', b: 'R', t: 'R', bday: '07/17/2005', home: 'Lake Charles, LA', school: 'McNeese State' },
];

// Coaching staff (gumbeauxgators.com/coaches). Shown beneath the player roster;
// bios/stats don't apply, so each is just a name + title (+ hometown when known).
const COACHES = [
  { num: 44, name: 'James Landreneau', slug: 'jameslandreneau', title: 'Head Coach', home: 'Mamou, LA',
    bio: `James Landreneau is the winningest coach in McNeese softball history, in his 14th season with the program and 10th as head coach, compiling a 339-181 overall record and a 163-41 mark in Southland Conference play. He reached his 300th career win on February 7, 2025, and became the program's all-time wins leader one week later. A four-time Southland Conference Coach of the Year, he has guided the Cowgirls to four consecutive regular-season titles (2022-2025) and three straight conference tournament championships (2021-2023), with multiple NCAA Regional runs and a program-record 47-win season in 2023. His son, Jaxon Landreneau, plays for the Gators.` },
  { num: 32, name: 'Carl Labit', slug: 'carllabit', title: 'Pitching Coach', home: 'Metairie, LA',
    bio: `Carl Labit, a Rummel graduate, spent several seasons as the pitching coach at De La Salle and last summer as the pitching coach for the Baton Rouge Rougarou. He hopes his expertise will help the Gators' young pitchers develop through the summer.` },
  { num: 23, name: 'Connor Schneider', slug: 'connorschneider', title: 'Hitting Coach', home: 'Papillion, NE',
    bio: `Connor Schneider, a senior infielder at McNeese, joins the Gators coaching staff for the summer. From Papillion, Nebraska, he has been at McNeese for three years. As a junior in 2024 he started 12 of 13 games, recording 9 hits, 2 runs, a double and a stolen base, and earned a spot on the SLC Commissioner's Honor Roll.` },
];

// ---- small HTML-table helpers (reuse bsText from box-score parser) ----------
function rowsOf(table) { return table.match(/<tr\b[\s\S]*?<\/tr>/gi) || []; }
function cellsOf(row) { return row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || []; }
function firstLink(cell) {
  const a = cell.match(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
  return a ? { href: a[1], text: bsText(a[2]) } : { href: '', text: bsText(cell) };
}
function slugFromHref(href) { const m = href.match(/\/players\/([a-z0-9_]+)/i); return m ? m[1] : ''; }
function teamIdFromHref(href) { const m = href.match(/[?&]id=([a-z0-9]+)/i); return m ? m[1] : ''; }

// "Player Stats" vertical table on a player page: label | Overall | rank.
const STAT_KEYS = {
  'games': 'gp', 'at bats': 'ab', 'runs': 'r', 'hits': 'h', 'doubles': '2b', 'triples': '3b',
  'home runs': 'hr', 'runs batted in': 'rbi', 'total bases': 'tb', 'walks': 'bb', 'strikeouts': 'k',
  'stolen bases': 'sb', 'caught stealing': 'cs', 'batting average': 'avg', 'on base percentage': 'obp',
  'slugging percentage': 'slg', 'hit by pitch': 'hbp', 'plate appearances': 'pa',
  'sacrifice flies': 'sf', 'sacrifice hits': 'sh',
  'appearances': 'app', 'games started': 'gs', 'wins': 'w', 'losses': 'l', 'saves': 'sv',
  'complete games': 'cg', 'shutouts': 'sho', 'innings pitched': 'ip', 'earned runs': 'er',
  'strikeouts per game': 'k9', 'whip': 'whip', 'earned run average': 'era',
  'batting average against': 'baa', 'home runs allows': 'hra', 'wild pitches': 'wp', 'hit batters': 'hb',
};
// The compact strip just below the player name (e.g. "app 5 ... ip 6.2 era 8.10 whip 1.95 k 8")
// is server-rendered on EVERY player page and is the most reliable signal. We parse it first.
const STRIP_PIT = ['app', 'gs', 'w', 'l', 'sv', 'ip', 'era', 'whip', 'k'];
const STRIP_BAT = ['gp', 'avg', 'obp', 'slg', 'hr', 'rbi', 'r', 'h', 'sb', 'ab'];
function parseStatStrip(html) {
  const h1 = html.search(/<\/h1>/i);
  let start = h1 >= 0 ? h1 + 5 : 0;
  let end = html.indexOf('Player Profile');
  if (end < 0 || end <= start) end = html.indexOf('Player Stats');
  if (end < 0 || end <= start) end = Math.min(html.length, start + 6000);
  const text = ' ' + bsText(html.slice(start, end)) + ' ';
  const grab = label => { const m = text.match(new RegExp('\\b' + label + '\\b\\s+([.\\d]+|-)\\b')); return (m && m[1] !== '-') ? m[1] : null; };
  const isPit = /\bip\b\s+[.\d]/.test(text) || /\bera\b\s+[.\d]/.test(text) || /\bwhip\b\s+[.\d]/.test(text);
  const isBat = /\bavg\b\s+[.\d]/.test(text) || /\bobp\b\s+[.\d]/.test(text) || /\bslg\b\s+[.\d]/.test(text);
  const kind = isPit ? 'pitching' : (isBat ? 'batting' : null);
  if (!kind) return { kind: null, map: {} };
  const keys = kind === 'pitching' ? STRIP_PIT : STRIP_BAT;
  const map = {};
  for (const key of keys) { const v = grab(key); if (v != null) map[key] = { v: v, r: '' }; }
  return { kind, map };
}
function parsePlayerPage(html) {
  const nameM = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const name = nameM ? bsText(nameM[1]) : '';
  const strip = parseStatStrip(html);
  const tables = html.match(/<table\b[\s\S]*?<\/table>/gi) || [];
  let kind = null; const map = {};
  for (const t of tables) {
    const low = bsText(t).toLowerCase();
    if (low.indexOf('overall') === -1) continue;
    if (!kind) kind = (low.indexOf('earned run average') !== -1 || low.indexOf('innings pitched') !== -1) ? 'pitching' : 'batting';
    for (const row of rowsOf(t)) {
      const c = cellsOf(row); if (c.length < 2) continue;
      const label = bsText(c[0]).toLowerCase().replace(/\s+/g, ' ').trim();
      const key = STAT_KEYS[label]; if (!key) continue;
      const v = bsText(c[1]); const r = c[2] ? bsText(c[2]) : '';
      if (v === '' || v === '-') continue;
      map[key] = { v: v, r: (r && r !== '-') ? r : '' };
    }
  }
  // Strip is authoritative for classification + headline values; merge table in for full stats + ranks.
  let finalKind = strip.kind || kind;
  let finalMap;
  if (strip.kind && kind && strip.kind !== kind) { finalKind = strip.kind; finalMap = Object.assign({}, strip.map); } // table is for the other discipline; trust strip
  else if (finalKind === kind) { finalMap = Object.assign({}, strip.map, map); } // table wins on overlap (has ranks)
  else { finalMap = Object.assign({}, map, strip.map); }
  const gl = parseGameLog(tables);
  return { name, kind: finalKind, map: finalMap, glBat: gl.bat, glPit: gl.pit };
}
// Per-game log lines from a player page (hitting + pitching game-log tables).
function parseGameLog(tables) {
  const bat = [], pit = [];
  for (const t of tables) {
    const rows = rowsOf(t); if (rows.length < 2) continue;
    const head = cellsOf(rows[0]).map(x => bsText(x).split(/\s+/)[0].toLowerCase());
    if (head.indexOf('opponent') === -1 || head.indexOf('score') === -1) continue;
    const idx = k => head.indexOf(k);
    const isPit = idx('ip') !== -1;
    const isBat = idx('ab') !== -1 && idx('avg') !== -1;
    if (!isPit && !isBat) continue;
    for (let i = 1; i < rows.length; i++) {
      const c = cellsOf(rows[i]); if (c.length < 4) continue;
      const get = k => { const j = idx(k); return (j >= 0 && c[j] != null) ? bsText(c[j]) : ''; };
      const num = v => v && v !== '-' && v !== '';
      const date = bsText(c[0]), opp = bsText(c[1]), score = bsText(c[2]);
      // Game-log rows carry the box-score link (in the Score cell); surface both
      // the upstream URL and the bare game id so the date can deep-link to our
      // own in-app box score (openBox) rather than out to PrestoSports.
      const bm = rows[i].match(/\/boxscores\/(\d{8}_[a-z0-9]+)\.xml/i);
      const boxUrl = bm ? boxscoreUrl(bm[1]) : '';
      const boxId = bm ? bm[1] : '';
      if (isPit) {
        const ip = get('ip'), h = get('h'), r = get('r'), er = get('er'), bb = get('bb'), k = get('k');
        // Only games the pitcher actually appeared in: recorded outs, or faced
        // batters (a hit/run/walk/strikeout). Skips listed-but-didn't-pitch rows.
        const appeared = ipToOuts(ip) > 0 || [h, r, er, bb, k].some(v => NUM(v) > 0);
        if (!appeared) continue;
        pit.push({ date, opp, score, ip, h, r, er, bb, k, era: get('era'), boxUrl, boxId });
      } else {
        const pa = get('pa'), ab = get('ab');
        if (!num(pa) && !num(ab)) continue;
        if ((pa === '0' || pa === '') && (ab === '0' || ab === '')) continue;
        bat.push({ date, opp, score, ab, h: get('h'), hr: get('hr'), rbi: get('rbi'), bb: get('bb'), k: get('k'), avg: get('avg'), boxUrl, boxId });
      }
    }
  }
  return { bat, pit };
}
function flatVals(map) { const o = {}; for (const k in map) o[k] = map[k].v; return o; }
function flatRanks(map) { const o = {}; for (const k in map) if (map[k].r) o[k] = map[k].r; return o; }
const NUM = v => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
function ipToOuts(ip) { const p = String(ip).split('.'); return (NUM(p[0]) * 3) + (p[1] ? NUM(p[1]) : 0); }
function outsToIp(o) { return Math.floor(o / 3) + '.' + (o % 3); }
function aggBat(gl) {
  let ab = 0, h = 0, hr = 0, rbi = 0, bb = 0, k = 0;
  gl.forEach(g => { ab += NUM(g.ab); h += NUM(g.h); hr += NUM(g.hr); rbi += NUM(g.rbi); bb += NUM(g.bb); k += NUM(g.k); });
  if (ab + bb === 0) return null;
  const avg = ab ? (h / ab).toFixed(3).replace(/^0/, '') : '.000';
  return { gp: String(gl.length), ab: String(ab), h: String(h), hr: String(hr), rbi: String(rbi), bb: String(bb), k: String(k), avg };
}
function aggPit(gl) {
  let outs = 0, h = 0, r = 0, er = 0, bb = 0, k = 0;
  gl.forEach(g => { outs += ipToOuts(g.ip); h += NUM(g.h); r += NUM(g.r); er += NUM(g.er); bb += NUM(g.bb); k += NUM(g.k); });
  if (outs === 0) return null;
  const ipDec = outs / 3;
  return { app: String(gl.length), ip: outsToIp(outs), h: String(h), r: String(r), er: String(er), bb: String(bb), k: String(k),
    era: (er * 9 / ipDec).toFixed(2), whip: ((h + bb) / ipDec).toFixed(2) };
}

// League hitting/pitching leaderboard (wide table) -> { slug: {col: val} } for Gators only.
// NOTE: the pitching leaderboard renders its real columns (era/ip/w/l) via JavaScript;
// the server HTML only contains placeholder hitting columns. We reject that so we never
// store bogus pitcher rows. Pitching season stats come from each player's page instead.
function parseLeagueStats(html, type) {
  const tables = html.match(/<table\b[\s\S]*?<\/table>/gi) || [];
  let tbl = null, head = null;
  for (const t of tables) {
    const rows = rowsOf(t); if (rows.length < 2) continue;
    const hd = cellsOf(rows[0]).map(x => bsText(x).split(/\s+/)[0].toLowerCase());
    if (hd.indexOf('team') === -1) continue;
    tbl = t; head = hd; break;
  }
  if (!tbl) return {};
  if (type === 'p' && head.indexOf('era') === -1 && head.indexOf('ip') === -1) return {};
  if (type === 'h' && head.indexOf('avg') === -1) return {};
  const rows = rowsOf(tbl); const out = {};
  for (let i = 1; i < rows.length; i++) {
    const c = cellsOf(rows[i]); if (c.length < 4) continue;
    const slug = slugFromHref(firstLink(c[1]).href);
    const teamId = teamIdFromHref(firstLink(c[2]).href);
    if (!slug || teamId !== GATORS_ID) continue;
    const o = {};
    for (let k = 3; k < c.length && k < head.length; k++) { if (head[k]) o[head[k]] = bsText(c[k]); }
    out[slug] = o;
  }
  return out;
}
// Name -> Presto slug for Gators players on a league leaderboard page. Lets us
// resolve the real slug of a roster entry added (findSlug) before its Presto
// player page was known: once the player appears on the league hitting/pitching
// page, we match them by name and swap their placeholder slug for the real one.
function parseLeagueSlugs(html) {
  const out = {};
  const tables = (html || '').match(/<table\b[\s\S]*?<\/table>/gi) || [];
  for (const t of tables) {
    const rows = rowsOf(t); if (rows.length < 2) continue;
    const hd = cellsOf(rows[0]).map(x => bsText(x).split(/\s+/)[0].toLowerCase());
    if (hd.indexOf('team') === -1) continue;
    for (let i = 1; i < rows.length; i++) {
      const c = cellsOf(rows[i]); if (c.length < 3) continue;
      const link = firstLink(c[1]);
      const slug = slugFromHref(link.href);
      if (!slug || teamIdFromHref(firstLink(c[2]).href) !== GATORS_ID) continue;
      const k = normPlayerName(link.text); if (k && !out[k]) out[k] = slug;
    }
    break;
  }
  return out;
}

// Two-way players' own pages carry only a pitching "Overall" table, so they get
// no hitting ranks from the player page the way pure hitters do. The league
// hitting leaderboard lists every league hitter with all their stat values, so
// we compute each Gators hitter's per-stat league rank from it (validated to
// reproduce the player-page ranks for pure hitters) and use it to fill in the
// hitters that are missing ranks. Runs (r) and stolen bases (sb) aren't on this
// leaderboard, so those two ranks stay unavailable for two-way players.
let leagueHitRanks = {};   // slug -> { statKey: 'Nth' }  (Gators hitters only)
const RANKABLE_HIT = ['avg', 'obp', 'slg', 'gp', 'ab', 'h', 'hr', 'rbi', 'bb', 'k'];
function computeLeagueHitRanks(html) {
  const tables = (html || '').match(/<table\b[\s\S]*?<\/table>/gi) || [];
  let tbl = null, head = null;
  for (const t of tables) {
    const rows = rowsOf(t); if (rows.length < 2) continue;
    const hd = cellsOf(rows[0]).map(x => bsText(x).split(/\s+/)[0].toLowerCase());
    if (hd.indexOf('team') === -1) continue; tbl = t; head = hd; break;
  }
  if (!tbl || head.indexOf('avg') === -1) return {};
  const rows = rowsOf(tbl); const players = [];
  for (let i = 1; i < rows.length; i++) {
    const c = cellsOf(rows[i]); if (c.length < 4) continue;
    const slug = slugFromHref(firstLink(c[1]).href); if (!slug) continue;
    const teamId = teamIdFromHref(firstLink(c[2]).href);
    const vals = {};
    for (let k = 3; k < c.length && k < head.length; k++) { if (head[k]) vals[head[k]] = bsText(c[k]); }
    players.push({ slug, teamId, vals });
  }
  if (players.length < 10) return {};   // didn't parse cleanly — don't touch existing ranks
  const ranks = {};
  for (const key of RANKABLE_HIT) {
    const list = players.map(p => ({ slug: p.slug, v: parseFloat(p.vals[key]) })).filter(p => !isNaN(p.v));
    list.sort((a, b) => b.v - a.v);   // higher value = better rank (matches the leaderboard)
    let prevV = null, prevRank = 0;
    for (let i = 0; i < list.length; i++) {
      const rank = (prevV !== null && list[i].v === prevV) ? prevRank : (i + 1);  // ties share a rank
      prevV = list[i].v; prevRank = rank;
      (ranks[list[i].slug] || (ranks[list[i].slug] = {}))[key] = ordinal(rank);
    }
  }
  const out = {};
  for (const p of players) if (p.teamId === GATORS_ID && ranks[p.slug]) out[p.slug] = ranks[p.slug];
  return out;
}
// hitRanks the client should see for a slug: the record's own (pure hitters) or,
// when those are empty (two-way players), the computed league ranks.
function effectiveHitRanks(slug, hit, ownRanks) {
  if (hit && (!ownRanks || !Object.keys(ownRanks).length) && leagueHitRanks[slug]) return leagueHitRanks[slug];
  return ownRanks || {};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let rosterStats = {};       // slug -> light { kind, hit, pit, hitRanks, pitRanks } for cards

// ----- league batter bios + stats (for the live "1st AB" card) ---------------
// On a batter's first plate appearance we have no this-game line, so we show his
// school, class, and season AVG/RBI/(HR|SB|H) instead. Bios for every TCL player
// come from the committed gameday-roster dataset; season stats come from our own
// roster cache (Gators) or the league hitting leaderboard (opponents).
let LEAGUE_BIO = {};  // normName -> { t:team, s:school, c:class }
try { LEAGUE_BIO = JSON.parse(fs.readFileSync(__dirname + '/league-roster.json', 'utf8')); } catch (e) {}
// Match the normalizer used to build league-roster.json: "Last, First" -> "first
// last", drop suffixes/punctuation, lowercase, collapse spaces.
function normPlayerName(n) {
  let s = String(n || '').replace(/’/g, "'").trim();
  if (s.includes(',')) { const p = s.split(','); s = (p[1] + ' ' + p[0]).trim(); }
  return s.toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}
const GATOR_BY_NORM = {}; for (const p of ROSTER) GATOR_BY_NORM[normPlayerName(p.name)] = p;
// Abbreviated-name index (firstInitial|lastname -> {t,s,c}) over the committed
// league roster, so an opponent the live feed names slightly differently than the
// roster PDF (a nickname, or an extra middle name) still resolves to a school +
// class on his 1st-AB card. First name wins on a collision. Built once — the bio
// dataset is loaded once at startup.
const LEAGUE_BIO_ABBR = {};
for (const k in LEAGUE_BIO) { const p = k.split(' '); if (p.length < 2) continue; const li = p[0][0] + '|' + p[p.length - 1]; if (!(li in LEAGUE_BIO_ABBR)) LEAGUE_BIO_ABBR[li] = LEAGUE_BIO[k]; }
function leagueBioAbbr(key) { const p = String(key || '').split(' '); if (p.length < 2 || !p[0]) return null; return LEAGUE_BIO_ABBR[p[0][0] + '|' + p[p.length - 1]] || null; }
let leagueHitterStats = {};  // normName -> { avg, hr, rbi, h } for every league hitter
// Like parseLeagueStats but keeps ALL teams, keyed by normalized player name, so
// an opponent batter's season line can be shown on his first at-bat.
function parseAllLeagueHitters(html) {
  const tables = (html || '').match(/<table\b[\s\S]*?<\/table>/gi) || [];
  let tbl = null, head = null;
  for (const t of tables) { const rows = rowsOf(t); if (rows.length < 2) continue; const hd = cellsOf(rows[0]).map(x => bsText(x).split(/\s+/)[0].toLowerCase()); if (hd.indexOf('team') === -1) continue; tbl = t; head = hd; break; }
  if (!tbl || head.indexOf('avg') === -1) return {};
  const rows = rowsOf(tbl); const out = {};
  for (let i = 1; i < rows.length; i++) {
    const c = cellsOf(rows[i]); if (c.length < 4) continue;
    const name = firstLink(c[1]).text; if (!name) continue;
    const o = {}; for (let k = 3; k < c.length && k < head.length; k++) { if (head[k]) o[head[k]] = bsText(c[k]); }
    out[normPlayerName(name)] = { avg: o.avg, hr: o.hr, rbi: o.rbi, h: o.h };
  }
  return out;
}
// Build the first-at-bat enrichment (bio + 3 season stats) for a batter by name.
// Third stat is HR, else SB (Gators only — the league leaderboard omits SB), else
// Hits. Returns { firstAB:true } with whatever data we have; absent -> just "1st AB".
function firstAbStats(name, teamId) {
  const key = normPlayerName(name);
  let bio = null, hit = null;
  const g = GATOR_BY_NORM[key];
  if (g) { bio = { school: g.school, cls: g.cls }; const s = rosterStats[g.slug]; hit = (s && s.hit) || null; }
  else {
    const b = LEAGUE_BIO[key] || leagueBioAbbr(key); if (b) bio = { school: b.s, cls: b.c };
    // Opponent stats: prefer his own Presto player page (which the lineup pass
    // fetches into rosterStats and which covers bats the league leaderboard drops
    // under its min-AB cutoff), then the leaderboard — the same source order the
    // lineup's season AVG uses, so this card doesn't go blank when that one shows a number.
    const rs = teamId && teamRosterSlugs[teamId];
    const slug = rs && rs.byName[key];
    hit = (slug && (rosterStats[slug] || {}).hit) || leagueHitterStats[key] || null;
  }
  const N = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const has = v => v != null && v !== '' && v !== '-';
  const line = [];
  // AVG from the season line when we have it, else the full-fallback lookup the
  // lineup uses (player page -> leaderboard -> first-initial+last-name match), so
  // the average still shows for a hitter we only matched by an abbreviated name.
  const avg = (hit && has(hit.avg)) ? String(hit.avg) : seasonAvgFor(name, teamId);
  if (has(avg)) line.push(['AVG', String(avg)]);
  if (hit) {
    if (has(hit.rbi)) line.push(['RBI', String(N(hit.rbi))]);
    let third = null;
    if (N(hit.hr) > 0) third = ['HR', String(N(hit.hr))];
    else if (N(hit.sb) > 0) third = ['SB', String(N(hit.sb))];
    else if (has(hit.h)) third = ['H', String(N(hit.h))];
    if (third) line.push(third);
  }
  const bioStr = bio ? [deshoutSchool(bio.school), bio.cls].filter(Boolean).join(' · ') : '';
  return { firstAB: true, bio: bioStr || null, seasonLine: line.length ? line : null };
}
let leaguePitcherStats = {};  // normName -> { era, ip, so, w, l, sv } for every league pitcher
// Like parseAllLeagueHitters but for the pitching leaderboard, so an opponent
// reliever's summer line can be shown when he enters the game.
function parseAllLeaguePitchers(html) {
  const tables = (html || '').match(/<table\b[\s\S]*?<\/table>/gi) || [];
  let tbl = null, head = null;
  for (const t of tables) { const rows = rowsOf(t); if (rows.length < 2) continue; const hd = cellsOf(rows[0]).map(x => bsText(x).split(/\s+/)[0].toLowerCase()); if (hd.indexOf('team') === -1) continue; tbl = t; head = hd; break; }
  if (!tbl || (head.indexOf('era') === -1 && head.indexOf('ip') === -1)) return {};
  const rows = rowsOf(tbl); const out = {};
  for (let i = 1; i < rows.length; i++) {
    const c = cellsOf(rows[i]); if (c.length < 4) continue;
    const name = firstLink(c[1]).text; if (!name) continue;
    const o = {}; for (let k = 3; k < c.length && k < head.length; k++) { if (head[k]) o[head[k]] = bsText(c[k]); }
    out[normPlayerName(name)] = { era: o.era, ip: o.ip, so: o.so != null ? o.so : o.k, w: o.w, l: o.l, sv: o.sv };
  }
  return out;
}
// A pitcher's school + class + summer line (ERA/IP/K) by name — Gators from our
// roster cache, opponents from the league pitching leaderboard.
function pitcherSeason(name) {
  const key = normPlayerName(name);
  let bio = null, pit = null;
  const g = GATOR_BY_NORM[key];
  if (g) { bio = { school: g.school, cls: g.cls }; const s = rosterStats[g.slug]; pit = (s && s.pit) || null; }
  else { const b = LEAGUE_BIO[key]; if (b) bio = { school: b.s, cls: b.c }; pit = leaguePitcherStats[key] || null; }
  const has = v => v != null && v !== '' && v !== '-';
  const line = [];
  if (pit) {
    if (has(pit.era)) line.push(['ERA', String(pit.era)]);
    if (has(pit.ip)) line.push(['IP', String(pit.ip)]);
    const k = pit.so != null ? pit.so : pit.k;
    if (has(k)) line.push(['K', String(Number(k) || 0)]);
  }
  const bioStr = bio ? [deshoutSchool(bio.school), bio.cls].filter(Boolean).join(' · ') : '';
  return { bio: bioStr || null, seasonLine: line.length ? line : null };
}
// Did the current pitcher just enter? Look for his pitching-change announcement
// in the play-by-play ("X to p for Y", "Pitching change: X for Y", "X relieved
// Y"). Returns { replaced } when found, so a starter (no such line) isn't flagged.
const PITCH_CHANGE_PATS = [
  /^(.+?) to p for (.+?)\.?$/i,
  /pitching change[:.]?\s*(.+?)\s+(?:replaces|for|relieved)\s+(.+?)\.?$/i,
  /^(.+?)\s+(?:relieved|replaces)\s+(.+?)\.?$/i,
];
function pitchChangeFor(plays, pitcherName) {
  const nm = normPlayerName(pitcherName); if (!nm || !Array.isArray(plays)) return null;
  for (let i = plays.length - 1; i >= 0; i--) {
    const t = String(plays[i].text || '').trim();
    for (const re of PITCH_CHANGE_PATS) { const m = t.match(re); if (m && normPlayerName(m[1]) === nm) return { replaced: m[2].trim(), index: i }; }
  }
  return null;
}
// Is this play's narrative a completed plate appearance (any outcome — out, hit,
// walk, HBP, reached on error, fielder's choice)? The narrative leads with the
// batter's name, so strip up to four leading name tokens and test the rest with
// the same plate-appearance verb list used elsewhere; baserunning sub-rows
// ("stole second", "scored", "advanced to third") don't start with a PA verb.
function isPaLine(text) {
  const t = String(text || '').trim(); if (!t) return false;
  const toks = t.split(/\s+/);
  for (let k = 1; k <= 4 && k < toks.length; k++) if (BS_PA_RE.test(toks.slice(k).join(' '))) return true;
  return false;
}
// The pitcher's home/visitor side, from whichever box team lists him.
function pitcherTeamVh(pitchers, name) {
  const nm = normPlayerName(name);
  for (const t of (pitchers || [])) if ((t.rows || []).some(r => normPlayerName(r.name) === nm)) return t.vh;
  return null;
}
// Has the pitcher already finished at least one batter since taking the mound?
// Read from the play-by-play so it catches every way a batter can end an at-bat,
// including reached-on-error and fielder's choice, which never appear as a hit,
// walk, or HBP on his box line. A reliever's first faced batter is the first
// completed PA after his pitching-change announcement; a starter's is the first
// completed PA in the half-innings his team is on defense.
function pitcherFacedBatter(plays, chg, starter, pitchers, name) {
  if (!Array.isArray(plays) || !plays.length) return false;
  if (chg) {
    for (let i = chg.index + 1; i < plays.length; i++) if (isPaLine(plays[i].text)) return true;
    return false;
  }
  if (!starter) return false;
  const vh = pitcherTeamVh(pitchers, name); if (!vh) return false;
  const fieldHalf = vh === 'H' ? 'top' : 'bot'; // home fields the top, visitor the bottom
  for (const p of plays) if (p.half === fieldHalf && isPaLine(p.text)) return true;
  return false;
}
// Is this pitcher his team's starter? The feed lists pitchers in order of
// appearance, so the first row per team is the starter.
function isStarter(pitchers, name) {
  const nm = normPlayerName(name);
  if (!Array.isArray(pitchers)) return false;
  for (const t of pitchers) { if (t.rows && t.rows.length && normPlayerName(t.rows[0].name) === nm) return true; }
  return false;
}
// Build the "new pitcher" enrichment for the live pitcher card: shown only while
// he's facing his very first batter — a reliever right after his pitching change,
// or a starter on his first batter. Carries his school, age (or class), and
// summer line. Returns null once he's finished a plate appearance, whether that
// batter made an out or reached base (walk/hit/HBP) — otherwise the badge lingers
// across several batters when he hasn't recorded an out yet.
function newPitcherInfo(info, plays, name, pitchers) {
  if (info && info.outs != null && info.outs > 0) return null;
  const chg = pitchChangeFor(plays, name);
  const starter = !chg && isStarter(pitchers, name);
  if (!chg && !starter) return null;
  // Clear the badge the moment his first batter is done. Two signals, so a thin
  // or lagging feed still clears it: his box line (out or baserunner allowed),
  // and the play-by-play (also covers reached-on-error / fielder's choice, which
  // never show as a hit, walk, or HBP).
  const nm = normPlayerName(name); const num = x => Number(x) || 0;
  let row = null;
  for (const t of (pitchers || [])) { const r = (t.rows || []).find(x => normPlayerName(x.name) === nm); if (r) { row = r; break; } }
  if (row && (num(row.h) + num(row.bb) + num(row.hbp)) > 0) return null;
  if (pitcherFacedBatter(plays, chg, starter, pitchers, name)) return null;
  const s = pitcherSeason(name);
  return { newPitcher: { replaced: chg ? chg.replaced : null, starter }, bio: s.bio, seasonLine: s.seasonLine };
}
// If the current batter entered as a pinch hitter/runner, find who he replaced
// from the play-by-play substitution announcement (handles both the "X pinch hit
// for Y" and "Pinch hitter X replaces Y" feed phrasings). Returns { for, type }.
function pinchFor(plays, batterName) {
  const nm = normPlayerName(batterName); if (!nm || !Array.isArray(plays)) return null;
  const pats = [
    [/^(.+?) pinch hit for (.+?)\.?$/i, 'ph'], [/pinch hitter\s+(.+?)\s+(?:replaces|for)\s+(.+?)\.?$/i, 'ph'],
    [/^(.+?) pinch ran for (.+?)\.?$/i, 'pr'], [/pinch runner\s+(.+?)\s+(?:replaces|for)\s+(.+?)\.?$/i, 'pr'],
  ];
  for (let i = plays.length - 1; i >= 0; i--) {
    const t = String(plays[i].text || '').trim();
    for (const [re, type] of pats) { const m = t.match(re); if (m && normPlayerName(m[1]) === nm) return { for: m[2].trim(), type }; }
  }
  return null;
}
// A batter's season batting average by name — Gators from our roster cache, every
// other league hitter from the league hitting leaderboard. Shown on the lineup.
// A last-name + first-initial fallback (over the leaderboard) covers opponents the
// live feed names differently than the stats site — a nickname ("Joey" vs the
// leaderboard's "Joseph") or an extra middle name — which would otherwise leave
// the lineup's AVG column blank even though the season line exists.
function seasonAvgFor(name, teamId) {
  const key = normPlayerName(name); if (!key) return null;
  const usable = h => h && h.avg != null && h.avg !== '' && h.avg !== '-';
  const g = GATOR_BY_NORM[key];
  if (g) { const h = (rosterStats[g.slug] || {}).hit; return usable(h) ? String(h.avg) : null; } // Gators matched by our own roster names
  // Opponent: prefer his own Presto player page (fetched via the team roster) —
  // that covers bats the league leaderboard drops under its min-AB cutoff — then
  // fall back to the leaderboard, then a first-initial + last-name match on it.
  const rs = teamId && teamRosterSlugs[teamId];
  const slug = rs && rs.byName[key];
  const bySlug = slug ? (rosterStats[slug] || {}).hit : null;
  if (usable(bySlug)) return String(bySlug.avg);
  const hit = leagueHitterStats[key];
  if (usable(hit)) return String(hit.avg);
  const p = key.split(' '); if (p.length < 2) return null;
  return hitterAbbrIndex()[p[0][0] + '|' + p[p.length - 1]] || null;
}
// Abbreviated-name index (firstInitial|lastname -> AVG) over the league hitting
// leaderboard, for seasonAvgFor's fallback. Rebuilt only when the leaderboard
// object is replaced (once per roster poll), keyed on its identity so per-call
// lookups stay cheap. First name wins on a collision, matching the box score.
let _hitAbbrSrc = null, _hitAbbr = {};
function hitterAbbrIndex() {
  if (_hitAbbrSrc === leagueHitterStats) return _hitAbbr;
  const idx = {};
  for (const k in leagueHitterStats) {
    const h = leagueHitterStats[k];
    if (!h || h.avg == null || h.avg === '' || h.avg === '-') continue;
    const p = k.split(' '); if (p.length < 2) continue;
    const li = p[0][0] + '|' + p[p.length - 1];
    if (!(li in idx)) idx[li] = String(h.avg);
  }
  _hitAbbrSrc = leagueHitterStats; _hitAbbr = idx;
  return idx;
}
const playerCache = {};     // slug -> full { ...light, glBat, glPit, ts } for profiles
let rosterUpdated = 0;
let rosterPolling = false;
const isThrottle = s => s === 459 || s === 429 || s === 503 || s === 403;
// Persist the scraped stats so a restart serves them instantly (no cold scrape)
// and only refreshes in the background. Best-effort: a read-only FS just no-ops.
const CACHE_FILE = (process.env.CACHE_DIR || '.') + '/roster-cache.json';
// Committed warm-boot seed: a periodic full-roster snapshot (rebuilt with
// scripts/build-seed). Loaded only when no live runtime cache exists — e.g. the
// first boot after a fresh deploy — so the roster shows complete instantly
// instead of cold-scraping. Resolved from __dirname so it's found regardless of
// the process working directory.
const SEED_FILE = __dirname + '/roster-seed.json';
function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ rosterStats, playerCache, rosterUpdated, playerPhotos, photosLoadedAt, leagueHitRanks })); } catch (e) {}
}
function applyCache(d) {
  if (!d || !d.rosterStats || !Object.keys(d.rosterStats).length) return false;
  rosterStats = d.rosterStats; Object.assign(playerCache, d.playerCache || {}); rosterUpdated = d.rosterUpdated || 0;
  if (d.playerPhotos && Object.keys(d.playerPhotos).length) { playerPhotos = d.playerPhotos; photosLoadedAt = d.photosLoadedAt || Date.now(); }
  // Computed two-way hitting ranks, so they show on warm boot instead of waiting
  // for the first roster poll to re-fetch the league leaderboard.
  if (d.leagueHitRanks && Object.keys(d.leagueHitRanks).length) leagueHitRanks = d.leagueHitRanks;
  return true;
}
function loadCache() {
  // Prefer the live runtime cache (fresher); fall back to the committed seed.
  for (const file of [CACHE_FILE, SEED_FILE]) {
    try { if (applyCache(JSON.parse(fs.readFileSync(file, 'utf8')))) return; } catch (e) { /* try next */ }
  }
}

// One fetch of a player page -> { primary, status }. No internal retries; the
// caller decides pacing so we don't hammer Presto into rate-limiting us.
async function fetchPlayerPage(slug) {
  try {
    const r = await fetchText(playerUrl(slug), SPORT_BASE + '/schedule');
    if (r.ok && r.body && r.body.indexOf('Player Stats') !== -1) return { primary: parsePlayerPage(r.body), status: r.status };
    return { primary: null, status: r.status || 0 };
  } catch (e) { return { primary: null, status: 0 }; }
}
// Build the cache record from a parsed page (+ optional league hitter fallback).
function buildRecord(slug, primary, batMap, pitMap) {
  const rec = { kind: null, hit: null, pit: null, hitRanks: {}, pitRanks: {}, glBat: [], glPit: [], ts: Date.now() };
  const pMap = (primary && primary.kind && Object.keys(primary.map).length) ? primary.map : null;
  if (pMap) { rec.kind = primary.kind; rec.glBat = primary.glBat || []; rec.glPit = primary.glPit || []; }
  // Hitting
  if (pMap && primary.kind === 'batting') { rec.hit = flatVals(pMap); rec.hitRanks = flatRanks(pMap); }
  else if (batMap && batMap[slug] && batMap[slug].avg) rec.hit = batMap[slug];
  else if (rec.glBat.length) rec.hit = aggBat(rec.glBat);
  // Pitching (player page is the only reliable source; league pitching is JS-rendered junk)
  if (pMap && primary.kind === 'pitching') { rec.pit = flatVals(pMap); rec.pitRanks = flatRanks(pMap); }
  else if (pitMap && pitMap[slug] && (pitMap[slug].era || pitMap[slug].ip)) rec.pit = pitMap[slug];
  else if (rec.glPit.length) rec.pit = aggPit(rec.glPit);
  // Presto leaves a recently-added player's page aggregate as a placeholder
  // {pa:0,tb:0} (no AB/AVG) for a while after his first game, even though his
  // game-by-game log already lists that game. That placeholder wins the branches
  // above but isn't showable, so his season line and lineup AVG read N/A. When a
  // game log exists but the chosen line has nothing to show, fall back to the
  // game-log aggregate (real AB/H/AVG, IP/ERA) so a number shows instead.
  if (rec.glBat.length && !lineIsShowable({ hit: rec.hit })) {
    const agg = aggBat(rec.glBat);
    if (lineIsShowable({ hit: agg })) { rec.hit = agg; rec.hitRanks = {}; }
  }
  if (rec.glPit.length && !lineIsShowable({ pit: rec.pit })) {
    const agg = aggPit(rec.glPit);
    if (lineIsShowable({ pit: agg })) { rec.pit = agg; rec.pitRanks = {}; }
  }
  return rec;
}
// On-demand fetch (taps + lazy-fill): a few gentle retries so a single open succeeds.
async function fetchPlayer(slug, batMap, pitMap, tries) {
  tries = tries || 3; let primary = null;
  for (let a = 0; a < tries && !primary; a++) {
    const pg = await fetchPlayerPage(slug);
    if (pg.primary) { primary = pg.primary; break; }
    if (a < tries - 1) await sleep(700 + a * 600);
  }
  return buildRecord(slug, primary, batMap, pitMap);
}
const recHasData = rec => !!(rec && (rec.hit || rec.pit || rec.glBat.length || rec.glPit.length));
// Whether a stat line has numbers actually worth showing on a card — real
// batting (AB/AVG) or pitching (real innings/counting stats). Distinguishes a
// produced line from Presto's placeholder line for a player who has appeared in
// the box scores but whose games Presto hasn't aggregated onto their page/
// leaderboard. For hitting that placeholder is {pa:0,tb:0} — no ab/avg, so it
// already reads as not-showable. For PITCHING the placeholder is ip "0.0" / era
// "0.00" (with everything else zero); ip/era are present but meaningless, so a
// bare "ip != null" wrongly counted it as showable — that let the box-score
// fallback skip a just-debuted pitcher and pinned a phantom 0.00 ERA on his card
// (e.g. Taylor Hollier, who had pitched but whose Presto page was still all
// dashes). Require real innings or real counting stats instead.
function pitLineShowable(p) {
  if (!p) return false;
  if (parseFloat(p.ip) > 0) return true;      // real innings pitched (0.1 = one out)
  if (parseFloat(p.era) > 0) return true;      // a real (non-placeholder) ERA
  const counts = ['h', 'r', 'er', 'bb', 'k']; // a rare 0-out appearance still logs these
  for (const c of counts) if (Number(p[c]) > 0) return true;
  return false;
}
const lineIsShowable = s => !!(s && ((s.hit && (s.hit.ab != null || s.hit.avg != null))
  || (s.pit && pitLineShowable(s.pit))));
// A "full" record carries player-page detail (game logs + stats like SB), as
// opposed to a league-leaderboard seed that only has headline card stats.
const recIsFull = rec => !!(rec && ((rec.glBat && rec.glBat.length) || (rec.glPit && rec.glPit.length)));
// A record is "fresh" while it's younger than this. Each roster poll re-scrapes any
// player whose record is older, so list-view card stats (served from rosterStats)
// refresh instead of freezing at whatever was first scraped. 10h sits below the
// ~12h between the twice-daily polls (noon & midnight Central), so every player
// refreshes on each poll.
const RECORD_TTL_MS = 10 * 60 * 60 * 1000;
const recFresh = rec => !!(rec && rec.ts && (Date.now() - rec.ts < RECORD_TTL_MS));
function storePlayer(slug, rec) {
  const had = playerCache[slug];
  // Don't let Presto's empty {pa:0,tb:0} placeholder line wipe a box-derived
  // fallback: keep the fallback until the real page has showable stats to replace
  // it. (recHasData treats {pa,tb} as data, which would otherwise clobber it.)
  if (rosterStats[slug] && rosterStats[slug].fromBox && !lineIsShowable({ hit: rec.hit, pit: rec.pit })) return;
  if (recHasData(rec) || !had) {
    playerCache[slug] = rec;
    rosterStats[slug] = { kind: rec.kind, hit: rec.hit, pit: rec.pit, hitRanks: rec.hitRanks, pitRanks: rec.pitRanks };
  }
}
const ROSTER_BY_SLUG = {}; for (const pl of ROSTER) ROSTER_BY_SLUG[pl.slug] = pl;
const isTwoWay = slug => { const pl = ROSTER_BY_SLUG[slug]; return !!(pl && /two.?way/i.test(pl.pos || '')); };
// A two-way player needs both a hitting and a pitching line; keep fetching until
// we have a full player-page record (which carries whatever disciplines he has),
// so the roster cache isn't stuck on the hitting-only league seed.
const playerNeedsData = slug => {
  const s = rosterStats[slug]; if (!s) return true;
  if (s.fromBox) return true; // box-derived fallback — keep re-checking the real player page
  if (isTwoWay(slug)) return recIsFull(playerCache[slug]) ? false : (s.hit == null || s.pit == null);
  return s.hit == null && s.pit == null;
};
// Gentle, persistent fill: only chase players still missing stats, back off hard
// when Presto throttles, and keep going across a few passes until everyone's in.
async function pollRoster() {
  if (rosterPolling) return;
  rosterPolling = true;
  try {
    let batMap = {}, pitMap = {};
    try {
      const [hRes, pRes] = await Promise.all([fetchText(leagueStatsUrl('h')), fetchText(leagueStatsUrl('p'))]);
      batMap = parseLeagueStats(hRes.body, 'h'); pitMap = parseLeagueStats(pRes.body, 'p');
      const lr = computeLeagueHitRanks(hRes.body); if (Object.keys(lr).length) leagueHitRanks = lr;
      const lh = parseAllLeagueHitters(hRes.body); if (Object.keys(lh).length) leagueHitterStats = lh; // opponents' season lines for the live 1st-AB card
      const lp = parseAllLeaguePitchers(pRes.body); if (Object.keys(lp).length) leaguePitcherStats = lp; // opponents' season lines for the live new-pitcher card
      // Resolve real Presto slugs for players added before their player page was
      // known (findSlug). The league hitting page lists each Gators hitter's
      // name+slug, but the league pitching page is JS-rendered and yields none —
      // so newly-active pitchers never resolved this way and their cards stayed
      // blank. The Gators team roster page lists EVERY player (hitters AND
      // pitchers) with their real slug, so fetch it too and merge: a player is
      // matched by name and their placeholder slug swapped for the real one —
      // stats then flow on the passes below. Wrapped separately so a team-page
      // failure still leaves the league-page resolution intact.
      let teamSlugs = {};
      if (ROSTER.some(pl => pl.findSlug)) {
        try {
          const tr = await fetchText(SPORT_BASE + '/teams/' + GATORS_SLUG, SPORT_BASE + '/schedule');
          if (tr.ok) teamSlugs = parseTeamRosterSlugs(tr.body);
        } catch (e) {}
      }
      const nameSlugs = Object.assign({}, parseLeagueSlugs(hRes.body), parseLeagueSlugs(pRes.body), teamSlugs);
      for (const pl of ROSTER) {
        if (!pl.findSlug) continue;
        const real = nameSlugs[normPlayerName(pl.name)];
        if (real && real !== pl.slug) {
          // Carry a headshot bundled under the placeholder slug over to the resolved
          // real slug — photos are keyed by slug, so without this the picture would
          // stop serving the moment findSlug swaps the slug.
          if (playerPhotos[pl.slug] && !playerPhotos[real]) { playerPhotos[real] = playerPhotos[pl.slug]; delete playerPhotos[pl.slug]; }
          delete ROSTER_BY_SLUG[pl.slug]; pl.slug = real; ROSTER_BY_SLUG[real] = pl; delete pl.findSlug;
        }
      }
    } catch (e) {}
    // Fast seed: the league hitting + pitching pages cover most of the roster in
    // just two fetches, so cards show stats almost immediately. The per-player
    // pass below then fills game logs, ranks, and any pitchers the league pages
    // miss — upgrading each card in the background without blocking the display.
    for (const pl of ROSTER) {
      if (!playerNeedsData(pl.slug)) continue;
      const hit = (batMap[pl.slug] && batMap[pl.slug].avg) ? batMap[pl.slug] : null;
      const pit = (pitMap[pl.slug] && (pitMap[pl.slug].era || pitMap[pl.slug].ip)) ? pitMap[pl.slug] : null;
      if (hit || pit) rosterStats[pl.slug] = { kind: pit ? 'pitching' : 'batting', hit, pit, hitRanks: {}, pitRanks: {} };
    }
    if (Object.keys(rosterStats).length && !rosterUpdated) rosterUpdated = Date.now();
    saveCache(); // persist the fast seed right away
    let pass = 0;
    while (pass < 5) {
      // Players with no card stats first (so they appear ASAP), then ones whose
      // record needs a (re)fetch: either no full record yet (to cache game logs
      // for profiles) or a record old enough that its stats should refresh. The
      // refetch's storePlayer rewrites rosterStats, so the list view's card stats
      // update instead of staying pinned to the first scrape.
      const missing = ROSTER.filter(pl => playerNeedsData(pl.slug));
      const stale = ROSTER.filter(pl => !playerNeedsData(pl.slug) && !recFresh(playerCache[pl.slug]));
      const todo = missing.concat(stale);
      if (!todo.length) break;
      // Fetch player pages with limited concurrency so a full cold scrape lands
      // in a few seconds, not ~30. Workers share the queue and flag throttling.
      let i = 0, throttled = false;
      const worker = async () => {
        while (i < todo.length) {
          const pl = todo[i++];
          // Through the shared limiter so this batch shares one global budget with
          // a live game's opponent warming instead of adding to it.
          const pg = await netLimit(() => fetchPlayerPage(pl.slug));
          storePlayer(pl.slug, buildRecord(pl.slug, pg.primary, batMap, pitMap));
          if (isThrottle(pg.status)) { throttled = true; await sleep(2500); }
          else await sleep(120);
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      saveCache();
      pass++;
      if (throttled) await sleep(5000); // breathe before re-attempting stragglers
    }
    // Final straggler sweep: a few players — usually pitchers, who aren't in the
    // league seed and get fetched last — can lose every single-attempt pass to
    // throttling and be left blank when the loop ends. Give whoever is still
    // missing the same retry-backed fetch a profile tap uses (fetchPlayer retries
    // internally), one at a time and gently, so the tail of the roster fills
    // instead of being abandoned.
    for (let sweep = 0; sweep < 3; sweep++) {
      const left = ROSTER.filter(pl => playerNeedsData(pl.slug));
      if (!left.length) break;
      for (const pl of left) {
        storePlayer(pl.slug, await fetchPlayer(pl.slug, batMap, pitMap, 3));
        await sleep(800);
      }
      saveCache();
      if (ROSTER.some(pl => playerNeedsData(pl.slug))) await sleep(4000);
    }
    // Box-score fallback: anyone still without stats — typically a just-debuted
    // player whose games Presto hasn't posted to their player page/leaderboard
    // yet — gets a season line derived straight from the Gators box scores. Only
    // touches players who have no player-page/leaderboard stats, so it never
    // overrides official numbers.
    try {
      await fillStatsFromBoxes(ROSTER.filter(pl => {
        const s = rosterStats[pl.slug];
        return (s && s.fromBox) || !lineIsShowable(s);
      }));
    } catch (e) { logErr('fillStatsFromBoxes', e); }
    rosterUpdated = Date.now();
    saveCache();
  } catch (e) { logErr('pollRoster', e); /* keep previous */ }
  finally { rosterPolling = false; }
}
// Player stats change about once a day, so we scrape them once daily at local
// (Central) midnight and serve the cache the rest of the day. Recomputing the
// delay to the next midnight each night keeps it correct across DST changes.
function msUntilNextCentralMidnight() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date());
  const get = t => +(parts.find(p => p.type === t) || {}).value;
  let h = get('hour'); if (h === 24) h = 0; // some runtimes emit "24" at midnight
  const into = h * 3600 + get('minute') * 60 + get('second');
  return Math.max(1000, (24 * 3600 - into) * 1000);
}
// ms until the next noon OR midnight Central, whichever comes first — the twice-a-day
// cadence for roster/player-stat refreshes. (The visitor-digest email keeps its own
// midnight-only schedule via msUntilNextCentralMidnight.)
function msUntilNextCentralHalfDay() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date());
  const get = t => +(parts.find(p => p.type === t) || {}).value;
  let h = get('hour'); if (h === 24) h = 0; // some runtimes emit "24" at midnight
  const into = h * 3600 + get('minute') * 60 + get('second');
  const next = into < 12 * 3600 ? 12 * 3600 : 24 * 3600; // next noon, else next midnight
  return Math.max(1000, (next - into) * 1000);
}
function scheduleRosterRefresh() {
  setTimeout(() => { try { pollRoster(); } catch (e) { logErr('scheduleRosterRefresh', e); } scheduleRosterRefresh(); }, msUntilNextCentralHalfDay());
}
// ----- per-game pitching walks (BB) from box scores --------------------------
// Presto's per-game pitching LOG omits BB, but each game's full box score lists
// it per pitcher. We match a game-log row to its game, read BB from that box,
// and cache boxes (shared across pitchers; a season is only ~20-30 games).
const boxWalkCache = {};   // gameId -> { ts, map:{ nameKey -> bb } }
const MON = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
// Pitcher decision/credit tokens Presto appends to a box-score name cell.
const PITCH_DECISION = new Set(['w','l','s','sv','bs','h','hld','hd','cg','sho','gs','nd']);
// Order-independent name key. Strips trailing decision tokens (e.g. a box's
// "John Munnerlyn SV") so it still matches the roster name "John Munnerlyn".
const nameKey = s => {
  let toks = String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z\s]/g,' ').trim().split(/\s+/).filter(Boolean);
  while (toks.length > 2 && PITCH_DECISION.has(toks[toks.length - 1])) toks.pop();
  return toks.filter(t => t.length > 1).sort().join('');
};
function glRowMD(s){ const m=String(s||'').match(/([A-Za-z]{3,})\.?\s+(\d{1,2})/); if(!m) return null;
  const mo=MON[m[1].slice(0,3).toLowerCase()]; return mo ? { mo, d:+m[2] } : null; }
// nameKey -> BB from one box-score pitching table.
function parsePitchingBB(tableHtml){
  const rows=rowsOf(tableHtml); if(rows.length<2) return {};
  const head=cellsOf(rows[0]).map(x=>bsText(x).split(/\s+/)[0].toLowerCase());
  const bbi=head.indexOf('bb'); if(bbi===-1) return {};
  const out={};
  for(let i=1;i<rows.length;i++){
    const c=cellsOf(rows[i]); if(c.length<=bbi) continue;
    const name=bsText(c[0]); if(!name || /^totals?$/i.test(name)) continue;
    const k=nameKey(name); if(!k) continue;
    out[k]=bsText(c[bbi]);
  }
  return out;
}
// nameKey -> roster player, so a box-score pitcher line can adopt the canonical
// roster name/number even when Presto abbreviates or reorders it.
const ROSTER_BY_NAMEKEY={}; for(const _p of ROSTER) ROSTER_BY_NAMEKEY[nameKey(_p.name)]=_p;
// Whole calendar days between two YYYYMMDD dates (b - a), timezone-agnostic.
function ymdToUTC(ymd){ return Date.UTC(+ymd.slice(0,4), +ymd.slice(4,6)-1, +ymd.slice(6,8)); }
function daysBetweenYmd(a,b){ return Math.round((ymdToUTC(b)-ymdToUTC(a))/86400000); }
// One pitcher's line from a box-score pitching table (headers already lower-cased,
// first token). Presto's NP column is renamed to "#P" in parseBoxscore, so accept
// either. Returns null for header/totals rows.
function pitcherLineFromRow(head, row){
  const c=cellsOf(row); if(!c.length) return null;
  const name=bsPitcherName(c[0]); if(!name || /^totals?$/i.test(name)) return null;
  const key=nameKey(name); if(!key) return null;
  const g=k=>{ const j=head.indexOf(k); return (j>=0 && c[j]!=null) ? bsText(c[j]) : ''; };
  const npCol=head.indexOf('#p')>=0 ? '#p' : 'np';
  return { key, name, np:NUM(g(npCol)), h:g('h'), r:g('r'), er:g('er'), bb:g('bb'), k:g('k') };
}
// Manual pitcher-rest outings, used when Presto never publishes a scrapeable box
// score for a final Gators game — the box XML stays bot-gated past the day-of live
// window, so the game would otherwise silently drop off the rest chart the next
// day. Each entry is one game: the date (YYYYMMDD, Central), opponent short name,
// whether the Gators were home, and every Gators pitcher's final pitch count (#P)
// read off the box score. Only current-roster names are kept (same as the scraped
// path). Deduped against scraped finals by date, so once Presto's box becomes
// available the scraped data takes over and the manual entry self-suppresses —
// remove it then. Currently empty: Presto is scraping the recent finals fine, so
// no game needs a manual backfill.
const MANUAL_REST_OUTINGS = [];
// Season pitcher-rest chart: for each current-roster Gators pitcher, every
// appearance (date, opponent, pitch count) across all final games, plus a
// per-game breakdown that mirrors the coach's hand-written pitch-count sheets for
// cross-checking. Pitchers who've since left the roster are excluded (only names
// that match ROSTER are kept). Final
// boxes are cached/persisted, so this walks the season cheaply. daysRest is left
// to the caller (it depends on "today"), so the result is date-independent and
// safe to memoize across a request or two.
async function computePitcherRest(){
  const finals=(games||[]).filter(g=>g.state==='final').sort((a,b)=>a.sortKey-b.sortKey);
  const acc={};              // key -> { key, name, num, outings:[] }
  const byGame=[];
  for(const g of finals){
    let res; try{ res=await fetchBoxPage(g.id); }catch(e){ continue; }
    if(!(res && res.ok && res.data && res.data.box)) continue;
    const sec=res.data.box.find(b => /gator/i.test(b.label) && /pitching/i.test(b.label));
    if(!sec) continue;
    const rows=rowsOf(sec.html); if(rows.length<2) continue;
    const head=cellsOf(rows[0]).map(x=>bsText(x).split(/\s+/)[0].toLowerCase());
    const oppShort=g.opponent.short || g.opponent.name || '';
    const gamePitchers=[];
    for(let i=1;i<rows.length;i++){
      const line=pitcherLineFromRow(head, rows[i]); if(!line) continue;
      const rp=ROSTER_BY_NAMEKEY[line.key];
      if(!rp) continue;        // only current-roster pitchers; skip players who've since left
      const disp=rp.name;
      const outing={ id:g.id, date:g.date, dateLabel:g.dateLabel, oppShort, gatorsHome:!!g.gatorsHome, np:line.np };
      const a=acc[line.key] || (acc[line.key]={ key:line.key, name:disp, num:rp.num, outings:[] });
      a.outings.push(outing);
      gamePitchers.push({ name:disp, num:rp.num, np:line.np });
    }
    if(gamePitchers.length) byGame.push({ id:g.id, date:g.date, dateLabel:g.dateLabel, oppShort, gatorsHome:!!g.gatorsHome, pitchers:gamePitchers });
  }
  // Fold in any manually-entered games (MANUAL_REST_OUTINGS) whose Presto box never
  // became scrapeable, so a real final still shows on the chart. Skip dates already
  // covered by a scraped final so nothing double-counts.
  const scrapedDates=new Set(byGame.map(b=>b.date));
  let manualGames=0;
  for(const mg of MANUAL_REST_OUTINGS){
    if(scrapedDates.has(mg.date)) continue;
    const dateLabel=ymdLabel(mg.date);
    const gamePitchers=[];
    for(const mp of mg.pitchers){
      const key=nameKey(mp.name); const rp=ROSTER_BY_NAMEKEY[key];
      if(!rp) continue;            // only current-roster pitchers, same as the scraped path
      const outing={ id:'manual_'+mg.date, date:mg.date, dateLabel, oppShort:mg.oppShort, gatorsHome:!!mg.gatorsHome, np:mp.np };
      const a=acc[key] || (acc[key]={ key, name:rp.name, num:rp.num, outings:[] });
      a.outings.push(outing);
      gamePitchers.push({ name:rp.name, num:rp.num, np:mp.np });
    }
    if(gamePitchers.length){ byGame.push({ id:'manual_'+mg.date, date:mg.date, dateLabel, oppShort:mg.oppShort, gatorsHome:!!mg.gatorsHome, pitchers:gamePitchers }); manualGames++; }
  }
  const pitchers=Object.values(acc).map(p=>{
    p.outings.sort((x,y)=>x.date.localeCompare(y.date));
    for(let i=0;i<p.outings.length;i++) p.outings[i].restBefore = i>0 ? daysBetweenYmd(p.outings[i-1].date, p.outings[i].date) : null;
    const last=p.outings[p.outings.length-1];
    p.lastDate=last.date; p.lastLabel=last.dateLabel; p.lastOpp=last.oppShort; p.lastHome=last.gatorsHome; p.lastNp=last.np;
    p.appearances=p.outings.length;
    p.totalPitches=p.outings.reduce((s,o)=>s+(o.np||0),0);
    return p;
  });
  byGame.sort((a,b)=>b.date.localeCompare(a.date));
  return { computedAt:Date.now(), finals:finals.length+manualGames, pitchers, byGame };
}
// Memoize the chart briefly — finals rarely change and box pages are cached, but
// this avoids re-walking the season on every request. daysRest is applied later.
let _restCache={ at:0, data:null, inflight:null };
async function getPitcherRest(){
  if(_restCache.data && Date.now()-_restCache.at < 5*60*1000) return _restCache.data;
  if(_restCache.inflight) return _restCache.inflight;
  _restCache.inflight=(async()=>{ try{ const d=await computePitcherRest(); _restCache={ at:Date.now(), data:d, inflight:null }; return d; }
    catch(e){ logErr('getPitcherRest', e); _restCache.inflight=null; return _restCache.data || { computedAt:0, finals:0, pitchers:[], byGame:[] }; } })();
  return _restCache.inflight;
}
// Today's outings from the featured game's live feed (featured.pitchers), which
// powers the gamecast. Presto gates the in-game AND freshly-final box XML behind
// a bot challenge, and the schedule page lags the final by minutes, so the feed
// is the only timely source: use it both while the game is LIVE and once the feed
// calls it FINAL, until the official box gets scraped into the finals set (the
// caller dedupes by game id so it never double-counts). Roster-matched.
function gatorsOutingsFrom(src){
  if(!src || !Array.isArray(src.rows)) return null;
  const outings = [];
  for(const row of src.rows){
    const np = row.np != null ? (Number(row.np) || 0) : 0;
    if(!(np > 0 || (row.ip && parseFloat(row.ip) > 0))) continue;   // actually took the mound
    const key = nameKey(row.name); const rp = ROSTER_BY_NAMEKEY[key];
    if(!rp) continue;
    outings.push({ key, name: rp.name, num: rp.num, np, ip: row.ip });
  }
  return outings.length ? { id:src.id, date:src.date, dateLabel:src.dateLabel, oppShort:src.oppShort, gatorsHome:!!src.gatorsHome, live:!!src.live, outings } : null;
}
function liveGatorsOutings(){
  const f = featured;
  // Prefer the current featured game when it's the Gators playing (live or just-final).
  if(f && (f.status === 'live' || f.status === 'final') && Array.isArray(f.pitchers)){
    const side = f.pitchers.find(t => t.isGators);
    if(side && Array.isArray(side.rows) && side.rows.length){
      const r = gatorsOutingsFrom({ id:f.id, date:f.date || String(f.id).slice(0,8), dateLabel:f.dateLabel,
        oppShort:(f.opponent && (f.opponent.short || f.opponent.name)) || '', gatorsHome:f.gatorsHome, live:f.status === 'live', rows:side.rows });
      if(r) return r;
    }
  }
  // Featured has rotated away: fall back to the remembered Gators game, but only
  // for today, so a prior-day snapshot never lingers on the chart.
  if(lastGatorsFeedGame && lastGatorsFeedGame.date === todayCentralYmd()) return gatorsOutingsFrom(lastGatorsFeedGame);
  return null;
}
// Overlay today's featured-game outings onto the (cached, finals-only) chart
// without mutating the cache: clone each pitcher, append the outing, and recompute
// the derived fields so a pitcher who threw today shows 0 days rest with his
// current pitch count. Skipped once the official final box is already in the
// finals set (dedupe by game id), so live → final → scraped-final is seamless.
function restWithLive(data){
  const live = liveGatorsOutings();
  const finalsIds = new Set((data.byGame || []).map(g => g.id));
  const apply = live && !finalsIds.has(live.id);
  const byKey = {};
  const pitchers = data.pitchers.map(p => { const c = Object.assign({}, p, { outings: p.outings.slice() }); byKey[c.key] = c; return c; });
  let byGame = data.byGame;
  if(apply){
    for(const o of live.outings){
      let p = byKey[o.key];
      if(!p){ p = { key:o.key, name:o.name, num:o.num, outings:[] }; byKey[o.key] = p; pitchers.push(p); }
      p.outings.push({ id:live.id, date:live.date, dateLabel:live.dateLabel, oppShort:live.oppShort, gatorsHome:live.gatorsHome, np:o.np, live:live.live });
    }
    for(const p of pitchers){
      p.outings.sort((x,y)=>x.date.localeCompare(y.date));
      const last = p.outings[p.outings.length-1];
      p.lastDate=last.date; p.lastLabel=last.dateLabel; p.lastOpp=last.oppShort; p.lastHome=last.gatorsHome; p.lastNp=last.np; p.lastLive=!!last.live;
      p.appearances=p.outings.length;
      p.totalPitches=p.outings.reduce((s,o)=>s+(o.np||0),0);
    }
    byGame = [{ id:live.id, date:live.date, dateLabel:live.dateLabel, oppShort:live.oppShort, gatorsHome:live.gatorsHome, live:live.live,
      pitchers: live.outings.map(o=>({ name:o.name, num:o.num, np:o.np })) }].concat(data.byGame);
  }
  return { computedAt:data.computedAt, finals:data.finals, live:!!(apply && live.live), liveGame: apply ? live : null, pitchers, byGame };
}
async function boxWalks(gid){
  const c=boxWalkCache[gid];
  if(c && c.map) return c.map;   // game-log games are final — BB never changes
  let map=null;
  try{
    const res=await fetchBoxPage(gid);   // shares one fetch with the box-score view + de-dupes
    if(res.ok && res.data){
      const m={};
      for(const b of res.data.box){ if(/Pitching/i.test(b.label)) Object.assign(m, parsePitchingBB(b.html)); }
      if(Object.keys(m).length) map=m;
    }
  }catch(e){}
  if(map){ boxWalkCache[gid]={ ts:Date.now(), map }; saveBoxCache(); }   // cache successes only
  return map;
}
// Find the Gators game id for a game-log row (month/day match, opponent tiebreak).
function gameIdForRow(row){
  const md=glRowMD(row.date); if(!md) return null;
  const opp=String(row.opp||'').toLowerCase();
  const sameDay=games.filter(g => +g.date.slice(4,6)===md.mo && +g.date.slice(6,8)===md.d);
  if(!sameDay.length) return null;
  if(sameDay.length===1) return sameDay[0].id;
  const hit=sameDay.find(g => { const n=String(g.opponent.name||'').toLowerCase(), s=String(g.opponent.short||'').toLowerCase();
    return (n && opp.indexOf(n)!==-1) || (s && opp.indexOf(s)!==-1); });
  return (hit||sameDay[0]).id;
}
// Fill BB into a pitcher's game-log rows from box scores — gentle, cached.
async function enrichPitchingWalks(name, glPit){
  if(!glPit || !glPit.length) return;
  const key=nameKey(name); if(!key) return;
  for(const row of glPit){
    if(row.bb && row.bb!=='-' && row.bb!=='') continue;
    const gid=gameIdForRow(row); if(!gid) continue;
    const wasCached=!!(boxWalkCache[gid] && boxWalkCache[gid].map);
    const map=await boxWalks(gid);
    if(map && map[key]!=null && map[key]!=='') row.bb=map[key];
    if(!wasCached) await sleep(500);   // pace only on real network fetches
  }
}
async function getPlayer(slug) {
  const cached = playerCache[slug];
  // Stats refresh once a day via the midnight poll, so serve the cached record
  // all day (no live re-scrape on open). 25h leaves a safety margin around the
  // daily refresh. An empty (throttled) entry still refetches on demand.
  const fresh = cached && (Date.now() - cached.ts < 25 * 60 * 60 * 1000);
  // Serve the cache only if it's a full player-page record; a league-only seed
  // (no game logs, no SB) gets re-fetched so the profile shows complete stats.
  if (fresh && recIsFull(cached)) return cached;
  storePlayer(slug, await fetchPlayer(slug, null, null));
  return playerCache[slug] || null;
}

// Season strike% for the Gators staff, aggregated from box-score play-by-play
// (no season pitch/strike totals exist on the league stat pages). Filled by
// pollStrikePct(); { pct: null } until the first aggregation completes.
let seasonStrikePct = { pct: null, pitches: 0, strikes: 0, games: 0, at: 0 };

// Count pitches in a chunk of play-by-play text by reading the per-at-bat pitch
// strings the feed appends as "(balls-strikes LETTERS)", e.g. "(2-2 KBKBK)".
// Each letter is one pitch: B (ball), H (hit-by-pitch) and P (pitchout) are
// balls; everything else (K, called/swinging strikes, F fouls, X in play) is a
// strike. A bare "(0-0)" with no letters is a first-pitch ball put in play — one
// strike. The count is clamped to a real baseball count [0-3]-[0-2] so fielding
// notations like "6-3" can't be mistaken for a count.
function strikeCounts(text) {
  const s = String(text || '').replace(/<[^>]+>/g, ' ');
  const re = /\(\s*[0-3]-[0-2](?:\s+([A-Za-z]+))?\s*\)/g;
  let m, pitches = 0, strikes = 0;
  while ((m = re.exec(s)) !== null) {
    const seq = m[1];
    if (!seq) { pitches++; strikes++; continue; }   // first-pitch ball in play
    for (const ch of seq.toUpperCase()) {
      pitches++;
      if (ch !== 'B' && ch !== 'H' && ch !== 'P') strikes++;
    }
  }
  return { pitches, strikes };
}

// Team-level season aggregates for the roster tab: batting (AVG/OBP/SLG/HR) and
// the pitching staff (ERA/WHIP/BB9/K9 + strike%), summed across every Gators
// player's season line in rosterStats.
// Dormant: kept for re-enabling the team batting/pitching card. Its result is
// currently withheld from the public /api/roster payload (see rosterPayload).
function computeTeamStats() {
  const N = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const ipOuts = ip => { const m = String(ip == null ? '' : ip).match(/^(\d+)(?:\.(\d))?$/); return m ? N(m[1]) * 3 + N(m[2]) : 0; };
  let ab = 0, h = 0, bb = 0, hbp = 0, sf = 0, tb = 0, hr = 0;       // batting
  let outs = 0, pbb = 0, pk = 0, er = 0, ph = 0;                    // pitching
  for (const slug in rosterStats) {
    const s = rosterStats[slug]; if (!s) continue;
    if (s.hit) { const x = s.hit; ab += N(x.ab); h += N(x.h); bb += N(x.bb); hbp += N(x.hbp); sf += N(x.sf); tb += N(x.tb); hr += N(x.hr); }
    if (s.pit) { const x = s.pit; outs += ipOuts(x.ip); pbb += N(x.bb); pk += N(x.k); er += N(x.er); ph += N(x.h); }
  }
  const ip = outs / 3;
  const f3 = x => x.toFixed(3).replace(/^0/, '');
  const batting = ab ? { avg: f3(h / ab), obp: f3((h + bb + hbp) / ((ab + bb + hbp + sf) || 1)), slg: f3(tb / ab), hr, h, ab } : null;
  const pitching = ip ? {
    era: (er * 9 / ip).toFixed(2), whip: ((pbb + ph) / ip).toFixed(2),
    bb9: (pbb * 9 / ip).toFixed(2), k9: (pk * 9 / ip).toFixed(2),
    ip: Math.floor(outs / 3) + '.' + (outs % 3), bb: pbb, k: pk,
    strikePct: seasonStrikePct.pct,
  } : null;
  return { batting, pitching };
}

function rosterPayload() {
  const players = ROSTER.map(p => {
    const s = rosterStats[p.slug] || { kind: null, hit: null, pit: null, hitRanks: {}, pitRanks: {} };
    // Serve headshots through our own /api/photo proxy: the team site hotlink-
    // protects images (403 unless the referer is its own domain), so a browser
    // can't load them directly — the proxy fetches them with the right referer.
    return Object.assign({}, p, s, {
      hitRanks: effectiveHitRanks(p.slug, s.hit, s.hitRanks),
      photo: playerPhotos[p.slug] ? ('/api/photo?slug=' + p.slug) : null,
    });
  });
  const complete = ROSTER.every(p => { const s = rosterStats[p.slug]; return s && (s.hit != null || s.pit != null); });
  const coaches = COACHES.map(c => Object.assign({}, c, { photo: playerPhotos[c.slug] ? ('/api/photo?slug=' + c.slug) : null }));
  // teamStats (team batting + pitching-staff aggregates) is intentionally withheld
  // from the public /api/roster response — these weren't meant to be public. The
  // computeTeamStats() helper and the client-side teamStatsCard() are kept intact;
  // to re-enable, add `teamStats: computeTeamStats()` back to the object below.
  return { players, coaches, updated: rosterUpdated, loading: Object.keys(rosterStats).length === 0,
           settled: rosterUpdated > 0 && !rosterPolling, complete, photos: photosLoadedAt > 0 };
}

// ===== Game location label + TCL TV watch links + player headshots ==========

// "Home, Joe Miller Ballpark" / "Away @ <city>". g.home is always the host team.
function gameLocation(g) {
  if (g.gatorsHome) return 'Home, ' + HOME_VENUE;
  const city = CITY[g.home.id] || (g.opponent && g.opponent.short) || 'Away';
  return 'Away @ ' + city;
}

// ---- TCL TV (Vewbie) live/upcoming stream links ----
const WATCH_LIST_URL = 'https://tcl-tv.vewbie.com/livestreams';
const WATCH_FALLBACK = 'https://tcl-tv.vewbie.com/categories/lake-charles-gumbeaux-gators';
let watchIndex = {};        // 'away|home|MM/DD/YYYY' and 'loose:away|home' -> stream URL
let watchLoadedAt = 0;
const citySlug = id => { const c = CITY[id]; return c ? c.toLowerCase().replace(/\s+/g, '-') : ''; };
const mmddyyyy = ymd => (ymd && ymd.length === 8) ? (ymd.slice(4, 6) + '/' + ymd.slice(6, 8) + '/' + ymd.slice(0, 4)) : '';
// Vewbie slugs look like /live/Lake-Charles-At-Abilene or ...-At-Abilene--83636.
// Repeat matchups get an undecipherable numeric suffix, so we scrape the list
// and match by away+home city (+ date), rather than constructing URLs.
function parseWatchList(html) {
  const idx = {}, seen = {};
  const re = /\/live\/([A-Za-z0-9\-]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1];
    if (seen[slug]) continue; seen[slug] = 1;
    const seg = html.slice(m.index, m.index + 900);
    const d = seg.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const date = d ? (d[1] + '/' + d[2] + '/' + d[3]) : '';
    const base = slug.replace(/--\d+$/, '').toLowerCase();
    const parts = base.split('-at-');
    if (parts.length !== 2) continue;
    const url = 'https://tcl-tv.vewbie.com/live/' + slug;
    if (date) { const k = parts[0] + '|' + parts[1] + '|' + date; if (!idx[k]) idx[k] = url; }
    const lk = 'loose:' + parts[0] + '|' + parts[1]; if (!idx[lk]) idx[lk] = url;
  }
  return idx;
}
async function pollWatch() {
  try {
    const r = await fetchText(WATCH_LIST_URL, 'https://tcl-tv.vewbie.com/');
    if (!r.ok || !r.body) return;
    const idx = parseWatchList(r.body);
    if (Object.keys(idx).length) { watchIndex = idx; watchLoadedAt = Date.now(); }
  } catch (e) { logErr('pollWatch', e); /* keep previous index */ }
}
// Live + upcoming only. Falls back to the Gators' TCL TV page when unmatched.
function watchUrlFor(g) {
  if (g.state !== 'live' && g.state !== 'scheduled') return null;
  const aw = citySlug(g.away.id), hm = citySlug(g.home.id);
  if (!aw || !hm) return WATCH_FALLBACK;
  const k = aw + '|' + hm + '|' + mmddyyyy(g.date || '');
  return watchIndex[k] || watchIndex['loose:' + aw + '|' + hm] || WATCH_FALLBACK;
}
// ----- finished-game replays (VODs from the league's Vewbie catalog) ---------
// texascollegiateleague.live is a Vewbie front end backed by vms.api.vewbie.com.
// We pull VODs from the Gators' own category (older seasons) AND the current
// "<year>-season" league category (where current games land), then index each
// Gators game by date + opponent, keeping the longest clip (the full broadcast,
// not a pre-game/rain-delay fragment). media_slug carries the game's *local*
// date and times, but the naming differs by season:
//   2024/25 team names:  Acadiana-Cane-Cutters-Gumbeaux-Gators-Sat-Jul-12-2025-...
//   2026+   city + "At": Acadiana-At-Lake-Charles-Wed-Jun-17-2026-...
// So the Gators side is "gumbeaux" OR "lake-charles", and an opponent matches by
// either its city or its team-name token. A finished game maps to its VOD by
// date + opponent id, so the Replay button always opens the correct game.
const REPLAY_SITE = 'https://texascollegiateleague.live';
const SEASON_YEAR = (SCHEDULE_URL.match(/\/(\d{4})\//) || [])[1] || '';
const REPLAY_API_URLS = ['https://vms.api.vewbie.com/api/categories/lake-charles-gumbeaux-gators/videos?limit=300']
  .concat(SEASON_YEAR ? ['https://vms.api.vewbie.com/api/categories/' + SEASON_YEAR + '-season/videos?limit=300'] : []);
const REPLAY_TOKEN = {
  cz8qei0rxijys6nm: 'cane',       // Acadiana Cane Cutters
  z10kgms3gvy1eszs: 'rougarou',   // Baton Rouge Rougarou
  ij0lwtvjsx2mi1nh: 'bison',      // Abilene Flying Bison
  z7w5th537gur3z15: 'bombers',    // Brazos Valley Bombers
  do9ibktaduhyld7f: 'monsters',   // San Antonio / Seguin River Monsters
  w43rx8i07fn44cyl: 'shadowcats', // Sherman Shadowcats
  jm9r4btii24hhtfp: 'generals',   // Victoria Generals
};
const RP_MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
const citySlugOf = id => (CITY[id] || '').toLowerCase().replace(/\s+/g, '-');
// The strings that identify an opponent in a slug: its team-name token + city.
const oppMarks = id => [REPLAY_TOKEN[id], citySlugOf(id)].filter(Boolean);
let replayIndex = {};       // 'YYYYMMDD|<oppTeamId>' -> { url, secs }
let replayLoadedAt = 0;
function durationSecs(d) { // "01:41:30" -> seconds
  const m = String(d || '').match(/^(\d+):(\d{2}):(\d{2})$/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
}
// Accepts the API payload ({ categories_medias: [...] }) or a bare media array.
function parseReplayList(data) {
  const medias = Array.isArray(data) ? data : (data && data.categories_medias) || [];
  const idx = {};
  for (const it of medias) {
    if (!it || it.is_live || /live/i.test(it.type || '')) continue;
    const slug = it.media_slug; if (!slug) continue;
    const dm = slug.match(/-([A-Za-z]{3})-(\d{1,2})-(\d{4})-/); // -Mon-DD-YYYY-
    if (!dm) continue;
    const mon = RP_MONTHS[dm[1].toLowerCase()]; if (!mon) continue;
    const ymd = dm[3] + mon + ('0' + dm[2]).slice(-2);
    const s = slug.toLowerCase();
    if (s.indexOf('gumbeaux') === -1 && s.indexOf('lake-charles') === -1) continue; // Gators games only
    const secs = durationSecs(it.duration);
    const url = REPLAY_SITE + '/video/' + slug;
    for (const id of Object.keys(REPLAY_TOKEN)) {
      if (!oppMarks(id).some(mk => s.indexOf(mk) !== -1)) continue;
      const k = ymd + '|' + id;
      if (!idx[k] || secs > idx[k].secs) idx[k] = { url, secs };
    }
  }
  return idx;
}
async function pollReplays() {
  try {
    const all = [];
    for (const u of REPLAY_API_URLS) {
      const r = await fetchText(u, REPLAY_SITE + '/');
      if (!r.ok || !r.body) continue;
      let data = null; try { data = JSON.parse(r.body); } catch (e) { continue; }
      const arr = Array.isArray(data) ? data : (data && data.categories_medias) || [];
      all.push.apply(all, arr);
    }
    if (!all.length) return;
    const idx = parseReplayList(all);
    if (Object.keys(idx).length) { replayIndex = idx; replayLoadedAt = Date.now(); }
  } catch (e) { logErr('pollReplays', e); /* keep previous index */ }
}
// Finished games only. Returns the direct VOD for *this* game, or null when we
// don't have that exact game's replay yet — so the Replay button only ever
// appears when it can open the correct game (never a misleading catalog/old VOD).
function replayUrlFor(g) {
  if (g.state !== 'final') return null;
  const oppId = g.away.id === GATORS_ID ? g.home.id : g.away.id;
  if (!oppId || !g.date) return null;
  const hit = replayIndex[g.date + '|' + oppId];
  return hit ? hit.url : null;
}

// ---- Player headshots ----
// The team site (gumbeauxgators.com) sits behind Cloudflare bot protection that
// blocks our datacenter IP, so headshots are downloaded once and bundled in
// photos/ (slug -> filename in photos/manifest.json), served from our origin.
let playerPhotos = {};      // roster slug -> bundled filename
let photosLoadedAt = 0;
const photoBuffers = {};    // filename -> { buf, type } preloaded at boot (headshots never change mid-run)
const normName = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
const PHOTO_DIR = __dirname + '/photos';
const PHOTO_TYPES = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', avif: 'image/avif', gif: 'image/gif' };
function loadLocalPhotos() {
  try {
    const man = JSON.parse(fs.readFileSync(PHOTO_DIR + '/manifest.json', 'utf8'));
    if (man && Object.keys(man).length) { playerPhotos = man; photosLoadedAt = Date.now(); }
  } catch (e) { /* no bundled photos */ }
  // Preload every bundled headshot into memory so /api/photo never hits the disk
  // (and never blocks the event loop with a sync read) on the hot request path.
  for (const file of new Set(Object.values(playerPhotos))) {
    if (!file || /[\\/]/.test(file)) continue;
    try {
      const buf = fs.readFileSync(PHOTO_DIR + '/' + file);
      const ext = String(file).split('.').pop().toLowerCase();
      photoBuffers[file] = { buf, type: PHOTO_TYPES[ext] || 'image/jpeg' };
    } catch (e) { /* skip a missing file */ }
  }
}
// ----- league standings (both teams' records on the jumbo + Standings tab) ---
let standings = {};         // normName(teamName) -> { w, l, t }  (jumbo records)
let standingsTable = [];    // ordered rows for the Standings tab
let standingsAt = 0;
// Parse the league standings table into both a name->record map (for the jumbo)
// and an ordered list of rows decorated with the team's logo/short name when the
// team can be matched to a known Presto id (via a /teams/<id> link or its name).
// "Won 5"/"Lost 4" (or "W5"/"L4") -> compact "W5"/"L4"; blank when none.
function fmtStreak(s) {
  const m = String(s || '').trim().match(/^(Won|Lost|W|L)\s*(\d+)/i);
  return m ? (/^w/i.test(m[1]) ? 'W' : 'L') + m[2] : '';
}
function parseStandings(html) {
  const tbl = (html.match(/<table\b[\s\S]*?<\/table>/i) || [])[0];
  if (!tbl) return { map: {}, rows: [] };
  const rows = rowsOf(tbl); if (rows.length < 2) return { map: {}, rows: [] };
  const head = cellsOf(rows[0]).map(c => bsText(c).toLowerCase());
  const wi = head.indexOf('w'), li = head.indexOf('l'), ti = head.indexOf('t'), si = head.indexOf('streak');
  if (wi === -1 || li === -1) return { map: {}, rows: [] };
  const map = {}, out = [];
  for (let i = 1; i < rows.length; i++) {
    const c = cellsOf(rows[i]); if (c.length <= Math.max(wi, li)) continue;
    const name = bsText(c[0]); const k = normName(name); if (!k) continue;
    const w = parseInt(bsText(c[wi]), 10), l = parseInt(bsText(c[li]), 10);
    if (!isFinite(w) || !isFinite(l)) continue;
    const t = ti >= 0 ? parseInt(bsText(c[ti]), 10) : 0;
    const streak = si >= 0 && c.length > si ? fmtStreak(bsText(c[si])) : '';
    const rec = { w, l, t: isFinite(t) ? t : 0 };
    map[k] = rec;
    const idm = rows[i].match(/\/teams\/([a-z0-9]+)/i);
    const id = (idm && TEAMS[idm[1]]) ? idm[1] : (Object.keys(TEAMS).find(tid => normName(TEAMS[tid].name) === k) || null);
    const meta = id ? TEAMS[id] : null;
    out.push({ id, name: meta ? meta.name : name, short: meta ? meta.short : name,
      logo: id ? logo(id) : '', w: rec.w, l: rec.l, t: rec.t, streak });
  }
  return { map, rows: out };
}
// Manual full-season record override — used when the live standings feed lags a
// confirmed final. Keyed by Presto team id -> the corrected full-season
// { w, l, streak }. Applied to BOTH the name->record map (jumbo/scoreboard) and
// the ordered rows (Standings tab) so every surface agrees; the second-half
// record then derives from these totals minus FIRST_HALF_FINAL, exactly like the
// feed.
//
// The override acts as a FLOOR, not a fixed pin: full-season W and L only ever
// climb over a season, so the correction applies only while the feed still sits
// BELOW it. The instant the feed ingests the confirmed result (or the team plays
// on past it), the feed's own numbers meet/exceed the floor and win — the record
// resumes updating automatically and the entry self-expires with no manual step.
// That's the fix for the recurring "records frozen because a stale pin was left
// behind" problem; a caught-up entry is harmless, but clearing it keeps this list
// honest about what's actually still lagging.
const MANUAL_STANDINGS_OVERRIDE = {
  // The feed lagged the 7/4 Gators 7–3 Brazos Valley final (as of 7/6 it showed
  // the Gators 15–12 / 3–1 2H and the Bombers a loss short). These floors carry
  // both sides through until the feed catches up, after which they no-op.
  et1bt9sixrz5lnnl: { w: 16, l: 12, streak: 'W4' }, // Lake Charles Gumbeaux Gators (4-1 2H)
  z7w5th537gur3z15: { w: 13, l: 15, streak: 'L1' }, // Brazos Valley Bombers (3-2 2H)
};
// Patch a freshly parsed standings result in place so the overrides above flow
// into both the record map and the rows before either is published. Floor
// semantics: never lower a feed number, and only stamp the manual streak while
// we're actually lifting the record (feed still behind) so a caught-up team keeps
// its live streak.
function applyStandingsOverride(parsed) {
  for (const id in MANUAL_STANDINGS_OVERRIDE) {
    const o = MANUAL_STANDINGS_OVERRIDE[id], t = TEAMS[id]; if (!t) continue;
    const k = normName(t.name);
    const feed = parsed.map[k];
    const w = feed ? Math.max(feed.w, o.w) : o.w;
    const l = feed ? Math.max(feed.l, o.l) : o.l;
    const correcting = !feed || w > feed.w || l > feed.l;
    parsed.map[k] = { w, l, t: (feed && feed.t) || 0 };
    const row = parsed.rows.find(x => x.id === id);
    if (row) { row.w = w; row.l = l; if (correcting && o.streak != null) row.streak = o.streak; }
  }
}
async function pollStandings() {
  try {
    const r = await fetchText(STANDINGS_URL, SCHEDULE_URL);
    if (!r.ok || !r.body) return;
    const parsed = parseStandings(r.body);
    if (Object.keys(parsed.map).length) { applyStandingsOverride(parsed); standings = parsed.map; standingsTable = parsed.rows; standingsAt = Date.now(); }
  } catch (e) { logErr('pollStandings', e); /* keep previous standings */ }
}
// Season strike% for the Gators staff: walk every finished Gators game's box-score
// play-by-play, count pitches only in the half-innings the Gators pitched (the
// opponent bats — Top when the Gators are home, Bottom when away), and roll the
// strike share up across the season. Final-game boxes are cached, so repeat runs
// are cheap.
async function pollStrikePct() {
  try {
    const finals = (games || []).filter(g => g.state === 'final');
    let pitches = 0, strikes = 0, gms = 0;
    for (const g of finals) {
      const res = await fetchBoxPage(g.id);
      const pbp = res && res.ok && res.data && res.data.pbp;
      if (!pbp || !pbp.length) continue;
      let any = false;
      for (const half of pbp) {
        const isTop = /top of/i.test(half.title || '');
        if (isTop !== !!g.gatorsHome) continue;   // only halves the Gators pitched
        const c = strikeCounts(half.html || '');
        pitches += c.pitches; strikes += c.strikes; if (c.pitches) any = true;
      }
      if (any) gms++;
      await sleep(250);
    }
    if (pitches > 0) seasonStrikePct = { pct: Math.round(strikes / pitches * 100), pitches, strikes, games: gms, at: Date.now() };
  } catch (e) { logErr('pollStrikePct', e); /* keep previous strike% */ }
}
// Manual second-half record override — used when the live standings feed lags
// behind a confirmed result. Clear an entry once the feed catches up to it.
const MANUAL_RECORD_OVERRIDE = {
  // (empty) — the live standings feed has caught up, so second-half records now
  // derive from it. Re-add an entry only when a confirmed result outpaces the feed.
};
// team {id,name,short} -> current-half "W-L"; name match then loose fallback.
// The feed reports full-season W-L, so the second-half record is derived as
// (season − first-half final, clamped at 0) — matching the reset Standings tab.
function recordStr(team) {
  if (!team) return null;
  if (team.id && MANUAL_RECORD_OVERRIDE[team.id]) return MANUAL_RECORD_OVERRIDE[team.id];
  const keys = Object.keys(standings); if (!keys.length) return null;
  let rec = standings[normName(team.name)];
  if (!rec) { const s = normName(team.short || ''); if (s.length >= 4) { const h = keys.find(k => k.indexOf(s) !== -1); if (h) rec = standings[h]; } }
  if (!rec) { const f = normName(team.name || ''); if (f.length >= 5) { const h = keys.find(k => k.indexOf(f) !== -1 || f.indexOf(k) !== -1); if (h) rec = standings[h]; } }
  if (!rec) return null;
  const base = (team.id && FIRST_HALF_FINAL[team.id]) || { w: 0, l: 0 };
  const w = Math.max(0, rec.w - base.w), l = Math.max(0, rec.l - base.l);
  return w + '-' + l;
}
// ----- single-game tickets (Gators home games on TicketSpice) ----------------
// Home-game ticket pages follow lake-charles-gumbeaux-gators-vs-<opp>-<M><DD><YY>
// (e.g. ...-baton-rouge-rougarou-62726). A bad slug 301-redirects to the site
// root, so we build candidates per upcoming home game and keep the one that
// actually returns 200 — no dead "Tickets" buttons.
const ticketSlugify = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
let ticketIndex = {};       // gameId -> verified ticket URL
let ticketsCheckedAt = 0;
function ticketCandidates(g) {
  if (!g || !g.gatorsHome || (g.state !== 'scheduled' && g.state !== 'live')) return [];
  if (!g.date || g.date.length !== 8 || !g.opponent || !g.opponent.name) return [];
  const opp = ticketSlugify(g.opponent.name); if (!opp) return [];
  const mo = String(parseInt(g.date.slice(4, 6), 10));
  const dd = g.date.slice(6, 8), dNo = String(parseInt(dd, 10)), yy = g.date.slice(2, 4);
  const base = 'https://gumbeauxgators.ticketspice.com/lake-charles-gumbeaux-gators-vs-' + opp + '-';
  return [...new Set([base + mo + dd + yy, base + mo + dNo + yy])];
}
async function pollTickets() {
  try {
    for (const g of games) {
      if (ticketIndex[g.id]) continue;
      const cands = ticketCandidates(g); if (!cands.length) continue;
      for (const url of cands) {
        try { const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'manual' }); if (r.status === 200) { ticketIndex[g.id] = url; break; } } catch (e) {}
        await sleep(250);
      }
    }
    ticketsCheckedAt = Date.now();
  } catch (e) { logErr('pollTickets', e); /* keep previous */ }
}
// Attaches the derived display fields a game needs on the client.
function decorateGame(g) { const dh = MANUAL_DOUBLEHEADER[g.id]; return Object.assign({}, g, { status: (dh && g.state === 'final' && dh.status) ? dh.status : g.status, dhLabel: dh ? dh.label : null, away: Object.assign({}, g.away, { city: boardCity(g.away && g.away.id), nick: NICK[g.away && g.away.id] || (g.away && g.away.short) || '' }), home: Object.assign({}, g.home, { city: boardCity(g.home && g.home.id), nick: NICK[g.home && g.home.id] || (g.home && g.home.short) || '' }), location: gameLocation(g), watchUrl: watchUrlFor(g), replayUrl: replayUrlFor(g), ticketUrl: ticketIndex[g.id] || null, theme: THEMES[g.date] || null, freeAdmission: FREE_ADMISSION[g.date] || null, promo: promoFor(g), special: SPECIALS[g.date] || null }); }

// ----- server ---------------------------------------------------------------
// ---- daily unique-visitor analytics ----------------------------------------
// Count distinct visitors per day by a salted, day-scoped hash of their IP — no
// cookies, no raw IPs stored. visitCounts keeps the per-day totals (history);
// visitDays keeps the current day's hash set for same-day dedupe.
const VISITS_FILE = (process.env.CACHE_DIR || '.') + '/visitors.json';
const visitCounts = {};           // 'YYYYMMDD' -> unique count
const visitDays = {};             // 'YYYYMMDD' -> Set(hashed ip)  (recent days only)
(function loadVisits() {
  try {
    const d = JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8'));
    Object.assign(visitCounts, d.counts || {});
    for (const day of Object.keys(d.days || {})) visitDays[day] = new Set(d.days[day]);
  } catch (e) {}
})();
let _visitsDirty = false;
function saveVisits() {
  try {
    const days = {}; for (const day of Object.keys(visitDays)) days[day] = [...visitDays[day]];
    fs.writeFileSync(VISITS_FILE, JSON.stringify({ counts: visitCounts, days }));
  } catch (e) {}
}
function pruneVisits() {
  const today = todayCentralYmd();
  // Keep only today's hash set (same-day dedupe); yesterday's count is frozen.
  for (const day of Object.keys(visitDays)) if (day !== today) delete visitDays[day];
  // Keep ~180 days of counts.
  const keep = Object.keys(visitCounts).sort().slice(-180);
  for (const day of Object.keys(visitCounts)) if (!keep.includes(day)) delete visitCounts[day];
}
function clientIp(req) {
  const xff = req && req.headers && req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || (req && req.ip) || (req && req.socket && req.socket.remoteAddress) || '';
}
function recordVisit(req) {
  try {
    const ip = clientIp(req); if (!ip) return;
    const day = todayCentralYmd();
    const h = crypto.createHash('sha256').update(STATS_SALT + '|' + day + '|' + ip).digest('hex').slice(0, 16);
    if (!visitDays[day]) { visitDays[day] = new Set(); pruneVisits(); }
    if (visitDays[day].has(h)) return;
    visitDays[day].add(h);
    visitCounts[day] = (visitCounts[day] || 0) + 1;
    _visitsDirty = true;
  } catch (e) {}
}
setInterval(() => { if (_visitsDirty) { _visitsDirty = false; saveVisits(); } }, 30000).unref?.();
function ymdLabel(ymd) { return /^\d{8}$/.test(ymd) ? dateFromId(ymd).label : ymd; }
function statsRows(n) {
  return Object.keys(visitCounts).sort().reverse().slice(0, n).map(d => ({ day: d, label: ymdLabel(d), n: visitCounts[d] }));
}
// Daily email digest: yesterday's uniques + the last 7 days.
function emailVisitorDigest() {
  const t = getMailer(); if (!t || !STATS_TO.length) return Promise.resolve(false);
  const rows = statsRows(8);                          // yesterday + prior week (today excluded below)
  const today = todayCentralYmd();
  const past = rows.filter(r => r.day !== today);
  const yest = past[0];
  const week = past.slice(0, 7);
  const weekTotal = week.reduce((s, r) => s + r.n, 0);
  const subject = 'Gators site — ' + (yest ? (yest.n + ' unique visitor' + (yest.n === 1 ? '' : 's') + ' on ' + yest.label) : 'daily traffic');
  const line = r => r.label + ': ' + r.n;
  const text = 'whatisthegatorscore.com — daily visitors\n\n'
    + (yest ? ('Yesterday (' + yest.label + '): ' + yest.n + ' unique visitors\n') : '')
    + 'Last 7 days: ' + weekTotal + ' total\n\n' + week.map(line).join('\n') + '\n';
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px">'
    + '<h2 style="margin:0 0 2px;color:#16102b">whatisthegatorscore.com — Daily Visitors</h2>'
    + (yest ? ('<p style="margin:0 0 10px;font-size:18px"><b>' + yest.n + '</b> unique visitor' + (yest.n === 1 ? '' : 's') + ' <span style="color:#777">on ' + repEsc(yest.label) + '</span></p>') : '')
    + '<p style="margin:0 0 6px;color:#555">Last 7 days: <b>' + weekTotal + '</b> total</p>'
    + '<table style="border-collapse:collapse;font-size:14px">' + week.map(r => '<tr><td style="padding:3px 14px 3px 0;color:#555">' + repEsc(r.label) + '</td><td style="padding:3px 0;text-align:right"><b>' + r.n + '</b></td></tr>').join('') + '</table></div>';
  return t.sendMail({ from: 'Gators Stats <' + MAIL_USER + '>', to: STATS_TO.join(', '), subject, text, html })
    .then(() => { process.stdout.write('\n[stats] emailed daily digest to ' + STATS_TO.join(', ') + '\n'); return true; })
    .catch(() => false);
}
function scheduleDailyStats() {
  setTimeout(() => { try { if (mailReady) emailVisitorDigest(); } catch (e) { logErr('scheduleDailyStats', e); } scheduleDailyStats(); }, msUntilNextCentralMidnight());
}

const app = express();
app.set('trust proxy', true);   // Render is behind a proxy — read the real client IP
app.use(compression());         // gzip the HTML page and JSON APIs; Render doesn't compress for us
app.use(cors());
app.use(express.json());

// no-cache (not no-store): the browser may keep a copy but MUST revalidate with
// the server every load, so a new deploy's HTML/JS reaches users immediately
// instead of being served stale from cache (ETag makes the revalidation a cheap
// 304 when nothing changed). Without this the single-page UI freezes at whatever
// version was first cached while live scores keep updating via the APIs.
// These three responses are constant strings, so gzip each one exactly once
// (memoized by name) instead of re-compressing on every request as the global
// compression() middleware would. compression() skips a response that already
// carries a Content-Encoding, so there's no double work.
const _gzMemo = {}, _brMemo = {};
function sendStatic(r, name, body, type) {
  r.type(type);
  const enc = String((r.req && r.req.headers['accept-encoding']) || '');
  // Prefer Brotli (noticeably smaller than gzip for this text-heavy HTML) when
  // the client accepts it, otherwise gzip. Each encoding is compressed once and
  // memoized by name, so no re-compression per request. Vary so shared caches
  // key on the negotiated encoding.
  if (/\bbr\b/.test(enc)) {
    r.set('Content-Encoding', 'br'); r.set('Vary', 'Accept-Encoding');
    return r.send(_brMemo[name] || (_brMemo[name] = zlib.brotliCompressSync(body)));
  }
  if (/\bgzip\b/.test(enc)) {
    r.set('Content-Encoding', 'gzip'); r.set('Vary', 'Accept-Encoding');
    return r.send(_gzMemo[name] || (_gzMemo[name] = zlib.gzipSync(body)));
  }
  return r.send(body);
}
app.get('/', (q, r) => { recordVisit(q); r.set('Cache-Control', 'no-store, must-revalidate'); sendStatic(r, 'app', APP_HTML, 'html'); });
app.get('/sw.js', (_q, r) => { r.set('Cache-Control', 'no-cache, no-store, must-revalidate'); sendStatic(r, 'sw', SW, 'application/javascript'); });
app.get('/manifest.json', (_q, r) => sendStatic(r, 'manifest', MANIFEST, 'application/json'));
app.get('/health', (_q, r) => r.json({ ok: true, build: BUILD, games: games.length, featured: featured && featured.id, push: pushReady, mail: mailReady, texts: INNING_ALERT_TO.length ? (mailReady ? 'on' : 'misconfigured') : 'off' }));
app.get('/api/version', (_q, r) => r.json(BUILD));
app.get('/debug', (_q, r) => {
  const html = lastHtml || '';
  const boxLinks = (html.match(/\/sports\/bsb\/\d{4}\/boxscores\/\d{8}_[a-z0-9]+\.xml/gi) || []).length;
  const logoIds = (html.match(/\/logos\/id\/[a-z0-9]+\.png/gi) || []).length;
  const hasGatorsLogo = html.indexOf(GATORS_ID) !== -1;
  r.json({
    scheduleUrl: SCHEDULE_URL,
    fetchedAgoSec: lastFetchAt ? Math.round((Date.now() - lastFetchAt) / 1000) : null,
    htmlLength: html.length,
    boxscoreLinksFound: boxLinks,
    teamLogosFound: logoIds,
    gatorsLogoPresent: hasGatorsLogo,
    gamesParsed: games.length,
    sample: games.slice(0, 3).map(g => ({ id: g.id, state: g.state, status: g.status,
      away: g.away.short + ' ' + g.away.score, home: g.home.short + ' ' + g.home.score })),
    htmlHead: html.slice(0, 500),
  });
});
app.get('/debug/live', async (q, r) => {
  try {
    const id = (q.query && q.query.id) || (featured && featured.id);
    if (!id) return r.status(503).json({ error: 'no game id yet — pass ?id=YYYYMMDD_xxxx or wait for the schedule poll' });
    const result = await fetchLiveForGame(id, true);
    r.json(result);
  } catch (err) {
    r.status(500).json({ error: String(err && err.message || err) });
  }
});

// Compact name diagnostic: for the live game, show each lineup player's raw feed
// name fields (batting-order name, player name, revname, shortname) alongside the
// name the lineup parser resolved. Lets us see which feed field is clean so the
// live lineup picks the right one. Read-only, like the sibling /debug/* endpoints.
app.get('/debug/names', async (q, r) => {
  try {
    const id = (q.query && q.query.id) || (featured && featured.id);
    if (!id) return r.status(503).json({ error: 'no game id yet — pass ?id=YYYYMMDD_xxxx' });
    const lf = await fetchLiveForGame(id, true);
    const json = lf && lf.raw;
    if (!json) return r.json({ id, note: 'no raw feed', auth: lf && lf.auth, feed: lf && lf.feed });
    const teams = (json.team || []).map(t => {
      const byUni = {}; (t.player || []).forEach(p => { if (p.uni != null) byUni[String(p.uni)] = p; });
      const order = (t.batords && t.batords.batord) || (t.starters && t.starters.starter) || [];
      return {
        team: t.name, vh: t.vh,
        rows: order.map(o => { const p = byUni[String(o.uni)] || {};
          return { uni: o.uni, batord: o.name, player: p.name, revname: p.revname, shortname: p.shortname }; }),
      };
    });
    const resolved = (lf.lineups || []).map(t => ({ vh: t.vh, names: (t.rows || []).map(x => x.name) }));
    r.json({ id, teams, resolved });
  } catch (err) {
    r.status(500).json({ error: String(err && err.message || err) });
  }
});

app.get('/debug/scan', async (q, r) => {
  try {
    const id = (q.query && q.query.id) || (featured && featured.id);
    if (!id) return r.status(503).json({ error: 'pass ?id=YYYYMMDD_xxxx' });
    const boxUrl = boxscoreUrl(id);
    const page = await fetchText(boxUrl, SCHEDULE_URL);
    r.json({ id, boxUrl, ok: page.ok, status: page.status, scan: scanForAuth(page.body) });
  } catch (err) {
    r.status(500).json({ error: String(err && err.message || err) });
  }
});
// Force-refresh one game's cached box score. A finished game's box is cached
// forever (boxIsFinal), so when the league post-edits a final's box (a stat
// correction), the site keeps serving the stale copy. This evicts the cached
// box + walk data and re-fetches the corrected version. Ungated, like the
// sibling /debug/* endpoints that also hit the upstream feed.
app.get('/debug/box-refresh', async (q, r) => {
  const id = String((q.query && q.query.id) || '');
  if (!/^\d{8}_[a-z0-9]+$/i.test(id)) return r.status(400).json({ ok: false, error: 'pass ?id=YYYYMMDD_xxxx (a boxscore id)' });
  const had = boxCache.has(id) || (boxWalkCache[id] != null);
  boxCache.delete(id);
  delete boxWalkCache[id];
  const res = await fetchBoxPage(id);
  if (!res || !res.ok) return r.status(502).json({ ok: false, id, evicted: had, error: 'refetch failed (status ' + (res && res.status) + ')' });
  saveBoxCache(); // persist the eviction of the stale walk data too
  r.set('Cache-Control', 'no-store');
  r.json({ ok: true, id, evicted: had, refetched: true, teams: res.data.teams, counts: res.data.counts });
});
app.get('/api/game', (_q, r) => { r.set('Cache-Control', 'no-store'); return featured ? r.json(featured) : r.status(503).json({ status: 'waiting' }); });
// Serve the bundled Gators badge. We deliberately use the embedded artwork (the
// clean white-circle "Lake Charles Gumbeaux Gators" roundel) rather than the
// PrestoSports CDN logo for this id — the CDN version is a different, lower-
// contrast design (purple ring, dark lettering) that looks wrong in the app.
app.get(['/gators-logo.png','/gators-logo.jpg'], (_q, r) => {
  r.set('Content-Type','image/png'); r.set('Cache-Control','public, max-age=604800');
  r.send(GATORS_LOGO_BUF);
});
app.get('/tcl-logo.png', (_q, r) => { r.set('Content-Type','image/png'); r.set('Cache-Control','public, max-age=604800'); r.send(TCL_LOGO_BUF); });
app.get(['/gg-logo.png','/gg-logo.jpg'], (_q, r) => { r.set('Content-Type','image/png'); r.set('Cache-Control','public, max-age=604800'); r.send(GG_LOGO_BUF); });
// Social/link-preview image (Gumbeaux Gators logo, 1200x628) for iMessage etc.
app.get('/og.jpg', (_q, r) => { if (!OG_BUF) return r.status(404).end(); r.set('Content-Type','image/jpeg'); r.set('Cache-Control','public, max-age=604800'); r.send(OG_BUF); });
// PWA / home-screen icons (also the notification icon the service worker uses).
app.get('/icon-512.png', (_q, r) => { if (!ICON_512_BUF) return r.status(404).end(); r.set('Content-Type','image/png'); r.set('Cache-Control','public, max-age=604800'); r.send(ICON_512_BUF); });
app.get(['/icon-192.png', '/icon.png'], (_q, r) => { if (!ICON_192_BUF) return r.status(404).end(); r.set('Content-Type','image/png'); r.set('Cache-Control','public, max-age=604800'); r.send(ICON_192_BUF); });
app.get(BG_PATH, (_q, r) => { r.set('Content-Type','image/jpeg'); r.set('Cache-Control','public, max-age=31536000, immutable'); r.send(BG_BUF); });
// Parsed box scores cached in memory and on disk. A finished game's box never
// changes, so once fetched we keep serving it forever — this avoids re-hitting
// PrestoSports (and its 429s) on every click, even across restarts.
const boxCache = new Map();        // id -> { data, at }
const boxInflight = new Map();     // id -> Promise (de-dupe concurrent fetches)
const BOX_TTL_MS = 60 * 60 * 1000; // re-fetch window only for a still-in-progress game
// A box score is "final" (never changes) once its game date is before today.
const boxIsFinal = id => /^\d{8}/.test(String(id)) && String(id).slice(0, 8) < todayCentralYmd();
const BOX_CACHE_FILE = (process.env.CACHE_DIR || '.') + '/box-cache.json';
let boxSaveTimer = null;
function saveBoxCache() {
  if (boxSaveTimer) return;
  boxSaveTimer = setTimeout(() => { boxSaveTimer = null;
    try { fs.writeFileSync(BOX_CACHE_FILE, JSON.stringify({ boxes: Object.fromEntries(boxCache), walks: boxWalkCache })); } catch (e) {}
  }, 4000);
}
function loadBoxCache() {
  try {
    const d = JSON.parse(fs.readFileSync(BOX_CACHE_FILE, 'utf8'));
    if (d && d.boxes) for (const k in d.boxes) boxCache.set(k, d.boxes[k]);
    if (d && d.walks) Object.assign(boxWalkCache, d.walks);
  } catch (e) { /* no cache yet */ }
}
// Map an upstream box-page failure to the API's error response. 429/503 (and a
// bare 502 from the proxy) are Presto rate-limiting or briefly gating a cold
// box — transient, so flag them retryable and answer 503 so the client backs
// off and tries again rather than showing the viewer a raw "box page 429".
function boxErrorResponse(status) {
  const transient = status === 429 || status === 503 || status === 502;
  return {
    status: transient ? 503 : 502,
    body: {
      error: transient
        ? 'Box score is still loading — please try again in a moment.'
        : 'Box score is unavailable for this game.',
      retry: transient,
    },
  };
}
// Fetch + parse one box score, sharing one network request across concurrent
// callers (box-score view and walk enrichment), with 429/503 backoff. Caches
// the result; persists finals. Returns { ok, data, types } or { ok:false }.
async function fetchBoxPage(id) {
  const cached = boxCache.get(id);
  // A final's box is permanent — but only once it's the REAL box. A transient
  // bot-gate / rate-limit response (served as a 200) parses to an empty,
  // incomplete box; never treat that stub as the permanent final copy, or it
  // poisons the box display AND the box-score stat fallback until the process
  // restarts. For an incomplete final, fall through and re-fetch (bounded by the
  // in-progress TTL so we don't hammer the source) until the real tables land.
  if (cached && ((boxIsFinal(id) && boxLooksComplete(cached.data)) || Date.now() - cached.at < BOX_TTL_MS)) return { ok: true, data: cached.data, cached: true };
  if (boxInflight.has(id)) return boxInflight.get(id);
  const job = (async () => {
    const url = boxscoreUrl(id) + '?view=plays';
    let page = await fetchText(url, SCHEDULE_URL);
    for (let tries = 0; !page.ok && (page.status === 429 || page.status === 503) && tries < 2; tries++) {
      await sleep(600 * (tries + 1));
      page = await fetchText(url, SCHEDULE_URL);
    }
    if (!page.ok) return { ok: false, status: page.status };
    const p = parseBoxscore(page.body);
    const data = { id, teams: p.teams, line: p.line, box: p.box, pbp: p.pbp, counts: p.counts };
    boxCache.set(id, { data, at: Date.now() });
    // Only persist a final's box once it's complete, so a gate/throttle stub is
    // never written to disk and restored on the next boot as a permanent
    // (poisoned) final copy.
    if (boxIsFinal(id) && boxLooksComplete(data)) saveBoxCache();
    return { ok: true, data, types: p.types };
  })();
  boxInflight.set(id, job);
  job.finally(() => boxInflight.delete(id));
  return job;
}
// ---- Pre-warm a just-final game's box score ---------------------------------
// Presto flips the schedule to "Final" (and our live feed calls the game over)
// several minutes before it renders the finished box-score page — and gates that
// page behind a bot challenge in the meantime. The "Box Score" button appears the
// instant the game ends (buildFinal), so without pre-warming the first viewer to
// tap it eats that lag on an empty or slow fetch. When a game goes final we poll
// the box quietly in the background until the real tables land, so the cache is
// hot before anyone taps. Bounded so a box that never posts (a gate that never
// lifts, a game Presto never renders) can't hammer the source for hours.
const boxWarmDone = new Set();      // ids whose real box has landed + cached
const boxWarmInflight = new Set();  // ids with a warm fetch in flight
const boxWarmTries = new Map();     // id -> attempts so far
const BOX_WARM_MAX_TRIES = 60;      // ~15 min at the 15s schedule-poll cadence
// A complete box has both teams' tables; a bot-gate stub parses to an empty box.
const boxLooksComplete = d => !!(d && Array.isArray(d.box) && d.box.length >= 2);
async function warmFinalBox(id) {
  if (!id || boxWarmDone.has(id) || boxWarmInflight.has(id)) return;
  if ((boxWarmTries.get(id) || 0) >= BOX_WARM_MAX_TRIES) return;
  boxWarmInflight.add(id);
  boxWarmTries.set(id, (boxWarmTries.get(id) || 0) + 1);
  try {
    // A prior pass may have cached a gate stub (empty box). Drop it so this pass
    // actually re-hits Presto instead of reading the empty cache straight back.
    const cached = boxCache.get(id);
    if (cached && !boxLooksComplete(cached.data)) boxCache.delete(id);
    const res = await fetchBoxPage(id);
    if (res && res.ok && boxLooksComplete(res.data)) boxWarmDone.add(id); // hot + cached
    else if (res && res.ok) boxCache.delete(id);   // gate still up — retry next poll
  } catch (e) { logErr('warmFinalBox', e); }
  finally { boxWarmInflight.delete(id); }
}
// ---- Box-score season-line fallback -----------------------------------------
// A just-debuted player can have real box-score lines for a game or two while
// Presto has not yet posted those games to their individual player page or the
// season leaderboard (both of which the roster reads), leaving their card blank
// in the meantime. As a fallback, read the player's per-game batting/pitching
// line straight from the completed Gators box scores and aggregate them with the
// same aggBat/aggPit the player-page game log uses, so the season line has the
// identical shape. Batting cols are name,AB,R,H,RBI,BB,K…; pitching cols are
// name,IP,H,R,ER,BB,K…; HR isn't a batting column so it's read from the notes.
function boxRowsForPlayer(boxData, normTarget) {
  const bat = [], pit = [];
  for (const sec of (boxData && boxData.box) || []) {
    if (!/Gator/i.test(sec.label || '')) continue;
    const isBat = /Batting/i.test(sec.label), isPit = /Pitching/i.test(sec.label);
    if (!isBat && !isPit) continue;
    // Per-game HR count for each batter from the notes ("Name" or "Name (2)").
    const hrBy = {};
    if (isBat && sec.notes && sec.notes.HR) {
      String(sec.notes.HR).split(',').forEach(part => {
        const m = part.match(/^\s*(.+?)\s*(?:\((\d+)\))?\s*$/);
        if (m) { const nm = normPlayerName(m[1]); if (nm) hrBy[nm] = m[2] ? +m[2] : 1; }
      });
    }
    for (const row of rowsOf(sec.html)) {
      const cells = cellsOf(row); if (cells.length < 7) continue;
      if (normPlayerName(bsBatterName(cells[0])) !== normTarget) continue;
      const num = i => bsText(cells[i]).replace(/[^0-9.]/g, '');
      if (isBat) bat.push({ ab: num(1), h: num(3), hr: String(hrBy[normTarget] || 0), rbi: num(4), bb: num(5), k: num(6) });
      else pit.push({ ip: num(1), h: num(2), r: num(3), er: num(4), bb: num(5), k: num(6) });
      break; // one row per player per table
    }
  }
  return { bat, pit };
}
// Fill each still-statless roster player from the Gators box scores. Fetches each
// final's box once (cached) and checks every target against it, then aggregates.
// Marks the result fromBox so the poll keeps re-checking the real player page and
// replaces it the moment Presto posts official stats (see storePlayer).
async function fillStatsFromBoxes(players) {
  if (!players || !players.length) return;
  const targets = players.map(pl => ({ pl, norm: normPlayerName(pl.name), bat: [], pit: [] }));
  const finals = (games || []).filter(g => g.state === 'final' && isGatorsGame(g));
  for (const g of finals) {
    // A recent game's box can be transiently bot-gated or rate-limited (the poll
    // fetches every final's box in quick succession, which is exactly what trips
    // the source's limiter). Without a retry the scan silently skips that game —
    // so a player whose only appearance is in it, and who has no Presto player
    // page yet, never gets a line. Back off and retry a few times, and require a
    // COMPLETE box (a stub parses to an empty one) before trusting it.
    let res = null;
    for (let a = 0; a < 4; a++) {
      try { res = await fetchBoxPage(g.id); } catch (e) { res = null; }
      if (res && res.ok && res.data && boxLooksComplete(res.data)) break;
      await sleep(1200 * (a + 1));
    }
    if (!res || !res.ok || !res.data || !boxLooksComplete(res.data)) continue;
    for (const t of targets) { const r = boxRowsForPlayer(res.data, t.norm); t.bat.push(...r.bat); t.pit.push(...r.pit); }
    await sleep(150);
  }
  for (const t of targets) {
    const hit = t.bat.length ? aggBat(t.bat) : null;
    const pit = t.pit.length ? aggPit(t.pit) : null;
    if (hit || pit) rosterStats[t.pl.slug] = { kind: pit ? 'pitching' : 'batting', hit, pit, hitRanks: {}, pitRanks: {}, fromBox: true };
  }
}
// Gmail transport, shared by the daily visitor-analytics digest.
let _mailer = null;
function getMailer() { if (!_mailer && mailReady) _mailer = nodemailer.createTransport({ service: 'gmail', auth: { user: MAIL_USER, pass: MAIL_PASS } }); return _mailer; }
// On-demand fetch of one opposing batter's own Presto player page — the same
// scrape fetchPlayer runs for Gators, just triggered by a box score sighting
// instead of the roster poll. Concurrent callers (multiple viewers of the same
// live box) share one in-flight fetch instead of each hitting Presto.
const oppAvgInflight = {};
function fetchOpponentAvg(slug) {
  if (oppAvgInflight[slug]) return oppAvgInflight[slug];
  const p = fetchPlayer(slug, null, null, 2)
    .then(rec => { storePlayer(slug, rec); saveCache(); })
    .catch(() => {})
    .finally(() => { delete oppAvgInflight[slug]; });
  oppAvgInflight[slug] = p;
  return p;
}
// Return a copy of the cached box data with a live season-AVG column added to
// each batting table. Done here (not in parseBoxscore) so the cached box — which
// for a final game is kept forever — never freezes a stale average; the column
// reflects the roster/leaderboard as of this request. Any batter (Gators or
// opponent) never seen before is fetched and awaited so their AVG shows on this
// very view; one already cached but stale (RECORD_TTL_MS) just refreshes quietly
// in the background so a live box's frequent polling never stalls on a re-scrape.
async function boxWithSeasonAvg(data) {
  if (!data || !Array.isArray(data.box)) return data;
  const slugs = new Set();
  for (const sec of data.box) {
    if (!/\bBatting\b/i.test(sec.label || '') || !sec.slugs) continue;
    for (const slug of Object.values(sec.slugs)) if (slug) slugs.add(slug);
  }
  const unseen = [...slugs].filter(s => !rosterStats[s]);
  if (unseen.length) await Promise.all(unseen.map(s => netLimit(() => fetchOpponentAvg(s))));
  for (const s of slugs) if (rosterStats[s] && !recFresh(playerCache[s])) netLimit(() => fetchOpponentAvg(s));
  return Object.assign({}, data, { box: data.box.map(sec =>
    /\bBatting\b/i.test(sec.label || '') ? Object.assign({}, sec, { html: bsAddSeasonAvg(sec.html, sec.slugs) }) : sec) });
}
// ---- opponent lineup AVGs from each team's own Presto page (like Gators) -----
// The live gamecast lineup only gets names from the feed, and the league
// leaderboard drops hitters under its min-AB cutoff — so an opponent bench bat
// shows no average there. Pull opponents' season AVGs the same way the Gators'
// (and the box score's) are: every team's Presto page lists its full roster with
// a link to each player's own page (which carries his season line). We cache each
// opponent team's name->slug map, then let seasonAvgFor read the player-page AVG
// that fetchOpponentAvg parks in rosterStats. Scoped to teams we display; daily.
let teamRosterSlugs = {};    // teamId -> { byName: {normName: slug}, ts }
let teamRosterLoading = {};  // teamId -> Promise (dedupes concurrent loads)
const TEAM_ROSTER_TTL_MS = 20 * 60 * 60 * 1000;
// A Presto team page lives at /teams/<name with no spaces or punctuation>, e.g.
// the San Antonio River Monsters at /teams/sanantoniorivermonsters.
function teamPageSlug(teamId) {
  const nm = TEAMS[teamId] && TEAMS[teamId].name;
  return nm ? nm.toLowerCase().replace(/[^a-z0-9]/g, '') : null;
}
// name -> Presto slug for every player in a team page's roster table (the one
// whose header has a "Name" column; each row links to the player's own page).
function parseTeamRosterSlugs(html) {
  const out = {};
  for (const t of (html.match(/<table\b[\s\S]*?<\/table>/gi) || [])) {
    const rows = rowsOf(t); if (rows.length < 2) continue;
    const hd = cellsOf(rows[0]).map(x => bsText(x).toLowerCase());
    const ni = hd.indexOf('name'); if (ni === -1) continue;
    for (let i = 1; i < rows.length; i++) {
      const c = cellsOf(rows[i]); if (c.length <= ni) continue;
      const a = firstLink(c[ni]); const slug = slugFromHref(a.href); const key = normPlayerName(a.text);
      if (slug && key) out[key] = slug;
    }
    if (Object.keys(out).length) break;
  }
  return out;
}
async function ensureTeamRoster(teamId) {
  if (!teamId || teamId === GATORS_ID) return null;
  const cur = teamRosterSlugs[teamId];
  if (cur && Date.now() - cur.ts < TEAM_ROSTER_TTL_MS) return cur.byName;
  if (teamRosterLoading[teamId]) return teamRosterLoading[teamId];
  const tslug = teamPageSlug(teamId); if (!tslug) return cur ? cur.byName : null;
  teamRosterLoading[teamId] = (async () => {
    try {
      const tp = await fetchText(SPORT_BASE + '/teams/' + tslug, SPORT_BASE + '/schedule');
      const byName = tp.ok ? parseTeamRosterSlugs(tp.body) : {};
      if (Object.keys(byName).length) teamRosterSlugs[teamId] = { byName, ts: Date.now() };
    } catch (e) { logErr('ensureTeamRoster', e); }
    finally { delete teamRosterLoading[teamId]; }
    const now = teamRosterSlugs[teamId] || cur;
    return now ? now.byName : null;
  })();
  return teamRosterLoading[teamId];
}
// Fire-and-forget: resolve the opponent lineup's slugs from their team page, then
// fetch each hitter's own player page into rosterStats (the same scrape the box
// score runs via fetchOpponentAvg). The averages land before the gamecast's next
// poll, so its lineup shows every bat's season AVG — including leaderboard omits.
async function loadOpponentLineupAvgs(teamId, names) {
  try {
    const byName = await ensureTeamRoster(teamId);
    if (!byName) return;
    const slugs = new Set();
    for (const nm of (names || [])) { const s = byName[normPlayerName(nm)]; if (s) slugs.add(s); }
    for (const s of slugs) if (!rosterStats[s] || !recFresh(playerCache[s])) netLimit(() => fetchOpponentAvg(s));
  } catch (e) { logErr('loadOpponentLineupAvgs', e); }
}
// Warm the opponent's ENTIRE roster once per game (loadOpponentLineupAvgs only
// covers the current nine). Bench bats, pinch hitters, and due-up players are all
// cached ahead of time, bounded by the shared scrape limiter, so the eager
// per-batter fetch on the live card almost never has to block. Runs at most once
// per game; if the team page itself failed, the guard is cleared so the next poll
// retries. Fire-and-forget — the fetches land in rosterStats for later polls.
const rosterWarmed = new Set();  // gameId -> warmed
async function warmOpponentRoster(gameId, teamId) {
  if (!gameId || rosterWarmed.has(gameId) || !teamId || teamId === GATORS_ID) return;
  rosterWarmed.add(gameId);
  try {
    const byName = await ensureTeamRoster(teamId);
    if (!byName) { rosterWarmed.delete(gameId); return; }
    for (const s of new Set(Object.values(byName))) {
      if (rosterStats[s] && recFresh(playerCache[s])) continue;
      netLimit(() => fetchOpponentAvg(s));
    }
  } catch (e) { rosterWarmed.delete(gameId); logErr('warmOpponentRoster', e); }
}
app.get('/api/boxscore', async (q, r) => {
  const id = q.query && q.query.id;
  try {
    if (!id) return r.status(400).json({ error: 'pass ?id=YYYYMMDD_xxxx' });
    const res = await fetchBoxPage(id);
    if (!res.ok) {
      // Source is rate-limiting: serve the last good copy rather than failing.
      const cached = boxCache.get(id);
      if (cached) { r.set('Cache-Control', 'public, max-age=120'); return r.json(await boxWithSeasonAvg(cached.data)); }
      const e = boxErrorResponse(res.status);
      return r.status(e.status).json(e.body);
    }
    r.set('Cache-Control', 'public, max-age=300');
    const data = await boxWithSeasonAvg(res.data);
    r.json(q.query.debug && res.types ? Object.assign({}, data, { types: res.types }) : data);
  } catch (err) {
    const cached = boxCache.get(id);
    if (cached) { r.set('Cache-Control', 'public, max-age=120'); return r.json(await boxWithSeasonAvg(cached.data)); }
    r.status(500).json({ error: String(err && err.message || err) });
  }
});
// ---- private analytics page shell ------------------------------------------
// HTML-escape helper shared by the /stats page and the daily visitor-digest email.
function repEsc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});}
function reportPage(title,bodyHtml){
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    +'<meta name="viewport" content="width=device-width, initial-scale=1">'
    +'<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">'
    +'<title>'+repEsc(title)+'</title><style>'
    +':root{--bayou:#16102b;--bayou2:#1e1640;--line:#41327a;--gold:#ecc913;--gold2:#ffd633;--purple:#714ad2;--bone:#f0ede4;--mute:#9a8cc4;--win:#7BD88F;--loss:#e0524a;}'
    +'*{box-sizing:border-box;}body{margin:0;background:var(--bayou);color:var(--bone);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.45;padding:18px 14px 48px;}'
    +'.rwrap{max-width:760px;margin:0 auto;}'
    +'.rh{text-align:center;margin-bottom:6px;}.rh .rt{font-family:Georgia,serif;font-weight:800;font-size:24px;color:var(--gold);letter-spacing:.5px;}'
    +'.rd{text-align:center;color:var(--mute);font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:14px;}'
    +'.rscore{text-align:center;font-size:30px;font-weight:800;margin:10px 0 2px;}'
    +'.rres{display:inline-block;font-weight:800;font-size:13px;letter-spacing:.1em;text-transform:uppercase;padding:3px 10px;border-radius:999px;}'
    +'.rres.w{color:var(--win);background:rgba(123,216,143,.12);}.rres.l{color:var(--loss);background:rgba(224,82,74,.12);}.rres.t{color:var(--mute);background:rgba(154,140,196,.12);}'
    +'.rmatch{text-align:center;color:var(--bone);font-size:14px;margin:4px 0 2px;}'
    +'.sec{font-family:Georgia,serif;font-weight:700;font-size:16px;color:var(--gold2);margin:24px 0 8px;border-bottom:1px solid var(--line);padding-bottom:5px;}'
    +'.subh{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);font-weight:700;margin:14px 0 5px;}'
    +'.rtw{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:10px;background:var(--bayou2);margin-bottom:6px;}'
    +'.rtw table{width:100%;border-collapse:collapse;font-size:13px;white-space:nowrap;}'
    +'.rtw th{background:rgba(113,74,210,.18);color:var(--mute);font-size:10px;letter-spacing:.05em;text-transform:uppercase;text-align:right;padding:7px 9px;font-weight:700;}'
    +'.rtw th:first-child{text-align:left;}'
    +'.rtw td{padding:7px 9px;border-top:1px solid var(--line);text-align:right;}.rtw td:first-child{text-align:left;font-weight:600;}'
    +'.rtw b{color:var(--gold2);}'
    +'.plist{list-style:none;margin:0;padding:0;}.plist li{padding:7px 2px;border-top:1px solid var(--line);font-size:13.5px;}.plist li:first-child{border-top:none;}'
    +'.pinn{display:inline-block;min-width:96px;color:var(--gold2);font-size:11px;font-weight:700;letter-spacing:.03em;}'
    +'.pteam{color:var(--mute);font-size:11px;}'
    +'.mlist li{color:#ffd9d5;}.klist li{color:#e9ffe0;}'
    +'.empty{color:var(--mute);font-size:13px;font-style:italic;padding:6px 2px;}'
    +'.foot{margin-top:30px;text-align:center;color:var(--mute);font-size:11px;}'
    +'</style></head><body><div class="rwrap">'+bodyHtml+'</div></body></html>';
}
function reportError(msg){return reportPage('Gators','<div class="rh"><div class="rt">Gators</div></div><p class="empty" style="text-align:center">'+repEsc(msg)+'</p>');}
// Private-page gate: locked entirely unless REPORT_KEY is configured, then it
// requires a matching ?key=. Returns true when access is allowed; otherwise it
// sends the locked page and returns false.
function reportLocked(q, r) {
  if (!REPORT_KEY) { r.status(403).type('html').send(reportError('This page is private. The site owner needs to set a REPORT_KEY to enable it.')); return true; }
  if (!q.query || String(q.query.key || '') !== REPORT_KEY) { r.status(403).type('html').send(reportError('This page is private.')); return true; }
  return false;
}
// Private daily unique-visitor report, gated by REPORT_KEY.
app.get('/stats', (q, r) => {
  if (reportLocked(q, r)) return;
  const today = todayCentralYmd();
  const rows = statsRows(60);
  const past = rows.filter(x => x.day !== today);
  const todayN = visitCounts[today] || 0;
  const wk = past.slice(0, 7), weekTotal = wk.reduce((s, x) => s + x.n, 0);
  const avg = wk.length ? Math.round(weekTotal / wk.length) : 0;
  let body = '<div class="rh"><div class="rt">Site Visitors</div></div><div class="rd">Unique viewers per day</div>';
  body += '<div class="rscore">' + todayN + '</div><div style="text-align:center;color:var(--mute);font-size:12px;margin-bottom:6px">today so far</div>';
  body += '<div class="subh">Last 7 days</div><div style="text-align:center;color:var(--bone);margin-bottom:4px">' + weekTotal + ' total · ~' + avg + '/day</div>';
  body += '<div class="sec">By day</div>';
  if (!rows.length) body += '<div class="empty">No visits recorded yet.</div>';
  else body += '<div class="rtw"><table><tr><th>Date</th><th>Unique viewers</th></tr>'
    + rows.map(x => '<tr><td>' + repEsc(x.label) + (x.day === today ? ' (today)' : '') + '</td><td>' + x.n + '</td></tr>').join('')
    + '</table></div>';
  body += '<div class="foot">Counts distinct visitors by hashed IP (no cookies, no raw IPs stored). Approximate.</div>';
  r.set('Cache-Control', 'no-store');
  r.type('html').send(reportPage('Site Visitors', body));
});
// Pitchers' rest chart JSON: every Gators pitcher's appearances + days of rest
// since their last outing, plus a per-game pitch-count breakdown. daysRest is
// computed here against today's Central date.
app.get('/api/rest', async (_q, r) => {
  try {
    const data = restWithLive(await getPitcherRest());
    const today = todayCentralYmd();
    const pitchers = data.pitchers.map(p => Object.assign({}, p, { daysRest: daysBetweenYmd(p.lastDate, today) }))
      .sort((a, b) => b.lastDate.localeCompare(a.lastDate) || (b.lastNp || 0) - (a.lastNp || 0));
    r.set('Cache-Control', 'no-store');
    r.json({ today, finals: data.finals, live: data.live, computedAt: data.computedAt, pitchers, byGame: data.byGame });
  } catch (err) {
    r.status(500).json({ error: String(err && err.message || err) });
  }
});
// Pitchers' rest chart page for the pitching coach — mirrors the layout of their
// hand-written pitch-count sheets so numbers can be cross-checked. Open (unlike
// /stats): the owner wants to pull it on demand without a key. A ?key= is still
// accepted but ignored, so the post-game Action's keyed render keeps working.
app.get('/rest', async (q, r) => {
  try {
    const data = restWithLive(await getPitcherRest());
    const today = todayCentralYmd();
    const vs = g => (g ? 'vs ' : '@ ');
    const mmdd = ymd => (+ymd.slice(4, 6)) + '/' + (+ymd.slice(6, 8));
    const restClass = d => d <= 1 ? 'hot' : d >= 4 ? 'cool' : 'warm';
    const showGames = !!(q.query && q.query.games);           // by-game detail is opt-in so the chart stays one screen
    // Compact, mobile-first styling: a single-line-per-pitcher list that fits a
    // phone width with no horizontal scroll. Injected here so the shared
    // reportPage shell stays generic.
    let body = '<style>'
      + '.rl{list-style:none;margin:8px 0 0;padding:0;border:1px solid var(--line);border-radius:12px;background:var(--bayou2);overflow:hidden;}'
      + '.rl li{display:flex;align-items:center;gap:9px;padding:6px 12px;border-top:1px solid var(--line);}'
      + '.rl li:first-child{border-top:none;}'
      + '.rn{flex:0 0 auto;min-width:20px;text-align:right;font-size:11px;font-weight:800;color:var(--gold2);font-variant-numeric:tabular-nums;}'
      + '.rnm{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700;font-size:15px;}'
      + '.rmeta{flex:0 0 auto;color:var(--mute);font-size:11.5px;font-variant-numeric:tabular-nums;text-align:right;}'
      + '.rmeta b{color:var(--gold2);font-weight:700;}'
      + '.rrd{flex:0 0 auto;min-width:36px;text-align:right;font-size:19px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1;}'
      + '.rrd i{font-size:10px;font-weight:700;color:var(--mute);font-style:normal;margin-left:1px;}'
      + '.rrd.hot{color:var(--loss);}.rrd.warm{color:var(--bone);}.rrd.cool{color:var(--win);}'
      + '.rlgd{color:var(--mute);font-size:11px;text-align:center;margin:7px 2px 0;line-height:1.4;}'
      + '.rlgd .hot{color:var(--loss);font-weight:700;}.rlgd .cool{color:var(--win);font-weight:700;}'
      + '.rlive{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.06em;color:#16102b;background:var(--gold2);border-radius:4px;padding:1px 4px;vertical-align:1px;}'
      + '.rmeta .lv{color:var(--gold2);font-weight:800;}'
      + '</style>';
    body += '<div class="rh"><div class="rt">Pitchers’ Rest</div></div>'
      + '<div class="rd">' + repEsc(ymdLabel(today)) + ' · ' + data.finals + ' games'
      + (data.liveGame ? ' · <span style="color:var(--gold2);font-weight:700">' + (data.liveGame.live ? 'LIVE ' : 'FINAL ') + repEsc(vs(data.liveGame.gatorsHome) + data.liveGame.oppShort) + '</span>' : '') + '</div>';
    const pitchers = data.pitchers.map(p => Object.assign({}, p, { daysRest: daysBetweenYmd(p.lastDate, today) }))
      .sort((a, b) => b.lastDate.localeCompare(a.lastDate) || (b.lastNp || 0) - (a.lastNp || 0));
    if (!pitchers.length) {
      body += '<div class="empty">No finished games with Gators pitching yet.</div>';
    } else {
      // One line per pitcher: number · name · last outing (pitches + date) · days rest.
      body += '<ul class="rl">' + pitchers.map(p =>
        '<li><span class="rn">' + (p.num != null ? p.num : '') + '</span>'
        + '<span class="rnm">' + repEsc(p.name) + (p.lastLive ? ' <span class="rlive">LIVE</span>' : '') + '</span>'
        + '<span class="rmeta"><b>' + (p.lastNp || 0) + 'p</b> · ' + (p.lastDate === today ? '<span class="lv">tonight</span>' : repEsc(mmdd(p.lastDate))) + '</span>'
        + '<span class="rrd ' + restClass(p.daysRest) + '">' + p.daysRest + '<i>d</i></span></li>').join('') + '</ul>';
      body += '<div class="rlgd">Big number = <b>days of rest</b>. <span class="hot">≤1 just threw</span> · <span class="cool">4+ rested</span> · <b style="color:var(--gold2)">Np</b> = pitches, last outing.</div>';
      // Per-game pitch counts (for cross-checking hand-written sheets) are opt-in
      // via ?games=1 so the default view stays a single mobile screen.
      // Per-game pitch counts are opt-in via ?games=1 so the default view stays a
      // single mobile screen. No on-page link — it can't work inside an exported
      // PDF (it would resolve to the render host), so it's reachable by URL only.
      if (showGames) {
        body += '<div class="sec">By game</div>';
        for (const g of data.byGame) {
          body += '<div class="subh">' + repEsc(g.dateLabel + ' · ' + vs(g.gatorsHome) + g.oppShort) + (g.live ? ' <span class="rlive">LIVE</span>' : (data.liveGame && g.id === data.liveGame.id ? ' <span class="rlive">FINAL</span>' : '')) + '</div>';
          body += '<ul class="plist">' + g.pitchers.map(pt =>
            '<li><span class="pinn">' + (pt.np || 0) + ' #P</span> ' + repEsc(pt.name) + '</li>').join('') + '</ul>';
        }
      }
    }
    r.set('Cache-Control', 'no-store');
    r.type('html').send(reportPage('Pitchers’ Rest', body));
  } catch (err) {
    r.status(500).type('html').send(reportError(String(err && err.message || err)));
  }
});
// The Gators schedule only changes on pollSchedule (~15s); live scores ride on
// /api/game, not here. So decorate+serialize at most once every few seconds and
// let concurrent viewers (a full stadium during a game) share the one payload
// instead of each triggering a fresh games.map(decorateGame) + JSON.stringify.
let _schedCache = { at: 0, json: null };
app.get('/api/schedule', (_q, r) => {
  r.set('Cache-Control', 'no-store');
  const now = Date.now();
  if (!_schedCache.json || now - _schedCache.at > 8000) {
    _schedCache = { at: now, json: JSON.stringify({ games: games.map(decorateGame) }) };
  }
  r.type('application/json').send(_schedCache.json);
});
// ----- playoff race: league game log, run diff, head-to-head, tie-breakers ---
// The standings feed only carries W/L/T + streak. Jared's TCL tie-breakers need
// run differential and head-to-head, which we reconstruct from every DECIDED
// game on the league schedule page (all eight teams, all dates). See
// docs/tcl-playoff-rules.md for the rules this implements.
//
// Parse the schedule HTML into a flat log of finals: { id, date, regulation,
// away:{id,score}, home:{id,score} }. Same chunking as parseLeagueScoreboard,
// but across every date and keeping only finals with two known teams and a
// score. A forfeit is a real W/L but not a "regulation" game (never played to
// completion), so it's excluded from the last-regulation-game tie-break.
function parseLeagueResults(html) {
  if (!html) return [];
  const re = /\/sports\/bsb\/\d{4}\/boxscores\/(\d{8})_([a-z0-9]+)\.xml/gi;
  const links = []; let m;
  while ((m = re.exec(html)) !== null) links.push({ id: m[1] + '_' + m[2], date: m[1], idx: m.index });
  const out = []; let prevEnd = 0; const seen = new Set();
  for (const link of links) {
    const chunk = html.slice(prevEnd, link.idx); prevEnd = link.idx + 1;
    if (seen.has(link.id)) continue;
    const cls = classify(chunk);
    if (cls.state !== 'final') continue;                       // decided games only
    const t = teamsFromChunk(chunk); if (!t) continue;
    const a = t.away, h = t.home;
    if (!a.id || !h.id || !TEAMS[a.id] || !TEAMS[h.id]) continue;   // both known teams
    if (a.score == null || h.score == null) continue;          // need a final score
    seen.add(link.id);
    out.push({ id: link.id, date: link.date, regulation: !/Forfeit/i.test(cls.status),
      away: { id: a.id, score: a.score }, home: { id: h.id, score: h.score } });
  }
  return out;
}
// Roll the game log up into per-team run differential and pairwise head-to-head.
//   rd[id]      = { rs, ra, w, l }                     season totals
//   h2h[a][b]   = { w, l, rs, ra }                     a's record/runs vs b
//   lastReg[a][b] = { date, winnerId }                 latest regulation meeting
function computeLeagueMetrics(log) {
  const rd = {}, h2h = {}, lastReg = {};
  const team = id => (rd[id] || (rd[id] = { rs: 0, ra: 0, w: 0, l: 0 }));
  const pair = (a, b) => { (h2h[a] || (h2h[a] = {})); return h2h[a][b] || (h2h[a][b] = { w: 0, l: 0, rs: 0, ra: 0 }); };
  for (const g of log || []) {
    const A = g.away, H = g.home;
    const ta = team(A.id), th = team(H.id);
    ta.rs += A.score; ta.ra += H.score; th.rs += H.score; th.ra += A.score;
    const aWon = A.score > H.score, hWon = H.score > A.score;
    if (aWon) { ta.w++; th.l++; } else if (hWon) { th.w++; ta.l++; }
    const pa = pair(A.id, H.id), ph = pair(H.id, A.id);
    pa.rs += A.score; pa.ra += H.score; ph.rs += H.score; ph.ra += A.score;
    if (aWon) { pa.w++; ph.l++; } else if (hWon) { ph.w++; pa.l++; }
    if (g.regulation && (aWon || hWon)) {
      const winnerId = aWon ? A.id : H.id;
      const prev = lastReg[A.id] && lastReg[A.id][H.id];
      if (!prev || g.date >= prev.date) {              // keep the latest meeting
        (lastReg[A.id] || (lastReg[A.id] = {}))[H.id] = { date: g.date, winnerId };
        (lastReg[H.id] || (lastReg[H.id] = {}))[A.id] = { date: g.date, winnerId };
      }
    }
  }
  return { rd, h2h, lastReg };
}
const seasonDiff = (metrics, id) => { const r = metrics.rd[id]; return r ? r.rs - r.ra : 0; };
const h2hRec = (metrics, a, b) => (metrics.h2h[a] && metrics.h2h[a][b]) || { w: 0, l: 0, rs: 0, ra: 0 };
const fmtDiff = n => (n > 0 ? '+' : '') + n;
// Two-team tie-break (Jared): games back → win% → H2H → run diff → run diff in
// H2H → last regulation game. Returns { d, by, detail }: d<0 ranks `a` ahead.
function cmpTwoTeam(a, b, metrics) {
  const gb = (b.w2 - b.l2) - (a.w2 - a.l2);            // 1. games back (games over .500)
  if (gb) return { d: gb, by: 'games back', detail: null };
  if (a.pct !== b.pct) return { d: b.pct - a.pct, by: 'win percentage', detail: null };  // 2.
  const ha = h2hRec(metrics, a.id, b.id);              // 3. head-to-head
  if (ha.w !== ha.l) return { d: ha.l - ha.w, by: 'head-to-head', detail: ha.w + '-' + ha.l };
  const da = seasonDiff(metrics, a.id), db = seasonDiff(metrics, b.id);  // 4. run differential
  if (da !== db) return { d: db - da, by: 'run differential', detail: fmtDiff(da) + ' vs ' + fmtDiff(db) };
  const hd = ha.rs - ha.ra;                            // 5. run diff in H2H games
  if (hd) return { d: -hd, by: 'run differential (H2H)', detail: fmtDiff(hd) };
  const lr = metrics.lastReg[a.id] && metrics.lastReg[a.id][b.id];       // 6. last regulation game
  if (lr && lr.winnerId === a.id) return { d: -1, by: 'last regulation game', detail: null };
  if (lr && lr.winnerId === b.id) return { d: 1, by: 'last regulation game', detail: null };
  return { d: 0, by: null, detail: null };
}
// Three-or-more-team tie-break (Jared): H2H among the tied teams → run diff →
// run diff in H2H among the tied teams. Returns teams ordered best-first plus a
// human note describing how the knot was settled.
function rankTiedGroup(group, metrics) {
  const key = t => {
    let w = 0, l = 0, hrd = 0;
    for (const o of group) { if (o.id === t.id) continue; const h = h2hRec(metrics, t.id, o.id); w += h.w; l += h.l; hrd += h.rs - h.ra; }
    return { id: t.id, hpct: (w + l) ? w / (w + l) : 0, hw: w, hl: l, diff: seasonDiff(metrics, t.id), hrd };
  };
  const keys = {}; group.forEach(t => { keys[t.id] = key(t); });
  const ordered = group.slice().sort((a, b) => {
    const ka = keys[a.id], kb = keys[b.id];
    return kb.hpct - ka.hpct || kb.diff - ka.diff || kb.hrd - ka.hrd;
  });
  const ka = keys[ordered[0].id], kb = keys[ordered[1].id];
  const by = ka.hpct !== kb.hpct ? 'head-to-head among tied teams'
    : ka.diff !== kb.diff ? 'run differential'
    : ka.hrd !== kb.hrd ? 'run differential in H2H games' : null;
  const names = ordered.map(t => t.short || t.name).join(' › ');
  return { ordered, note: by ? (names + ' — ' + by) : null };
}
// Fully rank the second-half standings, applying the tie-breakers within any set
// of teams level on both games-over-.500 and win%. Returns the ordered rows and
// a list of plain-language tie-break notes for the UI.
function rankSecondHalf(rows, metrics) {
  const base = rows.slice().sort((a, b) => (b.w2 - b.l2) - (a.w2 - a.l2) || b.pct - a.pct);
  const out = [], notes = [];
  for (let i = 0; i < base.length;) {
    let j = i + 1;
    while (j < base.length && (base[j].w2 - base[j].l2) === (base[i].w2 - base[i].l2) && base[j].pct === base[i].pct) j++;
    const group = base.slice(i, j);
    if (group.length === 1) { out.push(group[0]); }
    else if (group.length === 2) {
      const c = cmpTwoTeam(group[0], group[1], metrics);
      const ord = c.d <= 0 ? group : [group[1], group[0]];
      ord.forEach(x => out.push(x));
      if (c.by) {
        const w = ord[0], l = ord[1], nm = t => t.short || t.name;
        // Detail is always oriented winner-first so it matches the "W over L" text.
        let detail = null;
        if (c.by === 'head-to-head') {
          const h = h2hRec(metrics, w.id, l.id);
          detail = h.w + ' to ' + h.l;   // winner's record, e.g. "3 to 1"
        } else if (c.by === 'run differential') {
          detail = fmtDiff(seasonDiff(metrics, w.id)) + ' vs ' + fmtDiff(seasonDiff(metrics, l.id));
        } else if (c.by === 'run differential (H2H)') {
          const h = h2hRec(metrics, w.id, l.id);
          detail = fmtDiff(h.rs - h.ra);
        }
        notes.push(nm(w) + ' over ' + nm(l) + ' — ' + c.by + (detail ? ' (' + detail + ')' : ''));
      }
    } else {
      const r = rankTiedGroup(group, metrics);
      r.ordered.forEach(x => out.push(x));
      if (r.note) notes.push(r.note);
    }
    i = j;
  }
  return { rows: out, tiebreaks: notes };
}
// Build the four-team playoff bracket. Seeds 1-2 are the two first-half
// qualifiers (clinched), ordered by first-half record. Seeds 3-4 are the top two
// of the second half — but a team that placed top-2 in BOTH halves keeps its
// first-half seed (overlap rule), and the second-half berth it vacates passes to
// the best FULL-SEASON record among teams that didn't otherwise qualify. Ranked
// rows arrive already tie-broken. Matchups: 1v4 and 2v3, best-of-3.
function buildPlayoffPicture(ranked, metrics) {
  if (!ranked.length) return null;
  metrics = metrics || { rd: {}, h2h: {}, lastReg: {} };
  const pick = x => x ? { id: x.id, name: x.name, short: x.short, logo: x.logo || null, site: x.site || null } : null;
  const champs = ranked.filter(x => x.clinched).sort((a, b) => {
    const fa = FIRST_HALF_FINAL[a.id] || { w: 0, l: 0 }, fb = FIRST_HALF_FINAL[b.id] || { w: 0, l: 0 };
    const pa = (fa.w + fa.l) ? fa.w / (fa.w + fa.l) : 0, pb = (fb.w + fb.l) ? fb.w / (fb.w + fb.l) : 0;
    return pb - pa || fb.w - fa.w;
  });
  const fhIds = new Set(champs.map(x => x.id));
  const shTop2 = ranked.slice(0, 2);                          // top 2 of the second half
  const genuine = shTop2.filter(x => !fhIds.has(x.id));       // ones not already in via 1H
  const qualified = new Set([...fhIds, ...genuine.map(x => x.id)]);
  const open = 2 - genuine.length;                            // berths vacated by overlap
  const replacements = ranked.filter(x => !qualified.has(x.id))
    .sort((a, b) => b.pctSeason - a.pctSeason || (b.ws - b.ls) - (a.ws - a.ls) || seasonDiff(metrics, b.id) - seasonDiff(metrics, a.id))
    .slice(0, open);
  const lower = [...genuine, ...replacements];                // seed 3 then seed 4
  const lowNote = (x, i) => !x ? null
    : genuine.indexOf(x) !== -1 ? (i === 0 ? 'Second-half leader' : 'Second-half runner-up')
    : 'Best remaining full-season record';
  const seeds = [
    { seed: 1, team: pick(champs[0]), note: 'First-half champion', clinched: true },
    { seed: 2, team: pick(champs[1]), note: 'First-half champion', clinched: true },
    { seed: 3, team: pick(lower[0]), note: lowNote(lower[0], 0), provisional: true },
    { seed: 4, team: pick(lower[1]), note: lowNote(lower[1], 1), provisional: true },
  ];
  const notes = [];
  if (open > 0 && replacements.length) {
    const overlappers = shTop2.filter(x => fhIds.has(x.id)).map(x => x.short || x.name);
    notes.push((overlappers.join(' & ') || 'A first-half qualifier')
      + ' placed top-2 in both halves and keep' + (overlappers.length === 1 ? 's' : '') + ' a first-half seed, so '
      + (open === 1 ? 'the open second-half berth goes' : 'both open second-half berths go')
      + ' to the best remaining full-season record.');
  }
  return { format: 'Best-of-3', seeds, matchups: [[1, 4], [2, 3]], notes };
}
// Memoize the league metrics against the schedule fetch so we reparse only when
// pollSchedule brings in fresh HTML.
let _metricsCache = { at: -1, val: null };
function leagueMetrics() {
  if (_metricsCache.at !== lastFetchAt || !_metricsCache.val) {
    _metricsCache = { at: lastFetchAt, val: computeLeagueMetrics(parseLeagueResults(lastHtml)) };
  }
  return _metricsCache.val;
}
app.get('/api/standings', (_q, r) => {
  r.set('Cache-Control', 'no-store');
  if (!standingsTable.length) pollStandings();
  const metrics = leagueMetrics();
  const enriched = standingsTable.map(x => {
    // The feed reports full-season W-L; the second half = season − first-half
    // final (clamped at 0). Ranking, PCT and GB run off the second-half race.
    const base = (x.id && FIRST_HALF_FINAL[x.id]) || { w: 0, l: 0 };
    const sw = x.w, sl = x.l;
    const w2 = Math.max(0, sw - base.w), l2 = Math.max(0, sl - base.l);
    const g2 = w2 + l2, gs = sw + sl;
    return Object.assign({}, x, {
      w2, l2, ws: sw, ls: sl,
      pct: g2 ? w2 / g2 : 0,                       // second-half pct (drives sort/GB)
      pctSeason: gs ? (sw + x.t * 0.5) / gs : 0,   // full-season pct (tiebreak)
      diff: seasonDiff(metrics, x.id),             // season run differential
      site: TEAM_SITE[x.id] || null,
      clinched: (x.id && CLINCHED_PLAYOFF[x.id]) || null,
    });
  });
  const ranked = rankSecondHalf(enriched, metrics);
  const rows = ranked.rows;
  const lead = rows[0];
  for (const x of rows) x.gb = lead ? ((lead.w2 - x.w2) + (x.l2 - lead.l2)) / 2 : 0;
  r.json({ updatedAt: standingsAt, gatorsId: GATORS_ID, half: SEASON_HALF, rows,
    tiebreaks: ranked.tiebreaks, playoffs: buildPlayoffPicture(rows, metrics), scoreboard: buildLeagueBoard() });
});
app.get('/debug/extras', (_q, r) => {
  const sample = games.filter(g => g.state === 'live' || g.state === 'scheduled').slice(0, 4)
    .map(g => ({ id: g.id, location: gameLocation(g), watchUrl: watchUrlFor(g) }));
  r.json({
    watch: { keys: Object.keys(watchIndex).length, loadedAgoSec: watchLoadedAt ? Math.round((Date.now() - watchLoadedAt) / 1000) : null },
    photos: { matched: Object.keys(playerPhotos).length, of: ROSTER.length, loadedAgoSec: photosLoadedAt ? Math.round((Date.now() - photosLoadedAt) / 1000) : null,
      missing: ROSTER.filter(p => !playerPhotos[p.slug]).map(p => p.name) },
    sampleGames: sample,
  });
});
app.get('/api/roster', (_q, r) => { if (!rosterPolling && Object.keys(rosterStats).length === 0) pollRoster(); r.json(rosterPayload()); });
// Headshots are bundled in photos/ and served from our own origin.
app.get('/api/photo', (q, r) => {
  const slug = String((q.query && q.query.slug) || '');
  const file = /^[a-z0-9_]+$/i.test(slug) ? playerPhotos[slug] : null;
  if (!file || /[\\/]/.test(file)) return r.status(404).end();
  // Served from the boot-time in-memory cache; fall back to a disk read only if a
  // photo was added to the manifest after startup.
  let entry = photoBuffers[file];
  if (!entry) {
    try {
      const buf = fs.readFileSync(PHOTO_DIR + '/' + file);
      const ext = String(file).split('.').pop().toLowerCase();
      entry = photoBuffers[file] = { buf, type: PHOTO_TYPES[ext] || 'image/jpeg' };
    } catch (e) { return r.status(404).end(); }
  }
  r.set('Content-Type', entry.type);
  r.set('Cache-Control', 'public, max-age=604800');
  r.send(entry.buf);
});
app.get('/api/player', async (q, r) => {
  const slug = String((q.query && q.query.slug) || '');
  if (!/^[a-z0-9_]+$/i.test(slug)) return r.status(400).json({ error: 'bad slug' });
  try {
    const p = await getPlayer(slug);
    if (p && p.glPit && p.glPit.length) {
      const pl = ROSTER.find(x => x.slug === slug);
      await enrichPitchingWalks(pl ? pl.name : '', p.glPit);
    }
    if (p && p.hit) p.hitRanks = effectiveHitRanks(slug, p.hit, p.hitRanks);
    r.json(p || {});
  } catch (e) { r.status(502).json({ error: e.message }); }
});
app.get('/debug/walks', async (q, r) => {
  try {
    const slug = String((q.query && q.query.slug) || '');
    const pl = ROSTER.find(x => x.slug === slug);
    if (!pl) return r.status(404).json({ error: 'unknown slug', hint: 'use a slug from /api/roster' });
    const p = await getPlayer(slug);
    const key = nameKey(pl.name);
    const rows = [];
    for (const row of (p && p.glPit) || []) {
      const gid = gameIdForRow(row);
      const map = gid ? await boxWalks(gid) : null;
      rows.push({ date: row.date, opp: row.opp, gid, bbForPitcher: map ? (map[key] != null ? map[key] : null) : null,
        boxHasPitchers: map ? Object.keys(map).length : 0, boxNameKeys: map ? Object.keys(map) : null });
      await sleep(300);
    }
    r.json({ who: pl.name, nameKey: key, scheduleGames: games.length, rows });
  } catch (e) { r.status(502).json({ error: e.message, stack: e.stack }); }
});
app.get('/debug/box', async (q, r) => {
  try {
    const id = String((q.query && q.query.id) || '');
    if (!/^[0-9]{8}_[a-z0-9]+$/i.test(id)) return r.status(400).json({ error: 'pass ?id=YYYYMMDD_xxxx (from /debug/walks)' });
    const url = boxscoreUrl(id) + '?view=plays';
    const page = await fetchText(url, SCHEDULE_URL);
    const body = page.body || '';
    let counts = null, pitchingTables = 0, pitcherWalks = null, parseError = null;
    try {
      const p = parseBoxscore(body);
      counts = p.counts;
      const m = {};
      for (const b of p.box) { if (/Pitching/i.test(b.label)) { pitchingTables++; Object.assign(m, parsePitchingBB(b.html)); } }
      pitcherWalks = m;
    } catch (e) { parseError = String(e && e.message || e); }
    r.json({
      id, url, status: page.status, ok: page.ok, bytes: body.length, contentType: page.contentType,
      rawTableTags: (body.match(/<table\b/gi) || []).length,
      counts, pitchingTables, pitcherWalks, parseError, head: body.slice(0, 300),
    });
  } catch (e) { r.status(502).json({ error: String(e && e.message || e) }); }
});
app.get('/debug/standings', async (_q, r) => {
  try {
    const page = await fetchText(STANDINGS_URL, SCHEDULE_URL);
    const body = page.body || '';
    const tables = (body.match(/<table\b[\s\S]*?<\/table>/gi) || []).slice(0, 6).map(tbl => {
      const rows = rowsOf(tbl);
      const head = rows[0] ? cellsOf(rows[0]).map(c => bsText(c)) : [];
      const firstRows = rows.slice(1, 4).map(row => cellsOf(row).map(c => bsText(c)));
      return { headers: head, firstRows };
    });
    // team links reveal Presto team ids to match against game.away.id/home.id
    const teamLinks = (body.match(/href="[^"]*\/teams\/[a-z0-9]+"[^>]*>[^<]+/gi) || [])
      .slice(0, 30).map(s => {
        const id = (s.match(/\/teams\/([a-z0-9]+)/i) || [])[1];
        const name = bsText(s.replace(/^[^>]*>/, ''));
        return { id, name };
      });
    r.json({
      url: STANDINGS_URL, status: page.status, ok: page.ok, bytes: body.length, contentType: page.contentType,
      rawTableTags: (body.match(/<table\b/gi) || []).length,
      tables, teamLinks, head: body.slice(0, 300),
    });
  } catch (e) { r.status(502).json({ error: String(e && e.message || e) }); }
});
app.get('/debug/standings-map', async (_q, r) => {
  try {
    if (!Object.keys(standings).length) await pollStandings();
    const f = featured;
    const resolved = f ? { away: { name: f.away && f.away.name, record: recordStr(f.away) }, home: { name: f.home && f.home.name, record: recordStr(f.home) } } : null;
    r.json({ standingsAt, teams: Object.keys(standings).length, standings, featuredResolved: resolved });
  } catch (e) { r.status(502).json({ error: String(e && e.message || e) }); }
});
// Recompute season strike% on demand and show the per-game breakdown so the
// box-score aggregation can be verified against the real play-by-play.
app.get('/debug/strikepct', async (_q, r) => {
  try {
    const finals = (games || []).filter(g => g.state === 'final');
    let pitches = 0, strikes = 0; const perGame = [];
    for (const g of finals) {
      const res = await fetchBoxPage(g.id);
      const pbp = res && res.ok && res.data && res.data.pbp;
      if (!pbp || !pbp.length) { perGame.push({ id: g.id, pbp: 0 }); continue; }
      let gp = 0, gs = 0;
      for (const half of pbp) {
        const isTop = /top of/i.test(half.title || '');
        if (isTop !== !!g.gatorsHome) continue;
        const c = strikeCounts(half.html || ''); gp += c.pitches; gs += c.strikes;
      }
      pitches += gp; strikes += gs;
      perGame.push({ id: g.id, opp: g.opponent && g.opponent.short, gatorsHome: g.gatorsHome, pitches: gp, strikes: gs, pct: gp ? Math.round(gs / gp * 100) : null });
      await sleep(150);
    }
    await pollStrikePct();
    r.json({ seasonPct: pitches ? Math.round(strikes / pitches * 100) : null, pitches, strikes, games: perGame.length, cached: seasonStrikePct, perGame });
  } catch (e) { r.status(502).json({ error: String(e && e.message || e) }); }
});
app.get('/debug/roster', async (_q, r) => {
  try {
    const duhon = ROSTER.find(p => p.slug === 'davisduhons0vw');
    const pr = await fetchText(playerUrl(duhon.slug), SPORT_BASE + '/schedule');
    const parsed = parsePlayerPage(pr.body || '');
    const [hRes, pRes] = await Promise.all([fetchText(leagueStatsUrl('h')), fetchText(leagueStatsUrl('p'))]);
    const batMap = parseLeagueStats(hRes.body, 'h'), pitMap = parseLeagueStats(pRes.body, 'p');
    const rec = await fetchPlayer(duhon.slug, batMap, pitMap);
    r.json({
      pitcherFetch: { ok: pr.ok, status: pr.status, bytes: (pr.body || '').length, hasPlayerStats: (pr.body || '').indexOf('Player Stats') !== -1, hasERA: (pr.body || '').toLowerCase().indexOf('earned run average') !== -1 },
      pitcherParsed: { kind: parsed.kind, mapKeys: Object.keys(parsed.map), era: parsed.map.era, ip: parsed.map.ip, k: parsed.map.k },
      pitcherRecord: { kind: rec.kind, pit: rec.pit, hit: rec.hit },
      leagueHitGators: Object.keys(batMap).length, leaguePitGators: Object.keys(pitMap).length,
      cacheLoaded: Object.keys(rosterStats).length, rosterUpdated, polling: rosterPolling,
    });
  } catch (e) { r.status(502).json({ error: e.message, stack: e.stack }); }
});
// Dump the Gators team roster page's name -> real Presto slug map, and show how
// each roster entry currently resolves. Used to verify findSlug resolution picks
// up newly-active players (especially pitchers, who never appear on the league
// pitching leaderboard). Read-only, like the sibling /debug/* endpoints.
app.get('/debug/teamroster', async (_q, r) => {
  try {
    const url = SPORT_BASE + '/teams/' + GATORS_SLUG;
    const tr = await fetchText(url, SPORT_BASE + '/schedule');
    const byName = tr.ok ? parseTeamRosterSlugs(tr.body) : {};
    const roster = ROSTER.map(p => {
      const norm = normPlayerName(p.name);
      const teamSlug = byName[norm] || null;
      const s = rosterStats[p.slug];
      return { name: p.name, pos: p.pos, currentSlug: p.slug, teamPageSlug: teamSlug,
        matches: teamSlug === p.slug, findSlug: !!p.findSlug,
        hasStats: !!(s && (s.hit != null || s.pit != null)) };
    });
    r.set('Cache-Control', 'no-store');
    r.json({ url, ok: tr.ok, status: tr.status, teamRosterCount: Object.keys(byName).length,
      unresolved: roster.filter(x => !x.hasStats).map(x => x.name), roster });
  } catch (e) { r.status(502).json({ error: String(e && e.message || e) }); }
});
app.get('/debug/player', async (q, r) => {
  try {
    const slug = (q.query.slug || '').trim();
    const pl = ROSTER.find(p => p.slug === slug);
    if (!pl) return r.status(404).json({ error: 'unknown slug', hint: 'use a slug from /api/roster' });
    const pr = await fetchText(playerUrl(slug), SPORT_BASE + '/schedule');
    const body = pr.body || '';
    const strip = parseStatStrip(body);
    const parsed = parsePlayerPage(body);
    // Dump the raw game-log table headers + first data row so we can see the
    // actual column tokens (e.g. what the walks column is really called).
    const tables = body.match(/<table\b[\s\S]*?<\/table>/gi) || [];
    const glDump = [];
    for (const t of tables) {
      const rows = rowsOf(t); if (rows.length < 2) continue;
      const head = cellsOf(rows[0]).map(x => bsText(x).split(/\s+/)[0].toLowerCase());
      if (head.indexOf('opponent') === -1 && head.indexOf('date') === -1) continue;
      glDump.push({ kind: head.indexOf('ip') !== -1 ? 'pitching' : (head.indexOf('ab') !== -1 ? 'batting' : 'other'),
        headTokens: head, headRaw: cellsOf(rows[0]).map(x => bsText(x)), firstRow: cellsOf(rows[1]).map(x => bsText(x)) });
    }
    // Dump the "Player Stats" (Overall) tables' rows with every cell, so we can
    // see exactly which column holds the rank for hitting vs pitching.
    const statDump = [];
    for (const t of tables) {
      const low = bsText(t).toLowerCase();
      const rows = rowsOf(t);
      const firstLabels = rows.slice(1, 6).map(row => bsText(cellsOf(row)[0] || ''));
      statDump.push({
        hasOverall: low.indexOf('overall') !== -1,
        looksBatting: low.indexOf('batting average') !== -1 || low.indexOf('slugging') !== -1,
        looksPitching: low.indexOf('earned run average') !== -1 || low.indexOf('innings pitched') !== -1,
        ncols: cellsOf(rows[0] || '').length,
        header: cellsOf(rows[0] || '').map(x => bsText(x)),
        firstLabels,
        sampleRows: rows.slice(1, 4).map(row => cellsOf(row).map(x => bsText(x))),
      });
    }
    r.json({
      who: pl.name, slug,
      fetch: { ok: pr.ok, status: pr.status, bytes: body.length, hasPlayerStats: body.indexOf('Player Stats') !== -1, hasERA: body.toLowerCase().indexOf('earned run average') !== -1 },
      strip: { kind: strip.kind, map: flatVals(strip.map) },
      parsed: { kind: parsed.kind, keys: Object.keys(parsed.map), era: parsed.map.era && parsed.map.era.v, ip: parsed.map.ip && parsed.map.ip.v, k: parsed.map.k && parsed.map.k.v },
      statTables: statDump,
      gameLogTables: glDump,
      cached: rosterStats[slug] || null,
    });
  } catch (e) { r.status(502).json({ error: e.message, stack: e.stack }); }
});
// Inspect the league hitting leaderboard so we can compute hitting ranks for
// players whose own page has no batting "Overall" table (two-way players).
app.get('/debug/leaders', async (_q, r) => {
  try {
    const res = await fetchText(leagueStatsUrl('h'));
    const html = res.body || '';
    const tables = html.match(/<table\b[\s\S]*?<\/table>/gi) || [];
    let tbl = null, head = null;
    for (const t of tables) {
      const rows = rowsOf(t); if (rows.length < 2) continue;
      const hd = cellsOf(rows[0]).map(x => bsText(x).split(/\s+/)[0].toLowerCase());
      if (hd.indexOf('team') === -1) continue; tbl = t; head = hd; break;
    }
    if (!tbl) return r.json({ error: 'no leaderboard table', tables: tables.length });
    const rows = rowsOf(tbl); const all = [];
    for (let i = 1; i < rows.length; i++) {
      const c = cellsOf(rows[i]); if (c.length < 4) continue;
      const o = { col0: bsText(c[0]), slug: slugFromHref(firstLink(c[1]).href), teamId: teamIdFromHref(firstLink(c[2]).href) };
      for (let k = 3; k < c.length && k < head.length; k++) { if (head[k]) o[head[k]] = bsText(c[k]); }
      all.push(o);
    }
    r.json({
      header: head, totalLeagueHitters: all.length,
      gatorsId: GATORS_ID,
      sample: all.slice(0, 3),
      gators: all.filter(x => x.teamId === GATORS_ID),
      computedRanks: computeLeagueHitRanks(html),
    });
  } catch (e) { r.status(502).json({ error: e.message }); }
});
app.get('/api/vapidPublicKey', (_q, r) => r.json({ key: VAPID_PUB, enabled: pushReady }));
app.post('/api/subscribe', (q, r) => { if (!pushReady) return r.status(501).json({ error: 'push off' }); subscribers.add(q.body); r.json({ ok: true }); });
app.get('/api/test', (_q, r) => {
  if (!pushReady) return r.status(501).json({ ok: false, error: 'push not configured (set VAPID keys)' });
  notify('Test \uD83D\uDC0A', 'Push is working — you\u2019re all set', 'run');
  r.json({ ok: true, sentTo: subscribers.size });
});
// On-demand end-to-end test of the inning-text mailer, so a misconfigured
// deploy can be verified in seconds instead of waiting for a live inning
// boundary. Gated by REPORT_KEY (same as the other private pages) so it can't
// be used to spam the recipients. Sends one real text to INNING_ALERT_TO and
// returns the actual SMTP result — a wrong app password surfaces as the error.
app.get('/debug/testtext', async (q, r) => {
  if (!REPORT_KEY || String(q.query.key || '') !== REPORT_KEY) return r.status(403).json({ ok: false, error: 'set REPORT_KEY on the server and call with ?key=<REPORT_KEY>' });
  if (!INNING_ALERT_TO.length) return r.json({ ok: false, error: 'INNING_ALERT_TO not set' });
  const t = getMailer();
  if (!t) return r.json({ ok: false, mailReady, error: 'mailer off — set GMAIL_USER and GMAIL_APP_PASSWORD on the server' });
  try {
    await t.sendMail({ from: 'Gators GameTracker <' + MAIL_USER + '>', to: INNING_ALERT_TO.join(', '), text: 'Gators GameTracker test — inning texts are wired up 🐊' });
    r.json({ ok: true, recipients: INNING_ALERT_TO });
  } catch (e) { r.json({ ok: false, error: String(e && e.message || e) }); }
});
app.get('/api/stream', (q, r) => {
  r.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  r.flushHeaders(); r.write(':ok\n\n'); if (featured) r.write('data: ' + JSON.stringify({ type: 'game', game: featured }) + '\n\n');
  const hb = setInterval(() => { try { r.write(':hb\n\n'); } catch (e) {} }, 20000);
  sseClients.add(r); q.on('close', () => { clearInterval(hb); sseClients.delete(r); });
});

if (require.main === module) {
  loadCache(); // serve last-saved player stats instantly, then refresh below
  loadBoxCache(); // restore cached final box scores so we don't re-fetch them
  app.listen(PORT, () => { console.log('\nGators cloud on http://localhost:' + PORT + '  push:' + (pushReady ? 'on' : 'off') + '  texts:' + (INNING_ALERT_TO.length ? (mailReady ? 'on' : 'MISCONFIGURED') : 'off') + '\n');
    // Loud, actionable boot warning: recipients are set but the server has no
    // Gmail creds, so inning/final texts would silently no-op (getMailer null).
    // This is exactly the gap that hid a whole season of missing end-of-inning
    // texts — surface it instead of failing quietly.
    if (INNING_ALERT_TO.length && !mailReady) console.warn('[inning-alert] mailer NOT configured: INNING_ALERT_TO is set but GMAIL_USER/GMAIL_APP_PASSWORD are missing — no texts will send until they are set.');
    pollSchedule(); setInterval(pollSchedule, POLL_MS); setInterval(pollLive, LIVE_POLL_MS); pollRoster(); scheduleRosterRefresh(); pollWatch(); setInterval(pollWatch, 10 * 60 * 1000); pollReplays(); setInterval(pollReplays, 30 * 60 * 1000); loadLocalPhotos(); pollStandings(); setInterval(pollStandings, 30 * 60 * 1000); setTimeout(pollTickets, 8000); setInterval(pollTickets, 30 * 60 * 1000); setTimeout(pollStrikePct, 15000); setInterval(pollStrikePct, 3 * 60 * 60 * 1000); setTimeout(getPitcherRest, 20000); scheduleDailyStats(); });
}
module.exports = { parseSchedule, classify, teamsFromChunk, normalizeFeatured, summarizeLive, teamLineScores, summarizePlays, lineupsFromFeed, attachLineupSubLegend, pitchersFromFeed, extractEventAuth,
  dateFromId, ordinal, cap, shortName, fullName, scoreBetween, inningParts, parseBoxscore, parseStandings, applyStandingsOverride, MANUAL_STANDINGS_OVERRIDE, parseReplayList, msUntilNextCentralMidnight, parseLeagueStats, parseLeagueSlugs, parseTeamRosterSlugs, parseGameLog, boxRowsForPlayer, aggBat, aggPit, buildRecord, lineIsShowable, bsAddSeasonAvg, bsBatterName, bsBattingSlugs, ticketCandidates, parseLeagueScoreboard, todayCentralYmd, applyLiveScores, liveScoreCache, pick, finalIsFresh, noteFinals, finalSeenAt, assumedEndMs, feedGameOver, batterPriorPAs, summarizePlays, applyLivePitchCount, applyPitcherOverrides, pitchingTotals, strikeCounts, inningAlertText, finalAlertText,
  parseLeagueResults, computeLeagueMetrics, cmpTwoTeam, rankTiedGroup, rankSecondHalf, buildPlayoffPicture, boxLooksComplete, boxErrorResponse };

// ----- embedded service worker ---------------------------------------------
const SW = [
"self.addEventListener('install',function(){self.skipWaiting();});",
// On activation, take control and force every open window to reload. Because the
// fetch handler below serves navigations network-first (bypassing the HTTP cache),
// that reload pulls the current page even when an installed PWA has a stale shell
// pinned — which is otherwise unfixable from the server side.
"self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim().then(function(){return self.clients.matchAll({type:'window'}).then(function(cl){cl.forEach(function(c){if('navigate'in c){try{c.navigate(c.url);}catch(x){}}});});}));});",
// Navigations: network-first with the HTTP cache bypassed, so a new deploy is
// always picked up; fall back to a normal fetch if that fails. Everything else
// passes through untouched.
"self.addEventListener('fetch',function(e){var q=e.request;if(q.mode==='navigate'){e.respondWith(fetch(q,{cache:'reload'}).catch(function(){return fetch(q);}));}});",
"self.addEventListener('push',function(e){var d={title:'Gators',body:''};try{d=e.data.json();}catch(x){}",
"e.waitUntil(self.registration.showNotification(d.title||'Gators',{body:d.body||'',tag:d.tag||'g',renotify:true,icon:'icon.png',badge:'icon.png',vibrate:[80,40,80]}));});",
"self.addEventListener('notificationclick',function(e){e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(function(l){for(var i=0;i<l.length;i++){if('focus'in l[i])return l[i].focus();}if(clients.openWindow)return clients.openWindow('./');}));});"
].join('\n');

const MANIFEST = JSON.stringify({ name: 'Gators GameTracker', short_name: 'Gators', start_url: './', display: 'standalone', background_color: '#16102b', theme_color: '#16102b',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ] });

// ----- embedded app (no backticks inside) -----------------------------------
const APP = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="theme-color" content="#16102b"><link rel="manifest" href="manifest.json">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Gators">
<title>Gators GameTracker</title>
<meta name="description" content="Live scores, schedule, and roster for the Lake Charles Gumbeaux Gators.">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Gators GameTracker">
<meta property="og:title" content="Gators GameTracker">
<meta property="og:description" content="Live scores, schedule, and roster for the Lake Charles Gumbeaux Gators.">
<meta property="og:url" content="${SITE_URL}/">
<meta property="og:image" content="${SITE_URL}/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="628">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Gators GameTracker">
<meta name="twitter:description" content="Live scores, schedule, and roster for the Lake Charles Gumbeaux Gators.">
<meta name="twitter:image" content="${SITE_URL}/og.jpg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@500;600;700&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet">
<style>
:root{--bayou:#16102b;--bayou2:#1e1640;--panel:#2b1e5c;--line:#41327a;--gator:#b9a6ee;--gator2:#4e3191;--purple:#714ad2;--gold:#ecc913;--gold2:#ffd633;--bone:#f0ede4;--mute:#9a8cc4;--away:#e0524a;}
@font-face{font-family:'Kaushan Script';font-style:normal;font-weight:400;font-display:block;src:url(data:font/woff2;base64,d09GMgABAAAAAAfYAA0AAAAADYwAAAeFAAEAgwAAAAAAAAAAAAAAAAAAAAAAAAAAG4NEHBoGYABuEQgKjQiKWwE2AiQDMAsaAAQgBYUIByAbYAtRlDBSLsUXCTZnBrcdRrFVjVRsMQ67KY6zXDZo+UJav4982vp5fpt/LiU80CatKKzG4XDRAVuDNlgNRtQ6nr4fkavi99eGiMUXzywhpg327xDREBtjHZ5//3bu20Nq3iIsiGpe7GEaYMS/AP4LkPz/v18N/gCZSMskndahAY58c6djK6iCMvUL7FnAasuk1SVZUFqgVYFdxALfs24ICADGAkV9buetyoQCbgZa+diPBRUAJIooSKCE2eMAj3G6DheSsKy6riG12E1GRUucTsfARILG7zTjBrUG7zPxV4An8f/hTjH5NPFWxF/gC7DYWeWv0JoMwFn76mt9tI8/+jAx8dn3v038rCj2PoL/u/kDuAZA+5ap9hWHaf9TQhjiUqTl8mYDFkVQHKPoIgA6NJGJhgLBWBUyBjlG3UgeRyiIi8k5nxJUQHpKDqAg8dvoJ/hjNDKNRqLoUOkkKgAgOHHXfTypksC5wz6VAiePdhIF6K07E61oAZCALDGhhRg6kooBV+F51goGkIWd88gOZjO3jqdop3ZvWbcKABITKgB9egnKEiHEAqcErCjO69YDpEWLfcwEZZlJFCbJAflOAGjOOlx/jpE5N4lj7BbJCtyr6AVplYnGoQ6Hkt/iIpIRX8lULIBLYZo5wXQ/kmFyPBPHwcLgpH37U4KwbLuGyacE7QRB5DZUGyVWXL89ye7BoQaa+d3EYtMCkujHVd927sBhZNaGae4IKhpESEaI8YiXM2ijQq1WQdXR9WzlCCZHMrHX9uie3Vh3moGqzs5q9sh4djshru3vHxbndxGEo2rSpLPv4W8lqtBU1IjkGk0NkjU2djMV9/nKno4Osay2sdWysnF43lF937ljACeYVQ3wpEpMrunqypdxmQjRPq6Rqxid7GQrZ2Z6TCq6Nqovm1fhOM6rnZ/v53Y/ffiQqZjlS5UmVZd6soOKqWhnqlSgbEMPJp/qamjmqsOe8ltOM3hUx4yJpk8gayUIT4LIvTGOcKhl1OmtqGQqQNoPl3QMDDSNGI1LbrFvDWcEF9cS1bpq+7kqNfqyO3Cvh0Ss4045qAekfGWPieaKYGaiO2q6NlbV1XVgFRxZJTxNZDD50hTHmaqY0KStTan0mN4Kya4uYi/xlAiUzfvDh+enHVWTs73r2uf7h1HbxEwPSPMrGpB61L726tV+rqL7rh7cTTFeuk0Ft0Sbcp5/+11XFVvZMdFmorkz1af8BZ5F4YKnVnQDtlCa77sqSSSO7DpLOnKmcGPKpeOqFkleXGqwvy0ze4NRAG/S3CPQfUNMRFJe7MwBN8OEheLdr55JQrt031EXrsX9w3whO80omQktEimrXGLpR1jn9BuoG3X1jEUONMEJQxWjPs7KnJ8esCekMKTGu8Bm1zZdD7KIQ/guczrHMlvYEquMlPqvc4zuWoPZ3UjalHYxvTa23O/kYi3/+fkBzxA+TW+p7gRjMyc2sDasKkL+pPDfHCbLMY3kT2qwtYibxorlm40Q40v1A5KD7deE+2Yu37A22j3GL8jzaPJmcbysTLbxDX2/KFq4zHWzhzF+PWWJv6RU0SiFomlTsw3ux4LPhOz1F4U/i/9w0tR57TFRZWSP/tKhTdpa9jOWRK+Eysod4jHNzhEzBmY5sDqG4XLsYR3/y1W6W8i7wjb/eD7lUreAaqRHpRw+Ezl3k+YqXEtnpO8dW8ly8/vsSFeAYDRw0ABIKxebutxT3NPt4h3+25b64oKtX1EJT2BTRvrl28ceVonsFEv+fRbzsI53KvXA8qMbGeZRKQc4rPCJPB2S6b2/ksXrV2BjKSHxxp1G8aZpNHtxxFpYtDkbKxY6cXNdM0MTnDd5/fczdRfVf0Wk067E/HURdHfawpIhE977stvJAQFZFhtDBcu3zAiDIdE4lbfCeov9VsEDn+nHn8+uWNLvlJWxMlvsL9LXq0qw9HS7TpX901tS9110hEeq1Vo9oVRe7A2ThaSO/9j0JnNy6soMmt4VppPz2tUYigKD0Bi+6zQLDjS6PkskWZ+p8+hrdUi4g6VwXbLVEL+xp4ZtKgrTqlpSfUfinx5Wa+0FPp9qZg05UHsi7oBe6TOvv13g8j7sl3e1cQsuURdNZNHCFXQUh4odVgjEemmWbpSnuVF51LybHO0uqXGh0ojHSuTmWi53F0YFAIAAIKfbXt8+GznDXtL55N+oAO4ui98lDiVqen0q7TMdBqp3iIDAa4EmCmZOAcHnszIjrOQKyZO+zKJO3CDqSy4zqGSSJOWSIuHzo0KrTzMSljKgUCOAy3RIaKFmAKCLKkOGmOWQjEQvShlZYloWUogyKkH++Ck0LkWBWDt7D0cLM3NnAKPAAQGHx6OAJkS2tgNKNvaQtTXE9zLhFlAzFpRuhmInLfd2SkkzDUeJNXlrcBT78DRLZha2sVrTsO16iqFtvzJxtB1SsPNG0qKhRRtt8qDOO2jhbA60TZyaRNfoxDGQt7Md5uPqkI0JUIFcnMwhW6BDaZ6+d545xdtJeCYGFiq0/NNpqwl3tjC8YNAfNjqJsCN38xhcsITQzGRtKXpAMe2v0OIETwAAAA==) format('woff2'),url(data:font/ttf;base64,AAEAAAANAIAAAwBQR1BPU9qx6AwAAAugAAABxEdTVUJsjHSFAAANZAAAABpPUy8yjkeSBwAACCAAAABgY21hcAH/AgcAAAiAAAAAbmdhc3AAAAAQAAALmAAAAAhnbHlmbJW/VAAAANwAAAZ8aGVhZPli8rAAAAeUAAAANmhoZWEH8wDtAAAH/AAAACRobXR4FP0EFAAAB8wAAAAwbG9jYQt3CY4AAAd4AAAAGm1heHAAEQCTAAAHWAAAACBuYW1lPA1PTAAACPAAAAKIcG9zdP+7AC8AAAt4AAAAIAABAI3/tALkAuIAPQAAATIWFRQGByYnDgMHLgE1ND4CMzIWFRQGBy4BJz4BNTQjIgYHDgEVFB4CFz4DNw4BIyImJz4DAo8aHgICFRkGNEpYK4Z7TH6jWEVNISYXIgQiHDctZzRKRBIeKRggQDUlBBwzFx4tCBJFTksBPiQgCBEGBQEsYVVACwOFjWfBlls6NSM8IwcjFxkqHS5DP1m9dixINiACBzNFTyQGCx4aChYTDAAAAQDb/7QEewLhAFAAABcuATU0PgI3Mh4CFw4DFRQWFz4FNzIeAhcOAxUUFhc+BTceARcOBQcGIy4BJy4DNTQ2Nw4DBwYjLgHlBQUJDRAGDTEyJgMRGxIKAgIVNzs7MiMHDTMxJgIRGxIKAQIgRURANigLFzETHUpOT0Q1DhoZIDkMAwQCAQ4KFzg9Px4aGSA5HylhKkN7h59oDxQVByd/lp5FID4aH3OOm41xHQ8UFQcnf5aeRR05F1OjlYFlQgsDGxUXaYqclIAnDAQYERArKicOWblqRJyZizMMBBgAAQBT/+oCBAHKADQAAAEyHgIVDgMVFBYXDgEjIjU0Nw4DBy4BNTQ+AjceAxcOAxUUFz4BNz4DAboKGxYPFCIYDQwODCYPNiYUNDY3FyUuMEtYKQoZFxABKFVFLA4dTDYKGRoZAZQHCwwFKlVORBkcJQgICko5Yy5RPicEAkM0OHxqRwIDEhgZCQZCXWouEwUGV1sSLDAxAAACADz/swIIAxcAFQAnAAA3ND4ENx4DFw4DBy4DByIuAjU0PgIzMhYXDgOPHS46OzYUECUgGAIzZFVAEAwXEAoWDBYRCgYMEgscOQ4MEhIWvBtnfYV0VQ4DFx0gDCp9mK1aAwkQHPMLDxEFDCYjGScYDSEdFAAAAgBi/+4BsAKrABwAMwAANzQ+Ajc+AzceARcOAwcOAQcUBiMiLgITNDcuATU0PgI3Mh4CFw4DBy4BYgMIDQoCDhchFxE4FBcfGRUNCxIBAQUEGBkUvwMFBwUIDAYMIyQeCAskIhwEDBJDCRstQC0KLDEuCwQhHRo0ODwhHDsWEg8KFSAByAYMBRQICR8kJxANFRkLCycrJggCEQAAAQBL/84CZQHlAEgAAAEeARcOAwc+Azc+AzMyFhcUBgcOAxUUFjMyNjMeARUOAyMiLgI1ND4CNyIGBw4BBw4BBy4BJzQ+Ajc+AQEDGi4LCy4uJQMQJyUgCRM0OToYGiMKDw4OIyEWDQwLGAcEBQgWGBcJHSUVCAQMFhECMh0vSycWIQwVFAULExwRJj8B5Qg3IRtMT0cXES0tJQkUNS8hIxMCBxASP0lMHxkOCgINBQcODAgRHCcWDB4pOSgcHS1YNh8rBwwrFxM6R04nWGQAAAIAWv/dAeoB2QAVACgAABcuATU0PgI3NjMWFzI2MzIVFA4CAw4DFRQWFz4DNTQmJw4B1zlEGCw8IzcwIB8FCAU1KUllCREeFgwQCi1LNx8GByxFIwZYRChWUUgaKRE2AV4/cVw/AS4XNjczFBgsAwo3Umg7Gh4LDToAAQBJ/94B6AHgACsAADc+Azc+ATceAxcOAQc+ATc2MzIWFwYVFBcOAQcuAScOAwcuA0kFGSImEg0UDA4eHBYGGykVNlMkBg8OGgUSDQEZDxsqCi9CLyEPCRkZFBQdX2tsKx8jDAIKDg8HIFJAMFg2BQkIMC8sFgYiDw4xHSE/TWRFAQsQEgACABT/mAG6AgMAPgBKAAABDgMjJic0PgI1NCYjIgYVFBc+ATMWFRQHDgMVFBYVFAYHLgMnND4CNzQuAjU0PgI3HgMBPgM1DgMVFAG6AQsQEggLAgUGBQ0LKCoBFSEQAQQXGw4DAVtRDh4bFAQgN0ssCgsKFiQwGgslJBz+uRgrIBMUMCocAY4TKSEWAQ4DDRAQBg4TZGEKAgEBAgYJBAUHBgcGCBAMVGYIAQ4WGw4mRTUhAxkwLSsVGzUtIAYDHSQl/iwKJjA2GgMfKy4RFgAAAQB9/9IBzQJlADYAABMuATUeARc+AzcyHgIXDgEHMjY3HgEVBgcOAxUUFz4BNxYXDgMHLgM1ND4CN5wFCBowFA8jIR0ICh8gGgUeKxkUKRUFBjFGGScbDyEeNhUGAQYdIiAIGTIpGg0YIBMBfwYnDgIDAR47MSIFBwsMBiZBKgICBQ8IEgIwX1hOHywFBBYRCQYJGBcQAQEUHiUSGElWXi4AAQAAAAwAkgAEAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAWQDIARQBTwGdAgUCQgKFAu0C7QM+AAAAAQAAAAEAg2wUFQ5fDzz1ABkD6AAAAADLQNbgAAAAAMtA15r/MP6RBIQEPAAAAAkAAgAAAAAAAAG8ADwCigCNA7kA2wHWAFMBLAA8AOwAYgIcAEsBuQBaAZMASQFaABQA7gAAAWAAfQABAAAEPP6RAAAEMv8w/h0EhAABAAAAAAAAAAAAAAAAAAAADAADAYcBkAAFAAACvAKKAAAAjAK8AooAAAHdADIA+goGAwYGAgQHBQgCBQAAAAEAAAAAAAAAAAAAAABweXJzAEAAIAB0BDz+kQAABDwBbwAAAAEAAAAAAcQCygAAACAAAwAAAAIAAAADAAAAFAADAAEAAAAUAAQAWgAAABAAEAADAAAAIQBHAFcAYQBpAG8AdP//AAAAIABHAFcAYQBpAG4Acv//AAD/uv+r/6L/nP+YAAAAAQAQAAAAAAAAAAAAAAAIAAAACgAEAAgACQALAAAAAAAHAFoAAwABBAkAAAF4AAAAAwABBAkAAQAcAXgAAwABBAkAAgAOAZQAAwABBAkAAwBIAaIAAwABBAkABAAcAXgAAwABBAkABQAaAeoAAwABBAkABgAqAgQAQwBvAHAAeQByAGkAZwBoAHQAIAAoAGMAKQAgADIAMAAxADEALAAgAFAAYQBiAGwAbwAgAEkAbQBwAGEAbABsAGEAcgBpACAAKAB3AHcAdwAuAGkAbQBwAGEAbABsAGEAcgBpAC4AYwBvAG0AfABpAG0AcABhAGwAbABhAHIAaQBAAGcAbQBhAGkAbAAuAGMAbwBtACkALAANAEMAbwBwAHkAcgBpAGcAaAB0ACAAKABjACkAIAAyADAAMQAxACwAIABJAGcAaQBuAG8AIABNAGEAcgBpAG4AaQAuACAAKAB3AHcAdwAuAGkAawBlAHIAbgAuAGMAbwBtAHwAbQBhAGkAbABAAGkAZwBpAG4AbwBtAGEAcgBpAG4AaQAuAGMAbwBtACkALAANAHcAaQB0AGgAIABSAGUAcwBlAHIAdgBlAGQAIABGAG8AbgB0ACAATgBhAG0AZQAgAEsAYQB1AHMAaABhAG4AIABTAGMAcgBpAHAAdAAuAEsAYQB1AHMAaABhAG4AIABTAGMAcgBpAHAAdABSAGUAZwB1AGwAYQByAFAAYQBiAGwAbwBJAG0AcABhAGwAbABhAHIAaQA6ACAASwBhAHUAcwBoAGEAbgAgAFMAYwByAGkAcAB0ADoAIAAyADAAMQAxAFYAZQByAHMAaQBvAG4AIAAxAC4AMAAwADIASwBhAHUAcwBoAGEAbgBTAGMAcgBpAHAAdAAtAFIAZQBnAHUAbABhAHIAAwAAAAAAAP+4AC8AAAAAAAAAAAAAAAAAAAAAAAAAAAABAAH//wAPAAEAAAAKAB4ALAABbGF0bgAIAAQAAAAA//8AAQAAAAFrZXJuAAgAAAABAAAAAQAEAAIAAAACAAoAcgABABgABAAAAAcAKgA0ADoARABOAFQAXgABAAcAAwAFAAYABwAIAAkACwACAAH/6QAC/8YAAQAC//sAAgAB//YAAv/UAAIAAf/xAAL/ygABAAL/0wACAAH/+QAC/9MAAgAB//QAAv/VAAIA1gAEAAAA7AEGAAkACwAAAAAAAAAA//b/9wAAAAAAAAAAAAAAAP/R/9D/zwAA//L/+//f/9f/2AAAAAD/+wAA//sAAP/vAAD//AAAAAAAAAAAAAAAAAAAAAD/+QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/2AAAAAAAAAAAAAAAAAAD/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAkAAQACAAMABQAGAAcACAAJAAsAAQACAAoAAQACAAAAAwAEAAUABgAHAAAACAABAAEACwAGAAQAAQAKAAcACAADAAkAAgAAAAUAAQAAAAoAFgAYAAFsYXRuAAgAAAAAAAAAAAAA) format('truetype');}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html{margin:0;background:var(--bayou);}
body{margin:0;font-family:'Inter',system-ui,sans-serif;color:var(--bone);min-height:100vh;
background:transparent;-webkit-font-smoothing:antialiased;}
.bgfx{position:fixed;inset:0;z-index:-1;background-color:var(--bayou);
background:radial-gradient(1100px 550px at 50% -10%,rgba(111,79,212,.10),transparent 60%),linear-gradient(rgba(22,16,43,.12),rgba(22,16,43,.20)),url(${BG_PATH}) center center / cover no-repeat;}
.wrap{max-width:520px;margin:0 auto;padding:0 14px 40px;}
.topbar{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:9px;padding:14px 4px 12px;}
.topbar .tcllink{justify-self:start;display:inline-flex;}
.topbar .gglink{justify-self:center;display:inline-flex;max-width:100%;}
.topbar .shopbtn{justify-self:end;}
.gglogo{width:170px;max-width:100%;height:auto;object-fit:contain;}
.hdrlogo{height:48px;width:48px;object-fit:contain;border-radius:11px;flex:none;}
.hdrlogo.tcl{width:60px;height:60px;background:#fff;padding:5px;box-shadow:0 3px 10px -3px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.7);}
.lead{font-family:'Oswald',sans-serif;font-weight:700;letter-spacing:.06em;font-size:20px;text-transform:uppercase;background:linear-gradient(90deg,var(--gold2),var(--gold));-webkit-background-clip:text;background-clip:text;color:transparent;}
.sub{font-size:9.5px;letter-spacing:.28em;color:var(--mute);text-transform:uppercase;font-weight:600;margin-top:3px;}
.trail{justify-self:end;display:flex;flex-direction:column;align-items:stretch;gap:6px;}
.ticketbtn{display:flex;align-items:center;justify-content:center;gap:5px;font-family:'Oswald',sans-serif;font-weight:700;letter-spacing:.05em;text-transform:uppercase;font-size:10.5px;color:#1a1330;background:linear-gradient(180deg,var(--gold2),var(--gold));border:1px solid var(--gold);padding:7px 12px;border-radius:16px;text-decoration:none;white-space:nowrap;}
.shopbtn{display:flex;align-items:center;gap:6px;font-family:'Oswald',sans-serif;font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:10.5px;color:var(--gold2);background:rgba(236,201,19,.1);border:1px solid rgba(236,201,19,.3);padding:7px 12px;border-radius:16px;text-decoration:none;white-space:nowrap;}
.shopbtn .shoptxt{display:inline-block;line-height:1.1;text-align:center;}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(113,74,210,.5)}70%{box-shadow:0 0 0 8px rgba(113,74,210,0)}100%{box-shadow:0 0 0 0 rgba(113,74,210,0)}}
.jumbo{position:relative;border-radius:22px;overflow:hidden;border:1px solid var(--line);box-shadow:0 18px 40px -18px rgba(0,0,0,.8);padding:18px 16px;
background:linear-gradient(180deg,rgba(79,49,145,.30),transparent 40%),linear-gradient(180deg,var(--panel),var(--bayou2));}
.jumbo::before{content:"";position:absolute;inset:0;border-radius:22px;padding:1px;background:linear-gradient(135deg,rgba(236,201,19,.5),transparent 40%,rgba(139,92,246,.35));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;}
.sl{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:6px;}
.tm{display:flex;flex-direction:column;align-items:center;gap:8px;min-width:0;}
.tm img{width:54px;height:54px;border-radius:14px;object-fit:contain;background:transparent;}
.tm .tlogo{display:block;line-height:0;border-radius:14px;}
.tm a.tlogo[href]{cursor:pointer;transition:transform .12s ease,filter .12s ease;}
.tm a.tlogo[href]:hover{transform:scale(1.06);filter:drop-shadow(0 2px 6px rgba(0,0,0,.35));}
.tm a.tlogo[href]:focus-visible{outline:2px solid var(--gator);outline-offset:2px;}
.tm .nm{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.03em;font-size:12px;text-align:center;line-height:1.05;}
.tm .rec{font-family:'Inter',sans-serif;font-weight:600;font-size:11px;color:var(--mute);letter-spacing:.04em;margin-top:-4px;min-height:13px;}
.tm.gators .nm{color:var(--gator);}
.tm .sc{font-family:'Oswald',sans-serif;font-weight:700;font-size:60px;line-height:.9;}
/* Score color tracks the result, not the team: leader/winner in gold, trailer
   in light purple. A tie (or no result yet) leaves the default bone color. */
.tm.win .sc{color:var(--gold2);text-shadow:0 0 24px rgba(255,214,51,.4);}
.tm.lose .sc{color:var(--gator);text-shadow:0 0 24px rgba(113,74,210,.35);}
.sc.flash{animation:fl .9s ease;}@keyframes fl{0%{transform:scale(1)}30%{transform:scale(1.18);filter:brightness(1.5)}100%{transform:scale(1)}}
#fx{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;display:none;}
.mid{display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 2px;}
.statpill{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:12px;letter-spacing:.06em;color:var(--gold2);background:rgba(236,201,19,.08);border:1px solid rgba(236,201,19,.25);border-radius:999px;padding:6px 11px;text-align:center;text-transform:uppercase;white-space:nowrap;}
.statpill.live{color:var(--gator);background:rgba(113,74,210,.08);border-color:rgba(113,74,210,.3);}
.watchpill{display:inline-flex;align-items:center;gap:5px;font-family:'Oswald',sans-serif;font-weight:700;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#1a1330;background:linear-gradient(180deg,var(--gold2),var(--gold));border:1px solid var(--gold);border-radius:999px;padding:6px 12px;text-decoration:none;white-space:nowrap;}
.watchpill.replay{color:#fff;background:linear-gradient(180deg,var(--purple),var(--gator2));border-color:var(--purple);}
.vs{font-size:10px;color:var(--mute);letter-spacing:.1em;text-transform:uppercase;}
.note{margin-top:14px;font-size:11.5px;line-height:1.6;color:var(--mute);background:var(--bayou2);border:1px solid var(--line);border-radius:14px;padding:13px 15px;}
.bld{margin:20px 0 6px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.08em;color:var(--mute);opacity:.5;}
.note b{color:var(--bone);font-weight:600;}
.jloc{text-align:center;font-family:'Oswald',sans-serif;font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:10px;color:var(--mute);}
.jtheme{margin-top:6px;text-align:center;font-family:'Oswald',sans-serif;font-weight:700;letter-spacing:.04em;text-transform:uppercase;font-size:10.5px;color:#1a1330;background:linear-gradient(180deg,var(--gold2),var(--gold));border-radius:999px;padding:4px 11px;line-height:1.2;}
.jpromos{display:flex;flex-direction:column;align-items:center;}
.jpromo{margin-top:10px;text-align:center;font-size:10.5px;color:var(--mute);line-height:1.35;max-width:320px;}
.jpromo b{color:var(--gold2);font-family:'Oswald',sans-serif;text-transform:uppercase;letter-spacing:.03em;font-weight:700;}
.jloc:empty{display:none;}
.live{margin-top:14px;padding-top:14px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:13px;}
.lsit{display:flex;align-items:center;justify-content:center;gap:26px;}
.lsit.lend .lcell{min-width:0;}
.lsit.lend .ll{color:var(--gold2);}
.btwnote{text-align:center;color:var(--mute);font-size:11px;font-style:italic;letter-spacing:.04em;margin:8px auto 0;}
.lcell{text-align:center;min-width:46px;}
.lcell .lv{font-family:'Oswald',sans-serif;font-weight:700;font-size:21px;color:var(--bone);line-height:1;display:flex;gap:6px;justify-content:center;align-items:center;min-height:21px;}
.lcell .ll{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);margin-top:6px;}
.lcell .lv.count{gap:0;}
.cdig{display:inline-block;}
.cdig.cglow{animation:cglow 1s ease;}
@keyframes cglow{0%{color:var(--gold);text-shadow:0 0 11px rgba(255,214,51,.95),0 0 4px rgba(255,214,51,.85);}70%{color:var(--gold);text-shadow:0 0 6px rgba(255,214,51,.35);}100%{color:var(--bone);text-shadow:none;}}
.diamond{width:58px;height:50px;flex:none;}
.lastplay{display:flex;gap:9px;align-items:baseline;background:var(--bayou2);border:1px solid var(--line);border-left:3px solid var(--gold2);border-radius:9px;padding:7px 11px;margin:9px auto 0;max-width:420px;}
.lastplay.scored{border-left-color:#7BD88F;background:rgba(123,216,143,.09);}
.lastplay .lplab{font-family:'Oswald',sans-serif;font-weight:600;font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:var(--gold2);flex:none;line-height:1.5;}
.lastplay.scored .lplab{color:#7BD88F;}
.lastplay .lptx{font-size:12px;color:var(--bone);line-height:1.35;}
.lastplay.lpnew{animation:lpin .75s ease;}
@keyframes lpin{0%{transform:translateY(-5px);opacity:.15;box-shadow:0 0 0 2px rgba(255,214,51,.55);}60%{box-shadow:0 0 0 2px rgba(255,214,51,.18);}100%{transform:translateY(0);opacity:1;box-shadow:0 0 0 2px rgba(255,214,51,0);}}
.odot{display:inline-block;width:11px;height:11px;border-radius:50%;border:1.5px solid var(--mute);}
.odot.on{background:var(--gold);border-color:var(--gold);}
.lbp{display:flex;flex-direction:column;gap:7px;}
.bprow{display:flex;align-items:center;gap:10px;font-size:12.5px;}
.bpk{font-family:'Oswald',sans-serif;font-weight:600;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--gold2);min-width:84px;}
.bpn{color:var(--bone);font-weight:600;min-width:0;}
.mcard{background:var(--bayou2);border:1px solid var(--line);border-radius:10px;padding:9px 12px;}
.mrole{font-family:'Oswald',sans-serif;font-weight:600;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--gold2);}
.mname{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;color:var(--bone);font-weight:700;font-size:14px;margin-top:2px;}
.mmeta{font-family:'JetBrains Mono',monospace;font-weight:600;font-size:10.5px;color:var(--mute);letter-spacing:.03em;}
.mstat{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--gold2);margin-top:3px;}
.mprev{display:flex;flex-wrap:wrap;gap:3px 12px;margin-top:6px;padding-top:6px;border-top:1px solid var(--line);}
.mpa{font-size:11px;color:var(--mute);line-height:1.3;}
.mpa b{color:var(--bone);font-weight:600;font-family:'JetBrains Mono',monospace;font-size:10px;margin-right:3px;}
.mfirst{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-top:4px;}
.mfb{font-family:'Oswald',sans-serif;font-weight:700;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--bayou);background:var(--gold2);border-radius:5px;padding:1px 7px;}
.mfb.pinch{background:var(--purple);color:#fff;}
.mfbio{font-size:11px;color:var(--mute);}
.mfk{color:var(--mute);font-size:9px;letter-spacing:.04em;margin-right:1px;}
.mssn{font-family:'Oswald',sans-serif;font-weight:700;font-size:9px;letter-spacing:.07em;text-transform:uppercase;color:var(--mute);margin-right:5px;}
.mvs{text-align:center;font-family:'Oswald',sans-serif;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);margin:1px 0;}
.dueup{margin-top:14px;}
.duh{font-family:'Oswald',sans-serif;font-weight:600;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--gold2);margin-bottom:8px;}
.durow{display:flex;gap:8px;}
.duitem{flex:1;min-width:0;background:var(--bayou2);border:1px solid var(--line);border-radius:10px;padding:8px 10px;}
.dunum{font-family:'Oswald',sans-serif;font-size:9px;font-weight:700;letter-spacing:.08em;color:var(--mute);}
.dunm{font-weight:600;font-size:12px;color:var(--bone);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.duln{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--gold2);margin-top:3px;white-space:nowrap;overflow:hidden;}
.finalcard{display:flex;flex-direction:column;align-items:center;gap:13px;padding:6px 0 2px;}
.finalbtns{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}
.fbtn{font-family:'Oswald',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:11px;padding:9px 16px;border-radius:999px;border:1px solid var(--purple);background:linear-gradient(180deg,var(--purple),var(--gator2));color:#fff;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;}
.fbtn.rep{border-color:rgba(236,201,19,.5);background:linear-gradient(180deg,var(--gold2),var(--gold));color:#1a1330;}
.lsbox{overflow-x:auto;-webkit-overflow-scrolling:touch;}
.lstbl{width:100%;border-collapse:collapse;font-family:'JetBrains Mono',monospace;font-size:12.5px;}
.lstbl th{color:var(--mute);font-size:9px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;padding:4px 7px;text-align:center;}
.lstbl td{padding:6px 7px;text-align:center;color:var(--bone);border-top:1px solid var(--line);}
.lstbl .lsi{color:var(--mute);font-size:11.5px;min-width:18px;}
.lstbl .lsd{color:var(--bone);font-weight:700;border-left:1px solid var(--line);}
.lstbl th.lsd{color:var(--gold2);}
.lstbl td.lsn,.lstbl th.lsn{text-align:left;position:sticky;left:0;background:var(--bayou2);white-space:nowrap;}
.lstbl td.lsn{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.02em;}
.lstbl tr.g td{color:var(--gator);}
.lstbl tr.g td.lsn{color:var(--gator);font-weight:700;}
.lineup{margin-top:4px;}
.luh{font-family:'Oswald',sans-serif;font-weight:600;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--gold2);margin-bottom:8px;}
.lutabs{display:flex;gap:6px;margin-bottom:10px;}
.lutab{flex:1;text-align:center;font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.05em;font-size:10px;padding:8px 12px;border-radius:999px;border:1px solid var(--line);color:var(--mute);background:var(--bayou2);cursor:pointer;}
.lutab.on{color:#fff;background:linear-gradient(180deg,var(--purple),var(--gator2));border-color:var(--purple);}
.lubox{overflow-x:auto;-webkit-overflow-scrolling:touch;}
.lutbl{width:100%;border-collapse:collapse;font-size:12px;}
.lutbl th{color:var(--mute);font-size:9px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;padding:5px 4px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--line);}
.lutbl td{padding:7px 4px;border-top:1px solid var(--line);color:var(--bone);white-space:nowrap;}
.lutbl td.lus,.lutbl th.lus{color:var(--mute);text-align:center;}
.lutbl td.luu{font-family:'JetBrains Mono',monospace;color:var(--mute);}
.lutbl td.lunm{font-weight:600;width:100%;white-space:nowrap;}
.lutbl td.lut{font-family:'JetBrains Mono',monospace;color:var(--gold2);}
.lutbl tr.cur td{background:rgba(236,201,19,.10);}
.lutbl tr.cur td:first-child{box-shadow:inset 3px 0 0 var(--gold2);}
.lutbl tr.cur td.lunm{color:var(--gold2);}
.lutbl tr.lusub td{border-top:0;}
.lutbl tr.lusub td.lunm{padding-left:22px;}
/* Indent the sub's position + number along with his name, as one nested entry.
   A relative shift (not padding) so the POS/# columns keep the starters' width. */
.lutbl tr.lusub td .lucd{position:relative;left:20px;}
.lutbl td.lunm .lusublet{color:var(--mute);font-weight:400;margin-right:2px;}
.lusleg{display:flex;flex-wrap:wrap;gap:3px 14px;margin-top:10px;font-size:11px;color:var(--mute);line-height:1.45;}
.lusleg .lusl b{color:var(--gold2);font-weight:700;margin-right:3px;}
.lutbl td.lpn,.lutbl th.lpn{text-align:center;font-family:'JetBrains Mono',monospace;width:1%;white-space:nowrap;}
.lutbl tr.pttot td{border-top:2px solid var(--line);font-weight:700;color:var(--mute);}
.lutbl tr.pttot td.lunm{color:var(--bone);text-transform:uppercase;font-size:10px;letter-spacing:.06em;}
.lutbl td.lpn{color:var(--bone);}
.lutbl td.lavg{color:var(--gold2);}
.pthead{margin-top:10px;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--gold2);font-weight:700;padding:0 7px 3px;}
.pdec{color:var(--gold2);font-weight:700;font-size:10px;}
.lunotes{margin-top:10px;display:flex;flex-direction:column;gap:5px;}
.lunote{font-size:11.5px;line-height:1.45;color:var(--bone);}
.lunk{display:inline-block;min-width:18px;font-family:'Oswald',sans-serif;font-weight:700;font-size:10px;letter-spacing:.04em;color:var(--gold2);margin-right:6px;}
.pbp{margin-top:2px;}
.pbptabs{display:flex;gap:6px;margin-bottom:10px;}
.pbptab{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.05em;font-size:10px;padding:6px 12px;border-radius:999px;border:1px solid var(--line);color:var(--mute);background:var(--bayou2);cursor:pointer;}
.pbptab.on{color:#fff;background:linear-gradient(180deg,var(--purple),var(--gator2));border-color:var(--purple);}
.pbplist.full{max-height:46vh;overflow-y:auto;overflow-x:hidden;padding:0 6px;-webkit-overflow-scrolling:touch;}
.pbpih{font-family:'Oswald',sans-serif;font-weight:600;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--gold2);padding:9px 0 3px;}
.pbprow{padding:8px 0;border-top:1px solid var(--line);font-size:12.5px;line-height:1.45;}
.pbpempty{padding:10px 0;font-size:12px;color:var(--mute);font-style:italic;}
.pbpt{color:var(--bone);overflow-wrap:anywhere;}
.pbpout{color:var(--mute);font-style:italic;white-space:nowrap;}
.pbprow.sc{background:linear-gradient(90deg,rgba(236,201,19,.10),transparent);margin:0 -6px;padding-left:6px;padding-right:6px;border-radius:6px;}
.pbprow.sc .pbpt{color:var(--gold2);font-weight:600;}
.watchbtn{margin-top:12px;display:flex;align-items:center;justify-content:center;gap:8px;width:100%;font-family:'Oswald',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:13px;border-radius:14px;padding:13px;border:1px solid rgba(236,201,19,.45);background:rgba(236,201,19,.13);color:var(--gold2);text-decoration:none;}
.ctheme{margin-top:8px;font-family:'Oswald',sans-serif;font-weight:700;letter-spacing:.03em;text-transform:uppercase;font-size:10.5px;color:var(--gold2);background:rgba(236,201,19,.13);border:1px solid rgba(236,201,19,.4);border-radius:8px;padding:5px 9px;text-align:center;}
.cpromo{margin-top:6px;font-size:10px;color:var(--mute);line-height:1.35;text-align:center;}
.cpromo b{color:var(--gold2);font-family:'Oswald',sans-serif;text-transform:uppercase;letter-spacing:.03em;font-weight:700;}
.cfoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--line);}
.cloc{font-family:'Oswald',sans-serif;font-weight:600;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.watchmini{flex:none;display:flex;align-items:center;gap:5px;font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:10px;color:var(--gold2);border:1px solid rgba(236,201,19,.4);background:rgba(236,201,19,.1);border-radius:999px;padding:4px 10px;text-decoration:none;}
.watchmini.replay{color:var(--gator);border-color:rgba(113,74,210,.45);background:rgba(113,74,210,.12);}
.watchbtn.replay{color:var(--gator);border-color:rgba(113,74,210,.45);background:rgba(113,74,210,.13);}
.watchmini.tickets{color:#1a1330;border-color:var(--gold);background:linear-gradient(180deg,var(--gold2),var(--gold));font-weight:700;}
.watchbtn.ticket{color:#1a1330;border-color:var(--gold);background:linear-gradient(180deg,var(--gold2),var(--gold));}
.watchbtn.freead{color:#1a1330;border-color:var(--gold);background:linear-gradient(180deg,var(--gold2),var(--gold));cursor:default;text-transform:none;letter-spacing:.02em;font-size:12px;text-align:center;}
.watchmini.free{color:#1a1330;border-color:var(--gold);background:linear-gradient(180deg,var(--gold2),var(--gold));font-weight:700;}
.sec{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.08em;font-size:13px;color:var(--mute);margin:22px 4px 10px;}
.card{background:var(--bayou2);border:1px solid var(--line);border-radius:14px;padding:11px 13px;margin-bottom:8px;cursor:default;}
.card[data-state="final"]{cursor:pointer;}
.card.glive{border-color:rgba(113,74,210,.45);}
.card.gcancel{opacity:.5;}
.card.pinned{outline:1px solid rgba(236,201,19,.4);}
.ctop{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;}
.cdh{margin:-2px 0 7px;font-family:'Oswald',sans-serif;font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:9.5px;color:var(--gator);}
.cdate{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--mute);font-weight:700;}
.cpill{font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;border-radius:999px;border:1px solid var(--line);color:var(--mute);display:flex;align-items:center;gap:5px;}
.cpill.live{color:var(--gator);border-color:rgba(113,74,210,.4);background:rgba(113,74,210,.08);}
.cpill.live .dot{width:5px;height:5px;animation:pulse 1.8s infinite;}
.cpill.final{color:var(--gold);}
/* Upcoming game: gold the start-time pill so it reads as the card's accent,
   matching the Around-the-League scoreboard cards. */
.cpill.sched{color:var(--gold2);border-color:rgba(255,214,51,.35);background:rgba(255,214,51,.07);}
.crow{display:flex;align-items:center;gap:9px;padding:3px 0;}
.crow img{width:30px;height:30px;border-radius:6px;object-fit:contain;background:transparent;}
.crow .n{flex:1;min-width:0;font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;font-size:13px;line-height:1.18;overflow-wrap:anywhere;}
.tcity{font-weight:400;opacity:.72;}
.crow.g .n{color:var(--gator);}
.crow .s{font-family:'Oswald',sans-serif;font-weight:700;font-size:18px;min-width:22px;text-align:right;}
.crow.w .s{color:var(--gold2);}
/* Winner arrow points at the winning score; an equal-width empty slot on the
   losing row keeps the score column aligned. */
.crow .warrow{flex:none;width:11px;text-align:center;color:var(--gold2);font-size:11px;line-height:1;}
.toasts{position:fixed;top:14px;left:0;right:0;z-index:60;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;padding:0 14px;}
.a2hs{position:fixed;left:12px;right:12px;bottom:14px;max-width:520px;margin:0 auto;z-index:70;display:none;align-items:center;gap:11px;background:var(--bayou2);border:1px solid var(--line);border-radius:16px;padding:10px 12px;box-shadow:0 18px 44px -16px rgba(0,0,0,.85);}
.a2hs.show{display:flex;}
.a2hsico{width:42px;height:42px;border-radius:11px;flex:none;}
.a2hstxt{flex:1;min-width:0;display:flex;flex-direction:column;}
.a2hstxt b{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.03em;font-size:13px;color:var(--bone);}
.a2hstxt span{font-size:11px;color:var(--mute);margin-top:1px;}
.a2hsadd{flex:none;font-family:'Oswald',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:.04em;font-size:12px;color:#1a1330;background:linear-gradient(180deg,var(--gold2),var(--gold));border:1px solid var(--gold);border-radius:999px;padding:8px 16px;cursor:pointer;}
.a2hsx{flex:none;background:none;border:none;color:var(--mute);font-size:15px;cursor:pointer;padding:4px 2px;line-height:1;}
.toast{max-width:500px;width:100%;display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,var(--panel),var(--bayou2));border:1px solid rgba(236,201,19,.5);border-radius:14px;padding:12px 14px;box-shadow:0 16px 40px -12px rgba(0,0,0,.85);transform:translateY(-130%);opacity:0;transition:.45s cubic-bezier(.2,.9,.25,1);}
.toast.show{transform:translateY(0);opacity:1;}
.toast .e{font-size:24px;}.toast b{display:block;font-family:'Oswald',sans-serif;font-weight:700;text-transform:uppercase;font-size:14px;color:var(--gold2);}
.toast.lead{border-color:rgba(113,74,210,.5);}.toast.lead b{color:var(--gator);}
.toast span{font-size:12px;}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;}}
.modal{position:fixed;inset:0;z-index:80;background:rgba(8,5,16,.74);display:none;align-items:center;justify-content:center;padding:16px;}
.modal.show{display:flex;}
body.noscroll{overflow:hidden;}
.sheet{background:var(--bayou2);border:1px solid var(--line);border-radius:20px;overflow:hidden;width:100%;max-width:560px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 60px -20px rgba(0,0,0,.85);}
.shead{display:flex;align-items:center;gap:10px;padding:14px 16px 8px;}
.sttlwrap{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
.sttl{font-family:'Oswald',sans-serif;font-weight:700;text-transform:uppercase;font-size:14px;letter-spacing:.03em;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sdate{font-family:'Oswald',sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--gold2);letter-spacing:.14em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sscore{font-family:'Oswald',sans-serif;font-weight:700;font-size:16px;color:var(--gold2);flex:none;white-space:nowrap;}
.sclose{margin-left:auto;background:none;border:1px solid var(--line);color:var(--bone);border-radius:10px;width:34px;height:34px;font-size:15px;cursor:pointer;flex:none;}
.tabs{display:flex;gap:8px;padding:2px 16px 0;}
.tabb{flex:1;font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.05em;font-size:12px;padding:10px;border-radius:11px 11px 0 0;border:1px solid var(--line);border-bottom:none;color:var(--mute);background:transparent;cursor:pointer;}
.tabb.on{color:var(--bone);background:var(--panel);}
.sbody{padding:14px;overflow:auto;border-top:1px solid var(--line);}
.bxdate{font-family:'Oswald',sans-serif;font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--gold2);text-align:center;padding:0 0 12px;border-bottom:1px solid var(--line);margin-bottom:14px;}
.bx{margin-bottom:16px;}
.bx h4{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.1em;color:var(--gator);margin:0 0 6px;}
.bxwrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
.bxnotes{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px;font-size:11.5px;color:var(--bone);line-height:1.4;}
.bxnotes .bxn b{color:var(--gold2);font-family:'Oswald',sans-serif;font-weight:700;font-size:10px;letter-spacing:.04em;margin-right:4px;}
.bxleg{display:flex;flex-wrap:wrap;gap:3px 14px;margin-top:8px;font-size:11.5px;color:var(--mute);line-height:1.45;}
.bxleg .bxl b{color:var(--gold2);font-weight:700;margin-right:3px;}
.sbody table{width:100%;border-collapse:collapse;font-size:11px;}
.bx td,.bx th{padding:4px 6px;border-bottom:1px solid var(--line);text-align:center;white-space:nowrap;}
.bx th{color:var(--mute);font-weight:700;text-transform:uppercase;font-size:10px;}
.bx td:first-child,.bx th:first-child{text-align:left;position:sticky;left:0;background:var(--bayou2);}
.bx th:first-child{color:var(--bone);}
.bx th.bxsub{padding-left:24px;}
.bx td.bxavg{color:var(--gold2);font-family:'JetBrains Mono',monospace;}
.bx th.bxavg{color:var(--gold2);}
.bx .sublet{text-transform:none;color:var(--mute);font-weight:400;margin-right:1px;}
.bx th a.bxp{color:var(--bone);text-decoration:none;cursor:pointer;}
.bx th a.bxp:active{opacity:.6;}
.bx .dec{color:var(--gold2);font-weight:700;}
.pbp table{margin-bottom:12px;border:1px solid var(--line);border-radius:10px;overflow:hidden;}
.pbp tr:first-child th,.pbp tr:first-child td{background:var(--panel);color:var(--gold2);text-align:left;font-family:'Oswald',sans-serif;text-transform:uppercase;font-size:11px;letter-spacing:.05em;font-weight:700;padding:8px 10px;white-space:normal;}
.pbp td{text-align:left;white-space:normal;font-size:12px;color:var(--bone);padding:6px 10px;border-top:1px solid var(--line);line-height:1.45;}
.pbp td b{color:var(--gator);font-weight:700;}
.spin{padding:34px 16px;text-align:center;color:var(--mute);font-size:13px;}
.nav{display:flex;gap:8px;margin:2px 4px 12px;}
.navb{flex:1;font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.05em;font-size:12.5px;padding:11px;border-radius:12px;border:1px solid var(--line);color:var(--mute);background:var(--bayou2);cursor:pointer;}
.navb.on{color:#fff;background:linear-gradient(180deg,var(--purple),var(--gator2));border-color:var(--purple);}
.rmeta{font-size:10.5px;letter-spacing:.04em;color:var(--mute);margin:0 4px 12px;}
.tscard{background:var(--bayou2);border:1px solid var(--line);border-radius:12px;padding:11px 13px;margin:0 0 14px;display:flex;flex-wrap:wrap;gap:14px;}
.tsgrp{flex:1;min-width:160px;}
.tshd{font-family:'Oswald',sans-serif;font-weight:700;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--gold2);margin-bottom:7px;}
.tsrow{display:flex;gap:14px;}
.tscell{text-align:center;}
.tsk{font-size:8.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--mute);margin-bottom:2px;}
.tsv{font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:600;color:var(--bone);}
.sbsec{display:grid;grid-template-columns:1fr auto 1fr;align-items:baseline;gap:12px;}
.sbdate{font-family:'Oswald',sans-serif;font-weight:700;font-size:17px;letter-spacing:.03em;text-transform:uppercase;color:var(--gold2);}
.pcard{background:var(--bayou2);border:1px solid var(--line);border-radius:14px;padding:11px 13px;margin-bottom:8px;cursor:pointer;display:flex;align-items:center;gap:12px;}
.pnum{flex:none;width:40px;height:40px;border-radius:11px;background:linear-gradient(180deg,var(--panel),var(--bayou2));border:1px solid var(--line);overflow:hidden;display:flex;align-items:center;justify-content:center;font-family:'Oswald',sans-serif;font-weight:700;font-size:17px;color:var(--gator);}
.ppic{width:100%;height:100%;object-fit:cover;object-position:top center;border-radius:inherit;display:block;}
.pmain{flex:1;min-width:0;}
.pname{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;font-size:14px;letter-spacing:.02em;line-height:1.1;display:flex;align-items:baseline;gap:6px;min-width:0;}
.pnametext{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}
.pjersey{flex:none;color:var(--gold2);font-weight:700;}
.pmeta{font-size:10.5px;color:var(--mute);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pmeta b{color:var(--bone);font-weight:600;}
.pstat{flex:none;text-align:right;display:flex;flex-direction:column;gap:3px;align-items:flex-end;}
.pstline{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:var(--gold2);white-space:nowrap;}
.pstline.pit{color:var(--gator);}
.pstline .k{color:var(--mute);margin-right:3px;}
.pchev{flex:none;color:var(--mute);font-size:18px;}
.csec{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.09em;font-size:12px;color:var(--gator);margin:20px 4px 11px;padding-top:15px;border-top:1px solid var(--line);}
.pnum.coachico{font-size:14px;color:var(--gold2);letter-spacing:.02em;}
.cbio{font-size:13px;line-height:1.55;color:var(--bone);margin:2px 0 0;}
.plimited{font-size:10.5px;color:var(--mute);font-style:italic;}
.phead{display:flex;align-items:center;gap:13px;padding:16px 16px 8px;}
.phnum{flex:none;width:48px;height:48px;border-radius:13px;background:linear-gradient(180deg,var(--panel),var(--bayou2));border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-family:'Oswald',sans-serif;font-weight:700;font-size:20px;color:var(--gator);}
.phnum.hasimg{width:60px;height:60px;padding:0;overflow:hidden;background:#16102b;}
.phnum.hasimg img{width:100%;height:100%;object-fit:cover;object-position:top;display:block;}
.phname{font-family:'Oswald',sans-serif;font-weight:700;text-transform:uppercase;font-size:17px;line-height:1.1;}
.phsub{font-size:11px;color:var(--mute);margin-top:3px;}
.bio{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;padding:8px 16px 6px;}
.bio .bi{font-size:12px;color:var(--bone);}
.bio .bi span{color:var(--mute);display:block;font-size:9px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:2px;}
.statblock{margin:12px 14px 0;}
.statblock h4{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.1em;color:var(--gator);margin:0 0 9px;border-bottom:1px solid var(--line);padding-bottom:6px;}
.statblock h4.bat{color:var(--gold2);}
.sgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
.scell{background:var(--bayou);border:1px solid var(--line);border-radius:11px;padding:9px 8px;text-align:center;}
.scell .v{font-family:'Oswald',sans-serif;font-weight:700;font-size:18px;color:var(--bone);line-height:1;}
.scell .l{font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin-top:4px;}
.scell .rk{font-size:8.5px;color:var(--gold);margin-top:2px;}
.ranklegend{margin-top:10px;font-size:10px;line-height:1.4;color:var(--mute);text-align:center;}
.ranklegend b{color:var(--gold);font-weight:700;}
.gltbl{overflow-x:auto;-webkit-overflow-scrolling:touch;}
.gltbl a.gld{color:var(--gold2);text-decoration:none;font-weight:600;}
.gltbl a.gld:hover{text-decoration:underline;}
.gltbl table{width:100%;border-collapse:collapse;font-size:10px;white-space:nowrap;}
.gltbl th{color:var(--mute);font-weight:700;text-transform:uppercase;font-size:8.5px;padding:5px 3px;border-bottom:1px solid var(--line);}
.gltbl td{padding:5px 3px;text-align:center;border-bottom:1px solid var(--line);font-family:'JetBrains Mono',monospace;color:var(--bone);}
.gltbl td:first-child,.gltbl th:first-child{padding-left:2px;}
.gltbl td:last-child,.gltbl th:last-child{padding-right:2px;}
.gltbl td:first-child,.gltbl th:first-child{text-align:left;color:var(--mute);}
.gltbl td:nth-child(2),.gltbl th:nth-child(2){text-align:left;}
.gltbl tr:last-child td{border-bottom:none;}
.sttbl table{font-size:12px;}
.sttbl th,.sttbl td{padding:8px 4px;}
.sttbl td:first-child,.sttbl th:first-child{text-align:center;color:var(--mute);width:16px;padding-left:2px;padding-right:2px;font-family:'Oswald',sans-serif;}
/* Let the team name wrap so every column fits the phone width without scrolling. */
.sttbl td:nth-child(2),.sttbl th:nth-child(2){white-space:normal;}
.sttbl .stteam{display:flex;align-items:center;gap:6px;font-family:'Oswald',sans-serif;font-weight:600;letter-spacing:.01em;color:var(--bone);min-width:0;text-decoration:none;}
.sttbl a.stteam:hover .stnm{text-decoration:underline;}
.sttbl .stteam .stnm{white-space:normal;overflow-wrap:anywhere;line-height:1.15;}
.sttbl .stlogo{width:22px;height:22px;border-radius:5px;object-fit:contain;background:transparent;flex:none;}
.sttbl td:nth-child(4){color:var(--gold2);}
.sttbl .stwl2{font-weight:700;}
.sttbl .stwls{color:var(--mute);}
.sttbl tr.stg td{background:rgba(113,74,210,.16);}
.sttbl tr.stg .stteam{color:var(--gator);font-weight:700;}
.sttbl tr.stg td:first-child{color:var(--gator);}
.strk{font-family:'Oswald',sans-serif;font-weight:700;letter-spacing:.02em;}
.strk.win{color:#41a913;}
.strk.loss{color:var(--away);}
.clinch{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;flex:none;font-size:14px;font-family:'Oswald',sans-serif;font-weight:700;color:var(--gold2);}
.clinch small{font-size:8px;letter-spacing:.06em;margin-top:3px;}
.stnote{margin-top:8px;font-size:10px;color:var(--mute);display:flex;align-items:center;gap:6px;font-family:'Oswald',sans-serif;letter-spacing:.01em;}
.sttbl .stdiff{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--mute);text-align:right;}
.sttbl .stdiff.pos{color:#41a913;}
.sttbl .stdiff.neg{color:var(--away);}
.sttb{margin-top:10px;background:var(--bayou2);border:1px solid var(--line);border-radius:10px;padding:10px 12px;}
.sttbh{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:10px;color:var(--gold2);margin-bottom:6px;}
.sttb ul{margin:0;padding-left:16px;color:var(--mute);font-size:11px;line-height:1.55;}
.sttb li{margin-bottom:2px;}
.poffwrap{background:var(--bayou2);border:1px solid var(--line);border-radius:12px;padding:14px;}
.poffintro{font-size:12px;color:var(--mute);line-height:1.5;margin-bottom:13px;}
.poffhd{display:flex;align-items:center;justify-content:space-between;font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.08em;font-size:12px;color:var(--gold2);margin-bottom:10px;}
.pofftag{font-size:10px;color:var(--bayou);background:var(--gold2);border-radius:20px;padding:2px 10px;font-weight:700;letter-spacing:.05em;}
.poffmatch{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:10px;}
.poffslot{display:flex;align-items:center;gap:9px;padding:10px 12px;}
.poffslot.g{background:rgba(113,74,210,.16);}
.poffslot.tbd .poffnm{color:var(--mute);font-style:italic;}
.poffvs{text-align:center;font-family:'Oswald',sans-serif;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);padding:2px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--bayou);}
.poffseed{flex:none;width:23px;height:23px;border-radius:50%;background:var(--gator2);color:var(--bone);display:flex;align-items:center;justify-content:center;font-family:'Oswald',sans-serif;font-weight:700;font-size:12px;}
.poffseed.clin{background:var(--gold2);color:var(--bayou);}
.poffslot.g .poffseed{background:var(--purple);color:var(--bone);}
.poffl{width:24px;height:24px;border-radius:5px;object-fit:contain;background:transparent;flex:none;}
.poffnm{flex:1;min-width:0;font-family:'Oswald',sans-serif;font-weight:600;letter-spacing:.01em;color:var(--bone);white-space:normal;overflow-wrap:anywhere;line-height:1.15;}
.poffslot.g .poffnm{color:var(--gator);}
.poffwhy{display:block;margin-top:2px;font-size:9px;font-weight:400;letter-spacing:.03em;text-transform:uppercase;color:var(--mute);}
.poffclinch{flex:none;display:inline-flex;flex-direction:column;align-items:center;line-height:1;font-size:14px;color:var(--gold2);}
.poffclinch small{margin-top:2px;font-size:7.5px;font-family:'Oswald',sans-serif;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--gold2);}
.poffrules{margin:12px 0 0;padding-left:18px;color:var(--mute);font-size:11px;line-height:1.6;}
.poffrules li{margin-bottom:2px;}
.poffnote{margin-top:11px;font-size:10px;color:var(--mute);display:flex;align-items:flex-start;gap:6px;font-family:'Oswald',sans-serif;letter-spacing:.01em;line-height:1.45;}
.poffprov{color:var(--gold2);font-weight:700;}
.sbg{display:flex;align-items:center;gap:10px;background:var(--bayou2);border:1px solid var(--line);border-radius:12px;padding:10px 13px;margin-bottom:8px;color:inherit;text-decoration:none;cursor:pointer;transition:border-color .15s,background .15s;}
a.sbg:hover{border-color:var(--purple);background:rgba(113,74,210,.14);}
.sbg.g{border-color:var(--purple);background:rgba(113,74,210,.10);}
/* Upcoming games read as a legible matchup: full-strength team names, records
   kept subtle, and the start time as the one accent on the right. */
.sbg.sbsched .sbn{color:var(--bone);}
.sbg.sbsched .sbrec{opacity:1;color:#b9abe0;}
.sbteams{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;}
.sbrow{display:flex;align-items:center;gap:9px;}
.sbl{width:30px;height:30px;border-radius:6px;object-fit:contain;background:transparent;flex:none;}
/* One line always: a long name (e.g. "San Antonio River Monsters") ellipsizes
   rather than wrapping, so its record stays aligned with the other rows. 14px
   lets the longest name fit whole on phone-width screens; it only clips on the
   narrowest. */
.sbn{flex:0 1 auto;min-width:0;font-family:'Oswald',sans-serif;font-weight:600;font-size:14px;letter-spacing:.02em;color:var(--mute);line-height:1.18;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sbrec{flex:none;margin-left:5px;font-weight:400;font-size:.82em;color:var(--mute);opacity:.85;white-space:nowrap;}
.sbs{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:16px;color:var(--mute);min-width:20px;text-align:right;}
.sbsc{display:flex;align-items:center;gap:6px;flex:none;margin-left:auto;}
.sbtri{width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent;border-right:6px solid var(--gold2);}
.sbrow.w .sbn{color:var(--bone);font-weight:700;}
.sbrow.w .sbs{color:var(--gold2);}
/* Status block: inning over outs, vertically centered so a live card is the
   same height as a scheduled/final one (the bases diamond is its own column). */
.sbstat{flex:none;align-self:stretch;min-width:66px;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;gap:3px;}
.sbtime{font-family:'Oswald',sans-serif;font-weight:700;font-size:15px;letter-spacing:.01em;color:var(--gold2);white-space:nowrap;text-align:right;line-height:1.1;}
.sbtz{font-family:'Oswald',sans-serif;font-weight:600;font-size:9px;letter-spacing:.12em;color:var(--mute);text-align:right;margin-top:2px;}
.sbinn{font-family:'Oswald',sans-serif;font-weight:600;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--gator);text-align:right;}
.sbstat.sbfinal .sbinn{color:var(--bone);}
.sbouts{font-family:'Oswald',sans-serif;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--mute);}
.sbdia{display:block;flex:none;align-self:center;}
.sbdia rect{fill:rgba(154,140,196,.18);stroke:var(--gator);stroke-width:1.3;}
.sbdia rect.on{fill:var(--gold2);stroke:var(--gold2);}
.sitenotice{display:flex;align-items:flex-start;gap:9px;background:rgba(255,214,51,.1);border:1px solid var(--gold2);border-radius:12px;padding:11px 13px;margin-bottom:12px;font-family:'Oswald',sans-serif;font-size:12.5px;line-height:1.4;letter-spacing:.01em;color:var(--bone);}
.sitenotice b{color:var(--gold2);}
.heronote{margin-bottom:10px;font-size:11px;font-style:italic;color:var(--gold2);font-family:'Oswald',sans-serif;letter-spacing:.01em;}
</style></head><body>
<div class="bgfx"></div>
<canvas id="fx"></canvas>
<div class="toasts" id="toasts"></div>
<div class="wrap">
<div class="topbar"><a class="tcllink" href="https://texascollegiateleague.com" target="_blank" rel="noopener" title="Texas Collegiate League"><img class="hdrlogo tcl" src="/tcl-logo.png" alt="Texas Collegiate League"></a><a class="gglink" href="https://gumbeauxgators.com" target="_blank" rel="noopener" title="Gumbeaux Gators official site"><img class="gglogo" src="/gg-logo.png" alt="Lake Charles Gumbeaux Gators"></a><div class="trail"><a class="ticketbtn" href="https://gumbeauxgators.com/tickets/" target="_blank" rel="noopener" title="Buy game tickets">Tickets</a><a class="shopbtn" id="shopBtn" href="https://gumbeauxgators.myshopify.com/collections/all" target="_blank" rel="noopener" title="Shop the Gators store"><span class="shoptxt">Gators<br>Team<br>Store</span></a></div></div>
<div class="nav"><button class="navb on" id="navScores">Scores</button><button class="navb" id="navRoster">Roster</button><button class="navb" id="navStandings">Standings</button></div>
<div id="viewScores">
__SITE_NOTICE__
<div class="jumbo">
<div class="sl">
<div class="tm" id="awayTm"><a class="tlogo" id="awayLogoLink" rel="noopener"><img id="awayLogo" alt=""></a><div class="nm" id="awayNm">—</div><div class="rec" id="awayRec"></div><div class="sc" id="awaySc">0</div></div>
<div class="mid"><a class="watchpill" id="watchBtn" target="_blank" rel="noopener" style="display:none">Watch</a><div class="statpill" id="statpill">—</div><div class="vs" id="vs">vs</div><div class="jloc" id="jloc"></div><div class="jtheme" id="themeTag" style="display:none"></div><div class="jtheme" id="specialName" style="display:none"></div></div>
<div class="tm" id="homeTm"><a class="tlogo" id="homeLogoLink" rel="noopener"><img id="homeLogo" alt=""></a><div class="nm" id="homeNm">—</div><div class="rec" id="homeRec"></div><div class="sc" id="homeSc">0</div></div>
</div>
<div class="jpromos"><div class="jpromo" id="specialDetail" style="display:none"></div><div class="jpromo" id="promoTag" style="display:none"></div></div>
<div class="live" id="livePanel" style="display:none"></div>
<a class="watchbtn ticket" id="ticketBtn" target="_blank" rel="noopener" style="display:none">Buy Tickets</a>
</div>
<div class="sec">Gators Schedule</div>
<div id="sched"></div>
</div>
<div id="viewRoster" style="display:none">
<div class="sec">2026 Roster</div>
<div class="rmeta" id="rmeta">Loading roster…</div>
<div id="rosterBody"></div>
</div>
<div id="viewStandings" style="display:none">
<div class="sec">League Standings</div>
<div class="rmeta" id="stMeta">Loading standings…</div>
<div id="standingsBody"></div>
<div class="sec sbsec" id="sbSec" style="display:none"><span>Around the League</span><span class="sbdate" id="sbMeta"></span></div>
<div id="scoreboardBody"></div>
<div id="poffBody"></div>
</div>
<div class="bld">__BUILD_LABEL__</div>
</div>
<div class="a2hs" id="a2hs">
<img class="a2hsico" src="/icon-192.png" alt="">
<div class="a2hstxt"><b>Add to Home Screen</b><span id="a2hsmsg">One tap to live Gators scores.</span></div>
<button class="a2hsadd" id="a2hsadd">Add</button>
<button class="a2hsx" id="a2hsx" aria-label="Dismiss">✕</button>
</div>
<div class="modal" id="bxModal"><div class="sheet">
<div class="shead"><div class="sttlwrap"><span class="sdate" id="bxDate"></span><span class="sttl" id="bxTtl">Box Score</span></div><span class="sscore" id="bxScore"></span><button class="sclose" id="bxClose" aria-label="Close">✕</button></div>
<div class="tabs"><button class="tabb on" id="tabBox">Box Score</button><button class="tabb" id="tabPbp">Play-by-Play</button></div>
<div class="sbody" id="bxBody"><div class="spin">Loading…</div></div>
</div></div>
<div class="modal" id="plModal"><div class="sheet">
<div class="phead"><div class="phnum" id="plNum">0</div><div style="flex:1;min-width:0"><div class="phname" id="plName">Player</div><div class="phsub" id="plSub"></div></div><button class="sclose" id="plClose" aria-label="Close">✕</button></div>
<div class="sbody" id="plBody" style="border-top:none;padding-top:0"><div class="spin">Loading…</div></div>
</div></div>
<script>
var $=function(i){return document.getElementById(i);};
var curId=null,pbpView='half',lineupTeam='gators',lastGame=null,schedList=null,_schedHtml=null;
function setPbpView(v){pbpView=v;if(lastGame)renderGame(lastGame);}
function setLineupTeam(v){lineupTeam=v;if(lastGame)renderGame(lastGame);}
function ord(n){n=+n;var s=['th','st','nd','rd'],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0]);}
function esc(s){return (s||'').replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
// iOS Safari's Data Detectors would otherwise auto-link a name that contains a
// street-suffix word (e.g. "Lane Schulz") as a Maps address; the page's
// format-detection meta tag (address=no) already disables that site-wide, so
// this just escapes plain-text names.
function noAddr(s){return esc(s);}
function flash(el){el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');}
// Gators-scored fireworks: a short canvas burst in the brand gold/purple,
// fired when the Gators' run total ticks up during a live game. Pointer-events
// are off and it hides itself when the last spark fades, so it never blocks taps.
var FX=(function(){
  var cv,ctx,parts=[],rockets=[],raf=0,endAt=0,W=0,H=0,dpr=1,bloom=0,hero=null;
  var logoImg=null,logoOk=false; // the Gumbeaux Gators wordmark, drawn as the finale centerpiece
  var COLORS=['#ecc913','#ffd633','#714ad2','#b9a6ee','#f0ede4'];
  var GOLD=['#ecc913','#ffd633','#fff3b0']; // warm golds for drooping "willow" shells
  function size(){dpr=Math.min(window.devicePixelRatio||1,2);W=cv.clientWidth;H=cv.clientHeight;cv.width=W*dpr;cv.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);}
  // One spark. grav/drag tune how it falls and slows; trail draws a motion streak,
  // flick twinkles it as it dies, flash is the shrinking white core.
  function spark(x,y,vx,vy,col,decay,r,o){o=o||{};
    parts.push({x:x,y:y,vx:vx,vy:vy,life:1,decay:decay,col:col,r:r,
      grav:o.grav==null?0.045:o.grav,drag:o.drag==null?0.985:o.drag,
      trail:o.trail?1:0,flick:o.flick?1:0,flash:o.flash?1:0});
  }
  // A shell explodes. type: 'ring' (the classic burst), 'willow' (drooping gold
  // fronds), 'palm' (a few fat rising-then-falling tendrils), 'crackle' (a ring
  // plus a delayed second pop of glitter). scale fattens the finale's big shells.
  function burst(x,y,base,o){
    o=o||{};var type=o.type||'ring',scale=o.scale||1;
    base=base||COLORS[Math.random()*COLORS.length|0];
    // white core flash + a soft warm screen bloom so each burst reads as a flash.
    parts.push({x:x,y:y,vx:0,vy:0,life:1,decay:0.055,col:'#ffffff',r:(5+Math.random()*4)*scale,flash:1,grav:0,drag:1,trail:0,flick:0});
    bloom=Math.min(1.1,bloom+0.08*scale);
    if(type==='willow'){
      var nw=40+(Math.random()*26|0);
      for(var i=0;i<nw;i++){var a=(6.283*i)/nw+Math.random()*0.3,sp=(1.8+Math.random()*3.2)*scale;
        spark(x,y,Math.cos(a)*sp,Math.sin(a)*sp*0.8-1.2,GOLD[Math.random()*GOLD.length|0],0.006+Math.random()*0.006,1.5+Math.random()*1.8,{grav:0.075,drag:0.99,trail:1,flick:1});}
    }else if(type==='palm'){
      var np=10+(Math.random()*6|0);
      for(var j=0;j<np;j++){var b=(6.283*j)/np+Math.random()*0.2,pd=(4.5+Math.random()*3.5)*scale;
        spark(x,y,Math.cos(b)*pd,Math.sin(b)*pd-1.5,base,0.009+Math.random()*0.008,2.2+Math.random()*1.6,{grav:0.07,drag:0.985,trail:1});}
    }else{ // 'ring' (also the first stage of 'crackle')
      var n=46+(Math.random()*44|0);if(scale>1)n=(n*1.4|0);
      for(var k=0;k<n;k++){var c=(6.283*k)/n+Math.random()*0.24,s=(2.4+Math.random()*6.4)*scale;
        spark(x,y,Math.cos(c)*s,Math.sin(c)*s,Math.random()<0.3?COLORS[Math.random()*COLORS.length|0]:base,0.008+Math.random()*0.011,1.3+Math.random()*2,{trail:scale>1,flick:Math.random()<0.25});}
      if(type==='crackle')(function(cx,cy){setTimeout(function(){if(!cv||cv.style.display==='none')return;
        for(var m=0;m<26;m++){var e=Math.random()*6.283,g=1+Math.random()*3.4;
          spark(cx,cy,Math.cos(e)*g,Math.sin(e)*g,Math.random()<0.5?'#fff3b0':base,0.02+Math.random()*0.03,1+Math.random()*1.4,{flick:1});}
        bloom=Math.min(1.1,bloom+0.05);},220+Math.random()*160);})(x,y);
    }
  }
  // A rocket rises from the bottom to a target height anywhere across the width,
  // then explodes — so bursts scatter over the whole screen, not one spot. Targets
  // reach from just under the top header (4%) down, and each rocket's launch speed
  // is derived from its target under gravity (0.12/frame) so it actually climbs
  // that high — the highest shells burst over the gold "Gumbeaux Gators" letters.
  // opt lets the finale pin a shell's x/target/type/scale; omit for a random one.
  function launch(opt){opt=opt||{};
    var ty=opt.ty!=null?opt.ty:H*(0.04+Math.random()*0.56),rise=(H+8)-ty;
    rockets.push({x:opt.x!=null?opt.x:W*(0.05+Math.random()*0.9),y:H+8,ty:ty,
      vy:-Math.sqrt(0.24*rise)*(0.99+Math.random()*0.05),col:opt.col||COLORS[Math.random()*COLORS.length|0],
      type:opt.type,scale:opt.scale||1});
  }
  function tick(){
    raf=requestAnimationFrame(tick);ctx.clearRect(0,0,W,H);
    // warm bloom that fades each frame — the whole sky brightens on a burst.
    if(bloom>0.01){var bg=ctx.createRadialGradient(W/2,H*0.42,0,W/2,H*0.42,Math.max(W,H)*0.7);
      bg.addColorStop(0,'rgba(255,214,51,'+(0.10*bloom).toFixed(3)+')');bg.addColorStop(1,'rgba(255,214,51,0)');
      ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);bloom*=0.9;}
    for(var r=rockets.length-1;r>=0;r--){var k=rockets[r];
      k.y+=k.vy;k.vy+=0.12;
      ctx.globalAlpha=0.35;ctx.strokeStyle=k.col;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(k.x,k.y);ctx.lineTo(k.x,k.y-k.vy*1.6);ctx.stroke();
      ctx.globalAlpha=0.95;ctx.fillStyle=k.col;ctx.beginPath();ctx.arc(k.x,k.y,2.2,0,6.283);ctx.fill();
      if(k.y<=k.ty||k.vy>=0){burst(k.x,k.y,k.col,{type:k.type,scale:k.scale});rockets.splice(r,1);}
    }
    for(var i=parts.length-1;i>=0;i--){var p=parts[i];
      p.vy+=p.grav;p.vx*=p.drag;p.vy*=p.drag;p.x+=p.vx;p.y+=p.vy;p.life-=p.decay;
      if(p.life<=0){parts.splice(i,1);continue;}
      var al=p.flash?p.life:Math.min(1,p.life*1.25);
      if(p.flick&&p.life<0.6)al*=(0.4+Math.random()*0.6); // twinkle as they fade
      ctx.globalAlpha=al<0?0:al;ctx.fillStyle=p.col;
      if(p.trail){ctx.strokeStyle=p.col;ctx.lineWidth=p.r;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x-p.vx*1.4,p.y-p.vy*1.4);ctx.stroke();}
      ctx.beginPath();ctx.arc(p.x,p.y,p.flash?p.r*p.life:p.r,0,6.283);ctx.fill();
    }
    if(hero)drawHero();
    ctx.globalAlpha=1;
    if(!parts.length&&!rockets.length&&!hero&&Date.now()>endAt){cancelAnimationFrame(raf);raf=0;cv.style.display='none';}
  }
  // The finale centerpiece: the Gumbeaux Gators wordmark logo and a gold "Gators
  // Win!" in Kaushan Script — a bold, slanted athletic brush script close to the
  // wordmark's own lettering, gold with a dark outline. The pair bursts OUT of the
  // fireworks (see finale): a shell flashes where they sit, then they pop in with an
  // overshoot on top of it, hold with a soft bob/pulse, and fade at the end.
  function drawHero(){
    var t=Date.now()-hero.t;if(t>=hero.dur){hero=null;return;}
    var p=t/hero.dur,appear=Math.min(1,t/440),fade=p>0.86?(1-(p-0.86)/0.14):1,
        // easeOutBack: scale from nothing, overshoot past full size, then settle —
        // a punchy "pop" so the pair springs out of the shell burst behind it.
        c1=2.2,c3=c1+1,pop=1+c3*Math.pow(appear-1,3)+c1*Math.pow(appear-1,2),
        a=Math.max(0,Math.min(1,appear*2))*fade,
        bob=Math.sin(t/560)*4,cx=W/2,textY;
    ctx.save();ctx.globalAlpha=a;ctx.textAlign='center';ctx.textBaseline='middle';
    // logo, centered in the upper third with a warm glow behind it
    if(logoOk&&logoImg.width){
      var lw=Math.min(W*0.74,340)*pop,lh=lw*(logoImg.height/logoImg.width),ly=H*0.21+bob;
      ctx.shadowColor='rgba(255,214,51,.6)';ctx.shadowBlur=36;
      ctx.drawImage(logoImg,cx-lw/2,ly-lh/2,lw,lh);ctx.shadowBlur=0;
      textY=ly+lh/2+Math.min(W*0.11,60)*0.5;
    }else{textY=H*0.30+bob;}
    // "Gators Win!" in the matching gold script
    var fs=Math.min(W*0.15,82)*pop*(1+0.03*Math.sin(t/90));
    ctx.font="400 "+fs+"px 'Kaushan Script','Oswald',cursive";
    // Kaushan is a wider, heavier script than before — shrink to fit so
    // 'Gators Win!' never runs off a narrow phone.
    var tw=ctx.measureText('Gators Win!').width,maxw=W*0.9;
    if(tw>maxw){fs*=maxw/tw;ctx.font="400 "+fs+"px 'Kaushan Script','Oswald',cursive";}
    ctx.lineJoin='round';
    ctx.shadowColor='rgba(0,0,0,.5)';ctx.shadowBlur=16;
    ctx.lineWidth=fs*0.11;ctx.strokeStyle='#100a1e';ctx.strokeText('Gators Win!',cx,textY);ctx.shadowBlur=0;
    var lg=ctx.createLinearGradient(0,textY-fs*0.6,0,textY+fs*0.6);
    lg.addColorStop(0,'#fff3b0');lg.addColorStop(0.5,'#ffd633');lg.addColorStop(1,'#e0b207');
    ctx.fillStyle=lg;ctx.fillText('Gators Win!',cx,textY);ctx.restore();
  }
  // Lazily grab the canvas, honor reduced-motion, and show/size it. Returns false
  // when there's nothing to draw on or motion is suppressed.
  function ready(){
    if(!cv){cv=$('fx');if(!cv||!cv.getContext)return false;ctx=cv.getContext('2d');
      window.addEventListener('resize',function(){if(cv.style.display!=='none')size();});}
    // Warm the wordmark logo (same-origin, already in the header, so usually cached).
    if(!logoImg){logoImg=new Image();logoImg.onload=function(){logoOk=true;};logoImg.src='/gg-logo.png';}
    if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return false;
    cv.style.display='block';if(!raf)size();return true;
  }
  function show(intensity){
    if(!ready())return;
    // More runs -> a bigger show. Rockets fire in a staggered barrage across the
    // page; the barrage (and so the whole show) runs about twice as long as before.
    var shots=Math.max(16,Math.min(12+(intensity||1)*4,36));
    for(var s=0;s<shots;s++)(function(d){setTimeout(function(){if(cv.style.display!=='none')launch();},d);})(s*(150+Math.random()*130));
    endAt=Date.now()+shots*280+2600;if(!raf)tick();
  }
  // The win celebration: a long, dense, multi-type barrage that builds to an
  // all-at-once grand-finale volley of big shells, around the Gators wordmark logo
  // and a gold "Gators Win!" script.
  function finale(){
    if(!ready())return;
    // Kick off the self-hosted Kaushan Script webfont so it's ready before the line draws.
    if(document.fonts&&document.fonts.load){try{document.fonts.load("60px 'Kaushan Script'");}catch(e){}}
    var TYPES=['ring','ring','willow','palm','crackle'],t=0,last=0;
    // Phase 1 — a rolling barrage that runs a guaranteed ~9s (a while loop on
    // elapsed time, not a fixed shell count with random gaps that could finish
    // early), so the whole celebration always lasts well over 10s. Shells of every
    // type scattered across the sky, often two on a beat.
    while(t<9000){t+=130+Math.random()*150;
      (function(d){setTimeout(function(){if(cv.style.display==='none')return;
        launch({type:TYPES[Math.random()*TYPES.length|0],scale:0.9+Math.random()*0.5});
        if(Math.random()<0.5)launch({type:TYPES[Math.random()*TYPES.length|0],scale:0.9+Math.random()*0.5});
      },t);})(t);last=t;}
    // Phase 2 — the grand finale: three fast waves of big shells fired in near
    // unison across the width, bursting high over the header.
    for(var w=0;w<3;w++)(function(d){setTimeout(function(){if(cv.style.display==='none')return;
      for(var q=0;q<8;q++)launch({x:W*(0.08+q*0.11+Math.random()*0.03),ty:H*(0.05+Math.random()*0.28),
        type:Math.random()<0.5?'crackle':'ring',scale:1.5+Math.random()*0.7});
      bloom=Math.min(1.1,bloom+0.5);},d);})(last+300+w*520);
    var dur=last+300+2*520+3400;
    endAt=Date.now()+dur;
    // The logo + script burst OUT of the fireworks a beat after the show opens: let a
    // few shells go up first, then flash a bright shell right where the pair sits and
    // pop them in on top of it — so they read as springing out of the fireworks.
    var HDLY=560;
    setTimeout(function(){if(cv.style.display==='none')return;
      burst(W/2,H*0.21,'#ffd633',{type:'ring',scale:1.9});    // flash behind the logo
      burst(W/2,H*0.30,'#fff3b0',{type:'crackle',scale:1.3});  // sparkle over the lettering
      bloom=Math.min(1.2,bloom+0.7);
      hero={t:Date.now(),dur:dur-HDLY};},HDLY);
    if(!raf)tick();
  }
  return {show:show,finale:finale};
})();
var prev={a:null,h:null};
// Win finale bookkeeping: which game we've already celebrated, plus the status we
// last rendered for a game — so the finale fires only on the live->final flip we
// actually witnessed, not on every reload inside the 10-hour post-game window.
var winFinaleGid=null,lastSeenGid=null,lastSeenStatus=null;
var lastPlayTx='',lastPlayGid=null; // track the live "Last play" text to flash only on change
// Track the last count (per game) so renderGame can glow the digit that ticked
// up on a new pitch. Re-add the class after a reflow so the animation restarts.
var lastBalls=null,lastStrikes=null,lastCountGid=null;
// Detect a genuinely fresh batter so the count resets and the last-play bubble
// shows. The feed does NOT reliably reset abPitches (the per-at-bat pitch count)
// when a batter changes — when the previous batter reaches base, the feed can keep
// reporting his pitch count AND his balls/strikes for several polls until the new
// batter's first pitch. So abPitches===0 alone is not a reliable "new batter" test
// (it was: a stale non-zero count then showed for the incoming hitter, and his
// arrival-on-base last-play bubble got suppressed as if mid-at-bat). We instead
// latch per batter: on a batter change, if the feed's abPitches still equals the
// value we last saw (carried over from the prior batter), it's stale → treat the
// at-bat as 0 pitches (count 0-0) until abPitches diverges, confirming a real pitch.
var abKey=null,abBaseline=0,abConfirmed=false,abLastNp=0;
// Effective pitches thrown to the CURRENT batter: L.abPitches once we've confirmed
// a real pitch this at-bat, else 0 (stale/unreset feed count for a fresh batter).
function abLivePitches(g,L){
  if(!g||!L||L.holdEnd)return 0;
  var np=L.abPitches||0,key=g.id+'|'+(L.batter||'');
  if(key!==abKey){
    // New batter (or game). If the feed's abPitches carried over unchanged from the
    // previous frame, it belongs to the prior batter (lag) → unconfirmed. If it
    // already differs, the feed reset for this batter → trust it immediately.
    abKey=key;abBaseline=np;abConfirmed=(np!==abLastNp);
  }else if(!abConfirmed&&np!==abBaseline){
    abConfirmed=true; // abPitches moved off the stale baseline: a real pitch landed.
  }
  abLastNp=np;
  return (abConfirmed&&np>0)?np:0;
}
function glowDigit(el){if(!el)return;el.classList.remove('cglow');void el.offsetWidth;el.classList.add('cglow');}
// Gators fireworks are deferred so they launch WITH the green "scored" bubble,
// not before it: the run total ticks up a live-update frame or two ahead of the
// play narrative, so we stash the pending run count here and fire when the
// Gators' scored bubble appears — with a timer as a fallback for a run that
// never gets a "scored" narrative (e.g. a bases-loaded walk).
var fxPending=0,fxTimer=0;
function fireFx(){if(fxTimer){clearTimeout(fxTimer);fxTimer=0;}if(fxPending>0){FX.show(fxPending);fxPending=0;}}
// Point a team's scoreboard logo at their official site. Only the opponent is
// linked; the Gators' own logo (isGators=true) stays a plain, non-clickable image.
function logoLink(id,t,isGators){
  var a=$(id);if(!a)return;
  if(!isGators&&t&&t.site){a.setAttribute('href',t.site);a.setAttribute('target','_blank');a.setAttribute('title',(t.name||t.short||'Opponent')+' — official site');}
  else{a.removeAttribute('href');a.removeAttribute('target');a.removeAttribute('title');}
}
// ---- 3rd-out hold ----------------------------------------------------------
// The feed jumps to the next half-inning the instant the 3rd out is recorded, so
// the out that ended the inning flashes past before you can read it. Freeze the
// gamecast on the finished half — "inning over · 3 outs" plus the out's play
// text — for 30s before letting the live feed through again, so you can see how
// the inning ended without scrolling back to the previous half.
var holdKey='',holdUntil=0,holdLp=null,holdRealG=null,holdTimer=0;
function applyThirdOutHold(g){
  // Only a live game with narrated plays can start or sustain a hold; anything
  // else (pregame/final/no feed) clears any hold in progress.
  if(!g||g.status!=='live'||!g.live||!g.plays||!g.plays.length){
    holdKey='';holdUntil=0;holdLp=null;if(holdTimer){clearTimeout(holdTimer);holdTimer=0;}
    return g;
  }
  holdRealG=g;
  var L=g.live,liveInn=+L.inning||0,liveSide=(L.half==='Top')?'top':'bot';
  var lp=g.plays[g.plays.length-1];
  // A half ends only on the 3rd out, and the feed flips the live block to the next
  // half the instant that out lands. So once the newest narrated play sits in an
  // earlier half than the live situation, that play IS the inning-ending out — no
  // separate out-count check needed. (Don't gate on outsMade here: in the beat
  // before the feed adds the new half to its play-by-play, the just-finished half
  // isn't yet "closed", so its final out can be scored as 0 outs-made and an "==3"
  // test would miss the boundary — the bug that still let the last out flash past.)
  var ended=(lp.inning<liveInn||(lp.inning===liveInn&&lp.half!==liveSide));
  var now=Date.now();
  if(ended){
    var key=g.id+':'+lp.inning+':'+lp.half;
    // Start a hold once per boundary: a fresh key that isn't already mid-hold.
    if(key!==holdKey&&holdUntil<=now){holdKey=key;holdUntil=now+30000;holdLp=lp;}
  }
  if(holdUntil>now&&holdLp){
    // Auto-release once the window elapses, even if no further poll arrives.
    if(holdTimer)clearTimeout(holdTimer);
    holdTimer=setTimeout(function(){holdTimer=0;if(holdRealG)renderGame(applyThirdOutHold(holdRealG));},holdUntil-now+60);
    return frozenFrame(g);
  }
  holdUntil=0;
  return g;
}
function frozenFrame(g){
  // Shallow-clone the game (and its live block) so the real feed object stays
  // intact for release; retarget the display to the finished half.
  var lp=holdLp,fg={},k;
  for(k in g)fg[k]=g[k];
  var L={};for(k in g.live)L[k]=g.live[k];
  L.inning=lp.inning;L.half=(lp.half==='top')?'Top':'Bottom';
  L.outs=3;L.abPitches=0;L.holdEnd=true;
  L.batter=null;L.pitcher=null;L.batterInfo=null;L.pitcherInfo=null;
  fg.live=L;fg._holdLp=lp;
  fg.inningLabel=(lp.half==='top'?'Top':'Bottom')+' of '+ord(lp.inning);
  return fg;
}
function renderGame(g){
  var ah=!g.gatorsHome, hh=g.gatorsHome;
  $('awayTm').classList.toggle('gators',ah);$('homeTm').classList.toggle('gators',hh);
  $('awayLogo').src=g.away.logo;$('homeLogo').src=g.home.logo;
  // Hyperlink the opposing team's logo to their official site (the Gators' own
  // logo stays a plain image — the header already links to gumbeauxgators.com).
  logoLink('awayLogoLink',g.away,ah);logoLink('homeLogoLink',g.home,hh);
  $('awayNm').textContent=g.away.short;$('homeNm').textContent=g.home.short;
  var ar=$('awayRec'),hr=$('homeRec');
  if(ar)ar.textContent=g.away.record||'';if(hr)hr.textContent=g.home.record||'';
  // Upcoming games haven't been played, so show logo-vs-logo with no 0-0 score.
  var preGame=(g.status==='pregame'||g.status==='cancelled');
  $('awaySc').style.display=preGame?'none':'';
  $('homeSc').style.display=preGame?'none':'';
  if(g.id===curId){if(g.away.runs>prev.a)flash($('awaySc'));if(g.home.runs>prev.h)flash($('homeSc'));}
  // Fireworks when the Gators score (their run total rises) during a live game.
  // Don't fire yet — stash the runs and let them go off with the green "scored"
  // bubble below, which usually lands a frame later. The fallback timer fires the
  // show anyway if that narrative never arrives.
  var gPrev=g.gatorsHome?prev.h:prev.a,gNow=g.gatorsHome?g.home.runs:g.away.runs;
  if(g.id===curId&&g.status==='live'&&gPrev!=null&&gNow>gPrev){
    fxPending+=gNow-gPrev;if(!fxTimer)fxTimer=setTimeout(fireFx,5000);}
  $('awaySc').textContent=g.away.runs;$('homeSc').textContent=g.home.runs;
  // Color the scores by result (leader gold, trailer light purple); only once a
  // game is live or final and both totals are in. A tie leaves neither class, so
  // both fall back to the default bone color.
  var haveRes=(g.status==='live'||g.status==='final')&&g.away.runs!=null&&g.home.runs!=null;
  $('awayTm').classList.toggle('win',haveRes&&g.away.runs>g.home.runs);
  $('awayTm').classList.toggle('lose',haveRes&&g.away.runs<g.home.runs);
  $('homeTm').classList.toggle('win',haveRes&&g.home.runs>g.away.runs);
  $('homeTm').classList.toggle('lose',haveRes&&g.home.runs<g.away.runs);
  // Full finale when the Gators WIN — fire once, and only on the live->final flip
  // we watched happen (lastSeenStatus was a non-final state for this same game), so
  // it doesn't re-launch every time a finished win reloads in the post-game window.
  var gWon=g.status==='final'&&g.away.runs!=null&&g.home.runs!=null&&(g.gatorsHome?g.home.runs>g.away.runs:g.away.runs>g.home.runs);
  if(gWon&&winFinaleGid!==g.id&&lastSeenGid===g.id&&lastSeenStatus&&lastSeenStatus!=='final'){winFinaleGid=g.id;FX.finale();}
  lastSeenGid=g.id;lastSeenStatus=g.status;
  prev={a:g.away.runs,h:g.home.runs};var pc=curId;curId=g.id;if(schedList&&pc!==curId)renderSched(schedList);
  var sp=$('statpill');sp.textContent=g.inningLabel;sp.classList.toggle('live',g.status==='live');
  $('vs').textContent=g.dateLabel+(g.dhLabel?' · '+g.dhLabel:'')+(g.status==='pregame'?' · upcoming':'');
  var jl=$('jloc');if(jl)jl.textContent=g.location||'';
  var th=$('themeTag');if(th){if(g.theme&&g.status==='pregame'){th.textContent='🎉 '+g.theme+' Night';th.style.display='';}else{th.style.display='none';}}
  var sn=$('specialName'),sd=$('specialDetail');
  if(sn&&sd){if(g.special&&g.status==='pregame'){sn.textContent=(g.special.emoji?g.special.emoji+' ':'')+g.special.name;sn.style.display='';if(g.special.detail){sd.textContent=g.special.detail;sd.style.display='';}else sd.style.display='none';}else{sn.style.display='none';sd.style.display='none';}}
  var pr=$('promoTag');if(pr){if(g.promo&&g.status==='pregame'){pr.innerHTML=esc(g.promo.emoji)+' <b>'+esc(g.promo.name)+'</b> · '+esc(g.promo.detail);pr.style.display='';}else{pr.style.display='none';}}
  var wb=$('watchBtn');
  if(wb){
    // Live game: show the TCL stream pill. Upcoming games use the Buy Tickets
    // button below instead (you can't watch a game that hasn't started).
    if(g.status!=='pregame'&&g.status!=='cancelled'&&g.watchUrl){wb.href=g.watchUrl;wb.textContent='Watch on TCL';wb.classList.remove('replay');wb.style.display='';}
    else{wb.style.display='none';}
  }
  var tk=$('ticketBtn');
  if(tk){
    if(g.status==='pregame'&&g.freeAdmission){tk.removeAttribute('href');tk.removeAttribute('target');tk.classList.add('freead');tk.textContent='🎟️ Free Admission · Courtesy of '+g.freeAdmission;tk.style.display='';}
    else if(g.status==='pregame'&&g.ticketUrl){tk.setAttribute('href',g.ticketUrl);tk.setAttribute('target','_blank');tk.classList.remove('freead');tk.textContent='Buy Tickets';tk.style.display='';}
    else{tk.style.display='none';}
  }
  // Load the roster during a live game so lineup names can link to profiles.
  if(g.status==='live'&&!rosterData)loadRoster();
  var lp=$('livePanel');
  if(lp){
    var pl=document.getElementById('pbplist');var sc=pl?pl.scrollTop:0;
    var lh=(g.status==='final')?buildFinal(g):buildLive(g);lp.innerHTML=lh;lp.style.display=lh?'':'none';
    var pl2=document.getElementById('pbplist');if(pl2&&sc)pl2.scrollTop=sc;
    // Flash the "Last play" banner only when the play text actually changed —
    // not on every poll, and not when first switching to this game.
    var lpb=document.getElementById('lastPlay');
    if(lpb){var lt=lpb.querySelector('.lptx');var ntx=lt?lt.textContent:'';
      var lpNew=(g.id===lastPlayGid&&ntx&&ntx!==lastPlayTx);
      if(lpNew){lpb.classList.remove('lpnew');void lpb.offsetWidth;lpb.classList.add('lpnew');}
      // Launch the deferred Gators fireworks in lockstep with their scoring
      // bubble, so the burst and the "here's what happened" text land together.
      if(lpNew&&fxPending>0&&lpb.classList.contains('gscore'))fireFx();
      lastPlayTx=ntx;}
    lastPlayGid=g.id;
    // Glow the count digit that just ticked up (a new ball or strike), so a new
    // pitch outcome is easy to catch. Only on an increase for the same game —
    // not on the first switch to this game, nor on a reset to 0-0 (new batter).
    var cv=document.getElementById('countVal');
    if(cv&&g.status==='live'&&g.live&&!g.live.holdEnd){
      // Compare the digits actually shown (which already reflect the 0-0-on-new-
      // batter override above), not the raw feed count, so the two stay in step.
      var cbEl=cv.querySelector('.cb'),csEl=cv.querySelector('.cs');
      var nb=+(cbEl&&cbEl.textContent)||0,ns=+(csEl&&csEl.textContent)||0;
      if(g.id===lastCountGid){
        if(nb>lastBalls)glowDigit(cbEl);
        if(ns>lastStrikes)glowDigit(csEl);
      }
      lastBalls=nb;lastStrikes=ns;lastCountGid=g.id;
    }
  }
  lastGame=g;
}
function baseDiamond(b){
  b=b||{};
  var on='var(--gold)',off='rgba(255,255,255,.12)',st='var(--line)';
  function sq(cx,cy,fl){return '<rect x="'+(cx-7)+'" y="'+(cy-7)+'" width="14" height="14" rx="2" transform="rotate(45 '+cx+' '+cy+')" fill="'+fl+'" stroke="'+st+'" stroke-width="1.5"/>';}
  return '<svg class="diamond" viewBox="0 0 58 50">'+
    sq(29,15,b.second?on:off)+sq(43,29,b.first?on:off)+sq(15,29,b.third?on:off)+'</svg>';
}
function outsDots(n){n=n||0;var h='';for(var i=0;i<3;i++)h+='<span class="odot'+(i<n?' on':'')+'"></span>';return h;}
function buildLive(g){
  if(g.status!=='live')return '';
  // The count/bases/outs strip and the pitcher-vs-batter cards need the feed's
  // at-bat situation; the line score, play-by-play, and lineup come from other
  // parts of the same feed. Render whatever parsed instead of hiding the whole
  // panel when only the situation block is missing.
  var L=g.live,sit='',bp='';
  // Confirmed pitches to the current batter (0 for a fresh hitter even when the
  // feed still reports the prior batter's stale count). Drives both the count
  // reset and the last-play bubble below. Computed once so the per-batter latch
  // advances exactly once per render.
  var abp=abLivePitches(g,L);
  if(L&&L.holdEnd){
    // 3rd-out hold frame: the feed has already flipped to the next half, so its
    // count/bases/matchup belong to the new inning. Show only "inning over · 3
    // outs" here; the play that ended the inning appears in the bubble below.
    sit='<div class="lsit lend"><div class="lcell"><div class="lv">'+outsDots(3)+'</div><div class="ll">Inning over · 3 outs</div></div></div>'+
      '<div class="btwnote">* in between innings</div>';
  }else if(L){
    // Balls/strikes as separate spans so renderGame can glow just the digit that
    // ticked up on the latest pitch (see the count-glow block in renderGame).
    // The feed lags the count behind the batter change — it keeps showing the last
    // batter's count (and his abPitches) until the new batter's first pitch — so
    // key off abLivePitches (confirmed pitches this at-bat, 0 for a fresh batter)
    // rather than the raw, unreliably-reset L.abPitches: zero pitches this at-bat
    // means the count is 0-0 regardless of the stale balls/strikes.
    var cb=abp?(L.balls||0):0,cs=abp?(L.strikes||0):0;
    sit='<div class="lsit">'+
      '<div class="lcell"><div class="lv count" id="countVal"><span class="cdig cb">'+esc(''+cb)+'</span><span class="csep">-</span><span class="cdig cs">'+esc(''+cs)+'</span></div><div class="ll">Count</div></div>'+
      baseDiamond(L.bases)+
      '<div class="lcell"><div class="lv">'+outsDots(L.outs)+'</div><div class="ll">'+((L.outs||0)===1?'Out':'Outs')+'</div></div>'+
      '</div>';
    if(L.pitcherInfo||L.batterInfo){
      if(L.batterInfo)bp+=matchupCard('At bat',L.batterInfo);
      if(L.pitcherInfo&&L.batterInfo)bp+='<div class="mvs">— facing —</div>';
      if(L.pitcherInfo)bp+=matchupCard('Pitching',L.pitcherInfo);
    }else{
      if(L.batter)bp+='<div class="bprow"><span class="bpk">At bat</span><span class="bpn">'+noAddr(L.batter)+'</span></div>';
      if(L.pitcher)bp+='<div class="bprow"><span class="bpk">Pitching</span><span class="bpn">'+noAddr(L.pitcher)+'</span></div>';
    }
  }
  // Surface the most recent play right under the count/bases/outs so you see the
  // at-bat result without scrolling to the play-by-play. It clears once the next
  // batter sees a pitch (abp — confirmed pitches this at-bat — ticks up off 0 on
  // the first pitch), and also clears when a new half-inning starts — the prior out
  // belongs to the other team, so we only keep it while the latest play is still
  // in the current half. Flashes on change (renderGame); scored plays go green.
  var lastPlay='';
  if(L&&L.holdEnd&&g._holdLp){
    // During the hold, pin the bubble to the play that made the 3rd out (captured
    // when the hold started) — g.plays' newest entry may already be the next half.
    var hp=g._holdLp;
    lastPlay='<div class="lastplay hold'+(hp.scored?' scored':'')+'" id="lastPlay"><span class="lplab">3rd out</span><span class="lptx">'+esc(hp.text)+'</span></div>';
  }else if(g.plays&&g.plays.length){var lp=g.plays[g.plays.length-1];
    var inHalf=!L||(lp.inning===(+L.inning)&&lp.half===(L.half==='Top'?'top':'bot'));
    // gscore marks a Gators scoring play (their half + a "scored" narrative) so
    // the deferred fireworks fire the instant this bubble shows.
    var gBat=g.gatorsHome?(lp.half==='bot'):(lp.half==='top');
    // Between batters (no pitch yet this at-bat) show the last plate-appearance
    // result. Mid-at-bat, suppress that now-stale PA result — but still surface a
    // baserunning/scoring row (passed ball, wild pitch, steal, balk) that just
    // happened with the batter still up: otherwise a run scores with no cue on
    // the hero and you'd have to scroll to the play-by-play to see how.
    var show=(!L||!abp)||!lp.isPa;
    if(lp&&lp.text&&inHalf&&show)lastPlay='<div class="lastplay'+(lp.scored?' scored':'')+(lp.scored&&gBat?' gscore':'')+'" id="lastPlay"><span class="lplab">Last play</span><span class="lptx">'+esc(lp.text)+'</span></div>';}
  var line=buildLineScore(g);
  // Whose-up-next belongs to the new half; hide it during the finished-half hold.
  var dueup=(L&&L.holdEnd)?'':buildDueUp(g);
  var lineup=buildLineup(g);
  var pitching=buildPitching(g);
  var pbp=buildPbp(g);
  return sit+lastPlay+(bp?'<div class="lbp">'+bp+'</div>':'')+line+dueup+pbp+lineup+pitching;
}
// Live pitching box: each team's pitchers who have appeared, with their game
// line (IP/H/R/ER/BB/K and pitch count). Gators names link to their profile.
function buildPitching(g){
  var P=g.pitchers;if(!P||!P.length)return '';
  function nm(t){return t.vh==='H'?g.home.short:g.away.short;}
  // Show only the team picked by the lineup tab (Gators vs opponent), not both.
  var showGators=lineupTeam!=='opp';
  var head='<tr><th class="luu">#</th><th class="lunm">Pitcher</th><th class="lpn">IP</th><th class="lpn">H</th><th class="lpn">R</th>'+
    '<th class="lpn">ER</th><th class="lpn">BB</th><th class="lpn">K</th><th class="lpn">HBP</th><th class="lpn">P</th><th class="lpn">S%</th></tr>';
  var blocks='';
  P.forEach(function(t){
    if(!!t.isGators!==showGators)return;
    if(!t.rows||!t.rows.length)return;
    var rows='';
    t.rows.forEach(function(r){
      var slug=t.isGators?gatorSlug(r.name):null;
      var nme=slug?('<a class="bxp" data-slug="'+esc(slug)+'">'+esc(r.name||'')+'</a>'):noAddr(r.name||'');
      if(r.dec)nme+=' <span class="pdec">'+esc(r.dec)+'</span>';
      rows+='<tr><td class="luu">'+esc(String(r.uni||''))+'</td><td class="lunm">'+nme+'</td><td class="lpn">'+esc(String(r.ip))+'</td>'+
        '<td class="lpn">'+r.h+'</td><td class="lpn">'+r.r+'</td><td class="lpn">'+r.er+'</td>'+
        '<td class="lpn">'+r.bb+'</td><td class="lpn">'+r.k+'</td><td class="lpn">'+(r.hbp||0)+'</td><td class="lpn">'+(r.np==null?'·':r.np)+'</td>'+
        '<td class="lpn">'+(r.sp==null?'·':r.sp)+'</td></tr>';
    });
    var T=t.totals;
    if(T)rows+='<tr class="pttot"><td class="luu"></td><td class="lunm">Totals</td><td class="lpn">'+esc(String(T.ip))+'</td>'+
      '<td class="lpn">'+T.h+'</td><td class="lpn">'+T.r+'</td><td class="lpn">'+T.er+'</td>'+
      '<td class="lpn">'+T.bb+'</td><td class="lpn">'+T.k+'</td><td class="lpn">'+(T.hbp||0)+'</td><td class="lpn">'+(T.np==null?'·':T.np)+'</td>'+
      '<td class="lpn">'+(T.sp==null?'·':T.sp)+'</td></tr>';
    blocks+='<div class="pthead">'+esc(nm(t))+'</div><div class="lubox"><table class="lutbl ptbl">'+head+rows+'</table></div>';
  });
  if(!blocks)return '';
  return '<div class="lineup"><div class="luh">Pitching</div>'+blocks+'</div>';
}
// Final-score recap shown in the panel once a game ends: a "Final" banner, the
// score with the winner emphasized, and buttons into the box score / play-by-play.
function buildFinal(g){
  if(g.status!=='final')return '';
  var btns='<button class="fbtn" data-final="box" data-id="'+esc(g.id)+'">Box Score</button>'
    +'<button class="fbtn" data-final="pbp" data-id="'+esc(g.id)+'">Play-by-Play</button>'
    +(g.replayUrl?('<a class="fbtn rep" href="'+esc(g.replayUrl)+'" target="_blank" rel="noopener">Watch Replay</a>'):'');
  var note=g.heroNote?('<div class="heronote">* '+esc(g.heroNote)+'</div>'):'';
  return '<div class="finalcard">'+note+'<div class="finalbtns">'+btns+'</div></div>';
}
function buildLineScore(g){
  var rows=g.lineScore;if(!rows||!rows.length)return '';
  var maxInn=0;rows.forEach(function(t){if(t.innings)maxInn=Math.max(maxInn,t.innings.length);});
  if(g.live&&+g.live.inning)maxInn=Math.max(maxInn,+g.live.inning);
  if(maxInn<1)maxInn=1;
  function c(v){return (v==null||v==='')?'·':v;}
  var h='<div class="lsbox"><table class="lstbl"><tr><th class="lsn"></th>';
  for(var i=1;i<=maxInn;i++)h+='<th class="lsi">'+i+'</th>';
  h+='<th class="lsd">R</th><th>H</th><th>E</th></tr>';
  rows.forEach(function(t){
    var nm=t.vh==='H'?g.home.short:g.away.short;
    h+='<tr'+(t.isGators?' class="g"':'')+'><td class="lsn">'+esc(nm)+'</td>';
    for(var k=0;k<maxInn;k++){var v=(t.innings&&t.innings[k]!=null)?t.innings[k]:'';h+='<td class="lsi">'+(v===''?'·':v)+'</td>';}
    h+='<td class="lsd">'+c(t.runs)+'</td><td>'+c(t.hits)+'</td><td>'+c(t.errs)+'</td></tr>';
  });
  return h+'</table></div>';
}
// "Due Up" strip under the line score: the next three hitters for the team at
// bat (starting with whoever's up), each with his game line — like ESPN.
function buildDueUp(g){
  if(g.status==='final')return '';
  var L=g.lineups,live=g.live;
  if(!L||!L.length||!live||!live.half)return '';
  var battingV=live.half==='Top';                  // Top = visitor bats
  var team=null;L.forEach(function(t){if((t.vh==='V')===battingV&&!team)team=t;});
  if(!team||!team.rows||!team.rows.length)return '';
  // Current occupant of each batting spot (a later sub overrides the starter).
  var bySpot={};team.rows.forEach(function(r){if(r.spot!=null)bySpot[r.spot]=r;});
  var spots=Object.keys(bySpot).map(Number).sort(function(a,b){return a-b;});
  if(spots.length<2)return '';
  var curBat=live.batter?String(live.batter).trim():'';
  var curSpot=null;team.rows.forEach(function(r){if((r.full||r.name)===curBat&&r.spot!=null)curSpot=r.spot;});
  var ci=curSpot!=null?spots.indexOf(curSpot):0;if(ci<0)ci=0;
  // Show the batting line (H-AB) plus up to two more stats that have a value over
  // zero — capped at three groups total so it fits on one line without an ellipsis.
  function line(r){if(r.ab==null)return '—';
    var g=[r.hits+'-'+r.ab];
    var cand=[[r.runs,'R'],[r.rbi,'RBI'],[r.k,'K'],[r.bb,'BB']];
    for(var i=0;i<cand.length&&g.length<3;i++){if(cand[i][0])g.push(cand[i][0]+' '+cand[i][1]);}
    return g.join(', ');}
  var items='';
  // Start at the on-deck batter (skip whoever is currently at the plate).
  for(var j=1;j<=3;j++){var r=bySpot[spots[(ci+j)%spots.length]];if(!r)continue;
    items+='<div class="duitem"><div class="dunum">DUE UP ('+j+')</div><div class="dunm">'+esc(r.name)+'</div><div class="duln">'+esc(line(r))+'</div></div>';}
  if(!items)return '';
  return '<div class="dueup"><div class="duh">Due Up</div><div class="durow">'+items+'</div></div>';
}
function matchupCard(role,info){
  var meta=[];if(info.pos)meta.push(esc(info.pos));if(info.uni)meta.push('#'+esc(String(info.uni)));
  var head='<div class="mrole">'+role+'</div><div class="mname">'+noAddr(info.name)+(meta.length?'<span class="mmeta">'+meta.join(' ')+'</span>':'')+'</div>';
  // A pitcher who just entered: state "New pitcher" with who he relieved plus his
  // school/class and summer line (ERA/IP/K), the same shape as the 1st-AB card.
  if(info.newPitcher){
    var npLab=info.newPitcher.starter?'Starting Pitcher':'New Pitcher';
    // Put the "New pitcher" badge to the right of the name and number, inline in
    // the name row, rather than on its own line below.
    var npHead='<div class="mrole">'+role+'</div><div class="mname">'+noAddr(info.name)+(meta.length?'<span class="mmeta">'+meta.join(' ')+'</span>':'')+'<span class="mfb">'+npLab+'</span></div>';
    var rep=info.newPitcher.replaced?('in for '+noAddr(info.newPitcher.replaced)+(info.bio?' · '+esc(info.bio):'')):(info.bio?esc(info.bio):'');
    var nb=rep?'<div class="mfirst"><span class="mfbio">'+rep+'</span></div>':'';
    var nsl=(info.seasonLine&&info.seasonLine.length)?'<div class="mstat"><span class="mssn">SEASON</span> '+info.seasonLine.map(function(s){return '<span class="mfk">'+esc(s[0])+'</span> '+esc(s[1]);}).join('   ')+'</div>':'';
    return '<div class="mcard">'+npHead+nb+nsl+'</div>';
  }
  // First plate appearance of the game: no game line yet, so show "1st AB" plus
  // the batter's school/class and season AVG/RBI/(HR|SB|H). A pinch hitter/runner
  // gets a "PH/PR — pinch hitting for <player>" badge in place of "1st AB". If we
  // have no data on him at all, the card just states it's his first at-bat.
  if(info.firstAB){
    var fb;
    if(info.pinch){
      var verb=info.pinch.type==='pr'?'Pinch running for ':'Pinch hitting for ';
      fb='<div class="mfirst"><span class="mfb pinch">'+(info.pinch.type==='pr'?'PR':'PH')+'</span><span class="mfbio">'+verb+esc(info.pinch['for'])+(info.bio?' · '+esc(info.bio):'')+'</span></div>';
    }else{
      fb='<div class="mfirst"><span class="mfb">1st AB</span>'+(info.bio?'<span class="mfbio">'+esc(info.bio)+'</span>':'')+'</div>';
    }
    // Lead the stat line with a "SEASON" label so these season-to-date numbers
    // aren't mistaken for the current game's line (they read 0-for-0 the same).
    var sl=(info.seasonLine&&info.seasonLine.length)?'<div class="mstat"><span class="mssn">SEASON</span> '+info.seasonLine.map(function(s){return '<span class="mfk">'+esc(s[0])+'</span> '+esc(s[1]);}).join('   ')+'</div>':'';
    return '<div class="mcard">'+head+fb+sl+'</div>';
  }
  var stat=info.line?esc(info.line):'';
  if(info.pitches!=null){
    var pc=esc(String(info.pitches))+' P';
    if(info.strikes!=null)pc+=' ('+esc(String(info.strikes))+' S)';
    stat+=(stat?' · ':'')+pc;
  }
  var prev='';
  if(info.prev&&info.prev.length)prev='<div class="mprev">'+info.prev.map(function(x){
    return '<span class="mpa"><b>'+esc(x.inn)+'</b> '+esc(x.res)+'</span>';}).join('')+'</div>';
  return '<div class="mcard">'+head+(stat?'<div class="mstat">'+stat+'</div>':'')+prev+'</div>';
}
// Map a lineup player name to a roster slug (Gators only), so lineup names can
// open the player profile the same way box-score names do. Built lazily from
// rosterData and reset when the roster (re)loads.
var _gnSlug=null;
function gatorSlug(name){
  if(!rosterData)return null;
  if(!_gnSlug){_gnSlug={};for(var i=0;i<rosterData.length;i++){var p=rosterData[i];
    if(p&&p.name)_gnSlug[String(p.name).toLowerCase().replace(/\s+/g,' ').trim()]=p.slug;}}
  return _gnSlug[String(name||'').toLowerCase().replace(/\s+/g,' ').trim()]||null;
}
function buildLineup(g){
  var L=g.lineups;if(!L||!L.length)return '';
  var gators=null,opp=null;
  L.forEach(function(t){if(t.isGators&&!gators)gators=t;else if(!t.isGators&&!opp)opp=t;});
  if(!gators&&!opp)return '';
  var showGators=lineupTeam!=='opp'&&gators;
  var team=showGators?gators:(opp||gators);
  if(!team||!team.rows||!team.rows.length)return '';
  function nm(t){return t?(t.vh==='H'?g.home.short:g.away.short):'';}
  var curBat=g.live&&g.live.batter?String(g.live.batter).trim():'';
  var battingV=g.live&&g.live.half==='Top';
  var teamBatting=(team.vh==='V')===battingV;
  // Season AVG (from Presto's league hitting leaderboard) is shown for both the
  // Gators and the opponent — the lineup rows already carry seasonAvg for every
  // player, whichever team is on the tab.
  var showAvg=true;
  function sc(v){return '<td class="lpn">'+(v==null?'':esc(String(v)))+'</td>';}
  var rows='';
  team.rows.forEach(function(r){
    var full=r.full||r.name;
    var cur=teamBatting&&curBat&&full===curBat;
    // Gators names link to their profile (matched to the roster, by full name);
    // others stay plain. The display name (r.name) is already "F. Last".
    var slug=team.isGators?gatorSlug(full):null;
    var nmeCell=slug?('<a class="bxp" data-slug="'+esc(slug)+'">'+esc(r.name)+'</a>'):noAddr(r.name);
    // Substitutes (pinch hitters/runners) sit under the player they replaced and
    // share his spot, so drop the number and indent the whole entry — position,
    // number, and name together — under the starter, like the box score. The
    // alphabet reference letter (a-, b-…) prefixes the name and keys the sub
    // legend below, so you can see when the pinch hit/sub happened. The POS and #
    // are wrapped so their sub-row indent is a layout-neutral shift (see .lucd)
    // that doesn't widen those columns for the starters above.
    var cls=(cur?'cur':'')+(r.sub?(cur?' ':'')+'lusub':'');
    var subLet=(r.sub&&r.letter)?'<span class="lusublet">'+esc(r.letter)+'-</span>':'';
    rows+='<tr'+(cls?' class="'+cls+'"':'')+'><td class="lus">'+esc(r.sub?'':String(r.spot||''))+'</td>'+
      '<td><span class="lucd">'+esc(r.pos||'')+'</span></td><td class="luu"><span class="lucd">'+esc(String(r.uni||''))+'</span></td>'+
      '<td class="lunm">'+subLet+nmeCell+'</td>'+
      sc(r.ab)+sc(r.runs)+sc(r.hits)+sc(r.rbi)+sc(r.bb)+sc(r.k)+
      (showAvg?'<td class="lpn lavg">'+esc(r.seasonAvg||'N/A')+'</td>':'')+'</tr>';
  });
  var T=team.totals;
  if(T)rows+='<tr class="pttot"><td class="lus"></td><td></td><td class="luu"></td><td class="lunm">Totals</td>'+
    '<td class="lpn">'+T.ab+'</td><td class="lpn">'+T.runs+'</td><td class="lpn">'+T.hits+'</td>'+
    '<td class="lpn">'+T.rbi+'</td><td class="lpn">'+T.bb+'</td><td class="lpn">'+T.k+'</td>'+(showAvg?'<td class="lpn"></td>':'')+'</tr>';
  var tabs='<div class="lutabs">';
  if(gators)tabs+='<button class="lutab'+(showGators?' on':'')+'" data-lineup="gators">'+esc(nm(gators)||'Gators')+'</button>';
  if(opp)tabs+='<button class="lutab'+(!showGators?' on':'')+'" data-lineup="opp">'+esc(nm(opp)||'Opponent')+'</button>';
  tabs+='</div>';
  var head='<tr><th class="lus"></th><th>Pos</th><th>#</th><th class="lunm">Player</th>'+
    '<th class="lpn">AB</th><th class="lpn">R</th><th class="lpn">H</th><th class="lpn">RBI</th><th class="lpn">BB</th><th class="lpn">K</th>'+
    (showAvg?'<th class="lpn" title="Season batting average">AVG</th>':'')+'</tr>';
  return '<div class="lineup"><div class="luh">Lineup</div>'+tabs+
    '<div class="lubox"><table class="lutbl">'+head+rows+'</table></div>'+lineupSubLegend(team)+lineupNotes(team)+'</div>';
}
// Alphabet substitution ledger under the lineup — one line per pinch hitter/
// runner or defensive sub, keyed to the a-/b- letters on the rows above and
// telling you when he entered ("a- pinch-hit for X in the 7th"), like the box.
function lineupSubLegend(team){
  var L=team&&team.subLegend;if(!L||!L.length)return '';
  var p=L.map(function(s){return '<span class="lusl"><b>'+esc(s.letter)+'-</b>'+esc(s.text||('for '+(s.forName||'')))+'</span>';});
  return '<div class="lusleg">'+p.join('')+'</div>';
}
function lineupNotes(team){
  var n=team&&team.notes;if(!n)return '';
  var keys=['2B','3B','HR','SB','CS','E'];var lines='';
  keys.forEach(function(k){
    var arr=n[k];if(!arr||!arr.length)return;
    var txt=arr.map(function(x){return esc(x.name)+(x.n>1?' '+x.n:'');}).join('; ');
    lines+='<div class="lunote"><span class="lunk">'+k+'</span>'+txt+'</div>';
  });
  return lines?'<div class="lunotes">'+lines+'</div>':'';
}
// "for out 2" / "for outs 1 and 2" tag on the play that recorded the out(s).
// The out number is the count before the play plus one, up to how many it made.
function pbpOutTag(p){
  if(!p||!p.outsMade)return '';
  var nums=[];for(var i=0;i<p.outsMade;i++)nums.push((p.outs||0)+1+i);
  var joined=nums.length===1?String(nums[0]):nums.slice(0,-1).join(', ')+' and '+nums[nums.length-1];
  return ' <span class="pbpout">for out'+(nums.length>1?'s':'')+' '+joined+'</span>';
}
function pbpRow(p){return '<div class="pbprow'+(p.scored?' sc':'')+'"><span class="pbpt">'+esc(p.text)+pbpOutTag(p)+'</span></div>';}
function halfLabel(p){return (p.half==='top'?'▲ Top ':'▼ Bot ')+ord(p.inning);}
function buildPbp(g){
  var plays=g.plays;if(!plays||!plays.length)return '';
  var tabs='<div class="pbptabs"><button class="pbptab'+(pbpView!=='full'?' on':'')+'" data-pbp="half">This Half</button>'
    +'<button class="pbptab'+(pbpView==='full'?' on':'')+'" data-pbp="full">Full Game</button></div>';
  var body;
  if(pbpView==='full'){
    var h='',lastKey='';
    plays.slice().reverse().forEach(function(p){var key=p.inning+p.half;if(key!==lastKey){h+='<div class="pbpih">'+halfLabel(p)+'</div>';lastKey=key;}h+=pbpRow(p);});
    body='<div class="pbplist full" id="pbplist">'+h+'</div>';
  }else{
    // Anchor "This Half" to the live current half (status block), so it clears
    // and switches the moment the next team comes up — even before that half has
    // a narrated play. Fall back to the last play's half for finals / no live.
    var curInn=null,curHalf=null;
    if(g.live&&+g.live.inning){curInn=+g.live.inning;curHalf=(g.live.half==='Top')?'top':'bot';}
    if(curInn==null){var lp=plays[plays.length-1];curInn=lp.inning;curHalf=lp.half;}
    var half=plays.filter(function(p){return p.inning===curInn&&p.half===curHalf;}).reverse();
    var rows=half.length?half.map(pbpRow).join(''):'<div class="pbpempty">No plays yet this half.</div>';
    body='<div class="pbplist" id="pbplist"><div class="pbpih">'+halfLabel({inning:curInn,half:curHalf})+'</div>'+rows+'</div>';
  }
  return '<div class="pbp">'+tabs+body+'</div>';
}
function renderSched(list){
  schedList=list;   // cache so the list can re-render when the hero (featured) game changes
  var done=list.filter(function(g){return g.state==='final'||g.state==='cancelled';}).reverse();
  var up=list.filter(function(g){return g.state==='scheduled';});
  // Show every game except the one already in the hero (curId). Don't blind-drop
  // the first upcoming game: when the hero is a live or sticky-final game it isn't
  // curId, and slicing the first upcoming game would make it vanish entirely.
  var ord=done.concat(up).filter(function(g){return g.id!==curId;}),h='';
  ord.forEach(function(g){
    var pill=g.state==='live'?'<span class="cpill live"><span class="dot"></span>'+g.status+'</span>':g.state==='final'?'<span class="cpill final">'+g.status+' \u203A</span>':'<span class="cpill'+(g.state==='scheduled'?' sched':'')+'">'+esc(g.status)+'</span>';
    var aw=g.state==='final'&&g.away.score>g.home.score,hw=g.state==='final'&&g.home.score>g.away.score;
    function row(t,isG,won){var sc=(g.state==='live'||g.state==='final')&&t.score!=null?t.score:'';var ct=t.city?'<span class="tcity">'+esc(t.city)+'</span> ':'';return '<div class="crow'+(isG?' g':'')+(won?' w':'')+'"><img src="'+t.logo+'" alt=""><span class="n">'+ct+esc(t.nick||t.short)+'</span><span class="s">'+sc+'</span><span class="warrow" aria-label="'+(won?'Winner':'')+'">'+(won?'◀':'')+'</span></div>';}
    h+='<div class="card '+(g.state==='live'?'glive':g.state==='cancelled'?'gcancel':'')+(g.id===curId?' pinned':'')+'" data-state="'+g.state+'" data-id="'+g.id+'">'
      +'<div class="ctop"><span class="cdate">'+g.dateLabel+'</span>'+pill+'</div>'
      +(g.dhLabel?('<div class="cdh">'+esc(g.dhLabel)+'</div>'):'')
      +row(g.away,g.away.id==='et1bt9sixrz5lnnl',aw)+row(g.home,g.home.id==='et1bt9sixrz5lnnl',hw)
      +(g.state==='scheduled'&&g.theme?('<div class="ctheme">🎉 '+esc(g.theme)+' Night</div>'):'')
      +(g.state==='scheduled'&&g.special?('<div class="ctheme">'+(g.special.emoji?esc(g.special.emoji)+' ':'')+esc(g.special.name)+'</div>'+(g.special.detail?('<div class="cpromo">'+esc(g.special.detail)+'</div>'):'')):'')
      +(g.state==='scheduled'&&g.promo?('<div class="cpromo">'+esc(g.promo.emoji)+' <b>'+esc(g.promo.name)+'</b> · '+esc(g.promo.detail)+'</div>'):'')
      +'<div class="cfoot"><span class="cloc">'+esc(g.location||'')+'</span>'
      +(g.state==='final'&&g.replayUrl?('<a class="watchmini replay" href="'+esc(g.replayUrl)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">Replay</a>'):'')
      +(g.state==='scheduled'&&g.freeAdmission?('<span class="watchmini free">Free Admission</span>'):(g.state==='scheduled'&&g.ticketUrl?('<a class="watchmini tickets" href="'+esc(g.ticketUrl)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">Tickets</a>'):''))
      +'</div></div>';
  });
  var html=h||'<div class="note">No Gators games found yet.</div>';
  // The 15s schedule poll usually returns an unchanged list; skip the DOM churn
  // (and listener re-binding) when the markup is identical to what's on screen.
  if(html===_schedHtml)return;
  _schedHtml=html;
  var box=$('sched');
  box.innerHTML=html;
  // One delegated click handler on the container (bound once) instead of one per
  // final card on every render.
  if(!box._boxBound){box._boxBound=true;box.addEventListener('click',function(e){var c=e.target.closest&&e.target.closest('.card[data-state="final"]');if(c)openBox(c.dataset.id);});}
}
function toast(e,t,s,cls){var el=document.createElement('div');el.className='toast '+(cls||'');
  el.innerHTML='<div class="e">'+e+'</div><div><b>'+t+'</b><span>'+s+'</span></div>';$('toasts').appendChild(el);
  requestAnimationFrame(function(){requestAnimationFrame(function(){el.classList.add('show');});});
  setTimeout(function(){el.classList.remove('show');setTimeout(function(){el.remove();},500);},4200);}
function emo(tag){return tag==='lead'?'📣':tag==='final'?'🏁':tag==='run'?'🔥':tag==='start'?'⚾':'🐊';}
function loadSched(){fetch('/api/schedule',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){renderSched(d.games||[]);}).catch(function(){});}
function connect(){
  var sseOk=false,lastStatus='',pollTimer=null,schedTimer=null;
  function applyGame(g){if(g&&g.home){lastStatus=g.status||'';renderGame(applyThirdOutHold(g));if($('viewStandings').style.display!=='none')silentStandings();}}
  function pollGame(){fetch('/api/game',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(applyGame).catch(function(){});}
  // SSE carries live changes as they happen, so the /api/game poll is only a
  // safety net for a stalled stream (e.g. a buffering proxy). Poll fast (5s) only
  // when SSE is down during a live game; back off hard otherwise; and pause
  // entirely while the tab is hidden — visibilitychange refreshes on return.
  function gameDelay(){var live=lastStatus==='live';if(sseOk)return live?15000:60000;return live?5000:30000;}
  function tickGame(){if(!document.hidden)pollGame();pollTimer=setTimeout(tickGame,gameDelay());}
  function tickSched(){if(!document.hidden)loadSched();schedTimer=setTimeout(tickSched,15000);}
  pollGame();
  pollTimer=setTimeout(tickGame,gameDelay());
  schedTimer=setTimeout(tickSched,15000);
  function openSSE(){var es;try{es=new EventSource('/api/stream');}catch(e){return;}
    es.onopen=function(){sseOk=true;};
    es.onmessage=function(ev){sseOk=true;try{var m=JSON.parse(ev.data);if(m.type==='game')applyGame(m.game);else if(m.type==='alert')toast(emo(m.tag),m.title,m.body,(m.tag==='lead'||m.tag==='final')?'lead':'');}catch(x){}};
    es.onerror=function(){sseOk=false;try{es.close();}catch(x){}if(!document.hidden)pollGame();setTimeout(openSSE,8000);};}
  openSSE();
  // Coming back to the foreground: refresh at once instead of waiting out the
  // paused interval.
  document.addEventListener('visibilitychange',function(){if(!document.hidden){pollGame();loadSched();}});}
var _box=null,_boxDate='',_boxSeq=0;
function bsScoreFromLine(line){try{var rows=line.match(new RegExp('<tr[^]*?</tr>','gi'))||[];var rs=[];rows.forEach(function(r){var c=r.match(new RegExp('<t[dh][^]*?</t[dh]>','gi'))||[];if(c.length>3){var nm=c[0].replace(/<[^>]+>/g,'').trim();if(nm&&!/^final$/i.test(nm))rs.push(c[c.length-3].replace(/<[^>]+>/g,'').trim());}});return rs.length>=2?rs[0]+'\u2013'+rs[1]:'';}catch(e){return'';}}
function openBox(id,tab){var m=$('bxModal');m.classList.add('show');m.style.zIndex=++modalZ;syncBg();
  if(!rosterData)loadRoster(); // so tapping a Gators name in the box can open their profile
  tab=tab==='pbp'?'pbp':'box';
  $('tabBox').classList.toggle('on',tab==='box');$('tabPbp').classList.toggle('on',tab==='pbp');
  $('bxTtl').textContent='Box Score';$('bxScore').textContent='';
  // The box id is YYYYMMDD_xxxx, so the game date is known up front \u2014 show it in the
  // header so it's clear which game opened (e.g. from a profile game-log date tap).
  _boxDate=boxDate(id);$('bxDate').textContent=_boxDate;
  $('bxBody').innerHTML='<div class="spin">Loading\u2026</div>';
  loadBoxData(id,tab,0,++_boxSeq);}
// Presto rate-limits (429) or briefly gates a cold box, so a past game's first
// tap can come back empty even though the box exists. Retry transient failures a
// few times with backoff before giving up, and never surface a raw status code.
// The seq guard drops a late retry once the viewer has closed or opened another box.
function loadBoxData(id,tab,attempt,seq){
  var retry=function(){setTimeout(function(){if(seq===_boxSeq)loadBoxData(id,tab,attempt+1,seq);},700*(attempt+1));};
  fetch('/api/boxscore?id='+encodeURIComponent(id)).then(function(r){
    return r.json().then(function(d){return{ok:r.ok,d:d};},function(){return{ok:r.ok,d:null};});
  }).then(function(res){
    if(seq!==_boxSeq)return;
    var d=res.d;
    if(!d||d.error){
      if((!d||d.retry||!res.ok)&&attempt<4){retry();return;}
      $('bxBody').innerHTML='<div class="spin">'+esc((d&&d.error)||'Box score is temporarily unavailable. Please try again in a moment.')+'</div>';
      return;
    }
    _box=d;
    if(d.teams&&d.teams.length>=2)$('bxTtl').textContent=oppShort(d.teams[0])+' @ '+oppShort(d.teams[1]);
    if(d.line){var sc=bsScoreFromLine(d.line);if(sc)$('bxScore').textContent=sc;}
    showTab(tab);
  }).catch(function(){
    if(seq!==_boxSeq)return;
    if(attempt<4){retry();return;}
    $('bxBody').innerHTML='<div class="spin">Could not load box score.</div>';
  });}
function boxNotes(n){if(!n)return '';var order=['2B','3B','HR','SB','CS','E'],p=[];for(var i=0;i<order.length;i++){var k=order[i];if(n[k])p.push('<span class="bxn"><b>'+k+'</b> '+esc(n[k])+'</span>');}return p.length?'<div class="bxnotes">'+p.join('')+'</div>':'';}
function subLegend(L){if(!L||!L.length)return '';var p=L.map(function(s){return '<span class="bxl"><b>'+esc(s.letter)+'-</b>'+esc(s.text||'')+'</span>';});return '<div class="bxleg">'+p.join('')+'</div>';}
function showTab(which){$('tabBox').classList.toggle('on',which==='box');$('tabPbp').classList.toggle('on',which==='pbp');
  var d=_box;if(!d)return;var h='';
  if(which==='box'){
    if(d.line)h+='<div class="bx"><div class="bxwrap">'+d.line+'</div></div>';
    (d.box||[]).forEach(function(b){h+='<div class="bx"><div class="bxwrap">'+b.html+'</div>'+subLegend(b.legend)+boxNotes(b.notes)+'</div>';});
    if(!h)h='<div class="spin">No box score available for this game.</div>';
  }else{
    if((d.pbp||[]).length){h='<div class="pbp">';d.pbp.forEach(function(p){h+=p.html;});h+='</div>';}
    else h='<div class="spin">No play-by-play available for this game.</div>';
  }
  // Date heading on the box content itself (the pinned modal header is easy to lose
  // track of once you're scrolling the tables), so the open box always shows its date.
  var top=_boxDate?'<div class="bxdate">'+esc(_boxDate)+'</div>':'';
  $('bxBody').innerHTML=top+h;$('bxBody').scrollTop=0;}
$('tabBox').addEventListener('click',function(){showTab('box');});
$('tabPbp').addEventListener('click',function(){showTab('pbp');});
// ---- roster + player profiles ----
var rosterData=null,rosterReq=false,rosterPolls=0,rosterRendered=false;
var standingsData=null,standingsReq=false,standingsPolls=0;
var statCache={};            // slug -> {hit,pit,hitRanks,pitRanks}; survives refreshes
var fillQueue=[],filling={},filled={},fillBusy=false;
// Two-way players (e.g. Pierce, McKinley) have BOTH a hitting and a pitching
// line; everyone else needs only one. The league seed gives a two-way player
// their hitting stats, so without this they'd look "done" and never pull pitching.
function needsBoth(p){return !!(p&&p.pos&&/two.?way/i.test(p.pos));}
function pHasStats(p){return needsBoth(p)?!!((p.hit&&p.pit)||filled[p.slug]):!!(p.hit||p.pit);}
// Re-apply any stats we've already learned (server or lazy-fill) onto a fresh payload,
// and absorb newly-arrived ones, so a refresh never blanks a card we'd filled.
function mergeStats(list){
  (list||[]).forEach(function(p){
    var c=statCache[p.slug]||(statCache[p.slug]={});
    if(p.hit){c.hit=p.hit;c.hitRanks=p.hitRanks;}
    if(p.pit){c.pit=p.pit;c.pitRanks=p.pitRanks;}
    if(p.photo){c.photo=p.photo;}
    if(c.hit&&!p.hit){p.hit=c.hit;p.hitRanks=c.hitRanks;}
    if(c.pit&&!p.pit){p.pit=c.pit;p.pitRanks=c.pitRanks;}
    if(c.photo&&!p.photo){p.photo=c.photo;}
  });
}
function clientComplete(){return !!rosterData&&rosterData.every(pHasStats);}
function setRmeta(d){
  if(!rosterData)return;
  var el=$('rmeta');if(el)el.textContent=rosterData.length+' players';
}
function loadStandings(){
  if(standingsReq)return;standingsReq=true;
  fetch('/api/standings',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    standingsReq=false;standingsData=d;renderStandings(d);
    if((!d.rows||!d.rows.length)&&standingsPolls<20){standingsPolls++;setTimeout(function(){standingsData=null;loadStandings();},4000);}
  }).catch(function(){standingsReq=false;$('standingsBody').innerHTML='<div class="spin">Could not load standings. Tap Standings again to retry.</div>';});
}
function fmtPct(p){if(p==null)return '';var s=p.toFixed(3);return p<1?s.replace(/^0/,''):s;}
function fmtGb(g){if(g==null||g===0)return '—';return (g%1)?g.toFixed(1):String(g);}
function renderStandings(d){
  var rows=(d&&d.rows)||[];
  // Scoreboard cards show the reset current-half (2H) W-L, not the full season.
  var recById={};rows.forEach(function(x){if(x.id)recById[x.id]=(x.w2|0)+'-'+(x.l2|0);});
  if(!rows.length){$('standingsBody').innerHTML='<div class="note">Standings aren’t available yet — check back shortly.</div>';$('stMeta').textContent='';}
  else{
    var anyClinch=false;
    // Standings position with ties: teams sharing the same second-half PCT hold
    // the same rank, shown as "T-N" (e.g. four teams at .667 are all "T-1").
    var pos=rows.map(function(x,i){return (i>0&&rows[i-1].pct===x.pct)?null:i+1;});
    for(var pi=1;pi<pos.length;pi++){if(pos[pi]==null)pos[pi]=pos[pi-1];}
    var groupSize={};pos.forEach(function(p){groupSize[p]=(groupSize[p]||0)+1;});
    var haveDiff=rows.some(function(x){return x.diff!=null&&x.diff!==0;});
    var h='<div class="gltbl sttbl"><table><tr><th>#</th><th>Team</th><th title="Second-half W-L">2H</th><th>PCT</th><th>GB</th>'
      +(haveDiff?'<th title="Season run differential">DIFF</th>':'')+'<th>STRK</th><th title="Full-season W-L">Season</th></tr>';
    rows.forEach(function(x,i){
      var isG=x.id&&x.id===d.gatorsId;
      var lg=x.logo?'<img class="stlogo" src="'+esc(x.logo)+'" alt="">':'';
      var sk=x.streak?'<span class="strk '+(/^W/i.test(x.streak)?'win':'loss')+'">'+esc(x.streak)+'</span>':'—';
      var nm=esc(x.name||x.short);
      var clin=x.clinched?('<span class="clinch" title="Won the first half — clinched a playoff spot">🏆<small>1H</small></span>'):'';
      if(x.clinched)anyClinch=true;
      var inner=lg+'<span class="stnm">'+nm+'</span>'+clin;
      var team=x.site?('<a class="stteam" href="'+esc(x.site)+'" target="_blank" rel="noopener">'+inner+'</a>'):('<div class="stteam">'+inner+'</div>');
      var cls=[isG?'stg':'',x.clinched?'stclinch':''].filter(Boolean).join(' ');
      var wl2=(x.w2|0)+'-'+(x.l2|0), wls=(x.ws|0)+'-'+(x.ls|0);
      var rk=(groupSize[pos[i]]>1?'T-':'')+pos[i];
      var dv=(x.diff==null)?0:x.diff;
      var diffTd=haveDiff?('<td class="stdiff '+(dv>0?'pos':dv<0?'neg':'')+'">'+(dv>0?'+':'')+dv+'</td>'):'';
      h+='<tr'+(cls?' class="'+cls+'"':'')+'><td>'+rk+'</td>'
        +'<td>'+team+'</td>'
        +'<td class="stwl2">'+wl2+'</td><td>'+fmtPct(x.pct)+'</td><td>'+fmtGb(x.gb)+'</td>'+diffTd+'<td>'+sk+'</td><td class="stwls">'+wls+'</td></tr>';
    });
    h+='</table></div>';
    if(anyClinch)h+='<div class="stnote"><span class="clinch">🏆<small>1H</small></span> first-half champion — clinched a playoff spot</div>';
    var tbs=(d&&d.tiebreaks)||[];
    if(tbs.length){
      h+='<div class="sttb"><div class="sttbh">Tiebreakers applied</div><ul>';
      tbs.forEach(function(t){h+='<li>'+esc(t)+'</li>';});
      h+='</ul></div>';
    }
    $('standingsBody').innerHTML=h;
    $('stMeta').textContent=d.half===2?'Second-half standings':d.half===1?'First-half standings':'';
  }
  renderPlayoffs(d);
  renderScoreboard(d&&d.scoreboard,d&&d.gatorsId,recById);
}
// A single seeded slot in a playoff matchup card.
function poffSlot(s,gatorsId){
  if(!s)return '';
  var t=s.team;
  var isG=t&&t.id&&gatorsId&&t.id===gatorsId;
  var lg=t&&t.logo?'<img class="poffl" src="'+esc(t.logo)+'" alt="">':'<span class="poffl"></span>';
  var nm=t?esc(t.name||t.short):'TBD';
  var badge=s.clinched?'<span class="poffclinch" title="First-half champion — clinched a playoff spot">🏆<small>1st half</small></span>':'';
  var note=(t&&s.note)?'<span class="poffwhy">'+esc(s.note)+'</span>':'';
  return '<div class="poffslot'+(isG?' g':'')+(t?'':' tbd')+'">'
    +'<span class="poffseed'+(s.clinched?' clin':'')+'">'+s.seed+'</span>'
    +lg+'<span class="poffnm">'+nm+note+'</span>'+badge+'</div>';
}
function renderPlayoffs(d){
  var host=$('poffBody');if(!host)return;
  var p=d&&d.playoffs;
  if(!p||!p.seeds||!p.seeds.length){host.innerHTML='';return;}
  var gid=d&&d.gatorsId;
  var byseed={};p.seeds.forEach(function(s){byseed[s.seed]=s;});
  var provisional=p.seeds.some(function(s){return s.provisional;});
  var h='<div class="sec">Playoff Picture</div><div class="poffwrap">';
  h+='<div class="poffintro">Four teams reach the playoffs: the two first-half champions (seeds 1–2) plus the top two teams of the second half (seeds 3–4).</div>';
  h+='<div class="poffhd"><span>Semifinals</span><span class="pofftag">Best-of-3</span></div>';
  (p.matchups||[]).forEach(function(m){
    h+='<div class="poffmatch">'+poffSlot(byseed[m[0]],gid)+'<div class="poffvs">vs</div>'+poffSlot(byseed[m[1]],gid)+'</div>';
  });
  h+='<ul class="poffrules"><li>Best-of-3 series — first to two wins advances.</li>'
    +'<li>Lower seed hosts Game 1; higher seed hosts Games 2 &amp; 3 (if needed).</li></ul>';
  (p.notes||[]).forEach(function(n){h+='<div class="poffnote">'+esc(n)+'</div>';});
  if(provisional)h+='<div class="poffnote"><span class="poffprov">•</span> Seeds 3 &amp; 4 reflect the current second-half standings and can still change.</div>';
  h+='</div>';
  host.innerHTML=h;
}
function sbScore(v){return (v==null||v==='')?'':v;}
// Compact the inning label for the card: drop "of" and shorten the half word
// ("Bottom of 7th" -> "Bot 7th", "Middle of 3rd" -> "Mid 3rd").
function sbCompactInn(s){
  return String(s||'').replace(/\bof\s+/i,'').replace(/^Bottom/i,'Bot').replace(/^Middle/i,'Mid').replace(/^End/i,'End');
}
// Bases diamond: 2nd at top, 1st at right, 3rd at left (catcher's view); a base
// fills gold when occupied. b is {first,second,third} booleans.
function sbDiamond(b){
  if(!b)return '';
  function sq(cx,cy,on){return '<rect x="'+(cx-3.6)+'" y="'+(cy-3.6)+'" width="7.2" height="7.2" rx="1.2" transform="rotate(45 '+cx+' '+cy+')"'+(on?' class="on"':'')+'/>';}
  return '<svg class="sbdia" width="30" height="26" viewBox="0 0 30 26" aria-hidden="true">'+sq(15,7,b.second)+sq(23,15,b.first)+sq(7,15,b.third)+'</svg>';
}
function sbStatus(g){
  if(g.state==='final')return g.status||'Final';
  if(g.state==='live')return g.status||'Live';
  if(g.state==='postponed'||g.state==='cancelled'||g.state==='suspended')return g.status;
  return g.status||'Scheduled';
}
function sbTeamRow(t,win,isGt,showScore,recById,fin){
  var lg=t.logo?'<img class="sbl" src="'+esc(t.logo)+'" alt="">':'<span class="sbl"></span>';
  var sc=showScore?esc(String(sbScore(t.score))):'';
  var rec=(recById&&t.id&&recById[t.id])?('<span class="sbrec">('+esc(recById[t.id])+')</span>'):'';
  // Winner triangle only on finals (a live leader is shown bold, no arrow).
  var tri=(fin&&win)?'<span class="sbtri"></span>':'';
  var ct=t.city?'<span class="tcity">'+esc(t.city)+'</span> ':'';
  // Keep the record inside the name so it flows right after the last word and
  // wraps with it — a long name like "San Antonio River Monsters" reads as one
  // block instead of leaving the record floating beside a two-line name.
  return '<div class="sbrow'+(win?' w':'')+(isGt?' gt':'')+'">'+lg+'<span class="sbn">'+ct+esc(t.nick||t.short||'')+rec+'</span><span class="sbsc">'+tri+'<span class="sbs">'+sc+'</span></span></div>';
}
function renderScoreboard(sb,gatorsId,recById){
  var games=(sb&&sb.games)||[];
  $('sbSec').style.display='';
  $('sbMeta').textContent=(sb&&sb.dateLabel)||'';
  if(!games.length){$('scoreboardBody').innerHTML='<div class="note">No league games scheduled for this day.</div>';return;}
  var h='';
  games.forEach(function(g){
    var fin=g.state==='final',live=g.state==='live';
    var sched=!fin&&!live;
    var haveScores=g.away.score!=null&&g.home.score!=null;
    // Bold the winner (final) or the current leader (live); plain on ties.
    var aw=haveScores&&(fin||live)&&g.away.score>g.home.score;
    var hw=haveScores&&(fin||live)&&g.home.score>g.away.score;
    // Namespaced state class (sblive/sbfinal/sbsched) so the card doesn't pick
    // up the global .live gamecast rule, which turned it into a tall bordered
    // column and doubled the height when a game went live.
    var st=live?'sblive':fin?'sbfinal':'sbsched';
    var showScore=fin||live;
    // Status block: scheduled games show the start time as time-over-zone so a
    // long team name keeps its room; live/final show compact inning, then outs +
    // bases diamond for live games (any live game we have feed data for).
    var stat;
    if(sched){
      var ts=String(sbStatus(g)).trim().split(' ').filter(Boolean);
      var tz=ts.length>2?ts.pop():'';
      stat='<div class="sbtime">'+esc(ts.join(' '))+'</div>'+(tz?'<div class="sbtz">'+esc(tz)+'</div>':'');
    }else{
      stat='<div class="sbinn">'+esc(live?sbCompactInn(g.status):sbStatus(g))+'</div>';
      if(live){
        var topOrBot=/^(top|bot)/i.test(g.status||'');
        if(topOrBot&&g.outs!=null)stat+='<div class="sbouts">'+g.outs+' Out'+(g.outs===1?'':'s')+'</div>';
      }
    }
    // Bases diamond sits in its own column to the right of the scores (not
    // stacked under the status), so a live game keeps the same card height as a
    // scheduled/final one instead of growing when the diamond appears.
    var dia=(live&&/^(top|bot)/i.test(g.status||'')&&g.bases)?sbDiamond(g.bases):'';
    var tag=g.url?'a':'div',attr=g.url?(' href="'+esc(g.url)+'" target="_blank" rel="noopener"'):'';
    h+='<'+tag+' class="sbg'+(g.isGators?' g':'')+' '+st+'"'+attr+'>'
      +'<div class="sbteams">'+sbTeamRow(g.away,aw,g.away.id===gatorsId,showScore,recById,fin)+sbTeamRow(g.home,hw,g.home.id===gatorsId,showScore,recById,fin)+'</div>'
      +dia
      +'<div class="sbstat '+st+'">'+stat+'</div></'+tag+'>';
  });
  $('scoreboardBody').innerHTML=h;
}
function silentStandings(){
  fetch('/api/standings',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    if(d&&d.rows){standingsData=d;renderStandings(d);}
  }).catch(function(){});
}
function setView(v){
  $('viewScores').style.display=v==='scores'?'':'none';
  $('viewRoster').style.display=v==='roster'?'':'none';
  $('viewStandings').style.display=v==='standings'?'':'none';
  $('navScores').classList.toggle('on',v==='scores');
  $('navRoster').classList.toggle('on',v==='roster');
  $('navStandings').classList.toggle('on',v==='standings');
  if(v==='roster'&&!rosterData)loadRoster();
  if(v==='standings'&&!standingsData)loadStandings();
}
function loadRoster(){
  if(rosterReq)return;rosterReq=true;
  fetch('/api/roster').then(function(r){return r.json();}).then(function(d){
    rosterReq=false;rosterData=d.players||[];_gnSlug=null;mergeStats(rosterData);
    // Full render only the first time. Re-polls (every 4s until stats + photos are in)
    // must NOT rebuild rosterBody's innerHTML — that recreates every <img class="ppic">,
    // forcing the browser to re-fetch/re-decode each headshot and making them flicker.
    // Instead patch photos and stats onto the existing cards in place.
    if(rosterRendered)patchRoster(d);else{renderRoster(d);rosterRendered=true;}
    // Re-render a live game so its lineup names pick up profile links now the roster is in.
    if(lastGame&&lastGame.status==='live')renderGame(lastGame);
    lazyFill();
    // Keep polling until stats are complete AND headshots have loaded, so a fast
    // (cached) stats response doesn't leave profiles photoless.
    if((!clientComplete()||!d.photos)&&rosterPolls<60){rosterPolls++;setTimeout(function(){loadRoster();},4000);}
  }).catch(function(){rosterReq=false;if(!rosterRendered)$('rosterBody').innerHTML='<div class="spin">Could not load the roster. Tap Roster again to retry.</div>';});
}
// Fill freshly-arrived headshots and stats onto already-rendered cards without
// touching img elements that are already in place (which is what caused the
// flicker). Falls back to a full re-render only if the card set itself changed.
function patchRoster(d){
  var body=$('rosterBody');
  if(!body||!body.querySelector('.pcard')){renderRoster(d);return;}
  for(var i=0;i<rosterData.length;i++){var p=rosterData[i];
    var card=body.querySelector('.pcard[data-slug="'+p.slug+'"]');
    if(!card){renderRoster(d);return;} // roster membership changed — rebuild once
    patchPhoto(card,p.photo,p.name);
    updateCardStats(p);
  }
  if(d&&d.coaches){coachData=d.coaches;
    for(var k=0;k<d.coaches.length;k++){var c=d.coaches[k];
      var ccard=body.querySelector('.pcard.coach[data-coachnum="'+c.num+'"]');
      if(ccard)patchPhoto(ccard,c.photo,c.name);
    }
  }
  setRmeta(d);
}
// Swap a card's initials placeholder for its headshot once the photo arrives.
// Leaves an existing <img> untouched so it never re-loads.
function patchPhoto(card,photo,name){
  if(!photo)return;
  var box=card.querySelector('.pnum');if(!box||box.querySelector('img.ppic'))return;
  box.innerHTML='<img class="ppic" loading="lazy" decoding="async" src="'+esc(photo)+'" alt="">';
}
// Safety net: individually pull any card still blank (same call a tap makes),
// one at a time and gently, so the list finishes filling even if the poll lagged.
function lazyFill(){
  if(!rosterData)return;
  rosterData.forEach(function(p){
    if(!pHasStats(p)&&!filling[p.slug]){filling[p.slug]=1;fillQueue.push(p.slug);}
  });
  if(!fillBusy)pumpFill();
}
function pumpFill(){
  if(!fillQueue.length){fillBusy=false;return;}
  fillBusy=true;var slug=fillQueue.shift();
  fetch('/api/player?slug='+encodeURIComponent(slug)).then(function(r){return r.json();}).then(function(d){
    filled[slug]=1; // we've pulled the full record; don't keep re-queuing it
    if(!d||(!d.hit&&!d.pit))return;
    var c=statCache[slug]||(statCache[slug]={});
    if(d.hit){c.hit=d.hit;c.hitRanks=d.hitRanks||{};}
    if(d.pit){c.pit=d.pit;c.pitRanks=d.pitRanks||{};}
    var p=null;for(var i=0;i<rosterData.length;i++)if(rosterData[i].slug===slug)p=rosterData[i];
    if(p){if(d.hit){p.hit=d.hit;p.hitRanks=d.hitRanks||p.hitRanks;}if(d.pit){p.pit=d.pit;p.pitRanks=d.pitRanks||p.pitRanks;}updateCardStats(p);setRmeta();}
  }).catch(function(){}).then(function(){setTimeout(pumpFill,600);});
}
function updateCardStats(p){
  var card=document.querySelector('.pcard[data-slug="'+p.slug+'"]');if(!card)return;
  var st=card.querySelector('.pstat');if(!st)return;
  var tmp=document.createElement('div');tmp.innerHTML=cardStats(p);
  var neu=tmp.firstChild;if(neu)card.replaceChild(neu,st);
}
function agoTxt(ts){if(!ts)return '';var m=Math.round((Date.now()-ts)/60000);if(m<1)return 'just now';if(m<60)return m+'m ago';return Math.round(m/60)+'h ago';}
function sline(o,keys){var out=[];for(var i=0;i<keys.length;i++){var k=keys[i][0],lab=keys[i][1];if(o&&o[k]!=null&&o[k]!==''&&o[k]!=='-')out.push('<span class="k">'+lab+'</span>'+o[k]);}return out.join('  ');}
// A pure pitcher (pos "P") shows only pitching on the list view until he has 10+
// at-bats — his hitting still appears on the full profile. Two-way players are
// pos "Two-Way" and always show both.
// Show pitchers as LHP/RHP based on the hand they throw with; everyone else
// (two-way, position players) keeps their listed position.
function posLabel(p){
  if(p.pos&&/^p$/i.test(String(p.pos).trim()))return String(p.t||'').toUpperCase()==='L'?'LHP':'RHP';
  return p.pos;
}
function cardPitcherOnly(p){
  if(!p.pos||!/^p$/i.test(String(p.pos).trim()))return false;
  var ab=p.hit&&p.hit.ab;return (ab==null?0:Number(ab)||0)<10;
}
function cardStats(p){
  // Third stat is HR when the hitter has one, otherwise Hits — so every hitter
  // shows three stats instead of dropping to two when HR is 0.
  var third=['h','H'];
  if(p.hit){var hr=p.hit.hr;if(hr!=null&&hr!==''&&hr!=='-'&&Number(hr)>0)third=['hr','HR'];}
  var bat=(p.hit&&!cardPitcherOnly(p))?('<div class="pstline">'+sline(p.hit,[['avg','AVG'],third,['rbi','RBI']])+'</div>'):'';
  var pit=p.pit?('<div class="pstline pit">'+sline(p.pit,[['era','ERA'],['ip','IP'],['k','K']])+'</div>'):'';
  if(!bat&&!pit)return '<div class="pstat"><span class="plimited">—</span></div>';
  return '<div class="pstat">'+bat+pit+'</div>';
}
// Dormant: renders the team batting/pitching card. Currently no-ops because the
// server withholds d.teamStats from /api/roster (kept for easy re-enable).
function teamStatsCard(ts){
  if(!ts||(!ts.batting&&!ts.pitching))return '';
  function cell(k,v){return '<div class="tscell"><div class="tsk">'+k+'</div><div class="tsv">'+esc(String(v))+'</div></div>';}
  var h='<div class="tscard">';
  if(ts.batting){var b=ts.batting;
    h+='<div class="tsgrp"><div class="tshd">Team Batting</div><div class="tsrow">'+
      cell('AVG',b.avg)+cell('OBP',b.obp)+cell('SLG',b.slg)+cell('HR',b.hr)+'</div></div>';}
  if(ts.pitching){var p=ts.pitching;
    var cells=cell('ERA',p.era)+cell('WHIP',p.whip)+cell('BB/9',p.bb9)+cell('K/9',p.k9)+
      (p.strikePct!=null?cell('STR%',p.strikePct+'%'):'');
    h+='<div class="tsgrp"><div class="tshd">Pitching Staff</div><div class="tsrow">'+cells+'</div></div>';}
  return h+'</div>';
}
function pInitials(name){var w=String(name||'').trim().split(/\s+/);return (((w[0]||'')[0]||'')+((w.length>1?(w[w.length-1][0]||''):''))).toUpperCase();}
function renderRoster(d){
  var arr=rosterData.slice().sort(function(a,b){return a.num-b.num;});
  var h=teamStatsCard(d&&d.teamStats);
  for(var i=0;i<arr.length;i++){var p=arr[i];
    // Profile photo fills the avatar box; falls back to the player's initials when
    // we don't have a headshot yet. The jersey number moves beside the name (gold).
    var box=p.photo?('<img class="ppic" loading="lazy" decoding="async" src="'+esc(p.photo)+'" alt="">'):('<span class="pinit">'+esc(pInitials(p.name))+'</span>');
    h+='<div class="pcard" data-slug="'+p.slug+'">'+
       '<div class="pnum">'+box+'</div>'+
       '<div class="pmain"><div class="pname"><span class="pnametext">'+esc(p.name)+'</span><span class="pjersey">'+(p.numTBD?'TBD':'#'+p.num)+'</span></div>'+
       '<div class="pmeta"><b>'+esc(posLabel(p))+'</b>'+[p.cls,p.school].filter(Boolean).map(function(x){return ' · '+esc(x);}).join('')+'</div></div>'+
       cardStats(p)+'<div class="pchev">›</div></div>';
  }
  if(d&&d.coaches&&d.coaches.length){
    coachData=d.coaches;
    h+='<div class="csec">Coaching Staff</div>';
    for(var k=0;k<d.coaches.length;k++){var c=d.coaches[k];
      var cbox=c.photo?('<img class="ppic" loading="lazy" decoding="async" src="'+esc(c.photo)+'" alt="">'):('<span class="pinit">'+esc(pInitials(c.name))+'</span>');
      h+='<div class="pcard coach" data-coachnum="'+c.num+'">'+
         '<div class="pnum coachico">'+cbox+'</div>'+
         '<div class="pmain"><div class="pname"><span class="pnametext">'+esc(c.name)+'</span><span class="pjersey">#'+c.num+'</span></div>'+
         '<div class="pmeta"><b>'+esc(c.title)+'</b>'+(c.home?(' · '+esc(c.home)):'')+'</div></div>'+
         '<div class="pchev">›</div></div>';
    }
  }
  $('rosterBody').innerHTML=h;
  setRmeta(d);
  var cards=document.querySelectorAll('.pcard:not(.coach)');
  for(var j=0;j<cards.length;j++)cards[j].addEventListener('click',function(){openPlayer(this.getAttribute('data-slug'));});
  var ccards=document.querySelectorAll('.pcard.coach');
  for(var cc=0;cc<ccards.length;cc++)ccards[cc].addEventListener('click',function(){openCoach(this.getAttribute('data-coachnum'));});
}
function bi(label,val){return '<div class="bi"><span>'+label+'</span>'+esc(val)+'</div>';}
function scell(o,rk,k,lab){if(!o||o[k]==null||o[k]===''||o[k]==='-')return '';var r=(rk&&rk[k])?'<div class="rk">'+esc(rk[k])+'</div>':'';return '<div class="scell"><div class="v">'+esc(o[k])+'</div><div class="l">'+lab+'</div>'+r+'</div>';}
function sgrid(o,rk,defs){var c='';for(var i=0;i<defs.length;i++)c+=scell(o,rk,defs[i][0],defs[i][1]);return c?'<div class="sgrid">'+c+'</div>':'<div class="plimited" style="padding:2px">No qualifying stats yet.</div>';}
function statBlocks(p){
  var hitDefs=[['avg','AVG'],['obp','OBP'],['slg','SLG'],['gp','G'],['ab','AB'],['h','H'],['hr','HR'],['rbi','RBI'],['r','R'],['bb','BB'],['k','K']];
  // Only show Stolen Bases once a player actually has one — no 0/empty box.
  if(p.hit&&Number(p.hit.sb)>0)hitDefs.push(['sb','SB']);
  var batBlock=p.hit?('<div class="statblock"><h4 class="bat">Hitting</h4>'+sgrid(p.hit,p.hitRanks,hitDefs)+'</div>'):'';
  var pitBlock=p.pit?('<div class="statblock"><h4>Pitching</h4>'+sgrid(p.pit,p.pitRanks,[['era','ERA'],['whip','WHIP'],['ip','IP'],['w','W'],['l','L'],['sv','SV'],['app','APP'],['gs','GS'],['k','K'],['bb','BB'],['h','H'],['er','ER']])+'</div>'):'';
  // A just-added player carries a one-off note (e.g. "recently activated") shown
  // until his first game lands stats; everyone else gets the generic line.
  if(!batBlock&&!pitBlock)return '<div class="statblock"><div class="plimited" style="padding:2px">'+esc(p.note||'Season stats will appear here once this player records game action.')+'</div></div>';
  // Legend for the small gold rank — only ranks are a hitting thing, so it sits
  // directly under the Hitting block (and above Pitching for two-way players).
  var hasRanks=(p.hitRanks&&Object.keys(p.hitRanks).length)||(p.pitRanks&&Object.keys(p.pitRanks).length);
  var legend=hasRanks?'<div class="ranklegend">The <b>gold number</b> under each stat is its rank in the Texas Collegiate League.</div>':'';
  return batBlock+legend+pitBlock;
}
var plCur=null;
var coachData=[];
// Coaches reuse the player modal: number badge, name, title/hometown, and the
// bio from the team site. No stats or game log, so plCur is cleared to cancel any
// in-flight player fetch that might otherwise repaint the modal body.
function openCoach(num){
  var c=null;for(var i=0;i<coachData.length;i++)if(String(coachData[i].num)===String(num))c=coachData[i];
  if(!c)return;plCur=null;
  var ph=$('plNum');ph.classList.remove('hasimg');ph.textContent=c.num;
  if(c.photo){var im=new Image();im.alt=c.name;
    im.onload=function(){ph.classList.add('hasimg');ph.innerHTML='';ph.appendChild(im);};
    im.src=c.photo;}
  $('plName').textContent=c.name;
  $('plSub').textContent=c.title+(c.home?(' · '+c.home):'');
  var info='<div class="bio">'+bi('Role',c.title)+(c.home?bi('Hometown',c.home):'')+'</div>';
  var bioBlock=c.bio?('<div class="statblock"><h4>Bio</h4><p class="cbio">'+esc(c.bio)+'</p></div>'):'';
  $('plBody').innerHTML=info+bioBlock;
  $('plModal').classList.add('show');$('plModal').style.zIndex=++modalZ;syncBg();
}
function openPlayer(slug){
  var p=null;for(var i=0;i<rosterData.length;i++)if(rosterData[i].slug===slug)p=rosterData[i];
  if(!p)return;plCur=slug;
  var ph=$('plNum');ph.classList.remove('hasimg');ph.textContent=p.numTBD?'TBD':p.num;
  if(p.photo){var im=new Image();im.alt=p.name;
    im.onload=function(){ph.classList.add('hasimg');ph.innerHTML='';ph.appendChild(im);};
    im.src=p.photo;}
  $('plName').textContent=p.name;
  $('plSub').textContent=[posLabel(p),p.cls,p.school].filter(Boolean).join(' · ');
  var bio='<div class="bio">'+bi('Bats / Throws',(p.b||'—')+' / '+(p.t||'—'))+
    bi('Ht / Wt',(p.ht||'—')+(p.wt?(' · '+p.wt):''))+
    bi('Hometown',p.home||'—')+bi('School',p.school||'—')+
    (p.bday?bi('Birthday',p.bday):'')+'</div>';
  $('plBody').innerHTML=bio+'<div id="plStats">'+statBlocks(p)+'</div><div id="plGl"><div class="spin" style="padding:16px">Loading game log…</div></div>';
  $('plModal').classList.add('show');$('plModal').style.zIndex=++modalZ;syncBg();
  fetch('/api/player?slug='+encodeURIComponent(slug)).then(function(r){return r.json();}).then(function(d){
    if(plCur!==slug)return;
    var m=Object.assign({},p);
    if(d.hit){m.hit=d.hit;m.hitRanks=d.hitRanks||p.hitRanks;}
    if(d.pit){m.pit=d.pit;m.pitRanks=d.pitRanks||p.pitRanks;}
    var ps=$('plStats');if(ps)ps.innerHTML=statBlocks(m);
    renderGameLog(d);
  }).catch(function(){var g=$('plGl');if(g)g.innerHTML='';});
}
function renderGameLog(d){
  var g=$('plGl');if(!g)return;var h='';
  var bat=(d.glBat||[]).slice().reverse(),pit=(d.glPit||[]).slice().reverse();
  if(pit.length)h+='<div class="statblock"><h4>Pitching — Game by Game</h4>'+glTable(pit,[['ip','IP'],['h','H'],['r','R'],['er','ER'],['bb','BB'],['k','K'],['era','ERA']])+'</div>';
  if(bat.length)h+='<div class="statblock"><h4 class="bat">Hitting — Game by Game</h4>'+glTable(bat,[['ab','AB'],['h','H'],['hr','HR'],['rbi','RBI'],['bb','BB'],['k','K'],['avg','AVG']])+'</div>';
  g.innerHTML=h;
}
function glTable(rows,cols){
  var h='<div class="gltbl"><table><tr><th>Date</th><th>Opp</th>';
  for(var i=0;i<cols.length;i++)h+='<th>'+cols[i][1]+'</th>';
  h+='</tr>';
  for(var j=0;j<rows.length;j++){var row=rows[j];
    var dt=row.boxId?('<a class="gld" role="button" tabindex="0" data-glbox="'+esc(row.boxId)+'">'+esc(row.date)+'</a>'):esc(row.date);
    h+='<tr><td>'+dt+'</td><td>'+esc(oppShort(row.opp))+'</td>';
    for(var i2=0;i2<cols.length;i2++){var v=row[cols[i2][0]];h+='<td>'+((v==null||v===''||v==='-')?'·':esc(v))+'</td>';}
    h+='</tr>';
  }
  return h+'</table></div>';
}
// Box id is YYYYMMDD_xxxx -> "Jun 24, 2026" for the box-score modal header.
function boxDate(id){var m=/^(\d{4})(\d{2})(\d{2})/.exec(id||'');if(!m)return '';
  var mon=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2]-1];
  return mon?(mon+' '+(+m[3])+', '+m[1]):'';}
function oppShort(o){o=(o||'').replace('at ','@ ');var map={'Acadiana Cane Cutters':'Acadiana','Baton Rouge Rougarou':'Baton Rouge','Abilene Flying Bison':'Abilene','Brazos Valley Bombers':'Brazos Valley','San Antonio River Monsters':'San Antonio','Sherman Shadowcats':'Sherman','Victoria Generals':'Victoria','Lake Charles Gumbeaux Gators':'Gators'};for(var k in map)o=o.replace(k,map[k]);return o;}
$('navScores').addEventListener('click',function(){setView('scores');});
$('navStandings').addEventListener('click',function(){setView('standings');});
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-pbp]');if(b)setPbpView(b.getAttribute('data-pbp'));});
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-lineup]');if(b)setLineupTeam(b.getAttribute('data-lineup'));});
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-final]');if(b)openBox(b.getAttribute('data-id'),b.getAttribute('data-final'));});
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a.bxp[data-slug]');if(a){e.preventDefault();openPlayer(a.getAttribute('data-slug'));}});
// Game-log date → our in-app box score for that game (not PrestoSports). openBox
// raises its modal to the front, so it layers over the open player profile.
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-glbox]');if(b){e.preventDefault();openBox(b.getAttribute('data-glbox'),'box');}});
$('navRoster').addEventListener('click',function(){setView('roster');});
// Most-recently-opened modal wins: each open bumps this so it stacks on top,
// regardless of DOM order (player→box and box→player both layer correctly).
var modalZ=80;
function syncBg(){document.body.classList.toggle('noscroll',!!document.querySelector('.modal.show'));}
$('plClose').addEventListener('click',function(){$('plModal').classList.remove('show');syncBg();});
$('plModal').addEventListener('click',function(e){if(e.target===this){this.classList.remove('show');syncBg();}});
$('bxClose').addEventListener('click',function(){$('bxModal').classList.remove('show');syncBg();});
$('bxModal').addEventListener('click',function(e){if(e.target===this){this.classList.remove('show');syncBg();}});
// ---- Add to Home Screen prompt (Android install prompt; iOS shows how-to) ----
(function(){
  if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(function(){});
  var dp=null,b=$('a2hs');
  function standalone(){return window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;}
  function isIOS(){return /iphone|ipad|ipod/i.test(navigator.userAgent)&&!window.MSStream;}
  function dismissed(){try{return localStorage.getItem('a2hsX')==='1';}catch(e){return false;}}
  function isTouch(){return ('ontouchstart' in window)||navigator.maxTouchPoints>0||window.matchMedia('(pointer: coarse)').matches;}
  function show(){if(b&&isTouch()&&!standalone()&&!dismissed())b.classList.add('show');}
  function hide(){if(b)b.classList.remove('show');}
  window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();dp=e;$('a2hsadd').style.display='';show();});
  window.addEventListener('appinstalled',function(){hide();dp=null;try{localStorage.setItem('a2hsX','1');}catch(e){}});
  $('a2hsadd').addEventListener('click',function(){if(!dp)return;dp.prompt();dp.userChoice.then(function(){hide();dp=null;});});
  $('a2hsx').addEventListener('click',function(){try{localStorage.setItem('a2hsX','1');}catch(e){}hide();});
  // iOS Safari can't trigger the prompt programmatically — show the how-to instead.
  if(isIOS()&&!/crios|fxios|edgios/i.test(navigator.userAgent)){
    $('a2hsadd').style.display='none';
    $('a2hsmsg').innerHTML='Tap <b style="color:var(--gold2)">Share</b>, then "Add to Home Screen".';
    setTimeout(show,1800);
  }
})();
// Auto-update: the live lineup, abbreviations, and Due Up all render client-side,
// so a stale cached page can keep showing old/incorrect output even after a
// deploy. Compare the running build to the server's; when it changes, reload with
// a cache-busting param so no stale JS lingers. Check on foreground + periodically.
(function(){
  var BUILT='__BUILD_COMMIT__';var reloading=false;
  function check(){
    if(reloading||document.hidden)return;
    fetch('/api/version',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
      if(d&&d.commit&&BUILT&&d.commit!==BUILT){reloading=true;location.replace(location.pathname+'?b='+encodeURIComponent(d.commit));}
    }).catch(function(){});
  }
  document.addEventListener('visibilitychange',function(){if(!document.hidden)check();});
  setInterval(check,300000);
  setTimeout(check,4000);
})();
connect();loadSched();loadRoster();</script></body></html>`;
// BUILD_LABEL and BUILD.commit are fixed at boot, so resolve the page once here
// instead of running APP.replace() (allocating a fresh ~95 KB string) per request.
const SITE_NOTICE_HTML = SITE_NOTICE
  ? '<div class="sitenotice">⚠️<span><b>Notice:</b> ' + SITE_NOTICE + '</span></div>'
  : '';
const APP_HTML = APP.replace('__BUILD_LABEL__', BUILD_LABEL).replace('__BUILD_COMMIT__', BUILD.commit)
  .replace('__SITE_NOTICE__', SITE_NOTICE_HTML);
