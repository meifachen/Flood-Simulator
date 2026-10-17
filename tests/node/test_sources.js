// Point inflows (SWMM node flooding) and sub-hourly rain in the generic engine: node tests/node/test_sources.js   (exit 1 on failure)
const F = require(process.env.FLOOD2D || "../../src/engine/flood2d.js");
const res = []; const ok = (name, pass, info) => { res.push({ name, pass: !!pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + "  " + info); };

// a walled basin: wall ring, flat floor at z0 with a gentle bump so water must move
function basin(nx, ny, dx, fz) {
  const N = nx * ny, z = new Float32Array(N), type = new Uint8Array(N), node = new Uint8Array(N), n = new Float32Array(N).fill(0.03),
    perv = new Float32Array(N), ks = new Float32Array(N), psimd = new Float32Array(N), mult = new Float32Array(N).fill(1);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) { const k = r * nx + c; z[k] = fz(r, c); type[k] = (r === 0 || c === 0 || r === ny - 1 || c === nx - 1) ? 1 : 0; }
  return F.makeGrid({ nx, ny, dx, z, type, node, n, perv, ks, psimd, mult, K: 0 });
}
const vol = (g, st) => { let v = 0; for (let k = 0; k < g.N; k++) if ((g.aux[4 * k + 2] & 3) === 0) v += st[4 * k]; return v * g.dx * g.dx; };
async function expectError(name, fn, re) { try { await fn(); ok(name, false, "no error"); } catch (e) { ok(name, re.test(e.message), "error: " + e.message); } }

(async () => {
  const dx = 10, nx = 40, ny = 30, g = basin(nx, ny, dx, (r, c) => 100 + 0.002 * c * dx), cell = 15 * nx + 20;
  // S1 constant 10 cfs for 1 h: 36,000 cf stored, booked as inflow, water spreads over the floor
  {
    const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 1, rainAt: () => 0, stageAt: () => [], sources: [{ cell, name: "J1" }], sourceAt: () => [10], readSec: 600 });
    const st = r.frames[r.frames.length - 1].st, V = vol(g, st);
    let wet = 0; for (let k = 0; k < g.N; k++) if (st[4 * k] > 0.01) wet++;
    ok("S1 constant 10 cfs for 1 h is stored and booked", Math.abs(V - 36000) < 1 && Math.abs((r.ledger.inflow ?? NaN) - 36000) < 1e-6 && Math.abs(r.ledger.err) < 1, `stored ${V.toFixed(2)} cf, ledger inflow ${(r.ledger.inflow ?? NaN).toFixed(2)} cf, closure ${r.ledger.err.toFixed(4)} cf, ${wet} wet cells`);
  }
  // S2 triangular hydrograph through sourceAt(t0, t1) means: total equals the analytic volume 0.5 * 20 cfs * 3600 s
  {
    const tri = (h) => (h <= 0.5 ? 40 * h : h <= 1 ? 40 * (1 - h) : 0);   // cfs, peak 20 at 0.5 h
    const mean = (a, b) => { const n = 50; let s = 0; for (let i = 0; i < n; i++) s += tri(a + (i + 0.5) * (b - a) / n); return s / n; };
    const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 1.5, rainAt: () => 0, stageAt: () => [], sources: [{ cell, name: "J1" }], sourceAt: (a, b) => [mean(a, b)], readSec: 600 });
    const V = vol(g, r.frames[r.frames.length - 1].st);
    ok("S2 time-varying inflow volume matches the hydrograph", Math.abs((r.ledger.inflow ?? NaN) - 36000) / 36000 < 2e-3 && Math.abs(V - (r.ledger.inflow ?? NaN)) < 1, `ledger ${(r.ledger.inflow ?? NaN).toFixed(1)} cf, stored ${V.toFixed(1)} cf, analytic 36000 cf`);
  }
  // S3 two sources on the same cell add up
  {
    const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 0.5, rainAt: () => 0, stageAt: () => [], sources: [{ cell, name: "A" }, { cell, name: "B" }], sourceAt: () => [3, 4], readSec: 600 });
    const V = vol(g, r.frames[r.frames.length - 1].st);
    ok("S3 two sources on one cell add up", Math.abs(V - 7 * 1800) < 1, `stored ${V.toFixed(2)} cf (expected ${7 * 1800})`);
  }
  // S4 5-minute rain: rainAt is called per 5-minute interval and the total is exact
  {
    const calls = new Set(), rain = (i) => { calls.add(i); return i % 2 ? 6 : 0; };   // in/hr in odd intervals
    const r = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 1, rainAt: rain, rainStep: 300, stageAt: () => [], readSec: 600 });
    const expect = 6 * 6 * (5 / 60) / 12 * g.multSum * dx * dx;   // 6 odd intervals x 6 in/hr x 5 min
    ok("S4 rain at a 5-minute interval", calls.size === 12 && Math.abs(r.ledger.rain - expect) < 1e-6 * expect, `${calls.size} intervals called, rain ${r.ledger.rain.toFixed(2)} cf, expected ${expect.toFixed(2)} cf`);
  }
  // S5 a basin at rest after the inflow stops: level flat within float precision
  {
    const g2 = basin(30, 30, 10, () => 50), c2 = 15 * 30 + 15;
    const r = await F.simulate(g2, new F.CpuSolver(g2), { t0: 0, t1: 3, rainAt: () => 0, stageAt: () => [], sources: [{ cell: c2 }], sourceAt: (a) => [a < 0.5 ? 5 : 0], readSec: 3600 });
    const st = r.frames[r.frames.length - 1].st; let lo = 1e9, hi = -1e9;
    for (let k = 0; k < g2.N; k++) if ((g2.aux[4 * k + 2] & 3) === 0) { lo = Math.min(lo, st[4 * k]); hi = Math.max(hi, st[4 * k]); }
    const expect = 5 * 1800 / (28 * 28 * 100);
    ok("S5 basin settles flat at volume / area", hi - lo < 2e-3 && Math.abs((lo + hi) / 2 - expect) < 1e-3, `depth ${lo.toFixed(4)}–${hi.toFixed(4)} ft, expected ${expect.toFixed(4)} ft`);
  }
  // S6 refusals
  const base = { t0: 0, t1: 0.1, rainAt: () => 0, stageAt: () => [] };
  await expectError("S6 refuses a source on a wall cell", () => F.simulate(g, new F.CpuSolver(g), Object.assign({}, base, { sources: [{ cell: 0, name: "W" }], sourceAt: () => [1] })), /not on an open cell/);
  await expectError("S6 refuses a NaN inflow", () => F.simulate(g, new F.CpuSolver(g), Object.assign({}, base, { sources: [{ cell }], sourceAt: () => [NaN] })), /invalid/);
  await expectError("S6 refuses a negative inflow", () => F.simulate(g, new F.CpuSolver(g), Object.assign({}, base, { sources: [{ cell }], sourceAt: () => [-1] })), /invalid/);
  await expectError("S6 refuses sources without sourceAt", () => F.simulate(g, new F.CpuSolver(g), Object.assign({}, base, { sources: [{ cell }] })), /sourceAt/);
  await expectError("S6 refuses a wrong-length inflow array", () => F.simulate(g, new F.CpuSolver(g), Object.assign({}, base, { sources: [{ cell }, { cell: cell + 1 }], sourceAt: () => [1] })), /missing/);
  await expectError("S6 refuses a zero rain interval", () => F.simulate(g, new F.CpuSolver(g), Object.assign({}, base, { rainStep: 0 })), /rain interval/);
  const bad = res.filter((r) => !r.pass).length; console.log(bad ? `${bad} FAILED` : "ALL PASS"); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
