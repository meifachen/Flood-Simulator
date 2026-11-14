// Maximum velocity and depth x velocity: node tests/node/test_velocity.js   (exit 1 on failure)
const F = require(process.env.FLOOD2D || "../../src/engine/flood2d.js");
const res = []; const ok = (name, pass, info) => { res.push({ name, pass: !!pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + "  " + info); };
function grid(nx, ny, dx, fz, ft, n = 0.03) {
  const N = nx * ny, z = new Float32Array(N), type = new Uint8Array(N), node = new Uint8Array(N), nn = new Float32Array(N).fill(n), z0 = new Float32Array(N), m = new Float32Array(N).fill(1);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) { const k = r * nx + c; z[k] = fz(r, c); type[k] = ft(r, c); }
  return F.makeGrid({ nx, ny, dx, z, type, node, n: nn, perv: z0, ks: z0, psimd: z0, mult: m, K: 1 });
}
(async () => {
  // A wide channel: walls on the long sides and at the upstream end, inflow spread over the first column of open cells, open downstream edge.
  // Manning (US units): q = 1.486/n h^(5/3) S^(1/2) per unit width, V = q/h. The reference values below are computed from that, not from the engine.
  const channel = (o) => {
    const nx = o.nx ?? 200, ny = 7, dx = 10, S = o.S ?? 0.005, n = o.n ?? 0.03, Q = o.Q ?? 50, W = (ny - 2) * dx, q = Q / W, south = !!o.south;
    // south: the same channel turned to run north-to-south (rows and columns swapped), to check the y direction
    const NX = south ? ny : nx, NY = south ? nx : ny, idx = (r, c) => (south ? c * NX + r : r * NX + c);
    const g = grid(NX, NY, dx, (R, C) => { const c = south ? R : C; return 100 - S * c * dx; }, (R, C) => { const r = south ? C : R, c = south ? R : C; return r === 0 || r === ny - 1 || c === 0 ? 1 : 0; }, n);
    const src = []; for (let r = 1; r < ny - 1; r++) src.push({ cell: idx(r, 1), name: "in" + r });
    const hN = Math.pow(q * n / (1.486 * Math.sqrt(S)), 3 / 5), vN = q / hN, Fr = vN / Math.sqrt(32.174 * hN);
    return { g, src, q, hN, vN, Fr, nx, ny, idx, Q };
  };
  const mid = (ch, out, f) => { let s = 0, m = 0; for (let c = Math.floor(ch.nx / 3); c < Math.floor(2 * ch.nx / 3); c++) for (let r = 2; r < ch.ny - 2; r++) { s += f(ch.idx(r, c)); m++; } return s / m; };
  const ramp = (ch, rampSec = 600, offAt = Infinity) => (h0, h1) => ch.src.map(() => (h0 * 3600 >= offAt ? 0 : ch.Q / ch.src.length * Math.min(1, (h0 * 3600 + 1) / rampSec)));
  const sim = (ch, o) => F.simulate(ch.g, o.solver || new F.CpuSolver(ch.g), Object.assign({ t0: 0, t1: 1.5, rainAt: () => 0, stageAt: () => [0], sources: ch.src, readSec: 1800 }, o));
  // V1 uniform flow, east and south: depth, maximum speed and depth x speed equal Manning normal flow in the middle third
  for (const south of [false, true]) {
    const ch = channel({ south }), out = await sim(ch, { sourceAt: ramp(ch) }), st = out.frames[out.frames.length - 1].st;
    const hs = mid(ch, out, (k) => st[4 * k]), vs = mid(ch, out, (k) => out.vmax[k]), dvs = mid(ch, out, (k) => out.dvmax[k]);
    ok(`V1 uniform channel flow ${south ? "to the south" : "to the east"}: depth, max speed and D x V equal Manning within 1%`, Math.abs(hs - ch.hN) / ch.hN < 0.01 && Math.abs(vs - ch.vN) / ch.vN < 0.01 && Math.abs(dvs - ch.q) / ch.q < 0.01,
      `depth ${hs.toFixed(4)} ft (Manning ${ch.hN.toFixed(4)}), speed ${vs.toFixed(4)} ft/s (${ch.vN.toFixed(4)}), D x V ${dvs.toFixed(4)} ft2/s (q ${ch.q.toFixed(4)})`);
    // the inflow cells: nothing comes in through the upstream wall and q leaves through the downstream face, so the cell speed (the mean of the two
    // face flows over the depth) is about q / 2h, well below the q / h a single face would give; the maximum over the filling stays in that band
    let lo = Infinity, hi = 0; for (let r = 2; r < ch.ny - 2; r++) { const k = ch.idx(r, 1), f = out.vmax[k] / (ch.q / st[4 * k]); lo = Math.min(lo, f); hi = Math.max(hi, f); }
    ok(`V1 ${south ? "south" : "east"}: at the inflow cells the speed is the mean of the two face flows (about q / 2h), not one face (q / h)`, lo > 0.4 && hi < 0.9, `max speed / (q / h) between ${lo.toFixed(3)} and ${hi.toFixed(3)}`);
  }
  // V4 the maxima are maxima: after the inflow stops (at 1 h) the channel drains, and the recorded speed is still the steady peak
  {
    const ch = channel({}), out = await sim(ch, { t1: 2, sourceAt: ramp(ch, 600, 3600) }), st = out.frames[out.frames.length - 1].st;
    const hs = mid(ch, out, (k) => st[4 * k]), vs = mid(ch, out, (k) => out.vmax[k]);
    ok("V4 after the flow stops the maximum speed is still the peak", hs < 0.5 * ch.hN && Math.abs(vs - ch.vN) / ch.vN < 0.01, `final depth ${hs.toFixed(3)} ft; max speed ${vs.toFixed(4)} ft/s (Manning ${ch.vN.toFixed(4)})`);
    // the same solver, run again with no flow: nothing carries over
    const s2 = new F.CpuSolver(ch.g); await sim(ch, { solver: s2, sourceAt: ramp(ch) }); const again = await sim(ch, { solver: s2, t1: 0.25, sourceAt: () => ch.src.map(() => 0) });
    let m = 0; for (let k = 0; k < ch.g.N; k++) m = Math.max(m, again.vmax[k], again.dvmax[k], again.froude[k]);
    ok("V4 a second run on the same solver starts with no velocity maxima", m === 0, `largest carried value ${m}`);
  }
  // V5 a sudden inflow (step from 0 to 50 cfs) does not stamp a start-up spike into the maxima, and the result does not depend on the chunk length
  {
    const ch = channel({}), peak = (o) => { let d = 0, h = 0; for (let k = 0; k < ch.g.N; k++) { d = Math.max(d, o.dvmax[k]); h = Math.max(h, o.frames[o.frames.length - 1].st[4 * k + 2]); } return { d, h }; };
    const step = () => ch.src.map(() => ch.Q / ch.src.length);
    const a = peak(await sim(ch, { sourceAt: step })), b = peak(await sim(ch, { sourceAt: step, chunkSec: 5 }));
    ok("V5 a step inflow: peak D x V stays near q and does not depend on the chunk length", a.d < 1.15 * ch.q && Math.abs(a.d - b.d) / b.d < 0.05 && a.h < 2 * ch.hN,
      `peak D x V ${a.d.toFixed(3)} (60 s chunks) vs ${b.d.toFixed(3)} (5 s chunks) ft2/s, q ${ch.q.toFixed(3)}; peak depth ${a.h.toFixed(3)} ft (normal ${ch.hN.toFixed(3)})`);
  }
  // V6 supercritical flow: the solver caps every face at critical flow, so speed reads low; the cells where that happened are flagged
  {
    const steep = channel({ S: 0.05, n: 0.015 }), out = await sim(steep, { sourceAt: ramp(steep) }), vs = mid(steep, out, (k) => out.vmax[k]), fl = mid(steep, out, (k) => out.froude[k]);
    const gentle = channel({}), o2 = await sim(gentle, { sourceAt: ramp(gentle) }), fl2 = mid(gentle, o2, (k) => o2.froude[k]);
    ok("V6 supercritical channel: speed is capped below Manning and every cell there is flagged; a subcritical channel is not flagged", steep.Fr > 1.5 && vs < 0.8 * steep.vN && fl === 1 && fl2 === 0,
      `Manning Froude ${steep.Fr.toFixed(2)}: speed ${vs.toFixed(3)} ft/s vs Manning ${steep.vN.toFixed(3)}; flagged ${(100 * fl).toFixed(0)}% (steep), ${(100 * fl2).toFixed(0)}% (Froude ${gentle.Fr.toFixed(2)})`);
  }
  // V7 a hot start continues the velocity maxima; one without them is refused
  {
    const ch = channel({}), pulse = ramp(ch, 600, 1800), full = await sim(ch, { sourceAt: pulse });
    const s1 = new F.CpuSolver(ch.g), first = await sim(ch, { solver: s1, t1: 0.75, sourceAt: pulse }), init = first.frames[first.frames.length - 1].st;
    const second = await sim(ch, { t0: 0.75, t1: 1.5, sourceAt: pulse, init, initVel: { vmax: first.vmax, dvmax: first.dvmax, froude: first.froude } });
    let w = 0; for (let k = 0; k < ch.g.N; k++) w = Math.max(w, Math.abs(second.vmax[k] - full.vmax[k]));
    let wh = 0; const fs2 = second.frames[second.frames.length - 1].st, ff = full.frames[full.frames.length - 1].st; for (let k = 0; k < ch.g.N; k++) wh = Math.max(wh, Math.abs(fs2[4 * k + 2] - ff[4 * k + 2]));
    // the same state given without the velocity maxima is an initial condition: the depth maxima restart too, so both cover the same period
    // (the channel is draining by 0.75 h, so the earlier peak is well above the depth then: a carried-over maximum would show)
    const fresh = await sim(ch, { t0: 0.75, t1: 1.5, sourceAt: pulse, init }), fst = fresh.frames[fresh.frames.length - 1].st; let mism = 0, binds = 0;
    for (let k = 0; k < ch.g.N; k++) { if (init[4 * k + 2] - init[4 * k] > 0.1) binds++; if (fst[4 * k + 2] > init[4 * k] + 1e-5) mism++; }
    ok("V7 a hot start carries the depth and velocity maxima; a plain initial state restarts both", w < 1e-3 && wh < 1e-4 && binds > 100 && mism === 0,
      `vs one continuous run: speed ${w.toExponential(2)} ft/s, depth max ${wh.toExponential(2)} ft; restart: ${mism} cells keep an earlier depth maximum (${binds} cells where it would show)`);
  }
  // V2 still water: a lake at rest gives no velocity
  {
    const g = grid(40, 30, 6, (r, c) => (c < 5 ? 0 : 2 + 0.05 * c), (r, c) => (r === 0 || r === 29 || c === 39 ? 1 : c < 5 ? 2 : 0));   // walled, so nothing drains off the edges
    const init = (() => { const a = new Float32Array(4 * g.N); for (let k = 0; k < g.N; k++) a[4 * k] = Math.max(3.0 - g.aux[4 * k], 0); return a; })();
    const out = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 0.5, rainAt: () => 0, stageAt: () => [3.0], readSec: 1800, init, initVel: { vmax: new Float32Array(g.N), dvmax: new Float32Array(g.N) } });
    let vm = 0; for (let k = 0; k < g.N; k++) vm = Math.max(vm, out.vmax[k]);
    ok("V2 water at rest has no velocity", vm < 1e-3, `max speed ${vm.toExponential(2)} ft/s`);
  }
  // V3 the 0.05 ft threshold: rain on a gentle slope builds a sheet that is thinner than 0.05 ft upslope and deeper downslope.
  // Cells whose deepest water stayed at or below 0.05 ft record no speed; cells deeper than that, with water moving, do.
  {
    const g = grid(60, 6, 6, (r, c) => 10 - 0.002 * c * 6, (r, c) => (r === 0 || r === 5 || c === 0 ? 1 : 0), 0.05);
    const out = await F.simulate(g, new F.CpuSolver(g), { t0: 0, t1: 1, rainAt: () => 3, stageAt: () => [0], readSec: 3600 });
    const st = out.frames[out.frames.length - 1].st; let below = 0, belowV = 0, above = 0, aboveV = 0;
    for (let k = 0; k < g.N; k++) { if ((g.aux[4 * k + 2] & 3) !== 0) continue; const hm = st[4 * k + 2]; if (hm <= 0.05) { below++; if (out.vmax[k] > 0) belowV++; } else if (hm > 0.06) { above++; if (out.vmax[k] > 0) aboveV++; } }
    ok("V3 speeds are recorded only where the water got deeper than 0.05 ft", below > 20 && above > 20 && belowV === 0 && aboveV === above, `${below} cells never deeper than 0.05 ft (${belowV} with a speed); ${above} cells deeper than 0.06 ft (${aboveV} with a speed)`);
  }
  // V8 (new in 0.6.0, E-09) the time of the maximum speed and the duration with depth x speed above a threshold are recorded.
  // The V1 channel runs at D x V = q = 1.0 ft2/s, above the default 0.5 threshold: with the inflow stopping at 1 h of a 2 h run,
  // the middle third spends between 0.75 and 1.6 h above the threshold (the wave has to arrive and decay), its time of max speed falls inside the run, and a
  // threshold of 2.0 (above anything the channel reaches) records no duration at all. tvmax/dvdur are new outputs in 0.6.0.
  {
    const ch = channel({}), out = await sim(ch, { t1: 2, sourceAt: ramp(ch, 600, 3600) });
    const dur = mid(ch, out, (k) => out.dvdur[k]), tv = mid(ch, out, (k) => out.tvmax[k]);
    const hi = await sim(ch, { t1: 2, sourceAt: ramp(ch, 600, 3600), dvThresh: 2.0 }), durHi = mid(ch, hi, (k) => hi.dvdur[k]);
    // bands tightened in 0.6.1 (review 0.6.0 F-28) around the measured values (duration 3,191 s, time of max 0.338 h)
    ok("V8 time of max speed and duration above the D x V threshold are recorded (and the threshold is the run's)",
      out.tvmax.length === ch.g.N && dur > 2900 && dur < 3500 && tv > 0.25 && tv < 0.45 && durHi === 0,
      `duration above 0.5 ft2/s ${dur.toFixed(0)} s of 7200 (measured 3191); time of max speed ${tv.toFixed(3)} h (measured 0.338); duration above 2.0 ft2/s ${durHi.toFixed(0)} s`);
  }
  // V9 (review 0.6.1 ENG6-6, 6-7, 6-8) the duration above the D x V threshold is summed exactly enough: with a steady channel and fine steps
  // (dtMax 0.02 s, 4 h: 720,000 steps), a cell above the threshold records the whole 4 h less the few seconds the restarted face flows
  // take to build up (14,380-14,400 s; measured 14,392.8); the plain Float32 sum of 0.6.1 recorded 14,254.6 s (-1%), and drifted by -8%
  // over 72 h at this step; a threshold set in one run does not carry over to the next run on the same solver; carried-over
  // velocity arrays of the wrong size or with bad values are refused
  {
    const ch = channel({ nx: 40 }), solver = new F.CpuSolver(ch.g), steady = (h0) => ch.src.map(() => ch.Q / ch.src.length);
    const warm = await sim(ch, { t1: 1, sourceAt: steady, solver });   // reach steady flow first, then carry the state over
    const init = warm.frames.at(-1).st, k = ch.idx(3, 20);
    const fine = await sim(ch, { t0: 1, t1: 5, sourceAt: steady, init, dtMax: 0.02, readSec: 14400, solver });
    const a = await sim(ch, { t1: 0.5, sourceAt: steady, dvThresh: 50, solver }), b = await sim(ch, { t1: 0.5, sourceAt: steady, solver });
    const N = ch.g.N, z = new Float32Array(N), msgs = [];
    for (const iv of [{ vmax: z, dvmax: z, tvmax: new Float32Array(N - 5) }, { vmax: z, dvmax: z, dvdur: new Float32Array(N).fill(-1) }, { vmax: z, dvmax: z, froude: Float32Array.from(z, () => NaN) }])
      try { await sim(ch, { t1: 0.01, sourceAt: steady, init, initVel: iv }); msgs.push("accepted"); } catch (e) { msgs.push(e.message); }
    ok("V9 the D x V duration of a cell above the threshold for 4 h of 0.02 s steps is 14,380-14,400 s (0.6.1: 14,254.6); a run's threshold does not carry over; bad carried-over arrays are refused",
      fine.dvdur[k] > 14380 && fine.dvdur[k] <= 14400 && a.dvdur[k] === 0 && b.dvdur[k] > 1000 && /initVel.tvmax has \d+ values/.test(msgs[0]) && /initVel.dvdur at cell 0 is -1/.test(msgs[1]) && /initVel.froude at cell 0 is NaN/.test(msgs[2]),
      `duration ${fine.dvdur[k].toFixed(2)} s of 14,400; threshold 50 then default: ${a.dvdur[k]} then ${b.dvdur[k].toFixed(0)} s | ${msgs.join(" | ")}`);
  }
  const bad = res.filter((r) => !r.pass).length; console.log(bad ? `${bad} FAILED` : `ALL PASS (${res.length} checks)`); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
