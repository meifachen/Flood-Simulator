// Tests for the Round 1 review fixes (solver): node tests/test_fixes.js   (exit code 1 on any failure)
const F = require(process.env.FLOOD2D || "../../src/engine/flood2d.js");
const res = []; const ok = (name, pass, info) => { res.push({ name, pass: !!pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + "  " + info); };
const throwsAsync = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e); } };
function raw(nx, ny, dx, fz, ft = () => 0, o = {}) {
  const N = nx * ny, z = new Float32Array(N), type = new Uint8Array(N), node = new Uint8Array(N), n = new Float32Array(N).fill(o.n ?? 0.03),
    perv = new Float32Array(N).fill(o.perv ?? 0), ks = new Float32Array(N).fill(o.ks ?? 0), psimd = new Float32Array(N).fill(o.psimd ?? 0), mult = new Float32Array(N).fill(1), road = new Uint16Array(N);
  const imd = new Float32Array(N).fill(o.imd ?? 0);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) { const k = r * nx + c; z[k] = fz(r, c); type[k] = ft(r, c); }
  return { nx, ny, dx, z, type, node, n, perv, ks, psimd, imd, mult, road, K: 1 };
}
const walls = (nx, ny) => (r, c) => (r === 0 || c === 0 || r === ny - 1 || c === nx - 1) ? 1 : 0;
// exact Green-Ampt under constant ponding depth d (SWMM form, c1 = (psi + d) * IMD): F - c1 ln(1 + F/c1) = Ks t
function gaExact(Ks, psi, imd, d, t) { const c1 = (psi + d) * imd; let F = Math.max(Ks * t, 1e-9); for (let i = 0; i < 100; i++) { const f = F - c1 * Math.log(1 + F / c1) - Ks * t, fp = 1 - c1 / (F + c1); F -= f / fp; } return F; }

