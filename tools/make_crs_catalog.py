#!/usr/bin/env python3
"""Projected-CRS catalog for the browser: EPSG code -> proj4 string (from the PROJ database via pyproj).
Writes vendor/crs_catalog.json (code: [name, proj4]). Codes PROJ cannot express as proj4 are skipped and counted."""
import json, warnings
from pyproj import CRS
from pyproj.database import get_codes
warnings.filterwarnings("ignore")
cat, skipped = {}, 0
for code in sorted(get_codes("EPSG", "PROJECTED_CRS"), key=int):
    try:
        c = CRS.from_epsg(int(code))
        if c.is_deprecated:
            continue
        p = c.to_proj4()
        if not p or "+proj=" not in p:
            skipped += 1; continue
        cat[code] = [c.name, p.replace(" +type=crs", "")]
    except Exception:
        skipped += 1
json.dump({"source": "PROJ database via pyproj " + __import__("pyproj").__version__ + " (proj " + __import__("pyproj").proj_version_str + ")", "crs": cat},
          open("vendor/crs_catalog.json", "w"), separators=(",", ":"))
print(len(cat), "codes;", skipped, "skipped")
