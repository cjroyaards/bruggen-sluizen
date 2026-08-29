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


KF_OPEN = 112      # open water: prima om over te steken, maar iets minder "vanzelf"
CEMT_KOST = {"VII": 100, "VIb": 100, "VIa": 100, "VI": 100, "Vb": 100, "Va": 100,
             "IV": 106, "III": 118, "II": 132, "I": 145, "0": 160}


def kostfactor(tags):
    """Voorkeursfactor per vaarweg (×100). Hoofdvaarwegen tellen hun echte lengte,
    kleine wateren tellen zwaarder — anders knipt de kortste-pad-zoeker dwars door
    sloten en poldervaarten in plaats van via het Prinses Margrietkanaal te gaan."""
    c = (tags.get("CEMT") or "").strip()
    if c in CEMT_KOST:
        return CEMT_KOST[c]
    br = tags.get("width") or tags.get("maxwidth")
    try:
        if br and float(str(br).split()[0]) >= 20:
            return 120
    except ValueError:
        pass
    if tags.get("waterway") == "river" and tags.get("name"):
        return 125
    if tags.get("name"):
        return 150
    return 185                       # naamloos slootje: alleen als het echt moet


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


MIN_OPP_KM2 = 0.5          # kleiner dan dit heeft geen eigen vaargrid nodig
OEVER_M = 70               # vaste afstand tot de oever voor gridpunten
GRID_VANAF_KM2 = 2.0       # alleen echt open water krijgt een vaargrid


def _overpass(q, wat):
    for m in MIRRORS:
        for _ in range(2):
            try:
                print(f"Overpass ({wat}):", m)
                req = urllib.request.Request(m, data=urllib.parse.urlencode({"data": q}).encode(),
                                             headers={"User-Agent": "openpilot-net (bruggen-sluizen)"})
                with urllib.request.urlopen(req, timeout=900) as r:
                    return json.load(r)
            except Exception as e:  # noqa: BLE001
                print(f"  mislukt ({e})", file=sys.stderr)
                time.sleep(10)
    raise SystemExit(f"FOUT: Overpass ({wat}) niet bereikbaar")


def fetch_lakes():
    """Alle benoemde wateroppervlakken boven MIN_OPP_KM2 — niet een handmatige
    namenlijst, want vaarwegen lopen door tientallen meren (het Prinses
    Margrietkanaal alleen al door de Grutte Brekken, De Kûfurd, Snitser Mar,
    Pikmeer, Wide Ie en de Burgumer Mar). Twee stappen: eerst alleen de omvang
    opvragen, dan de geometrie van wat groot genoeg is."""
    if os.path.exists(LAKE_CACHE):
        return json.load(open(LAKE_CACHE))
    kop = _overpass(f'[out:json][timeout:600];wr["natural"="water"]["name"]{BBOX};out tags bb;', "meren-index")
    ids_w, ids_r, opp = [], [], {}
    for e in kop["elements"]:
        b = e.get("bounds")
        if not b:
            continue
        dla = (b["maxlat"] - b["minlat"]) * 111.32
        dlo = (b["maxlon"] - b["minlon"]) * 111.32 * math.cos(math.radians(b["minlat"]))
        o = dla * dlo
        if o < MIN_OPP_KM2:
            continue
        opp[(e["type"], e["id"])] = o
        (ids_w if e["type"] == "way" else ids_r).append(e["id"])
    print(f"meren ≥ {MIN_OPP_KM2} km²: {len(ids_w)} ways + {len(ids_r)} relations")
    els = []
    for i in range(0, max(len(ids_w), len(ids_r)), 300):
        w = ",".join(map(str, ids_w[i:i + 300]))
        r = ",".join(map(str, ids_r[i:i + 300]))
        delen = (f"way(id:{w});" if w else "") + (f"rel(id:{r});" if r else "")
        if not delen:
            continue
        els += _overpass(f"[out:json][timeout:600];({delen});out body geom;", "meren-geometrie")["elements"]
    d = {"elements": els, "opp": {f"{k[0]}/{k[1]}": v for k, v in opp.items()}}
    json.dump(d, open(LAKE_CACHE, "w"))
    return d


SPAN_CACHE = "/tmp/osm_spans.json"


