#!/usr/bin/env python3
"""
runvalues.py — league run expectancy and wOBA weights, built from this league's
own play-by-play. Nothing is imported from MLB.

  python3 scripts/runvalues.py            # gates + the derived weights
  python3 scripts/runvalues.py --json     # weights only, for other scripts

Why build them rather than borrow: wOBA weights are run values, and run values
are a property of the run environment they were measured in. A summer wood-bat
college league does not score like the majors, so MLB weights would make the
number look precise while being wrong. The inputs needed — base-out state before
each plate appearance and runs scored from there to the end of the inning — are
all recoverable from the play-by-play we already store.

Method (the standard one):
  1. Walk every half-inning, tracking runners and outs, and record each plate
     appearance's base-out state plus the runs that scored from that state to
     the end of the inning.
  2. RE24 = mean runs-to-end-of-inning for each of the 24 base-out states.
  3. Run value of an event = mean of (RE after - RE before + runs on the play).
  4. Shift so a batting out is worth zero, then scale so the resulting wOBA has
     the same mean as league OBP — the usual normalisation.

THE GATE: runs reconstructed for a half-inning must equal that inning's runs in
the official line score. Weights are only emitted from half-innings that pass;
the rest are reported and discarded, never patched.
"""
import json, re, sys, collections, importlib.util, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
_s = importlib.util.spec_from_file_location('psd', os.path.join(ROOT, 'scripts', 'player-season-data.py'))
psd = importlib.util.module_from_spec(_s)
_a, sys.argv = sys.argv, ['psd']
try: _s.loader.exec_module(psd)
except SystemExit: pass
sys.argv = _a

SCORED = re.compile(r'\bscored\b')
# Batting events that end a plate appearance, in the order they must be tested.
EVENTS = [
    ('HR', r'homered'), ('3B', r'tripled'), ('2B', r'doubled'), ('1B', r'singled'),
    ('HBP', r'hit by pitch'), ('BB', r'walked'),
    ('SF', r'sacrifice fly'), ('SH', r'sacrifice bunt'),
    ('K', r'struck out'),
    ('OUT', r'grounded out|flied out|lined out|popped up|popped out|fouled out|'
            r'grounded into|lined into|flied into|reached on|out at first'),
]
BASE_AFTER = {'1B': 1, '2B': 2, '3B': 3}


def half_innings(g, team):
    """Yield (inning_number, text) for the half-innings this club batted in."""
    for blk in g['pbp']:
        if team not in blk['title']: continue
        m = re.search(r'(\d+)(?:st|nd|rd|th)\s+Inning', blk['title'])
        p = psd.Text(); p.feed(blk['html'])
        txt = re.sub(r'\s+', ' ', ' '.join(p.t))
        yield (int(m.group(1)) if m else 0), psd.HDR_RE.sub(' ', txt)


def line_runs(g, team):
    """Runs per inning for a club, from the official line score."""
    if not g.get('line'): return None
    p = psd.Table(); p.feed(g['line'])
    short = team.split()[-1]
    for r in p.rows:
        if short in r[0]:
            cells = r[1:]
            out = []
            for c in cells[:-3]:                       # trailing R H E
                c = c.strip()
                if c in ('X', 'x', ''): out.append(0)
                elif c.isdigit(): out.append(int(c))
                else: return None
            return out
    return None


BASE_WORD = {'first': 1, 'second': 2, 'third': 3}
NAME_RE = r"[A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+)+"
LOB_RE = re.compile(r'Inning Summary:.*?(\d+)\s+LOB')


