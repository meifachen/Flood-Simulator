/* Flood Simulator model builder: DEM -> engine grid, buildings -> walls, boundary polygons -> level cells, SWMM nodes -> point inflows.
 * Pure functions (no DOM) so the same code runs in the browser worker and in node tests.
 * Coordinates: the DEM's projected CRS throughout. Engine units: ft, s, cfs (lengths converted with hUnitFt / vUnitFt).
 */
(function (root) {
  "use strict";
  const F2D = (typeof module !== "undefined" && module.exports) ? require("../engine/flood2d.js") : root.Flood2D;

  // ------------------------------------------------------------------ CRS helpers
  /* unit of a proj4 string in feet: us-ft, ft, m (default m) */
  function proj4UnitFt(p) {
    const m = /\+units=([\w-]+)/.exec(p || ""), to = /\+to_meter=([\d.eE+-]+)/.exec(p || "");
    if (to) return Number(to[1]) / 0.3048;
    const u = m ? m[1] : "m";
    return u === "us-ft" ? 1200 / 3937 / 0.3048 : u === "ft" ? 1 : u === "m" ? 1 / 0.3048 : u === "km" ? 1000 / 0.3048 : NaN;
  }
  function lookupCrs(catalog, code) { const e = catalog && catalog.crs && catalog.crs[String(code)]; return e ? { epsg: Number(code), name: e[0], proj4: e[1] } : null; }

  // ------------------------------------------------------------------ DEM
  /* Read a single-band GeoTIFF with geotiff.js. Returns {nx, ny, x0, y1, res, data (Float32, NaN for NoData), epsg, crsName, proj4, hUnitFt}. */
  async function readDEM(arrayBuffer, GeoTIFF, catalog) {
    const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer), img = await tiff.getImage();
    const nx = img.getWidth(), ny = img.getHeight();
    if (nx * ny > 40e6) throw new Error(`The DEM is ${nx} x ${ny} cells; clip or resample it first (python/prep_dem.py)`);
    const [rx, ry] = img.getResolution(); const [ox, oy] = img.getOrigin();
    if (!(Math.abs(Math.abs(rx) - Math.abs(ry)) < 1e-6 * Math.abs(rx))) throw new Error(`The DEM cells are not square (${Math.abs(rx)} x ${Math.abs(ry)}); resample it first`);
    const fd = img.getFileDirectory(); if (fd.ModelTransformation) throw new Error("Rotated GeoTIFFs are not supported; warp the DEM to north-up first");
    const ras = await img.readRasters({ interleave: true }); const nd = img.getGDALNoData();
    const data = new Float32Array(nx * ny); let valid = 0;
    for (let i = 0; i < data.length; i++) { const v = ras[i]; const bad = !Number.isFinite(v) || (nd !== null && v === nd) || v < -1e20 || v > 1e20; data[i] = bad ? NaN : v; if (!bad) valid++; }
    if (!valid) throw new Error("The DEM has no valid cells");
    const gk = img.getGeoKeys() || {}; const epsg = gk.ProjectedCSTypeGeoKey && gk.ProjectedCSTypeGeoKey !== 32767 ? gk.ProjectedCSTypeGeoKey : null;
    if (!epsg && gk.GeographicTypeGeoKey && !gk.ProjectedCSTypeGeoKey) throw new Error("The DEM is in geographic coordinates (degrees); project it to a CRS in feet or meters first (python/prep_dem.py)");
    const c = epsg ? lookupCrs(catalog, epsg) : null;
    let vUnit = null; const vt = (gk.VerticalUnitsGeoKey || null); if (vt === 9001) vUnit = "m"; else if (vt === 9002) vUnit = "ft"; else if (vt === 9003) vUnit = "us-ft";
    return { nx, ny, x0: ox, y1: oy, res: Math.abs(rx), data, valid, epsg, crsName: c ? c.name : null, proj4: c ? c.proj4 : null, hUnitFt: c ? proj4UnitFt(c.proj4) : NaN, vUnitHint: vUnit,
      bounds: [ox, oy - ny * Math.abs(ry), ox + nx * Math.abs(rx), oy] };
  }

  // ------------------------------------------------------------------ polygons
  /* rings of a GeoJSON Polygon/MultiPolygon feature */
  function featureRings(f) {
    const g = f && f.geometry; if (!g) return [];
    if (g.type === "Polygon") return g.coordinates; if (g.type === "MultiPolygon") return g.coordinates.flat(); return [];
  }
  /* even-odd fill of cell centres inside the rings; calls set(k) for each cell. Grid: x0, y1 (top), cs, nx, ny. */
  function fillRings(rings, G, set) {
    let ymin = Infinity, ymax = -Infinity;
    for (const r of rings) for (const p of r) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }
    if (!Number.isFinite(ymin)) return 0;
    const r0 = Math.max(0, Math.floor((G.y1 - ymax) / G.cs)), r1 = Math.min(G.ny - 1, Math.ceil((G.y1 - ymin) / G.cs));
    let n = 0;
    for (let r = r0; r <= r1; r++) {
      const yc = G.y1 - (r + 0.5) * G.cs, xs = [];
      for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j]; if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const c0 = Math.max(0, Math.ceil((xs[i] - G.x0) / G.cs - 0.5)), c1 = Math.min(G.nx - 1, Math.floor((xs[i + 1] - G.x0) / G.cs - 0.5));
        for (let c = c0; c <= c1; c++) { set(r * G.nx + c); n++; }
      }
    }
    return n;
  }

  // ------------------------------------------------------------------ grid
  /* opts: {cellSize (CRS units, a multiple of the DEM resolution), hUnitFt, vUnitFt, buildings: [features], boundaries: [{feature, key}],
   *        imperv (0..1), nImp, nPerv, ksInHr, suctionIn, imd, roofToGround (bool)}
   * Returns {g (engine grid), G (geometry), z (ft), type, bnd (boundary key per cell or -1), info, warnings}. */
  function buildGrid(dem, o) {
    const warnings = [], f = Math.round(o.cellSize / dem.res);
    if (!(f >= 1) || Math.abs(f * dem.res - o.cellSize) > 1e-6 * o.cellSize) throw new Error(`Cell size ${o.cellSize} must be a whole multiple of the DEM resolution ${dem.res}`);
    if (!(o.hUnitFt > 0) || !(o.vUnitFt > 0)) throw new Error("Horizontal and vertical units must be known (feet or meters)");
    const nx = Math.floor(dem.nx / f), ny = Math.floor(dem.ny / f), N = nx * ny;
    if (nx < 3 || ny < 3) throw new Error(`The grid would be only ${nx} x ${ny} cells; use a smaller cell size`);
    if (N > 8e6) throw new Error(`The grid would have ${(N / 1e6).toFixed(1)} million cells (limit 8 million); use a larger cell size or clip the DEM`);
    const G = { x0: dem.x0, y1: dem.y1, cs: o.cellSize, nx, ny, dxFt: o.cellSize * o.hUnitFt };
    const z = new Float32Array(N), type = new Uint8Array(N), node = new Uint8Array(N), noData = new Uint8Array(N); let nodata = 0;
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
      let s = 0, m = 0;
      for (let i = 0; i < f; i++) for (let j = 0; j < f; j++) { const v = dem.data[(r * f + i) * dem.nx + c * f + j]; if (v === v) { s += v; m++; } }
      const k = r * nx + c;
      if (m * 2 < f * f) { type[k] = 1; z[k] = 0; noData[k] = 1; nodata++; } else z[k] = s / m * o.vUnitFt;
    }
    if (nodata) warnings.push(`${nodata} cells have no ground data and act as walls`);
    // buildings -> walls (cell centre inside the footprint)
    let bCells = 0; const bld = o.buildings || [];
    const bStart = new Int32Array(bld.length + 1), bList = [];
    bld.forEach((ft, i) => { bStart[i] = bList.length; fillRings(featureRings(ft), G, (k) => { if (type[k] === 0) { type[k] = 1; bCells++; } bList.push(k); }); });
    bStart[bld.length] = bList.length;
    // boundaries -> level cells; key index into o.boundaries
    const bnd = new Int16Array(N).fill(-1); let lvlCells = 0;
    (o.boundaries || []).forEach((b, i) => {
      if (i > 63) throw new Error("At most 64 level boundaries");
      const n = fillRings(featureRings(b.feature), G, (k) => { if (noData[k]) return; type[k] = 2; node[k] = i; bnd[k] = i; lvlCells++; });
      if (!n) warnings.push(`Level boundary ${b.key} does not cover any cell of the grid`);
    });
    // walls between: a building cell inside a boundary polygon stays a boundary (handled by the order above)
    const imp = o.imperv ?? 0.4, ks = (o.ksInHr ?? 0.5) / 12 / 3600, psi = (o.suctionIn ?? 4) / 12, imd = o.imd ?? 0.3;
    const n = new Float32Array(N).fill(imp * (o.nImp ?? 0.015) + (1 - imp) * (o.nPerv ?? 0.1)), perv = new Float32Array(N).fill(1 - imp),
      ksA = new Float32Array(N).fill(ks), psimd = new Float32Array(N).fill(psi * imd), imdA = new Float32Array(N).fill(imd), mult = new Float32Array(N).fill(1);
    // rain on roofs: to the nearest open cell (multi-source BFS from open cells), or lost
    if (o.roofToGround !== false) {
      const near = new Int32Array(N).fill(-1), q = new Int32Array(N); let qh = 0, qt = 0;
      for (let k = 0; k < N; k++) if (type[k] === 0) { near[k] = k; q[qt++] = k; }
      while (qh < qt) { const k = q[qh++], r = (k / nx) | 0, c = k - r * nx; for (const j of [c > 0 ? k - 1 : -1, c < nx - 1 ? k + 1 : -1, r > 0 ? k - nx : -1, r < ny - 1 ? k + nx : -1]) if (j >= 0 && near[j] < 0) { near[j] = near[k]; q[qt++] = j; } }
      for (let k = 0; k < N; k++) if (type[k] === 1 && !noData[k] && near[k] >= 0) mult[near[k]] += 1;
    }
    const g = F2D.makeGrid({ nx, ny, dx: G.dxFt, z, type, node, n, perv, ks: ksA, psimd, imd: imdA, mult, K: (o.boundaries || []).length });
    g.bldStart = bStart; g.bldCells = Int32Array.from(bList);
    let open = 0; for (let k = 0; k < N; k++) if (type[k] === 0) open++;
    return { g, G, z, type, bnd, noData, info: { nx, ny, cells: N, open, wallCells: bCells, nodataCells: nodata, levelCells: lvlCells, factor: f, buildings: bld.length }, warnings };
  }
  function cellOf(G, x, y) { const c = Math.floor((x - G.x0) / G.cs), r = Math.floor((G.y1 - y) / G.cs); return (c >= 0 && r >= 0 && c < G.nx && r < G.ny) ? r * G.nx + c : -1; }
  /* nearest open cell within maxCells (Chebyshev rings), or -1 */
  function nearestOpen(type, G, k, maxCells) {
    if (k < 0) return -1; if (type[k] === 0) return k;
    const r0 = (k / G.nx) | 0, c0 = k % G.nx;
    for (let d = 1; d <= maxCells; d++) {
      let best = -1, bd = Infinity;
      for (let r = r0 - d; r <= r0 + d; r++) for (let c = c0 - d; c <= c0 + d; c++) {
        if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== d || r < 0 || c < 0 || r >= G.ny || c >= G.nx) continue;
        const j = r * G.nx + c; if (type[j] !== 0) continue; const dd = (r - r0) ** 2 + (c - c0) ** 2; if (dd < bd) { bd = dd; best = j; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  // ------------------------------------------------------------------ SWMM coupling (one way)
  /* model: parseInp result; out: readOut result (or null); opts: {searchFt (default 30), boundaries [{key, node, level}], useRainOnGrid, gauge, sourceNodes: "flooding"}
   * Time base: hours from the model START_DATE/START_TIME. Returns {sources, sourceAt, stageAt, rain, t0, t1, warnings, nodeMap}. */
  function coupleSwmm(B, model, out, o = {}) {
    const W = [], G = B.G, Lf = model.unitSystem === "SI" ? 1 / 0.3048 : 1;
    const qf = out ? ({ CFS: 1, GPM: 1 / 448.831, MGD: 1.547229, CMS: 35.3146667, LPS: 0.0353146667, MLD: 0.408734569 })[out.flowUnits] : 1;
    if (out && out.unitSystem !== model.unitSystem) throw new Error(`The .inp is in ${model.unitSystem} units but the .out is in ${out.unitSystem} units; they are from different runs`);
    if (out) { const miss = model.nodes.filter((n) => out.nodeNames.indexOf(n.name) < 0).map((n) => n.name); if (miss.length) throw new Error(`The .out file does not match the .inp: nodes ${miss.slice(0, 5).join(", ")} are missing from it`); }
    const startMs = model.start ? model.start.getTime() : (out ? out.start.getTime() : 0);
    const maxCells = Math.max(1, Math.ceil((o.searchFt ?? 30) / G.dxFt));
    const sources = [], series = [], nodeMap = [];
    let outside = 0, moved = 0, dropped = 0, inBoundary = 0;
    for (const nd of model.nodes) {
      const rec = { name: nd.name, type: nd.type, x: nd.x, y: nd.y, cell: -1, status: "" };
      nodeMap.push(rec);
      if (!Number.isFinite(nd.x)) { rec.status = "no coordinates"; continue; }
      const k = cellOf(G, nd.x, nd.y);
      if (k < 0) { rec.status = "outside the grid"; outside++; continue; }
      rec.cell = k;
      const s = out ? out.getNodeSeries(nd.name, "flooding") : null; let peak = 0; if (s) for (const v of s) if (v > peak) peak = v;
      rec.peakFloodCfs = peak * qf;
      if (!s || !(peak > 0)) { rec.status = "no flooding"; continue; }
      if (B.type[k] === 2) { rec.status = "inside a level boundary: its flooding is part of that water body"; inBoundary++; continue; }
      const kk = nearestOpen(B.type, G, k, maxCells);
      if (kk < 0) { rec.status = `no open cell within ${o.searchFt ?? 30} ft: flooding not added`; dropped++; W.push(`Node ${nd.name} floods (peak ${(peak * qf).toFixed(2)} cfs) but has no open cell within ${o.searchFt ?? 30} ft; its flooding is not added`); continue; }
      if (kk !== k) { rec.status = "moved to the nearest open cell"; moved++; } else rec.status = "inflow";
      rec.cell = kk; sources.push({ cell: kk, name: nd.name }); series.push(s);
    }
    if (outside) W.push(`${outside} SWMM nodes lie outside the grid and are ignored`);
    if (moved) W.push(`${moved} flooding nodes sat on a building or wall cell and were moved to the nearest open cell`);
    if (inBoundary) W.push(`${inBoundary} flooding nodes are inside a level boundary; their flooding is part of that water body`);
    // report times in hours from the model start; the series value at time 0 is taken as 0 (SWMM starts dry or at its initial state)
    const stepH = out ? out.reportStepSec / 3600 : 1, tOut0 = out ? (out.start.getTime() - startMs) / 3600000 : 0;
    const tAt = (i) => tOut0 + (i + 1) * stepH;   // value i is at the end of report period i
    // mean of a piecewise-linear series over [a, b] (hours), value 0 before the first point at tOut0, held after the last
    function meanOver(s, a, b, startVal) {
      const n = s.length; const v = (t) => { if (t <= tOut0) return startVal; const x = (t - tOut0) / stepH - 1; if (x < 0) { const w = x + 1; return startVal * (1 - w) + s[0] * w; } if (x >= n - 1) return s[n - 1]; const i = Math.floor(x), w = x - i; return s[i] * (1 - w) + s[i + 1] * w; };
      // integrate exactly over breakpoints
      const pts = [a]; for (let i = -1; i < n; i++) { const t = i < 0 ? tOut0 : tAt(i); if (t > a && t < b) pts.push(t); } pts.push(b);
      let sum = 0; for (let i = 0; i + 1 < pts.length; i++) sum += 0.5 * (v(pts[i]) + v(pts[i + 1])) * (pts[i + 1] - pts[i]);
      return b > a ? sum / (b - a) : v(a);
    }
    const sourceAt = (a, b) => series.map((s) => meanOver(s, a, b, 0) * qf);
    // level boundaries: a SWMM node head (converted to ft) or a constant level (ft)
    const bspec = o.boundaries || [];
    const heads = bspec.map((b) => {
      if (b.node) {
        if (!out) throw new Error(`Level boundary ${b.key} uses node ${b.node}, which needs the SWMM .out file`);
        const j = out.nodeNames.indexOf(b.node); if (j < 0) throw new Error(`Level boundary ${b.key}: node ${b.node} is not in the SWMM results`);
        const h = out.getNodeSeries(j, "head"), nd = model.nodes[model.nodeIndex[b.node]];
        const h0 = nd ? nd.invert + (nd.initDepth || 0) : h[0];
        return { s: Array.from(h, (v) => v * Lf), h0: h0 * Lf };
      }
      if (!Number.isFinite(b.level)) throw new Error(`Level boundary ${b.key} needs a SWMM node or a level`);
      return { level: b.level };
    });
    const stageAt = (t) => heads.map((h) => (h.level !== undefined ? h.level : meanOver(h.s, t, t, h.h0)));
    // rain on the grid from a gauge (optional)
    let rain = null;
    if (o.useRainOnGrid) {
      const SW = (typeof module !== "undefined" && module.exports) ? require("../io/swmm.js") : root.SWMM;
      rain = SW.gaugeRain(model, o.gauge);
    }
    const end = model.end ? (model.end.getTime() - startMs) / 3600000 : (out ? tAt(out.nPeriods - 1) : 1);
    return { sources, sourceAt, stageAt, rain, t0: 0, t1: end, warnings: W, nodeMap, flowFactor: qf, lengthFactor: Lf };
  }

  // ------------------------------------------------------------------ outputs
  /* GeoTIFF (little-endian, uncompressed, Float32 bands, NoData -9999) in the DEM's CRS. bands: [{name, data (Float32 per cell, NaN = NoData)}] */
  function geoTiff(G, epsg, bands, units) {
    const nx = G.nx, ny = G.ny, nb = bands.length, NOD = -9999, pix = new Float32Array(nx * ny * nb);
    for (let k = 0; k < nx * ny; k++) for (let b = 0; b < nb; b++) { const v = bands[b].data[k]; pix[k * nb + b] = Number.isFinite(v) ? v : NOD; }
    const lin = units === "m" ? 9001 : units === "us-ft" ? 9003 : 9002;
    const meta = "<GDALMetadata>" + bands.map((b, i) => `<Item name="DESCRIPTION" sample="${i}" role="description">${b.name}</Item>`).join("") + "</GDALMetadata>\0";
    const geokeys = epsg ? [1, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, epsg, 3076, 0, 1, lin] : [1, 1, 0, 2, 1024, 0, 1, 1, 1025, 0, 1, 1];
    const u16 = (...v) => new Uint8Array(new Uint16Array(v).buffer), u32 = (...v) => new Uint8Array(new Uint32Array(v).buffer), f64 = (...v) => new Uint8Array(new Float64Array(v).buffer), asc = (s) => new TextEncoder().encode(s);
    const tags = [[256, 4, 1, u32(nx)], [257, 4, 1, u32(ny)], [258, 3, nb, u16(...Array(nb).fill(32))], [259, 3, 1, u16(1)], [262, 3, 1, u16(1)], [273, 4, 1, null], [277, 3, 1, u16(nb)],
      [278, 4, 1, u32(ny)], [279, 4, 1, u32(pix.byteLength)], [284, 3, 1, u16(1)], [339, 3, nb, u16(...Array(nb).fill(3))],
      [33550, 12, 3, f64(G.cs, G.cs, 0)], [33922, 12, 6, f64(0, 0, 0, G.x0, G.y1, 0)], [34735, 3, geokeys.length, u16(...geokeys)],
      [42112, 2, asc(meta).length, asc(meta)], [42113, 2, asc(NOD + "\0").length, asc(NOD + "\0")]];
    if (nb > 1) tags.splice(10, 0, [338, 3, nb - 1, u16(...Array(nb - 1).fill(0))]);
    tags.sort((a, b) => a[0] - b[0]);
    const ifdOff = 8, ifdSize = 2 + tags.length * 12 + 4; let extra = ifdOff + ifdSize;
    for (const t of tags) if (t[3] && t[3].length > 4) { if (extra % 2) extra++; t.off = extra; extra += t[3].length; }
    const imgOff = Math.ceil(extra / 8) * 8, buf = new ArrayBuffer(imgOff + pix.byteLength), dv = new DataView(buf), u8 = new Uint8Array(buf);
    u8[0] = 0x49; u8[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, ifdOff, true); dv.setUint16(ifdOff, tags.length, true);
    tags.forEach((t, i) => { const p = ifdOff + 2 + 12 * i; dv.setUint16(p, t[0], true); dv.setUint16(p + 2, t[1], true); dv.setUint32(p + 4, t[2], true);
      if (t[0] === 273) dv.setUint32(p + 8, imgOff, true); else if (t[3].length > 4) { dv.setUint32(p + 8, t.off, true); u8.set(t[3], t.off); } else u8.set(t[3], p + 8); });
    dv.setUint32(ifdOff + 2 + 12 * tags.length, 0, true);
    u8.set(new Uint8Array(pix.buffer), imgOff);
    return buf;
  }

  const api = { proj4UnitFt, lookupCrs, readDEM, featureRings, fillRings, buildGrid, cellOf, nearestOpen, coupleSwmm, geoTiff };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FloodModel = api;
})(typeof self !== "undefined" ? self : this);
