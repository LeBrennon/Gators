#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'data', 'big-leagues-players.json');
const STATE_PATH = path.join(ROOT, 'data', 'big-leagues-state.json');
const PROFILE_DIR = path.join(ROOT, 'data', 'big-leagues-profiles');
const SEASON = Number(process.env.BIG_LEAGUES_SEASON || new Date().getFullYear());
const LOOKBACK_DAYS = Number(process.env.BIG_LEAGUES_LOOKBACK_DAYS || 2);
const FORCE = process.argv.includes('--force');

const MLB_API = 'https://statsapi.mlb.com/api';
const SAVANT_CSV = 'https://baseballsavant.mlb.com/statcast_search/csv';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dateDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Big-Leagues-Tracker/1.0',
      accept: options.accept || '*/*'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url, { accept: 'application/json' }));
}

function isFinal(game) {
  const status = game?.status || {};
  return status.abstractGameState === 'Final' || /final|game over/i.test(status.detailedState || '');
}

async function resolvePlayer(player) {
  const url = `${MLB_API}/v1/people/${player.mlbamId}?hydrate=currentTeam`;
  const data = await fetchJson(url);
  const person = data.people?.[0] || {};
  return {
    ...player,
    fullName: person.fullName || player.name,
    currentTeam: person.currentTeam?.name || player.currentTeam || null,
    currentTeamId: person.currentTeam?.id || player.currentTeamId || null,
    primaryPosition: person.primaryPosition || null,
    batSide: person.batSide || null,
    pitchHand: person.pitchHand || null,
    active: person.active,
    rosterStatus: person.rosterStatus || null
  };
}

async function getRecentFinalGames(teamId) {
  if (!teamId) return [];
  const start = isoDate(dateDaysAgo(LOOKBACK_DAYS));
  const end = isoDate(new Date());
  const url = `${MLB_API}/v1/schedule?teamId=${teamId}&startDate=${start}&endDate=${end}&hydrate=team`;
  const data = await fetchJson(url);
  const games = (data.dates || []).flatMap(d => d.games || []);
  return games.filter(isFinal).sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));
}

function playerBoxEntry(feed, playerId) {
  const key = `ID${playerId}`;
  const home = feed?.liveData?.boxscore?.teams?.home?.players?.[key];
  const away = feed?.liveData?.boxscore?.teams?.away?.players?.[key];
  return home || away || null;
}

function pitchingAppearance(entry) {
  if (!entry) return false;
  const p = entry.stats?.pitching;
  if (!p) return false;
  return Number(p.pitchesThrown || 0) > 0 || Number(p.battersFaced || 0) > 0 || String(p.inningsPitched || '0.0') !== '0.0';
}

function normalizeGameLine(game, feed, entry) {
  const p = entry.stats.pitching || {};
  const home = feed.gameData?.teams?.home?.name;
  const away = feed.gameData?.teams?.away?.name;
  const teamId = entry?.parentTeamId || null;
  const isHome = feed.gameData?.teams?.home?.id === teamId;
  return {
    gamePk: game.gamePk,
    gameDate: feed.gameData?.datetime?.officialDate || String(game.gameDate || '').slice(0, 10),
    matchup: `${away || 'Away'} @ ${home || 'Home'}`,
    inningsPitched: p.inningsPitched ?? null,
    hits: p.hits ?? null,
    runs: p.runs ?? null,
    earnedRuns: p.earnedRuns ?? null,
    homeRuns: p.homeRuns ?? null,
    baseOnBalls: p.baseOnBalls ?? null,
    strikeOuts: p.strikeOuts ?? null,
    pitchesThrown: p.pitchesThrown ?? null,
    strikes: p.strikes ?? null,
    battersFaced: p.battersFaced ?? null,
    outs: p.outs ?? null,
    era: p.era ?? null,
    whip: p.whip ?? null,
    note: entry.gameStatus?.isCurrentPitcher ? 'current pitcher' : null,
    homeAway: isHome ? 'home' : 'away'
  };
}

