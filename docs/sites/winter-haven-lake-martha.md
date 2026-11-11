# Real-site test: Winter Haven, Florida (Lake Martha), November 2026 (updated for 0.4.1)

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
| Rims | USGS 3DEP 1 m lidar at each structure | The inventory has no rim elevations. 3 nodes had lidar ground within 0.5 ft of the invert, or below it, and their depth was set to 0.5 ft |
| Ground | 3DEP 1 m lidar (FL Peninsular FDEM 2018) | Resampled to 3 ft in EPSG 2237; NAVD88 ft |
| Lakes | USGS NHD | Held at the 2018 lidar water surface (Martha 139.19 ft, Silver 142.73 ft, Maude 139.17 ft), or with `--lake-levels city` at the City's SAIP levels (141.3, 145.2, 139.6 ft) |
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

### 2. Inlet capture depended on cell size (fixed in 0.3.3)

Each inlet could take at most half the water in its cell per 30-second coupling interval. That cap is proportional to cell area, so it bound far below the inlet equations on fine grids.

- **Fix:** an inlet asks for the rate the weir and orifice equations give at the start of the interval. Each engine step it takes that rate, or the water left in its cell if that is less. SWMM is sent the volume actually taken, and node overflow is spread on the ground in the next interval. The cap is now an option (`capFrac`), off by default.
- **Test:** C9 in `test_couple2way.js` holds the same depth over the same inlet on a 12 ft and a 6 ft grid. Before the fix, the 12 ft grid took 4.000 times as much water; now the ratio is 1.000.

Same storm, 8–16 h, two-way, on the laptop GPU:

| Cell | Into inlets, before | Into inlets, now | Overflow, now | Net drained, before | Net drained, now | Deeper than 0.25 ft, now | Deepest, now | Engine time |
|---|---|---|---|---|---|---|---|---|
| 12 ft | 488,918 cf | 1,058,534 cf | 677,612 cf | 288,525 cf | 380,922 cf | 28.30 ac | 5.20 ft | 26.9 s |
| 6 ft | 217,612 cf | 1,276,194 cf | 854,835 cf | 155,481 cf | 421,359 cf | 29.30 ac | 5.28 ft | 93.2 s |
| 3 ft | 72,909 cf | 1,317,609 cf | 880,417 cf | 61,648 cf | 437,192 cf | 29.86 ac | 5.34 ft | 786.6 s |

Net drained = into inlets − overflow.

- **Before,** the water drained fell by 79% from 12 ft to 3 ft. **Now** it rises by 15% and settles: 6 ft to 3 ft adds only 4%. The remaining change comes from finer grids resolving the gutters that lead to the inlets.
- **Demand the cells could not supply:** 0 cf at 12 ft, 2,306 cf at 6 ft, 3,679 cf at 3 ft. It is shown in the water balance and is not sent to SWMM.
- **SWMM report against the inlet tally:** 1,058,552 vs 1,058,534 cf, 1,276,221 vs 1,276,194 cf, and 1,317,646 vs 1,317,609 cf.
- **Continuity:** the 2D balance closes within 0.001%, and SWMM within 0.01%.

### 3. Checks that held on the real network

- **SWMM report against the inlet tally:** see the table in section 2. Before 0.3.1, SWMM kept adding the last capture after the 2D run ended.
- **Continuity:** SWMM's flow-routing continuity stays between −0.26% and +0.01% in every run reported here (the low end is the 6 ft City-level run, section 5), and the 2D water balance closes within 0.0015%.
- **GPU against CPU at 12 ft:** the same flooded areas to 0.01 ac, deepest water 5.239 vs 5.239 ft, and inlet volume 484,039 vs 484,035 cf.
- **Double-counting warning:** it no longer shows for a model without subcatchments (fixed in 0.3.2).

### 4. Against the City's SAIP ICPR v4 inundation, 25-year 24-hour

The City of Winter Haven published the results of its Stormwater Assessment and Improvement Project (SAIP) as an ArcGIS Online layer, "SAIP Preliminary Results Map". Its inundation layers come from an ICPR v4 model and mark where at least 3 in of water stands. `python/compare_icpr_winter_haven.py` compares them with the simulator's peak depth over the whole storm (0–26 h), using the same 3 in threshold.

