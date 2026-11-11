/* Flood Simulator page: inputs, worker calls, map, 3D, charts and exports. */
"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmt = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const UNIT_FT = { ft: 1, "us-ft": 1200 / 3937 / 0.3048, m: 1 / 0.3048 };
const S = { dem: null, bld: null, bnd: null, swmm: null, grid: null, frames: [], final: null, frame: 0, view: "now", sel: -1, running: false, catalog: null, files: {}, exName: null };
window.S = S;

// ------------------------------------------------------------------ worker
let W = null, CID = 0; const CALLS = {};
function worker() {
  if (W) return W;
  W = new Worker(URL.createObjectURL(new Blob([$("#workersrc").textContent], { type: "text/javascript" })));
  W.onmessage = (e) => { const m = e.data, c = CALLS[m.id]; if (!c) return; if (m.progress || m.frame) { c.on && c.on(m); return; } delete CALLS[m.id]; m.error ? c.reject(new Error(m.error)) : c.resolve(m.res); };
  W.onerror = (e) => { for (const k of Object.keys(CALLS)) { CALLS[k].reject(new Error(e.message || "worker error")); delete CALLS[k]; } };
  return W;
}
function call(cmd, args, transfer, on) { const id = ++CID; return new Promise((resolve, reject) => { CALLS[id] = { resolve, reject, on }; worker().postMessage({ id, cmd, args }, transfer || []); }); }
async function gunzipB64(b64) { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); return new Uint8Array(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()); }
async function catalog() { if (!S.catalog) S.catalog = JSON.parse(new TextDecoder().decode(await gunzipB64($("#catalog").textContent.trim()))); return S.catalog; }

