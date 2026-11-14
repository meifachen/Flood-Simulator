#!/usr/bin/env python3
"""Regenerate tests/fixtures/*.tif, the small DEMs test_model.js reads (vertical-unit hint, review 0.5.0 F-11 and 0.6.0 F-13).

    python tests/py/make_fixtures.py

All three come from the synthetic US DEM through python/prep_dem.py (--epsg 2236 --cell 120):
  dem_no_zunits.tif      no --zunits: no UNITTYPE tag
  dem_zunits_ft.tif      --zunits ft: UNITTYPE "ft"
  dem_zunits_survey.tif  the ft file with its unit (tag and GDAL band unit) rewritten to "ft_survey" (a spelling other tools write)
"""
import os, shutil, subprocess, sys, tempfile
import rasterio

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FX, DEM, PREP = os.path.join(ROOT, "tests", "fixtures"), os.path.join(ROOT, "examples", "synthetic_us", "dem.tif"), os.path.join(ROOT, "python", "prep_dem.py")
os.makedirs(FX, exist_ok=True)
with tempfile.TemporaryDirectory() as tmp:
    for name, extra in [("dem_no_zunits.tif", []), ("dem_zunits_ft.tif", ["--zunits", "ft"])]:
        out = os.path.join(tmp, name[:-4])
        subprocess.run([sys.executable, PREP, "--dem", DEM, "--epsg", "2236", "--cell", "120", "--out", out] + extra, check=True)
        shutil.copy(os.path.join(out, "dem.tif"), os.path.join(FX, name))
shutil.copy(os.path.join(FX, "dem_zunits_ft.tif"), os.path.join(FX, "dem_zunits_survey.tif"))
with rasterio.open(os.path.join(FX, "dem_zunits_survey.tif"), "r+") as ds:
    ds.update_tags(1, UNITTYPE="ft_survey"); ds.set_band_unit(1, "ft_survey")
print("wrote", ", ".join(sorted(f for f in os.listdir(FX) if f.endswith(".tif"))))
