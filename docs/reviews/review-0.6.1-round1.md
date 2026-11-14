# Disjoint review: 0.6.0 and 0.6.1 (066baa5..08e3f27), all branches

Date: 2026-11-14. Five reviewers worked in parallel, each read-only on its own slice. Each finding was shown by running something unless it is marked otherwise. Probe scripts and logs are archived in `review-0.6.1-evidence.tar.gz` (see `HANDOFF.md`).

## 0. Setup

- **Surface:** every commit on GitHub after 066baa5 (0.5.0):

  | Commit | Branch | What |
  |---|---|---|
  | e409dd1 | main | Review of 0.5.0, round 1 (register) |
  | 0a651e3, ea0bc78 | v0.6.0-fixes-enhancements | 0.6.0: fixes F-01..F-35, enhancements E-01..E-12 |
  | 08e3f27 | v0.6.1-fixes | 0.6.1: fixes of the 0.6.0 review F-01..F-28 |

  Each branch builds on the one before, so 066baa5..08e3f27 covers all three.
- **Slices:** 42 files, each owned exactly once (`check_slices.py`). `dist/FloodSimulator.html` was added to the page slice because the manifest makes claims about it, although the file itself is unchanged in the range.

  | Slice | Files |
  |---|---|
  | engine | `flood2d.js`, the solver, guard, sources, velocity and lakes tests, `tools/stress_grid.js`, `tools/gpu_benchmark.md`, `CLAUDE.md` |
  | coupler | `couple2way.js`, `src/io/swmm.js`, their tests, `vendor/swmm-wasm` notices |
  | worker | `worker.js`, `model.js`, `results_io.js`, their tests, `python/prep_dem.py` |
  | page | `app.js`, `ui.js`, `index.html`, `help.html`, browser tests, `tools/build.py`, `dist/*`, `README.md` |
  | docs-site | `STATUS.md`, `docs/reviews/`, the site doc, `examples/winter_haven/README.md`, the Winter Haven builder, `tools/check_claims.py` |

- **Prior registers checked:** review-0.5.0-round1 and review-0.6.0-round1 (with their responses), and review-0.5.0-round4 (written against 066baa5, never pushed; carried on this branch).
- **Read-only check:** tracked, untracked and ignored files were the same before and after.
- **Commit hygiene:** no AI attribution in any message. These commits are authored "meifachen", where earlier ones were "Meifa Chen".

## 1. Farthest-traveling items

| Rank | ID | Title | Travel before detection |
|---|---|---|---|
| 1 | P-01 / DS-1 | The committed `dist/FloodSimulator.html` is still the 0.5.0 build (blob 4326135f, sha 36d5d616, unchanged since 066baa5), while the manifest and STATUS say 0.6.1. The ea0bc78 message says "dist rebuilt" | Anyone who opens the shipped app runs 0.5.0, with none of the 0.6.x fixes. Run against it, the browser suite aborts at B4 (6-band export) |
| 2 | ENG6-1 / P-02 | The Courant fix (0.6.0 F-01) does not hold above 0.7. On the T10 dam break the peak is 1.486 ft at Courant 0.95 against about 1.68 ft at Courant 0.9 and below; the moved volume is 0.838× at 1.0. In the page example, pocket peaks reach 10.3–10.7 ft at Courant 0.8–0.95 against 4.67 ft at 0.3 and 0.7. help.html now says the answer is the same up to 0.95 | Peak-depth maps and the GeoTIFF |
| 3 | CPL6-1 | 0.5.0 F-10 "fix" makes combination inlets in sag capture 1.33× too much (2×2 grate + 2 ft curb: 3.944 against 2.958 cfs). SWMM 5.2.4 `getOnSagInletCapture` adds no curb weir along the grate; 0.5.0 was right | Capture → SWMM inflow → depths |
| 4 | CPL6-3 | On-grade interception has no spread limit. Ponded 2 ft deep, an on-grade grate takes 75.5 cfs against 22.8 in sag. SWMM caps the spread at the crown | Same chain |
| 5 | WRK6-1 | A multi-band GeoTIFF DEM is read band-interleaved (100, 1, 101, 1 …); no warning. Predates the range | Every elevation |
| 6 | ENG6-2 | The lake "hold" (0.6.0 F-18) binds only for exactly zero quiet-period inflow; at 1e-6 cfs the 6.67 ft one-chunk jump returns | Lake levels, outfall stages |
| 7 | WRK6-3 / P-03 | Provenance compares a fixed key list. Different Manning n, imperviousness, closed edges or vertical unit (peak 4.66 vs 3.08 ft) give "The two runs used the same settings and input files" | Run comparisons |
| 8 | CPL6-2 | `gaugeRain` multiplies rain by the snow catch factor; SCF 0 now gives 0 in of rain (SWMM: 2.000 in at any SCF; SCF applies to snow only) | Rain on the grid (consumer path is a boundary lead) |
| 9 | DS-4 / WRK6-4 | `tests/fixtures/` is in no commit: `test_model.js` crashes after 37 of 47 checks on a clean checkout (and in CI). "268 checks, all pass" cannot be reproduced | CI and every check after the crash |
| 10 | DS-3 | CI runs neither `test_lakes.js` nor `check_claims.py`, though STATUS and two responses say it does | Lake regressions unseen on push |

