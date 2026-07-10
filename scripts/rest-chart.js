#!/usr/bin/env node
// Render the private "Pitchers' Rest" chart to a mobile one-page PDF for personal
// delivery — emailed by the post-game GitHub Action. This has nothing to do with
// the website: it boots the app on a localhost port behind a throwaway key,
// fetches the (key-gated) /rest page, prints a single 390px-wide page, and writes
// it to reports/rest/ (gitignored, never committed, never served).
//
//   node scripts/rest-chart.js            # writes reports/rest/pitchers-rest-MM-DD-YYYY.pdf
//
// Prints the written PDF path on stdout so the workflow can hand it to
// scripts/email-report.js. Exits non-zero only if it can't produce a chart.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.REST_PORT || 8991);
const KEY = 'ci-rest-' + process.pid;
const OUT_DIR = path.join(__dirname, '..', 'reports', 'rest');
// When REST_BASE is set (e.g. https://www.whatisthegatorscore.com), render the
// chart from that already-deployed app instead of booting a transient local
// server. The live deploy already has the scraped season data, so this avoids
// re-scraping Presto from a CI runner (whose IP the source blocks). /rest is
// public, so no report key is needed against an external base.
const REST_BASE = (process.env.REST_BASE || '').replace(/\/$/, '');
const BASE = REST_BASE || ('http://localhost:' + PORT);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Reuse the postgame report's Chromium resolution so CI and local both work.
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

async function getJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' -> ' + r.status); return r.json(); }

// Wait until the app has parsed the schedule and has at least one final game
// (so the chart has data), up to ~2 minutes.
async function waitForData() {
  for (let i = 0; i < 60; i++) {
    try { const s = await getJson(BASE + '/api/schedule'); if ((s.games || []).some(g => g.state === 'final')) return true; } catch (e) {}
    await sleep(2000);
  }
  return false;
}

async function main() {
  const bin = findChromium();
  if (!bin) { console.error('[rest-chart] no Chromium found (set CHROMIUM_PATH).'); process.exit(1); }

  // Boot a transient local server only when rendering locally; against REST_BASE
  // the deployed app is used as-is.
  const srv = REST_BASE ? null : spawn('node', [path.join(__dirname, '..', 'server.js')], {
    // Own port + throwaway report key; silence the outbound game-final dispatch so
    // booting this transient server never fires a duplicate post-game email.
    env: Object.assign({}, process.env, { PORT: String(PORT), REPORT_KEY: KEY, GH_DISPATCH_TOKEN: '' }),
    stdio: 'ignore',
  });

  let browser;
  try {
    if (!REST_BASE) {
      if (!(await waitForData())) throw new Error('no final games appeared in time');
      await sleep(6000);                        // let featured settle so tonight's live/final outings fold in
      await getJson(BASE + '/api/rest');        // warm the season walk (caches final boxes to disk)
    }
    const rest = await getJson(BASE + '/api/rest');
    const ymd = rest.today;                      // YYYYMMDD in Central time
    const stem = ymd.slice(4, 6) + '-' + ymd.slice(6, 8) + '-' + ymd.slice(0, 4);

    // /rest is public, so an external (deployed) base needs no report key.
    const restUrl = BASE + '/rest' + (REST_BASE ? '' : ('?key=' + KEY));
    const { chromium } = require('playwright-core');
    browser = await chromium.launch({ executablePath: bin, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(restUrl, { waitUntil: 'networkidle' });
    await page.emulateMedia({ media: 'print' });
    await page.addStyleTag({ content: '@media print{*{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;}}' });
    const h = await page.evaluate(() => document.documentElement.scrollHeight);

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, 'pitchers-rest-' + stem + '.pdf');
    await page.pdf({ path: file, width: '390px', height: (h + 4) + 'px', printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
    console.log(file);                           // stdout = the artifact path for the workflow
  } finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    if (srv) { try { srv.kill('SIGKILL'); } catch (e) {} }
  }
}

main().catch(e => { console.error('[rest-chart] ' + (e && e.message || e)); process.exit(1); });
