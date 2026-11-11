#!/usr/bin/env python3
"""Compare Flood Simulator peak depths at Winter Haven (Lake Martha) with the City's SAIP ICPR v4 inundation for the same design storm.

    python python/compare_icpr_winter_haven.py RUN_DIR [--ari 25] [--depth-in 3] [--out RUN_DIR/icpr_compare]

RUN_DIR holds runs saved by the site benchmark: <tag>.json (grid: x0, y1, cs, nx, ny), <tag>.hmax.f32 (peak depth, ft, row 0 at the top)
and <tag>.type.u8 (0 open ground, 1 building or no data, 2 lake). Every run in RUN_DIR is compared.

The City layer (SAIP Preliminary Results, Inundation_<ari>yr_24hr) marks where ICPR v4 gave at least 3 in of standing water. A cell is
wet in the Flood Simulator when its peak depth is at least --depth-in. Cells are compared only where both models say something:
open ground (not buildings, not lakes in either model) inside the SAIP model boundary.

Not like-for-like (written into the output):
  - rainfall: the Flood Simulator uses a nested (balanced) Atlas 14 storm; the SAIP distribution is not stated in the City's layer
    (Florida Modified or SCS Type II are usual in the region);
  - ground: 2018 3DEP lidar vs the City's 2017 SAIP DEM; vertical datum of the City's model not stated;
  - lakes: the Flood Simulator holds lakes at a fixed level (lidar or the City's SAIP WaterLevel), ICPR routes them;
  - the sewer: the City inventory with app-default inlet sizes vs the ICPR network.
"""
import argparse, glob, json, os, sys
import numpy as np, requests
from rasterio.features import rasterize
from rasterio.transform import from_origin
from shapely.geometry import shape, box, mapping
from shapely.ops import unary_union

EPSG = 2237
SAIP = "https://services.arcgis.com/hNKc1r3SBL6SVC6I/ArcGIS/rest/services/SAIP_Preliminary_Results_Map_WFL1/FeatureServer"
LAYER = {2.33: 9, 10: 10, 25: 11, 100: 12}
LAKES, BOUNDARY = 5, 20


