#!/usr/bin/env python3
"""
advanced.py — Savant-style batting splits rebuilt from play-by-play.

  python3 scripts/advanced.py "Ayden Sunday"
  python3 scripts/advanced.py                 # every batter, gate summary only

What it computes, and why each is trustworthy here:

  SPRAY (pull / center / oppo)
      Every ball in play in the play-by-play names where it went — a fielder
      ("grounded out to ss") or a region ("doubled to left center"). Combined
      with the batter's own hand that maps to pull/center/oppo. This is a
      location the scorer recorded, not a judgment call.

  COUNT (two-strike, ahead, behind, even; first pitch)
      Presto prints the count a plate appearance ENDED on: "(3-2 BBKKFB)". The
      bucket comes from that printed count, never from reading the pitch letters,
      so it does not depend on the scorer distinguishing a swinging strike from
      a called one.

  HOME / AWAY and MONTH
      Straight from the schedule.

Deliberately NOT computed:
  - Whiff / swinging-strike rate. It requires trusting that scorers entered
    swing-and-miss versus called strikes correctly, which the owner does not.
  - wOBA / wRC+ — not yet. scripts/runvalues.py derives this league's own run
    values rather than borrowing MLB's, and its two official gates (runs against
    the line score, runners left on base against the inning summary) currently
    clear only 58% of half-innings. Weights built on the subset that passes would
    be biased toward quiet innings. See that module for what still needs work.

Every split is gated: the buckets must add back up to the plate appearances the
card already reports, and spray must add up to balls in play.
"""
import json, re, sys, collections, importlib.util, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
_spec = importlib.util.spec_from_file_location('psd', os.path.join(ROOT, 'scripts', 'player-season-data.py'))
psd = importlib.util.module_from_spec(_spec)
_argv, sys.argv = sys.argv, ['psd']
try: _spec.loader.exec_module(psd)
except SystemExit: pass
sys.argv = _argv

# Where the ball went -> which third of the field, from the batter's side.
# Infield positions count as the side they are on; p and c are up the middle.
LEFT = {'3b', 'ss', 'lf', 'left field', 'left'}
RIGHT = {'1b', '2b', 'rf', 'right field', 'right'}
MID = {'p', 'c', 'cf', 'center field', 'center', 'left center', 'right center', 'up the middle'}
LOC_RE = re.compile(
    r'\b(?:to|through|down|into)\s+'
    r'(left center|right center|left field|right field|center field|the left side|the right side|'
    r'1b|2b|3b|ss|lf|cf|rf|p|c)\b')
BIP_VERBS = ('singled', 'doubled', 'tripled', 'homered', 'grounded out', 'flied out',
             'lined out', 'popped up', 'popped out', 'fouled out', 'reached on',
             'grounded into', 'lined into', 'flied into', 'sacrifice fly', 'sacrifice bunt')
COUNT_RE = re.compile(r'\((\d)-(\d)[\s)]')


def side(loc, bats):
    """pull / center / oppo for a hitter of this hand."""
    loc = loc.strip()
    if 'left center' in loc or 'right center' in loc: return 'center'
    if loc in MID: return 'center'
    if loc in LEFT or 'left' in loc: return 'pull' if bats == 'R' else 'oppo'
    if loc in RIGHT or 'right' in loc: return 'oppo' if bats == 'R' else 'pull'
    return None


