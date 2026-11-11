# Disjoint review: the 0.4.1 fixes (f1662e5..cbddcfe), round 2

Date: 2026-11-11. Five reviewers worked in parallel, each read-only on its own slice, against the round-1 register (`review-0.4.0-round1.md`). Each finding below was shown by running something, unless it is marked otherwise. The probe scripts are kept in the session scratchpad, under `rev3/work/<slice>/`.

## 0. Setup

| Slice | Owned paths |
|---|---|
| coupler | `src/core/couple2way.js`, `tests/node/test_couple2way.js` |
| engine | `src/engine/flood2d.js`, `tests/node/test_lakes.js` |
| worker | `src/app/worker.js`, `tests/node/test_worker.js` |
| page | `src/app/{app,ui,results_io}.js`, `index.html`, `help.html`, `tests/browser/test_app.py`, `tests/node/test_results_io.js`, `tools/build.py`, `dist/*` |
| site | `python/compare_icpr_winter_haven.py`, `python/make_winter_haven_demo.py`, `docs/sites/winter-haven-lake-martha.md`, `STATUS.md`, `README.md` |

- **Coverage:** every file in the range is owned exactly once (`check_slices.py`).
- **Prior register:** round 1. Each round-1 fix was checked for whether it does what its row in `response-0.4.0-round1.md` says.
- **Fail-first:** the reviewers reran the round-1 tests against f1662e5. All the new checks failed there except L6 and L9, which the response had already listed as mutant checks.

## 1. Farthest-traveling items

| Rank | ID | Title | Travel before detection |
|---|---|---|---|
| 1 | CPL2-F1 | A routed lake no longer gets the water that enters its outfall node directly (runoff, `[INFLOWS]`, dry-weather flow). This is a regression from the CPL-F1 fix | Lake level and the flooding around the lake; `toLakes` agrees with itself, so nothing flags it |
| 2 | ENG2-E1 | A level-dependent outside outflow (a weir or pipe to SWMM) is not in the chunk limit, so a lake can drain below its crest in one chunk | End level and level series, with no error |
| 3 | WRK2-F1 | Inlet sizes, clogging and rim in upper case are dropped without a message | Inlet capture, SWMM inflow and the depth maps in two-way runs |
| 4 | WRK2-F2 | Loading new boundaries does not clear the grid; a run then uses the old polygon's lake cells under the same key | All results (direct worker use; the page always builds before a run) |
| 5 | PAGE2-F1 | The tour moves on after a failed Run step when an earlier run's results are still loaded | The user reads old results as the new run's |
| 6 | SITE2-S1 | `--tol-ft` smaller than the cell does nothing, but the column still says "within N ft" | The comparison table |
| 7 | ENG2-E4 | The "below its bed" guard stops a lidar-lake run after a 0.01 ft drawdown, with a message that blames mass balance | The run stops; the user chases a balance error that does not exist |

## 2. Findings

### Coupler (`src/core/couple2way.js`)

- **CPL2-F1. Direct inflow to a routed lake's outfall is dropped.** With `[INFLOWS] LK FLOW "" FLOW 1.0 1.0 2.0` (2 cfs onto the outfall), the lake was booked 24,379 cf; SWMM's Outfall Loading Summary gives 67,509 cf, and the base code booked 67,570 cf. A subcatchment draining to LK gave 24,131 cf booked vs 65,236 cf in the report. Authority: SWMM 5.2.4 `routing.c` adds external and wet-weather inflows to `Node[j].newLatFlow`; the new code summed only the link flows.
- **CPL2-F2. A NaN clamp at the start of an interval (c0) is not refused.** NaN reaches SWMM's lateral inflow, the node head becomes NaN, and SWMM reports 0% continuity. The C13 guard checks only c1, and `setLat` takes any rate.
- **CPL2-F3. SWMM does not take inflows between `[EVENTS]`.** With an event window of 03:00–06:00 and coupling from 01:00, the inlets took 6,211 cf, the tally says 6,211 cf delivered, and SWMM's report shows 0 cf external inflow. Authority: `routing.c` skips `addSystemInflows` when `isBetweenEvents()` is true.
- **CPL2-F4. `finish()` books nothing for an interval whose `afterChunk` was never called.** About 310 cf of demand left the system untallied. The round-1 guard sits only in `sourceAt`.
- **CPL2-F5. A curb opening over 12 ft drops the depression but keeps a caller's `ccw`.** With L = 15 ft and `ccw` 2.3 it took 170.07 cf; the TxDOT rule (W = 0, Cw 3.0) gives 221.83 cf. The warning still says the rule was applied.
- **CPL2-F6. A NaN depth at an inlet cell becomes zero capture with no message.**
- **Weak tests:** C2's recirculation check is a range (0 < x ≤ sent); C12's reference uses the same method as the code; C11 and C12 have no direct outfall inflow; C13 supplies NaN only at c1.
- **Held:** the link-flow sign convention (the same lake written two ways books the same −483,544 cf); the reason for not using `NODE_INFLOW` at an outfall (`node.c` stores backflow as `fabs`); the 12 ft rule itself; the level guard; C14 delivery against SWMM's report. C14 can over-deliver up to one routing step at the last rate (74 cf of 3,106 cf at a 20 s step), booked as negative owed.

### Engine (`src/engine/flood2d.js`)

