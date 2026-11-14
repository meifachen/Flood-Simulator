#!/usr/bin/env python3
"""Prepare inputs for the Flood Simulator (runs on a PC or in Google Colab: pip install rasterio geopandas).

1. DEM: clip to a box, reproject to a projected CRS, resample to a cell size, write a Float32 GeoTIFF with NoData -9999.
2. Buildings (optional): any vector file geopandas reads, or Microsoft footprints (line-delimited GeoJSON, .gz ok);
   clipped to the box, reprojected to the DEM CRS, small sheds dropped, written as GeoJSON.
3. Check (optional): report SWMM nodes that fall outside the DEM.

    python python/prep_dem.py --dem lidar.tif --epsg 6438 --bounds 566170 1573780 568570 1576180 --cell 3 \
        --buildings footprints.geojsonl.gz --min-area 200 --inp model.inp --out site/
"""
import argparse, gzip, json, os, sys
import numpy as np, rasterio
from rasterio.warp import reproject, Resampling, calculate_default_transform, transform_bounds
from rasterio.transform import from_origin


def prep_dem(src, dst, epsg, bounds, cell, zfactor=1.0, zunits=None):
    with rasterio.open(src) as ds:
        dst_crs = rasterio.crs.CRS.from_epsg(epsg)
        if not dst_crs.is_projected: sys.exit("Choose a projected CRS (feet or meters), not a geographic one")
        xmin, ymin, xmax, ymax = bounds if bounds else transform_bounds(ds.crs, dst_crs, *ds.bounds)
        if cell is None:
            _, w, _ = calculate_default_transform(ds.crs, dst_crs, ds.width, ds.height, *ds.bounds)
            cell = (xmax - xmin) / w
        xmin = np.floor(xmin / cell) * cell; ymax = np.ceil(ymax / cell) * cell
        nx = int(np.ceil((xmax - xmin) / cell - 1e-6)); ny = int(np.ceil((ymax - ymin) / cell - 1e-6))
        if nx * ny > 40e6: sys.exit(f"{nx} x {ny} cells is too large for the browser app; use a larger cell or a smaller box")
        out = np.full((ny, nx), -9999.0, "float32"); tf = from_origin(xmin, ymax, cell, cell)
        reproject(rasterio.band(ds, 1), out, src_transform=ds.transform, src_crs=ds.crs, src_nodata=ds.nodata, dst_transform=tf, dst_crs=dst_crs,
                  dst_nodata=-9999.0, resampling=Resampling.average if cell > min(ds.res) * 1.5 else Resampling.bilinear)
        prof = dict(driver="GTiff", width=nx, height=ny, count=1, dtype="float32", crs=dst_crs, transform=tf, nodata=-9999.0, compress="deflate", predictor=3)
        if zfactor != 1: out = np.where(out == -9999.0, out, out * zfactor).astype("float32")
        with rasterio.open(dst, "w", **prof) as o:
            # the band's unit as GDAL stores it (role="unittype", which other GIS tools read) and the plain tag earlier versions wrote
            # (review 0.6.1 WRK6-9); the app reads either
            o.write(out, 1); o.update_tags(1, UNITTYPE=zunits or "")
            if zunits: o.set_band_unit(1, zunits)
    valid = (out != -9999).mean()
    print(f"DEM: {nx} x {ny} cells of {cell:g} {dst_crs.linear_units}, {100 * valid:.1f}% with data -> {dst}")
    return (xmin, ymax - ny * cell, xmin + nx * cell, ymax), dst_crs


def prep_buildings(src, dst, crs, bounds, min_area):
    import geopandas as gpd
    from shapely.geometry import box, shape
    B = box(*bounds)
    if src.endswith((".geojsonl", ".geojsonl.gz", ".csv.gz", ".jsonl", ".jsonl.gz")):
        ll = gpd.GeoSeries([B], crs=crs).to_crs(4326).total_bounds
        op = gzip.open if src.endswith(".gz") else open; geoms = []; skipped = 0
        with op(src, "rt") as fh:
            for line in fh:
                line = line.strip().rstrip(",")
                if not line.startswith("{"): continue
                g = json.loads(line)
                if "geometry" in g:   # a feature: a null geometry (allowed by GeoJSON) is skipped, not a crash (review 0.6.1 WRK6-12)
                    g = g["geometry"]
                    if not g: skipped += 1; continue
                geom = shape(g); bx = geom.bounds   # shape().bounds is right for every geometry type; coordinates[0] is not a ring for a MultiPolygon, whose prefilter box mixed x and y and could silently drop the footprint (review F-30)
                if bx[2] < ll[0] or bx[0] > ll[2] or bx[3] < ll[1] or bx[1] > ll[3]: continue
                geoms.append(geom)
        if skipped: print(f"buildings: {skipped} features with no geometry skipped")
        gdf = gpd.GeoDataFrame(geometry=geoms, crs=4326)
    else:
        gdf = gpd.read_file(src, bbox=tuple(gpd.GeoSeries([B], crs=crs).to_crs(gpd.read_file(src, rows=1).crs).total_bounds))
    gdf = gdf.to_crs(crs)
    gdf = gdf[gdf.intersects(B) & (gdf.area >= min_area)].reset_index(drop=True)
    gdf = gdf[gdf.geom_type.isin(["Polygon", "MultiPolygon"])]
    gdf[["geometry"]].to_file(dst, driver="GeoJSON")
    print(f"Buildings: {len(gdf)} footprints of {min_area:g} sq units or more -> {dst}")


def check_inp(inp, bounds):
    sec, xy = None, {}
    for line in open(inp):
        s = line.split(";")[0].strip()
        if not s: continue
        if s.startswith("["): sec = s.upper(); continue
        if sec == "[COORDINATES]":
            t = s.split(); xy[t[0]] = (float(t[1]), float(t[2]))
    out = [n for n, (x, y) in xy.items() if not (bounds[0] <= x <= bounds[2] and bounds[1] <= y <= bounds[3])]
    print(f"SWMM: {len(xy)} nodes with coordinates, {len(out)} outside the DEM" + (f": {', '.join(out[:10])}" if out else ""))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dem", required=True); ap.add_argument("--epsg", type=int, required=True)
    ap.add_argument("--bounds", type=float, nargs=4, metavar=("XMIN", "YMIN", "XMAX", "YMAX"), help="box in the target CRS")
    ap.add_argument("--cell", type=float, help="cell size in target CRS units (default: about the source resolution)")
    ap.add_argument("--buildings"); ap.add_argument("--min-area", type=float, default=200.0)
    ap.add_argument("--zfactor", type=float, default=1.0, help="multiply elevations, e.g. 3.28083333 for meters to US survey feet")
    ap.add_argument("--zunits", help="elevation units after --zfactor (ft or m), stored as the GDAL UNITTYPE tag, which the app reads as the vertical-unit hint")
    ap.add_argument("--inp"); ap.add_argument("--out", required=True)
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
    b, crs = prep_dem(a.dem, os.path.join(a.out, "dem.tif"), a.epsg, a.bounds, a.cell, a.zfactor, a.zunits)
    if a.buildings: prep_buildings(a.buildings, os.path.join(a.out, "buildings.geojson"), crs, b, a.min_area)
    if a.inp: check_inp(a.inp, b)
