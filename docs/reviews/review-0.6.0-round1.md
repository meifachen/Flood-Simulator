# Flood Simulator 0.6.0 — disjoint review, round 1 (consolidated register)

**Target:** branch `v0.6.0-fixes-enhancements` @ `3a54427` of
`meifachen/Flood-Simulator` — the release that answers the 0.5.0 round-1
register (`docs/reviews/review-0.5.0-round1.md`) with all 35 fixes and
enhancements E-01…E-12.
**Method:** three blind passes over a pristine git-archive snapshot (Pass A
documents & claims; Pass B code correctness, adversarial; Pass C execution).
No pass saw another's work. The repository was not modified (build tree
verified clean at consolidation, HEAD `3a54427`).
**Reference:** round-1 finding numbers are written "(0.5.0 F-02)" etc.;
this register's findings are F-01…F-28.

## Totals

**0 Critical · 0 Major · 12 Minor · 16 Info — 28 unique findings from 33 raw**
(2 pairs merged: A-04/C-03, A-12/C-02; 5 pass items were verification
results rather than defects and are carried in the Reproduced table).
*Errata (2026-11-14): two Pass A Info items, A-06 and A-10, were dropped
in consolidation as first delivered, and the file itself was truncated at
F-09; both are corrected in this version — A-06/A-10 are restored as F-27
and F-28. No finding's substance changed.*

**The headline:** the 0.5.0 fixes hold. Every engine fix was independently
re-probed and reproduced (0.5.0 F-01, F-02 in its gated range, F-13, F-09,
F-10, F-11, F-31), E-07 matches 13 independent HEC-22 hand calculations to
all digits, the Node battery reproduces exactly (259/259, per-suite
identical), fail-first is real (L14 throws at hour 0.52 on 0.5.0; T10 gives
47,031 cf), the claims gate passes pristine and catches 3/3 sabotages, and
the dist is byte-identical to its manifest. The findings cluster where
round 1's did not: in the *new* surface — the top of the Courant range the
F-02 fix doesn't cover, the new pipe outlet's head datum, provenance's
completeness, and the claims gate's own limits — plus a residue of
response-doc wording that misstates its own tests.

---

## Minor

### F-01 (B-01) — The 0.5.0 F-02 fix is one-sided: Courant invariance fails *above* the default, and cfl 1.0 rings
`flood2d.js` θ normalisation anchors at 0.63·dtWave, so smoothing per
second is flat for cfl ≤ 0.63 and falls above it: (1−θ) can never grow
past its base 0.2. Probe (T9/T10 dam-break fixture, moved volume):

| cfl | moved volume | vs cfl 0.7 |
|---|---|---|
| 0.05 / 0.10 / 0.35 | 53,505 / 53,575 / 54,074 cf | −2.4% / −2.2% / −1.3% |
| 0.70 | 54,801 cf | — |
| 0.95 | **62,536 cf** | **+14.1%** |
| 1.00 | 50,297 cf, max depth 1.813 ft (vs 1.680), **7 depth-gradient reversals** (vs 1) | −8.2%, non-monotone |

`simulate` accepts cfl up to and including 1.0. T10 gates only cfl ≤ 0.7,
and the code comment's "the answer does not depend on how finely the time
is cut" stands unqualified.
*Fix:* extend T10 to 0.95 and 1.0; either normalise (1−θ) upward above the
reference step too, or restate the claim as invariance for cfl ≤ 0.7 with
a warning above it.

