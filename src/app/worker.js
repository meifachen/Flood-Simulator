/* Flood Simulator worker. Built with geotiff.js, proj4, flood2d.js, swmm.js and model.js prepended.
 * Messages in: {id, cmd: "load" | "build" | "run" | "stop", args}. Out: {id, ok, res} | {id, error} | {id, progress} | {id, frame}.
 */
"use strict";
const Model = self.FloodModel;
let LCR = null, SOIL = null, INLETS = null;   // INLETS: [{x, y, node, lw, area, cw, co, rimFt}] in the DEM CRS   // land cover raster; soils: {kind: "raster", R} or {kind: "polygons", feats}
let CAT = null, DEM = null, SRC = {}, MODEL = null, INP = null, OUT = null, B = null, BLD = [], BOUND = [], STOP = false;
const post = (m, tr) => self.postMessage(m, tr || []);

// --------------------------------------------------------------- GeoJSON CRS handling
/* the CRS of a GeoJSON: an EPSG code from its "crs" member, "lonlat" for CRS84/4326 or when every coordinate looks like degrees, else "same" */
function geojsonCrs(gj) {
  const n = gj && gj.crs && gj.crs.properties && gj.crs.properties.name;
  if (n) { if (/CRS84|4326/.test(n)) return "lonlat"; const m = /EPSG:{1,2}(\d+)/.exec(n); if (m) return Number(m[1]); }
  let deg = true, any = false;
  for (const f of gj.features || []) for (const ring of Model.featureRings(f)) for (const p of ring) { any = true; if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) { deg = false; break; } }
  return any && deg ? "lonlat" : "same";
}
function toDemCrs(gj, what) {
  const c = geojsonCrs(gj); if (c === "same" || c === DEM.epsg) return { feats: gj.features || [], note: c === "same" ? "assumed to be in the DEM's CRS" : `EPSG ${c} (same as the DEM)` };
  if (!DEM.proj4) throw new Error(`${what} are in ${c === "lonlat" ? "longitude/latitude" : "EPSG " + c} but the DEM's CRS is unknown, so they cannot be reprojected`);
  let from = "EPSG:4326";
  if (c !== "lonlat") { const e = Model.lookupCrs(CAT, c); if (!e) throw new Error(`${what}: EPSG ${c} is not in the projection list`); from = e.proj4; }
  const P = proj4(from, DEM.proj4);
  const tr = (coords) => coords.map((ring) => ring.map((p) => P.forward([p[0], p[1]])));
  const feats = (gj.features || []).map((f) => {
    const g = f.geometry; if (!g) return f;
    const ng = g.type === "Polygon" ? { type: "Polygon", coordinates: tr(g.coordinates) } : g.type === "MultiPolygon" ? { type: "MultiPolygon", coordinates: g.coordinates.map(tr) } : g;
    return { type: "Feature", properties: f.properties || {}, geometry: ng };
  });
  return { feats, note: `reprojected from ${c === "lonlat" ? "longitude/latitude" : "EPSG " + c}` };
}
function parseJson(text, what) { try { const j = JSON.parse(text); if (!j || !Array.isArray(j.features)) throw new Error("no features"); return j; } catch (e) { throw new Error(`${what}: not a GeoJSON FeatureCollection (${e.message})`); } }

