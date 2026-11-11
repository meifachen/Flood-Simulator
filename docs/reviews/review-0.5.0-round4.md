# Disjoint review: 0.4.3 and 0.5.0 (66e313b..066baa5), round 4

Date: 2026-11-11. Four reviewers worked in parallel, each read-only on its own slice. Each finding below was shown by running something unless it is marked otherwise. The probe scripts are kept in the session scratchpad, under `rev5/work/<slice>/`.

## 0. Setup

| Slice | Owned paths |
|---|---|
| engine | `src/engine/flood2d.js`, `tests/node/test_lakes.js`, `tests/node/test_solver_core.js` |
| coupler | `src/core/couple2way.js`, `tests/node/test_couple2way.js` |
| worker | `src/app/worker.js`, `src/core/model.js`, `tests/node/test_worker.js` |
| page-site | `src/app/{app,ui}.js`, `help.html`, `tests/browser/test_app.py`, `tools/build.py`, `dist/*`, `python/make_winter_haven_demo.py`, `docs/sites/*`, `docs/reviews/*round3.md`, `STATUS.md` |

- **Coverage:** 20 of 20 files in the range owned exactly once (`check_slices.py`).
- **Prior register:** round 3. Each reviewer was given copies of the round-3 register and response and checked its own items after an independent first pass.
- **Read-only check:** the repository's tracked, untracked and ignored files were the same before and after the review.

## 1. Farthest-traveling items

| Rank | ID | Title | Travel before detection |
|---|---|---|---|
| 1 | ENG5-1 | The step-scaled smoothing (ENG3-E1) measures against the Courant step, so the answer still changes with the Courant number (dam break 54,801 cf at cfl 0.7, 41,328 cf at 0.05) and with deep water anywhere in the grid (one 40 ft pit: 50,570 cf) | Every depth and lake level, silently |
| 2 | ENG5-2 | An outside withdrawal can take a lake to any level: −710,417 ft was accepted (0.4.2 refused it) | Lake series and peak, the 2D lake boundary, the stage given to SWMM outfalls |
| 3 | CPL5-F1 | `finish()` hands the last chunk's lake-outlet release to SWMM in one routing step: 600 cfs instead of 10 cfs in SWMM's report | SWMM's .rpt peaks and .out, which read as genuine SWMM output |
| 4 | WRK5-2 | An outlet crest below the stage-area table's lowest stage is accepted; the lake drained to 34.2 ft, 15.8 ft below the table, releasing 1,174,114 cf from a table that holds 487,872 cf | Lake level and outlet volume |
| 5 | WRK5-3 | A lake or soils field given in two letter cases: the first in the file wins, silently (`Hsg: "A"` with `HSG: "D"` codes every cell A) | Lake level; infiltration (about 30 times) |
| 6 | CPL5-F2 | The lake-outlet function does not check its volumes: a longer array puts water into SWMM node 0; NaN or negative volumes vanish | SWMM inflows |
| 7 | WRK5-1 | The load rollback (WRK3-F2) restores a snapshot taken before its first `await`, so it can undo a message that finished in between | Worker state differs from the page's |
| 8 | ENG5-3 | A routed lake overtopped by outside (SWMM) water is stopped as a "numerical failure" (0.4.2 accepted it) | The run stops, with a misleading message |

## 2. Findings

### 2a. New defects introduced by this work

