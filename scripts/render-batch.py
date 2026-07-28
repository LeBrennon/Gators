#!/usr/bin/env python3
"""
render-batch.py — render print PDF + mobile HTML for a list of players.

  python3 scripts/render-batch.py Ramos:b Walker:b Thompson:p Levy:both ...

  suffix :b = batter card, :p = pitcher card, :both = double report card
Splices DATA from player-season-data.py into the locked card templates,
node-renders each, and verifies 1-page PDFs.
"""
import json, re, subprocess, sys, os

JOBS = {
    'b': ('scripts/player-season-card-batter.js', 'scripts/player-season-card-mobile-batter.js', '--batter'),
    'p': ('scripts/player-season-card.js', 'scripts/player-season-card-mobile.js', '--pitcher'),
}

def splice(template, data, out):
    s = open(template).read()
    start = s.index('const DATA = ')
    end = s.index('};', start) + 2
    open(out, 'w').write(s[:start] + 'const DATA = ' + json.dumps(data, indent=2) + ';' + s[end:])

def run(job):
    name, kind = job.split(':')
    roles = ['b', 'p'] if kind == 'both' else [kind]
    ok = True
    for r in roles:
        tpl_p, tpl_m, flag = JOBS[r]
        label = '' if len(roles) == 1 else ('Hitting' if r == 'b' else 'Pitching')
        for tpl, extra in ((tpl_p, []), (tpl_m, ['--mobile'])):
            res = subprocess.run(['python3', 'scripts/player-season-data.py', name.split()[-1], flag] + extra,
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
            if label:  # double report card: disambiguate filename
                import glob, shutil
                d = 'reports/players-mobile' if extra else 'reports/players'
                ext = 'html' if extra else 'pdf'
                src = glob.glob(f"{d}/{data['name']} - 2026 Summer Stats*.{ext}")
                import time
                for f in src:
                    if '(' in f: continue  # already labeled (don't double-suffix the other role's card)
                    dst = f.replace(' - 2026 Summer Stats', f' - 2026 Summer Stats ({label})')
                    for _try in range(4):
                        try: shutil.move(f, dst); break
                        except FileNotFoundError: time.sleep(2)
            print(f'  rendered {name} {flag}{" mobile" if extra else " print"}  [{note}]')
    return ok

if __name__ == '__main__':
    jobs = sys.argv[1:]
    if not jobs: print(__doc__); sys.exit(1)
    bad = [j for j in jobs if not run(j)]
    print('FAILED:', bad if bad else 'none')
