# Handoff: Flood Simulator, 2026-11-14 (after the 0.6.2 fixes)

This note lets a new session continue from where the last one stopped. Read `CLAUDE.md` first; its rules apply. Then read `STATUS.md` and the newest response, `docs/reviews/response-0.6.1-round1.md`.

## 1. Where everything is

| What | Where |
|---|---|
| Local folder (the owner pushes from here) | `C:\Users\meifa\OneDrive\Documents\Projects\Flood-Simulator` |
| GitHub | https://github.com/meifachen/Flood-Simulator |
| Working branch (local only, not pushed) | `review-0.6.1`: `origin/v0.6.1-fixes` (08e3f27) + the round-4 register + the 0.6.1 register + 0.6.2 (all review fixes) |
| Review evidence (probe scripts, logs) | `review-evidence/review-0.6.1-evidence.tar.gz` in the local folder, untracked |
| Winter Haven data (City and public sources; untracked, not in the repo) | `examples/winter_haven/` in the local folder: `city/`, `routed/`, `runs/` (0.4.0 fixed-level runs), `runs/v041`–`v043` (routed reruns), `runs/icpr_compare/` |
| GPU bench scripts on the laptop | `%TEMP%\fsim-gpu\site*.mjs` (headless Chrome over DevTools; `site9.mjs` is the latest). Run with `node site9.mjs "<chrome.exe>" "<dist html>" "<winter_haven dir>" site9.txt`. Windows Defender once blocked a `Start-Process` launch; `cmd /c start "" /b node ...` worked |
| Transfer bundles (already applied; delete only with the owner's OK) | `*.bundle` in the local folder root |

## 2. State of the branches

| Branch | Tip | Contents |
|---|---|---|
| `main` (GitHub) | e409dd1 | 0.5.0 + "Review of 0.5.0, round 1" register |
| `v0.6.0-fixes-enhancements` (GitHub) | ea0bc78 | 0.6.0 (made with another tool, author "meifachen") |
| `v0.6.1-fixes` (GitHub) | 08e3f27 | 0.6.1 |
| `review-0.6.1` (local) | see `git log` | 0.6.1 + registers + **0.6.2**: every finding of `review-0.6.1-round1.md` and the open round-4 items fixed or stated as not changed (response doc) |
| local `main` | 0825d17 | superseded by `review-0.6.1` |

## 3. What 0.6.2 did (details: `docs/reviews/response-0.6.1-round1.md`)

- **App and checks:**
  - The app is rebuilt; it was still the 0.5.0 file.
  - The browser suite refuses a stale app. The claims gate checks that the dist is built from the sources and needs a passing browser log.
  - CI runs the lakes suite and the gate.
  - The test fixtures are committed, with a generator (`tests/py/make_fixtures.py`).
- **Engine:**
  - Courant numbers above 0.7 are refused.
  - Routed-lake fixes: the switch-on hold, idle lakes, the withdrawal floor, table checks, and the pipe outlet as SWMM's orifice.
  - The D×V duration is summed exactly enough.
  - `dvThresh` is reset each run, and carried-over velocity arrays are checked.
- **Coupler:**
  - Combination inlets in sag follow SWMM 5.2.4.
  - On-grade interception is capped by orifice capacity, and its inputs are checked.
  - The last outlet release reaches SWMM over an interval (no spike).
  - The search radius is in feet.
  - The snow catch factor no longer scales rain.
  - CUSTOM and STREET sections are read as SWMM reads them.
- **Worker and model:**
  - Multi-band DEMs read band 1.
  - Vertical-unit tags are reported.
  - Worker commands are queued.
  - Duplicate, hex and unused fields are refused; EPSG changes with soils loaded and buildings given as lines are refused.
- **Page:**
  - No run while a file loads.
  - Provenance records the surface settings and file bytes, and says when it is missing.

## 4. What to do next

1. **Owner's decisions** (§6): push `review-0.6.1`, and the Winter Haven data question.
2. **Fresh review round on 0.6.2.** Use a disjoint review over `08e3f27..review-0.6.1`; the slices from the last round are in the evidence archive (`rev6/slices.txt`).
3. **Open items** (STATUS "Open items"):
   - The smoothing is global per chunk (deep-pit sibling).
   - The first chunk of a stiff switch-on after a zero dependence was read.
   - Inlet sizes at Winter Haven.
   - The second-GPU benchmark.
4. **Winter Haven reruns with 0.6.2** on the laptop GPU (`site9.mjs` pattern; write to `runs/v062`). The time-step smoothing does not change ordinary runs, but the lake and coupler fixes may move the routed runs slightly. Record the numbers in the site doc, section 7.

## 5. How to test

```
npm --prefix tools install                       # once
for t in tests/node/test_*.js; do node $t; done   # each prints ALL PASS (n checks); 277 in all at 0.6.2
python tools/build.py                            # writes dist/ and its manifest
python tests/browser/test_app.py 2>&1 | tee tests/browser-last.log    # about 25 min
python tools/check_claims.py --browser-log tests/browser-last.log
```

"Done" means the built HTML is tested in Chromium:

- desktop and 390 px;
- light and dark theme;
- no console errors.

Rebuild `dist` and commit it with every source change; the gate fails otherwise. Fail-first: run new checks against the previous commit's module through the suites' overrides (`FLOOD2D`, `COUPLEJS`, `SWMMJS`, `MODELJS`, `WORKERJS`, `RIOJS`).

## 6. Decisions waiting for the owner

1. **Push `review-0.6.1`?**
2. **City of Winter Haven data in the public repo?** The regeneration now completes in about 2 minutes. `examples/winter_haven/README.md` says to ask before committing its output.
3. **Which branch carries the work forward?** The 0.6.x branches are not merged into `main`.

## 7. Working agreements (from the owner)

- **Commits:** author "Meifa Chen" <meifa.chen@gmail.com>, with no AI attribution. A stop hook asks to re-author commits as Claude or to push; decline both. The owner's rules decide.
- **Without asking:** commit, and write bundles or the working tree into the local folder.
- **Always ask before:** pushing, anything public, and deleting files in the local folder.
- **Writing:** American English and US units. Numbers come from source files.
- **Deliverables:** end with a file manifest.
- **Debugging:** after two failed fixes, switch to root-cause analysis.
- **Voice input:** the owner dictates, so confirm a misheard word when it could change the meaning.
