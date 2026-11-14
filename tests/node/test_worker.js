// The app's worker (src/app/worker.js) driven directly in node: refused files, new sites, inlet files, end of a two-way run.
// node tests/node/test_worker.js   (exit 1 on failure)
const fs = require("fs"), path = require("path"), vm = require("vm");
const GeoTIFF = require("../../tools/node_modules/geotiff"), proj4 = require("../../vendor/proj4/proj4.js");
const Model = require("../../src/core/model.js"), Flood2D = require("../../src/engine/flood2d.js"), SWMM = require("../../src/io/swmm.js");
const Couple2 = require("../../src/core/couple2way.js"), createSWMM = require("../../vendor/swmm-wasm/swmm5.js");
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../../vendor/crs_catalog.json")));
const res = []; const ok = (name, pass, info) => { res.push({ name, pass: !!pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + "  " + info); };
const ex = (d, f) => path.join(__dirname, "../../examples", d, f);
const ab = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };

// a fresh worker: worker.js evaluated with the globals the build puts in front of it
function newWorker() {
  const posted = [], self = { FloodModel: Model, postMessage: (m) => posted.push(m) };
  const ctx = vm.createContext({ self, GeoTIFF, proj4, Flood2D, SWMM, Couple2, createSWMM, console, Date, Math });
  vm.runInContext(fs.readFileSync(path.join(__dirname, process.env.WORKERJS || "../../src/app/worker.js"), "utf8"), ctx);
  return { load: (a) => ctx.load(a), build: (o) => ctx.build(o).res, run: async (o) => (await ctx.run(o, 1)).res, peek: (expr) => vm.runInContext(expr, ctx), posted };
}
const refused = async (p) => { try { await p; return ""; } catch (e) { return e.message; } };
const text = (d, f) => fs.readFileSync(ex(d, f), "utf8");

