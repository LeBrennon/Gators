#!/usr/bin/env python3
"""
player-season-data.py — build card DATA (JSON) for any Gators player.

  python3 scripts/player-season-data.py "Ramos"  --batter  > /tmp/ramos.json
  python3 scripts/player-season-data.py "Rider"  --pitcher > /tmp/rider.json

Validation discipline (same as the Sunday/Guillory cards):
  - Batter: per-date AB/H/BB/K from PBP must equal box columns (Sunday: 40/40).
  - Pitcher: per-game H/BB/K from PBP (batting against) must equal box pitching
    columns. IP/#P/S% come straight from the box (authoritative).
  - Splits EXCLUDE unknown-hand PAs (never guessed).
Sources: box-seed.json, data/batch-roster.json (bios), data/league-throws.json,
data/league-bt.json (batter bats for pitcher splits), photos/manifest.json.
"""
import json, re, sys, collections, glob, os
from html.parser import HTMLParser

NAME = r"[A-Z][A-Za-z.'\-]*(?:\s+[A-Z][A-Za-z.'\-]*)*"
HDR_RE = re.compile(r"[A-Z][A-Za-z .&'\-]*?\b(?:Top|Bottom)\s+of\s+\d+(?:st|nd|rd|th)\s+Inning")
OUT_RE = re.compile(r"\(\d+\s*outs?\)")
SWAP_RE = re.compile(rf"({NAME}) to p(?: for ({NAME}))?")
# Presto writes saves as "(Sv, 1)" — lowercase v. Missing it left the suffix on
# the name, so the pitcher never matched himself and the whole save appearance
# dropped out of his card.
DEC_RE = re.compile(r"\s*\(([WLSVwlsv]+),\s*([\d-]+)\)$")
POS_RE = r'(?:(?:ph|pr|c|1b|2b|3b|ss|lf|cf|rf|dh|of|p)/)*(?:ph|pr|c|1b|2b|3b|ss|lf|cf|rf|dh|of|p)'
MON = {'01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr', '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Aug'}
# The Gators are an opponent too, on a card covering another club's games.
SHORT = {'Lake Charles Gumbeaux Gators': 'Lake Charles', 'Abilene Flying Bison': 'Abilene', 'Baton Rouge Rougarou': 'Baton Rouge', 'Acadiana Cane Cutters': 'Acadiana',
         'Victoria Generals': 'Victoria', 'Sherman Shadowcats': 'Sherman', 'Brazos Valley Bombers': 'Brazos Valley',
         'San Antonio River Monsters': 'San Antonio'}
# Short club codes for the game log's Tm column on a multi-stint card.
CLUB = {'Lake Charles Gumbeaux Gators': 'LC', 'Brazos Valley Bombers': 'BV',
        'Abilene Flying Bison': 'ABI', 'Baton Rouge Rougarou': 'BR',
        'Acadiana Cane Cutters': 'ACA', 'Victoria Generals': 'VIC',
        'Sherman Shadowcats': 'SHE', 'San Antonio River Monsters': 'SA'}
ABBR = {'Lake Charles Gumbeaux Gators': 'LC', 'Abilene Flying Bison': 'ABI', 'Baton Rouge Rougarou': 'BR', 'Acadiana Cane Cutters': 'ACA',
        'Victoria Generals': 'VIC', 'Sherman Shadowcats': 'SHE', 'Brazos Valley Bombers': 'BV',
        'San Antonio River Monsters': 'SA'}

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

def clean(nm):
    nm = re.sub(r'\s+', ' ', nm).strip()
    if '. ' in nm: nm = nm.split('. ')[-1].strip()  # PBP swap names can glue across sentences
    nm = DEC_RE.sub('', nm)
    nm = re.sub(rf'^{POS_RE}\s+[a-z]-\s*', '', nm)
    nm = re.sub(rf'^{POS_RE}\s*(?=[A-Z])', '', nm)
    nm = re.sub(r'^[a-z]-\s*', '', nm).strip()
    if nm == 'Landon Hennan': nm = 'Landon Hennen'
    return nm

def tkey(nm): return re.sub(r'[^a-z ]', '', nm.lower()).strip()

_MANIFEST = None
def photo_slug(player):
    global _MANIFEST
    if _MANIFEST is None:
        try: _MANIFEST = json.load(open('photos/manifest.json'))
        except Exception: _MANIFEST = {}
    base = re.sub(r'[^a-z]', '', player.lower())
    hits = sorted(glob.glob(f'photos/{base}*.*'))
    hits = [h for h in hits if h.rsplit('.', 1)[-1].lower() in ('webp', 'jpg', 'jpeg', 'png', 'avif')]
    if hits: return os.path.basename(hits[0]).rsplit('.', 1)[0]
    keys = list(_MANIFEST) if isinstance(_MANIFEST, dict) else []
    for k in keys:
        if not k.startswith(base): continue
        # The manifest key is a Presto slug, not a filename — a transferred
        # player's headshot sits under his previous team's slug (Matthew Scott
        # is filed as mattscottjzw4.webp). Hand back the stem of the file the
        # manifest points at, since the templates glob photos/<stem>.<ext>;
        # returning the key would render an empty headshot frame.
        stem = str(_MANIFEST[k]).rsplit('/', 1)[-1].rsplit('.', 1)[0]
        if stem and glob.glob(f'photos/{stem}.*'): return stem
        return k
    return base

