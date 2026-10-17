// Model builder (DEM, buildings, boundaries, SWMM coupling, GeoTIFF out): node tests/node/test_model.js   (exit 1 on failure)
// Reference values from rasterio (tests/py/make_grid_reference.py) and the SWMM engine (make_swmm_reference.py).
const fs = require("fs"), path = require("path");
const GeoTIFF = require("../../tools/node_modules/geotiff");
const M = require(process.env.MODELJS || "../../src/core/model.js"), S = require("../../src/io/swmm.js"), F = require("../../src/engine/flood2d.js");
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../../vendor/crs_catalog.json")));
const res = []; const ok = (name, pass, info) => { res.push({ name, pass: !!pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + "  " + info); };
const ex = (d, f) => path.join(__dirname, "../../examples", d, f);
const ab = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
const geo = (d, f) => JSON.parse(fs.readFileSync(ex(d, f)));
async function expectError(name, fn, re) { try { await fn(); ok(name, false, "no error"); } catch (e) { ok(name, re.test(e.message), "error: " + e.message); } }

(async () => {
  const B = {};
  for (const d of ["synthetic_us", "synthetic_si"]) {
    const si = d.endsWith("si"), ref = JSON.parse(fs.readFileSync(ex(d, "grid_reference.json")));
    const dem = await M.readDEM(ab(ex(d, "dem.tif")), GeoTIFF, catalog);
    ok(`[${d}] DEM georeference and units`, dem.nx === 400 && dem.ny === 267 && dem.epsg === (si ? 26917 : 2236) && Math.abs(dem.hUnitFt - (si ? 3.280839895 : 1.0000020000)) < 1e-6 && Math.abs(dem.res - ref.res) < 1e-9,
      `${dem.nx} x ${dem.ny}, res ${dem.res}, EPSG ${dem.epsg} (${dem.crsName}), unit ${dem.hUnitFt.toFixed(7)} ft`);
    for (const f of [1, 2]) {
      const R = ref.factors[f], vft = si ? 1 / 0.3048 : 1;
      const b = M.buildGrid(dem, { cellSize: dem.res * f, hUnitFt: dem.hUnitFt, vUnitFt: vft, buildings: geo(d, "buildings.geojson").features, boundaries: [{ key: "POND", feature: geo(d, "pond.geojson").features[0] }] });
      if (f === 2) B[d] = { dem, b };
      const bl = []; for (let k = 0; k < b.g.N; k++) if (b.type[k] === 1 && !b.noData[k]) bl.push(k);
      const pc = []; for (let k = 0; k < b.g.N; k++) if (b.type[k] === 2) pc.push(k);
      // buildings overlapping the pond would differ; the synthetic layout has none
      const zs = [[10, 10], [Math.floor(R.ny / 2), Math.floor(R.nx / 2)], [R.ny - 5, R.nx - 5]].map(([r, c]) => b.z[r * R.nx + c] / vft);
      const zerr = Math.max(...zs.map((v, i) => Math.abs(v - R.zsample[i]) / Math.max(1, Math.abs(R.zsample[i]))));
      ok(`[${d}] factor ${f}: grid size, NoData and block means equal rasterio`, b.g.nx === R.nx && b.g.ny === R.ny && b.info.nodataCells === R.nodata && zerr < 1e-6, `${b.g.nx} x ${b.g.ny}, NoData ${b.info.nodataCells} (ref ${R.nodata}), sample relative error ${zerr.toExponential(2)}`);
      // cells whose centre lies exactly on a footprint edge are ties; GDAL and this code may break them differently
      const onEdge = (k) => { const r = (k / b.G.nx) | 0, c = k % b.G.nx, x = b.G.x0 + (c + 0.5) * b.G.cs, y = b.G.y1 - (r + 0.5) * b.G.cs;
        return geo(d, "buildings.geojson").features.some((ft) => M.featureRings(ft).some((ring) => ring.some((p, i) => { const q = ring[(i + 1) % ring.length];
          return (Math.abs(p[1] - q[1]) < 1e-9 && Math.abs(y - p[1]) < 1e-6 && x >= Math.min(p[0], q[0]) - 1e-6 && x <= Math.max(p[0], q[0]) + 1e-6) || (Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(x - p[0]) < 1e-6 && y >= Math.min(p[1], q[1]) - 1e-6 && y <= Math.max(p[1], q[1]) + 1e-6); }))); };
      const A = new Set(bl), Rf = new Set(R.bldCells), diff = [...bl.filter((k) => !Rf.has(k)), ...R.bldCells.filter((k) => !A.has(k))];
      ok(`[${d}] factor ${f}: building cells equal rasterio (cell-centre rule)`, diff.every(onEdge), `${bl.length} cells (ref ${R.bldCells.length}); ${diff.length} differ, all with the cell centre exactly on a footprint edge: ${diff.every(onEdge)}`);
      ok(`[${d}] factor ${f}: boundary cells equal rasterio`, pc.join() === R.pondCells.join(), `${pc.length} cells (ref ${R.pondCells.length})`);
      ok(`[${d}] factor ${f}: roof rain conserved`, Math.abs(b.g.multSum - (b.g.openCells + bl.length)) < 1e-6, `rain area ${b.g.multSum} cells = ${b.g.openCells} open + ${bl.length} roofs`);
      ok(`[${d}] factor ${f}: cell size in feet`, Math.abs(b.G.dxFt - 6 * f) < 1e-4, `${b.G.dxFt.toFixed(6)} ft`);
    }
  }
  // US and SI examples are the same place: same ground in feet
  {
    const a = B.synthetic_us.b, s = B.synthetic_si.b; let w = 0; for (let k = 0; k < a.g.N; k++) if (!a.noData[k]) w = Math.max(w, Math.abs(a.z[k] - s.z[k]));
    ok("US and SI DEMs give the same ground in feet", w < 1e-3, `max difference ${w.toExponential(2)} ft`);
  }
  // SWMM coupling
  const C = {};
  for (const d of ["synthetic_us", "synthetic_si"]) {
    const { b } = B[d], model = S.parseInp(fs.readFileSync(ex(d, "model.inp"), "utf8")), out = S.readOut(fs.readFileSync(ex(d, "model.out")));
    const c = M.coupleSwmm(b, model, out, { boundaries: [{ key: "POND", node: "POND" }], useRainOnGrid: true, gauge: "RG1" });
    C[d] = { c, model, out, b };
    const flooding = c.nodeMap.filter((n) => n.peakFloodCfs > 0).map((n) => n.name);
    ok(`[${d}] every flooding node becomes a point inflow on an open cell`, c.sources.length === flooding.length && c.sources.every((s) => b.type[s.cell] === 0), `${c.sources.length} inflows: ${c.sources.map((s) => s.name).join(", ")}; warnings: ${c.warnings.join(" | ") || "none"}`);
    // volume: integrate sourceAt over the run in 1-minute pieces = trapezoid integral of the series from a zero start
    let v = 0; for (let t = 0; t < c.t1; t += 1 / 60) v += c.sourceAt(t, Math.min(t + 1 / 60, c.t1)).reduce((a, q) => a + q, 0) * 60;
    let vt = 0; for (const s of c.sources) { const ser = out.getNodeSeries(s.name, "flooding"); let prev = 0; for (const q of ser) { vt += 0.5 * (prev + q) * out.reportStepSec; prev = q; } }
    vt *= c.flowFactor;
    ok(`[${d}] inflow volume equals the trapezoid integral of the SWMM flooding series`, Math.abs(v - vt) / vt < 1e-5, `${v.toFixed(1)} cf vs ${vt.toFixed(1)} cf`);
    C[d].vol = v;
    const h = out.getNodeSeries("POND", "head"); const st = c.stageAt(out.times.length ? (out.times[10].getTime() - model.start.getTime()) / 3600000 : 0)[0];
    ok(`[${d}] pond level follows the SWMM head (in ft)`, Math.abs(st - h[10] * c.lengthFactor) < 1e-4, `${st.toFixed(4)} ft at report 11; SWMM ${(h[10] * c.lengthFactor).toFixed(4)} ft`);
    ok(`[${d}] rain from the gauge`, c.rain && Math.abs(c.rain.totalIn - 3.5) < 1e-3 && c.rain.stepSec === 300, `${c.rain.totalIn.toFixed(4)} in at ${c.rain.stepSec} s`);
  }
  ok("US and SI models give the same inflow volume (cf)", Math.abs(C.synthetic_us.vol - C.synthetic_si.vol) / C.synthetic_us.vol < 0.01, `${C.synthetic_us.vol.toFixed(0)} vs ${C.synthetic_si.vol.toFixed(0)} cf`);
  // a short coupled run conserves the inflow volume
  {
    const { c, b } = C.synthetic_us;
    const r = await F.simulate(b.g, new F.CpuSolver(b.g), { t0: 0.5, t1: 0.75, rainAt: () => 0, stageAt: c.stageAt, sources: c.sources, sourceAt: c.sourceAt, readSec: 900 });
    const L = r.ledger; ok("coupled CPU run closes the water balance", Math.abs(L.err) / L.inflow < 1e-4 && L.inflow > 1000, `inflow ${L.inflow.toFixed(0)} cf, to boundary ${L.toLakes.toFixed(0)} cf, edges ${L.edge.toFixed(0)} cf, closure ${L.err.toFixed(2)} cf`);
  }
  // closed edges with rain: the rain ledger counts only cells that receive rain, so the balance closes
  {
    const { dem } = B.synthetic_us, b = M.buildGrid(dem, { cellSize: 12, hUnitFt: dem.hUnitFt, vUnitFt: 1, closedEdges: true, imperv: 1 });
    const r = await F.simulate(b.g, new F.CpuSolver(b.g), { t0: 0, t1: 0.5, rainAt: () => 3, stageAt: () => [], readSec: 1800 });
    ok("closed edges with rain: water balance closes and nothing leaves at the edges", Math.abs(r.ledger.err) / r.ledger.rain < 1e-5 && r.ledger.edge === 0, `closure ${r.ledger.err.toFixed(2)} cf of ${r.ledger.rain.toFixed(0)} cf rain; edge ${r.ledger.edge}`);
  }
  // GeoTIFF out: read back with geotiff.js
  {
    const { b } = B.synthetic_us; const zt = Float32Array.from(b.z, (v, k) => (b.noData[k] ? NaN : v));
    const buf = M.geoTiff(b.G, 2236, [{ name: "ground_ft", data: zt }, { name: "twice", data: zt.map((v) => 2 * v) }], "us-ft");
    fs.writeFileSync(path.join(require("os").tmpdir(), "fsim_test_out.tif"), Buffer.from(buf));
    const t = await GeoTIFF.fromArrayBuffer(buf), im = await t.getImage(), r = await im.readRasters();
    let w = 0; for (let k = 0; k < b.g.N; k++) if (!b.noData[k]) w = Math.max(w, Math.abs(r[0][k] - zt[k]), Math.abs(r[1][k] - 2 * zt[k]));
    const o = im.getOrigin(), rs = im.getResolution();
    ok("GeoTIFF export reads back", w === 0 && o[0] === b.G.x0 && o[1] === b.G.y1 && rs[0] === b.G.cs && im.getGeoKeys().ProjectedCSTypeGeoKey === 2236 && r[0][0] === -9999, `max difference ${w}, origin ${o}, res ${rs[0]}, NoData ${r[0][0]}`);
  }
  // refusals
  const { dem } = B.synthetic_us;
  await expectError("refuses a cell size that is not a multiple of the DEM", () => M.buildGrid(dem, { cellSize: 7, hUnitFt: 1, vUnitFt: 1 }), /whole multiple/);
  await expectError("refuses unknown units", () => M.buildGrid(dem, { cellSize: 6, hUnitFt: NaN, vUnitFt: 1 }), /units must be known/);
  await expectError("refuses a grid that is too small", () => M.buildGrid(dem, { cellSize: 600, hUnitFt: 1, vUnitFt: 1 }), /only/);
  await expectError("refuses a .out from a different model", () => { const m = S.parseInp(fs.readFileSync(ex("synthetic_us", "model.inp"), "utf8")); m.nodes.push({ name: "EXTRA", x: 0, y: 0 }); M.coupleSwmm(B.synthetic_us.b, m, S.readOut(fs.readFileSync(ex("synthetic_us", "model.out")))); }, /does not match/);
  await expectError("refuses a .inp/.out unit mismatch", () => M.coupleSwmm(B.synthetic_us.b, S.parseInp(fs.readFileSync(ex("synthetic_us", "model.inp"), "utf8")), S.readOut(fs.readFileSync(ex("synthetic_si", "model.out")))), /different runs/);
  await expectError("refuses a boundary node without results", () => M.coupleSwmm(B.synthetic_us.b, S.parseInp(fs.readFileSync(ex("synthetic_us", "model.inp"), "utf8")), null, { boundaries: [{ key: "P", node: "POND" }] }), /needs the SWMM .out/);
  const bad = res.filter((r) => !r.pass).length; console.log(bad ? `${bad} FAILED` : "ALL PASS"); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
