# Response to the 0.6.1 review, round 1 (fixed in 0.6.2)

The findings are those of `review-0.6.1-round1.md`, plus the round-4 items (`review-0.5.0-round4.md`) still open at 0.6.1. **Fail-first** says how each new or changed check behaved against 0.6.1 (08e3f27), each suite run with its module override (`FLOOD2D`, `COUPLEJS`, `SWMMJS`, `MODELJS`, `WORKERJS`, `RIOJS`):

- **fails:** the check fails there by assertion.
- **crash:** the old code throws on the check's input.
- **new:** the check covers new behavior.

## Build, tests and CI

| ID | Finding | Fix | Check | Fail-first |
|---|---|---|---|---|
| P-01, DS-1 | The committed app was the 0.5.0 build under a 0.6.1 manifest | Rebuilt (0.6.2) and committed. The browser suite now refuses to start when the manifest does not describe the file. The claims gate checks on every run that the app's hash is the manifest's and that every input hash matches the sources | gate: "FAIL dist ... is not the file its manifest describes" on the 0.6.1 tree | fails |
| P-08 | The browser stamp did not tie the version to the file | The stamp prints the full sha256 and exits when the manifest disagrees | as above | fails |
| DS-2 | Gate holes | Full 64-character sha. The log must contain "ALL PASS" and no FAIL line or traceback. B20 is read from its own result line. A missing log fails unless `--no-browser` is given | gate runs | — |
| DS-3 | CI ran neither `test_lakes.js` nor the gate | Both added to `.github/workflows/test.yml`; the browser log is captured for the gate | — | — |
| DS-4, WRK6-4 | `tests/fixtures/` never committed | Committed, with `tests/py/make_fixtures.py` to regenerate them through `prep_dem.py` | test_model 49 checks | — |

## Engine

| ID | Finding | Fix | Check | Fail-first |
|---|---|---|---|---|
| ENG6-1, P-02 | The answer changed above Courant 0.7 (page example peaks 10.3–10.7 ft against 4.67) | Courant numbers above 0.7 are refused, naming the value: Bates et al. (2010) use 0.2–0.7. The 0.6.1 scaling above 0.7 is removed. The page field and the help say 0.1–0.7. A weighting θ outside 0.5–1 is refused | T10 | fails (accepted 0.75, 0.95, 1.0) |
| ENG6-2 | The switch-on hold ended on any nonzero quiet inflow | The hold now lasts until the outside inflow's dependence on the level has been read once. The reading is taken against the last reading point, so a slow drift counts too | L21: a 1e-6 cfs baseflow keeps it (largest move under 0.5 ft) | fails (6.67 ft) |
| ENG6-3 | Idle lakes ran in 1 s chunks | The hold applies only to lakes linked from outside; the worker marks a lake linked only when a SWMM outfall discharges into it. Lakes with outside inflow keep chunks to 60 s at most | worker | — |
| ENG5-5 (round 4) | One spike kept chunks short for good | The level-dependence estimate decays with a 10 min half-life between readings | — | — |
| ENG6-4 | The part-full pipe outlet was not SWMM's orifice | EPA SWMM 5.2 side orifice (link.c `orifice_getFlow`): weir form Cd A √(2g D/2) (d/D)^1.5 below the crown; full, the head to the centre | L17 | fails |
| ENG5-2 (round 4) | A withdrawal took a lake to −14 million ft | A table lake stops at its table's bottom. A lake without a table stops 10 ft under the grid's lowest ground and is asked for a table. Lidar lakes may still be drawn below their flattened surface | L21 | fails |
| ENG5-4, WRK6-2 | Falling-area tables; outlets below the table | Falling areas, a start below the table and an outlet (any kind) below the table's bottom are refused | L21 | fails |
| ENG6-6 | Float32 drift in the D×V duration | Kahan-compensated sum on the CPU and the GPU (the GPU compensation in `v.z`) | V9: 14,392.8 s of 14,400 at 0.02 s steps; 0.6.1 gave 14,254.6 | fails |
| ENG6-7 | `dvThresh` carried over between runs | Reset to the default each run unless given | V9 | fails |
| ENG6-8 | `initVel` arrays not checked | Each must have one finite value per cell; durations and maxima must not be negative; tvmax may be NaN (never moved) | V9 | fails (accepted) |
| ENG6-9 | stress_grid saved the final depth as "hmax" | It saves the run maximum, compares the reopened maxima cell by cell, and handles small targets | smoke runs at 2,000 and 50 cells | — |
| ENG5-1, deep-pit sibling | One deep still pit adds smoothing everywhere | Not changed. The smoothing is set per chunk from the deepest water. Making it local means a per-face weighting in both back ends; that is noted in STATUS as a known limit | — | — |
| ENG3-E3 | First chunk after a stiff inflow switches on | Partly addressed by the hold. Once a level dependence of zero has been read, a later stiff switch-on is again limited only by the chunk cap (60 s). STATUS keeps this as a limit | — | — |

## Coupler and SWMM reader

