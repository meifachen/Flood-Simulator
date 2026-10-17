#!/usr/bin/env python3
"""Build the synthetic example: a DEM (GeoTIFF), building footprints and a pond outline (GeoJSON), and a SWMM5 model
of a street sewer that floods at a sag, draining to a pond (storage) and a creek outfall. The model is then run with
the EPA SWMM 5.2 engine (swmm-toolkit) to produce the .out and .rpt files.

    python python/make_synthetic.py examples/synthetic_us            # US units (ft, CFS), EPSG:2236
    python python/make_synthetic.py examples/synthetic_si --si       # SI units (m, CMS), EPSG:26917

The place is invented: the coordinates sit in a real projected CRS only so the files carry a valid georeference.
"""
import argparse, json, math, os
import numpy as np
import rasterio
from rasterio.transform import from_origin

FT = 0.3048


def terrain(nx, ny, d):
    """Ground in ft on a d-ft grid; row 0 is north. A street runs west to east along y = 800 ft with a sag at x = 1050 ft."""
    x = (np.arange(nx) + 0.5) * d
    y = (np.arange(ny) + 0.5) * d  # distance from the north edge
    X, Y = np.meshgrid(x, y)
    yc = 800.0
    base = 62.0 - 0.004 * X                      # 0.4% fall to the east
    side = 0.02 * np.abs(Y - yc)                  # 2% rise away from the street
    sag = -2.2 * np.exp(-(((X - 1050) / 160) ** 2) - (((Y - yc) / 120) ** 2))   # street sag that ponds
    crown = np.where(np.abs(Y - yc) < 15, 0.25, 0.0) * (1 - np.abs(Y - yc) / 15)  # street crown
    z = base + side + sag + crown
    # pond in the south-east, 5 ft deep below the surrounding ground
    pond = np.exp(-(((X - 2050) / 120) ** 2) - (((Y - 1150) / 90) ** 2))
    z = z - 7.0 * pond
    # creek along the east edge, flowing south
    creek = np.exp(-(((X - 2340) / 25) ** 2))
    z = z - 4.0 * creek
    return z.astype(np.float32)


def buildings(d, nx, ny):
    """Rows of houses (40 x 50 ft) on both sides of the street, set back 60 ft from the centreline."""
    feats, i = [], 0
    for side in (-1, 1):
        for x0 in np.arange(120, 1900, 110):
            if 980 < x0 < 1120:   # leave the sag open
                continue
            y0 = 800 + side * 60 if side > 0 else 800 - 60 - 50
            feats.append(((x0, y0), (x0 + 40, y0 + 50), i)); i += 1
    return feats


