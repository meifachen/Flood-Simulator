#!/usr/bin/env python3
"""Reference for land cover and soils sampling: the land-cover class and soil group at each grid cell centre
(cell size = 2 x the DEM resolution), using pyproj and rasterio. Writes <example>/landcover_reference.json.

    python tests/py/make_landcover_reference.py examples/synthetic_us
"""
import json, os, sys
import numpy as np, rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from pyproj import Transformer


def main(d):
    meta = json.load(open(os.path.join(d, "example.json")))
    with rasterio.open(os.path.join(d, meta["dem"])) as ds:
        tf = ds.transform; crs = ds.crs; nx, ny = ds.width // 2, ds.height // 2; cs = tf.a * 2
    xs = tf.c + (np.arange(nx) + 0.5) * cs; ys = tf.f - (np.arange(ny) + 0.5) * cs
    X, Y = np.meshgrid(xs, ys)
    with rasterio.open(os.path.join(d, meta["landcover"])) as lc:
        tr = Transformer.from_crs(crs, lc.crs, always_xy=True); lx, ly = tr.transform(X, Y)
        a = lc.read(1); t2 = lc.transform
        col = np.floor((lx - t2.c) / t2.a).astype(int); row = np.floor((ly - t2.f) / t2.e).astype(int)
        inside = (col >= 0) & (row >= 0) & (col < lc.width) & (row < lc.height)
        cls = np.full(X.shape, -1, int); cls[inside] = a[row[inside], col[inside]]
        cls[cls == (lc.nodata if lc.nodata is not None else -999)] = -1
    feats = json.load(open(os.path.join(d, meta["soils"])))["features"]
    code = {"A": 1, "B": 2, "C": 3, "D": 4}
    shp = [(f["geometry"], code[f["properties"]["hsg"].split("/")[-1]]) for f in feats]
    hsg = rasterize(shp, out_shape=(ny, nx), transform=from_origin(tf.c, tf.f, cs, cs), all_touched=False, dtype="uint8")
    json.dump({"nx": nx, "ny": ny, "landcover": cls.ravel().tolist(), "hsg": hsg.ravel().tolist()}, open(os.path.join(d, "landcover_reference.json"), "w"))
    print("wrote", os.path.join(d, "landcover_reference.json"), "classes", sorted(set(cls.ravel().tolist())))


if __name__ == "__main__":
    main(sys.argv[1])
