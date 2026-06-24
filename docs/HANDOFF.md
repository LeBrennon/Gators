# Session Handoff — Gumbeaux Gators Game Tracker

**Repo:** `LeBrennon/Gators` · **Deploy:** Render auto-deploys from `main` · **Live:** https://whatisthegatorscore.com
Single-file app (`server.js`, backend + embedded frontend) · `npm test`

---

## Shipped (merged to `main`, deployed)

| PR  | Change |
|-----|--------|
| #1  | Live hero resilience (show line score/PBP/lineup even if at-bat situation missing) + **build stamp** (`/api/version`, `/health`, footer) |
| #2  | Extract live-feed **event id** from the new 2026 page format |
| #3  | **Base64 hash fix** — the root cause the in-game view went dark (hash with `/` was dropped; now allows `+ / =` and URL-encodes) |
| #4  | 🎆 Fireworks animation when the Gators score (live games) |
| #5  | Clickable Gators **lineup names** → player profiles |
| #6  | Live **pitching box** (IP/H/R/ER/BB/K/P) |
| #7  | "This Half" play-by-play **clears when the side flips** |
| #8  | Jersey **#s** in the pitching box |
| #9  | **S%** column in the pitching box |
| #10 | Removed the "stats updated" status from the Roster tab |
| #11 | 📋 Shareable per-game **GM report** page (`/report?id=`) |
| #12 | 🔒 Made reports **private** (`REPORT_KEY` gate, removed public button, `/reports` index) |
| #13 | 📧 **Auto-email** a report after each final (Gmail) |
| #14 | On-demand **`/report/send`** (email a report now) |
| #15 | 📊 Daily **unique-visitor analytics** (`/stats` page + midnight email digest) |

---

## ⚠️ REQUIRED setup (owner action in Render → Environment)

Reports, emails, and the stats digest stay dark until these are set. One pass unlocks all of it:

- **`REPORT_KEY`** — any long random string. Gates `/report`, `/reports`, `/report/send`, `/stats`. Until set, reports are locked (private by default).
- **`GMAIL_USER`** — sending Gmail address.
- **`GMAIL_APP_PASSWORD`** — a Google **App Password** (not the normal account password). Generate at https://myaccount.google.com/apppasswords (requires 2-Step Verification enabled).

Optional: `REPORT_TO` (default `brennonmbaseball@gmail.com`), `STATS_TO` (default `brennonmoore11@gmail.com`), `SITE_URL` (defaults to `https://whatisthegatorscore.com`), `STATS_SALT`.

**Key URLs (after `REPORT_KEY` set):**
- Reports index: `/reports?key=KEY`
- One game: `/report?id=GAMEID&key=KEY`
- Send now: `/report/send?key=KEY` (`&to=`, `&id=` optional)
- Visitor stats: `/stats?key=KEY`

---

## Open / unverified items

1. **`3-0` stale count bug** — live at-bat sometimes shows the wrong count. Not yet diagnosed; needs a `/debug/live` paste (the `live` object + `raw.status`) from a fresh at-bat to tell whether the feed is stale or we read the wrong field.
2. **Verify on a real live game** — the dev sandbox is egress-blocked from the upstream feed, so the following were built defensively and need confirmation against a live game: pitching **S%** populating (not `·`), pitching **H/R** correct, and report **Key Plays/Mistakes** categorization. `/debug/live` (raw feed) is the diagnostic for all.
3. ~~3 pre-existing `boxscore` test failures~~ — **fixed.** They were stale assertions left over from the "group tables by team" box-score rewrite (`eb5d1cf`): pitching now immediately follows its team's batting, `SO` renders as `K`, and a pitching section is only emitted when paired with its team's batting table. Tests updated to match; `npm test` is green (118/118). No parser changes.
4. **App icon** = Lake Charles badge — intentional owner revert (`0901d64`), not a bug.

---

## Notes for the next session/dev

- **Diagnostics:** `/debug/live?id=`, `/debug/scan?id=` expose the raw feed — invaluable since the league's feed format shifts.
- **Sandbox caveat:** the dev environment is network-blocked from `prestosports.com` and `whatisthegatorscore.com`, so live-feed behavior can't be verified locally — only via the deployed app's `/debug/*`.
- **Workflow:** branch off `main` → PR → squash-merge (Render deploys on merge). No CI configured. Verify each deploy via `/api/version`.
