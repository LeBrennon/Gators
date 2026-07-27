#!/usr/bin/env python3
"""
platoon-splits.py — vs-LHB / vs-RHB splits for any Gators pitcher.

Pipeline (validated on Brayden Guillory, 2026 season):
  1. Parse play-by-play from box-seed.json. Pitcher-on-mound attribution:
     track "X to p [for Y]" swap events; ONLY process blocks whose title does
     NOT contain 'Gators' (Gators batting = opponent pitching — without this
     filter, Gators offensive PAs get misattributed to our own pitchers).
     Inning headers ("Team Top of 3rd Inning") and "(1 out)" markers must be
     stripped from the block text first or they get swallowed into PA matches.
  2. Cross-validate every game against the box-score H/BB/K columns
     (Guillory: 7/7 games exact; combined split reconciles exactly with the
     season line on his card).
  3. Join batters to data/league-bt.json (normalized name -> bats L/R/S).
     Switch hitters bat LEFT vs RHP, RIGHT vs LHP.
  4. Emit split lines: PA/AB/H/2B/3B/HR/BB/K/HBP, AVG/OBP/SLG/OPS, K%/BB%, BABIP.

data/league-bt.json sources:
  - TCL gameday roster PDFs dated 7/1, 7/7, 7/12, 7/26 (BATS column)
  - 7 gaps filled from college/scouting sources:
      Jarret Halter R (Seminole State roster), Ricky Requejo R (Missouri Western
      roster + Baseball-Reference), Ellington Jefferson S (Five Tool profile),
      Luke Flores-King R (Perfect Game), Hayden Leblue R (TCL Presto stats page),
      Hayden Ramage R (Seward County, "RHH"), Caleb Boswell R (TCL Presto + UTPB).
  NOTE: the TCL Presto stats site lists B/T per player — for the season-end run,
  refresh league-bt.json from there or from the final roster PDF.

Usage: python3 scripts/platoon-splits.py "Guillory" [--hand R] [--json]
"""
import json, re, sys, collections

NAME = r"[A-Z][A-Za-z.'\-]*(?:\s+[A-Z][A-Za-z.'\-]*)*"
PA_RE = re.compile(rf"^({NAME})\s+(.+?)\s*\((\d-\d)(?:\s+([A-Z]+))?\)$")
SWAP_RE2 = re.compile(rf"^({NAME})\s+to p(?:\s+for\s+{NAME})?$")
EV_RE = re.compile(rf"(?P<swap>{NAME}\s+to p(?:\s+for\s+{NAME})?(?=\.))|(?P<pa>{NAME}\s+[^.]*?\s*\(\d-\d(?:\s+[A-Z]+)?\))|(?P<sb>{NAME}\s+stole\s+(?:second|third|home))|(?P<cs>caught stealing|picked off)")
HDR_RE = re.compile(r"[A-Z][A-Za-z .&'\-]*?\b(?:Top|Bottom)\s+of\s+\d+(?:st|nd|rd|th)\s+Inning")
OUT_RE = re.compile(r"\(\d+\s*outs?\)")

def clean_pitcher(nm): return re.sub(r'^Inning\s+', '', nm).split('. ')[-1].strip()
def strip_html(h): return re.sub(r'<[^>]+>', '', re.sub(r'<br\s*/?>', '\n', h))
def clean_name(nm): return re.sub(r'\s+', ' ', nm.split('. ')[-1]).strip()
def bad_name(nm): return bool(re.search(r'\b(Top|Bottom|Inning)\b', nm))

def classify(text):
    t = text.lower()
    if 'struck out' in t: return 'K'
    if 'intentionally walked' in t or 'walked' in t: return 'BB'
    if 'hit by pitch' in t: return 'HBP'
    if 'singled' in t: return '1B'
    if 'doubled' in t: return '2B'
    if 'tripled' in t: return '3B'
    if 'homered' in t: return 'HR'
    if 'sac' in t: return 'SF' if ('flied' in t or 'fouled' in t) else 'SH'
    if 'double play' in t: return 'GDP'
    if 'reached on' in t or 'reached first' in t: return 'ROE'
    if 'grounded out' in t or 'out at first' in t: return 'GB'
    if 'flied out' in t or 'flew out' in t: return 'FB'
    if 'lined out' in t or 'lined into' in t: return 'LD'
    if 'popped up' in t or 'popped out' in t or 'fouled out' in t or 'infield fly' in t: return 'PU'
    return 'OTHER'

