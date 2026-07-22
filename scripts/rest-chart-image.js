#!/usr/bin/env node
// Renders the pitchers' rest data (/api/rest) to a single compact PNG for chat
// delivery. This is a purpose-built grid layout, NOT a screenshot of the mobile
// /rest webpage — a tall single-column list is exactly the shape that gets cut
// off in an iMessage bubble preview (you have to tap to see the rest of it). A
// multi-column grid keeps the whole chart roughly landscape/square so it's
// fully visible without tapping, however many pitchers are on it.
//
// Reads from the already-deployed site (REST_BASE, default production) rather
// than booting a local copy — the local server would have to re-scrape Presto
// from scratch, which is exactly the bot-gating problem this avoids.
//
// Only builds at actual noon Central (unless --force), so the two cron fires
// scheduled 17:00 UTC / 18:00 UTC (CDT / CST) net exactly one image a day
// across DST, the same gate the old daily-rest workflow used. Prints the
// written PNG path on stdout so a caller can pick it up; prints nothing and
// exits 0 when skipped.
//
//   node scripts/rest-chart-image.js           # only builds at noon Central
//   node scripts/rest-chart-image.js --force   # build regardless of the hour

const fs = require('fs');
const path = require('path');
const os = require('os');

const REST_BASE = process.env.REST_BASE || 'https://www.whatisthegatorscore.com';
const OUT_DIR = path.join(__dirname, '..', 'reports', 'rest');
const FORCE = process.argv.includes('--force');

