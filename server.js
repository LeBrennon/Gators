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
// Split-season tracking. The TCL plays two halves; each half's winner clinches a
// playoff berth. Standings shown below reflect the current half, with clinched
// teams tagged "x-" regardless of where their (reset) second-half record sits.
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
const BS_PA_RE = /^(singled|doubled|tripled|homered|home run|walked|intentionally walked|struck out|grounded|flied|popped|lined|reached|hit by pitch|hit into|fouled|sacrific|infield fly|bunt|out at|grounded into)\b/i;
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
  let line = null; const batting = [], pitching = [], pbp = [], types = [];
  for (const t of tables) {
    const tx = bsText(t);
    let type = 'other';
    if (/(?:Top|Bottom) of /i.test(tx) && /Inning/i.test(tx)) {
      type = 'pbp';
      const m = tx.match(/(.*?(?:Top|Bottom) of .*?Inning)/i);
      pbp.push({ title: m ? m[1].trim() : 'Inning', html: bsClean(t) });
    } else if (/\bHitters\b/i.test(tx)) { type = 'batting'; batting.push(bsClean(t)); }
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
    box.push({ label: lab(i) + ' \u2014 Batting', html: sub.html, legend: sub.legend, notes: notes[i] || null });
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
// League first pitch is 7:05pm Central, except Sundays at 6:05pm. The schedule
// page's listed times are unreliable, so derive the start time from the date.
function gameTimeCDT(yyyymmdd) {
  const y = +yyyymmdd.slice(0,4), m = +yyyymmdd.slice(4,6), d = +yyyymmdd.slice(6,8);
  const dow = new Date(Date.UTC(y, m-1, d, 12)).getUTCDay();
  return (dow === 0 ? '6:05' : '7:05') + ' PM CDT';
}
// ----- helpers --------------------------------------------------------------
function ordinal(n){ const s=['th','st','nd','rd'], v=n%100; return n + (s[(v-20)%10] || s[v] || s[0]); }
function cap(w){ return w ? w.charAt(0).toUpperCase()+w.slice(1).toLowerCase() : w; }
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
    const ex = text.match(/Final[^<0-9]*?(\d+)\s*innings?/i);
    return { state: 'final', status: ex ? 'Final/' + ex[1] : 'Final' };
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

async function fetchText(url, referer) {
  const headers = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', 'cache-control': 'no-cache' };
  if (referer) headers.referer = referer;
  const res = await fetch(url, { headers });
  const body = await res.text();
  return { ok: res.ok, status: res.status, contentType: res.headers.get('content-type') || '', body };
}

async function fetchLiveUpdate(e, h, referer) {
  // h is base64 (may contain / + =), so it must be percent-encoded for the query.
  const url = ORIGIN + '/action/sports/liveupdate?e=' + encodeURIComponent(e) + (h ? '&h=' + encodeURIComponent(h) : '');
  const headers = { 'user-agent': UA, 'accept': 'application/json, text/javascript, */*; q=0.01',
    'x-requested-with': 'XMLHttpRequest', 'cache-control': 'no-cache' };
  if (referer) headers.referer = referer;
  const res = await fetch(url, { headers });
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
  const info = { name: nm, uni: p && p.uni ? String(p.uni) : null,
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
// outs, scored flag, and the human-readable text.
function summarizePlays(json) {
  const root = json && json.plays;
  if (!root || !Array.isArray(root.inning)) return [];
  const out = [];
  for (const inn of root.inning) {
    const num = +val(inn.number) || 0;
    for (const half of (inn.batting || [])) {
      const side = half.vh === 'H' ? 'bot' : 'top';
      const team = String(half.id || '').trim();
      for (const p of (half.play || [])) {
        const text = (p.narrative && val(p.narrative.text)) ? String(val(p.narrative.text)).trim() : '';
        if (!text) continue;
        out.push({ inning: num, half: side, team, outs: Number(val(p.outs)) || 0,
          scored: /\bscored\b|homer|grand slam/i.test(text), text });
      }
    }
  }
  return out;
}

// The current batter's completed plate appearances earlier in THIS game, read
// from the play-by-play. Each play's narrative leads with the batter's name
// ("Bankston Lembcke lined out to cf ..."), so a play belongs to this batter
// when its text starts with their name AND the remainder opens with a plate-
// appearance verb (BS_PA_RE) — which skips baserunning sub-rows ("stole second",
// "advanced to third"). Powers the "what they've done today" line on the live
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
    // Show the batter's earlier at-bats this game on the live at-bat card; on his
    // FIRST plate appearance (no prior PAs) there's no game line yet, so swap in
    // his school/class + season AVG/RBI/(HR|SB|H) instead.
    if (out.live && out.live.batterInfo && out.live.batter) {
      out.live.batterInfo.prev = batterPriorPAs(out.plays, out.live.batter);
      if (!out.live.batterInfo.prev.length) {
        Object.assign(out.live.batterInfo, firstAbStats(out.live.batter));
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
    // he's flagged PH/PR.
    const seenSpot = new Set();
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
      return {
        spot,
        pos,
        uni: o.uni != null ? String(o.uni) : (p.uni != null ? String(p.uni) : ''),
        // name = display ("F. Last", server-formatted); full = full name kept for
        // profile-link matching and current-batter highlighting on the client.
        name: abbrev(full),
        full,
        bats: String(p.bats || '').toUpperCase(),
        seasonAvg: seasonAvgFor(full),   // season-to-date AVG for the lineup
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
    const lastName = p => p.revname ? String(p.revname).split(',')[0].trim()
      : String(p.name || '').trim().split(/\s+/).slice(-1)[0] || '';
    const notes = { '2B': [], '3B': [], 'HR': [], 'SB': [], 'CS': [], 'E': [] };
    players.forEach(p => {
      const h = p.hitting || {}, fl = p.fielding || {};
      const add = (k, v) => { const n = Number(v) || 0; if (n > 0) notes[k].push({ name: lastName(p), n }); };
      add('2B', h.double); add('3B', h.triple); add('HR', h.hr); add('SB', h.sb); add('CS', h.cs); add('E', fl.e);
    });
    // Team batting totals (sum of every batter who came up, starters + subs).
    const sum = k => battingRows.reduce((a, r) => a + (r[k] || 0), 0);
    const totals = { ab: sum('ab'), runs: sum('runs'), hits: sum('hits'), rbi: sum('rbi'), bb: sum('bb'), k: sum('k') };
    return { vh: t.vh, name: t.name, teamId: t.teamId, isGators: t.teamId === GATORS_ID, rows: battingRows, totals, notes };
  }).filter(t => t.rows.length);
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
        name: String(p.name || p.shortname || '').trim(),
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
  const name = String(live.pitcher).trim();
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
  if (pi && String(pi.name || '').trim() === name && pi.pitches != null) {
    pi.pitches = pi.pitches + abNp;
    if (pi.strikes != null) { pi.strikes = pi.strikes + abStrikes; pi.balls = pi.pitches - pi.strikes; }
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
    inningLabel: status === 'live' ? g.status : status === 'final' ? 'Final' : status === 'cancelled' ? 'Cancelled' : g.status,
    gatorsHome: g.gatorsHome, opponent: g.opponent,
    location: gameLocation(g), watchUrl: watchUrlFor(g), ticketUrl: ticketIndex[g.id] || null, theme: THEMES[g.date] || null, freeAdmission: FREE_ADMISSION[g.date] || null, promo: promoFor(g), special: SPECIALS[g.date] || null,
    away: { name: g.away.name, short: g.away.short, logo: g.away.logo, runs: g.away.score || 0, record: recordStr(g.away) },
    home: { name: g.home.name, short: g.home.short, logo: g.home.logo, runs: g.home.score || 0, record: recordStr(g.home) },
  };
}

// ----- state ----------------------------------------------------------------
let games = [], featured = null, prevFeatured = null;
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
function broadcast(o) { const line = 'data: ' + JSON.stringify(o) + '\n\n'; sseClients.forEach(r => { try { r.write(line); } catch (e) {} }); }
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
async function enrichLive(norm) {
  if (norm.status !== 'live') return;
  try {
    const lf = await fetchLiveForGame(norm.id);
    if (lf && lf.live) norm.live = lf.live;
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
      norm.inningLabel = inn > 9 ? ('Final/' + inn) : 'Final';
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
        liveScoreCache[g.id] = { away, home, at: Date.now(), over, label: over ? (inn > 9 ? 'Final/' + inn : 'Final') : null,
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
  const games = raw.map(g => Object.assign({}, g, {
    away: Object.assign({}, g.away, { city: CITY[g.away && g.away.id] || '' }),
    home: Object.assign({}, g.home, { city: CITY[g.home && g.home.id] || '' }),
  }));
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
  prevFeatured = featured; featured = norm;
  diffAlert(norm);
  broadcast({ type: 'game', game: norm });
  process.stdout.write('\r[' + new Date().toLocaleTimeString() + '] ' + norm.away.short + ' ' + norm.away.runs + '-' + norm.home.runs + ' ' + norm.home.short + '  (' + norm.inningLabel + ')        ');
}
// Tighter refresh while a game is live: re-pull just the live feed (event auth
// is cached, so this is one lightweight JSON request) and re-broadcast.
async function pollLive() {
  if (!featured || featured.status !== 'live') return;
  try { await refreshFeatured(); } catch (e) { logErr('pollLive', e); }
}

// ===== Roster + player season stats =========================================
// Official gameday roster (TCL gameday sheet, updated 6/25). Bios are static;
// season stats are pulled live from the league stats site and cached.
const GATORS_SLUG = 'lakecharlesgumbeauxgators';
const playerUrl = slug => SPORT_BASE + '/players/' + slug;
const leagueStatsUrl = pos => SPORT_BASE + '/players?view=&r=0&pos=' + pos + '&sort=' + (pos === 'p' ? 'era' : 'avg');

const ROSTER = [
  { num: 2,  name: 'Jaxon Landreneau', slug: 'jaxonlandreneautqp8',  pos: 'Utility', cls: 'Junior',       ht: '5-10', wt: '190', b: 'R', t: 'R', bday: '10/20/2004', home: 'Lake Charles, LA', school: 'LSU-Eunice' },
  // Recently activated (6/25 sheet); placeholder slug until his Presto player page
  // exists, so the `note` shows on his profile instead of stats until his first game.
  { num: 3,  name: 'Griffin Hebert',   slug: 'griffinhebertqmlk',    pos: 'Utility', cls: 'Sophomore',    ht: '6-1',  wt: '205', b: 'L', t: 'R', bday: '',            home: 'Moss Bluff, LA',   school: 'Lamar', note: 'Recently activated — season stats will appear after his first game.' },
  { num: 5,  name: 'Davis Duhon',      slug: 'davisduhons0vw',       pos: 'P',       cls: 'Junior',       ht: '6-0',  wt: '185', b: 'L', t: 'L', bday: '03/12/2005', home: 'Katy, TX',         school: 'Louisiana Christian' },
  { num: 6,  name: 'Nathan McDonald',  slug: 'nathanmcdonaldftgl',   pos: 'Utility', cls: 'Senior',       ht: '6-0',  wt: '175', b: 'R', t: 'R', bday: '07/17/2004', home: 'McComb, MS',       school: 'Loyola-New Orleans' },
  // Added off the 6/28 gameday sheet; real Presto slug now set directly (was findSlug-matched by name).
  { num: 8,  name: 'Cade Robin',       slug: 'caderobinnu4m',        pos: 'P',       cls: 'Junior',       ht: '6-1',  wt: '200', b: 'R', t: 'R', bday: '',           home: 'Arnaudville, LA',  school: 'LSU-Shreveport' },
  { num: 9,  name: 'James Reina',      slug: 'jamesreinaluai',       pos: 'IF',      cls: 'Junior',       ht: '5-9',  wt: '180', b: 'R', t: 'R', bday: '10/07/2004', home: 'Lake Charles, LA', school: 'Stephen F. Austin' },
  // Added off the 6/30 second-half roster; placeholder slug + findSlug until his Presto player page exists.
  { num: 10, name: 'Kash Martin',      slug: 'kashmartin',           pos: 'Utility', cls: 'Sophomore',    ht: '5-10', wt: '185', b: 'R', t: 'R', bday: '11/09/2006', home: 'Westlake, LA',     school: 'Bossier Parish CC', findSlug: true, note: 'Recently added — season stats will appear after his first game.' },
  { num: 11, name: 'Diego Corrales',   slug: 'diegocorrales91v5',    pos: 'P',       cls: 'Junior',       ht: '5-8',  wt: '185', b: 'L', t: 'L', bday: '08/01/2005', home: 'Lake Charles, LA', school: 'McNeese State' },
  { num: 14, name: 'Brandon Levy',     slug: 'brandonlevyejo5',      pos: 'P',       cls: 'Junior',       ht: '5-10', wt: '180', b: 'R', t: 'R', bday: '05/25/2004', home: 'Bossier City, LA', school: 'New Orleans' },
  { num: 16, name: 'Daniel Midkiff',   slug: 'danielmidkifffqkb',    pos: 'P',       cls: 'Sophomore',    ht: '6-2',  wt: '208', b: 'R', t: 'R', bday: '05/20/2007', home: 'Buna, TX',         school: 'Lamar' },
  { num: 17, name: 'Ayden Sunday',     slug: 'aydensundayyp1j',      pos: 'OF',      cls: 'Sophomore',    ht: '6-0',  wt: '185', b: 'R', t: 'R', bday: '',           home: 'Nederland, TX',    school: 'Lamar' },
  { num: 19, name: 'Jack Garcille',    slug: 'jackgarcille9sq9',     pos: 'P',       cls: 'HS Senior',    ht: '6-6',  wt: '210', b: 'R', t: 'R', bday: '07/07/2008', home: 'Lake Charles, LA', school: 'McNeese State' },
  { num: 21, name: 'Bankston Lembcke', slug: 'bankstonlembckeoxyb',  pos: 'IF',      cls: 'Junior',       ht: '5-11', wt: '205', b: 'R', t: 'R', bday: '11/14/2005', home: 'Klein, TX',        school: 'Bradley' },
  { num: 22, name: 'Matthew McKinley', slug: 'matthewmckinleylgvq',  pos: 'Utility', cls: 'Sophomore',    ht: '5-11', wt: '205', b: 'L', t: 'L', bday: '12/14/2006', home: 'Brandon, MS',      school: 'Meridian CC' },
  { num: 28, name: 'Andrew Ramos',     slug: 'andrewramos4y33',      pos: 'Utility', cls: 'Sophomore',    ht: '5-10', wt: '',    b: 'R', t: 'R', bday: '',           home: 'Deer Park, TX',    school: 'San Jacinto CC' },
  { num: 29, name: 'Sawyer Simmons',   slug: 'sawyersimmonss92p',    pos: 'P',       cls: 'Senior',       ht: '6-1',  wt: '193', b: 'R', t: 'L', bday: '03/30/2005', home: 'Bossier City, LA', school: 'Southeastern Louisiana' },
  // Added off the 6/28 gameday sheet; real Presto slug now set directly (was findSlug-matched by name).
  { num: 34, name: 'Brenyn Ebarb',     slug: 'brenynebarb6uqv',      pos: 'P',       cls: 'Graduate',     ht: '6-1',  wt: '195', b: 'R', t: 'R', bday: '05/04/2004', home: 'Zwolle, LA',       school: 'LSU-Alexandria', note: 'Recently added — season stats will appear after his first game.' },
  { num: 36, name: 'Jake Rider',       slug: 'jakeridergyu4',        pos: 'P',       cls: 'Junior',       ht: '6-4',  wt: '220', b: 'R', t: 'R', bday: '10/11/2005', home: 'Lake Charles, LA', school: 'Nunez CC' },
  { num: 37, name: 'Landon Richards',  slug: 'landonrichards2fu3',   pos: 'P',       cls: 'Sophomore',    ht: '5-11', wt: '235', b: 'R', t: 'R', bday: '06/22/2007', home: 'Orange, TX',       school: 'Angelina College' },
  // Added off the 6/30 second-half roster; placeholder slug + findSlug until his Presto player page exists.
  { num: 38, name: 'Gabe Guidry',      slug: 'gabeguidry',           pos: 'Utility', cls: 'R-Sophomore',  ht: '6-3',  wt: '200', b: 'R', t: 'R', bday: '',            home: 'Lake Charles, LA', school: 'Bossier Parish CC', findSlug: true, note: 'Recently added — season stats will appear after his first game.' },
  { num: 40, name: 'Chris Melvin',     slug: 'chrismelvinnddm',      pos: 'P',       cls: 'R-Sophomore',  ht: '6-4',  wt: '220', b: 'L', t: 'R', bday: '09/12/2005', home: 'Waterloo, Ontario',school: 'Paris JC' },
  { num: 41, name: 'Cole Flanagan',    slug: 'coleflanaganemnl',     pos: 'P',       cls: 'Freshman',     ht: '6-1',  wt: '230', b: 'L', t: 'L', bday: '',           home: 'Moss Bluff, LA',   school: 'Louisiana' },
  { num: 42, name: 'Kale Cropper',     slug: 'kalecropperuden',      pos: 'P',       cls: 'Sophomore',    ht: '6-4',  wt: '210', b: 'R', t: 'R', bday: '08/25/2006', home: 'Port Neches, TX',  school: 'Hill College' },
  { num: 45, name: 'Cannon Faulk',     slug: 'cannonfaulk0l9x',      pos: 'P',       cls: 'R-Sophomore',  ht: '6-4',  wt: '225', b: 'L', t: 'L', bday: '12/02/2005', home: 'Port Neches, TX',  school: 'Angelina College' },
  // Assigned #39 on the 6/30 second-half roster. Placeholder slug + findSlug until
  // his Presto player page exists; headshot populates once a photo is bundled.
  { num: 39, name: 'Yuichiro Kumagami', slug: 'yuichirokumagami', pos: 'C', cls: 'Sophomore', ht: '5-11', wt: '', b: '', t: '', bday: '', home: 'Miyagi, Japan', school: 'Mt. Hood CC', findSlug: true, note: 'Recently added — season stats will appear after his first game.' },
  // Added off the 6/30 second-half roster; placeholder slug + findSlug until their Presto pages exist.
  { num: 12, name: 'Taylor Hollier',  slug: 'taylorhollier',  pos: 'P', cls: 'Freshman', ht: '6-0', wt: '155', b: 'L', t: 'L', bday: '', home: 'Opelousas, LA', school: 'Belhaven', findSlug: true, note: 'Recently added — season stats will appear after his first game.' },
  { num: 43, name: 'Hunter Degeyter', slug: 'hunterdegeyter', pos: 'P', cls: 'HS Senior', ht: '6-1', wt: '170', b: 'R', t: 'R', bday: '', home: 'Lafayette, LA', school: 'Lafayette HS', findSlug: true, note: 'Recently added — season stats will appear after his first game.' },
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
// Every league hitter's full season line, grouped by team id, so any team's
// hitters can be shown "just like ours" (the Roster tab) from the Standings tab.
// Same leaderboard as parseAllLeagueHitters, but keyed by team and keeping the
// whole stat line (avg/obp/slg/hr/rbi/…) instead of just four card fields.
let leagueTeamHitters = {};  // teamId -> [ { name, stats:{col:val} } ], leaderboard order
function parseLeagueTeamHitters(html) {
  const tables = (html || '').match(/<table\b[\s\S]*?<\/table>/gi) || [];
  let tbl = null, head = null;
  for (const t of tables) { const rows = rowsOf(t); if (rows.length < 2) continue; const hd = cellsOf(rows[0]).map(x => bsText(x).split(/\s+/)[0].toLowerCase()); if (hd.indexOf('team') === -1) continue; tbl = t; head = hd; break; }
  if (!tbl || head.indexOf('avg') === -1) return {};
  const rows = rowsOf(tbl); const byTeam = {};
  for (let i = 1; i < rows.length; i++) {
    const c = cellsOf(rows[i]); if (c.length < 4) continue;
    const name = firstLink(c[1]).text; if (!name) continue;
    const teamId = teamIdFromHref(firstLink(c[2]).href); if (!teamId) continue;
    const stats = {}; for (let k = 3; k < c.length && k < head.length; k++) { if (head[k]) stats[head[k]] = bsText(c[k]); }
    (byTeam[teamId] || (byTeam[teamId] = [])).push({ name: name.trim(), stats });
  }
  return byTeam;
}
// Build the first-at-bat enrichment (bio + 3 season stats) for a batter by name.
// Third stat is HR, else SB (Gators only — the league leaderboard omits SB), else
// Hits. Returns { firstAB:true } with whatever data we have; absent -> just "1st AB".
function firstAbStats(name) {
  const key = normPlayerName(name);
  let bio = null, hit = null;
  const g = GATOR_BY_NORM[key];
  if (g) { bio = { school: g.school, cls: g.cls }; const s = rosterStats[g.slug]; hit = (s && s.hit) || null; }
  else { const b = LEAGUE_BIO[key]; if (b) bio = { school: b.s, cls: b.c }; hit = leagueHitterStats[key] || null; }
  const N = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const has = v => v != null && v !== '' && v !== '-';
  const line = [];
  if (hit) {
    if (has(hit.avg)) line.push(['AVG', String(hit.avg)]);
    if (has(hit.rbi)) line.push(['RBI', String(N(hit.rbi))]);
    let third = null;
    if (N(hit.hr) > 0) third = ['HR', String(N(hit.hr))];
    else if (N(hit.sb) > 0) third = ['SB', String(N(hit.sb))];
    else if (has(hit.h)) third = ['H', String(N(hit.h))];
    if (third) line.push(third);
  }
  const bioStr = bio ? [bio.school, bio.cls].filter(Boolean).join(' · ') : '';
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
  const bioStr = bio ? [bio.school, bio.cls].filter(Boolean).join(' · ') : '';
  return { bio: bioStr || null, seasonLine: line.length ? line : null };
}
// Did the current pitcher just enter? Look for his pitching-change announcement
// in the play-by-play ("X to p for Y", "Pitching change: X for Y", "X relieved
// Y"). Returns { replaced } when found, so a starter (no such line) isn't flagged.
function pitchChangeFor(plays, pitcherName) {
  const nm = normPlayerName(pitcherName); if (!nm || !Array.isArray(plays)) return null;
  const pats = [
    /^(.+?) to p for (.+?)\.?$/i,
    /pitching change[:.]?\s*(.+?)\s+(?:replaces|for|relieved)\s+(.+?)\.?$/i,
    /^(.+?)\s+(?:relieved|replaces)\s+(.+?)\.?$/i,
  ];
  for (let i = plays.length - 1; i >= 0; i--) {
    const t = String(plays[i].text || '').trim();
    for (const re of pats) { const m = t.match(re); if (m && normPlayerName(m[1]) === nm) return { replaced: m[2].trim() }; }
  }
  return null;
}
// Is this pitcher his team's starter? The feed lists pitchers in order of
// appearance, so the first row per team is the starter.
function isStarter(pitchers, name) {
  const nm = normPlayerName(name);
  if (!Array.isArray(pitchers)) return false;
  for (const t of pitchers) { if (t.rows && t.rows.length && normPlayerName(t.rows[0].name) === nm) return true; }
  return false;
}
// Build the "new pitcher" enrichment for the live pitcher card: shown while he's
// freshly in and hasn't recorded an out — a reliever right after his pitching
// change, or a starter on his first batter. Carries his school, age (or class),
// and summer line. Returns null once he's recorded an out.
function newPitcherInfo(info, plays, name, pitchers) {
  if (info && info.outs != null && info.outs > 0) return null;
  const chg = pitchChangeFor(plays, name);
  const starter = !chg && isStarter(pitchers, name);
  if (!chg && !starter) return null;
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
function seasonAvgFor(name) {
  const key = normPlayerName(name); if (!key) return null;
  const g = GATOR_BY_NORM[key];
  const hit = g ? ((rosterStats[g.slug] || {}).hit) : leagueHitterStats[key];
  return (hit && hit.avg != null && hit.avg !== '' && hit.avg !== '-') ? String(hit.avg) : null;
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
// A "full" record carries player-page detail (game logs + stats like SB), as
// opposed to a league-leaderboard seed that only has headline card stats.
const recIsFull = rec => !!(rec && ((rec.glBat && rec.glBat.length) || (rec.glPit && rec.glPit.length)));
// A record is "fresh" while it's younger than this. The daily poll re-scrapes any
// player whose record is older, so list-view card stats (served from rosterStats)
// refresh day to day instead of freezing at whatever was first scraped. 20h sits
// below the ~24h between daily polls, so every player refreshes once a day.
const RECORD_TTL_MS = 20 * 60 * 60 * 1000;
const recFresh = rec => !!(rec && rec.ts && (Date.now() - rec.ts < RECORD_TTL_MS));
function storePlayer(slug, rec) {
  const had = playerCache[slug];
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
      const lth = parseLeagueTeamHitters(hRes.body); if (Object.keys(lth).length) leagueTeamHitters = lth; // every team's hitters for the Standings-tab team hitting view
      const lp = parseAllLeaguePitchers(pRes.body); if (Object.keys(lp).length) leaguePitcherStats = lp; // opponents' season lines for the live new-pitcher card
      // Resolve real Presto slugs for players added before their player page was
      // known (findSlug). Both league pages list each Gators player's name+slug,
      // so a newly-active player is matched by name and their placeholder slug is
      // swapped for the real one — stats then flow on the passes below.
      const nameSlugs = Object.assign({}, parseLeagueSlugs(hRes.body), parseLeagueSlugs(pRes.body));
      for (const pl of ROSTER) {
        if (!pl.findSlug) continue;
        const real = nameSlugs[normPlayerName(pl.name)];
        if (real && real !== pl.slug) { delete ROSTER_BY_SLUG[pl.slug]; pl.slug = real; ROSTER_BY_SLUG[real] = pl; delete pl.findSlug; }
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
          const pg = await fetchPlayerPage(pl.slug);
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
function scheduleDailyRoster() {
  setTimeout(() => { try { pollRoster(); } catch (e) { logErr('scheduleDailyRoster', e); } scheduleDailyRoster(); }, msUntilNextCentralMidnight());
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
const normName = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
const PHOTO_DIR = __dirname + '/photos';
const PHOTO_TYPES = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', avif: 'image/avif', gif: 'image/gif' };
function loadLocalPhotos() {
  try {
    const man = JSON.parse(fs.readFileSync(PHOTO_DIR + '/manifest.json', 'utf8'));
    if (man && Object.keys(man).length) { playerPhotos = man; photosLoadedAt = Date.now(); }
  } catch (e) { /* no bundled photos */ }
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
async function pollStandings() {
  try {
    const r = await fetchText(STANDINGS_URL, SCHEDULE_URL);
    if (!r.ok || !r.body) return;
    const parsed = parseStandings(r.body);
    if (Object.keys(parsed.map).length) { standings = parsed.map; standingsTable = parsed.rows; standingsAt = Date.now(); }
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
// team {id,name,short} -> current-half "W-L"; name match then loose fallback.
// The feed reports full-season W-L, so the second-half record is derived as
// (season − first-half final, clamped at 0) — matching the reset Standings tab.
function recordStr(team) {
  if (!team) return null;
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
function decorateGame(g) { return Object.assign({}, g, { away: Object.assign({}, g.away, { city: CITY[g.away && g.away.id] || '' }), home: Object.assign({}, g.home, { city: CITY[g.home && g.home.id] || '' }), location: gameLocation(g), watchUrl: watchUrlFor(g), replayUrl: replayUrlFor(g), ticketUrl: ticketIndex[g.id] || null, theme: THEMES[g.date] || null, freeAdmission: FREE_ADMISSION[g.date] || null, promo: promoFor(g), special: SPECIALS[g.date] || null }); }

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
app.get('/', (q, r) => { recordVisit(q); r.set('Cache-Control', 'no-store, must-revalidate'); r.type('html').send(APP_HTML); });
app.get('/sw.js', (_q, r) => { r.set('Cache-Control', 'no-cache, no-store, must-revalidate'); r.type('application/javascript').send(SW); });
app.get('/manifest.json', (_q, r) => r.type('application/json').send(MANIFEST));
app.get('/health', (_q, r) => r.json({ ok: true, build: BUILD, games: games.length, featured: featured && featured.id, push: pushReady }));
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
  r.set('Content-Type','image/png'); r.set('Cache-Control','public, max-age=86400');
  r.send(GATORS_LOGO_BUF);
});
app.get('/tcl-logo.png', (_q, r) => { r.set('Content-Type','image/png'); r.set('Cache-Control','public, max-age=86400'); r.send(TCL_LOGO_BUF); });
app.get(['/gg-logo.png','/gg-logo.jpg'], (_q, r) => { r.set('Content-Type','image/png'); r.set('Cache-Control','public, max-age=86400'); r.send(GG_LOGO_BUF); });
// Social/link-preview image (Gumbeaux Gators logo, 1200x628) for iMessage etc.
app.get('/og.jpg', (_q, r) => { if (!OG_BUF) return r.status(404).end(); r.set('Content-Type','image/jpeg'); r.set('Cache-Control','public, max-age=86400'); r.send(OG_BUF); });
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
// Fetch + parse one box score, sharing one network request across concurrent
// callers (box-score view and walk enrichment), with 429/503 backoff. Caches
// the result; persists finals. Returns { ok, data, types } or { ok:false }.
async function fetchBoxPage(id) {
  const cached = boxCache.get(id);
  if (cached && (boxIsFinal(id) || Date.now() - cached.at < BOX_TTL_MS)) return { ok: true, data: cached.data, cached: true };
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
    if (boxIsFinal(id)) saveBoxCache();
    return { ok: true, data, types: p.types };
  })();
  boxInflight.set(id, job);
  job.finally(() => boxInflight.delete(id));
  return job;
}
// Gmail transport, shared by the daily visitor-analytics digest.
let _mailer = null;
function getMailer() { if (!_mailer && mailReady) _mailer = nodemailer.createTransport({ service: 'gmail', auth: { user: MAIL_USER, pass: MAIL_PASS } }); return _mailer; }
app.get('/api/boxscore', async (q, r) => {
  const id = q.query && q.query.id;
  try {
    if (!id) return r.status(400).json({ error: 'pass ?id=YYYYMMDD_xxxx' });
    const res = await fetchBoxPage(id);
    if (!res.ok) {
      // Source is rate-limiting: serve the last good copy rather than failing.
      const cached = boxCache.get(id);
      if (cached) { r.set('Cache-Control', 'public, max-age=120'); return r.json(cached.data); }
      return r.status(502).json({ error: 'box page ' + res.status });
    }
    r.set('Cache-Control', 'public, max-age=300');
    r.json(q.query.debug && res.types ? Object.assign({}, res.data, { types: res.types }) : res.data);
  } catch (err) {
    const cached = boxCache.get(id);
    if (cached) { r.set('Cache-Control', 'public, max-age=120'); return r.json(cached.data); }
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
app.get('/api/schedule', (_q, r) => { r.set('Cache-Control', 'no-store'); r.json({ games: games.map(decorateGame) }); });
app.get('/api/standings', (_q, r) => {
  r.set('Cache-Control', 'no-store');
  if (!standingsTable.length) pollStandings();
  const rows = standingsTable.map(x => {
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
      site: TEAM_SITE[x.id] || null,
      clinched: (x.id && CLINCHED_PLAYOFF[x.id]) || null,
    });
  }).sort((a, b) => b.pct - a.pct || b.pctSeason - a.pctSeason || b.ws - a.ws || a.ls - b.ls);
  const lead = rows[0];
  for (const x of rows) x.gb = lead ? ((lead.w2 - x.w2) + (x.l2 - lead.l2)) / 2 : 0;
  r.json({ updatedAt: standingsAt, gatorsId: GATORS_ID, half: SEASON_HALF, rows, scoreboard: buildLeagueBoard() });
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
// One opposing (or our own) team's hitters + season batting lines, for the
// Standings-tab team hitting view. Data is the same league leaderboard that
// seeds our roster; hitters are ordered most-active first (AB desc, AVG break).
app.get('/api/team-hitting', (q, r) => {
  r.set('Cache-Control', 'no-store');
  const id = String((q.query && q.query.id) || '');
  if (!/^[a-z0-9]+$/i.test(id) || !TEAMS[id]) return r.status(404).json({ error: 'unknown team' });
  // Kick a roster poll if the league leaderboard hasn't been scraped yet, then
  // let the client re-request while we report loading (same pattern as /api/roster).
  if (!rosterPolling && !Object.keys(leagueTeamHitters).length) pollRoster();
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : -1; };
  const hitters = (leagueTeamHitters[id] || []).slice().sort((a, b) =>
    num(b.stats.ab) - num(a.stats.ab) || num(b.stats.avg) - num(a.stats.avg));
  const meta = TEAMS[id];
  r.json({ id, name: meta.name, short: meta.short, logo: logo(id), site: TEAM_SITE[id] || null,
    hitters, updated: rosterUpdated, loading: !Object.keys(leagueTeamHitters).length });
});
// Headshots are bundled in photos/ and served from our own origin.
app.get('/api/photo', (q, r) => {
  const slug = String((q.query && q.query.slug) || '');
  const file = /^[a-z0-9_]+$/i.test(slug) ? playerPhotos[slug] : null;
  if (!file || /[\\/]/.test(file)) return r.status(404).end();
  try {
    const buf = fs.readFileSync(PHOTO_DIR + '/' + file);
    const ext = String(file).split('.').pop().toLowerCase();
    r.set('Content-Type', PHOTO_TYPES[ext] || 'image/jpeg');
    r.set('Cache-Control', 'public, max-age=86400');
    r.send(buf);
  } catch (e) { r.status(404).end(); }
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
app.get('/api/stream', (q, r) => {
  r.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  r.flushHeaders(); r.write(':ok\n\n'); if (featured) r.write('data: ' + JSON.stringify({ type: 'game', game: featured }) + '\n\n');
  const hb = setInterval(() => { try { r.write(':hb\n\n'); } catch (e) {} }, 20000);
  sseClients.add(r); q.on('close', () => { clearInterval(hb); sseClients.delete(r); });
});

if (require.main === module) {
  loadCache(); // serve last-saved player stats instantly, then refresh below
  loadBoxCache(); // restore cached final box scores so we don't re-fetch them
  app.listen(PORT, () => { console.log('\nGators cloud on http://localhost:' + PORT + '  push:' + (pushReady ? 'on' : 'off') + '\n'); pollSchedule(); setInterval(pollSchedule, POLL_MS); setInterval(pollLive, LIVE_POLL_MS); pollRoster(); scheduleDailyRoster(); pollWatch(); setInterval(pollWatch, 10 * 60 * 1000); pollReplays(); setInterval(pollReplays, 30 * 60 * 1000); loadLocalPhotos(); pollStandings(); setInterval(pollStandings, 30 * 60 * 1000); setTimeout(pollTickets, 8000); setInterval(pollTickets, 30 * 60 * 1000); setTimeout(pollStrikePct, 15000); setInterval(pollStrikePct, 3 * 60 * 60 * 1000); scheduleDailyStats(); });
}
module.exports = { parseSchedule, classify, teamsFromChunk, normalizeFeatured, summarizeLive, teamLineScores, summarizePlays, lineupsFromFeed, pitchersFromFeed, extractEventAuth,
  dateFromId, ordinal, cap, shortName, fullName, scoreBetween, inningParts, parseBoxscore, parseStandings, parseReplayList, msUntilNextCentralMidnight, parseLeagueStats, parseLeagueSlugs, parseLeagueTeamHitters, parseGameLog, ticketCandidates, parseLeagueScoreboard, todayCentralYmd, applyLiveScores, liveScoreCache, pick, finalIsFresh, noteFinals, finalSeenAt, assumedEndMs, feedGameOver, batterPriorPAs, summarizePlays, applyLivePitchCount, pitchingTotals, strikeCounts };

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
.tm .nm{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.03em;font-size:12px;text-align:center;line-height:1.05;}
.tm .rec{font-family:'Inter',sans-serif;font-weight:600;font-size:11px;color:var(--mute);letter-spacing:.04em;margin-top:-4px;min-height:13px;}
.tm.gators .nm{color:var(--gator);}
.tm .sc{font-family:'Oswald',sans-serif;font-weight:700;font-size:60px;line-height:.9;}
.tm.gators .sc{color:var(--gator);text-shadow:0 0 24px rgba(113,74,210,.35);}
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
.lcell{text-align:center;min-width:46px;}
.lcell .lv{font-family:'Oswald',sans-serif;font-weight:700;font-size:21px;color:var(--bone);line-height:1;display:flex;gap:6px;justify-content:center;align-items:center;min-height:21px;}
.lcell .ll{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);margin-top:6px;}
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
.lutbl td.lpn,.lutbl th.lpn{text-align:center;font-family:'JetBrains Mono',monospace;width:1%;white-space:nowrap;}
.lutbl tr.pttot td{border-top:2px solid var(--line);font-weight:700;color:var(--mute);}
.lutbl tr.pttot td.lunm{color:var(--bone);text-transform:uppercase;font-size:10px;letter-spacing:.06em;}
.lutbl td.lpn{color:var(--bone);}
.lutbl td.lavg{color:var(--gold2);}
.pthead{margin-top:10px;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--gold2);font-weight:700;padding:0 7px 3px;}
.pdec{color:var(--gold2);font-weight:700;font-size:10px;}
.lunotes{margin-top:10px;display:flex;flex-direction:column;gap:5px;}
.lunote{font-size:11.5px;line-height:1.45;color:var(--bone);}
.lunk{display:inline-block;min-width:22px;font-family:'Oswald',sans-serif;font-weight:700;font-size:10px;letter-spacing:.04em;color:var(--gold2);margin-right:5px;}
.pbp{margin-top:2px;}
.pbptabs{display:flex;gap:6px;margin-bottom:10px;}
.pbptab{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.05em;font-size:10px;padding:6px 12px;border-radius:999px;border:1px solid var(--line);color:var(--mute);background:var(--bayou2);cursor:pointer;}
.pbptab.on{color:#fff;background:linear-gradient(180deg,var(--purple),var(--gator2));border-color:var(--purple);}
.pbplist.full{max-height:46vh;overflow-y:auto;overflow-x:hidden;padding:0 6px;-webkit-overflow-scrolling:touch;}
.pbpih{font-family:'Oswald',sans-serif;font-weight:600;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--gold2);padding:9px 0 3px;}
.pbprow{padding:8px 0;border-top:1px solid var(--line);font-size:12.5px;line-height:1.45;}
.pbpempty{padding:10px 0;font-size:12px;color:var(--mute);font-style:italic;}
.pbpt{color:var(--bone);overflow-wrap:anywhere;}
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
.cdate{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--mute);font-weight:700;}
.cpill{font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;border-radius:999px;border:1px solid var(--line);color:var(--mute);display:flex;align-items:center;gap:5px;}
.cpill.live{color:var(--gator);border-color:rgba(113,74,210,.4);background:rgba(113,74,210,.08);}
.cpill.live .dot{width:5px;height:5px;animation:pulse 1.8s infinite;}
.cpill.final{color:var(--gold);}
.crow{display:flex;align-items:center;gap:9px;padding:3px 0;}
.crow img{width:30px;height:30px;border-radius:6px;object-fit:contain;background:transparent;}
.crow .n{flex:1;font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
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
/* Tappable team cell: a full-width button that opens the team hitting view. */
.sttbl button.stteam{width:100%;background:none;border:0;padding:0;margin:0;font:inherit;text-align:left;cursor:pointer;color:var(--bone);-webkit-tap-highlight-color:transparent;}
.sttbl button.stteam:hover .stnm,.sttbl button.stteam:active .stnm{text-decoration:underline;}
.sttbl .stchev{margin-left:auto;color:var(--mute);font-size:15px;line-height:1;flex:none;padding-left:4px;}
.sttbl tr.stg button.stteam{color:var(--gator);}
.sttbl .stlogo{width:22px;height:22px;border-radius:5px;object-fit:contain;background:transparent;flex:none;}
#thLogo.hasimg{width:48px;height:48px;background:transparent;border:1px solid var(--line);}
#thLogo.hasimg img{object-fit:contain;}
.thsite{padding:12px 2px 2px;font-size:12px;}
.thsite a{color:var(--gold2);text-decoration:none;font-weight:600;}
.thsite a:hover{text-decoration:underline;}
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
.sbg{display:flex;align-items:center;gap:10px;background:var(--bayou2);border:1px solid var(--line);border-radius:12px;padding:10px 13px;margin-bottom:8px;color:inherit;text-decoration:none;cursor:pointer;transition:border-color .15s,background .15s;}
a.sbg:hover{border-color:var(--purple);background:rgba(113,74,210,.14);}
.sbg.g{border-color:var(--purple);background:rgba(113,74,210,.10);}
.sbteams{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;}
.sbrow{display:flex;align-items:center;gap:9px;}
.sbl{width:30px;height:30px;border-radius:6px;object-fit:contain;background:transparent;flex:none;}
.sbn{flex:1;min-width:0;font-family:'Oswald',sans-serif;font-weight:600;letter-spacing:.02em;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sbrec{margin-left:5px;font-weight:400;font-size:.82em;color:var(--mute);opacity:.85;}
.sbs{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:16px;color:var(--mute);min-width:20px;text-align:right;}
.sbsc{display:flex;align-items:center;gap:6px;flex:none;}
.sbtri{width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent;border-right:6px solid var(--gold2);}
.sbrow.w .sbn{color:var(--bone);font-weight:700;}
.sbrow.w .sbs{color:var(--gold2);}
/* Status block: inning over outs over the bases diamond, top-aligned for live
   games (like a standard scoreboard card); centered for finals/scheduled. */
.sbstat{flex:none;align-self:stretch;min-width:72px;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;gap:3px;}
.sbstat.live{justify-content:flex-start;}
.sbinn{font-family:'Oswald',sans-serif;font-weight:600;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--gator);text-align:right;}
.sbstat.final .sbinn{color:var(--bone);}
.sbouts{font-family:'Oswald',sans-serif;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--mute);}
.sbdia{display:block;margin-top:2px;}
.sbdia rect{fill:rgba(154,140,196,.18);stroke:var(--gator);stroke-width:1.3;}
.sbdia rect.on{fill:var(--gold2);stroke:var(--gold2);}
</style></head><body>
<div class="bgfx"></div>
<canvas id="fx"></canvas>
<div class="toasts" id="toasts"></div>
<div class="wrap">
<div class="topbar"><a class="tcllink" href="https://texascollegiateleague.com" target="_blank" rel="noopener" title="Texas Collegiate League"><img class="hdrlogo tcl" src="/tcl-logo.png" alt="Texas Collegiate League"></a><a class="gglink" href="https://gumbeauxgators.com" target="_blank" rel="noopener" title="Gumbeaux Gators official site"><img class="gglogo" src="/gg-logo.png" alt="Lake Charles Gumbeaux Gators"></a><div class="trail"><a class="ticketbtn" href="https://gumbeauxgators.com/tickets/" target="_blank" rel="noopener" title="Buy game tickets">Tickets</a><a class="shopbtn" id="shopBtn" href="https://gumbeauxgators.myshopify.com/collections/all" target="_blank" rel="noopener" title="Shop the Gators store"><span class="shoptxt">Gators<br>Team<br>Store</span></a></div></div>
<div class="nav"><button class="navb on" id="navScores">Scores</button><button class="navb" id="navRoster">Roster</button><button class="navb" id="navStandings">Standings</button></div>
<div id="viewScores">
<div class="jumbo">
<div class="sl">
<div class="tm" id="awayTm"><img id="awayLogo" alt=""><div class="nm" id="awayNm">—</div><div class="rec" id="awayRec"></div><div class="sc" id="awaySc">0</div></div>
<div class="mid"><a class="watchpill" id="watchBtn" target="_blank" rel="noopener" style="display:none">Watch</a><div class="statpill" id="statpill">—</div><div class="vs" id="vs">vs</div><div class="jloc" id="jloc"></div><div class="jtheme" id="themeTag" style="display:none"></div><div class="jtheme" id="specialName" style="display:none"></div></div>
<div class="tm" id="homeTm"><img id="homeLogo" alt=""><div class="nm" id="homeNm">—</div><div class="rec" id="homeRec"></div><div class="sc" id="homeSc">0</div></div>
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
<div class="modal" id="thModal"><div class="sheet">
<div class="phead"><div class="phnum" id="thLogo">0</div><div style="flex:1;min-width:0"><div class="phname" id="thName">Team</div><div class="phsub" id="thSub"></div></div><button class="sclose" id="thClose" aria-label="Close">✕</button></div>
<div class="sbody" id="thBody" style="border-top:none;padding-top:0"><div class="spin">Loading…</div></div>
</div></div>
<script>
var $=function(i){return document.getElementById(i);};
var curId=null,pbpView='half',lineupTeam='gators',lastGame=null,schedList=null;
function setPbpView(v){pbpView=v;if(lastGame)renderGame(lastGame);}
function setLineupTeam(v){lineupTeam=v;if(lastGame)renderGame(lastGame);}
function ord(n){n=+n;var s=['th','st','nd','rd'],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0]);}
function esc(s){return (s||'').replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
// iOS Safari's Data Detectors auto-link a name that contains a street-suffix word
// (e.g. "Lane Schulz") as a Maps address. Opposing players render as plain text
// with no profile link, so there's nothing for the user to tap on purpose. Break
// the address pattern by putting an invisible word-joiner (U+2060) on each side of
// every space: it interrupts the phrase the detector matches without changing how
// the name looks, wraps, or reads to a screen reader. Use for any plain-text name.
function noAddr(s){return esc(s).replace(/ /g,'\u2060 \u2060');}
function flash(el){el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');}
// Gators-scored fireworks: a short canvas burst in the brand gold/purple,
// fired when the Gators' run total ticks up during a live game. Pointer-events
// are off and it hides itself when the last spark fades, so it never blocks taps.
var FX=(function(){
  var cv,ctx,parts=[],raf=0,endAt=0,W=0,H=0,dpr=1;
  var COLORS=['#ecc913','#ffd633','#714ad2','#b9a6ee','#f0ede4'];
  function size(){dpr=Math.min(window.devicePixelRatio||1,2);W=cv.clientWidth;H=cv.clientHeight;cv.width=W*dpr;cv.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);}
  function burst(x,y){
    var n=34+(Math.random()*22|0),base=COLORS[Math.random()*COLORS.length|0];
    for(var i=0;i<n;i++){
      var a=(6.283*i)/n+Math.random()*0.3,sp=2+Math.random()*4.2;
      parts.push({x:x,y:y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:1,
        col:Math.random()<0.28?COLORS[Math.random()*COLORS.length|0]:base,r:1.4+Math.random()*1.8});
    }
  }
  function tick(){
    raf=requestAnimationFrame(tick);ctx.clearRect(0,0,W,H);
    for(var i=parts.length-1;i>=0;i--){var p=parts[i];
      p.vy+=0.05;p.vx*=0.99;p.vy*=0.99;p.x+=p.vx;p.y+=p.vy;p.life-=0.013;
      if(p.life<=0){parts.splice(i,1);continue;}
      ctx.globalAlpha=p.life<0?0:p.life;ctx.fillStyle=p.col;
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,6.283);ctx.fill();
    }
    ctx.globalAlpha=1;
    if(!parts.length&&Date.now()>endAt){cancelAnimationFrame(raf);raf=0;cv.style.display='none';}
  }
  function show(intensity){
    if(!cv){cv=$('fx');if(!cv||!cv.getContext)return;ctx=cv.getContext('2d');
      window.addEventListener('resize',function(){if(cv.style.display!=='none')size();});}
    if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    cv.style.display='';if(!raf)size();
    var shots=Math.max(3,Math.min(2+(intensity||1),7));
    for(var s=0;s<shots;s++)(function(d){setTimeout(function(){
      burst(W*(0.18+Math.random()*0.64),H*(0.16+Math.random()*0.34));},d);})(s*210);
    endAt=Date.now()+shots*210+1800;if(!raf)tick();
  }
  return {show:show};
})();
var prev={a:null,h:null};
var lastPlayTx='',lastPlayGid=null; // track the live "Last play" text to flash only on change
function renderGame(g){
  var ah=!g.gatorsHome, hh=g.gatorsHome;
  $('awayTm').classList.toggle('gators',ah);$('homeTm').classList.toggle('gators',hh);
  $('awayLogo').src=g.away.logo;$('homeLogo').src=g.home.logo;
  $('awayNm').textContent=g.away.short;$('homeNm').textContent=g.home.short;
  var ar=$('awayRec'),hr=$('homeRec');
  if(ar)ar.textContent=g.away.record||'';if(hr)hr.textContent=g.home.record||'';
  // Upcoming games haven't been played, so show logo-vs-logo with no 0-0 score.
  var preGame=(g.status==='pregame');
  $('awaySc').style.display=preGame?'none':'';
  $('homeSc').style.display=preGame?'none':'';
  if(g.id===curId){if(g.away.runs>prev.a)flash($('awaySc'));if(g.home.runs>prev.h)flash($('homeSc'));}
  // Fireworks when the Gators score (their run total rises) during a live game.
  var gPrev=g.gatorsHome?prev.h:prev.a,gNow=g.gatorsHome?g.home.runs:g.away.runs;
  if(g.id===curId&&g.status==='live'&&gPrev!=null&&gNow>gPrev)FX.show(gNow-gPrev);
  $('awaySc').textContent=g.away.runs;$('homeSc').textContent=g.home.runs;
  prev={a:g.away.runs,h:g.home.runs};var pc=curId;curId=g.id;if(schedList&&pc!==curId)renderSched(schedList);
  var sp=$('statpill');sp.textContent=g.inningLabel;sp.classList.toggle('live',g.status==='live');
  $('vs').textContent=g.dateLabel+(g.status==='pregame'?' · upcoming':'');
  var jl=$('jloc');if(jl)jl.textContent=g.location||'';
  var th=$('themeTag');if(th){if(g.theme&&g.status==='pregame'){th.textContent='🎉 '+g.theme+' Night';th.style.display='';}else{th.style.display='none';}}
  var sn=$('specialName'),sd=$('specialDetail');
  if(sn&&sd){if(g.special&&g.status!=='final'&&g.status!=='cancelled'){sn.textContent=(g.special.emoji?g.special.emoji+' ':'')+g.special.name;sn.style.display='';if(g.special.detail){sd.textContent=g.special.detail;sd.style.display='';}else sd.style.display='none';}else{sn.style.display='none';sd.style.display='none';}}
  var pr=$('promoTag');if(pr){if(g.promo&&g.status!=='final'&&g.status!=='cancelled'){pr.innerHTML=esc(g.promo.emoji)+' <b>'+esc(g.promo.name)+'</b> · '+esc(g.promo.detail);pr.style.display='';}else{pr.style.display='none';}}
  var wb=$('watchBtn');
  if(wb){
    // Live game: show the TCL stream pill. Upcoming games use the Buy Tickets
    // button below instead (you can't watch a game that hasn't started).
    if(g.status!=='pregame'&&g.watchUrl){wb.href=g.watchUrl;wb.textContent='Watch on TCL';wb.classList.remove('replay');wb.style.display='';}
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
      if(g.id===lastPlayGid&&ntx&&ntx!==lastPlayTx){lpb.classList.remove('lpnew');void lpb.offsetWidth;lpb.classList.add('lpnew');}
      lastPlayTx=ntx;}
    lastPlayGid=g.id;
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
  if(L){
    var count=L.count||((L.balls||0)+'-'+(L.strikes||0));
    sit='<div class="lsit">'+
      '<div class="lcell"><div class="lv">'+esc(count)+'</div><div class="ll">Count</div></div>'+
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
  // batter sees a pitch (abPitches resets to 0 each batter and ticks up on the
  // first pitch), and also clears when a new half-inning starts — the prior out
  // belongs to the other team, so we only keep it while the latest play is still
  // in the current half. Flashes on change (renderGame); scored plays go green.
  var lastPlay='';
  if((!L||!L.abPitches)&&g.plays&&g.plays.length){var lp=g.plays[g.plays.length-1];
    var inHalf=!L||(lp.inning===(+L.inning)&&lp.half===(L.half==='Top'?'top':'bot'));
    if(lp&&lp.text&&inHalf)lastPlay='<div class="lastplay'+(lp.scored?' scored':'')+'" id="lastPlay"><span class="lplab">Last play</span><span class="lptx">'+esc(lp.text)+'</span></div>';}
  var line=buildLineScore(g);
  var dueup=buildDueUp(g);
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
  return '<div class="finalcard"><div class="finalbtns">'+btns+'</div></div>';
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
    var rep=info.newPitcher.replaced?('in for '+noAddr(info.newPitcher.replaced)+(info.bio?' · '+esc(info.bio):'')):(info.bio?esc(info.bio):'');
    var nb='<div class="mfirst"><span class="mfb">'+npLab+'</span>'+(rep?'<span class="mfbio">'+rep+'</span>':'')+'</div>';
    var nsl=(info.seasonLine&&info.seasonLine.length)?'<div class="mstat"><span class="mssn">SEASON</span> '+info.seasonLine.map(function(s){return '<span class="mfk">'+esc(s[0])+'</span> '+esc(s[1]);}).join('   ')+'</div>':'';
    return '<div class="mcard">'+head+nb+nsl+'</div>';
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
    if(info.strikes!=null&&info.balls!=null)pc+=' ('+esc(String(info.strikes))+' S / '+esc(String(info.balls))+' B)';
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
    // share his spot, so drop the number and indent the name, like the box score.
    var cls=(cur?'cur':'')+(r.sub?(cur?' ':'')+'lusub':'');
    rows+='<tr'+(cls?' class="'+cls+'"':'')+'><td class="lus">'+esc(r.sub?'':String(r.spot||''))+'</td>'+
      '<td>'+esc(r.pos||'')+'</td><td class="luu">'+esc(String(r.uni||''))+'</td>'+
      '<td class="lunm">'+nmeCell+'</td>'+
      sc(r.ab)+sc(r.runs)+sc(r.hits)+sc(r.rbi)+sc(r.bb)+sc(r.k)+
      '<td class="lpn lavg">'+esc(r.seasonAvg||'')+'</td></tr>';
  });
  var T=team.totals;
  if(T)rows+='<tr class="pttot"><td class="lus"></td><td></td><td class="luu"></td><td class="lunm">Totals</td>'+
    '<td class="lpn">'+T.ab+'</td><td class="lpn">'+T.runs+'</td><td class="lpn">'+T.hits+'</td>'+
    '<td class="lpn">'+T.rbi+'</td><td class="lpn">'+T.bb+'</td><td class="lpn">'+T.k+'</td><td class="lpn"></td></tr>';
  var tabs='<div class="lutabs">';
  if(gators)tabs+='<button class="lutab'+(showGators?' on':'')+'" data-lineup="gators">'+esc(nm(gators)||'Gators')+'</button>';
  if(opp)tabs+='<button class="lutab'+(!showGators?' on':'')+'" data-lineup="opp">'+esc(nm(opp)||'Opponent')+'</button>';
  tabs+='</div>';
  var head='<tr><th class="lus"></th><th>Pos</th><th>#</th><th class="lunm">Player</th>'+
    '<th class="lpn">AB</th><th class="lpn">R</th><th class="lpn">H</th><th class="lpn">RBI</th><th class="lpn">BB</th><th class="lpn">K</th>'+
    '<th class="lpn" title="Season batting average">AVG</th></tr>';
  return '<div class="lineup"><div class="luh">Lineup</div>'+tabs+
    '<div class="lubox"><table class="lutbl">'+head+rows+'</table></div>'+lineupNotes(team)+'</div>';
}
function lineupNotes(team){
  var n=team&&team.notes;if(!n)return '';
  var keys=['2B','3B','HR','SB','CS','E'];var lines='';
  keys.forEach(function(k){
    var arr=n[k];if(!arr||!arr.length)return;
    var txt=arr.map(function(x){return esc(x.name)+(x.n>1?' '+x.n:'');}).join('; ');
    lines+='<div class="lunote"><span class="lunk">'+k+'</span> '+txt+'</div>';
  });
  return lines?'<div class="lunotes">'+lines+'</div>':'';
}
function pbpRow(p){return '<div class="pbprow'+(p.scored?' sc':'')+'"><span class="pbpt">'+esc(p.text)+'</span></div>';}
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
    var pill=g.state==='live'?'<span class="cpill live"><span class="dot"></span>'+g.status+'</span>':g.state==='final'?'<span class="cpill final">'+g.status+' \u203A</span>':'<span class="cpill">'+esc(g.status)+'</span>';
    var aw=g.state==='final'&&g.away.score>g.home.score,hw=g.state==='final'&&g.home.score>g.away.score;
    function row(t,isG,won){var sc=(g.state==='live'||g.state==='final')&&t.score!=null?t.score:'';var ct=t.city?'<span class="tcity">'+esc(t.city)+'</span> ':'';return '<div class="crow'+(isG?' g':'')+(won?' w':'')+'"><img src="'+t.logo+'" alt=""><span class="n">'+ct+esc(t.short)+'</span><span class="s">'+sc+'</span><span class="warrow" aria-label="'+(won?'Winner':'')+'">'+(won?'◀':'')+'</span></div>';}
    h+='<div class="card '+(g.state==='live'?'glive':g.state==='cancelled'?'gcancel':'')+(g.id===curId?' pinned':'')+'" data-state="'+g.state+'" data-id="'+g.id+'">'
      +'<div class="ctop"><span class="cdate">'+g.dateLabel+'</span>'+pill+'</div>'
      +row(g.away,g.away.id==='et1bt9sixrz5lnnl',aw)+row(g.home,g.home.id==='et1bt9sixrz5lnnl',hw)
      +(g.state==='scheduled'&&g.theme?('<div class="ctheme">🎉 '+esc(g.theme)+' Night</div>'):'')
      +(g.state==='scheduled'&&g.special?('<div class="ctheme">'+(g.special.emoji?esc(g.special.emoji)+' ':'')+esc(g.special.name)+'</div>'+(g.special.detail?('<div class="cpromo">'+esc(g.special.detail)+'</div>'):'')):'')
      +(g.promo?('<div class="cpromo">'+esc(g.promo.emoji)+' <b>'+esc(g.promo.name)+'</b> · '+esc(g.promo.detail)+'</div>'):'')
      +'<div class="cfoot"><span class="cloc">'+esc(g.location||'')+'</span>'
      +(g.state==='final'&&g.replayUrl?('<a class="watchmini replay" href="'+esc(g.replayUrl)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">Replay</a>'):'')
      +(g.state==='scheduled'&&g.freeAdmission?('<span class="watchmini free">Free Admission</span>'):(g.state==='scheduled'&&g.ticketUrl?('<a class="watchmini tickets" href="'+esc(g.ticketUrl)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">Tickets</a>'):''))
      +'</div></div>';
  });
  $('sched').innerHTML=h||'<div class="note">No Gators games found yet.</div>';
  $('sched').querySelectorAll('.card[data-state="final"]').forEach(function(c){c.addEventListener('click',function(){openBox(c.dataset.id);});});
}
function toast(e,t,s,cls){var el=document.createElement('div');el.className='toast '+(cls||'');
  el.innerHTML='<div class="e">'+e+'</div><div><b>'+t+'</b><span>'+s+'</span></div>';$('toasts').appendChild(el);
  requestAnimationFrame(function(){requestAnimationFrame(function(){el.classList.add('show');});});
  setTimeout(function(){el.classList.remove('show');setTimeout(function(){el.remove();},500);},4200);}
function emo(tag){return tag==='lead'?'📣':tag==='final'?'🏁':tag==='run'?'🔥':tag==='start'?'⚾':'🐊';}
function loadSched(){fetch('/api/schedule',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){renderSched(d.games||[]);}).catch(function(){});}
function connect(){
  function applyGame(g){if(g&&g.home){renderGame(g);if($('viewStandings').style.display!=='none')silentStandings();}}
  function pollGame(){fetch('/api/game',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(applyGame).catch(function(){});}
  pollGame();
  // Poll the live game often so the score/count/pitch-count stay fresh even when
  // the SSE push stalls (e.g. behind the non-www->www redirect). /api/game is
  // served from cache, so this only hits our own server. Schedule changes
  // rarely, so it stays on the slower cadence.
  setInterval(pollGame,5000);
  setInterval(loadSched,15000);
  function openSSE(){var es;try{es=new EventSource('/api/stream');}catch(e){return;}
    es.onmessage=function(ev){try{var m=JSON.parse(ev.data);if(m.type==='game')applyGame(m.game);else if(m.type==='alert')toast(emo(m.tag),m.title,m.body,(m.tag==='lead'||m.tag==='final')?'lead':'');}catch(x){}};
    es.onerror=function(){try{es.close();}catch(x){}setTimeout(openSSE,8000);};}
  openSSE();}
var _box=null,_boxDate='';
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
  fetch('/api/boxscore?id='+encodeURIComponent(id)).then(function(r){return r.json();}).then(function(d){
    if(d.error){$('bxBody').innerHTML='<div class="spin">'+esc(d.error)+'</div>';return;}
    _box=d;
    if(d.teams&&d.teams.length>=2)$('bxTtl').textContent=oppShort(d.teams[0])+' @ '+oppShort(d.teams[1]);
    if(d.line){var sc=bsScoreFromLine(d.line);if(sc)$('bxScore').textContent=sc;}
    showTab(tab);
  }).catch(function(){$('bxBody').innerHTML='<div class="spin">Could not load box score.</div>';});}
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
var rosterData=null,rosterReq=false,rosterPolls=0;
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
    var h='<div class="gltbl sttbl"><table><tr><th>#</th><th>Team</th><th title="Second-half W-L">2H</th><th>PCT</th><th>GB</th><th>STRK</th><th title="Full-season W-L">Season</th></tr>';
    rows.forEach(function(x,i){
      var isG=x.id&&x.id===d.gatorsId;
      var lg=x.logo?'<img class="stlogo" src="'+esc(x.logo)+'" alt="">':'';
      var sk=x.streak?'<span class="strk '+(/^W/i.test(x.streak)?'win':'loss')+'">'+esc(x.streak)+'</span>':'—';
      var nm=esc(x.name||x.short);
      var clin=x.clinched?('<span class="clinch" title="Won the first half — clinched a playoff spot">🏆<small>1H</small></span>'):'';
      if(x.clinched)anyClinch=true;
      var inner=lg+'<span class="stnm">'+nm+'</span>'+clin;
      // Tapping a team opens its hitters + batting lines (like tapping one of our
      // roster cards). Only teams we can key to a Presto id have leaderboard stats.
      var team=x.id?('<button type="button" class="stteam sttap" data-teamid="'+esc(x.id)+'" data-teamname="'+esc(x.name||x.short||'')+'">'+inner+'<span class="stchev">›</span></button>'):('<div class="stteam">'+inner+'</div>');
      var cls=[isG?'stg':'',x.clinched?'stclinch':''].filter(Boolean).join(' ');
      var wl2=(x.w2|0)+'-'+(x.l2|0), wls=(x.ws|0)+'-'+(x.ls|0);
      h+='<tr'+(cls?' class="'+cls+'"':'')+'><td>'+(i+1)+'</td>'
        +'<td>'+team+'</td>'
        +'<td class="stwl2">'+wl2+'</td><td>'+fmtPct(x.pct)+'</td><td>'+fmtGb(x.gb)+'</td><td>'+sk+'</td><td class="stwls">'+wls+'</td></tr>';
    });
    h+='</table></div>';
    if(anyClinch)h+='<div class="stnote"><span class="clinch">🏆<small>1H</small></span> first-half champion — clinched a playoff spot</div>';
    $('standingsBody').innerHTML=h;
    $('stMeta').textContent=d.half===2?'Second-half standings':d.half===1?'First-half standings':'';
    var tcells=$('standingsBody').querySelectorAll('.sttap');
    for(var t=0;t<tcells.length;t++)tcells[t].addEventListener('click',function(){openTeamHitting(this.getAttribute('data-teamid'),this.getAttribute('data-teamname'));});
  }
  renderScoreboard(d&&d.scoreboard,d&&d.gatorsId,recById);
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
  return '<div class="sbrow'+(win?' w':'')+(isGt?' gt':'')+'">'+lg+'<span class="sbn">'+ct+esc(t.short||'')+rec+'</span><span class="sbsc">'+tri+'<span class="sbs">'+sc+'</span></span></div>';
}
function renderScoreboard(sb,gatorsId,recById){
  var games=(sb&&sb.games)||[];
  $('sbSec').style.display='';
  $('sbMeta').textContent=(sb&&sb.dateLabel)||'';
  if(!games.length){$('scoreboardBody').innerHTML='<div class="note">No league games scheduled for this day.</div>';return;}
  var h='';
  games.forEach(function(g){
    var fin=g.state==='final',live=g.state==='live';
    var haveScores=g.away.score!=null&&g.home.score!=null;
    // Bold the winner (final) or the current leader (live); plain on ties.
    var aw=haveScores&&(fin||live)&&g.away.score>g.home.score;
    var hw=haveScores&&(fin||live)&&g.home.score>g.away.score;
    var st=live?'live':fin?'final':'';
    var showScore=fin||live;
    // Status block: compact inning, then outs + bases diamond for live games
    // (shown for any live game we have feed data for, not just the Gators').
    var stat='<div class="sbinn">'+esc(live?sbCompactInn(g.status):sbStatus(g))+'</div>';
    if(live){
      var topOrBot=/^(top|bot)/i.test(g.status||'');
      if(topOrBot&&g.outs!=null)stat+='<div class="sbouts">'+g.outs+' Out'+(g.outs===1?'':'s')+'</div>';
      if(topOrBot&&g.bases)stat+=sbDiamond(g.bases);
    }
    var tag=g.url?'a':'div',attr=g.url?(' href="'+esc(g.url)+'" target="_blank" rel="noopener"'):'';
    h+='<'+tag+' class="sbg'+(g.isGators?' g':'')+'"'+attr+'>'
      +'<div class="sbteams">'+sbTeamRow(g.away,aw,g.away.id===gatorsId,showScore,recById,fin)+sbTeamRow(g.home,hw,g.home.id===gatorsId,showScore,recById,fin)+'</div>'
      +'<div class="sbstat '+st+'">'+stat+'</div></'+tag+'>';
  });
  $('scoreboardBody').innerHTML=h;
}
function silentStandings(){
  fetch('/api/standings',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    if(d&&d.rows){standingsData=d;renderStandings(d);}
  }).catch(function(){});
}
// ----- team hitting (opponent batting lines, opened from the Standings tab) ---
var thId=null,thPolls=0;
function openTeamHitting(id,name){
  if(!id)return;
  thId=id;thPolls=0;
  var lg=$('thLogo');lg.classList.remove('hasimg');lg.textContent='';
  var im=new Image();im.alt='';
  im.onload=function(){if(thId!==id)return;lg.classList.add('hasimg');lg.innerHTML='';lg.appendChild(im);};
  im.src='https://cdn.prestosports.com/action/cdn/logos/id/'+id+'.png';
  $('thName').textContent=name||'Team';
  $('thSub').textContent='Team hitting';
  $('thBody').innerHTML='<div class="spin" style="padding:16px">Loading hitting…</div>';
  $('thModal').classList.add('show');$('thModal').style.zIndex=++modalZ;syncBg();
  loadTeamHitting(id,name);
}
function loadTeamHitting(id,name){
  fetch('/api/team-hitting?id='+encodeURIComponent(id),{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    if(thId!==id)return; // a different team (or close) happened while we waited
    // Stats are still being scraped on first load — keep the spinner and retry.
    if((!d.hitters||!d.hitters.length)&&d.loading&&thPolls<15){thPolls++;setTimeout(function(){loadTeamHitting(id,name);},3000);return;}
    renderTeamHitting(d);
  }).catch(function(){if(thId===id)$('thBody').innerHTML='<div class="note" style="padding:12px">Could not load hitting. Tap the team again to retry.</div>';});
}
function thCell(o,k){return (o&&o[k]!=null&&o[k]!==''&&o[k]!=='-')?esc(String(o[k])):'';}
function renderTeamHitting(d){
  var hitters=(d&&d.hitters)||[];
  var site=d&&d.site?'<div class="thsite"><a href="'+esc(d.site)+'" target="_blank" rel="noopener">Team site ↗</a></div>':'';
  if(!hitters.length){$('thBody').innerHTML='<div class="note" style="padding:12px">Hitting stats aren’t available for this team yet.</div>'+site;return;}
  var head='<tr><th class="lunm">Player</th><th class="lpn">AVG</th><th class="lpn">OBP</th><th class="lpn">SLG</th>'+
    '<th class="lpn">HR</th><th class="lpn">RBI</th><th class="lpn">H</th><th class="lpn">AB</th></tr>';
  var rows='';
  hitters.forEach(function(p){var s=p.stats||{};
    rows+='<tr><td class="lunm">'+esc(p.name)+'</td>'+
      '<td class="lpn lavg">'+thCell(s,'avg')+'</td>'+
      '<td class="lpn">'+thCell(s,'obp')+'</td>'+
      '<td class="lpn">'+thCell(s,'slg')+'</td>'+
      '<td class="lpn">'+thCell(s,'hr')+'</td>'+
      '<td class="lpn">'+thCell(s,'rbi')+'</td>'+
      '<td class="lpn">'+thCell(s,'h')+'</td>'+
      '<td class="lpn">'+thCell(s,'ab')+'</td></tr>';
  });
  $('thBody').innerHTML='<div class="lubox"><table class="lutbl">'+head+rows+'</table></div>'+site;
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
    rosterReq=false;rosterData=d.players||[];_gnSlug=null;mergeStats(rosterData);renderRoster(d);
    // Re-render a live game so its lineup names pick up profile links now the roster is in.
    if(lastGame&&lastGame.status==='live')renderGame(lastGame);
    lazyFill();
    // Keep polling until stats are complete AND headshots have loaded, so a fast
    // (cached) stats response doesn't leave profiles photoless.
    if((!clientComplete()||!d.photos)&&rosterPolls<60){rosterPolls++;setTimeout(function(){loadRoster();},4000);}
  }).catch(function(){rosterReq=false;$('rosterBody').innerHTML='<div class="spin">Could not load the roster. Tap Roster again to retry.</div>';});
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
    var box=p.photo?('<img class="ppic" src="'+esc(p.photo)+'" alt="">'):('<span class="pinit">'+esc(pInitials(p.name))+'</span>');
    h+='<div class="pcard" data-slug="'+p.slug+'">'+
       '<div class="pnum">'+box+'</div>'+
       '<div class="pmain"><div class="pname"><span class="pnametext">'+esc(p.name)+'</span><span class="pjersey">'+(p.numTBD?'TBD':'#'+p.num)+'</span></div>'+
       '<div class="pmeta"><b>'+esc(posLabel(p))+'</b> · '+esc(p.cls)+' · '+esc(p.school)+'</div></div>'+
       cardStats(p)+'<div class="pchev">›</div></div>';
  }
  if(d&&d.coaches&&d.coaches.length){
    coachData=d.coaches;
    h+='<div class="csec">Coaching Staff</div>';
    for(var k=0;k<d.coaches.length;k++){var c=d.coaches[k];
      var cbox=c.photo?('<img class="ppic" src="'+esc(c.photo)+'" alt="">'):('<span class="pinit">'+esc(pInitials(c.name))+'</span>');
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
  $('plSub').textContent=posLabel(p)+' · '+p.cls+' · '+p.school;
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
$('thClose').addEventListener('click',function(){thId=null;$('thModal').classList.remove('show');syncBg();});
$('thModal').addEventListener('click',function(e){if(e.target===this){thId=null;this.classList.remove('show');syncBg();}});
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
const APP_HTML = APP.replace('__BUILD_LABEL__', BUILD_LABEL).replace('__BUILD_COMMIT__', BUILD.commit);