// ------------------------------------------------------------------ inputs
function msg(html, cls = "note") { $("#msg").className = cls; $("#msg").innerHTML = html; }
function setSt(id, html, cls = "") { $(id).innerHTML = cls ? `<span class="${cls}">${html}</span>` : html; }
async function loadInputs(args, label) {
  if (S.running) { msg("Stop the run first, then load files.", "err"); return false; }
  args.catalog = await catalog();
  msg(`Reading ${esc(label)}…`);
  try {
    const r = await call("load", args);
    if (r.dem) { S.dem = r.dem; S.grid = null; S.resultsOnly = false; S.loadedFrom = null; clearResults(); }
    if (r.buildings) S.bld = r.buildings.count ? r.buildings : null;
    if (r.boundaries) S.bnd = r.boundaries.count ? r.boundaries : null;
    if ("inlets" in r) S.inl = r.inlets;
    if ("landcover" in r) S.lc = r.landcover; if ("soils" in r) S.soil = r.soils;
    if ("swmm" in r) S.swmm = r.swmm;
    refreshInputs(); msg(`Loaded ${esc(label)}.`);
    return true;
  } catch (e) { msg(`Could not read ${esc(label)}: ${esc(String(e.message).replace(/\.+$/, ""))}. Nothing was changed; the layers loaded before are still in use.`, "err"); return false; }
}
function vUnitFt() { const v = $("#vunit").value; if (v !== "auto") return UNIT_FT[v]; return S.dem && S.dem.vUnitHint ? UNIT_FT[S.dem.vUnitHint] : S.dem ? S.dem.hUnitFt : NaN; }
function unitName(ft) { return Math.abs(ft - 1) < 1e-5 ? "ft" : Math.abs(ft - 1 / 0.3048) < 1e-6 ? "m" : Math.abs(ft - UNIT_FT["us-ft"]) < 1e-9 ? "US survey ft" : `${ft} ft`; }
function refreshInputs() {
  const d = S.dem;
  if (d) {
    const crs = d.epsg ? `EPSG ${d.epsg}${d.crsName ? " (" + esc(d.crsName) + ")" : ""}` : "<span class='err'>CRS unknown</span>";
    setSt("#st-dem", `${d.nx.toLocaleString()} × ${d.ny.toLocaleString()} cells of ${fmt(d.res, 2)} ${Number.isFinite(d.hUnitFt) ? unitName(d.hUnitFt) : "units"}; ${crs}; ground ${fmt(d.zmin * vUnitFt(), 1)} to ${fmt(d.zmax * vUnitFt(), 1)} ft${d.valid < d.nx * d.ny ? `; ${(d.nx * d.ny - d.valid).toLocaleString()} cells without data` : ""}`);
    $("#crs-box").hidden = !!d.proj4;
    if (d.vUnitHint) $("#vunit").title = `The file says ${d.vUnitHint}`;
    fillCellSizes();
  }
  setSt("#st-bld", S.bld ? `${S.bld.count.toLocaleString()} footprints, ${esc(S.bld.note)}` : "none");
  setSt("#st-bnd", S.bnd ? `${S.bnd.count} polygons, ${esc(S.bnd.note)}` : "none");
  const sw = S.swmm;
  if (sw) {
    const inside = sw.nodes.filter((n) => n.inside).length;
    setSt("#st-inp", `${sw.nodes.length} nodes (${inside} inside the DEM), ${sw.links.length} links, ${sw.flowUnits}; ${sw.start ? sw.start.replace("T", " ").slice(0, 16) : "?"} for ${fmt(sw.hours, 2)} h` + (sw.warnings.length ? `<br><span class="warn">${sw.warnings.slice(0, 3).map(esc).join("<br>")}</span>` : ""));
    if (sw.hasOut) { const fl = sw.nodes.filter((n) => n.peakCfs > 0); setSt("#st-out", `${sw.out.nPeriods} reports every ${sw.out.stepSec / 60} min; ${fl.length} nodes flood (peak ${fmt(Math.max(0, ...fl.map((n) => n.peakCfs)), 1)} cfs, ${fmt(fl.reduce((s, n) => s + n.floodCf, 0) / 43560, 2)} ac-ft in all)`); }
    else setSt("#st-out", "none");
    $("#gauge").innerHTML = sw.rain.map((g) => `<option value="${esc(g.name)}" ${g.error ? "disabled" : ""}>${esc(g.name)}${g.error ? " – " + esc(g.error) : ` – ${fmt(g.totalIn, 2)} in`}</option>`).join("");
    if (sw.hours && !S._tSet) { $("#t1").value = +sw.hours.toFixed(2); S._tSet = true; }
  } else { setSt("#st-inp", "none"); setSt("#st-out", "none"); $("#gauge").innerHTML = ""; }
  const co = $("#coupling"); co.options[1].disabled = !(sw && sw.hasOut); co.options[2].disabled = !sw;
  if (co.selectedOptions[0].disabled) co.value = "off";
  $("#swmm-note").textContent = !sw ? "Load a SWMM .inp to use it" : sw.hasOut ? "One way reads the .out; two way runs SWMM 5.2.4 in the page" : "Two way runs SWMM 5.2.4 in the page; one way needs the .out";
  boundaryTable(); surfaceTables(); waterNotes();
  if (S.inl) { const known = S.swmm ? S.inl.nodes.filter((n) => S.swmm.nodes.some((x) => x.name === n && x.type === "JUNCTION")) : []; const unknown = S.inl.nodes.filter((n) => known.indexOf(n) < 0);
    setSt("#st-inl", `${S.inl.count} inlets on ${S.inl.nodes.length} junctions${S.inl.reprojected ? `, ${esc(S.inl.note)}` : ""}${S.inl.skipped ? `; ${S.inl.skipped} features that are not points were skipped` : ""}` + (S.swmm && unknown.length ? `<br><span class="warn">Not junctions in the .inp: ${unknown.slice(0, 6).map(esc).join(", ")}</span>` : "") + (S.inl.typeNote ? `<br><span class="warn">${esc(S.inl.typeNote)}.</span>` : "")); }
  else setSt("#st-inl", "none");
  $("#st-data").textContent = d ? "DEM loaded" + (S.bld ? ", buildings" : "") + (S.bnd ? ", boundaries" : "") + (sw ? ", SWMM" : "") : "nothing loaded";
  $("#b-run").disabled = !d || S.running || S.resultsOnly || (!d.proj4 && !Number.isFinite(d.hUnitFt));
  if (d) mapInputs();
}
function fillCellSizes() {
  const d = S.dem, cur = +$("#cell").value || 0; let html = "", pick = null;
  for (const f of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20]) {
    const nx = Math.floor(d.nx / f), ny = Math.floor(d.ny / f), n = nx * ny; if (nx < 3 || ny < 3) break;
    const cs = +(d.res * f).toFixed(6), ft = cs * (d.hUnitFt || NaN);
    html += `<option value="${cs}" ${n > 8e6 ? "disabled" : ""}>${fmt(cs, cs < 10 ? 2 : 1)} ${Number.isFinite(d.hUnitFt) ? unitName(d.hUnitFt) : ""} – ${(n / 1e6).toFixed(n < 1e5 ? 3 : 2)} M cells</option>`;
    if (pick === null && n <= 1.2e6) pick = cs;
  }
  $("#cell").innerHTML = html; $("#cell").value = cur && [...$("#cell").options].some((o) => +o.value === cur) ? cur : pick;
  cellNote();
}
function cellNote() { const d = S.dem; if (!d) return; const cs = +$("#cell").value, f = Math.round(cs / d.res); $("#cell-note").textContent = `${fmt(cs * d.hUnitFt, 1)} ft; ${Math.floor(d.nx / f)} × ${Math.floor(d.ny / f)} cells`; $("#st-grid").textContent = `${fmt(cs * d.hUnitFt, 1)} ft cells`; }
// land cover classes present and soil groups: editable tables (defaults from the NLCD and HSG tables in model.js)
function surfaceTables() {
  const lc = S.lc, so = S.soil;
  setSt("#st-lc", lc ? `${lc.nx} × ${lc.ny} cells of ${fmt(lc.res, 1)}; ${lc.epsg ? "EPSG " + lc.epsg : "CRS unknown (taken as the DEM's)"}; classes ${lc.classes.join(", ")}${lc.crsNote ? `<br><span class="warn">${esc(lc.crsNote)}</span>` : ""}` : "none");
  setSt("#st-soil", so ? (so.kind === "polygons" ? `${so.count} polygons (${Object.entries(so.groups).map(([g, n]) => `${g}: ${n}`).join(", ")}), ${esc(so.note)}` : `${so.nx} × ${so.ny} raster of groups (${Object.entries(so.groups || {}).map(([g, n]) => `${g}: ${n.toLocaleString()}`).join(", ")}), ${esc(so.note)}`) : "none");
  $("#lc-box").hidden = !lc; $("#soil-box").hidden = !so;
  if (lc) {
    const prev = S.lcTable || {};
    $("#lc-table").innerHTML = `<table class="t"><thead><tr><th>Class</th><th class="n">Manning n</th><th class="n">Impervious %</th></tr></thead><tbody>` + lc.classes.map((c) => {
      const d = FloodModel.NLCD[c], e = prev[c] || (d ? { n: d[1], imp: d[2] } : { n: "", imp: "" });
      return `<tr><td>${c}${d ? " " + esc(d[0]) : " (not an NLCD code)"}</td><td class="n"><input type="number" class="lc-n" data-c="${c}" min="0.005" max="1" step="0.001" value="${e.n}" aria-label="Manning n for class ${c}"></td><td class="n"><input type="number" class="lc-i" data-c="${c}" min="0" max="100" step="1" value="${e.imp}" aria-label="Impervious percent for class ${c}"></td></tr>`;
    }).join("") + "</tbody></table>";
  }
  if (so) {
    const prev = S.soilTable || FloodModel.HSG;
    $("#soil-table").innerHTML = `<table class="t"><thead><tr><th>Group</th><th class="n">Ks (in/hr)</th><th class="n">Suction (in)</th><th class="n">IMD</th></tr></thead><tbody>` + [1, 2, 3, 4].map((g) => {
      const e = prev[g], d = FloodModel.HSG[g];
      return `<tr><td>${d.name} <span class="note">${esc(d.texture)}</span></td><td class="n"><input type="number" class="so-k" data-g="${g}" min="0" max="50" step="0.01" value="${e.ks}" aria-label="Ks for group ${d.name}"></td><td class="n"><input type="number" class="so-s" data-g="${g}" min="0" max="50" step="0.01" value="${e.suction}" aria-label="Suction for group ${d.name}"></td><td class="n"><input type="number" class="so-m" data-g="${g}" min="0" max="0.6" step="0.001" value="${e.imd}" aria-label="IMD for group ${d.name}" title="Default: porosity − field capacity of ${esc(d.texture)}; at most ${d.imdMax} (porosity − wilting point)"></td></tr>`;
    }).join("") + "</tbody></table>";
  }
}
function readSurfaceTables() {
  let lcTable = null, soilTable = null;
  if (S.lc) { lcTable = {}; for (const c of S.lc.classes) { const nEl = document.querySelector(`.lc-n[data-c="${c}"]`), iEl = document.querySelector(`.lc-i[data-c="${c}"]`); if (nEl.value === "" && iEl.value === "") continue;   // both blank: the class uses the global values (the build reports it)
    const n = parseFloat(nEl.value), imp = parseFloat(iEl.value); if (!(n >= 0.005 && n <= 1) || !(imp >= 0 && imp <= 100)) throw new Error(`Land cover class ${c}: Manning n must be 0.005–1 and impervious 0–100%`); lcTable[c] = { n, imp }; } }
  if (S.soil) { soilTable = {}; for (const g of [1, 2, 3, 4]) { const ks = parseFloat(document.querySelector(`.so-k[data-g="${g}"]`).value), suction = parseFloat(document.querySelector(`.so-s[data-g="${g}"]`).value), imd = parseFloat(document.querySelector(`.so-m[data-g="${g}"]`).value);
    if (!(ks >= 0 && ks <= 50) || !(suction >= 0 && suction <= 50) || !(imd >= 0 && imd <= 0.6)) throw new Error(`Soil group ${"ABCD"[g - 1]}: Ks (0–50 in/hr), suction (0–50 in) and IMD (0–0.6) must be numbers in range`); soilTable[g] = { name: "ABCD"[g - 1], ks, suction, imd }; } }
  S.lcTable = lcTable; S.soilTable = soilTable; return { lcTable, soilTable };
}
function boundaryTable() {
  const el = $("#bnd-table"); if (!S.bnd) { el.innerHTML = ""; S.bspec = []; return; }
  const nodes = S.swmm ? S.swmm.nodes.filter((n) => n.type === "STORAGE" || n.type === "OUTFALL").concat(S.swmm.nodes.filter((n) => n.type !== "STORAGE" && n.type !== "OUTFALL")) : [];
  const prev = S.bspecTouched ? S.bspec || [] : [];   // until the user changes a row, defaults follow the files (a node named in the polygon once the SWMM files arrive)
  const ROUTED = "__routed__";
  el.innerHTML = `<table class="t"><thead><tr><th>Polygon</th><th>Water level from</th><th class="n">Level (ft)</th><th class="n">Lake area (ac)</th></tr></thead><tbody>` + S.bnd.props.map((p, i) => {
    const name = p.name || p.node || `Boundary ${i + 1}`, pv = prev[i] || {};
    const routed = pv.routed !== undefined ? pv.routed : /^(yes|true|1|routed)$/i.test(String(p.routed ?? ""));
    const node = routed ? ROUTED : pv.node !== undefined ? pv.node || "" : (p.node && nodes.some((n) => n.name === p.node) ? p.node : "");
    const lvl = pv.level !== undefined ? pv.level : (p.level_ft ?? p.level ?? ""), area = pv.areaAc !== undefined ? pv.areaAc : (p.area_ac ?? "");
    return `<tr><td>${esc(name)}</td><td><select data-b="${i}" class="b-src" aria-label="Level source for ${esc(name)}"><option value="">Fixed level</option><option value="${ROUTED}" ${routed ? "selected" : ""}>Routed: rises with the water it gains</option>${nodes.map((n) => `<option value="${esc(n.name)}" ${n.name === node ? "selected" : ""}>SWMM ${esc(n.type.toLowerCase())} ${esc(n.name)}</option>`).join("")}</select></td>
      <td class="n"><input type="number" step="0.01" data-b="${i}" class="b-lvl" value="${esc(lvl)}" ${node && node !== ROUTED ? "disabled" : ""} aria-label="Level (fixed, or the starting level if routed) for ${esc(name)}"></td>
      <td class="n"><input type="number" step="0.1" min="0" data-b="${i}" class="b-area" value="${esc(area)}" placeholder="in grid" ${routed ? "" : "disabled"} aria-label="Lake surface area for ${esc(name)} (blank: the part inside the grid)"></td></tr>`;
  }).join("") + "</tbody></table>";
  const read = () => { S.bspec = S.bnd.props.map((p, i) => { const src = el.querySelector(`.b-src[data-b="${i}"]`).value, a = el.querySelector(`.b-area[data-b="${i}"]`).value;
    return { index: i, key: p.name || p.node || `Boundary ${i + 1}`, node: src && src !== ROUTED ? src : null, routed: src === ROUTED, areaAc: a === "" ? undefined : parseFloat(a), level: parseFloat(el.querySelector(`.b-lvl[data-b="${i}"]`).value) }; }); };
  el.querySelectorAll(".b-src").forEach((s) => s.onchange = () => { const b = s.dataset.b; el.querySelector(`.b-lvl[data-b="${b}"]`).disabled = !!s.value && s.value !== ROUTED; el.querySelector(`.b-area[data-b="${b}"]`).disabled = s.value !== ROUTED; S.bspecTouched = true; read(); });
  el.querySelectorAll(".b-lvl, .b-area").forEach((s) => s.oninput = () => { S.bspecTouched = true; read(); });
  read();
}
function waterNotes() {
  const r = $("#rain").value; $("#rain-gauge").hidden = r !== "gauge"; $("#rain-uniform").hidden = r !== "uniform";
  const cp = $("#coupling").value; $("#two-box").hidden = cp !== "two";
  // rain on the grid counts runoff twice only when SWMM also makes runoff from that gauge in its own subcatchments
  const sw = S.swmm, gauge = $("#gauge").value;
  $("#double-warn").hidden = !(r === "gauge" && cp !== "off" && sw && sw.subcatchments > 0 && (!sw.subcatchmentGauges || sw.subcatchmentGauges.includes(gauge)));
  const parts = []; if (cp === "one") parts.push("SWMM flooding (one way)"); if (cp === "two") parts.push("SWMM two way"); if (r !== "none") parts.push(r === "gauge" ? "gauge rain" : "uniform rain");
  $("#st-water").textContent = parts.join(" + ") || "none chosen";
}
async function readFile(inp, kind) {
  const f = inp.files[0]; if (!f) return null;
  if (f.size > 600e6) throw new Error(`${f.name} is ${(f.size / 1e6).toFixed(0)} MB; prepare a smaller file first (python/prep_dem.py)`);
  return kind === "text" ? await f.text() : await f.arrayBuffer();
}
function wireInputs() {
  // a new DEM starts a new site: every other layer is cleared, so nothing from an earlier site or example is used by mistake
  // (the old site's settings are cleared only once the new DEM has been read; a DEM that fails to load changes nothing)
  $("#f-dem").onchange = async (e) => { try { const b = await readFile(e.target, "bin"); if (!b) return;
    const had = !!(S.bld || S.bnd || S.lc || S.soil || S.inl || S.swmm), name = e.target.files[0].name;
    const ok2 = await loadInputs({ dem: b, buildings: null, boundaries: null, landcover: null, soils: null, inlets: null, inp: null, out: null }, name);
    if (!ok2) { e.target.value = ""; return; }
    S.exName = null; S.bspec = null; S.bspecTouched = false; S.lcTable = null; S.soilTable = null; S._tSet = false;
    ["#f-bld", "#f-bnd", "#f-lc", "#f-soil", "#f-inl", "#f-inp", "#f-out"].forEach((s2) => ($(s2).value = ""));
    refreshInputs();
    if (had) msg(`Loaded ${esc(name)}. The layers loaded for the previous ground were cleared; add the ones for this site.`);
  } catch (x) { msg(esc(x.message), "err"); } };
  const needDem = (e) => { if (S.dem && !S.resultsOnly) return true; msg(S.resultsOnly ? "Saved results are open; load a DEM to start a new run." : "Load the DEM first.", "err"); e.target.value = ""; return false; };
  // a refused file clears its own file box; the layer loaded before stays in use (the worker keeps it, and so do the tables)
  const keep = (e, ok2) => { if (!ok2) e.target.value = ""; return ok2; };
  $("#f-bld").onchange = async (e) => { if (!needDem(e)) return; keep(e, await loadInputs({ buildings: await readFile(e.target, "text") }, e.target.files[0].name)); };
  $("#f-bnd").onchange = async (e) => { if (!needDem(e)) return; const prev = S.bspecTouched; S.bspecTouched = false; if (!keep(e, await loadInputs({ boundaries: await readFile(e.target, "text") }, e.target.files[0].name))) S.bspecTouched = prev; };
  $("#f-lc").onchange = async (e) => { if (!needDem(e)) return; const prev = S.lcTable; if (keep(e, await loadInputs({ landcover: await readFile(e.target, "bin") }, e.target.files[0].name))) { S.lcTable = null; surfaceTables(); } else S.lcTable = prev; };
  $("#f-soil").onchange = async (e) => { if (!needDem(e)) return; const f = e.target.files[0];
    if (keep(e, await loadInputs({ soils: /\.tiff?$/i.test(f.name) ? await f.arrayBuffer() : await f.text() }, f.name))) { S.soilTable = null; surfaceTables(); } };
  $("#f-inl").onchange = async (e) => { if (!needDem(e)) return; keep(e, await loadInputs({ inlets: await readFile(e.target, "text") }, e.target.files[0].name)); drawSwmm(); };
  $("#f-inp").onchange = async (e) => { if (!needDem(e)) return; if (keep(e, await loadInputs({ inp: await readFile(e.target, "text"), out: null }, e.target.files[0].name))) $("#f-out").value = ""; };
  $("#f-out").onchange = async (e) => { if (!S.swmm) { msg("Load the SWMM .inp first.", "err"); e.target.value = ""; return; } const ok2 = keep(e, await loadInputs({ out: await readFile(e.target, "bin") }, e.target.files[0].name)); if (ok2 && S.swmm.hasOut && $("#coupling").value === "off") $("#coupling").value = "one"; refreshInputs(); waterNotes(); };
  $("#crs-epsg").onchange = async (e) => { const v = parseInt(e.target.value, 10); if (!(v > 0)) return; await loadInputs({ epsg: v }, `EPSG ${v}`); };
  $("#vunit").onchange = refreshInputs;
  $("#cell").onchange = cellNote;
  $("#rain").onchange = waterNotes; $("#coupling").onchange = waterNotes; $("#gauge").onchange = waterNotes;
  // values are checked where they are typed: out-of-range numbers are marked and block the run
  document.querySelectorAll("aside input[type=number]").forEach((i) => i.addEventListener("input", () => { const v = +i.value; const bad = i.value === "" || (i.min !== "" && v < +i.min) || (i.max !== "" && v > +i.max); i.style.borderColor = bad ? "var(--bad)" : ""; i.setAttribute("aria-invalid", bad); }));
}
const EX = () => JSON.parse($("#examples").textContent || "[]");
async function loadExample(i) {
  const ex = EX()[i]; if (!ex) return;
  if (S.running) { msg("Stop the run first, then load an example.", "err"); return; }
  msg(`Loading example “${esc(ex.name)}”…`);
  const get = async (k, kind) => { if (!ex.files[k]) return null; const u8 = await gunzipB64(ex.files[k]); return kind === "text" ? new TextDecoder().decode(u8) : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); };
  S._tSet = false; S.bspec = null; S.bspecTouched = false; S.exName = ex.name;
  S.lcTable = null; S.soilTable = null;
  const ok1 = await loadInputs({ inlets: await get("inlets", "text"), dem: await get("dem"), buildings: await get("buildings", "text"), boundaries: await get("boundaries", "text"), landcover: await get("landcover"), soils: await get("soils", "text"), inp: await get("inp", "text"), out: await get("out") }, `example “${ex.name}”`);
  if (!ok1) return;
  if (S.swmm && S.swmm.hasOut) $("#coupling").value = "one";
  $("#rain").value = "none"; $("#basemap").value = ex.basemap || "none";
  // the example's own run settings (coupling, rain, inlets, cell size, window), so it runs as intended with one click
  const st = ex.settings || {}, setv = (id, v) => { if (v !== undefined && v !== null && $(id)) $(id).value = String(v); };
  setv("#coupling", st.coupling); setv("#rain", st.rain); setv("#def-inl", st.defaultInlets === undefined ? undefined : st.defaultInlets ? "1" : "0"); setv("#t0", st.t0); setv("#t1", st.t1); setv("#outmin", st.outputMin);
  if (st.t1 !== undefined) S._tSet = true;
  waterNotes(); refreshInputs();
  if (st.gauge) setv("#gauge", st.gauge);
  if (st.cellFt && S.dem) { const want = [...$("#cell").options].find((op) => Math.abs(+op.value * S.dem.hUnitFt - st.cellFt) < 0.01 * st.cellFt); if (want) { $("#cell").value = want.value; cellNote(); } }
  waterNotes();
  ["#f-dem", "#f-bld", "#f-bnd", "#f-lc", "#f-soil", "#f-inl", "#f-inp", "#f-out"].forEach((s) => ($(s).value = ""));
  msg(`Loaded example “${esc(ex.name)}”. ${esc(ex.note || "")}${ex.settings && Object.keys(ex.settings).length ? " Its run settings are filled in." : ""} Press Run.`);
}