**Where the comparison is made:**

- open ground in both models, inside the SAIP model boundary;
- outside the lakes of either model;
- 174.5 ac in the domain.

| Run | ICPR ac | Simulator ac | Both | ICPR only | Simulator only | Hit rate | False alarm ratio | CSI | Hit rate within 12 ft |
|---|---|---|---|---|---|---|---|---|---|
| Lidar lake levels, 12 ft (0.4.0) | 15.23 | 28.99 | 5.80 | 9.43 | 23.18 | 0.38 | 0.80 | 0.15 | 0.52 |
| Lidar lake levels, 6 ft (0.4.0) | 15.32 | 29.91 | 6.14 | 9.18 | 23.77 | 0.40 | 0.79 | 0.16 | 0.56 |
| City lake levels, 12 ft (0.4.0) | 15.23 | 29.29 | 5.99 | 9.24 | 23.30 | 0.39 | 0.80 | 0.16 | 0.54 |
| City lake levels, 6 ft (0.4.0) | 15.32 | 30.28 | 6.38 | 8.94 | 23.90 | 0.42 | 0.79 | 0.16 | 0.59 |
| Routed lakes (lidar start), 12 ft (0.4.1) | 15.23 | 28.99 | 5.80 | 9.43 | 23.18 | 0.38 | 0.80 | 0.15 | 0.52 |
| Routed lakes (lidar start), 6 ft (0.4.1) | 15.32 | 29.91 | 6.14 | 9.18 | 23.77 | 0.40 | 0.79 | 0.16 | 0.56 |

The fixed-level runs were made with 0.4.0 and not repeated. The routed runs were repeated with 0.4.1; their peaks moved by less than 0.001 ft (section 7), so the fixed-level rows are not expected to change at the precision shown, but that was not run. "Within 12 ft" uses the same distance at both cell sizes: an ICPR cell counts as a hit if the simulator is wet within 12 ft of it.

How to read the columns:

- **Hit rate:** the share of the ICPR area that the simulator also floods.
- **False alarm ratio:** the share of the simulator's area that ICPR leaves dry.
- **CSI:** both ÷ (both + ICPR only + simulator only).

**What the table shows:**

- **The simulator floods about twice the ICPR area and overlaps it poorly** (CSI 0.15–0.16). Cell size and lake level change the hit rate by up to 0.04, and the hit rate within 12 ft by up to 0.08: the 6 ft grid matches better at the same distance.
- **About 2.2 of the 9.4 ac that only ICPR floods lie within 60 ft of a lake shore.** ICPR routes the lakes, so they rise during the storm. The simulator holds them fixed, or routes them with no outlet (section 7); routing did not change this ring. Across the whole ICPR-only area, the simulator's median peak depth is 0.05 ft.
- **The area only the simulator floods is not marginal:** the median peak depth there is 0.42 ft. About 7.4 of its 23.2 ac lie within 25 ft of the centerlines in the SAIP roads layer, so they are street flow. That layer holds only 65 road lines in the domain, so street flow may account for more.

**Not like-for-like.** The table is a consistency check, not a validation. Neither model was checked against observed flooding.

- **Rainfall:** the simulator uses a nested Atlas 14 storm (7.69 in; peak 10.4 in/hr for 5 minutes). The City's layer does not state its rainfall distribution. Florida Modified or SCS Type II is usual in the region. Their peaks differ from the nested storm's.
- **Ground:** the simulator uses the 2018 USGS lidar. ICPR uses the City's 2017 SAIP DEM. The City's vertical datum is not stated (section 6).
- **Lakes:** the simulator holds them at a fixed level, or routes them with no outlet (section 7); ICPR routes them with their outlets.
- **Inlets:** the simulator uses the app's default sizes, because the inventory has none. The network in ICPR is not published.
- **Mapping:** ICPR inundation maps are drawn from modeled stages. How the SAIP drew them (from node stages or from a 2D mesh) is not stated.

### 5. Lake levels: lidar or the City's model

The builder now records both levels. `--lake-levels city` uses the City's levels for the level boundaries and for the outfalls on the lakes.