def fetch_spans(bboxes):
    """Lange brugoverspanningen (Zeelandbrug, Ketelbrug, …) uit OSM.
    Op open water staat een brug in de RWS-data als één of twee punten, terwijl
    het bouwwerk kilometers lang is — een route kruist hem dan zonder dat het
    puntje binnen 60 m ligt. Daarom halen we de echte overspanningslijnen op."""
    if os.path.exists(SPAN_CACHE):
        return json.load(open(SPAN_CACHE))
    delen = "".join(f'way["bridge"]["highway"]{b};way["bridge"]["railway"]{b};' for b in bboxes)
    q = f"[out:json][timeout:600];({delen});out geom;"
    for m in MIRRORS:
        for _ in range(2):
            try:
                print("Overpass (bruggen):", m)
                req = urllib.request.Request(m, data=urllib.parse.urlencode({"data": q}).encode(),
                                             headers={"User-Agent": "openpilot-net (bruggen-sluizen)"})
                with urllib.request.urlopen(req, timeout=900) as r:
                    d = json.load(r)
                json.dump(d, open(SPAN_CACHE, "w"))
                return d
            except Exception as e:  # noqa: BLE001
                print(f"  mislukt ({e})", file=sys.stderr)
                time.sleep(10)
    print("  bruggen niet opgehaald; overspanningen overgeslagen", file=sys.stderr)
    return {"elements": []}


def assemble_rings(el):
    """Ringen als (rol, ring)-paren ('o' buiten, 'i' gat) uit een way of relation.
    Eindpunten worden op 1e-7 graad afgerond gekoppeld via een index, zodat ook
    grote multipolygonen (Grevelingen: 195 leden) betrouwbaar sluiten."""
    def key(p):
        return (round(p[0] * 1e7), round(p[1] * 1e7))

    if el["type"] == "way":
        g = [(p["lat"], p["lon"]) for p in el.get("geometry", [])]
        return [("o", g)] if len(g) > 3 and key(g[0]) == key(g[-1]) else []
    rings = []
    for rol in (("outer", ""), ("inner",)):       # rollen apart: eilanden die de oever
        segs = []                                  # raken mogen de buitenring niet kapen
        for m in el.get("members", []):
            if m.get("type") == "way" and m.get("role", "") in rol:
                g = [(p["lat"], p["lon"]) for p in m.get("geometry", [])]
                if len(g) >= 2:
                    segs.append(g)
        idx = {}
        for i, s in enumerate(segs):
            for k in (key(s[0]), key(s[-1])):
                idx.setdefault(k, []).append(i)
        used = [False] * len(segs)
        for start in range(len(segs)):
            if used[start]:
                continue
            used[start] = True
            cur = list(segs[start])
            while key(cur[0]) != key(cur[-1]):
                k = key(cur[-1])
                volgende = next((j for j in idx.get(k, []) if not used[j]), None)
                if volgende is None:
                    break                          # open keten
                used[volgende] = True
                s = segs[volgende]
                cur += s[1:] if key(s[0]) == k else s[-2::-1]
            if key(cur[0]) == key(cur[-1]) and len(cur) > 3:
                rings.append(("o" if "outer" in rol or "" in rol else "i", cur))
    return rings


