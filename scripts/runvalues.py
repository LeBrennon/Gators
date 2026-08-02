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

TWO GATES, both against the official record:
  runs  — reconstructed runs must equal that inning's runs in the line score
  LOB   — runners left on base must equal the inning summary's LOB count
The second is what actually validates the base tracking; runs alone will pass
while runners are being dropped, so runs are counted from the text independently
of the tracking rather than derived from it.

STATUS: 90% of half-innings clear both gates (1061 of 1174) and all 24 base-out
states have a usable sample. wOBA still does not ship, and the reason is
measured rather than assumed:

    kept       1061 half-innings, mean 0.664 runs
    discarded   113 half-innings, mean 1.549 runs
    league     1174 half-innings, mean 0.750 runs

The surviving sample scores 11.4% below the league. The important part is that
raising the pass rate from 51% to 90% did NOT shrink that gap (it was 11.0% at
89%): the innings that still fail are not random, they are the busiest ones, so
each fix removes innings from the failure pile without changing its character.
The kept sample keeps under-representing the loaded base states that set the run
values for extra-base hits and walks, and weights fitted to it would be biased
low with nothing on the card to reveal it.

Closing this needs the pass rate near 98%, not 90% — the remaining 113 are
innings with errors advancing several runners at once, fielder's-choice chains,
and a steal plus an advance on the same play. Until then wOBA and wRC+ stay off
the cards.
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

# A run is usually "X scored", but Presto also writes "advanced to home" — on a
# fielder's choice, for instance — and that is a run too. "out at home" is not.
SCORED = re.compile(r'\bscored\b|\badvanced to home\b')
# Batting events that end a plate appearance, in the order they must be tested.
EVENTS = [
    ('HR', r'homered'), ('3B', r'tripled'), ('2B', r'doubled'), ('1B', r'singled'),
    ('HBP', r'hit by pitch'), ('BB', r'walked'),
    ('SF', r'sacrifice fly'), ('SH', r'sacrifice bunt'),
    # A batter who reaches on an error or a fielder's choice is SAFE — he was
    # being counted as an out and never placed on base, which broke the state
    # every later hitter in the inning inherited.
    ('REACH', r"reached (?:first |second |third )?on (?:an? )?(?:\w+ )?"
              r"(?:error|fielder'?s choice)"),
    ('K', r'struck out'),
    ('OUT', r'grounded out|flied out|lined out|popped up|popped out|fouled out|'
            r'grounded into|lined into|flied into|out at first'),
]
BASE_AFTER = {'1B': 1, '2B': 2, '3B': 3}


def half_innings(g, team):
    """Yield (inning_number, text) for the half-innings this club batted in."""
    for blk in g['pbp']:
        if team not in blk['title']: continue
        m = re.search(r'(\d+)(?:st|nd|rd|th)\s+Inning', blk['title'])
        p = psd.Text(); p.feed(blk['html'])
        txt = re.sub(r'\s+', ' ', ' '.join(p.t))
        txt = psd.HDR_RE.sub(' ', txt)
        # Strip the "(2 out)" markers BEFORE splitting into plays. They prefix
        # the next sentence, so leaving them in stops the batter's name from
        # being read off the front of the chunk and that hitter is never placed
        # on base — which quietly wrecked the state for the rest of the inning.
        txt = re.sub(r'\((\d+) outs?\)\s*', ' ', txt)
        yield (int(m.group(1)) if m else 0), re.sub(r'\s+', ' ', txt)


def strip_summary(txt):
    """Drop the trailing "Inning Summary: ..." but keep the play in front of it.
    Presto often runs the last out of an inning into the same sentence as the
    summary, and skipping the whole sentence lost that out."""
    i = txt.find('Inning Summary')
    return txt[:i] if i >= 0 else txt


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
MOVE_RE = re.compile(r'(' + NAME_RE + r')\s+(?:picked off,?\s+)?'
                     r'(advanced to (?:first|second|third)[^;.]*?,\s*out at (?:first|second|third|home)|'
                     r'scored|advanced to (?:first|second|third)|'
                     r'out at (?:first|second|third|home)|out on the play|picked off|'
                     r'stole (?:second|third|home)|pinch ran for (' + NAME_RE + r'))')


def nm(x):
    """Trim a captured name. NAME_RE allows '.' so initials survive ("J.T.
    Simonelli"), which means it also swallows the period ending a sentence —
    "pinch ran for Tobias Motley." captured the runner as "Tobias Motley." and
    matched nobody on the bases."""
    return x.rstrip('.').strip() if x else x


