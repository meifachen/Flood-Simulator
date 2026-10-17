# Disjoint review: Flood Simulator 0.3.0 (2c04c24..9bc7ac3), Round 1

Reviewed 2026-10-17. Review only: no code was changed in this round.

## 0. Setup

**Slice map.** `check_slices.py` confirmed that each of the 31 changed files belongs to exactly one slice. No files outside the diff were added.

| Slice | Files | Reviewer |
|---|---|---|
| engine | 2: flood2d.js, test_velocity.js | agent E |
| model-landcover | 11: model.js, test_landcover.js, test_model.js, landcover reference script and generator, 6 example land cover and soils files | agent M |
| coupler-inlets | 4: couple2way.js, test_couple2way.js, make_inlets_example.py, inlets.geojson | agent C |
| worker | 1: worker.js | agent W |
| app-ui | 3: app.js, index.html, help.html | agent A |
| results-build-docs | 10: results_io.js, test_app.py, build.py, dist, README, STATUS, CI workflow, two example.json | agent R |

**How it was run.**

- **Prior register:** none. This is the first review of this project, so §2c is empty.
- **Run mode:** six agents in parallel, all read-only, each in its own git worktree.
- **Follow-ups:** boundary leads went back to the slice that owns the file: three to app-ui, one to worker, two to coupler-inlets.

**Departures from the review method.**

- The browser suite (`tests/browser/test_app.py`) was not run through the fail-first gate. At the base commit, the built page lacks the inputs the new checks use, so every new browser check would fail on missing elements: that tests the symbol, not the behavior. It was run at HEAD only, where it passes 42 of 42 (twice: once in the release run, once by agent R).
- The node tests print PASS/FAIL lines rather than JUnit. A small wrapper (`nodejunit.py`, kept in the review scratch folder) turned those lines into JUnit so the gate could give a verdict per check.

## 1. Farthest-traveling items (across groups)

| Rank | Group | ID | Title | Travel before anyone notices |
|---|---|---|---|---|
| 1 | 2d | W9 | After the 2D run ends, SWMM keeps receiving each inlet node's last captured inflow until SWMM ends | SWMM .rpt, .out and every node result after the 2D end. Example: 104,326 cf extra against a tally of 4,536 cf. SWMM continuity still closes, so nothing flags it |
| 2 | 2a | W1 | A refused land cover file stays active in the worker; the status still shows the old layer | Roughness and imperviousness in every map, the GeoTIFF and reports |
| 3 | 2a | AU-1 | Opening saved results during a run mixes the two runs; the exported GeoTIFF has the wrong maxima | GeoTIFF with a valid CRS and plausible name goes straight to GIS |
| 4 | 2a | C-F1 | A listed inlet without `rim_ft` uses the cell ground as its crest; a default inlet uses the SWMM rim | 17.7× capture difference at the same spot and size. Mass balances, so no check shows it |
| 5 | 2d | C-S2 | Weir/orifice switch at head = rim is decided by a 7e-15 ft rounding; the two branches differ 7.4× there | SI model sends 2.2× the US model's water to SWMM for the same site |
| 6 | 2a | M-F1 / AU-4 | Default IMD 0.3 for soil groups C and D is above the Rawls bound; help says the values are Rawls | +36% infiltration on D soils (checked with SWMM 5.2.4). Flood extents come out too small |
| 7 | 2a | E1 | Start-up transient is stamped into vmax and dvmax at point inflows | D×V hazard map shows 10.7 ft²/s where theory gives 1.0 |
| 8 | 2a | E2 | Speed is capped at critical, so vmax is 19–50% low on supercritical slopes | Velocity map and KPI on steep, smooth streets |
| 9 | 2a | W4 / AU-Q5 / M-F3 | Land cover that does not overlap the grid is used silently (0 cells, no warning) | Status says loaded; the run uses global values everywhere |
| 10 | 2a | W2 / AU-Q1 | A refused inlets file replaces the worker's inlets; status still says "14 inlets" | The run captured through 0 inlets (or through the refused file's valid ones) |

## 2. Findings

### 2a. New defects introduced by this work (ranked by travel)