// ------------------------------------------------------------------ run
function numIn(id, what) { const el = $(id), v = parseFloat(el.value); if (!Number.isFinite(v) || (el.min !== "" && v < +el.min) || (el.max !== "" && v > +el.max)) throw new Error(`${what}: “${el.value}” is outside ${el.min}–${el.max}`); return v; }
function runOptions() {
  const d = S.dem, o = {};
  o.cellSize = +$("#cell").value; o.vUnitFt = vUnitFt(); o.useBuildings = $("#use-bld").value === "1"; o.roofToGround = $("#roof").value === "1"; o.closedEdges = $("#edges").value === "closed";
  if (!Number.isFinite(o.vUnitFt)) throw new Error("Choose the elevation units");
  Object.assign(o, readSurfaceTables()); o.useLandcover = !!S.lc; o.useSoils = !!S.soil;
  o.imperv = numIn("#imp", "Impervious fraction") / 100; o.nImp = numIn("#n-imp", "Manning n impervious"); o.nPerv = numIn("#n-perv", "Manning n pervious");
  o.ksInHr = numIn("#ks", "Ks"); o.suctionIn = numIn("#psi", "Suction head"); o.imd = numIn("#imd", "Initial moisture deficit");
  o.coupling = $("#coupling").value; o.useSwmmFlooding = o.coupling === "one"; o.rainSource = $("#rain").value; o.gauge = $("#gauge").value;
  if (o.coupling === "one" && !(S.swmm && S.swmm.hasOut)) throw new Error("One-way coupling needs the SWMM .out file");
  if (o.coupling === "two") { o.lw = numIn("#lw", "Inlet weir length"); o.cw = numIn("#cw", "Weir coefficient"); o.inletArea = numIn("#ia", "Inlet orifice area"); o.co = numIn("#co", "Orifice coefficient"); o.clog = numIn("#clog", "Clogging") / 100; o.couplingSec = numIn("#csec", "Coupling interval"); o.defaultInlets = $("#def-inl").value === "1"; }
  if (o.rainSource === "uniform") { o.rainInHr = numIn("#rain-ih", "Rain intensity"); o.rainHours = numIn("#rain-h", "Rain duration"); }
  if (o.rainSource === "gauge" && !S.swmm) throw new Error("Rain from a gauge needs the SWMM .inp");
  o.t0 = numIn("#t0", "Start"); o.t1 = numIn("#t1", "End"); if (!(o.t1 > o.t0)) throw new Error("The end must be after the start");
  o.outputSec = numIn("#outmin", "Map interval") * 60; o.engine = $("#engine").value; o.cfl = numIn("#cfl", "Courant number");
  o.wetFt = numIn("#wet", "Wet depth"); o.buildingFt = numIn("#bthr", "Building depth");
  o.boundaries = (S.bspec || []).map((b) => { if (!b.node && !Number.isFinite(b.level)) throw new Error(`Give a level or a SWMM node for boundary “${b.key}”`); return b; });
  if (o.coupling === "off" && o.rainSource === "none" && !o.boundaries.length) throw new Error("Choose at least one water source (SWMM coupling, rain or a level boundary)");
  // two-way with no rain on the grid: water can only come from SWMM itself (its subcatchments or its own inflows)
  if (o.coupling === "two" && o.rainSource === "none" && S.swmm && !S.swmm.subcatchments && !S.swmm.otherInflows)
    throw new Error("No water would enter this run: the SWMM model has no subcatchments or inflows of its own, and there is no rain on the grid. Set “Rain on the grid” (for example to the SWMM rain gauge)");
  if (o.coupling !== "two" && o.boundaries.some((b) => b.node) && !(S.swmm && S.swmm.hasOut)) throw new Error("A boundary level from a SWMM node needs the .out file (or two-way coupling)");
  const nFrames = Math.ceil((o.t1 - o.t0) * 3600 / o.outputSec) + 1, f = Math.round(o.cellSize / d.res), cells = Math.floor(d.nx / f) * Math.floor(d.ny / f);
  if (nFrames * cells > 400e6) throw new Error(`Storing ${nFrames} maps of ${(cells / 1e6).toFixed(1)} M cells needs too much memory; map less often or use larger cells`);
  return o;
}
async function run() {
  let o; try { o = runOptions(); } catch (e) { msg(esc(e.message), "err"); return; }
  S.running = true; $("#b-run").disabled = true; $("#b-stop").disabled = false; clearResults(); $("#warns").innerHTML = "";
  try {
    msg("Building the grid…");
    const gr = await call("build", o);
    S.grid = gr; S.grid.opts = o;
    if (gr.warnings.length) $("#warns").innerHTML = gr.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("");
    mapGrid();
    msg(`Grid ${gr.G.nx} × ${gr.G.ny} (${(gr.info.open / 1e6).toFixed(2)} M open cells)${S.lc ? `; land cover on ${gr.info.landcoverCells.toLocaleString()} cells` : ""}${S.soil ? `; soils on ${gr.info.soilCells.toLocaleString()} cells` : ""}. Starting…`);
    const t0 = performance.now();
    const res = await call("run", o, [], (m) => {
      if (m.frame) { S.frames.push({ q: new Uint8Array(m.frame.q), sum: m.frame.sum }); onFrame(); return; }
      const p = m.progress;
      if (p.phase === "start") { S.sources = p.sources; S.nodeMap = p.nodeMap; if (p.warnings.length) $("#warns").innerHTML += p.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join(""); }
      else if (p.phase === "note") $("#warns").innerHTML += `<div class="warn">${esc(p.text)}</div>`;
      else if (p.phase === "run") {
        $("#pbar").style.width = `${Math.min(100, 100 * p.frac).toFixed(1)}%`;
        const eta = p.frac > 0 ? (p.wall / p.frac - p.wall) : NaN;
        msg(`${p.kind === "gpu" ? "GPU" : "CPU"}: ${fmt(p.tHours, 2)} h simulated, ${fmt(p.speed, 1)}× real time, time step ${fmt(p.dt, 2)} s; about ${eta > 90 ? fmt(eta / 60, 0) + " min" : fmt(eta, 0) + " s"} left. Water balance closes within ${fmt(Math.abs(p.closurePct), 4)}%.`);
      }
    });
    S.final = res; $("#pbar").style.width = "100%";
    msg(`${res.stopped ? "<b>Stopped early.</b> " : "Done: "}${res.steps.toLocaleString()} time steps in ${fmt(res.wall, 1)} s on the ${res.kind === "gpu" ? "GPU" : "CPU"}; water balance closes within ${fmt(Math.abs(res.ledger.errPct), 4)}%.`, res.stopped ? "warn" : "note");
    S.view = $("#view").value; renderAll();
    ["#x-tif", "#x-csv", "#x-nodes", "#x-save", "#b-cmp"].forEach((s) => ($(s).disabled = false)); $("#x-nodes").disabled = !(S.sources && S.sources.length);
  } catch (e) { msg(`Run failed: ${esc(e.message)}`, "err"); }
  finally { S.running = false; $("#b-run").disabled = false; $("#b-stop").disabled = true; }
}
function clearCompare() { S.cmp = null; $("#view-diff").disabled = true; $("#view-diff").hidden = true; $("#b-cmp-clear").hidden = true; $("#cmp-note").hidden = true; if (S.view === "diff") { S.view = "max"; $("#view").value = "max"; } }
async function compareWith(file) {
  if (!S.final || !S.grid) { msg("Run the model or open saved results first, then compare.", "err"); return; }
  try {
    const r = await RIO.unpack(await file.arrayBuffer());
    const c = RIO.compare(S.grid, S.final, r.grid, r.final, S.grid.opts.wetFt, 0.1);
    S.cmp = { name: file.name, c, saved: r.h.saved };
    $("#view-diff").disabled = false; $("#view-diff").hidden = false; $("#b-cmp-clear").hidden = false;
    $("#cmp-note").hidden = false;
    $("#cmp-note").innerHTML = `Compared with <b>${esc(file.name)}</b> (saved ${esc((r.h.saved || "").slice(0, 16).replace("T", " "))}): ${fmt(c.acres.compared, 1)} ac of open ground in both runs.` +
      (c.typeDiffers ? ` <span class="warn">${c.typeDiffers.toLocaleString()} cells are ground in one run and a building, wall or lake in the other; they are left out.</span>` : "");
    S.view = "diff"; $("#view").value = "diff"; paint();
    msg(`Comparing with ${esc(file.name)}. Choose “Change in maximum depth” under Show to see it again.`);
  } catch (e) { msg(`Could not compare: ${esc(e.message)}`, "err"); }
}
function clearResults() { clearCompare(); $("#b-cmp").disabled = true; S.frames = []; S.final = null; S.frame = 0; S.sel = -1; $("#slider").max = 0; $("#slider").disabled = true; $("#b-play").disabled = true; ["#x-tif", "#x-csv", "#x-nodes", "#x-save"].forEach((s) => ($(s).disabled = true)); $("#kpis").innerHTML = ""; $("#ledger").textContent = "Run the model to see where the water went."; }
let lastPaint = 0;
function onFrame() {
  const n = S.frames.length; $("#slider").max = n - 1; $("#slider").disabled = false; $("#b-play").disabled = false;
  if (S.view === "now" && (performance.now() - lastPaint > 400)) { S.frame = n - 1; $("#slider").value = n - 1; lastPaint = performance.now(); paint(); }
}

