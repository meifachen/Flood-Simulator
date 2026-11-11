// Routed lakes (level pools that rise with the water they gain): node tests/node/test_lakes.js   (exit 1 on failure)
const F = require(process.env.FLOOD2D || "../../src/engine/flood2d.js");
const res = []; const ok = (name, pass, info) => { res.push({ name, pass: !!pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + "  " + info); };

// a walled basin whose floor falls toward a lake in the east (columns 30-38), lake bed at 95 ft
function basin() {
  const nx = 40, ny = 30, dx = 10, N = nx * ny, z = new Float32Array(N), type = new Uint8Array(N), node = new Uint8Array(N), n = new Float32Array(N).fill(0.03),
    perv = new Float32Array(N), ks = new Float32Array(N), psimd = new Float32Array(N), mult = new Float32Array(N).fill(1);
  let lakeCells = 0;
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
    const k = r * nx + c, wall = r === 0 || c === 0 || r === ny - 1 || c === nx - 1;
    if (wall) { type[k] = 1; z[k] = 110; mult[k] = 0; continue; }
    if (c >= 30) { type[k] = 2; node[k] = 0; z[k] = 95; mult[k] = 0; lakeCells++; continue; }
    z[k] = 100 + 0.01 * (30 - c) * dx;
  }
  const g = F.makeGrid({ nx, ny, dx, z, type, node, n, perv, ks, psimd, mult, K: 1 });
  return { g, nx, dx, lakeArea: lakeCells * dx * dx };
}
const vol = (g, st) => { let v = 0; for (let k = 0; k < g.N; k++) if ((g.aux[4 * k + 2] & 3) === 0) v += st[4 * k]; return v * g.dx * g.dx; };
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

