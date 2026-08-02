#!/usr/bin/env python3
"""
fielding.py — derive per-player defensive stats (PO / A / E) from play-by-play.

  python3 scripts/fielding.py               # season totals for every Gator
  python3 scripts/fielding.py "Reina"       # one player, with the per-game log

Why this exists: the official fielding table is not in box-seed.json (the box
parser keeps only the batting and pitching tables), and Presto blocks direct
scraping, so PO/A/E have to be rebuilt from the play-by-play text — the same
source the platoon splits and advanced metrics already come from.

How it works, per game:
  1. Seed the defensive lineup from the box score — starters (non-sub rows of
     the Gators batting table, with their position) plus the starting pitcher
     (first row of the Gators pitching table).
  2. Walk the play-by-play in order. Substitution announcements ("Sunday to cf
     for McDonald", "Pierce to lf") move players between positions; only
     announcements naming a Gator are applied, since the opponent's own
     substitutions are announced in the same text.
  3. In half-innings where the opponent bats, credit each out and error to
     whoever holds that position at that moment, by standard scoring:
       - ground out to X          -> A X, PO 1b   (PO p when X is 1b: the 3-1)
       - ground out to X unassisted -> PO X
       - fly/pop/line/foul out to X -> PO X
       - strikeout                -> PO c  (unless the same play ends with a
                                            dropped-third-strike throw)
       - out at <base> X to Y to Z -> A X, A Y, PO Z
       - double play X to Y to Z  -> A X, PO Y, A Y, PO Z   (2 outs)
       - double play X to Y       -> PO X, A X, PO Y        (2 outs)
       - error by X               -> E X

Two gates run on every game and both must pass for the numbers to be usable:
  PO gate: putouts credited == outs the Gators actually recorded on defense
           (from the play-by-play out markers). Every out is exactly one putout.
  E  gate: errors credited == the Gators' error total in the official line score.
Assists have no independent check; they ride on the same parse the putouts do.
"""
import json, re, sys, html, collections, os, difflib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATORS = 'Lake Charles Gumbeaux Gators'
POS = ('p', 'c', '1b', '2b', '3b', 'ss', 'lf', 'cf', 'rf')
POS_RE = r'(?:1b|2b|3b|ss|lf|cf|rf|dh|c|p)'
NAME = r"[A-Z][A-Za-z.'\-]*(?:\s+[A-Z][A-Za-z.'\-]*)*"


def text(h):
    h = re.sub(r'<[^>]+>', ' ', h)
    return html.unescape(re.sub(r'\s+', ' ', h)).strip()


def clean_name(s):
    s = re.sub(r'\s*\([WLSV][^)]*\)\s*$', '', s).strip()       # (W, 3-1) decisions
    s = re.sub(r'^[a-z]-\s*', '', s).strip()                   # a- sublet markers
    if '. ' in s: s = s.split('. ')[-1].strip()                # names glued across sentences
    return ' '.join(s.split())


def key(n):
    return re.sub(r'[^a-z]', '', (n or '').lower())


def match_gator(nm, gators):
    """Resolve a play-by-play name to this game's Gators, or None for an
    opponent. Play-by-play spellings drift from the box ("Hennen"/"Hennan"),
    and a substitution that fails to match would silently leave the wrong
    player on the field, so near-misses are matched the same way the rest of
    the pipeline does it."""
    k = key(nm)
    if k in gators: return nm
    close = difflib.get_close_matches(k, gators, n=1, cutoff=0.88)
    return nm if close else None


