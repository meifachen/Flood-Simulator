# Flood Simulator: project rules

## Standing permissions
- Without asking:
  - commit to the working branch;
  - write the working tree and a git bundle into the local folder `C:\Users\meifa\OneDrive\Documents\Projects\Flood-Simulator`;
  - start and stop local test servers;
  - use synthetic or public test data.
- Always ask:
  - pushing to GitHub (the owner pushes from the local folder);
  - anything public-facing;
  - adding client or non-public data to the repo;
  - deleting files in the local folder.

## Conventions
- American English. US customary units inside the engine (ft, s, cfs, in/hr). SI inputs are converted on load and the conversion is shown.
- No AI or LLM attribution in code, docs or commits.
- Engine numerics live in `src/engine/flood2d.js`. The CPU and WGSL code paths implement the same formulas, operation by operation, and must stay that way; they are not bit-identical (the CPU computes in float64 with a Newton early exit, the WGSL in float32 with a fixed 12 iterations), so tests compare them to a stated tolerance (emulated agreement about 2-5e-8 relative per step; the browser check measured a GPU-vs-CPU maximum-depth difference of 7.63e-06 ft under SwiftShader).
- Bad input is refused with a message that names the item and the value. It is never silently replaced.
- Every new test must fail on the code before the change (fail-first) unless it covers a brand-new function (then say so).
- The app is a single offline HTML file built by `python tools/build.py`. External libraries are inlined from `vendor/` with their licenses.
- Done means tested through the path the user uses: the built HTML in Chromium, desktop and 390 px, light and dark, no console errors.
- After two failed fixes of the same symptom, stop and do root-cause analysis.
- Keep `STATUS.md` current: what works, what was tested, what was not.
