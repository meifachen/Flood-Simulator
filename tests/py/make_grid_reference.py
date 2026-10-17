#!/usr/bin/env python3
"""Independent reference for the grid builder: rasterio block averages and cell-centre rasterization of buildings and
boundary polygons (rasterio.features.rasterize with all_touched=False uses the cell-centre rule).
Writes <example>/grid_reference.json for cell factors 1 and 2.

    python tests/py/make_grid_reference.py examples/synthetic_us
"""
import json, os, sys
import numpy as np, rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin


def main(d):
    meta = json.load(open(os.path.join(d, "example.json")))
    with rasterio.open(os.path.join(d, meta["dem"])) as ds:
        a = ds.read(1, masked=True).astype("float64"); tf = ds.transform; res = tf.a
        crs_units = ds.crs.linear_units
    blds = json.load(open(os.path.join(d, meta["buildings"])))["features"]
    pond = json.load(open(os.path.join(d, meta["boundaries"])))["features"]
    out = {"res": res, "units": crs_units, "factors": {}}
    for f in (1, 2):
        ny, nx = a.shape[0] // f, a.shape[1] // f
        blk = a[: ny * f, : nx * f].reshape(ny, f, nx, f)
        cnt = (~blk.mask).sum(axis=(1, 3)); s = blk.filled(0).sum(axis=(1, 3))
        nodata = cnt * 2 < f * f
        z = np.where(nodata, np.nan, s / np.maximum(cnt, 1))
        t2 = from_origin(tf.c, tf.f, res * f, res * f)
        b = rasterize([(ft["geometry"], 1) for ft in blds], out_shape=(ny, nx), transform=t2, all_touched=False, dtype="uint8")
        p = rasterize([(ft["geometry"], 1) for ft in pond], out_shape=(ny, nx), transform=t2, all_touched=False, dtype="uint8")
        out["factors"][str(f)] = {"nx": nx, "ny": ny, "nodata": int(nodata.sum()), "zmean": float(np.nanmean(z)), "zsample": [float(z[r, c]) for r, c in [(10, 10), (ny // 2, nx // 2), (ny - 5, nx - 5)]],
                                   "bldCells": [int(k) for k in np.flatnonzero((b == 1) & ~nodata)], "pondCells": [int(k) for k in np.flatnonzero((p == 1) & ~nodata)]}
    json.dump(out, open(os.path.join(d, "grid_reference.json"), "w"))
    print("wrote", os.path.join(d, "grid_reference.json"))


if __name__ == "__main__":
    main(sys.argv[1])