def lineup_from_box(g, team=GATORS):
    """Starters by position, the Gators' name set, and each player's listed positions.

    The listed positions are Presto's own record of where a player appeared
    ("lf", or "lf/cf" for someone who moved). They are the check on the
    substitution timeline: a position this code hands a player must be one
    Presto also lists for him.
    """
    starters, names, order = {}, set(), []
    listed = collections.defaultdict(set)
    unchipped, by_key = [], {}
    for sec in g['box']:
        if team not in sec['label']: continue
        batting = 'Batting' in sec['label']
        for row in re.findall(r'<tr>(.*?)</tr>', sec['html'], re.S):
            th = re.search(r'<th([^>]*)>(.*?)</th>', row, re.S)
            if not th: continue
            cls, inner = th.group(1), th.group(2)
            pm = re.search(r'<span>([a-z0-9/]+)</span>', inner)
            # drop the position chip and the a-/b- sublet marker before reading
            # the name — but a pitching row can put the NAME itself in a span,
            # so fall back to the raw text rather than losing the pitcher.
            nm = clean_name(text(re.sub(r'<span[^>]*>.*?</span>', ' ', inner, flags=re.S))) or clean_name(text(inner))
            if not nm or nm in ('Hitters', 'Pitchers', 'Totals'): continue
            names.add(key(nm)); by_key.setdefault(key(nm), nm)
            if not batting:
                order.append(nm)                               # pitchers, in order used
                listed[key(nm)].add('p')
                continue
            if pm: listed[key(nm)].update(pm.group(1).split('/'))
            if 'bxsub' in cls: continue                        # subs enter via the play-by-play
            if not pm: unchipped.append(nm); continue          # starter Presto left without a chip
            p = pm.group(1).split('/')[0]
            if p in POS and p not in starters: starters[p] = nm
    if order: starters['p'] = order[0]                         # starting pitcher
    # Presto occasionally omits a starter's position chip (and can print a dual
    # chip like "3b/rf" for someone who moved). Any position still empty after
    # the chipped rows belongs to the unchipped starters, in batting order.
    for p in POS:
        if p not in starters and unchipped: starters[p] = unchipped.pop(0)
    fill_vacancies(starters, listed, by_key)
    return starters, names, listed, by_key


def fill_vacancies(lineup, listed, by_key):
    """Seat anyone Presto chips for a position the parse has left empty.

    Not every defensive change is announced: a substitute can appear only as a
    chipped row in the box ("1b Matthew McKinley"), and a DH who takes the
    field ("dh/1b") is never seated by the starting nine. When exactly one
    player carries the chip for an empty position and is not already on the
    field, he is the fielder. Ambiguous cases are left empty on purpose — an
    unattributed putout is better than one credited to the wrong glove.
    """
    for p in POS:
        if p in lineup: continue
        on = {key(v) for v in lineup.values()}
        cand = [k for k, ps in listed.items() if p in ps and k not in on]
        if len(cand) == 1: lineup[p] = by_key[cand[0]]


def half_outs(t, last=False):
    """Outs recorded in one half-inning.

    A completed half-inning is always three outs. The play-by-play's "(N out)"
    markers can't be used for this on their own: Presto omits the marker on an
    inning-ending play that is described inside another batter's play ("...
    advanced to third, out at home lf to c"), so the markers under-count. Only
    the game's final half-inning can legitimately stop short of three, and
    there the marker is the answer.
    """
    n = [int(m.group(1)) for m in re.finditer(r'\((\d+) outs?\)', t)]
    return (max(n) if n else 0) if last else 3


SUB_RE = re.compile(rf'({NAME})\s+to\s+({POS_RE})\b(?:\s+for\s+({NAME}))?')
ERR_RE = re.compile(rf'error by ({POS_RE})\b')
# Scorer shorthand: "Dropped foul ball, E5" — E1..E9 are the numbered positions.
ENUM_RE = re.compile(r'\bE([1-9])\b')
ENUM_POS = {'1': 'p', '2': 'c', '3': '1b', '4': '2b', '5': '3b', '6': 'ss', '7': 'lf', '8': 'cf', '9': 'rf'}
GRD_RE = re.compile(rf'grounded out(?:\s+to)?\s+({POS_RE})\b(\s+unassisted)?')
AIR_RE = re.compile(rf'(?:flied out|popped up|popped out|lined out|fouled out|flied into)\s+to\s+({POS_RE})\b')
# A strikeout the batter survives — wild pitch, passed ball, dropped third he
# beats out — is not an out, so nobody gets a putout for it.
REACHED_RE = re.compile(r'reached (?:first|base)\b')
OUT_RE = re.compile(rf'out at (?:first|second|third|home)\s+((?:{POS_RE})(?:\s+to\s+(?:{POS_RE}))*)(\s+unassisted)?')
DP_RE = re.compile(rf'(?:double|triple) play\s+((?:{POS_RE})(?:\s+to\s+(?:{POS_RE}))*)(\s+unassisted)?')
CHAIN_RE = re.compile(POS_RE)
STEAL_RE = re.compile(r'\bstole (?:second|third|home)\b')


