# Real-site test: Winter Haven, Florida (Lake Martha), November 2026

## Why this site

It has a real storm sewer in a public inventory: the City of Winter Haven's ArcGIS Online stormwater layers give pipe sizes, materials, upstream and downstream inverts, and the structure at each end. That made it possible to build a SWMM model of the actual system without client data.

- **Size:** 34 acres of outfall basin in a 3,564 × 3,360 ft domain, in downtown Winter Haven around Lake Martha.
- **Land use:** a mix of commercial blocks and streets.
- **Receiving water:** the system drains to lakes that the 2D model holds as level boundaries.

## How it was built

`python python/make_winter_haven_demo.py examples/winter_haven` downloads and builds everything. `build_report.json` records every source, assumption and data gap.

| Input | Source | Notes |
|---|---|---|
| Storm sewer | City of Winter Haven inventory (pipes, inlets, manholes, outlets) | 145 pipes, 162 nodes, 84 curb and grate inlets, 15 outfalls to lakes, 6 free outfalls. 2 pipes without inverts were skipped |
| Rims | USGS 3DEP 1 m lidar at each structure | The inventory has no rim elevations. 4 nodes had lidar ground within 0.5 ft of the invert, and their depth was set to 0.5 ft |
| Ground | 3DEP 1 m lidar (FL Peninsular FDEM 2018) | Resampled to 3 ft in EPSG 2237; NAVD88 ft |
| Lakes | USGS NHD | Held at the 2018 lidar water surface: Martha 139.19 ft, Silver 142.73 ft, Maude 139.17 ft |
| Buildings | FEMA USA Structures | 352 footprints |
| Land cover | NLCD 2021 | 30 m |
| Soils | SSURGO hydrologic soil groups | Groups A and A/D |
| Rain | NOAA Atlas 14 | 25-year, 24-hour, 7.69 in. Nested storm in 5-minute steps; peak 10.4 in/hr |

The SWMM model has no subcatchments. Rain falls on the 2D grid and reaches the sewer only through the 84 inlets, by two-way coupling. Junctions with no listed inlet take no water.

## What the test showed

### 1. Roof rain was piling up in courtyards (fixed in 0.3.2)

The first whole-storm run at 6 ft gave a deepest water of 66.4 ft and needed 700,903 time steps.

- **Cause:** roof rain goes to the nearest open cell. At 6 ft, a one-cell gap closed in by buildings was the nearest open cell for 104 roof cells, so 7.69 in of rain became 66.6 ft of water.
- **Fix:** open ground cut off from the edge, the lakes and the main area now keeps only its own rain. Roof rain goes to open ground that drains, and the build reports such pockets.
- **Test:** `test_model.js` checks a courtyard against a hand-computed answer. It fails on 0.3.1 (11 times the rain) and passes now.
- **After the fix:** the whole storm at 6 ft gives a deepest water of 5.51 ft in 224,896 steps (249.8 s on the GPU, down from 703.5 s), and the 8-hour window takes 71,835 steps.

### 2. Inlet capture depends on cell size (open; the next fix to make)

Each inlet may take at most half the water in its cell per 30-second coupling interval. That cap is proportional to cell area, so it binds far below real inlet capacity on fine grids.

Same storm, 8–16 h, two-way, on the GPU:

| Cell | Water into inlets | Overflow out of nodes | Area deeper than 0.25 ft | Deepest |
|---|---|---|---|---|
| 12 ft | 488,918 cf | 200,393 cf | 29.17 ac | 5.26 ft |
| 6 ft | 217,612 cf | 62,131 cf | 31.03 ac | 5.47 ft |
| 3 ft | 72,909 cf | 11,261 cf | 32.03 ac | 5.60 ft |

At 12 ft on the CPU, without land cover or soils, the cap was varied:

| Cap | Into inlets | Overflow | Net drained | 2D clamp |
|---|---|---|---|---|
| 0.5 (default) | 681,420 cf | 281,730 cf | 399,690 cf | 0 cf |
| 2 | 1,602,741 cf | 1,073,886 cf | 528,855 cf | 0 cf |
| none | 1,686,452 cf | 1,157,595 cf | 528,857 cf | 0 cf |

- **The cap, not the inlet, sets the exchange.** With the default, the net water drained is 24% lower than with no cap, and the exchange shrinks as the cells get finer.
- **The flooded area moves less** (33.97 vs 33.21 ac), because the surcharged sewer limits drainage here. That will not hold on every site.
- **Proposed fix:** take what the inlet equations ask, limited each engine step by the water actually in the cell, and send SWMM the volume actually taken. This removes the per-interval cap and its dependence on cell size.

### 3. Checks that held on the real network

- **SWMM report against the inlet tally:** 488,917 cf in the SWMM report against 488,918 cf taken by the inlets. Before 0.3.1, SWMM kept adding the last capture after the 2D run ended.
- **Continuity:** SWMM's flow-routing continuity stays between −0.25% and 0.005%, and the 2D water balance closes within 0.0007%.
- **GPU against CPU at 12 ft:** the same flooded areas to 0.01 ac, deepest water 5.239 vs 5.239 ft, and inlet volume 484,039 vs 484,035 cf.
- **Double-counting warning:** it no longer shows for a model without subcatchments (fixed in 0.3.2).

## Speed on a real GPU

The laptop has Intel Core 7 150U graphics (gen-12lp). Both engines ran in headless Chrome on that machine. The CPU and GPU maps agree within 1.4e-5 ft in depth and 0.0065 ft/s in speed.

| Case | Cells | CPU | GPU |
|---|---|---|---|
| Synthetic US example, 12 ft, 1 h, one-way | 26,600 | 12.9 s | 1.1 s |
| Synthetic US example, 6 ft, 1 h, one-way | 106,800 | 110.1 s | 3.4 s |
| Synthetic US example, 12 ft, 1.5 h, two-way | 26,600 | 18.7 s | 2.2 s |
| Winter Haven, 12 ft, 8 h, two-way | 83,160 | 279 s (cloud CPU) | 19.3 s |
| Winter Haven, 6 ft, 8 h, two-way | 332,640 | not run | 84.6 s |
| Winter Haven, 3 ft, 8 h, two-way | 1,330,560 | not run | 831 s |
| Winter Haven, 6 ft, whole 26 h storm, two-way | 332,640 | not run | 249.8 s |

## Not covered

- **Calibration and observed flooding:** there is no comparison with observed flooding or with the City's own models. The lakes are held at their 2018 levels rather than flood stages.
- **Inlets:** inlet sizes are not in the inventory, so the app defaults were used.
- **Datum:** horizontal NAD83(2011) was taken as NAD83, with no grid shift (under 1 m here).
- **The work PC:** not tested.