def batter_splits(player):
    """Per-plate-appearance buckets for one hitter."""
    bio = psd.ROSTER.get(player) or next((psd.ROSTER[a] for a in psd.aka(player) if a in psd.ROSTER), {})
    bats = (bio.get('bt') or '—/—').split('/')[0]
    spray = collections.Counter()
    count = collections.defaultdict(lambda: collections.Counter())
    venue = collections.defaultdict(lambda: collections.Counter())
    month = collections.defaultdict(lambda: collections.Counter())
    pa_total = bip_total = 0
    for gid, g in sorted(psd.BOX.items()):
        if (gid, player) in psd.EXCLUDE_GAMES: continue
        mine = psd.team_of(gid, player)
        if not mine: continue
        opp, home, res = psd.game_meta(g, mine, gid)
        mon = psd.MON[gid[4:6]]
        pat = '(?:' + '|'.join(re.escape(n) for n in psd.aka(player, gid)) + ')'
        ev_re = re.compile(pat + r'\s+(?:' + '|'.join(BIP_VERBS) + r')[^.;]*')
        for sec in g['data'].get('pbp', []):
            if mine not in sec['title']: continue
            p = psd.Text(); p.feed(sec['html'])
            txt = re.sub(r'\s+', ' ', ' '.join(p.t))
            txt = psd.HDR_RE.sub(' ', txt); txt = psd.OUT_RE.sub(' ', txt)
            for m in re.finditer(pat + r'\s+(?:' + psd.BVERBS + r')[^.;]*', txt):
                seg = m.group(0)
                # "out at first p to 1b, picked off" is base running, not a plate
                # appearance — the card's own classifier excludes it too.
                if 'out at first' in seg and ('picked off' in seg or 'caught stealing' in seg):
                    continue
                pa_total += 1
                # bucket by the count Presto printed for this plate appearance
                c = COUNT_RE.search(txt[m.end():m.end() + 40]) or COUNT_RE.search(seg)
                if c:
                    b, s = int(c.group(1)), int(c.group(2))
                    key = 'two-strike' if s == 2 else ('first pitch' if b == 0 and s == 0 else
                          'ahead' if b > s else 'behind' if s > b else 'even')
                    hit = bool(re.search(r'singled|doubled|tripled|homered', seg))
                    ab = bool(re.search(r'singled|doubled|tripled|homered|struck out|grounded out|'
                                        r'flied out|lined out|popped|fouled out|reached on|out at', seg))
                    count[key]['PA'] += 1; count[key]['H'] += hit; count[key]['AB'] += ab
                # spray, on balls in play only
                if any(v in seg for v in BIP_VERBS) and 'struck out' not in seg:
                    loc = LOC_RE.search(seg)
                    if loc:
                        sd = side(loc.group(1), bats)
                        if sd: spray[sd] += 1; bip_total += 1
                        else: spray['unplaced'] += 1
                    else: spray['unplaced'] += 1
                    hit = bool(re.search(r'singled|doubled|tripled|homered', seg))
                    venue['home' if home else 'away']['PA'] += 1
                    month[mon]['PA'] += 1
    placed = sum(v for k, v in spray.items() if k != 'unplaced')
    omitted = spray.get('unplaced', 0)
    return {'bats': bats, 'spray': {k: v for k, v in spray.items() if k != 'unplaced'},
            'count': {k: dict(v) for k, v in count.items()},
            'pa_seen': pa_total,
            # Spray is only as complete as the text: Presto often writes "singled"
            # with no direction. Those balls are omitted, never guessed, and the
            # count travels with the numbers so a card can print it.
            'spray_placed': placed, 'spray_omitted': omitted, 'spray_bip': placed + omitted,
            'spray_note': (f'{placed} of {placed + omitted} balls in play located; '
                           f'{omitted} omitted — no direction recorded')}


def avg(d):
    return ('%.3f' % (d.get('H', 0) / d['AB'])).replace('0.', '.') if d.get('AB') else '—'


if __name__ == '__main__':
    names = sys.argv[1:]
    if not names:
        names = [p['name'] for p in json.load(open(os.path.join(ROOT, 'data/active-batch.json')))['players']
                 if p['role'] in ('b', 'both')]
    for n in names:
        r = batter_splits(n)
        sp = r['spray']
        print(f"\n{n}  (bats {r['bats']})")
        if r['spray_placed']:
            print('  SPRAY   ' + '  '.join(
                f"{k} {sp.get(k,0)} ({100*sp.get(k,0)/r['spray_placed']:.0f}%)"
                for k in ('pull', 'center', 'oppo')))
            print(f"          {r['spray_note']}")
        for k in ('first pitch', 'ahead', 'even', 'behind', 'two-strike'):
            d = r['count'].get(k)
            if d: print(f"  {k:12} {d['PA']:3} PA   {d.get('H',0):2} H / {d.get('AB',0):2} AB   AVG {avg(d)}")
        print(f"  gate: plate appearances seen {r['pa_seen']}")
