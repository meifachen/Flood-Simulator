# STATUS: Flood Simulator

Updated 2026-10-17. Version 0.1.0 (one-way SWMM coupling).

## What works
- Offline single-file app `dist/FloodSimulator.html` (about 4.9 MB including three examples).
- Inputs:
  - DEM GeoTIFF in any projected CRS from the PROJ list (5,252 EPSG codes);
  - buildings and level-boundary GeoJSON (reprojected from lon/lat or another EPSG);
  - SWMM5 `.inp` and `.out`, in US or SI units.
- One-way coupling:
  - SWMM node flooding enters the 2D as point inflows;
  - storage and outfall heads drive level boundaries;
  - rain on the grid comes from a SWMM gauge (intensity, volume or cumulative) or is uniform.
- Engine on the CPU or WebGPU, with a water balance at every map.
- Results:
  - map with hillshade or basemap;
  - 3D view with buildings, water and SWMM nodes;
  - four charts and a water-balance table;
  - GeoTIFF, buildings CSV and SWMM inflow CSV exports.
- Python tools:
  - `prep_dem.py`: clip, reproject and resample, convert vertical units, buildings, SWMM node check;
  - example builders.

## Tested
- `tests/node/test_solver_core.js`, `test_solver_guards.js`: carried-over solver tests (Hunter front, mass balance, lake at rest, Green-Ampt against the exact solution, refusals, stop, Froude cap).
- `tests/node/test_sources.js` (new):
  - point inflow volume and ledger;
  - time-varying hydrograph;
  - two sources in one cell;
  - 5-minute rain;
  - basin at rest;
  - refusals.
  - All 11 checks fail on the original solver (fail-first).
- `tests/node/test_swmm.js`: `.inp` and `.out` readers against the EPA SWMM 5.2 engine (swmm-toolkit 0.17.0) for three models. Node inverts and depths, flooding and head series are exact. Rain totals equal the report. Flooding volume is within 0.65% of the report (5-minute point samples).
- `tests/node/test_model.js`:
  - DEM block means, NoData, building and boundary cells against rasterio;
  - US and SI examples agree;
  - coupling volume equals the trapezoid integral of the node series;
  - pond level follows the SWMM head;
  - GeoTIFF export reads back.
- Prep: `prep_dem.py` from a raw USGS 1 m tile (meters, UTM) reproduces the 3 ft DEM within 0.12 ft (90th percentile, after 6 ft averaging).
- Browser (`tests/browser/test_app.py`, Chromium 1400 px and 390 px, light and dark): see the latest run below.

## Not tested
- Speed on a real GPU (only SwiftShader here: a 160,000-cell run was about 7–10× real time, slower than the CPU's 30×).
- The work PC's browser and its WebGPU policy.
- Online basemaps (tile requests are blocked in the test sandbox; the hillshade fallback was tested).
- DEMs without an EPSG code in the GeoTIFF (the EPSG box path is coded, not run).
- Very large grids near the 8-million-cell limit.

## Open items
- Phase 2: two-way coupling with SWMM 5.2 compiled to WebAssembly (in progress).
- Spatially varying roughness and soils (from land cover).
- Maximum velocity and depth x velocity hazard maps.
- Save and reopen results.
