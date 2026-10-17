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
    const r = await F.simulate(B.g, new F.CpuSolver(B.g), { t0: 0, t1: T1, rainAt: () => 0, stageAt: pond.stageAt, sources: c.sources, sourceAt: c.sourceAt, chunkSec: 30, readSec: 1800 });
    // finish the SWMM run to its end so its report covers the whole period
    c.engine.advance(1e9, []); const fin = c.finish();
    return { B, c, r, fin, st: r.frames[r.frames.length - 1].st };
  }
  // C1 with the inlets closed, the coupled run passes SWMM's own flooding to the 2D (no water goes back)
  {
    const { c, r, fin } = await coupled({ cw: 0, area: 0 });
    const L = r.ledger, rptV = rptFlood(fin.rpt);
    // the 2D only ran to T1; SWMM flooding after T1 is not in the 2D ledger: compare with the tally up to T1
    ok("C1 closed inlets: no water returns to SWMM", L.captured === 0 && c.tally.sentToSwmm === 0, `captured ${L.captured}, sent ${c.tally.sentToSwmm}`);
    ok("C1 closed inlets: 2D inflow equals the overflow SWMM produced while coupled", Math.abs(L.inflow - c.tally.fromSwmm) / c.tally.fromSwmm < 1e-6, `2D ${L.inflow.toFixed(0)} cf, SWMM ${c.tally.fromSwmm.toFixed(0)} cf`);
    ok("C1 closed inlets: SWMM's flooding equals its report", Math.abs(c.tally.fromSwmm + c.tally.lostOverflow - rptV) / rptV < 0.01, `tally ${(c.tally.fromSwmm + c.tally.lostOverflow).toFixed(0)} cf (coupled + lost), report ${rptV.toFixed(0)} cf, SWMM flow continuity ${fin.massBalance.flow.toFixed(3)}%`);
    globalThis.ONEWAY = { L, surf: L.v1 };
  }
  // C2 two-way: water goes back into the inlets; both sides balance
  {
    const { c, r, fin } = await coupled({});
    const L = r.ledger;
    // the engine nets inflow and capture at a node within an interval, so compare net exchange: (2D inflow - 2D capture) = (SWMM overflow - SWMM lateral inflow)
    const net2d = L.inflow - L.captured, netSw = c.tally.fromSwmm - c.tally.sentToSwmm;
    ok("C2 two-way: surface water returns to SWMM through the inlets", c.tally.sentToSwmm > 10000 && Math.abs(net2d - netSw) / c.tally.fromSwmm < 1e-6,
      `sent to SWMM ${c.tally.sentToSwmm.toFixed(0)} cf; net exchange 2D ${net2d.toFixed(1)} cf = SWMM ${netSw.toFixed(1)} cf`);
    ok("C2 two-way: 2D water balance closes", Math.abs(L.err) / (L.inflow + L.captured) < 1e-4 && L.clamp / L.captured < 0.01, `closure ${L.err.toFixed(2)} cf; clamp ${L.clamp.toFixed(2)} cf (${(100 * L.clamp / L.captured).toFixed(3)}% of capture)`);
    ok("C2 two-way: SWMM continuity stays within 1%", Math.abs(fin.massBalance.flow) < 1, `flow routing continuity ${fin.massBalance.flow.toFixed(3)}%`);
    ok("C2 two-way: less water left on the surface than with closed inlets", L.v1 < globalThis.ONEWAY.surf, `${(L.v1 / 43560).toFixed(3)} ac-ft vs ${(globalThis.ONEWAY.surf / 43560).toFixed(3)} ac-ft`);
    const net = c.tally.perNode.map((p, i) => `${c.sources[i].name} out ${(p.out / 43560).toFixed(2)} in ${(p.in / 43560).toFixed(2)}`);
    console.log("   per node (ac-ft):", net.join("; "));
  }
  // C3 prepareInp forces ALLOW_PONDING NO
  {
    const p = C2.prepareInp("[OPTIONS]\nFLOW_UNITS CFS\nALLOW_PONDING YES\n[JUNCTIONS]\nJ 1 2\n");
    const q = C2.prepareInp("[OPTIONS]\nFLOW_UNITS CFS\n[JUNCTIONS]\nJ 1 2\n");
    ok("C3 ponding at nodes is turned off for coupling (and said so)", /ALLOW_PONDING\s+NO/.test(p.text) && p.notes.length === 1 && /ALLOW_PONDING\s+NO/.test(q.text), p.notes.join(""));
  }
  const bad = res.filter((r) => !r.pass).length; console.log(bad ? `${bad} FAILED` : "ALL PASS"); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