**W1. A refused land cover file stays active** (worker.js L51–53, with app.js `loadInputs`). FINDING.

- `LCR` is assigned before the "too many distinct values" check throws.
- The app keeps showing the previous layer's classes. The next Build uses the refused raster: `landcoverCells 4984`, plus a warning listing classes 0 to 149.
- Evidence: `worker/h/t5.js` (`landcoverCells 0` before, 4788 after the refusal) and `app-ui/probe2/q2.py` (end to end in the built page).

**AU-1. Opening results during a run** (app.js `openResults`, no `S.running` guard). FINDING.

- When the run finishes, `S.final` is the new run's (640,000 cells) while the grid is the opened file's (106,800).
- The exported GeoTIFF band 1 differs in 8,689 cells; maximum depth reads 0.32 ft against 5.34 ft.
- Evidence: `app-ui/probe/p5.py` and `cmp.py`.

**C-F1. A listed inlet's crest datum differs from a default inlet's** (couple2way.js). FINDING.

- Default inlets use `rim = elev + maxDepth`. A listed inlet without `rimFt` uses `null`, which falls back to the cell ground `z`.
- At J4 with the rim 0.48 ft above ground: capture is 0.378 cfs (default) against 6.690 cfs (listed). `rimFt` set to the manhole rim gives 0.378 again.
- The shipped `inlets.geojson` has no `rim_ft`. Rim and ground agree to 0.02 ft in the example, so no test can see the difference: mutant m3 (fallback changed to the manhole rim) passes the whole suite.
- Evidence: `coupler-inlets/probes/p4.js`, `out_m3_rim_manhole.txt`.

**M-F1 / AU-4. IMD 0.3 for groups C and D** (model.js HSG table; help.html, index.html). FINDING.

- Authority: Rawls et al. (1983) table in the SWMM 5 manual, Appendix A.
  - Sandy clay loam (C): porosity − wilting point = 0.262.
  - Clay loam (D): porosity − wilting point = 0.277.
  - Porosity − field capacity = 0.154 for both.
- SWMM 5.2.4 run, D soil: 0.487 in infiltrated at IMD 0.3 against 0.359 in at 0.154 (+36%). The 2D ledger matches SWMM in both cases (0.4858 / 0.3580).
- The help text calls the starting values Rawls values; Ks and suction are, IMD is not.
- Evidence: `model-landcover/scripts/swmm_ga.py`, `ga_ledger.js`.

**M-F2. NLCD n for classes 11 and 82 is not in Kalyanapu et al. (2009)** (model.js L74–78). FINDING.

- Table 2 of the paper lists 21, 22, 23, 24, 31, 41, 42, 43, 52, 71, 81, 90 and 95. The other 13 values match exactly.
- Open water 0.040 and cultivated crops 0.037 have another source, or none.
- For comparison, the FHWA table in the SWMM manual gives 0.06–0.17 for cultivated soils.
- Caveat: the paper was read through WebFetch only.

**E1. Start-up transient in vmax and dvmax** (flood2d.js simulate, with the new maxima). FINDING.

- V1 channel, step inflow of 50 cfs: peak D×V is 10.73 ft²/s with the defaults, 1.24 with `chunkSec` 5, and 1.00 with a ramped inflow. Theory gives q = 1.0.
- The cause predates this commit: base hmax shows the same 3.35 ft. But the new hazard map carries it, at 10.7× against hmax's 7×.
- V1 averages only the middle third of the channel, which hides it (the spike covers columns 1–37).
- Authority: Manning normal flow and the kinematic wave (depth rises monotonically to normal depth, so max D×V = q).
- Evidence: `engine/mut/dtdep.js`, `where.js`, `dtdep_base.js`.

**E2. vmax capped at critical speed** (flood2d.js face limiter `qm = h·sqrt(g·h)`, pre-existing). FINDING against the new velocity output.

| Slope, n | Froude | Speed error |
|---|---|---|
| S = 0.005, n = 0.03 | 0.54 | 0.0% |
| S = 0.01, n = 0.015 | 1.39 | −19.5% |
| S = 0.05, n = 0.015 | 2.86 | −50.4% |

