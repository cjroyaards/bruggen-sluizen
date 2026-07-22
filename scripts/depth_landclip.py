import json, glob, os
from shapely.geometry import shape, mapping, Polygon, MultiPolygon
from shapely.ops import unary_union
from shapely import make_valid
from shapely.prepared import prep

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

# 1) al het ENC-land verzamelen (dammen, dijken, sluiscomplexen zitten hier exact in)
land = []
for f in glob.glob('enc/LNDARE/*.geojson'):
    try: d = json.load(open(f))
    except: continue
    for ft in d['features']:
        g = ft.get('geometry')
        if not g: continue
        try:
            geom = shape(g)
            if not geom.is_valid: geom = make_valid(geom)
            for p in polys_of(geom):
                ps = p.simplify(0.0002, preserve_topology=True)
                if ps.is_valid and not ps.is_empty and ps.area > 5e-9:
                    land.append(ps)
        except: continue
print('landpolygonen:', len(land), flush=True)
# klein buffertje zodat vlakken net niet tot op de damrand komen
U = unary_union(land)
U = U.buffer(0.0004, join_style=1)
U = U.simplify(0.0002, preserve_topology=True)
print('land-unie klaar', flush=True)

# 2) dieptevlakken clippen
d = json.load(open('/home/claude/brugsite/data/depth_smooth.geojson'))
def rnd(o):
    if isinstance(o, float): return round(o, 4)
    if isinstance(o, list): return [rnd(x) for x in o]
    return o
out = []
for ft in d['features']:
    g = shape(ft['geometry'])
    if g.intersects(U):
        g = g.difference(U)
        if g.is_empty: continue
        keep = [p for p in polys_of(g) if p.area > 6e-6]
        if not keep: continue
        g = MultiPolygon(keep)
        ft['geometry'] = mapping(g)
        ft['geometry']['coordinates'] = rnd(ft['geometry']['coordinates'])
    out.append(ft)
    print('band', ft['properties']['t'], 'ok', flush=True)
json.dump({'type': 'FeatureCollection', 'features': out}, open('/home/claude/brugsite/data/depth_smooth.geojson', 'w'), separators=(',', ':'))
print('MB:', round(os.path.getsize('/home/claude/brugsite/data/depth_smooth.geojson')/1e6, 2), flush=True)