async function getStats(playerId, statsType) {
  const url = `${MLB_API}/v1/people/${playerId}/stats?stats=${encodeURIComponent(statsType)}&group=pitching&season=${SEASON}`;
  const data = await fetchJson(url);
  return data.stats || [];
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (rows.length < 2) return [];
  const header = rows[0];
  return rows.slice(1).filter(r => r.some(Boolean)).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function avg(values) {
  const clean = values.filter(v => Number.isFinite(v));
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function round(value, places = 1) {
  if (!Number.isFinite(value)) return null;
  const p = 10 ** places;
  return Math.round(value * p) / p;
}

function isSwing(description = '') {
  return /swinging_strike|foul|hit_into_play|foul_tip/i.test(description);
}

function isWhiff(description = '') {
  return /swinging_strike|swinging_pitchout|foul_tip/i.test(description);
}

function isZone(zone) {
  const z = Number(zone);
  return z >= 1 && z <= 9;
}

function aggregateSavant(rows) {
  if (!rows.length) return { available: false, pitchCount: 0 };
  const pitches = rows.filter(r => r.pitch_type);
  const bbe = rows.filter(r => num(r.launch_speed) !== null);
  const swings = pitches.filter(r => isSwing(r.description));
  const whiffs = pitches.filter(r => isWhiff(r.description));
  const chases = pitches.filter(r => !isZone(r.zone) && isSwing(r.description));
  const outZone = pitches.filter(r => !isZone(r.zone));
  const hardHit = bbe.filter(r => num(r.launch_speed) >= 95);
  const barrels = bbe.filter(r => Number(r.launch_speed_angle) === 6);

  const byPitch = new Map();
  for (const r of pitches) {
    const type = r.pitch_type || 'UNK';
    if (!byPitch.has(type)) byPitch.set(type, []);
    byPitch.get(type).push(r);
  }
  const arsenal = [...byPitch.entries()].map(([pitchType, list]) => ({
    pitchType,
    count: list.length,
    usagePct: round(100 * list.length / pitches.length, 1),
    avgVelocity: round(avg(list.map(r => num(r.release_speed))), 1),
    maxVelocity: round(Math.max(...list.map(r => num(r.release_speed)).filter(Number.isFinite)), 1),
    avgSpin: round(avg(list.map(r => num(r.release_spin_rate))), 0),
    horizontalBreakInches: round(avg(list.map(r => num(r.pfx_x))) * 12, 1),
    verticalBreakInches: round(avg(list.map(r => num(r.pfx_z))) * 12, 1),
    extensionFeet: round(avg(list.map(r => num(r.release_extension))), 1),
    whiffPct: round(100 * list.filter(r => isWhiff(r.description)).length / Math.max(1, list.filter(r => isSwing(r.description)).length), 1),
    zonePct: round(100 * list.filter(r => isZone(r.zone)).length / list.length, 1)
  })).sort((a, b) => b.count - a.count);

  return {
    available: true,
    source: 'Baseball Savant Statcast Search CSV',
    season: SEASON,
    pitchCount: pitches.length,
    arsenal,
    velocity: {
      average: round(avg(pitches.map(r => num(r.release_speed))), 1),
      max: pitches.length ? round(Math.max(...pitches.map(r => num(r.release_speed)).filter(Number.isFinite)), 1) : null
    },
    pitchCharacteristics: {
      averageSpin: round(avg(pitches.map(r => num(r.release_spin_rate))), 0),
      averageExtension: round(avg(pitches.map(r => num(r.release_extension))), 1),
      zonePct: round(100 * pitches.filter(r => isZone(r.zone)).length / Math.max(1, pitches.length), 1),
      whiffPct: round(100 * whiffs.length / Math.max(1, swings.length), 1),
      chasePct: round(100 * chases.length / Math.max(1, outZone.length), 1)
    },
    contactAllowed: {
      battedBalls: bbe.length,
      avgExitVelocity: round(avg(bbe.map(r => num(r.launch_speed))), 1),
      maxExitVelocity: bbe.length ? round(Math.max(...bbe.map(r => num(r.launch_speed)).filter(Number.isFinite)), 1) : null,
      avgLaunchAngle: round(avg(bbe.map(r => num(r.launch_angle))), 1),
      hardHitPct: round(100 * hardHit.length / Math.max(1, bbe.length), 1),
      barrelPct: round(100 * barrels.length / Math.max(1, bbe.length), 1),
      expectedBA: round(avg(bbe.map(r => num(r.estimated_ba_using_speedangle))), 3),
      expectedWOBA: round(avg(bbe.map(r => num(r.estimated_woba_using_speedangle))), 3)
    }
  };
}

async function getSavant(playerId) {
  const params = new URLSearchParams();
  params.set('all', 'true');
  params.set('type', 'pitcher');
  params.set('player_type', 'pitcher');
  params.set('hfSeaYear', `${SEASON}|`);
  params.set('hfGT', 'R|');
  params.append('player_lookup[]', String(playerId));
  try {
    const text = await fetchText(`${SAVANT_CSV}?${params.toString()}`, { accept: 'text/csv' });
    return aggregateSavant(parseCsv(text));
  } catch (error) {
    return { available: false, pitchCount: 0, error: String(error.message || error) };
  }
}

async function buildProfile(player, previousProfile, gameLines) {
  const [seasonStats, gameLog, savant] = await Promise.all([
    getStats(player.mlbamId, 'season'),
    getStats(player.mlbamId, 'gameLog'),
    getSavant(player.mlbamId)
  ]);

  return {
    schemaVersion: 1,
    player: {
      mlbamId: player.mlbamId,
      name: player.fullName,
      role: player.role,
      organization: player.organization,
      currentTeam: player.currentTeam,
      currentTeamId: player.currentTeamId,
      currentLevel: player.currentLevel,
      active: player.active,
      rosterStatus: player.rosterStatus,
      primaryPosition: player.primaryPosition,
      batSide: player.batSide,
      pitchHand: player.pitchHand
    },
    season: SEASON,
    updatedAt: new Date().toISOString(),
    lastAppearance: gameLines.at(-1) || previousProfile?.lastAppearance || null,
    recentProcessedAppearances: [
      ...(previousProfile?.recentProcessedAppearances || []),
      ...gameLines
    ].slice(-30),
    statsApi: {
      season: seasonStats,
      gameLog
    },
    statcast: savant
  };
}

async function processPlayer(player, state) {
  const resolved = await resolvePlayer(player);
  const prior = state.players[String(player.mlbamId)] || {};
  const profilePath = path.join(PROFILE_DIR, `${player.mlbamId}.json`);
  const previousProfile = readJson(profilePath, null);
  const games = await getRecentFinalGames(resolved.currentTeamId);
  const unprocessed = games.filter(g => FORCE || !prior.processedGamePks?.includes(g.gamePk));
  const appearanceLines = [];
  const processedGamePks = new Set(prior.processedGamePks || []);

  for (const game of unprocessed) {
    const feed = await fetchJson(`${MLB_API}/v1.1/game/${game.gamePk}/feed/live`);
    const entry = playerBoxEntry(feed, player.mlbamId);
    if (pitchingAppearance(entry)) appearanceLines.push(normalizeGameLine(game, feed, entry));
    processedGamePks.add(game.gamePk);
  }

  const teamChanged = prior.currentTeamId && resolved.currentTeamId && prior.currentTeamId !== resolved.currentTeamId;
  const shouldRefresh = FORCE || appearanceLines.length > 0 || teamChanged || !previousProfile;

  if (shouldRefresh) {
    const profile = await buildProfile(resolved, previousProfile, appearanceLines);
    writeJson(profilePath, profile);
    console.log(`[Big Leagues] refreshed ${resolved.fullName}: ${appearanceLines.length} new appearance(s)`);
  } else {
    console.log(`[Big Leagues] no refresh needed for ${resolved.fullName}`);
  }

  state.players[String(player.mlbamId)] = {
    currentTeamId: resolved.currentTeamId,
    currentTeam: resolved.currentTeam,
    checkedAt: new Date().toISOString(),
    processedGamePks: [...processedGamePks].slice(-100),
    lastAppearanceGamePk: appearanceLines.at(-1)?.gamePk || prior.lastAppearanceGamePk || null,
    lastAppearanceAt: appearanceLines.at(-1)?.gameDate || prior.lastAppearanceAt || null
  };
}

async function main() {
  const registry = readJson(REGISTRY_PATH, { players: [] });
  const state = readJson(STATE_PATH, { schemaVersion: 1, players: {} });
  if (!state.players) state.players = {};
  const players = (registry.players || []).filter(p => p.enabled !== false);
  if (!players.length) throw new Error('No enabled players in data/big-leagues-players.json');

  for (const player of players) {
    try { await processPlayer(player, state); }
    catch (error) {
      console.error(`[Big Leagues] ${player.name}: ${error.stack || error.message || error}`);
      state.players[String(player.mlbamId)] = {
        ...(state.players[String(player.mlbamId)] || {}),
        checkedAt: new Date().toISOString(),
        lastError: String(error.message || error)
      };
    }
  }
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_PATH, state);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
