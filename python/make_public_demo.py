#!/usr/bin/env python3
"""Public-data demo: lidar ground, building footprints and an ILLUSTRATIVE storm sewer for a small window.

Inputs (all public):
  --dem    a lidar DEM GeoTIFF in a projected CRS (here: USGS 3DEP 2018 FL Peninsular lidar, 3 ft, EPSG:6438)
  --bld    Microsoft building footprints, line-delimited GeoJSON in lon/lat (optionally .gz)  [ODbL]
  --roads  road centerlines (here: US Census TIGER local roads, MTFCC S1400), any vector format geopandas reads
  --lake-x/--lake-y  a point on the lake surface inside the window (the lake becomes a fixed-level boundary)

The sewer is generated from the roads: a branched network along the streets draining to the lake, with pipes sized
small on purpose so that it floods in the design storm. It is NOT the real drainage system of this place.

    python python/make_public_demo.py --dem DEM.tif --bld footprints.csv.gz --roads roads.gpkg --roads-layer roads \
        --x0 566170 --y1 1576180 --size 2400 --lake-x 566300 --lake-y 1574800 --out examples/public_demo
"""
import argparse, gzip, json, math, os
import numpy as np, geopandas as gpd, networkx as nx, rasterio
from rasterio.windows import from_bounds
from rasterio.features import shapes
from shapely.geometry import box, shape, Point, LineString, Polygon, mapping
from shapely.ops import unary_union, voronoi_diagram


