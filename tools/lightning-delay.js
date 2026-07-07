#!/usr/bin/env node
'use strict';
/*
 * lightning-delay.js — live lightning-delay clock for a ballpark.
 *
 * Opens the Blitzortung / lightningmaps.org real-time strike feed (a WebSocket),
 * filters strikes to a radius around the park, and runs the delay clock:
 * any strike inside the clearing radius clears the field and (re)starts a
 * 30-minute countdown; the field can reopen 30 min after the LAST strike
 * inside the radius.
 *
 * Usage:
 *   node tools/lightning-delay.js                 # defaults: Joe Miller Ballpark, 6 mi
 *   node tools/lightning-delay.js --radius 8      # clear-field radius = 8 mi
 *   node tools/lightning-delay.js --lat 30.17 --lon -93.21 --name "My Park"
 *
 * Flags:
 *   --lat <deg>       park latitude   (default 30.1732005, Joe Miller Ballpark)
 *   --lon <deg>       park longitude  (default -93.2130354)
 *   --name <str>      park name for the header
 *   --radius <mi>     clearing radius; strike inside this = clear + reset 30 min (default 6)
 *   --close <mi>      danger-close alert radius (default 3)
 *   --hold <min>      minutes with no strike inside radius before all-clear (default 30)
 *   --tz <zone>       IANA timezone for display (default America/Chicago)
 *   --every <sec>     status readout interval (default 20)
 *
 * IMPORTANT — this is decision SUPPORT, not the decision. Blitzortung is a
 * community network explicitly "for entertainment only, not for protecting
 * people or equipment." It can miss strikes and mislocate them. Cross-check
 * against NWS radar (radar.weather.gov, lightning layer) and your own eyes/ears.
 * The go/no-go is the operator's call.
 *
 * Requires Node 18+ (uses the built-in global WebSocket; Node 22 tested).
 */

// ---- args ---------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const PARK = {
  lat: parseFloat(arg('lat', '30.1732005')),
  lon: parseFloat(arg('lon', '-93.2130354')),
  name: arg('name', 'Joe Miller Ballpark'),
};
const RADIUS_MI = parseFloat(arg('radius', '6'));   // clearing / clock radius
const CLOSE_MI = parseFloat(arg('close', '3'));     // danger-close alert
const HOLD_MIN = parseFloat(arg('hold', '30'));     // all-clear hold time
const LOG_MI = Math.max(RADIUS_MI * 2, 12);         // record context out to here
const TZ = arg('tz', 'America/Chicago');
const EVERY_MS = parseFloat(arg('every', '20')) * 1000;
const HOLD_MS = HOLD_MIN * 60000;

// ---- geo + decode helpers ----------------------------------------------
// Blitzortung streams each strike as an LZW-compressed JSON string; this is the
// decompressor the lightningmaps.org client uses.
function decode(b) {
  const dict = {};
  const data = ('' + b).split('');
  let ch = data[0], oldPhrase = ch;
  const out = [ch];
  let code = 256, phrase;
  for (let i = 1; i < data.length; i++) {
    const cc = data[i].charCodeAt(0);
    phrase = cc < 256 ? data[i] : (dict[cc] ? dict[cc] : oldPhrase + ch);
    out.push(phrase);
    ch = phrase.charAt(0);
    dict[code] = oldPhrase + ch;
    code++;
    oldPhrase = phrase;
  }
  return out.join('');
}
function haversineMi(la1, lo1, la2, lo2) {
  const R = 3958.8, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 +
            Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearing(la1, lo1, la2, lo2) {
  const r = Math.PI / 180;
  const y = Math.sin((lo2 - lo1) * r) * Math.cos(la2 * r);
  const x = Math.cos(la1 * r) * Math.sin(la2 * r) -
            Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r);
  const deg = (Math.atan2(y, x) / r + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}
const fmt = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: TZ });

// ---- state --------------------------------------------------------------
const nearby = [];        // strikes within LOG_MI: {dist, dir, strikeMs}
let lastInside = null;    // most recent strike within RADIUS_MI
let lastGlobalMsg = 0;    // heartbeat: last time ANY strike arrived (feed health)
let totalInside = 0;
let announcedClear = false, warned10 = false, lastCloseMs = 0;

