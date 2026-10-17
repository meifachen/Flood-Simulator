// Maximum velocity and depth x velocity: node tests/node/test_velocity.js   (exit 1 on failure)
const F = require(process.env.FLOOD2D || "../../src/engine/flood2d.js");
const res = []; const ok = (name, pass, info) => { res.push({ name, pass: !!pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + "  " + info); };
function grid(nx, ny, dx, fz, ft, n = 0.03) {
  const N = nx * ny, z = new Float32Array(N), type = new Uint8Array(N), node = new Uint8Array(N), nn = new Float32Array(N).fill(n), z0 = new Float32Array(N), m = new Float32Array(N).fill(1);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) { const k = r * nx + c; z[k] = fz(r, c); type[k] = ft(r, c); }
  return F.makeGrid({ nx, ny, dx, z, type, node, n: nn, perv: z0, ks: z0, psimd: z0, mult: m, K: 1 });
}
(async () => {
  // V1 uniform flow in a wide channel: walls on the long sides, inflow at the upstream end, open downstream edge.
  // Manning: q = 1.486/n h^(5/3) S^(1/2) -> h and V = q/h, checked in the middle third once steady.
  {
    const nx = 200, ny = 7, dx = 10, S = 0.005, n = 0.03, Q = 50, W = (ny - 2) * dx, q = Q / W;
    const g = grid(nx, ny, dx, (r, c) => 100 - S * c * dx, (r, c) => (r === 0 || r === ny - 1 || c === 0 ? 1 : 0), n);
    const src = []; for (let r = 1; r < ny - 1; r++) src.push({ cell: r * nx + 1, name: "in" + r });
    const out = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 1.5, rainAt: () => 0, stageAt: () => [0], sources: src, sourceAt: () => src.map(() => Q / src.length), readSec: 1800 });
    const st = out.frames[out.frames.length - 1].st, hN = Math.pow(q * n / (1.486 * Math.sqrt(S)), 3 / 5), vN = q / hN;
    let hs = 0, vs = 0, dvs = 0, m = 0;
    for (let c = Math.floor(nx / 3); c < Math.floor(2 * nx / 3); c++) for (let r = 2; r < ny - 2; r++) { const k = r * nx + c; hs += st[4 * k]; vs += out.vmax[k]; dvs += out.dvmax[k]; m++; }
    hs /= m; vs /= m; dvs /= m;
    ok("V1 uniform channel flow: depth and velocity equal Manning normal flow", Math.abs(hs - hN) / hN < 0.03 && Math.abs(vs - vN) / vN < 0.05 && Math.abs(dvs - q) / q < 0.05,
      `depth ${hs.toFixed(3)} ft (Manning ${hN.toFixed(3)}), max velocity ${vs.toFixed(3)} ft/s (${vN.toFixed(3)}), max D x V ${dvs.toFixed(3)} ft2/s (q = ${q.toFixed(3)})`);
  }
  // V2 still water: a lake at rest gives no velocity
  {
    const g = grid(40, 30, 6, (r, c) => (c < 5 ? 0 : 2 + 0.05 * c), (r, c) => (r === 0 || r === 29 || c === 39 ? 1 : c < 5 ? 2 : 0));   // walled, so nothing drains off the edges
    const out = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 0.5, rainAt: () => 0, stageAt: () => [3.0], readSec: 1800,
      init: (() => { const a = new Float32Array(4 * g.N); for (let k = 0; k < g.N; k++) a[4 * k] = Math.max(3.0 - g.aux[4 * k], 0); return a; })() });
    let vm = 0; for (let k = 0; k < g.N; k++) vm = Math.max(vm, out.vmax[k]);
    ok("V2 water at rest has no velocity", vm < 1e-3, `max speed ${vm.toExponential(2)} ft/s`);
  }
  // V3 a dry cell or a film thinner than 0.05 ft records no velocity
  {
    const g = grid(30, 30, 6, (r, c) => 10 + 0.02 * c, () => 0);
    const out = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 0.25, rainAt: () => 0.5, stageAt: () => [0], readSec: 1800 });
    const st = out.frames[out.frames.length - 1].st; let bad = 0, hmx = 0;
    for (let k = 0; k < g.N; k++) { hmx = Math.max(hmx, st[4 * k + 2]); if (st[4 * k + 2] <= F.VEL_H && out.vmax[k] > 0) bad++; }
    ok("V3 thin sheet flow (max depth under 0.05 ft) records no velocity", bad === 0, `deepest ${hmx.toFixed(4)} ft; ${bad} cells with a velocity`);
  }
  const bad = res.filter((r) => !r.pass).length; console.log(bad ? `${bad} FAILED` : "ALL PASS"); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