def lake_grids(edges, names, name_idx, nid):
    import numpy as np
    import re as _re

    d = fetch_lakes()
    lakes = []
    for el in (e for e in d["elements"] if "tags" in e):
        naam = el["tags"].get("name", "")
        rings = [(rol, dp_simplify(r, 30.0)) for rol, r in assemble_rings(el)]
        rings = [(rol, r) for rol, r in rings if len(r) > 3]
        if not rings:
            continue
        # échte oppervlakte (niet de bbox: het Veerse Meer is smal maar 20 km lang)
        opp_km2 = 0.0
        for rol, r in rings:
            a = 0.0
            for (y1, x1), (y2, x2) in zip(r, r[1:]):
                a += (x2 - x1) * (y2 + y1) / 2
            km2 = abs(a) * 111.32 * 111.32 * math.cos(math.radians(r[0][0]))
            opp_km2 += km2 if rol == "o" else -km2
        if opp_km2 < GRID_VANAF_KM2:
            continue          # klein water: het lijnennetwerk volstaat, en een grid
                              # zou hier langs sluizen heen kunnen snijden
        sp = 500 if opp_km2 >= 60 else (350 if opp_km2 >= 12 else 250)
        lakes.append({"naam": naam, "sp": sp, "rings": rings, "opp": opp_km2})
    # zelfde water tweemaal (bv. Volkerak als way én relation): grootste houden —
    # maar alleen als de bboxen elkaar overlappen, want dezelfde naam komt ook
    # voor bij heel andere wateren elders in het land
    def bbox(lk):
        pts = [p for _, r in lk["rings"] for p in r]
        return (min(p[0] for p in pts), max(p[0] for p in pts),
                min(p[1] for p in pts), max(p[1] for p in pts))

    per_naam = {}
    for lk in lakes:
        per_naam.setdefault(lk["naam"], []).append((bbox(lk), lk))
    lakes = []
    for naam, groep in per_naam.items():
        houden = []
        for bb, lk in sorted(groep, key=lambda g: -g[1]["opp"]):
            if any(not (bb[1] < b2[0] or bb[0] > b2[1] or bb[3] < b2[2] or bb[2] > b2[3])
                   for b2, _ in houden):
                continue                       # overlapt met een groter exemplaar
            houden.append((bb, lk))
        lakes += [lk for _, lk in houden]
    print(f"{len(lakes)} meerpolygonen")

    def inside(pts, rings):
        """puntinpolygoon met de winding-regel (nonzero) — robuust tegen zichzelf
        kruisende buitenringen (Grevelingen) — outer-union minus inner-union;
        gevectoriseerd en in blokken (geheugen); pts (N,2) lat,lon"""
        pts = np.asarray(pts, float)
        in_o = np.zeros(len(pts), bool)
        in_i = np.zeros(len(pts), bool)
        for rol, ring in rings:
            r = np.asarray(ring, float)
            y1, x1 = r[:-1, 0][None, :], r[:-1, 1][None, :]
            y2, x2 = r[1:, 0][None, :],  r[1:, 1][None, :]
            doel = in_o if rol == "o" else in_i
            for i in range(0, len(pts), 1000):
                py = pts[i:i + 1000, 0][:, None]
                px = pts[i:i + 1000, 1][:, None]
                links = (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1)
                wn = (((y1 <= py) & (y2 > py) & (links > 0)).sum(axis=1)
                      - ((y1 > py) & (y2 <= py) & (links < 0)).sum(axis=1))
                doel[i:i + 1000] |= wn != 0
        return in_o & ~in_i

    # bestaande knooppunten (voor aanhechting) in een celindex
    endpoints = set()
    for e_ in edges:
        flat = e_[1]
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
        allpts = np.array([p for _, r in rings for p in r], float)
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
        # erosie: punt + 8 buren op een váste oevermarge moeten binnen liggen.
        # (Niet schalen met de gridafstand: dan vallen smalle delen zoals het
        # oostelijk Veerse Meer helemaal leeg.)
        mla = OEVER_M / 111320.0
        mlo = OEVER_M / (111320.0 * math.cos(math.radians(latm)))
        ok = np.ones(len(cand), bool)
        for oy in (-1, 0, 1):
            for ox in (-1, 0, 1):
                ok &= inside(cand + [oy * mla, ox * mlo], rings)
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
                    edges.append([nm, [ka[0], ka[1], kb[0] - ka[0], kb[1] - ka[1]], KF_OPEN])
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
                    edges.append([nm, [int(la), int(lo), int(kb[0] - la), int(kb[1] - lo)], KF_OPEN])
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
                        # élk tussenpunt in water én ergens een punt dat in béíde
                        # watervlakken ligt: dan sluiten ze op elkaar aan. Zonder
                        # zo'n overlap zit er iets tussen (Houtribdijk!) en mag je
                        # alleen via een sluis of kanaal oversteken.
                        if (ok_a | ok_b).all() and (ok_a & ok_b).any():
                            edges.append([nid("open water"), [ka[0], ka[1], kb[0] - ka[0], kb[1] - ka[1]], KF_OPEN])
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
        for e_ in edges:
            flat = e_[1]
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
                edges.append([nm2, [ka[0], ka[1], la - ka[0], lo - ka[1], kb[0] - la, kb[1] - lo], KF_OPEN])
                n_lock += 1
    # vangnet: losse netwerkcomponenten die via open water bereikbaar zijn alsnog
    # aan elkaar knopen (bv. een gridje dat nét niet aan de sluisaanloop hecht)
    lake_bbox = []
    for lk in lakes:
        allp = np.array([p for _, r in lk["rings"] for p in r], float)
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

    def inside_one(pts):
        """helemaal binnen één en hetzelfde watervlak — zo kan een verbinding
        nooit ongemerkt van het ene naar het andere water springen"""
        mn_la, mn_lo = pts[:, 0].min(), pts[:, 1].min()
        mx_la, mx_lo = pts[:, 0].max(), pts[:, 1].max()
        for lk, (b0, b1, b2, b3) in zip(lakes, lake_bbox):
            if mx_la < b0 or mn_la > b1 or mx_lo < b2 or mn_lo > b3:
                continue
            if inside(pts, lk["rings"]).all():
                return True
        return False

    from collections import defaultdict as _dd
    adj = _dd(list)
    for e_ in edges:
        flat = e_[1]
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
                        if inside_one(samp):
                            edges.append([nid("open water"), [ka[0], ka[1], kb[0] - ka[0], kb[1] - ka[1]], KF_OPEN])
                            gedaan.add(paar)
                            n_bridge += 1
    print(f"vaargrid: {n_nodes} gridpunten, {n_edges} gridkanten, {n_conn} aanhechtingen, "
          f"{n_stitch} meerkoppelingen, {n_lock} sluisdoorgangen, {n_bridge} componentbruggen")

    # ---- lange brugoverspanningen over open water ------------------------
    spans = []
    bboxes = []
    for lk, (b0, b1, b2, b3) in zip(lakes, lake_bbox):
        bboxes.append(f"({b0:.4f},{b2:.4f},{b1:.4f},{b3:.4f})")
    ways = [w for w in fetch_spans(bboxes)["elements"] if w.get("type") == "way" and w.get("geometry")]
    try:
        stat2 = json.load(gzip.open(os.path.join(os.path.dirname(OUT), "static.json.gz")))
        bruggen = [o for o in stat2["objs"] if o.get("t") == "B"]
    except Exception:  # noqa: BLE001
        bruggen = []
    gezien = set()
    for w in ways:
        g = [(p["lat"], p["lon"]) for p in w["geometry"]]
        lengte = sum(math.hypot((b[0] - a[0]) * 111320,
                                (b[1] - a[1]) * 111320 * math.cos(math.radians(a[0])))
                     for a, b in zip(g, g[1:]))
        if lengte < 250:
            continue
        mid = np.array([[(g[len(g) // 2][0]), (g[len(g) // 2][1])]])
        if not inside_any(mid).any():
            continue                                  # brug niet over groot open water
        simp = dp_simplify(g, 40.0)
        ip = [(round(la * 1e5), round(lo * 1e5)) for la, lo in simp]
        sleutel = (ip[0], ip[-1])
        if sleutel in gezien:
            continue
        gezien.add(sleutel)
        # bijbehorende RWS-brugobjecten: binnen 2,5 km van de overspanningslijn
        ids = []
        for o in bruggen:
            ola, olo = o["lat"], o["lon"]
            best = min(math.hypot((ola - a[0]) * 111320,
                                  (olo - a[1]) * 111320 * math.cos(math.radians(ola))) for a in simp)
            if best < 2500:
                ids.append(o["id"])
        if not ids:
            continue
        flat = [ip[0][0], ip[0][1]]
        for (la, lo), (pla, plo) in zip(ip[1:], ip[:-1]):
            flat += [la - pla, lo - plo]
        spans.append([flat, ids])
    print(f"overspanningen: {len(spans)} bruggen over open water")
    return spans


def knoop_gelijknamig(edges, names):
    """Vaarwegen die door een meer lopen (Prinses Margrietkanaal door de Groote
    Brekken, het Koevordermeer, …) staan in OSM als losse stukken: in het meer
    houdt de lijn op. Losse uiteinden van een vaarweg met dezelfde naam, die
    dicht bij elkaar liggen en nu niet verbonden zijn, horen bij elkaar."""
    from collections import defaultdict as _dd
    graad = _dd(int)
    info = []                                  # (naamIdx, punt_a, punt_b)
    for e in edges:
        flat = e[1]
        la, lo = flat[0], flat[1]
        a = (la, lo)
        for i in range(2, len(flat), 2):
            la += flat[i]; lo += flat[i + 1]
        b = (la, lo)
        graad[a] += 1; graad[b] += 1
        info.append((e[0], a, b))

    adj = _dd(list)
    for _, a, b in info:
        adj[a].append(b); adj[b].append(a)
    comp = {}
    c = 0
    for s in adj:
        if s in comp:
            continue
        stack = [s]; comp[s] = c
        while stack:
            n = stack.pop()
            for nb in adj[n]:
                if nb not in comp:
                    comp[nb] = c; stack.append(nb)
        c += 1

    los = _dd(list)                            # naamIdx -> losse uiteinden
    for ni, a, b in info:
        if not names[ni]:
            continue                           # naamloos: te riskant
        for p in (a, b):
            if graad[p] == 1:
                los[ni].append(p)

    n_knoop = 0
    for ni, pts in los.items():
        paren = []
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                a, b = pts[i], pts[j]
                dy = (b[0] - a[0]) * 1.1132
                dx = (b[1] - a[1]) * 1.1132 * math.cos(math.radians(a[0] / 1e5))
                dd = math.hypot(dy, dx)
                if dd <= 2500:
                    paren.append((dd, a, b))
        paren.sort()
        for dd, a, b in paren:
            if comp.get(a) == comp.get(b):
                continue                       # al verbonden: geen sluiproute maken
            edges.append([ni, [a[0], a[1], b[0] - a[0], b[1] - a[1]], 100])
            oud, nieuw = comp[b], comp[a]
            for k, v in comp.items():
                if v == oud:
                    comp[k] = nieuw
            n_knoop += 1
    print(f"gelijknamige vaarwegen aaneengeknoopt: {n_knoop} verbindingen")


def zet_hoogtes(edges):
    """Vaste bruggen bepalen de doorvaarthoogte van het stukje vaarweg eronder.
    Per vaste brug zoeken we de dichtstbijzijnde kant en zetten daar de hoogte
    op (in decimeters), zodat de planner met een opgegeven doorvaarthoogte om
    te lage bruggen heen kan zoeken."""
    try:
        stat = json.load(gzip.open(os.path.join(os.path.dirname(OUT), "static.json.gz")))
    except Exception as e:  # noqa: BLE001
        print(f"  static.json.gz niet leesbaar ({e}); hoogtes overgeslagen", file=sys.stderr)
        return
    vast = [o for o in stat["objs"]
            if o.get("t") == "B" and not o.get("open") and o.get("hf") is not None]

    cel = {}                                   # celindex van segmenten
    for ei, e in enumerate(edges):
        flat = e[1]
        la, lo = flat[0], flat[1]
        pts = [(la, lo)]
        for i in range(2, len(flat), 2):
            la += flat[i]; lo += flat[i + 1]
            pts.append((la, lo))
        for (a, b) in zip(pts, pts[1:]):
            for k in {(a[0] // 500, a[1] // 800), (b[0] // 500, b[1] // 800)}:
                cel.setdefault(k, []).append((ei, a, b))

    n = 0
    for o in vast:
        pla, plo = round(o["lat"] * 1e5), round(o["lon"] * 1e5)
        kx = math.cos(math.radians(o["lat"]))
        best = (1e18, None)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for ei, a, b in cel.get((pla // 500 + dy, plo // 800 + dx), []):
                    ay, ax = a[0] * 1.1132, a[1] * 1.1132 * kx
                    by, bx = b[0] * 1.1132, b[1] * 1.1132 * kx
                    py, px = pla * 1.1132, plo * 1.1132 * kx
                    ddy, ddx = by - ay, bx - ax
                    L2 = ddy * ddy + ddx * ddx or 1e-9
                    t = max(0.0, min(1.0, ((py - ay) * ddy + (px - ax) * ddx) / L2))
                    dd = math.hypot(py - (ay + t * ddy), px - (ax + t * ddx))
                    if dd < best[0]:
                        best = (dd, ei)
        if best[1] is None or best[0] > 45:
            continue
        e = edges[best[1]]
        while len(e) < 4:
            e.append(0)
        dm = int(round(o["hf"] * 10))
        e[3] = dm if not e[3] else min(e[3], dm)
        n += 1
    print(f"doorvaarthoogtes: {n} vaste bruggen aan een vaarwegvak gekoppeld")


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
        kf = kostfactor(w.get("tags", {}))
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
            edges.append([nm, flat, kf])

    knoop_gelijknamig(edges, names)
    spans = lake_grids(edges, names, name_idx, nid)
    zet_hoogtes(edges)

    out = {"v": 1, "built": int(time.time() * 1000), "names": names, "e": edges, "spans": spans}
    raw = json.dumps(out, separators=(",", ":")).encode()
    with gzip.open(OUT, "wb", compresslevel=9) as f:
        f.write(raw)
    npts = sum((len(e[1]) - 2) // 2 + 1 for e in edges)
    print(f"net.json.gz: {len(edges)} kanten, {npts} punten, "
          f"{len(raw) / 1e6:.1f} MB raw, {os.path.getsize(OUT) / 1e6:.1f} MB gzip")


if __name__ == "__main__":
    main()
