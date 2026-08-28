#!/usr/bin/env python3
"""Bouwt het vaarwegennetwerk voor de routeplanner: data/net.json.gz.

Haalt alle bevaarbare waterlijnen (waterway=river|canal) voor Nederland +
randgebied op uit OpenStreetMap (Overpass), filtert duikers en verboden water
eruit, knipt de lijnen op splitsingen in kanten (edges), vereenvoudigt de
geometrie (Douglas-Peucker, knooppunten blijven exact), en schrijft een
compact gzip-bestand:

  { "v": 1,
    "names": ["Rotte", ...],                 # vaarwegnamen (dedupliceerd)
    "e": [ [naamIdx, [lat0,lon0, dLat,dLon, ...]], ... ] }

Coördinaten als gehele getallen ×1e5, na het eerste punt delta-gecodeerd.
De app koppelt kanten aan elkaar op exact gelijke eindpuntcoördinaten.

Draaien: python3 scripts/build_net.py   (Overpass is traag — cache + mirrors)
"""
import gzip, json, math, os, sys, time, urllib.parse, urllib.request

BBOX = (50.70, 3.15, 53.60, 7.30)          # (zuid, west, noord, oost) — NL + randje B/D
CACHE = "/tmp/osm_net_nl.json"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "net.json.gz")
MIRRORS = ["https://overpass-api.de/api/interpreter",
           "https://lz4.overpass-api.de/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter"]
SIMPLIFY_M = 12.0                           # Douglas-Peucker-tolerantie (meter)


def fetch():
    if os.path.exists(CACHE):
        print("cache:", CACHE)
        return json.load(open(CACHE))
    q = (f'[out:json][timeout:600];'
         f'way["waterway"~"^(river|canal)$"]{BBOX};'
         f'out body; >; out skel qt;')
    for m in MIRRORS:
        for att in range(2):
            try:
                print("Overpass:", m)
                req = urllib.request.Request(m, data=urllib.parse.urlencode({"data": q}).encode(),
                                             headers={"User-Agent": "openpilot-net (bruggen-sluizen)"})
                with urllib.request.urlopen(req, timeout=900) as r:
                    d = json.load(r)
                json.dump(d, open(CACHE, "w"))
                return d
            except Exception as e:  # noqa: BLE001
                print(f"  mislukt ({e}), volgende poging/mirror", file=sys.stderr)
                time.sleep(10)
    raise SystemExit("FOUT: Overpass niet bereikbaar")


def keep(way):
    t = way.get("tags", {})
    if t.get("tunnel") in ("culvert", "flooded", "yes") and t.get("bridge") != "aqueduct":
        return t.get("tunnel") == "yes"     # echte vaartunnels bestaan amper; duikers eruit
    if t.get("boat") == "no" or t.get("motorboat") == "no" or t.get("ship") == "no":
        return False
    if t.get("intermittent") == "yes":
        return False
    return True


def dp_simplify(pts, tol_m):
    """Douglas-Peucker op (lat,lon)-lijst; eindpunten blijven altijd staan."""
    if len(pts) < 3:
        return pts
    lat0 = math.radians(pts[0][0])
    kx = 111320.0 * math.cos(lat0)
    ky = 111320.0

    def seg_dist(p, a, b):
        ax, ay = a[1] * kx, a[0] * ky
        bx, by = b[1] * kx, b[0] * ky
        px, py = p[1] * kx, p[0] * ky
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        if L2 == 0:
            return math.hypot(px - ax, py - ay)
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

    stack, out = [(0, len(pts) - 1)], {0, len(pts) - 1}
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        best, bi = -1.0, None
        for k in range(i + 1, j):
            dd = seg_dist(pts[k], pts[i], pts[j])
            if dd > best:
                best, bi = dd, k
        if best > tol_m:
            out.add(bi)
            stack.append((i, bi))
            stack.append((bi, j))
    return [pts[k] for k in sorted(out)]


"""---- groot open binnenwater: vaargrid over meerpolygonen -------------------
Op open water (IJsselmeer enz.) zijn er geen OSM-vaarlijnen. Daarom leggen we
er een grid overheen: punten om de ~250-500 m binnen het wateroppervlak (met
oevermarge), in 16 richtingen verbonden, en vastgeknoopt aan het gewone
netwerk bij havenmonden en sluisaanlopen. Waddenzee/Noordzee bewust niet
(droogvallende platen — echt kaartwerk)."""

