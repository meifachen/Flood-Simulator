# Handoff: Flood Simulator, 2026-11-14

This note lets a new session continue from where the last one stopped. Read `CLAUDE.md` first; its rules apply. Then read `STATUS.md` and the newest register, `docs/reviews/review-0.6.1-round1.md`.

## 1. Where everything is

| What | Where |
|---|---|
| Local folder (the owner pushes from here) | `C:\Users\meifa\OneDrive\Documents\Projects\Flood-Simulator` |
| GitHub | https://github.com/meifachen/Flood-Simulator |
| This branch (local only, not pushed) | `review-0.6.1`, from `origin/v0.6.1-fixes` (08e3f27) plus two commits: the round-4 register (carried from local `main` 0825d17) and the 0.6.1 register with this handoff |
| Review evidence (probe scripts, logs, prompts, slice list) | `review-evidence/review-0.6.1-evidence.tar.gz` in the local folder, untracked |
| Winter Haven data (City and public sources, untracked, not in the repo) | `examples/winter_haven/` in the local folder: `city/`, `routed/`, `runs/` (0.4.0 fixed-level runs), `runs/v041`, `v042`, `v043` (routed reruns), `runs/icpr_compare/` |
| GPU bench scripts on the laptop | `%TEMP%\fsim-gpu\site*.mjs` (headless Chrome over DevTools; `site9.mjs` is the latest). Run with `node site9.mjs "<chrome.exe>" "<dist html>" "<winter_haven dir>" site9.txt` |
| Transfer bundles (already pulled, can be deleted with the owner's OK) | `fsim-*.bundle` in the local folder root |

## 2. State of the branches

| Branch | Tip | Contents |
|---|---|---|
| `main` (GitHub) | e409dd1 | 0.5.0 + "Review of 0.5.0, round 1" register |
| `v0.6.0-fixes-enhancements` | ea0bc78 | 0.6.0: fixes F-01..F-35 and enhancements E-01..E-12 (on-grade inlets, rating/pipe/gate lake outlets, provenance, D×V duration, claims gate, ...) |
| `v0.6.1-fixes` | 08e3f27 | 0.6.1: fixes of the 0.6.0 review |
| local `main` | 0825d17 | 066baa5 + the round-4 register; diverges from GitHub `main` (not pushed; superseded by this branch) |
| local `review-0.6.1` | this commit | v0.6.1-fixes + both registers + this handoff |

The 0.6.x commits were made by another tool ("Muse") under the author name "meifachen"; earlier commits are "Meifa Chen".

## 3. What to do first (in this order)

1. **Rebuild and commit dist (P-01).** `dist/FloodSimulator.html` in every branch is still the 0.5.0 build, while the manifest says 0.6.1. Run `python tools/build.py`, commit both files, and make the browser stamp compare the manifest sha with the file (P-08). Rebuilt, the browser suite passes 80 checks.
2. **Commit `tests/fixtures/` (DS-4).** Without them `test_model.js` crashes after 37 of 47 checks, in CI too. The reviewer regenerated them with `prep_dem.py --epsg 2236 --cell 120`, with and without `--zunits ft`, plus one retagged `ft_survey`. The exact recipe is in the evidence archive, `rev6/work/worker/probes`.
3. **Add `test_lakes.js` and `check_claims.py` to `.github/workflows/test.yml` (DS-3).** Then fix the gate's holes (DS-2):
   - minimum sha length;
   - require a pass marker;
   - anchor the B20 regex;
   - fail when the log is missing.
4. **Fix the numerics findings, then the rest of `review-0.6.1-round1.md`:**
   - ENG6-1: the Courant number above 0.7. The help text currently claims invariance to 0.95; correct it or the code.
   - CPL6-1: combination inlets in sag. Return to 0.5.0's formula, which matches SWMM 5.2.4 `getOnSagInletCapture`.
   - CPL6-3: the on-grade spread limit.
   - WRK6-1: multi-band DEMs.
   - ENG6-2 and ENG6-3: the lake hold.
   - CPL6-2: the snow catch factor.
   - Provenance (WRK6-3, P-03..P-05).
   - The still-open round-4 items listed in §2c of the register.

   Each fix needs a fail-first test (CLAUDE.md).
5. **Run everything** (§4), update `STATUS.md`, write `response-0.6.1-round1.md`, commit, then ask the owner before pushing.

## 4. How to test

```
npm --prefix tools install                 # once
for t in tests/node/test_*.js; do node $t; done      # each prints ALL PASS or FAIL lines
python tools/build.py                      # writes dist/
python tests/browser/test_app.py           # Playwright Chromium, about 25 min, prints ALL PASS (n checks)
python tools/check_claims.py --browser-log <log>     # gated figures
```

"Done" means the built HTML is tested in Chromium:

- desktop and 390 px;
- light and dark theme;
- no console errors.

Run the GPU checks on the laptop through `%TEMP%\fsim-gpu`.

## 5. Decisions waiting for the owner

1. **Push `review-0.6.1`?** It carries the two registers and this handoff.
2. **May the City of Winter Haven data go into the public repo?** `examples/winter_haven/README.md` (0.6.1) says to commit generated files when a regeneration completes. CLAUDE.md lists non-public or client data under "always ask", and this has never been decided. The builder now completes in about 2 minutes (SDA answered), so the question is live.
3. **Which branch is the line of work?** The 0.6.x branches are not merged into `main`. Local `main` 0825d17 is not pushed and is superseded by `review-0.6.1`.

## 6. Working agreements (from the owner)

- **Commits:** author "Meifa Chen" <meifa.chen@gmail.com>, with no AI attribution. A stop hook asks to re-author commits as Claude; the owner's rule overrides it, so decline each time.
- **Without asking:** commit, and write bundles or the working tree into the local folder.
- **Always ask before:** pushing, anything public, and deleting files in the local folder.
- **Writing:** American English and US units. Numbers come from source files.
- **Deliverables:** end with a file manifest.
- **Debugging:** after two failed fixes, switch to root-cause analysis.
- **Voice input:** the owner dictates, so confirm a misheard word when it could change the meaning.
