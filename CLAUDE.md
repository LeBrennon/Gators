# Gumbeaux Gators Game Tracker

Single-file Node/Express app (`server.js`) that serves a live Gators score/gamecast,
schedule, roster, and league standings for the Texas Collegiate League. The backend
and the embedded frontend (HTML/CSS/client JS) all live in `server.js`. Deployed on
Render, which auto-deploys from `main`.

## PR workflow

Open pull requests **ready for review, not as drafts** — the owner wants to say
"merge" once, without first flipping the PR out of draft. Squash-merge to `main`.

## Agent skills

### Issue tracker

Issues and PRDs are tracked as GitHub issues in `LeBrennon/Gators` via the `gh` CLI.
External PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root (created lazily by the
domain-modeling skill, not upfront). See `docs/agents/domain.md`.

### Box-score PDF

The branded one-page box-score PDF (`scripts/box-score.js`, `npm run report:box`) has a
fixed set of generation steps and formatting conventions — proper-case names, indented
substitutes with an alphabet legend, box notes, dual-position change notes, one-page fit,
etc. Follow them for every game's box score. See `docs/agents/box-score-pdf.md`.

### Player season cards

The one-page player season cards (`scripts/render-batch.py --print`) are **print only** —
mobile cards are no longer sent. Cards carry defense (`PO/PO-per-G/A/E/FLD%`) and, for
catchers, the throwing game (`Runners CS/Steals allowed/CS%`), all rebuilt from
play-by-play by `scripts/fielding.py` because the official fielding table is not in
`box-seed.json`. New stats go inside the four existing panels, never a fifth. Every gate
in that doc must be green before a card is sent to a player, and note that `box-seed.json`
holds Gators games only — read the doc before building cards for another team. See
`docs/agents/player-cards.md`.

### Roster sync

The daily roster sync keeps the `ROSTER` array in `server.js` matching Lake Charles's
active roster off the league's "TCL Updates" email. The authoritative source is the
gameday roster PDF, auto-saved to Drive by `scripts/gmail-to-drive-roster.gs` (Presto is
the fallback). See `docs/agents/roster-sync.md`.
