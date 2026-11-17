"""Build site/geo/ba_footprints.json: approximate balancing-authority service areas for the home map.

Input : geo_source/control_areas_us_raw.geojson (HIFLD Control Areas, WGS84; see geo_source/PROVENANCE.md)
        site/vendor/us-atlas-3.0.1-states-albers-10m.json (already projected; used as the land/coast mask)
        site/data/<latest issue>/summary.json (BA centroids, for the match check only)
Output: site/geo/ba_footprints.json  (site/geo, not site/data: build_site.py rebuilds site/data)

Coordinates are projected with exactly the same lower-48 d3.geoAlbersUsa math as site/js/usmap.js
(scale 1300, translate [487.5, 305], 975 x 610 viewBox), clipped to the lower-48 state outline, simplified
and written as SVG path strings (relative 'l' steps on a 0.1-unit grid).

Run:  python -I tools/make_footprints.py      (from F:/labweb/forecast; needs shapely >= 2 and numpy)
"""
import glob
import json
import math
import os
import sys

import numpy as np
import shapely
from shapely.geometry import MultiPolygon, Polygon, Point, shape
from shapely.ops import polylabel, unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'geo_source', 'control_areas_us_raw.geojson')
STATES = os.path.join(ROOT, 'site', 'vendor', 'us-atlas-3.0.1-states-albers-10m.json')
OUT = os.path.join(ROOT, 'site', 'geo', 'ba_footprints.json')

# Our 29 BA codes -> HIFLD NAME(s). CPLE is "Duke Energy Progress" stitched from EIA respondents 122+214
# in sample/selection.csv (East + West), so its footprint is the union of PROGRESS EAST and PROGRESS WEST.
# SPPC (Sierra Pacific) has no polygon and stays a point marker on the map.
MAP = {
    'AEC': ['POWERSOUTH ENERGY COOPERATIVE'],
    'AECI': ['ASSOCIATED ELECTRIC COOPERATIVE, INC.'],
    'AVA': ['AVISTA CORPORATION'],
    'BANC': ['BALANCING AUTHORITY OF NORTHERN CALIFORNIA'],
    'BPAT': ['BONNEVILLE POWER ADMINISTRATION'],
    'CISO': ['CALIFORNIA INDEPENDENT SYSTEM OPERATOR'],
    'CPLE': ['DUKE ENERGY PROGRESS EAST', 'DUKE ENERGY PROGRESS WEST'],
    'DUK': ['DUKE ENERGY CAROLINAS'],
    'EPE': ['EL PASO ELECTRIC COMPANY'],
    'ERCO': ['ELECTRIC RELIABILITY COUNCIL OF TEXAS, INC.'],
    'FPC': ['DUKE ENERGY FLORIDA INC'],
    'FPL': ['FLORIDA POWER & LIGHT COMPANY'],
    'IPCO': ['IDAHO POWER COMPANY'],
    'ISNE': ['ISO NEW ENGLAND INC.'],
    'JEA': ['JEA'],
    'LDWP': ['LOS ANGELES DEPARTMENT OF WATER AND POWER'],
    'LGEE': ['LOUISVILLE GAS AND ELECTRIC COMPANY AND KENTUCKY UTILITIES'],
    'NEVP': ['NEVADA POWER COMPANY'],
    'NYIS': ['NEW YORK INDEPENDENT SYSTEM OPERATOR'],
    'PGE': ['PORTLAND GENERAL ELECTRIC COMPANY'],
    'PJM': ['PJM INTERCONNECTION, LLC'],
    'PSEI': ['PUGET SOUND ENERGY'],
    'SC': ['SOUTH CAROLINA PUBLIC SERVICE AUTHORITY'],
    'SCEG': ['SOUTH CAROLINA ELECTRIC & GAS COMPANY'],
    'SCL': ['SEATTLE CITY LIGHT'],
    'SRP': ['SALT RIVER PROJECT'],
    'TEC': ['TAMPA ELECTRIC COMPANY'],
    'TVA': ['TENNESSEE VALLEY AUTHORITY'],
}
NO_POLYGON = ['SPPC']
# Documented corrections where the HIFLD polygon clearly exceeds the BA (checked against the summary centroid):
#  EPE: the HIFLD polygon runs from southern New Mexico to Laredo, overlapping ERCOT; El Paso Electric is
#       outside ERCOT, so the ERCOT overlap is removed.
#  JEA: the largest HIFLD part lies in the Florida panhandle / south Georgia, ~330 km from Jacksonville;
#       detached parts more than 150 km from the BA's load centroid are dropped.
SUBTRACT = {'EPE': ['ELECTRIC RELIABILITY COUNCIL OF TEXAS, INC.']}
MAX_KM = {'JEA': 150}
#  EPE (2nd correction): even after removing ERCOT the polygon is ~5x the real service area (about 10,000 sq mi),
#       so it is clipped to a 130 km disc around the El Paso load centroid. The curved edge is an approximation.
CLIP_KM = {'EPE': 130}
DROP_STATES = {'AK', 'HI', 'NB'}          # Alaska, Hawaii, New Brunswick (Canada): not lower 48
TOL = 0.45                                # simplify tolerance, viewBox units (~0.5 px at 975 px wide)
SLIVER = 0.6                              # drop polygon parts / holes smaller than this (units^2)
CTX_MIN = 4.0                             # context parts smaller than this are dropped
KM_PER_UNIT = 6371.0 / 1300.0             # ~4.9 km per viewBox unit near the standard parallels

