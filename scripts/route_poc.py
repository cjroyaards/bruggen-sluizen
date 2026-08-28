#!/usr/bin/env python3
"""Proof of concept: routeplanner over het vaarwegennetwerk (bruggen & sluizen).

Bouwt een graaf uit OSM-waterwegen (Overpass), zoekt met A* een route tussen
twee punten, en prikt daarna de bruggen/sluizen uit data/static.json.gz op de
route — in passagevolgorde, met hoogtes, breedtes en bedieningstijden.

Gebruik:
  python3 scripts/route_poc.py                # standaard: Rottemeren -> Hollandsche IJssel
  python3 scripts/route_poc.py LAT1 LON1 LAT2 LON2

De OSM-download wordt gecachet in /tmp/osm_water.json (bbox onderin aanpassen
voor een andere regio).
"""
import gzip, heapq, itertools, json, math, os, sys, time, urllib.parse, urllib.request
from collections import defaultdict
from datetime import date

BBOX = (51.90, 4.44, 52.03, 4.76)          # (zuid, west, noord, oost)
CACHE = "/tmp/osm_water.json"
DATA = os.path.join(os.path.dirname(__file__), "..", "data", "static.json.gz")
MIRRORS = ["https://overpass.kumi.systems/api/interpreter",
           "https://lz4.overpass-api.de/api/interpreter",
           "https://overpass-api.de/api/interpreter"]
DAGEN = ["ma", "di", "wo", "do", "vr", "za", "zo"]


def fetch_osm():
    if os.path.exists(CACHE):
        return json.load(open(CACHE))
    q = f'[out:json][timeout:120];way["waterway"~"^(river|canal)$"]{BBOX};out body; >; out skel qt;'
    for m in MIRRORS:
        for _ in range(2):
            try:
                req = urllib.request.Request(m, data=urllib.parse.urlencode({"data": q}).encode(),
                                             headers={"User-Agent": "openpilot-routeplanner-poc"})
                with urllib.request.urlopen(req, timeout=150) as r:
                    d = json.load(r)
                json.dump(d, open(CACHE, "w"))
                return d
            except Exception as e:  # noqa: BLE001
                print(f"  {m}: {e}", file=sys.stderr)
                time.sleep(5)
    raise SystemExit("Overpass niet bereikbaar")


def build_graph(d):
    nodes = {e["id"]: (e["lat"], e["lon"]) for e in d["elements"] if e["type"] == "node"}

    def dist(a, b):
        (la1, lo1), (la2, lo2) = nodes[a], nodes[b]
        return math.hypot((lo2 - lo1) * math.cos(math.radians((la1 + la2) / 2)) * 111320,
                          (la2 - la1) * 111320)

    G = defaultdict(list)
    for w in (e for e in d["elements"] if e["type"] == "way"):
        name = w["tags"].get("name", "(naamloos)")
        for a, b in zip(w["nodes"], w["nodes"][1:]):
            if a in nodes and b in nodes:
                m = dist(a, b)
                G[a].append((b, m, name))
                G[b].append((a, m, name))
    return nodes, G


def astar(nodes, G, start, goal):
    def h(n):
        (la, lo), (gla, glo) = nodes[n], nodes[goal]
        return math.hypot((lo - glo) * math.cos(math.radians(la)) * 111320, (la - gla) * 111320)

    pq, came, gscore = [(h(start), 0.0, start, None, None)], {}, {start: 0.0}
    while pq:
        _, g, n, prev, via = heapq.heappop(pq)
        if n in came:
            continue
        came[n] = (prev, via)
        if n == goal:
            break
        for nb, m, name in G[n]:
            ng = g + m
            if ng < gscore.get(nb, 1e18):
                gscore[nb] = ng
                heapq.heappush(pq, (ng + h(nb), ng, nb, n, name))
    if goal not in came:
        return None, None, None
    path, names = [], []
    n = goal
    while n is not None:
        path.append(n)
        prev, via = came[n]
        if via:
            names.append(via)
        n = prev
    path.reverse()
    names.reverse()
    return [nodes[p] for p in path], gscore[goal], [k for k, _ in itertools.groupby(names)]


