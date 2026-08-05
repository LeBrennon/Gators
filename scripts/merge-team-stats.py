#!/usr/bin/env python3
"""
merge-team-stats.py <prefix> <Team Display Name>

  python3 scripts/merge-team-stats.py abilene "Abilene Flying Bison"

Merges data/league-stats/<prefix>_batting.csv, _running.csv, _pitching.csv,
_fielding.csv (the four-file-per-team export the owner sends, PrestoSports
team stat pages) into one clean per-player record at
data/league-stats/<prefix>.json.

Keyed by cleaned player name. A pure position player has no 'pitching' key;
a pure pitcher usually still has a (mostly empty) 'batting' line since
pitchers take at-bats in this league. Run this once per team when the owner
supplies a refreshed export, then rerun build-league-ranks.py to recompute
every rank against the new numbers.
"""
import csv, json, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SP = os.path.join(ROOT, 'data', 'league-stats')


def load(path):
    with open(path) as f:
        return list(csv.DictReader(f))


def clean_name(raw):
    return ' '.join(raw.split())


def clean_val(v):
    v = (v or '').strip()
    return None if v in ('', "'-", '-') else v


def row_to_dict(row, skip_keys):
    return {k: clean_val(v) for k, v in row.items() if k not in skip_keys}


def merge(prefix, team_name):
    batting = load(f'{SP}/{prefix}_batting.csv')
    running = load(f'{SP}/{prefix}_running.csv')
    pitching = load(f'{SP}/{prefix}_pitching.csv')
    fielding = load(f'{SP}/{prefix}_fielding.csv')

    players = {}

    def touch(name, num):
        if name not in players:
            players[name] = {'name': name, 'num': num, 'yr': None, 'pos': None}
        return players[name]

    for row in batting:
        name = clean_name(row['Name'])
        p = touch(name, clean_val(row['#']))
        p['yr'] = p['yr'] or clean_val(row['Yr'])
        p['pos'] = p['pos'] or clean_val(row['Pos'])
        p['batting'] = row_to_dict(row, {'#', 'Name', 'Yr', 'Pos'})

    for row in running:
        name = clean_name(row['Name'])
        p = touch(name, clean_val(row['#']))
        p['yr'] = p['yr'] or clean_val(row['Yr'])
        p['pos'] = p['pos'] or clean_val(row['Pos'])
        p['running'] = row_to_dict(row, {'#', 'Name', 'Yr', 'Pos', 'gp'})

    for row in pitching:
        name = clean_name(row['Name'])
        p = touch(name, clean_val(row['#']))
        p['yr'] = p['yr'] or clean_val(row['Yr'])
        p['pos'] = p['pos'] or clean_val(row['Pos'])
        p['pitching'] = row_to_dict(row, {'#', 'Name', 'Yr', 'Pos'})

    for row in fielding:
        name = clean_name(row['Name'])
        p = touch(name, clean_val(row['#']))
        p['yr'] = p['yr'] or clean_val(row['Yr'])
        p['pos'] = p['pos'] or clean_val(row['Pos'])
        p['fielding'] = row_to_dict(row, {'#', 'Name', 'Yr', 'Pos'})

    out = {'team': team_name,
           'source': 'owner-provided CSV exports, TCL/PrestoSports stats',
           'players': dict(sorted(players.items()))}
    outpath = f'{SP}/{prefix}.json'
    with open(outpath, 'w') as f:
        json.dump(out, f, indent=1)

    print(f'{team_name}: {len(players)} players merged -> {outpath}')
    have_all_four = sum(1 for p in players.values()
                         if all(k in p for k in ('batting', 'running', 'pitching', 'fielding')))
    have_batting = sum(1 for p in players.values() if 'batting' in p)
    print(f'  {have_batting} with a batting line, {have_all_four} with all four categories')
    return out


if __name__ == '__main__':
    merge(sys.argv[1], sys.argv[2])
