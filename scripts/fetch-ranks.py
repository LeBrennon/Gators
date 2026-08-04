#!/usr/bin/env python3
"""
fetch-ranks.py — cache each batter's TCL league ranks for the season cards.

  python3 scripts/fetch-ranks.py            # -> data/league-ranks.json

The ranks are PRESTO'S OWN, read off each player's league player page through
the live site's /api/player proxy — the identical source the website's player
bio uses, so a card and the site agree by construction.

They are not computed here. An earlier attempt to compute them from the league
leaderboard was thrown away after it failed to reproduce Presto's numbers: the
board pages out at ~216 hitters, short of the league, and Presto applies a
minimum-AB qualifier to the rate stats that the raw board does not. Both errors
are small and quiet, which is the worst kind — Landreneau's AVG rank came out
70th against Presto's 49th.

PITCHING RANKS DO NOT EXIST at this source. Presto's player pages carry none —
not for the league ERA leader, not for anyone — so pitcher cards get no ranks.
The website says the same in its own legend.

Two things this has to be careful about:
  - A cold cache answers 200 with an empty body rather than an error, so a
    player with no hit line is retried before being believed.
  - Slugs come from server.js's ROSTER (authoritative) and the league hitting
    board, never guessed from a name.
"""
import json, os, re, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = 'https://www.whatisthegatorscore.com'
OUT = os.path.join(ROOT, 'data', 'league-ranks.json')
TRIES = 8


def get(url):
    for attempt in range(TRIES):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                return json.loads(r.read().decode())
        except Exception:
            if attempt == TRIES - 1: raise
            time.sleep(2 ** attempt)


def player(slug):
    """A player page, retried past the empty body a cold cache returns."""
    for attempt in range(TRIES):
        d = get(f'{SITE}/api/player?slug={slug}')
        if d.get('hit'): return d
        time.sleep(2 ** attempt)
    return d


def norm(n):
    return re.sub(r'[^a-z]', '', (n or '').lower())


def gators_board_slugs():
    """Every Gators hitter's slug off the league board, keyed by the name in it."""
    out = {}
    for row0 in (0, 125, 250):
        d = get(f'{SITE}/debug/leaders?pos=h&team=all&r={row0}&sort=avg')
        gid = d.get('gatorsId')
        for r in d.get('rows') or []:
            if r.get('teamId') != gid or not r.get('slug'): continue
            out.setdefault(re.sub(r'[a-z0-9]{4}$', '', r['slug']), r['slug'])
    return out


def slug_table():
    """name key -> Presto slug. The roster wins; the board and the headshot
    manifest fill in the departed. A two-way player can be missing from the
    hitting board entirely (Presto files him under pitching), which is why the
    manifest is worth consulting — its keys are Presto slugs."""
    out = {}
    for stem in json.load(open(os.path.join(ROOT, 'photos/manifest.json'))):
        out.setdefault(re.sub(r'[a-z0-9]{4}$', '', stem), stem)
    out.update(gators_board_slugs())
    # The board is a remote page that has come back short between runs, so a slug
    # confirmed once is kept: the committed cache is the record, not the fetch.
    try:
        for n, p in json.load(open(OUT))['players'].items():
            if p.get('slug'): out[norm(n)] = p['slug']
    except (FileNotFoundError, KeyError):
        pass
    src = open(os.path.join(ROOT, 'server.js')).read()
    for m in re.finditer(r"name:\s*'([^']+)',\s*slug:\s*'([^']+)'", src):
        out[norm(m.group(1))] = m.group(2)
    return out


if __name__ == '__main__':
    sys.path.insert(0, os.path.join(ROOT, 'scripts'))
    import importlib.util
    spec = importlib.util.spec_from_file_location('psd', os.path.join(ROOT, 'scripts/player-season-data.py'))
    psd = importlib.util.module_from_spec(spec); sys.modules['psd'] = psd
    _a, sys.argv = sys.argv, ['psd']
    try: spec.loader.exec_module(psd)
    except SystemExit: pass
    sys.argv = _a

    names = [p['name'] for p in json.load(open(os.path.join(ROOT, 'data/season-final-batch.json')))['players']
             if p['role'] in ('b', 'both')]
    table = slug_table()
    out, noslug, noranks = {}, [], []
    for n in names:
        keys = [norm(n)] + [norm(a) for a in psd.aka(n)]
        slug = next((table[k] for k in keys if k in table), None)
        if not slug: noslug.append(n); continue
        d = player(slug)
        r = d.get('hitRanks') or {}
        if not r: noranks.append(n)
        out[n] = {'slug': slug, 'ranks': r, 'line': d.get('hit') or {}}
        print(f'  {n:22} {slug:26} {len(r):2} ranked stats', file=sys.stderr)
    json.dump({'fetched': int(time.time() * 1000),
               'source': f'{SITE}/api/player — Presto player-page ranks, hitting only',
               'players': out}, open(OUT, 'w'), indent=1)
    print(f'\n{len(out)}/{len(names)} batters resolved', file=sys.stderr)
    if noslug: print(f'NO SLUG  : {noslug}', file=sys.stderr)
    if noranks: print(f'NO RANKS : {noranks}', file=sys.stderr)
    print(f'wrote {OUT}', file=sys.stderr)
