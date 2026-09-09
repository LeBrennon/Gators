#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'big-leagues-media-config.json'), 'utf8'));
const OUT_DIR = path.join(ROOT, 'data', 'big-leagues-media');
const FEED_PATH = path.join(OUT_DIR, 'feed.json');
const REVIEW_PATH = path.join(OUT_DIR, 'review.json');
const STATE_PATH = path.join(OUT_DIR, 'state.json');

const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY || '';
const X_BEARER = process.env.X_BEARER_TOKEN || '';
const YOUTUBE_KEY = process.env.YOUTUBE_API_KEY || '';
const USER_AGENT = 'Big-Leagues-Media-Tracker/1.0 (+https://github.com/LeBrennon/Gators)';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function clean(s = '') { return String(s).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim(); }
function lower(s = '') { return clean(s).toLowerCase(); }
function hash(input) { return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 24); }
function domainOf(url = '') { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }
function canonicalUrl(url = '') {
  try {
    const u = new URL(url);
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'].forEach(k => u.searchParams.delete(k));
    u.hash = '';
    return u.toString();
  } catch { return url; }
}
function nowIso() { return new Date().toISOString(); }
function termHit(text, terms = []) { const t = lower(text); return terms.some(x => t.includes(lower(x))); }
function exactPlayerHit(text, player) { return termHit(text, [player.name, ...player.aliases.filter(a => a.length >= 5)]); }
function contextHit(text, player) { return termHit(text, player.contextTerms || []); }

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'user-agent': USER_AGENT, accept: options.accept || '*/*', ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.text();
}
async function fetchJson(url, options = {}) { return JSON.parse(await fetchText(url, { ...options, accept: 'application/json' })); }

function sourceType(item) {
  const d = domainOf(item.url);
  if (CONFIG.socialDomains.some(x => d === x || d.endsWith('.' + x))) return 'social';
  if (CONFIG.videoDomains.some(x => d === x || d.endsWith('.' + x))) return 'video';
  return item.kind || 'article';
}

function classifyFanSentiment(item) {
  const text = `${item.title || ''} ${item.description || ''}`;
  const positive = CONFIG.positiveTerms.filter(t => lower(text).includes(lower(t)));
  const negative = CONFIG.negativeTerms.filter(t => lower(text).includes(lower(t)));
  const ambiguous = CONFIG.ambiguousTerms.filter(t => lower(text).includes(lower(t)));
  if (negative.length) return { bucket: 'reject', reason: `negative fan content: ${negative.slice(0,3).join(', ')}`, positive, negative, ambiguous };
  if (positive.length >= 1 && ambiguous.length === 0) return { bucket: 'publish', reason: 'clearly positive fan engagement', positive, negative, ambiguous };
  return { bucket: 'review', reason: positive.length ? 'positive but potentially ambiguous fan content' : 'fan sentiment not clearly positive', positive, negative, ambiguous };
}

function classify(item, player) {
  const text = `${item.title || ''} ${item.description || ''} ${item.author || ''}`;
  const relevant = exactPlayerHit(text, player) || (termHit(text, player.aliases || []) && contextHit(text, player));
  if (!relevant) return { bucket: 'reject', reason: 'insufficient player relevance' };
  const type = sourceType(item);
  if (type === 'social' && !item.official) return classifyFanSentiment(item);
  return { bucket: 'publish', reason: type === 'social' ? 'official/verified social media' : 'relevant media coverage' };
}

function normalize(raw, player, provider) {
  const url = canonicalUrl(raw.url || '');
  const domain = domainOf(url);
  const item = {
    id: hash(`${url}|${raw.title || ''}|${player.mlbamId}`),
    playerId: player.mlbamId,
    playerName: player.name,
    playerLabel: player.label,
    provider,
    kind: raw.kind || null,
    sourceType: null,
    source: raw.source || domain || provider,
    author: clean(raw.author || ''),
    title: clean(raw.title || ''),
    description: clean(raw.description || ''),
    url,
    imageUrl: raw.imageUrl || null,
    videoUrl: raw.videoUrl || null,
    publishedAt: raw.publishedAt || null,
    discoveredAt: nowIso(),
    official: Boolean(raw.official),
    metrics: raw.metrics || null
  };
  item.sourceType = sourceType(item);
  const verdict = classify(item, player);
  return { ...item, moderation: verdict };
}

