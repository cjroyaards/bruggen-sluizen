#!/usr/bin/env python3
"""Bouwt de databestanden voor het bruggen & sluizen-dashboard.

  python scripts/build_data.py --full    # volledige FIS-dataset + stremmingen (dagelijks)
  python scripts/build_data.py --strem   # alleen actuele stremmingen (elk uur)

Uitvoer in data/:
  static.json.gz  – objecten + bedieningstijden (gzip)
  strem.json      – actuele scheepvaartberichten
  meta.json       – tijdstempels
"""
import gzip, json, re, sys, time, urllib.request, os
from collections import defaultdict

BASE = "https://www.vaarweginformatie.nl/wfswms/dataservice/1.3"
NTS = "https://www.vaarweginformatie.nl/frp/api/messages/nts/summaries"
OUT = os.path.join(os.path.dirname(__file__), "..", "data")
UA = {"User-Agent": "bruggen-sluizen-dashboard (persoonlijk gebruik)"}


def get(url):
    last = None
    for i in range(5):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=90) as r:
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


def pt(geom):
    if not geom:
        return None
    nums = re.findall(r"-?\d+\.?\d*", geom)
    if not nums:
        return None
    xs = [float(n) for n in nums]
    lons, lats = xs[0::2], xs[1::2]
    return (round(sum(lats) / len(lats), 5), round(sum(lons) / len(lons), 5))


DAYS = ["IsMonday", "IsTuesday", "IsWednesday", "IsThursday", "IsFriday",
        "IsSaturday", "IsSunday", "IsHoliday"]
EPOCH2000 = 946681200000  # 2000-01-01 00:00 Europe/Amsterdam


def compact_ot(o):
    periods = []
    for p in o.get("OperatingPeriods") or []:
        rules = []
        for r in p.get("OperatingRules") or []:
            mask = sum(1 << i for i, d in enumerate(DAYS) if r.get(d))
            rules.append([mask, round((r["From"] - EPOCH2000) / 60000),
                          round((r["To"] - EPOCH2000) / 60000), r.get("Note") or ""])
        rules.sort(key=lambda x: (x[1], x[0]))
        periods.append([p.get("Start", ""), p.get("End", ""), p.get("Note") or "", rules])
    return [o.get("Note") or "", periods]