function findChromium() {
  const cands = [process.env.CHROMIUM_PATH, process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  try {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) {}
  return null;
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const restClass = d => d <= 1 ? 'hot' : d >= 4 ? 'cool' : 'warm';
const mmdd = ymd => (+ymd.slice(4, 6)) + '/' + (+ymd.slice(6, 8));

// Keep the grid roughly square regardless of roster size (~6 rows per column,
// so 15 pitchers is 3x5, 17 is 3x6, 24 is 4x6) — a wide banner shrinks each
// column's text too much once iMessage scales it to the bubble's fixed width,
// and a tall single column is the shape that gets cut off needing a tap.
function gridCols(n) { return Math.max(1, Math.ceil(n / 6)); }

function buildHtml(data) {
  const today = data.today;
  const pitchers = data.pitchers;
  const cols = gridCols(pitchers.length);
  const cards = pitchers.map(p => (
    '<div class="card">'
    + '<div class="ctop"><span class="cn">' + (p.num != null ? p.num : '') + '</span>'
    + '<span class="cnm">' + esc(p.name) + (p.lastLive ? ' <span class="live">LIVE</span>' : '') + '</span></div>'
    + '<div class="cbot"><span class="cmeta"><b>' + (p.lastNp || 0) + 'p</b> · ' + (p.lastDate === today ? 'tonight' : esc(mmdd(p.lastDate))) + '</span>'
    + '<span class="crd ' + restClass(p.daysRest) + '">' + p.daysRest + '<i>d</i></span></div>'
    + '</div>'
  )).join('');
  const liveTag = data.liveGame
    ? ' · <span class="livehdr">' + (data.liveGame.live ? 'LIVE ' : 'FINAL ') + esc((data.liveGame.gatorsHome ? 'vs ' : '@ ') + data.liveGame.oppShort) + '</span>'
    : '';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
    + ':root{--bayou:#16102b;--bayou2:#1e1640;--line:#41327a;--gold:#ecc913;--gold2:#ffd633;--bone:#f0ede4;--mute:#9a8cc4;--win:#7BD88F;--loss:#e0524a;}'
    + '*{box-sizing:border-box;}body{margin:0;background:var(--bayou);color:var(--bone);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}'
    + '.wrap{display:inline-block;padding:22px 24px 20px;}'
    + '.hd{text-align:center;margin-bottom:14px;}'
    + '.hd .t{font-family:Georgia,serif;font-weight:800;font-size:26px;color:var(--gold);letter-spacing:.5px;}'
    + '.hd .d{color:var(--mute);font-size:13px;letter-spacing:.06em;text-transform:uppercase;margin-top:4px;}'
    + '.livehdr{color:var(--gold2);font-weight:700;}'
    + '.grid{display:grid;grid-template-columns:repeat(' + cols + ',232px);gap:9px;}'
    + '.card{border:1px solid var(--line);border-radius:10px;background:var(--bayou2);padding:8px 12px;}'
    + '.ctop{display:flex;align-items:baseline;gap:7px;}'
    + '.cn{color:var(--gold2);font-weight:800;font-size:12px;font-variant-numeric:tabular-nums;min-width:14px;}'
    + '.cnm{font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.live{display:inline-block;font-size:8px;font-weight:800;letter-spacing:.05em;color:#16102b;background:var(--gold2);border-radius:4px;padding:1px 3px;vertical-align:1px;}'
    + '.cbot{display:flex;justify-content:space-between;align-items:baseline;margin-top:3px;}'
    + '.cmeta{color:var(--mute);font-size:12px;font-variant-numeric:tabular-nums;}.cmeta b{color:var(--gold2);}'
    + '.crd{font-size:17px;font-weight:800;font-variant-numeric:tabular-nums;}'
    + '.crd i{font-size:10px;font-weight:700;color:var(--mute);font-style:normal;margin-left:1px;}'
    + '.crd.hot{color:var(--loss);}.crd.warm{color:var(--bone);}.crd.cool{color:var(--win);}'
    + '.lgd{color:var(--mute);font-size:11px;text-align:center;margin-top:14px;max-width:' + (cols * 232 + (cols - 1) * 9) + 'px;line-height:1.5;}'
    + '.lgd .hot{color:var(--loss);font-weight:700;}.lgd .cool{color:var(--win);font-weight:700;}'
    + '</style></head><body><div class="wrap">'
    + '<div class="hd"><div class="t">Pitchers’ Rest</div><div class="d">' + esc(dateLabel(today)) + liveTag + '</div></div>'
    + '<div class="grid">' + cards + '</div>'
    + '<div class="lgd">Big number = <b>days of rest</b>. <span class="hot">≤1 just threw</span> · <span class="cool">4+ rested</span> · pitches shown are the last outing.</div>'
    + '</div></body></html>';
}

function dateLabel(ymd) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  return wd + ' ' + (+ymd.slice(4, 6)) + '/' + (+ymd.slice(6, 8));
}

async function main() {
  if (!FORCE) {
    const centralHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(new Date());
    if (Number(centralHour) % 24 !== 12) return; // not noon Central — the other cron fire handles today
  }

  const res = await fetch(REST_BASE.replace(/\/$/, '') + '/api/rest');
  if (!res.ok) throw new Error('/api/rest -> ' + res.status);
  const data = await res.json();
  if (!data.pitchers || !data.pitchers.length) { console.error('[rest-chart-image] no pitchers in /api/rest yet'); process.exit(1); }

  const bin = findChromium();
  if (!bin) { console.error('[rest-chart-image] no Chromium found (set CHROMIUM_PATH).'); process.exit(1); }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: bin, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1400 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const tmp = path.join(os.tmpdir(), 'rest-chart-' + Date.now() + '.html');
    fs.writeFileSync(tmp, buildHtml(data));
    await page.goto('file://' + tmp, { waitUntil: 'networkidle', timeout: 20000 });
    fs.unlinkSync(tmp);

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const stem = ymd.slice(5, 7) + '-' + ymd.slice(8, 10) + '-' + ymd.slice(0, 4);
    const file = path.join(OUT_DIR, 'pitchers-rest-' + stem + '.png');
    const box = await page.evaluate(() => { const r = document.querySelector('.wrap').getBoundingClientRect(); return { width: Math.ceil(r.width), height: Math.ceil(r.height) }; });
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: box.width, height: box.height } });
    console.log(file); // stdout = the image path for the caller to pick up
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[rest-chart-image] ' + (e && e.message || e)); process.exit(1); });