BOX = json.load(open('box-seed.json'))['boxes']
# A player who transferred mid-season played games this club's seed never saw.
# data/prior-stint-seed.json holds those boxes (same shape, fetched through the
# live site's box proxy) so a full-season card can span both teams.
# late-box-repair.json carries a finished game whose line score Presto never
# rendered, with the team names recovered from its own play-by-play titles.
RESULTS = {}
for _extra in ('data/prior-stint-seed.json', 'data/late-box-repair.json'):
    try:
        for _gid, _g in json.load(open(_extra))['boxes'].items():
            BOX.setdefault(_gid, _g)      # never shadow a validated box-seed game
            if _g.get('repair'): RESULTS[_gid] = _g['repair']['score']
    except FileNotFoundError:
        pass
ROSTER = json.load(open('data/batch-roster.json'))['players']

GATORS = 'Lake Charles Gumbeaux Gators'
# One player, more than one spelling in the sources. Presto's own name for a
# player can change when he changes clubs, so a full-season card has to match
# both — Matthew Scott is "Matt Scott" in every Brazos Valley box.
ALIASES = {
    'Matt Scott': ['Matthew Scott'],       # the Gators box spells him Matthew; the club calls him Matt
    'Landon Hennen': ['Landon Hennan'],
}
# Sources that contradict each other on who batted, left unresolved on purpose.
#
# 7/8 at Brazos Valley: the box has Matt Scott in left field with 3 AB / 2 H /
# 2 BB / 3 RBI and no Castillo row; the play-by-play for that same lineup slot
# names Eddie Castillo throughout and never mentions Scott. This was briefly
# resolved in Scott's favour on the grounds that Castillo appeared nowhere else
# — but the league's own gameday roster for 7/7 lists Eddie Castillo on the
# Brazos Valley roster, wearing the #8 that had been Scott's, so he was there
# the day before. Presto's player page for Scott does carry the game, but that
# page is built from the same box, so it is not independent evidence.
#
# The counting stats still come from the box line, which is what Presto's own
# season totals reflect. The play-by-play detail for those five plate
# appearances is NOT claimed for either player, so the game shows as a
# reconciliation mismatch rather than being quietly assigned to the wrong man.
GAME_ALIASES = {}

def aka(player, gid=None):
    return [player] + ALIASES.get(player, []) + (GAME_ALIASES.get((gid, player), []) if gid else [])

def is_player(name, player):
    return clean(name) in aka(player)

def canonical(name):
    """The name the card should print. Presto's spelling varies by club and the
    owner's roster is the authority — the Gators box says "Matthew Scott", the
    club (and his card) says "Matt Scott"."""
    n = clean(name)
    for canon, alts in ALIASES.items():
        if n == canon or n in alts: return canon
    return n

_TEAMS = {}
def team_of(gid, player):
    """Which club the player appeared for in this game.

    Everything downstream — his batting line, which half-innings are his team's,
    who the opponent was, whether the result was a win — used to assume the
    Gators. For a transferred player it has to follow him, so it is read off the
    box itself: his team is whichever side lists him.
    """
    k = (gid, player)
    if k in _TEAMS: return _TEAMS[k]
    found = None
    for sec in BOX[gid]['data']['box']:
        p = Table(); p.feed(sec['html'])
        if any(r and is_player(r[0], player) for r in p.rows):
            found = sec['label'].split('—')[0].strip(); break
    _TEAMS[k] = found
    return found

import fielding
_FIELD = None
POS_LABEL = {'p': 'P', 'c': 'C', '1b': '1B', '2b': '2B', '3b': '3B', 'ss': 'SS',
             'lf': 'LF', 'cf': 'CF', 'rf': 'RF'}

def all_fielding():
    """Fielding totals across every club a player appeared for.

    The Gators run comes off box-seed.json. A prior stint is a different club in
    a different set of boxes, so it needs its own run with that club's name —
    "we're in the field" is decided by the team in the half-inning title. Alias
    spellings are folded onto the canonical name so one player's two stints add
    up instead of sitting in two buckets.
    """
    tot = fielding.season()[0]
    try:
        prior = json.load(open('data/prior-stint-seed.json'))['boxes']
    except FileNotFoundError:
        return tot
    teams = {t for g in prior.values() for t in g['data'].get('teams', []) if t != GATORS}
    for team in sorted(teams):
        games = {gid: g for gid, g in prior.items() if team in g['data'].get('teams', [])}
        for who, counts in fielding.season(box=games, team=team)[0].items():
            for k, v in counts.items(): tot[who][k] += v
    for canon, alts in ALIASES.items():                        # fold "Matt Scott" into "Matthew Scott"
        for alt in alts:
            if alt in tot:
                for k, v in tot[alt].items(): tot[canon][k] += v
    return tot