| Lake | Lidar water surface, 2018 | City SAIP WaterLevel | City − lidar | City − lidar, if the City used NGVD 29 |
|---|---|---|---|---|
| Martha | 139.19 ft | 141.3 ft | +2.11 ft | +1.18 ft |
| Silver | 142.73 ft | 145.2 ft | +2.47 ft | +1.54 ft |
| Maude | 139.17 ft | 139.6 ft | +0.43 ft | −0.51 ft |

- **What the City's levels are:** the layer gives the field name `WaterLevel` and no explanation. It may be a starting or control level in ICPR rather than a flood stage.
- **Effect on the 25-year whole storm:**
  - At 12 ft, the City levels flood 0.3 ac more than the lidar levels (29.29 vs 28.99 ac, open ground over 3 in, compared area).
  - The inlets take 1,207,937 cf with the City levels and 1,195,106 cf with the lidar levels.
  - At 6 ft, the City-level run has the largest unsupplied inlet demand (31,158 cf) and the largest SWMM continuity error (−0.25%).

### 6. Vertical datum

- **Ground:** the lidar is NAVD 88.
- **The City's layers:** neither the inventory nor the SAIP layers state a datum. The builder takes them as NAVD 88, with no shift, and says so in `build_report.json`.
- **If they are NGVD 29:** at the site, NAVD 88 = NGVD 29 − 0.93 ft (NGS NCAT, VERTCON 3.0, σ 0.08 ft). The City's elevations would then be 0.93 ft lower in NAVD 88.
- **Inverts above the lidar ground:** the builder now lists every structure whose inventory invert is above the lidar ground. 9 of the 154 structures on the DEM are, by 0.04 to 3.17 ft.
  - **Seven are outfalls on a lake** (0.04 to 1.61 ft). At a lake, the lidar is the flattened water surface, so an invert above it is expected.
  - **Two are inside the network:**
    - **STRUCTURE-4059, a grate inlet, 3.17 ft:** it sits on Lake Silver, 0.9 ft from the NHD shoreline and inside the City's lake polygon. Its "ground" is the lake's flattened lidar water surface (142.73 ft), not land. The builder flags it. At 12 ft its node falls in a lake cell, so the 2D does not couple it. At 6 ft it falls in an open cell at the shore and is coupled, but it never takes water: the water surface there peaks near 143.3 ft, below its rim of 146.40 ft (invert plus the 0.5 ft depth). Its invert (145.90 ft) is also above the City's own Silver level (145.2 ft); its location or invert in the inventory should be checked.
    - **STRUCTURE-6227, a mitered end, 0.50 ft above the ground.**
  - The builder gave both a 0.5 ft depth.

### 7. Routed lakes (0.4.0, rerun with 0.4.1)

In 0.4.0, a lake can rise with the water it gains instead of holding a fixed level (section 7 of the User Guide).

- **Setup:**
  - `python/make_winter_haven_demo.py --routed` writes the lakes as routed, starting from the lidar levels, with their whole NHD areas: Maude 55.2 ac, Silver 54.4 ac and Martha 89.1 ac.
  - Run: the whole 25-year storm, two-way, on the laptop GPU.
  - Code: 0.4.1, which takes water flowing back into SWMM out of a lake (review 0.4.0 round 1, CPL-F1) and limits the chunk length so the level update stays stable.

| Lake | Start | Peak, 12 ft | Peak, 6 ft | Rain on the lake, cf | From the 2D, cf (12 ft) | SWMM outfalls, net cf (12 ft) |
|---|---|---|---|---|---|---|
| Maude | 139.17 ft | 139.89 ft | 139.89 ft | 1,540,893 | 175,424 | 5,424 |
| Silver | 142.73 ft | 143.48 ft | 143.38 ft | 1,518,561 | 165,107 | 81,388 |
| Martha | 139.19 ft | 139.96 ft | 139.95 ft | 2,487,202 | 255,986 | 189,238 |

- **What drives the rise:**
  - The lakes rose 0.72–0.77 ft at 12 ft, and 0.65–0.76 ft at 6 ft. Most of that is rain on the lakes themselves (7.69 in, 0.64 ft).
  - At 12 ft, runoff from the grid and the storm sewer adds 0.075 ft (Maude) to 0.115 ft (Martha).
  - At 6 ft, Lake Silver nets −0.011 ft from those sources. It lost 133,700 cf to the land by spilling onto low ground at its edge, ground the 6 ft grid resolves and the 12 ft grid averages away.