// ------------------------------------------------------------------ geometry for the map
let P4 = null;
function proj() { if (!S.dem || !S.dem.proj4) return null; if (!P4 || P4._p !== S.dem.proj4) { P4 = proj4(S.dem.proj4, "EPSG:4326"); P4._p = S.dem.proj4; } return P4; }
const geoMode = () => (proj() ? "geo" : "local");
function toLL(x, y) { const p = proj(); if (!p) return L.latLng(y, x); const q = p.forward([x, y]); return L.latLng(q[1], q[0]); }
function fromLL(ll) { const p = proj(); if (!p) return [ll.lng, ll.lat]; return p.inverse([ll.lng, ll.lat]); }
let MAP = null;
function ensureMap() {
  const mode = geoMode();
  if (MAP && MAP._mode === mode) return MAP;
  if (MAP) { MAP.remove(); MAP = null; }
  $("#map").innerHTML = "";
  MAP = L.map("map", { crs: mode === "geo" ? L.CRS.EPSG3857 : L.CRS.Simple, minZoom: mode === "geo" ? 3 : -8, maxZoom: mode === "geo" ? 21 : 8, preferCanvas: true, zoomSnap: 0.25 });
  MAP._mode = mode; MAP._layers2 = {};
  MAP.on("click", onMapClick);
  $("#bm-wrap").hidden = mode !== "geo";
  setBasemap();
  return MAP;
}
function setBasemap() {
  if (!MAP) return; if (MAP._bm) { MAP.removeLayer(MAP._bm); MAP._bm = null; }
  const v = $("#basemap").value; if (MAP._mode !== "geo" || v === "none") return;
  MAP._bm = v === "osm" ? L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, maxNativeZoom: 19, attribution: "© OpenStreetMap contributors" })
    : L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}", { maxZoom: 21, maxNativeZoom: 16, attribution: "USGS The National Map" });
  MAP._bm.addTo(MAP).bringToBack();
}
function mapInputs() {
  const m = ensureMap(), d = S.dem, b = d.bounds;
  for (const k of ["frame", "bld", "bnd", "swmm"]) if (m._layers2[k]) { m.removeLayer(m._layers2[k]); delete m._layers2[k]; }
  const ring = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]].map(([x, y]) => toLL(x, y));
  m._layers2.frame = L.polyline(ring, { color: css("--muted"), weight: 1, dashArray: "4 4", interactive: false }).addTo(m);
  if (!m._fitted || m._fitted !== d) { m.fitBounds(L.latLngBounds(ring), { animate: false }); m._fitted = d; }
  const cvt = (rings) => rings.map((r) => r.map((p) => toLL(p[0], p[1])));
  if (S.bld) {
    const polys = []; for (const f of S.bld.feats) { const g = f.geometry; if (g.type === "Polygon") polys.push(cvt(g.coordinates)); else if (g.type === "MultiPolygon") for (const p of g.coordinates) polys.push(cvt(p)); }
    m._layers2.bld = L.layerGroup(polys.map((p) => L.polygon(p, { weight: 0.6, color: css("--muted"), fillColor: css("--surface"), fillOpacity: 0.6, interactive: false }))).addTo(m);
  }
  if (S.bnd) m._layers2.bnd = L.layerGroup(S.bnd.feats.map((f) => { const g = f.geometry, rs = g.type === "Polygon" ? [g.coordinates] : g.coordinates; return L.polygon(rs.map(cvt), { color: css("--bnd"), weight: 1.5, dashArray: "5 3", fill: false, interactive: false }); })).addTo(m);
  drawSwmm();
}
function drawSwmm() {
  const m = MAP; if (!m) return; if (m._layers2.swmm) { m.removeLayer(m._layers2.swmm); delete m._layers2.swmm; }
  const sw = S.swmm, g = L.layerGroup();
  if (S.inl) for (const [x, y, node] of S.inl.pts) g.addLayer(L.circleMarker(toLL(x, y), { radius: 3, color: css("--accent"), weight: 2, fill: true, fillColor: css("--surface"), fillOpacity: 1 }).bindTooltip(`Inlet to ${esc(node)}`));
  if (!sw) { if (S.inl) m._layers2.swmm = g.addTo(m); return; }
  const idx = {}; sw.nodes.forEach((n) => (idx[n.name] = n));
  for (const l of sw.links) { const a = idx[l.from], b = idx[l.to]; if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(b.x)) continue; g.addLayer(L.polyline([[a.x, a.y], ...l.verts, [b.x, b.y]].map((p) => toLL(p[0], p[1])), { color: css("--link"), weight: 2, opacity: 0.8, interactive: false })); }
  const t = curT();
  for (const n of sw.nodes) {
    if (!Number.isFinite(n.x)) continue;
    const q = rateNow(n), fl = n.peakCfs > 0 || q !== 0;
    const mk = L.circleMarker(toLL(n.x, n.y), { radius: n.type === "JUNCTION" ? (q > 0 ? 5 + Math.min(9, Math.sqrt(q)) : 4) : 6, color: fl ? css("--node") : css("--link"), weight: 2, fillColor: q > 0 ? css("--node") : css("--surface"), fillOpacity: 0.9 });
    mk.bindTooltip(() => `<b>${esc(n.name)}</b> (${esc(n.type.toLowerCase())})<br>Rim ${fmt(n.rimFt, 2)} ft, invert ${fmt(n.invertFt, 2)} ft` + (S.frames.length || sw.hasOut ? `<br>Exchange now ${fmt(rateNow(n), 2)} cfs (+ out of SWMM)` : "") + (sw.hasOut ? `<br>.out flooding: peak ${fmt(n.peakCfs, 2)} cfs; volume ${fmt(n.floodCf, 0)} cf` : "") + (nodeStatus(n.name) ? `<br><i>${esc(nodeStatus(n.name))}</i>` : ""));
    g.addLayer(mk);
  }
  m._layers2.swmm = g.addTo(m);
}
// exchange at a node in the selected map (cfs, + out of SWMM onto the ground); before a run, the .out flooding (one way)
function rateNow(n) { const f = S.frames[S.frame]; if (f && S.sources) { const i = S.sources.findIndex((s) => s.name === n.name); return i >= 0 && f.sum.rates ? f.sum.rates[i] : 0; } return S.swmm.hasOut ? nodeFloodAt(n, curT()) : 0; }
function nodeStatus(name) { const r = (S.nodeMap || []).find((x) => x.name === name); return r ? r.status : ""; }
function nodeFloodAt(n, tHours) { const sw = S.swmm; if (!n.flood || !sw.out) return 0; const step = sw.out.stepSec / 3600, x = (tHours - sw.out.t0Hours) / step - 1; if (x < -1) return 0; if (x < 0) return n.flood[0] * (x + 1); if (x >= n.flood.length - 1) return n.flood[n.flood.length - 1]; const i = Math.floor(x), w = x - i; return n.flood[i] * (1 - w) + n.flood[i + 1] * w; }
function curT() { const f = S.frames[S.frame]; return f ? f.sum.tHours : +$("#t0").value || 0; }

