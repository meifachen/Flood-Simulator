# Disjoint review: the 0.4.2 fixes (cbddcfe..66e313b), round 3

Date: 2026-11-11. Four reviewers worked in parallel, each read-only on its own slice. Each finding below was shown by running something unless it is marked otherwise. The probe scripts are kept in the session scratchpad, under `rev4/work/<slice>/`.

## 0. Setup

| Slice | Owned paths |
|---|---|
| engine | `src/engine/flood2d.js`, `tests/node/test_lakes.js` |
| coupler | `src/core/couple2way.js`, `tests/node/test_couple2way.js` |
| worker | `src/app/worker.js`, `tests/node/test_worker.js` |
| page-site | `src/app/{app,ui,results_io}.js`, `help.html`, `tests/browser/test_app.py`, `tests/node/test_results_io.js`, `tools/build.py`, `dist/*`, `python/*`, `docs/sites/*`, `docs/reviews/*round2.md`, `STATUS.md` |

- **Coverage:** 21 of 21 files in the range owned exactly once (`check_slices.py`).
- **Prior register:** round 2. All 30 of its findings were TOUCHED in the range (no commit message cites IDs, so CLAIMED = 0). The reviewers checked the round-2 fixes in their first pass; no separate second pass was sent.
- **Read-only check:** the repository's tracked, untracked and ignored files were the same before and after the review.
- **Departure:** the page and site were one slice (a smaller round).

## 1. Farthest-traveling items

| Rank | ID | Title | Travel before detection |
|---|---|---|---|
| 1 | ENG3-E1 | The 2D scheme does not converge as the time step shrinks: a dam break moves 54,801 cf at the Courant step and 14,134 cf at dt 0.005 s. The 0.4.2 lake chunks push dt into that range | Every depth and lake level whenever chunks are short, silently |
| 2 | ENG3-E2 | With a two-way link to a fixed level, the adaptive cap regrows past the link's stability limit; the steady level bursts up to 0.32 ft away | Lake level series, outfall stage, the 2D lake boundary, the peak |
| 3 | ENG3-E3 | The cap only reacts after a chunk: the first chunk after a level-dependent inflow starts can overshoot by over a foot | Lake level, silently |
| 4 | WRK3-F1 | Changing the DEM's EPSG clears the grid but leaves reprojected buildings, boundaries and inlets in the old CRS | Inlet positions and the next grid |
| 5 | PAGE3-1 | The tour's Run step starts a second run on top of one already going; frames from both runs mix | Time slider, maps and saved results |
| 6 | SITE3-2 | The site doc says STRUCTURE-4059 never takes water at 6 ft; in the City-level 6 ft run the water stands about 1.6 ft above its rim | Readers of the 6 ft City-level row |

## 2. Findings

### Engine (`src/engine/flood2d.js`)

- **ENG3-E1. No convergence in dt.** Open-cell dam break (3 ft over a dry flat bed, 20 s), volume moved west: 54,801 / 46,930 / 30,421 / 14,134 cf at dt about 0.69 / 0.1 / 0.02 / 0.005 s. A fixed-stage spill and a routed lake show the same. Likely cause: the de Almeida et al. (2012) weighting θq + (1−θ)/2(qa+qb) is applied once per step, a diffusion of about (1−θ)dx²/(2dt) that grows as dt shrinks. L7's comment that its 0.1 s reference is converged is false.
- **ENG3-E2. Cap regrows into instability.** `lakeInflow = −k(level − 98)`: with k = 2,500 cfs/ft and 900 s chunks the level departs up to 0.320 ft from 98 ft in hours 2–12 (98 excursions over 0.02 ft). Forward Euler is stable only for dt < 2A/k.
- **ENG3-E3. Cap reacts after the fact.** After 3 quiet hours (cap about 2,750 s), a link with k = 20 switching on takes the lake to 96.816 ft; the exact answer never goes below 98 ft.
- **ENG3-E4. The lowest-ground guard refuses valid drawdowns.** A lake whose cells are the grid's lowest ground (a lidar lake) with a 1 cfs withdrawal is stopped at 98.99 ft; with one unrelated lower cell elsewhere it is accepted. L10's refusal case drives the level to −99 ft, so it never tests the threshold.
- **Minor:** `r.lastD` written but not read; read and hour boundaries collapse the cap (a quiet 6 h run at 3,600 s chunks takes 28 chunks against 6).
- **Held:** L10 fails on 0.4.1; a stiff one-sided weir stays at 97.000 ft with 60, 900 and 3,600 s chunks; nine `lakeInflow` inputs behave as documented; a square-root link no longer saws ±0.51 ft.