# --- d3.geoAlbersUsa lower-48 branch, identical to site/js/usmap.js ---
RAD = math.pi / 180
phi0, phi1 = 29.5 * RAD, 45.5 * RAD
sy0 = math.sin(phi0); n = (sy0 + math.sin(phi1)) / 2
c = 1 + sy0 * (2 * n - sy0); r0 = math.sqrt(c) / n
K, TX, TY = 1300.0, 487.5, 305.0


def _raw(lam, phi):
    r = np.sqrt(c - 2 * n * np.sin(phi)) / n
    x = lam * n
    return r * np.sin(x), r0 - r * np.cos(x)


_cx, _cy = _raw(-0.6 * RAD, 38.7 * RAD)
DX, DY = TX - K * _cx, TY + K * _cy


def project_xy(lonlat):
    lon, lat = lonlat[:, 0], lonlat[:, 1]
    lam = (lon + 96) * RAD
    lam = np.where(lam > math.pi, lam - 2 * math.pi, np.where(lam < -math.pi, lam + 2 * math.pi, lam))
    x, y = _raw(lam, lat * RAD)
    return np.column_stack([DX + K * x, DY - K * y])


def project(g):
    return shapely.transform(g, project_xy)


# --- vendored states TopoJSON -> lower-48 land mask in projected units ---
def land_mask():
    topo = json.load(open(STATES, encoding='utf-8'))
    t = topo.get('transform')
    arcs = []
    for arc in topo['arcs']:
        x = y = 0; pts = []
        for p in arc:
            if t:
                x += p[0]; y += p[1]
                pts.append((x * t['scale'][0] + t['translate'][0], y * t['scale'][1] + t['translate'][1]))
            else:
                pts.append(tuple(p))
        arcs.append(pts)

    def ring(r):
        pts = []
        for k, i in enumerate(r):
            a = arcs[~i][::-1] if i < 0 else arcs[i]
            pts.extend(a if k == 0 else a[1:])
        return pts

    polys = []
    for g in topo['objects']['states']['geometries']:
        name = (g.get('properties') or {}).get('name', '')
        if name in ('Alaska', 'Hawaii'):
            continue
        rings = [g['arcs']] if g['type'] == 'Polygon' else g['arcs'] if g['type'] == 'MultiPolygon' else []
        for poly in rings:
            rs = [ring(r) for r in poly]
            polys.append(shapely.make_valid(Polygon(rs[0], rs[1:])))
    return unary_union(polys).buffer(0)


def clean(g, min_area=SLIVER, keep_largest=True):
    """Valid polygonal geometry, holes and parts below min_area removed (largest part always kept)."""
    if g is None or g.is_empty:
        return None
    g = shapely.make_valid(g).buffer(0)
    parts = [p for p in getattr(g, 'geoms', [g]) if isinstance(p, Polygon) and not p.is_empty]
    if not parts:
        return None
    out = []
    for p in parts:
        holes = [h for h in p.interiors if Polygon(h).area >= min_area]
        out.append(Polygon(p.exterior, holes))
    big = [p for p in out if p.area >= min_area]
    if not big and keep_largest:
        big = [max(out, key=lambda p: p.area)]
    if not big:
        return None
    return big[0] if len(big) == 1 else MultiPolygon(big)