def defense(player, where, mobile):
    """Defensive rows for a card panel, print only — PO/A/E/FLD%/PO-per-game.

    `where` is 'field' for a position player's card and 'p' for a pitcher's, so
    a two-way player's two cards each report the glove work that belongs to it.
    Returns ([], '') when there is nothing to show (mobile cards, or a player
    with no chances in that role), leaving the panel exactly as it was. The
    numbers come from fielding.py, which rebuilds them from the play-by-play.
    """
    global _FIELD
    if mobile: return [], ''                                   # print cards only
    if _FIELD is None: _FIELD = all_fielding()
    s = fielding.summary(_FIELD, player, where)
    if not s['G'] or not s['CH']: return [], ''
    # "/" not " · " — the card templates split panel legends on " · ", so a
    # middot inside one definition would break the list into separate entries.
    spots = '/'.join(POS_LABEL.get(p, p.upper()) for p in s['POS'])
    rows = [['PO', str(s['PO'])], ['PO/G', s['POG']], ['A', str(s['A'])],
            ['E', str(s['E'])], ['FLD%', s['FLD']]]
    legend = (f'PO = putouts · A = assists · E = errors · FLD% = fielding pct ((PO+A) ÷ chances) · '
              f'PO/G = putouts per game{" at " + spots if spots else ""} ({s["G"]} G)')
    # Catchers get the throwing game too. Labels stay spelled out so they read
    # apart from the SB/CS rows just above them, which are his own base running.
    if s['GC'] and s['ATT']:
        rows += [['Runners CS', str(s['CS'])], ['Steals allowed', str(s['SBA'])], ['CS%', s['CSPCT']]]
        if s['PKO']: rows.append(['Pickoffs', str(s['PKO'])])
        legend += (f' · Runners CS = runners he threw out stealing · CS% = caught stealing rate '
                   f'(CS ÷ {s["ATT"]} attempts in {s["GC"]} G behind the plate)'
                   + (' · Pickoffs counted separately, as the league counts them' if s['PKO'] else ''))
    return rows, legend

THROWS = json.load(open('data/league-throws.json'))['players']
BATS = json.load(open('data/league-bt.json'))['players']
GATOR_KEYS = {tkey(n) for n in ROSTER}

import difflib
_FUZZ = {}
def lookup(table, nm):
    """exact key, then close spelling match (PBP vs roster spelling variants)"""
    k = tkey(nm)
    if k in table: return table[k]
    if k in _FUZZ: return _FUZZ[k]
    close = difflib.get_close_matches(k, table.keys(), n=1, cutoff=0.88)
    v = table[close[0]] if close else None
    _FUZZ[k] = v
    return v

def find_player(last, table_kind):
    # Prefer a Gators row: a transferred player appears in two clubs' tables and
    # the Gators spelling is the one the roster and bios are keyed to.
    fallback = None
    for pass_gators in (True, False):
        for g in BOX.values():
            for sec in g['data']['box']:
                if table_kind not in sec['label']: continue
                if pass_gators and 'Gators' not in sec['label']: continue
                p = Table(); p.feed(sec['html'])
                for r in p.rows:
                    if r and last.lower() in r[0].lower():
                        if pass_gators: return clean(r[0])
                        fallback = fallback or clean(r[0])
    return fallback

def game_meta(g, team=GATORS, gid=None):
    teams = g['data']['teams']
    gi = teams.index(team)
    opp = teams[1 - gi]; home = gi == 1
    short = team.split()[-1]
    gr = er = None
    if not g['data'].get('line'):
        # no line score on the page — use the official scoreboard's final
        sc = RESULTS.get(gid) or {}
        gr, er = sc.get(team), sc.get(opp)
        if gr is None or er is None: raise KeyError(f'no result for {gid}')
        return opp, home, ('W' if gr > er else 'L') + f', {max(gr, er)}-{min(gr, er)}'
    p = Table(); p.feed(g['data']['line'])
    for r in p.rows:
        if short in r[0]: gr = int(r[-3])
        elif 'Final' not in r[0] and len(r) > 3:
            try: er = int(r[-3])
            except Exception: pass
    res = ('W' if gr > er else 'L') + f', {max(gr, er)}-{min(gr, er)}'
    return opp, home, res

BVERBS = ('sacrifice fly|sacrifice bunt|singled|doubled|tripled|homered|was intentionally walked|intentionally walked|walked|'
          'struck out|hit by pitch|reached on|reached first|grounded out|flied out|lined out|popped up|'
          'fouled out|infield fly|grounded into double play|lined into double play|flied into double play|out on batter.s interference|out at first')
PITCH_SEQ = re.compile(r'\((?:\d+-\d+\s+)?([BCFHKLMNOPQRSTUVXZ*+.\s]+)\)\s*$')

def parse_pitch_seqs(txt):
    """rough strike/ball + FPS counting from Presto pitch strings like (1-1 BKS)"""
    strikes = balls = fps = pa = 0
    for m in re.finditer(r'\((\d+)-(\d+)\s+([A-Z*+.]+)\)', txt):
        seq = m.group(3)
        for ch in seq:
            if ch in 'BIX': balls += 1
            elif ch in 'CFKLMNOPQRSTUVYZ*+.': strikes += 1
        if seq and seq[0] in 'CFKLMNOPQRSTUVYZ*+.': fps += 1
        elif seq and seq[0] == 'S' and len(seq) > 1 and seq[1] not in 'BIX': fps += 1
        pa += 1
    return strikes, balls, fps, pa