(async () => {
  // GA1/GA2: ponded pervious cells with a fixed head from a lake boundary; infiltrated depth vs exact Green-Ampt at the default (large) time step
  for (const [label, dHead, dtMax, hrs] of [["shallow ponding, dt 5 s, 1 min", 0.05, 5, 1 / 60], ["shallow ponding, dt 5 s, 1 h", 0.05, 5, 1], ["2 ft ponding, dt 5 s, 1 h", 2, 5, 1]]) {
    const Ks = 1.18 / 12 / 3600, psi = 2.41 / 12, imd = 0.35, nx = 7, ny = 7;
    const R = raw(nx, ny, 6, () => 10, (r, c) => (r === 3 && c === 3) ? 0 : 2, { perv: 1, ks: Ks, psimd: psi * imd, imd });
    const g = F.makeGrid(R), s = new F.CpuSolver(g), k = 3 * nx + 3;
    // the open cell is surrounded by lake cells at 10 + dHead, so it stays ponded at about dHead
    const init = new Float32Array(4 * g.N); for (let i = 0; i < g.N; i++) init[4 * i] = dHead;
    const out = await F.simulate(g, s, { t0: 0, t1: hrs, init, rainAt: () => 0, stageAt: () => [10 + dHead], dtMax, readSec: 1e9, hInit: 0.05 });
    const Fsim = s.st[4 * k + 1], Fex = gaExact(Ks, psi, imd, dHead, hrs * 3600), e = (Fsim - Fex) / Fex;
    ok(`GA ${label}`, Math.abs(e) < 0.02, `F sim ${(Fsim * 12).toFixed(4)} in, exact ${(Fex * 12).toFixed(4)} in, error ${(100 * e).toFixed(2)}%, ${out.steps} steps`);
  }
  // GA3: rain below the infiltration capacity infiltrates completely (supply limited)
  {
    const Ks = 1.18 / 12 / 3600, nx = 9, ny = 9, R = raw(nx, ny, 6, () => 10, walls(nx, ny), { perv: 1, ks: Ks, psimd: 2.41 / 12 * 0.35, imd: 0.35 });
    const g = F.makeGrid(R), s = new F.CpuSolver(g);
    const out = await F.simulate(g, s, { t0: 0, t1: 1, rainAt: () => 0.5, stageAt: () => [0], readSec: 1e9 });
    const L = out.ledger;
    ok("GA rain 0.5 in/hr below capacity: all infiltrates", Math.abs(L.inf - L.rain) / L.rain < 1e-3 && L.v1 < 1e-3 * L.rain, `rain ${L.rain.toFixed(1)} cf, infiltration ${L.inf.toFixed(1)} cf, stored ${L.v1.toFixed(3)} cf`);
  }
  // V1-V8: invalid inputs are refused with a message instead of NaN or a hang
  {
    const g = F.makeGrid(raw(10, 8, 6, () => 10, (r, c) => c === 0 ? 2 : walls(10, 8)(r, c)));
    const base = { t0: 0, t1: 0.1, rainAt: () => 1, stageAt: () => [10.5], readSec: 1e9 };
    const cases = [["empty stage array", { stageAt: () => [] }], ["NaN stage", { stageAt: () => [NaN] }], ["missing rain hour", { rainAt: () => undefined }], ["negative rain", { rainAt: () => -3 }],
      ["cfl 0", { cfl: 0 }], ["dtMax 0", { dtMax: 0 }], ["reversed window", { t0: 1, t1: 0.5 }], ["zero-length window", { t1: 0 }], ["NaN start", { t0: NaN }]];
    for (const [nm, ov] of cases) {
      if (process.env.SKIP_HANG && (nm === "cfl 0" || nm === "dtMax 0")) { ok(`refuses ${nm}`, false, "skipped: hangs this solver version (run alone under timeout)"); continue; }
      const t = Date.now(); const msg = await throwsAsync(() => F.simulate(g, new F.CpuSolver(g), Object.assign({}, base, ov)));
      ok(`refuses ${nm}`, msg !== null && Date.now() - t < 5000, msg ? `error: ${msg}` : "no error");
    }
  }
  // Y1: a CPU run yields to the event loop, so a stop request delivered as an event is honoured
  {
    const nx = 40, ny = 30, g = F.makeGrid(raw(nx, ny, 6, () => 10, walls(nx, ny)));
    let stop = false, fired = 0; const t0 = Date.now();
    setTimeout(() => { fired = (Date.now() - t0) || 1; stop = true; }, 0);
    const out = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 2, rainAt: () => 1, stageAt: () => [0], readSec: 600, chunkSec: 60, shouldStop: () => stop });
    ok("CPU run honours a stop event", fired > 0 && out.chunks < 120 && out.stopped === true, `timer fired at ${fired} ms; chunks run ${out.chunks} of 120; stopped ${out.stopped}`);
  }
  // C1: no initial state next to a deep lake: the first step must respect the lake depth. Dam-break into a long dry channel
  // (no reflection within 60 s); reference is the same run at Courant 0.1. Before the fix the default run reached 39.6 ft for a 10 ft head.
  {
    const nx = 300, ny = 3, head = 10, run = async (cfl) => {
      const g = F.makeGrid(raw(nx, ny, 6, () => 0, (r, c) => (r !== 1 || c === nx - 1) ? 1 : (c === 0 ? 2 : 0), { n: 0.03 }));
      const s = new F.CpuSolver(g); await F.simulate(g, s, { t0: 0, t1: 60 / 3600, rainAt: () => 0, stageAt: () => [head], readSec: 1e9, cfl });
      let mx = 0; for (let c = 1; c < nx - 1; c++) mx = Math.max(mx, s.st[4 * (nx + c) + 2]); return mx;
    };
    const mx = await run(undefined), ref = await run(0.1);
    ok("first step sized for the lake depth (no spikes)", mx <= head * 1.10 && mx <= ref * 1.10, `max depth ${mx.toFixed(2)} ft (default Courant 0.7) vs ${ref.toFixed(2)} ft (Courant 0.1) for a ${head} ft head; local-inertial overshoot at a dry-bed front stays under 10%`);
  }
  // E1/E2: level fill reports when lake water reaches an open tile edge (where it would drain without limit in 2D)
  {
    const nx = 40, ny = 30, z = (r, c) => (c < 6 ? 2 : 8 + 0.02 * c);
    const gw = F.makeGrid(raw(nx, ny, 6, z, (r, c) => c < 6 ? 2 : walls(nx, ny)(r, c))), go = F.makeGrid(raw(nx, ny, 6, z, (r, c) => c < 6 ? 2 : 0));
    const iw = {}, io = {}; F.levelFill(gw, [10], null, null, null, iw); F.levelFill(go, [10], null, null, null, io);
    ok("level fill flags lake water at an open edge", io.edgeCells > 0 && iw.edgeCells === 0, `open edges: ${io.edgeCells} edge cells reached; walled: ${iw.edgeCells}`);
  }
  // R1: a solver reused after a stopped run gives the same result as a fresh one
  {
    const nx = 30, ny = 20, R = raw(nx, ny, 6, (r, c) => 10 + 0.01 * c, walls(nx, ny), { perv: 0.7, ks: 1.18 / 12 / 3600, psimd: 2.41 / 12 * 0.35, imd: 0.35 });
    const g = F.makeGrid(R), s = new F.CpuSolver(g); let calls = 0;
    await F.simulate(g, s, { t0: 0, t1: 1, rainAt: () => 2, stageAt: () => [0], readSec: 600, shouldStop: () => ++calls > 3 });
    const o = { t0: 0, t1: 0.5, rainAt: () => 2, stageAt: () => [0], readSec: 1e9 };
    const a = await F.simulate(g, s, o), b = await F.simulate(g, new F.CpuSolver(g), o);
    let d = 0; for (let k = 0; k < g.N; k++) d = Math.max(d, Math.abs(a.frames[0].st[4 * k] - b.frames[0].st[4 * k]));
    ok("reused solver equals a fresh solver", d === 0 && Math.abs(a.ledger.inf - b.ledger.inf) < 1e-6 && Math.abs(a.ledger.err) < 1, `max depth difference ${d}; infiltration ${a.ledger.inf.toFixed(2)} vs ${b.ledger.inf.toFixed(2)} cf; closure ${a.ledger.err.toFixed(3)} cf`);
  }
  // R2: leftover flows and tallies on a solver (driven directly, with no read) do not leak into the next run
  {
    const nx = 30, ny = 20, R = raw(nx, ny, 6, (r, c) => 10 + 0.02 * c, walls(nx, ny), { perv: 0.7, ks: 1.18 / 12 / 3600, psimd: 2.41 / 12 * 0.35, imd: 0.35 });
    const g = F.makeGrid(R), s = new F.CpuSolver(g);
    for (let k = 0; k < g.N; k++) if ((g.aux[4 * k + 2] & 3) === 0) s.st[4 * k] = 0.5;
    s.pipes = []; await s.chunk({ dt: 0.5, n: 200, rain: 0, drain: 0, stages: [0], tHours: 0, pipes: [] });
    const o = { t0: 0, t1: 0.25, rainAt: () => 2, stageAt: () => [0], readSec: 1e9 };
    const a = await F.simulate(g, s, o), b = await F.simulate(g, new F.CpuSolver(g), o);
    let d = 0; for (let k = 0; k < g.N; k++) d = Math.max(d, Math.abs(a.frames[0].st[4 * k] - b.frames[0].st[4 * k]));
    ok("solver state from direct use does not leak into a run", d === 0 && Math.abs(a.ledger.inf - b.ledger.inf) < 1e-6, `max depth difference ${d}; infiltration ${a.ledger.inf.toFixed(3)} vs ${b.ledger.inf.toFixed(3)} cf`);
  }
  // P1: pipe exchange is reported as its own ledger term, separate from edge outflow
  {
    const nx = 40, ny = 30, z = (r, c) => (c < 8 ? 2 : (c >= 18 && c <= 20) ? 12 : (c > 20 ? 6 + 0.02 * (c - 20) : 7));
    const g = F.makeGrid(raw(nx, ny, 6, z, (r, c) => (c < 8 ? 2 : walls(nx, ny)(r, c)))), cell = 15 * nx + 30;
    const out = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 2, rainAt: () => 0, stageAt: () => [9], pipes: [{ cell, cda: 1.06, lake: 0 }], readSec: 1e9 });
    const L = out.ledger;
    ok("pipe flow has its own ledger term", L.edge === 0 && L.pipe < -1000 && Math.abs(L.err) < 1, `edge ${L.edge.toFixed(1)} cf, pipe ${(L.pipe ?? NaN).toFixed(1)} cf, closure ${L.err.toFixed(3)} cf`);
  }
  // FR1: Froude cap binds on a steep smooth slope: no face exceeds critical flow
  {
    const nx = 60, ny = 5;
    const g = F.makeGrid(raw(nx, ny, 6, (r, c) => 100 - 1.2 * c, (r, c) => (r === 0 || r === ny - 1) ? 1 : (c === 0 ? 2 : 0), { n: 0.01 }));
    const s = new F.CpuSolver(g); await F.simulate(g, s, { t0: 0, t1: 0.05, rainAt: () => 0, stageAt: () => [100.8], readSec: 1e9 });
    let worst = 0, n = 0;
    for (let c = 2; c < nx - 2; c++) { const L = 2 * nx + c - 1, R = L + 1, f = 2 * (nx + 1) + c; const h = Math.max(s.st[4 * L], s.st[4 * R]); if (h > 0.01) { n++; worst = Math.max(worst, Math.abs(s.q[f]) / (h * Math.sqrt(F.G * h))); } }
    ok("Froude cap holds on a steep slope", n > 10 && worst <= 1.0001, `${n} wet faces; max |q| / (h sqrt(gh)) = ${worst.toFixed(4)}`);
  }
  // NAN1: the solver never stores a non-finite depth (guard): a stage of +Infinity is refused
  {
    const g = F.makeGrid(raw(10, 8, 6, () => 10, (r, c) => c === 0 ? 2 : walls(10, 8)(r, c)));
    const msg = await throwsAsync(() => F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 0.1, rainAt: () => 0, stageAt: () => [Infinity], readSec: 1e9 }));
    ok("refuses infinite stage", msg !== null, msg || "no error");
  }
  require("fs").writeFileSync((process.env.OUTDIR || require("os").tmpdir()) + "/test_fixes_results.json", JSON.stringify(res, null, 1));
  const bad = res.filter((r) => !r.pass).length; console.log(bad ? `${bad} FAILED` : "ALL PASS"); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
