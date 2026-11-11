# Response to the 0.4.0 review, round 3 (fixed in 0.4.3)

The findings are those of `review-0.4.0-round3.md`. Every new check was run against 0.4.2 (66e313b) and fails there: T9, L7 (rewritten), L10 (withdrawal), L11, C17, W15 and B25 (B25 as a short browser script against the 0.4.2 build).

## Findings

| ID | Finding | Fix | Test | Fail-first |
|---|---|---|---|---|
| ENG3-E1 | No convergence in dt | The weighting is applied with 1 − (1 − θ)·min(1, dt / (0.9 × the Courant step)), so the smoothing per second stays near that of the Courant step. Steps within 90% of the Courant step (every step of a chunk of 10 or more) keep θ as given, so ordinary runs are unchanged. One value per chunk, rounded to Float32, goes to both back ends | T9: dam break moves 54,801 / 53,579 / 53,457 / 53,438 cf at dtMax 5 / 0.1 / 0.02 / 0.005 s | fails (old: 54,801 / 46,930 / 30,421 / 14,134 cf) |
| ENG3-E1 (L7) | L7's reference not converged | L7 now compares the 60 s and 900 s runs with a 0.1 s run at every chunk end: within 0.03 ft (one chunk of lag while the level falls 0.06 ft/s) | L7: largest difference 0.028 ft; lowest 101.271 / 101.272 / 101.272 ft | fails (old: 0.355 ft) |
| ENG3-E2 | Cap regrows into instability | Each lake measures the level dependence of its outside inflow between chunks, k = −Δrate/Δlevel, and keeps chunks under A/k (half the explicit limit). A level that reverses by more than 0.002 ft two chunks running halves the cap | L11: a lake linked both ways (2,500 cfs/ft) to 98 ft stays within 0.005 ft of it, hours 1–6, 60 s and 900 s chunks (0.0000 ft) | fails (old: 0.082 / 0.326 ft) |
| ENG3-E3 | First chunk after a level-dependent inflow starts | Not changed: the dependence cannot be known before it is seen. In the app the chunk is at most the coupling interval (30 s by default) in two-way runs, the only runs with outside lake inflow. Stated in the User Guide (section 14) | — | — |
| ENG3-E4 | Guard refuses valid drawdowns | The guard now checks only the level the 2D exchange and rain would give; outside withdrawals may draw a lake below the grid's lowest ground | L10: a lake at the lowest ground, 5 cfs withdrawn for 3 minutes, ends 900 cf lower | fails (old: refused at 94.99 ft) |
| ENG3 minor | `lastD` unused | Now used by the reversal check | — | — |
| CPL3-F1 | Bad `ccw` on a long curb accepted | Checked before it is overridden | C17 | fails |
| CPL3-F2 | Short 2D readings | Depth and clamp arrays must have one value per cell | C17 | fails |
| CPL3-F3 | Panel inlet values not checked | Weir and orifice coefficients, weir length and orifice area must be zero (closed inlets) or positive; clogging 0 to below 1; `capFrac` positive. Checked before SWMM is opened | C17 (zero still accepted) | fails |
| CPL3-F4 | C16 refusals share a coupler | The clamp check has its own coupler | C16 | — |
| WRK3-F1 | EPSG change under reprojected layers | Refused once the DEM has a CRS and buildings, boundaries or inlets are loaded ("load the DEM again"). From the page the EPSG box shows only while the DEM has no CRS, so this was reachable only through the worker | W15 | fails |
| WRK3-F2 | Refused multi-layer call partly applied | A refused call restores every layer, the grid and the DEM's CRS fields | W15 | fails (old: buildings kept, grid cleared) |
| WRK3-F3 | Duplicate check on unread and built-in names | Only the names the inlets file uses are read and checked; the maps have no prototype | W15 | fails |
| WRK3-F4 | Soils field spellings | `hsg`, `hydgrp` and `hydgrpdcd` in any letter case (`hsgValue` in the model, used by the worker and the rasterizer) | W15 | fails |
| WRK3-F5 | One grid-clearing branch tested | W15 checks buildings, land cover, soils and the CRS | W15 | fails |
| PAGE3-1 | Tour starts a second run | `run()` refuses while a run is going, and the tour's Run step says so and stays | B25 | fails (probe: old started a second run) |
| SITE3-2 | STRUCTURE-4059 at 6 ft | The site doc gives the three 6 ft runs: below the rim in the lidar and routed runs, above it (about 148.0 ft) in the City-level run | — | — |
| PAGE3-3 | 12 significant digits | 15 significant digits for impervious %, clogging and the map interval | B22 | — |
| Wording | "Level boundaries" for routed lakes | "routed level pools" when `--routed` | — | — |

## Effect on results

- ENG3-E1 changes a run only where a chunk is shorter than about ten Courant steps: the first chunks of routed lakes, the chunks cut at map times, and runs with a low dtMax. In the round-2 routed-lake probe, the peak land depth is now 2.62–2.63 ft for every chunk and step size; before, it ranged from 1.90 to 1.93 ft and depended on them.
- The Winter Haven routed runs were repeated with 0.4.3 (site doc, section 7).