- **ENG5-2 (engine).** The ENG3-E4 guard now counts only the 2D exchange and rain, so nothing bounds what `lakeInflow` removes. `lakeInflow: () => [-5e6]` on a lake at 99 ft ends at −710,416.9 ft. L10 dropped the case that caught this.
- **ENG5-3 (engine).** When outside water overtops a lake, its 2D share (`gain2d`) goes negative while the real level rises. Lidar lake (start = lowest ground 95 ft, 20 cfs for 2 h): refused at hour 1.82; 0.4.2 peaked at 100.567 ft. Lake at 99 ft, 100 cfs for 1 h: refused at hour 0.54; 0.4.2 peaked at 104.305 ft.
- **CPL5-F1 (coupler).** For inlets, what is owed at `finish()` is about one routing step; for a lake outlet it is a whole chunk. 3,000 cf released per 300 s chunk gives 600 cfs at POND in SWMM's report (3,000 cf over the 5 s routing step) against 10 cfs when the last release is spread over an interval. Volume totals are right; the peak is wrong by chunk length ÷ routing step.
- **CPL5-F2 (coupler).** `f(..., [500, 700])` with one outlet name is accepted: 700 cf goes to node index 0 (`null` key) and raised J1's peak lateral inflow from 43.8 to 81.5 cfs. `[NaN]`, `[-400]` and `[]` are accepted silently. An extra node's rate is also set after the junction rates; reasoned, not run, that it can overwrite a coupled junction's inlet rate for that interval.
- **CPL5-F4 (coupler).** `ccw: null` on any curb inlet is now refused ("curb weir coefficient null is not a positive number"); 0.4.2 used the default, as it still does for `cco` and `depressionWidth`.
- **CPL5-F6 (coupler).** `finish()` throws a TypeError (`sw.latV` undefined) when lake-outlet water is owed and `setLat` was never called (no coupled junction, release only in the last chunk).
- **WRK5-1 (worker).** Messages sent without waiting: a refused land cover load followed by a buildings load replies success for the buildings, but `BLD.length` is 0 afterwards (30 in 0.4.2). A refused load followed by a 24 ft `build` leaves the worker on the old 12 ft grid while the page draws the 24 ft one. Whether the page can send these concurrently is a boundary lead.
- **WRK5-2 (worker, engine).** See §1. Also a start above the table's top is extrapolated with no note. Authority: EPA SWMM 5.2 storage curves give area against depth above the invert; the level cannot go below the curve's lowest point.
- **WRK5-3 (worker, model).** `{STAGE_AREA: "50:1; 60:2", stage_area: "50:100; 60:200"}` ends at 57.483 ft; flipped, 57.976 ft; no message either way. The inlets loader refuses the same situation.
- **WRK5-5 (worker).** A boundary that is not routed but has a bad or partial `stage_area` or outlet is refused, labeled "Routed lake", for fields that will not be used.
- **WRK5-6 (worker).** `outlet_length_ft "0x10"` is read as 16 ft; crest `"0b111001"` as 57. "Infinity" length or Cw is refused, but by the engine, not the worker.
- **ENG5-4 (engine).** A table with falling areas is accepted (`[[95,30000],[96,30000],[97,3000],[100,300000]]`); the "at least its own cells" check runs only at the starting level.
- **ENG5-5 (engine, performance).** `kExt` decays only when the level moves more than 1e-4 ft, so one spike keeps chunks near 1.7 s for the rest of a still period: 5,354 `lakeInflow` calls against 194 (each a SWMM advance in two-way runs).

### 2b. Fixes that stop short

- **ENG5-1 / ENG3-E1.** The dtMax path is fixed (T9). A smaller step from a lower Courant number keeps dt equal to the Courant step, so θ is not scaled: 54,801 / 52,355 / 47,031 / 41,328 cf at cfl 0.7 / 0.3 / 0.1 / 0.05, the same as 0.4.2. A deep still pit elsewhere shrinks the Courant step and adds smoothing everywhere. Routed lake (L7 setup, 60 s chunks): lowest level 101.272 / 101.444 / 101.594 ft at cfl 0.7 / 0.3 / 0.1. Authority: the de Almeida et al. (2012) weighting is a discrete Laplacian applied once per step, D = (1 − θ) dx² / (2 dt).
- **WRK5-4 / WRK3-F1.** Soils polygons are not guarded: lon/lat soils, then `epsg: 26917`, is accepted and the soils stay in EPSG 2236 numbers.
- **CPL5-F5 / CPL3-F1.** The "bad value in the table is refused" rule covers only `ccw` on a long curb; a curb inlet's `lw: -5` or `cw: "abc"`, a grate's `curbLength: -3` and a generic inlet's `ccw: "abc"` are kept silently (unused, so no hydraulic result changes).
- **PS5-2 / PAGE3-1.** `run()` now refuses during a run, but a run can still start while a file is loading ("Reading dem.tif…", Run enabled). In the probes it was refused or equivalent; no wrong map was seen.

### 2c. Prior findings still open

- **ENG3-E3** (first chunk after a level-dependent inflow starts): as the response said; 96.816 ft at 3,600 s chunks, 98.054 ft at the default 60 s.
- **Read and hour boundaries collapse the cap:** a quiet 6 h run at 3,600 s chunks takes 75 chunks against 24.

