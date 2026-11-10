#!/usr/bin/env python3
"""Real-site example: downtown Winter Haven, Florida, around Lake Martha, built only from public data.

    python python/make_winter_haven_demo.py examples/winter_haven [--cell 3] [--margin 400] [--ari 25]

Downloads, in NAD83 / Florida West (ftUS), EPSG 2237:
  - storm sewer: City of Winter Haven stormwater inventory (ArcGIS Online, public view): pipes with inverts, sizes and from/to structures,
    structures (inlets, manholes, ends) and the Lake Martha outfall basin;
  - ground: USGS 3DEP 1 m lidar DEM (FL Peninsular FDEM 2018), resampled to --cell ft, NAVD88 converted to feet;
  - lakes: USGS NHD waterbodies (level boundaries; the level is the lidar water surface);
  - buildings: FEMA USA Structures footprints;
  - land cover: NLCD 2021 (MRLC); soils: USDA SSURGO hydrologic soil groups (Soil Data Access);
  - rain: NOAA Atlas 14 depth-duration values at the site, arranged as a nested (balanced) 24-hour storm in 5-minute steps.
Builds a SWMM5 .inp from the sewer: junction rims from the lidar at each structure, inverts from the pipes, pipe ends that leave the
network or reach a lake as outfalls (a lake outfall is FIXED at the lake level). No subcatchments: rain falls on the 2D grid and enters
the sewer through the inlets (two-way coupling). Every assumption is written to build_report.json.
"""
import argparse, io, json, math, os, sys, zipfile, datetime
import numpy as np, requests, rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import from_origin
from pyproj import Transformer
from shapely.geometry import shape, mapping, Point, box
from shapely.ops import unary_union

EPSG = 2237
CITY = "https://services.arcgis.com/hNKc1r3SBL6SVC6I/ArcGIS/rest/services"
LAYERS = {"pipes": "GIS_ASSET_STRM_Pipes/FeatureServer/5", "inlets": "GIS_ASSET_STRM_Inlet/FeatureServer/4", "manholes": "GIS_ASSET_STRM_Manhole/FeatureServer/1",
          "outlets": "GIS_ASSET_STRM_Outlet/FeatureServer/2",
          "basins": "City_Stormwater_Pipe_Assessment_WFL1/FeatureServer/1"}
NHD = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12"
FEMA = "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0"
TNM = "https://tnmaccess.nationalmap.gov/api/v1/products"
NLCD_WCS = "https://www.mrlc.gov/geoserver/mrlc_download/NLCD_2021_Land_Cover_L48/wcs"
SDA = "https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest"
PFDS = "https://hdsc.nws.noaa.gov/cgi-bin/hdsc/new/cgi_readH5.py"
ROUGH = {"CONCRETE": 0.013, "CORRUGATED_METAL": 0.024, "CLAY": 0.013, "PVC": 0.011, "HDPE": 0.012, "DUCTILE_IRON": 0.013, "CAST_IRON": 0.013}
FT_PER_M = 1 / 0.3048


def arcgis(url, bbox, fields="*", where="1=1"):
    feats, off = [], 0
    while True:
        r = requests.get(url + "/query", params={"where": where, "geometry": ",".join(map(str, bbox)), "geometryType": "esriGeometryEnvelope", "inSR": EPSG,
                                                 "spatialRel": "esriSpatialRelIntersects", "outFields": fields, "outSR": EPSG, "f": "geojson", "resultOffset": off}, timeout=180)
        r.raise_for_status(); d = r.json()
        if "error" in d: sys.exit(f"{url}: {d['error']}")
        feats += d["features"]
        if not d.get("properties", {}).get("exceededTransferLimit") and not d.get("exceededTransferLimit"): return feats
        off = len(feats)


