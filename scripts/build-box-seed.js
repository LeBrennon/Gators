// Rebuild box-seed.json — the committed warm-boot snapshot of every FINAL
// game's box score (loadBoxCache in server.js loads it to fill any gap in the
// runtime disk cache). A final's box never changes, so once a game is
// captured here it never needs PrestoSports again — that matters because the
// runtime cache lives on the app's disk, which a redeploy can wipe, forcing a
// full re-walk of the season against Presto's bot gate all at once (which it
// does not tolerate well). This seed means a fresh deploy boots with the
// whole season already known instead of racing Presto to re-earn it.
//
//   node scripts/build-box-seed.js [baseUrl]
//
// Run it periodically (same cadence as build-seed.js) so newly-finished games
// join the seed promptly. Merges into the existing file rather than replacing
// it — a game Presto is currently gating just keeps its last-known-good entry
// (or is skipped if it has none yet) instead of the whole seed regressing.
const fs = require('fs');
const path = require('path');
const BASE = (process.argv[2] || 'https://www.whatisthegatorscore.com').replace(/\/$/, '');
const OUT = path.join(__dirname, '..', 'box-seed.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url) {
  try { const r = await fetch(url); if (r.ok) return await r.json(); return null; } catch (e) { return null; }
}

// Mirrors boxLooksComplete() in server.js — never seed a bot-gate stub.
const looksComplete = d => !!(d && Array.isArray(d.box) && d.box.length >= 2);

(async () => {
  const sched = await getJSON(BASE + '/api/schedule');
  if (!sched || !Array.isArray(sched.games)) { console.error('could not load /api/schedule'); process.exit(1); }
  const finals = sched.games.filter(g => g.state === 'final');

  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')).boxes || {}; } catch (e) {}

  const boxes = Object.assign({}, existing);
  let added = 0, already = 0, gated = 0;
  for (const g of finals) {
    if (boxes[g.id] && looksComplete(boxes[g.id].data)) { already++; continue; }
    const res = await getJSON(BASE + '/api/boxscore?id=' + encodeURIComponent(g.id));
    if (looksComplete(res)) { boxes[g.id] = { data: res, at: Date.now() }; added++; }
    else gated++;
    await sleep(300);
  }

  fs.writeFileSync(OUT, JSON.stringify({ boxes }));
  console.log(`wrote box-seed.json: ${Object.keys(boxes).length}/${finals.length} finals ` +
    `(${added} newly added, ${already} already seeded, ${gated} still gated by Presto)`);
})();