- V1 tests only a subcritical case. D×V is unaffected because it equals q.
- Evidence: `engine/mut/chan.js`.

**W4 / AU-Q5 / M-F3. Land cover or soils that miss the grid are used silently.** FINDING.

- `lc_far.tif` (no overlap) loads with the message "classes 41" and builds with `landcoverCells 0` and no warning.
- `landcoverCells` and `soilCells` are never shown in the UI.
- The builder also accepts wrong-length `lcClass` and `hsg` arrays without a warning (M-F3).
- A DEM with no CRS plus land cover in EPSG:4326 is sampled in raw coordinates (W4a).
- Evidence: `worker/h/t8.js`, `app-ui/probe2/q.py`, `model-landcover/scripts/probe.js`.

**W2 / AU-Q1. A refused inlets file.** FINDING.

- `INLETS` is set before the missing-node check throws.
- The app keeps showing "14 inlets on 7 junctions". The run used 0 inlets in A's probe, or the refused file's valid inlets in W's probe (`weir_length_ft` 20 from the refused file was used).
- Evidence: `worker/h/t6.js`, `t8.js`, `app-ui/probe2/q3.py`.

**AU-2. An opened results file shows the current panel parameters, not the saved run's.** FINDING.

- The file holds `grid.opts` (imperv 0.77, lcTable class 11 n 0.2), but the panel shows 40% and 0.04.
- help.html says opening shows the run "with the same maps, charts and exports"; the parameters are not restored.
- Evidence: `app-ui/probe/p2.py`.

**C-F2. An inlet may sit any distance from its junction.** FINDING.

- Inlets 781–1,044 ft from J4 are accepted with no warning.
- Evidence: `coupler-inlets/probes/p2.js`.

**C-F3. A rejected listed inlet is silently replaced by a default inlet.** FINDING.

- The header comment says default inlets go to "junctions without an inlet in the list".
- In the probe, the warning says "inlet ignored" while J4 still gets a default inlet (`inlets: 1`).
- Evidence: `p1.js` case i.

**W3. Standard lon/lat GeoJSON inlets (no `crs` member, RFC 7946) are not reprojected.** FINDING.

- `geojsonCrs` finds no coordinates in Point features, so it returns "same".
- The inlet is then dropped with a "no open cell" warning. Polygons and CRS84-tagged files work.
- Evidence: `worker/h/t6.js`, `t7.js`.

**AU-3. A DEM that fails to load still wipes table edits and site state.** FINDING.

- `S.lcTable`, `S.soilTable`, `S.bspec` and `S.exName` are nulled, and all file inputs are blanked, before the load succeeds.
- Evidence: `app-ui/probe/p3.py` case B.

**W6. Soil raster codes outside 1–4 are dropped without a count or a warning** (the polygon path warns). FINDING.

- In the probe, `soilCells` was 13,300 of 26,600 with no warning.
- Evidence: `worker/h/t8.js` E.

**E5. A hot start carries hmax over but restarts vmax and dvmax at 0.** FINDING, latent.

- No caller passes `init` (worker follow-up Q2).

**Low travel (each demonstrated):**

- **W7:** cell size below the DEM resolution with land cover loaded gives "Invalid typed array length: Infinity".
- **W8 / C-F5:**
  - Bad inlet values pass the load and are refused only at Run (NaN, negative).
  - `co = 0` is accepted and silently captures 0.
  - `lw: "4"` is refused with the message "lw 4 is not a valid number".
  - A numeric `node: 0` is refused.
  - The error index counts after non-Point features are filtered out.
  - MultiPoint features are dropped silently.
  - `rim_ft` has no plausibility check (an SI value in metres was accepted).
- **M-F4:** the builder accepts n = Infinity and blank-as-zero. The app's table editor refuses these first (HELD), except Ks = 1e300.
- **M-F6:** `hsgCode("1")` returns 0, and fractional codes round silently.
- **M-F7:** `readRaster` lacks the ±1e20 NoData guard that `readDEM` has.
- **R-F3:** `RIO.unpack` trusts the header's array lengths and types. A hand-edited header with a negative length or wrong type opens and shifts arrays.
- **AU-5:** after an open, Run is re-enabled by a units change and then fails with "Load a DEM first".
- **AU-6:** loading an example does not clear the `#f-inl` file name.
- **AU-Q4:** inlets loaded before a `.inp` are not drawn.
- **C-F6:** the generator docstring says 30 ft; the actual offset is 33.11 ft.

