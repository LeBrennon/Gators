#!/usr/bin/env python3
"""
build-league-ranks.py — self-computed league ranks, hitting AND pitching,
off the owner's own complete league stat export (data/league-stats/).

  python3 scripts/build-league-ranks.py   -> data/league-ranks-computed.json

Replaces dependence on texasleaguestats.prestosports.com for RANKS. That site
has proven unreliable from two directions this season: its bulk leaderboard
pages are Cloudflare-blocked from this dev environment, and it separately went
down with a site-wide 500 servlet crash the owner hit directly in a real
browser. It also never publishes pitching ranks on any page at all — this
script is what lets a pitcher card carry a rank for the first time.

official_line() in player-season-data.py is UNTOUCHED and keeps reading the
old Presto-sourced data/league-ranks.json for headline numbers. That is a
separate concern from ranking (which number prints vs. which numbers get a
gold badge) and was not part of what this rework changes.

QUALIFIERS. A rate stat computed on a tiny sample can look extreme without
being real — a hitter with 1 AB batting 1.000, a pitcher with 1 IP and a 0.00
ERA. A counting stat mostly doesn't have that problem: nobody racks up 20 HR
in 5 games. So only rate-shaped stats are gated, at thresholds the owner set
after checking what a real comparable league uses (Cape Cod League — a summer
wood-bat league of similar season length):

  - AVG / OBP / SLG: 50 AB minimum.
  - Every pitching stat where a LOW value is what's being celebrated (ERA,
    WHIP, BB/H/HR/HBP allowed, and their /9 and % derivatives): 25 IP,
    Cape Cod's own standard. A "lower is better" stat is NOT self-limiting by
    playing time the way a counting stat is — a pitcher who throws 0.1 IP
    and allows 0 hits hasn't demonstrated anything, so these need the same
    guard rate stats do.
  - Every pitching stat where a HIGH value is celebrated (W, SV, K, APP, GS,
    IP, BF, K/9, K%, K:BB) needs no qualifier — it takes real accumulated
    playing time to rack up strikeouts or wins, the same reasoning that
    already exempts HR/RBI/SB from a qualifier on the hitting side.
  - L (losses) is not ranked at all: not a meaningful skill signal on its
    own, the same reason GIDP isn't ranked for hitters.

Competition ranking throughout: tied values share a rank, and the next
distinct value skips ahead by the tie's size (two people tied for 3rd, next
is 5th) — matches how the site's own ranks read.
"""
import glob, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATS_DIR = os.path.join(ROOT, 'data', 'league-stats')
OUT = os.path.join(ROOT, 'data', 'league-ranks-computed.json')

AB_MIN = 50
IP_MIN = 25

# Matt Scott's card is a full season across two clubs (Brazos Valley, then
# Lake Charles) by owner decision, so no single team's own CSV export holds
# his real total — the two rows this dataset actually has for him ("Matt
# Scott" at Brazos Valley, "Matthew Scott" at Lake Charles, spelled
# differently because that's how each club's own export spells him) sum to
# MORE than his true season: Brazos Valley's export still credits a 7/8 game
# the league's own transactions log says he wasn't rostered for that day
# (see EXCLUDE_GAMES in player-season-data.py). Rather than leave him
# unranked forever for a data-shape problem we can actually solve, his one
# true line — box-validated, PBP-reconciled, and already what his card prints
# — replaces both fragments below, so he competes for a rank on the same
# footing as everyone else. Refresh this by re-running
# `python3 scripts/player-season-data.py "Matt Scott" --batter` if his
# underlying box data (or the excluded-game ruling) ever changes.
MATT_SCOTT_HIT_LINE = {
    'gp': 32, 'pa': 137, 'ab': 120, 'h': 34, '2b': 11, '3b': 2, 'hr': 3,
    'rbi': 25, 'r': 25, 'bb': 13, 'k': 37, 'hbp': 1, 'sf': 2, 'sb': 6, 'cs': 2,
    'tb': 58, 'avg': .283, 'obp': .353, 'slg': .483,
}

# label -> raw key. 'hit' combines the batting + running CSVs (running's own
# gp is dropped at merge time, so 'gp' below is always batting's).
# G, PA, AB, SF deliberately absent: owner's call, no rank wanted on them.
HIT_KEYS = {'H': 'h', '2B': '2b', '3B': '3b',
            'HR': 'hr', 'RBI': 'rbi', 'R': 'r', 'BB': 'bb', 'K': 'k', 'HBP': 'hbp',
            'SB': 'sb', 'CS': 'cs', 'TB': 'tb',
            'AVG': 'avg', 'OBP': 'obp', 'SLG': 'slg'}
HIT_RATE = {'avg', 'obp', 'slg'}   # need AB_MIN