# naam-regex → gridafstand in meters (kleinere afstand voor smalle wateren)
LAKES = [
    (r"^(IJsselmeer|Markermeer|Hollandsch Diep|Haringvliet|Oosterschelde|Grevelingenmeer)$", 500),
    (r"^(IJmeer|Gooimeer|Eemmeer|Nijkerkernauw|Wolderwijd|Nuldernauw|Veluwemeer|Drontermeer"
     r"|Vossemeer|Ketelmeer|Zwarte Meer|Veerse Meer|Krammer|Volkerak|Zoommeer"
     r"|Snitser Mar|Sneekermeer|Tsj.kemar|Tjeukemeer|Hegemer Mar|Heegermeer|Fluezen|Fluessen"
     r"|Alkmaardermeer|Braassemermeer|Westeinderplassen|Keeten|Mastgat|Zijpe"
     r"|Zuid Vlije|Noorder Krammer|Krabbenkreek|Slaak)$", 250),
]
LAKE_CACHE = "/tmp/osm_lakes.json"


def fetch_lakes():
    if os.path.exists(LAKE_CACHE):
        return json.load(open(LAKE_CACHE))
    rx = "|".join(r.strip("^$") for r, _ in LAKES)
    q = (f'[out:json][timeout:600];wr["natural"="water"]["name"~"^({rx})$"]{BBOX};'
         f'out body geom;')
    for m in MIRRORS:
        for _ in range(2):
            try:
                print("Overpass (meren):", m)
                req = urllib.request.Request(m, data=urllib.parse.urlencode({"data": q}).encode(),
                                             headers={"User-Agent": "openpilot-net (bruggen-sluizen)"})
                with urllib.request.urlopen(req, timeout=900) as r:
                    d = json.load(r)
                json.dump(d, open(LAKE_CACHE, "w"))
                return d
            except Exception as e:  # noqa: BLE001
                print(f"  mislukt ({e})", file=sys.stderr)
                time.sleep(10)
    raise SystemExit("FOUT: Overpass (meren) niet bereikbaar")


def assemble_rings(el):
    """Ringen (outer én inner, allebei nodig voor even-odd) uit een way of relation."""
    if el["type"] == "way":
        g = [(p["lat"], p["lon"]) for p in el.get("geometry", [])]
        return [g] if len(g) > 3 and g[0] == g[-1] else []
    segs = []
    for m in el.get("members", []):
        if m.get("type") == "way" and m.get("role") in ("outer", "inner", ""):
            g = [(p["lat"], p["lon"]) for p in m.get("geometry", [])]
            if len(g) >= 2:
                segs.append(g)
    rings = []
    while segs:
        cur = segs.pop()
        while cur[0] != cur[-1]:
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:   cur = cur + s[1:]; break
                if s[-1] == cur[-1]:  cur = cur + s[-2::-1]; break
                if s[-1] == cur[0]:   cur = s[:-1] + cur; break
                if s[0] == cur[0]:    cur = s[::-1][:-1] + cur; break
            else:
                break                 # open keten: weggooien
            segs.pop(i)
        if cur[0] == cur[-1] and len(cur) > 3:
            rings.append(cur)
    return rings