// overlay image: pixel grid over the grid's lat/lng box (Web Mercator rows), each pixel looks up its grid cell
function overlayLUT() {
  const gr = S.grid, G = gr.G; if (gr._lut) return gr._lut;
  const corners = [[G.x0, G.y1], [G.x0 + G.nx * G.cs, G.y1], [G.x0, G.y1 - G.ny * G.cs], [G.x0 + G.nx * G.cs, G.y1 - G.ny * G.cs]];
  if (geoMode() === "local") { gr._lut = { simple: true, bounds: L.latLngBounds([L.latLng(G.y1 - G.ny * G.cs, G.x0), L.latLng(G.y1, G.x0 + G.nx * G.cs)]), W: G.nx, H: G.ny }; return gr._lut; }
  // sample the edges densely for the bounding box
  const lls = []; for (let i = 0; i <= 20; i++) { const t = i / 20; lls.push(toLL(G.x0 + t * G.nx * G.cs, G.y1), toLL(G.x0 + t * G.nx * G.cs, G.y1 - G.ny * G.cs), toLL(G.x0, G.y1 - t * G.ny * G.cs), toLL(G.x0 + G.nx * G.cs, G.y1 - t * G.ny * G.cs)); }
  void corners;
  const bb = L.latLngBounds(lls), W = Math.min(G.nx, 2048), H = Math.max(1, Math.round(W * G.ny / G.nx));
  const yM = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)), latM = (y) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;
  const y0 = yM(bb.getNorth()), y1 = yM(bb.getSouth()), lut = new Int32Array(W * H), p = proj();
  for (let j = 0; j < H; j++) { const lat = latM(y0 + (j + 0.5) / H * (y1 - y0));
    for (let i = 0; i < W; i++) { const lng = bb.getWest() + (i + 0.5) / W * (bb.getEast() - bb.getWest()), xy = p.inverse([lng, lat]); const c = Math.floor((xy[0] - G.x0) / G.cs), r = Math.floor((G.y1 - xy[1]) / G.cs); lut[j * W + i] = c >= 0 && r >= 0 && c < G.nx && r < G.ny ? r * G.nx + c : -1; } }
  gr._lut = { lut, W, H, bounds: bb }; return gr._lut;
}
function imageFrom(fn) {
  const L0 = overlayLUT(), cv = document.createElement("canvas"); cv.width = L0.W; cv.height = L0.H;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(L0.W, L0.H), px = img.data, G = S.grid.G;
  for (let p = 0; p < L0.W * L0.H; p++) { let k; if (L0.simple) { const j = (p / L0.W) | 0, i = p % L0.W; k = j * G.nx + i; } else k = L0.lut[p]; if (k < 0) continue; fn(k, px, 4 * p); }
  ctx.putImageData(img, 0, 0); return cv.toDataURL("image/png");
}
function mapGrid() {
  const m = ensureMap(), gr = S.grid, G = gr.G, z = gr.z, t = gr.type, dx = G.cs * (S.dem.hUnitFt || 1);
  if (m._layers2.hs) m.removeLayer(m._layers2.hs);
  // hillshade (sun from the north-west, 45 degrees) of the grid ground, walls dark
  let zs = []; for (let k = 0; k < z.length; k += 13) if (!(t[k] === 1 && z[k] === 0)) zs.push(z[k]); zs.sort((a, b) => a - b);
  const zlo = zs[Math.floor(zs.length * 0.02)] || 0, zhi = Math.max(zlo + 1, zs[Math.floor(zs.length * 0.98)] || 1);
  const dk = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const url = imageFrom((k, px, o) => {
    const r = (k / G.nx) | 0, c = k % G.nx; if (t[k] === 1 && gr.z[k] === 0) return;
    const zl = z[r * G.nx + Math.max(c - 1, 0)], zr = z[r * G.nx + Math.min(c + 1, G.nx - 1)], zu = z[Math.max(r - 1, 0) * G.nx + c], zd = z[Math.min(r + 1, G.ny - 1) * G.nx + c];
    // hillshade with 4x relief, sun from the north-west at 45 degrees, over a light elevation tint (low = green-grey, high = sand)
    const sx = 4 * (zr - zl) / (2 * dx), sy = 4 * (zd - zu) / (2 * dx), n = Math.hypot(sx, sy, 1), sh = Math.min(1, Math.max(0, (sx * 0.5 - sy * 0.5 + 0.707) / n));
    const e = Math.min(1, Math.max(0, (z[k] - zlo) / (zhi - zlo))), tint = dk ? [52 + 30 * e, 62 + 22 * e, 58 + 10 * e] : [196 + 40 * e, 210 + 22 * e, 190 + 30 * e];
    const f = (dk ? 0.55 : 0.62) + 0.5 * sh, w = t[k] === 1 ? 0.7 : 1;
    px[o] = Math.min(255, tint[0] * f * w); px[o + 1] = Math.min(255, tint[1] * f * w); px[o + 2] = Math.min(255, tint[2] * f * w); px[o + 3] = $("#basemap").value === "none" ? 255 : 90;
  });
  m._layers2.hs = L.imageOverlay(url, overlayLUT().bounds, { interactive: false, opacity: 1 }).addTo(m);
  m._layers2.hs.bringToBack(); if (m._bm) m._bm.bringToBack();
  if (m._layers2.depth) { m.removeLayer(m._layers2.depth); delete m._layers2.depth; }
}