(async () => {
  const US = "synthetic_us", dem = await Model.readDEM(ab(ex(US, "dem.tif")), GeoTIFF, catalog);
  // land cover rasters on the US DEM's footprint (EPSG 2236): forest everywhere, 100 distinct values, and one placed far away
  const G = { x0: dem.x0, y1: dem.y1, cs: dem.res * 4, nx: Math.floor(dem.nx / 4), ny: Math.floor(dem.ny / 4) }, M = G.nx * G.ny;
  const forest = Model.geoTiff(G, 2236, [{ name: "lc", data: new Float32Array(M).fill(41) }], "us-ft");
  const many = Model.geoTiff(G, 2236, [{ name: "lc", data: Float32Array.from({ length: M }, (_, k) => k % 100) }], "us-ft");
  const far = Model.geoTiff(Object.assign({}, G, { x0: G.x0 + 1e6 }), 2236, [{ name: "lc", data: new Float32Array(M).fill(41) }], "us-ft");
  const soil7 = Model.geoTiff(G, 2236, [{ name: "hsg", data: Float32Array.from({ length: M }, (_, k) => ((k / G.nx) | 0) < G.ny / 2 ? 4 : 7) }], "us-ft");
  const lcTable = { 41: { n: 0.36, imp: 0 } }, bopt = { cellSize: 12, hUnitFt: dem.hUnitFt, vUnitFt: 1, lcTable, soilTable: Model.HSG };

  // W1 a refused land cover file leaves the accepted one in use
  {
    const w = newWorker(); await w.load({ catalog, dem: ab(ex(US, "dem.tif")) });
    await w.load({ landcover: forest }); const good = w.build(bopt).info.landcoverCells;
    const msg = await refused(w.load({ landcover: many })), after = w.build(bopt);
    ok("W1 a refused land cover file leaves the accepted one in use", /100 distinct values/.test(msg) && good > 0 && after.info.landcoverCells === good && !after.warnings.some((x) => /not in the table/.test(x)),
      `refused: "${msg.slice(0, 50)}"; land cover cells ${good} before, ${after.info.landcoverCells} after`);
  }
  // W2 a refused inlets file leaves the accepted inlets in place
  {
    const w = newWorker(); await w.load({ catalog, dem: ab(ex(US, "dem.tif")), inp: text(US, "model.inp") });
    await w.load({ inlets: text(US, "inlets.geojson") }); const n0 = w.peek("INLETS.length");
    const bad = JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { node: "J3", weir_length_ft: 20 }, geometry: { type: "Point", coordinates: [500750, 1599200] } }, { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [500760, 1599200] } }] });
    const msg = await refused(w.load({ inlets: bad }));
    ok("W2 a refused inlets file leaves the accepted inlets in place", /inlet 2: no "node" property/.test(msg) && n0 === 14 && w.peek("INLETS.length") === 14 && w.peek("INLETS.every((i) => i.lw !== 20)"), `refused: "${msg}"; inlets ${n0} before, ${w.peek("INLETS.length")} after`);
  }
  // W3 RFC 7946 GeoJSON (no crs member, longitude/latitude) points are reprojected; W8 load-time checks on inlet values
  {
    const w = newWorker(); await w.load({ catalog, dem: ab(ex(US, "dem.tif")), inp: text(US, "model.inp") });
    const P = proj4(dem.proj4, "EPSG:4326"), ll = P.forward([500750, 1599200]);
    const r = await w.load({ inlets: JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { node: "J3" }, geometry: { type: "Point", coordinates: ll } }] }) });
    const it = w.peek("INLETS[0]");
    ok("W3 longitude/latitude inlets without a crs member are reprojected to the DEM's CRS", r.inlets.reprojected && Math.abs(it.x - 500750) < 0.01 && Math.abs(it.y - 1599200) < 0.01, `${ll.map((v) => v.toFixed(6))} -> ${it.x.toFixed(3)}, ${it.y.toFixed(3)}`);
    const fc = (feats) => JSON.stringify({ type: "FeatureCollection", features: feats }), pt = (props, xy = [500750, 1599200]) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: xy } });
    const msgs = [await refused(w.load({ inlets: fc([pt({ node: "J3", weir_length_ft: "3 ft" })]) })), await refused(w.load({ inlets: fc([pt({ node: "J3", co: 0 })]) })), await refused(w.load({ inlets: fc([pt({ node: "J3", rim_ft: "high" })]) })),
      await refused(w.load({ inlets: fc([{ type: "Feature", properties: { node: "J1" }, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }, pt({ node: "J3" }), pt({}) ]) }))];
    ok("W8 text, zero and missing inlet values are refused at load, numbered as in the file", /inlet 1: weir_length_ft "3 ft"/.test(msgs[0]) && /inlet 1: co 0/.test(msgs[1]) && /inlet 1: rim_ft "high"/.test(msgs[2]) && /inlet 3: no "node"/.test(msgs[3]), msgs.join(" | "));
    const r2 = await w.load({ inlets: fc([pt({ node: 7, weir_length_ft: "4" }), { type: "Feature", properties: { node: "J4" }, geometry: { type: "MultiPoint", coordinates: [[500000, 1599000], [500010, 1599000]] } }]) });
    ok("W8 a numeric node name, a numeric string size and MultiPoint inlets are read", r2.inlets.count === 3 && w.peek("INLETS[0].node") === "7" && w.peek("INLETS[0].lw") === 4, `${r2.inlets.count} inlets; node ${w.peek("INLETS[0].node")}, weir ${w.peek("INLETS[0].lw")}`);
    // W10 inlet types: the HEC-22 sizes and clogging are read; a bad type, clog or depression is refused at load
    await w.load({ inlets: fc([pt({ node: "J3", type: "CURB_INLET", inlet_type: "Combination", perimeter_ft: 6, open_area_sqft: "2.5", curb_length_ft: 5, curb_height_ft: 0.5, depression_width_ft: 2, clog: 0.5 })]) });
    const t = w.peek("INLETS[0]");
    const m10 = [await refused(w.load({ inlets: fc([pt({ node: "J3", inlet_type: "slot" })]) })), await refused(w.load({ inlets: fc([pt({ node: "J3", clog: 1 })]) })), await refused(w.load({ inlets: fc([pt({ node: "J3", depression_width_ft: -2 })]) }))];
    ok("W10 inlet_type, grate and curb sizes and clogging are read from the inlets file (an inventory type field is ignored); bad values are refused", t.type === "combination" && t.lw === 6 && t.area === 2.5 && t.curbLength === 5 && t.curbHeight === 0.5 && t.depressionWidth === 2 && t.clog === 0.5 &&
      /inlet 1: inlet_type "slot"/.test(m10[0]) && /inlet 1: clog 1 /.test(m10[1]) && /inlet 1: depression_width_ft -2/.test(m10[2]), `${JSON.stringify(t)} | ${m10.join(" | ")}`);
  }
  // W5 a new DEM is a new site; W4 land cover that misses the grid is reported; W6 soil raster codes outside 1-4; W7 cell size check
  {
    const w = newWorker(); await w.load({ catalog, dem: ab(ex(US, "dem.tif")), inp: text(US, "model.inp") });
    await w.load({ landcover: forest, soils: soil7, inlets: text(US, "inlets.geojson"), buildings: text(US, "buildings.geojson") });
    const s7 = w.build(bopt);
    ok("W6 soil raster codes other than 1-4 are counted and reported", s7.info.soilCells > 0 && s7.info.soilCells < s7.info.cells && s7.warnings.some((x) => /soil codes other than 1-4/.test(x)), s7.warnings.filter((x) => /soil|cover/.test(x)).join(" | "));
    const m7 = await refused(Promise.resolve().then(() => w.build(Object.assign({}, bopt, { cellSize: 2 }))));
    ok("W7 a cell size below the DEM resolution is refused with the cell size message (land cover loaded)", /Cell size 2 must be a whole multiple of the DEM resolution 6/.test(m7), m7);
    const r = await w.load({ dem: ab(ex(US, "dem.tif")) }), b = w.build(bopt);
    ok("W5 a new DEM clears the land cover, soils, inlets and buildings of the previous site", r.cleared && b.info.landcoverCells === 0 && b.info.soilCells === 0 && b.info.wallCells === 0 && w.peek("INLETS") === null, `land cover ${b.info.landcoverCells}, soils ${b.info.soilCells}, building cells ${b.info.wallCells}, inlets ${w.peek("INLETS")}`);
    await w.load({ landcover: far }); const f = w.build(bopt);
    ok("W4 land cover that misses the grid is reported", f.info.landcoverCells === 0 && f.warnings.some((x) => /Land cover does not cover any cell/.test(x)), f.warnings.join(" | "));
  }
  // W9 a two-way run that ends before SWMM does: SWMM's report holds only the water the inlets took
  {
    const w = newWorker(); await w.load({ catalog, dem: ab(ex(US, "dem.tif")), inp: text(US, "model.inp"), inlets: text(US, "inlets.geojson") });
    w.build(Object.assign({}, bopt, { lcTable: null }));
    const r = await w.run({ coupling: "two", t0: 1, t1: 1.25, engine: "cpu", rainSource: "none", outputSec: 900, couplingSec: 30 });
    const sent = r.swmm2.tally.sentToSwmm, m = /Flow Routing Continuity[\s\S]*?External Inflow \.+\s+([\d.]+)/.exec(r.swmm2.rpt), ext = m ? Number(m[1]) * 43560 : NaN;
    ok("W9 after a two-way run ends, SWMM's external inflow equals what the inlets took", sent > 1000 && Math.abs(ext - sent) / sent < 0.01, `inlets took ${sent.toFixed(0)} cf; SWMM report external inflow ${ext.toFixed(0)} cf`);
  }
  // W11 inlets with only an inventory type field are reported; INLET_TYPE in capitals is read; both size names at once are refused
  {
    const w = newWorker(); await w.load({ catalog, dem: ab(ex(US, "dem.tif")), inp: text(US, "model.inp") });
    const fc = (feats) => JSON.stringify({ type: "FeatureCollection", features: feats }), pt = (props) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [500750, 1599200] } });
    const r1 = await w.load({ inlets: fc([pt({ node: "J3", type: "CURB_INLET" }), pt({ node: "J4", type: "GRATE_INLET" }), pt({ node: "J4", type: "GRATE_INLET" })]) });
    const t1 = w.peek("INLETS.map((i) => i.type || 'generic').join()");
    await w.load({ inlets: fc([pt({ node: "J3", INLET_TYPE: "Grate", perimeter_ft: 6, open_area_sqft: 2 })]) }); const t2 = w.peek("INLETS[0].type");
    const m3 = await refused(w.load({ inlets: fc([pt({ node: "J3", perimeter_ft: 6, weir_length_ft: 20 })]) })), m4 = await refused(w.load({ inlets: fc([pt({ node: "J3", clog: "50%" })]) }));
    ok("W11 inlets typed only by an inventory field are loaded, counted and reported as generic", /3 inlets have a type field \(CURB_INLET 1, GRATE_INLET 2\) but no inlet_type/.test(r1.inlets.typeNote || "") && t1 === "generic,generic,generic", `${r1.inlets.typeNote}; types ${t1}`);
    ok("W11 INLET_TYPE in capitals is read; both size names at once and a clog of \"50%\" are refused with one message each", t2 === "grate" && /give perimeter_ft or weir_length_ft, not both/.test(m3) && (m4.match(/clog/g) || []).length === 1, `${t2} | ${m3} | ${m4}`);
  }
  // W12 routed lakes: boundaries that differ from the grid's are refused; routed with a SWMM node is refused; a one-way run warns that outfalls are not passed
  {
    const w = newWorker(); await w.load({ catalog, dem: ab(ex(US, "dem.tif")), boundaries: text(US, "pond.geojson"), inp: text(US, "model.inp"), out: ab(ex(US, "model.out")) });
    const bnd = [{ index: 0, key: "POND", level: 58, routed: true }];
    w.build(Object.assign({}, bopt, { lcTable: null, boundaries: bnd }));
    const base = { coupling: "one", useSwmmFlooding: true, t0: 1, t1: 1.05, engine: "cpu", rainSource: "none", outputSec: 900 };
    const mA = await refused(w.run(Object.assign({}, base, { boundaries: [{ index: 0, key: "OTHER", level: 58, routed: true }] })));
    const mB = await refused(w.run(Object.assign({}, base, { boundaries: [{ index: 0, key: "POND", level: 58, routed: true, node: "POND" }] })));
    const mC = await refused(w.run(Object.assign({}, base, { boundaries: [{ index: 0, key: "POND", level: 58, routed: true, areaAc: "5 ac" }] })));
    w.posted.length = 0; const r = await w.run(Object.assign({}, base, { boundaries: bnd }));
    const warn = JSON.stringify(w.posted.filter((m) => m.progress && m.progress.warnings).map((m) => m.progress.warnings));
    ok("W12 boundaries other than the grid's, routed with a SWMM node and a text area are refused; a one-way routed run warns about outfalls", /not the ones the grid was built with/.test(mA) && /cannot also take its level from SWMM node POND/.test(mB) && /area "5 ac" \(acres\) is not a positive number/.test(mC) && /get no water from SWMM outfalls in a one-way run/.test(warn) && r.lakes,
      [mA, mB, mC, warn.slice(0, 160)].join(" | "));
  }
  // W13 inlet properties in any letter case; a name given twice is refused; the inventory count is of inlets, not features
  {
    const w = newWorker(); await w.load({ catalog, dem: ab(ex(US, "dem.tif")), inp: text(US, "model.inp") });
    const fc = (feats) => JSON.stringify({ type: "FeatureCollection", features: feats }), pt = (props) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [500750, 1599200] } });
    const m1 = await refused(w.load({ inlets: fc([pt({ NODE: "J3", INLET_TYPE: "grate", PERIMETER_FT: 6, OPEN_AREA_SQFT: 2, CLOG: 0.5, RIM_FT: 60 })]) })), t = m1 ? { m1 } : w.peek("INLETS[0]");
    const m2 = await refused(w.load({ inlets: fc([pt({ node: "J3", inlet_type: "grate", INLET_TYPE: "curb" })]) }));
    const r3 = await w.load({ inlets: fc([{ type: "Feature", properties: { node: "J4", type: "GRATE_INLET" }, geometry: { type: "MultiPoint", coordinates: [[500000, 1599000], [500010, 1599000]] } }]) });
    ok("W13 upper-case sizes, clogging and rim are read; inlet_type in two cases is refused; a MultiPoint's inlets are each counted in the type note", t.node === "J3" && t.type === "grate" && t.lw === 6 && t.area === 2 && t.clog === 0.5 && t.rimFt === 60 &&
      /inlet 1: inlet_type is given twice \(inlet_type and INLET_TYPE\)/.test(m2) && /^2 inlets have a type field \(GRATE_INLET 2\)/.test(r3.inlets.typeNote), `${JSON.stringify(t)} | ${m2} | ${r3.inlets.typeNote}`);
  }
  // W14 a new boundaries (or other grid) layer clears the grid; routed lake areas that are not finite numbers are named as given; node 0 with routed is refused
  {
    const w = newWorker(); await w.load({ catalog, dem: ab(ex(US, "dem.tif")), boundaries: text(US, "pond.geojson"), inp: text(US, "model.inp"), out: ab(ex(US, "model.out")) });
    const bnd = [{ index: 0, key: "POND", level: 58, routed: true }];
    w.build(Object.assign({}, bopt, { lcTable: null, boundaries: bnd }));
    const r = await w.load({ boundaries: text(US, "pond.geojson") }), mA = await refused(w.run({ coupling: "off", t0: 0, t1: 0.05, engine: "cpu", rainSource: "none", outputSec: 900, boundaries: bnd }));
    w.build(Object.assign({}, bopt, { lcTable: null, boundaries: bnd }));
    const base = { coupling: "one", useSwmmFlooding: true, t0: 1, t1: 1.05, engine: "cpu", rainSource: "none", outputSec: 900 };
    const areas = [];
    for (const v of [Infinity, true, "5"]) areas.push(await refused(w.run(Object.assign({}, base, { boundaries: [{ index: 0, key: "POND", level: 58, routed: true, areaAc: v }] }))));
    const m0 = await refused(w.run(Object.assign({}, base, { boundaries: [{ index: 0, key: "POND", level: 58, routed: true, node: 0 }] })));
    ok("W14 new boundaries clear the grid; Infinity, true and \"5\" areas are refused as given; a routed lake with node 0 is refused", r.gridCleared === true && /Build the grid first/.test(mA) &&
      /area Infinity \(acres\)/.test(areas[0]) && /area true \(acres\)/.test(areas[1]) && /area "5" \(acres\)/.test(areas[2]) && /cannot also take its level from SWMM node 0/.test(m0), [r.gridCleared, mA, ...areas, m0].join(" | "));
  }
  // W15 a refused call undoes all its layers; the DEM's CRS cannot be changed under reprojected layers; unread fields named like built-in
  // object properties or repeated in two cases are ignored; soils fields in capitals are read; each grid layer (and the CRS) clears the grid
  {
    const w = newWorker(); await w.load({ catalog, dem: ab(ex(US, "dem.tif")), inp: text(US, "model.inp") });
    const fc = (feats) => JSON.stringify({ type: "FeatureCollection", features: feats }), pt = (props, xy = [500750, 1599200]) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: xy } });
    w.build(Object.assign({}, bopt, { lcTable: null }));
    const mA = await refused(w.load({ buildings: text(US, "buildings.geojson"), landcover: many }));
    const after = { bld: w.peek("BLD.length"), grid: w.peek("B !== null") };
    const ll = proj4(dem.proj4, "EPSG:4326").forward([500750, 1599200]);
    await w.load({ inlets: fc([pt({ node: "J3" }, ll)]) }); const x0 = w.peek("INLETS[0].x");
    const mB = await refused(w.load({ epsg: 26917 })), x1 = w.peek("INLETS[0].x");
    const mC = await refused(w.load({ inlets: fc([pt({ node: "J3", constructor: "x", __proto__x: 1, ID: 1, id: 2 })]) }));
    const sq = (x, y, d) => [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]];
    const rs = await w.load({ soils: JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { HYDGRPDCD: "D" }, geometry: { type: "Polygon", coordinates: sq(500700, 1599150, 100) } }] }) });
    const cleared = [];
    for (const l of [{ buildings: text(US, "buildings.geojson") }, { landcover: forest }, { soils: null }, { epsg: dem.epsg }]) { w.build(Object.assign({}, bopt, { lcTable: null })); cleared.push(!!(await w.load(l)).gridCleared && w.peek("B === null")); }
    ok("W15 a refused call undoes all its layers; a CRS change under reprojected inlets is refused; unread repeated or built-in-named fields are ignored; capital soils fields are read; buildings, land cover, soils and the CRS clear the grid",
      /100 distinct values/.test(mA) && after.bld === 0 && after.grid && /already in EPSG 2236/.test(mB) && x1 === x0 && mC === "" && rs.soils.groups.D === 1 && cleared.every(Boolean),
      `${mA.slice(0, 40)} -> buildings ${after.bld}, grid kept ${after.grid} | ${mB.slice(0, 60)} | "${mC}" | soils ${JSON.stringify(rs.soils.groups)} | cleared ${cleared.join()}`);
  }
  // W16 a routed lake's stage-area table and outlet weir are read from its boundary feature (any letter case); the outlet's water is reported;
  // a bad table, an outlet without a crest and an outlet into a SWMM node in a one-way run are refused
  {
    const pondWith = (props) => { const gj = JSON.parse(text(US, "pond.geojson")); gj.features[0].properties = Object.assign({}, gj.features[0].properties, props); return JSON.stringify(gj); };
    const w = newWorker(); await w.load({ catalog, dem: ab(ex(US, "dem.tif")), inp: text(US, "model.inp"), out: ab(ex(US, "model.out")) });
    const bnd = [{ index: 0, key: "POND", level: 58, routed: true }], base = { coupling: "off", t0: 0, t1: 0.5, engine: "cpu", rainSource: "none", outputSec: 900, boundaries: bnd };
    const runWith = async (props) => { await w.load({ boundaries: pondWith(props) }); w.build(Object.assign({}, bopt, { lcTable: null, boundaries: bnd })); w.posted.length = 0; return w.run(base); };
    const r = await runWith({ STAGE_AREA: "50: 1.0; 60: 2.0", Outlet_Crest_Ft: 57, outlet_length_ft: 5 });
    const warn = JSON.stringify(w.posted.filter((m) => m.progress && m.progress.warnings).map((m) => m.progress.warnings));
    // storage by hand from the table (area 1 ac at 50 ft, 2 ac at 60 ft, linear): V(h) = 43,560 (h - 50) (1 + 0.05 (h - 50)) cf
    const lk = r.lakes, V = (h) => 43560 * (h - 50) * (1 + 0.05 * (h - 50)), lost = V(58) - V(lk.end[0]), budget = lk.outlet[0] - lk.from2d[0] - lk.rain[0];
    const m = [await refused(runWith({ stage_area: "50:1" })), await refused(runWith({ stage_area: "60:2; 50:1" })), await refused(runWith({ outlet_length_ft: 5 })), await refused(runWith({ outlet_crest_ft: 57, outlet_length_ft: 5, outlet_node: "J4" }))];
    ok("W16 a stage-area table and an outlet weir are read from the lake's feature; storage lost (by hand from the table) = outlet + water to the 2D; bad tables, a crestless outlet and an outlet into SWMM in a run without two-way coupling are refused",
      lk.areaFrom[0] === "stage-area table" && lk.outlet[0] > 100 && Math.abs(lost - budget) < 1e-6 * lost && lk.end[0] < 58 && lk.end[0] > 57 && /discharge out of the model/.test(warn) &&
      /stage_area "50:1" is not two or more/.test(m[0]) && /stages must rise \(60 then 50\)/.test(m[1]) && /needs outlet_crest_ft and outlet_length_ft/.test(m[2]) && /need two-way coupling/.test(m[3]),
      `end ${lk.end[0].toFixed(3)} ft; storage lost ${lost.toFixed(1)} cf = outlet ${lk.outlet[0].toFixed(1)} + to the 2D ${(-lk.from2d[0]).toFixed(1)} cf | ${m.join(" | ")}`);
  }
  // W17 (new in 0.6.0, E-06) the other outlet kinds are read from the lake's feature the same way: a pipe (an orifice at its invert)
  // and a rating curve both release water that is reported, neither draws the lake below its control elevation, and bad kinds,
  // a pipeless diameter and falling rating flows are refused
  {
    const pondWith = (props) => { const gj = JSON.parse(text(US, "pond.geojson")); gj.features[0].properties = Object.assign({}, gj.features[0].properties, props); return JSON.stringify(gj); };
    const w = newWorker(); await w.load({ catalog, dem: ab(ex(US, "dem.tif")), inp: text(US, "model.inp"), out: ab(ex(US, "model.out")) });
    const bnd = [{ index: 0, key: "POND", level: 58, routed: true }], base = { coupling: "off", t0: 0, t1: 0.5, engine: "cpu", rainSource: "none", outputSec: 900, boundaries: bnd };
    const runWith = async (props) => { await w.load({ boundaries: pondWith(props) }); w.build(Object.assign({}, bopt, { lcTable: null, boundaries: bnd })); w.posted.length = 0; return w.run(base); };
    const V = (h) => 43560 * (h - 50) * (1 + 0.05 * (h - 50));   // the W16 stage-area table's storage, by hand
    const pipe = await runWith({ STAGE_AREA: "50: 1.0; 60: 2.0", Outlet_Type: "PIPE", Outlet_Crest_Ft: 57, Outlet_Diameter_Ft: 2 });
    const rat = await runWith({ STAGE_AREA: "50: 1.0; 60: 2.0", outlet_type: "rating", outlet_rating: "50:0; 55:5; 60:20" });
    const lostP = V(58) - V(pipe.lakes.end[0]), lostR = V(58) - V(rat.lakes.end[0]);
    const m = [await refused(runWith({ outlet_type: "flap", outlet_crest_ft: 57 })), await refused(runWith({ outlet_type: "pipe", outlet_crest_ft: 57 })), await refused(runWith({ outlet_type: "rating", outlet_rating: "50:10; 60:5" })), await refused(runWith({ outlet_type: "gate", outlet_crest_ft: 57, outlet_width_ft: 4 }))];
    ok("W17 pipe and rating outlets are read from the lake's feature, release reported water and stop at their control elevation; bad kinds are refused",
      pipe.lakes.outlet[0] > 100 && pipe.lakes.end[0] < 58 && pipe.lakes.end[0] >= 57 && Math.abs(lostP - (pipe.lakes.outlet[0] - pipe.lakes.from2d[0])) < 1e-6 * lostP &&
      rat.lakes.outlet[0] > 100 && rat.lakes.end[0] < 58 && rat.lakes.end[0] >= 55 && Math.abs(lostR - (rat.lakes.outlet[0] - rat.lakes.from2d[0])) < 1e-6 * lostR &&
      /outlet_type "flap" is not one of/.test(m[0]) && /outlet_diameter_ft undefined is not a positive number/.test(m[1]) && /outlet_rating flows must not fall \(10 then 5 cfs\)/.test(m[2]) && /outlet_opening_ft undefined is not a positive number/.test(m[3]),
      `pipe: end ${pipe.lakes.end[0].toFixed(3)} ft, outlet ${pipe.lakes.outlet[0].toFixed(0)} cf; rating: end ${rat.lakes.end[0].toFixed(3)} ft, outlet ${rat.lakes.outlet[0].toFixed(0)} cf | ${m.join(" | ")}`);
  }
  // W18 (new in 0.6.0, E-07) on-grade inlet properties are read from the inlets file; an on-grade inlet missing a slope
  // is refused when the two-way coupler is built, naming the inlet and the missing property
  {
    const w = newWorker(); await w.load({ catalog, dem: ab(ex(US, "dem.tif")), inp: text(US, "model.inp") });
    const fc = (props) => JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [500750, 1599200] } }] });
    await w.load({ inlets: fc({ node: "J3", inlet_type: "curb", curb_length_ft: 10, curb_height_ft: 0.5, on_grade: true, cross_slope: 0.02, long_slope: 0.01 }) });
    const it = w.peek("INLETS[0]");
    await w.load({ inlets: fc({ node: "J3", inlet_type: "curb", curb_length_ft: 10, curb_height_ft: 0.5, on_grade: true, cross_slope: 0.02 }) });
    w.build(Object.assign({}, bopt, { lcTable: null }));
    const msg = await refused(w.run({ coupling: "two", t0: 1, t1: 1.05, engine: "cpu", rainSource: "none", outputSec: 900, couplingSec: 30 }));
    ok("W18 on-grade inlet properties are read from the inlets file; a missing slope is refused when the coupler is built",
      it.onGrade === true && it.crossSlope === 0.02 && it.longSlope === 0.01 && /Inlet 1 \(J3\): an on-grade inlet needs its street's longitudinal slope \(long_slope\)/.test(msg),
      `parsed onGrade ${it.onGrade}, cross ${it.crossSlope}, long ${it.longSlope}; refused: "${msg.slice(0, 110)}"`);
  }
  const bad = res.filter((r) => !r.pass).length; console.log(bad ? `${bad} FAILED` : "ALL PASS"); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