def batter_card(player, mobile=False):
    def pats(gid=None):
        p_pat = '(?:' + '|'.join(re.escape(n) for n in aka(player, gid)) + ')'
        return (re.compile(p_pat + r'\s+(?:' + BVERBS + ')'),
                re.compile(p_pat + r' stole (?:second|third|home)'),
                re.compile(p_pat + r' out at \w+ [^.;]*?caught stealing'))
    splits = {'L': collections.defaultdict(int), 'R': collections.defaultdict(int)}
    tot = collections.defaultdict(int)
    box = collections.defaultdict(lambda: [0, 0, 0, 0, 0, 0])  # keyed by gid, not date — 7/12 was a doubleheader
    games = []
    stints = set()          # every club he appeared for; drives the Tm column
    bad = 0
    for gid, g in sorted(BOX.items()):
        dt = gid[:8]
        pa_re, sb_re, cs_re = pats(gid)   # a game-scoped alias changes the patterns
        mine = team_of(gid, player)
        if not mine: continue                       # he wasn't in this game at all
        opp, home, res = game_meta(g, mine, gid)
        starter = None
        for sec in g['data']['box']:
            if 'Pitching' in sec['label'] and mine not in sec['label']:
                p = Table(); p.feed(sec['html'])
                for r in p.rows:
                    if len(r) < 3 or 'Pitchers' in r[0]: continue
                    starter = clean(r[0]); break
        cur = starter
        line = None
        for sec in g['data']['box']:
            if mine in sec['label'] and 'Batting' in sec['label']:
                p = Table(); p.feed(sec['html'])
                for r in p.rows:
                    if len(r) < 8: continue
                    if is_player(r[0], player):
                        line = [int(x) for x in r[1:7]]
                        for i in range(6): box[gid][i] += line[i]
        if not line: continue
        per = collections.defaultdict(int)
        for sec in g['data'].get('pbp', []):
            if mine not in sec['title']: continue           # his team's half-innings
            p = Text(); p.feed(sec['html'])
            txt = re.sub(r'\s+', ' ', ' '.join(p.t))
            txt = HDR_RE.sub(' ', txt); txt = OUT_RE.sub(' ', txt)
            swaps = [(m.start(), clean(m.group(1))) for m in SWAP_RE.finditer(txt)]
            for m in pa_re.finditer(txt):
                while swaps and swaps[0][0] < m.start(): cur = swaps.pop(0)[1]
                hand = lookup(THROWS, cur or '')
                S = splits[hand] if hand else collections.defaultdict(int)
                v = m.group(0); tail = txt[m.end():m.end() + 80].split(')')[0].split(';')[0]
                ev = None
                if ('sacrifice fly' in tail or re.search(r',\s*SAC\b', tail)) and re.search(r'(flied|lined) out|popped (out|up)', v): ev = 'SF'
                elif 'out at first' in v and ('picked off' in tail or 'caught stealing' in tail): ev = None
                elif re.search(r',\s*SAC\b', tail) and re.search(r'(out at first|grounded out|reached)', v): ev = 'SH'
                elif 'struck out' in v: ev = 'K'
                elif 'walked' in v: ev = 'BB'
                elif 'hit by pitch' in v: ev = 'HBP'
                elif 'singled' in v: ev = '1B'
                elif 'doubled' in v: ev = '2B'
                elif 'tripled' in v: ev = '3B'
                elif 'homered' in v: ev = 'HR'
                elif 'sacrifice bunt' in v: ev = 'SH'
                elif 'sacrifice fly' in v: ev = 'SF'
                else: ev = 'O'
                if ev:
                    S[ev] += 1; S['PA'] += 1; per[ev] += 1; tot[ev] += 1
                    if ev in ('1B', '2B', '3B', 'HR'): S['H'] += 1; tot['H'] += 1; per['H'] += 1
                    if ev in ('1B', '2B', '3B', 'HR', 'K', 'O'): S['AB'] += 1; per['AB'] += 1
            for m in sb_re.finditer(txt): per['SB'] += 1; tot['SB'] += 1
            for m in cs_re.finditer(txt): per['CS'] += 1; tot['CS'] += 1
        if per['AB'] != line[0] or per['H'] != line[2] or per['BB'] != line[4] or per['K'] != line[5]:
            bad += 1; print(f'  MISMATCH {dt} box {line[0]}/{line[2]}/{line[4]}/{line[5]} pbp {per["AB"]}/{per["H"]}/{per["BB"]}/{per["K"]}', file=sys.stderr)
        label = f"{MON[dt[4:6]]} {int(dt[6:8])}" if not mobile else f"{int(dt[4:6])}/{int(dt[6:8])}"
        pa = line[0] + line[4] + per['HBP'] + per['SF'] + per['SH']
        avg = '—' if line[0] == 0 else ('%.3f' % (line[2] / line[0])).replace('0.', '.')
        stints.add(mine)
        row_tm = [CLUB.get(mine, mine[:3].upper())]
        if mobile:
            games.append([label] + row_tm + [('vs ' if home else 'at ') + ABBR[opp], res.replace(', ', ' '), str(pa),
                          str(line[0]), str(line[1]), str(line[2]), str(line[3]), str(line[4]), str(line[5]), str(per['SB']), avg])
        else:
            games.append([label] + row_tm + [('' if home else 'at ') + SHORT[opp], res, str(pa), str(line[0]), str(line[1]),
                          str(line[2]), str(line[3]), str(line[4]), str(line[5]), str(per['SB']), avg])
    # A one-club season keeps the original 12-column log: the Tm column only
    # earns its place when the card actually spans two clubs.
    multi = len(stints) > 1
    if not multi: games = [[x[0]] + x[2:] for x in games]
    # doubleheader labels
    cnt = collections.Counter(x[0] for x in games); seen = collections.Counter()
    for x in games:
        if cnt[x[0]] > 1: seen[x[0]] += 1; x[0] += f' G{seen[x[0]]}'
    ab = box_total = sum(b[0] for b in box.values())
    h = sum(b[2] for b in box.values()); bb = sum(b[4] for b in box.values()); k = sum(b[5] for b in box.values())
    r = sum(b[1] for b in box.values()); rbi = sum(b[3] for b in box.values())
    hbp = tot['HBP']; sf = tot['SF']
    one = tot['1B']; two = tot['2B']; thr = tot['3B']; hr = tot['HR']
    tb = one + 2 * two + 3 * thr + 4 * hr
    pa = ab + bb + hbp + sf + tot['SH']
    avg = h / ab if ab else 0; obp = (h + bb + hbp) / pa if pa else 0; slg = tb / ab if ab else 0
    babip_den = ab - k - hr + sf
    babip = (h - hr) / babip_den if babip_den else 0
    bio = ROSTER.get(player) or next((ROSTER[a] for a in aka(player) if a in ROSTER), {})
    bt = bio.get('bt') or '—'
    def slash(S):
        sab, sh_ = S['AB'], S['H']
        spa = S['PA']  # SF events already incremented PA above
        stb = S['1B'] + 2 * S['2B'] + 3 * S['3B'] + 4 * S['HR']
        savg = sh_ / sab if sab else 0
        # standard OBP denominator: AB + BB + HBP + SF (sac bunts excluded)
        obp_den = sab + S['BB'] + S['HBP'] + S['SF']
        sobp = (sh_ + S['BB'] + S['HBP']) / obp_den if obp_den else 0
        sslg = stb / sab if sab else 0
        return spa, savg, sobp, sslg
    lpa, lavg, lobp, lslg = slash(splits['L']); rpa, ravg, robp, rslg = slash(splits['R'])
    f3 = lambda v: ('%.3f' % v).replace('0.', '.')
    drows, dleg = defense(player, 'field', mobile)
    DATA = {
        'name': player, 'num': str(bio.get('num') or ''), 'pos': bio.get('pos') or '—',
        'bt': bt, 'cls': bio.get('cls') or '—', 'school': bio.get('school') or '—',
        'home': bio.get('home') or '—', 'htwt': bio.get('htwt') or '—', 'bday': '—',
        'photoSlug': photo_slug(player),
        'seasonTitle': 'Season Totals — Hitting',
        'season': [['G', str(len(box))], ['PA', str(pa)], ['AVG', f3(avg)], ['OBP', f3(obp)],
                   ['SLG', f3(slg)], ['OPS', f3(obp + slg)], ['HR', str(hr)], ['RBI', str(rbi)], ['SB', str(tot['SB'])]],
        'groups': [
            ['PRODUCTION', [['AVG', f3(avg)], ['OBP', f3(obp)], ['SLG', f3(slg)], ['OPS', f3(obp + slg)],
                            ['ISO', f3(slg - avg)], ['BABIP', f3(babip)], ['XBH', str(two + thr + hr)], ['TB', str(tb)],
                            [f'vs LHP ({lpa} PA)', f'{f3(lavg)}/{f3(lobp)}/{f3(lslg)}', 'wide', f'AVG · OBP · SLG — OPS {f3(lobp + lslg)}'],
                            [f'vs RHP ({rpa} PA)', f'{f3(ravg)}/{f3(robp)}/{f3(rslg)}', 'wide', f'AVG · OBP · SLG — OPS {f3(robp + rslg)}']],
             'OBP = on-base pct (H+BB+HBP per PA) · SLG = total bases per AB · OPS = OBP + SLG · ISO = isolated power (SLG − AVG) · BABIP = batting avg on balls in play · XBH = extra-base hits · TB = total bases'],
            ['PLATE DISCIPLINE', [['BB%', '%.1f' % (100 * bb / pa if pa else 0)], ['K%', '%.1f' % (100 * k / pa if pa else 0)],
                                  ['BB:K', '%.2f' % (bb / k if k else 0)], ['PA', str(pa)], ['BB', str(bb)], ['K', str(k)],
                                  ['HBP', str(hbp)], ['SF', str(sf)]],
             'BB% = walks per PA · K% = strikeouts per PA · SF = sacrifice flies (not an AB)'],
            ['HIT BREAKDOWN', [['H', str(h)], ['1B', str(one)], ['2B', str(two)], ['3B', str(thr)],
                               ['HR', str(hr)], ['RBI', str(rbi)], ['R', str(r)], ['GIDP', str(tot.get('GIDP', 0))]]],
            [f'BASE RUNNING{" & DEFENSE" if drows else ""}',
             [['SB', str(tot['SB'])], ['CS', str(tot['CS'])],
              ['SB%', '%.1f' % (100 * tot['SB'] / (tot['SB'] + tot['CS']) if tot['SB'] + tot['CS'] else 0)],
              ['SB-ATT', f"{tot['SB']}-{tot['SB'] + tot['CS']}"]] + drows,
             'SB% = stolen-base success (SB ÷ attempts)' + (' · ' + dleg if dleg else '')]
        ],
        'key': [],  # legends moved into each panel (3rd element of its group)
        'logTitle': 'Game by Game — Hitting',
        'logCols': ['Date'] + (['Tm'] if multi else []) + ['Opponent' if not mobile else 'Opp',
                    'Result' if not mobile else 'Res', 'PA', 'AB', 'R', 'H', 'RBI', 'BB', 'K', 'SB', 'AVG'],
        'log': games,
        'totals': ['TOTAL'] + ([''] if multi else []) + [f'{len(box)} G', '', str(pa), str(ab), str(r), str(h),
                   str(rbi), str(bb), str(k), str(tot['SB']), f3(avg)]
    }
    return DATA, {'games': len(box), 'mismatched': bad}

