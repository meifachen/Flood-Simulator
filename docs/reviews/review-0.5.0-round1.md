# Flood-Simulator — Disjoint Review, Consolidated Register

**Repo:** `meifachen/Flood-Simulator`, public, JavaScript
**Commit reviewed:** `main @ 066baa5bb671600588b3915daaf9985da9289d2e` (2026-11-11, "0.5.0: routed lake storage tables and outlet weirs")
**Method:** Three blind passes, independent of each other — A: documents & claims; B: code correctness; C: execution. Repo unmodified (git status clean at consolidation; snapshot hash-verified by Pass C). Fixes below are drafts for adjudication, none applied.
**Scale:** 106 files; own code ~6,400 lines across src/tests/tools/python (src/engine/flood2d.js 754, src/app/app.js 635, src/core/couple2way.js 320, src/core/model.js 331, src/io/swmm.js 193).

## Totals

**0 Critical · 4 Major · 23 Minor · 8 Info — 35 unique findings**
(from 38 raw: A 20 + B 12 + C 6; 2 pairs merged — A-01/C-01, A-02/C-05; 1 rejected — C-06, a review-VM tmpfs limit, not a repo defect; A-03 reframed on Pass C's execution evidence, see F-06.)

**Headline verdict:** The numerics are proven, not just asserted — and the 0.5.0 lake feature works through the page with a 0.0 cf budget error. The defects are (1) one false abort that hits the flagship 0.5.0 configuration (F-01), (2) one user knob that silently changes the physics (F-02), and (3) a verification-ledger problem: STATUS's two most precise 0.5.0 numbers are *true* but *not gated* by the tests that supposedly back them, and the lake suite that contains them is not run by CI at all (F-03, F-05, F-06).

---

## Major

### F-01 (B-01) — Routed-lake "numerical failure" guard falsely aborts valid runs
`flood2d.js:682–684`. The virtual-lake check excludes outside inflow (`gainExt`) while `gain2d` includes spill of that very water. Probe: lake fed at a steady 50 cfs, rises to its lip, spills — `simulate()` threw "numerical failure" at hour 0.52 (outside inflow ≈93,600 cf, ≈54,000 cf spilled). This is the flagship 0.5.0 configuration (routed lake + two-way SWMM outfall inflow); any sustained spill eventually trips it and loses the whole run, with a message that misdiagnoses conserving arithmetic as numerical failure.
*Fix draft (Pass B):* include `max(gainExt, 0)` in the virtual level, keeping the existing exemption for net withdrawals; or bound the check per-chunk instead of cumulatively.

### F-02 (B-02) — de Almeida θ scaling still scales ~1/cfl; lowering Courant silently multiplies diffusion 7×
`flood2d.js:632,639`. The 0.4.3 scaling normalises to `0.9·dtCour`, but `dtCour` is proportional to the user's `cfl`, so the ratio never engages on the cfl path: measured (1−θ)/dt = 0.162 at cfl 0.7 vs 1.134 at cfl 0.1. The dtMax/chunk-subdivision path works (0.180 vs 0.162). A user lowering cfl to 0.1 as a "steadier" setting gets 7× the numerical diffusion per second and a materially more damped flood wave, undocumented.
*Fix draft:* normalise against the cfl-free wave step with a fixed reference cfl (0.7, the default).

### F-03 (A-01 + C-01) — `test_lakes.js` is in neither README's Tests block nor CI
Both list the same 10 of 11 Node suites; the omitted suite holds L1–L13 (21 checks) — the only test evidence for the 0.5.0 headline feature. Pass C ran it manually: 21/21 PASS today, so the omission costs nothing yet, but a future routed-lake regression would pass CI green. Raised to Major (A: Major, C: Minor) because the ungated feature is the release headline.
*Fix draft:* one line in each of README.md and `.github/workflows/test.yml`.

### F-04 (A-04) — STATUS "Not tested: speed on a real GPU — only SwiftShader" contradicts STATUS's own real-GPU measurements
`STATUS.md:229` vs `:113` (Intel Core 7 150U, 12–32×, Winter Haven timings), `:239`, and the site doc's GPU table. A stale pre-0.3.2 bullet; one of the two statements is wrong as written and the document doesn't say which.
*Fix draft:* delete the bullet or rescope it to GPUs other than the home laptop's.

---

## Minor

### F-05 (A-02 + C-05) — L13: STATUS's "within 0.001 ft" is true but not gated — the test asserts 0.005 ft
Pass A flagged a 5× overstatement (`STATUS.md:40` vs `test_lakes.js:149`). Pass C's independent probe settles the fact: max error vs the closed form is 0.000212 ft (60 s chunks) and 0.000977 ft (900 s) — the claim *holds*, but with only ~2% margin at 900 s, and nothing would catch a drift past 0.001 ft. Reframed from "overstated claim" to "ungated claim," downgraded to Minor.
*Fix draft:* tighten L13's assertion to 0.001 ft (passes now), making the claim a gate.

### F-06 (A-03, reframed) — C18: STATUS's "+17,990 of 18,000 cf" is a real measured value the test asserts only to ±1%
Pass A found "17,990" nowhere else in the repo and the C18 assertion at ±180 cf. Pass C reproduced the run: the suite prints "report external inflow 17990 vs 0" and the outlets tally exactly 12,000 + 6,000 cf. The figure is genuine run output, not an error — but as with F-05, the *assertion* (±1%) does not establish the *quoted precision* (0.06%).
*Fix draft:* have C18 print/assert the external-inflow value it quotes in STATUS, or restate STATUS at the asserted tolerance.

### F-07 (C-02) — Browser test B16 "refuses a truncated file" is flaky — a race in the test, not the app
Run 1 FAIL, run 2 PASS, same app, correct refusal message both times. The wait regex `/Opened|Could not/` matches the preceding successful-open message, so the wait returns on stale text and the check's two reads demonstrably disagreed within one `ok()` call. The app's refusal behaviour is correct.
*Fix draft:* wait for the message to change from its pre-load value, or wait specifically for `/Could not open/`.

### F-08 (C-03) — STATUS landcover figures drifted: A 13.81 / D 3.54 ac-ft claimed; test at HEAD prints A 13.99 / D 2.61 (of 14.58)
The check passes (it asserts ordering); the companion Green-Ampt-vs-EPA figures still match STATUS exactly. Claim drift, not a demonstrated code regression.
*Fix draft:* update STATUS to the printed values or note what changed the storm/table.

### F-09 (B-03) — `nearestOpen` is a Chebyshev search: "within 30 ft" can place water 42.4 ft away, and not always on the nearest cell
`model.js:222–235`; same pattern in `couple2way.js lakeOf`. Proven both ways by probe (diagonal at ring 3 returned over a closer axial cell at ring 4). Error grows with cell size (dx 50 ft → 71 ft diagonal).
*Fix draft:* filter by true Euclidean distance ≤ searchFt and take the global minimum over the square; apply in `lakeOf` too.

### F-10 (B-04) — Combination-inlet weir capacity omits curb-opening weir flow — 62% low in shallow sag ponding
`couple2way.js:98–108`. At hw = 0.3 ft: 1.48 cfs computed vs 3.94 cfs with the curb weir included (HEC-22 sag treatment). Documented in a header comment as a simplification, but presented as the HEC-22 equation set.
*Fix draft:* `min(grateW() + curbW(), grateO() + (hw > h ? curbO() : 0))`.

### F-11 (B-06) — `prep_dem.py --zunits` writes a GDAL tag `readDEM` never reads — feet silently treated as metres (3.28×)
`prep_dem.py:33–35` writes `UNITTYPE` via `update_tags`; `readDEM` reads only GeoKey 4099. The documented m→ft recipe (`--zfactor 3.2808 --zunits ft` under a metric CRS) therefore loses the hint and the app falls back to the horizontal unit. The ft-CRS path works only because the fallback happens to be right.
*Fix draft:* write a real GeoKey 4099, or have `readDEM` also read the GDAL `UNITTYPE` item; add a round-trip check.

### F-12 (B-07) — GeoJSON CRS heuristic: small-extent local coordinates classified as lon/lat; buildings can vanish silently
`worker.js:12–33`. A 150×80 ft local site plan satisfies |x|≤180, |y|≤90, gets reprojected from EPSG:4326, lands off-grid — and buildings covering zero cells produce no warning (boundaries do warn).
*Fix draft:* warn when a non-empty buildings file covers 0 cells, mirroring the boundary warning.

### F-13 (B-08) — Routed lake starting above dry land rings ±0.3 ft and dips 0.024 ft below its lip in the first chunks
`flood2d.js:546–563`. Volumes conserve (ledger closed 0.00005%); the defect is in the reported level series / first-spill timing, and it feeds the cumulative `gain2d` that F-01's guard reads. The ⅛-of-limit chunk cap doesn't cover the first chunk over dry land.
*Fix draft:* seed the adaptive cap prospectively from the starting head over the lip (the 0.02 ft-per-chunk rule), rather than learning it from the first overshoot.

### F-14 (B-05) — `readOut` labels every node "JUNCTION" on real SWMM 5.2 files
`swmm.js:164–165`. Raw dump of the bundled `model.out`: property codes [0, 2, 3], code 0 = 0 for junction, outfall (OF1) and storage (POND) alike; inverts/maxDepths all verified correct. No in-app consumer today, but `readOut` is an exported API.
*Fix draft:* drop the derived type, or source it from `parseInp` by name.

### F-15 (A-05) — Single-file size stated as "5.6 MB"; shipped file is 5,736,443 bytes (5.74 MB)
`STATUS.md:6` vs the manifest's own `"bytes": 5736443` and build.py's printed "5.74 MB". Wrong under either decimal or binary reading.

### F-16 (A-06) — STATUS's present-tense GeoTIFF summary still lists 3 bands; the export has had 6 since 0.3.1
`STATUS.md:22` and `:213` vs README/help/UI/browser test B4 (6 bands, cell-compared). The 5-band mentions sit in historical paragraphs and are correct there; only the present-tense summaries went stale.

### F-17 (A-07) — "126 controls" is a scenario-dependent runtime count presented as fixed; B19 asserts only ">60, none untipped"
`STATUS.md:83,180` vs `test_app.py:51`. Static HTML holds 61 controls; the rest is generated per loaded data, so the total moves with the example/user data. The durable claim ("every visible control has a tooltip") is proven; the numeral is false precision.
*Fix draft:* drop the numeral, or quote B19's counted total with its scenario.

### F-18 (A-08) — Three GPU speedup ranges in circulation; the site table's two-way case (8.5×) falls below two of them
`STATUS.md:113` "12 to 32 times" (defensible only if silently scoped to one-way); help §8 "usually 10–30 times"; site table gives 11.7× / 32.4× one-way and 8.5× two-way.
*Fix draft:* one range everywhere from the full table, e.g. "about 9–32×; two-way at the low end."

### F-19 (A-09) — The only version evidence inside `vendor/swmm-wasm/` says SWMM 5.2.2, not 5.2.4
`SWMM_Readme.txt` is EPA's 5.2.2 engine-archive readme; the binary carries no version string. The 5.2.4 claim *is* supported outside the folder (`build_swmm_wasm.sh` clones tag v5.2.4, Emscripten 3.1.64) — a provenance mismatch in the shipped folder, not evidence the engine is 5.2.2.
*Fix draft:* annotate or replace the readme in place.

### F-20 (A-10) — README's "(vendor/*/LICENSE*)" doesn't cover SWMM or the CRS catalog
`vendor/swmm-wasm/` has no LICENSE file (public-domain status asserted in README text only) and `vendor/crs_catalog.json` is a file, not a directory. The five libraries that do ship licenses are characterised correctly.
*Fix draft:* add a SWMM NOTICE (public domain, built from v5.2.4) and note the exceptions in README:127.

### F-21 (A-11) — Winter Haven results are unverifiable from the repo; 162 nodes vs 154 structures unreconciled
By design the data aren't stored and the builder fetches live sources, so every real-site number traces only to prose; the 8-structure gap and whether "145 pipes" is pre- or post-skip are never explained.
*Fix draft:* commit a frozen `build_report.json` + run summary per reported run set; add one reconciling clause to the site doc.

### F-22 (A-12) — Site doc header says "(updated for 0.4.1)" but §7 reports 0.4.2/0.4.3 reruns
Git log agrees the doc moved on (`66e313b`, `68ce868`). In a document whose point is which version produced which number, the header misdates the claims.

### F-23 (A-13) — Site doc gives 66.4 ft and 66.6 ft for the same pre-fix run, unlabelled
`winter-haven-lake-martha.md:32,34`. If one is measured and the other a volume expectation, the doc doesn't say so.

### F-24 (A-14) — Site doc §5: Maude NGVD-adjusted difference −0.51 ft; the table's own inputs give −0.50 ft
0.43 − 0.93 = −0.50. The other two rows are exact. Presumably unrounded sources — unstated.

### F-25 (A-15) — README: two-way SWMM results "are identical to the native engine", unqualified
`README.md:54` drops STATUS's own scope for C0: "for two models". *Fix draft:* quote the scoped version.

### F-26 (A-16) — Browser test B15 calls the synthetic inlets "curb inlets"; the fixture defines generic inlets
The 14 points carry no `inlet_type`/`type`, so all run as generic (curb/grate/combination are covered at Node level by C10). The count (14 on 7 junctions) is right; the word in the check name — what failure reports show — is wrong.

### F-27 (A-17) — README's Repository table omits `compare_icpr_winter_haven.py` from the python/ row
The one script behind the headline ICPR comparison is undiscoverable from README's map of the repo.

---

## Info

### F-28 (B-09) — CPU↔WGSL "arithmetically identical" holds at formula level only
CPU computes in f64 with a Newton early-exit; WGSL is pure f32, fixed 12 iterations. Emulated agreement ~2–5×10⁻⁸ relative per step (Pass B); browser GPU=CPU depth diff 7.63e-06 ft (Pass C, SwiftShader). Formulas match operation-by-operation; bit-identity is unsatisfiable as built. *Draft:* record the intended meaning and the comparison tolerance in CLAUDE.md/test comments.

### F-29 (B-10) — `parseInp` silently zeroes malformed secondary numeric fields
`swmm.js:45,47` (`surDepth`, `pondedArea`, `initDepth` via `|| 0`) vs primary fields, which refuse via `num()`. Inconsistent with the project's refuse-don't-replace rule; `initDepth` does reach a result (one-way boundary h0).

### F-30 (B-11) — `prep_dem.py` line-delimited prefilter can silently drop MultiPolygon buildings
`prep_dem.py:52–58` assumes `coordinates[0]` is a ring; for MultiPolygons the bbox mixes x/y and the exact test never sees the footprint. Microsoft footprints (the branch's stated purpose) are Polygons, so it needs a MultiPolygon-bearing file to bite. *Draft:* use `shape(g).bounds`.

### F-31 (B-12) — `readOut().dateAt()` can be 1 ms off `readOut().times`
OLE-date conversion rounding on the bundled example (`…00.001Z` vs `…00.000Z`). No in-app consumer.

### F-32 (C-04) — Build is not byte-reproducible across Python/zlib versions; the committed dist is *not* stale
Rebuild differs only via the build-date stamp and gzip encoding: all 43 manifest input hashes identical, catalog and every example payload byte-identical after decompression, remainder byte-identical after stripping those items. Consequence: output-hash comparison is not a usable cross-machine check; manifest input hashes are.

### F-33 (A-18) — STATUS's version-history chain starts at 0.3.0; 0.2.0 exists in git history
Everything the chain does list matches git subjects/dates exactly — an omission at the tail, not an error.

### F-34 (A-19) — "Stop works in about 0.2 s" is more precise than its check
B9 asserts only within 5 s; no artifact records 0.2 s. (Pass C measured 0.5 s on a throttled VM, consistent with "typically fast", not with a gated 0.2 s.)

### F-35 (A-20) — Settings-restore wording ("exactly", 12 digits, round 2 / STATUS 0.4.2 paragraph) superseded by round 3 (15 digits) but never annotated
Round-3 documents and STATUS's 0.4.3 paragraph are correct; the older text stands unannotated. Recorded so the adjudicator can settle the register convention once.

---

## Verified clean (consolidated — the passes agree)

**Execution (Pass C, all reproduced):**
- Node tests **235/235 PASS, 11/11 suites exit 0**; browser tests **77/77 PASS, exit 0**, no console errors (SwiftShader).
- L12: **+0.111720 ft** exact — suite, quadratic, and independent bisection/integration (0.1117199; engine diff 2e-14).
- L13 weir drawdown, 0.4.3 dam-break (**53,438 vs 54,801 cf digit-for-digit** via T9), C18 (**17,990 cf reproduced**), B20 peak level **55.5367 ft to all five digits** through the page, B26 0.5.0 lake budget closing at **0.0 cf error** through the page.
- Mass conservation: T3 closure 1.187 cf on 54,135 cf; independent closed-basin probe −0.002 cf on 13,066.667 cf. CPU solver **bitwise deterministic**. Inlet capture grid-independent (5,915 cf at 12 ft and 6 ft, ratio 1.000).
- All **7 reference JSONs regenerate byte-identical** (swmm-toolkit 0.17.0 / EPA engine, rasterio). All 3 examples internally consistent (files, node counts 15/9/9, units).
- Fail-first is real: **3/3 sabotages caught** by assertions (weir exponent, levelOf inversion, ledger rain), exit 1; no assignment-instead-of-assert patterns.

**Code (Pass B, probed):**
- Green-Ampt residuals ≤1e-12 vs the implicit equation; storage/`levelOf` is the exact trapezoid/quadratic inverse (holds even for decreasing area tables).
- The new outlet-weir midpoint step reproduced the analytic ODE drainage solution to 4 decimals (level 101.0029 ft, volume 17,974.3 cf, both ways); outside-inflow volume→level exact; lake never drawn below crest volume.
- Full CPU↔WGSL operation-by-operation diff matches (faces, ratio, update order, VEL_H = 0.05 ft gate, Froude flags) — precision is the only difference (F-28).
- Inlet regime switch continuous at the rim (3.1820 cfs at lim = ∞/0.5/0.49); clamp-based capture accounting sound (a clamp at an inlet cell can only arise from the sink); `prepareInp` [EVENTS] refusal, `.out` offsets, GeoTIFF writer, worker load atomicity all check out.

**Documents (Pass A, recomputed):**
- **5,252 EPSG codes exact**; 15 guide sections exact; 5 workflow steps / 8 tour steps; manifest SHA-256 and all 43 input hashes verify; panel defaults/tooltips/help agree with code (incl. outlet_cw 3.0, θ = 0.8, 40M/8M/1.2M limits, 30 ft placement).
- Winter Haven internal arithmetic recomputes exactly (ICPR hit/FAR/CSI, net-drained, lake rises 0.72–0.77 ft) — the numbers are consistent, just not reproducible from the repo (F-21).
- Prior-review hygiene complete: every finding in all four earlier registers has a response row; STATUS restates response numbers accurately (exceptions F-05/F-06/F-35); the absence of a 0.5.0 review round is honestly disclosed at STATUS.md:238. This review is that round.

## Scope limits
- **No real GPU** in the review VM: WebGPU exercised only via SwiftShader; STATUS's real-GPU benchmarks not assessed (and see F-04/F-18).
- Pass B did not execute the SWMM WASM engine; two-way behaviour depending on the live engine is reasoned from `couple2way.js`, corroborated where Pass C's browser/Node runs exercise it (B12/B13/C18 all green).
- Winter Haven builder and ICPR comparison not run (data not in repo, live sources).
- Pre-0.5.0 code is not in the snapshot: "fails on the earlier version" claims verified only forward, via sabotage.
- Timings are from a 1.5-shared-CPU VM — sanity observations, not benchmarks.

## Enhancements (E-01…E-12 — recommendations, not findings; nothing built)

Drafted at the owner's request after consolidation. First tranche grows out of this review's findings; second tranche takes up STATUS's own "Open items" / "Not tested" lists, ranked by leverage.

**From this review:**
- **E-01 — Claims gate: generate STATUS's quoted numbers from test output.** F-03/F-05/F-06/F-08 are one failure mode — precise numbers hand-copied from runs into prose, then drifting or outrunning their assertions. Have each suite emit a `results.json` of its measured values (L12 rise, L13 errors, C18 external inflow, soil ac-ft, B20 peak), and a small check that STATUS's quoted figures match it. Turns the ledger from hand-kept to enforced, permanently.
- **E-02 — cfl-invariance regression test (pairs with the F-02 fix).** T9 already pins dtMax-invariance for a dam break; add the same fixture run at cfl 0.7 / 0.35 / 0.1 asserting moved volume within the same 3%. Without it, F-02's class of defect can return silently.
- **E-03 — Spilling-routed-lake end-to-end fixture (pairs with F-01/F-13).** Pass B's probe (lake fed 50 cfs, rises, spills for hours, budget closes) belongs in `test_lakes.js` as L14 — the flagship configuration currently has no test that lets a fed lake spill at length, which is exactly how F-01 survived to release.
- **E-04 — Run provenance inside `.fsim.gz`.** The dist manifest already hashes its 43 inputs; a saved run should likewise carry app version, engine settings (cfl, θ, dtMax, coupling interval), and input-file hashes. Makes any saved run — and any future STATUS figure — reproducible and auditable after the fact, and gives run comparison a settings-diff for free.
- **E-05 — Winter Haven evidence pack (closes F-21).** Commit the frozen `build_report.json` + run-summary table for each reported run set, so the project's only real-site credibility numbers can be checked without re-running a live-data build against sources that may have moved.

**From STATUS's own open items, ranked:**
- **E-06 — Lake outlet rating curve / pipe / gate.** The natural 0.6.0 headline: 0.5.0's weir is one point on this curve. The midpoint-step and never-below-crest machinery generalises (Q as a function of level instead of Cw·L·H^1.5), and Winter Haven's real outlet structures are the motivating case, builder support included.
- **E-07 — On-grade inlet interception (HEC-22).** Inlets currently use sag equations at local depth everywhere; on-grade capture (gutter flow, spread, interception efficiency) is the larger half of real inlet behaviour and the main gap between this and a production inlet model. Bigger than E-06 in scope; sequence after it.
- **E-08 — Velocity/hazard benchmark (UK EA Test 6A or equivalent).** Velocity and hazard maps are shipped but benchmarked only against Manning flow. One recognised benchmark converts them from plausible to citable — the same move T2 (Hunter) made for depth.
- **E-09 — Velocity time series (or at least time-of-max-velocity).** Only maxima are kept today; the GeoTIFF already stores time-to-max-depth, so the pattern exists. Needed for hazard-duration questions (how long was dv above threshold at this cell?).
- **E-10 — Large-grid stress test.** Grids near the 8M-cell limit and reopening very large `.fsim` files are explicitly untested; one synthetic 8M-cell smoke run in CI (or a documented manual run) closes the last scale unknown, and would have caught any memory blow-up in results_io before a user does.
- **E-11 — Soils GeoTIFF through the browser + DEM-without-EPSG run.** Two coded-but-never-run paths in the "Not tested" list; each is a browser check (B-series), cheap once E-03's lake fixture pattern exists.
- **E-12 — Second-GPU / work-PC verification run.** One documented run on the work PC's WebGPU closes F-04/F-18 for good — the hardware claims then rest on two machines, not one laptop, and the "Not tested" section can stop contradicting itself.

## Annexes
- Pass A (documents & claims): 0 Critical · 4 Major · 13 Minor · 3 Info (20 findings)
- Pass B (code correctness): 0 Critical · 2 Major · 6 Minor · 4 Info (12 findings)
- Pass C (execution): 0 Critical · 0 Major · 3 Minor · 3 Info (6 findings)