function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return m ? clean(m[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : '';
  };
  for (const b of blocks) {
    const link = tag(b, 'link');
    const sourceMatch = b.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    items.push({
      title: tag(b, 'title'),
      description: tag(b, 'description'),
      url: link,
      source: sourceMatch ? clean(sourceMatch[1]) : '',
      publishedAt: tag(b, 'pubDate') ? new Date(tag(b, 'pubDate')).toISOString() : null,
      kind: 'article'
    });
  }
  return items;
}

async function googleNews(player) {
  const q = `"${player.name}" baseball OR ${player.contextTerms.map(x => `"${x}"`).join(' OR ')}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  try { return parseRss(await fetchText(url)); } catch (e) { console.warn('Google News:', player.name, e.message); return []; }
}

async function braveSearch(player) {
  if (!BRAVE_KEY) return [];
  const queries = [
    `"${player.name}" baseball`,
    `"${player.name}" (site:x.com OR site:twitter.com OR site:instagram.com OR site:threads.net OR site:tiktok.com OR site:facebook.com OR site:bsky.app)`,
    `"${player.name}" (site:youtube.com OR site:reddit.com)`,
    ...(player.socialSearchTerms || []).slice(0, 2)
  ];
  const out = [];
  for (const q of queries) {
    try {
      const data = await fetchJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=20&freshness=pm`, { headers: { 'X-Subscription-Token': BRAVE_KEY } });
      for (const r of data.web?.results || []) out.push({ title: r.title, description: r.description, url: r.url, source: r.profile?.long_name || domainOf(r.url), publishedAt: r.age ? null : null, imageUrl: r.thumbnail?.src || null });
    } catch (e) { console.warn('Brave:', q, e.message); }
  }
  return out;
}

async function redditSearch(player) {
  const q = encodeURIComponent(`"${player.name}" baseball`);
  try {
    const data = await fetchJson(`https://www.reddit.com/search.json?q=${q}&sort=new&t=month&limit=50&raw_json=1`);
    return (data.data?.children || []).map(x => x.data).filter(Boolean).map(r => ({
      title: r.title,
      description: r.selftext || '',
      url: `https://www.reddit.com${r.permalink}`,
      source: `r/${r.subreddit}`,
      author: r.author,
      publishedAt: r.created_utc ? new Date(r.created_utc * 1000).toISOString() : null,
      imageUrl: /^https?:/.test(r.thumbnail || '') ? r.thumbnail : null,
      kind: 'social',
      metrics: { score: r.score, comments: r.num_comments }
    }));
  } catch (e) { console.warn('Reddit:', player.name, e.message); return []; }
}

async function xSearch(player) {
  if (!X_BEARER) return [];
  const query = `("${player.name}") (baseball OR Phillies OR Blue Jays OR Bisons OR Reading) -is:retweet lang:en`;
  const url = `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=100&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=name,username,verified`;
  try {
    const data = await fetchJson(url, { headers: { authorization: `Bearer ${X_BEARER}` } });
    const users = Object.fromEntries((data.includes?.users || []).map(u => [u.id, u]));
    return (data.data || []).map(t => {
      const u = users[t.author_id] || {};
      return {
        title: t.text,
        description: '',
        url: u.username ? `https://x.com/${u.username}/status/${t.id}` : `https://x.com/i/web/status/${t.id}`,
        source: 'X',
        author: u.username ? `@${u.username}` : '',
        publishedAt: t.created_at || null,
        kind: 'social',
        official: Boolean(u.verified && /phillies|bluejays|bisons|fightins|milb|mlb/i.test(u.username || '')),
        metrics: t.public_metrics || null
      };
    });
  } catch (e) { console.warn('X:', player.name, e.message); return []; }
}

