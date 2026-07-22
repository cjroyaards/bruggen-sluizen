import json, os
import numpy as np, rasterio
from scipy.ndimage import binary_erosion

src = rasterio.open('/tmp/emod_ext.tif')
water = np.load('/tmp/water_ext.npy')
# stevig eroderen zodat lijnen nergens het land raken (~3 cellen = 350 m)
wmask = binary_erosion(water, iterations=3)
inv = ~src.transform
H, W = wmask.shape

def inwater(lon, lat):
    c, r = inv*(lon, lat)
    ci, ri = int(c), int(r)
    if ri < 0 or ci < 0 or ri >= H or ci >= W: return True   # buiten grid: laten staan (geen info)
    return bool(wmask[ri, ci])

def clipline(coords):
    """splits een lijn in stukken die volledig in water liggen; bemonster ook tussenpunten (~120 m)."""
    out = []; cur = []
    for k in range(len(coords)):
        lon, lat = coords[k][0], coords[k][1]
        ok = inwater(lon, lat)
        if ok and k > 0 and cur:
            # check tussenliggend pad
            plon, plat = cur[-1]
            dist = max(abs(lon-plon), abs(lat-plat))
            nsteps = int(dist/0.0012)
            for st in range(1, nsteps+1):
                f = st/(nsteps+1)
                if not inwater(plon+(lon-plon)*f, plat+(lat-plat)*f):
                    ok = False; break
        if ok:
            cur.append([lon, lat])
        else:
            if len(cur) >= 2: out.append(cur)
            cur = [[lon, lat]] if inwater(lon, lat) else []
    if len(cur) >= 2: out.append(cur)
    return out

d = json.load(open('/home/claude/brugsite/data/depth.geojson'))
nin = nout = 0
for ft in d['features']:
    g = ft['geometry']
    lines = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
    nin += len(lines)
    new = []
    for ln in lines:
        new += clipline(ln)
    nout += len(new)
    ft['geometry'] = {"type": "MultiLineString", "coordinates": new}
def rnd(o):
    if isinstance(o, float): return round(o, 4)
    if isinstance(o, list): return [rnd(x) for x in o]
    return o
for ft in d['features']:
    ft['geometry']['coordinates'] = rnd(ft['geometry']['coordinates'])
json.dump(d, open('/home/claude/brugsite/data/depth.geojson', 'w'), separators=(',', ':'))
print('lijnen in:', nin, '-> uit:', nout, '| MB:', round(os.path.getsize('/home/claude/brugsite/data/depth.geojson')/1e6, 2), flush=True)
