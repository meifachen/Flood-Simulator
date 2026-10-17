# STATUS: Flood Simulator

Updated 2026-10-17. Version 0.2.0: one-way and two-way SWMM coupling.

## What works
- **App:** offline single file `dist/FloodSimulator.html` (5.6 MB including three examples and SWMM 5.2.4 in WebAssembly).
- **Inputs:**
  - DEM GeoTIFF in any projected CRS from the PROJ list (5,252 EPSG codes);
  - building and level-boundary GeoJSON (reprojected from lon/lat or another EPSG);
  - SWMM5 `.inp`, and `.out` for one-way, in US or SI units.
- **SWMM coupling:**
  - One way: node flooding from the `.out` enters the 2D as point inflows.
  - Two way: EPA SWMM 5.2.4 runs in the page in step with the 2D. Node overflow goes onto the surface. Surface water returns through inlets (weir below the rim, orifice when surcharged, capped at half the cell's water per interval). `ALLOW_PONDING` is forced to NO, and the app says so.
  - Boundary levels: storage or outfall heads (from the `.out`, or live in two-way) or fixed levels.
- **Rain on the grid:** from a SWMM gauge (intensity, volume or cumulative) or uniform. A warning shows when it is combined with SWMM, since that counts runoff twice.
- **Engine:** CPU or WebGPU, identical arithmetic, with a water balance at every map. Stop works in about 0.2 s.
- **Results:**
  - map (hillshade offline, or OSM or USGS imagery online);
  - 3D view with buildings, water and SWMM nodes;
  - four charts and a water-balance table;
  - a two-way SWMM summary with the coupled `.rpt` and `.out` to download;
  - GeoTIFF (max depth, max water level, time of max), buildings CSV and SWMM exchange CSV.
- **Python tools:**
  - `prep_dem.py`: clip, reproject and resample, vertical unit factor, buildings, SWMM node check;
  - `make_synthetic.py` and `make_public_demo.py`.
- **Other tools:** `tools/build.py` builds the page, `tools/build_swmm_wasm.sh` builds SWMM in WebAssembly, and `tools/screenshot.py`.

## Tested (all pass)
- `tests/node/test_solver_core.js`, `test_solver_guards.js`: carried-over solver tests.
  - Hunter front, mass balance, lake at rest.
  - Green-Ampt against the exact solution.
  - Refusals, Stop, Froude cap.
- `tests/node/test_sources.js`:
  - point inflow volume and ledger;
  - hydrograph;
  - two sources in one cell;
  - 5-minute rain;
  - basin at rest;
  - refusals.
  - All 11 checks fail on the original solver (fail-first).
- `tests/node/test_swmm.js`: `.inp` and `.out` readers against the EPA engine (swmm-toolkit 0.17.0, SWMM 5.2.4) for three models.
  - Node data and the flooding and head series are exact.
  - Rain totals equal the report.
  - Flooding volume is within 0.65% of the report.
- `tests/node/test_model.js`: DEM block means, NoData, buildings and boundaries against rasterio.
  - US and SI examples agree.
  - Coupling volume equals the trapezoid integral of the node series.
  - The pond follows the SWMM head.
  - GeoTIFF export reads back.
- `tests/node/test_couple2way.js`:
  - C0: SWMM in WebAssembly gives results identical to the native engine for two models (max difference 0).
  - C1 (closed inlets): the 2D receives exactly the overflow SWMM produces; that matches the report within 0.1%.
  - C2 (two-way):
    - 97,401 cf goes back into the inlets;
    - the net exchange matches on both sides to 1e-6;
    - 2D closure is 0.10 cf;
    - SWMM continuity is −0.010%;
    - less water is left on the surface than with closed inlets.
  - C3: ponding is forced off. C1 to C3 test new code, so they cannot fail on the earlier commit (symbol-only); the reference values come from the EPA engine.
- `tests/browser/test_app.py` (Chromium, built page, offline). B1 to B13 and Z all pass:
  - example load;
  - CPU run with closure, and inflow volume equal to the node series;
  - map, KPIs and map click;
  - GeoTIFF read by rasterio (CRS, 3 bands, NoData, values);
  - buildings and exchange CSVs;
  - 3D;
  - GPU equal to CPU (4.8e-6 ft);
  - refusals and inline marking;
  - SI files through the file inputs with lon/lat buildings;
  - two-way CPU (exchange balances, SWMM continuity −0.003%, `.rpt` and `.out` open in the EPA reader);
  - two-way GPU equal to CPU (4.8e-6 ft);
  - Stop (0.2 s);
  - 390 px width with no horizontal scroll;
  - dark theme;
  - public demo;
  - no console errors.
- Prep: `prep_dem.py` run on a raw USGS 1 m tile reproduces the 3 ft DEM within 0.12 ft.

## Not tested
- Speed on a real GPU. Only SwiftShader was available; it is slower than the CPU here (CPU about 30–35× real time at 100,000–160,000 cells).
- The work PC's browser and its WebGPU policy.
- Online basemaps: tiles are blocked in the test sandbox, so only the hillshade fallback was tested.
- A DEM without an EPSG code (the EPSG entry box is coded but was not run).
- Grids near the 8-million-cell limit.
- Two-way coupling against another coupled model (e.g. PCSWMM 2D or HEC-RAS). It is verified for conservation and consistency only.

## Open items
- Per-inlet parameters (from a GeoJSON of inlets) instead of one size for every junction.
- Spatially varying roughness and soils (from land cover).
- Maximum velocity and depth × velocity hazard maps.
- Save and reopen results.
