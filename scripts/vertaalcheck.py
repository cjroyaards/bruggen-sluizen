#!/usr/bin/env python3
"""Controleer welke RWS/haven-teksten nog niet in data/texts_en.json staan.

Gebruik (vanuit de repo-root):  python3 scripts/vertaalcheck.py
Print de onvertaalde teksten; die vertalen we samen en voegen we toe aan
data/texts_en.json. Onvertaalde teksten verschijnen op de site gewoon in het
Nederlands, dus er breekt niets zolang de tabel achterloopt.
"""
import json, gzip, os, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def p(*a): return os.path.join(root, *a)

need = set()
d = json.load(gzip.open(p('data', 'static.json.gz')))
for ot in d['ot'].values():
    if isinstance(ot, list) and ot:
        if isinstance(ot[0], str) and ot[0].strip(): need.add(ot[0].strip())
        for per in (ot[1] if len(ot) > 1 and isinstance(ot[1], list) else []):
            if not isinstance(per, list): continue
            if len(per) > 2 and isinstance(per[2], str) and per[2].strip(): need.add(per[2].strip())
            for r in (per[3] if len(per) > 3 and isinstance(per[3], list) else []):
                if isinstance(r, list) and len(r) > 3 and isinstance(r[3], str) and r[3].strip(): need.add(r[3].strip())
s = json.load(open(p('data', 'strem.json')))
for it in s['strem']:
    if isinstance(it, dict) and it.get('loc', '').strip(): need.add(it['loc'].strip())
h = json.load(open(p('data', 'ukharbours.json')))
for x in (h if isinstance(h, list) else h.get('harbours', [])):
    if not isinstance(x, dict): continue
    for f in ('access', 'lock', 'bridge', 'notes'):
        v = x.get(f)
        if isinstance(v, str) and v.strip(): need.add(v.strip())
need = {t for t in need if any(c.isalpha() for c in t)}

done = set(json.load(open(p('data', 'texts_en.json'))))
missing = sorted(need - done)
stale = len(done - need)
print(f"teksten in data: {len(need)} | vertaald: {len(done)} | NIEUW/onvertaald: {len(missing)} | verouderd in tabel: {stale}")
if missing:
    out = p('data', 'onvertaald.json')
    json.dump(missing, open(out, 'w'), ensure_ascii=False, indent=1)
    print(f"→ nieuwe teksten weggeschreven naar {out}")
    for t in missing[:20]:
        print("  -", t[:100].replace("\n", " "))
    if len(missing) > 20: print(f"  … en {len(missing)-20} meer")
else:
    print("alles vertaald ✔")
