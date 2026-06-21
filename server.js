/* ============================================================================
 * Gators GameTracker — Cloud (lite)
 * One file. Polls the Texas League schedule (server-rendered, no browser),
 * pulls the Gators' live score + inning, serves the app, and pushes alerts on
 * runs, lead changes, and final. Fits a free host. Node 18+ (built-in fetch).
 * ==========================================================================*/
'use strict';
const express = require('express');
const cors = require('cors');
let webpush = null; try { webpush = require('web-push'); } catch (e) {}

const PORT         = process.env.PORT || 8787;
const POLL_MS      = Number(process.env.POLL_MS || 15000);
const SCHEDULE_URL = process.env.SCHEDULE_URL || 'https://texasleaguestats.prestosports.com/sports/bsb/2026/schedule';
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
const GATORS_ID = 'et1bt9sixrz5lnnl';
const GATORS_LOGO_B64 = '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';
const logo = id => id === GATORS_ID ? '/gators-logo.jpg' : 'https://cdn.prestosports.com/action/cdn/logos/id/' + id + '.png';
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function dateFromId(yyyymmdd) {
  const y = +yyyymmdd.slice(0,4), m = +yyyymmdd.slice(4,6), d = +yyyymmdd.slice(6,8);
  const dt = new Date(Date.UTC(y, m-1, d, 12));
  return { iso: y+'-'+yyyymmdd.slice(4,6)+'-'+yyyymmdd.slice(6,8), label: DOW[dt.getUTCDay()]+' '+m+'/'+d, sortKey: +yyyymmdd };
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
    out.push({ id: link.id, dateLabel: when.label, sortKey: when.sortKey, state: cls.state, status: cls.status,
      gatorsHome, opponent: { name: opp.name, short: opp.short, logo: opp.logo }, away: t.away, home: t.home });
  }
  const seen = new Set();
  return out.filter(g => (seen.has(g.id) ? false : seen.add(g.id))).sort((a,b) => a.sortKey - b.sortKey);
}

// ----- live situation feed --------------------------------------------------
const val = x => Array.isArray(x) ? x[0] : x;            // status fields arrive as 1-element arrays
const has = x => { const v = val(x); return v != null && String(v).trim() !== ''; };