- **ENG2-E1. The chunk limit ignores outside inflow that depends on the lake level.** A 0.58 ac lake at 99 ft with a 150 ft weir at 97 ft drains to 97.001 ft with 1 s chunks but falls to 95.636 ft in one 60 s chunk and stays there. Forward Euler is stable only for dt < 2A/(dQ/dh); here that is about 48 s.
- **ENG2-E2. The 0.5 s floor in the chunk limit can override the stability limit.** A one-column lake at dx 3 ft, starting 4 ft above flat land, ends at 97.931 ft with 60 s chunks against 100.215 ft with 0.01 s chunks.
- **ENG2-E3. L7's "fine" reference is not converged, and its tolerance sits at the observed error.** The lowest level by chunk length: 0.1 s 101.611; 0.25 s 101.486; 1 s 101.323; capped 101.227 ft. Separately, the peak land depth in the routed-lake transient depends on the 2D step: 2.599 ft at the default step against 1.52–1.66 ft as dt → 0. That predates 0.4.1.
- **ENG2-E4. The bed guard misfires on lidar lakes.** On the Winter Haven DEM, the lowest lake cell of Silver and Martha equals the lake level (the lidar is the flattened water surface), so a 0.01 ft drawdown stops the run with "it lost more water than it holds".
- **ENG2-E5. L6 and L9 pass on the base code; the bed guard and the pipe refusal have no test.**
- **ENG2-E6. `lakeInflow` without routed lakes is silently ignored; a non-function gives a raw TypeError.**
- **Held:** 11 refusal inputs; L7 and L8 fail on the base code; a submerged exchange is stable at 1, 60 and 900 s chunks; the crest formula (Cw = √g·(2/3)^1.5 ≈ 3.09); no lake edge flux is missed.

### Worker (`src/app/worker.js`)

- **WRK2-F1. Only `inlet_type` is read in any letter case.** `{node, INLET_TYPE: "Grate", PERIMETER_FT: 2, OPEN_AREA_SQFT: 0.5, CLOG: 0.5, RIM_FT: 70}` loads as a grate with no sizes, no clogging and no rim, and no note.
- **WRK2-F2. New boundaries do not clear the grid.** The same key with the polygon moved 1,500 ft kept 359 lake cells (index sum 6,911,533) and the run was accepted.
- **WRK2-F3. The type note counts features, not inlets** (one MultiPoint of 3 points: "1 inlet has a type field").
- **WRK2-F4. The area message prints "null" for Infinity and NaN.**
- **WRK2-F5. Node `0` (a number) on a routed lake is accepted, then dropped.**
- **WRK2-F6. `inlet_type` and `INLET_TYPE` both present: the first in the file wins without comment.**
- **WRK2-T1. W12's text-area check passes on the base code by its wording only.** Infinity, `true` and `"5"` were not tested.
- **Held:** routed with a node is refused for "POND", "0" and " "; mismatched keys are refused; seven bad areas are refused; the one-way outfall warning; one message per bad value.

### Page (`src/app/*`, `dist/*`)

- **PAGE2-F1. The tour moves on after a failed Run step when an earlier run is loaded.** `run()` returns at `runOptions()` before `clearResults()`, so `S.final` stays. The same shape applies to the example step when `loadExample` returns early with an earlier DEM loaded (reasoned, not run).
- **PAGE2-F2. Impervious % is restored with `toFixed(4)`.** 33.333333% comes back as 33.3333%.
- **PAGE2-F3. Change classes on the map use the Float32 change; the area counts use the double.** At a class boundary one cell can be mapped "deeper" and not counted (about 1e-8 ft).
- **Held:** R-C1 (`dxFt` checked); the build reproduces the committed `dist` on the same day; the inlet type note is shown; the recirculated and owed rows convert correctly.

### Site (`python/*`, `docs/sites/*`)

- **SITE2-S1. A tolerance smaller than the cell does nothing.** With `--tol-ft 6` or `10`, the 12 ft run's "within" hit rate equals its plain hit rate (0.381); a true-distance check gives 0.469 at 6 ft.
- **SITE2-S2. STRUCTURE-4059 is in a lake cell only at 12 ft.** At 6 ft it is an open cell (ground 142.73 ft, peak depth 0.10 ft fixed and 0.60 ft routed) and is coupled. Its invert is 145.90 ft.
- **SITE2-S3. With `--routed`, `build_report.json` still says the lakes are fixed.**
- **SITE2-S4. The continuity bound (−0.11% to +0.01%) is contradicted by the 6 ft City-level run (−0.2548%).**
- **SITE2-S5. "Lakes are fixed" wording remains** in the site doc's not-like-for-like list and the compare script's docstring; the usage line omits `--tol-ft`.
- **SITE2-S6 (unverified suspicion).** The "lakes" column depends only on whether a run file has a `lakes` key.
- **SITE2-S7. The fixed-lake runs in the "updated for 0.4.1" doc are byte-identical 0.4.0 runs.**
- **SITE2-S8. Minor text.** 1 of 251 changed 12 ft cells lies outside the SAIP lake polygons; "changed" needs an unstated 0.01 ft threshold; a ",," typo.
- **Held:** the comparison table reproduces; SITE-F6 fails first; the tolerance conclusion survives a true-distance metric; every section 7 lake figure; the NGVD 29 to NAVD 88 shift (NGS NCAT: −0.932 ft); the rims; the location of STRUCTURE-4059.

## 3. Not covered

- The GPU path for the new engine code (driver-only, shared by both solvers).
- The full browser suite (the page reviewer ran targeted probes only).
- Rebuilding the Winter Haven site end to end, and rerunning its fixed-lake runs.
- SWMM `FLOW_TOL`, `SKIP_STEADY_STATE` and `ROUTE TO` on outfalls; SI models for the lake sign code; combination inlets over 12 ft.