def build_full():
    gen = get(f"{BASE}/geogeneration")["GeoGeneration"]
    print("geogeneration", gen)
    raw = {}
    for t in ["bridge", "lock", "opening", "operatingtimes", "radiocallinpoint",
              "administration", "chamber", "fairway"]:
        raw[t] = fetch_type(gen, t)
        print(f"  {t}: {len(raw[t])}")

    admmap = {a["Id"]: (a.get("Name", ""), a.get("PhoneNumber", "")) for a in raw["administration"]}
    fwmap = {f["Id"]: f.get("Name", "") for f in raw["fairway"]}

    vhf = defaultdict(list)
    for r in raw["radiocallinpoint"]:
        key = (r.get("ParentGeoType"), r.get("ParentId"))
        for c in r.get("VhfChannels") or []:
            if c not in vhf[key]:
                vhf[key].append(c)

    opens = defaultdict(list)
    for o in raw["opening"]:
        if o.get("ParentGeoType") == "bridge":
            opens[o["ParentId"]].append(o)

    chambers = defaultdict(list)
    for c in raw["chamber"]:
        if c.get("ParentId"):
            chambers[c["ParentId"]].append(c)

    otmap = {o["Id"]: compact_ot(o) for o in raw["operatingtimes"]}

    objs = []
    for b in raw["bridge"]:
        p = pt(b.get("Geometry"))
        if not p:
            continue
        oo = opens.get(b["Id"], [])
        fixed_h = [x.get("ClearanceHeightClosed") or x.get("HeightClosed")
                   for x in oo if x.get("Type") == "VST"]
        fixed_h = [h for h in fixed_h if h is not None]
        mov = [x for x in oo if x.get("Type") not in (None, "VST")]
        mov_h = [x.get("ClearanceHeightClosed") or x.get("HeightClosed") for x in mov]
        mov_h = [h for h in mov_h if h is not None]
        mov_w = [x.get("Width") for x in mov if x.get("Width")]
        all_w = [x.get("Width") for x in oo if x.get("Width")]
        objs.append({
            "t": "B", "id": b["Id"], "n": b.get("Name", ""), "c": b.get("City") or "",
            "lat": p[0], "lon": p[1],
            "open": 1 if b.get("CanOpen") else 0,
            "rem": 1 if b.get("IsRemoteControlled") else 0,
            "tel": b.get("PhoneNumber") or "",
            "vhf": vhf.get(("bridge", b["Id"]), []),
            "adm": admmap.get(b.get("AdministrationId"), ("", ""))[0],
            "admTel": admmap.get(b.get("AdministrationId"), ("", ""))[1],
            "fw": fwmap.get(b.get("FairwayId"), ""),
            "ot": b.get("OperatingTimesId") or 0,
            "hf": round(max(fixed_h), 2) if fixed_h else None,
            "hm": round(max(mov_h), 2) if mov_h else None,
            "wm": round(max(mov_w), 1) if mov_w else None,
            "w": round(max(all_w), 1) if all_w else None,
        })
    for l in raw["lock"]:
        p = pt(l.get("Geometry"))
        if not p:
            continue
        cs = chambers.get(l["Id"], [])
        ln = [c.get("Length") for c in cs if c.get("Length")] + ([l["Length"]] if l.get("Length") else [])
        wd = [c.get("Width") for c in cs if c.get("Width")] + ([l["Width"]] if l.get("Width") else [])
        objs.append({
            "t": "S", "id": l["Id"], "n": l.get("Name", ""), "c": l.get("City") or "",
            "lat": p[0], "lon": p[1],
            "open": 1 if l.get("OperatingTimesId") else 0,
            "rem": 1 if l.get("IsRemoteControlled") else 0,
            "tel": l.get("PhoneNumber") or "",
            "vhf": vhf.get(("lock", l["Id"]), []),
            "adm": admmap.get(l.get("AdministrationId"), ("", ""))[0],
            "admTel": admmap.get(l.get("AdministrationId"), ("", ""))[1],
            "fw": fwmap.get(l.get("FairwayId"), ""),
            "ot": l.get("OperatingTimesId") or 0,
            "nch": l.get("NumberOfChambers"),
            "len": round(max(ln), 1) if ln else None,
            "w": round(max(wd), 1) if wd else None,
        })

    used = {o["ot"] for o in objs if o.get("ot")}
    otmap = {k: v for k, v in otmap.items() if k in used}

    data = {"gen": gen, "objs": objs, "ot": otmap}
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    with open(os.path.join(OUT, "static.json.gz"), "wb") as f:
        f.write(gzip.compress(blob, 9))
    print(f"static.json.gz: {len(objs)} objecten, {len(otmap)} regelingen")
    return gen


def build_strem():
    now = int(time.time() * 1000)
    until = now + 60 * 86400 * 1000
    # berichten die NU (komende 2 uur) gelden — alleen die tellen mee voor de status
    d_act = get(f"{NTS}?validFrom={now}&validUntil={now + 2 * 3600 * 1000}&ntsTypes=FTM&limitationGroup=ALL")
    act_ids = {s.get("ntsSummaryId") for s in d_act}
    # alle berichten voor de komende 60 dagen (incl. aangekondigde werkzaamheden)
    d = get(f"{NTS}?validFrom={now}&validUntil={until}&ntsTypes=FTM&limitationGroup=ALL")
    strem = []
    for s in d:
        loc = s.get("location") or []
        if not loc:
            continue
        nn = s.get("ntsNumber") or {}
        strem.append({
            "lat": round(loc[0]["lat"], 5), "lon": round(loc[0]["lon"], 5),
            "code": s.get("limitationCode") or "",
            "loc": s.get("locationName") or "",
            "fw": s.get("fairwayName") or "",
            "start": s.get("startDate"),
            "act": 1 if s.get("ntsSummaryId") in act_ids else 0,
            "nts": f"{nn.get('organisation','')}-{nn.get('year','')}-{nn.get('number','')}",
        })
    with open(os.path.join(OUT, "strem.json"), "w") as f:
        json.dump({"ts": now, "strem": strem}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"strem.json: {len(strem)} berichten")


def write_meta(full):
    meta_path = os.path.join(OUT, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        try:
            meta = json.load(open(meta_path))
        except Exception:  # noqa: BLE001
            meta = {}
    now = int(time.time() * 1000)
    meta["stremTs"] = now
    if full:
        meta["staticTs"] = now
    json.dump(meta, open(meta_path, "w"))


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    full = "--full" in sys.argv
    if full:
        build_full()
    build_strem()
    write_meta(full)
    print("klaar")
