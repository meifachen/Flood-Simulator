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
  // no crs member: RFC 7946 GeoJSON is longitude/latitude; take it as such when every coordinate (of any geometry type) fits in degrees
  let deg = true, any = false;
  const walk = (c) => { if (!deg || !Array.isArray(c)) return; if (typeof c[0] === "number") { any = true; if (!(Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90)) deg = false; } else for (const x of c) walk(x); };
  for (const f of gj.features || []) if (f && f.geometry) walk(f.geometry.coordinates);
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
/* load: one call may carry several layers. If any of them is refused, every layer of the call is undone, so a refused call leaves the
 * worker exactly as it was (the DEM's CRS fields included). */
async function load(a) {
  const saved = { DEM, B, LCR, SOIL, INLETS, BLD, BOUND, MODEL, INP, OUT, CAT }, crs = DEM && { epsg: DEM.epsg, crsName: DEM.crsName, proj4: DEM.proj4, hUnitFt: DEM.hUnitFt };
  try { return await loadAll(a); }
  catch (e) { ({ DEM, B, LCR, SOIL, INLETS, BLD, BOUND, MODEL, INP, OUT, CAT } = saved); if (DEM && crs) Object.assign(DEM, crs); throw e; }
}
async function loadAll(a) {
  if (a.catalog) CAT = a.catalog;
  const res = {};
  const regrid = () => { if (B) { B = null; res.gridCleared = true; } };   // the grid is built from the layers: a new one accepted means building it again
  // Every layer is read and checked into a local first and only replaces the stored one once it is accepted:
  // a refused file leaves the worker exactly as it was.
  if (a.dem) {
    const dem = await Model.readDEM(a.dem, GeoTIFF, CAT);
    if (a.epsg) { const e = Model.lookupCrs(CAT, a.epsg); if (!e) throw new Error(`EPSG ${a.epsg} is not in the projection list`); Object.assign(dem, { epsg: e.epsg, crsName: e.name, proj4: e.proj4, hUnitFt: Model.proj4UnitFt(e.proj4) }); }
    // a new DEM is a new site: nothing loaded for the previous ground carries over
    DEM = dem; B = null; LCR = null; SOIL = null; INLETS = null; BLD = []; BOUND = [];
    res.cleared = true;
  }
  if (!DEM) throw new Error("Load a DEM first");
  // the vector layers already loaded were placed in the DEM's CRS; once it has one, changing it would leave them in the old one
  if (a.epsg && !a.dem && DEM.proj4 && a.epsg !== DEM.epsg && (BLD.length || BOUND.length || INLETS || (SOIL && SOIL.kind === "polygons"))) throw new Error(`The DEM is already in EPSG ${DEM.epsg}, and the buildings, boundaries, inlets or soil polygons loaded were placed in it; load the DEM again to use EPSG ${a.epsg}`);
  if (a.epsg && !a.dem) { const e = Model.lookupCrs(CAT, a.epsg); if (!e) throw new Error(`EPSG ${a.epsg} is not in the projection list`); Object.assign(DEM, { epsg: e.epsg, crsName: e.name, proj4: e.proj4, hUnitFt: Model.proj4UnitFt(e.proj4) }); regrid(); }
  const z = DEM.data; let zmin = Infinity, zmax = -Infinity; for (const v of z) if (v === v) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
  res.dem = { nx: DEM.nx, ny: DEM.ny, res: DEM.res, x0: DEM.x0, y1: DEM.y1, bounds: DEM.bounds, epsg: DEM.epsg, crsName: DEM.crsName, proj4: DEM.proj4, hUnitFt: DEM.hUnitFt, vUnitHint: DEM.vUnitHint, warnings: DEM.warnings || [], zmin, zmax, valid: DEM.valid };
  if ("buildings" in a) { let bld = []; if (a.buildings) { const r = toDemCrs(parseJson(a.buildings, "Buildings"), "Buildings"); bld = r.feats.filter((f) => f.geometry && /Polygon/.test(f.geometry.type));
      // features that are not polygons (lines, points) cannot be footprints: they are counted and said so, not dropped silently (WRK6-11)
      const other = r.feats.length - bld.length; if (!bld.length && other) throw new Error(`Buildings: none of the ${other} features is a polygon (${[...new Set(r.feats.map((f) => (f.geometry ? f.geometry.type : "no geometry")))].join(", ")}); footprints must be polygons`);
      res.buildings = { count: bld.length, note: r.note + (other ? `; ${other} features that are not polygons are left out` : ""), feats: bld }; } else res.buildings = { count: 0 }; BLD = bld; regrid(); }
  if ("boundaries" in a) { let bnd = []; if (a.boundaries) { const r = toDemCrs(parseJson(a.boundaries, "Level boundaries"), "Level boundaries"); bnd = r.feats.filter((f) => f.geometry && /Polygon/.test(f.geometry.type)); res.boundaries = { count: bnd.length, note: r.note, props: bnd.map((f) => f.properties || {}), feats: bnd }; } else res.boundaries = { count: 0 }; BOUND = bnd; regrid(); }
  if ("landcover" in a) {
    const R = a.landcover ? await Model.readRaster(a.landcover, GeoTIFF, CAT, "Land cover") : null;
    if (R) { const cnt = {}; for (const v of R.data) if (v === v) cnt[v] = (cnt[v] || 0) + 1; const codes = Object.keys(cnt);
      if (codes.length > 64) throw new Error(`Land cover has ${codes.length} distinct values; it should be a class map (for example NLCD codes)`);
      res.landcover = { nx: R.nx, ny: R.ny, res: R.rx, epsg: R.epsg, crsName: R.crsName, classes: codes.map(Number).sort((x, y) => x - y), counts: cnt, sameCrs: !R.proj4 || R.epsg === DEM.epsg, crsNote: crsNote(R, "Land cover") }; }
    else res.landcover = null;
    LCR = R; regrid();
  }
  if ("soils" in a) {
    let soil = null; res.soils = null;
    if (a.soils && typeof a.soils === "string") { const r = toDemCrs(parseJson(a.soils, "Soils"), "Soils"); soil = { kind: "polygons", feats: r.feats };
      // a soil-group field given in two letter cases with different values would be resolved by file order (round 4 WRK5-3): refused
      r.feats.forEach((f, i) => { const pr = f.properties || {}, by = {}; for (const k of Object.keys(pr)) { const l = k.toLowerCase(); if (!["hsg", "hydgrp", "hydgrpdcd"].includes(l)) continue; if (l in by && String(by[l][1]) !== String(pr[k])) throw new Error(`Soils: polygon ${i + 1} gives ${l} twice with different values (${by[l][0]} ${JSON.stringify(by[l][1])}, ${k} ${JSON.stringify(pr[k])}); keep one`); by[l] = [k, pr[k]]; } }); const g = {}; let dual = 0; for (const f of r.feats) { const v = Model.hsgValue(f.properties || {}), c = Model.hsgCode(v); if (c && /\//.test(String(v))) dual++; g[c ? "ABCD"[c - 1] : "?"] = (g[c ? "ABCD"[c - 1] : "?"] || 0) + 1; } res.soils = { kind: "polygons", count: r.feats.length, note: r.note + (dual ? `; ${dual} dual-group polygon${dual > 1 ? "s" : ""} (e.g. B/D) treated as D` : ""), groups: g }; }
    else if (a.soils) {
      const R = await Model.readRaster(a.soils, GeoTIFF, CAT, "Soils"), g = {}; let other = 0;
      for (const v of R.data) { if (v !== v) continue; const c = Model.hsgCode(v); if (c) g["ABCD"[c - 1]] = (g["ABCD"[c - 1]] || 0) + 1; else other++; }
      if (!Object.keys(g).length) throw new Error("Soils raster has no cells coded 1-4 (A-D); code the hydrologic soil groups as 1 = A, 2 = B, 3 = C, 4 = D");
      soil = { kind: "raster", R }; res.soils = { kind: "raster", nx: R.nx, ny: R.ny, epsg: R.epsg, groups: g, other, note: (crsNote(R, "Soils") || `EPSG ${R.epsg || "unknown"}`) + (other ? `; ${other} cells have other codes (not 1-4) and use the global values` : "") };
    }
    SOIL = soil; regrid();
  }
  if ("inlets" in a) {
    let list = null; res.inlets = null;
    if (a.inlets) {
      const gj = parseJson(a.inlets, "Inlets"), c = geojsonCrs(gj); let fwd = null;
      if (c !== "same" && c !== DEM.epsg) { if (!DEM.proj4) throw new Error("Inlets need reprojecting but the DEM's CRS is unknown"); const from = c === "lonlat" ? "EPSG:4326" : (Model.lookupCrs(CAT, c) || {}).proj4; if (!from) throw new Error(`Inlets: EPSG ${c} is not in the projection list`); fwd = proj4(from, DEM.proj4); }
      const errs = [], skipped = [], invType = new Map(); list = []; let invTyped = 0;
      const num = (fi, key, v, positive) => {   // a size or level: absent, or a finite number (text such as "3 ft" is refused here, at load)
        if (v === undefined || v === null || v === "") return undefined; const x = typeof v === "number" ? v : Number(String(v).trim());
        if (!Number.isFinite(x) || (positive && !(x > 0))) { errs.push(`inlet ${fi}: ${key} ${JSON.stringify(v)} is not ${positive ? "a positive number" : "a number"}`); return null; }
        return x;
      };
      (gj.features || []).forEach((f, i) => {
        const fi = i + 1, g = f && f.geometry, p0 = (f && f.properties) || {};
        const pts = g && g.type === "Point" ? [g.coordinates] : g && g.type === "MultiPoint" ? g.coordinates : null;
        if (!pts) { skipped.push(fi); return; }
        // property names in any letter case (shapefile fields are often upper case); the same name in two cases is refused
        // (only the names read here are checked for duplicates; other fields are left alone)
        const p = Object.create(null), seen = Object.create(null);
        for (const k of Object.keys(p0)) { const lk = k.toLowerCase(); if (!INLET_KEYS.has(lk)) continue; if (lk in seen) errs.push(`inlet ${fi}: ${lk} is given twice (${seen[lk]} and ${k}); keep one`); else { seen[lk] = k; p[lk] = p0[k]; } }
        const node = p.node === undefined || p.node === null ? "" : String(p.node).trim();
        if (!node) errs.push(`inlet ${fi}: no "node" property (the SWMM junction it drains to)`);
        // inlet_type, not type: GIS inventories often carry their own "type" field (CURB_INLET, MANHOLE ...).
        // Such a field is not read, but the load reports how many inlets have one and no inlet_type.
        const it0 = p.inlet_type;
        const type = it0 === undefined || it0 === null || it0 === "" ? undefined : String(it0).trim().toLowerCase();
        if (type === undefined && p.type !== undefined && p.type !== null && p.type !== "") { invTyped += pts.length; const v = String(p.type); invType.set(v, (invType.get(v) || 0) + pts.length); }
        if (type !== undefined && !["generic", "grate", "curb", "combination"].includes(type)) errs.push(`inlet ${fi}: inlet_type ${JSON.stringify(it0)} is not generic, grate, curb or combination`);
        const both = (k1, k2) => {   // the grate name or the generic one, not both
          const a1 = num(fi, k1, p[k1], true), a2 = num(fi, k2, p[k2], true);
          if (a1 !== undefined && a2 !== undefined) { errs.push(`inlet ${fi}: give ${k1} or ${k2}, not both`); return undefined; }
          return a1 !== undefined ? a1 : a2;
        };
        const clog = num(fi, "clog", p.clog, false); if (typeof clog === "number" && !(clog >= 0 && clog < 1)) errs.push(`inlet ${fi}: clog ${JSON.stringify(p.clog)} is not a fraction from 0 to below 1`);
        const dw = num(fi, "depression_width_ft", p.depression_width_ft, false); if (typeof dw === "number" && !(dw >= 0)) errs.push(`inlet ${fi}: depression_width_ft ${JSON.stringify(p.depression_width_ft)} is negative`);
        const onGrade = p.on_grade === undefined || p.on_grade === null || p.on_grade === "" ? undefined : (p.on_grade === true || p.on_grade === 1 || /^(true|yes|1)$/i.test(String(p.on_grade).trim()));
        if (p.on_grade !== undefined && p.on_grade !== null && p.on_grade !== "" && onGrade === false && !/^(false|no|0)$/i.test(String(p.on_grade).trim())) errs.push(`inlet ${fi}: on_grade ${JSON.stringify(p.on_grade)} is not true or false`);
        const props = { node, type, lw: both("perimeter_ft", "weir_length_ft"), area: both("open_area_sqft", "orifice_area_sqft"), cw: num(fi, "cw", p.cw, true), co: num(fi, "co", p.co, true),
          curbLength: num(fi, "curb_length_ft", p.curb_length_ft, true), curbHeight: num(fi, "curb_height_ft", p.curb_height_ft, true), depressionWidth: dw, clog, rimFt: num(fi, "rim_ft", p.rim_ft, false),
          onGrade, crossSlope: num(fi, "cross_slope", p.cross_slope, true), longSlope: num(fi, "long_slope", p.long_slope, true), gutterN: num(fi, "gutter_n", p.gutter_n, true),
          grateLength: num(fi, "grate_length_ft", p.grate_length_ft, true), grateWidth: num(fi, "grate_width_ft", p.grate_width_ft, true), splashOver: num(fi, "splash_over_ft_s", p.splash_over_ft_s, true), depressionDepth: num(fi, "depression_depth_ft", p.depression_depth_ft, false) };
        for (const k of Object.keys(props)) if (props[k] === undefined || props[k] === null) delete props[k];
        for (const c0 of pts) { const xy = fwd ? fwd.forward([c0[0], c0[1]]) : c0; list.push(Object.assign({ x: xy[0], y: xy[1], feature: fi }, props)); }
      });
      if (errs.length) throw new Error(`Inlets: ${errs.slice(0, 5).join("; ")}${errs.length > 5 ? `; and ${errs.length - 5} more` : ""}`);
      if (!list.length) throw new Error("Inlets: the file has no point features");
      const typeNote = invTyped ? `${invTyped} inlet${invTyped > 1 ? "s have" : " has"} a type field (${[...invType].map(([k, n]) => `${k} ${n}`).join(", ")}) but no inlet_type, so ${invTyped > 1 ? "they are modeled as generic inlets" : "it is modeled as a generic inlet"} with the panel sizes unless sizes are given` : "";
      res.inlets = { typeNote, count: list.length, nodes: [...new Set(list.map((i) => i.node))], pts: list.map((i) => [i.x, i.y, i.node]), reprojected: !!fwd, note: fwd ? `reprojected from ${c === "lonlat" ? "longitude/latitude" : "EPSG " + c}` : "in the DEM's CRS", skipped: skipped.length };
    }
    INLETS = list;
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
      nodes, links, warnings: MODEL.warnings, hasOut: !!OUT, subcatchments: MODEL.subcatchments.length, otherInflows: MODEL.otherInflows || 0,
      subcatchmentGauges: [...new Set(MODEL.subcatchments.map((c) => c.gauge))],
      out: OUT ? { nPeriods: OUT.nPeriods, stepSec: OUT.reportStepSec, t0Hours: (OUT.start.getTime() - t0) / 3600000, flowUnits: OUT.flowUnits } : null };
    res.swmm.rain = MODEL.gauges.map((g) => { try { const r = SWMM.gaugeRain(MODEL, g.name); return { name: g.name, stepSec: r.stepSec, values: r.values, totalIn: r.totalIn }; } catch (e) { return { name: g.name, error: e.message }; } });
  } else res.swmm = null;
  return res;
}

/* a routed lake's storage and outlet from its boundary feature's properties (any letter case):
 *   stage_area: [[stage ft, area ac], ...] or "stage:area; stage:area" (two or more rows, stages rising),
 *   outlet_type: weir (the default), rating, pipe or gate;
 *   weir: outlet_crest_ft, outlet_length_ft, outlet_cw (default 3.0);
 *   rating: outlet_rating as "stage:flow; stage:flow" (ft and cfs) or pairs;
 *   pipe: outlet_crest_ft (its invert), outlet_diameter_ft, outlet_cd (default 0.6);
 *   gate: outlet_crest_ft (its sill), outlet_width_ft, outlet_opening_ft, outlet_cd (default 0.6);
 *   outlet_node: the SWMM node any of them discharges into (two-way runs) */
const LAKE_KEYS = ["stage_area", "outlet_type", "outlet_crest_ft", "outlet_length_ft", "outlet_cw", "outlet_rating", "outlet_diameter_ft", "outlet_width_ft", "outlet_opening_ft", "outlet_cd", "outlet_node"];
/* the lake fields a boundary feature carries, by lower-case name; one given in two letter cases is refused, as for inlets (review 0.6.1
 * WRK6-7, round 4 WRK5-3) */
function lakeFields(name, p0) {
  const p = Object.create(null), seen = Object.create(null);
  for (const k of Object.keys(p0 || {})) { const l = k.toLowerCase(); if (!LAKE_KEYS.includes(l)) continue; if (l in seen) throw new Error(`Level boundary ${name}: ${l} is given twice (${seen[l]} and ${k}); keep one`); seen[l] = k; p[l] = p0[k]; }
  return p;
}
function lakeProps(name, p0) {
  const p = lakeFields(name, p0);
  const has = (v) => v !== undefined && v !== null && v !== "", show = (v) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));
  // decimal numbers only: Number() also reads "0x10" as 16, "0b111001" as 57 and "Infinity" (review 0.6.1 WRK6-7, round 4 WRK5-6)
  const DEC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  const numOf = (v) => (typeof v === "number" ? v : typeof v === "string" && DEC.test(v.trim()) ? Number(v) : NaN);
  const out = {};
  if (has(p.stage_area)) {
    let rows = p.stage_area;
    if (typeof rows === "string") { const t = rows.trim(); try { rows = t.startsWith("[") ? JSON.parse(t) : t.split(/[;\n]+/).filter((x) => x.trim()).map((x) => x.split(/[:,\s]+/).filter(Boolean)); } catch (e) { rows = null; } }
    const ok = Array.isArray(rows) && rows.length >= 2 && rows.every((x) => Array.isArray(x) && x.length === 2 && x.every((v) => Number.isFinite(numOf(v))) && numOf(x[1]) > 0);
    if (!ok) throw new Error(`Routed lake ${name}: stage_area ${show(p.stage_area)} is not two or more pairs of stage (ft) and area (ac), such as "95:12; 100:20"`);
    const tab = rows.map((x) => [numOf(x[0]), numOf(x[1]) * 43560]);
    for (let m = 1; m < tab.length; m++) if (!(tab[m][0] > tab[m - 1][0])) throw new Error(`Routed lake ${name}: stage_area stages must rise (${tab[m - 1][0]} then ${tab[m][0]})`);
    out.stageArea = tab;
  }
  const oc = p.outlet_crest_ft, ol = p.outlet_length_ft, ow = p.outlet_cw, on = p.outlet_node, ot = p.outlet_type, orr = p.outlet_rating,
    od = p.outlet_diameter_ft, ogw = p.outlet_width_ft, ogo = p.outlet_opening_ft, ocd = p.outlet_cd;
  if (has(ot) || has(oc) || has(ol) || has(ow) || has(on) || has(orr) || has(od) || has(ogw) || has(ogo) || has(ocd)) {
    const kind = has(ot) ? String(ot).trim().toLowerCase() : "weir";
    if (!["weir", "rating", "pipe", "gate"].includes(kind)) throw new Error(`Routed lake ${name}: outlet_type ${show(ot)} is not one of weir, rating, pipe, gate`);
    // a field the outlet type does not use is refused, not silently dropped: a rating given without outlet_type rating became a weir,
    // a pipe ignored outlet_length_ft, and outlet_cd alone made no outlet at all (review 0.6.1 WRK6-7)
    const uses = { weir: ["outlet_crest_ft", "outlet_length_ft", "outlet_cw"], rating: ["outlet_rating"], pipe: ["outlet_crest_ft", "outlet_diameter_ft", "outlet_cd"], gate: ["outlet_crest_ft", "outlet_width_ft", "outlet_opening_ft", "outlet_cd"] }[kind];
    const stray = ["outlet_crest_ft", "outlet_length_ft", "outlet_cw", "outlet_rating", "outlet_diameter_ft", "outlet_width_ft", "outlet_opening_ft", "outlet_cd"].filter((k) => has(p[k]) && !uses.includes(k));
    if (stray.length) throw new Error(`Routed lake ${name}: ${stray.join(", ")} ${stray.length > 1 ? "are" : "is"} not used by a ${kind} outlet${has(ot) ? "" : " (outlet_type not given: weir)"}; give the outlet_type that uses ${stray.length > 1 ? "them" : "it"}, or remove ${stray.length > 1 ? "them" : "it"}`);
    const crest = () => { if (!has(oc)) throw new Error(`Routed lake ${name}: a ${kind} outlet needs outlet_crest_ft`); const v = numOf(oc); if (!Number.isFinite(v)) throw new Error(`Routed lake ${name}: outlet_crest_ft ${show(oc)} is not a number`); return v; };
    const posOf = (v, label) => { const x = numOf(v); if (!(x > 0)) throw new Error(`Routed lake ${name}: ${label} ${show(v)} is not a positive number`); return x; };
    const cd = () => (has(ocd) ? posOf(ocd, "outlet_cd") : 0.6);
    if (kind === "weir") {
      if (!has(oc) || !has(ol)) throw new Error(`Routed lake ${name}: an outlet needs outlet_crest_ft and outlet_length_ft`);
      out.outlet = { kind, crestFt: crest(), lengthFt: posOf(ol, "outlet_length_ft"), cw: has(ow) ? posOf(ow, "outlet_cw") : 3.0 };
    } else if (kind === "rating") {
      let rows = orr;
      if (typeof rows === "string") { const t = rows.trim(); try { rows = t.startsWith("[") ? JSON.parse(t) : t.split(/[;\n]+/).filter((x) => x.trim()).map((x) => x.split(/[:,\s]+/).filter(Boolean)); } catch (e) { rows = null; } }
      const ok = Array.isArray(rows) && rows.length >= 2 && rows.every((x) => Array.isArray(x) && x.length === 2 && x.every((v) => Number.isFinite(numOf(v))) && numOf(x[1]) >= 0);
      if (!ok) throw new Error(`Routed lake ${name}: outlet_rating ${show(orr)} is not two or more pairs of stage (ft) and flow (cfs), such as "95:0; 100:25; 105:80"`);
      const tab = rows.map((x) => [numOf(x[0]), numOf(x[1])]);
      for (let m = 1; m < tab.length; m++) { if (!(tab[m][0] > tab[m - 1][0])) throw new Error(`Routed lake ${name}: outlet_rating stages must rise (${tab[m - 1][0]} then ${tab[m][0]})`); if (tab[m][1] < tab[m - 1][1]) throw new Error(`Routed lake ${name}: outlet_rating flows must not fall (${tab[m - 1][1]} then ${tab[m][1]} cfs)`); }
      out.outlet = { kind, rating: tab };
    } else if (kind === "pipe") {
      out.outlet = { kind, crestFt: crest(), diameterFt: posOf(od, "outlet_diameter_ft"), cd: cd() };
    } else {
      out.outlet = { kind, crestFt: crest(), widthFt: posOf(ogw, "outlet_width_ft"), openingFt: posOf(ogo, "outlet_opening_ft"), cd: cd() };
    }
    if (has(on)) out.outletNode = String(on).trim();
  }
  return out;
}
const INLET_KEYS = new Set(["node", "inlet_type", "type", "perimeter_ft", "weir_length_ft", "open_area_sqft", "orifice_area_sqft", "cw", "co", "curb_length_ft", "curb_height_ft", "depression_width_ft", "clog", "rim_ft", "on_grade", "cross_slope", "long_slope", "gutter_n", "grate_length_ft", "grate_width_ft", "splash_over_ft_s", "depression_depth_ft"]);
/* a note when a raster's CRS cannot be matched to the DEM's (it is then read as if in the DEM's CRS) */
function crsNote(R, what) {
  if (!R.proj4 && R.epsg !== DEM.epsg) return `${what} has no known CRS; it is taken to be in the DEM's CRS`;
  if (R.proj4 && !DEM.proj4 && R.epsg !== DEM.epsg) return `${what} is in EPSG ${R.epsg} but the DEM's CRS is unknown; it is taken to be in the DEM's CRS`;
  return "";
}
function build(o) {
  if (!DEM) throw new Error("Load a DEM first");
  const f = o.cellSize / DEM.res;
  if (!(f >= 1 - 1e-9) || Math.abs(f - Math.round(f)) > 1e-6 * f) throw new Error(`Cell size ${o.cellSize} must be a whole multiple of the DEM resolution ${DEM.res}`);
  const bspec = (o.boundaries || []).map((b) => ({ key: b.key, feature: BOUND[b.index] }));
  // land cover and soils sampled at the cell centres (reprojected when their CRS differs from the DEM's)
  const G0 = { x0: DEM.x0, y1: DEM.y1, cs: o.cellSize, nx: Math.floor(DEM.nx / Math.round(o.cellSize / DEM.res)), ny: Math.floor(DEM.ny / Math.round(o.cellSize / DEM.res)) };
  const projTo = (R) => { if (!R.proj4 || !DEM.proj4 || R.epsg === DEM.epsg) return null; const P = proj4(DEM.proj4, R.proj4); return (xy) => P.forward(xy); };
  const extra = [];
  let lcClass = null, hsg = null;
  if (LCR && o.useLandcover !== false) { const n = crsNote(LCR, "Land cover"); if (n) extra.push(n); lcClass = Model.sampleRaster(LCR, G0, projTo(LCR)); }
  if (SOIL && o.useSoils !== false) {
    if (SOIL.kind === "polygons") { const r = Model.rasterizeHsg(SOIL.feats, G0); hsg = r.hsg; if (r.unknown) extra.push(`${r.unknown} soil polygons have no recognizable hydrologic soil group and are ignored`); }
    else {
      const n = crsNote(SOIL.R, "Soils"); if (n) extra.push(n);
      const v = Model.sampleRaster(SOIL.R, G0, projTo(SOIL.R)); hsg = new Uint8Array(v.length); let other = 0;
      for (let k = 0; k < v.length; k++) { hsg[k] = Model.hsgCode(v[k] === v[k] ? v[k] : null); if (!hsg[k] && v[k] === v[k]) other++; }
      if (other) extra.push(`${other} grid cells have soil codes other than 1-4 (A-D); they use the global Green-Ampt values`);
    }
  }
  B = Model.buildGrid(DEM, { lcClass, lcTable: o.lcTable, hsg, soilTable: o.soilTable, cellSize: o.cellSize, hUnitFt: DEM.hUnitFt || o.hUnitFt, vUnitFt: o.vUnitFt, buildings: o.useBuildings ? BLD : [], boundaries: bspec,
    imperv: o.imperv, nImp: o.nImp, nPerv: o.nPerv, ksInHr: o.ksInHr, suctionIn: o.suctionIn, imd: o.imd, roofToGround: o.roofToGround, closedEdges: o.closedEdges });
  B.bkeys = bspec.map((b) => b.key);
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
  // the boundaries must be the ones the grid was built with, in the same order: lake cells are numbered by position
  const keys = (o.boundaries || []).map((b) => b.key);
  if (B.bkeys && (keys.length !== B.bkeys.length || keys.some((k, i) => k !== B.bkeys[i]))) throw new Error(`The level boundaries (${keys.join(", ") || "none"}) are not the ones the grid was built with (${B.bkeys.join(", ") || "none"}); build the grid again`);
  const given = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  for (const b of o.boundaries || []) if (b.routed && given(b.node)) throw new Error(`Level boundary ${b.key}: a routed lake cannot also take its level from SWMM node ${b.node}`);
  const bspec = (o.boundaries || []).map((b) => ({ key: b.key, node: b.routed || !given(b.node) ? null : String(b.node), level: b.level, routed: !!b.routed, areaAc: b.areaAc, props: (BOUND[b.index] && BOUND[b.index].properties) || {} }));
  const lakeNotes = [];
  // routed lakes: a level pool that starts at the level given and rises with what it gains; its area is the one given, else the part inside the grid
  const routedLakes = [];
  bspec.forEach((b, i) => {
    if (!b.routed) return;
    if (!Number.isFinite(b.level)) throw new Error(`Routed lake ${b.key} needs a starting level`);
    let cells = 0; for (let k = 0; k < N; k++) if ((g.aux[4 * k + 2] & 3) === 2 && ((g.aux[4 * k + 2] >> 4) & 255) === i) cells++;
    if (b.areaAc !== undefined && b.areaAc !== null && b.areaAc !== "" && !(typeof b.areaAc === "number" && b.areaAc > 0 && Number.isFinite(b.areaAc))) throw new Error(`Routed lake ${b.key}: area ${typeof b.areaAc === "number" ? String(b.areaAc) : JSON.stringify(b.areaAc)} (acres) is not a positive number`);
    const areaFt2 = b.areaAc > 0 ? b.areaAc * 43560 : cells * A;
    if (!(areaFt2 > 0)) throw new Error(`Routed lake ${b.key} has no cells in the grid; give its area`);
    const lk = lakeProps(b.key, b.props);
    if (lk.stageArea && b.areaAc > 0) lakeNotes.push(`Routed lake ${b.key}: its stage-area table is used, not its area of ${b.areaAc} ac`);
    routedLakes.push({ lake: i, areaFt2, level0: b.level, name: b.key, areaFrom: lk.stageArea ? "stage-area table" : b.areaAc > 0 ? "given" : "inside the grid", gridAc: cells * A / 43560,
      stageArea: lk.stageArea, outlet: lk.outlet, outletNode: lk.outletNode });
  });
  // a boundary that is not routed does not use its lake fields: they are noted, not parsed, so a bad one does not stop the run (round 4 WRK5-5)
  for (const b of bspec) if (!b.routed) { const f = Object.keys(lakeFields(b.key, b.props)).filter((k) => b.props && Object.keys(b.props).some((x) => x.toLowerCase() === k && b.props[x] !== null && b.props[x] !== "")); if (f.length) lakeNotes.push(`Level boundary ${b.key}: its lake fields (${f.join(", ")}) are used only when it is routed`); }
  const outletNodes = routedLakes.map((r) => r.outletNode || null);
  if (outletNodes.some(Boolean) && o.coupling !== "two") throw new Error(`Lake outlets into a SWMM node (${routedLakes.filter((r) => r.outletNode).map((r) => `${r.name} to ${r.outletNode}`).join(", ")}) need two-way coupling`);
  if (o.coupling === "two") {
    // two-way: SWMM runs here in step with the 2D; boundary levels from SWMM nodes are the live heads
    if (!MODEL || !INP) throw new Error("Two-way coupling needs the SWMM .inp");
    if (o.t0 > (MODEL.end && MODEL.start ? (MODEL.end - MODEL.start) / 3600000 : Infinity)) throw new Error("The start is after the end of the SWMM run");
    post({ id, progress: { phase: "note", text: "Starting SWMM 5.2.4 (WebAssembly) for two-way coupling" } });
    two = await Couple2.makeCoupler(B, createSWMM, INP, MODEL, { cw: o.cw, lw: o.lw, co: o.co, area: o.inletArea, clog: o.clog ?? 0, searchFt: o.searchFt ?? 30, inlets: INLETS || [], defaultInlets: o.defaultInlets !== false });
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
  const runWarn = [];
  runWarn.push(...lakeNotes);
  const freeOut = routedLakes.filter((r) => r.outlet && !r.outletNode).map((r) => r.name);
  if (freeOut.length) runWarn.push(`The outlets of ${freeOut.join(", ")} discharge out of the model (no outlet_node); that water is reported, not routed`);
  if (routedLakes.length && !two && MODEL) runWarn.push(`Routed lakes (${routedLakes.map((r) => r.name).join(", ")}) get no water from SWMM outfalls in a one-way run; only two-way coupling passes outfall flow to them`);
  const fr0 = { sources: (two ? two.nodes : sources).map((s) => ({ name: s.name, cell: s.cell })), warnings: (cpl.warnings || []).concat(runWarn), nodeMap: cpl.nodeMap || [] };
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
  // a routed lake is linked from outside only when a SWMM outfall discharges into it: the engine holds linked lakes to short chunks until
  // their inflow's dependence on the level has been read, and an idle lake should not pay for that (review 0.6.1 ENG6-3)
  if (two) for (const rl of routedLakes) rl.linked = two.lakeOutfalls.some((x) => x.lake === rl.lake);
  const r = await Flood2D.simulate(g, solver, {
    t0: o.t0, t1: o.t1, rainAt, rainStep, stageAt: cpl.stageAt, sources, sourceAt: cpl.sourceAt || (() => []), afterChunk: two ? two.afterChunk : undefined, routedLakes, lakeInflow: two && routedLakes.length ? two.lakeInflowFor(routedLakes) : undefined, lakeOutflow: two && outletNodes.some(Boolean) ? two.lakeOutletTo(outletNodes) : undefined, cfl: o.cfl ?? 0.7, dvThresh: o.dvThresh, readSec: o.outputSec, chunkSec,
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
      const stages = Array.from(cpl.stageAt(fr.tHours)); for (const x of fr.lakeLevels || []) stages[x.lake] = x.level;
      const sum = { tHours: fr.tHours, wetAc: wet * A / 43560, volCf: vol * A, depthMax: dmax, buildings: bNow, inflowCfs: qin, rates: Array.from(rates), stages, ledger: fr.ledger };
      post({ id, frame: { q: q.buffer, sum } }, [q.buffer]);
      const done = (fr.tHours - o.t0) * 3600, wall = (Date.now() - t0w) / 1000;
      post({ id, progress: { phase: "run", tHours: fr.tHours, frac: done / simLen, wall, speed: done / Math.max(wall, 1e-3), steps: fr.steps, dt: fr.dtLast, closurePct: fr.ledger.errPct, kind: solver.kind } });
    }
  });
  if (solver.destroy) solver.destroy();
  let swmm2 = null;
  if (two) {   // finish SWMM to the end of its run so that its report and output are complete
    const fin = two.finish();   // zeroes the inlet inflow, then runs SWMM to its end
    swmm2 = { tally: two.tally, massBalance: fin.massBalance, rpt: fin.rpt, out: fin.out ? fin.out.buffer : null, nodeMap: two.nodeMap, notes: two.engine.notes, inlets: two.inlets };
  }
  for (let k = 0; k < N; k++) if (!(hmax[k] > 0)) tmax[k] = NaN;
  const bReached = bMax.reduce((s, v) => s + (v > bthr ? 1 : 0), 0);
  const vmax = r.vmax || new Float32Array(N), dvmax = r.dvmax || new Float32Array(N), froude = r.froude || new Uint8Array(N);
  const tvmax = r.tvmax || new Float32Array(N), dvdur = r.dvdur || new Float32Array(N);
  // tvmax is NaN where the water never moved (a speed of 0), as tmax is NaN where a cell never got wet: 0 h read as a time inside the run
  // (review 0.6.1 WRK6-10)
  let froudeCells = 0; for (let k = 0; k < N; k++) { if (!isOpen(k)) { vmax[k] = 0; dvmax[k] = 0; froude[k] = 0; tvmax[k] = NaN; dvdur[k] = 0; } else if (!(vmax[k] > 0)) tvmax[k] = NaN; froudeCells += froude[k]; }
  const lakes = r.lakes ? Object.assign({}, r.lakes, { outletNode: outletNodes, hasOutlet: routedLakes.map((x) => !!x.outlet), outletKind: routedLakes.map((x) => x.outlet ? (x.outlet.kind ?? "weir") : null), areaFrom: routedLakes.map((x) => x.areaFrom), gridAc: routedLakes.map((x) => x.gridAc), fromSwmm: two && two.tally.toLakes ? two.tally.toLakes : null, series: undefined,
    seriesT: r.lakes.series.map((x) => x.tHours), seriesL: r.lakes.series.map((x) => x.levels) }) : null;
  return { __transfer: [hmax.buffer, tmax.buffer, bMax.buffer, vmax.buffer, dvmax.buffer, froude.buffer, tvmax.buffer, dvdur.buffer], res: { hmax, tmax, bMax, bReached, vmax, dvmax, froude, tvmax, dvdur, froudeCells, ledger: r.ledger, lakes, steps: r.steps, stopped: r.stopped, kind: solver.kind, wall: (Date.now() - t0w) / 1000, QS, swmm2 } };
}

// Commands run one at a time, in the order they arrive (stop excepted): a load that awaits while a second load or a build arrives
// would otherwise interleave with it, and a refused load's rollback could undo the other's work (review 0.5.0 round 4 WRK5-1).
let QUEUE = Promise.resolve();
self.onmessage = (e) => {
  const { id, cmd, args } = e.data;
  if (cmd === "stop") { STOP = true; return; }
  QUEUE = QUEUE.then(async () => {
    try {
      const out = cmd === "load" ? await load(args) : cmd === "build" ? build(args) : cmd === "run" ? await run(args, id) : null;
      if (out && out.__transfer) post({ id, ok: true, res: out.res }, out.__transfer); else post({ id, ok: true, res: out });
    } catch (err) { post({ id, error: err.message || String(err) }); }
  });
};