def to_path(g):
    """SVG path: absolute M per ring, then relative l steps on a 0.1 grid (exact, no drift)."""
    out = []
    for p in getattr(g, 'geoms', [g]):
        for r in [p.exterior, *p.interiors]:
            q = np.rint(np.asarray(r.coords)[:-1] * 10).astype(np.int64)
            keep = np.ones(len(q), bool); keep[1:] = np.any(q[1:] != q[:-1], axis=1)
            q = q[keep]
            if len(q) < 3:
                continue
            s = ['M%s,%s' % (fmt(q[0, 0]), fmt(q[0, 1]))]
            d = np.diff(q, axis=0)
            s.append('l')
            for k, (dx, dy) in enumerate(d):
                a = fmt(dx)
                if k and not a.startswith('-'):
                    s.append(' ')
                s.append(pair(dx, dy))
            out.append(''.join(s) + 'z')
    return ''.join(out)


def fmt(v):  # tenths integer -> shortest decimal string
    v = int(v); neg = v < 0; v = abs(v)
    s = str(v // 10) + ('.' + str(v % 10) if v % 10 else '')
    if s.startswith('0.'):
        s = s[1:]
    return ('-' if neg else '') + s


def pair(dx, dy):
    a, b = fmt(dx), fmt(dy)
    return a + ('' if b.startswith('-') else ',') + b


def main():
    raw = json.load(open(RAW, encoding='utf-8'))
    feats = raw['features']
    by_name = {}
    for f in feats:
        nm = (f['properties'].get('NAME') or '').strip()
        by_name.setdefault(nm, []).append(f)

    summaries = sorted(glob.glob(os.path.join(ROOT, 'site', 'data', '20*', 'summary.json')))
    cent = {}
    if summaries:
        for b in json.load(open(summaries[-1], encoding='utf-8')).get('bas', []):
            cent[b['ba']] = (b.get('lon'), b.get('lat'), b.get('name'))

    mask = land_mask()
    print('land mask area', round(mask.area), 'units^2')

    years = set()
    bas = {}
    used = set()
    for code, names in MAP.items():
        geoms = []
        for nm in names:
            if nm not in by_name:
                sys.exit('No HIFLD polygon named %r for %s' % (nm, code))
            for f in by_name[nm]:
                geoms.append(shapely.make_valid(shape(f['geometry'])).buffer(0))
                years.add(str(f['properties'].get('YEAR')))
            used.add(nm)
        g = unary_union(geoms)
        for nm in SUBTRACT.get(code, []):
            g = g.difference(unary_union([shapely.make_valid(shape(f['geometry'])).buffer(0) for f in by_name[nm]]))
        g = project(g)
        g = shapely.make_valid(g).buffer(0).intersection(mask)
        g = clean(g)
        if code in MAX_KM and code in cent:
            pt = Point(project_xy(np.array([cent[code][:2]], float))[0])
            keep = [p for p in getattr(g, 'geoms', [g]) if p.distance(pt) * KM_PER_UNIT <= MAX_KM[code]]
            g = keep[0] if len(keep) == 1 else MultiPolygon(keep)
        if code in CLIP_KM and code in cent:      # HIFLD polygon far larger than the service area: keep a disc around the load centroid
            pt = Point(project_xy(np.array([cent[code][:2]], float))[0])
            g = clean(g.intersection(pt.buffer(CLIP_KM[code] / KM_PER_UNIT)))
        g = clean(shapely.simplify(g, TOL, preserve_topology=True))
        bas[code] = {'names': names, 'geom': g}

    # draw order: larger areas first, so small ones (SCL, TEC, JEA, LDWP...) sit on top
    order = sorted(bas, key=lambda k: -bas[k]['geom'].area)
    # label point: pole of inaccessibility of the part left visible by everything drawn above it
    for i, code in enumerate(order):
        g = bas[code]['geom']
        above = [bas[k]['geom'] for k in order[i + 1:]]
        vis = g.difference(unary_union(above)) if above else g
        vis = clean(vis, keep_largest=True) if vis is not None and not vis.is_empty else None
        base = vis if vis is not None and vis.area > 0.15 * g.area else g
        parts = getattr(base, 'geoms', [base])
        cp = Point(project_xy(np.array([cent[code][:2]], float))[0]) if code in cent else None
        if cp is not None and base.buffer(-1.5).contains(cp):
            lp = cp                                            # load centroid sits well inside: label there
        else:                                                   # else pole of the part nearest the centroid
            main_part = min(parts, key=lambda p: (p.distance(cp) if cp is not None else 0, -p.area))
            lp = polylabel(main_part, tolerance=0.5)
        bas[code]['lp'] = lp
        bas[code]['vis_frac'] = (vis.area / g.area) if vis is not None else 0.0

    # match check: projected BA centroid from summary.json vs polygon
    print('\n%-5s %-58s %9s %8s %8s %s' % ('code', 'HIFLD NAME', 'area_u2', 'in_km', 'lp_km', 'note'))
    flags = []
    for code in sorted(bas):
        g = bas[code]['geom']
        note = ''
        dk = lk = float('nan')
        if code in cent and cent[code][0] is not None:
            p = Point(project_xy(np.array([[cent[code][0], cent[code][1]]]))[0])
            dk = g.distance(p) * KM_PER_UNIT
            lk = p.distance(bas[code]['lp']) * KM_PER_UNIT
            if dk > 25:
                note = 'CENTROID OUTSIDE (%.0f km)' % dk; flags.append(code)
        if bas[code]['vis_frac'] < 0.15:
            note += ' mostly covered by smaller areas'
        print('%-5s %-58s %9.0f %8.1f %8.1f %s' % (code, ' + '.join(bas[code]['names'])[:58], g.area, dk, lk, note))
    for code in NO_POLYGON:
        p = cent.get(code)
        if p:
            pt = Point(project_xy(np.array([[p[0], p[1]]]))[0])
            inside = [k for k in bas if bas[k]['geom'].contains(pt)]
            print('%-5s %-58s %9s  point marker; centroid lies inside: %s' % (code, '(no polygon)', '-', ', '.join(inside) or 'none'))

    # context: other lower-48 control areas, minus our footprints; smaller ones win where they overlap each other
    ours = unary_union([b['geom'] for b in bas.values()])
    ctx_src = []
    for f in feats:
        p = f['properties']; nm = (p.get('NAME') or '').strip()
        if nm in used or (p.get('STATE') or '').strip() in DROP_STATES or not f['geometry']:
            continue
        g = project(shapely.make_valid(shape(f['geometry'])).buffer(0))
        g = shapely.make_valid(g).buffer(0).intersection(mask)
        if g.is_empty:
            continue
        ctx_src.append((nm, g))
    ctx_src.sort(key=lambda t: t[1].area)
    taken = ours
    context = []
    for nm, g in ctx_src:
        rest = g.difference(taken)
        rest = clean(rest, CTX_MIN, keep_largest=False)
        if rest is None:
            continue
        taken = taken.union(rest)
        rest = clean(shapely.simplify(rest, TOL * 1.5, preserve_topology=True), CTX_MIN, keep_largest=False)
        if rest is not None:
            context.append((nm, rest))
    context.sort(key=lambda t: -t[1].area)
    print('\ncontext areas kept:', len(context))
    for nm, g in context:
        print('   %-70s %8.0f' % (nm[:70], g.area))

    doc = {
        'version': 1,
        'source': 'HIFLD Control Areas (Oak Ridge, Los Alamos and Idaho National Laboratories with NGA HSIP), public domain',
        'vintage': 'mostly 2018 (years in file: %s)' % ', '.join(sorted(years)),
        'note': 'Approximate service areas, not legal boundaries; polygons may overlap or leave gaps. Projected with '
                'd3.geoAlbersUsa lower-48 (scale 1300, translate [487.5,305]) to the 975x610 map, clipped to the '
                'lower-48 outline. CPLE = Duke Energy Progress East + West. SPPC has no polygon (point marker).',
        'projection': {'type': 'albersUsa-lower48', 'scale': 1300, 'translate': [487.5, 305], 'width': 975, 'height': 610},
        'order': order,
        'nopolygon': NO_POLYGON,
        'bas': {code: {
            'name': ' + '.join(bas[code]['names']),
            'path': to_path(bas[code]['geom']),
            'area': round(bas[code]['geom'].area, 1),
            'cx': round(bas[code]['lp'].x, 1), 'cy': round(bas[code]['lp'].y, 1),
        } for code in order},
        'context': [{'name': nm, 'path': to_path(g)} for nm, g in context],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    txt = json.dumps(doc, separators=(',', ':'), ensure_ascii=True)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(txt)
    print('\nwrote %s  %.1f KB  (bas %.1f KB, context %.1f KB)' % (
        OUT, len(txt) / 1024,
        sum(len(v['path']) for v in doc['bas'].values()) / 1024,
        sum(len(v['path']) for v in doc['context']) / 1024))
    if flags:
        print('CHECK:', ', '.join(flags))


if __name__ == '__main__':
    main()