// ------------------------------------------------------------------ depth display
const DCL = [0.1, 0.25, 0.5, 1, 2, 4];   // ft
const RAMP_L = ["#cfe3f6", "#9cc7ec", "#68a6dd", "#3b82c4", "#1d5d9b", "#0d3a6b"], RAMP_D = ["#9ec9f0", "#73aee6", "#4a91d8", "#2f73bd", "#1e5596", "#123b6c"];
const dark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
const ramp = () => (dark() ? RAMP_D : RAMP_L).map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
function dclass(d) { let c = -1; for (let i = 0; i < DCL.length; i++) if (d >= DCL[i]) c = i; return c; }
const dec = (q) => (q ? 25 * (q / 255) ** 2 : 0);
function depthAt(k) { if (S.view !== "now" && S.final) return S.final.hmax[k]; const f = S.frames[S.frame]; return f ? dec(f.q[k]) : 0; }
// velocity (ft/s) and depth x velocity (ft2/s) maxima: their own sequential ramps so they are never read as depth
const VIEWS = {
  now: { title: "Water depth (ft)", cl: DCL, L: RAMP_L, D: RAMP_D },
  max: { title: "Maximum water depth (ft)", cl: DCL, L: RAMP_L, D: RAMP_D },
  vmax: { title: "Maximum velocity (ft/s)", cl: [0.5, 1, 2, 4, 6, 8], L: ["#e6dcf2", "#cbb6e3", "#ab8dd1", "#8a66bd", "#6a45a0", "#4a2b78"], D: ["#d9c9ef", "#bba2e0", "#9c7ccd", "#7f5ab8", "#63409b", "#472b72"] },
  diff: { title: "Change in maximum depth, this run − compared run (ft)", cl: [-Infinity, -1, -0.5, -0.25, -0.1, 0.1, 0.25, 0.5, 1],
    labels: ["1 or more shallower", "0.5–1 shallower", "0.25–0.5 shallower", "0.1–0.25 shallower", "within 0.1", "0.1–0.25 deeper", "0.25–0.5 deeper", "0.5–1 deeper", "1 or more deeper"],
    L: ["#2c5f8a", "#4f86b5", "#86b0d6", "#bcd4ea", "#d6d5d0", "#f4cfa6", "#eba468", "#d6713a", "#a5471c"], D: ["#5b97cf", "#4d84b8", "#3d6d99", "#2f5677", "#4a4f55", "#7d5434", "#a8653a", "#cf7d43", "#ef9b5c"] },
  dv: { title: "Maximum depth × velocity (ft²/s)", cl: [0.5, 1, 2, 4, 8, 16], L: ["#fde3c8", "#f9c08d", "#f39a52", "#e0702a", "#b4501a", "#7a330f"], D: ["#f6c69b", "#f0a465", "#e5853a", "#cc6624", "#a24c1b", "#73330f"] },
};
// change classes symmetric about zero: |d| < 0.1 is "within 0.1"; a boundary value belongs to the larger change on either side
function diffClass(d) { const e = [0.1, 0.25, 0.5, 1], m = Math.abs(d); let i = -1; for (let j = 0; j < e.length; j++) if (m >= e[j]) i = j; return i < 0 ? 4 : d > 0 ? 5 + i : 3 - i; }
function valueAt(k) { const v = S.view; if ((v === "vmax" || v === "dv") && S.final) return (v === "vmax" ? S.final.vmax : S.final.dvmax)[k]; return depthAt(k); }
function vclass(x, cl) { let c = -1; for (let i = 0; i < cl.length; i++) if (x >= cl[i]) c = i; return c; }
const hex3 = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function paint() {
  if (!S.grid || !S.frames.length) return;
  const m = ensureMap(), rp = ramp(), t = S.grid.type, lake = css("--water"), lc = [parseInt(lake.slice(1, 3), 16), parseInt(lake.slice(3, 5), 16), parseInt(lake.slice(5, 7), 16)];
  const wet = S.grid.opts.wetFt;
  if ((S.view === "vmax" || S.view === "dv") && !S.final) { S.view = "now"; $("#view").value = "now"; }
  if (S.view === "diff" && !S.cmp) { S.view = "max"; $("#view").value = "max"; }
  const V = VIEWS[S.view], vr = (dark() ? V.D : V.L).map(hex3), depthView = S.view === "now" || S.view === "max", hatch = hex3(css("--ink") || "#1b1f24");
  const url = imageFrom((k, px, o) => {
    if (t[k] === 1) return;
    if (t[k] === 2) { px[o] = lc[0]; px[o + 1] = lc[1]; px[o + 2] = lc[2]; px[o + 3] = 200; return; }   // a level boundary is always water
    if (S.view === "diff") { const d = S.cmp ? S.cmp.c.diff[k] : NaN; if (Number.isNaN(d)) return; const c = vr[diffClass(d)]; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 230; return; }
    if (depthView) { const d = depthAt(k); if (!(d >= wet)) return; const c = rp[dclass(d)]; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 220; return; }
    if (!(S.final.hmax[k] >= wet)) return; const ci = vclass(valueAt(k), V.cl); if (ci < 0) return; const c = vr[ci]; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 225;
    // hatch where the flow reached critical speed and the solver capped it (the speed shown there is a lower bound)
    if (S.final.froude && S.final.froude[k]) { const p = o >> 2, W0 = overlayLUT().W; if (((p % W0) + ((p / W0) | 0)) % 5 === 0) { px[o] = hatch[0]; px[o + 1] = hatch[1]; px[o + 2] = hatch[2]; px[o + 3] = 255; } }
  });
  if (m._layers2.depth) m._layers2.depth.setUrl(url); else m._layers2.depth = L.imageOverlay(url, overlayLUT().bounds, { interactive: false }).addTo(m);
  const f = S.frames[S.frame];
  $("#tlabel").textContent = S.view !== "now" ? "Maximum over the run" : `${clock(f.sum.tHours)} (${S.frame + 1} of ${S.frames.length})`;
  drawSwmm(); kpis(); legend();
  if (!$("#v3d").hidden) V3.frame();
  for (const id of ["c-area", "c-in", "c-lvl", "c-pt"]) { const el = document.getElementById(id); if (el && el.data && el.data.some((d) => d.x && d.x.length)) Plotly.relayout(el, { shapes: [vline(f.sum.tHours)] }); }
}
function clock(h) { const sw = S.swmm; if (sw && sw.start) { const d = new Date(Date.parse(sw.start) + h * 3600000); return d.toISOString().slice(0, 16).replace("T", " "); } return `${fmt(h, 2)} h`; }
function legend() {
  const V = VIEWS[S.view] || VIEWS.now, cl = V.cl, rpl = dark() ? V.D : V.L;
  if (S.view === "diff") { $("#legend").innerHTML = `${esc(V.title)}: ` + V.labels.map((l, i) => `<span><span class="sw" style="background:${rpl[i]}"></span>${esc(l)}</span>`).join("") + `<span>Shown where either run has water deeper than ${fmt(S.cmp.c.wetFt, 2)} ft.</span>`; return; }
  $("#legend").innerHTML = `${esc(V.title)}: ` + cl.map((d, i) => `<span><span class="sw" style="background:${rpl[i]}"></span>${i < cl.length - 1 ? `${d}–${cl[i + 1]}` : `over ${d}`}</span>`).join("") +
    (S.view === "vmax" || S.view === "dv" ? `<span>Velocities are recorded where the water is deeper than ${Flood2D.VEL_H} ft; classes are for display, not a hazard standard.</span>` +
      (S.final && S.final.froudeCells ? `<span><span class="sw hatch"></span>flow reached critical speed, where the solver caps it: the speed there is a lower bound (depth × velocity is not affected)</span>` : "") : "") +
    `<span><span class="sw" style="background:var(--water)"></span>level boundary</span><span><span class="sw" style="background:var(--node);border-radius:50%"></span>SWMM node flooding now</span><span>Map shows water deeper than ${fmt(S.grid.opts.wetFt, 2)} ft.</span>`;
}
function kpis() {
  const fr = S.frames, f = fr[S.frame], fin = S.final; if (!f) return;
  if (S.view === "diff" && S.cmp) {
    const c = S.cmp.c, a = c.acres;
    const k2 = [["Newly flooded", fmt(a.onlyThis, 2) + " ac", "wet in this run only"], ["No longer flooded", fmt(a.onlyOther, 2) + " ac", "wet in the compared run only"],
      ["Deeper", fmt(a.deeper, 2) + " ac", `by ${fmt(c.tolFt, 2)} ft or more; largest rise ${fmt(c.maxRise, 2)} ft`], ["Shallower", fmt(a.shallower, 2) + " ac", `by ${fmt(c.tolFt, 2)} ft or more; largest drop ${fmt(-c.maxDrop, 2)} ft`],
      ["Buildings reached", `${c.buildings.this ?? "–"} vs ${c.buildings.other ?? "–"}`, "this run vs compared run"]];
    $("#kpis").innerHTML = k2.map(([l, v, n]) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${v}</div><div class="l">${esc(n)}</div></div>`).join(""); return;
  }
  const peakArea = Math.max(...fr.map((x) => x.sum.wetAc)), peakB = fin ? fin.bReached : Math.max(...fr.map((x) => x.sum.buildings));
  const dmax = fin ? Math.max(...fr.map((x) => x.sum.depthMax)) : f.sum.depthMax;
  const L0 = (fin || {}).ledger || f.sum.ledger;
  const mx = S.view !== "now", vmx = fin && fin.vmax ? fin.vmax.reduce((a, v) => (v > a ? v : a), 0) : NaN, dvx = fin && fin.dvmax ? fin.dvmax.reduce((a, v) => (v > a ? v : a), 0) : NaN;
  const k = [[mx ? "Peak flooded area" : "Flooded area now", fmt(mx ? peakArea : f.sum.wetAc, 2) + " ac", `deeper than ${fmt(S.grid.opts.wetFt, 2)} ft`],
    S.view === "vmax" ? ["Fastest flow", fmt(vmx, 2) + " ft/s", fin && fin.froudeCells ? `${fin.froudeCells.toLocaleString()} cells capped at critical speed (hatched)` : "over the run"] : S.view === "dv" ? ["Highest depth × velocity", fmt(dvx, 2) + " ft²/s", "over the run"] :
    ["Deepest water on land", fmt(mx ? dmax : f.sum.depthMax, 2) + " ft", mx ? "over the run" : "now"],
    ["Buildings reached", mx ? (fin ? peakB.toLocaleString() : "–") : f.sum.buildings.toLocaleString(), `water over ${fmt(S.grid.opts.buildingFt, 2)} ft beside them`],
    ["Water on the surface", fmt(f.sum.volCf / 43560, 2) + " ac-ft", "now"],
    ["SWMM flooding into the 2D", fmt(f.sum.inflowCfs, 1) + " cfs", `now; ${fmt(L0.inflow / 43560, 2)} ac-ft so far`]];
  $("#kpis").innerHTML = k.map(([l, v, n]) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${v}</div><div class="l">${esc(n)}</div></div>`).join("");
}

// ------------------------------------------------------------------ charts (one measure per chart, no second axis)
const CFG = { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] };
function layout(title, ytitle) {
  return { title: { text: title, font: { size: 14, color: css("--ink") }, x: 0.02 }, paper_bgcolor: css("--surface"), plot_bgcolor: css("--surface"), font: { color: css("--ink"), size: 12 },
    margin: { l: 56, r: 12, t: 36, b: 40 }, xaxis: { gridcolor: css("--line"), linecolor: css("--line") }, yaxis: { title: { text: ytitle }, gridcolor: css("--line"), zerolinecolor: css("--line"), rangemode: "tozero" },
    showlegend: true, legend: { orientation: "h", y: -0.2 }, hovermode: "x unified" };
}
function vline(t) { return { type: "line", xref: "x", yref: "paper", x0: hx(t), x1: hx(t), y0: 0, y1: 1, line: { color: css("--muted"), width: 1, dash: "dot" } }; }
const hx = (h) => clock(h);
const SERIES = ["#2a6fb0", "#c46a1e", "#3f8f5a", "#8e4fa8", "#b0413e", "#5c6f84", "#a08a1c", "#1c8a8a"];
function charts() {
  const fr = S.frames; if (!fr.length) return; const t = fr.map((f) => hx(f.sum.tHours));
  Plotly.react("c-area", [{ x: t, y: fr.map((f) => f.sum.wetAc), name: "Flooded area", mode: "lines", line: { color: SERIES[0], width: 2 }, hovertemplate: "%{y:.2f} ac<extra></extra>" }],
    Object.assign(layout(`Flooded area (deeper than ${fmt(S.grid.opts.wetFt, 2)} ft)`, "Area (ac)"), { showlegend: false, shapes: [vline(fr[S.frame].sum.tHours)] }), CFG);
  // SWMM inflows: the 7 largest nodes by volume, the rest as "Other"
  // per-node exchange from the maps; the 7 largest by volume, the rest as "Other"
  const srcs = (S.sources || []).map((s, i) => ({ name: s.name, i, vol: fr.reduce((a, f) => a + Math.abs((f.sum.rates || [])[i] || 0), 0) })).filter((x) => x.vol > 0).sort((a, b) => b.vol - a.vol);
  const tr = [], top = srcs.slice(0, 7), rest = srcs.slice(7), two = S.grid.opts.coupling === "two";
  top.forEach((n, j) => tr.push({ x: t, y: fr.map((f) => (f.sum.rates || [])[n.i] || 0), name: n.name, mode: "lines", line: { color: SERIES[j], width: 2 }, hovertemplate: `${esc(n.name)} %{y:.2f} cfs<extra></extra>` }));
  if (rest.length) tr.push({ x: t, y: fr.map((f) => rest.reduce((a, n) => a + ((f.sum.rates || [])[n.i] || 0), 0)), name: `Other (${rest.length})`, mode: "lines", line: { color: SERIES[7], width: 2 } });
  Plotly.react("c-in", tr.length ? tr : [{ x: [], y: [] }], Object.assign(layout(two ? "SWMM exchange at nodes (+ out of SWMM, − into inlets)" : "SWMM node flooding into the 2D", "Flow (cfs)"), { shapes: tr.length ? [vline(fr[S.frame].sum.tHours)] : [], annotations: tr.length ? [] : [{ text: "No SWMM flooding in this run", showarrow: false, xref: "paper", yref: "paper", x: 0.5, y: 0.5, font: { color: css("--muted") } }] }), CFG);
  const bs = S.grid.opts.boundaries || [];
  Plotly.react("c-lvl", bs.length ? bs.map((b, i) => ({ x: t, y: fr.map((f) => f.sum.stages[i]), name: b.key + (b.routed ? " (routed)" : b.node ? ` (SWMM ${b.node})` : " (fixed)"), mode: "lines", line: { color: SERIES[i % 8], width: 2 } })) : [{ x: [], y: [] }],
    Object.assign(layout("Level boundaries", "Water level (ft)"), { yaxis: { title: { text: "Water level (ft)" }, gridcolor: css("--line") }, shapes: bs.length ? [vline(fr[S.frame].sum.tHours)] : [], annotations: bs.length ? [] : [{ text: "No level boundaries", showarrow: false, xref: "paper", yref: "paper", x: 0.5, y: 0.5, font: { color: css("--muted") } }] }), CFG);
  pointChart();
}
function pointChart() {
  const fr = S.frames; if (!fr.length) return; const k = S.sel;
  const tr = k >= 0 ? [{ x: fr.map((f) => hx(f.sum.tHours)), y: fr.map((f) => dec(f.q[k])), name: "Depth", mode: "lines", line: { color: SERIES[0], width: 2 }, hovertemplate: "%{y:.2f} ft<extra></extra>" }] : [{ x: [], y: [] }];
  Plotly.react("c-pt", tr, Object.assign(layout(k >= 0 ? `Depth at the clicked point (ground ${fmt(S.grid.z[k], 2)} ft)` : "Depth at a point", "Depth (ft)"), { showlegend: false, shapes: k >= 0 ? [vline(fr[S.frame].sum.tHours)] : [], annotations: k >= 0 ? [] : [{ text: "Click the map to pick a point", showarrow: false, xref: "paper", yref: "paper", x: 0.5, y: 0.5, font: { color: css("--muted") } }] }), CFG);
}
function ledger() {
  const L0 = S.final.ledger, ac = (v) => fmt(v / 43560, 3);
  // two-way: inlet demand the cell could not supply shows in the engine as a clamp; net it out of both rows so they read as water actually moved
  const sf = (S.final.swmm2 && S.final.swmm2.tally && S.final.swmm2.tally.shortfall) || 0;
  const rows = [["Rain on the grid", L0.rain], ["SWMM node flooding (into the 2D)", L0.inflow], ["Taken by SWMM inlets", -((L0.captured || 0) - sf)], ["Infiltration", -L0.inf], ["Out at the grid edges", -L0.edge], ["Into level boundaries (– means out of them)", -L0.toLakes], ["Change in water on the surface", -(L0.v1 - L0.v0)], ["Depth clamped at zero (numerical)", L0.clamp - sf], ["Closure (should be about 0)", -L0.err]];
  $("#ledger").innerHTML = `<table class="t"><thead><tr><th>Term</th><th class="n">ac-ft</th><th class="n">cubic feet</th></tr></thead><tbody>${rows.map(([l, v]) => `<tr><td>${esc(l)}</td><td class="n">${ac(v)}</td><td class="n">${fmt(v, 0)}</td></tr>`).join("")}</tbody></table>
    <p class="note">Positive terms add water to the surface. Closure is ${fmt(Math.abs(L0.errPct), 5)}% of the water moved.</p>` + lakesHtml() + swmm2Html();
  const r2 = S.final.swmm2;
  if (r2) { $("#dl-rpt").onclick = () => download(`${stem()}_coupled.rpt`, r2.rpt, "text/plain"); $("#dl-out").onclick = () => download(`${stem()}_coupled.out`, new Uint8Array(r2.out), "application/octet-stream"); }
}
function lakesHtml() {
  const lk = S.final && S.final.lakes; if (!lk) return "";
  const ac = (v) => fmt(v / 43560, 3);
  return `<h3 style="margin:12px 0 6px;font-size:15px">Routed lakes</h3><table class="t"><thead><tr><th>Lake</th><th class="n">Start (ft)</th><th class="n">Peak (ft)</th><th class="n">End (ft)</th><th class="n">Area (ac)</th><th class="n">From the 2D (ac-ft)</th><th class="n">Rain on the lake (ac-ft)</th><th class="n">SWMM outfalls (ac-ft)</th></tr></thead><tbody>` +
    lk.names.map((n, i) => `<tr><td>${esc(n)}</td><td class="n">${fmt(lk.start[i], 2)}</td><td class="n">${fmt(lk.peak[i], 2)}</td><td class="n">${fmt(lk.end[i], 2)}</td><td class="n">${fmt(lk.area[i] / 43560, 1)}${lk.areaFrom[i] === "given" ? "" : " (in grid)"}</td><td class="n">${ac(lk.from2d[i])}</td><td class="n">${ac(lk.rain[i])}</td><td class="n">${ac(lk.outside[i])}</td></tr>`).join("") +
    `</tbody></table><p class="note">A routed lake is a level pool with a constant area and no outlet: its level changes by (water from the 2D + rain on its area + SWMM outfall inflow) ÷ area.</p>`;
}
function swmm2Html() {
  const r2 = S.final && S.final.swmm2; if (!r2) return "";
  const t = r2.tally, ac = (v) => fmt(v / 43560, 3);
  return `<h3 style="margin:12px 0 6px;font-size:15px">SWMM, two-way coupling</h3><table class="t"><tbody>
    <tr><td>Overflow from SWMM nodes onto the 2D</td><td class="n">${ac(t.fromSwmm)} ac-ft</td></tr>
    <tr><td>Surface water into SWMM inlets</td><td class="n">${ac(t.sentToSwmm)} ac-ft</td></tr>
    <tr><td>Overflow at nodes not coupled (lost)</td><td class="n">${ac(t.lostOverflow)} ac-ft</td></tr>
    <tr><td>Inlet demand the surface could not supply</td><td class="n">${ac(t.shortfall || 0)} ac-ft</td></tr>
    <tr><td>Overflow made in the last interval (after the 2D ended)</td><td class="n">${ac(t.pendingOverflow || 0)} ac-ft</td></tr>
    <tr><td>Of the water into inlets: back out of the same flooding node in the same interval</td><td class="n">${ac(t.recirculated || 0)} ac-ft</td></tr>
    <tr><td>Taken by inlets but not yet received by SWMM at the end (− means received ahead)</td><td class="n">${ac(t.owedToSwmm || 0)} ac-ft</td></tr>
    <tr><td>Inlets used</td><td class="n">${(r2.inlets || []).length}</td></tr>
    <tr><td>SWMM flow routing continuity error</td><td class="n">${fmt(r2.massBalance.flow, 3)} %</td></tr></tbody></table>
    ${r2.notes && r2.notes.length ? `<p class="warn">${r2.notes.map(esc).join("<br>")}</p>` : ""}
    <div class="row" style="margin-top:6px"><button id="dl-rpt">SWMM report of the coupled run (.rpt)</button><button id="dl-out" ${r2.out ? "" : "disabled"}>SWMM results (.out)</button></div>`;
}
function renderAll() { paint(); charts(); ledger(); if (!$("#v3d").hidden) V3.build(); }