def bediening(OT, otid, vandaag):
    e = OT.get(str(otid))
    if not e:
        return ""
    remark, periods = e[0], e[1]
    for frm, to, note, slots in periods:
        if (int(frm[:2]), int(frm[2:])) <= (vandaag.month, vandaag.day) <= (int(to[:2]), int(to[2:])):
            out = []
            for mask, s, en, _ in slots:
                dgs = "ma-zo" if mask in (127, 255) else "+".join(DAGEN[i] for i in range(7) if mask >> i & 1)
                out.append(f"{dgs} {s // 60:02d}:{s % 60:02d}-{en // 60:02d}:{en % 60:02d}")
            extra = (f" [{note}]" if note else "") + (f" ({remark})" if remark else "")
            return "; ".join(out) + extra
    return remark


def objecten_op_route(route, max_afstand=60):
    d = json.load(gzip.open(DATA))
    ref = route[0]

    def xy(lat, lon):
        return ((lon - ref[1]) * math.cos(math.radians(ref[0])) * 111320, (lat - ref[0]) * 111320)

    pts = [xy(*p) for p in route]
    cum = [0.0]
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        cum.append(cum[-1] + math.hypot(bx - ax, by - ay))

    lat_c = sum(p[0] for p in route) / len(route)
    lon_c = sum(p[1] for p in route) / len(route)
    rows = []
    for o in d["objs"]:
        if abs(o["lat"] - lat_c) > 0.15 or abs(o["lon"] - lon_c) > 0.20:
            continue
        px, py = xy(o["lat"], o["lon"])
        best = (1e18, 0.0)
        for i, ((ax, ay), (bx, by)) in enumerate(zip(pts, pts[1:])):
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy or 1e-9
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
            dd = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if dd < best[0]:
                best = (dd, cum[i] + t * math.hypot(dx, dy))
        if best[0] < max_afstand:
            rows.append((best[1], o))
    rows.sort(key=lambda r: r[0])
    return rows, d["ot"]


if __name__ == "__main__":
    if len(sys.argv) == 5:
        a = tuple(map(float, sys.argv[1:3]))
        b = tuple(map(float, sys.argv[3:5]))
    else:
        a, b = (52.005, 4.556), (51.977, 4.656)  # Rottemeren -> Hollandsche IJssel (Moordrecht)

    osm = fetch_osm()
    nodes, G = build_graph(osm)

    def nearest(lat, lon):
        return min(nodes, key=lambda n: (nodes[n][0] - lat) ** 2 + (nodes[n][1] - lon) ** 2)

    route, meters, vaarwegen = astar(nodes, G, nearest(*a), nearest(*b))
    if route is None:
        raise SystemExit("Geen route gevonden")
    print(f"Route: {meters / 1000:.1f} km via " + " -> ".join(vaarwegen) + "\n")

    rows, OT = objecten_op_route(route)
    vandaag = date.today()
    print(f"{'km':>5}  {'type':5} {'naam':45} {'hoogte':>12} {'breed':>6}  bediening")
    for along, o in rows:
        if o.get("open") == 0 and o.get("hf"):
            h = f"vast {o['hf']}m"
        elif o.get("hm") is not None:
            h = f"dicht {o['hm']}m"
        else:
            h = "sluis"
        bed = bediening(OT, o["ot"], vandaag) if o.get("open") and o.get("ot") else ""
        soort = "brug" if o["t"] == "B" else "SLUIS"
        print(f"{along / 1000:5.1f}  {soort:5} {o['n'][:45]:45} {h:>12} {str(o.get('w') or '?'):>6}  {bed[:100]}")
