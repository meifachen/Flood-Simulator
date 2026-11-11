# Disjoint review: 0.3.3 and 0.4.0 (f3aa98e..d8a5da7), round 1

Date: 2026-11-11. Five reviewers worked in parallel, each read-only on its own slice. Each finding below was shown by running something. The probe scripts are kept in the session scratchpad, under `rev2/work/<slice>/`.

## 0. Setup

| Slice | Files | Owned paths |
|---|---|---|
| engine | 2 | `src/engine/flood2d.js`, `tests/node/test_lakes.js` |
| coupler | 2 | `src/core/couple2way.js`, `tests/node/test_couple2way.js` |
| worker | 2 | `src/app/worker.js`, `tests/node/test_worker.js` |
| page | 10 | `src/app/{app,ui,results_io}.js`, `index.html`, `help.html`, `tests/browser/test_app.py`, `tests/node/test_results_io.js`, `tools/build.py`, `dist/*` |
| site | 5 | `python/compare_icpr_winter_haven.py`, `python/make_winter_haven_demo.py`, `docs/sites/winter-haven-lake-martha.md`, `STATUS.md`, `README.md` |

- **Coverage:** 21 of 21 files are owned exactly once (`check_slices.py`). No files outside the diff were added.
- **Prior register:** none for this range. The 0.3.0 register was closed in 0.3.1.
- **Run mode:** parallel agents. Each got one follow-up round for the leads other slices raised (§7).
- **Departures:**
  - The fail-first gate could not isolate the coupler tests one block at a time (§6).
  - Probe evidence from the reviewers and one isolated script from the commit stand in for that.

## 1. Farthest-traveling items

| Rank | Group | ID | Title | Travel before detection |
|---|---|---|---|---|
| 1 | 2a | CPL-F1 | Water flowing back into SWMM from a routed lake is added to the lake | Lake level, outfall stage, the flooding around the lake and the peak-depth maps. C11 compares two copies of the same wrong number |
| 2 | 2a | ENG-E3 | Routed lake levels oscillate between chunks and depend on chunk size, and can fall below the lake bed | The level series, the peak, the outfall stage and the saved results. The water balance still closes |
| 3 | 2d | CPL-F3 | SWMM gets the inlet volume over its own routing step, not over the coupling interval, when the two are out of step | SWMM's flows and flooding, and the coupled .rpt. The tally disagrees with the report by up to 100% |
| 4 | 2a | WRK-F2 | An inventory's `type` field makes an inlet generic with no message, and W10 cannot catch the old bug | Every Winter Haven run: 84 inlets are modelled as generic |
| 5 | 2a | WRK-F7 | In one-way runs, a routed lake gets no SWMM outfall inflow and no message | Lake level too low |
| 6 | 2a | CPL-F2 | About 90% of the gross inlet capture is water that goes straight back out of flooding nodes | The captured and sent-to-SWMM figures, and SWMM's flooding totals |
| 7 | 2b | SITE-F2 | The routed-lake runs cannot be reproduced from committed code | Every routed-lake number in the site doc and STATUS |
| 8 | 2a | ENG-E2 / CPL-Q1b / CPL-Q3b | NaN from a callback is silently zeroed (lake inflow), or silently changes the SWMM outfall stage or SWMM heads | Lake level, outfall boundary, and a SWMM continuity that reads 0% |

## 2. Findings

### 2a. New defects introduced by this work

**CPL-F1. A routed lake is credited with water that flows back from it into SWMM.** (`couple2way.js`: `SwmmEngine.advance` watchIn, `lakeInflowFor`)
- **Evidence:** `probes/p3_backflow.js` with the C11 model and the lake at 58 ft.
  - Pipe C7 runs backwards (min −33.9 cfs, about 40,700 cf), and the coupler hands the lake **+40,664 cf**.
  - At 50 ft, the C11 level, the forward flow is 2,719 cf and 2,677 cf reaches the lake, which is correct.
- **Authority:** EPA SWMM 5.2.4 `node.c` `node_getSystemOutflow` sets `Node[j].inflow = fabs(outflow)` for an outfall that sends flow into its conduit. So `swmm_NODE_INFLOW` gives the size of the backflow as a positive number. The lake should change by forward inflow minus backflow.

