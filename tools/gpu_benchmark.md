# Second-GPU benchmark (E-12) — procedure

The 0.5.0 performance figures were measured on one machine (home laptop, Intel Core 7 150U
integrated GPU) plus software rendering (SwiftShader) in the test environment. This procedure
repeats the measurement on a second, different GPU so the speedup range in STATUS.md rests on
more than one device. It takes about ten minutes and needs no code changes.

## Procedure

1. Build the app (`python tools/build.py`) or use the shipped `dist/FloodSimulator.html`.
   Open it in Chrome or Edge on the machine under test.
2. Load the US synthetic example (Examples menu) and build the grid at the default 12 ft cell.
3. Note the GPU the browser reports: the run panel shows the WebGPU adapter description after
   the first GPU run; also record it from `chrome://gpu` (the "Renderer" / WebGPU line).
4. Run the same case twice, once with the engine set to GPU and once to CPU: two-way coupling
   off, rain from the model gauge, a 1 h to 1.25 h window is enough (a like window to the
   browser suite's routed-pond check, B20: the pond set to routed at 54.8 ft, uniform rain
   2 in over 1 h, from hour 0). Record for each run: wall time shown in the run log, steps
   taken, cell count.
5. Repeat step 4 on the Winter Haven example if it has been generated (see
   `examples/winter_haven/`), at its default cell size.
6. Also record: machine, CPU, GPU model and driver, browser and version, operating system.

## What to record (fill in and paste into STATUS.md, "Tested" section)

| Item | Value |
| --- | --- |
| Machine / CPU | |
| GPU (adapter string) | |
| Browser + version | |
| Synthetic example: cells / steps | |
| GPU run wall time | |
| CPU run wall time | |
| Speedup (CPU ÷ GPU) | |
| Winter Haven (if run): cells / steps / GPU s / CPU s / speedup | |

## Acceptance

There is no pass mark; the point is a second honest data point. If the GPU run fails or falls
back, record that instead, with the console message. When the table is filled in, move the
STATUS.md "Not tested" line for the second GPU into "Tested" with these numbers and update the
response doc entry for E-12.
