#!/usr/bin/env node
// Best-effort: email the latest post-game deliverables to yourself the moment a
// game goes final. The FULL BOX SCORE is the primary attachment — the thing we
// want in your inbox "as soon as the last out is made" (reports/box/) — and the
// narrative post-game recap (reports/postgame/) rides along whenever it's ready.
// Used by the post-game GitHub Action; a personal delivery path, nothing to do
// with the website.
//
// No-ops (exit 0) unless Gmail creds are set, so a repo without the secret
// configured still succeeds; the PDFs are always also uploaded as workflow
// artifacts. Send failures are swallowed too — a flaky SMTP run never fails CI.
//
//   GMAIL_USER, GMAIL_APP_PASSWORD  Gmail account + App Password (not the login)
//   REPORT_TO (optional)            recipient(s), comma-separated; defaults to GMAIL_USER
//
//   node scripts/email-report.js                     # newest box score + recap
//   node scripts/email-report.js extra.pdf [more...] # also attach these files

const fs = require('fs');
const path = require('path');

const USER = process.env.GMAIL_USER || '';
const PASS = process.env.GMAIL_APP_PASSWORD || '';
if (!USER || !PASS) {
  console.log('[email-report] GMAIL_USER / GMAIL_APP_PASSWORD not set — skipping email (the PDFs are still uploaded as artifacts).');
  process.exit(0);
}

const BOX_DIR    = path.join(__dirname, '..', 'reports', 'box');
const REPORT_DIR = path.join(__dirname, '..', 'reports', 'postgame');
function newestPdf(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf')).map(f => path.join(dir, f)); } catch (e) {}
  if (!files.length) return null;
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

const box    = newestPdf(BOX_DIR);       // the full box score — primary deliverable
const report = newestPdf(REPORT_DIR);    // the narrative recap — rides along if built
const extra  = process.argv.slice(2).map(p => path.resolve(p)).filter(p => fs.existsSync(p));

// Box score leads, then the narrative recap, then any explicit extras; de-dupe by path.
const seen = new Set();
const files = [box, report, ...extra].filter(f => f && !seen.has(f) && seen.add(f));
if (!files.length) {
  console.error('[email-report] no PDFs found in reports/box or reports/postgame — nothing to send.');
  process.exit(0);
}

const to = (process.env.REPORT_TO || USER).split(',').map(s => s.trim()).filter(Boolean).join(', ');
const lead = box || report || files[0];
const stem = path.basename(lead, '.pdf');
const subject = (box ? 'Gators Full Box Score — ' : 'Gators Post-Game Report — ') + stem;
const text = [
  box ? 'Your Gumbeaux Gators full box score is attached.' : 'Your Gumbeaux Gators post-game report is attached.',
  (box && report) ? 'The narrative post-game report is attached too.' : null,
  '',
  files.map(f => '· ' + path.basename(f)).join('\n'),
  '',
].filter(x => x !== null).join('\n');

(async () => {
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: USER, pass: PASS } });
  await t.sendMail({
    from: 'Gumbeaux Gators <' + USER + '>',
    to,
    subject,
    text,
    attachments: files.map(f => ({ filename: path.basename(f), path: f })),
  });
  console.log('[email-report] sent ' + files.map(f => path.basename(f)).join(', ') + ' to ' + to);
})().catch(e => { console.error('[email-report] send failed (best-effort, ignoring):', e.message); process.exit(0); });
