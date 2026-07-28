# HANDOFF PROMPT — Gators Player Season Cards (paste into new chat, use K3 model)

## 1. Who I am / how to work with me
- I run gameday ops for the Lake Charles Gumbeaux Gators (Texas Collegiate League, summer collegiate baseball). I own whatisthegatorscore.com.
- Keep your answers at the TOP of your replies so I don't have to scroll.
- Do NOT give me terminal commands to copy/paste. You have direct GitHub access — clone, edit, render, commit, and push yourself. Intermittent GnuTLS/TLS push errors are normal; use retry.

## 2. Repo & infrastructure (already set up)
- GitHub repo: `LeBrennon/Gators` — pushes to main auto-deploy to Render (site: gators-xicm.onrender.com, custom domain via Squarespace).
- Persistent local clone: `/mnt/agents/gators-repo` (/tmp wipes between turns — always work in the clone).
- GitHub token for pushes: `[REDACTED — ask me for it]`
- Workflow per change: edit → `node --check` → render → visually verify PNG (pdftoppm) → commit → push with retries.
- `box-seed.json` (repo root, ~2MB) = ALL stats source: 61 games with box[] (box-score HTML) and pbp[] (play-by-play HTML, titled blocks like "Team Top of 3rd").

## 3. The deliverable: 1-page player season cards