def walk(txt):
    """Replay one half-inning, following every named runner.

    Presto states each runner's move explicitly, so the bases are tracked by
    name rather than guessed. Run expectancy is keyed on the base-out state a
    hitter walked into, so a wrong state puts the plate appearance in the wrong
    bucket — and the runs gate alone would never notice, which is what the
    left-on-base gate is for.

    Returns the plate appearances, runs scored, and runners left on base.
    """
    plays, bases, outs, runs = [], {1: None, 2: None, 3: None}, 0, 0
    # A runner erased for the THIRD out by a caught stealing or a pickoff is
    # still counted in Presto's inning-summary LOB — he was standing on the base
    # when the inning ended. This holds only for those two; a runner forced or
    # thrown out on a batted ball is not counted, which is why applying it to
    # every kind of baserunning out made the gate worse rather than better.
    cs_ended_inning = [False]

    def at(who):
        return next((b for b in (1, 2, 3) if bases[b] == who), None)

    def move(who, dest):
        b = at(who)
        if b: bases[b] = None
        if dest: bases[dest] = who

    for chunk in re.split(r'(?<=\.)\s+', strip_summary(txt)):
        if not chunk.strip(): continue
        head = chunk.split(';')[0]
        ev = None
        for name, pat in EVENTS:
            if re.search(pat, head): ev = name; break
        bm = re.match(r'\s*(' + NAME_RE + r')', chunk)
        batter = nm(bm.group(1)) if bm else None
        before = (tuple(bool(bases[b]) for b in (1, 2, 3)), outs)
        # Runs are counted from the text alone, independently of the base
        # tracking. Deriving them from the tracked runners would make the runs
        # gate depend on the very thing the left-on-base gate exists to test,
        # and a tracking slip would then hide itself in both.
        scored = len(SCORED.findall(chunk))
        if ev == 'HR': scored += 1        # his own run is never written as "scored"
        # A scoring clause is occasionally truncated to the runner's name with no
        # verb ("; Connor Stelly Connor Stelly."), losing the run. The play's own
        # RBI annotation still counts it, and an RBI is always a run, so the
        # larger of the two is the honest reading.
        rbi = re.search(r',\s*(\d+)?\s*RBI\b', chunk)
        if rbi: scored = max(scored, int(rbi.group(1) or 1))

        # 0. Extra innings start with a runner already standing on second:
        #    "Damian Montanez Lucas Dunn placed on second". Without this he is
        #    invisible and the inning ends a runner short.
        placed = re.search(r'(' + NAME_RE + r')\s+placed on (first|second|third)', chunk)
        if placed: bases[BASE_WORD[placed.group(2)]] = nm(placed.group(1))

        # 1. Runners already on base move first — they were there before the
        #    batter's result, so they cannot collide with where he ends up.
        #    Presto lists them trailing-runner-first ("Hardin advanced to second;
        #    Charboneau advanced to third"), so applying them in text order drops
        #    a runner into a base the man ahead of him has not vacated yet and
        #    overwrites him. Move the LEAD runner first.
        moves = list(MOVE_RE.finditer(chunk))
        for m in moves:                            # pinch runners first: they rename a base
            if m.group(2).startswith('pinch ran'):
                b = at(nm(m.group(3)))
                if b: bases[b] = nm(m.group(1))
        moves = [m for m in moves if not m.group(2).startswith('pinch ran')]
        moves.sort(key=lambda m: at(nm(m.group(1))) or 0, reverse=True)
        for m in moves:
            who, what = nm(m.group(1)), m.group(2)
            if at(who) is None: continue          # not a runner yet; handled below
            if 'out at' in what:                   # thrown out, with or without an advance first
                move(who, None); outs += 1
                if outs >= 3 and ev != 'REACH' and re.search(r'caught stealing|picked off', chunk):
                    cs_ended_inning[0] = True
            elif what == 'scored':
                move(who, None)
            elif what.startswith('advanced'):
                move(who, BASE_WORD[what.rsplit(' ', 1)[-1]])
            elif what.startswith('stole'):
                dest = what.rsplit(' ', 1)[-1]
                move(who, None if dest == 'home' else BASE_WORD[dest])
            else:                    # out at <base>, out on the play, picked off
                move(who, None); outs += 1
                if outs >= 3 and ev != 'REACH' and re.search(r'caught stealing|picked off', chunk):
                    cs_ended_inning[0] = True

        # 2. Then the batter's own result.
        if ev is not None:
            if ev == 'HR':
                # runs already counted from the text above; just clear the bases
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
                # A double play retires the batter and a runner. The runner is
                # usually named ("X out on the play") and already counted above;
                # when he is not, the phrase is the only record of that out.
                if 'double play' in head and 'out on the play' not in chunk: outs += 1
                if 'triple play' in head: outs += 2
            plays.append((ev, before[0], before[1], scored))

        # 2b. A runner's clause can chain too, naming him only once:
        #     "Aidan Eshelman stole third, scored on an error by ss".
        for m in MOVE_RE.finditer(chunk):
            who = nm(m.group(1))
            # On a pure base-running sentence there is no batter, so the leading
            # name is a runner and his continuation counts too.
            if (who == batter and ev is not None) or at(who) is None: continue
            tail = chunk[m.end():].split(';')[0]
            if re.search(r',\s*scored\b', tail): move(who, None)
            elif re.search(r',\s*out at\b', tail): move(who, None); outs += 1
            else:
                adv = re.search(r',\s*advanced to (first|second|third)\b', tail)
                if adv: move(who, BASE_WORD[adv.group(1)])

        # 3a. The batter's own continuation, written without repeating his name:
        #     "Mitchell singled to right field, advanced to second on a fielding
        #     error by rf, out at third rf to 2b to 3b". Only bases past first
        #     count as an out here — a batter "out at first" is his own out and
        #     is already recorded as the play's result.
        if ev is not None and batter and at(batter) is not None:
            adv = re.search(r',\s*advanced to (first|second|third)\b', head)
            if adv: move(batter, BASE_WORD[adv.group(1)])
            if re.search(r',\s*scored\b', head): move(batter, None)
            gone = re.search(r',\s*out at (second|third|home)\b', head)
            if gone and at(batter) is not None:
                move(batter, None); outs += 1

        # 3b. Anything the batter himself did after reaching, named explicitly.
        for m in MOVE_RE.finditer(chunk):
            who, what = nm(m.group(1)), m.group(2)
            if who != batter or at(who) is None: continue
            if 'out at' in what: move(who, None); outs += 1
            elif what == 'scored': move(who, None)
            elif what.startswith('advanced'): move(who, BASE_WORD[what.rsplit(' ', 1)[-1]])
            elif what.startswith('stole'):
                dest = what.rsplit(' ', 1)[-1]
                move(who, None if dest == 'home' else BASE_WORD[dest])
            elif what.startswith('out'):
                move(who, None); outs += 1

        runs += scored
        outs = min(outs, 3)
    lob = sum(1 for b in (1, 2, 3) if bases[b]) + (1 if cs_ended_inning[0] else 0)
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