def walk(txt):
    """Replay one half-inning, following every named runner.

    Presto states each runner's move explicitly ("Kason Atkins advanced to
    second", "Tiger Donnato scored", "Matt Scott out at third"), so the bases can
    be tracked by name rather than guessed. That matters because run expectancy
    is keyed on the base-out state a hitter walked into — if the state is wrong
    the plate appearance lands in the wrong bucket, and the runs gate alone would
    never notice.

    Returns the plate appearances, the runs scored, and the runners left on base
    so both can be checked against the official record.
    """
    plays, bases, outs, runs = [], {1: None, 2: None, 3: None}, 0, 0
    for chunk in re.split(r'(?<=\.)\s+', txt):
        if not chunk.strip() or 'Inning Summary' in chunk: continue
        head = chunk.split(';')[0]
        ev = None
        for name, pat in EVENTS:
            if re.search(pat, head): ev = name; break
        bm = re.match(r'\s*(' + NAME_RE + r')', chunk)
        batter = bm.group(1) if bm else None
        before = (tuple(bool(bases[b]) for b in (1, 2, 3)), outs)
        scored = 0

        # Runners first: every clause that names someone already on base.
        for clause in chunk.split(';'):
            for m in re.finditer(r'(' + NAME_RE + r')\s+(scored|advanced to (first|second|third)|out at (first|second|third|home))', clause):
                who, what = m.group(1), m.group(2)
                at = next((b for b in (1, 2, 3) if bases[b] == who), None)
                if what == 'scored':
                    if at: bases[at] = None; scored += 1
                    elif who != batter: scored += 1
                elif what.startswith('advanced'):
                    dest = BASE_WORD[m.group(3)]
                    if at: bases[at] = None
                    if at or who != batter: bases[dest] = who
                else:
                    if at: bases[at] = None
                    if 'picked off' not in clause and 'caught stealing' not in clause: pass
                    outs += 1

        if ev is not None:
            if ev == 'HR':
                scored += 1 + sum(1 for b in (1, 2, 3) if bases[b])
                bases = {1: None, 2: None, 3: None}
            elif ev in BASE_AFTER:
                bases[BASE_AFTER[ev]] = batter
            elif ev in ('BB', 'HBP'):
                if bases[1] and bases[2] and bases[3]: pass
                elif bases[1] and bases[2]: bases[3] = bases[2]; bases[2] = bases[1]
                elif bases[1]: bases[2] = bases[1]
                bases[1] = batter
            elif ev == 'REACH':
                bases[1] = batter
            else:
                outs += 1
            plays.append((ev, before[0], before[1], scored))
        runs += scored
        outs = min(outs, 3)
    lob = sum(1 for b in (1, 2, 3) if bases[b])
    return plays, runs, lob


def collect():
    seen = collections.defaultdict(list)      # base-out state -> runs to end of inning
    events = collections.defaultdict(list)    # event -> (state_before, outs, runs_on_play, state_after)
    ok = bad = 0
    badlob = [0]
    for gid, g in sorted(psd.BOX.items()):
        d = g['data']
        for team in (d.get('teams') or []):
            lr = line_runs(d, team)
            if lr is None: continue
            for inn, txt in half_innings(d, team):
                plays, runs, lob = walk(txt)
                want = lr[inn - 1] if 0 < inn <= len(lr) else None
                m = LOB_RE.search(txt)
                want_lob = int(m.group(1)) if m else None
                if want is None or runs != want:
                    bad += 1; continue
                if want_lob is not None and lob != want_lob:
                    badlob[0] += 1; continue
                ok += 1
                total = runs
                sofar = 0
                for i, (ev, bases, outs, sc) in enumerate(plays):
                    if outs > 2: continue
                    key = (bases, outs)
                    seen[key].append(total - sofar)
                    events[ev].append((key, total - sofar, sc))
                    sofar += sc
    return seen, events, ok, bad, badlob[0]


if __name__ == '__main__':
    seen, events, ok, bad, badlob = collect()
    tot = ok + bad + badlob
    print(f'half-innings passing BOTH gates: {ok} of {tot} ({100*ok/tot:.0f}%)', file=sys.stderr)
    print(f'   discarded: {bad} runs did not match the line score, '
          f'{badlob} runners-left-on-base did not match the inning summary', file=sys.stderr)
    re24 = {k: sum(v) / len(v) for k, v in seen.items() if len(v) >= 15}
    print(f'base-out states with a usable sample (>=15): {len(re24)} of 24', file=sys.stderr)
    print(f'plate appearances behind them: {sum(len(v) for v in seen.values())}', file=sys.stderr)
    for ev in ('HR', '3B', '2B', '1B', 'BB', 'HBP', 'K', 'OUT'):
        n = len(events.get(ev, []))
        print(f'   {ev:4} {n:5} occurrences', file=sys.stderr)