// --------------------------------------------------------------- commands
async function load(a) {
  if (a.catalog) CAT = a.catalog;
  const res = {};
  if (a.dem) {
    DEM = await Model.readDEM(a.dem, GeoTIFF, CAT);
    if (a.epsg) { const e = Model.lookupCrs(CAT, a.epsg); if (!e) throw new Error(`EPSG ${a.epsg} is not in the projection list`); Object.assign(DEM, { epsg: e.epsg, crsName: e.name, proj4: e.proj4, hUnitFt: Model.proj4UnitFt(e.proj4) }); }
    B = null;
  }
  if (!DEM) throw new Error("Load a DEM first");
  if (a.epsg && !a.dem) { const e = Model.lookupCrs(CAT, a.epsg); if (!e) throw new Error(`EPSG ${a.epsg} is not in the projection list`); Object.assign(DEM, { epsg: e.epsg, crsName: e.name, proj4: e.proj4, hUnitFt: Model.proj4UnitFt(e.proj4) }); }
  const z = DEM.data; let zmin = Infinity, zmax = -Infinity; for (const v of z) if (v === v) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
  res.dem = { nx: DEM.nx, ny: DEM.ny, res: DEM.res, x0: DEM.x0, y1: DEM.y1, bounds: DEM.bounds, epsg: DEM.epsg, crsName: DEM.crsName, proj4: DEM.proj4, hUnitFt: DEM.hUnitFt, vUnitHint: DEM.vUnitHint, zmin, zmax, valid: DEM.valid };
  if ("buildings" in a) { BLD = []; if (a.buildings) { const r = toDemCrs(parseJson(a.buildings, "Buildings"), "Buildings"); BLD = r.feats.filter((f) => f.geometry && /Polygon/.test(f.geometry.type)); res.buildings = { count: BLD.length, note: r.note, feats: BLD }; } else res.buildings = { count: 0 }; }
  if ("boundaries" in a) { BOUND = []; if (a.boundaries) { const r = toDemCrs(parseJson(a.boundaries, "Level boundaries"), "Level boundaries"); BOUND = r.feats.filter((f) => f.geometry && /Polygon/.test(f.geometry.type)); res.boundaries = { count: BOUND.length, note: r.note, props: BOUND.map((f) => f.properties || {}), feats: BOUND }; } else res.boundaries = { count: 0 }; }
  if ("landcover" in a) {
    LCR = a.landcover ? await Model.readRaster(a.landcover, GeoTIFF, CAT, "Land cover") : null;
    if (LCR) { const cnt = {}; let nd = 0; for (const v of LCR.data) { if (v === v) cnt[v] = (cnt[v] || 0) + 1; else nd++; } const codes = Object.keys(cnt);
      if (codes.length > 64) throw new Error(`Land cover has ${codes.length} distinct values; it should be a class map (for example NLCD codes)`);
      res.landcover = { nx: LCR.nx, ny: LCR.ny, res: LCR.rx, epsg: LCR.epsg, crsName: LCR.crsName, classes: codes.map(Number).sort((x, y) => x - y), counts: cnt, sameCrs: !LCR.proj4 || LCR.epsg === DEM.epsg }; }
    else res.landcover = null;
  }
  if ("soils" in a) {
    SOIL = null; res.soils = null;
    if (a.soils && typeof a.soils === "string") { const r = toDemCrs(parseJson(a.soils, "Soils"), "Soils"); SOIL = { kind: "polygons", feats: r.feats }; const g = {}; let dual = 0; for (const f of r.feats) { const p = f.properties || {}, v = p.hsg ?? p.HSG ?? p.hydgrp ?? p.HYDGRP ?? p.hydgrpdcd, c = Model.hsgCode(v); if (c && /\//.test(String(v))) dual++; g[c ? "ABCD"[c - 1] : "?"] = (g[c ? "ABCD"[c - 1] : "?"] || 0) + 1; } res.soils = { kind: "polygons", count: r.feats.length, note: r.note + (dual ? `; ${dual} dual-group polygon${dual > 1 ? "s" : ""} (e.g. B/D) treated as D` : ""), groups: g }; }
    else if (a.soils) { const R = await Model.readRaster(a.soils, GeoTIFF, CAT, "Soils"); SOIL = { kind: "raster", R }; res.soils = { kind: "raster", nx: R.nx, ny: R.ny, epsg: R.epsg }; }
  }
  if ("inlets" in a) {
    INLETS = null; res.inlets = null;
    if (a.inlets) {
      const gj = parseJson(a.inlets, "Inlets"), c = geojsonCrs(gj); let fwd = null;
      if (c !== "same" && c !== DEM.epsg) { if (!DEM.proj4) throw new Error("Inlets need reprojecting but the DEM's CRS is unknown"); const from = c === "lonlat" ? "EPSG:4326" : (Model.lookupCrs(CAT, c) || {}).proj4; if (!from) throw new Error(`Inlets: EPSG ${c} is not in the projection list`); fwd = proj4(from, DEM.proj4); }
      const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v)); const bad = [];
      INLETS = (gj.features || []).filter((f) => f.geometry && f.geometry.type === "Point").map((f, i) => {
        const p = f.properties || {}, xy = fwd ? fwd.forward(f.geometry.coordinates.slice(0, 2)) : f.geometry.coordinates;
        if (!p.node) bad.push(i + 1);
        return { x: xy[0], y: xy[1], node: p.node ? String(p.node) : "", lw: num(p.weir_length_ft), area: num(p.orifice_area_sqft), cw: num(p.cw), co: num(p.co), rimFt: num(p.rim_ft) };
      });
      if (bad.length) throw new Error(`Inlets ${bad.slice(0, 5).join(", ")} have no "node" property (the SWMM junction they drain to)`);
      res.inlets = { count: INLETS.length, nodes: [...new Set(INLETS.map((i) => i.node))], pts: INLETS.map((i) => [i.x, i.y, i.node]), reprojected: !!fwd };
    }
  }
  if ("inp" in a) { MODEL = a.inp ? SWMM.parseInp(a.inp) : null; INP = a.inp || null; }
  if ("out" in a) { OUT = a.out ? SWMM.readOut(a.out) : null; }
  if (MODEL) {
    const qf = OUT ? SWMM.CFS_PER_UNIT[OUT.flowUnits] : 1, Lf = MODEL.unitSystem === "SI" ? 1 / 0.3048 : 1;
    if (OUT && OUT.unitSystem !== MODEL.unitSystem) throw new Error(`The .inp is in ${MODEL.unitSystem} units but the .out is in ${OUT.unitSystem} units; load files from the same run`);
    if (OUT) { const miss = MODEL.nodes.filter((n) => OUT.nodeNames.indexOf(n.name) < 0); if (miss.length) throw new Error(`The .out file is not from this .inp: nodes ${miss.slice(0, 5).map((n) => n.name).join(", ")} are missing`); }
    const t0 = MODEL.start ? MODEL.start.getTime() : 0, b = DEM.bounds;
    const nodes = MODEL.nodes.map((n) => {
      const r = { name: n.name, type: n.type, x: n.x, y: n.y, invertFt: n.invert * Lf, rimFt: (n.invert + (n.maxDepth || 0)) * Lf, inside: Number.isFinite(n.x) && n.x >= b[0] && n.x <= b[2] && n.y >= b[1] && n.y <= b[3] };
      if (OUT) { const f = OUT.getNodeSeries(n.name, "flooding"), h = OUT.getNodeSeries(n.name, "head"); let pk = 0, vol = 0, prev = 0; for (const q of f) { pk = Math.max(pk, q); vol += 0.5 * (prev + q) * OUT.reportStepSec; prev = q; } r.peakCfs = pk * qf; r.floodCf = vol * qf; r.flood = Array.from(f, (v) => v * qf); r.head = Array.from(h, (v) => v * Lf); }
      return r;
    });
    const links = MODEL.links.map((l) => ({ name: l.name, type: l.type, from: l.from, to: l.to, verts: MODEL.vertices[l.name] || [] }));
    res.swmm = { title: MODEL.title, flowUnits: MODEL.flowUnits, unitSystem: MODEL.unitSystem, start: MODEL.start && MODEL.start.toISOString(), end: MODEL.end && MODEL.end.toISOString(),
      hours: MODEL.end && MODEL.start ? (MODEL.end - MODEL.start) / 3600000 : null, gauges: MODEL.gauges.map((g) => ({ name: g.name, source: g.source, interval: g.interval })),
      nodes, links, warnings: MODEL.warnings, hasOut: !!OUT,
      out: OUT ? { nPeriods: OUT.nPeriods, stepSec: OUT.reportStepSec, t0Hours: (OUT.start.getTime() - t0) / 3600000, flowUnits: OUT.flowUnits } : null };
    res.swmm.rain = MODEL.gauges.map((g) => { try { const r = SWMM.gaugeRain(MODEL, g.name); return { name: g.name, stepSec: r.stepSec, values: r.values, totalIn: r.totalIn }; } catch (e) { return { name: g.name, error: e.message }; } });
  } else res.swmm = null;
  return res;
}

function build(o) {
  if (!DEM) throw new Error("Load a DEM first");
  const bspec = (o.boundaries || []).map((b) => ({ key: b.key, feature: BOUND[b.index] }));
  // land cover and soils sampled at the cell centres (reprojected when their CRS differs from the DEM's)
  const G0 = { x0: DEM.x0, y1: DEM.y1, cs: o.cellSize, nx: Math.floor(DEM.nx / Math.round(o.cellSize / DEM.res)), ny: Math.floor(DEM.ny / Math.round(o.cellSize / DEM.res)) };
  const projTo = (R) => { if (!R.proj4 || !DEM.proj4 || R.epsg === DEM.epsg) return null; const P = proj4(DEM.proj4, R.proj4); return (xy) => P.forward(xy); };
  const extra = [];
  let lcClass = null, hsg = null;
  if (LCR && o.useLandcover !== false) { if (!LCR.proj4 && LCR.epsg !== DEM.epsg) extra.push("Land cover has no known CRS; it is taken to be in the DEM's CRS"); lcClass = Model.sampleRaster(LCR, G0, projTo(LCR)); }
  if (SOIL && o.useSoils !== false) {
    if (SOIL.kind === "polygons") { const r = Model.rasterizeHsg(SOIL.feats, G0); hsg = r.hsg; if (r.unknown) extra.push(`${r.unknown} soil polygons have no recognizable hydrologic soil group and are ignored`); }
    else { const v = Model.sampleRaster(SOIL.R, G0, projTo(SOIL.R)); hsg = new Uint8Array(v.length); for (let k = 0; k < v.length; k++) hsg[k] = v[k] >= 1 && v[k] <= 4 ? Math.round(v[k]) : 0; }
  }
  B = Model.buildGrid(DEM, { lcClass, lcTable: o.lcTable, hsg, soilTable: o.soilTable, cellSize: o.cellSize, hUnitFt: DEM.hUnitFt || o.hUnitFt, vUnitFt: o.vUnitFt, buildings: o.useBuildings ? BLD : [], boundaries: bspec,
    imperv: o.imperv, nImp: o.nImp, nPerv: o.nPerv, ksInHr: o.ksInHr, suctionIn: o.suctionIn, imd: o.imd, roofToGround: o.roofToGround, closedEdges: o.closedEdges });
  // cells beside each building (open cells next to its wall cells) for the "buildings reached" count
  const nb = B.g.bldStart.length - 1, nx = B.G.nx, ny = B.G.ny, ring = [], start = new Int32Array(nb + 1);
  for (let i = 0; i < nb; i++) {
    start[i] = ring.length; const seen = new Set();
    for (let j = B.g.bldStart[i]; j < B.g.bldStart[i + 1]; j++) { const k = B.g.bldCells[j], r = (k / nx) | 0, c = k % nx;
      for (const q of [c > 0 ? k - 1 : -1, c < nx - 1 ? k + 1 : -1, r > 0 ? k - nx : -1, r < ny - 1 ? k + nx : -1]) if (q >= 0 && B.type[q] === 0 && !seen.has(q)) { seen.add(q); ring.push(q); } }
  }
  start[nb] = ring.length; B.ring = Int32Array.from(ring); B.ringStart = start;
  const z = B.z.slice(), type = B.type.slice();
  return { __transfer: [z.buffer, type.buffer], res: { G: B.G, z, type, info: B.info, warnings: extra.concat(B.warnings) } };
}

// depth quantization for frames: q = round(255 * sqrt(h / 25)); fine near 0 (0.0004 ft), 0.08 ft at 5 ft
const QS = 25, enc = (h) => (h <= 0 ? 0 : Math.min(255, Math.round(255 * Math.sqrt(h / QS))));
async function run(o, id) {
  if (!B) throw new Error("Build the grid first");
  STOP = false;
  const g = B.g, N = g.N, A = g.dx * g.dx, thr = o.wetFt ?? 0.1, bthr = o.buildingFt ?? 0.5;
  let cpl = { sources: [], sourceAt: null, stageAt: () => [], rain: null, t1: o.t1 }, two = null;
  const bspec = (o.boundaries || []).map((b) => ({ key: b.key, node: b.node || null, level: b.level }));
  if (o.coupling === "two") {
    // two-way: SWMM runs here in step with the 2D; boundary levels from SWMM nodes are the live heads
    if (!MODEL || !INP) throw new Error("Two-way coupling needs the SWMM .inp");
    if (o.t0 > (MODEL.end && MODEL.start ? (MODEL.end - MODEL.start) / 3600000 : Infinity)) throw new Error("The start is after the end of the SWMM run");
    post({ id, progress: { phase: "note", text: "Starting SWMM 5.2.4 (WebAssembly) for two-way coupling" } });
    two = await Couple2.makeCoupler(B, createSWMM, INP, MODEL, { cw: o.cw, lw: o.lw, co: o.co, area: o.inletArea, searchFt: o.searchFt ?? 30, inlets: INLETS || [], defaultInlets: o.defaultInlets !== false });
    cpl.sources = two.sources; cpl.sourceAt = two.sourceAt; cpl.warnings = two.warnings; cpl.nodeMap = two.nodeMap;
    for (const b of bspec) if (!b.node && !Number.isFinite(b.level)) throw new Error(`Level boundary ${b.key} needs a level or a SWMM node`);
    cpl.stageAt = () => bspec.map((b) => (b.node ? two.headFt(b.node) : b.level));
    if (o.rainSource === "gauge") cpl.rain = SWMM.gaugeRain(MODEL, o.gauge);
  } else if (MODEL && (o.useSwmmFlooding || bspec.some((b) => b.node) || o.rainSource === "gauge")) {
    cpl = Model.coupleSwmm(B, MODEL, OUT, { searchFt: o.searchFt ?? 30, boundaries: bspec, useRainOnGrid: o.rainSource === "gauge", gauge: o.gauge });
    if (!o.useSwmmFlooding) { cpl.sources = []; }
  } else if (bspec.length) {
    for (const b of bspec) if (!Number.isFinite(b.level)) throw new Error(`Level boundary ${b.key} needs a level (or a SWMM node with results)`);
    cpl.stageAt = () => bspec.map((b) => b.level);
  }
  let rainAt = () => 0, rainStep = 3600;
  if (o.rainSource === "gauge") { const r = cpl.rain; rainStep = r.stepSec; rainAt = (i) => (i >= 0 && i < r.values.length ? r.values[i] : 0); }
  else if (o.rainSource === "uniform") { const ih = o.rainInHr, dur = o.rainHours; if (!(ih >= 0) || !(dur > 0)) throw new Error("Uniform rain needs an intensity and a duration"); rainStep = 300; rainAt = (i) => (i * 300 < dur * 3600 ? ih : 0); }
  const sources = cpl.sources;
  const fr0 = { sources: (two ? two.nodes : sources).map((s) => ({ name: s.name, cell: s.cell })), warnings: cpl.warnings || [], nodeMap: cpl.nodeMap || [] };
  post({ id, progress: { phase: "start", ...fr0 } });
  let solver;
  const want = o.engine || "auto";
  const chunkSec = two ? (o.couplingSec || 30) : 60;
  if (want !== "cpu") {
    try { solver = await new Flood2D.GpuSolver(g).init(); }
    catch (e) { if (want === "gpu") throw e; solver = null; post({ id, progress: { phase: "note", text: `GPU not used (${e.message}); running on the CPU` } }); }
  }
  if (!solver) solver = new Flood2D.CpuSolver(g);
  const hmax = new Float32Array(N), tmax = new Float32Array(N).fill(NaN);
  const nb = B.ringStart.length - 1, bMax = new Float32Array(nb);
  const t0w = Date.now(), simLen = (o.t1 - o.t0) * 3600;
  const isOpen = (k) => (g.aux[4 * k + 2] & 3) === 0;
  const r = await Flood2D.simulate(g, solver, {
    t0: o.t0, t1: o.t1, rainAt, rainStep, stageAt: cpl.stageAt, sources, sourceAt: cpl.sourceAt || (() => []), cfl: o.cfl ?? 0.7, readSec: o.outputSec, chunkSec,
    shouldStop: () => STOP,
    onRead: async (fr) => {
      const st = fr.st, q = new Uint8Array(N); let wet = 0, vol = 0, dmax = 0, bNow = 0;
      for (let k = 0; k < N; k++) {
        const h = st[4 * k]; q[k] = enc(h);
        if (isOpen(k)) { if (h > thr) wet++; vol += h; if (h > dmax) dmax = h; if (st[4 * k + 2] > hmax[k]) { hmax[k] = st[4 * k + 2]; tmax[k] = st[4 * k + 3]; } }
      }
      for (let i = 0; i < nb; i++) { let d = 0; for (let j = B.ringStart[i]; j < B.ringStart[i + 1]; j++) d = Math.max(d, st[4 * B.ring[j]]); if (d > bMax[i]) bMax[i] = d; if (d > bthr) bNow++; }
      const rates = sources.length ? (two ? two.rates() : cpl.sourceAt(fr.tHours, fr.tHours)) : [];
      const qin = rates.reduce((s, v) => s + v, 0);
      const stages = cpl.stageAt(fr.tHours);
      const sum = { tHours: fr.tHours, wetAc: wet * A / 43560, volCf: vol * A, depthMax: dmax, buildings: bNow, inflowCfs: qin, rates: Array.from(rates), stages, ledger: fr.ledger };
      post({ id, frame: { q: q.buffer, sum } }, [q.buffer]);
      const done = (fr.tHours - o.t0) * 3600, wall = (Date.now() - t0w) / 1000;
      post({ id, progress: { phase: "run", tHours: fr.tHours, frac: done / simLen, wall, speed: done / Math.max(wall, 1e-3), steps: fr.steps, dt: fr.dtLast, closurePct: fr.ledger.errPct, kind: solver.kind } });
    }
  });
  if (solver.destroy) solver.destroy();
  let swmm2 = null;
  if (two) {   // finish SWMM to the end of its run so that its report and output are complete
    two.engine.advance(1e12, []); const fin = two.finish();
    swmm2 = { tally: two.tally, massBalance: fin.massBalance, rpt: fin.rpt, out: fin.out ? fin.out.buffer : null, nodeMap: two.nodeMap, notes: two.engine.notes, inlets: two.inlets };
  }
  for (let k = 0; k < N; k++) if (!(hmax[k] > 0)) tmax[k] = NaN;
  const bReached = bMax.reduce((s, v) => s + (v > bthr ? 1 : 0), 0);
  const vmax = r.vmax || new Float32Array(N), dvmax = r.dvmax || new Float32Array(N);
  for (let k = 0; k < N; k++) if (!isOpen(k)) { vmax[k] = 0; dvmax[k] = 0; }
  return { __transfer: [hmax.buffer, tmax.buffer, bMax.buffer, vmax.buffer, dvmax.buffer], res: { hmax, tmax, bMax, bReached, vmax, dvmax, ledger: r.ledger, steps: r.steps, stopped: r.stopped, kind: solver.kind, wall: (Date.now() - t0w) / 1000, QS, swmm2 } };
}

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  if (cmd === "stop") { STOP = true; return; }
  try {
    const out = cmd === "load" ? await load(args) : cmd === "build" ? build(args) : cmd === "run" ? await run(args, id) : null;
    if (out && out.__transfer) post({ id, ok: true, res: out.res }, out.__transfer); else post({ id, ok: true, res: out });
  } catch (err) { post({ id, error: err.message || String(err) }); }
};
