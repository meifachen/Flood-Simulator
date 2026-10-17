// Land cover and soils: sampling, per-cell parameters and their effect on a run: node tests/node/test_landcover.js   (exit 1 on failure)
const fs = require("fs"), path = require("path");
const GeoTIFF = require("../../tools/node_modules/geotiff"), proj4 = require("../../vendor/proj4/proj4.js");
const M = require(process.env.MODELJS || "../../src/core/model.js"), F = require("../../src/engine/flood2d.js");
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../../vendor/crs_catalog.json")));
const res = []; const ok = (name, pass, info) => { res.push({ name, pass: !!pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + "  " + info); };
const ex = (d, f) => path.join(__dirname, "../../examples", d, f);
const ab = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };

(async () => {
  for (const d of ["synthetic_us", "synthetic_si"]) {
    const ref = JSON.parse(fs.readFileSync(ex(d, "landcover_reference.json")));
    const dem = await M.readDEM(ab(ex(d, "dem.tif")), GeoTIFF, catalog);
    const R = await M.readRaster(ab(ex(d, "landcover.tif")), GeoTIFF, catalog, "Land cover");
    const G = { x0: dem.x0, y1: dem.y1, cs: dem.res * 2, nx: Math.floor(dem.nx / 2), ny: Math.floor(dem.ny / 2) };
    const P = proj4(dem.proj4, R.proj4), cls = M.sampleRaster(R, G, (xy) => P.forward(xy));
    let same = 0; for (let k = 0; k < cls.length; k++) if ((cls[k] === cls[k] ? cls[k] : -1) === ref.landcover[k]) same++;
    ok(`[${d}] land cover sampled at cell centres (reprojected from EPSG ${R.epsg}) equals pyproj/rasterio`, R.epsg === 5070 && same / cls.length > 0.999, `${same} of ${cls.length} cells agree (${(100 * same / cls.length).toFixed(3)}%)`);
    const soils = JSON.parse(fs.readFileSync(ex(d, "soils.geojson"))), hs = M.rasterizeHsg(soils.features, G);
    let sameS = 0; for (let k = 0; k < hs.hsg.length; k++) if (hs.hsg[k] === ref.hsg[k]) sameS++;
    ok(`[${d}] soil groups rasterized at cell centres equal rasterio (B/D taken as D)`, sameS === hs.hsg.length && hs.unknown === 0, `${sameS} of ${hs.hsg.length} cells`);
    // the grid takes n, imperviousness and Green-Ampt from the tables
    const table = {}; for (const [c, v] of Object.entries(M.NLCD)) table[c] = { n: v[1], imp: v[2] };
    const B = M.buildGrid(dem, { cellSize: dem.res * 2, hUnitFt: dem.hUnitFt, vUnitFt: d.endsWith("si") ? 1 / 0.3048 : 1, lcClass: cls, lcTable: table, hsg: hs.hsg, soilTable: M.HSG });
    let bad = 0;
    for (let k = 0; k < B.g.N; k++) {
      const c = cls[k], e = table[c], s = M.HSG[hs.hsg[k]];
      if (e && (Math.abs(B.n[k] - e.n) > 1e-6 || Math.abs(B.perv[k] - (1 - e.imp / 100)) > 1e-6)) bad++;
      if (s && Math.abs(B.ksA[k] - s.ks / 43200) > 1e-12) bad++;
    }
    ok(`[${d}] per-cell Manning n, impervious fraction and Ks follow the tables`, bad === 0 && B.info.landcoverCells > 0.99 * B.g.N && B.info.soilCells === B.g.N, `${bad} mismatches; ${B.info.landcoverCells} land cover cells, ${B.info.soilCells} soil cells`);
  }
  // effect on a run: the same rain on group A soils infiltrates more than on group D soils
  {
    const dem = await M.readDEM(ab(ex("synthetic_us", "dem.tif")), GeoTIFF, catalog), N = Math.floor(dem.nx / 2) * Math.floor(dem.ny / 2);
    const run = async (g) => { const B = M.buildGrid(dem, { cellSize: 12, hUnitFt: dem.hUnitFt, vUnitFt: 1, imperv: 0, hsg: new Uint8Array(N).fill(g), soilTable: M.HSG });
      return (await F.simulate(B.g, new F.CpuSolver(B.g), { t0: 0, t1: 1, rainAt: () => 2, stageAt: () => [], readSec: 3600 })).ledger; };
    const A = await run(1), D = await run(4);
    ok("soil group A infiltrates more than group D under the same rain", A.inf > 1.5 * D.inf && Math.abs(A.err) < 1 && Math.abs(D.err) < 1, `infiltration A ${(A.inf / 43560).toFixed(2)} ac-ft, D ${(D.inf / 43560).toFixed(2)} ac-ft of ${(A.rain / 43560).toFixed(2)} ac-ft rain`);
  }
  // refusals and unknown classes
  {
    const dem = await M.readDEM(ab(ex("synthetic_us", "dem.tif")), GeoTIFF, catalog), N = Math.floor(dem.nx / 2) * Math.floor(dem.ny / 2);
    const B = M.buildGrid(dem, { cellSize: 12, hUnitFt: dem.hUnitFt, vUnitFt: 1, lcClass: new Float32Array(N).fill(77), lcTable: {} });
    ok("an unknown land cover class keeps the global values and is reported", B.warnings.some((w) => /classes 77 are not in the table/.test(w)) && B.info.landcoverCells === 0, B.warnings.join(" | "));
    let msg = ""; try { M.buildGrid(dem, { cellSize: 12, hUnitFt: dem.hUnitFt, vUnitFt: 1, lcClass: new Float32Array(N).fill(21), lcTable: { 21: { n: -1, imp: 10 } } }); } catch (e) { msg = e.message; }
    ok("an invalid Manning n in the table is refused", /class 21: Manning n -1/.test(msg), msg);
  }
  const bad = res.filter((r) => !r.pass).length; console.log(bad ? `${bad} FAILED` : "ALL PASS"); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