async function youtubeSearch(player) {
  if (!YOUTUBE_KEY) return [];
  const q = `${player.name} baseball`;
  try {
    const data = await fetchJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=25&q=${encodeURIComponent(q)}&key=${encodeURIComponent(YOUTUBE_KEY)}`);
    return (data.items || []).map(v => ({
      title: v.snippet?.title,
      description: v.snippet?.description,
      url: `https://www.youtube.com/watch?v=${v.id?.videoId}`,
      videoUrl: `https://www.youtube.com/watch?v=${v.id?.videoId}`,
      source: v.snippet?.channelTitle || 'YouTube',
      author: v.snippet?.channelTitle || '',
      publishedAt: v.snippet?.publishedAt || null,
      imageUrl: v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.medium?.url || null,
      kind: 'video'
    }));
  } catch (e) { console.warn('YouTube:', player.name, e.message); return []; }
}

function mergeUnique(existing, incoming, max) {
  const map = new Map();
  for (const item of [...incoming, ...existing]) {
    const key = item.id || hash(`${canonicalUrl(item.url)}|${item.playerId}`);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()].sort((a,b) => new Date(b.publishedAt || b.discoveredAt || 0) - new Date(a.publishedAt || a.discoveredAt || 0)).slice(0, max);
}

async function discoverPlayer(player) {
  const batches = await Promise.all([
    googleNews(player),
    braveSearch(player),
    redditSearch(player),
    xSearch(player),
    youtubeSearch(player)
  ]);
  const providers = ['google-news','brave','reddit','x','youtube'];
  const out = [];
  batches.forEach((batch, i) => batch.forEach(raw => out.push(normalize(raw, player, providers[i]))));
  return out;
}

async function main() {
  const existingFeed = readJson(FEED_PATH, { updatedAt: null, items: [] });
  const existingReview = readJson(REVIEW_PATH, { updatedAt: null, items: [] });
  const state = readJson(STATE_PATH, { schemaVersion: 1, scans: 0, providers: {} });
  const found = [];
  for (const player of CONFIG.players) {
    console.log(`[Media] scanning ${player.name}`);
    found.push(...await discoverPlayer(player));
  }

  const publish = found.filter(x => x.moderation.bucket === 'publish');
  const review = found.filter(x => x.moderation.bucket === 'review');
  const rejected = found.filter(x => x.moderation.bucket === 'reject');

  const feedItems = mergeUnique(existingFeed.items || [], publish, CONFIG.maxFeedItems || 1000);
  const reviewItems = mergeUnique(existingReview.items || [], review, CONFIG.maxReviewItems || 500);
  const ts = nowIso();
  writeJson(FEED_PATH, { schemaVersion: 1, updatedAt: ts, policy: 'Fan-generated content must be clearly positive; ambiguous fan content is held for review.', items: feedItems });
  writeJson(REVIEW_PATH, { schemaVersion: 1, updatedAt: ts, items: reviewItems });
  writeJson(STATE_PATH, {
    schemaVersion: 1,
    lastScanAt: ts,
    scans: Number(state.scans || 0) + 1,
    lastScan: { discovered: found.length, published: publish.length, review: review.length, rejected: rejected.length },
    providers: {
      googleNews: true,
      brave: Boolean(BRAVE_KEY),
      reddit: true,
      x: Boolean(X_BEARER),
      youtube: Boolean(YOUTUBE_KEY)
    }
  });
  console.log(`[Media] found=${found.length} publish=${publish.length} review=${review.length} reject=${rejected.length}`);
  if (!BRAVE_KEY) console.log('[Media] BRAVE_SEARCH_API_KEY not configured: broad web/social discovery is limited.');
  if (!X_BEARER) console.log('[Media] X_BEARER_TOKEN not configured: direct X search is disabled; indexed X results can still arrive through Brave when enabled.');
  if (!YOUTUBE_KEY) console.log('[Media] YOUTUBE_API_KEY not configured: direct YouTube search is disabled; indexed YouTube results can still arrive through Brave when enabled.');
}

main().catch(err => { console.error('[Media] fatal:', err); process.exitCode = 1; });