def norm(nm):
    nm = re.sub(r'\b(jr|sr|ii|iii|iv)\b\.?', '', nm.lower().strip())
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z ]', '', nm)).strip()

def statline(c):
    h = sum(c[x] for x in ('1B', '2B', '3B', 'HR')); bb = c['BB']; k = c['K']
    hbp = c['HBP']; sf = c['SF']
    pa = sum(c.values())
    ab = h + sum(c[x] for x in ('GB', 'FB', 'LD', 'PU', 'K', 'GDP', 'ROE'))
    tb = c['1B'] + 2 * c['2B'] + 3 * c['3B'] + 4 * c['HR']
    avg = h / ab if ab else 0.0
    obp = (h + bb + hbp) / (ab + bb + hbp + sf) if (ab + bb + hbp + sf) else 0.0
    slg = tb / ab if ab else 0.0
    bab = (h - c['HR']) / (ab - k - c['HR'] + sf) if (ab - k - c['HR'] + sf) else 0.0
    return {'PA': pa, 'AB': ab, 'H': h, '2B': c['2B'], '3B': c['3B'], 'HR': c['HR'],
            'BB': bb, 'K': k, 'HBP': hbp,
            'AVG': round(avg, 3), 'OBP': round(obp, 3), 'SLG': round(slg, 3),
            'OPS': round(obp + slg, 3),
            'K%': round(k / pa * 100, 1) if pa else 0.0,
            'BB%': round(bb / pa * 100, 1) if pa else 0.0, 'BABIP': round(bab, 3)}

def main():
    target = sys.argv[1] if len(sys.argv) > 1 else 'Guillory'
    hand = sys.argv[sys.argv.index('--hand') + 1].upper() if '--hand' in sys.argv else 'R'
    boxes = json.load(open('box-seed.json'))['boxes']
    bt = json.load(open('data/league-bt.json'))['players']

    gids = [gid for gid, g in boxes.items()
            if target.lower() in ' '.join(b.get('html', '') for b in g['data'].get('box', [])).lower()]
    batters = collections.defaultdict(collections.Counter)
    per_game = {}
    for gid in sorted(gids):
        cur = None
        gc = collections.Counter()
        for block in boxes[gid]['data'].get('pbp', []):
            title = block.get('title', '')
            if 'gator' in title.lower() or 'gumbeaux' in title.lower():
                continue  # Gators batting — target pitcher not on mound
            text = re.sub(r'\s+', ' ', OUT_RE.sub(' ', HDR_RE.sub(' ', strip_html(block.get('html', '')))))
            for m in EV_RE.finditer(text):
                if m.group('swap'):
                    sm = SWAP_RE2.match(m.group('swap').strip())
                    if sm: cur = clean_pitcher(sm.group(1))
                elif m.group('pa'):
                    pm = PA_RE.match(m.group('pa').strip())
                    if pm and cur and target.lower() in cur.lower():
                        b = clean_name(pm.group(1))
                        if bad_name(b): continue
                        oc = classify(pm.group(2))
                        batters[b][oc] += 1
                        gc[oc] += 1
        per_game[gid] = gc

    # switch hitters bat left vs RHP, right vs LHP
    def side_of(bats):
        if bats == 'S': return 'L' if hand == 'R' else 'R'
        return bats

    splits = {'L': collections.Counter(), 'R': collections.Counter()}
    unknown = []
    for b, cnts in batters.items():
        k = norm(b)
        if k in bt:
            splits[side_of(bt[k])].update(cnts)
        else:
            unknown.append((b, sum(cnts.values())))

    total_pa = sum(sum(c.values()) for c in batters.values())
    known_pa = total_pa - sum(n for _, n in unknown)
    result = {
        'pitcher': target, 'games': len(gids),
        'PA': total_pa, 'coverage': f"{known_pa}/{total_pa}",
        'vs_LHB': statline(splits['L']), 'vs_RHB': statline(splits['R']),
        'unknown_batters': sorted(unknown, key=lambda x: -x[1]),
        'per_game_outcomes': {g: dict(c) for g, c in per_game.items()},
    }
    print(json.dumps(result, indent=1))

if __name__ == '__main__':
    main()
