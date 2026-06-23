// Rebuild roster-seed.json — the committed warm-boot snapshot the server falls
// back to when no live runtime cache exists (loadCache in server.js). Pulls each
// player's current full record from the live deploy and writes a stats-only
// snapshot (no photos — those load from the committed photos/ dir).
//
//   node scripts/build-seed.js [baseUrl]
//
// Run it periodically so a fresh deploy boots with recent stats instead of a
// blank cold-scrape window. The daily poll keeps the running server fresh; this
// only affects the first paint after a deploy.
const fs = require('fs');
const path = require('path');
const BASE = (process.argv[2] || 'https://gators.onrender.com').replace(/\/$/, '');
const OUT = path.join(__dirname, '..', 'roster-seed.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 4) {
  for (let a = 0; a < tries; a++) {
    try { const r = await fetch(url, { redirect: 'follow' }); if (r.ok) return await r.json(); } catch (e) {}
    await sleep(1500 + a * 1500);
  }
  return null;
}

(async () => {
  const roster = await getJSON(BASE + '/api/roster');
  if (!roster || !roster.players) { console.error('could not load /api/roster'); process.exit(1); }

  const rosterStats = {}, playerCache = {};
  let ok = 0, missing = [];
  for (const p of roster.players) {
    const rec = await getJSON(BASE + '/api/player?slug=' + encodeURIComponent(p.slug));
    const hasData = rec && (rec.hit || rec.pit || (rec.glBat || []).length || (rec.glPit || []).length);
    if (hasData) {
      playerCache[p.slug] = rec;
      rosterStats[p.slug] = { kind: rec.kind, hit: rec.hit, pit: rec.pit, hitRanks: rec.hitRanks || {}, pitRanks: rec.pitRanks || {} };
      ok++;
    } else {
      missing.push(p.num + ' ' + p.name); // no qualifying stats yet (or fetch failed)
    }
    await sleep(400);
  }

  fs.writeFileSync(OUT, JSON.stringify({ rosterStats, playerCache, rosterUpdated: roster.updated || 0 }));
  console.log(`wrote roster-seed.json: ${ok}/${roster.players.length} players with stats` +
    (missing.length ? `; no data for: ${missing.join(', ')}` : ''));
})();
