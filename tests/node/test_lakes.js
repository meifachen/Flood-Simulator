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
  // L7 the routed level does not depend on the chunk length and does not swing from chunk to chunk (a lake started 3 ft above its lip)
  {
    const runL = async (chunkSec) => { const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 2, rainAt: () => 0, stageAt: () => [103], routedLakes: [{ lake: 0, areaFt2: lakeArea, level0: 103 }], chunkSec, readSec: 3600 });
      // swing: the largest drop-and-rise (or rise-and-drop) between consecutive chunks, a sawtooth that a stable level does not have
      const L = r.lakes.series.map((x) => x.levels[0]); let swing = 0; for (let k = 2; k < L.length; k++) { const d1 = L[k - 1] - L[k - 2], d2 = L[k] - L[k - 1]; if (d1 * d2 < 0) swing = Math.max(swing, Math.min(Math.abs(d1), Math.abs(d2))); }
      return { end: r.lakes.end[0], min: Math.min(...L), swing }; };
    const fine = await runL(1), c60 = await runL(60), c900 = await runL(900);
    ok("L7 the routed level is the same with 1 s, 60 s and 900 s chunks (end within 0.02 ft, lowest within 0.1 ft of a lake dumped 3 ft onto dry land), with no sawtooth", [c60, c900].every((c) => Math.abs(c.end - fine.end) < 0.02 && Math.abs(c.min - fine.min) < 0.1 && c.swing < 0.01),
      `end ${fine.end.toFixed(3)} / ${c60.end.toFixed(3)} / ${c900.end.toFixed(3)} ft; lowest ${fine.min.toFixed(3)} / ${c60.min.toFixed(3)} / ${c900.min.toFixed(3)} ft; largest swing ${fine.swing.toFixed(4)} / ${c60.swing.toFixed(4)} / ${c900.swing.toFixed(4)} ft`);
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
  const bad = res.filter((r) => !r.pass).length; console.log(bad ? `${bad} FAILED` : "ALL PASS"); process.exit(bad ? 1 : 0);
})().catch((e) => { console.log("CRASH " + (e.stack || e)); process.exit(1); });
