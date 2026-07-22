import sys, json, time, os, urllib.request
import numpy as np, rasterio
from rasterio import features as rfeat
from rasterio.transform import from_origin
from scipy.ndimage import gaussian_filter, binary_opening, binary_closing, label
from shapely.geometry import LineString, shape, mapping, Polygon, MultiPolygon
from shapely.ops import unary_union

NAME, W, S, E, N, SEEDLON, SEEDLAT = sys.argv[1], *map(float, sys.argv[2:8])
UA = {"User-Agent": "brugsluis-app data build"}
RES = 1.0/960.0*16.0/16.0  # 1/16 arcmin in graden = 1/960... EMODnet: 1/16 arcmin = 0.0010416667
RES = 0.25/240.0

def wcs(w, s, e, n, out):
    u = ("https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1&request=GetCoverage"
         "&CoverageId=emodnet__mean&format=image/tiff"
         f"&subset=Lat({s},{n})&subset=Long({w},{e})")
    d = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=600).read()
    open(out, "wb").write(d)
    print("wcs", out, round(len(d)/1e6, 1), "MB", flush=True)

# 1) grid in 2 lon-helften ophalen en samenvoegen
mid = round((W+E)/2, 2)
wcs(W, S, mid, N, f"{NAME}_a.tif"); time.sleep(2)
wcs(mid, S, E, N, f"{NAME}_b.tif")
sa, sb = rasterio.open(f"{NAME}_a.tif"), rasterio.open(f"{NAME}_b.tif")
a, b = sa.read(1), sb.read(1)
if a.shape[0] != b.shape[0]:
    h = min(a.shape[0], b.shape[0]); a, b = a[:h], b[:h]
grid = np.hstack([a, b]).astype(np.float32)
px = (sa.bounds.right - sa.bounds.left)/sa.width
transform = from_origin(sa.bounds.left, sa.bounds.top, px, px)
H, Wd = grid.shape
print("grid", Wd, "x", H, flush=True)

# 2) OSM-kustlijn in sub-boxen
els = []
lonstep = (E-W)/2.0; latstep = (N-S)/2.0
for i in range(2):
    for j in range(2):
        cachef = f"{NAME}_osm_{i}{j}.json"
        if os.path.exists(cachef):
            d = json.load(open(cachef)); els += d.get("elements", [])
            print("osm box", i, j, "cache", len(d.get("elements", [])), flush=True)
            continue
        bs, bw = S+j*latstep, W+i*lonstep
        q = f'[out:json][timeout:90];way["natural"="coastline"]({bs},{bw},{bs+latstep},{bw+lonstep});out geom;'
        ok = False
        for att in range(6):
            host = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"][att % 2]
            try:
                r = urllib.request.urlopen(urllib.request.Request(host, data=q.encode(), headers=UA), timeout=110)
                d = json.load(r)
                json.dump(d, open(cachef, "w"))
                els += d.get("elements", []); ok = True
                print("osm box", i, j, host.split("/")[2], len(d.get("elements", [])), flush=True)
                break
            except Exception as ex:
                print("osm err", i, j, str(ex)[:60], flush=True); time.sleep(30+att*15)
        if not ok: raise SystemExit("OSM-kustlijn mislukt")
        time.sleep(5)
lines = [LineString([(p["lon"], p["lat"]) for p in el["geometry"]]) for el in els if el.get("geometry") and len(el["geometry"]) > 1]
print("kustlijn-ways:", len(lines), flush=True)

# 3) watermasker: kustlijn als barrière, flood-fill vanaf zeezaad
bar = rfeat.rasterize(((l, 1) for l in lines), out_shape=grid.shape, transform=transform, all_touched=True).astype(bool) if lines else np.zeros(grid.shape, bool)
lab, _ = label(~bar)
inv = ~transform
c, rr = inv*(SEEDLON, SEEDLAT)
water = (lab == lab[int(rr), int(c)])
print("water frac:", round(float(water.mean()), 3), flush=True)

# 4) smoothing + banden (zelfde pijplijn als hoofdset)
depth = -grid; depth[~water] = np.nan
val = np.nan_to_num(depth, nan=0.0); msk = (~np.isnan(depth)).astype(np.float32)
sv = gaussian_filter(val, 1.5); sm = gaussian_filter(msk, 1.5)
with np.errstate(invalid="ignore", divide="ignore"):
    Z = sv/sm
Z[sm < 0.2] = np.nan
LEVELS = [(-5, "w"), (0, "b0"), (2, "b2"), (5, "b5"), (10, "b10"), (15, "b15"), (20, "b20")]
def polys_of(g):
    if g is None or g.is_empty: return []
    t = g.geom_type
    if t == "Polygon": return [g]
    if t == "MultiPolygon": return list(g.geoms)
    if t == "GeometryCollection":
        o = []
        for x in g.geoms: o += polys_of(x)
        return o
    return []
feats = []
MIN = 1.6e-5
for lvl, tag in LEVELS:
    m0 = (Z >= lvl) & water
    m0 = binary_closing(binary_opening(m0, iterations=1), iterations=1)
    geoms = [shape(g) for g, v in rfeat.shapes(m0.astype(np.uint8), mask=m0, transform=transform)]
    geoms = [g for g in geoms if g.area > 4e-6]
    if not geoms:
        print(tag, "leeg", flush=True); continue
    u = unary_union(geoms).simplify(0.0003, preserve_topology=True)
    dd = 0.0016
    u = u.buffer(dd, join_style=1).buffer(-2*dd, join_style=1).buffer(dd, join_style=1)
    u = u.simplify(0.0003, preserve_topology=True)
    keep = []
    for p in polys_of(u):
        if p.area < MIN: continue
        holes = [h for h in p.interiors if Polygon(h).area >= MIN]
        keep.append(Polygon(p.exterior, holes))
    if not keep:
        print(tag, "leeg2", flush=True); continue
    feats.append({"type": "Feature", "properties": {"t": tag, "lvl": lvl}, "geometry": mapping(MultiPolygon(keep))})
    print(tag, "ok", len(keep), "polys", flush=True)
def rnd(o):
    if isinstance(o, float): return round(o, 4)
    if isinstance(o, list): return [rnd(x) for x in o]
    return o
for ft in feats:
    ft["geometry"]["coordinates"] = rnd(ft["geometry"]["coordinates"])
out = f"/home/claude/brugsite/data/depth_{NAME}.geojson"
json.dump({"type": "FeatureCollection", "features": feats}, open(out, "w"), separators=(",", ":"))
print("OUT", out, round(os.path.getsize(out)/1e6, 2), "MB", flush=True)
