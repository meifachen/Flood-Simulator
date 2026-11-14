// Solver tests carried over from the Lake Kathryn tool (CPU): node tests/node/test_solver_core.js
const F = require(process.env.FLOOD2D || "../../src/engine/flood2d.js");
const res = []; const ok = (name, pass, info) => { res.push({ name, pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + "  " + info); };

function raw(nx, ny, dx, fz, ft = () => 0, o = {}) {
  const N = nx * ny, z = new Float32Array(N), type = new Uint8Array(N), node = new Uint8Array(N), n = new Float32Array(N).fill(o.n ?? 0.03),
    perv = new Float32Array(N).fill(o.perv ?? 0), ks = new Float32Array(N).fill(o.ks ?? 0), psimd = new Float32Array(N).fill(o.psimd ?? 0), mult = new Float32Array(N).fill(1), road = new Uint16Array(N);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) { const k = r * nx + c; z[k] = fz(r, c); type[k] = ft(r, c); }
  return { nx, ny, dx, z, type, node, n, perv, ks, psimd, mult, road, K: 1 };
}

(async () => {
  // T1 lake at rest: uneven bed fully under a level surface inside walls; nothing should move
  {
    const nx = 40, ny = 30, g = F.makeGrid(raw(nx, ny, 6, (r, c) => 5 + Math.sin(r * 0.7) + Math.cos(c * 0.5), (r, c) => (r === 0 || c === 0 || r === ny - 1 || c === nx - 1) ? 1 : 0));
    const s = new F.CpuSolver(g); const init = new Float32Array(4 * g.N);
    for (let k = 0; k < g.N; k++) if ((g.aux[4 * k + 2] & 3) === 0) init[4 * k] = 10 - g.aux[4 * k];
    const out = await F.simulate(g, s, { t0: 0, t1: 1, rainAt: () => 0, stageAt: () => [0], init, readSec: 3600 });
    let dmax = 0; for (let k = 0; k < g.N; k++) if ((g.aux[4 * k + 2] & 3) === 0) dmax = Math.max(dmax, Math.abs(s.st[4 * k] + g.aux[4 * k] - 10));
    let qmax = 0; for (const v of s.q) qmax = Math.max(qmax, Math.abs(v));
    ok("T1 lake at rest (float32 limit 1e-4 ft)", dmax < 1e-4 && qmax < 5e-3, `max level change ${dmax.toExponential(2)} ft, max |q| ${qmax.toExponential(2)} cfs/ft, ${out.steps} steps`);
  }
  // T2 Hunter et al. (2005) moving front over a flat bed with a prescribed level at the left end
  {
    const nx = 300, ny = 3, dx = 6, n = 0.03, u = 0.5;
    const h0 = (t) => Math.pow(7 / 3 * n * n * u * u * u * t / F.KN, 3 / 7);
    const g = F.makeGrid(raw(nx, ny, dx, () => 0, (r, c) => (r !== 1 || c === nx - 1) ? 1 : (c === 0 ? 2 : 0), { n }));
    const s = new F.CpuSolver(g); const T = 3600;
    await F.simulate(g, s, { t0: 0, t1: T / 3600, rainAt: () => 0, stageAt: (th) => [h0(Math.max(th * 3600, 1e-3))], cfl: 0.7, chunkSec: 5, readSec: 3600 });
    let se = 0, m = 0, emax = 0;
    for (let c = 1; c < nx - 1; c++) {
      const x = c * dx, ha = x < u * T ? Math.pow(7 / 3 * n * n * u * u * (u * T - x) / F.KN, 3 / 7) : 0, hs = s.st[4 * (nx + c)];
      if (x < 0.9 * u * T) { se += (hs - ha) ** 2; m++; emax = Math.max(emax, Math.abs(hs - ha)); }
    }
    const rmse = Math.sqrt(se / m), h00 = h0(T);
    ok("T2 Hunter front (1 h, n 0.03, u 0.5 ft/s)", rmse / h00 < 0.03, `RMSE ${rmse.toFixed(4)} ft (${(100 * rmse / h00).toFixed(2)}% of h(0)=${h00.toFixed(3)} ft), max error ${emax.toFixed(4)} ft over 90% of the wetted length`);
  }
  // T3 mass balance: rough terrain, rain, infiltration, walls with roof rain, a stage boundary, open edges
  {
    const nx = 90, ny = 70, dx = 6, rnd = (() => { let s = 7; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
    const R = raw(nx, ny, dx, (r, c) => 50 + 0.01 * c * dx - 0.004 * r * dx + 0.6 * rnd(), (r, c) => (r > 20 && r < 30 && c > 30 && c < 38) ? 1 : (r > 50 && c < 15) ? 2 : 0, { perv: 0.7, ks: 1.18 / 12 / 3600, psimd: 2.41 * 0.35 / 12 });
    // roof rain from the wall block goes to the cell just west of it
    for (let r = 21; r < 30; r++) { R.mult[r * nx + 30] += 7; }
    for (let k = 0; k < nx * ny; k++) if (R.type[k] === 1) R.mult[k] = 0; else if (R.type[k] === 2) R.mult[k] = 0;
    for (let k = 0; k < nx * ny; k++) R.road[k] = (k % nx) === 45 ? 1 : 0;
    const g = F.makeGrid(R), s = new F.CpuSolver(g);
    let negMin = 0;
    const out = await F.simulate(g, s, { t0: 0, t1: 2, rainAt: (h) => (h < 1 ? 3 : 0), stageAt: () => [50.3], drainInHr: 0.5, readSec: 600,
      onRead: (fr) => { for (let k = 0; k < g.N; k++) negMin = Math.min(negMin, fr.st[4 * k]); } });
    const L = out.ledger;
    ok("T3 mass balance (rain, infiltration, roofs, drains, lake, open edges)", Math.abs(L.err) / L.rain < 1e-4 && negMin >= 0,
      `rain ${L.rain.toFixed(1)} cf, infiltration ${L.inf.toFixed(1)}, drains ${L.drain.toFixed(1)}, edges ${L.edge.toFixed(1)}, to lake ${L.toLakes.toFixed(1)}, stored ${(L.v1 - L.v0).toFixed(1)}; closure ${L.err.toFixed(3)} cf (${(100 * L.err / L.rain).toExponential(2)}% of rain); clamp ${L.clamp.toExponential(2)} cf; min depth ${negMin}`);
    ok("T6 roof rain conserved", Math.abs(g.multSum - (g.openCells + 63)) < 1e-6, `rain-receiving area ${g.multSum} cells = ${g.openCells} open + 63 wall cells`);
  }
  // T4 bathtub: constant lake level; every cell below the level and connected to the lake fills to it; a basin behind a ridge stays dry
  {
    const nx = 80, ny = 60, dx = 6, S = 10;
    const z = (r, c) => { if (c < 10) return 4; let v = 8 + 0.06 * (c - 10) + 0.5 * Math.sin(r / 5); if (c >= 50 && c <= 52) v = 12; if (c > 52 && c < 70 && r > 15 && r < 45) v = 7; return v; };
    const g = F.makeGrid(raw(nx, ny, dx, z, (r, c) => (c < 10 ? 2 : (r === 0 || r === ny - 1 || c === nx - 1) ? 1 : 0))), s = new F.CpuSolver(g);
    await F.simulate(g, s, { t0: 0, t1: 3, rainAt: () => 0, stageAt: () => [S], readSec: 3 * 3600 });
    // flood fill from the boundary through open cells with z < S
    const conn = new Uint8Array(g.N), st = []; for (let k = 0; k < g.N; k++) if ((g.aux[4 * k + 2] & 3) === 2) { conn[k] = 1; st.push(k); }
    while (st.length) { const k = st.pop(), r = (k / nx) | 0, c = k % nx; for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= ny || cc >= nx) continue; const j = rr * nx + cc; if (!conn[j] && (g.aux[4 * j + 2] & 3) === 0 && g.aux[4 * j] < S) { conn[j] = 1; st.push(j); } } }
    let n1 = 0, agree = 0, lvl = 0, dryBasin = true;
    for (let k = 0; k < g.N; k++) {
      if ((g.aux[4 * k + 2] & 3) !== 0) continue; n1++;
      const wet = s.st[4 * k] > 0.01, c = k % nx, r = (k / nx) | 0;
      if (wet === !!conn[k]) agree++;
      if (conn[k] && g.aux[4 * k] < S - 0.05) lvl = Math.max(lvl, Math.abs(g.aux[4 * k] + s.st[4 * k] - S));
      if (c > 52 && c < 70 && r > 15 && r < 45 && s.st[4 * k] > 0) dryBasin = false;
    }
    const fill = F.levelFill(g, [S]); let fd = 0; for (let k = 0; k < g.N; k++) if ((g.aux[4 * k + 2] & 3) === 0) fd = Math.max(fd, Math.abs(fill[k] - s.st[4 * k]));
    ok("T7 fast level-spill map equals the 2D steady state (walled edges; open edges are flagged, see test_fixes E1)", fd < 0.005, `max depth difference ${fd.toFixed(4)} ft over ${n1} open cells`);
    ok("T4 lake-level spill equals connected fill", agree / n1 > 0.995 && lvl < 0.02 && dryBasin, `${(100 * agree / n1).toFixed(2)}% of cells agree (wet/dry), max level difference ${lvl.toFixed(4)} ft, basin behind the ridge dry: ${dryBasin}`);
  }
  // T8 pipe connection: a closed hollow behind a ridge fills from the lake through a pipe, then drains back when the lake falls
  {
    const nx = 40, ny = 30, dx = 6;
    const z = (r, c) => (c < 8 ? 2 : (c >= 18 && c <= 20) ? 12 : (c > 20 ? 6 + 0.02 * (c - 20) : 7));
    const g = F.makeGrid(raw(nx, ny, dx, z, (r, c) => (c < 8 ? 2 : (r === 0 || r === ny - 1 || c === nx - 1) ? 1 : 0)));
    const s = new F.CpuSolver(g), cell = 15 * nx + 30;
    const pipes = [{ cell, cda: 0.6 * Math.PI * 0.75 * 0.75, lake: 0 }];
    const r1 = await F.simulate(g, s, { t0: 0, t1: 6, rainAt: () => 0, stageAt: (h) => [h < 4 ? 9 : 5], pipes, readSec: 4 * 3600 });
    const f4 = r1.frames[0], lvl4 = f4.st[4 * cell] + g.aux[4 * cell], fe = r1.frames[r1.frames.length - 1], lvl6 = fe.st[4 * cell];
    const fill = F.levelFill(g, [9], null, null, pipes); const fd = Math.abs(fill[cell] - f4.st[4 * cell]);
    const L = r1.ledger;
    ok("T8 pipe connection fills and drains a hollow behind a ridge", Math.abs(lvl4 - 9) < 0.02 && lvl6 < 0.05 && fd < 0.02 && Math.abs(L.err) < 1,
      `level after 4 h ${lvl4.toFixed(3)} ft (lake 9.0); depth 2 h after the lake drops to 5.0: ${lvl6.toFixed(3)} ft; level-spill map differs by ${fd.toFixed(4)} ft; ledger closure ${L.err.toFixed(3)} cf (hollow holds about 60,000 cf)`);
  }
  // T9 the answer does not depend on how finely the time is cut: a dam break (3 ft of water released over a dry flat bed, 20 s)
  // moves the same volume with the Courant step (dtMax 5) and with dtMax 0.1, 0.02 and 0.005 s (within 3%)
  {
    const nx = 40, ny = 30, g = F.makeGrid(raw(nx, ny, 10, () => 100, (r, c) => (r === 0 || c === 0 || r === ny - 1 || c === nx - 1) ? 1 : 0));
    const moved = [];
    for (const dtMax of [5, 0.1, 0.02, 0.005]) {
      const init = new Float32Array(4 * g.N); for (let r = 1; r < ny - 1; r++) for (let c = 30; c < nx - 1; c++) init[4 * (r * nx + c)] = 3;
      const out = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 20 / 3600, rainAt: () => 0, stageAt: () => [0], dtMax, readSec: 3600, init });
      const st = out.frames.at(-1).st; let v = 0; for (let r = 1; r < ny - 1; r++) for (let c = 1; c < 30; c++) v += st[4 * (r * nx + c)] * 100; moved.push(v);
    }
    ok("T9 a dam break moves the same water whatever the step (dtMax 5, 0.1, 0.02, 0.005 s; within 3%)", moved.every((v) => Math.abs(v - moved[0]) / moved[0] < 0.03), moved.map((v) => v.toFixed(0) + " cf").join(", "));
  }
  // T10 (new in 0.6.0, E-02; covers review F-02) the same dam break at Courant numbers 0.7, 0.35 and 0.1 moves the same water (within 3%):
  // the de Almeida smoothing is normalised to the wave step at the reference Courant number, so a lower cfl no longer adds diffusion.
  // On 0.5.0 the cfl 0.1 run moved 14% less water than the cfl 0.7 run.
  {
    const nx = 40, ny = 30, g = F.makeGrid(raw(nx, ny, 10, () => 100, (r, c) => (r === 0 || c === 0 || r === ny - 1 || c === nx - 1) ? 1 : 0));
    const moved = [];
    for (const cfl of [0.7, 0.35, 0.1]) {
      const init = new Float32Array(4 * g.N); for (let r = 1; r < ny - 1; r++) for (let c = 30; c < nx - 1; c++) init[4 * (r * nx + c)] = 3;
      const out = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 20 / 3600, rainAt: () => 0, stageAt: () => [0], cfl, dtMax: 5, readSec: 3600, init });
      const st = out.frames.at(-1).st; let v = 0; for (let r = 1; r < ny - 1; r++) for (let c = 1; c < 30; c++) v += st[4 * (r * nx + c)] * 100; moved.push(v);
    }
    ok("T10 a dam break moves the same water at Courant 0.7, 0.35 and 0.1 (within 3%)", moved.every((v) => Math.abs(v - moved[0]) / moved[0] < 0.03), moved.map((v) => v.toFixed(0) + " cf").join(", "));
  }
  // T11 (new in 0.6.0, E-08) UK Environment Agency benchmarking Test 3, "momentum conservation over a small obstruction"
  // (Neelz and Pender 2010, Benchmarking of 2D hydraulic modelling packages): a 300 m by 100 m plane at 1:200 with two
  // depressions separated by a 0.25 m obstruction; the inflow volume is just sufficient to fill the left depression, so
  // water reaches the right depression only if the solver carries momentum over the crest. The EA distributes the test
  // DEM and hydrograph tables on request; this fixture reconstructs the test from the published description (5 m grid,
  // Manning n 0.01, 900 s, dry bed, inflow along the left edge) with smooth depressions and sill of the published sizes,
  // and the hydrograph volume set to the reconstructed left-depression storage up to the crest, which is the published
  // defining condition. EA Test 6A (dam break, Soares-Frazao and Zech) is not used: its flume flow is supercritical with
  // hydraulic jumps, and this engine caps face velocity at critical flow by design, so its 6A velocities would be lower
  // bounds by construction and a pass/fail against the measured series would misstate the engine's class. Brand-new
  // fixture (no 0.5.0 counterpart); the engine is unchanged by E-08, so this check also passes on 0.5.0.
  {
    const M = 1 / 0.3048, nx = 60, ny = 20, dx = 5 * M;                     // 5 m cells, in feet
    const bowl = (x, c) => Math.abs(x - c) < 20 ? 0.35 * Math.pow(Math.cos(Math.PI * (x - c) / 40), 2) : 0;
    const sill = (x) => Math.abs(x - 200) < 5 ? 0.25 * Math.pow(Math.cos(Math.PI * (x - 200) / 10), 2) : 0;
    const zm = (x) => 11.0 - x / 200 - bowl(x, 150) - bowl(x, 250) + sill(x);
    const g = F.makeGrid(raw(nx, ny, dx, (r, c) => zm((c + 0.5) * 5) * M, (r, c) => (r === 0 || r === ny - 1 || c === nx - 1) ? 1 : 0, { n: 0.01 }));
    const crest = zm(200) * M, A = dx * dx;
    let vFill = 0; for (let k = 0; k < g.N; k++) { const c = k % nx; if ((c + 0.5) * 5 < 200) vFill += Math.max(0, crest - g.aux[4 * k]) * A; }
    const srcs = []; for (let r = 1; r < ny - 1; r++) srcs.push({ cell: r * nx, name: "west edge row " + r });
    const qPeak = 2 * vFill / 300;                                        // triangle over 300 s holding exactly vFill
    const qAt = (t) => t < 0 || t > 300 ? 0 : qPeak * (t < 150 ? t / 150 : 1 - (t - 150) / 150);
    const solver = new F.CpuSolver(g);
    const out = await F.simulate(g, solver, { t0: 0, t1: 0.25, rainAt: () => 0, stageAt: () => [0], sources: srcs, sourceAt: (a, b) => srcs.map(() => qAt((a + b) / 2 * 3600) / srcs.length), readSec: 900 });
    const st = out.frames.at(-1).st, mid = 10;
    const dep = (c) => st[4 * (mid * nx + c)], lvl = (c) => dep(c) + g.aux[4 * (mid * nx + c)];
    let vEast = 0; for (let k = 0; k < g.N; k++) if ((k % nx + 0.5) * 5 > 200) vEast += st[4 * k] * A;
    const v1 = out.vmax[mid * nx + 30] / M;                            // peak speed at the left depression, m/s
    ok("T11 EA Test 3 replica: momentum carries water over the 0.25 m obstruction into the right depression, a bounded share, levels settle flat, ledger closes",
      dep(50) > 0.15 && vEast / vFill < 0.3 && vEast > 0.01 * vFill && Math.abs(lvl(28) - lvl(32)) < 0.1 && Math.abs(out.ledger.errPct) < 0.5 && v1 > 0.3 && v1 < 3.7,
      `right depression depth ${(dep(50) / M).toFixed(3)} m (published: the full-SWE packages settle it about 0.02 m apart), share east of crest ${(100 * vEast / vFill).toFixed(1)}% of the inflow volume, left pond flatness ${Math.abs(lvl(28) - lvl(32)).toFixed(3)} ft, peak speed at point 1 ${v1.toFixed(2)} m/s (published plot envelope up to about 3 m/s), ledger ${out.ledger.errPct.toFixed(3)}%`);
  }
  require("fs").writeFileSync((process.env.OUTDIR || require("os").tmpdir()) + "/test_flood_results.json", JSON.stringify(res, null, 1));
  console.log(res.every((r) => r.pass) ? "ALL PASS" : "SOME FAILED"); process.exitCode = res.every((r) => r.pass) ? 0 : 1;
})();
