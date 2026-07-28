#!/usr/bin/env python3
"""
batter-splits.py — vs-LHP / vs-RHP splits for any Gators hitter.

Pipeline (validated on Ayden Sunday, 2026 season):
  1. Parse play-by-play from box-seed.json. Process ONLY blocks whose title
     contains 'Gators' (Gators batting = opponent on the mound).
  2. Pitcher-on-mound attribution: the starter is the first name in the
     opponent's Pitching box table (decision suffixes like "(W, 1-0)" and
     ALL-CAPS formatting stripped); relievers tracked via "X to p [for Y]"
     swap events. Inning headers and "(1 out)" markers are stripped first.
  3. Cross-validate every game against the box-score H/BB/K columns
     (Sunday: 40/40 dates exact via the same classifier as the batter card).
  4. Join pitchers to data/league-throws.json (normalized name -> throws L/R).
     Built from the TCL gameday roster PDFs (pitchers section B/T column).
  5. Emit split lines: PA/AB/H/2B/3B/HR/BB/K/HBP, AVG/OBP/SLG/OPS, K%/BB%, BABIP.

Usage: python3 scripts/batter-splits.py "Sunday" [--json]
       python3 scripts/batter-splits.py "Sunday" --need-hands   # list pitchers missing throws data
"""
import json, re, sys, collections
from html.parser import HTMLParser

NAME = r"[A-Z][A-Za-z.'\-]*(?:\s+[A-Z][A-Za-z.'\-]*)*"
HDR_RE = re.compile(r"[A-Z][A-Za-z .&'\-]*?\b(?:Top|Bottom)\s+of\s+\d+(?:st|nd|rd|th)\s+Inning")
OUT_RE = re.compile(r"\(\d+\s*outs?\)")
SWAP_RE = re.compile(rf"({NAME}) to p(?: for ({NAME}))?")
DEC_RE = re.compile(r"\s*\([WLSV]+,\s*[\d-]+\)")

class Text(HTMLParser):
    def __init__(self): super().__init__(); self.t = []
    def handle_data(self, d): self.t.append(d)

class Table(HTMLParser):
    def __init__(self):
        super().__init__(); self.rows = []; self.cur = None; self.cell = None
    def handle_starttag(self, t, a):
        if t == 'tr': self.cur = []
        elif t in ('td', 'th') and self.cur is not None: self.cell = ''
    def handle_data(self, d):
        if self.cell is not None: self.cell += d
    def handle_endtag(self, t):
        if t in ('td', 'th') and self.cell is not None:
            self.cur.append(self.cell.strip()); self.cell = None
        elif t == 'tr' and self.cur is not None:
            if self.cur: self.rows.append(self.cur)
            self.cur = None

def norm(nm):
    s = DEC_RE.sub('', nm)
    s = s.split('. ')[-1] if '. ' in s and ' to p' not in s else s
    s = re.sub(r'\s+', ' ', s).strip().title()
    return s

def tkey(nm):  # lookup key for league-throws.json
    return re.sub(r'[^a-z ]', '', norm(nm).lower()).strip()

VERBS = ('sacrifice fly|sacrifice bunt|singled|doubled|tripled|homered|intentionally walked|walked|'
         'struck out|hit by pitch|reached on|reached first|grounded out|flied out|lined out|popped up|'
         'fouled out|infield fly|grounded into double play|out on batter.s interference|out at first')

def batter_events(player):
    pa_re = re.compile(re.escape(player) + r'\s+(?:' + VERBS + ')')
    sb_re = re.compile(re.escape(player) + r' stole (?:second|third|home)')
    cs_re = re.compile(re.escape(player) + r' out at \w+ [^.;]*?(?:caught stealing)')
    return pa_re, sb_re, cs_re

