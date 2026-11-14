// Land cover and soils: sampling, per-cell parameters and their effect on a run: node tests/node/test_landcover.js   (exit 1 on failure)
const fs = require("fs"), path = require("path");
const GeoTIFF = require("../../tools/node_modules/geotiff"), proj4 = require("../../vendor/proj4/proj4.js");
const M = require(process.env.MODELJS || "../../src/core/model.js"), F = require("../../src/engine/flood2d.js"), createSWMM = require("../../vendor/swmm-wasm/swmm5.js");
// Reference values written out here from their sources, independent of the code under test:
// Manning n: Kalyanapu, Burian & McPherson (2009) Table 2; 11 Chow (1959) natural stream, clean, normal; 82 SWMM manual overland table, cultivated soil, residue < 20%.
// Impervious %: midpoints of the NLCD developed-class ranges.
const NLCD_REF = { 11: [0.035, 100], 21: [0.0404, 10], 22: [0.0678, 35], 23: [0.0678, 65], 24: [0.0404, 90], 31: [0.0113, 0], 41: [0.36, 0], 42: [0.32, 0], 43: [0.40, 0],
  52: [0.40, 0], 71: [0.368, 0], 81: [0.325, 0], 82: [0.06, 0], 90: [0.086, 0], 95: [0.1825, 0] };