def write(args):
    us = not args.si
    out = args.out; os.makedirs(out, exist_ok=True)
    d = 6.0                                             # ft grid of the synthetic DEM
    nx, ny = 400, 267
    z = terrain(nx, ny, d)
    if us:
        epsg, x0, y1, unit = 2236, 500000.0, 1600000.0, 1.0   # NAD83 / Florida East (ftUS)
    else:
        epsg, x0, y1, unit = 26917, 460000.0, 3170000.0, FT  # NAD83 / UTM 17N (m)
    cell = d * unit
    tf = from_origin(x0, y1, cell, cell)
    zz = (z * unit).astype(np.float32)
    # a nodata strip on the west edge to exercise NoData handling
    zz[:, :2] = -9999.0
    prof = dict(driver="GTiff", width=nx, height=ny, count=1, dtype="float32", crs=f"EPSG:{epsg}", transform=tf, nodata=-9999.0,
                compress="deflate", tiled=False)
    with rasterio.open(os.path.join(out, "dem.tif"), "w", **prof) as ds:
        ds.write(zz, 1)
        ds.update_tags(1, UNITTYPE="ft" if us else "m")
        ds.set_band_description(1, "ground elevation " + ("ft" if us else "m"))

    def P(xf, yf):   # local ft (x east, y from the north edge) -> CRS coordinates
        return [round(x0 + xf * unit, 3), round(y1 - yf * unit, 3)]

    feats = [{"type": "Feature", "properties": {"id": i}, "geometry": {"type": "Polygon", "coordinates": [[P(a[0], a[1]), P(b[0], a[1]), P(b[0], b[1]), P(a[0], b[1]), P(a[0], a[1])]]}}
             for a, b, i in buildings(d, nx, ny)]
    json.dump({"type": "FeatureCollection", "name": "buildings", "crs": {"type": "name", "properties": {"name": f"urn:ogc:def:crs:EPSG::{epsg}"}}, "features": feats},
              open(os.path.join(out, "buildings.geojson"), "w"))
    ring = [P(2050 + 150 * math.cos(t), 1150 + 110 * math.sin(t)) for t in np.linspace(0, 2 * math.pi, 37)]
    json.dump({"type": "FeatureCollection", "name": "pond", "crs": {"type": "name", "properties": {"name": f"urn:ogc:def:crs:EPSG::{epsg}"}},
               "features": [{"type": "Feature", "properties": {"node": "POND"}, "geometry": {"type": "Polygon", "coordinates": [ring]}}]},
              open(os.path.join(out, "pond.geojson"), "w"))

    # ---------------- SWMM model (US numbers, converted for SI)
    def ground(xf, yf):
        c = min(max(int(xf / d), 0), nx - 1); r = min(max(int(yf / d), 0), ny - 1); return float(z[r, c])

    jx = [150, 450, 750, 1050, 1350, 1650, 1950]
    J = []
    for i, xf in enumerate(jx):
        g = ground(xf, 800)
        J.append(dict(name=f"J{i + 1}", x=xf, y=800, rim=g, inv=g - 7.0))
    # keep the trunk falling downstream at least 0.3%
    for i in range(1, len(J)):
        J[i]["inv"] = min(J[i]["inv"], J[i - 1]["inv"] - 0.003 * 300)
    pond_bottom = ground(2050, 1150)
    pond_top = pond_bottom + 6.0
    of_inv = ground(2340, 1300)
    L = lambda v: v * unit
    Q = (lambda v: v) if us else (lambda v: v * 0.0283168)
    lines = []
    w = lines.append
    w("[TITLE]\nSynthetic street sewer that floods at a sag (invented place)\n")
    w("[OPTIONS]")
    w(f"FLOW_UNITS           {'CFS' if us else 'CMS'}")
    for k, v in [("INFILTRATION", "GREEN_AMPT"), ("FLOW_ROUTING", "DYNWAVE"), ("LINK_OFFSETS", "ELEVATION"), ("MIN_SLOPE", "0"),
                 ("ALLOW_PONDING", "NO"), ("SKIP_STEADY_STATE", "NO"), ("START_DATE", "07/15/2024"), ("START_TIME", "00:00:00"),
                 ("REPORT_START_DATE", "07/15/2024"), ("REPORT_START_TIME", "00:00:00"), ("END_DATE", "07/15/2024"), ("END_TIME", "06:00:00"),
                 ("SWEEP_START", "01/01"), ("SWEEP_END", "12/31"), ("DRY_DAYS", "0"), ("REPORT_STEP", "00:05:00"), ("WET_STEP", "00:01:00"),
                 ("DRY_STEP", "01:00:00"), ("ROUTING_STEP", "0:00:05"), ("INERTIAL_DAMPING", "PARTIAL"), ("NORMAL_FLOW_LIMITED", "BOTH"),
                 ("FORCE_MAIN_EQUATION", "H-W"), ("VARIABLE_STEP", "0.75"), ("LENGTHENING_STEP", "0"), ("MIN_SURFAREA", "12.557"),
                 ("MAX_TRIALS", "8"), ("HEAD_TOLERANCE", "0.005"), ("SYS_FLOW_TOL", "5"), ("LAT_FLOW_TOL", "5"), ("THREADS", "1")]:
        w(f"{k:<20} {v}")
    w("\n[RAINGAGES]\n;;Name Format Interval SCF Source")
    w("RG1              INTENSITY 0:05     1.0      TIMESERIES DESIGN")
    w("\n[SUBCATCHMENTS]\n;;Name Raingage Outlet Area %Imperv Width %Slope CurbLen")
    subs = []
    for i, j in enumerate(J):
        for side, ys in (("N", 500), ("S", 1100)):
            name = f"S{i + 1}{side}"
            area_ac = 4.0
            subs.append((name, j, ys))
            w(f"{name:<16} RG1 {j['name']:<8} {area_ac * (1 if us else 0.404686):.4f} 55 {L(400):.2f} 2.0 0")
    w("\n[SUBAREAS]\n;;Subcatchment N-Imperv N-Perv S-Imperv S-Perv PctZero RouteTo")
    for s in subs:
        w(f"{s[0]:<16} 0.015 0.15 {0.06 if us else 1.52} {0.15 if us else 3.81} 25 OUTLET")
    w("\n[INFILTRATION]\n;;Subcatchment Suction Ksat IMD")
    for s in subs:
        w(f"{s[0]:<16} {3.5 if us else 88.9} {0.2 if us else 5.08} 0.3")
    w("\n[JUNCTIONS]\n;;Name Elevation MaxDepth InitDepth SurDepth Aponded")
    for j in J:
        w(f"{j['name']:<16} {L(j['inv']):.3f} {L(j['rim'] - j['inv']):.3f} 0 0 0")
    w("\n[OUTFALLS]\n;;Name Elevation Type Stage Gated")
    w(f"OF1              {L(of_inv):.3f} FREE NO")
    w("\n[STORAGE]\n;;Name Elev MaxDepth InitDepth Shape Curve/Params SurDepth Fevap")
    w(f"POND             {L(pond_bottom):.3f} {L(pond_top - pond_bottom):.3f} {L(1.0):.3f} FUNCTIONAL {L(L(30000)):.1f} 0 0 0 0")
    w("\n[CONDUITS]\n;;Name From To Length Roughness InOffset OutOffset InitFlow MaxFlow")
    dia = [1.5, 1.5, 1.5, 1.5, 2.0, 2.0]
    conds = []
    for i in range(len(J) - 1):
        conds.append((f"C{i + 1}", J[i]["name"], J[i + 1]["name"], 300.0, J[i]["inv"], J[i + 1]["inv"], dia[i]))
    conds.append(("C7", J[-1]["name"], "POND", math.hypot(2050 - 1950, 1150 - 800), J[-1]["inv"], max(pond_bottom, J[-1]["inv"] - 1.0), 2.0))
    for c in conds:
        w(f"{c[0]:<8} {c[1]:<8} {c[2]:<8} {L(c[3]):.2f} 0.013 {L(c[4]):.3f} {L(c[5]):.3f} 0 0")
    w("\n[ORIFICES]\n;;Name From To Type Offset Qcoeff Gated CloseTime")
    w(f"OR1      POND     OF1      SIDE     {L(max(pond_bottom + 1.0, of_inv + 0.01)):.3f} 0.65 NO 0")
    w("\n[XSECTIONS]\n;;Link Shape Geom1 Geom2 Geom3 Geom4 Barrels")
    for c in conds:
        w(f"{c[0]:<8} CIRCULAR {L(c[6]):.4f} 0 0 0 1")
    w(f"OR1      CIRCULAR {L(1.0):.4f} 0 0 0")
    w("\n[TIMESERIES]\n;;Name Date Time Value")
    # 2-hour design storm, 3.5 in, peaked at 50 min (alternating-block style), 5-minute intensities in in/hr (mm/hr for SI)
    blocks = [0.6, 0.8, 1.0, 1.3, 1.7, 2.3, 3.2, 4.8, 7.5, 9.0, 6.0, 4.0, 2.8, 2.1, 1.6, 1.3, 1.1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4]
    tot = sum(blocks) * 5 / 60
    blocks = [b * 3.5 / tot for b in blocks]
    for k, b in enumerate(blocks):
        w(f"DESIGN   {k * 5 // 60}:{k * 5 % 60:02d} {b if us else b * 25.4:.4f}")
    w(f"DESIGN   2:00 0")
    w("\n[REPORT]\nSUBCATCHMENTS ALL\nNODES ALL\nLINKS ALL\n")
    w("[MAP]\nUNITS " + ("Feet" if us else "Meters"))
    w("\n[COORDINATES]\n;;Node X Y")
    for j in J:
        xx, yy = P(j["x"], j["y"]); w(f"{j['name']:<16} {xx} {yy}")
    xx, yy = P(2050, 1150); w(f"POND             {xx} {yy}")
    xx, yy = P(2340, 1300); w(f"OF1              {xx} {yy}")
    w("\n[POLYGONS]\n;;Subcatchment X Y")
    for name, j, ys in subs:
        cx = j["x"]
        for (a, b) in [(cx - 150, ys - 200 if ys < 800 else ys - 250), (cx + 150, ys - 200 if ys < 800 else ys - 250), (cx + 150, ys + 250 if ys < 800 else ys + 200), (cx - 150, ys + 250 if ys < 800 else ys + 200)]:
            xx, yy = P(a, b); w(f"{name:<16} {xx} {yy}")
    inp = os.path.join(out, "model.inp")
    open(inp, "w").write("\n".join(lines) + "\n")
    from swmm.toolkit import solver
    solver.swmm_run(inp, os.path.join(out, "model.rpt"), os.path.join(out, "model.out"))
    meta = {"name": "Synthetic street sewer" + ("" if us else " (SI)"), "epsg": epsg, "units": "US" if us else "SI",
            "dem": "dem.tif", "buildings": "buildings.geojson", "boundaries": "pond.geojson", "inp": "model.inp", "out": "model.out",
            "note": "Invented place and model for testing. Georeferenced in a real CRS so the files are valid; turn the basemap off."}
    json.dump(meta, open(os.path.join(out, "example.json"), "w"), indent=1)
    print("wrote", out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("out"); ap.add_argument("--si", action="store_true"); write(ap.parse_args())