### Coupler (`src/core/couple2way.js`)

- **CPL3-F1. A bad `ccw` on a curb over 12 ft is no longer refused** ("abc", −1, NaN, 0 accepted; 0.4.1 refused them). Regression from the CPL2-F5 fix.
- **CPL3-F2. The NaN depth check does not check the array length.** A short `readCells` gives an inlet zero demand with no message.
- **CPL3-F3. Panel inlet values are not range-checked.** `cw` −3, `co` −0.6 and `capFrac` −1 make inlets add water; NaN reaches the 2D for one chunk. Present before 0.4.2.
- **CPL3-F4. C16's four refusals share one coupler,** so the NaN-clamp check is never shown failing on its own.
- **Held:** direct outfall inflow with spiky `[INFLOWS]` (0.9960 of SWMM's total) and with runoff routed to the outfall (0.9994); Cw 3.0 over 12 ft (FHWA HEC-22, Eq. 4-30); `[EVENTS]` detection in five spellings; `finish()` with a pending interval; full-length NaN depths and clamps.

### Worker (`src/app/worker.js`)

- **WRK3-F1. An EPSG change leaves reprojected layers in the old CRS** (an inlet stays at 500750, 1599200 instead of 452645, 3178403).
- **WRK3-F2. A refused multi-layer call keeps its earlier layers and clears the grid** (`{buildings: ok, landcover: bad}`: buildings committed, grid gone).
- **WRK3-F3. The duplicate-name check refuses unread fields** (`ID` and `id`) and names every JavaScript object has (`constructor`, `__proto__`).
- **WRK3-F4. Soils polygons read only five spellings;** `HYDGRPDCD`, `Hsg` and `HydGrp` fall back to the global values. Present before 0.4.2.
- **WRK3-F5. Only the boundaries branch of the grid clearing is tested;** removing the buildings, land cover, soils or EPSG branch leaves the suite passing.
- **Held:** routed areas named as given; node 0 refused; boundary nodes not matched loosely; single refused layers keep the grid.

### Page and site

- **PAGE3-1. Tour Run step during a run.** With a run going, the tour's Next started a second `run()`; frame hours repeated (0.5, 0.5, 0.67, 0.67 ...) and the tour moved on. `run()` has no running check; the page's Run button is disabled, but the tour calls `run()` directly. Present before 0.4.2.
- **SITE3-2. STRUCTURE-4059 at 6 ft.** In the City-level 6 ft run its cell peaks at 148.01 ft, above its 146.40 ft rim.
- **PAGE3-3. "Restored exactly" is 12 significant digits:** 99.99999999999 comes back as 100.
- **Wording:** the routed build report says lakes "start at" a level, then calls them "level boundaries".
- **Held:** the build reproduces `dist` byte for byte; R-C2; B24 and B22 fail on 0.4.1; the builder's routed rebuild matches; the comparison script reproduces section 4 and gives n/a below the cell size; every 0.4.1-to-0.4.2 claim in the site doc; the continuity and closure bounds across all 16 run files.

## 3. Not covered

- The GPU solver for the engine findings (all CPU).
- The full browser suite (targeted probes only).
- Real-size lakes for ENG3-E2 and E3 (a 0.58 ac lake was used); several routed lakes at once.
- Whether STRUCTURE-4059 took water in the City-level run.
- SI models with direct outfall inflow; `finish()` called twice; SWMM left open after `finish()` refuses.