def query(layer, bbox):
    feats, off = [], 0
    while True:
        r = requests.get(f"{SAIP}/{layer}/query", params={"where": "1=1", "geometry": ",".join(map(str, bbox)), "geometryType": "esriGeometryEnvelope", "inSR": EPSG,
                                                          "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "outSR": EPSG, "f": "geojson", "resultOffset": off}, timeout=180)
        r.raise_for_status(); d = r.json()
        if "error" in d: sys.exit(f"layer {layer}: {d['error']}")
        feats += d["features"]
        if not (d.get("properties", {}).get("exceededTransferLimit") or d.get("exceededTransferLimit")): return feats
        off = len(feats)


def main(a):
    runs = sorted(glob.glob(os.path.join(a.run_dir, "*.json")))
    runs = [r for r in runs if os.path.exists(r[:-5] + ".hmax.f32")]
    if not runs: sys.exit(f"no runs (*.json with .hmax.f32) in {a.run_dir}")
    out = a.out or os.path.join(a.run_dir, "icpr_compare"); os.makedirs(out, exist_ok=True)
    m0 = json.load(open(runs[0])); bbox = [m0["x0"], m0["y1"] - m0["ny"] * m0["cs"], m0["x0"] + m0["nx"] * m0["cs"], m0["y1"]]
    dom = box(*bbox)
    inun = [f for f in query(LAYER[a.ari], bbox) if f["geometry"]]
    lakes = [f for f in query(LAKES, bbox) if f["geometry"]]
    bnd = [f for f in query(BOUNDARY, bbox) if f["geometry"]]
    ig = unary_union([shape(f["geometry"]).buffer(0) for f in inun]).intersection(dom)
    lg = unary_union([shape(f["geometry"]).buffer(0) for f in lakes]).intersection(dom)
    bg = unary_union([shape(f["geometry"]).buffer(0) for f in bnd]).intersection(dom) if bnd else dom
    json.dump({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"layer": f"Inundation_{a.ari}yr_24hr"}, "geometry": mapping(ig)},
                                                         {"type": "Feature", "properties": {"layer": "LakePolygons"}, "geometry": mapping(lg)}]}, open(os.path.join(out, "saip_layers.geojson"), "w"))
    rows, note = [], {"icpr_layer": f"City of Winter Haven SAIP Preliminary Results, Inundation_{a.ari}yr_24hr (ICPR v4; at least 3 in of standing water)",
                      "flood_simulator_wet": f"peak depth >= {a.depth_in} in", "compared_cells": "open ground in both models, inside the SAIP model boundary, outside lakes of either model",
                      "not_like_for_like": ["rainfall: nested Atlas 14 storm here; SAIP distribution not stated in the City layer",
                                            "ground: 2018 3DEP lidar here; 2017 City SAIP DEM in ICPR; City vertical datum not stated",
                                            "lakes: fixed levels here; routed in ICPR", "inlets: app default sizes here (sizes not in the inventory)"],
                      "saip_inundation_ac_in_domain_total": round(ig.area / 43560, 2), "saip_model_boundary_ac_in_domain": round(bg.area / 43560, 2)}
    for r in runs:
        m = json.load(open(r)); tag = os.path.basename(r)[:-5]; nx, ny, cs = m["nx"], m["ny"], m["cs"]
        h = np.fromfile(r[:-5] + ".hmax.f32", dtype="<f4").reshape(ny, nx); t = np.fromfile(r[:-5] + ".type.u8", dtype=np.uint8).reshape(ny, nx)
        tf = from_origin(m["x0"], m["y1"], cs, cs)
        ras = lambda g: rasterize([(mapping(g), 1)], out_shape=(ny, nx), transform=tf, fill=0, dtype="uint8").astype(bool) if not g.is_empty else np.zeros((ny, nx), bool)
        I, LK, BD = ras(ig), ras(lg), ras(bg)
        mask = (t == 0) & ~LK & BD
        S = h >= a.depth_in / 12.0
        A = cs * cs / 43560
        both, miss, fa = int((mask & I & S).sum()), int((mask & I & ~S).sum()), int((mask & ~I & S).sum())
        nI, nS = both + miss, both + fa
        row = {"run": m.get("label", tag), "cell_ft": cs, "icpr_ac": round(nI * A, 2), "flood_sim_ac": round(nS * A, 2), "both_ac": round(both * A, 2),
               "icpr_only_ac": round(miss * A, 2), "flood_sim_only_ac": round(fa * A, 2),
               "hit_rate": round(both / nI, 3) if nI else None, "false_alarm_ratio": round(fa / nS, 3) if nS else None,
               "csi": round(both / (both + miss + fa), 3) if both + miss + fa else None, "area_ratio": round(nS / nI, 3) if nI else None,
               "compared_ac": round(int(mask.sum()) * A, 2)}
        # with one cell of tolerance: an ICPR cell counts as hit if the Flood Simulator is wet in it or a neighbor, and the reverse for false alarms
        def grow(x):
            y = x.copy(); y[1:] |= x[:-1]; y[:-1] |= x[1:]; y[:, 1:] |= x[:, :-1]; y[:, :-1] |= x[:, 1:]; return y
        hit1 = int((mask & I & grow(S & mask)).sum()); fa1 = int((mask & S & ~grow(I)).sum())
        row["hit_rate_within_1_cell"] = round(hit1 / nI, 3) if nI else None; row["false_alarm_ratio_beyond_1_cell"] = round(fa1 / nS, 3) if nS else None
        rows.append(row); print(json.dumps(row))
        # map: agree / ICPR only / Flood Simulator only
        try:
            import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
            from matplotlib.colors import ListedColormap
            img = np.full((ny, nx), 0, np.uint8); img[t == 1] = 1; img[(t == 2) | LK] = 2; img[~BD & (t == 0)] = 3
            img[mask & I & S] = 4; img[mask & I & ~S] = 5; img[mask & ~I & S] = 6
            cm = ListedColormap(["#f4f3ef", "#9a9890", "#c9d7e3", "#e7e5df", "#3b6e8f", "#d08a2c", "#7a4fa0"])
            fig, ax = plt.subplots(figsize=(8, 8 * ny / nx + 0.8), dpi=150)
            ax.imshow(img, cmap=cm, vmin=0, vmax=6, interpolation="nearest", extent=[m["x0"], m["x0"] + nx * cs, m["y1"] - ny * cs, m["y1"]])
            from matplotlib.patches import Patch
            ax.legend(handles=[Patch(color="#3b6e8f", label=f"both ({row['both_ac']} ac)"), Patch(color="#d08a2c", label=f"ICPR only ({row['icpr_only_ac']} ac)"),
                               Patch(color="#7a4fa0", label=f"Flood Simulator only ({row['flood_sim_only_ac']} ac)"), Patch(color="#9a9890", label="building"),
                               Patch(color="#c9d7e3", label="lake"), Patch(color="#e7e5df", label="outside SAIP model")], loc="lower left", fontsize=7, framealpha=0.9)
            ax.set_title(f"{m.get('label', tag)}: at least {a.depth_in:g} in, vs SAIP ICPR v4 {a.ari}-yr/24-hr\nhit rate {row['hit_rate']}, false alarm ratio {row['false_alarm_ratio']}, CSI {row['csi']}", fontsize=9)
            ax.set_xlabel("x, ft (EPSG 2237)", fontsize=8); ax.set_ylabel("y, ft", fontsize=8); ax.tick_params(labelsize=7)
            fig.tight_layout(); fig.savefig(os.path.join(out, f"{tag}_vs_icpr.png")); plt.close(fig)
        except ImportError:
            pass
    json.dump({"notes": note, "runs": rows}, open(os.path.join(out, "icpr_compare.json"), "w"), indent=1)
    with open(os.path.join(out, "icpr_compare.md"), "w") as f:
        f.write(f"# Flood Simulator vs City SAIP ICPR v4, {a.ari}-year 24-hour\n\nWet: ICPR at least 3 in; Flood Simulator peak depth at least {a.depth_in:g} in. "
                f"Compared on {note['compared_cells']}.\n\n| Run | Cell | ICPR ac | Flood Sim ac | Both ac | ICPR only ac | Flood Sim only ac | Hit rate | False alarm ratio | CSI | Area ratio | Hit rate within 1 cell | False alarms beyond 1 cell |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n")
        for r in rows: f.write(f"| {r['run']} | {r['cell_ft']:g} ft | {r['icpr_ac']} | {r['flood_sim_ac']} | {r['both_ac']} | {r['icpr_only_ac']} | {r['flood_sim_only_ac']} | {r['hit_rate']} | {r['false_alarm_ratio']} | {r['csi']} | {r['area_ratio']} | {r['hit_rate_within_1_cell']} | {r['false_alarm_ratio_beyond_1_cell']} |\n")
        f.write("\nNot like-for-like:\n\n" + "".join(f"- {s}\n" for s in note["not_like_for_like"]))
    print("wrote", out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("run_dir"); ap.add_argument("--ari", type=float, default=25); ap.add_argument("--depth-in", type=float, default=3); ap.add_argument("--out")
    a = ap.parse_args(); a.ari = int(a.ari) if a.ari == int(a.ari) else a.ari; main(a)