def lake_grids(edges, names, name_idx, nid):
    import numpy as np
    import re as _re

    d = fetch_lakes()
    lakes = []
    for el in (e for e in d["elements"] if "tags" in e):
        naam = el["tags"].get("name", "")
        for rx, sp in LAKES:
            if _re.match(rx, naam):
                rings = [dp_simplify(r, 30.0) for r in assemble_rings(el)]
                rings = [r for r in rings if len(r) > 3]
                if rings:
                    lakes.append({"naam": naam, "sp": sp, "rings": rings})
                break
    # zelfde naam meermaals (bv. Volkerak als way én relation): grootste houden
    best = {}
    for lk in lakes:
        n = sum(len(r) for r in lk["rings"])
        if lk["naam"] not in best or n > best[lk["naam"]][0]:
            best[lk["naam"]] = (n, lk)
    lakes = [v[1] for v in best.values()]
    print(f"{len(lakes)} meerpolygonen")

    def inside(pts, rings):
        """even-odd puntinpolygoon, gevectoriseerd en in blokken (geheugen); pts (N,2) lat,lon"""
        pts = np.asarray(pts, float)
        res = np.zeros(len(pts), bool)
        for ring in rings:
            r = np.asarray(ring, float)
            y1, x1 = r[:-1, 0][None, :], r[:-1, 1][None, :]
            y2, x2 = r[1:, 0][None, :],  r[1:, 1][None, :]
            with np.errstate(divide="ignore", invalid="ignore"):
                helling = (x2 - x1) / (y2 - y1)
            for i in range(0, len(pts), 1000):
                py = pts[i:i + 1000, 0][:, None]
                px = pts[i:i + 1000, 1][:, None]
                cross = ((y1 > py) != (y2 > py)) & (px < x1 + (py - y1) * helling)
                res[i:i + 1000] ^= (cross.sum(axis=1) % 2).astype(bool)
        return res

    # bestaande knooppunten (voor aanhechting) in een celindex
    endpoints = set()
    for _, flat in edges:
        n = len(flat)
        la, lo = flat[0], flat[1]
        endpoints.add((la, lo))
        for i in range(2, n, 2):
            la += flat[i]; lo += flat[i + 1]
        endpoints.add((la, lo))
    ep = np.array(sorted(endpoints), dtype=np.int64) if endpoints else np.zeros((0, 2), np.int64)

    all_grid = {}                     # (la1e5,lo1e5) -> lake-index (voor onderlinge hechting)
    DIRS = [(1, 0), (0, 1), (1, 1), (1, -1), (2, 1), (1, 2), (2, -1), (1, -2)]
    n_nodes = n_edges = n_conn = 0

    for li, lk in enumerate(lakes):
        rings, sp = lk["rings"], lk["sp"]
        nm = nid(lk["naam"])
        allpts = np.array([p for r in rings for p in r], float)
        la0, la1 = allpts[:, 0].min(), allpts[:, 0].max()
        lo0, lo1 = allpts[:, 1].min(), allpts[:, 1].max()
        latm = (la0 + la1) / 2
        dla = sp / 111320.0
        dlo = sp / (111320.0 * math.cos(math.radians(latm)))
        gy = np.arange(la0, la1, dla)
        gx = np.arange(lo0, lo1, dlo)
        if len(gy) * len(gx) > 80000:
            print(f"  {lk['naam']}: te veel cellen, overslaan"); continue
        YY, XX = np.meshgrid(gy, gx, indexing="ij")
        cand = np.column_stack([YY.ravel(), XX.ravel()])
        # erosie: punt + 8 halfstap-buren moeten binnen liggen (oevermarge ~ sp/2)
        ok = np.ones(len(cand), bool)
        for oy in (-.5, 0, .5):
            for ox in (-.5, 0, .5):
                ok &= inside(cand + [oy * dla, ox * dlo], rings)
        pts = cand[ok]
        idx = {}
        for la, lo in pts:
            k = (round(la * 1e5), round(lo * 1e5))
            idx[(round((la - la0) / dla), round((lo - lo0) / dlo))] = k
            all_grid[k] = li
        n_nodes += len(idx)
        # verbindingen in 16 richtingen; middelpunt(en) moeten binnen liggen
        pend = []
        for (iy, ix), ka in idx.items():
            for dy, dx in DIRS:
                kb = idx.get((iy + dy, ix + dx))
                if kb:
                    pend.append((ka, kb))
        if pend:
            mids = np.array([[(a[0] + b[0]) / 2e5, (a[1] + b[1]) / 2e5] for a, b in pend])
            okm = inside(mids, rings)
            for (ka, kb), o in zip(pend, okm):
                if o:
                    edges.append([nm, [ka[0], ka[1], kb[0] - ka[0], kb[1] - ka[1]]])
                    n_edges += 1
        # aanhechting: bestaande knooppunten binnen het meer-bbox aan dichtstbijzijnd gridpunt
        if len(ep) and idx:
            marge = int(4.0 * sp / 1.1132)          # in 1e-5-graadeenheden (breedte gecorrigeerd hieronder)
            sel = ep[(ep[:, 0] > (la0 - .01) * 1e5) & (ep[:, 0] < (la1 + .01) * 1e5)
                     & (ep[:, 1] > (lo0 - .01) * 1e5) & (ep[:, 1] < (lo1 + .01) * 1e5)]
            gridpts = np.array(list(idx.values()), dtype=np.int64)
            for la, lo in sel:
                dv = (gridpts - [la, lo]).astype(float)
                dv[:, 1] *= math.cos(math.radians(la / 1e5))
                dist = np.hypot(dv[:, 0], dv[:, 1])
                j = int(dist.argmin())
                if dist[j] > marge:
                    continue
                kb = tuple(gridpts[j])
                samp = np.array([[la / 1e5 + t * (kb[0] / 1e5 - la / 1e5),
                                  lo / 1e5 + t * (kb[1] / 1e5 - lo / 1e5)] for t in (0.5, 0.75)])
                if inside(samp, rings).all():
                    edges.append([nm, [int(la), int(lo), int(kb[0] - la), int(kb[1] - lo)]])
                    n_conn += 1

    # aangrenzende meren aan elkaar hechten (bv. Markermeer-IJmeer, Randmerenketen)
    cell = {}
    for k, li in all_grid.items():
        cell.setdefault((k[0] // 1200, k[1] // 1900), []).append((k, li))
    n_stitch = 0
    ring_by_lake = {i: lk["rings"] for i, lk in enumerate(lakes)}
    import numpy as np2
    for (cy, cx), items in cell.items():
        for oy in (0, 1):
            for ox in (-1, 0, 1):
                if (oy, ox) < (0, 0):
                    continue
                for ka, la_ in items:
                    for kb, lb_ in cell.get((cy + oy, cx + ox), []):
                        if la_ == lb_ or ((oy, ox) == (0, 0) and kb <= ka):
                            continue
                        dy = (kb[0] - ka[0]) * 1.1132
                        dx = (kb[1] - ka[1]) * 1.1132 * math.cos(math.radians(ka[0] / 1e5))
                        dist = math.hypot(dy, dx)
                        if dist > 1300:
                            continue
                        # élk tussenpunt (om de ~90 m) moet in een van beide watervlakken
                        # liggen — anders steek je een dam over (Houtribdijk!)
                        ns = max(6, int(dist / 90))
                        ts = [(i + 1) / (ns + 1) for i in range(ns)]
                        samp = np2.array([[(ka[0] + t * (kb[0] - ka[0])) / 1e5,
                                           (ka[1] + t * (kb[1] - ka[1])) / 1e5] for t in ts])
                        ok_a = inside(samp, ring_by_lake[la_])
                        ok_b = inside(samp, ring_by_lake[lb_])
                        if (ok_a | ok_b).all():
                            edges.append([nid("open water"), [ka[0], ka[1], kb[0] - ka[0], kb[1] - ka[1]]])
                            n_stitch += 1
    # sluizen die niet aan het lijnennetwerk liggen (bv. Krammersluizen in de
    # Philipsdam) als doorgang rijgen: dichtstbijzijnde waterpunten aan
    # weerszijden van de sluis verbinden, dwars door het sluispunt heen.
    n_lock = 0
    try:
        stat = json.load(gzip.open(os.path.join(os.path.dirname(OUT), "static.json.gz")))
        locks = [o for o in stat["objs"] if o.get("t") == "S"]
    except Exception as e:  # noqa: BLE001
        print(f"  static.json.gz niet leesbaar ({e}); sluisdoorgangen overgeslagen")
        locks = []
    if locks:
        # componenten van het huidige netwerk (lijnen + grid + hechtingen)
        from collections import defaultdict as _dd0
        adj0 = _dd0(list)
        for _, flat in edges:
            la, lo = flat[0], flat[1]
            a = (la, lo)
            for i in range(2, len(flat), 2):
                la += flat[i]; lo += flat[i + 1]
            adj0[a].append((la, lo)); adj0[(la, lo)].append(a)
        comp0 = {}
        c0 = 0
        for s in adj0:
            if s in comp0:
                continue
            stack = [s]; comp0[s] = c0
            while stack:
                n = stack.pop()
                for nb in adj0[n]:
                    if nb not in comp0:
                        comp0[nb] = c0; stack.append(nb)
            c0 += 1
        ccell = {}
        for k in adj0:
            ccell.setdefault((k[0] // 1400, k[1] // 2200), []).append(k)
        # sluizen die twee verschillende dammen/dijken doorsnijden waarvan beide
        # zijden tóch al (via een grote omweg) verbonden zijn, ontsnappen aan de
        # componentregel — die rijgen we op naam:
        ALTIJD = {"Krammersluizen", "Krammerjachtensluis"}
        for o in locks:
            la, lo = round(o["lat"] * 1e5), round(o["lon"] * 1e5)
            buren = []
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    for k in ccell.get((la // 1400 + dy, lo // 2200 + dx), []):
                        vy = (k[0] - la) * 1.1132
                        vx = (k[1] - lo) * 1.1132 * math.cos(math.radians(la / 1e5))
                        dist = math.hypot(vy, vx)
                        if 60 < dist < 1500:
                            buren.append((dist, k, math.atan2(vy, vx), comp0[k]))
            if len(buren) < 2:
                continue
            comps_hier = {b[3] for b in buren}
            forceer = o.get("n", "") in ALTIJD
            if len(comps_hier) < 2 and not forceer:
                continue                     # alles hangt hier al aan elkaar
            buren.sort()
            best = None
            for i in range(len(buren)):
                for j in range(i + 1, len(buren)):
                    if not forceer and buren[i][3] == buren[j][3]:
                        continue             # zelfde component: geen doorgang nodig
                    hoek = abs(buren[i][2] - buren[j][2])
                    hoek = min(hoek, 2 * math.pi - hoek)
                    if hoek > math.radians(100):
                        # geforceerde doorgangen: grootste hoek (echt óver de dam);
                        # anders: kortste verbinding tussen de twee componenten
                        score = -hoek if forceer else buren[i][0] + buren[j][0]
                        if best is None or score < best[0]:
                            best = (score, buren[i][1], buren[j][1])
                if best and not forceer:
                    break                    # dichtstbijzijnde i met geldige partner volstaat
            if best:
                _, ka, kb = best
                nm2 = nid(o.get("n", ""))
                edges.append([nm2, [ka[0], ka[1], la - ka[0], lo - ka[1], kb[0] - la, kb[1] - lo]])
                n_lock += 1
    # vangnet: losse netwerkcomponenten die via open water bereikbaar zijn alsnog
    # aan elkaar knopen (bv. een gridje dat nét niet aan de sluisaanloop hecht)
    lake_bbox = []
    for lk in lakes:
        allp = np.array([p for r in lk["rings"] for p in r], float)
        lake_bbox.append((allp[:, 0].min(), allp[:, 0].max(), allp[:, 1].min(), allp[:, 1].max()))

    def inside_any(pts):
        res = np.zeros(len(pts), bool)
        mn_la, mn_lo = pts[:, 0].min(), pts[:, 1].min()
        mx_la, mx_lo = pts[:, 0].max(), pts[:, 1].max()
        for lk, (b0, b1, b2, b3) in zip(lakes, lake_bbox):
            if mx_la < b0 or mn_la > b1 or mx_lo < b2 or mn_lo > b3:
                continue
            res |= inside(pts, lk["rings"])
            if res.all():
                break
        return res

    from collections import defaultdict as _dd
    adj = _dd(list)
    for _, flat in edges:
        la, lo = flat[0], flat[1]
        a = (la, lo)
        for i in range(2, len(flat), 2):
            la += flat[i]; lo += flat[i + 1]
        adj[a].append((la, lo)); adj[(la, lo)].append(a)
    comp = {}
    cid = 0
    for s in adj:
        if s in comp:
            continue
        stack = [s]; comp[s] = cid
        while stack:
            n = stack.pop()
            for nb in adj[n]:
                if nb not in comp:
                    comp[nb] = cid; stack.append(nb)
        cid += 1
    csize = _dd(int)
    for n, c in comp.items():
        csize[c] += 1
    bcell = _dd(list)
    for n, c in comp.items():
        bcell[(n[0] // 1400, n[1] // 2200)].append((n, c))
    gedaan = set()
    n_bridge = 0
    for (cy, cx), items in bcell.items():
        for oy in (0, 1):
            for ox in (-1, 0, 1):
                if (oy, ox) < (0, 0):
                    continue
                for ka, ca in items:
                    for kb, cb in bcell.get((cy + oy, cx + ox), []):
                        if ca == cb or ((oy, ox) == (0, 0) and kb <= ka):
                            continue
                        paar = (min(ca, cb), max(ca, cb))
                        if paar in gedaan or min(csize[ca], csize[cb]) < 3:
                            continue
                        dy = (kb[0] - ka[0]) * 1.1132
                        dx = (kb[1] - ka[1]) * 1.1132 * math.cos(math.radians(ka[0] / 1e5))
                        dist = math.hypot(dy, dx)
                        if dist > 2200:
                            continue
                        ns = max(6, int(dist / 90))
                        samp = np.array([[(ka[0] + (i + 1) / (ns + 1) * (kb[0] - ka[0])) / 1e5,
                                          (ka[1] + (i + 1) / (ns + 1) * (kb[1] - ka[1])) / 1e5]
                                         for i in range(ns)])
                        if inside_any(samp).all():
                            edges.append([nid("open water"), [ka[0], ka[1], kb[0] - ka[0], kb[1] - ka[1]]])
                            gedaan.add(paar)
                            n_bridge += 1
    print(f"vaargrid: {n_nodes} gridpunten, {n_edges} gridkanten, {n_conn} aanhechtingen, "
          f"{n_stitch} meerkoppelingen, {n_lock} sluisdoorgangen, {n_bridge} componentbruggen")


def main():
    d = fetch()
    nodes = {e["id"]: (e["lat"], e["lon"]) for e in d["elements"] if e["type"] == "node"}
    ways = [w for w in d["elements"] if w["type"] == "way" and keep(w)]
    print(f"{len(ways)} bruikbare ways, {len(nodes)} nodes")

    use = {}
    for w in ways:
        nds = [n for n in w["nodes"] if n in nodes]
        w["nodes"] = nds
        for n in nds:
            use[n] = use.get(n, 0) + 1
        if nds:
            use[nds[0]] += 1          # eindpunten tellen dubbel → altijd knooppunt
            use[nds[-1]] += 1

    names, name_idx = [], {}

    def nid(nm):
        if nm not in name_idx:
            name_idx[nm] = len(names)
            names.append(nm)
        return name_idx[nm]

    def rnd(n):
        la, lo = nodes[n]
        return (round(la * 1e5), round(lo * 1e5))

    edges = []
    for w in ways:
        nm = nid(w.get("tags", {}).get("name", ""))
        nds = w["nodes"]
        if len(nds) < 2:
            continue
        # knippen op knooppunten (gebruik >= 2)
        cut = [0] + [i for i in range(1, len(nds) - 1) if use[nds[i]] >= 2] + [len(nds) - 1]
        for a, b in zip(cut, cut[1:]):
            chain = nds[a:b + 1]
            if len(chain) < 2:
                continue
            pts = [nodes[n] for n in chain]
            simp = dp_simplify(pts, SIMPLIFY_M)
            # eindpunten exact op de knooppuntafronding, rest gewoon afgerond
            ip = [rnd(chain[0])] + [(round(la * 1e5), round(lo * 1e5)) for la, lo in simp[1:-1]] + [rnd(chain[-1])]
            if ip[0] == ip[-1] and len(ip) <= 2:
                continue
            flat = [ip[0][0], ip[0][1]]
            for (la, lo), (pla, plo) in zip(ip[1:], ip[:-1]):
                flat += [la - pla, lo - plo]
            edges.append([nm, flat])

    lake_grids(edges, names, name_idx, nid)

    out = {"v": 1, "names": names, "e": edges}
    raw = json.dumps(out, separators=(",", ":")).encode()
    with gzip.open(OUT, "wb", compresslevel=9) as f:
        f.write(raw)
    npts = sum((len(e[1]) - 2) // 2 + 1 for e in edges)
    print(f"net.json.gz: {len(edges)} kanten, {npts} punten, "
          f"{len(raw) / 1e6:.1f} MB raw, {os.path.getsize(OUT) / 1e6:.1f} MB gzip")


if __name__ == "__main__":
    main()