def credit(book, lineup, pos, stat, orphans=None):
    """Credit one stat to whoever holds `pos`. An empty position is an orphan —
    the play happened, so a credit that lands on nobody means the lineup
    timeline is wrong, not that the play didn't count."""
    who = lineup.get(pos)
    if who: book[who][pos + ':' + stat] += 1
    elif orphans is not None: orphans.append((pos, stat))
    return who is not None


def apply_play(seg, book, lineup, orphans=None):
    """Credit one play segment. Returns the number of putouts credited."""
    def give(pos, stat):
        return credit(book, lineup, pos, stat, orphans)
    po = 0
    dp = DP_RE.search(seg)
    if dp:
        chain = CHAIN_RE.findall(dp.group(1))
        if dp.group(2) or len(chain) == 1:                     # 3-unassisted: same fielder twice
            give(chain[0], 'PO'); give(chain[0], 'PO')
            return 2
        if len(chain) == 2:                                    # 4-3: force taken unassisted, then the throw
            give(chain[0], 'PO'); give(chain[0], 'A'); give(chain[1], 'PO')
            return 2
        for f in chain[:-2]: give(f, 'A')                      # 6-4-3 and longer
        give(chain[-2], 'PO'); give(chain[-2], 'A'); give(chain[-1], 'PO')
        return 2

    outs = list(OUT_RE.finditer(seg))
    for m in outs:
        chain = CHAIN_RE.findall(m.group(1))
        if m.group(2) or len(chain) == 1:
            give(chain[0], 'PO')
        else:
            for f in chain[:-1]: give(f, 'A')
            give(chain[-1], 'PO')
        po += 1
        # The catcher's throwing game. A runner is only the catcher's to claim
        # when the play starts with him: "out at second c to 2b, caught
        # stealing" is his, "out at second p to 1b to ss, caught stealing" is
        # the pitcher's pickoff and no catching credit at all. Pickoffs are
        # kept apart from caught stealing, the way the league counts them.
        if chain[0] == 'c':
            if 'caught stealing' in seg: give('c', 'CS')
            elif 'picked off' in seg: give('c', 'PKO')

    # Every steal that goes uncontested is charged to whoever is catching.
    for _ in STEAL_RE.finditer(seg):
        give('c', 'SBA')

    # A strikeout is a putout for the catcher unless the play ended with a
    # throw (dropped third strike) — that out is already credited above.
    # Batter's interference is also the catcher's putout.
    if ('struck out' in seg or "out on batter's interference" in seg) \
            and not outs and not REACHED_RE.search(seg):
        give('c', 'PO'); po += 1

    for m in GRD_RE.finditer(seg):
        f = m.group(1)
        if m.group(2):
            give(f, 'PO')
        else:
            give(f, 'A')
            give('p' if f == '1b' else '1b', 'PO')
        po += 1
    for m in AIR_RE.finditer(seg):
        give(m.group(1), 'PO'); po += 1
    for m in ERR_RE.finditer(seg):
        give(m.group(1), 'E')
    for m in ENUM_RE.finditer(seg):
        give(ENUM_POS[m.group(1)], 'E')
    return po