### 2b. Fixes that stop short of their stated generality

| Fix / claim (commit 9bc7ac3) | Sibling case tested | Result | Evidence |
|---|---|---|---|
| "Bad input is refused" (CLAUDE.md) for land cover, soils and inlets | Refusal followed by Build or Run | Refused data is still used (W1, W2) | t5, t6, q2, q3 |
| "New DEM clears previous site layers" | `#f-dem` success path | HELD end to end: nulls are sent to the worker, and the build shows 0 old cells | q4.py |
| (same) | DEM load that fails | Clears table edits and state anyway (AU-3) | p3 B |
| (same) | `worker.load({dem})` alone | Does not clear `LCR`, `INLETS` or `BLD`. Latent; the app never sends it | t8 C |
| "Unknown classes are reported" | Soil raster codes; zero-overlap land cover | Not reported (W6, W4) | t8, q.py |
| "Save/open .fsim.gz" | Two-way run; four views; all charts | HELD | R probe2, probe3 |
| (same) | Panel parameters; open during a run | Not restored (AU-2); mixes runs (AU-1) | p2, p5 |
| "Invalid sizes refused" | `co = 0`, `rimFt`, distance to node | Accepted (C-F2, C-F5, W-Q3) | p1, p2, t11 |
| "Default inlets only where none is listed" | Listed inlet rejected | Default inlet added (C-F3) | p1 i |
| Closed edges, "no rain on the ring" | Code | HELD (balance closes, edges closed) | M mutants M10, M12 killed |

### 2c. Prior findings still open

None. This is the first round.

### 2d. Pre-existing defects newly found

| ID | Where | Present at base? | Travel |
|---|---|---|---|
| W9 | worker.js L191 `advance(1e12, [])` with couple2way.js: NODE_LATFLOW is never zeroed when coupling stops | Yes. Identical output at 2c04c24 (coupler follow-up 2, `p9.js`): 108,856 cf external inflow against 4,530 cf when zeroed; the extra matches 7 × 0.72 cfs × 20,700 s | Farthest of all. Every two-way run whose 2D end is before the SWMM end |
| C-S2 | couple2way.js sourceAt: `Hn <= rim` weir, else orifice; the branches do not meet at Hn = rim | Regime code predates 0.3.0; not executed at base | SI against US: 2.2× the water sent to SWMM |
| E6 | flood2d.js GPU reset writes `bRat` without COPY_DST, so WebGPU raises a validation error on every run | Yes (line unchanged) | Low: the ratios are recomputed every step; GPU = CPU |
| E1, E2 mechanisms | step-size start-up, critical-speed limiter | Yes (hmax 3.35 ft at base) | Listed in 2a because the new outputs carry them |

## 3. Weak tests

| Test | Shape | Mutation that still passes, or gate verdict | Evidence |
|---|---|---|---|
| test_velocity V3 | Fixture never binds: deepest 0.0104 ft; also reads VEL_H from the module under test | Passes for any VEL_H from 0.0105 to 0.45, and with velocity recording deleted | engine/mut/sweep.js |
| test_velocity V1 | One point of agreement: uniform steady flow, middle third only | Survives: last value instead of max; one face only; no reset; x only; +4%; VEL_H 0.011 | engine/mut/run.js |
| test_landcover tables | Expected values built from `M.NLCD` itself | Survives changed NLCD values (M14, M15); misaligned cls (same array on both sides) | mut_lc.txt |
| test_landcover sampling | Fixture padded, no NoData | Survives the bounds check removed (M1) and the NoData mapping removed (M3) | mut_lc.txt |
| test_landcover soils | Validation and IMD not pinned | Survives M5, M7, M8, M13 | mut_lc.txt |
| test_model closed edges | Asserts closure only | Survives wall-without-noData (M11): rain 476,408 cf, the same as closed edges off | mut_model.txt |
| test_couple2way C4 | All inlets in distinct cells; rim ≈ ground | Survives the per-cell cap removed (m2) and the rim fallback changed (m3) | out_m2, out_m3 |
| test_app B16 | Claims "maps, KPIs"; checks maxima only (`kp0`/`kp1` unused) | A reopen that zeroes every frame passes | mutant_frames.html, b16_harness.py |
| test_app B4 band 5 | `>= 0` only | Band 5 := 0, := band 4, or := band1×band4 all pass | probe4 |

