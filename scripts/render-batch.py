#!/usr/bin/env python3
"""
render-batch.py — render print PDF + mobile HTML for a list of players.

  python3 scripts/render-batch.py Ramos:b Walker:b Thompson:p Levy:both ...
  python3 scripts/render-batch.py --print Ramos:b ...        # skip the mobile cards
  python3 scripts/render-batch.py --print --roster data/active-batch.json

  suffix :b = batter card, :p = pitcher card, :both = double report card
A --roster file is {"players": [{"name": ..., "role": "b|p|both"}, ...]} — the
whole batch and its roles in one reviewed place, so a long command line can't
quietly drop a player or send someone the wrong card.
Splices DATA from player-season-data.py into the locked card templates,
node-renders each, and verifies the PDF came out at exactly two pages
(page 1 all stats, page 2 the game log).
"""
import json, re, subprocess, sys, os

PAGES = 2   # every print card: stats page + game-log page

def page_count(pdf):
    with open(pdf, 'rb') as f:
        return len(re.findall(rb'/Type\s*/Page[^s]', f.read()))

JOBS = {
    'b': ('scripts/player-season-card-batter.js', 'scripts/player-season-card-mobile-batter.js', '--batter'),
    'p': ('scripts/player-season-card.js', 'scripts/player-season-card-mobile.js', '--pitcher'),
}

def splice(template, data, out):
    s = open(template).read()
    start = s.index('const DATA = ')
    end = s.index('};', start) + 2
    open(out, 'w').write(s[:start] + 'const DATA = ' + json.dumps(data, indent=2) + ';' + s[end:])

def run(job, print_only=False):
    name, kind = job.split(':')
    roles = ['b', 'p'] if kind == 'both' else [kind]
    ok = True
    for r in roles:
        tpl_p, tpl_m, flag = JOBS[r]
        label = '' if len(roles) == 1 else ('Hitting' if r == 'b' else 'Pitching')
        jobs = [(tpl_p, [])] + ([] if print_only else [(tpl_m, ['--mobile'])])
        for tpl, extra in jobs:
            # pass the name as given (full name if supplied) — a bare last name is ambiguous
            # when two players share one, e.g. Jake Smith / Shyler Smith
            res = subprocess.run(['python3', 'scripts/player-season-data.py', name, flag] + extra,
                                 capture_output=True, text=True)
            if res.returncode != 0:
                print(f'  DATA FAIL {name} {flag}: {res.stderr[-200:]}'); ok = False; continue
            note = res.stderr.strip().splitlines()[-1]
            data = json.loads(res.stdout)
            tmp = f'scripts/.batch-tmp-{os.getpid()}.js'  # template resolves ROOT from script location
            splice(tpl, data, tmp)
            chk = subprocess.run(['node', '--check', tmp], capture_output=True, text=True)
            if chk.returncode != 0:
                print(f'  SYNTAX FAIL {name}: {chk.stderr[-200:]}'); ok = False; continue
            rn = subprocess.run(['node', tmp], capture_output=True, text=True)
            if rn.returncode != 0:
                print(f'  RENDER FAIL {name}: {rn.stderr[-200:]}'); ok = False; continue
            fit = rn.stdout.strip().split('  ', 1)[-1] if '  ' in rn.stdout else ''
            if not extra:
                pdf = f"reports/players/{data['name']} - 2026 Summer Stats.pdf"
                n = page_count(pdf)
                if n != PAGES:
                    print(f'  PAGE FAIL {name}: {n} pages, expected {PAGES}'); ok = False; continue
            if label:  # double report card: disambiguate filename
                import glob, shutil
                d = 'reports/players-mobile' if extra else 'reports/players'
                ext = 'html' if extra else 'pdf'
                src = glob.glob(f"{d}/{data['name']} - 2026 Summer Stats*.{ext}")
                import time
                for f in src:
                    if '(Hitting)' in f or '(Pitching)' in f: continue  # already labeled (don't double-suffix the other role's card)
                    dst = f.replace(' - 2026 Summer Stats', f' - 2026 Summer Stats ({label})')
                    for _try in range(4):
                        try: shutil.move(f, dst); break
                        except FileNotFoundError: time.sleep(2)
            print(f'  rendered {name} {flag}{" mobile" if extra else " print"}  [{note}] {fit}')
    return ok

if __name__ == '__main__':
    args = sys.argv[1:]
    print_only = '--print' in args
    dry_run = '--dry-run' in args
    skip = set()
    if '--roster' in args: skip.add(args.index('--roster') + 1)     # the flag's value, not a job
    jobs = [a for i, a in enumerate(args) if not a.startswith('--') and i not in skip]
    if '--roster' in args:
        path = args[args.index('--roster') + 1]
        jobs += [f"{p['name']}:{p['role']}" for p in json.load(open(path))['players']]
    if not jobs: print(__doc__); sys.exit(1)
    if dry_run:
        # Resolve every player and run the validation gate without rendering —
        # the cheap way to confirm a batch is sendable before committing to it.
        bad = []
        for j in jobs:
            name, kind = j.split(':')
            for r in (['b', 'p'] if kind == 'both' else [kind]):
                res = subprocess.run(['python3', 'scripts/player-season-data.py', name, JOBS[r][2]],
                                     capture_output=True, text=True)
                note = (res.stderr.strip().splitlines() or ['no output'])[-1]
                ok = res.returncode == 0 and '0 mismatched' in note
                print(f"  {'ok  ' if ok else 'FAIL'} {name} ({r}): {note[:70]}")
                if not ok: bad.append(f'{name}:{r}')
        print(f'\n{len(jobs)} players, {sum(2 if j.endswith(":both") else 1 for j in jobs)} cards')
        print('FAILED:', bad if bad else 'none')
        sys.exit(1 if bad else 0)
    bad = [j for j in jobs if not run(j, print_only)]
    print('FAILED:', bad if bad else 'none')