| ID | Finding | Fix | Check | Fail-first |
|---|---|---|---|---|
| CPL6-1 | Combination inlets in sag over-counted by a third | Grate weir plus the weir of the curb beyond the grate only (`grate_length_ft`), as HEC-22 and SWMM 5.2.4 `getOnSagInletCapture` | C10, combination check (1.4789 / 2.9578 cfs) | fails (3.9436) |
| CPL6-3, 6-10 | No spread limit on grade; surcharge ignored | On-grade interception is capped by the openings' orifice capacity at the same depth and surcharge limit | C20: 35.55 cfs at 2 ft (55.19 uncapped) | fails |
| CPL6-4 | On-grade never tested through makeCoupler | C20 sends an on-grade curb through `makeCoupler`/`sourceAt` (1.346 cfs against 2.683 in sag) | C20 | fails |
| CPL6-5 | `onGrade` read as truthy | Must be true or false | C20 | fails |
| CPL6-6, WRK6-5 | Percent slopes accepted | Slopes of 0.3 or more refused as likely percents | C20 | fails |
| CPL6-9 | Depressed curb share | HEC-22 Eq. 4-4 (SWMM `getEo`). A depression depth without a width is refused | C20 (refusal) | fails |
| CPL5-F4, F5 | ccw null refused; unused bad sizes kept | Every size or coefficient given is checked whatever the inlet type; a blank (null) counts as not given | C20 | fails |
| CPL5-F1 | Last outlet release spiked to 600 cfs in SWMM | `finish()` spreads what is owed over one coupling interval first | C21: POND peak lateral inflow 10 cfs | fails |
| CPL5-F2 | Outlet volumes not checked | One finite volume of zero or more per lake, else refused | C21 | fails |
| CPL5-F6 | `finish()` TypeError | Guarded | C21 | fails |
| CPL6-8, WRK6-6 | Search radius rounded up to whole cells | Radius = searchFt / cell size (fractional) in the coupler and the model | test_model (36 ft) | not fail-first at the helper; the defect was in the callers' rounding, which is removed |
| CPL6-2 | Snow catch factor scaled rain (SCF 0: no rain) | Not applied to rain (SWMM 5.2 gage.c) | test_swmm | fails (2 / 1 / 0 in) |
| CPL6-7 | CUSTOM and STREET sections | CUSTOM height numeric and curve kept; STREET name kept | test_swmm | fails |
| CPL6-11 | NOTICE listed swmm5.wasm | Corrected (embedded in swmm5.js) | — | — |

## Worker, model and results

| ID | Finding | Fix | Check | Fail-first |
|---|---|---|---|---|
| WRK6-1 | Multi-band DEM read interleaved | Band 1 is read, with a note naming the band count | test_model | fails |
| WRK6-8 | Vertical-unit GeoKeys and conflicting tags | Unknown unit codes and conflicts are named. GDAL's role item is preferred; US survey foot spellings are added | test_model F-13 | — |
| WRK6-9 | prep_dem wrote no GDAL band unit | Also sets the band unit (role="unittype") | fixtures | — |
| WRK6-12 | Null geometry crashed prep_dem | Skipped and counted | — | — |
| WRK6-3, P-03 | Provenance missed the grid and surface settings | A `surface` group (cell size, units, Manning n, imperviousness, Green-Ampt values, tables, edges, thresholds, search distance) is recorded and compared key by key. `provDiff` returns null when a run has none. The page says "the recorded settings ... agree", or that one run's settings were not recorded | R-C4 | fails |
| P-04 | Cleared inputs kept their hashes | A cleared layer drops its hash | — | — |
| P-05 | Hash of decoded text | Hash of the file's bytes | — | — |
| WRK6-7, WRK5-3, WRK5-6 | Outlet fields | Lake fields given twice in two cases refused; decimal numbers only; a field the outlet type does not use refused (a rating without its type, outlet_cd alone, stray weir fields) | W19 | crash (0.6.1 refused the unrouted boundary first) |
| WRK5-5 | Unrouted boundary refused for unused fields | Its lake fields are noted, not parsed | W19 | crash |
| WRK5-3 (soils) | Soil group in two cases | Refused when the values differ | W19 | fails |
| WRK5-4 | EPSG change with soil polygons | Refused like the other vector layers | W19 | fails |
| WRK6-11 | Buildings as lines; small sheds blamed on the CRS | A file with no polygons is refused, and other features are counted. Footprints inside the grid but smaller than a cell get their own message | W19 | fails |
| WRK5-1 | Concurrent load rollback | Worker commands run one at a time in arrival order | W19 | — |
| WRK6-10 | tvmax 0 for never moved | NaN, like tmax | — | — |

## Page

| ID | Finding | Fix |
|---|---|---|
| PS5-2 (round 4) | Run during a file load | Run refuses and its button is disabled while a file is being read |
| P-06 | Band counts | README, tooltip and button say 8 bands, or 6 for runs saved before 0.6.0 |
| P-07 | "outlet outlet:" | Fixed |

## Docs and site

| ID | Fix |
|---|---|
| DS-5, DS-6 | The Winter Haven pack README states that a regeneration completes (2026-11-14) and what the build report actually holds. Committing the generated files needs the owner's decision: they would put City data in the public repository |
| DS-7 | `--outlets` CSV: BOM and header case handled; node names kept as text; non-finite numbers and files without a lake column refused; the routed note agrees with the outlets given |
| DS-8, DS-11, DS-12 | STATUS: gate wording, drifted figures, the Winter Haven outlet statement and the app size updated |
| DS-9 | Maude NGVD 29 column back to the build report's −0.51 ft, with a note; the 0.4.1/0.4.2 inlet order fixed |
| DS-10 | The response's 0.6.0 hash corrected to ea0bc78 |

## Not changed

- **ENG5-1:** the smoothing is per chunk, from the deepest water in the grid.
- **ENG3-E3 residual:** a stiff level-dependent inflow that switches on after a zero dependence has been read is limited only by the 60 s chunk cap.
- **P-08's B16 wait shape:** a wrongly accepted file times out and aborts the suite, which still fails it.
- **Two inputs of one kind in provenance:** each layer kind holds one file, so it does not arise from the page.
