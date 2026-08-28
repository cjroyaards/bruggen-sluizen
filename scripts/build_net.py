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

    out = {"v": 1, "names": names, "e": edges}
    raw = json.dumps(out, separators=(",", ":")).encode()
    with gzip.open(OUT, "wb", compresslevel=9) as f:
        f.write(raw)
    npts = sum((len(e[1]) - 2) // 2 + 1 for e in edges)
    print(f"net.json.gz: {len(edges)} kanten, {npts} punten, "
          f"{len(raw) / 1e6:.1f} MB raw, {os.path.getsize(OUT) / 1e6:.1f} MB gzip")


if __name__ == "__main__":
    main()