## 4. Unverified suspicions

- **E:** with fine steps, a step inflow still gives about 1.7× Manning speed at the wet front. Physical bore or numerical? A full shallow-water reference would settle it.
- **C:** an inlet away from its node switches to orifice mode when the node head is between the inlet ground and the manhole rim, so no backflow comes out of it. Realism not judged.
- **M-U1:** real MRLC NLCD GeoTIFFs may carry a user-defined Albers projection with no EPSG code. Demonstrated that such a file returns `epsg` null and `proj4` null; not demonstrated on a real download.
- **R-U1:** non-finite numbers in the results header save as `null` and display as 0 after reopening. No real run producing NaN was found.
- **A:** the velocity KPI uses no wet mask and the exported bands use `hmax > 0`, while the map uses `hmax >= wet`. They agreed on the example; another site could differ.

## 5. Defences that held

| Slice | Defence | Inputs tried | Outcome |
|---|---|---|---|
| E | GPU = CPU for velocity | V1 channel, SwiftShader | 9.6e-5 ft/s |
| E | Reset clears the maxima; vec4 source packing when a source switches off | Reuse after a 50 cfs run; pulse cut at 0.5 h | Both held |
| E | VEL_H gate | US and SI examples | First velocity at h = 0.0502 / 0.05006 ft |
| M | Ks and suction against Rawls / SWMM | 4 groups, SWMM 5.2.4 | Within 0.3% |
| M | 13 Kalyanapu n values; NLCD impervious midpoints | Paper Table 2; MRLC definitions | Exact |
| M | Sampling and rasterizing against pyproj/rasterio | US and SI | 26,600 / 26,600 cells |
| M | Dual groups → D; junk HSG values refused | B/D, A/D, C/D; "", "/", "AB", "E", null, true | All as intended |
| M | Fixtures regenerate byte for byte | Both examples | Identical |
| C | Shared per-cell cap | 1, 2, 3 inlets in one cell | Total 0.12 cfs each time |
| C | Bad positions, unknown nodes, Infinity and negative sizes | 6 position cases; outfall and storage nodes | Refused or warned |
| C | SI/US unit consistency | J4 at 0.3 and 0.6 ft | Identical capture |
| C | Tally consistency; generator coefficients | perInlet sum = LATFLOW = 2D captured; TxDOT / HEC-22 | Hold |
| W | Sampling grid = built grid; closed edges unchanged against base; transfer buffers; source/rate alignment; rim_ft passed | 8 cell sizes; hashes; 3 inlet configurations | All held |
| A | New DEM clears all layers end to end (worker receives nulls) | Example 0 → SI DEM → SI inp → run | 0 old cells, no old inlets |
| A | Table editor refuses blanks, Infinity, 1e400, out-of-range values | 7 inputs | All refused (gap: Ks 1e300) |
| A | "Take no water" option exists and is honored | def-inl = 0 | 0 inlets |
| R | Save/open fidelity, one-way and two-way | 4 views, 4 charts, .rpt/.out/GeoTIFF/CSVs by sha256 | Identical |
| R | Band 5 is time-coincident max(h·v) | dvmax ≤ hmax·vmax | Strict in 1,104 of 2,059 cells |
| R | Bad results files refused, earlier results kept | Truncated, trailing junk, empty, fractional length, wrong N, 3 suite cases | All refused |
| R | Build reproducible; CI node list passes | Rebuild at 9bc7ac3 | Same SHA; 8/8 pass |

## 6. Fail-first and no-regression gates

**Fail-first.**