_ARMS = {}
def club_arms(gid, team):
    """Name keys of every pitcher that club used in this game."""
    k = (gid, team)
    if k not in _ARMS:
        names = set()
        for sec in BOX[gid]['data']['box']:
            if team in sec['label'] and 'Pitching' in sec['label']:
                p = Table(); p.feed(sec['html'])
                for r in p.rows:
                    if r and 'Pitchers' not in r[0]: names.add(tkey(clean(r[0])))
        _ARMS[k] = names
    return _ARMS[k]

def pitcher_card(player, mobile=False):
    box_games = []
    dec = collections.Counter()
    for gid, g in sorted(BOX.items()):
        dt = gid[:8]
        mine = team_of(gid, player)
        if not mine: continue                       # not his game — a prior stint's box, say
        opp, home, res = game_meta(g, mine, gid)
        for sec in g['data']['box']:
            if mine in sec['label'] and 'Pitching' in sec['label']:
                p = Table(); p.feed(sec['html'])
                for r in p.rows:
                    if len(r) < 8 or 'Pitchers' in r[0]: continue
                    if is_player(r[0], player):
                        m = DEC_RE.search(r[0])
                        if m:
                            for ch in m.group(1): dec[ch] += 1
                        box_games.append({'gid': gid, 'dt': dt, 'opp': opp, 'home': home, 'res': res,
                                          'ip': r[1], 'h': int(r[2]), 'r': int(r[3]), 'er': int(r[4]),
                                          'bb': int(r[5]), 'k': int(r[6]), 'np': int(r[8]) if len(r) > 8 and r[8].isdigit() else 0,
                                          'spct': int(r[9]) if len(r) > 9 and r[9].isdigit() else 0})
    # batting-against events from opponent-side PBP blocks
    splits = {'L': collections.defaultdict(int), 'R': collections.defaultdict(int)}
    tot = collections.defaultdict(int)
    bad = 0
    for gid, g in sorted(BOX.items()):
        dt = gid[:8]
        if not any(b['gid'] == gid for b in box_games): continue
        mine = team_of(gid, player)
        # find which pbp blocks are opponent batting: blocks whose title names the opponent
        cur = None  # his club's pitcher on the mound; starter = first such pitcher in the box
        starter = None
        for sec in g['data']['box']:
            if mine in sec['label'] and 'Pitching' in sec['label']:
                p = Table(); p.feed(sec['html'])
                for r in p.rows:
                    if len(r) < 3 or 'Pitchers' in r[0]: continue
                    starter = clean(r[0]); break
        cur = starter
        per = collections.defaultdict(int)
        for sec in g['data'].get('pbp', []):
            if mine in sec['title']: continue      # opponent batting only
            p = Text(); p.feed(sec['html'])
            txt = re.sub(r'\s+', ' ', ' '.join(p.t))
            txt = HDR_RE.sub(' ', txt); txt = OUT_RE.sub(' ', txt)
            # only his club's arms count as pitching changes here — "X to p for
            # <pitcher>" can also be a pinch hitter taking the P lineup spot.
            # On a prior-stint game the roster keys are the wrong club's, so the
            # names come off that game's own pitching table instead.
            arms = GATOR_KEYS if mine == GATORS else club_arms(gid, mine)
            swaps = [(m.start(), clean(m.group(1))) for m in SWAP_RE.finditer(txt)
                     if tkey(clean(m.group(1))) in arms or clean(m.group(1)) == 'Landon Hennan']
            # batter events: "<Name> singled..." for any batter while cur == player
            ev_re = re.compile(rf"({NAME}) ({BVERBS})")
            for m in ev_re.finditer(txt):
                while swaps and swaps[0][0] < m.start(): cur = swaps.pop(0)[1]
                if not is_player(cur or '', player): continue
                batter, verb = m.group(1), m.group(2)
                tail = txt[m.end():m.end() + 80].split(';')[0]
                if ('sacrifice fly' in tail or re.search(r',\s*SAC\b', tail)) and verb in ('flied out', 'lined out', 'popped up'): ev = 'SF'
                elif verb == 'out at first' and ('picked off' in tail or 'caught stealing' in tail): continue
                elif re.search(r',\s*SAC\b', tail) and ('out at first' in verb or 'grounded out' in verb or 'reached' in verb): ev = 'SH'
                elif verb == 'struck out': ev = 'K'
                elif 'walked' in verb: ev = 'BB'
                elif verb == 'hit by pitch': ev = 'HBP'
                elif verb == 'singled': ev = '1B'
                elif verb == 'doubled': ev = '2B'
                elif verb == 'tripled': ev = '3B'
                elif verb == 'homered': ev = 'HR'
                elif verb == 'sacrifice bunt': ev = 'SH'
                elif verb == 'sacrifice fly': ev = 'SF'
                else: ev = 'O'
                if '. ' in batter: batter = batter.split('. ')[-1]  # unglue sentence-boundary names ("Cade Robin. Hayden Ramage")
                bats = lookup(BATS, batter)
                if bats == 'S':  # switch hitter bats opposite the pitcher's throwing hand
                    p_hand = (ROSTER.get(player, {}).get('bt') or '—/—').split('/')[-1]
                    bats = 'L' if p_hand == 'R' else 'R'
                S = splits[bats] if bats in ('L', 'R') else collections.defaultdict(int)
                S[ev] += 1; S['PA'] += 1; per[ev] += 1; per['PA'] += 1; tot[ev] += 1
                if ev in ('1B', '2B', '3B', 'HR'): S['H'] += 1; per['H'] += 1; tot['H'] += 1
                if ev in ('1B', '2B', '3B', 'HR', 'K', 'O'): S['AB'] += 1; per['AB'] += 1; tot['AB'] += 1
                tot['PA'] += 1
            # Wild pitches are deliberately NOT derived here. Counting them from
            # the text does not reconcile with Presto's own WP column (3 of 11
            # pitchers matched): one wild pitch is described once per runner it
            # moves, and the league counts some the text never flags. Presto
            # publishes WP per pitcher — take it from there if it is ever wanted,
            # rather than shipping a number that does not tie out.
        bg = [b for b in box_games if b['gid'] == gid][0]
        bg['bf_pbp'] = per['PA']  # true batters faced from play-by-play
        if per['H'] != bg['h'] or per['BB'] != bg['bb'] or per['K'] != bg['k']:
            bad += 1; print(f'  MISMATCH {dt} box H/BB/K {bg["h"]}/{bg["bb"]}/{bg["k"]} pbp {per["H"]}/{per["BB"]}/{per["K"]}', file=sys.stderr)
    outs = sum(int(b['ip'].split('.')[0]) * 3 + int(b['ip'].split('.')[1]) for b in box_games)
    ip = outs / 3
    er = sum(b['er'] for b in box_games); h = sum(b['h'] for b in box_games)
    bb = sum(b['bb'] for b in box_games); k = sum(b['k'] for b in box_games)
    r = sum(b['r'] for b in box_games); np_ = sum(b['np'] for b in box_games)
    hr = tot['HR']; hbp = tot['HBP']; sf = tot['SF']
    bf = tot['PA']  # batters faced = plate appearances against (SF/SH already counted in PA)
    ab = tot['AB']
    ha = tot['H']
    one, two, thr = tot['1B'], tot['2B'], tot['3B']
    tb = one + 2 * two + 3 * thr + 4 * hr
    era = 9 * er / ip if ip else 0
    whip = (bb + h) / ip if ip else 0
    fip = ((13 * hr + 3 * (bb + hbp) - 2 * k) / ip + 3.10) if ip else 0
    avg = ha / ab if ab else 0
    obp_den = ab + bb + hbp + sf  # standard OBP denominator (sac bunts excluded)
    obp = (ha + bb + hbp) / obp_den if obp_den else 0
    slg = tb / ab if ab else 0
    babip_den = ab - k - hr + sf
    babip = (ha - hr) / babip_den if babip_den else 0
    bio = ROSTER.get(player) or next((ROSTER[a] for a in aka(player) if a in ROSTER), {})
    def slash(S):
        sab, sh_ = S['AB'], S['H']
        spa = S['PA']  # SF events already incremented PA above
        stb = S['1B'] + 2 * S['2B'] + 3 * S['3B'] + 4 * S['HR']
        sbb = S['BB']; shp = S['HBP']
        savg = sh_ / sab if sab else 0
        # standard OBP denominator: AB + BB + HBP + SF (sac bunts excluded)
        obp_den = sab + sbb + shp + S['SF']
        sobp = (sh_ + sbb + shp) / obp_den if obp_den else 0
        sslg = stb / sab if sab else 0
        return spa, savg, sobp, sslg
    lpa, lavg, lobp, lslg = slash(splits['L']); rpa, ravg, robp, rslg = slash(splits['R'])
    f3 = lambda v: ('%.3f' % v).replace('0.', '.')
    ip_s = f'{int(ip)}{"." + str(outs % 3) if outs % 3 else ""}'
    games = []
    for b in box_games:
        label = f"{MON[b['dt'][4:6]]} {int(b['dt'][6:8])}" if not mobile else f"{int(b['dt'][4:6])}/{int(b['dt'][6:8])}"
        gera = '—' if b['ip'] == '0.0' else '%.2f' % (9 * b['er'] / (int(b['ip'].split('.')[0]) + int(b['ip'].split('.')[1]) / 3))
        # BF: true count from play-by-play (box BF column is unreliable in this league);
        # fall back to outs+H+BB approximation only if PBP is missing for the game
        outs_g = int(b['ip'].split('.')[0]) * 3 + int(b['ip'].split('.')[1])
        bf_g = b.get('bf_pbp') or (outs_g + b['h'] + b['bb'])
        if mobile:
            games.append([label, ('vs ' if b['home'] else 'at ') + ABBR[b['opp']], b['res'].replace(', ', ' '),
                          b['ip'], str(bf_g), str(b['h']), str(b['r']), str(b['er']), str(b['bb']), str(b['k']),
                          str(b['np']) if b['np'] else '—', (str(b['spct']) + '%') if b['spct'] else '—', gera])
        else:
            games.append([label, ('' if b['home'] else 'at ') + SHORT[b['opp']], b['res'],
                          b['ip'], str(bf_g), str(b['h']), str(b['r']), str(b['er']), str(b['bb']), str(b['k']),
                          str(b['np']) if b['np'] else '—', (str(b['spct']) + '%') if b['spct'] else '—', gera])
    w, l, sv = dec['W'], dec['L'], dec['SV'] + dec['S']
    app = len(box_games)
    season = [['APP', str(app)], ['GS', '0'], ['W', str(w)], ['L', str(l)], ['SV', str(sv)],
              ['ERA', '%.2f' % era], ['WHIP', '%.2f' % whip], ['K', str(k)], ['BB', str(bb)]]
    drows, dleg = defense(player, 'p', mobile)
    DATA = {
        'name': player, 'num': str(bio.get('num') or ''), 'pos': bio.get('pos') or 'P',
        'bt': bio.get('bt') or '—', 'cls': bio.get('cls') or '—', 'school': bio.get('school') or '—',
        'home': bio.get('home') or '—', 'htwt': bio.get('htwt') or '—', 'bday': '—',
        'photoSlug': photo_slug(player),
        'seasonTitle': 'Season Totals — Pitching',
        'season': season,
        'groups': [
            ['RUN PREVENTION', [['ERA', '%.2f' % era], ['WHIP', '%.2f' % whip], ['FIP', '%.2f' % fip],
                                ['BABIP', f3(babip)], ['AVG', f3(avg)], ['OBP', f3(obp)], ['SLG', f3(slg)], ['OPS', f3(obp + slg)]],
             'FIP = fielding-independent pitching (HR, BB, K) · BABIP = avg on balls in play · WHIP = walks + hits per IP · ERA = earned runs per 9 IP'],
            ['COMMAND & RATES', [['K%', '%.1f' % (100 * k / bf if bf else 0)], ['BB%', '%.1f' % (100 * bb / bf if bf else 0)],
                                 ['K:BB', '%.2f' % (k / bb if bb else 0)], ['K/9', '%.2f' % (9 * k / ip if ip else 0)],
                                 ['BB/9', '%.2f' % (9 * bb / ip if ip else 0)], ['H/9', '%.2f' % (9 * h / ip if ip else 0)],
                                 ['HR/9', '%.2f' % (9 * hr / ip if ip else 0)], ['P/IP', '%.1f' % (np_ / ip if ip and np_ else 0)]],
             'K% = strikeouts per batter faced · BB% = walks per batter faced · P/IP = pitches per inning'],
            ['HITTERS AGAINST', [['BF', str(bf)], ['AB', str(ab)], ['H', str(ha)], ['2B', str(two)],
                                 ['3B', str(thr)], ['HR', str(hr)], ['HBP', str(hbp)], ['SF', str(sf)],
                                 [f'Total ({tot["PA"]} PA)', f'{f3(avg)}/{f3(obp)}/{f3(slg)}', 'wide', 'AVG · OBP · SLG'],
                                 [f'vs LHB ({lpa} PA)', f'{f3(lavg)}/{f3(lobp)}/{f3(lslg)}', 'wide', 'AVG · OBP · SLG'],
                                 [f'vs RHB ({rpa} PA)', f'{f3(ravg)}/{f3(robp)}/{f3(rslg)}', 'wide', 'AVG · OBP · SLG']],
             'BF = batters faced'],
            [f'WORKLOAD{" & DEFENSE" if drows else ""}',
             [['APP', str(app)], ['IP', ip_s], ['IP/APP', '%.1f' % (ip / app if app else 0)],
              ['BF', str(bf)], ['R', str(r)], ['ER', str(er)], ['#P', str(np_) if np_ else '—'],
              ['W-L', f'{w}-{l}'], ['HBP', str(hbp)]] + drows,
             'IP/APP = innings per appearance · #P = total pitches · HBP = batters he hit' + (' · ' + dleg if dleg else '')]
        ],
        'key': [],  # legends moved into each panel (3rd element of its group)
        'logTitle': 'Game by Game — Pitching',
        'logCols': ['Date', 'Opponent' if not mobile else 'Opp', 'Result' if not mobile else 'Res',
                    'IP', 'BF', 'H', 'R', 'ER', 'BB', 'K', '#P', 'S%', 'ERA'],
        'log': games,
        'totals': ['TOTAL', f'{app} APP', '', ip_s, str(sum(int(x[4]) for x in games)), str(h), str(r), str(er), str(bb), str(k),
                   str(np_) if np_ else '—', ('%.0f%%' % (100 * sum(b['np'] * b['spct'] / 100 for b in box_games if b['np'] and b['spct']) / np_)) if np_ else '—', '%.2f' % era]
    }
    return DATA, {'games': app, 'mismatched': bad}

def main():
    if len(sys.argv) < 3: print(__doc__); sys.exit(1)
    last, role = sys.argv[1], sys.argv[2]
    kind = '--batter' if role == '--batter' else '--pitcher'
    player = find_player(last, 'Batting' if kind == '--batter' else 'Pitching')
    if not player: print(f'"{last}" not found in the box scores'); sys.exit(1)
    player = canonical(player)      # print the club's spelling, not Presto's
    mobile = '--mobile' in sys.argv
    if kind == '--batter':
        DATA, v = batter_card(player, mobile)
    else:
        DATA, v = pitcher_card(player, mobile)
    print(f'{player}: {v["games"]} games, {v["mismatched"]} mismatched', file=sys.stderr)
    print(json.dumps(DATA, indent=1))

if __name__ == '__main__':
    main()
