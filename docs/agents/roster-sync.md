# Roster sync (daily, from the TCL email)

Keeps the `ROSTER` array in `server.js` matching Lake Charles's real active roster.
Runs once a day off the league's "TCL Updates" email. The authoritative source is
the **gameday roster PDF** the league attaches to that email; PrestoSports is a
fallback when the PDF isn't available.

## Source of truth: the gameday PDF (via Drive)

The Gmail tools available to the sync can read message text but **cannot download
an attachment's bytes**. To get around that, a small Google Apps Script
(`scripts/gmail-to-drive-roster.gs`) runs in the owner's Google account and copies
the daily `TCL GAMEDAY ROSTER 2026.pdf` into a Drive folder the sync can read:

- **Folder:** `TCL Gameday Rosters`  (ID `1bv3tli9bZV66OmkEDXAoXoS3Wk1t3cJG`)
- **Saved filename pattern:** `TCL GAMEDAY ROSTER <YYYY-MM-DD>.pdf` (message date, CT)

So the sync reads the PDF from Drive instead of scraping PrestoSports. See
[one-time setup](#one-time-setup-apps-script) below for how the Apps Script is
installed.

## Daily steps

1. **Find the email.** Gmail search `subject:"TCL Updates" newer_than:2d` (the mail
   arrives forwarded, so the original `baseball@texascollegiateleague.com` sender is
   only in the body, not the Gmail `From:`). Take the most recent message and read
   its full body. No email → make no changes and stop ("No TCL email to sync today").

2. **Read the gameday roster PDF from Drive.** Search the folder above for the newest
   `TCL GAMEDAY ROSTER *.pdf` (`title contains 'TCL GAMEDAY ROSTER' and mimeType =
   'application/pdf'`, newest by `createdTime`) and read it with
   `read_file_content`. Pull the Lake Charles (**LCH**) block: each player's jersey
   number, name, and position. This is the roster's ground truth — membership,
   numbers, and positions.
   - If the folder has no PDF from the last ~2 days (Apps Script hasn't run, or the
     email had no attachment), fall back to the **PrestoSports active roster**:
     `…/sports/bsb/2026/teams/lakecharlesgumbeauxgators`, using only rows whose
     Status is **Active**. Note in the report that the PDF was unavailable.

3. **Cross-check the TRANSACTIONS section** of the email as a sanity signal. It lists
   `Activated:` / `Deactivated:` as `Player Name (TEAM)`; only `(LCH)` lines are ours.
   The PDF is authoritative for the final roster, but the transactions explain *why*
   a player was added or dropped and should agree with the PDF diff.

4. **Reconcile against `ROSTER` in `server.js`.** Match players by name.
   - Player on the PDF/active roster but **not** in `ROSTER` → add an entry:
     ```js
     { num: <jersey or null>, numTBD: true, name: 'Full Name', slug: '<lowercasenamenospaces>',
       pos: 'Utility', cls: '', ht: '', wt: '', b: '', t: '', bday: '', home: '',
       school: '', findSlug: true,
       note: 'Recently added — season stats will appear after his first game.' }
     ```
     `findSlug: true` lets the server resolve his real Presto slug/stats. Fill in
     `num`/`pos` from the PDF when present; never block on bio details.
   - Player in `ROSTER` but **not** on the PDF/active roster → remove that entry.
   - Player on both → leave unchanged (don't churn curated bios/slugs).

5. **Sanity check before pushing.** `node --check server.js` must pass. Count LCH
   entries — expect ~25–32. **Stop and report instead of pushing** if a single run
   would remove more than 5 players, drop below ~20, or empty the roster; that
   usually means a bad PDF parse, not a real mass cut.

6. **Commit & deploy.** If `ROSTER` changed: commit (e.g. `Sync roster from TCL email
   <M.D> (activated: …; deactivated: …)`) and push. Direct to `main` if allowed,
   else a `claude/roster-sync-<MM-DD>` branch with a ready-for-review PR. No change →
   stop and report "Roster already in sync."

Only ever touch the `ROSTER` array. Preserve existing style/alignment; never remove
coaches or unrelated code.

## One-time setup (Apps Script)

Done once in the owner's Google account; after that the PDF shows up in Drive daily
with no action.

1. Go to <https://script.google.com> → **New project**.
2. Paste the contents of `scripts/gmail-to-drive-roster.gs`. Save.
3. Run `saveTCLRoster` once and approve the Gmail + Drive permission prompts.
4. Run `installDailyTrigger` once (creates the daily 11am-CT trigger), or add the
   trigger by hand: **Triggers → Add Trigger → `saveTCLRoster`, Time-driven, Day
   timer, 11am–noon**.

To verify: after a "TCL Updates" email with the roster attachment arrives, the folder
should hold a `TCL GAMEDAY ROSTER <date>.pdf`. Re-running is safe — the script skips
a date it has already saved.
