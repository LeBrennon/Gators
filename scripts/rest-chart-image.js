#!/usr/bin/env node
// Renders the public "Pitchers' Rest" chart (/rest) to a single tall PNG for chat
// delivery — unlike a paginated PDF, one continuous image opens full-screen in
// iMessage with nothing cut off at a page boundary.
//
// Reads from the already-deployed site (REST_BASE, default production) rather
// than booting a local copy — the local server would have to re-scrape Presto
// from scratch, which is exactly the bot-gating problem this avoids.
//
// Only builds at actual noon Central (unless --force), so the two cron fires
// scheduled 17:00 UTC / 18:00 UTC (CDT / CST) net exactly one image a day
// across DST, same gate the old daily-rest workflow used. Prints the written
// PNG path on stdout so a caller can pick it up; prints nothing and exits 0
// when skipped.
//
//   node scripts/rest-chart-image.js           # only builds at noon Central
//   node scripts/rest-chart-image.js --force   # build regardless of the hour

const fs = require('fs');
const path = require('path');

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

async function main() {
  if (!FORCE) {
    const centralHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(new Date());
    if (Number(centralHour) % 24 !== 12) return; // not noon Central — the other cron fire handles today
  }

  const bin = findChromium();
  if (!bin) { console.error('[rest-chart-image] no Chromium found (set CHROMIUM_PATH).'); process.exit(1); }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: bin, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    let target = REST_BASE.replace(/\/$/, '') + '/rest';
    try {
      await page.goto(target, { waitUntil: 'networkidle', timeout: 20000 });
    } catch (e) {
      // Some sandboxed environments reset a direct Chromium connection through
      // their outbound proxy even though plain HTTP fetch works fine there;
      // fall back to fetching the HTML ourselves and opening it as a local file.
      const res = await fetch(target);
      if (!res.ok) throw new Error(target + ' -> ' + res.status);
      const html = await res.text();
      const tmp = path.join(require('os').tmpdir(), 'rest-chart-' + Date.now() + '.html');
      fs.writeFileSync(tmp, html);
      await page.goto('file://' + tmp, { waitUntil: 'networkidle', timeout: 20000 });
      fs.unlinkSync(tmp);
    }

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const now = new Date();
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const stem = ymd.slice(5, 7) + '-' + ymd.slice(8, 10) + '-' + ymd.slice(0, 4);
    const file = path.join(OUT_DIR, 'pitchers-rest-' + stem + '.png');
    // The shared report shell forces body{min-height:100vh}, so a plain fullPage
    // shot trails a blank screen-height of empty background below the actual
    // content — crop to the real content bottom (.rwrap) instead.
    const width = page.viewportSize().width;
    const bottom = await page.evaluate(() => Math.ceil(document.querySelector('.rwrap').getBoundingClientRect().bottom) + 18);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width, height: bottom } });
    console.log(file); // stdout = the image path for the caller to pick up
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[rest-chart-image] ' + (e && e.message || e)); process.exit(1); });