**ENG-E3. The routed lake update is explicit, so the level is unstable, and an area smaller than the lake is accepted.** (`flood2d.js` 552, 581–591; `worker.js` 180–190)
- **Evidence (engine `probe/p2.js`, a start above the lake's lip):**
  - At 103 ft with 60 s chunks the level swings 118 times in 120 chunks and ends at 102.345 ft.
  - With 1–5 s chunks it converges to 101.624 ft.
- **Evidence (worker `p3.js`, `p4.js`, synthetic pond):**
  - Started at 65 ft, it ends at 27.67 ft. Started at 100 ft, it ends at −442.95 ft. The bed is at 53.71 ft.
  - A given area of 0.01 ac for a pond of 1.187 ac is accepted, and the level falls to 44.15 ft in 0.1 h.
- **Authority:** explicit Euler on dS/dt = −Q(h) is stable only for Δt < 2A/(dQ/dh). For the test basin at H = 1 ft that limit is about 39 s.

**WRK-F2. An inlet with only an inventory `type` field silently runs as generic.** (`worker.js` 92–95)
- **Evidence:**
  - Every Winter Haven inlets file has only `node` and `type` (52 CURB_INLET, 32 GRATE_INLET). They load as generic with no note.
  - The page's `p4.py` shows a `type:"grate"` inlet run as generic with Co 0.6, not 0.67.
  - Upper-case `INLET_TYPE` is ignored without a message.

**WRK-F7. A routed lake in a one-way run receives no SWMM outfall water.** (`worker.js` 227)
- **Evidence:** `p8.js`: `lakeInflow` is undefined in the engine options for one-way runs, and there is no note.

**CPL-F2. Gross inlet capture is mostly water going in and back out of a flooding node in the same interval.** (`couple2way.js` `sourceAt`, the `Hn <= rim ? Infinity` branch)
- **Evidence (`probes/p2_cellsize.js`, C2 setup, 12 ft):**
  - 331,312 of the 373,291 cf sent to SWMM (89%) came back out of the same node in the same interval.
  - SWMM flooding is 953,904 cf, against 580,883 cf with the inlets closed.
  - The net exchange and the 2D balance still close.
- **Authority:** SWMM 5.2.4 `dynwave.c`. With ponding off, a flooding junction holds its head at the rim, so `Hn <= rim` is always true there.
- **Note:** this is shown by execution; whether to treat it as a defect is a design decision.

**ENG-E2 / CPL-Q1b / CPL-Q3b. Bad values from a callback do not stop the run.**
- `ve = ext ? +ext[i] || 0 : 0` turns NaN, `[]`, text, undefined and null into 0. Only Infinity is refused (engine `p1.js` P2).
- A NaN or missing lake level sets the SWMM outfall stage to critical depth (coupler `p9_lakefn.js` E and F: LK head goes from 50 to 54.197 ft).
- A NaN clamp reading makes the J4 head NaN for the rest of the run, and `finish()` reports 0% continuity (`p11_nan.js`).
- The coupler's own `lakeInflowFor` always returns finite values of the right length (held, 7 cases). So these paths are reached only through other callers or a NaN level.

**WRK-Q4. The worker does not check that `run` gets its boundaries in the same order as `build`.** (`worker.js` 185)
- **Evidence:** `p8.js` Q4b: with the order reversed, the "POND" routed lake takes SQ's cells, and SQ's fixed level lands on POND. There is no message.
- **Not reachable from the page:** the page sends the same object to both, which the page reviewer held in its Q1. So this only travels through other callers.

**ENG-E5 / WRK-Q2. The same lake can be listed twice.**
- **Evidence:** both entries are accepted. Rain is counted twice, and one entry reports a level the 2D never uses (engine `p1.js` P3; worker Q2a and Q2c).

**CPL-F4. Inlet capacity jumps at the opening height for depressed curb inlets and combination inlets.** (`inletCapacity`)
- **Evidence (`probes/p1_jumps.js`):**
  - A curb inlet with L 3 ft, h 0.5 ft, W 2 ft drops from 5.367 to 4.031 cfs (−25%) as depth crosses h.
  - A combination with grate A 0.5 sq ft rises 235%.
  - The C10 continuity check uses W = 0, where the jump cannot happen.
- **Missing rule:** TxDOT HDM ch. 10 sec. 6 sets W = 0 for curb openings longer than 12 ft. This is not implemented, so a 20 ft opening comes out 9.5% low at 0.3 ft.

**PAGE-F1. The clogging value changes when a saved run is reopened.**
- **Evidence:** `applyOptions` rounds to a whole percent: 12.5% comes back as 13% (`probe/p1.py`).

**PAGE-F3. The tour moves on after a step fails.**
- **Evidence:** both step actions catch their own errors, so the tour's failure message never shows. A refused run still advances the tour to the Results step (`probe/p2.py`).

**PAGE-F4. The comparison's grid check ignores units and coordinate system.**
- **Evidence:** a feet grid and a meter grid with the same numbers are accepted (`probe/cmp.js`).

**PAGE-F5. The comparison legend classifies exact boundary values unevenly.**
- **Evidence:** d = +1.0 shows as "1 or more deeper", but d = −1.0 shows as "0.5–1 shallower".
- **Impact:** cosmetic; it affects only exact ties.

**SITE-F3. The ICPR comparison report always says the lakes are fixed, even for routed runs.**
- **Evidence:** the not-like-for-like text is hard-coded in `compare_icpr_winter_haven.py`.

**SITE-F5 / SITE-F6 / SITE-F7. Smaller problems in the comparison and the builder.**
- **SITE-F5:** the "within 1 cell" tolerance is 12 ft on one grid and 6 ft on the other. At the same 12 ft, the 6 ft run scores 0.558, not 0.501.
- **SITE-F6:** every run in the folder is clipped to the first run's extent.
- **SITE-F7:** a SAIP lake matched by name wins even when it does not overlap the NHD lake.

**WRK-F4 / F5 / F6. Input handling.**
- **WRK-F4:** when both size names are given, the grate name wins silently.
- **WRK-F5:** `routed` drops the lake's `node` without a message.
- **WRK-F6:** some refusal messages are garbled ("area 5 ac ac", and two errors for one value).

### 2b. Fixes that stop short of their stated generality

| Fix / commit | Stated claim | Sibling case tested | Result | Evidence |
|---|---|---|---|---|
| 769dcdf routed lakes | "rises and falls with the water it gains" | Water piped into a routed lake (engine `pipes`) | The pipe volume never reaches the lake (18,000 cf disappear), and reverse piping creates water. Not reachable from the app: the worker passes no `pipes` | engine `p1.js` P1, `p4.js` |
| 769dcdf routed lakes | SWMM outfalls into the lake raise it | Backflow, and one-way runs | CPL-F1 and WRK-F7 | above |
| b5c8264 inlet_type | An inventory `type` "no longer makes the inlets file fail" | A file that carries `type` only | It loads, but runs as generic with no message, and the W10 mutant `p.inlet_type ?? p.type` still passes | worker `p5.js`, `p6.js`, mutant run |
| b9d9ca3 capture | "Inlet capture no longer depends on cell size" | A real 2D run at 12 and 6 ft | **Held approximately**: +6.7% sent, +1.1% surface (base: 3.75 times less at 6 ft) | coupler `p2_cellsize.js` |
| ee7e04a/d8a5da7 site doc | STRUCTURE-4059 "not explained by the datum; check record drawings" | Its location | It sits inside the City's Lake Silver polygon, on the lake's flattened lidar surface, and the coupler never couples it ("inside a level boundary") | site F1; coupler Q4 `p8_s4059.js` |
| d8a5da7 site doc and STATUS | Routed-lake results | Rebuild from committed code | They cannot be reproduced: `routed: true` was added to `lakes.geojson` by hand, and no script writes it | site F2 |
| d8a5da7 STATUS and doc figures | "lakes rose 0.70–0.77 ft", "runoff adds 0.05–0.12 ft", continuity ranges, "4 nodes" | The saved run files | Several figures do not match (table in the site report: 0.72–0.77 at 12 ft; Silver at 6 ft nets −0.011 ft; 3 nodes, not 4) | site F4 |

### 2c. Prior findings still open

None for this range.

### 2d. Pre-existing defects newly found

| ID | Where | Present at base? (evidence) | Travel |
|---|---|---|---|
| CPL-F3 | `couple2way.js` `afterChunk`: SWMM uses the lateral rate over its own step | Yes. The mechanism predates b9d9ca3, but the new header claims SWMM gets exactly what the 2D lost. `p6b_steps_alt.js`: with ROUTING_STEP 20 s the report is +33.7% over the tally; at 60 s it is +100%. With constant demand it is within 0.5% | SWMM flows and flooding |
| SITE-F1b | `make_winter_haven_demo.py`: the "within 0.5 ft of the invert" message also fires when the ground is below the invert | Yes. The condition `rim - invert < 0.5` includes negative values | Misleading build report |

## 3. Weak tests

| Test | Shape | Mutation that still passes, or gate verdict | Evidence |
|---|---|---|---|
| test_lakes L1–L5 | No test checks that the routed level reaches the 2D (every fixture has `stageAt = level0`) | Line 552 back to `checkStages(o.stageAt(th), th)`: all 10 pass | engine E4 |
| test_lakes (peak) | A level that rises and then falls is never tested | `peak = max(end, start)`: passes | engine E4 |
| test_lakes L4 | Runs in the unstable range and checks volume only | ENG-E3 | engine `p2.js` |
| C9 | The flat stand-in solver has no `readClamp`, so the shortfall branch never runs; it proves only that `inletCapacity` contains no cell size | Fixture | coupler H1 |
| C2 "clamp = shortfall" | Partly circular: the shortfall is computed from the clamp | Fixture | coupler H1 |
| C10 continuity | W = 0 and a large grate A are the only cases where no jump can occur | Fixture | CPL-F4 |
| C11 | The lake sits below the outfall pipe, so backflow never happens, and `outside == tally.toLakes` compares the same number twice | Fixture | CPL-F1 |
| C5 | Constant demand, so a mismatch between the SWMM step and the interval never shows | Fixture | CPL-F3 |
| W10 | Every fixture also carries `inlet_type` | `p.inlet_type ?? p.type`: passes | WRK-F2 |
| B12 | The shortfall is 0 in the fixture, so the new term is never exercised | Fixture | page F2 |
| B21 | The two runs differ by 0 ac on open ground, so the comparison KPIs show only zeros | Fixture | B21 output |

## 4. Unverified suspicions

- **CPL-S1:** overflow is lost if an interval stops short of the h1 given to `sourceAt`.
  - Shown at the coupler level: 3,675.9 cf unaccounted.
  - The engine passes a different h1 only on Stop, and by 1 ulp otherwise (engine Q1).
  - A run stopped mid-chunk would confirm or refute it.
- **CPL-S2:** nothing warns if `afterChunk` is never called.
  - The 12 no-regression REGRESSED results (§6) are exactly this: the old harness never calls it.
  - The worker and the page always pass it.
- **ENG-Q3:** two `cellsOf` calls overlapping on the GPU's shared staging buffer.
  - The driver never overlaps them, shown on a mock.
  - A real WebGPU run with concurrent reads would decide it.

## 5. Defences that held

| Slice | Defence | Inputs tried | Outcome |
|---|---|---|---|
| engine | Routed-lake input checks | lake index out of range, area 0, NaN level, Infinity inflow | refused |
| engine | No double-counted rain on lake cells | walled lake pocket, 3 in/hr | rise 0.250000 ft; lake cells have rain multiplier 0 |
| engine | lakeInflow on every chunk, stopped chunks included | 2 / 1 / 60 chunks | everything booked |
| engine | Mass closure of the routed lake | L1 and L4 independent volumes | exact |
| coupler | Inlet input checks | 14 bad values | all refused, naming the inlet |
| coupler | HEC-22 / TxDOT coefficients | grate 3.0/0.67; curb 2.3/3.0/0.67; centroid head | match TxDOT HDM ch. 10 sec. 6 |
| coupler | Capture independent of cell size (real 2D) | 12 and 6 ft | +6.7% (base: −73%) |
| coupler | lakeInflowFor output | 7 cases | always the right length and finite |
| coupler | Clogging default | absent, undefined, null | 0 |
| worker | Per-inlet and routed-area refusals | about 20 values | refused (Infinity area refused by the engine) |
| page | Comparison arithmetic | 200 random grids | 0 mismatches against an independent implementation |
| page | Tooltip defaults and ranges | 18 number inputs | all match the inputs |
| page | Build reproducible | rebuild | differs only in the build date |
| page | Boundary order from build to run; no routed + node together | two boundaries | held |
| site | NGVD 29 → NAVD 88 | live NCAT query | −0.932 ft, correct sign |
| site | ICPR metrics | independent implementation | match to 3 decimals on 6 runs |
| site | Builder reproducible | rebuild lidar and city | identical apart from the date |

## 6. Fail-first and no-regression gates

- **Fail-first, with `prove_tests_fail_first.py` and the node JUnit wrapper:**
  - `--range f3aa98e..d8a5da7`, tests: test_lakes, test_couple2way, test_worker, test_results_io.
  - **PROVEN 1:** W10.
  - **UNPROVEN 17:** all are older tests in the same files.
  - **SUSPECT 31:** the whole test file crashes at base on a missing new API: `r.lakes.end`, an undefined tally field's `.toFixed`, `RIO.compare`. Each file then stops at its first crash.
  - **NO-RESULT 10:** test_lakes.
  - **Isolating the coupler blocks failed:** the blocks share variables, so it was not resolved. The evidence used instead:
    - C9 was shown failing at base when the commit was made (ratio 4.000, with the one-block script).
    - The C10 refusals pass on code that ignores `type` and `clog`.
    - `inletCapacity`, `lakeInflowFor`, routed lakes and `RIO.compare` are new functions, so in effect SYMBOL-ONLY.
- **No-regression, the base versions of 10 node test files at base and at HEAD:**
  - HELD 170, REGRESSED 12. All 12 are in test_couple2way (C2, C4, C5, C6, C7, C8).
  - Cause: the base harness never calls `afterChunk`, which the new coupler needs. The test file was changed in the range to call it. The change is intended, but it is also the evidence for CPL-S2.
- **Repeat count:** 1 (no flake history).
- **Browser suite:** not run by the gate. It passed in full (69 checks) before delivery.

## 7. Boundary leads

| Lead | Raised by | Crosses into | Routed to | Outcome |
|---|---|---|---|---|
| Can lakeInflow return short arrays or NaN? | engine | couple2way | coupler | No (held); a NaN level is CPL-Q1b |
| Does the GPU have readClamp? Is h1 equal in sourceAt and afterChunk? | coupler | flood2d | engine | Defined. h1 differs only on Stop, or by 1 ulp |
| Is lakeInflow called on the last and stopped chunks? | coupler | flood2d | engine | Held |
| Rain double-counted on lake cells? | site | flood2d | engine | Held |
| Clog default; is W9 = 0 cf a defect? | worker | couple2way | coupler | Default held; 0 cf comes from mixing versions (CPL-S2) |
| Pipes to a routed lake; duplicate lakes; chunkSec; build/run order | engine | worker | worker | No pipes; duplicates and order mismatch accepted (2a); chunkSec 60 one-way and 30 two-way |
| Boundary order and routed + node from the page | worker | app.js | page | Held |
| inlet_type documentation | worker | help/index/ui | page | Consistent; generic fallback is silent (WRK-F2) |
| STRUCTURE-4059 capture | site | couple2way | coupler | Not coupled: its node is in a lake cell |

## 8. Read-only check

Before and after all agents and gates: `git status --porcelain --ignored` plus the size and mtime of every ignored file. **Unchanged.** The gate script's own check was also unchanged on both runs.

## 9. Not covered

- Real WebGPU for the new code paths (B20 in the browser suite covers GPU = CPU for one routed pond).
- The full browser suite during the review.
- Touch devices and screen readers for the tooltips.
- Comparisons between runs with different wet thresholds.
- Whether the City's WaterLevel is a starting level, and the City's datum (no source states either).
- The 3 ft Winter Haven runs and the §2 inlet volumes for 8–16 h (no saved run files).
- NLCD, SSURGO, Atlas 14 and FEMA inputs in the builder.
- Pollutants. Unit systems beyond the US/SI pair in C7.
- On-grade inlets.
- The HEC-22 text itself: TxDOT was used as the authority, and its equations are images.