// Rawls et al. (1983) table in the SWMM manual, Appendix A: Ks in/hr, suction in, porosity, field capacity, wilting point.
const RAWLS = { 1: [1.18, 2.40, 0.437, 0.105, 0.033], 2: [0.26, 6.69, 0.501, 0.284, 0.135], 3: [0.06, 8.66, 0.398, 0.244, 0.136], 4: [0.04, 8.27, 0.464, 0.310, 0.187] };
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
    let bad = 0, ground = 0, wantLc = 0, wantSoil = 0;
    for (let k = 0; k < B.g.N; k++) {
      if (B.noData[k]) continue; ground++;
      const e = NLCD_REF[ref.landcover[k]], s = RAWLS[ref.hsg[k]];   // expected from the rasterio/pyproj reference and the written-out tables
      if (e) { wantLc++; if (Math.abs(B.n[k] - e[0]) > 1e-6 || Math.abs(B.perv[k] - (1 - e[1] / 100)) > 1e-6) bad++; }
      if (s) { wantSoil++; if (Math.abs(B.ksA[k] - s[0] / 43200) > 1e-12 || Math.abs(B.g.imd[k] - (s[2] - s[3])) > 1e-6) bad++; }
    }
    ok(`[${d}] per-cell Manning n, impervious fraction, Ks and IMD equal the published tables`, bad === 0 && B.info.landcoverCells === wantLc && wantLc > 0.99 * ground && B.info.soilCells === wantSoil && wantSoil === ground,
      `${bad} mismatches; ${B.info.landcoverCells} land cover cells, ${B.info.soilCells} soil cells of ${ground} ground cells`);
  }
  // effect on a run: the same rain on group A soils infiltrates more than on group D soils
  {
    const dem = await M.readDEM(ab(ex("synthetic_us", "dem.tif")), GeoTIFF, catalog), N = Math.floor(dem.nx / 2) * Math.floor(dem.ny / 2);
    const run = async (g) => { const B = M.buildGrid(dem, { cellSize: 12, hUnitFt: dem.hUnitFt, vUnitFt: 1, imperv: 0, hsg: new Uint8Array(N).fill(g), soilTable: M.HSG });
      return (await F.simulate(B.g, new F.CpuSolver(B.g), { t0: 0, t1: 1, rainAt: () => 2, stageAt: () => [], readSec: 3600 })).ledger; };
    const A = await run(1), D = await run(4);
    ok("soil group A infiltrates more than group D under the same rain", A.inf > 1.5 * D.inf && Math.abs(A.errPct) < 1e-3 && Math.abs(D.errPct) < 1e-3, `infiltration A ${(A.inf / 43560).toFixed(2)} ac-ft, D ${(D.inf / 43560).toFixed(2)} ac-ft of ${(A.rain / 43560).toFixed(2)} ac-ft rain`);
    // against EPA SWMM 5.2.4 (WebAssembly build): one 100% pervious subcatchment, Green-Ampt with each group's default values, 2 in/hr for 1 hour
    const swmmInf = async (e) => {
      const inp = `[OPTIONS]\nFLOW_UNITS CFS\nINFILTRATION GREEN_AMPT\nFLOW_ROUTING STEADY\nSTART_DATE 01/01/2020\nSTART_TIME 00:00:00\nEND_DATE 01/01/2020\nEND_TIME 01:00:00\nWET_STEP 00:00:30\nDRY_STEP 00:00:30\nROUTING_STEP 30\nREPORT_STEP 00:15:00\n`
        + `[RAINGAGES]\nG1 INTENSITY 0:05 1.0 TIMESERIES TS\n[TIMESERIES]\n${Array.from({ length: 12 }, (_, i) => `TS 0:${String(5 * i).padStart(2, "0")} 2\n`).join("")}[SUBCATCHMENTS]\nS1 G1 O1 10 0 500 0.5 0\n[SUBAREAS]\nS1 0.01 0.1 0 0 100 OUTLET\n`
        + `[INFILTRATION]\nS1 ${e.suction} ${e.ks} ${e.imd}\n[OUTFALLS]\nO1 0 FREE NO\n`;
      const m = await createSWMM({ print: () => {}, printErr: () => {} }); m.FS.writeFile("/g.inp", inp);
      const err = m.ccall("swmm_run", "number", ["string", "string", "string"], ["/g.inp", "/g.rpt", "/g.out"]), rpt = m.FS.readFile("/g.rpt", { encoding: "utf8" });
      const x = /Runoff Quantity Continuity[\s\S]*?Total Precipitation \.+\s+[\d.]+\s+([\d.]+)[\s\S]*?Infiltration Loss \.+\s+[\d.]+\s+([\d.]+)/.exec(rpt);
      return err === 0 && x ? Number(x[2]) / Number(x[1]) * 2 : NaN;   // inches infiltrated per 2 in of rain
    };
    const sA = await swmmInf(M.HSG[1]), sD = await swmmInf(M.HSG[4]), dA = A.inf / A.rain * 2, dD = D.inf / D.rain * 2;
    ok("Green-Ampt infiltration of groups A and D equals EPA SWMM 5.2.4 within 1%", Math.abs(dA / sA - 1) < 0.01 && Math.abs(dD / sD - 1) < 0.01, `A ${dA.toFixed(3)} in vs SWMM ${sA.toFixed(3)} in; D ${dD.toFixed(3)} in vs SWMM ${sD.toFixed(3)} in`);
    // the default IMD is the drained deficit (porosity - field capacity) and never drier than the wilting point
    const imdOk = [1, 2, 3, 4].every((g) => Math.abs(M.HSG[g].imd - (RAWLS[g][2] - RAWLS[g][3])) < 1e-3 && M.HSG[g].imd <= RAWLS[g][2] - RAWLS[g][4]);
    ok("default IMD of each soil group is porosity - field capacity (Rawls)", imdOk, [1, 2, 3, 4].map((g) => `${M.HSG[g].name} ${M.HSG[g].imd}`).join(", "));
  }
  // refusals and unknown classes
  {
    const dem = await M.readDEM(ab(ex("synthetic_us", "dem.tif")), GeoTIFF, catalog), N = Math.floor(dem.nx / 2) * Math.floor(dem.ny / 2);
    const B = M.buildGrid(dem, { cellSize: 12, hUnitFt: dem.hUnitFt, vUnitFt: 1, lcClass: new Float32Array(N).fill(77), lcTable: {} });
    ok("an unknown land cover class keeps the global values and is reported", B.warnings.some((w) => /classes 77 are not in the table/.test(w)) && B.info.landcoverCells === 0, B.warnings.join(" | "));
    let msg = ""; try { M.buildGrid(dem, { cellSize: 12, hUnitFt: dem.hUnitFt, vUnitFt: 1, lcClass: new Float32Array(N).fill(21), lcTable: { 21: { n: -1, imp: 10 } } }); } catch (e) { msg = e.message; }
    ok("an invalid Manning n in the table is refused", /class 21: Manning n -1/.test(msg), msg);
    const base = { cellSize: 12, hUnitFt: dem.hUnitFt, vUnitFt: 1 }, tryB = (o) => { try { M.buildGrid(dem, Object.assign({}, base, o)); return "accepted"; } catch (e) { return e.message; } };
    const lc21 = new Float32Array(N).fill(21), h1 = new Uint8Array(N).fill(1), soil = (e) => ({ 1: Object.assign({}, M.HSG[1], e) });
    const refusals = [tryB({ lcClass: lc21, lcTable: { 21: { n: Infinity, imp: 10 } } }), tryB({ lcClass: lc21, lcTable: { 21: { n: 0.04, imp: null } } }), tryB({ lcClass: lc21, lcTable: { 21: { n: 0.04, imp: "" } } }),
      tryB({ hsg: h1, soilTable: soil({ ks: Infinity }) }), tryB({ hsg: h1, soilTable: soil({ ks: "" }) }), tryB({ hsg: h1, soilTable: soil({ imd: null }) }), tryB({ hsg: h1, soilTable: soil({ ks: 1e300 }) }),
      tryB({ lcClass: new Float32Array(N / 2).fill(21), lcTable: { 21: { n: 0.04, imp: 10 } } }), tryB({ hsg: new Uint8Array(N * 4).fill(1), soilTable: M.HSG })];
    ok("infinite, blank, oversized and misaligned land cover and soil inputs are refused", refusals.every((m) => m !== "accepted"), refusals.join(" | "));
    // coverage: a layer that misses the grid (all NaN), or covers half of it, is reported
    const none = M.buildGrid(dem, Object.assign({}, base, { lcClass: new Float32Array(N).fill(NaN), lcTable: { 21: { n: 0.04, imp: 10 } } }));
    const half = new Float32Array(N).fill(NaN); half.fill(21, 0, N / 2); const part = M.buildGrid(dem, Object.assign({}, base, { lcClass: half, lcTable: { 21: { n: 0.04, imp: 10 } }, hsg: new Uint8Array(N) }));
    ok("land cover or soils that miss all or part of the grid are reported", none.warnings.some((w) => /Land cover does not cover any cell/.test(w)) && part.warnings.some((w) => /Land cover covers \d+ of \d+ ground cells/.test(w)) && part.warnings.some((w) => /soils layer does not cover any cell/.test(w)),
      none.warnings.concat(part.warnings).filter((w) => /cover/.test(w)).join(" | "));
    // soil groups given without a table use the published defaults; an IMD drier than the wilting point is flagged
    const noTable = M.buildGrid(dem, Object.assign({}, base, { hsg: new Uint8Array(N).fill(4) })), dry = M.buildGrid(dem, Object.assign({}, base, { hsg: new Uint8Array(N).fill(4), soilTable: { 4: Object.assign({}, M.HSG[4], { imd: 0.3 }) } }));
    ok("soil groups without a table use the defaults; an IMD drier than the wilting point is flagged", noTable.info.soilCells > 0 && Math.abs(noTable.ksA[N / 2] - 0.04 / 43200) < 1e-12 && dry.warnings.some((w) => /Soil group D: IMD 0.3 is drier than the wilting point/.test(w)),
      `${noTable.info.soilCells} cells; ${dry.warnings.filter((w) => /IMD/.test(w)).join("")}`);
    // soil group codes: whole numbers 1-4 as numbers or text; fractions and other values are not recognized
    const codes = [1, "1", "4", " b/d ", 2.5, 3.6, 0, 5, "5", "AB", true].map((v) => M.hsgCode(v));
    ok("soil group codes: 1-4 as numbers or text are read; fractions and other values are not", codes.join(",") === "1,1,4,4,0,0,0,0,0,0,0", codes.join(","));
  }
  // rasters: a NoData value stored as rounded text (-3.4e38 stays finite) reads as NoData; cells outside the raster sample as NaN
  {
    const G = { x0: 1000, y1: 2000, cs: 10, nx: 4, ny: 3 }, vals = new Float32Array(12).fill(41); vals[5] = -3.4e38;
    const R = await M.readRaster(M.geoTiff(G, 2236, [{ name: "lc", data: vals }], "us-ft"), GeoTIFF, catalog, "Land cover");
    const wide = M.sampleRaster(R, { x0: 990, y1: 2010, cs: 10, nx: 6, ny: 5 }, null), inside = Array.from(wide).filter((v) => v === 41).length, nan = Array.from(wide).filter((v) => v !== v).length;
    ok("raster NoData stored as a huge number reads as NoData; cells outside the raster are NaN", R.data[5] !== R.data[5] && inside === 11 && nan === 19, `cell 5 ${R.data[5]}; ${inside} cells inside with class 41, ${nan} NaN (1 NoData + 18 outside)`);
  }
  const bad = res.filter((r) => !r.pass).length; console.log(bad ? `${bad} FAILED` : `ALL PASS (${res.length} checks)`); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
