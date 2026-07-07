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

// One or more explicit paths become the attachments (e.g. the two GM report
// cards); with no path, fall back to the newest post-game PDF.
const explicit = process.argv.slice(2).filter(a => !a.startsWith('--'));
let pdfs;
if (explicit.length) pdfs = explicit.map(p => path.resolve(p)).filter(p => fs.existsSync(p));
else { const one = latestPdf(); pdfs = one ? [one] : []; }
if (!pdfs.length) {
  console.error('[email-report] no file(s) to send — nothing attached.');
  process.exit(0);
}

const to = (process.env.REPORT_TO || USER).split(',').map(s => s.trim()).filter(Boolean).join(', ');
const stem = path.basename(pdfs[0], path.extname(pdfs[0]));
const names = pdfs.map(p => path.basename(p));

(async () => {
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: USER, pass: PASS } });
  // Subject/body default to the post-game report wording; a caller (e.g. the
  // GM report cards or the pitchers' rest chart) can override them via env.
  const subject = process.env.REPORT_SUBJECT || ('Gators Post-Game Report — ' + stem);
  const body = process.env.REPORT_BODY || ('Your Gumbeaux Gators post-game report is attached.\n\n(' + names.join('\n') + ')\n');
  await t.sendMail({
    from: 'Gumbeaux Gators <' + USER + '>',
    to,
    subject,
    text: body,
    attachments: pdfs.map(p => ({ filename: path.basename(p), path: p })),
  });
  console.log('[email-report] sent ' + names.join(', ') + ' to ' + to);
})().catch(e => { console.error('[email-report] send failed (best-effort, ignoring):', e.message); process.exit(0); });
