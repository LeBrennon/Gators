#!/usr/bin/env python3
"""
fetch-throws.py — build data/league-throws.json from TCL Presto player profiles.

Cloudflare blocks datacenter IPs, so run this on your own machine:

    cd ~/Gators && git pull && python3 scripts/fetch-throws.py

It walks the 8 TCL team pages, finds every player profile link, reads each
profile's "B/T: X/X" line, and writes data/league-throws.json:

    { "players": { "wyatt chenevert": "L", "ryan self": "R", ... } }

Throws = the SECOND letter of B/T. Then commit + push the json (or send it
to the chat) and batter splits (vs LHP / vs RHP) can be computed.
"""
import json, re, sys, time, urllib.request

BASE = 'https://texasleaguestats.prestosports.com/sports/bsb/2026'
TEAMS = ['abileneflyingbison', 'acadianacanecutters', 'batonrougerougarou',
         'brazosvalleybombers', 'lakecharlesgumbeauxgators', 'sanantoniorivermonsters',
         'shermanshadowcats', 'victoriagenerals']
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'}

def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode('utf-8', 'replace')
        except Exception as e:
            print(f'  retry {i+1} {url} ({e})', file=sys.stderr)
            time.sleep(3)
    return None

def norm(nm):
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z\s]', '', nm.lower())).strip()

def main():
    players = {}   # slug -> name
    for t in TEAMS:
        html = get(f'{BASE}/teams/{t}')
        if not html:
            print(f'TEAM FAILED: {t}', file=sys.stderr); continue
        links = re.findall(r'href="/sports/bsb/2026/players/([a-z0-9]+)"[^>]*>([^<]+)<', html)
        for slug, nm in links:
            players[slug] = nm.strip()
        print(f'{t}: {len(links)} player links')
        time.sleep(1)
    print(f'\n{len(players)} unique players. Fetching profiles for B/T...\n')

    out, fails = {}, []
    for i, (slug, nm) in enumerate(sorted(players.items(), key=lambda kv: kv[1])):
        html = get(f'{BASE}/players/{slug}')
        hand = None
        if html:
            m = re.search(r'B\s*/\s*T\s*[:.]?\s*([LRS])\s*/\s*([LRS])', html, re.I)
            if m: hand = m.group(2).upper()
        if hand:
            out[norm(nm)] = hand
        else:
            fails.append(nm)
        if (i + 1) % 25 == 0: print(f'  {i+1}/{len(players)}...')
        time.sleep(0.4)

    data = {'_comment': 'Pitcher/player throwing hand (2nd letter of Presto profile B/T). Built by scripts/fetch-throws.py from TCL Presto profiles.',
            'players': out}
    with open('data/league-throws.json', 'w') as f:
        json.dump(data, f, indent=1, sort_keys=True)
    print(f'\nWrote data/league-throws.json: {len(out)} players with throws data.')
    if fails:
        print(f'{len(fails)} profiles had no B/T line (check manually): {fails[:20]}')

if __name__ == '__main__':
    main()