## 2. Findings

### 2a. New defects introduced by this work

**Engine**

- **ENG6-3.** The F-18 hold makes every chunk 1 s for a lake whose `lakeInflow` returns zero or a withdrawal: 494 → 28,800 chunks over 8 h. A second idle lake holds the whole run to 1 s. Results are unaffected; each chunk is a SWMM advance in two-way runs.
- **ENG6-4.** The part-full pipe outlet is not SWMM 5.2's orifice. At equal depth SWMM passes 2.28× (0.26 ft), 1.34× (0.86 ft) and 1.10× (1.42 ft) the engine's flow. Run in swmm-toolkit 0.17.0; full-pipe flow agrees.
- **ENG6-6.** Duration above D×V (E-09) adds dt into a Float32 tally: +0.7% to −8.3% over 24–72 h at dt 0.02–0.17 s (emulated accumulator).
- **ENG6-7.** `dvThresh` carries over on a reused solver: a run with no threshold after one with 50 gives 0 s duration.
- **ENG6-8.** `initVel.tvmax`, `dvdur` and `froude` are not size- or value-checked; a short array leaves NaN tails on the GPU (NaN never clears in WGSL) and 0 on the CPU.
- **ENG6-9.** Minor: `stress_grid.js` saves the final depth as "hmax", compares only wet counts, and fails confusingly below 4,000 cells.

**Coupler and SWMM reader**