// ------------------------------------------------------------------ map click
function onMapClick(e) {
  if (!S.grid) return; const [x, y] = fromLL(e.latlng), G = S.grid.G;
  const c = Math.floor((x - G.x0) / G.cs), r = Math.floor((G.y1 - y) / G.cs); if (c < 0 || r < 0 || c >= G.nx || r >= G.ny) return;
  const k = r * G.nx + c, t = S.grid.type[k]; S.sel = t === 0 ? k : -1;
  const f = S.frames[S.frame];
  const html = t === 1 ? (S.grid.z[k] === 0 ? "No ground data here (acts as a wall)" : "Building (wall)") : t === 2 ? "Level boundary" :
    `Ground ${fmt(S.grid.z[k], 2)} ft<br>` + (f ? `Water at ${esc(clock(f.sum.tHours))}: ${fmt(dec(f.q[k]), 2)} ft<br>` : "") + (S.final ? `Deepest ${fmt(S.final.hmax[k], 2)} ft${S.final.hmax[k] > 0 ? ` at ${esc(clock(S.final.tmax[k]))}` : ""}` : "") +
    (S.final && S.final.vmax ? `<br>Fastest ${fmt(S.final.vmax[k], 2)} ft/s${S.final.froude && S.final.froude[k] ? " or more (capped at critical speed here)" : ""}; depth × velocity up to ${fmt(S.final.dvmax[k], 2)} ft²/s` : "");
  L.popup().setLatLng(e.latlng).setContent(html).openOn(MAP); pointChart();
}

