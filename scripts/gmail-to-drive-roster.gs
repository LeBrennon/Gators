/**
 * Gmail -> Drive auto-save for the TCL gameday roster PDF.
 *
 * WHY THIS EXISTS
 * The daily roster sync (see docs/agents/roster-sync.md) wants to read the
 * authoritative "TCL GAMEDAY ROSTER 2026.pdf" that the league emails out. The
 * roster-sync agent can read PDFs from Google Drive, but it cannot pull an
 * attachment straight out of Gmail. This Apps Script bridges that gap: it runs
 * in the owner's Google account, finds the daily TCL email, and drops the roster
 * PDF into a dedicated Drive folder so the sync can rely on the PDF instead of
 * scraping PrestoSports.
 *
 * This is NOT part of the Node app and is not deployed by Render. It lives in the
 * repo only so the automation is version-controlled and reproducible. Install it
 * once by hand (steps in docs/agents/roster-sync.md) and let a time-driven
 * trigger run it daily.
 */

// Drive folder the roster PDFs land in ("TCL Gameday Rosters", owned by the
// roster-sync Google account). Replace if the folder is ever recreated.
var FOLDER_ID = '1bv3tli9bZV66OmkEDXAoXoS3Wk1t3cJG';

// The TCL email arrives forwarded, so its Gmail "From" is the forwarding address,
// not baseball@texascollegiateleague.com. Match on the subject (which survives the
// "Fwd:" prefix) plus an attachment, over the last few days.
var GMAIL_QUERY = 'subject:"TCL Updates" filename:pdf newer_than:3d';

function saveTCLRoster() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var threads = GmailApp.search(GMAIL_QUERY, 0, 15);
  var saved = 0;

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      msg.getAttachments().forEach(function (att) {
        var name = (att.getName() || '').toLowerCase();
        var isPdf = att.getContentType() === 'application/pdf' || name.slice(-4) === '.pdf';
        // Only the gameday roster PDF — never box scores or other attachments.
        if (!isPdf || name.indexOf('roster') === -1) return;

        // Name the saved copy by the message date so re-runs are idempotent and
        // the sync can always pick the most recent one.
        var stamp = Utilities.formatDate(msg.getDate(), 'America/Chicago', 'yyyy-MM-dd');
        var outName = 'TCL GAMEDAY ROSTER ' + stamp + '.pdf';
        if (folder.getFilesByName(outName).hasNext()) return; // already saved this day

        folder.createFile(att.copyBlob()).setName(outName);
        saved++;
        console.log('Saved ' + outName);
      });
    });
  });

  console.log('Done. Saved ' + saved + ' new roster PDF(s).');
  return saved;
}

/**
 * One-time helper: create the daily time-driven trigger from code instead of the
 * UI. Safe to run more than once — it clears any existing trigger for
 * saveTCLRoster first so you never stack duplicates.
 */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'saveTCLRoster') ScriptApp.deleteTrigger(t);
  });
  // Runs once a day between 11am–noon CT, after the ~10:30am email lands.
  ScriptApp.newTrigger('saveTCLRoster')
    .timeBased()
    .atHour(11)
    .everyDays(1)
    .inTimezone('America/Chicago')
    .create();
  console.log('Installed daily saveTCLRoster trigger (11am CT).');
}