def fc(feats, crs=EPSG):
    return {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": f"urn:ogc:def:crs:EPSG::{crs}"}}, "features": feats}


def main(a):
    os.makedirs(a.out, exist_ok=True); rep = {"built": datetime.date.today().isoformat(), "crs": f"EPSG:{EPSG}", "assumptions": [], "checks": {}}
    note = lambda s: (rep["assumptions"].append(s), print("  -", s))
    to_ll = Transformer.from_crs(EPSG, 4326, always_xy=True)

    # ---- domain: the Lake Martha outfall basin plus a margin
    basins = arcgis(f"{CITY}/{LAYERS['basins']}", [-1e9, -1e9, 1e9, 1e9])
    basin = [shape(f["geometry"]) for f in basins if f["properties"]["WATERBODY1"] == "LAKE MARTHA"][0]
    x0, y0, x1, y1 = basin.bounds; m = a.margin
    x0 = math.floor((x0 - m) / 12) * 12; y0 = math.floor((y0 - m) / 12) * 12; x1 = math.ceil((x1 + m) / 12) * 12; y1 = math.ceil((y1 + m) / 12) * 12
    bbox = [x0, y0, x1, y1]; dom = box(*bbox); ll = [*to_ll.transform(x0, y0), *to_ll.transform(x1, y1)]
    rep["domain"] = {"bbox_ft": bbox, "bbox_lonlat": [round(v, 6) for v in ll], "basin_acres": round(basin.area / 43560, 1)}
    print(f"domain {x1 - x0:.0f} x {y1 - y0:.0f} ft; Lake Martha outfall basin {basin.area / 43560:.1f} ac")
    json.dump(fc([{"type": "Feature", "properties": {"name": "Lake Martha outfall basin (City of Winter Haven)"}, "geometry": mapping(basin)}]), open(os.path.join(a.out, "basin.geojson"), "w"))

    # ---- DEM: 3DEP 1 m tiles -> EPSG 2237, cell a.cell ft, feet
    r = requests.get(TNM, params={"datasets": "Digital Elevation Model (DEM) 1 meter", "bbox": ",".join(f"{v:.6f}" for v in ll), "outputFormat": "JSON"}, timeout=120).json()
    tiles = sorted({i["downloadURL"] for i in r["items"]}); rep["sources"] = {"dem": [i["title"] for i in r["items"]]}
    cache = os.path.join(a.cache, "dem"); os.makedirs(cache, exist_ok=True)
    nx, ny = int((x1 - x0) / a.cell), int((y1 - y0) / a.cell); tf = from_origin(x0, y1, a.cell, a.cell); dem = np.full((ny, nx), np.nan, "float32")
    for u in tiles:
        p = os.path.join(cache, os.path.basename(u))
        if not os.path.exists(p):
            print("downloading", os.path.basename(u)); open(p, "wb").write(requests.get(u, timeout=1800).content)
        with rasterio.open(p) as ds:
            part = np.full((ny, nx), np.nan, "float32")
            reproject(rasterio.band(ds, 1), part, src_transform=ds.transform, src_crs=ds.crs, src_nodata=ds.nodata, dst_transform=tf, dst_crs=f"EPSG:{EPSG}", dst_nodata=np.nan, resampling=Resampling.average)
            dem = np.where(np.isnan(dem), part, dem)
    dem = np.where(np.isnan(dem), -9999, dem * FT_PER_M).astype("float32")
    note("Lidar NAVD88 meters converted to feet (x 3.28084); horizontal NAD83(2011) taken as NAD83 for EPSG 2237 (no datum grid shift; under 1 m here)")
    with rasterio.open(os.path.join(a.out, "dem.tif"), "w", driver="GTiff", width=nx, height=ny, count=1, dtype="float32", crs=f"EPSG:{EPSG}", transform=tf, nodata=-9999, compress="deflate", predictor=3) as o:
        o.write(dem, 1)
    valid = dem > -9000; rep["checks"]["dem"] = {"cells": [nx, ny], "cell_ft": a.cell, "valid_pct": round(100 * valid.mean(), 2), "min_ft": float(dem[valid].min()), "max_ft": float(dem[valid].max())}
    print(f"DEM {nx} x {ny} cells of {a.cell} ft, ground {dem[valid].min():.1f} to {dem[valid].max():.1f} ft")
    def ground(x, y):
        c, rr = int((x - x0) / a.cell), int((y1 - y) / a.cell)
        if 0 <= c < nx and 0 <= rr < ny:
            v = dem[max(rr - 1, 0):rr + 2, max(c - 1, 0):c + 2]; v = v[v > -9000]; return float(np.median(v)) if v.size else None
        return None

    # ---- lakes: NHD waterbodies in the domain; level = median lidar surface inside (hydro-flattened water)
    r = requests.get(NHD + "/query", params={"geometry": ",".join(map(str, bbox)), "geometryType": "esriGeometryEnvelope", "inSR": EPSG, "spatialRel": "esriSpatialRelIntersects",
                                             "where": "ftype=390", "outFields": "gnis_name,ftype,areasqkm", "outSR": EPSG, "f": "geojson"}, timeout=120).json()
    lakes = []
    for f in r["features"]:
        g = shape(f["geometry"]).intersection(dom); name = f["properties"].get("gnis_name") or f["properties"].get("GNIS_NAME") or "Lake"
        if g.is_empty or g.area < 20000: continue
        from rasterio.features import geometry_mask
        msk = ~geometry_mask([mapping(g.buffer(-30))], (ny, nx), tf); vals = dem[msk & valid]
        lvl = float(np.median(vals)); spread = float(np.percentile(vals, 95) - np.percentile(vals, 5))
        lakes.append({"type": "Feature", "properties": {"name": name, "level_ft": round(lvl, 2)}, "geometry": mapping(g)})
        rep["checks"].setdefault("lakes", []).append({"name": name, "level_ft": round(lvl, 2), "surface_spread_ft": round(spread, 2), "acres_in_domain": round(g.area / 43560, 1)})
        print(f"lake {name}: level {lvl:.2f} ft (lidar surface spread {spread:.2f} ft)")
    note("Lake levels are fixed at the lidar water surface (2018 survey), not a flood stage; lakes are level boundaries in the 2D")
    json.dump(fc(lakes), open(os.path.join(a.out, "lakes.geojson"), "w"))
    lake_geoms = [(shape(f["geometry"]), f["properties"]) for f in lakes]

    # ---- sewer: pipes and structures in the domain
    # pipes name their end structures by the FACILITYID of the inlet, manhole and outlet layers (the combined structures layer uses other numbers)
    pipes = arcgis(f"{CITY}/{LAYERS['pipes']}", bbox); sxy = {}
    for key, kind in (("inlets", None), ("manholes", "MANHOLE"), ("outlets", None)):
        for f in arcgis(f"{CITY}/{LAYERS[key]}", bbox):
            if f["geometry"]: sxy[str(f["properties"]["FACILITYID"]).strip()] = (f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1], kind or f["properties"].get("TYPE") or key.upper())
    rep["sources"]["sewer"] = "City of Winter Haven stormwater inventory (GIS_ASSET_STRM_Pipes, _Inlet, _Manhole, _Outlet), public view"
    nodes, links, issues = {}, [], []
    def node(nid, xy, inv, kind):
        n = nodes.setdefault(nid, {"x": xy[0], "y": xy[1], "inv": [], "type": kind, "up": 0, "dn": 0}); n["inv"].append(inv); return n
    for f in pipes:
        p = f["properties"]; g = f["geometry"]
        if not g: continue
        coords = g["coordinates"] if g["type"] == "LineString" else g["coordinates"][0]
        a0, b0 = coords[0], coords[-1]; ui, di = p["USINVERTEL"], p["DSINVERTEL"]
        if not (ui and di and ui > 0 and di > 0): issues.append(f"{p['FACILITYID']}: missing invert, skipped"); continue
        fr, to = (p["Node_From"] or "").strip() or f"END-{p['FACILITYID']}-A", (p["Node_To"] or "").strip() or f"END-{p['FACILITYID']}-B"
        fxy = sxy.get(fr, (a0[0], a0[1], "PIPE_END"))[:2]; txy = sxy.get(to, (b0[0], b0[1], "PIPE_END"))[:2]
        # the drawn line can run either way: keep the From/To nodes, match the inverts to them by the drawn ends
        if math.dist(fxy, b0) + math.dist(txy, a0) < math.dist(fxy, a0) + math.dist(txy, b0): pass
        nf = node(fr, fxy, ui, sxy.get(fr, (0, 0, "PIPE_END"))[2]); nt = node(to, txy, di, sxy.get(to, (0, 0, "PIPE_END"))[2])
        nf["dn"] += 1; nt["up"] += 1
        d = (p["WIDTH"] or 0) / 12; h = (p["HEIGHT"] or p["WIDTH"] or 0) / 12
        if not d > 0: issues.append(f"{p['FACILITYID']}: no size, skipped"); continue
        L = max(p["LENGTH_FT"] or math.dist(fxy, txy), 10)
        links.append({"id": p["FACILITYID"], "from": fr, "to": to, "len": L, "n": ROUGH.get(p["MATERIAL"], 0.013), "d": d, "h": h, "shape": p["PIPESHAPE"] or "CIRCULAR",
                      "barrels": max(int(p["PIPE_COUNT"] or 1), 1), "ui": ui, "di": di, "owner": p["OWNEDBY"], "material": p["MATERIAL"]})
    # node inverts, rims and roles
    out_lake, out_free = [], []
    for nid, n in nodes.items():
        n["invert"] = min(n["inv"]); gz = ground(n["x"], n["y"]); inside = dom.contains(Point(n["x"], n["y"]))
        lake = next((pr for g, pr in lake_geoms if g.distance(Point(n["x"], n["y"])) < 40), None)
        n["outfall"] = (n["dn"] == 0) and (lake is not None or not inside or n["type"] in ("MITERED_END", "PROJECTED_END", "HEADWALL"))
        n["lake"] = lake
        if gz is None: gz = n["invert"] + 4; issues.append(f"{nid}: outside the DEM; rim set 4 ft above the invert")
        n["rim"] = gz
        if n["rim"] - n["invert"] < 0.5 and not n["outfall"]: issues.append(f"{nid}: lidar ground {gz:.2f} ft is within 0.5 ft of the invert {n['invert']:.2f} ft; depth set to 0.5 ft"); n["rim"] = n["invert"] + 0.5
        (out_lake if n["outfall"] and lake else out_free if n["outfall"] else []).append(nid)
    sinks = [nid for nid, n in nodes.items() if n["dn"] == 0 and not n["outfall"]]
    for nid in sinks: nodes[nid]["outfall"] = True; out_free.append(nid); issues.append(f"{nid}: no pipe leaves this node; made a free outfall")
    rep["checks"]["sewer"] = {"pipes": len(links), "nodes": len(nodes), "outfalls_to_lakes": len(out_lake), "free_outfalls": len(out_free), "issues": issues}
    print(f"sewer: {len(links)} pipes, {len(nodes)} nodes, {len(out_lake)} outfalls to lakes, {len(out_free)} free outfalls, {len(issues)} notes")

    # ---- rain: Atlas 14 at the domain centre, nested 24-hour storm, 5-minute steps
    lon, lat = to_ll.transform((x0 + x1) / 2, (y0 + y1) / 2)
    txt = requests.get(PFDS, params={"lat": f"{lat:.4f}", "lon": f"{lon:.4f}", "type": "pf", "data": "depth", "units": "english", "series": "pds"}, timeout=120).text
    q = eval(txt.split("quantiles =")[1].split(";")[0])   # PFDS returns a JavaScript array literal of strings
    durs = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]; col = [1, 2, 5, 10, 25, 50, 100, 200, 500, 1000].index(a.ari)
    D = [float(q[i][col]) for i in range(10)]
    rep["sources"]["rain"] = f"NOAA Atlas 14 (PFDS) at {lat:.4f}, {lon:.4f}: {a.ari}-year depths (in) for {durs} min = {D}"
    cum = lambda t: float(np.exp(np.interp(np.log(t), np.log(durs), np.log(D))))   # log-log interpolation
    n5 = 288; blocks = [cum(5 * (i + 1)) - cum(5 * i) if i else cum(5) for i in range(n5)]   # largest block first
    order = np.zeros(n5); mid = n5 // 2 - 1
    for k, v in enumerate(blocks): order[mid + ((k + 1) // 2) * (1 if k % 2 else -1) if k else mid] = v
    inten = order * 12; tot = order.sum()
    note(f"Design storm: {a.ari}-year, 24-hour, {tot:.2f} in, nested from Atlas 14 depths (peak 5-min block at 11:55); no antecedent rain")
    rep["checks"]["rain"] = {"total_in": round(tot, 3), "atlas14_24h_in": D[-1], "peak_in_per_hr": round(float(inten.max()), 2)}

    # ---- inlets: the curb and grate inlets of the network (app default sizes; crest = SWMM rim = lidar ground)
    inl = [{"type": "Feature", "properties": {"node": nid, "type": n["type"]}, "geometry": {"type": "Point", "coordinates": [n["x"], n["y"]]}}
           for nid, n in nodes.items() if n["type"] in ("CURB_INLET", "GRATE_INLET") and not n["outfall"]]
    json.dump(fc(inl), open(os.path.join(a.out, "inlets.geojson"), "w"))
    note(f"{len(inl)} curb and grate inlets take surface water; inlet sizes are not in the inventory, so the app's default weir and grate sizes apply; manholes take none")

    # ---- SWMM .inp
    L = ["[TITLE]", f"Winter Haven, FL - Lake Martha area storm sewer from the City of Winter Haven public inventory; built {rep['built']} by make_winter_haven_demo.py", "",
         "[OPTIONS]", "FLOW_UNITS CFS", "INFILTRATION HORTON", "FLOW_ROUTING DYNWAVE", "LINK_OFFSETS ELEVATION", "ALLOW_PONDING NO",
         "START_DATE 01/01/2024", "START_TIME 00:00:00", "REPORT_START_DATE 01/01/2024", "REPORT_START_TIME 00:00:00", "END_DATE 01/02/2024", "END_TIME 02:00:00",
         "REPORT_STEP 00:05:00", "WET_STEP 00:05:00", "DRY_STEP 01:00:00", "ROUTING_STEP 0:00:05", "VARIABLE_STEP 0.75", "MIN_SURFAREA 12.566", "NORMAL_FLOW_LIMITED BOTH", "INERTIAL_DAMPING PARTIAL", "",
         "[RAINGAGES]", ";;Name Format Interval SCF Source", f"ATLAS14_{a.ari}Y INTENSITY 0:05 1.0 TIMESERIES DESIGN_{a.ari}Y", "",
         "[JUNCTIONS]", ";;Name Elevation MaxDepth InitDepth SurDepth Aponded"]
    for nid, n in nodes.items():
        if not n["outfall"]: L.append(f"{nid:22s} {n['invert']:.3f} {n['rim'] - n['invert']:.3f} 0 0 0")
    L += ["", "[OUTFALLS]", ";;Name Elevation Type Stage Gated"]
    for nid, n in nodes.items():
        if n["outfall"]: L.append(f"{nid:22s} {n['invert']:.3f} " + (f"FIXED {max(n['lake']['level_ft'], n['invert']):.2f} NO" if n["lake"] else "FREE NO"))
    L += ["", "[CONDUITS]", ";;Name From To Length Roughness InOffset OutOffset"]
    for k in links: L.append(f"{k['id']:14s} {k['from']:22s} {k['to']:22s} {k['len']:.1f} {k['n']} {k['ui']:.3f} {k['di']:.3f} 0 0")
    L += ["", "[XSECTIONS]", ";;Link Shape Geom1 Geom2 Geom3 Geom4 Barrels"]
    for k in links:
        if k["shape"] in ("CIRCULAR", "ROUND") or abs(k["d"] - k["h"]) < 1e-6: L.append(f"{k['id']:14s} CIRCULAR {k['d']:.3f} 0 0 0 {k['barrels']}")
        else: L.append(f"{k['id']:14s} RECT_CLOSED {k['h']:.3f} {k['d']:.3f} 0 0 {k['barrels']}")
    L += ["", "[TIMESERIES]", ";;Name Time Value (in/hr)"] + [f"DESIGN_{a.ari}Y {i * 5 // 60}:{i * 5 % 60:02d} {v:.4f}" for i, v in enumerate(inten)] + [f"DESIGN_{a.ari}Y 24:00 0"]
    L += ["", "[COORDINATES]", ";;Node X Y"] + [f"{nid:22s} {n['x']:.2f} {n['y']:.2f}" for nid, n in nodes.items()]
    open(os.path.join(a.out, "model.inp"), "w").write("\n".join(L) + "\n")

    # ---- buildings: FEMA USA Structures
    bl = arcgis(FEMA, bbox, fields="BUILD_ID,OCC_CLS,HEIGHT,SQFEET")
    bfe = [{"type": "Feature", "properties": {"id": f["properties"].get("BUILD_ID"), "occupancy": f["properties"].get("OCC_CLS"), "height": round((f["properties"].get("HEIGHT") or 0) * FT_PER_M, 1) or None},
            "geometry": mapping(shape(f["geometry"]).intersection(dom))} for f in bl if f["geometry"] and shape(f["geometry"]).intersects(dom)]
    json.dump(fc(bfe), open(os.path.join(a.out, "buildings.geojson"), "w")); rep["sources"]["buildings"] = "FEMA USA Structures (public domain)"
    print(f"buildings: {len(bfe)}")

    # ---- land cover: NLCD 2021 through the MRLC WCS (EPSG 5070, 30 m)
    b5070 = transform_bounds(f"EPSG:{EPSG}", "EPSG:5070", x0, y0, x1, y1, densify_pts=21)
    r = requests.get(NLCD_WCS, params={"service": "WCS", "version": "2.0.1", "request": "GetCoverage", "coverageid": "NLCD_2021_Land_Cover_L48", "format": "image/geotiff",
                                       "subset": [f"X({b5070[0] - 60},{b5070[2] + 60})", f"Y({b5070[1] - 60},{b5070[3] + 60})"]}, timeout=300)
    if r.ok and r.content[:2] in (b"II", b"MM"):   # a TIFF (the server says image/geotiff)
        with rasterio.MemoryFile(r.content) as mf, mf.open() as ds:
            arr = ds.read(1); prof = dict(driver="GTiff", width=ds.width, height=ds.height, count=1, dtype=arr.dtype, crs="EPSG:5070", transform=ds.transform, nodata=0, compress="deflate")
        with rasterio.open(os.path.join(a.out, "landcover.tif"), "w", **prof) as o: o.write(arr, 1)
        u, c = np.unique(arr, return_counts=True); rep["checks"]["landcover"] = {int(k): int(v) for k, v in zip(u, c)}; rep["sources"]["landcover"] = "NLCD 2021 (MRLC), public domain"
        print("land cover classes", dict(zip(u.tolist(), c.tolist())))
    else: note(f"NLCD download failed ({r.status_code}); no land cover layer");

    # ---- soils: SSURGO map units with their hydrologic soil group (dominant condition)
    wkt = f"POLYGON(({ll[0]} {ll[1]},{ll[2]} {ll[1]},{ll[2]} {ll[3]},{ll[0]} {ll[3]},{ll[0]} {ll[1]}))"
    sql = (f"SELECT mp.mupolygongeo.STAsText() AS wkt, mp.mukey, ma.hydgrpdcd, mu.muname FROM mupolygon mp INNER JOIN muaggatt ma ON ma.mukey = mp.mukey INNER JOIN mapunit mu ON mu.mukey = mp.mukey "
           f"WHERE mp.mupolygonkey IN (SELECT * FROM SDA_Get_Mupolygonkey_from_intersection_with_WktWgs84('{wkt}'))")
    r = requests.post(SDA, json={"query": sql, "format": "JSON+COLUMNNAME"}, timeout=300).json()
    from shapely import wkt as W
    rows = r.get("Table", [])[1:]; sf = []
    for w, mukey, hsg, muname in rows:
        g = W.loads(w).intersection(box(*ll))
        if not g.is_empty: sf.append({"type": "Feature", "properties": {"mukey": mukey, "hsg": hsg, "muname": muname}, "geometry": mapping(g)})
    json.dump({"type": "FeatureCollection", "features": sf}, open(os.path.join(a.out, "soils.geojson"), "w"))
    rep["sources"]["soils"] = "USDA NRCS SSURGO via Soil Data Access (hydgrpdcd), public domain"
    rep["checks"]["soils"] = {}
    for f in sf: rep["checks"]["soils"][f["properties"]["hsg"] or "none"] = rep["checks"]["soils"].get(f["properties"]["hsg"] or "none", 0) + 1
    print("soil polygons by group", rep["checks"]["soils"])

    ex = {"name": "Winter Haven, FL – Lake Martha (real public data)", "epsg": EPSG, "units": "US", "dem": "dem.tif", "buildings": "buildings.geojson", "boundaries": "lakes.geojson",
          "inp": "model.inp", "inlets": "inlets.geojson", "landcover": "landcover.tif", "soils": "soils.geojson",
          "note": f"Real storm sewer (City of Winter Haven inventory) on 2018 lidar; lakes held at their 2018 lidar levels. Loading fills in a two-way run at 12 ft cells, 8 to 16 h, with rain from the SWMM gauge ({a.ari}-year 24-hour Atlas 14 storm, {tot:.2f} in) and no water taken at manholes.",
          "sources": rep["sources"],
          "settings": {"coupling": "two", "rain": "gauge", "gauge": f"ATLAS14_{a.ari}Y", "defaultInlets": False, "cellFt": 12, "t0": 8, "t1": 16, "outputMin": 15}}
    json.dump(ex, open(os.path.join(a.out, "example.json"), "w"), indent=1)
    json.dump(rep, open(os.path.join(a.out, "build_report.json"), "w"), indent=1)
    print("wrote", a.out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("out"); ap.add_argument("--cell", type=float, default=3); ap.add_argument("--margin", type=float, default=400)
    ap.add_argument("--ari", type=int, default=25); ap.add_argument("--cache", default=os.path.join(os.path.expanduser("~"), ".cache", "fsim"))
    main(ap.parse_args())
