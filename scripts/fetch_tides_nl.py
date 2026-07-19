#!/usr/bin/env python3
"""Officiële astronomische getijverwachtingen voor NL-kuststations (Rijkswaterstaat).

Bron: RWS WaterWebservices (ddapi20), zonder sleutel.
- HW/LW-extremen: groepering GETETBRKD2 ('getijextreem berekend'), cm t.o.v. NAP
- curve: grootheid WATHTE met ProcesType 'astronomisch', 10-minutenreeks

Uitvoer: data/nltides.json
  {"checked": ms, "stations": [{"code","n","lat","lon",
     "events": [["2026-07-20T03:12","H",1.92], ...],      # UTC, m NAP
     "series": [["2026-07-20T00:00",-0.42], ...]}]}       # uurlijks, 3 dagen

Dit script draait ook in de uurlijkse workflow-run; het ververst alleen echt
als de bestaande data ouder is dan ~20 uur (of met --force). Fouten per
station worden overgeslagen; het script eindigt altijd met exit 0.
"""
import json, os, sys, time, urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://ddapi20-waterwebservices.rijkswaterstaat.nl"
OUT = os.path.join(os.path.dirname(__file__), "..", "data")

# (nieuwe RWS-locatiecode, weergavenaam, lat, lon) — codes uit de ddapi20-catalogus
STATIONS = [
    ("vlissingen", "Vlissingen", 51.442, 3.6),
    ("westkapelle", "Westkapelle", 51.52145, 3.44003),
    ("breskens.veerhaven", "Breskens, Veerhaven", 51.40366, 3.55043),
    ("terneuzen", "Terneuzen", 51.33621, 3.81981),
    ("hansweert", "Hansweert", 51.44567, 3.99744),
    ("oosterschelde.roompotsluis.buiten", "Roompotsluis buiten", 51.619, 3.68),
    ("oosterschelde.roompotsluis.binnen", "Roompotsluis binnen", 51.618, 3.688),
    ("kats.zandkreeksluis", "Kats, Zandkreeksluis", 51.54395, 3.86542),
    ("yerseke", "Yerseke", 51.50615, 4.07513),
    ("stavenisse", "Stavenisse", 51.598, 4.004),
    ("sintannaland.havensteiger", "Sint Annaland", 51.6036, 4.10959),
    ("krammersluizen.west", "Krammersluizen west", 51.65934, 4.14426),
    ("brouwersdam.brouwershavensegat.8", "Brouwershavense Gat", 51.74644, 3.81472),
    ("haringvliet.10", "Haringvliet 10", 51.86278, 3.86056),
    ("stellendam.buitenhaven", "Stellendam, buitenhaven", 51.82703, 4.03345),
    ("hellevoetsluis", "Hellevoetsluis", 51.81972, 4.12824),
    ("willemstad.hollandschdiep", "Willemstad", 51.6964, 4.40689),
    ("hoekvanholland", "Hoek van Holland", 51.9769, 4.11983),
    ("scheveningen", "Scheveningen", 52.09904, 4.26356),
    ("ijmuiden.buitenhaven", "IJmuiden, buitenhaven", 52.463, 4.555),
    ("denhelder.marsdiep", "Den Helder, Marsdiep", 52.96436, 4.74499),
    ("texel.oudeschild", "Texel, Oudeschild", 53.03883, 4.85019),
    ("denoever.waddenzee.voorhaven", "Den Oever, voorhaven", 52.93154, 5.0456),
    ("kornwerderzand.waddenzee.buitenhaven", "Kornwerderzand, buitenhaven", 53.07459, 5.33476),
    ("harlingen.waddenzee", "Harlingen", 53.17563, 5.40934),
    ("vlieland.haven", "Vlieland, haven", 53.29613, 5.09146),
    ("terschelling.west", "West-Terschelling", 53.36304, 5.22003),
    ("ameland.nes", "Ameland, Nes", 53.42977, 5.75945),
    ("schiermonnikoog.waddenzee", "Schiermonnikoog", 53.46894, 6.20291),
    ("lauwersoog.waddenzee", "Lauwersoog", 53.40833, 6.19605),
    ("eemshaven.haven", "Eemshaven", 53.4487, 6.82839),
    ("delfzijl", "Delfzijl", 53.328, 6.931),
]