def main():
    args = sys.argv[1:]
    if not args: print(__doc__); sys.exit(1)
    last = args[0]
    as_json = '--json' in args
    need_hands = '--need-hands' in args

    boxes = json.load(open('box-seed.json'))['boxes']
    # find full player name from box tables
    player = None
    for g in boxes.values():
        for sec in g['data']['box']:
            if 'Gators' in sec['label'] and 'Batting' in sec['label']:
                p = Table(); p.feed(sec['html'])
                for r in p.rows:
                    if r and last.lower() in r[0].lower():
                        nm = re.sub(r'\s+', ' ', r[0])
                        nm = re.sub(r'^[a-z0-9]{1,3}\s+', '', nm); nm = re.sub(r'^[a-z]-', '', nm).strip()
                        player = nm
        if player: break
    if not player: print(f'player "{last}" not found'); sys.exit(1)

    pa_re, sb_re, cs_re = batter_events(player)

    splits = {'L': collections.defaultdict(int), 'R': collections.defaultdict(int)}
    box = collections.defaultdict(lambda: [0, 0, 0, 0, 0, 0])
    per_game = collections.defaultdict(lambda: collections.defaultdict(int))
    pitchers_seen = collections.Counter()
    unk = collections.Counter()

    throws = {}
    try:
        throws = json.load(open('data/league-throws.json'))['players']
    except Exception:
        pass

    for gid, g in sorted(boxes.items()):
        dt = gid[:8]
        starter = None
        for sec in g['data']['box']:
            if 'Pitching' in sec['label'] and 'Gators' not in sec['label']:
                p = Table(); p.feed(sec['html'])
                for r in p.rows:
                    if len(r) < 3 or 'Pitchers' in r[0]: continue
                    starter = norm(r[0]); break
        cur = starter
        has_pa = False
        for sec in g['data']['box']:
            if 'Gators' in sec['label'] and 'Batting' in sec['label']:
                p = Table(); p.feed(sec['html'])
                for r in p.rows:
                    if len(r) < 8: continue
                    nm = re.sub(r'\s+', ' ', r[0]); nm = re.sub(r'^[a-z0-9]{1,3}\s+', '', nm); nm = re.sub(r'^[a-z]-', '', nm).strip()
                    if nm == player:
                        for i in range(6): box[dt][i] += int(r[i + 1])
        for sec in g['data'].get('pbp', []):
            if 'Gators' not in sec['title']: continue
            p = Text(); p.feed(sec['html'])
            txt = re.sub(r'\s+', ' ', ' '.join(p.t))
            txt = HDR_RE.sub(' ', txt); txt = OUT_RE.sub(' ', txt)
            swaps = [(m.start(), norm(m.group(1))) for m in SWAP_RE.finditer(txt)]
            for m in pa_re.finditer(txt):
                while swaps and swaps[0][0] < m.start():
                    cur = swaps.pop(0)[1]
                # a PA by our player against cur
                has_pa = True
                hand = throws.get(tkey(cur or ''))
                pitchers_seen[cur or '?'] += 1
                S = splits[hand] if hand else collections.defaultdict(int)
                if not hand: unk[cur or '?'] += 1
                v = m.group(0)
                tail = txt[m.end():m.end() + 45].split(';')[0]
                if 'sacrifice fly' in tail and re.search(r'(flied|lined|popped) out', v):
                    S['SF'] += 1; per_game[dt]['SF'] += 1; continue
                if 'out at first' in v and ('picked off' in tail or 'caught stealing' in tail):
                    continue
                S['PA'] += 1
                if 'struck out' in v: S['K'] += 1; S['AB'] += 1; per_game[dt]['K'] += 1; per_game[dt]['AB'] += 1
                elif 'walked' in v: S['BB'] += 1; per_game[dt]['BB'] += 1
                elif 'hit by pitch' in v: S['HBP'] += 1
                elif 'singled' in v: S['1B'] += 1; S['H'] += 1; S['AB'] += 1; per_game[dt]['H'] += 1; per_game[dt]['AB'] += 1
                elif 'doubled' in v: S['2B'] += 1; S['H'] += 1; S['AB'] += 1; per_game[dt]['H'] += 1; per_game[dt]['AB'] += 1
                elif 'tripled' in v: S['3B'] += 1; S['H'] += 1; S['AB'] += 1; per_game[dt]['H'] += 1; per_game[dt]['AB'] += 1
                elif 'homered' in v: S['HR'] += 1; S['H'] += 1; S['AB'] += 1; per_game[dt]['H'] += 1; per_game[dt]['AB'] += 1
                elif 'sacrifice bunt' in v: S['SH'] += 1
                elif 'sacrifice fly' in v: S['SF'] += 1
                else: S['AB'] += 1; per_game[dt]['AB'] += 1

    # validation: per-date AB/H/BB/K vs box
    bad = 0
    for dt in sorted(box):
        ab, r, h, rbi, bb, k = box[dt]
        p = per_game[dt]
        if p['AB'] != ab or p['H'] != h or p['BB'] != bb or p['K'] != k:
            bad += 1
            print(f'MISMATCH {dt} box AB/H/BB/K {ab}/{h}/{bb}/{k} vs pbp {p["AB"]}/{p["H"]}/{p["BB"]}/{p["K"]}')

    if need_hands:
        print(f'Pitchers faced by {player} without throws data ({len(unk)}):')
        for nm, c in unk.most_common(): print(f'  {c:3d} PA  {nm}  [{tkey(nm)}]')
        return

    def slash(S):
        ab, h = S['AB'], S['H']
        pa = S['PA'] + S['SF']  # SF events skip the PA increment above; HBP/SH are already counted
        tb = S['1B'] + 2 * S['2B'] + 3 * S['3B'] + 4 * S['HR']
        avg = h / ab if ab else 0
        obp = (h + S['BB'] + S['HBP']) / pa if pa else 0
        slg = tb / ab if ab else 0
        babip = (h - S['HR']) / (ab - S['K'] - S['HR'] + S['SF']) if (ab - S['K'] - S['HR'] + S['SF']) else 0
        return {'PA': pa, 'AB': ab, 'H': h, '2B': S['2B'], '3B': S['3B'], 'HR': S['HR'],
                'BB': S['BB'], 'K': S['K'], 'HBP': S['HBP'],
                'AVG': round(avg, 3), 'OBP': round(obp, 3), 'SLG': round(slg, 3),
                'OPS': round(obp + slg, 3), 'K%': round(100 * S['K'] / pa, 1) if pa else 0,
                'BB%': round(100 * S['BB'] / pa, 1) if pa else 0, 'BABIP': round(babip, 3)}

    out = {'batter': player, 'games': len(box), 'validation': f'{len(box) - bad}/{len(box)} dates exact',
           'unknown_pitcher_hands': dict(unk), 'vs_LHP': slash(splits['L']), 'vs_RHP': slash(splits['R'])}
    if as_json:
        print(json.dumps(out, indent=1))
    else:
        print(f"{player} — validation {out['validation']}")
        for side in ('vs_LHP', 'vs_RHP'):
            s = out[side]
            print(f"{side}: {s['PA']} PA  {s['AVG']:.3f}/{s['OBP']:.3f}/{s['SLG']:.3f}  OPS {s['OPS']:.3f}  "
                  f"H{s['H']} 2B{s['2B']} 3B{s['3B']} HR{s['HR']} BB{s['BB']} K{s['K']} HBP{s['HBP']}")
        if unk: print(f'NOTE: {sum(unk.values())} PA vs {len(unk)} pitchers excluded from splits (unknown hand). Run --need-hands.')

if __name__ == '__main__':
    main()
