# Response to the 0.3.0 review, round 1 (fixed in 0.3.1)

Findings are those of `review-0.3.0-round1.md`, in its order.

**Fail-first** says how each test behaved when run against 0.3.0 (commit a8cc431). The checks were run one block at a time, so a crash in one block could not hide the result of the rest:

- **fails at 0.3.0**: the check failed on the old code, so it proves the fix.
- **passes at 0.3.0**: the behavior was already right; the check was added to catch the code being broken later.
- **crashes at 0.3.0**: the output it reads did not exist yet.
- **not gated**: browser checks, which were not run against 0.3.0.

Decisions taken with the owner on 2026-11-10:

- **Froude cap (E2):** keep the cap and flag the cells where it acted.
- **IMD:** use the Rawls drained values, porosity − field capacity.
- **Manning n:** open water (class 11) 0.035; cultivated crops (class 82) 0.06.
- **Inlet crest:** a listed inlet falls back to its node's SWMM rim.

| # | Finding | Fix | Test | Fail-first |
|---|---|---|---|---|
| 1 | W9: SWMM keeps receiving the last inlet capture after the 2D run ends (present since 0.2.0) | Coupler `stop()` zeroes NODE_LATFLOW; `finish()` = stop, run SWMM to its end, close. Worker uses `finish()` | C5; W9; browser B12 (report 88,557 cf vs inlets 88,563 cf) | C5 and W9 fail at 0.3.0 |
| 2 | W1: refused land cover still used | Every layer is read and checked into a local before it replaces the stored one | W1; browser B17 | fails at 0.3.0 |
| 3 | AU-1: opening results during a run mixes runs | Open, load and example are refused while running | browser B9 | not gated |
| 4 | C-F1: listed inlet crest = cell ground | Falls back to the node's SWMM rim; crest more than 0.5 ft from the cell ground reported | C6 | fails at 0.3.0 |
| 5 | C-S2: weir/orifice jump at head = rim | Orifice head = min(depth over crest, H2 − Hn) when surcharged, so the regimes meet at the crest | C7 (US = SI, cap lifted: 37,267 cf each) | fails at 0.3.0 (SI 2.2 times US) |
| 6 | M-F1 / AU-4: IMD 0.3 for C and D | IMD = porosity − field capacity (A 0.332, B 0.217, C 0.154, D 0.154); IMD above porosity − wilting point flagged; help and panel text corrected | landcover: IMD defaults, published-table check, Green-Ampt vs SWMM 5.2.4 | fails at 0.3.0 |
| 7 | E1: start-up spike in vmax/dvmax | Step size allows for the depth a point inflow (capped at the single-face critical depth) or rain can add in the chunk | V5 (1.000 vs 1.000 ft²/s; was 10.7 vs 1.24) | fails at 0.3.0 |
| 8 | E2: speed capped at critical | Cells where the cap acted are recorded (CPU and GPU), hatched, counted, explained, GeoTIFF band 6 | V6; browser B3, B4, B6 (19 = 19 cells) | V6 crashes at 0.3.0 (no flag output) |
| 9 | W4 / AU-Q5 / M-F3: layer missing the grid used silently | buildGrid reports no or partial coverage; misaligned arrays refused; CRS mismatch noted; build message gives counts | W4; landcover coverage and refusal checks | fails at 0.3.0 |
| 10 | W2: refused inlets file replaces the inlets | As #2 | W2 | fails at 0.3.0 |
| 11 | AU-2: opened results show current panel | `applyOptions` restores the run's settings and tables | browser B16 | not gated |
| 12 | C-F2: inlet far from its node | Warning beyond 300 ft (`maxLeadFt`) | C8 | fails at 0.3.0 |
| 13 | C-F3: rejected listed inlet replaced by a default | A junction with a listed inlet gets no default even if that inlet is rejected; the warning says so | C8 | fails at 0.3.0 |
| 14 | W3: lon/lat Point GeoJSON not reprojected | `geojsonCrs` walks every geometry type | W3 | fails at 0.3.0 |
| 15 | AU-3: failed DEM wipes edits | Site reset only after the new DEM is accepted | browser B17 | not gated |
| 16 | W6: soil raster codes outside 1–4 dropped | Counted at load and at build, reported | W6 | fails at 0.3.0 |
| 17 | E5: hot start carries hmax, not vmax | `initVel` carries both; `init` alone restarts both | V7 | fails at 0.3.0 |
| 18 | W7: cell size crash | Cell size checked first | W7 | fails at 0.3.0 |
| 19 | W8 / C-F5: loose inlet values | Load and coupler refuse zero, text and NaN; numeric node names and MultiPoint read; numbering as in the file | W8; C8 | fails at 0.3.0 |
| 20 | M-F2: n for classes 11 and 82 not in Kalyanapu | 11 = 0.035 (Chow 1959), 82 = 0.06 (SWMM manual overland table), cited in code, panel and help | landcover published-table check | fails at 0.3.0 |
| 21 | M-F4: Infinity and blanks accepted | Model validates type and range; Ks at most 50 in/hr | landcover refusals | fails at 0.3.0 |
| 22 | M-F6: `hsgCode("1")` = 0; fractions rounded | Text 1–4 read; non-integers refused | landcover codes | fails at 0.3.0 |
| 23 | M-F7: no ±1e20 NoData guard | Added to `readRaster` | landcover NoData | fails at 0.3.0 |
| 24 | R-F3: unpack trusts the header | Integer and non-negative lengths, known types, no repeats, grid consistency, whole body consumed | results_io refusals | fails at 0.3.0 |
| 25 | R-U1: NaN saved as null | Header writes non-finite numbers as `{"$num": "NaN"}` and reads them back | results_io round trip | fails at 0.3.0 |
| 26 | AU-5: Run re-enabled after open | `S.resultsOnly` keeps Run off until a DEM or example is loaded | browser B16 | not gated |
| 27 | AU-6: inlets file box not cleared | Cleared with the others | browser B17 | not gated |
| 28 | AU-Q4: inlets not drawn without .inp | Drawn first | browser B17 | not gated |
| 29 | E6: GPU `bRat` without COPY_DST | Usage flag added | browser B6 (no console errors, Z) | not gated |
| 30 | C-F6: generator docstring 30 ft vs 33.11 ft | Docstring corrected (33.1 ft: 30 ft along, 14 ft across) | — | documentation only |

## Weak tests (review §3)

All strengthened:

- **V1:** Manning check within 1%, east and south; inflow-cell face mean.
- **V3:** a sheet that crosses 0.05 ft, with the threshold written as the literal 0.05.
- **V4:** maxima survive the falling limb; a reused solver starts clean.
- **Land cover:** expected values come from tables written out in the test, not from the code.
- **Closed edges:** rain total equals 1.5 in on the ground cells.
- **C8:** three inlets share one cell.
- **B16:** KPIs, chart, last map and water balance compared at the same view.
- **B4:** bands 5 and 6 compared cell by cell.

Of these, V1 Manning, V3, the V4 falling-limb check, closed edges and C8 pass at 0.3.0. That is expected: they guard behavior that was already right. V4's reused-solver check crashes at 0.3.0 because it reads the new flag output.

## Found during this round

The new Stop wiring was accidentally commented out. Browser check B9 caught it before delivery, and it was fixed.