def weights():
    """League run values and wOBA weights, from the innings that pass both gates.

    Run value of an event = the runs that actually scored from that plate
    appearance to the end of the inning, minus what the base-out state was worth
    before it. Shift so a batting out is zero, then scale so league wOBA equals
    league OBP — the standard normalisation, with this league's numbers rather
    than another league's.
    """
    seen, events, ok, bad, badlob = collect()
    re24 = {k: sum(v) / len(v) for k, v in seen.items() if len(v) >= 15}
    rv = {}
    for ev, occ in events.items():
        vals = [to_end - re24[state] for state, to_end, _ in occ if state in re24]
        if len(vals) >= 20: rv[ev] = sum(vals) / len(vals)
    outs = [v for e, v in rv.items() if e in ('K', 'OUT')]
    n_outs = sum(len(events[e]) for e in ('K', 'OUT') if e in events)
    out_val = sum(rv[e] * len(events[e]) for e in ('K', 'OUT') if e in rv) / n_outs
    shifted = {e: v - out_val for e, v in rv.items()}
    # scale: league wOBA must come out equal to league OBP
    num = sum(shifted.get(e, 0) * len(events.get(e, [])) for e in ('BB', 'HBP', '1B', '2B', '3B', 'HR'))
    den = sum(len(events.get(e, [])) for e in ('BB', 'HBP', '1B', '2B', '3B', 'HR', 'K', 'OUT', 'SF'))
    reach = sum(len(events.get(e, [])) for e in ('BB', 'HBP', '1B', '2B', '3B', 'HR'))
    lg_obp = reach / den if den else 0
    scale = lg_obp / (num / den) if num else 0
    w = {e: round(shifted[e] * scale, 3) for e in ('BB', 'HBP', '1B', '2B', '3B', 'HR') if e in shifted}
    # Standard error of each weight, so its precision travels with it. The rare
    # events are the loose ones: 40 triples and 52 home runs in the sample.
    import statistics, math
    se = {}
    for ev in w:
        vals = [t - re24[st_] for st_, t, _ in events[ev] if st_ in re24]
        se[ev] = round(statistics.stdev(vals) / math.sqrt(len(vals)) * scale, 3)
    lg_woba = sum(w[e] * len(events[e]) for e in w) / den if den else 0
    return {'weights': w, 'weight_stderr': se, 'n': {e: len(events[e]) for e in w},
            'lgOBP': round(lg_obp, 4), 'lgwOBA': round(lg_woba, 4), 'scale': round(scale, 4),
            'runsPerPA': round(sum(sum(v) for v in seen.values()) / sum(len(v) for v in seen.values()), 4),
            'gates': {'passed': ok, 'total': ok + bad + badlob},
            're24': {f'{"".join("123"[i] for i, b in enumerate(k[0]) if b) or "_"}|{k[1]}': round(v, 3)
                     for k, v in sorted(re24.items(), key=lambda kv: (kv[0][1], kv[0][0]))}}


if __name__ == '__main__':
    if '--json' in sys.argv:
        print(json.dumps(weights(), indent=1)); sys.exit(0)
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
    w = weights()
    print('\nleague run expectancy (bases|outs -> runs to end of inning):', file=sys.stderr)
    for k, v in w['re24'].items(): print(f'   {k:8} {v}', file=sys.stderr)
    print(f"\nwOBA weights (this league, scaled to its own OBP {w['lgOBP']}):", file=sys.stderr)
    for k, v in w['weights'].items(): print(f'   {k:4} {v}', file=sys.stderr)
