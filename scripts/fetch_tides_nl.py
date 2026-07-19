#!/usr/bin/env python3
"""Officiële astronomische getijverwachtingen voor NL-kuststations (Rijkswaterstaat).

Bron: RWS WaterWebservices (api20), grootheid WATHTBRKD (waterhoogte berekend =
astronomisch getij), hoogte in cm t.o.v. NAP. Geen sleutel nodig.

Uitvoer: data/nltides.json
  {"checked": ms, "stations": [{"code","n","lat","lon",
     "events": [["2026-07-20T03:12","H",1.92], ...],      # UTC, m NAP
     "series": [["2026-07-20T00:00",-0.42], ...]}]}       # uurlijks, 3 dagen
"""
import json, os, sys, time, urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://api20-waterwebservices.rijkswaterstaat.nl"
OUT = os.path.join(os.path.dirname(__file__), "..", "data")

# kuststations relevant voor (zee)zeilers — code = RWS-locatiecode
STATIONS = [
    ("VLISSGN", "Vlissingen", 51.4422, 3.5961),
    ("TERNZN", "Terneuzen", 51.3378, 3.8258),
    ("HANSWT", "Hansweert", 51.4417, 4.0000),
    ("ROOMPBTN", "Roompot buiten", 51.6183, 3.6725),
    ("ROOMPBNN", "Roompot binnen", 51.6217, 3.6944),
    ("ZIERKZE", "Zierikzee", 51.6317, 3.9192),
    ("YERSKE", "Yerseke", 51.4933, 4.0553),
    ("STAVNSE", "Stavenisse", 51.5883, 4.0089),
    ("KRAMMSZWT", "Krammersluizen west", 51.6467, 4.1667),
    ("BROUWHVSGT08", "Brouwershavense Gat", 51.7667, 3.8233),
    ("HARVT10", "Haringvliet 10", 51.8583, 3.8667),
    ("STELLDBTN", "Stellendam buiten", 51.8317, 4.0333),
    ("HOEKVHLD", "Hoek van Holland", 51.9775, 4.1200),
    ("SCHEVNGN", "Scheveningen", 52.1061, 4.2622),
    ("IJMDBTHVN", "IJmuiden buitenhaven", 52.4650, 4.5553),
    ("DENHDR", "Den Helder", 52.9644, 4.7450),
    ("OUDSD", "Oudeschild (Texel)", 53.0392, 4.8511),
    ("DENOVBTN", "Den Oever buiten", 52.9394, 5.0294),
    ("KORNWDZBTN", "Kornwerderzand buiten", 53.0742, 5.3250),
    ("HARLGN", "Harlingen", 53.1758, 5.4092),
    ("VLIELHVN", "Vlieland haven", 53.2992, 5.0958),
    ("WESTTSLG", "West-Terschelling", 53.3622, 5.2200),
    ("NES", "Nes (Ameland)", 53.4333, 5.7667),
    ("SCHIERMNOG", "Schiermonnikoog", 53.4717, 6.2000),
    ("LAUWOG", "Lauwersoog", 53.4083, 6.2000),
    ("EEMSHVN", "Eemshaven", 53.4383, 6.8331),
    ("DELFZL", "Delfzijl", 53.3267, 6.9331),
]

MISSING = 999999999


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    last = None
    for i in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  retry {i+1} {path} {e}", file=sys.stderr)
            time.sleep(3 * (i + 1))
    raise SystemExit(f"FOUT: {path}: {last}")


def catalog_xy():
    """Locatiecode -> (X, Y) uit de catalogus (sommige endpoints vereisen X/Y)."""
    try:
        d = post("/METADATASERVICES/OphalenCatalogus",
                 {"CatalogusFilter": {"Grootheden": True, "Compartimenten": True}})
        return {l.get("Code"): (l.get("X"), l.get("Y")) for l in d.get("LocatieLijst", [])}
    except SystemExit:
        return {}


def fetch_station(code, xy):
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    loc = {"Code": code}
    if code in xy and xy[code][0] is not None:
        loc["X"], loc["Y"] = xy[code]
    body = {
        "AquoPlusWaarnemingMetadata": {"AquoMetadata": {
            "Compartiment": {"Code": "OW"}, "Grootheid": {"Code": "WATHTBRKD"}}},
        "Locatie": loc,
        "Periode": {
            "Begindatumtijd": (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:00.000+00:00"),
            "Einddatumtijd": (now + timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:00.000+00:00")},
    }
    d = post("/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen", body)
    pts = []
    for w in d.get("WaarnemingenLijst") or []:
        for m in w.get("MetingenLijst") or []:
            v = (m.get("Meetwaarde") or {}).get("Waarde_Numeriek")
            t = m.get("Tijdstip")
            if v is None or v == MISSING or not t:
                continue
            ts = datetime.fromisoformat(t).astimezone(timezone.utc)
            pts.append((ts, v / 100.0))
    pts.sort()
    # dubbele tijdstippen weg
    ded = []
    for ts, v in pts:
        if ded and ded[-1][0] == ts:
            continue
        ded.append((ts, v))
    return ded


def extremes(pts):
    ev = []
    for i in range(1, len(pts) - 1):
        a, b, c = pts[i-1][1], pts[i][1], pts[i+1][1]
        is_max = b >= a and b > c
        is_min = b <= a and b < c
        if not is_max and not is_min:
            continue
        den = a - 2*b + c
        off = 0.0
        if den != 0:
            off = max(-0.5, min(0.5, 0.5 * (a - c) / den))
        v = b - 0.25 * (a - c) * off
        step = (pts[i+1][0] - pts[i][0]).total_seconds()
        t = pts[i][0] + timedelta(seconds=off * step)
        # extremen dichter dan 3 uur op elkaar overslaan (ruis)
        if ev and abs((t - ev[-1][0]).total_seconds()) < 3 * 3600 and (ev[-1][2] == "H") == is_max:
            continue
        ev.append((t, round(v, 2), "H" if is_max else "L"))
    return ev


def main():
    # versheidscheck: max 1x per ~20 uur echt verversen (script draait ook in de uurlijkse run)
    path = os.path.join(OUT, "nltides.json")
    if "--force" not in sys.argv and os.path.exists(path):
        try:
            prev = json.load(open(path))
            if time.time() * 1000 - prev.get("checked", 0) < 20 * 3600 * 1000 and prev.get("stations"):
                print("nltides.json is vers — overgeslagen")
                return
        except Exception:  # noqa: BLE001
            pass
    xy = catalog_xy()
    out = []
    for code, name, lat, lon in STATIONS:
        try:
            pts = fetch_station(code, xy)
        except SystemExit as e:
            print(f"  {name} ({code}): mislukt — overgeslagen ({e})")
            continue
        if len(pts) < 24:
            print(f"  {name} ({code}): te weinig punten ({len(pts)}) — overgeslagen")
            continue
        ev = extremes(pts)
        series = [[p[0].strftime("%Y-%m-%dT%H:%M"), round(p[1], 2)]
                  for p in pts if p[0].minute == 0][:72]
        out.append({
            "code": code, "n": name, "lat": lat, "lon": lon,
            "events": [[e[0].strftime("%Y-%m-%dT%H:%M"), e[2], e[1]] for e in ev],
            "series": series,
        })
        print(f"  {name}: {len(ev)} extremen, {len(series)} uurpunten")
        time.sleep(0.3)
    json.dump({"checked": int(time.time() * 1000), "stations": out},
              open(os.path.join(OUT, "nltides.json"), "w"), separators=(",", ":"))
    print(f"nltides.json: {len(out)}/{len(STATIONS)} stations")


if __name__ == "__main__":
    main()
