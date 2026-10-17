# STATUS: Flood Simulator

Updated 2026-10-17. Version 0.3.0: per-inlet sizes, roughness and soils from land cover, velocity and hazard maps, save and reopen results.

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

- **New in 0.3.0:**
  - **Inlets:** a GeoJSON of inlets (point, node, weir length, grate area, coefficients, rim) replaces the single default size. Each inlet is its own sink; the half-the-water cap is shared among inlets in one cell. Junctions without a listed inlet use the default size or none (setting in the two-way box). An unknown node is reported and the inlet is ignored; an invalid size is refused.
  - **Land cover and soils:** an NLCD-coded GeoTIFF (any CRS; sampled at cell centres) sets Manning n and imperviousness per cell; a soils GeoJSON with a hydrologic soil group (dual groups use the last letter, D) sets Green-Ampt Ks and suction. Both tables are editable in the app. Unknown classes keep the global values and are reported.
  - **Velocity and hazard:** maximum speed and maximum depth × velocity, recorded where depth is at least 0.05 ft, on the CPU and on the GPU. New map views, legend classes, KPIs and popup values. The GeoTIFF export has 5 bands.
  - **Save and reopen:** `.fsim.gz` holds the grid, maps, maxima, SWMM summary and the layers on the map. A reopened run shows the map, 3D, charts and exports; Run is off until the inputs are loaded again.
  - **Closed edges:** an option to wall the grid edge; the outer ring of cells becomes a wall with no rain, so the balance stays closed.
  - Loading a new DEM clears the other layers and says so.

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
- `tests/node/test_velocity.js` (new functions; symbol-only fail-first):
  - V1 uniform Manning flow: depth 0.471 ft (exact 0.471), speed 2.122 ft/s (exact 2.121), depth × velocity 1.000;
  - V2 water at rest: 0 ft/s;
  - V3 sheet flow under 0.05 ft: no velocity recorded.
- `tests/node/test_landcover.js` (new functions; symbol-only fail-first):
  - land cover sampled at cell centres agrees 100% with pyproj/rasterio for both examples;
  - the soils raster equals the rasterio rasterization;
  - table values reach the cells;
  - group A soil infiltrates 13.81 ac-ft against 3.54 for group D on the same storm;
  - unknown classes reported, invalid table values refused.
- `tests/node/test_couple2way.js` C4 (inlets): per-node sums equal the exchange; at the same location a smaller inlet takes 15,356 cf against 28,551 cf; unknown node reported; invalid size refused.
- `tests/node/test_model.js` closed edges: edge outflow 0 and closure −1.86 cf of 466,886 cf of rain. Fails on the earlier code (edge outflow 218,522 cf): proven fail-first.
- `tests/browser/test_app.py` (Chromium, built page, offline). B1 to B16 and Z all pass. New in 0.3.0:
  - B14 land cover and soils loaded and used;
  - B3 velocity views; B4 5-band GeoTIFF;
  - B6 GPU velocity equal to CPU (4.4e-5 ft/s);
  - B15 two-way with 14 listed inlets;
  - B16 save, reopen, identical maps and GeoTIFF; truncated, wrong and future-version files refused;
  - B8 a new DEM clears the old layers; SI land cover and soils through the file inputs.
  Carried over:
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
- A soils GeoTIFF in the browser (the code path exists; only soils GeoJSON was run in the app).
- Land cover classes other than NLCD codes (other schemes need an edited table).
- Results files from very large grids (file size and memory when reopening).

## Open items
- Inlet clogging factors and inlet types (curb, grate, combination) with HEC-22 curves.
- Time series of velocity (only maxima are kept).
- Velocity and hazard checked against a benchmark (e.g. UK EA test 6A); only Manning flow is checked now.