### F-02 (B-02) — The E-06 pipe outlet measures orifice head from the invert, not the centroid — up to √2 too much flow
`flood2d.js` pipe outlet: `q = cd·A·sqrt(2g(h − ctl))` with `ctl` the
invert. The standard orifice head is to the centroid; at the moment the
pipe just runs full the overstatement is exactly √2 (probe, D = 3 ft,
Cd 0.6: code **58.9 cfs** vs centroid **41.7 cfs** at the crown). Fed
20 cfs, the code's equilibrium is 100.346 ft — below the crown, a part-full
regime the orifice equation does not describe under either convention.
L17 validates the pipe only against the same invert-head formula, so the
suite cannot see the choice. The code comment discloses the convention;
help and STATUS do not flag its size.
*Fix:* take head to the centroid (`sqrt(2g·max(h − ctl − D/2, 0))`) with
the part-full range modelled or declared out of scope — or keep invert
head and state the convention and its √2 size where users size outlets.

### F-03 (B-03) — E-04 provenance omits run-defining settings, so run comparison can certify different runs as identical
`prov.settings` records engine, cfl, coupling, times, rainSource, dvThresh
— but not uniform-rain intensity/duration, the gauge, the drain allowance,
dtMax, the panel inlet values, or boundary levels typed into the panel
(only boundary *files* are hashed). Probe: two prov objects differing only
in uniform rain (1 in/hr × 6 h vs 4 in/hr × 2 h) give `provDiff === []`,
and the app prints **"The two runs used the same settings and input
files."** — an audit statement, wrong in exactly the place it must not be.
*Fix:* record `rainInHr`, `rainHours`, gauge, drain, `dtMax`, inlet panel
values and boundary specs, and compare them in `provDiff`; until then,
soften the message to "the recorded settings and input files agree".

### F-04 (C-06) — The provenance object does not survive the save/reopen round trip unchanged
RT-A (Playwright, built dist): the reopened `.fsim.gz` *shows* provenance
and the reopened values are bit-identical (hmax 5.4272; lake end
55.00131511155445), but strict `S.prov` before == after **fails** — the
after-state lists 1 input where the run's provenance listed its inputs.
The field-level diff was not captured, so which part mutates is an open
question for the fix round. (Distinct from F-03: F-03 is fields never
recorded; F-04 is recorded state changing across the round trip.)
*Fix:* capture the diff, make the reopened provenance equal the saved one
(or document which fields are intentionally rebuilt on open).

### F-05 (B-04) — The 0.5.0 F-29 warning false-positives on legitimate SWMM cross sections
`secNum` is applied to `[XSECTIONS]` Geom1, but for IRREGULAR sections
Geom1 is a transect *name* and for CUSTOM a curve *name*. Probe file (only
genuinely bad tokens: a junction depth `abc`, a conduit offset `*`) also
produced: `Cross section C2 geometry: "TRANSECT1" is not a number; 0 is
used` — false. Every natural-channel model now earns a spurious warning in
a list whose other entries are real defects, and the name is zeroed.
*Fix:* keep Geom1 as a string for IRREGULAR/CUSTOM; apply `secNum` only
where Geom1 is a dimension.

### F-06 (A-01) — L14's duration is misstated as "50 cfs for 6 h" in STATUS and the response; the test runs 2 h — and the response reverses the flow direction
`STATUS.md:43` and response row F-01 both say 6 h. The test runs t 0→2 h;
the docs' own volume proves it (360,000 cf = 50 cfs × 2 h; 6 h would be
1,080,000 cf; runtime print: `end 100.347 ft`, `outside 360000 of
360,000`). The response's "sends exactly 360,000 cf outside" also reverses
direction: 360,000 cf is inflow the lake *receives* (`lk.outside`); what
it sends out is the spill (39,119.7 cf net).
*Fix:* "fed 50 cfs for 2 h"; "receives exactly 360,000 cf from outside".

### F-07 (A-02) — Response row F-09 inverts its own test
The row says "a diagonal-only cell within radius 3 is found". The test
asserts the opposite (`nearestOpen(...) === -1`; the cell is 4.24 cells
away, outside radius 3) and its own name says "a diagonal beyond the
radius is not accepted". The code fix is real and STATUS is correct; only
the response row is wrong.
*Fix:* reword to "a diagonal-only cell beyond radius 3 is not accepted; an
axial cell (distance² 16) beats a diagonal (18)".

