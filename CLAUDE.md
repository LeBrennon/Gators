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