// The boxscore page embeds the liveupdate event id + access hash that the live
// widget uses. Pull them out so we can call the feed ourselves.
function extractEventAuth(html) {
  const clean = String(html || '').replace(/&amp;/g, '&');
  let m = clean.match(/liveupdate\?e=([a-z0-9]+)&h=([A-Za-z0-9_\-]+)/i);
  if (m) return { e: m[1], h: m[2], how: 'liveupdate-url' };
  const e = (clean.match(/(?:eventId|["']e)["']?\s*[:=]\s*["']([a-z0-9]{12,})["']/i) || [])[1];
  const h = (clean.match(/(?:hash|liveHash|["']h)["']?\s*[:=]\s*["']([A-Za-z0-9_\-]{20,})["']/i) || [])[1];
  if (e && h) return { e, h, how: 'separate-tokens' };
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
  const url = ORIGIN + '/action/sports/liveupdate?e=' + e + '&h=' + h;
  const headers = { 'user-agent': UA, 'accept': 'application/json, text/javascript, */*; q=0.01',
    'x-requested-with': 'XMLHttpRequest', 'cache-control': 'no-cache' };
  if (referer) headers.referer = referer;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null, parseError = null;
  try { json = JSON.parse(text); } catch (err) { parseError = err.message; }
  return { url, ok: res.ok, status: res.status, contentType: res.headers.get('content-type') || '', length: text.length, json, parseError, head: text.slice(0, 200) };
}

// Boil the feed's status block down to the live game situation.
function summarizeLive(json) {
  const s = json && json.status; if (!s) return null;
  const battingHome = val(s.vh) === 'H';
  return {
    complete: val(s.complete) === 'Y',
    inning: val(s.inning),
    half: battingHome ? 'Bottom' : 'Top',
    battingTeam: String(val(s.batting) || '').trim(),
    outs: Number(val(s.outs)) || 0,
    balls: Number(val(s.b)) || 0,
    strikes: Number(val(s.s)) || 0,
    count: (val(s.b) || '0') + '-' + (val(s.s) || '0'),
    batter: has(s.batter) ? val(s.batter) : null,
    pitcher: has(s.pitcher) ? val(s.pitcher) : null,
    bases: { first: has(s.first), second: has(s.second), third: has(s.third) },
    runners: { first: val(s.first) || null, second: val(s.second) || null, third: val(s.third) || null },
  };
}

function teamLineScores(json) {
  return (json && json.team || []).map(t => ({
    vh: t.vh, name: t.name, teamId: t.teamId, isGators: t.teamId === GATORS_ID,
    runs: t.linescore && t.linescore.runs, hits: t.linescore && t.linescore.hits, errs: t.linescore && t.linescore.errs,
  }));
}

// Full chain: boxscore page -> event id + hash -> live feed -> summary.
async function fetchLiveForGame(boxscoreId) {
  const boxUrl = boxscoreUrl(boxscoreId);
  const out = { boxscoreId, boxUrl };
  const page = await fetchText(boxUrl, SCHEDULE_URL);
  out.boxPage = { ok: page.ok, status: page.status, length: page.body.length };
  const auth = extractEventAuth(page.body);
  out.auth = { e: auth.e, h: auth.h, how: auth.how };
  if (!auth.e || !auth.h) {
    out.snippet = snippetAround(page.body, 'liveupdate') || snippetAround(page.body, 'eventId') || snippetAround(page.body, 'gamecenter');
    return out;
  }
  const feed = await fetchLiveUpdate(auth.e, auth.h, boxUrl);
  out.feed = { url: feed.url, ok: feed.ok, status: feed.status, contentType: feed.contentType, length: feed.length, parseError: feed.parseError, head: feed.json ? undefined : feed.head };
  if (feed.json) { out.live = summarizeLive(feed.json); out.teams = teamLineScores(feed.json); out.feedSource = feed.json.source; }
  return out;
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
    id: g.id, status, statusText: g.status, dateLabel: g.dateLabel,
    inning: ip.inning, half: ip.half,
    inningLabel: status === 'live' ? g.status : status === 'final' ? 'Final' : status === 'cancelled' ? 'Cancelled' : g.status,
    gatorsHome: g.gatorsHome, opponent: g.opponent,
    away: { name: g.away.name, short: g.away.short, logo: g.away.logo, runs: g.away.score || 0 },
    home: { name: g.home.name, short: g.home.short, logo: g.home.logo, runs: g.home.score || 0 },
  };
}

// ----- state ----------------------------------------------------------------
let games = [], featured = null, prevFeatured = null, pinnedId = null;
let lastHtml = '', lastFetchAt = 0;
const sseClients = new Set(), subscribers = new Set(), startedAnnounced = new Set();

function pick(list) {
  if (pinnedId) { const p = list.find(x => x.id === pinnedId); if (p) return p; }
  const live = list.find(g => g.state === 'live'); if (live) return live;
  const sched = list.filter(g => g.state === 'scheduled'); if (sched.length) return sched[0];
  const finals = list.filter(g => g.state === 'final'); if (finals.length) return finals[finals.length - 1];
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
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
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
    const chosen = pick(games);
    if (chosen) {
      const norm = normalizeFeatured(chosen);
      prevFeatured = featured; featured = norm;
      diffAlert(norm);
      broadcast({ type: 'game', game: norm });
      process.stdout.write('\r[' + new Date().toLocaleTimeString() + '] ' + norm.away.short + ' ' + norm.away.runs + '-' + norm.home.runs + ' ' + norm.home.short + '  (' + norm.inningLabel + ')        ');
    }
  } catch (err) { process.stdout.write('\r[poll error] ' + err.message + '        '); }
}

// ----- server ---------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (_q, r) => r.type('html').send(APP));
app.get('/sw.js', (_q, r) => r.type('application/javascript').send(SW));
app.get('/manifest.json', (_q, r) => r.type('application/json').send(MANIFEST));
app.get('/health', (_q, r) => r.json({ ok: true, games: games.length, featured: featured && featured.id, push: pushReady }));
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
    const result = await fetchLiveForGame(id);
    r.json(result);
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
app.get('/api/game', (_q, r) => featured ? r.json(featured) : r.status(503).json({ status: 'waiting' }));
app.get('/gators-logo.jpg', (_q, r) => { r.set('Content-Type','image/jpeg'); r.set('Cache-Control','public, max-age=86400'); r.send(Buffer.from(GATORS_LOGO_B64,'base64')); });
app.get('/api/schedule', (_q, r) => r.json({ games }));
app.post('/api/follow', (q, r) => { pinnedId = (q.body && q.body.id) || null; pollSchedule(); r.json({ ok: true, pinned: pinnedId }); });
app.get('/api/vapidPublicKey', (_q, r) => r.json({ key: VAPID_PUB, enabled: pushReady }));
app.post('/api/subscribe', (q, r) => { if (!pushReady) return r.status(501).json({ error: 'push off' }); subscribers.add(q.body); r.json({ ok: true }); });
app.get('/api/test', (_q, r) => {
  if (!pushReady) return r.status(501).json({ ok: false, error: 'push not configured (set VAPID keys)' });
  notify('Test \uD83D\uDC0A', 'Push is working — you\u2019re all set', 'run');
  r.json({ ok: true, sentTo: subscribers.size });
});
app.get('/api/stream', (q, r) => {
  r.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  r.flushHeaders(); if (featured) r.write('data: ' + JSON.stringify({ type: 'game', game: featured }) + '\n\n');
  sseClients.add(r); q.on('close', () => sseClients.delete(r));
});

if (require.main === module) {
  app.listen(PORT, () => { console.log('\nGators cloud on http://localhost:' + PORT + '  push:' + (pushReady ? 'on' : 'off') + '\n'); pollSchedule(); setInterval(pollSchedule, POLL_MS); });
}
module.exports = { parseSchedule, classify, teamsFromChunk, normalizeFeatured, summarizeLive, teamLineScores, extractEventAuth };

// ----- embedded service worker ---------------------------------------------
const SW = [
"self.addEventListener('push',function(e){var d={title:'Gators',body:''};try{d=e.data.json();}catch(x){}",
"e.waitUntil(self.registration.showNotification(d.title||'Gators',{body:d.body||'',tag:d.tag||'g',renotify:true,icon:'icon.png',badge:'icon.png',vibrate:[80,40,80]}));});",
"self.addEventListener('notificationclick',function(e){e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(function(l){for(var i=0;i<l.length;i++){if('focus'in l[i])return l[i].focus();}if(clients.openWindow)return clients.openWindow('./');}));});"
].join('\n');

const MANIFEST = JSON.stringify({ name: 'Gators GameTracker', short_name: 'Gators', start_url: './', display: 'standalone', background_color: '#16102b', theme_color: '#16102b' });

// ----- embedded app (no backticks inside) -----------------------------------
const APP = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#16102b"><link rel="manifest" href="manifest.json">
<title>Gators GameTracker</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@500;600;700&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet">
<style>
:root{--bayou:#16102b;--bayou2:#1e1640;--panel:#2b1e5c;--line:#41327a;--gator:#b9a6ee;--gator2:#4f3191;--purple:#6f4fd4;--gold:#f2b705;--gold2:#ffd23f;--bone:#f0ede4;--mute:#9a8cc4;--away:#e0524a;}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body{margin:0;background:var(--bayou);}
body{font-family:'Inter',system-ui,sans-serif;color:var(--bone);min-height:100vh;
background:radial-gradient(1200px 600px at 50% -10%,rgba(111,79,212,.18),transparent 60%),radial-gradient(900px 500px at 80% 110%,rgba(79,49,145,.20),transparent 55%),var(--bayou);-webkit-font-smoothing:antialiased;}
.wrap{max-width:520px;margin:0 auto;padding:0 14px 120px;}
.topbar{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:10px;padding:14px 4px 12px;background:linear-gradient(180deg,var(--bayou) 70%,transparent);}
.lead{font-family:'Oswald',sans-serif;font-weight:700;letter-spacing:.06em;font-size:20px;text-transform:uppercase;background:linear-gradient(90deg,var(--gold2),var(--gold));-webkit-background-clip:text;background-clip:text;color:transparent;}
.sub{font-size:9.5px;letter-spacing:.28em;color:var(--mute);text-transform:uppercase;font-weight:600;margin-top:3px;}
.chip{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);background:rgba(242,183,5,.1);border:1px solid rgba(242,183,5,.3);padding:6px 10px;border-radius:999px;}
.chip.live{color:var(--gator);background:rgba(157,92,255,.1);border-color:rgba(157,92,255,.3);}
.chip.off{color:#ff7a70;background:rgba(212,56,47,.1);border-color:rgba(212,56,47,.3);}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;}
.chip.live .dot{animation:pulse 1.8s infinite;}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(157,92,255,.5)}70%{box-shadow:0 0 0 8px rgba(157,92,255,0)}100%{box-shadow:0 0 0 0 rgba(157,92,255,0)}}
.jumbo{position:relative;border-radius:22px;overflow:hidden;border:1px solid var(--line);box-shadow:0 18px 40px -18px rgba(0,0,0,.8);padding:18px 16px;
background:linear-gradient(180deg,rgba(79,49,145,.30),transparent 40%),linear-gradient(180deg,var(--panel),var(--bayou2));}
.jumbo::before{content:"";position:absolute;inset:0;border-radius:22px;padding:1px;background:linear-gradient(135deg,rgba(242,183,5,.5),transparent 40%,rgba(139,92,246,.35));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;}
.sl{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:6px;}
.tm{display:flex;flex-direction:column;align-items:center;gap:8px;min-width:0;}
.tm img{width:54px;height:54px;border-radius:14px;object-fit:contain;background:#16102b;border:1px solid var(--line);}
.tm .nm{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.03em;font-size:12px;text-align:center;line-height:1.05;}
.tm.gators .nm{color:var(--gator);}
.tm .sc{font-family:'Oswald',sans-serif;font-weight:700;font-size:60px;line-height:.9;}
.tm.gators .sc{color:var(--gator);text-shadow:0 0 24px rgba(157,92,255,.35);}
.sc.flash{animation:fl .9s ease;}@keyframes fl{0%{transform:scale(1)}30%{transform:scale(1.18);filter:brightness(1.5)}100%{transform:scale(1)}}
.mid{display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 2px;}
.statpill{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:12px;letter-spacing:.06em;color:var(--gold2);background:rgba(242,183,5,.08);border:1px solid rgba(242,183,5,.25);border-radius:999px;padding:6px 11px;text-align:center;text-transform:uppercase;white-space:nowrap;}
.statpill.live{color:var(--gator);background:rgba(157,92,255,.08);border-color:rgba(157,92,255,.3);}
.vs{font-size:10px;color:var(--mute);letter-spacing:.1em;text-transform:uppercase;}
.mom{margin-top:16px;}
.mh{display:flex;justify-content:space-between;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);font-weight:700;margin-bottom:6px;}
.mb{height:9px;border-radius:999px;overflow:hidden;background:#221038;display:flex;border:1px solid var(--line);}
.mfa{background:linear-gradient(90deg,var(--away),#ff7a70);transition:width .6s;}
.mfh{background:linear-gradient(90deg,var(--gator2),var(--gator));transition:width .6s;}
.note{margin-top:14px;font-size:11.5px;line-height:1.6;color:var(--mute);background:var(--bayou2);border:1px solid var(--line);border-radius:14px;padding:13px 15px;}
.note b{color:var(--bone);font-weight:600;}
.sec{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.08em;font-size:13px;color:var(--mute);margin:22px 4px 10px;}
.card{background:var(--bayou2);border:1px solid var(--line);border-radius:14px;padding:11px 13px;margin-bottom:8px;cursor:pointer;}
.card.glive{border-color:rgba(157,92,255,.45);}
.card.gcancel{opacity:.5;}
.card.pinned{outline:1px solid rgba(242,183,5,.4);}
.ctop{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;}
.cdate{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--mute);font-weight:700;}
.cpill{font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;border-radius:999px;border:1px solid var(--line);color:var(--mute);display:flex;align-items:center;gap:5px;}
.cpill.live{color:var(--gator);border-color:rgba(157,92,255,.4);background:rgba(157,92,255,.08);}
.cpill.live .dot{width:5px;height:5px;animation:pulse 1.8s infinite;}
.cpill.final{color:var(--gold);}
.crow{display:flex;align-items:center;gap:9px;padding:3px 0;}
.crow img{width:22px;height:22px;border-radius:5px;object-fit:contain;background:#16102b;}
.crow .n{flex:1;font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.crow.g .n{color:var(--gator);}
.crow .s{font-family:'Oswald',sans-serif;font-weight:700;font-size:18px;min-width:22px;text-align:right;}
.crow.w .s{color:var(--gold2);}
.dock{position:fixed;left:0;right:0;bottom:0;z-index:50;background:linear-gradient(180deg,transparent,var(--bayou) 28%);padding:18px 14px;}
.dock .in{max-width:520px;margin:0 auto;}
.abtn{width:100%;font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.05em;font-size:13px;border-radius:14px;padding:14px;cursor:pointer;border:1px solid rgba(139,92,246,.35);background:rgba(139,92,246,.14);color:var(--purple);box-shadow:0 18px 40px -18px rgba(0,0,0,.8);}
.abtn.on{background:linear-gradient(180deg,var(--purple),#4f3191);color:#fff;border-color:var(--purple);}
.toasts{position:fixed;top:14px;left:0;right:0;z-index:60;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;padding:0 14px;}
.toast{max-width:500px;width:100%;display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,var(--panel),var(--bayou2));border:1px solid rgba(242,183,5,.5);border-radius:14px;padding:12px 14px;box-shadow:0 16px 40px -12px rgba(0,0,0,.85);transform:translateY(-130%);opacity:0;transition:.45s cubic-bezier(.2,.9,.25,1);}
.toast.show{transform:translateY(0);opacity:1;}
.toast .e{font-size:24px;}.toast b{display:block;font-family:'Oswald',sans-serif;font-weight:700;text-transform:uppercase;font-size:14px;color:var(--gold2);}
.toast.lead{border-color:rgba(157,92,255,.5);}.toast.lead b{color:var(--gator);}
.toast span{font-size:12px;}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;}}
</style></head><body>
<div class="toasts" id="toasts"></div>
<div class="wrap">
<div class="topbar"><div><div class="lead">Gators GameTracker</div><div class="sub">Texas Collegiate League</div></div>
<div class="chip" id="chip"><span class="dot"></span><span id="chiptx">Connecting</span></div></div>
<div class="jumbo">
<div class="sl">
<div class="tm" id="awayTm"><img id="awayLogo" alt=""><div class="nm" id="awayNm">—</div><div class="sc" id="awaySc">0</div></div>
<div class="mid"><div class="statpill" id="statpill">—</div><div class="vs" id="vs">vs</div></div>
<div class="tm" id="homeTm"><img id="homeLogo" alt=""><div class="nm" id="homeNm">—</div><div class="sc" id="homeSc">0</div></div>
</div>
<div class="mom"><div class="mh"><span id="mAwayL">Away</span><span>Win Momentum</span><span id="mHomeL">Home</span></div>
<div class="mb"><div class="mfa" id="mfa" style="width:50%"></div><div class="mfh" id="mfh" style="width:50%"></div></div></div>
<div class="note">Live score and inning, straight from the league feed. Tap <b>Get alerts</b> for a buzz at first pitch, every run, and the final.</div>
</div>
<div class="sec">Gators Schedule</div>
<div id="sched"></div>
</div>
<div class="dock"><div class="in"><button class="abtn" id="abtn">🔔 Get alerts</button></div></div>
<script>
var $=function(i){return document.getElementById(i);};
var alertsOn=false,curId=null;
function esc(s){return (s||'').replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function flash(el){el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');}
var prev={a:null,h:null};
function renderGame(g){
  var ah=!g.gatorsHome, hh=g.gatorsHome;
  $('awayTm').classList.toggle('gators',ah);$('homeTm').classList.toggle('gators',hh);
  $('awayLogo').src=g.away.logo;$('homeLogo').src=g.home.logo;
  $('awayNm').textContent=g.away.short;$('homeNm').textContent=g.home.short;
  $('mAwayL').textContent=g.away.short;$('mHomeL').textContent=g.home.short;
  if(g.id===curId){if(g.away.runs>prev.a)flash($('awaySc'));if(g.home.runs>prev.h)flash($('homeSc'));}
  $('awaySc').textContent=g.away.runs;$('homeSc').textContent=g.home.runs;
  prev={a:g.away.runs,h:g.home.runs};curId=g.id;
  var sp=$('statpill');sp.textContent=g.inningLabel;sp.classList.toggle('live',g.status==='live');
  $('vs').textContent=g.dateLabel+(g.status==='pregame'?' · upcoming':'');
  var diff=(g.home.runs||0)-(g.away.runs||0);var hp=Math.max(8,Math.min(92,50+diff*9));
  $('mfh').style.width=hp+'%';$('mfa').style.width=(100-hp)+'%';
  setChip(g.status);
}
function setChip(status){var c=$('chip'),t=$('chiptx');c.className='chip';
  if(status==='live'){c.classList.add('live');t.textContent='Live';}
  else if(status==='final'){t.textContent='Final';}
  else if(status==='off'){c.classList.add('off');t.textContent='Reconnecting';}
  else if(status==='cancelled'){c.classList.add('off');t.textContent='Cancelled';}
  else{t.textContent='Next up';}}
function renderSched(list){
  var live=list.filter(function(g){return g.state==='live';});
  var up=list.filter(function(g){return g.state==='scheduled';});
  var done=list.filter(function(g){return g.state==='final'||g.state==='cancelled';}).reverse();
  var ord=live.concat(up).concat(done),h='';
  ord.forEach(function(g){
    var pill=g.state==='live'?'<span class="cpill live"><span class="dot"></span>'+g.status+'</span>':g.state==='final'?'<span class="cpill final">'+g.status+'</span>':'<span class="cpill">'+esc(g.status)+'</span>';
    var aw=g.state==='final'&&g.away.score>g.home.score,hw=g.state==='final'&&g.home.score>g.away.score;
    function row(t,isG,won){return '<div class="crow'+(isG?' g':'')+(won?' w':'')+'"><img src="'+t.logo+'"><span class="n">'+esc(t.short)+'</span><span class="s">'+(t.score==null?'':t.score)+'</span></div>';}
    h+='<div class="card '+(g.state==='live'?'glive':g.state==='cancelled'?'gcancel':'')+(g.id===curId?' pinned':'')+'" data-id="'+g.id+'">'
      +'<div class="ctop"><span class="cdate">'+g.dateLabel+'</span>'+pill+'</div>'
      +row(g.away,g.away.id==='et1bt9sixrz5lnnl',aw)+row(g.home,g.home.id==='et1bt9sixrz5lnnl',hw)+'</div>';
  });
  $('sched').innerHTML=h||'<div class="note">No Gators games found yet.</div>';
  $('sched').querySelectorAll('.card').forEach(function(c){c.addEventListener('click',function(){
    fetch('/api/follow',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:c.dataset.id})}).catch(function(){});
    window.scrollTo({top:0,behavior:'smooth'});
  });});
}
function toast(e,t,s,cls){var el=document.createElement('div');el.className='toast '+(cls||'');
  el.innerHTML='<div class="e">'+e+'</div><div><b>'+t+'</b><span>'+s+'</span></div>';$('toasts').appendChild(el);
  requestAnimationFrame(function(){requestAnimationFrame(function(){el.classList.add('show');});});
  setTimeout(function(){el.classList.remove('show');setTimeout(function(){el.remove();},500);},4200);
  if(alertsOn&&'Notification'in window&&Notification.permission==='granted'){try{new Notification(t,{body:s});}catch(x){}}}
function emo(tag){return tag==='lead'?'📣':tag==='final'?'🏁':tag==='run'?'🔥':tag==='start'?'⚾':'🐊';}
function loadSched(){fetch('/api/schedule').then(function(r){return r.json();}).then(function(d){renderSched(d.games||[]);}).catch(function(){});}
function connect(){var es;function open(){try{es=new EventSource('/api/stream');}catch(e){setChip('off');return setTimeout(open,4000);}
  es.onmessage=function(ev){var m=JSON.parse(ev.data);if(m.type==='game'){renderGame(m.game);loadSched();}else if(m.type==='alert')toast(emo(m.tag),m.title,m.body,m.tag==='lead'||m.tag==='final'?'lead':'');};
  es.onerror=function(){setChip('off');es.close();setTimeout(open,4000);};}open();
  fetch('/api/game').then(function(r){return r.ok?r.json():null;}).then(function(g){if(g&&g.home)renderGame(g);}).catch(function(){});}
function urlB64(b){var p='='.repeat((4-b.length%4)%4),s=(b+p).replace(/-/g,'+').replace(/_/g,'/'),raw=atob(s),o=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)o[i]=raw.charCodeAt(i);return o;}
$('abtn').addEventListener('click',function(){
  var b=this;alertsOn=!alertsOn;b.classList.toggle('on',alertsOn);b.textContent=alertsOn?'🔔 Alerts on':'🔔 Get alerts';
  if(!alertsOn)return;
  (async function(){try{
    var info=await fetch('/api/vapidPublicKey').then(function(r){return r.json();});
    if('serviceWorker'in navigator&&'PushManager'in window&&info.enabled){
      var reg=await navigator.serviceWorker.register('sw.js');
      var perm=await Notification.requestPermission();
      if(perm==='granted'){var sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64(info.key)});
        await fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub)});
        toast('🔔','Phone alerts on','Runs, lead changes, and the final','lead');return;}}
    if('Notification'in window&&Notification.permission!=='denied')await Notification.requestPermission();
    toast('🔔','Alerts on','Pop-ups while this screen is open','');
  }catch(e){toast('🔔','Alerts on','Pop-ups while this screen is open','');}})();
});
// Re-register an existing push subscription whenever the app opens, so the
// server's in-memory subscriber list self-heals after a redeploy or sleep.
function resubscribe(){(async function(){try{
  if(!('serviceWorker'in navigator)||!('PushManager'in window))return;
  if(!('Notification'in window)||Notification.permission!=='granted')return;
  var info=await fetch('/api/vapidPublicKey').then(function(r){return r.json();});
  if(!info.enabled)return;
  var reg=await navigator.serviceWorker.register('sw.js');
  var sub=await reg.pushManager.getSubscription();
  if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64(info.key)});
  await fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub)});
  alertsOn=true;var b=$('abtn');b.classList.add('on');b.textContent='🔔 Alerts on';
}catch(e){}})();}
connect();loadSched();resubscribe();</script></body></html>`;