# label -> raw/derived key, for the pitching side.
# IP, APP, GS, BF, HBP, BB, K%, BB%, H, HR, HR/9 deliberately absent: owner's call,
# no rank wanted on them. IP/BF/BB/H/HR still feed every derived rate
# (k9/bb9/h9/hr9/kpct/bbpct/kbb) and IP still gates the IP_MIN qualifier below
# — only the badges on the raw stats themselves are suppressed.
PITCH_KEYS = {'W': 'w', 'SV': 'sv',
              'ERA': 'era', 'WHIP': 'whip', 'K': 'k',
              'K/9': 'k9', 'BB/9': 'bb9', 'H/9': 'h9', 'K:BB': 'kbb'}
# lower value = better rank. Everything else in PITCH_KEYS sorts descending.
# (Only keys still in PITCH_KEYS matter here — extra entries are harmless but
# keep this trimmed to what's actually rankable, for clarity.)
PITCH_ASC = {'era', 'whip', 'bb9', 'h9'}
# needs IP_MIN before it can rank: every ascending pitching stat, plus the
# high-is-better RATE stats (k9, kbb) which are just as fluke-prone on a tiny
# sample as an ascending one.
PITCH_QUALIFY = PITCH_ASC | {'k9', 'kbb'}


def num(v):
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_ip(v):
    """Baseball innings notation: 'X.1'/'X.2' means X plus 1 or 2 OUTS, not a
    decimal tenth — '45.2' is 45 and two-thirds innings (45.667), not 45.2.
    Matches player-season-data.py's own outs-based parse exactly, since a
    naive float() understates every fractional inning and throws off every
    rate stat computed from it (ERA, WHIP, K/9, the IP qualifier itself)."""
    if v is None:
        return None
    try:
        whole, _, frac = str(v).partition('.')
        outs = int(whole) * 3 + (int(frac) if frac else 0)
        return outs / 3
    except (TypeError, ValueError):
        return None


def fmt_int(v):
    return str(int(round(v)))


def fmt3(v):
    # matches player-season-data.py's own f3() exactly, since the "must equal
    # the card's own printed number" gate is a literal string comparison
    return ('%.3f' % v).replace('0.', '.')


def fmt2(v):
    return '%.2f' % v


def fmt1(v):
    return '%.1f' % v


