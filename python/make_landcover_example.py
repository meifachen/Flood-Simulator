#!/usr/bin/env python3
"""Synthetic land cover (NLCD class codes, 30 m, EPSG:5070 Albers, so the app has to reproject) and hydrologic soil groups
(GeoJSON polygons with an "hsg" property) for an example folder. Invented, for testing the land cover and soils inputs.

    python python/make_landcover_example.py examples/synthetic_us
"""
import json, os, sys
import numpy as np, rasterio
from rasterio.transform import from_origin
from pyproj import Transformer


def main(d):
    meta = json.load(open(os.path.join(d, "example.json")))
    with rasterio.open(os.path.join(d, meta["dem"])) as ds:
        b = ds.bounds; src_crs = ds.crs
    tr = Transformer.from_crs(src_crs, "EPSG:5070", always_xy=True)
    xs, ys = tr.transform([b.left, b.right, b.left, b.right], [b.bottom, b.bottom, b.top, b.top])
    x0, y1 = min(xs) - 60, max(ys) + 60; x1, y0 = max(xs) + 60, min(ys) - 60
    res = 30.0; nx = int(np.ceil((x1 - x0) / res)); ny = int(np.ceil((y1 - y0) / res))
    X, Y = np.meshgrid(x0 + (np.arange(nx) + 0.5) * res, y1 - (np.arange(ny) + 0.5) * res)
    # bands of land cover across the street corridor, a wooded strip, and water at the pond
    inv = Transformer.from_crs("EPSG:5070", src_crs, always_xy=True)
    xl, yl = inv.transform(X, Y)
    fx = (xl - b.left) / (b.right - b.left); fy = (b.top - yl) / (b.top - b.bottom)
    lc = np.full((ny, nx), 21, "uint8")                      # developed, open space
    lc[(fy > 0.38) & (fy < 0.62)] = 23                        # medium intensity along the street
    lc[(fy > 0.45) & (fy < 0.55)] = 24                        # high intensity at the road itself
    lc[(fx < 0.25) & ((fy < 0.25) | (fy > 0.8))] = 41          # deciduous forest corners
    lc[(fx > 0.80) & (fy > 0.62)] = 90                        # woody wetland near the pond
    lc[(fx > 0.82) & (fx < 0.93) & (fy > 0.66) & (fy < 0.8)] = 11   # open water (the pond)
    lc[(fx > 0.40) & (fx < 0.55) & (fy < 0.2)] = 82           # cultivated crops patch
    prof = dict(driver="GTiff", width=nx, height=ny, count=1, dtype="uint8", crs="EPSG:5070", transform=from_origin(x0, y1, res, res), nodata=0)
    with rasterio.open(os.path.join(d, "landcover.tif"), "w", **prof) as o:
        o.write(lc, 1); o.set_band_description(1, "NLCD class (synthetic)")
    # soils: A in the west, B in the middle, C east, D around the pond (dual group B/D to test the mapping)
    W, E, S_, N_ = b.left, b.right, b.bottom, b.top
    def box(a, c, e, f): return [[[a, c], [e, c], [e, f], [a, f], [a, c]]]
    fx_ = lambda t: W + t * (E - W); fy_ = lambda t: N_ - t * (N_ - S_)
    feats = [
        {"type": "Feature", "properties": {"hsg": "A"}, "geometry": {"type": "Polygon", "coordinates": box(W - 50, S_ - 50, fx_(0.35), N_ + 50)}},
        {"type": "Feature", "properties": {"hsg": "B"}, "geometry": {"type": "Polygon", "coordinates": box(fx_(0.35), S_ - 50, fx_(0.65), N_ + 50)}},
        {"type": "Feature", "properties": {"hsg": "C"}, "geometry": {"type": "Polygon", "coordinates": box(fx_(0.65), fy_(0.55), E + 50, N_ + 50)}},
        {"type": "Feature", "properties": {"hsg": "B/D"}, "geometry": {"type": "Polygon", "coordinates": box(fx_(0.65), S_ - 50, E + 50, fy_(0.55))}},
    ]
    epsg = src_crs.to_epsg()
    json.dump({"type": "FeatureCollection", "name": "soils", "crs": {"type": "name", "properties": {"name": f"urn:ogc:def:crs:EPSG::{epsg}"}}, "features": feats},
              open(os.path.join(d, "soils.geojson"), "w"))
    meta["landcover"] = "landcover.tif"; meta["soils"] = "soils.geojson"
    json.dump(meta, open(os.path.join(d, "example.json"), "w"), indent=1)
    print("wrote", d, "landcover", nx, "x", ny, "classes", sorted(set(lc.ravel().tolist())))


if __name__ == "__main__":
    main(sys.argv[1])
