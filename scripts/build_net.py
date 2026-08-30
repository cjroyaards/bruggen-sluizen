#!/usr/bin/env python3
"""Bouwt het vaarwegennetwerk voor de routeplanner: data/net.json.gz.

Bron: het **officiële vaarwegennetwerk van Rijkswaterstaat** (FIS), hetzelfde
bestand waar ook de bruggen, sluizen en bedieningstijden uit komen. Dat is
precies de goede keuze, want:

  * het bevat alleen water dat officieel als vaarweg geldt — geen stadsgrachten
    of poldersloten waar je met een boot niets te zoeken hebt;
  * de topologie zit er al in (elke sectie heeft een start- en eindknooppunt),
    dus er hoeft niets aan elkaar geknoopt of geraden te worden;
  * open water zoals het IJsselmeer en de Zeeuwse wateren zit erin als de
    officiële betonde routes, niet als een zelfbedacht raster over het meer;
  * de bruggen en sluizen komen uit dezelfde bron, dus ze liggen per definitie
    op het netwerk.

Een eerdere versie bouwde het netwerk uit OpenStreetMap en verzon zelf
verbindingen over open water. Dat liep telkens ergens dwars door een dijk of
polder (Durgerdam, Muiden, Broek in Waterland) en stuurde routes door
Amsterdamse grachten met bruggen van 2 meter. Zie de git-geschiedenis.

Uitvoer (gzip):
  { "v": 2, "built": <ms>,
    "names": ["Prinses Margrietkanaal", ...],
    "e": [ [naamIdx, [lat0,lon0, dLat,dLon, ...], kostfactor, hoogte_dm], ... ] }

Coördinaten als gehele getallen ×1e5, na het eerste punt delta-gecodeerd.
De app koppelt secties aan elkaar op exact gelijke eindpuntcoördinaten.

Draaien: python3 scripts/build_net.py
Controleren: python3 scripts/audit_net.py  en  node scripts/test_route_graph.js
"""
import gzip, json, math, os, sys, time, urllib.parse, urllib.request
from collections import defaultdict

BASE = "https://www.vaarweginformatie.nl/wfswms/dataservice/1.3"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "net.json.gz")
STAT = os.path.join(os.path.dirname(__file__), "..", "data", "static.json.gz")
UA = {"User-Agent": "openpilot-net (bruggen-sluizen, persoonlijk gebruik)"}
BBOX = (50.60, 3.20, 53.75, 7.35)        # (zuid, west, noord, oost)
SIMPLIFY_M = 12.0                         # Douglas-Peucker-tolerantie
HOOGTE_M = 45.0                           # brug hoort binnen deze afstand bij een sectie
OBJ_M = 60.0                              # object hoort bij de sectie binnen deze afstand


def get(url):
    last = None
    for i in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  retry {i+1} {e}", file=sys.stderr)
            time.sleep(3 * (i + 1))
    raise SystemExit(f"FOUT: {url}: {last}")


def fetch_type(gen, t):
    out, offset = [], 0
    while True:
        d = get(f"{BASE}/{gen}/{t}?offset={offset}&count=500")
        out.extend(d["Result"])
        offset += 500
        if offset >= d["TotalCount"]:
            return out


def linestring(s):
    """WKT LINESTRING → [(lat, lon), …]"""
    g = s.get("Geometry") or ""
    i, j = g.find("("), g.rfind(")")
    if i < 0 or j < 0:
        return []
    out = []
    for p in g[i + 1:j].replace("(", "").replace(")", "").split(","):
        q = p.split()
        if len(q) >= 2:
            try:
                out.append((float(q[1]), float(q[0])))
            except ValueError:
                pass
    return out


def dp_simplify(pts, tol_m):
    """Douglas-Peucker; eindpunten blijven altijd staan (zijn de knooppunten)."""
    if len(pts) < 3:
        return pts
    kx = 111320.0 * math.cos(math.radians(pts[0][0]))
    ky = 111320.0

    def seg_dist(p, a, b):
        ax, ay, bx, by = a[1] * kx, a[0] * ky, b[1] * kx, b[0] * ky
        px, py = p[1] * kx, p[0] * ky
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        if L2 == 0:
            return math.hypot(px - ax, py - ay)
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

    stack, houden = [(0, len(pts) - 1)], {0, len(pts) - 1}
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        best, bi = -1.0, None
        for k in range(i + 1, j):
            d = seg_dist(pts[k], pts[i], pts[j])
            if d > best:
                best, bi = d, k
        if best > tol_m:
            houden.add(bi)
            stack.append((i, bi))
            stack.append((bi, j))
    return [pts[k] for k in sorted(houden)]


