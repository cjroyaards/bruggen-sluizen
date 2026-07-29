#!/usr/bin/env python3
"""Zet echte Copernicus-data klaar voor scripts/test_currents_decode.js.

Haalt voor een handvol vaarwaters de uo/vo-kleurtegels op (ruwe RGBA naar /tmp), plus de
legenda en de officiele GetFeatureInfo-waarde per punt. Die laatste is de referentie waar
de gedecodeerde waarde tegen wordt afgezet.

Gebruik:  python3 scripts/maak_currents_testdata.py [zoom]   (standaard 12)
"""
import urllib.request, urllib.parse, json, math, datetime, io, sys
from PIL import Image

BASE = 'https://wmts.marine.copernicus.eu/teroWmts?'
DS = 'NWSHELF_ANALYSISFORECAST_PHY_004_013/cmems_mod_nws_phy-cur_anfc_1.5km-2D_PT1H-i_202511/'
STYLE = 'cmap:balance,range:-2.5/2.5'
Z = int(sys.argv[1]) if len(sys.argv) > 1 else 12
ISO = datetime.datetime.now(datetime.timezone.utc).replace(
    minute=0, second=0, microsecond=0).strftime('%Y-%m-%dT%H:00:00.000Z')

PUNTEN = [("Marsdiep", 52.98, 4.78), ("Texelstroom", 53.03, 4.85),
          ("Westerschelde", 51.42, 3.55), ("Oosterschelde", 51.62, 3.85),
          ("IJmuiden", 52.46, 4.40), ("Noordzee", 52.80, 3.60),
          ("Utrecht(land)", 52.09, 5.12), ("IJsselmeer", 52.70, 5.40)]


def get(p):
    return urllib.request.urlopen(BASE + urllib.parse.urlencode(p), timeout=30).read()


def gxy(lat, lon, z):
    n = 2 ** z
    return ((lon + 180) / 360 * n,
            (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)


legend = json.loads(get({'SERVICE': 'WMTS', 'REQUEST': 'GetLegend', 'LAYER': DS + 'uo',
                         'STYLE': STYLE, 'FORMAT': 'application/json'}))
open('/tmp/legend.json', 'w').write(json.dumps(legend))

out = {'z': Z, 'iso': ISO, 'tiles': [], 'punten': []}
for X, Y in {(int(gxy(la, lo, Z)[0]), int(gxy(la, lo, Z)[1])) for _, la, lo in PUNTEN}:
    rec = {'x': X, 'y': Y}
    for var in ('uo', 'vo'):
        im = Image.open(io.BytesIO(get({
            'SERVICE': 'WMTS', 'REQUEST': 'GetTile', 'VERSION': '1.0.0', 'LAYER': DS + var,
            'TILEMATRIXSET': 'EPSG:3857', 'TILEMATRIX': str(Z), 'TILEROW': str(Y), 'TILECOL': str(X),
            'FORMAT': 'image/png', 'STYLE': STYLE, 'time': ISO}))).convert('RGBA')
        fn = f'/tmp/tile_{var}_{Z}_{X}_{Y}.bin'
        open(fn, 'wb').write(im.tobytes())
        rec[var] = fn
    out['tiles'].append(rec)

N = 64          # moet gelijk zijn aan de constante N in currents.js


def ongxy(x, y, z):
    """tegelraster -> lat/lon"""
    n = 2 ** z
    return (math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n)))), x / n * 360 - 180)


def gfi(lat, lon):
    gx, gy = gxy(lat, lon, 12)
    pr = json.loads(get({
        'SERVICE': 'WMTS', 'REQUEST': 'GetFeatureInfo', 'VERSION': '1.0.0',
        'LAYER': DS + 'sea_water_velocity', 'TILEMATRIXSET': 'EPSG:3857', 'TILEMATRIX': '12',
        'TILEROW': str(int(gy)), 'TILECOL': str(int(gx)), 'FORMAT': 'image/png',
        'STYLE': 'cmap:speed,vectorStyle:vector', 'time': ISO,
        'INFOFORMAT': 'application/json',
        'I': str(int((gx % 1) * 256)), 'J': str(int((gy % 1) * 256))}))['features'][0]['properties']
    return pr.get('component1Value'), pr.get('component2Value')


for naam, la, lo in PUNTEN:
    # De app bemonstert het 64x64-raster, dus de referentiewaarde moet van hetzelfde plekje
    # komen; anders meet je celgrenzen van het model in plaats van decodeerfouten.
    gx, gy = gxy(la, lo, Z)
    tx, ty = int(gx), int(gy)
    i = min(N - 1, int((gx - tx) * N))
    j = min(N - 1, int((gy - ty) * N))
    slat, slon = ongxy(tx + (i + 0.5) / N, ty + (j + 0.5) / N, Z)
    u, v = gfi(slat, slon)
    afst = math.hypot((slat - la) * 111, (slon - lo) * 111 * math.cos(math.radians(la))) * 1000
    out['punten'].append({'naam': naam, 'lat': la, 'lon': lo, 'u': u, 'v': v,
                          'monsterAfstandM': round(afst)})

open('/tmp/testdata.json', 'w').write(json.dumps(out))
print(f"klaar: {len(out['tiles'])} tegels, {len(out['punten'])} referentiepunten op zoom {Z}")