def line_errors(g, team=GATORS):
    """The club's error count from the official line score (R/H/E).

    None when the page carries no line score — Presto sometimes never renders
    one for a finished game. That leaves the error gate with nothing to check
    against, which is reported as ungraded rather than counted as a pass.
    """
    if not g.get('line'): return None
    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', g['line'], re.S)
    for r in rows:
        cells = [text(c) for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', r, re.S)]
        if cells and team.split()[-1] in cells[0]:
            try: return int(cells[-1])
            except ValueError: return None
    return None


def game_fielding(g, team=GATORS):
    """Per-player PO/A/E for one game, with all three validation gates."""
    lineup, gators, listed, by_key = lineup_from_box(g, team)
    seeded = dict(lineup)
    book = collections.defaultdict(lambda: collections.defaultdict(int))
    orphans, thin, afield = [], [], {}
    po = outs = 0
    for i, blk in enumerate(g['pbp']):
        t = text(blk['html'])
        t = re.sub(re.escape(blk['title']), ' ', t)
        fielding = team not in blk['title']                    # opponent batting -> we're in the field
        if fielding:
            outs += half_outs(t, last=(i == len(g['pbp']) - 1))
            if len(lineup) != 9 or len(set(map(key, lineup.values()))) != 9:
                thin.append((blk['title'][:40], sorted(lineup)))
            for p, who in lineup.items():
                afield.setdefault(who, set()).add(p)            # took the field, chance or not
        for seg in re.split(r'(?<=[.;])\s+', t):
            seg = re.sub(r'\([0-9]-[0-9][^)]*\)', ' ', seg)    # strip pitch counts
            seg = re.sub(r'\(\d+ outs?\)', ' ', seg)
            if fielding:
                fill_vacancies(lineup, listed, by_key)         # unannounced changes
                po += apply_play(seg, book, lineup, orphans)
            for m in SUB_RE.finditer(seg):                     # subs are announced in both halves
                who, pos = match_gator(clean_name(m.group(1)), gators), m.group(2)
                if not who: continue                           # the opponent's own moves
                for p, occ in list(lineup.items()):
                    if key(occ) == key(who): del lineup[p]      # vacate his old spot
                if pos in POS: lineup[pos] = who
                elif pos == 'dh': pass                          # the DH does not field
    err = sum(n for v in book.values() for k, n in v.items() if k.endswith(':E'))
    official = line_errors(g, team)
    # The seeded nine are the one part of the lineup not backed by an explicit
    # announcement, so they are what needs checking against Presto's own chips.
    off_book = sorted(f'{who} at {p}' for p, who in seeded.items()
                      if listed.get(key(who)) and p not in listed[key(who)])
    return {
        'players': {k: dict(v) for k, v in book.items()},
        'afield': {k: sorted(v) for k, v in afield.items()},
        'po': po, 'outs': outs, 'po_ok': po == outs,
        'errors': err, 'official_errors': official, 'e_ok': official is not None and err == official,
        'seed_off_book': off_book, 'orphans': orphans, 'thin': thin,
    }


def load_boxes():
    """box-seed plus the supplements the card pipeline uses: a prior club's
    games, and any finished game whose line score Presto never rendered."""
    boxes = json.load(open(os.path.join(ROOT, 'box-seed.json')))['boxes']
    for extra in ('data/prior-stint-seed.json', 'data/late-box-repair.json'):
        try:
            for gid, g in json.load(open(os.path.join(ROOT, extra)))['boxes'].items():
                boxes.setdefault(gid, g)
        except FileNotFoundError:
            pass
    return boxes


def season(box=None, team=GATORS):
    box = box if box is not None else load_boxes()
    tot = collections.defaultdict(lambda: collections.defaultdict(int))
    log = collections.defaultdict(list)
    gates = {'po': [], 'e': [], 'seed': [], 'orphan': [], 'thin': []}
    for gid in sorted(box):
        g = box[gid]['data']
        # supplements carry other clubs' games; a club's season is its own
        if team not in (g.get('teams') or [team]): continue
        r = game_fielding(g, team)
        gates['po'].append((gid, r['po'], r['outs']))
        gates['e'].append((gid, r['errors'], r['official_errors']))
        if r['seed_off_book']: gates['seed'].append((gid, r['seed_off_book']))
        if r['orphans']: gates['orphan'].append((gid, r['orphans']))
        if r['thin']: gates['thin'].append((gid, r['thin']))
        for who, ps in r['afield'].items():
            # One game counts once per group, however many spots he moved
            # between in it: "G" on the mound and "G" in the field are separate
            # denominators because the two cards report them separately.
            for p in ps: tot[who]['at@' + p] += 1
            if 'p' in ps: tot[who]['G@p'] += 1
            if [p for p in ps if p != 'p']: tot[who]['G@field'] += 1
        for who, s in r['players'].items():
            if not any(s.values()): continue
            for k, v in s.items(): tot[who][k] += v
            log[who].append((gid, s))
    return tot, log, gates


def summary(tot, who, where='all'):
    """Season fielding line. `where` selects the mound ("p"), everywhere else
    ("field" — what a position player's card should show), or the whole lot."""
    s = tot.get(who, {})
    keep = (lambda p: True) if where == 'all' else \
           (lambda p: p == 'p') if where == 'p' else (lambda p: p != 'p')
    take = lambda stat: sum(n for k, n in s.items() if ':' in k and k.split(':')[1] == stat and keep(k.split(':')[0]))
    po, a, e = take('PO'), take('A'), take('E')
    ch = po + a + e
    g = s.get('G@p', 0) if where == 'p' else \
        s.get('G@field', 0) if where == 'field' else max(s.get('G@p', 0), s.get('G@field', 0))
    pos = sorted((k[3:] for k in s if k.startswith('at@') and keep(k[3:])),
                 key=lambda p: -s['at@' + p])
    # Catching: runners he threw out, runners who got the base, and the rate.
    # Pickoffs stay out of the rate — the league counts them separately.
    cs, sba, pko = take('CS'), take('SBA'), take('PKO')
    att = cs + sba
    return {'G': g, 'PO': po, 'A': a, 'E': e, 'CH': ch, 'POS': pos,
            'FLD': ('%.3f' % ((po + a) / ch)).replace('0.', '.') if ch else '—',
            'POG': ('%.2f' % (po / g)) if g else '—',
            'CS': cs, 'SBA': sba, 'PKO': pko, 'ATT': att,
            'CSPCT': ('%.1f' % (100 * cs / att)) if att else '—',
            'GC': s.get('at@c', 0)}


if __name__ == '__main__':
    tot, log, gates = season()
    bad_po = [x for x in gates['po'] if x[1] != x[2]]
    ungraded = [x for x in gates['e'] if x[2] is None]      # no line score on the page
    bad_e = [x for x in gates['e'] if x[2] is not None and x[1] != x[2]]
    print(f"games: {len(gates['po'])}", file=sys.stderr)
    print(f"PO gate: {len(gates['po']) - len(bad_po)}/{len(gates['po'])} games exact", file=sys.stderr)
    for gid, got, want in bad_po: print(f'   {gid}: credited {got} PO vs {want} outs', file=sys.stderr)
    gradeable = len(gates['e']) - len(ungraded)
    print(f"E  gate: {gradeable - len(bad_e)}/{gradeable} games match the line score"
          + (f' ({len(ungraded)} ungraded — no line score published)' if ungraded else ''), file=sys.stderr)
    for gid, got, want in bad_e: print(f'   {gid}: credited {got} E vs line score {want}', file=sys.stderr)
    for gid, got, _ in ungraded: print(f'   {gid}: {got} E credited, no line score to check against', file=sys.stderr)
    n = len(gates['po'])
    print(f"LINEUP gate: {n - len(gates['seed'])}/{n} games seed the nine at Presto's own listed positions", file=sys.stderr)
    for gid, offs in gates['seed']: print(f'   {gid}: {offs}', file=sys.stderr)
    print(f"FIELD gate: {n - len(gates['thin'])}/{n} games keep nine distinct fielders on at all times", file=sys.stderr)
    for gid, t in gates['thin']: print(f'   {gid}: {t[:2]}', file=sys.stderr)
    print(f"CREDIT gate: {n - len(gates['orphan'])}/{n} games land every credit on a player", file=sys.stderr)
    for gid, o in gates['orphan']: print(f'   {gid}: {o}', file=sys.stderr)

    if len(sys.argv) > 1:
        want = sys.argv[1].lower()
        for who in sorted(tot):
            if want in who.lower():
                print(json.dumps({'player': who, 'season': summary(tot, who),
                                  'games': [{'game': gid, **s} for gid, s in log[who]]}, indent=2))
    else:
        print(json.dumps({who: summary(tot, who) for who in sorted(tot)}, indent=2))
