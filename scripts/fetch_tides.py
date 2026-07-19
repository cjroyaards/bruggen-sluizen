#!/usr/bin/env python3
"""Haalt officiële UKHO Admiralty getijvoorspellingen op voor de UK-havens.

Vereist env ADMIRALTY_KEY (gratis 'UK Tidal API - Discovery' abonnement,
https://admiraltyapi.portal.azure-api.net). Zonder sleutel doet dit script
niets (exit 0), zodat de workflow gewoon doorloopt.

Uitvoer: data/uktides.json
  {"checked": <epoch ms>, "byId": {"H9307928": {"station": "Harwich",
    "events": [["2026-07-20T03:12", "H", 3.9], ...]}}}
Tijden in UTC (ISO, minuten), hoogtes in meters boven kaartnul (LAT).
"""
import json, math, os, sys, time, urllib.request

KEY = os.environ.get("ADMIRALTY_KEY", "").strip()
BASE = "https://admiraltyapi.azure-api.net/uktidalapi/api/V1"
HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "..", "data")
MAX_KM = 25.0


def get(url):
    req = urllib.request.Request(url, headers={"Ocp-Apim-Subscription-Key": KEY})
    last = None
    for i in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  retry {i+1} {url.split('?')[0]} {e}", file=sys.stderr)
            time.sleep(2 * (i + 1))
    raise SystemExit(f"FOUT: {url}: {last}")


def dist_km(a_lat, a_lon, b_lat, b_lon):
    dy = (a_lat - b_lat) * 111.32
    dx = (a_lon - b_lon) * 111.32 * math.cos(math.radians(a_lat))
    return (dx * dx + dy * dy) ** 0.5


def main():
    if not KEY:
        print("ADMIRALTY_KEY niet gezet — officiële getijdata overgeslagen.")
        return
    # versheidscheck: max 1x per ~20 uur echt verversen (script draait ook in de uurlijkse run)
    path = os.path.join(OUT, "uktides.json")
    if "--force" not in sys.argv and os.path.exists(path):
        try:
            prev = json.load(open(path))
            if time.time() * 1000 - prev.get("checked", 0) < 20 * 3600 * 1000 and prev.get("byId"):
                print("uktides.json is vers — overgeslagen")
                return
        except Exception:  # noqa: BLE001
            pass
    harbours = json.load(open(os.path.join(OUT, "ukharbours.json")))["harbours"]

    st = get(f"{BASE}/Stations")
    stations = []
    for f in st.get("features", []):
        lon, lat = f["geometry"]["coordinates"][:2]
        p = f.get("properties", {})
        stations.append({"id": p.get("Id"), "name": p.get("Name"), "lat": lat, "lon": lon})
    print(f"{len(stations)} Admiralty-stations")

    by_id = {}
    cache = {}
    for h in harbours:
        best = min(stations, key=lambda s: dist_km(h["lat"], h["lon"], s["lat"], s["lon"]))
        d = dist_km(h["lat"], h["lon"], best["lat"], best["lon"])
        if d > MAX_KM:
            print(f"  {h['n']}: geen station binnen {MAX_KM} km (dichtstbij {best['name']} {d:.0f} km)")
            continue
        if best["id"] not in cache:
            ev = get(f"{BASE}/Stations/{best['id']}/TidalEvents?duration=7")
            events = []
            for e in ev:
                t = (e.get("DateTime") or "")[:16]
                typ = "H" if e.get("EventType") == "HighWater" else "L"
                hgt = e.get("Height")
                if t and hgt is not None:
                    events.append([t, typ, round(hgt, 2)])
            cache[best["id"]] = {"station": best["name"], "sid": best["id"],
                                 "lat": round(best["lat"], 5), "lon": round(best["lon"], 5),
                                 "events": events}
            time.sleep(0.4)  # netjes binnen de rate limit blijven
        by_id[f"{h['t']}{h['id']}"] = cache[best["id"]]
        print(f"  {h['n']} -> {best['name']} ({d:.1f} km, {len(cache[best['id']]['events'])} events)")

    out = {"checked": int(time.time() * 1000), "byId": by_id}
    json.dump(out, open(os.path.join(OUT, "uktides.json"), "w"), separators=(",", ":"))
    print(f"uktides.json: {len(by_id)} havens gekoppeld, {len(cache)} stations opgehaald")


if __name__ == "__main__":
    main()