- **Model limits:** the lakes have no outlet and a constant area, so the rise is an upper bound for the storm.
- **Where the land got wetter:**
  - Routing changed the peak depth by more than 0.01 ft on 0.83 ac of open ground at 12 ft (251 cells) and 0.79 ac at 6 ft. All but one 12 ft cell (250 of 251), and 0.78 ac at 6 ft, lie inside the City's SAIP lake polygons, which extend beyond the NHD shorelines.
  - So the ICPR comparison in section 4 is unchanged to the reported precision.
- **What that implies (an inference, not tested):** the ring that only ICPR floods lies on higher ground, within 60 ft of the lakes. ICPR's lake stages would then peak above these routed levels. The City's model also starts the lakes 0.4 to 2.5 ft higher (section 5).
- **Checks:**
  - SWMM continuity: −0.015% at 12 ft and −0.108% at 6 ft.
  - 2D balance: within 0.0011%.
  - Inlets: 1,195,216 cf at 12 ft, the same as with fixed lakes to within 0.01%.
  - 0.4.0 against 0.4.1: the peaks changed by less than 0.001 ft, and the net outfall volumes by under 1%. These lakes are large enough that the 0.4.0 update was already stable, and little water flowed back.
  - 0.4.1 against 0.4.2 (the adaptive lake chunk cap, rerun on the same GPU): the lake peaks agree to 0.001 ft; peak depth on open ground moved by at most 0.009 ft (no cell by more than 0.01 ft); inlets 1,195,143 vs 1,195,216 cf at 12 ft; SWMM continuity −0.014% and −0.104%.

### 8. Inlet file fields

The Winter Haven inlets file carries the City inventory's `type` field (CURB_INLET, GRATE_INLET). The first 0.4.0 build read `type` as the new inlet type and refused the file. The app now reads the inlet type from `inlet_type` (in any letter case) and leaves an inventory's `type` alone. Since 0.4.1 it also reports, at load, how many inlets have such a field and no `inlet_type` (52 CURB_INLET and 32 GRATE_INLET here), so it is clear they run as generic inlets. W10 and W11 check this.

## Speed on a real GPU

The laptop has Intel Core 7 150U graphics (gen-12lp). Both engines ran in headless Chrome on that machine. The CPU and GPU maps agree within 1.4e-5 ft in depth and 0.0065 ft/s in speed.

| Case | Cells | CPU | GPU |
|---|---|---|---|
| Synthetic US example, 12 ft, 1 h, one-way | 26,600 | 12.9 s | 1.1 s |
| Synthetic US example, 6 ft, 1 h, one-way | 106,800 | 110.1 s | 3.4 s |
| Synthetic US example, 12 ft, 1.5 h, two-way | 26,600 | 18.7 s | 2.2 s |
| Winter Haven, 12 ft, 8 h, two-way (0.3.3) | 83,160 | 279 s (cloud CPU, 0.3.2) | 26.9 s |
| Winter Haven, 6 ft, 8 h, two-way (0.3.3) | 332,640 | not run | 93.2 s |
| Winter Haven, 3 ft, 8 h, two-way (0.3.3) | 1,330,560 | not run | 786.6 s |
| Winter Haven, 12 ft, whole 26 h storm, two-way (0.3.3) | 83,160 | not run | 76.0 s |
| Winter Haven, 6 ft, whole 26 h storm, two-way (0.3.3) | 332,640 | not run | 281.0 s |

## Not covered

- **Calibration and observed flooding:** there is no comparison with observed flooding. The only comparison with the City's model is the inundation check in section 4, which is not like-for-like.
- **Lakes:** fixed levels (lidar or City), or routed with no outlet (section 7). The City's outlet structures are not modeled.
- **Inlets:** inlet sizes are not in the inventory, so the app defaults were used.
- **Datum:**
  - Horizontal: NAD83(2011) was taken as NAD83, with no grid shift (under 1 m here).
  - Vertical: the City's datum is unconfirmed (section 6).
- **The work PC:** not tested.