def post(path, body, timeout=45):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    last = None
    for i in range(2):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if r.status == 204:
                    return None
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2)
    raise RuntimeError(f"{path}: {last}")


def to_utc_iso(t):
    return datetime.fromisoformat(t).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M")


def fetch_extremes(code, per):
    d = post("/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen", {
        "Locatie": {"Code": code},
        "AquoPlusWaarnemingMetadata": {"AquoMetadata": {"Groepering": {"Code": "GETETBRKD2"}}},
        "Periode": per})
    if not d or not d.get("WaarnemingenLijst"):
        return []
    types, heights = {}, {}
    for w in d["WaarnemingenLijst"]:
        gh = ((w.get("AquoMetadata") or {}).get("Grootheid") or {}).get("Code")
        for m in w.get("MetingenLijst") or []:
            t = m.get("Tijdstip")
            mv = m.get("Meetwaarde") or {}
            if not t:
                continue
            if gh == "WATHTE":
                v = mv.get("Waarde_Numeriek")
                if v is not None and abs(v) < 9000:
                    heights[t] = v / 100.0
            else:
                a = (mv.get("Waarde_Alfanumeriek") or "").lower()
                if "hoog" in a:
                    types[t] = "H"
                elif "laag" in a:
                    types[t] = "L"
    events = []
    for t, v in sorted(heights.items()):
        typ = types.get(t)
        if typ is None:
            continue
        events.append([to_utc_iso(t), typ, round(v, 2)])
    return events


def fetch_series(code, per):
    d = post("/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen", {
        "Locatie": {"Code": code},
        "AquoPlusWaarnemingMetadata": {"AquoMetadata": {
            "Grootheid": {"Code": "WATHTE"}, "ProcesType": "astronomisch"}},
        "Periode": per}, timeout=60)
    if not d or not d.get("WaarnemingenLijst"):
        return []
    pts = {}
    for w in d["WaarnemingenLijst"]:
        for m in w.get("MetingenLijst") or []:
            t = m.get("Tijdstip")
            v = (m.get("Meetwaarde") or {}).get("Waarde_Numeriek")
            if not t or v is None or abs(v) > 9000:
                continue
            dt = datetime.fromisoformat(t).astimezone(timezone.utc)
            if dt.minute == 0:
                pts[dt.strftime("%Y-%m-%dT%H:%M")] = round(v / 100.0, 2)
    return [[k, v] for k, v in sorted(pts.items())][:72]


def main():
    path = os.path.join(OUT, "nltides.json")
    if "--force" not in sys.argv and os.path.exists(path):
        try:
            prev = json.load(open(path))
            if time.time() * 1000 - prev.get("checked", 0) < 20 * 3600 * 1000 and prev.get("stations"):
                print("nltides.json is vers — overgeslagen")
                return
        except Exception:  # noqa: BLE001
            pass
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    per5 = {"Begindatumtijd": (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:00.000+00:00"),
            "Einddatumtijd": (now + timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:00.000+00:00")}
    per3 = {"Begindatumtijd": now.strftime("%Y-%m-%dT%H:%M:00.000+00:00"),
            "Einddatumtijd": (now + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:00.000+00:00")}
    out = []
    for code, name, lat, lon in STATIONS:
        try:
            events = fetch_extremes(code, per5)
            if len(events) < 4:
                print(f"  {name} ({code}): {len(events)} extremen — overgeslagen")
                continue
            series = []
            try:
                series = fetch_series(code, per3)
            except Exception as e:  # noqa: BLE001
                print(f"  {name}: reeks mislukt ({e}) — alleen extremen")
            out.append({"code": code, "n": name, "lat": lat, "lon": lon,
                        "events": events, "series": series})
            print(f"  {name}: {len(events)} extremen, {len(series)} uurpunten")
            time.sleep(0.2)
        except Exception as e:  # noqa: BLE001
            print(f"  {name} ({code}): mislukt — {e}")
    if out:
        json.dump({"checked": int(time.time() * 1000), "stations": out},
                  open(path, "w"), separators=(",", ":"))
        print(f"nltides.json: {len(out)}/{len(STATIONS)} stations")
    else:
        print("WAARSCHUWING: geen enkel station gelukt; bestaand bestand blijft staan.")


if __name__ == "__main__":
    main()