- **CPL6-4.** No node test sends an on-grade inlet through `makeCoupler`. A mutant that drops `p.onGrade = true` passes all 44 checks. The splash-over polynomial and the depressed-gutter branch never run.
- **CPL6-5.** `onGrade` is read as truthy: "false", "no" and "0" take the on-grade path (API level; the worker parses its own field correctly).
- **CPL6-6 / WRK6-5.** Cross and longitudinal slopes have no range check. 2 and 1 (percent, as SWMM's [STREETS] uses) are accepted: 5.6× low capture in the coupler, −11% delivered to SWMM through the worker. HEC-22 Eq. 4-2 takes ft/ft.
- **CPL6-7.** The 0.6.0 F-05 fix is wrong for CUSTOM sections: SWMM requires `CUSTOM <height> <curve> …`; the test's line `C3 CUSTOM CURVE1` is refused by SWMM (ERROR 203), and a valid line now gives geom1 as the string "2.5". STREET is still zeroed with a warning.
- **CPL6-9.** The depressed curb on grade uses the uniform-gutter share, not HEC-22 Eq. 4-4: 2.108 against 2.246 cfs (6% low). A depression depth without a width is ignored silently.
- **CPL6-10.** On grade, the surcharge head is ignored: 3.088 cfs at lim 1e-6, 0 at lim 0 (the header says the exchange does not jump).
- **CPL6-11.** NOTICE lists `swmm5.wasm`, which is not shipped (embedded in `swmm5.js`).

**Worker, model and results**

- **WRK6-7.** Outlet fields: a rating with crest and length but no `outlet_type` is silently a weir; a pipe ignores stray weir fields; `outlet_cd` alone gives no outlet and no note; two cases of `outlet_type` (first wins); "0x10" read as 16.
- **WRK6-8.** The vertical-unit hint ignores VerticalUnitsGeoKey 9036 and 9030 and does not report a conflict between the GeoKey and UNITTYPE. With a plain and a GDAL `role="unittype"` item, it takes the first; GDAL takes the role item.
- **WRK6-9.** `prep_dem --zunits` writes a plain UNITTYPE item, not GDAL's band unit; other GIS tools do not see it.
- **WRK6-10.** `tvmax` uses 0 for "never moved" where `tmax` uses NaN.
- **WRK6-11.** Buildings given as LineStrings give 0 footprints with no warning; sheds smaller than a cell are blamed on the coordinate system.
- **WRK6-12.** A null geometry crashes prep_dem's line-delimited reader (also on base).

**Page**

- **P-04.** Hashes of inputs that were cleared stay in the provenance (`out` after loading a new .inp).
- **P-05.** The recorded "SHA-256 of the input file" is of the decoded text: a BOM is stripped, and two .inp files differing in one Latin-1 byte get the same hash.
- **P-06.** README, the `#x-tif` tooltip ("Six-band") and the button label still describe a fixed band count.
- **P-07.** Results saved before 0.6.1 render "outlet outlet:" in the lakes table.
- **P-08.** The browser stamp takes the version from the manifest and the sha from the file, and never compares them; it read "app 0.6.1, dist sha256 36d5d616" on the 0.5.0 build.

**Docs, site and the claims gate**

- **DS-2.** `check_claims.py` ties the browser log to the dist file, not the dist to the source. A one-character sha prefix passes. A log with `FAIL B20` and a traceback passes. The B20 regex is not anchored to B20. No log: SKIP, exit 0.
- **DS-6.** The pack README describes per-file "measured or supplied" flags and an inventory reconciliation that `build_report.json` does not contain.
- **DS-7.** `--outlets` CSV handling:
  - A UTF-8-BOM file or a capitalized "Lake" header yields no outlets while the report says user-supplied outlets.
  - `nan` is written as bare NaN (invalid JSON).
  - Node "0412" becomes 412.0.
  - With `--routed --outlets` the notes say both "no outlet" and "outlets written".
- **DS-9.**
  - Maude's NGVD 29 figure is now −0.50, from rounded values; the build report gives −0.51.
  - The 0.4.1 vs 0.4.2 inlet volumes are quoted in reverse order.
- **DS-10.** The fail-first base named in response-0.6.0 (3a54427) does not exist; 0.6.0 is ea0bc78.
- **DS-11.** STATUS says Winter Haven lakes were routed "with no outlet or a weir"; no weir run exists.
- **Repo-content decision (process).** examples/winter_haven/README.md says to "commit the generated files and build_report.json here" when a regeneration completes. That would add City of Winter Haven data to the public repo, which CLAUDE.md lists under "always ask" and which has not been decided.

### 2b. Fixes that stop short

- **ENG6-1 / 0.6.0 F-01.**
  - Above Courant 0.7 the scaling makes things worse: at 0.9 the moved volume is 1.098× (0.6.0: 1.086×), and at 1.0 the error doubled (0.918× → 0.838×).
  - With θ0 = 0.6, Courant 0.9 gives a 3.92 ft peak from a 3 ft dam.
  - T10 samples only 0.95, where the distorted answer lands near the reference volume.
  - The code uses dt/(0.7·dtWave) above and 0.63 below, not the single factor the response describes. At 0.7 and below, results are bit-identical to 0.6.0 (held).
- **ENG6-2 / F-18:** see §1.
- **WRK6-3 and P-03 / 0.6.0 F-03.**
  - Settings not recorded: cellSize, vUnitFt, useBuildings, roofToGround, closedEdges, imperv, nImp, nPerv, Green-Ampt values, lcTable, soilTable, wetFt, buildingFt, searchFt.
  - `provDiff(null, null)` returns `[]`, so "unknown" reads as "identical".
  - Two inputs of one kind collapse to one.
  - The softer wording the register suggested ("the recorded settings agree") was not adopted.
- **CPL6-8 and WRK6-6 / 0.5.0 F-09.** The search radius is `ceil(searchFt/dx)` cells, so with searchFt 30 an outfall or node 36 ft away (12 ft cells) or 50 ft away (50 ft cells) is accepted. The F-09 check passes the cell count directly.
- **WRK6-2 / round-4 WRK5-2.** An outlet below the stage-area table's bottom is still accepted, now for all four outlet kinds. The engine holds the lowest row's area below the table: a pipe at 40 ft released 847,536 cf from a table holding 487,872 cf.
- **DS-5 / 0.6.0 F-08.** The Winter Haven regeneration is not blocked. The builder's SDA query answered in 0.6 s on 2026-11-14, and a full run finished in about 2 minutes. Its report matches the 2026-11-10 report on every check except one added field and two corrected labels. The response said no completed report existed; four exist in the review workspace.
- **DS-8 / 0.6.0 F-09.** STATUS line 27 still says the gate covers "the figures quoted in this file". Several ungated figures have drifted:

  | Check | STATUS | Measured |
  |---|---|---|
  | C4 | 15,356 vs 28,551 cf | 15,316 vs 135,450 cf |
  | W9 | 13,678 vs 13,692 cf | 36,588 vs 36,590 cf |
  | B12 | 88,557 vs 88,563 cf | 274,646 vs 274,667 cf |

- **P-08 / 0.6.1 F-10:** see §2a.

### 2c. Prior findings still open (re-run at 08e3f27)

From the unpushed round-4 register (066baa5), all still reproduce:

- **Engine:**
  - ENG5-1, deep-pit sibling: one 40 ft still pit cuts the T10 volume from 54,801 to 50,570 cf.
  - ENG5-2: a −5e6 cf withdrawal ends at −14,281,845 ft and is accepted.
  - ENG5-4: falling-area tables are accepted.
  - ENG5-3 held: overtopping is accepted again.
- **Coupler:**
  - CPL5-F1: the final outlet release spikes to 603.65 cfs.
  - CPL5-F2: lake-outlet volumes are unchecked.
  - CPL5-F4: `ccw: null` is refused while `cco: null` is accepted.
  - CPL5-F5: unused bad values are kept.
  - CPL5-F6: `finish()` throws a TypeError.
- **Worker:**
  - WRK5-1: a concurrent load rollback undoes a later load.
  - WRK5-3: soils fields given in two cases.
  - WRK5-4: EPSG changes are not guarded against soils polygons.
  - WRK5-5: the "Routed lake" label on unrouted boundaries.
  - WRK5-6: hex text is read as numbers.
- **Page:** WRK5-8 is answered: the page sends `epsg` as a number.
- **0.5.0 round 1:** F-03 (CI coverage) is still open (DS-3).

## 3. Weak tests

- **T10** samples one Courant number (0.95) and pins the worsened 1.0 value.
- **L20** uses exactly zero quiet inflow, the only value at which the hold binds.
- **C19** never goes through `makeCoupler`; the on-grade mutant survives.
- **C10** and the new 3.9436 check pin the code's own combination formula.
- **The 0.6.0 F-05 test** uses a CUSTOM line SWMM refuses.
- **The F-09 checks** (coupler and model) pass the radius in cells.
- **W17** tests the gate only as a refusal.
- **W18** checks only two of the on-grade fields.
- **No test covers `prep_dem.py`.**
- **B16** waits for "Could not open", so a wrongly accepted file times out instead of printing FAIL (still exits 1).
- **The browser stamp and check_claims** do not tie dist to source (P-08, DS-2).

## 4. Unverified suspicions

- No owned test emulates the WGSL code or compares back ends since tvmax/dvdur were added. The CLAUDE.md agreement figures predate that change.
- `g.theta` and the constructor `dvThresh` are not validated.
- On-grade fields are left out of `c.inlets`, so they may not reach provenance or the page.
- The 5,778,824 B in STATUS was not reproduced: two fresh builds gave 5,779,748 B (Python/zlib dependence, as build.py now says).

## 5. Defences that held

- **On-grade equations.** Undepressed gutter, spread inside the street, against the SWMM 5.2.4 engine (capture %):

  | Inlet | SWMM | Code |
  |---|---|---|
  | Curb 10 ft, T 10 ft | 56.27 | 56.2 |
  | Curb 5 ft, T 8 ft | 38.48 | 38.43 |
  | P-50 grate 3×2, T 8 ft | 68.16 | 68.08 |
  | P-50 grate 3×2, T 15 ft | 43.86 | 43.74 |

- **Outlets:**
  - The rating stall (F-16) is fixed: a rating that jumps at its control now drains, and a steep rating conserves volume to 16 cf in 360,000 cf.
  - Pipe and rating return dq = 0 at and below the control (F-17).
  - Gate regimes are continuous.
  - Full-pipe flow is 41.67 cfs at the crown (orifice equation, Cd 0.6, D = 3 ft).
- **Worker and model:**
  - UNITTYPE round trips (F-11) work for 18 files from prep_dem and rasterio.
  - Unknown unit names are now reported (F-13).
  - A site plan read as lon/lat now warns (F-12).
  - A MultiPolygon straddling the box edge is kept (F-30).
  - `dvThresh` refuses 7 of 7 bad inputs.
  - Infinite outlet sizes are refused.
  - `on_grade` "false" is read as false.
- **SWMM reader:**
  - dateAt equals times in all periods, including a 14,815-period run with a 7:13 report step (F-31).
  - Named warnings work (F-29).
  - `.out` nodes carry no type (F-14).
- **Page:**
  - Provenance round-trips through save and reopen.
  - A 0.5.0 file compares with a 0.6.1 file.
  - The EPSG entry keeps the DEM hash.
  - The help, README and test-list fixes from 0.5.0 round 1 hold.
- **Rebuilt dist:** rebuilt from source at 08e3f27, the browser suite prints ALL PASS (80 checks). B20 = 55.5367 ft on CPU and GPU, and the claims gate passes on that log.
- **Site doc:** the Winter Haven counts (145 pipes, 162 nodes, 84 inlets, 15 + 6 outfalls, 9 inverts above ground) and the section 7 table reconcile with the run files.

## 6. Fail-first

As reported by the reviewers:

- **Fail on 066baa5:** T9, T10, L14–L20, C19, W17, W18 and R-C3. W17 and R-C3 fail as crashes on missing functions.
- **Fail on base model.js:** the new test_model checks (F-09, F-11, F-12, F-13), shown with regenerated fixtures only.
- **New functions (they crash or are absent on 066baa5):** on-grade inlets, the rating, pipe and gate outlets, provenance and dvdur.
- **Not gated:** the browser checks were not run against 0.5.0.

## 7. Boundary leads not settled

- Who consumes `gaugeRain` and `link.geom1` (CPL6-2, CPL6-7)?
- Does two-way SWMM give routed lakes a small baseflow (ENG6-2) or wire `lakeInflow` to idle lakes (ENG6-3)?
- Is any solver reused across runs in the worker (ENG6-7)?
- Do the worker defaults for `drainInHr` and `dtMax` equal the 0 and 5 that provenance records?
- Could a reloaded 6- or 8-band results GeoTIFF be loaded as a DEM (WRK6-1)?

## 8. Not covered

- The GPU back end in Node.
- Phone width and dark theme for the new controls.
- On-grade flows through the page.
- SI models with the new outlets.
- Several routed lakes with outlets at once.
- 8M-cell stress runs (200k cells only).
- `--lake-levels city` and `--routed` regenerations.
- The 0.4.3 Winter Haven rerun figures: the run files are on the laptop only.