def main(a):
    os.makedirs(a.out, exist_ok=True)
    B = box(a.x0, a.y1 - a.size, a.x0 + a.size, a.y1)
    # ---- DEM clip (keeps the source resolution and CRS)
    with rasterio.open(a.dem) as ds:
        w = from_bounds(*B.bounds, ds.transform).round_offsets().round_lengths()
        z = ds.read(1, window=w, masked=True).astype("float32"); tf = ds.window_transform(w); crs = ds.crs; res = ds.res[0]
    epsg = crs.to_epsg()
    zf = z.filled(-9999.0)
    prof = dict(driver="GTiff", width=zf.shape[1], height=zf.shape[0], count=1, dtype="float32", crs=crs, transform=tf, nodata=-9999.0, compress="deflate", predictor=3)
    with rasterio.open(os.path.join(a.out, "dem.tif"), "w", **prof) as o:
        o.write(zf, 1); o.set_band_description(1, "ground elevation ft NAVD88")
    # ---- lake: cells connected to the lake point, at or below the lake surface + 0.2 ft
    r0, c0 = rasterio.transform.rowcol(tf, a.lake_x, a.lake_y)
    lake_level = float(np.ma.median(z[max(r0 - 3, 0): r0 + 4, max(c0 - 3, 0): c0 + 4]))
    low = (~z.mask) & (z.filled(1e9) <= lake_level + 0.2)
    from scipy.ndimage import label
    lab, _ = label(low); lake = lab == lab[r0, c0]
    polys = [shape(g) for g, v in shapes(lake.astype("uint8"), mask=lake, transform=tf) if v == 1]
    lake_poly = unary_union(polys).buffer(0)
    lake_poly = max(lake_poly.geoms, key=lambda p: p.area) if lake_poly.geom_type == "MultiPolygon" else lake_poly
    lake_poly = lake_poly.simplify(res, preserve_topology=True)
    # ---- buildings
    op = gzip.open if a.bld.endswith(".gz") else open
    lonlat = gpd.GeoSeries([B], crs=crs).to_crs(4326).total_bounds
    geoms = []
    with op(a.bld, "rt") as fh:
        for line in fh:
            line = line.strip().rstrip(",")
            if not line.startswith("{"): continue
            f = json.loads(line); g = f.get("geometry") or f
            xs = [p[0] for p in g["coordinates"][0]]; ys = [p[1] for p in g["coordinates"][0]]
            if max(xs) < lonlat[0] or min(xs) > lonlat[2] or max(ys) < lonlat[1] or min(ys) > lonlat[3]: continue
            geoms.append(shape(g))
    bld = gpd.GeoDataFrame(geometry=geoms, crs=4326).to_crs(crs)
    bld = bld[bld.within(B) & (bld.area >= 200) & ~bld.intersects(lake_poly)].reset_index(drop=True)
    bld["geometry"] = bld.geometry.simplify(0.5)
    feats = [{"type": "Feature", "properties": {"id": i, "area_sqft": round(g.area)}, "geometry": json.loads(json.dumps(mapping(g), default=float))} for i, g in enumerate(bld.geometry)]
    for f in feats:
        f["geometry"]["coordinates"] = [[[round(x, 2), round(y, 2)] for x, y in ring] for ring in f["geometry"]["coordinates"]]
    crs_obj = {"type": "name", "properties": {"name": f"urn:ogc:def:crs:EPSG::{epsg}"}}
    json.dump({"type": "FeatureCollection", "name": "buildings", "crs": crs_obj, "features": feats}, open(os.path.join(a.out, "buildings.geojson"), "w"), separators=(",", ":"))
    json.dump({"type": "FeatureCollection", "name": "lake", "crs": crs_obj, "features": [{"type": "Feature", "properties": {"node": "OF1", "level_ft": round(lake_level, 2)},
               "geometry": json.loads(json.dumps(mapping(lake_poly)))}]}, open(os.path.join(a.out, "lake.geojson"), "w"), separators=(",", ":"))
    # ---- illustrative sewer along the roads
    roads = gpd.read_file(a.roads, layer=a.roads_layer).to_crs(crs)
    roads = roads[roads.intersects(B.buffer(-60))]
    if "MTFCC" in roads: roads = roads[roads.MTFCC.isin(["S1400", "S1200"])]
    G = nx.Graph()
    def gz(x, y):
        r, c = rasterio.transform.rowcol(tf, x, y); r = min(max(r, 0), z.shape[0] - 1); c = min(max(c, 0), z.shape[1] - 1); return float(z[r, c])
    key = lambda p: (round(p[0], 0), round(p[1], 0))
    for geom in roads.geometry.intersection(B.buffer(-60)):
        for ln in getattr(geom, "geoms", [geom]):
            if ln.is_empty or ln.length < 1: continue
            n = max(1, int(ln.length // 150)); pts = [ln.interpolate(i / n, normalized=True) for i in range(n + 1)]
            for p, q in zip(pts[:-1], pts[1:]):
                G.add_edge(key((p.x, p.y)), key((q.x, q.y)), w=p.distance(q))
    # merge nodes closer than 20 ft (road joins)
    nodes = list(G.nodes); from scipy.spatial import cKDTree
    t = cKDTree(np.array(nodes))
    for i, j in t.query_pairs(20):
        if nodes[i] in G and nodes[j] in G and nodes[i] != nodes[j]:
            G = nx.contracted_nodes(G, nodes[i], nodes[j], self_loops=False)
    G = G.subgraph(max(nx.connected_components(G), key=len)).copy()
    # outfall: the road node closest to the lake; the network is the shortest-path tree from there to the 4 highest far nodes
    out_node = min(G.nodes, key=lambda n: lake_poly.exterior.distance(Point(n)))
    dist = nx.single_source_dijkstra_path_length(G, out_node, weight="w")
    far = sorted([n for n in G.nodes if dist[n] > 900], key=lambda n: -gz(*n))
    chosen = []
    for n in far:
        if all(Point(n).distance(Point(m)) > 700 for m in chosen): chosen.append(n)
        if len(chosen) == 4: break
    paths = [nx.shortest_path(G, out_node, n, weight="w") for n in chosen]
    # junctions every ~300 ft along each path (plus junctions where paths split)
    J, E = {}, set()
    for path in paths:
        acc, prev = 0.0, out_node
        J.setdefault(out_node, None)
        for i in range(1, len(path)):
            acc += math.dist(path[i - 1], path[i])
            last = i == len(path) - 1
            if acc >= 300 or last or path[i] in J:
                J.setdefault(path[i], None); E.add((path[i], prev)); prev = path[i]; acc = 0.0
    # names and inverts: 6 ft cover, falling at least 0.3% toward the outfall
    order = sorted(J, key=lambda n: dist[n])
    names = {n: ("OUT" if n == out_node else f"J{i}") for i, n in enumerate(order)}
    down = {u: v for u, v in E}
    inv = {}
    for n in order:
        g = gz(*n); iv = g - 6.0
        if n in down: iv = max(iv, inv[down[n]] + 0.003 * math.dist(n, down[n]))
        inv[n] = iv
    for n in reversed(order):   # cover check after raising: never above ground - 3 ft
        inv[n] = min(inv[n], gz(*n) - 3.0)
    # upstream counts -> pipe size (deliberately small)
    ups = {n: 0 for n in J}
    for n in order[::-1]:
        if n in down: ups[down[n]] += ups[n] + 1
    lake_pt = lake_poly.exterior.interpolate(lake_poly.exterior.project(Point(out_node)))
    # ---- SWMM model (US units)
    L = []; w = L.append
    w("[TITLE]\nIllustrative storm sewer generated from street centerlines (NOT the real drainage system)\n")
    w("[OPTIONS]")
    for k, v in [("FLOW_UNITS", "CFS"), ("INFILTRATION", "GREEN_AMPT"), ("FLOW_ROUTING", "DYNWAVE"), ("LINK_OFFSETS", "ELEVATION"), ("ALLOW_PONDING", "NO"),
                 ("START_DATE", "08/01/2024"), ("START_TIME", "00:00:00"), ("REPORT_START_DATE", "08/01/2024"), ("REPORT_START_TIME", "00:00:00"),
                 ("END_DATE", "08/01/2024"), ("END_TIME", "06:00:00"), ("REPORT_STEP", "00:05:00"), ("WET_STEP", "00:01:00"), ("DRY_STEP", "01:00:00"),
                 ("ROUTING_STEP", "0:00:05"), ("INERTIAL_DAMPING", "PARTIAL"), ("NORMAL_FLOW_LIMITED", "BOTH"), ("VARIABLE_STEP", "0.75"),
                 ("MIN_SURFAREA", "12.557"), ("THREADS", "1")]:
        w(f"{k:<20} {v}")
    w("\n[RAINGAGES]\nRG1              INTENSITY 0:05     1.0      TIMESERIES DESIGN")
    # subcatchments: Voronoi cells of the junctions, clipped to the window minus the lake
    land = B.difference(lake_poly)
    jn = [n for n in order if n != out_node]
    vor = voronoi_diagram(unary_union([Point(n) for n in jn]), envelope=B)
    w("\n[SUBCATCHMENTS]\n;;Name Raingage Outlet Area %Imperv Width %Slope CurbLen")
    subs = []
    for cell in vor.geoms:
        poly = cell.intersection(land)
        if poly.is_empty: continue
        n = min(jn, key=lambda q: Point(q).distance(cell.centroid) if not cell.contains(Point(q)) else -1)
        poly = max(poly.geoms, key=lambda p: p.area) if poly.geom_type == "MultiPolygon" else poly
        ac = poly.area / 43560; subs.append((f"S_{names[n]}", names[n], ac, poly))
        w(f"S_{names[n]:<14} RG1 {names[n]:<8} {ac:.3f} 45 {math.sqrt(poly.area):.1f} 1.0 0")
    w("\n[SUBAREAS]")
    for s in subs: w(f"{s[0]:<16} 0.015 0.15 0.06 0.15 25 OUTLET")
    w("\n[INFILTRATION]")
    for s in subs: w(f"{s[0]:<16} 2.4 0.5 0.3")
    w("\n[JUNCTIONS]\n;;Name Elevation MaxDepth InitDepth SurDepth Aponded")
    for n in order:
        if n == out_node: continue
        w(f"{names[n]:<16} {inv[n]:.2f} {gz(*n) - inv[n]:.2f} 0 0 0")
    w("\n[OUTFALLS]")
    w(f"OF1              {min(inv[out_node], lake_level - 1.0):.2f} FIXED {lake_level:.2f} NO")
    w("\n[CONDUITS]")
    links = []
    for (u, v) in sorted(E, key=lambda e: dist[e[0]]):
        links.append((f"P{len(links) + 1}", names[u], names[v], max(math.dist(u, v), 20), inv[u], inv[v], ups[u]))
    links.append(("P_OUT", "OUT", "OF1", max(Point(out_node).distance(lake_pt), 30), inv[out_node], min(inv[out_node], lake_level - 1.0) , ups[out_node]))
    # OUT is a junction too
    L.insert(L.index("\n[OUTFALLS]"), f"OUT              {inv[out_node]:.2f} {gz(*out_node) - inv[out_node]:.2f} 0 0 0")
    for l in links: w(f"{l[0]:<8} {l[1]:<8} {l[2]:<8} {l[3]:.1f} 0.013 {l[4]:.2f} {l[5]:.2f} 0 0")
    w("\n[XSECTIONS]")
    for l in links: w(f"{l[0]:<8} CIRCULAR {1.25 if l[6] < 2 else 1.5 if l[6] < 5 else 2.0 if l[6] < 10 else 2.5} 0 0 0 1")
    w("\n[TIMESERIES]")
    blocks = [0.6, 0.8, 1.0, 1.3, 1.7, 2.3, 3.2, 4.8, 7.5, 9.0, 6.0, 4.0, 2.8, 2.1, 1.6, 1.3, 1.1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4]
    tot = sum(blocks) * 5 / 60; blocks = [b * 4.0 / tot for b in blocks]
    for k, b in enumerate(blocks): w(f"DESIGN   {k * 5 // 60}:{k * 5 % 60:02d} {b:.4f}")
    w("DESIGN   2:00 0")
    w("\n[REPORT]\nNODES ALL\nLINKS ALL\n\n[MAP]\nUNITS Feet\n\n[COORDINATES]")
    for n in order: w(f"{names[n]:<16} {n[0]:.2f} {n[1]:.2f}")
    w(f"OF1              {lake_pt.x:.2f} {lake_pt.y:.2f}")
    w("\n[POLYGONS]")
    for s in subs:
        for x, y in list(s[3].exterior.coords)[:-1]: w(f"{s[0]:<16} {x:.1f} {y:.1f}")
    inp = os.path.join(a.out, "model.inp"); open(inp, "w").write("\n".join(L) + "\n")
    from swmm.toolkit import solver
    solver.swmm_run(inp, os.path.join(a.out, "model.rpt"), os.path.join(a.out, "model.out"))
    json.dump({"name": "Public-data demo (lidar, footprints, illustrative sewer)", "epsg": epsg, "units": "US", "dem": "dem.tif", "buildings": "buildings.geojson",
               "boundaries": "lake.geojson", "inp": "model.inp", "out": "model.out", "lake_level_ft": round(lake_level, 2),
               "sources": {"dem": "USGS 3DEP lidar (2018 FL Peninsular), public domain", "buildings": "Microsoft Building Footprints, ODbL 1.0",
                           "roads": "US Census Bureau TIGER/Line, public domain", "sewer": "generated by make_public_demo.py from the road centerlines; illustrative only"},
               "note": "The storm sewer is invented for the demo and is not the real drainage system."}, open(os.path.join(a.out, "example.json"), "w"), indent=1)
    print("wrote", a.out, "junctions", len(J), "links", len(links), "buildings", len(feats), "lake level", round(lake_level, 2))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    for k in ("dem", "bld", "roads", "out"): ap.add_argument("--" + k, required=True)
    ap.add_argument("--roads-layer", default=None)
    for k in ("x0", "y1", "size", "lake_x", "lake_y"): ap.add_argument("--" + k.replace("_", "-"), dest=k, type=float, required=True)
    main(ap.parse_args())