def fmt_ip(v):
    # inverse of parse_ip: decimal innings back to baseball's X.1/X.2 notation
    outs = round(v * 3)
    return f'{outs // 3}.{outs % 3}' if outs % 3 else str(outs // 3)


def load_all_teams():
    players = []
    for path in sorted(glob.glob(os.path.join(STATS_DIR, '*.json'))):
        d = json.load(open(path))
        for name, p in d['players'].items():
            players.append({'name': name, 'team': d['team'],
                             'batting': p.get('batting') or {},
                             'running': p.get('running') or {},
                             'pitching': p.get('pitching') or {}})
    return players


def build_hit_line(p):
    b, r = p['batting'], p['running']
    if not b and not r:
        return None
    line = {}
    for k in ('gp', 'pa', 'ab', 'h', '2b', '3b', 'hr', 'rbi', 'bb', 'k', 'hbp', 'sf', 'avg', 'obp', 'slg'):
        line[k] = num(b.get(k))
    for k in ('r', 'tb', 'sb', 'cs'):
        line[k] = num(r.get(k))
    return line


def build_pitch_line(p):
    pt = p['pitching']
    if not pt:
        return None
    ip = parse_ip(pt.get('ip'))
    bf = num(pt.get('bf'))
    k, bb, h, hr = num(pt.get('k')), num(pt.get('bb')), num(pt.get('h')), num(pt.get('hr'))
    line = {'app': num(pt.get('app')), 'gs': num(pt.get('gs')), 'w': num(pt.get('w')),
            'sv': num(pt.get('sv')), 'ip': ip, 'bf': bf,
            'era': num(pt.get('era')), 'whip': num(pt.get('whip')),
            'k': k, 'bb': bb, 'h': h, 'hr': hr, 'hbp': num(pt.get('hbp'))}
    if ip:
        line['k9'] = 9 * k / ip if k is not None else None
        line['bb9'] = 9 * bb / ip if bb is not None else None
        line['h9'] = 9 * h / ip if h is not None else None
        line['hr9'] = 9 * hr / ip if hr is not None else None
    if bf:
        line['kpct'] = 100 * k / bf if k is not None else None
        line['bbpct'] = 100 * bb / bf if bb is not None else None
    if bb:
        line['kbb'] = k / bb if k is not None else None
    return line


def qualifies(stat_key, line, qualify_set, min_ip):
    if stat_key not in qualify_set:
        return True
    ip = line.get('ip')
    return ip is not None and ip >= min_ip


def rank_all(entries, stat_key, ascending, qualify_set, qualifier_field, min_val):
    """entries: [(name, line)]. Returns {name: rank_int} for qualifying entries with a value."""
    pool = []
    for name, line in entries:
        v = line.get(stat_key)
        if v is None:
            continue
        if stat_key in qualify_set:
            gv = line.get(qualifier_field)
            if gv is None or gv < min_val:
                continue
        pool.append((name, v))
    pool.sort(key=lambda x: x[1], reverse=not ascending)
    ranks = {}
    prev_v, prev_rank = None, 0
    for i, (name, v) in enumerate(pool):
        rank = prev_rank if prev_v is not None and v == prev_v else i + 1
        prev_v, prev_rank = v, rank
        ranks[name] = rank
    return ranks


def ordinal(n):
    if 10 <= n % 100 <= 20:
        suf = 'th'
    else:
        suf = {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')
    return f'{n}{suf}'


def main():
    players = load_all_teams()
    print(f'{len(players)} players loaded across {len(set(p["team"] for p in players))} teams', file=sys.stderr)

    hit_lines = {p['name']: build_hit_line(p) for p in players}
    pitch_lines = {p['name']: build_pitch_line(p) for p in players}
    # Merge Matt Scott's two fragments into the one line that's actually his
    # season — see MATT_SCOTT_HIT_LINE's own comment for why. Dropping the
    # Lake Charles fragment ("Matthew Scott") rather than leaving it in the
    # pool matters: left in, it would keep competing as if it were a second,
    # separate player.
    hit_lines.pop('Matthew Scott', None)
    hit_lines['Matt Scott'] = dict(MATT_SCOTT_HIT_LINE)
    hit_entries = [(n, l) for n, l in hit_lines.items() if l]
    pitch_entries = [(n, l) for n, l in pitch_lines.items() if l]

    hit_ranks_by_stat = {}
    for stat_key in set(HIT_KEYS.values()):
        ascending = False  # every hitting stat that ranks at all is higher-is-better
        hit_ranks_by_stat[stat_key] = rank_all(
            hit_entries, stat_key, ascending,
            qualify_set=HIT_RATE, qualifier_field='ab', min_val=AB_MIN)

    pitch_ranks_by_stat = {}
    for stat_key in set(PITCH_KEYS.values()):
        ascending = stat_key in PITCH_ASC
        pitch_ranks_by_stat[stat_key] = rank_all(
            pitch_entries, stat_key, ascending,
            qualify_set=PITCH_QUALIFY, qualifier_field='ip', min_val=IP_MIN)

    def fmt_hit_value(stat_key, v):
        return fmt3(v) if stat_key in HIT_RATE else fmt_int(v)

    def fmt_pitch_value(stat_key, v):
        if stat_key == 'ip':
            return fmt_ip(v)
        if stat_key in ('era', 'whip', 'k9', 'bb9', 'h9', 'hr9', 'kbb'):
            return fmt2(v)
        if stat_key in ('kpct', 'bbpct'):
            return fmt1(v)
        return fmt_int(v)

    out_players = {}
    for p in players:
        name = p['name']
        rec = {'team': p['team']}
        hl = hit_lines.get(name)
        if hl:
            hit_ranks = {}
            hit_vals = {}
            for k in set(HIT_KEYS.values()):
                v = hl.get(k)
                if v is None:
                    continue
                hit_vals[k] = fmt_hit_value(k, v)
                r = hit_ranks_by_stat[k].get(name)
                if r:
                    hit_ranks[k] = ordinal(r)
            rec['hitLine'] = hit_vals
            rec['hitRanks'] = hit_ranks
        pl = pitch_lines.get(name)
        if pl:
            pitch_ranks = {}
            pitch_vals = {}
            for k in set(PITCH_KEYS.values()):
                v = pl.get(k)
                if v is None:
                    continue
                pitch_vals[k] = fmt_pitch_value(k, v)
                r = pitch_ranks_by_stat[k].get(name)
                if r:
                    pitch_ranks[k] = ordinal(r)
            rec['pitchLine'] = pitch_vals
            rec['pitchRanks'] = pitch_ranks
        out_players[name] = rec
    # The Lake Charles fragment has nothing of its own left to report — his
    # numbers live under 'Matt Scott' now — so drop the empty leftover entry
    # rather than ship a ghost row with a team and no stats.
    out_players.pop('Matthew Scott', None)

    out = {'built': None, 'source': f'{len(players)} players, all 8 TCL teams, data/league-stats/',
           'abMin': AB_MIN, 'ipMin': IP_MIN, 'players': out_players}
    import time
    out['built'] = int(time.time() * 1000)
    # sort_keys: HIT_KEYS/PITCH_KEYS are iterated via set(), whose order is not
    # stable run to run — without this every rebuild produced a full-file diff
    # of pure key reordering with no actual data change.
    json.dump(out, open(OUT, 'w'), indent=1, sort_keys=True)
    n_hit_ranked = sum(1 for r in out_players.values() if r.get('hitRanks'))
    n_pitch_ranked = sum(1 for r in out_players.values() if r.get('pitchRanks'))
    print(f'wrote {OUT}', file=sys.stderr)
    print(f'{n_hit_ranked} players with at least one hitting rank, {n_pitch_ranked} with at least one pitching rank', file=sys.stderr)


if __name__ == '__main__':
    main()
