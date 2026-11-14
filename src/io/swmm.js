/* SWMM5 input (.inp) and binary output (.out) readers for the Flood Simulator.
 * parseInp(text)  -> model: options, units, nodes (junctions, outfalls, storage, dividers) with coordinates, links, rain gauges, time series, subcatchments.
 * readOut(buffer) -> results: names, node properties, report times, and getNodeSeries(name or index, variable).
 * All values are returned in the units of the file; toUS() converts a model to ft and cfs. The .out format follows the
 * SWMM 5.1/5.2 Interfacing Guide (magic 516114522 at both ends; REAL4 results, REAL8 dates in days since 12/30/1899).
 */
(function (root) {
  "use strict";
  const FT = 0.3048, CFS = { CFS: 1, GPM: 1 / 448.831, MGD: 1.547229, CMS: 35.3146667, LPS: 0.0353146667, MLD: 0.408734569 };
  const US_UNITS = new Set(["CFS", "GPM", "MGD"]);

  // ------------------------------------------------------------------ .inp
  function tokens(line) {
    const out = []; let i = 0, n = line.length;
    while (i < n) {
      while (i < n && /\s/.test(line[i])) i++;
      if (i >= n) break;
      if (line[i] === '"') { const j = line.indexOf('"', i + 1); out.push(line.slice(i + 1, j < 0 ? n : j)); i = j < 0 ? n : j + 1; }
      else { let j = i; while (j < n && !/\s/.test(line[j])) j++; out.push(line.slice(i, j)); i = j; }
    }
    return out;
  }
  function num(v, what) { const x = Number(v); if (!Number.isFinite(x)) throw new Error(`${what}: "${v}" is not a number`); return x; }

  function parseInp(text) {
    if (typeof text !== "string" || !text.trim()) throw new Error("The SWMM input file is empty");
    const sec = {}; let cur = null, lineNo = 0;
    for (const raw of text.split(/\r?\n/)) {
      lineNo++;
      const s = raw.replace(/;.*$/, "").trim(); if (!s) continue;
      const m = s.match(/^\[([^\]]+)\]/); if (m) { cur = m[1].toUpperCase(); sec[cur] = sec[cur] || []; continue; }
      if (!cur) continue;
      sec[cur].push({ t: cur === "TITLE" ? [s] : tokens(s), line: lineNo });
    }
    if (!sec.OPTIONS && !sec.JUNCTIONS && !sec.OUTFALLS) throw new Error("This does not look like a SWMM input file (no [OPTIONS], [JUNCTIONS] or [OUTFALLS] section)");
    const options = {}; for (const r of sec.OPTIONS || []) options[r.t[0].toUpperCase()] = r.t.slice(1).join(" ");
    const flowUnits = (options.FLOW_UNITS || "CFS").toUpperCase();
    if (!(flowUnits in CFS)) throw new Error(`Unknown FLOW_UNITS ${flowUnits}`);
    const model = { title: (sec.TITLE || []).map((r) => r.t[0]).join("\n"), options, flowUnits, unitSystem: US_UNITS.has(flowUnits) ? "US" : "SI",
      nodes: [], nodeIndex: {}, links: [], gauges: [], timeseries: {}, subcatchments: [], polygons: {}, vertices: {}, warnings: [] };
    /* secondary numeric fields: a present token that is not a number is named in the warnings and read as 0,
     * never silently zeroed (review F-29); primary fields refuse through num() instead */
    const secNum = (tok, what) => { if (tok === undefined) return 0; const x = Number(tok); if (Number.isFinite(x)) return x; model.warnings.push(`${what}: "${tok}" is not a number; 0 is used`); return 0; };
    const addNode = (name, type, invert, maxDepth, extra, line) => {
      if (name in model.nodeIndex) throw new Error(`Node ${name} is defined twice (line ${line})`);
      model.nodeIndex[name] = model.nodes.length; model.nodes.push(Object.assign({ name, type, invert, maxDepth, x: null, y: null }, extra));
    };
    for (const r of sec.JUNCTIONS || []) { const t = r.t; addNode(t[0], "JUNCTION", num(t[1], `Junction ${t[0]} elevation`), num(t[2] ?? 0, `Junction ${t[0]} max depth`), { surDepth: secNum(t[4], `Junction ${t[0]} surcharge depth`), pondedArea: secNum(t[5], `Junction ${t[0]} ponded area`) }, r.line); }
    for (const r of sec.OUTFALLS || []) { const t = r.t; addNode(t[0], "OUTFALL", num(t[1], `Outfall ${t[0]} elevation`), 0, { outfallType: (t[2] || "FREE").toUpperCase(), stageData: t[3] }, r.line); }
    for (const r of sec.STORAGE || []) { const t = r.t; addNode(t[0], "STORAGE", num(t[1], `Storage ${t[0]} elevation`), num(t[2] ?? 0, `Storage ${t[0]} max depth`), { initDepth: secNum(t[3], `Storage ${t[0]} initial depth`), shape: (t[4] || "").toUpperCase() }, r.line); }
    for (const r of sec.DIVIDERS || []) { const t = r.t; addNode(t[0], "DIVIDER", num(t[1], `Divider ${t[0]} elevation`), 0, {}, r.line); }
    for (const r of sec.COORDINATES || []) {
      const i = model.nodeIndex[r.t[0]]; if (i === undefined) { model.warnings.push(`Coordinates given for unknown node ${r.t[0]} (line ${r.line})`); continue; }
      model.nodes[i].x = num(r.t[1], `Node ${r.t[0]} X`); model.nodes[i].y = num(r.t[2], `Node ${r.t[0]} Y`);
    }
    for (const n of model.nodes) if (n.x === null) model.warnings.push(`Node ${n.name} has no coordinates`);
    const linkSec = { CONDUITS: "CONDUIT", PUMPS: "PUMP", ORIFICES: "ORIFICE", WEIRS: "WEIR", OUTLETS: "OUTLET" };
    for (const [s, type] of Object.entries(linkSec)) for (const r of sec[s] || []) {
      const t = r.t, l = { name: t[0], type, from: t[1], to: t[2] };
      if (type === "CONDUIT") { l.length = num(t[3], `Conduit ${t[0]} length`); l.roughness = num(t[4], `Conduit ${t[0]} roughness`); l.inOffset = secNum(t[5], `Conduit ${t[0]} inlet offset`); l.outOffset = secNum(t[6], `Conduit ${t[0]} outlet offset`); }
      for (const e of [l.from, l.to]) if (!(e in model.nodeIndex)) model.warnings.push(`Link ${l.name} refers to unknown node ${e}`);
      model.links.push(l);
    }
    const xs = {}; for (const r of sec.XSECTIONS || []) xs[r.t[0]] = { shape: (r.t[1] || "").toUpperCase(), geom1: secNum(r.t[2], `Cross section ${r.t[0]} geometry`) };
    for (const l of model.links) if (xs[l.name]) Object.assign(l, xs[l.name]);
    for (const r of sec.VERTICES || []) (model.vertices[r.t[0]] = model.vertices[r.t[0]] || []).push([num(r.t[1], "Vertex X"), num(r.t[2], "Vertex Y")]);
    for (const r of sec.POLYGONS || []) (model.polygons[r.t[0]] = model.polygons[r.t[0]] || []).push([num(r.t[1], "Polygon X"), num(r.t[2], "Polygon Y")]);
    for (const r of sec.SUBCATCHMENTS || []) { const t = r.t; model.subcatchments.push({ name: t[0], gauge: t[1], outlet: t[2], area: secNum(t[3], `Subcatchment ${t[0]} area`), imperv: secNum(t[4], `Subcatchment ${t[0]} impervious percent`) }); }
    // other water SWMM can make on its own: external and dry-weather inflows, RDII, groundwater
    model.otherInflows = ["INFLOWS", "DWF", "RDII", "GROUNDWATER"].reduce((n, k) => n + (sec[k] || []).length, 0);
    for (const r of sec.RAINGAGES || []) {
      const t = r.t; // Name Format Interval SCF TIMESERIES ts | FILE fname sta units
      model.gauges.push({ name: t[0], format: (t[1] || "INTENSITY").toUpperCase(), interval: t[2], intervalSec: clockSec(t[2]), scf: t[3] === undefined ? 1 : secNum(t[3], `Rain gauge ${t[0]} snow catch factor`), source: (t[4] || "").toUpperCase(), series: t[5], fileUnits: t[8] });
    }
    // time series: "name [date] time value" or "name FILE path"; dates continue across lines
    let lastDate = {};
    for (const r of sec.TIMESERIES || []) {
      const t = r.t, name = t[0]; const ts = (model.timeseries[name] = model.timeseries[name] || { name, points: [], file: null });
      if ((t[1] || "").toUpperCase() === "FILE") { ts.file = t[2]; continue; }
      // remaining tokens: pairs of (time value) optionally preceded by a date
      let i = 1;
      while (i < t.length) {
        let date = null;
        if (/[\/-]/.test(t[i]) && i + 2 < t.length + 1 && !/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(t[i])) { date = t[i]; lastDate[name] = date; i++; }
        const tm = t[i], v = t[i + 1]; if (tm === undefined || v === undefined) { model.warnings.push(`Time series ${name}: incomplete entry on line ${r.line}`); break; }
        const d = date || lastDate[name] || null;
        ts.points.push({ date: d, time: tm, value: num(v, `Time series ${name} value (line ${r.line})`) }); i += 2;
      }
    }
    model.start = dateTime(options.START_DATE, options.START_TIME);
    model.end = dateTime(options.END_DATE || options.START_DATE, options.END_TIME || "0:00");
    model.reportStart = dateTime(options.REPORT_START_DATE || options.START_DATE, options.REPORT_START_TIME || options.START_TIME);
    model.reportStepSec = clockSec(options.REPORT_STEP || "0:15:00");
    model.ponding = (options.ALLOW_PONDING || "NO").toUpperCase() === "YES";
    model.mapUnits = ((sec.MAP || []).find((r) => (r.t[0] || "").toUpperCase() === "UNITS") || { t: [, "NONE"] }).t[1];
    return model;
  }
  // "h:mm[:ss]" or decimal hours -> seconds
  function clockSec(s) {
    if (s === undefined || s === null || s === "") return NaN;
    const str = String(s);
    if (str.includes(":")) { const p = str.split(":").map(Number); return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0); }
    return Number(str) * 3600;
  }
  // SWMM date (MM/DD/YYYY) + time -> JS Date in UTC (the model clock has no time zone)
  function dateTime(d, t) {
    if (!d) return null; const p = d.split(/[\/-]/).map(Number);
    let y, mo, da; if (p[0] > 1000) { [y, mo, da] = p; } else { [mo, da, y] = p; }
    const ms = Date.UTC(y, mo - 1, da) + (clockSec(t || "0:00") || 0) * 1000; return new Date(ms);
  }
  /* Rain series for a gauge, as intensity in in/hr per interval: {startHours (from model start), stepSec, values[]}.
   * Handles INTENSITY, VOLUME and CUMULATIVE formats from an inline time series; FILE sources are refused with a message. */
  function gaugeRain(model, gaugeName) {
    const g = model.gauges.find((x) => x.name === gaugeName) || model.gauges[0];
    if (!g) throw new Error("The model has no rain gauge");
    if (g.source !== "TIMESERIES") throw new Error(`Rain gauge ${g.name} reads a rainfall file; only gauges with an inline time series are supported`);
    const ts = model.timeseries[g.series]; if (!ts) throw new Error(`Rain gauge ${g.name} refers to time series ${g.series}, which is not in the file`);
    if (ts.file) throw new Error(`Time series ${ts.name} is read from an external file (${ts.file}); paste it into the .inp or use the Python prep tools`);
    const step = g.intervalSec; if (!(step > 0)) throw new Error(`Rain gauge ${g.name} has an invalid interval ${g.interval}`);
    const t0 = model.start ? model.start.getTime() : 0;
    const pts = ts.points.map((p) => ({ t: p.date ? (dateTime(p.date, p.time).getTime() - t0) / 1000 : clockSec(p.time), v: p.value }));
    for (let i = 1; i < pts.length; i++) if (!(pts[i].t >= pts[i - 1].t)) throw new Error(`Time series ${ts.name} is not in time order near point ${i + 1}`);
    if (!pts.length) throw new Error(`Time series ${ts.name} is empty`);
    const toIn = model.unitSystem === "SI" ? 1 / 25.4 : 1;
    const endT = pts[pts.length - 1].t + step, n = Math.ceil(endT / step), vals = new Float64Array(n);
    // value at point i applies from its time to the next point (SWMM treats rain series as step functions)
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i].t, b = i + 1 < pts.length ? pts[i + 1].t : a + step;
      let rate; // in/hr over [a, b)
      if (g.format === "INTENSITY") rate = pts[i].v;
      else if (g.format === "VOLUME") rate = pts[i].v / (step / 3600);
      else if (g.format === "CUMULATIVE") rate = i + 1 < pts.length ? (pts[i + 1].v - pts[i].v) / ((b - a) / 3600) : 0;
      else throw new Error(`Unknown rain format ${g.format}`);
      rate *= toIn * g.scf;
      if (!(rate >= 0)) throw new Error(`Rain gauge ${g.name}: negative or invalid rain at point ${i + 1}`);
      for (let k = Math.floor(a / step); k < Math.ceil(b / step) && k < n; k++) {
        const lo = Math.max(a, k * step), hi = Math.min(b, (k + 1) * step); if (hi > lo) vals[k] += rate * (hi - lo) / step;
      }
    }
    return { gauge: g.name, stepSec: step, values: Array.from(vals), totalIn: vals.reduce((s, v) => s + v * step / 3600, 0) };
  }
  // convert a parsed SI model to ft (elevations, depths, coordinates if map units are meters is left to the caller)
  function lengthFactor(model) { return model.unitSystem === "SI" ? 1 / FT : 1; }

  // ------------------------------------------------------------------ .out
  const MAGIC = 516114522, NODE_VARS = ["depth", "head", "volume", "lateral_inflow", "total_inflow", "flooding"];
  function readOut(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), L = u8.byteLength;
    if (L < 52) throw new Error("The SWMM output file is too short");
    const i32 = (o) => dv.getInt32(o, true), f32 = (o) => dv.getFloat32(o, true), f64 = (o) => dv.getFloat64(o, true);
    if (i32(0) !== MAGIC) throw new Error("Not a SWMM binary output file (bad header)");
    if (i32(L - 4) !== MAGIC) throw new Error("The SWMM output file is incomplete (the run may have stopped with an error)");
    const errCode = i32(L - 8), nPeriods = i32(L - 12), resOff = i32(L - 16), propOff = i32(L - 20), idOff = i32(L - 24);
    if (errCode) throw new Error(`SWMM reported error code ${errCode} in this run`);
    if (nPeriods <= 0) throw new Error("The SWMM output file has no reporting periods");
    const version = i32(4), flowCode = i32(8), nSub = i32(12), nNode = i32(16), nLink = i32(20), nPoll = i32(24);
    const flowUnits = ["CFS", "GPM", "MGD", "CMS", "LPS", "MLD"][flowCode]; if (!flowUnits) throw new Error(`Unknown flow unit code ${flowCode}`);
    // names
    let o = idOff; const name = () => { const n = i32(o); o += 4; let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(u8[o + i]); o += n; return s; };
    const subNames = [], nodeNames = [], linkNames = [], pollNames = [];
    for (let i = 0; i < nSub; i++) subNames.push(name()); for (let i = 0; i < nNode; i++) nodeNames.push(name());
    for (let i = 0; i < nLink; i++) linkNames.push(name()); for (let i = 0; i < nPoll; i++) pollNames.push(name());
    // properties
    o = propOff;
    const nSubProp = i32(o); o += 4 * (1 + nSubProp) + 4 * nSubProp * nSub;
    const nNodeProp = i32(o); o += 4; const nodeCodes = []; for (let i = 0; i < nNodeProp; i++) { nodeCodes.push(i32(o)); o += 4; }
    const nodes = [];
    // no node type is reported: property code 0 is 0 for junctions, outfalls and storage alike in files the EPA engine writes,
    // so a type derived from it labelled every node "JUNCTION" (review F-14). Node types come from parseInp, by name.
    for (let j = 0; j < nNode; j++) { const p = {}; for (let i = 0; i < nNodeProp; i++) { p[nodeCodes[i]] = f32(o); o += 4; } nodes.push({ name: nodeNames[j], invert: p[2], maxDepth: p[3] }); }
    const nLinkProp = i32(o); o += 4 * (1 + nLinkProp) + 4 * nLinkProp * nLink;
    // reporting variables
    const nSubVar = i32(o); o += 4 * (1 + nSubVar);
    const nNodeVar = i32(o); o += 4 * (1 + nNodeVar);
    const nLinkVar = i32(o); o += 4 * (1 + nLinkVar);
    const nSysVar = i32(o); o += 4 * (1 + nSysVar);
    const startDays = f64(o), stepSec = i32(o + 8);
    const bytesPerPeriod = 8 + 4 * (nSub * nSubVar + nNode * nNodeVar + nLink * nLinkVar + nSysVar);
    if (resOff + nPeriods * bytesPerPeriod > L - 24) throw new Error("The SWMM output file is truncated");
    const t0ms = Math.round((startDays - 25569) * 86400000);   // 25569 days from 12/30/1899 to 1/1/1970
    const out = { version, flowUnits, unitSystem: US_UNITS.has(flowUnits) ? "US" : "SI", nPeriods, reportStepSec: stepSec, start: new Date(t0ms),
      subcatchments: subNames, nodeNames, linkNames, pollutants: pollNames, nodes, nodeVars: NODE_VARS.slice(),
      // the first reported value is at start + one report step
      times: Array.from({ length: nPeriods }, (_, i) => new Date(t0ms + (i + 1) * stepSec * 1000)) };
    out.dateAt = (i) => new Date(Math.round((f64(resOff + i * bytesPerPeriod) - 25569) * 86400) * 1000);   // report times are whole seconds; rounding to the second keeps dateAt in step with times (the stored OLE date can carry a millisecond of float error, review F-31)
    out.getNodeSeries = (node, variable) => {
      const j = typeof node === "number" ? node : nodeNames.indexOf(node); if (j < 0 || j >= nNode) throw new Error(`Node ${node} is not in the output file`);
      const v = typeof variable === "number" ? variable : NODE_VARS.indexOf(variable); if (v < 0 || v >= nNodeVar) throw new Error(`Unknown node variable ${variable}`);
      const s = new Float32Array(nPeriods), base = resOff + 8 + 4 * (nSub * nSubVar) + 4 * (j * nNodeVar + v);
      for (let i = 0; i < nPeriods; i++) s[i] = f32(base + i * bytesPerPeriod);
      return s;
    };
    return out;
  }

  const api = { parseInp, readOut, gaugeRain, clockSec, dateTime, lengthFactor, FT, CFS_PER_UNIT: CFS, NODE_VARS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SWMM = api;
})(typeof self !== "undefined" ? self : this);