## 3. Weak tests

- **T9** varies only dtMax, so the Courant-number path (ENG5-1) is never exercised.
- **L10** dropped the runaway-withdrawal refusal and never puts outside water onto the land (ENG5-2, ENG5-3).
- **C18** checks only total external inflow: a mutant that sends POND's water to J7 and J4's to J5 passes. It also closes the inlets, so outlet and inlet water never share a junction (a separate mixed run balanced: 217,267 cf delivered against 217,277 cf in the report).
- **C17** does not cover the panel `lw`, `area` or `clog` checks (mutants pass).
- **W15 / W16:** removing the CRS restore after a refusal, the table row area check, the outlet crest, length and Cw checks, or either lake note leaves the suite passing.
- **B22** uses 12.5 and 12.34567, which round-trip at 12 digits too, so it does not test the 15-digit change; the map interval is not tested.

## 4. Unverified suspicions

- **WRK5-8.** A text EPSG equal to the DEM's (`"2236"`) is refused with vector layers loaded (strict `!==`); whether the page ever sends text is not known.
- **WRK5-9.** A routed lake with a table but no grid cells and no `area_ac` would be refused with "give its area" (not constructed).
- **PS5-3.** The 0.4.2-to-0.4.3 rerun figures in the site doc: no run files in the cloud copies. The files are on the laptop (`examples/winter_haven/runs/v043`), where the figures were computed; they were not staged for the reviewer.

## 5. Defences that held

- **Outlet weir:** with a 0→50→0 cfs hydrograph into a stage-area lake, the peak, end level and outlet volume at 1, 60 and 900 s chunks match an independent RK4 level-pool solution within 0.001 ft and 16 cf; through the page, the end level matches an RK2 solution to 0.0001 ft and the outlet volume to 0.4 cf.
- **Storage table:** `levelOf(vol(h))` returns h within 1e-6 ft in 100,000 random round trips (2–7 rows, narrow and falling segments, outside the table).
- **Outlets into SWMM:** coupled junction and storage node reconcile with the report; with inlets open as well, 217,267 cf delivered against 217,277 cf reported. `outlet_node` J3 through the page works; an outfall, an unknown name, the wrong case and a run without two-way coupling are refused.
- **Round-3 fixes that hold:** ENG3-E1 (dtMax), L7's converged reference, ENG3-E2 (two-way link, also cross-linked lakes and links up to 1e5 cfs/ft), CPL3-F1 to F4, WRK3-F2 (sequential calls), WRK3-F3, F4, F5, PAGE3-1 (run during a run), SITE3-2, PAGE3-3 (15 digits, 20,000 random values), the routed wording.
- **Build:** `dist` reproduces byte for byte; the 390 px check binds (486 px without the wrapper).

## 6. Fail-first gate

Run by the reviewers against 66e313b: T9, L7, L10 (withdrawal), L11, C17, W15, W16 and B25 fail there; L12, L13, C18 and B26 crash or are absent (new functions). B22's new values pass there (§3).

## 7. Boundary leads

- `src/app/app.js`: can the page send a second `load` or a `build` before a `load` replies (WRK5-1)? Does it send `epsg` as text (WRK5-8)? Do blank inlet-table cells arrive as `null` (CPL5-F4)?
- `src/app/worker.js`: does a typical two-way run end the 2D before SWMM's end, so the CPL5-F1 spike lands mid-run?
- `src/app/results_io.js` (outside the range): do saved results keep `lakes.outlet`, `outletNode`, `hasOutlet` and `tally.lakeOutletsToSwmm`?
- Where is the Courant number exposed, and how far does ENG5-1 reach in practice? (It is a run setting in the page, 0.1–1.)

## 8. Not covered

- The GPU back end for the new engine code (driver-side, shared with the CPU, but not executed).
- The full browser suite (targeted probes only); phone width beyond the lakes table.
- Several routed lakes with outlets and 2D exchange at once; SI and CMS models with lake outlets; outlets to divider nodes.
- Rerunning the Winter Haven builder; the 0.4.3 Winter Haven run files.
- Minor: STATUS gives the app as 5.6 MB (now 5.74 MB); the site doc's "no outlet and a constant area" remains true for the builder's runs.