- Command: `prove_tests_fail_first.py --range 2c04c24..9bc7ac3 --tests test_velocity.js test_landcover.js test_couple2way.js test_model.js --cmd 'python3 nodejunit.py {junit} {tests}' --link tools/node_modules`
- Base mode: range. Repeat: 1 (deterministic CPU tests).

| Test (new in 0.3.0) | At base | At HEAD | Verdict |
|---|---|---|---|
| test_model: closed edges with rain | FAIL: edge outflow 218,522 cf | PASS | PROVEN |
| test_velocity V1–V3 | crash: `vmax` undefined ("reading '466'") | PASS | NO-RESULT from the gate; in substance SYMBOL-ONLY |
| test_landcover (9 checks) | crash: `landcover_reference.json` absent (a data fixture added in the range, not carried); the functions are also absent at base | PASS | SUSPECT from the gate; in substance SYMBOL-ONLY |
| test_couple2way C4 (6 checks) | crash: `c.inlets` undefined (`findIndex`) | PASS | SUSPECT from the gate; in substance SYMBOL-ONLY |
| test_couple2way C3 (existing check) | not reached (crash at C4) | PASS | collateral of the crash |

- Counts: PROVEN 1, SYMBOL-ONLY in substance 18, UNPROVEN 49.
- The 49 UNPROVEN are pre-existing checks in the two modified test files. They passed at base, as expected; they are not new tests.
- The behavior strength of the symbol-only tests is measured by the mutations in §3.

**No-regression.**

- The six node suites that existed at base were run in their base version at base and at HEAD.
- Result: HELD 123, REGRESSED 0.

**Browser suite.** HEAD only: 42/42. Not gated at base; see §0.

## 7. Boundary leads

| Lead | Raised by | Crosses into | Routed to | Outcome |
|---|---|---|---|---|
| Does the app clear the worker's layers on a new DEM? | W | app.js | A | HELD (nulls sent) |
| After a refusal, is the layer marked unloaded? | W, A | app.js / worker.js | A, W | FINDING (W1, W2) |
| Are table blanks or strings passed to the builder? | M | app.js | A | HELD (gap: Ks 1e300) |
| Are landcoverCells / soilCells shown? | M, W | app.js | A | FINDING (W4 / AU-Q5) |
| Is rim_ft passed to the coupler? | C | worker.js | W | HELD |
| Any caller using `init`? | E | worker.js | W | none, so E5 is latent |
| NaN or negative inlet sizes at run time | W | couple2way.js | W (run) | Refused; `co = 0` accepted |
| SI units in the coupler | R | couple2way.js | C | HELD; found C-S2 |
| `advance(t, [])` semantics | W | couple2way.js | C | FINDING W9, present at base |
| Engine always in ft for SI? | E | model / app | R (H4) | HELD |
| `rates()` alignment with sources | C | worker.js | W (H4) | HELD |
| "None" inlet option; README wording | R | index.html | A | HELD (option exists); README wording minor |
| Kalyanapu attribution in docs | M | help.html | A | A raised it independently; attribution in help confirmed |

No lead is left unrouted.

## 8. Read-only check

The repo state (`git status --ignored` plus size and mtime of every ignored file, 2,012 lines) was identical before launch and after every agent, follow-up and gate run. No stray worktrees remain.

## 9. Not covered

- **Hardware and environment:**
  - Real GPU hardware; all GPU runs used SwiftShader.
  - The work PC's browser.
  - CI on node 20 and on GitHub.
  - Online basemaps.
- **Data and scale:**
  - Real NLCD or SSURGO downloads.
  - Large grids, including results files near the 8M-cell limit.
  - Multi-band land cover.
  - Overlapping or holed soil polygons.
  - Soil GeoTIFF upload in the browser.
- **Physics:**
  - A convergence study of velocity at the wet front.
  - Velocity at bends and corners.
  - Kalyanapu n values at the depths this model produces.
- **Specific paths:**
  - A new DEM loaded during a run, or after opening results.
  - Stopped runs and GPU runs saved to file.
  - A refused soils file.
  - Partial land cover overlap.
- **Process:** the browser suite was not run through the fail-first gate.
