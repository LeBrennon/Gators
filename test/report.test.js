'use strict';
// Tests for the shareable per-game GM report: line-score parsing, play bucketing
// (scoring / key plays / mistakes), and the assembled report page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseBoxscore, buildReportHtml, repPlays, repLineRows } = require('../server');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'boxscore.html'), 'utf8');

test('repLineRows: pulls team name and R/H/E (last three cells)', () => {
  const p = parseBoxscore(FIXTURE);
  const rows = repLineRows(p.line);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: 'Acadiana Cane Cutters', r: '3', h: '7', e: '1' });
  assert.deepEqual(rows[1], { name: 'Lake Charles Gumbeaux Gators', r: '5', h: '9', e: '0' });
});

test('repPlays: buckets scoring plays from the play-by-play', () => {
  const pbp = [
    { title: 'Bottom of 1st Inning - Lake Charles Gumbeaux Gators batting',
      html: '<table><tr><td>Smith homered to left field, 2 RBI. 0 out</td></tr>'
          + '<tr><td>Jones grounded out to ss. 1 out</td></tr></table>' },
    { title: 'Top of 2nd Inning - Acadiana Cane Cutters batting',
      html: '<table><tr><td>Doe singled to center; Roe scored. 1 out</td></tr>'
          + '<tr><td>Wild pitch by pitcher. 1 out</td></tr></table>' },
  ];
  const r = repPlays(pbp);
  assert.equal(r.scoring.length, 2);                 // homer + "scored"
  assert.equal(r.key.length, 1);                     // Gators homer (offense)
  assert.match(r.key[0].tx, /homered/);
  assert.equal(r.mist.length, 1);                    // wild pitch on Gators defense
  assert.match(r.mist[0].tx, /Wild pitch/);
});

test('buildReportHtml: assembles all sections and the win result', () => {
  const p = parseBoxscore(FIXTURE);
  const html = buildReportHtml({ id: '20260623_mrd6', teams: p.teams, line: p.line, box: p.box, pbp: p.pbp });
  for (const sec of ['Gators Game Report', 'Pitching', 'Batting', 'Scoring Plays', 'Gators Key Plays', 'Gators Mistakes']) {
    assert.ok(html.includes(sec), 'missing section: ' + sec);
  }
  assert.match(html, /rres w/);                       // Gators won 5-3
  assert.ok(!/class="bxp"/.test(html));               // profile links flattened
});
