// Stress smoke run (E-10): build a grid at the app's 8 million cell limit, run a short simulation on the CPU
// engine, save the results file and reopen it. Run with node:  node tools/stress_grid.js [cells]
// Prints cell count, step count, wall times and peak memory so the numbers can be quoted in STATUS.md.
// The GPU path is not exercised here (no GPU in the build environment); see tools/gpu_benchmark.md.
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const F = require("../src/engine/flood2d.js");
const ctx = vm.createContext({ Blob, Response, CompressionStream, DecompressionStream, TextEncoder, TextDecoder, Uint8Array, Float32Array, Float64Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, ArrayBuffer, DataView, JSON, Math, Number, Object, String, Array, Error, Date });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/app/results_io.js"), "utf8") + "\nthis.RIO = RIO;", ctx);
const RIO = ctx.RIO;

(async () => {
  const target = Number(process.argv[2] || 8000000);
  // 4,000 columns for the full-size run; smaller targets get a square-ish grid (review 0.6.1 ENG6-9: below 4,000 cells ny was 0)
  if (!(target >= 100)) throw new Error(`target ${process.argv[2]} is not a cell count of 100 or more`);
  const nx = Math.min(4000, Math.max(10, Math.round(Math.sqrt(target * 2)))); const ny = Math.floor(target / nx); const N = nx * ny;
  const dx = 10, z = new Float32Array(N), type = new Uint8Array(N), n = new Float32Array(N).fill(0.035),
    perv = new Float32Array(N), ks = new Float32Array(N), psimd = new Float32Array(N), mult = new Float32Array(N).fill(1), road = new Uint16Array(N), node = new Uint8Array(N);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) { const k = r * nx + c; z[k] = 100 - 20 * c / nx + 3 * Math.sin(r / 90) * Math.cos(c / 140); if (r === 0 || c === 0 || r === ny - 1 || c === nx - 1) type[k] = 1; }
  const t0 = Date.now();
  const g = F.makeGrid({ nx, ny, dx, z, type, node, n, perv, ks, psimd, mult, road, K: 1 });
  const tGrid = (Date.now() - t0) / 1000;
  const solver = new F.CpuSolver(g);
  const t1 = Date.now();
  const out = await F.simulate(g, solver, { t0: 0, t1: 600 / 3600, rainAt: () => 2, stageAt: () => [0], readSec: 600, chunkSec: 60 });
  const tRun = (Date.now() - t1) / 1000;
  const st = out.frames.at(-1).st, q = new Uint8Array(N);
  // st[4k+2] is the engine's maximum depth over the run (the depth itself is st[4k]); 0.6.1 saved the final depth as "hmax" (ENG6-9)
  let wet = 0; const hmax = new Float32Array(N);
  for (let k = 0; k < N; k++) { const h = st[4 * k]; hmax[k] = st[4 * k + 2]; if (hmax[k] > 0.01) wet++; q[k] = Math.max(0, Math.min(255, Math.round(h / 12 * 255))); }
  const S = { grid: { G: { nx, ny, x0: 0, y1: 0, cs: dx, dxFt: dx }, info: { nx, ny }, opts: {}, z, type },
    frames: [{ q, sum: { tHours: 600 / 3600 } }],
    final: { hmax, tmax: new Float32Array(N), bMax: new Float32Array(N), vmax: out.vmax, dvmax: out.dvmax, tvmax: out.tvmax, dvdur: out.dvdur, froude: out.froude, froudeCells: 0, ledger: out.ledger }, dem: {}, swmm: null, prov: { app: "stress", settings: {}, inputs: [] } };
  const t2 = Date.now();
  const gz = await RIO.pack(S, "stress");
  const tPack = (Date.now() - t2) / 1000;
  const file = path.join(os.tmpdir(), "stress_results.fsim.gz");
  fs.writeFileSync(file, Buffer.from(gz));
  const t3 = Date.now();
  const back = await RIO.unpack(new Uint8Array(fs.readFileSync(file)));
  const tOpen = (Date.now() - t3) / 1000;
  // the reopened file must hold the same maximum depths cell for cell, not only the same wet count
  let wetBack = 0, diff = 0; for (let k = 0; k < N; k++) { if (back.final.hmax[k] > 0.01) wetBack++; if (back.final.hmax[k] !== hmax[k]) diff++; }
  console.log(JSON.stringify({ cells: N, nx, ny, dxFt: dx, gridSec: +tGrid.toFixed(2), steps: out.steps, runSec: +tRun.toFixed(1), wetCells: wet, ledgerErrPct: +out.ledger.errPct.toFixed(4), fileMB: +(gz.length / 1048576).toFixed(1), packSec: +tPack.toFixed(1), reopenSec: +tOpen.toFixed(1), wetCellsAfterReopen: wetBack, peakRssMB: Math.round(process.memoryUsage().rss / 1048576) }, null, 1));
  if (wetBack !== wet || diff) { console.error(`reopened file disagrees: wet cells ${wet} vs ${wetBack}, ${diff} cells differ in maximum depth`); process.exit(1); }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
