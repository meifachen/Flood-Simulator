# Flood Simulator

A 2D overland flood simulator that runs in a web browser, with SWMM5 integration. It is one offline HTML file: no installation, no server, and no data leaves the computer.

- **Inputs:**
  - a ground DEM (GeoTIFF);
  - building footprints (GeoJSON);
  - lakes or other level boundaries (GeoJSON);
  - land cover, such as NLCD (GeoTIFF of class codes), for Manning n and imperviousness per cell;
  - soils (GeoJSON with `hsg`, or a GeoTIFF of groups 1–4) for Green-Ampt per cell;
  - a SWMM5 model (`.inp`), with its results (`.out`) for one-way coupling;
  - inlets (GeoJSON points) for two-way coupling.
- **Water sources:**
  - SWMM node flooding, added at each node;
  - rain on the grid, from a SWMM rain gauge or uniform;
  - water levels held at lakes, ponds or tidal boundaries, either from a SWMM node's head or a fixed level.
- **Engine:** local-inertial shallow-water equations (Bates et al. 2010; de Almeida et al. 2012), with Green-Ampt infiltration. It runs on the GPU (WebGPU) or the CPU, and keeps a water balance at every output step.
- **Results:**
  - animated depth map over a hillshade or basemap;
  - 3D view with buildings and water;
  - maximum velocity and maximum depth × velocity maps, with the cells where the solver capped the flow at critical speed hatched (speed there is a lower bound);
  - charts of flooded area, SWMM exchange, boundary levels and the depth at any point;
  - water-balance table;
  - exports: a 6-band GeoTIFF (maximum depth, maximum water level, time to maximum, maximum velocity, maximum depth × velocity, critical-flow cap flag), buildings CSV and SWMM exchange CSV;
  - save a run to a `.fsim.gz` file and open it later without the inputs.

![screenshot](docs/screenshot.png)

## Quick start

1. Download `dist/FloodSimulator.html` and open it in Chrome or Edge.
2. Under **1. Data**, pick an example and press **Load**, then press **Run**.
3. For your own site:
   - load a DEM in a projected CRS (feet or meters);
   - optionally add buildings, a lake polygon and the SWMM `.inp` and `.out`;
   - choose the water sources and press **Run**.

Large lidar rasters should be clipped and resampled first:

```bash
pip install rasterio geopandas
python python/prep_dem.py --dem lidar.tif --epsg 6438 --bounds XMIN YMIN XMAX YMAX --cell 6 \
    --buildings footprints.geojson --inp model.inp --out mysite/
```

Use `--zfactor 3.2808333333 --zunits ft` to convert meter elevations to US survey feet.

## SWMM integration

| | One way | Two way |
|---|---|---|
| What runs SWMM | You, beforehand. The app reads your `.out`. | The app: EPA SWMM 5.2.4 compiled to WebAssembly, run in step with the 2D. Results are identical to the native engine. |
| Into the 2D | Node flooding (cfs) at each node's location | Node overflow every coupling interval |
| Back into SWMM | Nothing | Surface water through inlets: weir flow while the node is below its rim, orifice flow when it is surcharged, capped at half the water standing in the cell. Inlets come from an inlets file (each at its own cell, with its own size), or default to one at each manhole. |
| Level boundaries | Storage or outfall head from the `.out` | Live storage or outfall head |
| Outputs | Results in the app | Also the coupled SWMM report (`.rpt`) and results (`.out`) |

Notes:
- **Coordinates:** node coordinates in the `.inp` must be in the DEM's CRS.
- **Placement:** a node on a building is moved to the nearest open cell within 30 ft. Nodes that cannot be placed are reported, not dropped silently:
  - one way: their flooding is not added;
  - two way: their overflow is tallied as lost.
- **Two-way settings:**
  - the coupling is explicit, with a default interval of 30 s; the 2D sees SWMM's response one interval later;
  - `ALLOW_PONDING` is forced to `NO` in the in-memory copy so that overflow reaches the surface, and the app says so;
  - in the inlets file, each point names its junction (`node`) and can set `weir_length_ft`, `orifice_area_sqft`, `cw`, `co` and `rim_ft`. The defaults in the app apply to anything not given; without `rim_ft` the crest is the SWMM rim of the node, as for a default inlet.
  - when the 2D run ends before SWMM's, the inlet inflow is reset to zero and SWMM finishes on its own, so its report holds only what the inlets took.
- **Double counting:** rain on the grid together with SWMM counts runoff twice where the grid overlaps SWMM subcatchments. The app warns about this.

The WebAssembly build of SWMM is `vendor/swmm-wasm/swmm5.js`. It was built from the EPA source (public domain), tag v5.2.4, with Emscripten 3.1.64; see `tools/build_swmm_wasm.sh`.

## Repository

| Path | Contents |
|---|---|
| `src/engine/flood2d.js` | 2D engine: CPU and WebGPU (WGSL) back ends with the same arithmetic, point inflows, level boundaries, water balance |
| `src/io/swmm.js` | SWMM5 `.inp` parser and binary `.out` reader, rain-gauge series |
| `src/core/model.js` | DEM to grid, buildings to walls, boundary polygons, one-way SWMM coupling, GeoTIFF writer |
| `src/app/` | Page, worker, 3D view, help |
| `tools/build.py` | Builds `dist/FloodSimulator.html` with every library inlined |
| `python/` | `prep_dem.py` (DEM and buildings prep), `make_synthetic.py`, `make_public_demo.py`, `make_landcover_example.py`, `make_inlets_example.py` |
| `examples/` | Synthetic street sewer (US and SI units) and a public-data demo |
| `tests/` | Node tests (engine, SWMM readers, model builder), Python reference generators, browser tests |

## Tests

```bash
npm --prefix tools install          # geotiff for the node tests (once)
node tests/node/test_solver_core.js
node tests/node/test_solver_guards.js
node tests/node/test_sources.js
node tests/node/test_swmm.js
node tests/node/test_model.js
node tests/node/test_couple2way.js
node tests/node/test_velocity.js
node tests/node/test_landcover.js
node tests/node/test_worker.js
node tests/node/test_results_io.js
python tools/build.py && python tests/browser/test_app.py
```

The SWMM readers are checked against the EPA SWMM 5.2 engine (`swmm-toolkit`), and the grid builder against rasterio.

## Data in the examples

**Synthetic street sewer:**
- an invented place and model;
- placed in a real CRS only so the files are valid.

**Public-data demo:**
- ground from USGS 3DEP lidar (2018 FL Peninsular; public domain);
- buildings from Microsoft Building Footprints (ODbL 1.0);
- streets from US Census TIGER/Line (public domain).

The storm sewer in the public-data demo was generated from the street centerlines by `make_public_demo.py`. It is illustrative and is **not** the real drainage system of that place.

## License

MIT (see `LICENSE`). Bundled libraries keep their own licenses (`vendor/*/LICENSE*`): Leaflet (BSD-2), three.js (MIT), Plotly.js (MIT), geotiff.js (MIT), proj4js (MIT). The CRS list comes from the PROJ database (MIT/X).