(async () => {
  const { g, nx, lakeArea } = basin(), cell = 15 * nx + 5, lvl0 = 99;
  // L1 an inflow that runs downhill into a routed lake raises it by exactly the volume that crossed its edge
  {
    const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 3, rainAt: () => 0, stageAt: () => [lvl0], sources: [{ cell, name: "Q" }], sourceAt: (h) => [h < 1 ? 5 : 0],
      routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: lvl0, name: "East lake" }], readSec: 900 });
    const L = r.ledger, lk = r.lakes, stored = vol(g, r.frames[r.frames.length - 1].st), rise = lk.end[0] - lvl0;
    ok("L1 the lake rises by the volume the 2D sent into it (area x rise = 2D ledger into lakes)", lk && near(rise * lakeArea, L.toLakes, 1e-5) && near(lk.from2d[0], L.toLakes, 1e-5) && rise > 0.05,
      `rise ${rise.toFixed(4)} ft x ${lakeArea} sq ft = ${(rise * lakeArea).toFixed(1)} cf; 2D into lakes ${L.toLakes.toFixed(1)} cf`);
    ok("L1 inflow = water left on the ground + water in the lake (2D balance closes)", near(L.inflow, stored + L.toLakes, 1e-4) && Math.abs(L.errPct) < 1e-3,
      `inflow ${L.inflow.toFixed(1)} cf = surface ${stored.toFixed(1)} + lake ${L.toLakes.toFixed(1)} cf; closure ${L.errPct.toExponential(2)}%`);
    ok("L1 the lake level is reported over time and peaks at the end (no outlet)", lk.series.length > 100 && near(lk.peak[0], lk.end[0], 1e-9) && lk.series[0].levels[0] >= lvl0, `${lk.series.length} chunks; ${lvl0} -> ${lk.end[0].toFixed(4)} ft`);
  }
  // L2 rain on a routed lake raises it by the rain depth over the lake's area (here the area given is larger than the part in the grid)
  {
    const area = 4 * lakeArea;
    const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 1, rainAt: () => 1, stageAt: () => [lvl0], routedLakes: [{ lake: 0, areaFt2: area, level0: lvl0 }], readSec: 900 });
    const lk = r.lakes;
    ok("L2 1 in of rain on the lake's whole area is booked as rain on the lake", near(lk.rain[0], area / 12, 1e-9), `rain on the lake ${lk.rain[0].toFixed(2)} cf (expected ${(area / 12).toFixed(2)})`);
    ok("L2 level change = (rain on the lake + runoff from the grid) / area", near((lk.end[0] - lvl0) * area, lk.rain[0] + lk.from2d[0], 1e-5) && lk.from2d[0] > 0, `${((lk.end[0] - lvl0) * area).toFixed(1)} cf = ${lk.rain[0].toFixed(1)} + ${lk.from2d[0].toFixed(1)} cf`);
  }
  // L3 outside inflow (for example SWMM outfalls on the lake) is added, and the routed level is passed back to the caller
  {
    const seen = [];
    const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 0.5, rainAt: () => 0, stageAt: () => [lvl0], routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: lvl0 }],
      lakeInflow: (a, b, levels) => { seen.push(levels[0]); return [10 * (b - a) * 3600]; }, chunkSec: 30, readSec: 900 });
    const lk = r.lakes;
    ok("L3 10 cfs from outside for 0.5 h raises the lake by 18,000 cf / area", near(lk.outside[0], 18000, 1e-9) && near(lk.end[0] - lvl0, 18000 / lakeArea, 1e-5), `outside ${lk.outside[0].toFixed(1)} cf; rise ${(lk.end[0] - lvl0).toFixed(5)} ft`);
    ok("L3 the caller sees the level rise chunk by chunk", seen.length === r.chunks && seen[0] === lvl0 && seen[seen.length - 1] > lvl0, `${seen.length} calls; ${seen[0]} -> ${seen[seen.length - 1].toFixed(4)} ft`);
  }
  // L4 a rising lake spills onto low ground: a lake started above the land next to it loses water to it, and its level falls
  {
    const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 1, rainAt: () => 0, stageAt: () => [101], routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: 101 }], readSec: 900 });
    const stored = vol(g, r.frames[r.frames.length - 1].st), lk = r.lakes;
    ok("L4 water that spills out of a routed lake lowers it by the same volume", lk.end[0] < 101 && near((101 - lk.end[0]) * lakeArea, stored, 1e-4), `level 101 -> ${lk.end[0].toFixed(4)} ft; ${((101 - lk.end[0]) * lakeArea).toFixed(1)} cf left the lake, ${stored.toFixed(1)} cf on the ground`);
  }
  // L5 a fixed lake still follows stageAt; bad routed-lake input is refused
  {
    const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 0.25, rainAt: () => 0, stageAt: () => [lvl0], sources: [{ cell, name: "Q" }], sourceAt: () => [5], readSec: 900 });
    ok("L5 without routing the lake is not reported and keeps its level", r.lakes === null, "lakes: " + JSON.stringify(r.lakes));
    const msgs = [];
    for (const rl of [{ lake: 1, areaFt2: 1, level0: 99 }, { lake: 0, areaFt2: 0, level0: 99 }, { lake: 0, areaFt2: 1, level0: NaN }]) {
      try { await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 0.1, rainAt: () => 0, stageAt: () => [lvl0], routedLakes: [rl] }); msgs.push("accepted"); } catch (e) { msgs.push(e.message); }
    }
    ok("L5 an unknown lake, a zero area and a missing starting level are refused", /lake 1 is not one/.test(msgs[0]) && /area 0/.test(msgs[1]) && /starting level NaN/.test(msgs[2]), msgs.join(" | "));
  }
  // L6 the routed level is the level the 2D holds: a lake routed from 101 ft spills even though stageAt says 95 ft (its bed)
  {
    const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 0.5, rainAt: () => 0, stageAt: () => [95], routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: 101 }], readSec: 900 });
    const stored = vol(g, r.frames[r.frames.length - 1].st);
    ok("L6 the 2D holds the routed level, not stageAt's (a lake above the land spills)", stored > 1000 && r.lakes.end[0] < 101, `on the ground ${stored.toFixed(0)} cf; lake 101 -> ${r.lakes.end[0].toFixed(3)} ft`);
  }
  // L7 the routed level does not depend on the chunk length (a lake started 3 ft above its lip spills onto dry land, then sloshes back):
  // at every chunk end of a 60 s and a 900 s run, the level is within 0.03 ft of the level of a run in 0.1 s chunks at that time
  // (the chunks are cut so the level moves at most about 0.02 ft in one; at the start it falls 0.06 ft/s, so one chunk of lag is about that)
  {
    const runL = async (chunkSec) => { const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 2, rainAt: () => 0, stageAt: () => [103], routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: 103 }], chunkSec, readSec: 3600 });
      return { end: r.lakes.end[0], T: r.lakes.series.map((x) => x.tHours), L: r.lakes.series.map((x) => x.levels[0]) }; };
    const fine = await runL(0.1), c60 = await runL(60), c900 = await runL(900);
    const at = (t) => { let k = fine.T.findIndex((x) => x >= t - 1e-9); if (k <= 0) return fine.L[Math.max(k, 0)]; const f = (t - fine.T[k - 1]) / (fine.T[k] - fine.T[k - 1]); return fine.L[k - 1] + f * (fine.L[k] - fine.L[k - 1]); };
    const dev = (c) => c.T.reduce((m, t, k) => Math.max(m, Math.abs(c.L[k] - at(t))), 0), lo = (c) => Math.min(...c.L);
    ok("L7 60 s and 900 s chunks follow the level of 0.1 s chunks within 0.03 ft at every chunk end, the lowest level included", [c60, c900].every((c) => dev(c) < 0.03 && Math.abs(c.end - fine.end) < 0.02),
      `largest difference ${dev(c60).toFixed(4)} / ${dev(c900).toFixed(4)} ft; lowest ${lo(fine).toFixed(3)} / ${lo(c60).toFixed(3)} / ${lo(c900).toFixed(3)} ft; end ${fine.end.toFixed(3)} / ${c60.end.toFixed(3)} / ${c900.end.toFixed(3)} ft`);
  }
  // L8 refusals: an area smaller than the lake's own cells, a lake listed twice, outside inflow that is missing or not a number
  {
    const msgs = [], base = { t0: 0, t1: 0.1, rainAt: () => 0, stageAt: () => [lvl0] };
    for (const extra of [{ routedLakes: [{ lake: 0, areaFt2: lakeArea / 2, level0: 99 }] }, { routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: 99 }, { lake: 0, areaFt2: lakeArea, level0: 99 }] },
      { routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: 99 }], lakeInflow: () => [NaN] }, { routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: 99 }], lakeInflow: () => [] },
      { routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: 99 }], lakeInflow: () => null }]) {
      try { await F.simulate(g, new F.CpuSolver(g), Object.assign({}, base, extra)); msgs.push("accepted"); } catch (e) { msgs.push(e.message); }
    }
    ok("L8 a too-small area, a lake listed twice and missing or NaN outside inflow are refused", /smaller than its \d+ cells/.test(msgs[0]) && /listed more than once/.test(msgs[1]) && msgs.slice(2).every((m) => /missing or not a number/.test(m)), msgs.join(" | "));
  }
  // L9 a lake that rises and then falls reports its peak, not its end or start (200 cfs from outside for 6 minutes, then spilling)
  {
    const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 1, rainAt: () => 0, stageAt: () => [lvl0], routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: lvl0 }],
      lakeInflow: (a, b) => [Math.max(0, Math.min(b, 0.1) - a) * 3600 * 200], chunkSec: 30, readSec: 3600 });
    const lk = r.lakes, top = Math.max(...lk.series.map((x) => x.levels[0]));
    ok("L9 the peak of a lake that rises and falls is its highest level", Math.abs(lk.peak[0] - top) < 1e-9 && top > lk.end[0] + 0.01 && top > lvl0 + 1, `start ${lvl0}, peak ${lk.peak[0].toFixed(3)}, end ${lk.end[0].toFixed(3)} ft`);
  }
  // L10 a lake whose outside inflow depends on its level (an outlet weir, as a SWMM outfall at the lake's stage would be) settles at the crest
  // without overshooting, whatever the chunk length; a level below the grid's lowest ground, lakeInflow without routed lakes and a pipe to a routed lake are refused
  {
    const weir = (a, b, lv) => [-3.33 * 150 * Math.pow(Math.max(lv[0] - 97, 0), 1.5) * (b - a) * 3600];
    const runW = async (chunkSec) => { const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 1, rainAt: () => 0, stageAt: () => [lvl0], routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: lvl0 }], lakeInflow: weir, chunkSec, readSec: 3600 });
      let lo = Infinity; for (const x of r.lakes.series) lo = Math.min(lo, x.levels[0]); return { lo, end: r.lakes.end[0] }; };
    const w1 = await runW(1), w60 = await runW(60);
    ok("L10 a level-dependent outlet drains the lake to its 97 ft crest and no lower, with 1 s and 60 s chunks", w1.lo > 96.99 && w60.lo > 96.99 && Math.abs(w60.end - w1.end) < 0.01, `lowest ${w1.lo.toFixed(3)} / ${w60.lo.toFixed(3)} ft; end ${w1.end.toFixed(3)} / ${w60.end.toFixed(3)} ft`);
    // a lake that starts at the grid's lowest ground (a lidar lake's flattened surface) may be drawn below it by an outside withdrawal (5 cfs)
    let zLow = Infinity; for (let k = 0; k < g.N; k++) if ((g.aux[4 * k + 2] & 3) !== 1) zLow = Math.min(zLow, g.aux[4 * k]);
    let wd; try { const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 0.05, rainAt: () => 0, stageAt: () => [zLow], routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: zLow }], lakeInflow: (a, b) => [-5 * (b - a) * 3600], readSec: 3600 }); wd = r.lakes.end[0]; } catch (e) { wd = e.message; }
    ok("L10 a withdrawal may draw a lake that starts at the grid's lowest ground below it (5 cfs for 3 minutes: 900 cf)", typeof wd === "number" && Math.abs((zLow - wd) * lakeArea - 900) < 1, `${typeof wd === "number" ? `start ${zLow.toFixed(2)} ft, end ${wd.toFixed(4)} ft` : wd}`);
    const msgs = [];
    for (const extra of [{ lakeInflow: () => [0] }, { routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: 99 }], pipes: [{ cell: 15 * nx + 20, cda: 1, lake: 0 }] }]) {
      try { await F.simulate(g, new F.CpuSolver(g), Object.assign({ t0: 0, t1: 0.05, rainAt: () => 0, stageAt: () => [lvl0] }, extra)); msgs.push("accepted"); } catch (e) { msgs.push(e.message); }
    }
    ok("L10 lakeInflow without a routed lake and a pipe to a routed lake are refused", /no lake is routed/.test(msgs[0]) && /pipes to routed lakes are not supported/.test(msgs[1]), msgs.join(" | "));
  }
  // L11 a two-way link to a fixed level (an outfall pipe to a node held at 98 ft, 2,500 cfs per foot of head) settles at 98 ft and stays there,
  // with 60 s and 900 s chunks: the chunks are kept under the link's own stability limit, so the level does not burst away from it later
  {
    const link = (a, b, lv) => [-2500 * (lv[0] - 98) * (b - a) * 3600];
    const dev = [];
    for (const chunkSec of [60, 900]) {
      const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 6, rainAt: () => 0, stageAt: () => [99], routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: 99 }], lakeInflow: link, chunkSec, readSec: 900 });
      dev.push(r.lakes.series.filter((x) => x.tHours >= 1).reduce((m, x) => Math.max(m, Math.abs(x.levels[0] - 98)), 0));
    }
    ok("L11 a lake linked both ways to a fixed 98 ft level stays within 0.005 ft of it from hour 1 to hour 6, with 60 s and 900 s chunks", dev.every((d) => d < 0.005), `largest departure ${dev.map((d) => d.toFixed(4)).join(" / ")} ft`);
  }
  // L12 a stage-area table: a lake below its lip (no 2D exchange) given 1 cfs for an hour (3,600 cf) rises to the level whose storage holds it.
  // Table 95 ft: 20,000 sq ft, 100 ft: 40,000 sq ft (linear between). From 98 ft (area 32,000): 3,600 = 32,000 x + 2,000 x^2, x = 0.111720 ft
  {
    const tab = [[95, 20000], [100, 40000]], x = (-32000 + Math.sqrt(32000 ** 2 + 4 * 2000 * 3600)) / (2 * 2000);
    const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 1, rainAt: () => 0, stageAt: () => [98], routedLakes: [{ lake: 0, stageArea: tab, level0: 98 }], lakeInflow: (a, b) => [1 * (b - a) * 3600], readSec: 3600 });
    const cst = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 1, rainAt: () => 0, stageAt: () => [98], routedLakes: [{ lake: 0, areaFt2: 32000, level0: 98 }], lakeInflow: (a, b) => [1 * (b - a) * 3600], readSec: 3600 });
    ok("L12 with a stage-area table the level holds the volume given (3,600 cf from 98 ft: +0.111720 ft by hand); a constant 32,000 sq ft gives +0.1125 ft", Math.abs(r.lakes.end[0] - 98 - x) < 1e-6 && Math.abs(cst.lakes.end[0] - 98 - 3600 / 32000) < 1e-6,
      `table ${(r.lakes.end[0] - 98).toFixed(6)} ft (hand ${x.toFixed(6)}); constant ${(cst.lakes.end[0] - 98).toFixed(6)} ft`);
  }
  // L13 an outlet weir drains a lake below its lip (constant area 25,200 sq ft, crest 97 ft, 10 ft long, Cw 3.0, from 99 ft) as the level-pool
  // solution does: dh/dt = -Cw L (h - c)^1.5 / A, so h(t) = c + (1 / sqrt(h0 - c) + Cw L t / (2 A))^-2; it never goes below the crest,
  // and what the outlet released equals the storage the lake lost
  {
    const Ar = 25200, cw = 3.0, L = 10, c = 97, h0 = 99, ex = (t) => c + Math.pow(1 / Math.sqrt(h0 - c) + cw * L * t / (2 * Ar), -2);
    const run = async (chunkSec) => F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 3, rainAt: () => 0, stageAt: () => [h0], routedLakes: [{ lake: 0, areaFt2: Ar, level0: h0, outlet: { crestFt: c, lengthFt: L, cw } }], chunkSec, readSec: 3600 });
    const r1 = await run(60), r9 = await run(900), errs = [r1, r9].map((r) => r.lakes.series.reduce((m, x) => Math.max(m, Math.abs(x.levels[0] - ex(x.tHours * 3600))), 0));
    const lo = Math.min(...r9.lakes.series.map((x) => x.levels[0]));
    ok("L13 an outlet weir drains the lake along the level-pool solution (within 0.005 ft, 60 s and 900 s chunks), not below its crest; outlet volume = storage lost",
      errs.every((e) => e < 0.005) && lo >= c && Math.abs(r9.lakes.outlet[0] - (h0 - r9.lakes.end[0]) * Ar) < 1e-3 * Ar,
      `largest error ${errs.map((e) => e.toFixed(4)).join(" / ")} ft; end ${r9.lakes.end[0].toFixed(4)} ft (exact ${ex(3 * 3600).toFixed(4)}); outlet ${r9.lakes.outlet[0].toFixed(0)} cf`);
    const msgs = [];
    for (const rl of [{ stageArea: [[95, 20000]] }, { stageArea: [[100, 2e4], [95, 4e4]] }, { stageArea: [[95, 0], [100, 4e4]] }, { areaFt2: Ar, outlet: { crestFt: 97, lengthFt: 0 } }, { areaFt2: Ar, outlet: { crestFt: "97", lengthFt: 10 } }, { areaFt2: Ar, outlet: { crestFt: 97, lengthFt: 10, cw: -1 } }])
      try { await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 0.01, rainAt: () => 0, stageAt: () => [98], routedLakes: [Object.assign({ lake: 0, level0: 98 }, rl)] }); msgs.push("accepted"); } catch (e) { msgs.push(e.message); }
    ok("L13 a one-row, falling or zero-area stage-area table and a zero length, text crest or negative coefficient outlet are refused", /two or more/.test(msgs[0]) && /must rise/.test(msgs[1]) && /positive areas/.test(msgs[2]) && /outlet length 0/.test(msgs[3]) && /outlet crest 97 is not/.test(msgs[4]) && /weir coefficient -1/.test(msgs[5]), msgs.join(" | "));
  }
  const bad = res.filter((r) => !r.pass).length; console.log(bad ? `${bad} FAILED` : "ALL PASS"); process.exit(bad ? 1 : 0);
})().catch((e) => { console.log("CRASH " + (e.stack || e)); process.exit(1); });
