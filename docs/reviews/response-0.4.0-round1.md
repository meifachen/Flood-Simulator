# Response to the 0.4.0 review, round 1 (fixed in 0.4.1)

The findings are those of `review-0.4.0-round1.md`. The **Fail-first** column says how each new check behaved when run against the code before the fix (d8a5da7 for most rows; f1662e5 for the coupler file), one block at a time:

- **fails**: the check failed on the old code, so it proves the fix.
- **new function**: the check calls code that did not exist before, so it crashes on the old code. That shows only that the code is new, not that the check is strong.
- **not gated**: browser checks, which were not run against the old page.

Row by row:

- **Fails on the old code by assertion:** C12, C13, C14, C15, L7, L8, W11, W12 and R-C1, all run one block at a time.
- **Pass on the old code:** L6 and L9. They are there to catch the review's mutants (code changed on purpose to be wrong), and both fail on those mutants.

## Findings

| ID | Finding | Fix | Test | Fail-first |
|---|---|---|---|---|
| CPL-F1 | Water flowing back from a routed lake into SWMM was added to the lake | Lake-outfall exchange uses the signed flow of the links that reach the outfall, in the direction they are written in the .inp. SWMM gives an outfall's backflow as a positive NODE_INFLOW, and it reports link flow in the written direction even when it swaps the ends of an adverse-slope conduit | C12: back into SWMM ≈ 38,987 cf, lake booked −38,889 cf | fails (old: +39,594 cf) |
| ENG-E3 | Routed lake level unstable; depends on chunk size; can fall below its bed | Chunk length limited to 0.25 A/(dQ/dh), with Q the critical-depth crest flow over the lake's edge | L7: 1 s, 60 s and 900 s chunks end at 101.624 ft; largest swing 0.006 ft | fails (old: swing 2.8–4.8 ft, ends 102.345 / 102.987 ft) |
| ENG-E3 (inputs) | Lake area smaller than the lake accepted; level fell below the bed | Area smaller than the lake's own cells refused; falling below the bed (and the starting level) refused | L8 | fails |
| ENG-E2 | NaN or missing outside inflow silently became 0 | Refused, naming the hour and values | L8 | fails |
| CPL-Q1b, Q3b | NaN lake level changed the SWMM outfall stage; NaN clamp corrupted SWMM | Both refused | C13 | fails |
| ENG-E5, WRK-Q2 | A lake listed twice | Refused | L8 | fails |
| ENG-E1 | Pipes to a routed lake not in the lake budget | Refused (the app never passes pipes) | — | not reachable from the app; no test |
| ENG-E4 | No test that the routed level reaches the 2D; peak never tested on a rise and fall | L6 (stageAt says 95 ft, routed 101 ft: the lake spills); L9 (rise, then spill) | L6, L9 | kill the reviewer's mutants (stageAt-only, peak = max(end, start)) |
| CPL-F3 | SWMM received the inlet volume over its own routing step | What SWMM actually received is tallied per SWMM step. Each interval's rate delivers the interval's capture plus what is still owed, and `finish()` hands over the rest. Anything left is reported (`owedToSwmm`, a row in the water balance) | C14: 20 s and 60 s routing steps, demand on and off | fails (old: report +33% and +100%) |
| CPL-S2 | No warning if `afterChunk` is never called | `sourceAt` refuses an interval whose previous `afterChunk` is missing | C15 | fails |
| CPL-F2 | Gross capture is mostly recirculation at flooding nodes | Not changed: the exchange is physical. The water that goes back out of the same node in the same interval is tallied (`recirculated`) and shown in the two-way table, so gross and net can be read apart | C2 (331,312 of 373,291 cf) | new field |
| CPL-F4 | Depressed curb capacity jumps at the opening height; 12 ft rule missing | Openings over 12 ft ignore the depression (TxDOT HDM ch. 10 sec. 6) and warn. The jump comes from the method itself (the weir and orifice do not meet), so it is now stated in the C10 check's name | C15 (15 ft opening: 221.83 cf = 3.0 × 15 × 0.3^1.5 × 30 s) | fails |
| WRK-F2 | Inventory `type` silently generic; W10 could not catch the bug | Inlets with a `type` field and no `inlet_type` are counted and reported at load and in the inlets status. `INLET_TYPE` is read in any letter case | W11 (kills the `inlet_type ?? type` mutant) | fails |
| WRK-F4 | Both size names: one silently won | Refused | W11 | fails |
| WRK-F5 | Routed + SWMM node: node dropped | Refused | W12 | fails |
| WRK-F6 | Garbled messages | One message per value; area shown as given | W11, W12 | fails |
| WRK-F7 | One-way routed lakes get no outfall water silently | Warning in the run notes | W12 | fails |
| WRK-Q4 | Boundaries in another order than the grid's | Refused ("build the grid again") | W12 | fails |
| PAGE-F1 | Clogging rounded on reopen | Restored exactly | B22 | not gated (browser check, not run on the old page) |
| PAGE-F3 | Tour moved on after a failed step | Example and Run steps check their result | B23 | not gated (browser check, not run on the old page) |
| PAGE-F4 | Compare ignored feet vs meters | Cell size in feet compared too | R-C1 | fails |
| PAGE-F5 | Change classes not symmetric | Classes by the size of the change | B21 | not gated (browser check, not run on the old page) |
| SITE-F1 | STRUCTURE-4059 misdiagnosed | Site doc corrected. The builder now flags structures on lakes (NHD within 10 ft or the City's lake polygon), and its message says "below the invert" when it is | rebuild: 4059 flagged | — |
| SITE-F2 | Routed runs not reproducible | `make_winter_haven_demo.py --routed`. The rebuilt `lakes.geojson` matches the one used. The runs were repeated with 0.4.1 | rebuild | — |
| SITE-F3 | Report said "fixed" for routed runs | Lakes column per run; general wording | rerun | — |
| SITE-F4 | Figures that did not match the run files | Corrected | — | — |
| SITE-F5 | "Within 1 cell" differed by cell size | Tolerance in feet (12 ft default, `--tol-ft`) | rerun: 6 ft 0.558, 12 ft 0.516 | — |
| SITE-F6 | All runs clipped to the first run's extent | Each run over its own grid; a note when extents differ | — | — |
| SITE-F7 | City lake matched by name alone | Name and overlap | — | — |

## Weak tests (review §3)

| Test | Now |
|---|---|
| test_lakes (level reaches the 2D, peak) | L6 and L9 kill both mutants |
| L4 in the unstable range | Chunks are limited; L7 checks the level path |
| C11 (lake below the pipe) | C12 adds the backflow case and checks it against SWMM's own link flow |
| C5 (constant demand) | C14 alternates demand with 20 s and 60 s steps |
| C10 continuity fixture | The claim is narrowed to undepressed curbs; C15 adds the long-curb rule |
| W10 | W11 loads a file with `type` only |
| B21 (zero areas) | The two runs now differ (rain and no rain): 1.01 ac no longer flooded |

These remain:

- **C9:** still uses a stand-in solver without `readClamp`. C2, C12 and C14 run the real solver.
- **B12:** the fixture still has no shortfall. The page reviewer showed the code holds with a forced shortfall.

## Not changed

- **CPL-F2:** the exchange is physical; it is reported, not altered.
- **ENG-Q3:** the GPU staging-buffer overlap needs concurrent reads, which nothing does.
- **CPL-S1:** stopping short of `sourceAt`'s h1 happens only on Stop. The engine reviewer showed the stopped chunk is still booked.