// ------------------------------------------------------------------ exports
function download(name, data, type) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
function stem() { return (S.exName || "flood").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "flood"; }
function exportTif() {
  const gr = S.grid, G = gr.G, N = G.nx * G.ny, d = new Float32Array(N), wse = new Float32Array(N), tm = new Float32Array(N), vf = S.grid.opts.vUnitFt;
  for (let k = 0; k < N; k++) { const open = gr.type[k] === 0, h = S.final.hmax[k]; d[k] = open ? h : NaN; wse[k] = open && h > 0 ? (gr.z[k] + h) / vf : NaN; tm[k] = open && h > 0 ? S.final.tmax[k] - S.grid.opts.t0 : NaN; }
  const lin = S.dem.hUnitFt ? (Math.abs(S.dem.hUnitFt - 1 / 0.3048) < 1e-6 ? "m" : Math.abs(S.dem.hUnitFt - UNIT_FT["us-ft"]) < 1e-9 ? "us-ft" : "ft") : "ft";
  const vm = new Float32Array(N), dv = new Float32Array(N), fl = new Float32Array(N);
  for (let k = 0; k < N; k++) { const ok2 = gr.type[k] === 0 && S.final.hmax[k] > 0; vm[k] = ok2 && S.final.vmax ? S.final.vmax[k] : NaN; dv[k] = ok2 && S.final.dvmax ? S.final.dvmax[k] : NaN; fl[k] = ok2 && S.final.froude ? S.final.froude[k] : NaN; }
  const buf = FloodModel.geoTiff(G, S.dem.epsg, [{ name: "max_depth_ft", data: d }, { name: `max_water_level_${vf === 1 ? "ft" : "dem_units"}`, data: wse }, { name: `hours_to_max_from_start_${S.grid.opts.t0}h`, data: tm },
    { name: "max_velocity_ft_per_s", data: vm }, { name: "max_depth_x_velocity_ft2_per_s", data: dv }, { name: "critical_flow_cap_1_where_velocity_is_a_lower_bound", data: fl }], lin);
  download(`${stem()}_max_depth_EPSG${S.dem.epsg || "none"}.tif`, buf, "image/tiff");
}
function exportCsv() {
  const rows = ["building,centroid_x,centroid_y,max_depth_beside_ft,reached"], bm = S.final.bMax, thr = S.grid.opts.buildingFt;
  const feats = S.grid.opts.useBuildings && S.bld ? S.bld.feats : [];
  feats.forEach((f, i) => { const r = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0]; let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; } x /= r.length; y /= r.length;
    rows.push(`${f.properties && f.properties.id !== undefined ? f.properties.id : i},${x.toFixed(2)},${y.toFixed(2)},${(bm[i] || 0).toFixed(3)},${bm[i] > thr ? "yes" : "no"}`); });
  download(`${stem()}_buildings.csv`, rows.join("\n"), "text/csv");
}
function exportNodes() {
  const srcs = S.sources || [];
  const rows = ["time,hours," + srcs.map((x) => `${x.name}_cfs`).join(",")];
  for (const f of S.frames) rows.push(`${clock(f.sum.tHours)},${f.sum.tHours.toFixed(4)},` + srcs.map((x, i) => ((f.sum.rates || [])[i] || 0).toFixed(4)).join(","));
  download(`${stem()}_swmm_inflows.csv`, rows.join("\n"), "text/csv");
}

// ------------------------------------------------------------------ save and open results
async function saveResults() {
  try { const gz = await RIO.pack(S, BUILD ? BUILD.version : "dev"); const t = S.frames[0].sum.tHours, name = `${stem()}_${S.grid.opts.coupling || "run"}_${fmt(S.grid.G.dxFt, 0)}ft_${clock(t).replace(" ", "_").replace(":", "")}.fsim.gz`;
    download(name, gz, "application/gzip"); msg(`Saved ${esc(name)} (${(gz.length / 1e6).toFixed(2)} MB).`); }
  catch (e) { msg(`Could not save: ${esc(e.message)}`, "err"); }
}
/* put the saved run's settings back in the panel, so what is shown is what produced the maps */
function applyOptions(o) {
  if (!o) return;
  const set = (id, v) => { const el = $(id); if (el && v !== undefined && v !== null && !(typeof v === "number" && !Number.isFinite(v))) el.value = String(v); };
  set("#imp", o.imperv !== undefined ? +(o.imperv * 100).toPrecision(12) : undefined); set("#n-imp", o.nImp); set("#n-perv", o.nPerv); set("#ks", o.ksInHr); set("#psi", o.suctionIn); set("#imd", o.imd);
  set("#edges", o.closedEdges ? "closed" : "open"); set("#roof", o.roofToGround ? "1" : "0"); set("#use-bld", o.useBuildings ? "1" : "0");
  set("#coupling", o.coupling); set("#rain", o.rainSource); set("#rain-ih", o.rainInHr); set("#rain-h", o.rainHours); set("#gauge", o.gauge);
  set("#lw", o.lw); set("#cw", o.cw); set("#ia", o.inletArea); set("#co", o.co); set("#clog", o.clog === undefined ? undefined : +(o.clog * 100).toPrecision(12)); set("#csec", o.couplingSec); set("#def-inl", o.defaultInlets === false ? "0" : o.defaultInlets ? "1" : undefined);
  set("#t0", o.t0); set("#t1", o.t1); set("#outmin", o.outputSec !== undefined ? +(o.outputSec / 60).toPrecision(12) : undefined); set("#engine", o.engine); set("#cfl", o.cfl); set("#wet", o.wetFt); set("#bthr", o.buildingFt);
  S.lcTable = o.lcTable || null; S.soilTable = o.soilTable || null; S.bspec = o.boundaries || []; S.bspecTouched = true; S._tSet = true;
}
async function openResults(file) {
  if (S.running) { msg("Stop the run first, then open saved results.", "err"); return; }
  try {
    const r = await RIO.unpack(await file.arrayBuffer());
    S.dem = r.h.dem; S.bld = r.h.bld; S.bnd = r.h.bnd; S.inl = r.h.inl; S.lc = r.h.lc; S.soil = r.h.soil; S.swmm = r.h.swmm; S.exName = r.h.exName;
    S.sources = r.h.sources; S.nodeMap = r.h.nodeMap; S.grid = r.grid; S.frames = r.frames; S.final = r.final; S.frame = r.frames.length - 1; S.sel = -1;
    S.loadedFrom = { name: file.name, saved: r.h.saved, app: r.h.app };
    $("#slider").max = S.frames.length - 1; $("#slider").value = S.frame; $("#slider").disabled = false; $("#b-play").disabled = false;
    S.resultsOnly = true; applyOptions(r.grid.opts);
    refreshInputs(); if (r.grid.opts && r.grid.opts.cellSize) { $("#cell").value = r.grid.opts.cellSize; cellNote(); } waterNotes(); boundaryTable(); surfaceTables();
    clearCompare(); mapInputs(); mapGrid(); S.view = "max"; $("#view").value = "max"; renderAll();
    ["#x-tif", "#x-csv", "#x-nodes", "#x-save", "#b-cmp"].forEach((s) => ($(s).disabled = false)); $("#x-nodes").disabled = !(S.sources && S.sources.length);
    ["#f-dem", "#f-bld", "#f-bnd", "#f-lc", "#f-soil", "#f-inl", "#f-inp", "#f-out"].forEach((s) => ($(s).value = ""));
    msg(`Opened ${esc(file.name)} (saved ${esc((r.h.saved || "").slice(0, 16).replace("T", " "))}). The panel shows the settings of that run. To run again, load a DEM or an example.`);
  } catch (e) { msg(`Could not open the file: ${esc(e.message)}`, "err"); }
}

// ------------------------------------------------------------------ wiring
function setTab(which) { $("#t-map").setAttribute("aria-selected", which === "map"); $("#t-3d").setAttribute("aria-selected", which === "3d"); $("#map").hidden = which !== "map"; $("#v3d").hidden = which !== "3d"; if (which === "3d") V3.build(); else if (MAP) MAP.invalidateSize(); }
let PLAY = null;
function init() {
  const ex = EX(); $("#ex-pick").innerHTML = ex.map((e, i) => `<option value="${i}">${esc(e.name)}</option>`).join("");
  $("#ex-load").onclick = () => loadExample(+$("#ex-pick").value);
  wireInputs();
  // (Run stays off while saved results are open: the worker does not hold their inputs)
  $("#b-run").onclick = run; $("#b-stop").onclick = () => { if (W) W.postMessage({ cmd: "stop" }); msg("Stopping…"); };
  $("#slider").oninput = (e) => { S.frame = +e.target.value; if (S.view !== "now") { S.view = "now"; $("#view").value = "now"; } paint(); pointChart(); };
  $("#view").onchange = (e) => { S.view = e.target.value; paint(); };
  $("#basemap").onchange = () => { setBasemap(); if (S.grid) mapGrid(); if (S.frames.length) paint(); };
  $("#b-play").onclick = () => {
    if (PLAY) { clearInterval(PLAY); PLAY = null; $("#b-play").textContent = "Play"; return; }
    S.view = "now"; $("#view").value = "now"; $("#b-play").textContent = "Pause";
    PLAY = setInterval(() => { S.frame = (S.frame + 1) % S.frames.length; $("#slider").value = S.frame; paint(); }, 450);
  };
  $("#t-map").onclick = () => setTab("map"); $("#t-3d").onclick = () => setTab("3d");
  $("#b-cmp").onclick = () => $("#f-cmp").click(); $("#f-cmp").onchange = (e) => { if (e.target.files[0]) compareWith(e.target.files[0]); e.target.value = ""; };
  $("#b-cmp-clear").onclick = () => { clearCompare(); paint(); };
  $("#x-save").onclick = saveResults; $("#f-res").onchange = (e) => { if (e.target.files[0]) openResults(e.target.files[0]); e.target.value = ""; };
  $("#x-tif").onclick = exportTif; $("#x-csv").onclick = exportCsv; $("#x-nodes").onclick = exportNodes;
  $("#b-help").onclick = () => { $("#help").hidden = !$("#help").hidden; if (!$("#help").hidden) $("#help").scrollIntoView({ behavior: "smooth" }); };
  $("#b-theme").onclick = () => { const r = document.documentElement, d = dark(); r.dataset.theme = d ? "light" : "dark"; try { localStorage.setItem("fsim-theme", r.dataset.theme); } catch (e) {} if (S.grid) mapGrid(); if (S.dem) mapInputs(); if (S.frames.length) renderAll(); };
  try { const t = localStorage.getItem("fsim-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
  if (!("gpu" in navigator)) $("#engine").options[1].disabled = true;
  if (BUILD) document.title = `Flood Simulator ${BUILD.version}`;
}
document.addEventListener("DOMContentLoaded", init);
