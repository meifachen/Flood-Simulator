#!/usr/bin/env python3
"""Curb inlets for the synthetic example: two inlets per junction, 30 ft either side of the manhole on opposite gutters,
4 ft weir and 2 sq ft opening each. Writes <example>/inlets.geojson and adds it to example.json.

    python python/make_inlets_example.py examples/synthetic_us
"""
import json, os, sys


def main(d):
    meta = json.load(open(os.path.join(d, "example.json")))
    inp = open(os.path.join(d, meta["inp"])).read()
    sec = inp.split("[COORDINATES]")[1].split("[")[0]
    co = {l.split()[0]: (float(l.split()[1]), float(l.split()[2])) for l in sec.strip().splitlines() if l.strip() and not l.startswith(";")}
    feats = []
    for n, (x, y) in co.items():
        if not n.startswith("J"): continue
        for dx, dy in ((-30, 14), (30, -14)):
            feats.append({"type": "Feature", "properties": {"node": n, "weir_length_ft": 4, "orifice_area_sqft": 2.0, "cw": 3.0, "co": 0.6},
                          "geometry": {"type": "Point", "coordinates": [round(x + dx, 2), round(y + dy, 2)]}})
    json.dump({"type": "FeatureCollection", "name": "inlets", "crs": {"type": "name", "properties": {"name": f"urn:ogc:def:crs:EPSG::{meta['epsg']}"}}, "features": feats},
              open(os.path.join(d, "inlets.geojson"), "w"))
    meta["inlets"] = "inlets.geojson"; json.dump(meta, open(os.path.join(d, "example.json"), "w"), indent=1)
    print("wrote", len(feats), "inlets")


if __name__ == "__main__":
    main(sys.argv[1])