### Print version
- Template: `scripts/player-season-card.js` — hand-fed DATA block (JSON) per player + generic rendering.
- Usage: `node scripts/player-season-card.js [/tmp/stem]` → writes PDF to `reports/players/`.
- Page: 816×1056px letter, `overflow: hidden`, `padding-bottom: 28px` (safe print margin so bottom doesn't clip).
- Final PDF naming: `<Name> - 2026 Summer Stats.pdf`.
- Rendering: headless Chromium `--print-to-pdf` (NOT Paged.js — it caused artifacts).

### Mobile version
- Template: `scripts/player-season-card-mobile.js` — same DATA block as print.
- Usage: `node scripts/player-season-card-mobile.js [/tmp/stem]` → writes HTML to `reports/players-mobile/`.
- Outputs HTML only (no PNG screenshot).
- Responsive: max-width 100%, season strip wraps with `flex-wrap`, game log uses card layout (not table) so nothing requires horizontal scroll.
- On phones <380px: panels stack to 1 column, game log cards show 3 stats per row.

### Locked design system (do not change without asking me)
- Header = inset croc-texture bubble (`.band`, ~90-118px, gold border `#ecc913`, logo ~64-102px). No footer.
- Palette — Purples: `#16102b` bayou (values/totals bg), `#4e3191` dark (titles/strip/th), `#714ad2` accent (subtitles/totals legend), `#6d6391` muted, `#cfc6ea` lavender (on-dark text), `#e5e0f0` light fill. Golds: `#ffd633` (gold text on dark), `#ecc913` (structural borders).
- Croc texture: `scripts/assets/croc-band.jpg` = hue-locked duotone (do NOT autocontrast per channel — causes magenta drift).
- Season strip: tiles auto-hide GS when "0" (relievers never start). 4 stat panels × ~8 stats. Advanced Metrics Key legend above panels.
- Game log: print = 13 cols table + TOTAL row + acronym legend row (totlab — must show, appears twice by design). Mobile = card layout per game.
- Panel rows support "wide" (span full panel width) and a 4th element sub-label (tiny caption under the value).
- Stats must be triple-checked against raw sources before I send anything to a player.

## 4. Current status (as of this handoff)
- Brayden Guillory's print + mobile cards are DONE and validated (44/44 exact audit vs raw sources).
- Files live in `cards/brayden-guillory/` in the repo.
- Mobile script was just fixed to remove horizontal scroll and PNG output.
- Print script was just fixed to add 28px bottom padding for safe print margins.

## 5. Guillory's validated numbers (reference)
7 APP, 11.0 IP, 16 H, 19 R, 18 ER, 9 BB, 3 K, ERA 14.73, WHIP 2.27, FIP 8.83, #P 212, S% 52, BF 60, AB 48, 2B 2, HR 3, HBP 1, SF 1, K% 5.0, BB% 15.0, K/9 2.5, BB/9 7.4, H/9 13.1, K:BB 0.33, P/BF 3.5, P/IP 19.3, AVG .333, OBP .441, SLG .562, OPS 1.003, ISO .229, BABIP .302, FPS% 60.0, GB/FB/LD/PU 40/36/4/20.
Platoon splits: vs LHB (21 PA) .222/.333/.444 · vs RHB (39 PA) .400/.500/.633.
Note: his Presto player page is an all-dashes placeholder — ALL his stats were rebuilt from box scores + PBP.

## 6. Platoon splits pipeline (for every pitcher at season's end)
- `scripts/platoon-splits.py "<LastName>"` → JSON with vs_LHB / vs_RHB lines, coverage, unknown batters, per-game outcomes.
- `data/league-bt.json` = 308-player league handedness lookup (normalized name → bats L/R/S).
- MANDATORY validation: per-game PBP-derived H/BB/K must equal the box-score line for every game. Never put unvalidated splits on a card.

## 7. Stat formulas (validated — keep these exact)
- ERA = 27·ER/outs
- WHIP = (H+BB)·3/outs
- FIP = (13·HR + 3·(BB+HBP) − 2·K)/IP + 3.10
- BABIP = (H−HR)/(AB−K−HR+SF)
- OBP = (H+BB+HBP)/(AB+BB+HBP+SF)
- K%/BB% per BF
- ISO = SLG−AVG
- per-9 = 27·X/outs
- PBP pitch sequences: K/S/F/X/C/T/M/L = strikes; B/I/P/H/N = balls (FPS% = first-pitch strike rate).

## 8. Commit history (this project arc, oldest → newest)
0756d84 croc hue-lock → 8fa70bf font/logo/labels → 27da701 Savant v2 → 24624c4 legend move → 7a1a6a2 Advanced Key → 275a43e SwStr% removed → eb50917 GS-hide → fb86254 → 14ca01f legend restore → 0908c62/7a55d05 key wrap fixes → f8de078 purple consolidation → 88b31cd gold matching → 06c644a page-fill → a3be133 bubble header, footer removed → 45cced9 platoon splits block + pipeline → 6f72ea4 splits folded into HITTERS panel as wide rows → 6922b7a AVG/OBP/SLG sub-labels under split values → eb2db88 Add mobile player season card renderer → (current HEAD) print bottom cushion + mobile no-PNG.

## 9. What we've learned about my preferences (respect these)
- Purples must be hue-consistent (limited palette above); golds must match exactly.
- Game log font stays dark (#16102b), never red. Legend appears twice (Key above panels + totlab under totals) — that's intentional.
- No separate full-width stat blocks — new data goes INSIDE the 4 existing panels (use "wide" rows).
- Stats must be triple-checked against raw sources before I send anything to a player.
- I print these — keep everything inside safe margins (bubble design, no edge-to-edge).
- Mobile: NO horizontal scrolling. Everything must fit within phone width.

## 9b. SEASON-END BATCH (started Jul 28)
- `scripts/player-season-data.py "Last" --batter|--pitcher [--mobile]` → card DATA JSON. Validated: ALL 15 batters + ALL 15 pitchers, 0 mismatches (per-game H/BB/K vs box).
- `scripts/render-batch.py "Name:b"|"Name:p"|"Name:both" ...` → renders print PDF + mobile HTML (two-way players get double report cards with "(Hitting)"/"(Pitching)" filename suffixes).
- `data/batch-roster.json` = 51-player roster w/ merged bios. `data/league-bt.json` refreshed w/ roster-PDF bats (617 players). `data/league-throws.json` (306).
- PBP quirks handled: ", SAC" bunts (incl. reached-on-error), "was intentionally walked", SF double-count guard (SF events increment PA; never add again), glued swap names (split ". "), pinch-hitters "X to p for <pitcher>" are NOT pitching changes (filter vs GATOR_KEYS), switch hitters bat opposite pitcher hand, fuzzy name lookup (difflib .88) for PBP/roster spelling variants, photo slug = glob photos/{name}*.* first (manifest is stale).
- DONE-FOR-SUMMER RUN COMPLETE: 23 players / 28 cards (9 batters, 9 pitchers, 5 double) + Guillory + Sunday re-rendered. NOTE: Guillory's ORIGINAL locked card had K 8 / BB 15 / L 1 — box truth is K 3 / BB 9 / no decision; new card is box-validated.
- Remaining: playoff-active players (28-man current roster in batch-roster.json entries with `num`) after season ends + box-seed refresh.

## 10. Next steps (in order)
1. ~~**Batter card variant**~~ DONE (Jul 28): `scripts/player-season-card-batter.js` (print) + `scripts/player-season-card-mobile-batter.js` (mobile), both validated on Ayden Sunday (#17 OF, Lamar). Panels: PRODUCTION / PLATE DISCIPLINE / HIT BREAKDOWN / BASE RUNNING & TCL RANKS. Print auto-switches to a 2-column compact game log when log > 20 rows (41 games fits one page). Stats triple-validated: box scores + PBP classifier (40/40 dates exact) + roster-seed.json official TCL line. PBP classifier notes: "flied out …, sacrifice fly" = SF not AB (check tail); "out at first" = AB unless tail has picked off/caught stealing; "out on batter's interference" = AB; TCL official CS excludes pickoffs. Batter splits (vs LHP/RHP) DONE (Jul 28): scripts/batter-splits.py + data/league-throws.json (95 pitchers, deep-researched from college bios/team sites/PG/PBR — Cloudflare blocks Presto profile scraping from agents, so hands were researched one-by-one; scripts/fetch-throws.py exists if a user-run Presto scrape is ever possible). Unknown-hand PAs are EXCLUDED from splits, never guessed. Sunday FINAL (all 185 PA sourced): vs LHP 52 PA .289/.385/.333 (.718 OPS), vs RHP 133 PA .284/.459/.537 (.995 OPS). 40/40 validated. Throws cross-check: roster PDFs confirmed 48/50 researched hands (2 corrected to PDF: will robinson R, landon brewer L — PDF wins when they disagree).
2. **Refresh league-bt.json** from TCL Presto team pages before the season-end run.
3. **Season-end batch run**: for each pitcher — platoon-splits.py, validate per-game H/BB/K vs box, fill DATA, render, deliver. For each batter — batter template once built.
4. **Optional**: batch script that loops a roster list and emits all cards.

## 9c. Auto-fit print layout (no blank bottoms)

Both print templates now self-fit the letter page at render time:
- `.page` is a flex column with `justify-content: space-between` (+ `.page > * { flex-shrink: 0 }`), so leftover space distributes between sections instead of pooling at the bottom.
- `buildHtml(sp)` builds the page at a given `spread` factor (0 = locked layout, 1 = fully loosened); the script measures real content height in headless Chromium (dump-dom + `.page{height:auto}` override, title = scrollHeight) and **binary-searches the spread** that lands content at 1010px (1056 - 46px footer padding). Nonlinear growth (row/panel wraps) made interpolation unreliable — don't go back to it.
- Batter template: if natural height already exceeds the target, it auto-falls-back to the `compact` two-column log even at <=20 games.
- Landmines fixed: `.spread .grid` must use `row-gap` only (a column gap wraps 50%-wide panels into a stacked single column and clips the page); `.panel` needs `min-width: 0` (long slash lines like `.000/1.000/.000` push min-content past 50% and wrap the grid).
- render-batch.py: two-way rename skips already-labeled files (`if '(' in f: continue`) so the second role no longer double-suffixes the first role's card.