// ---- websocket ----------------------------------------------------------
const SERVERS = ['wss://ws1.blitzortung.org/', 'wss://ws7.blitzortung.org/', 'wss://ws8.blitzortung.org/'];
let sidx = 0;
function connect() {
  const url = SERVERS[sidx % SERVERS.length]; sidx++;
  let ws, alive = false;
  try { ws = new WebSocket(url); } catch (e) { return setTimeout(connect, 3000); }
  const to = setTimeout(() => { if (!alive) { try { ws.close(); } catch (e) {} } }, 8000);
  ws.onopen = () => { alive = true; clearTimeout(to); ws.send(JSON.stringify({ a: 111 })); };
  ws.onerror = () => { if (!alive) { try { ws.close(); } catch (e) {} } };
  ws.onclose = () => setTimeout(connect, 2000);   // server cycles the socket every ~6 min
  ws.onmessage = (m) => {
    let o = null;
    try { o = JSON.parse(m.data); } catch (e) { try { o = JSON.parse(decode(m.data)); } catch (e2) { return; } }
    if (!o || typeof o.lat !== 'number' || typeof o.lon !== 'number') return;
    lastGlobalMsg = Date.now();
    const dist = haversineMi(PARK.lat, PARK.lon, o.lat, o.lon);
    if (dist > LOG_MI) return;
    const s = { dist: +dist.toFixed(1), dir: bearing(PARK.lat, PARK.lon, o.lat, o.lon), strikeMs: Math.round(o.time / 1e6) };
    nearby.push(s);
    if (dist <= RADIUS_MI) {
      totalInside++;
      if (!lastInside || s.strikeMs > lastInside.strikeMs) lastInside = s;
      warned10 = false; announcedClear = false;      // fresh strike resets the clock
      if (dist <= CLOSE_MI && Date.now() - lastCloseMs > 45000) {
        lastCloseMs = Date.now();
        alert(`DANGER-CLOSE  ${s.dist} mi ${s.dir} at ${fmt(s.strikeMs)}  ->  restart no earlier than ${fmt(s.strikeMs + HOLD_MS)}`);
      }
    }
  };
}

// ---- reporting ----------------------------------------------------------
function alert(msg) { console.log(`\n*** ${msg} ***\n`); }

function tick() {
  const now = Date.now();
  const feedAgeS = lastGlobalMsg ? Math.round((now - lastGlobalMsg) / 1000) : Infinity;
  const feedOk = feedAgeS < 90;                    // any global strike in last 90s => socket healthy
  const recent = nearby.filter((s) => s.strikeMs > now - 5 * 60000).sort((a, b) => a.dist - b.dist);

  let line;
  if (!lastInside) {
    line = `No strike within ${RADIUS_MI} mi yet.  Nearest logged: ` +
           (recent[0] ? `${recent[0].dist} mi ${recent[0].dir}` : 'none within ' + LOG_MI + ' mi');
  } else {
    const restart = lastInside.strikeMs + HOLD_MS;
    const remMin = (restart - now) / 60000;
    if (remMin <= 0) {
      line = `ALL CLEAR — ${HOLD_MIN} min since last strike inside ${RADIUS_MI} mi (${fmt(lastInside.strikeMs)}). Field may reopen.`;
      if (!announcedClear) { announcedClear = true; alert(`ALL CLEAR at ${fmt(now)} — no strike inside ${RADIUS_MI} mi since ${fmt(lastInside.strikeMs)}. Field may reopen.`); }
    } else {
      line = `FIELD DOWN — last inside-${RADIUS_MI}mi: ${lastInside.dist} mi ${lastInside.dir} at ${fmt(lastInside.strikeMs)} | ` +
             `earliest restart ${fmt(restart)} (${remMin.toFixed(1)} min) | quiet ${((now - lastInside.strikeMs) / 60000).toFixed(1)} min`;
      if (!warned10 && remMin <= 10) { warned10 = true; alert(`10-MINUTE WARNING — all-clear at ${fmt(restart)} if it stays quiet inside ${RADIUS_MI} mi.`); }
    }
  }
  const feedTag = feedOk ? 'feed OK' : `FEED SILENT ${feedAgeS === Infinity ? 'since start' : feedAgeS + 's'} — verify socket!`;
  console.log(`[${fmt(now)}] ${line}`);
  console.log(`            last 5min<=${LOG_MI}mi: ${recent.length} (inside ${RADIUS_MI}mi: ${recent.filter((s) => s.dist <= RADIUS_MI).length}) | inside-total: ${totalInside} | ${feedTag}`);
  if (recent.length) console.log('            ' + recent.slice(0, 5).map((s) => `${s.dist}${s.dir}`).join('  '));
}

// ---- boot ---------------------------------------------------------------
console.log('='.repeat(72));
console.log(`Lightning delay watch — ${PARK.name} (${PARK.lat}, ${PARK.lon})`);
console.log(`Clearing radius ${RADIUS_MI} mi | danger-close ${CLOSE_MI} mi | hold ${HOLD_MIN} min | tz ${TZ}`);
console.log('Data: Blitzortung/lightningmaps.org — DECISION SUPPORT ONLY, not for safety.');
console.log('Cross-check NWS radar (radar.weather.gov, lightning layer). Operator makes the call.');
console.log('='.repeat(72));
connect();
tick();
setInterval(tick, EVERY_MS);