def kostfactor(cemt):
    """Voorkeursfactor (×100): op een hoofdvaarweg telt de echte lengte, een
    kleine vaarweg telt zwaarder zodat de planner de doorgaande route kiest."""
    tabel = {"VII": 100, "VIc": 100, "VIb": 100, "VIa": 100, "Vb": 100, "Va": 100,
             "IV": 104, "III": 112, "II": 122, "I": 132, "0": 140}
    return tabel.get((cemt or "").strip(), 118)


def main():
    gen = get(f"{BASE}/geogeneration")["GeoGeneration"]
    print("geogeneration", gen)
    secties = fetch_type(gen, "section")
    fairways = fetch_type(gen, "fairway")
    print(f"  section: {len(secties)}, fairway: {len(fairways)}")

    fwnaam = {f["Id"]: (f.get("Name") or "").strip() for f in fairways}
    fwcemt = {f["Id"]: f.get("CEMTClass") or f.get("Cemt") or "" for f in fairways}

    names, name_idx = [], {}

    def nid(nm):
        if nm not in name_idx:
            name_idx[nm] = len(names)
            names.append(nm)
        return name_idx[nm]

    # knooppunt-id → afgeronde coördinaat, zodat de app secties aan elkaar rijgt
    knooppunt = {}
    bruikbaar = []
    for s in secties:
        pts = linestring(s)
        if len(pts) < 2:
            continue
        if not any(BBOX[0] < la < BBOX[2] and BBOX[1] < lo < BBOX[3] for la, lo in pts):
            continue
        a, b = s.get("StartJunctionId"), s.get("EndJunctionId")
        if a is None or b is None:
            continue
        knooppunt.setdefault(a, (round(pts[0][0] * 1e5), round(pts[0][1] * 1e5)))
        knooppunt.setdefault(b, (round(pts[-1][0] * 1e5), round(pts[-1][1] * 1e5)))
        bruikbaar.append((s, pts, a, b))
    print(f"  bruikbaar in NL: {len(bruikbaar)} secties, {len(knooppunt)} knooppunten")

    edges = []
    for s, pts, a, b in bruikbaar:
        nm = nid(fwnaam.get(s.get("FairwayId"), "") or (s.get("Name") or "").strip())
        kf = kostfactor(fwcemt.get(s.get("FairwayId")))
        simp = dp_simplify(pts, SIMPLIFY_M)
        ip = [knooppunt[a]] + [(round(la * 1e5), round(lo * 1e5)) for la, lo in simp[1:-1]] + [knooppunt[b]]
        if len(ip) < 2 or (len(ip) == 2 and ip[0] == ip[1]):
            continue
        flat = [ip[0][0], ip[0][1]]
        for (la, lo), (pla, plo) in zip(ip[1:], ip[:-1]):
            flat += [la - pla, lo - plo]
        edges.append([nm, flat, kf, 0, []])

    koppel_objecten(edges)
    spans = overspanningen(edges)

    out = {"v": 2, "built": int(time.time() * 1000), "names": names, "e": edges,
           "spans": spans}
    raw = json.dumps(out, separators=(",", ":")).encode()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with gzip.open(OUT, "wb", compresslevel=9) as f:
        f.write(raw)
    npts = sum((len(e[1]) - 2) // 2 + 1 for e in edges)
    print(f"net.json.gz: {len(edges)} secties, {npts} punten, "
          f"{len(raw)/1e6:.1f} MB raw, {os.path.getsize(OUT)/1e6:.2f} MB gzip")


OVERPASS = ["https://overpass-api.de/api/interpreter",
            "https://lz4.overpass-api.de/api/interpreter"]
SPAN_MIN_W = 40.0        # alleen brede doorvaarten kunnen een lange overspanning zijn
SPAN_VER_M = 150.0       # ligt het RWS-punt verder dan dit van de vaargeul, dan nodig
SPAN_KOPPEL_M = 150.0    # RWS-brug hoort bij een overspanning binnen deze afstand


def celindex(edges):
    """celindex over alle netwerksegmenten, voor snelle afstandsvragen"""
    cel = defaultdict(list)
    for e in edges:
        flat = e[1]
        la, lo = flat[0], flat[1]
        pts = [(la, lo)]
        for i in range(2, len(flat), 2):
            la += flat[i]; lo += flat[i + 1]
            pts.append((la, lo))
        for a, b in zip(pts, pts[1:]):
            for k in {(a[0] // 900, a[1] // 1400), (b[0] // 900, b[1] // 1400)}:
                cel[k].append((a, b))
    return cel


def afstand_tot_net(cel, la, lo):
    pla, plo = round(la * 1e5), round(lo * 1e5)
    kx = math.cos(math.radians(la))
    best = 1e18
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for a, b in cel.get((pla // 900 + dy, plo // 1400 + dx), []):
                ay, ax = a[0] * 1.1132, a[1] * 1.1132 * kx
                by, bx = b[0] * 1.1132, b[1] * 1.1132 * kx
                py, px = pla * 1.1132, plo * 1.1132 * kx
                ddy, ddx = by - ay, bx - ax
                L2 = ddy * ddy + ddx * ddx or 1e-9
                t = max(0.0, min(1.0, ((py - ay) * ddy + (px - ax) * ddx) / L2))
                best = min(best, math.hypot(py - (ay + t * ddy), px - (ax + t * ddx)))
    return best


def overspanningen(edges):
    """Lange bruggen over open water.

    De RWS-data geeft één punt per brug. Bij de Zeelandbrug ligt dat punt bij de
    beweegbare overspanning, terwijl de vaargeul het bouwwerk 800 m verderop
    kruist — dan mist de routelijst die brug, juist waar de doorvaarthoogte
    telt. Voor die enkele gevallen halen we de échte overspanningslijn uit
    OpenStreetMap op. Het raakt alleen de objectenlijst, nooit de routering.
    """
    try:
        stat = json.load(gzip.open(STAT))
    except Exception as e:  # noqa: BLE001
        print(f"  static.json.gz niet leesbaar ({e}); overspanningen overgeslagen", file=sys.stderr)
        return []
    cel = celindex(edges)
    bruggen = [o for o in stat["objs"] if o.get("t") == "B"
               and BBOX[0] < o["lat"] < BBOX[2] and BBOX[1] < o["lon"] < BBOX[3]]
    kand = [o for o in bruggen if (o.get("w") or 0) >= SPAN_MIN_W
            and SPAN_VER_M < afstand_tot_net(cel, o["lat"], o["lon"]) < 5000]
    print(f"  overspanningen nodig voor {len(kand)} bruggen: "
          + ", ".join(o["n"][:24] for o in kand))
    if not kand:
        return []

    delen = "".join(f'way["bridge"]["highway"](around:2500,{o["lat"]:.5f},{o["lon"]:.5f});'
                    f'way["bridge"]["railway"](around:2500,{o["lat"]:.5f},{o["lon"]:.5f});'
                    for o in kand)
    ways = []
    for m in OVERPASS:
        try:
            print("  Overpass (overspanningen):", m)
            req = urllib.request.Request(
                m, data=urllib.parse.urlencode({"data": f"[out:json][timeout:180];({delen});out geom;"}).encode(),
                headers=UA)
            with urllib.request.urlopen(req, timeout=240) as r:
                ways = [w for w in json.load(r)["elements"] if w.get("geometry")]
            break
        except Exception as e:  # noqa: BLE001
            print(f"    mislukt ({e})", file=sys.stderr)
            time.sleep(5)
    if not ways:
        print("    geen overspanningen opgehaald; lijst blijft leeg", file=sys.stderr)
        return []

    spans, gezien = [], set()
    for w in ways:
        g = [(p["lat"], p["lon"]) for p in w["geometry"]]
        lengte = sum(math.hypot((b[0] - a[0]) * 111320,
                                (b[1] - a[1]) * 111320 * math.cos(math.radians(a[0])))
                     for a, b in zip(g, g[1:]))
        if lengte < 250:
            continue
        simp = dp_simplify(g, 40.0)
        ip = [(round(la * 1e5), round(lo * 1e5)) for la, lo in simp]
        sleutel = (ip[0], ip[-1])
        if sleutel in gezien:
            continue
        ids = []
        for o in bruggen:
            d = min(math.hypot((o["lat"] - a[0]) * 111320,
                               (o["lon"] - a[1]) * 111320 * math.cos(math.radians(o["lat"])))
                    for a in simp)
            if d < SPAN_KOPPEL_M:
                ids.append(o["id"])
        if not ids:
            continue
        gezien.add(sleutel)
        flat = [ip[0][0], ip[0][1]]
        for (la, lo), (pla, plo) in zip(ip[1:], ip[:-1]):
            flat += [la - pla, lo - plo]
        spans.append([flat, ids])
    print(f"  {len(spans)} overspanningslijnen vastgelegd")
    return spans


def koppel_objecten(edges):
    """Koppelt elke brug en sluis aan de sectie waar hij op ligt.

    Zo weet de app precies welke objecten je passeert: die van de secties die de
    route gebruikt. Nabijheid alleen is niet genoeg — in Amsterdam loopt de
    Kostverlorenvaart op 50 m van je route, en dan zou een brug van 2,36 m in je
    lijst komen die je nooit ziet. Vult tegelijk de doorvaarthoogte per sectie.
    """
    try:
        stat = json.load(gzip.open(STAT))
    except Exception as e:  # noqa: BLE001
        print(f"  static.json.gz niet leesbaar ({e}); objecten niet gekoppeld", file=sys.stderr)
        return
    objs = [o for o in stat["objs"] if o.get("t") in ("B", "S")
            and BBOX[0] < o["lat"] < BBOX[2] and BBOX[1] < o["lon"] < BBOX[3]]

    # celindex met sectienummer erbij
    cel = defaultdict(list)
    for ei, e in enumerate(edges):
        flat = e[1]
        la, lo = flat[0], flat[1]
        pts = [(la, lo)]
        for i in range(2, len(flat), 2):
            la += flat[i]; lo += flat[i + 1]
            pts.append((la, lo))
        for a, b in zip(pts, pts[1:]):
            for k in {(a[0] // 900, a[1] // 1400), (b[0] // 900, b[1] // 1400)}:
                cel[k].append((ei, a, b))

    n = h = 0
    for o in objs:
        pla, plo = round(o["lat"] * 1e5), round(o["lon"] * 1e5)
        kx = math.cos(math.radians(o["lat"]))
        best = (1e18, None)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for ei, a, b in cel.get((pla // 900 + dy, plo // 1400 + dx), []):
                    ay, ax = a[0] * 1.1132, a[1] * 1.1132 * kx
                    by, bx = b[0] * 1.1132, b[1] * 1.1132 * kx
                    py, px = pla * 1.1132, plo * 1.1132 * kx
                    ddy, ddx = by - ay, bx - ax
                    L2 = ddy * ddy + ddx * ddx or 1e-9
                    t = max(0.0, min(1.0, ((py - ay) * ddy + (px - ax) * ddx) / L2))
                    d = math.hypot(py - (ay + t * ddy), px - (ax + t * ddx))
                    if d < best[0]:
                        best = (d, ei)
        if best[1] is None or best[0] > OBJ_M:
            continue
        e = edges[best[1]]
        e[4].append(o["id"] if o["t"] == "B" else -o["id"])    # sluizen negatief
        n += 1
        if o["t"] == "B" and not o.get("open") and o.get("hf") is not None:
            dm = int(round(o["hf"] * 10))
            e[3] = dm if not e[3] else min(e[3], dm)
            h += 1
    zonder = sum(1 for e in edges if not e[4])
    print(f"  {n} bruggen/sluizen aan een sectie gekoppeld ({h} met doorvaarthoogte); "
          f"{zonder} secties zonder object")


def zet_hoogtes(edges):
    """Vaste bruggen bepalen de doorvaarthoogte van de sectie eronder (in dm)."""
    try:
        stat = json.load(gzip.open(STAT))
    except Exception as e:  # noqa: BLE001
        print(f"  static.json.gz niet leesbaar ({e}); hoogtes overgeslagen", file=sys.stderr)
        return
    vast = [o for o in stat["objs"]
            if o.get("t") == "B" and not o.get("open") and o.get("hf") is not None]

    cel = defaultdict(list)
    for ei, e in enumerate(edges):
        flat = e[1]
        la, lo = flat[0], flat[1]
        pts = [(la, lo)]
        for i in range(2, len(flat), 2):
            la += flat[i]; lo += flat[i + 1]
            pts.append((la, lo))
        for p, q in zip(pts, pts[1:]):
            for k in {(p[0] // 500, p[1] // 800), (q[0] // 500, q[1] // 800)}:
                cel[k].append((ei, p, q))

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
                    d = math.hypot(py - (ay + t * ddy), px - (ax + t * ddx))
                    if d < best[0]:
                        best = (d, ei)
        if best[1] is None or best[0] > HOOGTE_M:
            continue
        dm = int(round(o["hf"] * 10))
        e = edges[best[1]]
        e[3] = dm if not e[3] else min(e[3], dm)
        n += 1
    print(f"  doorvaarthoogtes: {n} vaste bruggen aan een sectie gekoppeld")


if __name__ == "__main__":
    main()