### F-08 (A-03) — E-05's pack contains no evidence files, and its README claims they are present
`examples/winter_haven/` contains exactly one file, `README.md`. E-05 asked
to commit the frozen `build_report.json` + run summaries from the
already-completed review-environment run — no regeneration required. The
README's first paragraph states in the present tense that the generated
files "are the frozen evidence behind the Winter Haven numbers quoted in
STATUS.md"; none are in the tree. The response's "Partial" framing blames
only the USDA-blocked 0.6.0 regeneration (true, consistently reported) —
the frozen report from the run that *did* complete was never committed.
*Fix:* commit the review run's `build_report.json` (and summaries), or
rewrite the paragraph to say the pack is a regeneration recipe with no
committed evidence.

### F-09 (A-04 + C-03) — The claims gate's coverage is narrower than STATUS/README describe, and B20 is ungated in practice
`check_claims.py` gates five figures: L12, L13's bound, C18, soils — plus
B20 *only* with `--browser-log`; without one it prints SKIP and still
exits 0 (reproduced by both passes). `STATUS.md:27` ("gates the figures
quoted in this file") and `README.md:103` carry no such qualification;
the response doc and STATUS's own enumeration state the coverage
correctly. Everything else STATUS quotes (T9/T10 volumes, L14–L18, C19,
E-10 figures, B27's cell count, GPU range) is ungated. On Pass C's
evidence, B20's 55.5367 ft rests on the builder's run alone: the gate
skips it without a log and fails closed with a B20-less log.
*Fix:* qualify both doc lines ("gates five figures STATUS quotes: L12,
L13, C18, soils; B20 with a browser log") and say in the docs that CI is
covered because the CI step passes a log.

### F-10 (A-05) — The gate takes L13's bound from the check's printed name, and a stale browser log passes B20
The gate parses the tolerance from the PASS line's name string
(`within ([\d.]+) ft`) while the assertion is a separate hard-coded
`e < 0.001` in `test_lakes.js`: loosening the assertion to 0.005 while
leaving the name would still pass the gate. (The measured errors are
genuinely parsed and required ≤ STATUS's bound, so a real error
regression is caught; only the bound↔assertion link is textual.) B20
compares STATUS against whatever log is handed in — nothing ties the log
to the current code or run, and the first regex match wins.
*Fix:* have the lakes suite print its asserted bound from the same
constant the assertion uses; stamp the browser log with build
version/date for the gate to check.

### F-11 (C-02 + A-12) — The browser battery defines 79 checks, not the quoted 80, and this review could execute only 58 of them
`tests/browser/test_app.py` contains 79 literal `ok()` checks (the 80th
was not found; runtime counts also vary with WebGPU branches and the B16
loop). In the review VM the suite aborted twice on missing Python modules
(`geopandas` at check 43; `pyswmm` at check 59): **58 unique checks
executed, 0 FAIL**; B20, B21, B22, B26, B27, B28 never ran — so B20's
55.5367 ft, B27 (soils GeoTIFF) and B28 (CRS-less DEM) have **no
independent execution evidence**, and E-10's 8M-cell figures remain
builder-reported (500k-cell sanity clean: ledger 0%, reopen identical).
Everything that did run passed, including B4's 8-band GeoTIFF and B6
GPU-vs-CPU under SwiftShader. Separately (A-12), neither suite prints a
check total, so the quoted 259/80 cannot be verified from the tree alone.
*Fix:* install `geopandas` + `pyswmm` and complete the battery; make each
suite print its check count (F-20); quote the measured runtime count.

### F-12 (C-07) — The results lakes table never names the outlet kind
RT-A's "ledger names the rating outlet" check failed: the rendered table
(`app.js:520-521`) shows the outlet volume with "out of the model" or the
destination node, but no outlet-kind label. For a headline feature with
four outlet kinds, saved results cannot say which control produced a
release. (The run itself is correct — budget error 0.0 cf.)
*Fix:* name the kind in the ledger line (e.g. "rating outlet to …").

---

## Info

### F-13 (B-08, part) — Unrecognized UNITTYPE spellings fall back silently
`readDEM`'s UNITTYPE map accepts the spellings GDAL/prep_dem produce
(`ft`, `feet`, `m`, `us-ft`, `US Survey Foot`, …). An unrecognized value
(e.g. `ft_survey`) is silently ignored and the load falls back to the
horizontal unit — the silent-fallback shape 0.5.0 F-11 was fixing, one
level down.
*Fix:* name an unrecognized UNITTYPE in the DEM warnings.

### F-14 (A-07) — The User Guide's Limits bullet is stale after the 0.5.0 F-13 fix
`src/app/help.html:195` says "The first chunk after such an inflow starts
is not limited". In 0.6.0 every chunk, the first included, is bounded by
the adaptive cap and, where the lake starts above its lip or crest, by
the F-13 seeded cap; only the level-dependent-inflow term (kExt) is
unmeasured on the first chunk. As written the bullet contradicts STATUS's
L15 description.
*Fix:* reword to "…the first chunk after such an inflow starts is limited
only by the general chunk caps, because its dependence on the level is
not known yet".

### F-15 (A-09) — Response row F-33 overstates the STATUS tail note
The row says "A tail note records 0.2.0 (git commit 2c04c24) as the first
version with a STATUS file". STATUS:3 mentions no commit hash ("see the
git history").
*Fix:* drop "(git commit 2c04c24)" from the row, or add the hash to STATUS.

### F-16 (B-05) — Rating outlets can stall a hair above their control at extreme curve slopes
The midpoint release can land `hMid` below the control when
q(lv)·used/2 exceeds the volume stored above it, releasing nothing,
repeatably. Probe: slope 500,000 cfs/ft on a 1,600 sq ft pond released
0.0 cf in 2 h, parked 0.01 ft above the control. The stall needs a
first-segment slope above roughly 40× the lake area; at a plausible
2,000 cfs/ft the same pond drains to exactly 100.0000 ft. Volume at stake
is tiny.
*Fix (optional):* evaluate the release at `max(hMid, the level whose
stored volume is half the available volume above the control)`.

### F-17 (B-06) — Pipe and rating chunk limits throttle chunks for a dry outlet (performance)
Below its control, a pipe's dq returns the 0.02 ft-floored value (213.8
cfs/ft for a 4 ft pipe at Cd 0.6), so `lakeDt` clamps chunks (9.4 s for a
2,000 sq ft lake) for the whole run even while the pipe cannot flow. A
rating's dq below its first stage likewise returns the first segment's
slope. The weir's dq correctly returns 0 below its crest.
*Fix:* return 0 below the control for pipe/rating, as the weir does.

### F-18 (B-07) — After a long quiet stretch the adaptive cap is unbounded; the first surge chunk can move the level by feet before kExt learns
Probe: 3 quiet hours (cap grows to Infinity), then a level-dependent
inflow q = (106 − level)·400 cfs/ft switches on — the first surge chunk
moves the level **6.667 ft**, followed by 10 direction reversals, before
kExt engages; the run then settles exactly at equilibrium with the budget
closed. At k = 40 cfs/ft: one 0.667 ft jump, no reversals. No water is
created and nothing aborts; the exposure is one badly-lagged stage handed
to SWMM for one interval in stiff outfall couplings.
*Fix:* when a lake's cap is Infinity and the chunk's outside inflow is
suddenly nonzero, hold that chunk to the adaptive 0.02 ft rule as if the
cap were still small.

### F-19 (A-13) — C19's test comment hand-values have drifted (STATUS and the response are exact)
The comment says gutter flow 2.395 cfs, capture 1.347 cfs, LT 27.16 ft,
grate gutter flow 14.10 cfs. Independent recomputation: 2.3940, 1.3455,
27.183 ft, 14.1164, grate capture 4.9278 — matching STATUS and the
response exactly. (The C19 assertion itself recomputes the same formulas
inline at 1e-9 — a regression pin, not an independent hand check; the
comment is the only hand calculation, and it is the part that drifted.)
*Fix:* correct the comment to 2.394 / 1.346 / 27.18 / 14.12.

### F-20 (A-12, part) — Suite totals are runtime log counts the tree does not self-verify
Neither suite prints a total; both print PASS/FAIL lines and "ALL PASS".
Statically there are 192 node `ok()` call sites expanded at runtime by
loops, which makes 259 plausible but not derivable from the tree (Pass C
did verify the runtime count directly: 259 PASS / 0 FAIL, per-suite
identical to the builder's breakdown).
*Fix:* have each suite print its check count, so quoted totals can be
checked without a full run log.

### F-21 (A-08) — gpu_benchmark.md names a dist file that does not exist and cites a browser "W9" window
Step 1 offers the shipped `dist/flood_simulator.html`; the file is
`dist/FloodSimulator.html` (the instruction fails on a case-sensitive
filesystem). Step 4 references "the browser suite's W9/B20 window": W9 is
a node worker check, not a browser check, and B20's window is not "1 h to
1.25 h" (it runs t0 = 0 with uniform rain for 1 h). The document contains
no fabricated numbers (E-12 itself verified clean).
*Fix:* correct the filename; describe the window directly.

### F-22 (A-11) — GeoTIFF band count is stated unconditionally as 8; reopened pre-0.6.0 results export 6 bands
`STATUS.md:22` and the Guide state 8 bands; bands 7–8 are appended only
`if (S.final.tvmax && S.final.dvdur)`, so a 0.5.0 run reopened in 0.6.0
exports 6 bands. The response doc carries the qualifier ("only for runs
that recorded them"); STATUS and the Guide do not.
*Fix:* add the qualifier in both places.

### F-23 (B-08, part) — The gate outlet's wetted regime is a centroid-head convention; worth one line in help
In the wetted regime the code's `cd·w·d·sqrt(g·d)` is the centroid-head
orifice on the wetted area — exact against that convention, continuous at
d = a (38.5 cfs from both regimes), and its equilibria match hand
calculation. Strip-by-strip integration of the orifice law gives (2/3)√2
≈ 0.943 of the code's coefficient (a 6% flow difference; equilibrium
0.730 vs 0.702 ft) — a convention choice, not an error. L18 checks only
the code's own formula.
*Fix:* one line in help naming the convention.

### F-24 (B-09) — tvmax/tmax are stamped at chunk *mid*-time; a comment says chunk-start
`simulate` passes `tHours = (t + span/2)/3600` to every step of a chunk,
and both the depth-max time and the new time-of-max-speed record it. The
CpuSolver field comment calls tvx "the chunk-start convention of tmax" —
the convention is chunk-mid for both. CPU and WGSL agree; wording only.
*Fix:* correct the comment.

### F-25 (C-05 observation) — L13's quoted bound is met with no margin at the coarse chunk
The gate measured L13's 900 s-chunk error at **0.0010 ft — exactly at**
the quoted 0.001 ft bound (the gate accepts ≤). The claim is true; there
is no headroom if anything upstream shifts slightly.
*Fix:* none required; consider quoting "at most 0.001 ft (measured
0.0002/0.0010)" so the margin is visible.

### F-26 (C-08) — E-07 through the page remains unverified end-to-end (a review-script defect; the app behaved correctly)
Pass C's RT-B set `curb_length_ft` but not `curb_height_ft` on its
fixture inlet; the app refused the run by name ("a curb inlet needs
curb_length_ft and curb_height_ft", `couple2way.js:196`) — correct
behaviour. The inlet file was accepted at load. E-07's page-level
verification therefore still rests on the Node evidence (C19, W18, both
in the passing 259).
*Fix:* none in the product; a corrected RT-B belongs in the 0.6.1
verification battery.

### F-27 (A-06) — The claims gate runs the lakes suite twice on every run
`tools/check_claims.py` calls `cache.get(key, run_suite(key))` — Python
evaluates the default argument eagerly, so `test_lakes.js` (already run
and cached for L12) executes a second time and its result is discarded
(≈ 90 s duplicated inside an ≈ 8-minute gate run on the review VM).
*Fix:* test membership first (`if key not in cache: cache[key] =
run_suite(key)`).

### F-28 (A-10) — Several new tests assert bounds far looser than the values STATUS quotes (the 0.5.0 F-05/F-06 pattern, in new tests)
T11/EA Test 3: share east of crest asserted in (1%, 30%) vs quoted 18.3%;
right-depression depth asserted > 0.15 ft vs quoted 0.166 m; peak speed
asserted < 3.7 m/s while the comment cites a published envelope "up to
about 3 m/s" — a regression halving the quoted depth would still pass.
V8/E-09: duration asserted in (2,700 s, 5,760 s) vs quoted 3,191 s; time
of max in (0, 2] h vs quoted 0.338 h. B27: "106,266 soil cells" quoted;
the check asserts only `soilCells > 0`. The quoted values are measured
prints and are not said to be wrong — the tests would not catch them
drifting well away.
*Fix:* tighten the assertions toward the quoted values (as was done for
L13/C18), or stop quoting the extra digits in STATUS.

---

## Reproduced by execution (Pass C, with A/B corroboration)

| Claim | Measured | Verdict |
|---|---|---|
| Node 259/259 | 259 PASS / 0 FAIL, per-suite identical | Confirmed |
| Browser 80/80 | 79 defined; 58 executed, 0 FAIL (env modules missing) | Not reproduced — see F-11 |
| B20 = 55.5367 ft | Never executed in this review | Not verified — see F-09/F-11 |
| T10: 54,801 / 54,074 / 53,575 cf | Identical (−2.3% max) | Confirmed |
| L14/T10 fail-first on 0.5.0 | Hour-0.52 throw; 47,031 cf at cfl 0.1 | Confirmed |
| L12 +0.111720 ft · C18 +17,990 cf · soils 13.99/2.61/14.58 | Gate-measured exact | Confirmed |
| L13 within 0.001 ft | 0.0002 / 0.0010 — at the bound | Confirmed, no margin (F-25) |
| Claims gate passes + catches drift | Pristine exit 0; 3/3 sabotages exit 1 | Confirmed |
| Dist 5,768,737 B, ace9da88… | Exact; 43/43 input hashes (Pass A) | Confirmed |
| E-10: 8M cells / 409 s / 7,982,703 wet | Not re-run; 500k sanity clean | Not verified |
| E-04 provenance round trip | Shown; values identical; object changes | Partial (F-04) |
| E-06 rating outlet via page | 27,231 cf drained, budget error 0.0 cf | Confirmed |
| E-07 on-grade via page | Accepted at load; run blocked by script fixture | Not verified via page (F-26) |

## Verified clean
- **0.5.0 fixes under independent probes (Pass B):** F-01 (fed-lake spill
  completes — 1.08M cf in over 6 h in B's own probe — no abort;
  withdrawal-then-feed safe; rain on lake cells booked exactly once);
  F-13 (first chunk −0.0024 ft starting 5 ft above the lip); F-09
  (Euclidean pick 16 over 18; diagonal at 4.24 cells correctly refused at
  radius 3, found at 5); F-10 (hand calc at two depths); F-11 precedence
  (GeoKey > UNITTYPE > CRS); F-31 (dateAt == times for all 72 periods of
  the shipped .out); F-29 except F-05 (genuine bad tokens named with node,
  field, value).
- **E-06 outlets except F-02/F-16/F-17:** rating interpolation exact
  (settles 102.500 ft); above-last-stage flow held; nonzero-first-flow
  rating hovers at the control with an exact budget; never-below-control
  cap holds in all drainage probes; multiple outlets refused by name (one
  outlet per lake by design); gate regimes continuous at d = a.
- **E-07:** 13 HEC-22 hand computations agree to all printed digits
  (curb LT/E, grate E0/Rf/Rs, gutter Q/V, combination = grate, clogging
  treatment); C19 figures reproduce (1.346 of 2.394; 4.928 of 14.12);
  missing slopes refused by name.
- **E-09 invariants (probe, 480 cells):** duration > 0 ⟺ dvmax >
  threshold (0 violations); tvmax inside the run window exactly where
  vmax > 0; changing dvThresh leaves the physics bit-identical; CPU/WGSL
  velocity blocks mirror.
- **E-04 except F-03/F-04:** hashes are SHA-256 over raw bytes as loaded;
  provDiff catches cfl and per-kind hash changes (and R-C3); 0.5.0 files
  unpack in 0.6.0 and vice versa at unchanged format version 1.
- **Diff discipline:** the src/ diff against 0.5.0 is confined to register
  items plus E-04/E-09 plumbing; the GPU uniform's dvThresh occupies the
  previously unused slot; no unrelated numerics touched.
- **Response doc:** ~30 rows spot-checked accurate by Pass A (F-02 θ
  description, F-03, F-04, F-05, F-07, F-08, F-10…F-35 items as listed in
  pass-A.md), including the two build corrections carried from 0.6.0
  (F-13 reframing; C10's corrected 5.4225 cfs expectation).
- **Winter Haven site doc** counts reconciled (145 pipes, 162 nodes, 154
  with lidar ground); **CRS catalog** exactly 5,252 entries; **E-12** has
  zero fabricated numbers (procedure + empty table only).

## Scope limits
- **Browser battery incomplete in the review VM** (missing `geopandas`,
  `pyswmm`) — see F-11. All browser evidence is SwiftShader software
  WebGL; no real GPU anywhere in this review (E-12 remains the path).
- **E-10's 8M-cell run not repeated** (500k sanity only).
- **Pass B is CPU-only:** the WGSL path was verified by reading,
  formula-by-formula against the CPU, not by execution; a full two-lake
  SWMM-in-the-loop fixture was not built (coupler verified at `simulate`
  level + code reading); the F-01 guard's exact 0.01 ft trip boundary was
  not probed (no genuine solver failure could be constructed without
  modifying the engine).
- **F-04's field-level provenance diff was not captured** — recorded as a
  failure with the after-state; diagnosis belongs to the fix round.
- Pass C's gate battery and round trip were re-run by a finishing agent
  after the first Pass C agent ended without a report; its Node,
  browser-attempt and fail-first logs are the first agent's, read as
  found. All evidence is in the pass workdirs.

## Suggested 0.6.1 scope (for adjudication)
A patch release, no new features: the doc corrections (F-06, F-07, F-09
wording, F-14, F-15, F-19, F-21, F-22, F-25 wording); T10 extended to
0.95/1.0 with the θ claim fixed or qualified (F-01); pipe centroid head
with L17 re-derived independently (F-02); provenance completed and made
round-trip-stable (F-03, F-04); shape-aware `secNum` (F-05); gate
hardening (F-10, F-27) and suites printing their counts (F-20);
assertions tightened toward quoted values (F-28); outlet kind named in
the results ledger (F-12); the small engine guards (F-13 warning, F-16,
F-17, F-18); the frozen E-05 evidence committed (F-08); and the browser
battery completed with `geopandas` + `pyswmm` installed, closing F-11
and F-26's verification gaps.

## Annexes
- Pass A report: `flood-sim-review-v060-workA/pass-A.md`
- Pass B report: `flood-sim-review-v060-workB/pass-B.md` (probes p1–p6 in the same folder)
- Pass C report: `flood-sim-review-v060-workC/pass-C.md` (evidence logs in its `logs/`)
