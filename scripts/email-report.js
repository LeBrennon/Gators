#!/usr/bin/env node
// Best-effort: email the most recent post-game report PDF to yourself. Used by
// the post-game GitHub Action so a finished game lands in your inbox. This is a
// personal delivery path — nothing to do with the website.
//
// No-ops (exit 0) unless Gmail creds are set, so a repo without the secret
// configured still succeeds; the report is always also uploaded as a workflow
// artifact. Send failures are swallowed too — a flaky SMTP run never fails CI.
//
//   GMAIL_USER, GMAIL_APP_PASSWORD  Gmail account + App Password (not the login)
//   REPORT_TO (optional)            recipient(s), comma-separated; defaults to GMAIL_USER
//
//   node scripts/email-report.js [path/to/report.pdf]   # defaults to the newest PDF

const fs = require('fs');
const path = require('path');

const USER = process.env.GMAIL_USER || '';
const PASS = process.env.GMAIL_APP_PASSWORD || '';
if (!USER || !PASS) {
  console.log('[email-report] GMAIL_USER / GMAIL_APP_PASSWORD not set — skipping email (the report is still uploaded as an artifact).');
  process.exit(0);
}

const DIR = path.join(__dirname, '..', 'reports', 'postgame');
function latestPdf(explicit) {
  if (explicit) return path.resolve(explicit);
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.pdf')).map(f => path.join(DIR, f)); } catch (e) {}
  if (!files.length) return null;
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

const pdf = latestPdf(process.argv[2]);
if (!pdf || !fs.existsSync(pdf)) {
  console.error('[email-report] no PDF found in reports/postgame/ — nothing to send.');
  process.exit(0);
}

const to = (process.env.REPORT_TO || USER).split(',').map(s => s.trim()).filter(Boolean).join(', ');
const stem = path.basename(pdf, '.pdf');

(async () => {
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: USER, pass: PASS } });
  await t.sendMail({
    from: 'Gumbeaux Gators <' + USER + '>',
    to,
    subject: 'Gators Post-Game Report — ' + stem,
    text: 'Your Gumbeaux Gators post-game report is attached.\n\n(' + path.basename(pdf) + ')\n',
    attachments: [{ filename: path.basename(pdf), path: pdf }],
  });
  console.log('[email-report] sent ' + path.basename(pdf) + ' to ' + to);
})().catch(e => { console.error('[email-report] send failed (best-effort, ignoring):', e.message); process.exit(0); });
