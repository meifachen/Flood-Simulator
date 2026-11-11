# Response to the 0.4.0 review, round 2 (fixed in 0.4.2)

The findings are those of `review-0.4.0-round2.md`. The **Fail-first** column says how each new check behaved when run against 0.4.1 (cbddcfe):

- **fails**: the check failed on 0.4.1, so it proves the fix.
- **fails (probe)**: a browser check run as a short script against the 0.4.1 build (`dist` at cbddcfe), not through the whole suite.

Every new check fails on 0.4.1: C16 (3 checks), L7 (new reference), L10 (2 checks), W13, W14, R-C2, B22 (impervious) and B24.

## Findings

| ID | Finding | Fix | Test | Fail-first |
|---|---|---|---|---|
| CPL2-F1 | Direct inflow to a routed lake's outfall dropped | Each lake outfall's sum starts at the outfall's own `NODE_LATFLOW` (runoff, `[INFLOWS]`, dry-weather flow), then adds the signed link flows | C16: 2 cfs `[INFLOWS]` on the outfall books 67,570 cf; SWMM's Outfall Loading Summary gives 67,509 cf | fails (old: 24,379 cf) |
| CPL2-F2 | NaN clamp at the start of an interval | Refused at `sourceAt`; `setLat` refuses any rate that is not finite | C16 | fails (accepted) |
| CPL2-F3 | `[EVENTS]` make SWMM skip inflows the tally counts as delivered | A model with an `[EVENTS]` section is refused for two-way coupling, with the reason | C16 | fails (accepted) |
| CPL2-F4 | `finish()` with an interval not booked | `finish()` refuses while an interval is pending (its `afterChunk` was not called) | C16 | fails (accepted) |
| CPL2-F5 | Curb opening over 12 ft keeps a given `ccw` | Cw 3.0 is used, and the warning says when a given depression or `ccw` was overridden | C16: 221.83 cf | fails (old: 170.07 cf) |
| CPL2-F6 | NaN depth at an inlet cell | Refused, naming the hour | C16 | fails (accepted) |
| CPL2 (C14 note) | Over-delivery of up to one routing step at the last rate | Not changed. It is booked as negative owed and shown in the two-way table | — | — |
| ENG2-E1 | Level-dependent outside outflow drains a lake below its crest | An adaptive chunk cap per routed lake: it starts at 1 s, keeps the level change per chunk at 0.02 ft or less, and grows by 1.5 times per chunk while the level is steady (no limit once past an hour). This covers any outside inflow, not only the crest over the lake edge | L10: a 150 ft weir at 97 ft drains the lake to 97.001 ft with 1 s and 60 s chunks | fails (old: 95.636 ft at 60 s) |
| ENG2-E2 | The 0.5 s floor overrode the stability limit | Floor 0.05 s, and the adaptive cap applies too | L7 | fails |
| ENG2-E3 | L7's reference not converged | L7 now compares against 0.1 s chunks: end within 0.02 ft, lowest level within 0.25 ft, no sawtooth. The transient error of the lowest level and the 2D step effect on peak depths are stated in the User Guide (section 14, Limits) | L7 | fails |
| ENG2-E4 | Bed guard misfires on lidar lakes | The guard is now at the grid's lowest ground (or the starting level, if lower), less 0.01 ft. The message says it is a numerical failure | L10 | fails |
| ENG2-E5 | No test for the bed guard or the pipe refusal | Added | L10 | fails |
| ENG2-E6 | `lakeInflow` without routed lakes, or not a function | Both refused, naming the problem | L10 | fails |
| WRK2-F1 | Upper-case inlet properties dropped | Every inlet property name is read in any letter case | W13 | fails (old: refused for `NODE`) |
| WRK2-F2 | New boundaries do not clear the grid | Loading buildings, boundaries, land cover, soils or a CRS clears the grid once accepted (`gridCleared` in the load result). A refused file still changes nothing | W14 | fails |
| WRK2-F3 | Type note counts features | It counts inlets (a MultiPoint's points each count); grammar fixed for one inlet | W13 | fails (old: "1 inlet") |
| WRK2-F4 | "null" for Infinity or NaN | The number is printed as given | W14 | fails |
| WRK2-F5 | Node `0` accepted with routed | Any node given, number or text, is refused with routed; a fixed boundary's node is passed as text | W14 | fails |
| WRK2-F6 | `inlet_type` in two cases | Refused: "inlet_type is given twice (inlet_type and INLET_TYPE); keep one". The same for any property | W13 | fails |
| WRK2-T1 | W12 text area passed by wording | W14 tests Infinity, `true` and `"5"` | W14 | fails |
| PAGE2-F1 | Tour moves on with earlier results loaded | The example and Run steps check that the DEM and the results are new objects | B24 (example step with a run in progress; Run step with earlier results) | fails (probe: old moved on to 4 of 8 and 8 of 8) |
| PAGE2-F2 | Impervious % rounded on restore | Restored with 12 significant digits, like clogging; the map interval too | B22: 12.34567% | fails (probe: old 12.3457) |
| PAGE2-F3 | Counts in double, map in Float32 | The change is rounded to Float32 before it is classed and counted, so the counts match the map | R-C2 | fails (old: 0 cells deeper) |
| SITE2-S1 | Tolerance below the cell size | Those scores are "n/a" with a note in the .md and .json | rerun on the PC | — |
| SITE2-S2 | STRUCTURE-4059 at 6 ft | Site doc and builder message corrected: at 6 ft it is coupled in an open cell at the shore, but the water there peaks near 143.3 ft, below its 146.40 ft rim, so it takes nothing | — | — |
| SITE2-S3 | `build_report` says fixed with `--routed` | The report notes say the lakes start at the level and are routed, with no outlet | — | — |
| SITE2-S4 | Continuity bound | −0.26% to +0.01% | — | — |
| SITE2-S5 | "Fixed" wording | Site doc and script docstring updated; usage shows `--tol-ft` | — | — |
| SITE2-S6 | Lakes column from the `lakes` key | Checked: the worker writes `lakes` as null for runs with no routed lake, so fixed runs are labeled fixed | — | — |
| SITE2-S7 | Fixed-lake runs are 0.4.0 runs | Labeled (0.4.0) and (0.4.1) in the table, with a note that the fixed-lake runs were not repeated | — | — |
| SITE2-S8 | Minor text | 250 of 251 cells; the 0.01 ft threshold stated; typo fixed | — | — |

## Not changed

- **CPL2 C14 over-delivery:** booked and shown, not corrected; it is at most one routing step at the last rate.
- **CPL2 weak tests C2 and C12:** C16 adds an independent reference (SWMM's own outfall total) for the lake booking. C2's recirculation check is still a range.
- **The 2D step and peak depths in fast transients (ENG2-E3):** this predates 0.4.0. It is stated in the guide's limits, not changed.
