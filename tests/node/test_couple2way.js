// Two-way SWMM <-> 2D coupling with SWMM 5.2.4 in WebAssembly: node tests/node/test_couple2way.js   (exit 1 on failure)
const fs = require("fs"), path = require("path");
const GeoTIFF = require("../../tools/node_modules/geotiff");
const F = require("../../src/engine/flood2d.js"), M = require("../../src/core/model.js"), S = require("../../src/io/swmm.js");
const C2 = require(process.env.COUPLEJS || "../../src/core/couple2way.js"), createSWMM = require("../../vendor/swmm-wasm/swmm5.js");
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../../vendor/crs_catalog.json")));
const res = []; const ok = (name, pass, info) => { res.push({ name, pass: !!pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + "  " + info); };
const ex = (d, f) => path.join(__dirname, "../../examples", d, f);
const ab = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };

(async () => {
  // C0 the WebAssembly SWMM gives the same results as the native engine
  for (const d of ["synthetic_us", "public_demo"]) {
    const m = await createSWMM({ print: () => {}, printErr: () => {} }); m.FS.writeFile("/m.inp", fs.readFileSync(ex(d, "model.inp"), "utf8"));
    const err = m.ccall("swmm_run", "number", ["string", "string", "string"], ["/m.inp", "/m.rpt", "/m.out"]);
    const a = S.readOut(m.FS.readFile("/m.out")), b = S.readOut(fs.readFileSync(ex(d, "model.out")));
    let w = 0; for (const n of a.nodeNames) for (const v of ["flooding", "head"]) { const x = a.getNodeSeries(n, v), y = b.getNodeSeries(n, v); for (let i = 0; i < x.length; i++) w = Math.max(w, Math.abs(x[i] - y[i])); }
    ok(`C0 [${d}] SWMM in WebAssembly equals the native engine`, err === 0 && m._swmm_getVersion() === 52004 && w === 0, `version ${m._swmm_getVersion()}, max difference ${w}`);
  }
  // the synthetic model on a 12 ft grid
  const d = "synthetic_us", dem = await M.readDEM(ab(ex(d, "dem.tif")), GeoTIFF, catalog), geo = (f) => JSON.parse(fs.readFileSync(ex(d, f)));
  const inp = fs.readFileSync(ex(d, "model.inp"), "utf8"), model = S.parseInp(inp), out = S.readOut(fs.readFileSync(ex(d, "model.out")));
  const build = () => M.buildGrid(dem, { cellSize: 12, hUnitFt: dem.hUnitFt, vUnitFt: 1, buildings: geo("buildings.geojson").features, boundaries: [{ key: "POND", feature: geo("pond.geojson").features[0] }] });
  const rptFlood = (txt) => { const m = /Flooding Loss \.+\s+([\d.]+)/.exec(txt); return m ? Number(m[1]) * 43560 : NaN; };
  const T1 = 3;
  async function coupled(opts) {
    const B = build(), c = await C2.makeCoupler(B, createSWMM, inp, model, opts), pond = M.coupleSwmm(B, model, out, { boundaries: [{ key: "POND", node: "POND" }] });
    const r = await F.simulate(B.g, new F.CpuSolver(B.g), { t0: 0, t1: T1, rainAt: () => 0, stageAt: pond.stageAt, sources: c.sources, sourceAt: c.sourceAt, afterChunk: c.afterChunk, chunkSec: 30, readSec: 1800 });
    // finish(): stop the exchange and run SWMM to its end so its report covers the whole period
    const fin = c.finish();
    return { B, c, r, fin, st: r.frames[r.frames.length - 1].st };
  }
  // C1 with the inlets closed, the coupled run passes SWMM's own flooding to the 2D (no water goes back)
  {
    const { c, r, fin } = await coupled({ cw: 0, area: 0 });
    const L = r.ledger, rptV = rptFlood(fin.rpt);
    // the 2D only ran to T1; SWMM flooding after T1 is not in the 2D ledger: compare with the tally up to T1
    ok("C1 closed inlets: no water returns to SWMM", L.captured === 0 && c.tally.sentToSwmm === 0, `captured ${L.captured}, sent ${c.tally.sentToSwmm}`);
    // overflow reaches the 2D one interval later: the last interval's overflow is still pending when the 2D run ends
    ok("C1 closed inlets: 2D inflow equals the overflow SWMM produced while coupled", Math.abs(L.inflow - (c.tally.fromSwmm - c.tally.pendingOverflow)) / c.tally.fromSwmm < 1e-6 && c.tally.fromSwmm > 1000,
      `2D ${L.inflow.toFixed(0)} cf = SWMM ${c.tally.fromSwmm.toFixed(0)} cf - ${c.tally.pendingOverflow.toFixed(0)} cf made in the last interval`);
    ok("C1 closed inlets: SWMM's flooding equals its report", Math.abs(c.tally.fromSwmm + c.tally.lostOverflow - rptV) / rptV < 0.01, `tally ${(c.tally.fromSwmm + c.tally.lostOverflow).toFixed(0)} cf (coupled + lost), report ${rptV.toFixed(0)} cf, SWMM flow continuity ${fin.massBalance.flow.toFixed(3)}%`);
    globalThis.ONEWAY = { L, surf: L.v1 };
  }
  // C2 two-way: water goes back into the inlets; both sides balance
  {
    const { c, r, fin } = await coupled({});
    const L = r.ledger;
    // the engine nets inflow and capture at a node within an interval, so compare net exchange: (2D inflow - 2D capture) = (SWMM overflow - SWMM lateral inflow)
    const net2d = L.inflow - (L.captured - c.tally.shortfall), netSw = c.tally.fromSwmm - c.tally.pendingOverflow - c.tally.sentToSwmm;
    ok("C2 two-way: surface water returns to SWMM through the inlets", c.tally.sentToSwmm > 10000 && Math.abs(net2d - netSw) / c.tally.fromSwmm < 1e-6,
      `sent to SWMM ${c.tally.sentToSwmm.toFixed(0)} cf; net exchange 2D ${net2d.toFixed(1)} cf = SWMM ${netSw.toFixed(1)} cf`);
    ok("C2 two-way: 2D water balance closes, and the only clamp is inlet demand the cells could not supply", Math.abs(L.err) / (L.inflow + L.captured) < 1e-4 && Math.abs(L.clamp - c.tally.shortfall) / Math.max(L.clamp, 1) < 1e-3,
      `closure ${L.err.toFixed(2)} cf; clamp ${L.clamp.toFixed(1)} cf, of which inlet demand not supplied ${c.tally.shortfall.toFixed(1)} cf`);
    ok("C2 two-way: water that goes straight back out of a flooding node is tallied (part of what the inlets took)", c.tally.recirculated > 0 && c.tally.recirculated <= c.tally.sentToSwmm, `${c.tally.recirculated.toFixed(0)} of ${c.tally.sentToSwmm.toFixed(0)} cf`);
    ok("C2 two-way: SWMM continuity stays within 1%", Math.abs(fin.massBalance.flow) < 1, `flow routing continuity ${fin.massBalance.flow.toFixed(3)}%`);
    ok("C2 two-way: less water left on the surface than with closed inlets", L.v1 < globalThis.ONEWAY.surf, `${(L.v1 / 43560).toFixed(3)} ac-ft vs ${(globalThis.ONEWAY.surf / 43560).toFixed(3)} ac-ft`);
    const net = c.tally.perNode.map((p, i) => `${c.sources[i].name} out ${(p.out / 43560).toFixed(2)} in ${(p.in / 43560).toFixed(2)}`);
    console.log("   per node (ac-ft):", net.join("; "));
  }
  // C4 per-inlet parameters: two curb inlets on J4 placed off the manhole, no default inlets elsewhere
  {
    const j4 = model.nodes[model.nodeIndex.J4], inl = [{ x: j4.x - 40, y: j4.y + 12, node: "J4", lw: 6, area: 3 }, { x: j4.x + 40, y: j4.y - 12, node: "J4", lw: 2, area: 1 }, { x: j4.x, y: j4.y, node: "NOPE" }];
    const { c, r } = await coupled({ inlets: inl, defaultInlets: false });
    const iJ4 = c.nodes.findIndex((n) => n.name === "J4"), perIn = c.tally.perInlet, sumIn = perIn.reduce((a, v) => a + v, 0);
    ok("C4 only the listed inlets capture water, at their own cells", c.inlets.length === 2 && c.inlets.every((it) => it.node === "J4") && c.inlets[0].cell !== c.nodes[iJ4].cell && Math.abs(c.tally.sentToSwmm - sumIn) < 1e-6 * Math.max(1, sumIn) && sumIn > 0,
      `${c.inlets.length} inlets; captured ${perIn.map((v) => v.toFixed(0)).join(" + ")} cf = sent to SWMM ${c.tally.sentToSwmm.toFixed(0)} cf`);
    ok("C4 SWMM receives the sum of J4's inlets as its lateral inflow", Math.abs(c.tally.perNode[iJ4].in - sumIn) < 1e-6 * Math.max(1, sumIn) && sumIn > 0, `J4 in ${c.tally.perNode[iJ4].in.toFixed(0)} cf`);
    // same place, smaller opening: less capture (the inlet size is used)
    const small = await coupled({ inlets: [{ x: j4.x - 40, y: j4.y + 12, node: "J4", lw: 1, area: 0.3 }], defaultInlets: false });
    ok("C4 a smaller inlet at the same place takes less water", small.c.tally.perInlet[0] < perIn[0] && small.c.tally.perInlet[0] > 0, `${small.c.tally.perInlet[0].toFixed(0)} cf (1 ft weir, 0.3 sq ft) vs ${perIn[0].toFixed(0)} cf (6 ft weir, 3 sq ft)`);
    ok("C4 an inlet tied to an unknown node is reported", c.warnings.some((w) => /node NOPE is not a coupled SWMM junction/.test(w)), c.warnings.join(" | "));
    ok("C4 2D capture equals what the inlets took", Math.abs(r.ledger.captured - c.tally.shortfall - sumIn) / sumIn < 1e-6 && Math.abs(r.ledger.err) / r.ledger.inflow < 1e-4, `2D captured ${(r.ledger.captured - c.tally.shortfall).toFixed(0)} cf (demand ${r.ledger.captured.toFixed(0)} cf, not supplied ${c.tally.shortfall.toFixed(0)} cf); closure ${r.ledger.err.toFixed(2)} cf`);
  }
  {
    let m = ""; try { await coupled({ inlets: [{ x: model.nodes[0].x, y: model.nodes[0].y, node: "J1", lw: -2 }] }); } catch (e) { m = e.message; }
    ok("C4 an invalid inlet size is refused", /Inlet 1 \(J1\): weir length -2/.test(m), m);
  }
  // ---- exchange-only probes: a stand-in surface with a fixed depth everywhere (no 2D run), so each check isolates the coupler
  const flat = (depth) => ({ readCells: async (cells) => cells.map(() => depth) });
  const sweep = async (c, h0, h1, depth, stepSec = 30) => { for (let t = h0; t < h1 - 1e-9; t += stepSec / 3600) { const s = flat(depth), t1 = Math.min(h1, t + stepSec / 3600); await c.sourceAt(t, t1, s); if (c.afterChunk) await c.afterChunk(t, t1, s); } };
  const rptExternal = (txt) => { const m = /Flow Routing Continuity[\s\S]*?External Inflow \.+\s+([\d.]+)/.exec(txt); return m ? Number(m[1]) * 43560 : NaN; };
  // C5 when the exchange stops, SWMM must not keep receiving the last inlet capture for the rest of its run
  {
    const c = await C2.makeCoupler(build(), createSWMM, inp, model, {});
    await sweep(c, 0, 0.25, 0.3);
    const sent = c.tally.sentToSwmm, fin = c.finish(), ext = rptExternal(fin.rpt), o = S.readOut(fin.out);
    ok("C5 after the exchange stops, SWMM receives only what the inlets took (report external inflow = tally)", sent > 1000 && Math.abs(ext - sent) / sent < 0.01 && o.nPeriods === out.nPeriods,
      `tally ${sent.toFixed(0)} cf; SWMM external inflow ${ext.toFixed(0)} cf; report periods ${o.nPeriods} of ${out.nPeriods}`);
  }
  // C6 a listed inlet with no crest elevation uses its node's SWMM rim, the same crest as a default inlet (rim raised 1 ft above the ground here)
  {
    const inpHi = inp.replace(/^(J4\s+48\.842\s+)7\.000/m, "$18.000"), modelHi = S.parseInp(inpHi), j4 = modelHi.nodes[modelHi.nodeIndex.J4];
    const one = async (opts) => { const c = await C2.makeCoupler(build(), createSWMM, inpHi, modelHi, opts); await sweep(c, 1, 1 + 30 / 3600, 1.5); return c; };
    const dflt = await one({}), listed = await one({ inlets: [{ x: j4.x, y: j4.y, node: "J4" }] });
    const qD = dflt.tally.perNode[dflt.nodes.findIndex((n) => n.name === "J4")].in, qL = listed.tally.perNode[listed.nodes.findIndex((n) => n.name === "J4")].in;
    ok("C6 a listed inlet without rim_ft takes the same water as the default inlet at the same place", qD > 0 && Math.abs(qL - qD) / qD < 1e-9, `listed ${qL.toFixed(2)} cf, default ${qD.toFixed(2)} cf (crest ${Number(listed.inlets.find((i) => i.node === "J4").rimFt).toFixed(3)} ft)`);
    ok("C6 a crest far from the cell ground is reported", listed.warnings.some((w) => /Inlet 1 \(J4\): crest 56\.8\d ft is 0\.9\d ft above the ground/.test(w)), listed.warnings.filter((w) => /crest/.test(w)).join(" | "));
  }
  // C7 the same site in US and SI units exchanges the same water (no jump between the weir and orifice regimes when a flooding node sits at its rim)
  {
    const dS = "synthetic_si", demS = await M.readDEM(ab(ex(dS, "dem.tif")), GeoTIFF, catalog), geoS = (f) => JSON.parse(fs.readFileSync(ex(dS, f)));
    const inpS = fs.readFileSync(ex(dS, "model.inp"), "utf8"), modelS = S.parseInp(inpS);
    const BS = M.buildGrid(demS, { cellSize: 3.6576, hUnitFt: demS.hUnitFt, vUnitFt: 1 / 0.3048, buildings: geoS("buildings.geojson").features, boundaries: [{ key: "POND", feature: geoS("pond.geojson").features[0] }] });
    const r = {};
    // capFrac lifted so that the inlet equations, not the half-the-water cap, set the exchange
    for (const [k, B, text, mdl] of [["US", build(), inp, model], ["SI", BS, inpS, modelS]]) { const c = await C2.makeCoupler(B, createSWMM, text, mdl, { capFrac: 1e9 }); await sweep(c, 1, 2, 0.3); r[k] = c.tally; }
    const ratio = r.SI.sentToSwmm / r.US.sentToSwmm, worst = Math.max(...r.US.perNode.map((p, i) => Math.abs(r.SI.perNode[i].in - p.in) / Math.max(p.in, 1)));
    ok("C7 US and SI models of the same site send the same water to SWMM", Math.abs(ratio - 1) < 0.02 && worst < 0.05, `sent to SWMM US ${r.US.sentToSwmm.toFixed(0)} cf, SI ${r.SI.sentToSwmm.toFixed(0)} cf (ratio ${ratio.toFixed(3)}); worst node ${(100 * worst).toFixed(1)}%`);
  }
  // C8 inlet list checks
  {
    const j4 = model.nodes[model.nodeIndex.J4];
    const off = await C2.makeCoupler(build(), createSWMM, inp, model, { inlets: [{ x: j4.x + 1e6, y: j4.y, node: "J4" }] });
    ok("C8 a junction whose listed inlet was rejected gets no default inlet", !off.inlets.some((i) => i.node === "J4") && off.nodeMap.find((n) => n.name === "J4").inlets === 0 && off.warnings.some((w) => /Inlet 1 \(J4\).*no default inlet/.test(w)),
      off.warnings.filter((w) => /J4/.test(w)).join(" | "));
    const far = await C2.makeCoupler(build(), createSWMM, inp, model, { inlets: [{ x: j4.x - 800, y: j4.y - 400, node: "J4" }] });
    ok("C8 an inlet far from its node is reported", far.warnings.some((w) => /Inlet 1 \(J4\) is 89\d ft from its node/.test(w)), far.warnings.filter((w) => /ft from/.test(w)).join(" | "));
    const refused = [];
    for (const [k, v] of [["co", 0], ["cw", 0], ["lw", "4"], ["area", NaN], ["rimFt", "abc"]]) { try { await C2.makeCoupler(build(), createSWMM, inp, model, { inlets: [{ x: j4.x, y: j4.y, node: "J4", [k]: v }] }); refused.push(`${k}=${v} accepted`); } catch (e) { refused.push(e.message); } }
    ok("C8 zero, text and NaN inlet values are refused, naming the inlet and value", refused.every((m) => /^Inlet 1 \(J4\): .* is not a/.test(m)) && /"4"/.test(refused[2]) && /NaN/.test(refused[3]), refused.join(" | "));
    // three identical large inlets in one cell share the cell's water: together they take no more than one inlet alone
    const big = { node: "J4", lw: 50, area: 50 }, pts = (n) => Array.from({ length: n }, () => Object.assign({ x: j4.x, y: j4.y }, big));
    const take = async (n) => { const c = await C2.makeCoupler(build(), createSWMM, inp, model, { inlets: pts(n), defaultInlets: false, capFrac: 0.5 }); await sweep(c, 1, 1 + 30 / 3600, 0.05); return c.tally.perInlet; };
    const t1 = await take(1), t3 = await take(3), dx = build().G.dxFt, cap = 0.5 * 0.05 * dx * dx;   // capFrac x depth x cell area: the most one interval may take from the cell
    ok("C8 inlets in one cell share the optional half-the-water cap", Math.abs(t1[0] - cap) < 1e-9 * cap && Math.abs(t3.reduce((a, v) => a + v, 0) - cap) < 1e-9 * cap, `one inlet ${t1[0].toFixed(3)} cf; three inlets ${t3.map((v) => v.toFixed(3)).join(" + ")} cf; cap ${cap.toFixed(3)} cf`);
  }
  // C9 inlet capture does not depend on cell size: with the same depth over the same inlet, 12 ft and 6 ft grids take the same water
  // (crest set far below the ground so the head is the water depth on both grids; the old per-interval cap, half the cell's water, took 4 times less on the 6 ft grid)
  {
    const j1 = model.nodes.find((n) => n.name === "J1"), depth = 0.3;
    const run = async (cell) => {
      const B = M.buildGrid(dem, { cellSize: cell, hUnitFt: dem.hUnitFt, vUnitFt: 1, buildings: geo("buildings.geojson").features, boundaries: [{ key: "POND", feature: geo("pond.geojson").features[0] }] });
      const c = await C2.makeCoupler(B, createSWMM, inp, model, { inlets: [{ x: j1.x, y: j1.y, node: "J1", lw: 20, area: 10, rimFt: 0 }], defaultInlets: false });
      await sweep(c, 1, 1 + 600 / 3600, depth); return c.tally.perInlet[0];
    };
    const a = await run(12), b = await run(6);
    ok("C9 an inlet takes the same water at 12 ft and 6 ft cells", Math.abs(a / b - 1) < 1e-6 && a > 0, `taken in 10 min at ${depth} ft: 12 ft ${a.toFixed(0)} cf, 6 ft ${b.toFixed(0)} cf (ratio ${(a / b).toFixed(3)})`);
  }
  // C10 HEC-22 sag inlet types and clogging (hand-computed: g = 32.174 ft/s2)
  {
    const cap = C2.inletCapacity, g2 = 2 * 32.174, I = Infinity, near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
    const grate = { kind: "grate", lw: 6, area: 2, cw: 3.0, co: 0.67 }, curb = { kind: "curb", cl: 5, ch: 0.5, dw: 0, ccw: 3.0, cco: 0.67 };
    const curbD = Object.assign({}, curb, { dw: 2, ccw: 2.3 }), combo = Object.assign({}, grate, { kind: "combination", cl: 5, ch: 0.5, dw: 0, ccw: 3.0, cco: 0.67 });
    const cases = [
      ["grate, weir regime (0.3 ft)", cap(grate, 0.3, I), Math.min(3 * 6 * 0.3 ** 1.5, 0.67 * 2 * Math.sqrt(g2 * 0.3))],
      ["grate, orifice regime (1.5 ft)", cap(grate, 1.5, I), 0.67 * 2 * Math.sqrt(g2 * 1.5)],
      ["grate, 50% clogged (0.3 ft)", cap(Object.assign({ clog: 0.5 }, grate), 0.3, I), 0.5 * 3 * 6 * 0.3 ** 1.5],
      ["curb, weir below the opening height (0.3 ft)", cap(curb, 0.3, I), 3 * 5 * 0.3 ** 1.5],
      ["curb, above the opening (1.5 ft): lesser of weir and orifice at the centroid", cap(curb, 1.5, I), Math.min(3 * 5 * 1.5 ** 1.5, 0.67 * 0.5 * 5 * Math.sqrt(g2 * (1.5 - 0.25)))],
      ["curb with a 2 ft gutter depression (0.3 ft)", cap(curbD, 0.3, I), 2.3 * (5 + 1.8 * 2) * 0.3 ** 1.5],
      ["combination, shallow (0.3 ft): the grate alone", cap(combo, 0.3, I), Math.min(3 * 6 * 0.3 ** 1.5, 0.67 * 2 * Math.sqrt(g2 * 0.3))],
      ["combination, deep (1.5 ft): grate orifice + curb orifice", cap(combo, 1.5, I), Math.min(3 * 6 * 1.5 ** 1.5, 0.67 * 2 * Math.sqrt(g2 * 1.5) + 0.67 * 0.5 * 5 * Math.sqrt(g2 * 1.25))],
      ["surcharged node: grate orifice on the head left (0.1 ft)", cap(grate, 0.3, 0.1), Math.min(3 * 6 * 0.3 ** 1.5, 0.67 * 2 * Math.sqrt(g2 * 0.1))],
      ["node level with the water: nothing", cap(curb, 0.3, 0), 0],
    ];
    const bad = cases.filter(([, a, b]) => !near(a, b));
    ok("C10 HEC-22 sag inlets: grate, curb (with and without depression), combination, clogging and surcharge match hand calculations", bad.length === 0,
      bad.length ? bad.map(([n, a, b]) => `${n}: ${a} vs ${b}`).join("; ") : cases.map(([n, a]) => `${n} ${a.toFixed(3)} cfs`).join("; "));
    // the regimes meet: no jump in a curb inlet's capacity at the opening height or as the node rises past the crest
    const below = cap(curb, 0.5 - 1e-9, I), above = cap(curb, 0.5 + 1e-9, I), sur = cap(curb, 0.3, 0.3 + 1e-12), free = cap(curb, 0.3, I);
    ok("C10 an undepressed curb's capacity is continuous at the opening height and at the crest (a depressed curb is not: the HEC-22/TxDOT weir and orifice do not meet)", Math.abs(above - below) < 1e-6 && Math.abs(sur - free) < 1e-6, `${below.toFixed(6)} / ${above.toFixed(6)} cfs; ${free.toFixed(6)} / ${sur.toFixed(6)} cfs`);
    const iJ4 = model.nodes.findIndex((n) => n.name === "J4"), j4 = model.nodes[iJ4], refused = [];
    for (const [k, extra] of [["slot type", { type: "slot" }], ["curb without height", { type: "curb", curbLength: 5 }], ["grate without area", { type: "grate", lw: 6 }], ["clog 1.2", { clog: 1.2 }], ["negative depression", { type: "curb", curbLength: 5, curbHeight: 0.5, depressionWidth: -1 }]]) {
      try { await C2.makeCoupler(build(), createSWMM, inp, model, { inlets: [Object.assign({ x: j4.x, y: j4.y, node: "J4" }, extra)] }); refused.push(`${k} accepted`); } catch (e) { refused.push(e.message); }
    }
    ok("C10 an unknown type, missing curb or grate sizes and a clog of 1 or more are refused, naming the inlet", refused.every((m) => /^Inlet 1 \(J4\): /.test(m)), refused.join(" | "));
    // typed inlets run through the coupler: a 50% clogged grate takes half of the same clean grate's water in the weir regime
    const takeT = async (extra) => { const c = await C2.makeCoupler(build(), createSWMM, inp, model, { inlets: [Object.assign({ x: j4.x, y: j4.y, node: "J4", rimFt: 0 }, extra)], defaultInlets: false }); await sweep(c, 1, 1 + 60 / 3600, 0.2); return c.tally.perInlet[0]; };
    const clean = await takeT({ type: "grate", lw: 6, area: 20 }), half = await takeT({ type: "grate", lw: 6, area: 20, clog: 0.5 });
    ok("C10 a 50% clogged grate takes half the water of a clean one (weir regime, through the coupler)", clean > 0 && Math.abs(half / clean - 0.5) < 1e-9, `clean ${clean.toFixed(1)} cf, clogged ${half.toFixed(1)} cf`);
  }
  // C11 an outfall on a routed lake: its inflow raises the lake, and it takes the lake's level as its stage
  {
    const pond = model.nodes.find((n) => n.name === "POND");
    const inpL = inp.replace(/^(C7\s+J7\s+)POND/m, "$1LK").replace(/\[OUTFALLS\][^\n]*\n[^\n]*\n/, (m) => m + "LK               46.142 FIXED 50.0 NO\n").replace(/\[COORDINATES\][^\n]*\n[^\n]*\n/, (m) => m + `LK               ${pond.x} ${pond.y}\n`);
    const modelL = S.parseInp(inpL), B = build(), c = await C2.makeCoupler(B, createSWMM, inpL, modelL, {});
    const routed = [{ lake: 0, areaFt2: 200000, level0: 50 }], lakeInflow = c.lakeInflowFor(routed);
    const r = await F.simulate(B.g, new F.CpuSolver(B.g), { t0: 0, t1: 1.5, rainAt: () => 0, stageAt: () => [50], sources: c.sources, sourceAt: c.sourceAt, afterChunk: c.afterChunk, routedLakes: routed, lakeInflow, chunkSec: 30, readSec: 1800 });
    const lk = r.lakes, i = c.engine.names.indexOf("LK"), head = c.engine.get(C2.P.NODE_HEAD, i);
    ok("C11 the outfall on a routed lake is found and its inflow raises the lake", c.lakeOutfalls.length === 1 && c.lakeOutfalls[0].name === "LK" && lk.outside[0] > 1000 && Math.abs(lk.outside[0] - c.tally.toLakes[0]) < 1e-6 &&
      Math.abs((lk.end[0] - 50) * 200000 - (lk.from2d[0] + lk.outside[0])) < 1e-3 * lk.outside[0], `outfall inflow ${lk.outside[0].toFixed(0)} cf, from the 2D ${lk.from2d[0].toFixed(0)} cf; lake 50 -> ${lk.end[0].toFixed(3)} ft`);
    ok("C11 the outfall's stage follows the routed lake level", Math.abs(head - lk.series[lk.series.length - 2].levels[0]) < 1e-3 || Math.abs(head - lk.end[0]) < 1e-3, `outfall head ${head.toFixed(3)} ft; lake ${lk.end[0].toFixed(3)} ft`);
    c.finish();
  }
  // C12 a routed lake above its outfall pipe: the water that flows back from the lake into SWMM is taken from the lake, not added to it
  {
    const pond = model.nodes.find((n) => n.name === "POND");
    const inpL = inp.replace(/^(C7\s+J7\s+)POND/m, "$1LK").replace(/\[OUTFALLS\][^\n]*\n[^\n]*\n/, (m) => m + "LK               46.142 FIXED 58.0 NO\n").replace(/\[COORDINATES\][^\n]*\n[^\n]*\n/, (m) => m + `LK               ${pond.x} ${pond.y}\n`);
    const modelL = S.parseInp(inpL), B = build(), c = await C2.makeCoupler(B, createSWMM, inpL, modelL, { cw: 0, area: 0 });
    // the sign of the flow in C7 at each step, read on its own from SWMM: + toward the lake
    const sw = c.engine, li = (() => { const b = sw.M._malloc(64); let k = -1; for (let i = 0; i < sw.M._swmm_getCount(3); i++) { sw.M._swmm_getName(3, i, b, 63); if (sw.M.UTF8ToString(b) === "C7") k = i; } sw.M._free(b); return k; })();
    const toLake = 1;   // C7 is written J7 -> LK in the .inp, and SWMM reports link flow in the written direction
    let back = 0; const step0 = sw.advance.bind(sw);
    sw.advance = (tSec, nodes) => { const t0 = sw.tSec; const r = step0(tSec, nodes); back += Math.min(toLake * sw.get(C2.P.LINK_FLOW, li), 0) * (sw.tSec - t0); return r; };
    const routed = [{ lake: 0, areaFt2: 200000, level0: 58 }], lakeInflow = c.lakeInflowFor(routed);
    const r = await F.simulate(B.g, new F.CpuSolver(B.g), { t0: 0, t1: 0.5, rainAt: () => 0, stageAt: () => [58], sources: c.sources, sourceAt: c.sourceAt, afterChunk: c.afterChunk, routedLakes: routed, lakeInflow, chunkSec: 30, readSec: 1800 });
    const lk = r.lakes, backRun = back; c.finish(); back = backRun;   // only while coupled (finish() runs SWMM on to its end)
    ok("C12 water flowing back from a routed lake into SWMM lowers the lake by about that volume", back < -1000 && lk.outside[0] < 0 && Math.abs(lk.outside[0] / back - 1) < 0.1,
      `back into SWMM about ${(-back).toFixed(0)} cf (C7 flow toward the network); lake booked ${lk.outside[0].toFixed(0)} cf from the outfall`);
  }
  // C13 a missing or NaN lake level, and a NaN clamp reading, are refused instead of changing SWMM silently
  {
    const pond = model.nodes.find((n) => n.name === "POND");
    const inpL = inp.replace(/^(C7\s+J7\s+)POND/m, "$1LK").replace(/\[OUTFALLS\][^\n]*\n[^\n]*\n/, (m) => m + "LK               46.142 FIXED 50.0 NO\n").replace(/\[COORDINATES\][^\n]*\n[^\n]*\n/, (m) => m + `LK               ${pond.x} ${pond.y}\n`);
    const msgs = [];
    for (const lv of [[], [NaN], null]) { const c = await C2.makeCoupler(build(), createSWMM, inpL, S.parseInp(inpL), {}); const f = c.lakeInflowFor([{ lake: 0 }]); try { f(0, 1 / 120, lv); msgs.push("accepted"); } catch (e) { msgs.push(e.message); } }
    const c = await C2.makeCoupler(build(), createSWMM, inp, model, {}), s0 = { readCells: async (cells) => cells.map(() => 0.3), readClamp: async (cells) => cells.map(() => 0) }, s1 = { readCells: s0.readCells, readClamp: async (cells) => cells.map(() => NaN) };
    await c.sourceAt(1, 1 + 30 / 3600, s0); try { await c.afterChunk(1, 1 + 30 / 3600, s1); msgs.push("accepted"); } catch (e) { msgs.push(e.message); }
    ok("C13 missing or NaN lake levels and a NaN clamp are refused", msgs.slice(0, 3).every((m) => /levels missing or not a number/.test(m)) && /clamp at an inlet cell is not a number/.test(msgs[3]), msgs.join(" | "));
  }
  // C14 SWMM receives exactly what the inlets took, whatever its routing step (20 s and 60 s against 30 s exchanges, demand on and off)
  {
    const out14 = [];
    for (const rs of [20, 60]) {
      const inpR = inp.replace(/^ROUTING_STEP\s+\S+/m, `ROUTING_STEP         0:00:${String(rs % 60).padStart(2, "0")}`.replace("0:00:00", "0:01:00")).replace(/^VARIABLE_STEP\s+\S+/m, "VARIABLE_STEP        0");
      const c = await C2.makeCoupler(build(), createSWMM, inpR, S.parseInp(inpR), {});
      for (let i = 0; i < 20; i++) { const t = 1 + i * 30 / 3600, sv = flat(i % 2 ? 0 : 0.3); await c.sourceAt(t, t + 30 / 3600, sv); await c.afterChunk(t, t + 30 / 3600, sv); }
      const fin = c.finish(), ext = rptExternal(fin.rpt), sent = c.tally.sentToSwmm;
      out14.push({ rs, sent, ext, owed: c.tally.owedToSwmm ?? 0 });
    }
    // the report gives ac-ft to 3 decimals (43.6 cf); a SWMM step that ends past the last exchange can deliver up to one step ahead, which is booked as owed (< 0)
    ok("C14 SWMM's external inflow equals what the inlets took, less what is booked as still owed, with 20 s and 60 s routing steps", out14.every((x) => x.sent > 1000 && Math.abs(x.ext - (x.sent - x.owed)) < 50 && Math.abs(x.owed) < 0.03 * x.sent),
      out14.map((x) => `${x.rs} s: inlets ${x.sent.toFixed(0)} cf, SWMM report ${x.ext.toFixed(0)} cf, still owed ${x.owed.toFixed(1)} cf`).join("; "));
  }
  // C15 a curb opening longer than 12 ft does not count its gutter depression (TxDOT HDM ch. 10 sec. 6), and says so;
  // a sourceAt with no afterChunk for the interval before is refused; the water that goes straight back out of a flooding node is tallied
  {
    const j4 = model.nodes.find((n) => n.name === "J4");
    const c = await C2.makeCoupler(build(), createSWMM, inp, model, { inlets: [{ x: j4.x, y: j4.y, node: "J4", type: "curb", curbLength: 15, curbHeight: 0.5, depressionWidth: 2, rimFt: 0 }], defaultInlets: false });
    await sweep(c, 1, 1 + 30 / 3600, 0.3);
    const expect = 3.0 * 15 * Math.pow(0.3, 1.5) * 30;   // Cw 3.0 on L, no depression term, for one 30 s interval
    ok("C15 a 15 ft curb opening ignores its depression and warns", Math.abs(c.tally.perInlet[0] - expect) < 1e-6 * expect && c.warnings.some((m) => /longer than 12 ft/.test(m)), `took ${c.tally.perInlet[0].toFixed(2)} cf (3.0 x 15 x 0.3^1.5 x 30 s = ${expect.toFixed(2)} cf)`);
    const c2 = await C2.makeCoupler(build(), createSWMM, inp, model, {}), s0 = flat(0.3); let m = "";
    await c2.sourceAt(1, 1 + 30 / 3600, s0); try { await c2.sourceAt(1 + 30 / 3600, 1 + 60 / 3600, s0); } catch (e) { m = e.message; }
    ok("C15 an interval whose afterChunk was never called is refused", /afterChunk was not called/.test(m), m);
  }
  // C16 water SWMM puts on a lake's outfall directly ([INFLOWS] here) reaches the routed lake: the lake gets what SWMM's report says left by that outfall
  {
    const pond = model.nodes.find((n) => n.name === "POND");
    const inpL = inp.replace(/^(C7\s+J7\s+)POND/m, "$1LK").replace(/\[OUTFALLS\][^\n]*\n[^\n]*\n/, (m) => m + "LK               46.142 FIXED 50.0 NO\n").replace(/\[COORDINATES\][^\n]*\n[^\n]*\n/, (m) => m + `LK               ${pond.x} ${pond.y}\n`) + '\n[INFLOWS]\nLK FLOW "" FLOW 1.0 1.0 2.0\n';
    const c = await C2.makeCoupler(build(), createSWMM, inpL, S.parseInp(inpL), { cw: 0, area: 0 }), f = c.lakeInflowFor([{ lake: 0 }]);
    let booked = 0; for (let t = 0; t < 6 - 1e-9; t += 300 / 3600) { const sv = flat(0); await c.sourceAt(t, t + 300 / 3600, sv); await c.afterChunk(t, t + 300 / 3600, sv); booked += f(t, t + 300 / 3600, [50])[0]; }
    const fin = c.finish(), m = new RegExp("^\\s*LK\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)", "m").exec(fin.rpt.split("Outfall Loading Summary")[1] || ""), rptCf = m ? Number(m[4]) * 1e6 / 7.48052 : NaN;
    ok("C16 a routed lake gets the outfall's direct inflow too: booked = SWMM's outfall total volume", Math.abs(booked / rptCf - 1) < 0.01 && booked > 43200, `booked ${booked.toFixed(0)} cf; SWMM outfall LK ${rptCf.toFixed(0)} cf (2 cfs x 6 h = 43,200 cf of it direct)`);
    const msgs = [];
    const c2 = await C2.makeCoupler(build(), createSWMM, inp, model, {});
    try { await c2.sourceAt(1, 1 + 30 / 3600, { readCells: async (cells) => cells.map(() => NaN), readClamp: async (cells) => cells.map(() => 0) }); msgs.push("accepted"); } catch (e) { msgs.push(e.message); }
    try { await c2.sourceAt(1, 1 + 30 / 3600, { readCells: async (cells) => cells.map(() => 0.3), readClamp: async (cells) => cells.map(() => NaN) }); msgs.push("accepted"); } catch (e) { msgs.push(e.message); }
    const c3 = await C2.makeCoupler(build(), createSWMM, inp, model, {}); await c3.sourceAt(1, 1 + 30 / 3600, flat(0.3)); try { c3.finish(); msgs.push("accepted"); } catch (e) { msgs.push(e.message); }
    try { await C2.makeCoupler(build(), createSWMM, inp + "\n[EVENTS]\n07/15/2024 03:00 07/15/2024 06:00\n", model, {}); msgs.push("accepted"); } catch (e) { msgs.push(e.message); }
    ok("C16 a NaN depth, a NaN clamp at the start of an interval, finish() with an interval not booked and an [EVENTS] section are refused",
      /depth at an inlet cell is not a number/.test(msgs[0]) && /clamp at an inlet cell is not a number/.test(msgs[1]) && /not called for the last interval/.test(msgs[2]) && /\[EVENTS\]/.test(msgs[3]), msgs.join(" | "));
    const j4 = model.nodes.find((n) => n.name === "J4");
    const c4 = await C2.makeCoupler(build(), createSWMM, inp, model, { inlets: [{ x: j4.x, y: j4.y, node: "J4", type: "curb", curbLength: 15, curbHeight: 0.5, depressionWidth: 2, ccw: 2.3, rimFt: 0 }], defaultInlets: false });
    await sweep(c4, 1, 1 + 30 / 3600, 0.3);
    ok("C16 a curb opening over 12 ft uses Cw 3.0 even when 2.3 is given", Math.abs(c4.tally.perInlet[0] - 3.0 * 15 * Math.pow(0.3, 1.5) * 30) < 1e-3, `took ${c4.tally.perInlet[0].toFixed(2)} cf`);
  }
  // C3 prepareInp forces ALLOW_PONDING NO
  {
    const p = C2.prepareInp("[OPTIONS]\nFLOW_UNITS CFS\nALLOW_PONDING YES\n[JUNCTIONS]\nJ 1 2\n");
    const q = C2.prepareInp("[OPTIONS]\nFLOW_UNITS CFS\n[JUNCTIONS]\nJ 1 2\n");
    ok("C3 ponding at nodes is turned off for coupling (and said so)", /ALLOW_PONDING\s+NO/.test(p.text) && p.notes.length === 1 && /ALLOW_PONDING\s+NO/.test(q.text), p.notes.join(""));
  }
  const bad = res.filter((r) => !r.pass).length; console.log(bad ? `${bad} FAILED` : "ALL PASS"); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
