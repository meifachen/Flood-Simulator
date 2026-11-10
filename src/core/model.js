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

  /* any single-band GeoTIFF (land cover, soils): {nx, ny, x0, y1, rx, ry, data (Float32, NaN = NoData), epsg, proj4} */
  async function readRaster(arrayBuffer, GeoTIFF, catalog, what) {
    const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer), img = await tiff.getImage();
    const nx = img.getWidth(), ny = img.getHeight(); if (nx * ny > 60e6) throw new Error(`${what} has ${nx} x ${ny} cells; clip it first`);
    const [rx, ry] = img.getResolution(), [ox, oy] = img.getOrigin();
    if (img.getFileDirectory().ModelTransformation) throw new Error(`${what}: rotated GeoTIFFs are not supported`);
    const ras = await img.readRasters({ interleave: true, samples: [0] }), nd = img.getGDALNoData(), data = new Float32Array(nx * ny);
    for (let i = 0; i < data.length; i++) { const v = ras[i]; data[i] = !Number.isFinite(v) || (nd !== null && v === nd) || v < -1e20 || v > 1e20 ? NaN : v; }   // the +-1e20 guard catches NoData tags written as rounded text (e.g. -3.4e38)
    const gk = img.getGeoKeys() || {}; let epsg = gk.ProjectedCSTypeGeoKey && gk.ProjectedCSTypeGeoKey !== 32767 ? gk.ProjectedCSTypeGeoKey : null;
    if (!epsg && gk.GeographicTypeGeoKey === 4326) epsg = 4326;
    const c = epsg === 4326 ? { proj4: "+proj=longlat +datum=WGS84 +no_defs", name: "WGS 84" } : epsg ? lookupCrs(catalog, epsg) : null;
    return { nx, ny, x0: ox, y1: oy, rx: Math.abs(rx), ry: Math.abs(ry), data, epsg, proj4: c ? c.proj4 : null, crsName: c ? c.name : null };
  }
  /* value of raster R at each grid cell centre (NaN outside or NoData); proj: function [x, y] in the grid CRS -> raster CRS, or null when the CRS is the same */
  function sampleRaster(R, G, proj) {
    const N = G.nx * G.ny, out = new Float32Array(N).fill(NaN);
    for (let r = 0; r < G.ny; r++) for (let c = 0; c < G.nx; c++) {
      let x = G.x0 + (c + 0.5) * G.cs, y = G.y1 - (r + 0.5) * G.cs;
      if (proj) { const p = proj([x, y]); x = p[0]; y = p[1]; }
      const i = Math.floor((x - R.x0) / R.rx), j = Math.floor((R.y1 - y) / R.ry);
      if (i >= 0 && j >= 0 && i < R.nx && j < R.ny) out[r * G.nx + c] = R.data[j * R.nx + i];
    }
    return out;
  }
  /* hydrologic soil group code: "A".."D" or the whole numbers 1..4 (as numbers or text); a dual group ("B/D") takes the undrained group (D).
   * Anything else (fractions, 0, 5, "AB") is 0 = not recognized, and is counted by the callers. */
  function hsgCode(v) {
    if (v === null || v === undefined || typeof v === "boolean") return 0; if (typeof v === "number") return Number.isInteger(v) && v >= 1 && v <= 4 ? v : 0;
    const s = String(v).trim().toUpperCase(); if (/^[1-4]$/.test(s)) return Number(s); const last = s.split("/").pop(); const i = "ABCD".indexOf(last); return i >= 0 && last.length === 1 ? i + 1 : 0;
  }
  function rasterizeHsg(features, G) {
    const out = new Uint8Array(G.nx * G.ny); let unknown = 0;
    for (const f of features) { const p = f.properties || {}, code = hsgCode(p.hsg ?? p.HSG ?? p.hydgrp ?? p.HYDGRP ?? p.hydgrpdcd); if (!code) { unknown++; continue; } fillRings(featureRings(f), G, (k) => { out[k] = code; }); }
    return { hsg: out, unknown };
  }
  /* Manning n for NLCD classes: Kalyanapu, Burian & McPherson (2009), Table 2, for every class it lists (21-24, 31, 41-43, 52, 71, 81, 90, 95).
   * The paper has no value for 11 or 82: open water 0.035 is Chow (1959), natural stream, clean and straight, normal value;
   * cultivated crops 0.06 is the SWMM manual's overland-flow table (McCuen et al. 1996), cultivated soil with residue cover under 20%.
   * Impervious %: the midpoints of the NLCD developed-class ranges (21 <20%, 22 20-49%, 23 50-79%, 24 80-100%); open water counts as 100% (no infiltration). */
  const NLCD_SOURCE = { 11: "Chow (1959)", 82: "SWMM manual, McCuen et al. (1996)" };
  const NLCD = {
    11: ["Open water", 0.035, 100], 21: ["Developed, open space", 0.0404, 10], 22: ["Developed, low intensity", 0.0678, 35], 23: ["Developed, medium intensity", 0.0678, 65],
    24: ["Developed, high intensity", 0.0404, 90], 31: ["Barren land", 0.0113, 0], 41: ["Deciduous forest", 0.36, 0], 42: ["Evergreen forest", 0.32, 0], 43: ["Mixed forest", 0.40, 0],
    52: ["Shrub/scrub", 0.40, 0], 71: ["Grassland/herbaceous", 0.368, 0], 81: ["Pasture/hay", 0.325, 0], 82: ["Cultivated crops", 0.06, 0], 90: ["Woody wetlands", 0.086, 0], 95: ["Emergent herbaceous wetlands", 0.1825, 0] };
  /* Green-Ampt by hydrologic soil group from the Rawls et al. (1983) texture table in the SWMM manual (Appendix A):
   * A loamy sand, B silt loam, C sandy clay loam, D clay loam. Ks (in/hr) and suction (in) as tabulated.
   * IMD (initial moisture deficit) = porosity - field capacity, the deficit of a drained soil; imdMax = porosity - wilting point, the driest the table supports. */
  const HSG = { 1: { name: "A", texture: "loamy sand", ks: 1.18, suction: 2.40, imd: 0.332, imdMax: 0.404 }, 2: { name: "B", texture: "silt loam", ks: 0.26, suction: 6.69, imd: 0.217, imdMax: 0.366 },
    3: { name: "C", texture: "sandy clay loam", ks: 0.06, suction: 8.66, imd: 0.154, imdMax: 0.262 }, 4: { name: "D", texture: "clay loam", ks: 0.04, suction: 8.27, imd: 0.154, imdMax: 0.277 } };

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
    // closed grid edges: the outer ring becomes wall, with no rain on it (like cells without ground data)
    if (o.closedEdges) for (let k = 0; k < N; k++) { const r = (k / nx) | 0, c = k % nx; if ((r === 0 || c === 0 || r === ny - 1 || c === nx - 1) && type[k] !== 1) { type[k] = 1; noData[k] = 1; } }
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
    // land cover: per-cell Manning n and impervious fraction from the class table; classes not in the table keep the global values
    const lcInfo = { cells: 0, missing: {}, covered: 0 }, isNum = (v) => typeof v === "number" && Number.isFinite(v);
    let ground = 0; for (let k = 0; k < N; k++) if (!noData[k]) ground++;
    const coverNote = (what, covered, rest) => { if (!covered) warnings.push(`${what} does not cover any cell of the grid; ${rest} are used everywhere`); else if (covered < ground) warnings.push(`${what} covers ${covered} of ${ground} ground cells; the others use ${rest}`); };
    if (o.lcClass) {
      if (o.lcClass.length !== N) throw new Error(`Land cover was sampled on ${o.lcClass.length} cells but the grid has ${N}`);
      for (const [c, e] of Object.entries(o.lcTable || {})) if (!(isNum(e.n) && e.n > 0 && e.n <= 1) || !(isNum(e.imp) && e.imp >= 0 && e.imp <= 100)) throw new Error(`Land cover class ${c}: Manning n ${e.n} or impervious ${e.imp}% is not valid (n 0-1, impervious 0-100%)`);
      for (let k = 0; k < N; k++) {
        const c = o.lcClass[k]; if (!(c === c) || noData[k]) continue; lcInfo.covered++; const e = o.lcTable && o.lcTable[c];
        if (!e) { lcInfo.missing[c] = (lcInfo.missing[c] || 0) + 1; continue; }
        n[k] = e.n; perv[k] = 1 - e.imp / 100; lcInfo.cells++;
      }
      coverNote("Land cover", lcInfo.covered, "the global roughness and imperviousness");
      const miss = Object.keys(lcInfo.missing); if (miss.length) warnings.push(`Land cover classes ${miss.join(", ")} are not in the table; those cells use the global roughness and imperviousness`);
    }
    // soils: per-cell Green-Ampt parameters from the hydrologic soil group (1-4 = A-D)
    const soilInfo = { cells: 0 };
    if (o.hsg) {
      if (o.hsg.length !== N) throw new Error(`Soil groups were sampled on ${o.hsg.length} cells but the grid has ${N}`);
      const table = o.soilTable || HSG;
      for (const [gI, e] of Object.entries(table)) {
        const nm = "ABCD"[gI - 1] || gI;
        if (!(isNum(e.ks) && e.ks >= 0 && e.ks <= 50) || !(isNum(e.suction) && e.suction >= 0 && e.suction <= 100) || !(isNum(e.imd) && e.imd >= 0 && e.imd <= 1))
          throw new Error(`Soil group ${nm}: Ks ${e.ks} in/hr, suction ${e.suction} in or IMD ${e.imd} is not valid (Ks 0-50, suction 0-100, IMD 0-1)`);
        const ref = HSG[gI]; if (ref && e.imd > ref.imdMax + 1e-9) warnings.push(`Soil group ${nm}: IMD ${e.imd} is drier than the wilting point of ${ref.texture} (porosity - wilting point = ${ref.imdMax}); check it`);
      }
      for (let k = 0; k < N; k++) {
        const gI = o.hsg[k]; if (!gI || noData[k]) continue; const e = table[gI]; if (!e) continue;
        ksA[k] = e.ks / 12 / 3600; psimd[k] = e.suction / 12 * e.imd; imdA[k] = e.imd; soilInfo.cells++;
      }
      coverNote("The soils layer", soilInfo.cells, "the global Green-Ampt values");
    }
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
    return { g, G, z, type, bnd, noData, n, perv, ksA, info: { nx, ny, cells: N, open, wallCells: bCells, nodataCells: nodata, levelCells: lvlCells, factor: f, buildings: bld.length, landcoverCells: lcInfo.cells, soilCells: soilInfo.cells }, warnings };
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

  const api = { readRaster, sampleRaster, hsgCode, rasterizeHsg, NLCD, NLCD_SOURCE, HSG, proj4UnitFt, lookupCrs, readDEM, featureRings, fillRings, buildGrid, cellOf, nearestOpen, coupleSwmm, geoTiff };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FloodModel = api;
})(typeof self !== "undefined" ? self : this);
