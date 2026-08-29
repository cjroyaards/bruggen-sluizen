#!/usr/bin/env python3
"""Controleert het vaarwegennetwerk op verbindingen dwars over land.

`build_net.py` verzint zelf een aantal verbindingen: het vaargrid over open
water, de aanhechting daarvan aan het lijnennetwerk, koppelingen tussen
aangrenzende wateren, sluisdoorgangen en het aaneenknopen van gelijknamige
vaarwegen. Die zijn gemarkeerd (5e element = 1). Elke zo'n verbinding hoort
over water te lopen; loopt hij over land, dan snijdt de routeplanner door een
dijk of polder heen.

Een punt telt als water wanneer het:
  - binnen een watervlak uit de merencache ligt, óf
  - binnen 45 m van een échte OSM-vaarweglijn uit het netwerk ligt.

Draaien: python3 scripts/audit_net.py [maxmeldingen]
Exit 1 als er verdachte verbindingen zijn.
"""
import gzip, json, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_net import assemble_rings, dp_simplify, LAKE_CACHE  # noqa: E402

import numpy as np  # noqa: E402

NET = os.path.join(os.path.dirname(__file__), "..", "data", "net.json.gz")
STAP_M = 25.0          # afstand tussen controlepunten
DROOG_M = 70.0         # aaneengesloten droge lengte die we een fout noemen
BIJ_LIJN_M = 45.0      # zo dicht bij een echte vaarweg telt als water


def laad_meren():
    if not os.path.exists(LAKE_CACHE):
        print("merencache ontbreekt; draai eerst scripts/build_net.py", file=sys.stderr)
        return []
    d = json.load(open(LAKE_CACHE))
    meren = []
    for el in (e for e in d["elements"] if "tags" in e):
        ringen = [(rol, dp_simplify(r, 30.0)) for rol, r in assemble_rings(el)]
        ringen = [(rol, r) for rol, r in ringen if len(r) > 3]
        if not ringen:
            continue
        pts = [p for _, r in ringen for p in r]
        meren.append({
            "ringen": ringen,
            "bb": (min(p[0] for p in pts), max(p[0] for p in pts),
                   min(p[1] for p in pts), max(p[1] for p in pts)),
        })
    return meren


def in_water(pts, meren):
    """even-odd via windingregel: outer minus inner, per meer"""
    res = np.zeros(len(pts), bool)
    mn_la, mx_la = pts[:, 0].min(), pts[:, 0].max()
    mn_lo, mx_lo = pts[:, 1].min(), pts[:, 1].max()
    for m in meren:
        b0, b1, b2, b3 = m["bb"]
        if mx_la < b0 or mn_la > b1 or mx_lo < b2 or mn_lo > b3:
            continue
        io = np.zeros(len(pts), bool)
        ii = np.zeros(len(pts), bool)
        for rol, ring in m["ringen"]:
            r = np.asarray(ring, float)
            y1, x1 = r[:-1, 0][None, :], r[:-1, 1][None, :]
            y2, x2 = r[1:, 0][None, :], r[1:, 1][None, :]
            py, px = pts[:, 0][:, None], pts[:, 1][:, None]
            links = (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1)
            wn = (((y1 <= py) & (y2 > py) & (links > 0)).sum(axis=1)
                  - ((y1 > py) & (y2 <= py) & (links < 0)).sum(axis=1))
            (io if rol == "o" else ii)[:] |= wn != 0
        res |= io & ~ii
        if res.all():
            break
    return res


def main():
    maxmeld = int(sys.argv[1]) if len(sys.argv) > 1 else 25
    d = json.load(gzip.open(NET))
    namen = d["names"]

    echt, verzonnen = [], []
    for e in d["e"]:
        flat = e[1]
        la, lo = flat[0], flat[1]
        pts = [(la, lo)]
        for i in range(2, len(flat), 2):
            la += flat[i]; lo += flat[i + 1]
            pts.append((la, lo))
        (verzonnen if (len(e) > 4 and e[4]) else echt).append((namen[e[0]], pts))
    print(f"{len(echt)} echte vaarwegvakken, {len(verzonnen)} zelfgemaakte verbindingen")

    # celindex over de échte vaarweglijnen (cel ≈ 100 m)
    cel = {}
    for _, pts in echt:
        for a, b in zip(pts, pts[1:]):
            for p in (a, b):
                cel.setdefault((p[0] // 90, p[1] // 145), []).append((a, b))

    def bij_lijn(p):
        py, px = p[0] * 1.1132, p[1] * 1.1132 * math.cos(math.radians(p[0] / 1e5))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for a, b in cel.get((p[0] // 90 + dy, p[1] // 145 + dx), []):
                    ay, ax = a[0] * 1.1132, a[1] * 1.1132 * math.cos(math.radians(a[0] / 1e5))
                    by, bx = b[0] * 1.1132, b[1] * 1.1132 * math.cos(math.radians(b[0] / 1e5))
                    ddy, ddx = by - ay, bx - ax
                    L2 = ddy * ddy + ddx * ddx or 1e-9
                    t = max(0.0, min(1.0, ((py - ay) * ddy + (px - ax) * ddx) / L2))
                    if math.hypot(py - (ay + t * ddy), px - (ax + t * ddx)) < BIJ_LIJN_M:
                        return True
        return False

    meren = laad_meren()
    print(f"{len(meren)} watervlakken geladen")

    fout = []
    for naam, pts in verzonnen:
        for a, b in zip(pts, pts[1:]):
            dy = (b[0] - a[0]) * 1.1132
            dx = (b[1] - a[1]) * 1.1132 * math.cos(math.radians(a[0] / 1e5))
            lengte = math.hypot(dy, dx)
            if lengte < DROOG_M:
                continue
            n = max(2, int(lengte / STAP_M))
            samp = np.array([[a[0] + (i + 0.5) / n * (b[0] - a[0]),
                              a[1] + (i + 0.5) / n * (b[1] - a[1])] for i in range(n)])
            water = in_water(samp / 1e5, meren)
            for i in range(n):
                if not water[i] and bij_lijn((samp[i][0], samp[i][1])):
                    water[i] = True
            # langste aaneengesloten droge stuk
            langste = huidig = 0
            for w in water:
                huidig = 0 if w else huidig + 1
                langste = max(langste, huidig)
            droog_m = langste * (lengte / n)
            if droog_m > DROOG_M:
                fout.append((droog_m, naam, a, b, lengte))

    fout.sort(reverse=True)
    print(f"\n{len(fout)} verbindingen lopen over land (>{DROOG_M:.0f} m droog):")
    for droog, naam, a, b, lengte in fout[:maxmeld]:
        print(f"  {droog:5.0f} m droog van {lengte:5.0f} m · {naam or '(naamloos)':28s} "
              f"({a[0]/1e5:.4f},{a[1]/1e5:.4f}) -> ({b[0]/1e5:.4f},{b[1]/1e5:.4f})")
    if len(fout) > maxmeld:
        print(f"  … en nog {len(fout)-maxmeld}")
    return 1 if fout else 0


if __name__ == "__main__":
    sys.exit(main())
