/* Flood Simulator page helpers: tooltips on every control, the clickable workflow map, the User Guide drawer and the first-run tour. */
"use strict";
const UI = (() => {
  // ---------------------------------------------------------------- tooltips: what it is, units, default, range
  const TIPS = {
    "#b-help": "Open the User Guide: quick start, every input and setting, results, troubleshooting and the method.",
    "#b-tour": "A short guided run: loads the example and walks through the five steps. You can skip it at any step.",
    "#b-theme": "Switch between the light and dark theme. The choice is remembered in this browser.",
    "#ex-pick": "Built-in examples with their own data and run settings. They show how the inputs fit together.",
    "#ex-load": "Load the chosen example: its DEM, buildings, boundaries, SWMM files and run settings. Replaces what is loaded.",
    "#f-res": "Open a .fsim.gz file saved earlier. It shows that run's maps, charts and settings without its input files. Run stays off until a DEM or example is loaded.",
    "#f-dem": "Required. Single-band GeoTIFF of ground levels in a projected CRS (feet or meters), north up, square cells; up to 40 million cells. Loading a DEM starts a new site and clears the other layers.",
    "#crs-epsg": "The EPSG code of the DEM's coordinate system, when the file has none (for example 2237 for Florida West, US feet).",
    "#vunit": "Units of the DEM's elevations. Default: the same as the horizontal units. Choose this when, for example, x and y are in feet and z in meters.",
    "#f-bld": "Optional. GeoJSON polygons. Cells whose centre is inside a footprint become walls; an optional height property sets the 3D height. Reprojected from lon/lat or another EPSG.",
    "#f-bnd": "Optional. GeoJSON polygons of lakes, ponds or tidal water held at a level. Properties name, level_ft, node, routed and area_ac fill in the table below.",
    "#f-lc": "Optional. GeoTIFF of land cover class codes (for example NLCD). Sets Manning n and impervious % per cell; the classes found are listed under Grid and surface.",
    "#f-soil": "Optional. GeoJSON polygons with an hsg property (A–D; B/D uses D) or a GeoTIFF of groups 1–4. Sets Green-Ampt Ks, suction and moisture deficit per cell.",
    "#f-inp": "Optional. SWMM5 input file (US or SI units). Needed for SWMM coupling, rain from a gauge and boundary levels from nodes. Node coordinates must be in the DEM's CRS.",
    "#f-out": "Optional. SWMM5 results file of the same model. Needed for one-way coupling (node flooding) and for boundary levels from nodes without two-way coupling.",
    "#f-inl": "Optional, two-way only. GeoJSON points with node (the junction), and optionally inlet_type (generic, grate, curb, combination), sizes, clog and rim_ft. See the guide, section 6.",
    "#cell": "Grid cell size, a whole multiple of the DEM cell; ground is the block average. Halving it takes about eight times as long. Default: the finest size with at most 1.2 million cells.",
    "#use-bld": "Yes: building footprints are walls water flows around (default). No: they are ignored.",
    "#roof": "Where rain on roofs goes: to the nearest open ground that drains (default), or nowhere.",
    "#edges": "Open: water reaching the grid edge leaves at normal depth (default). Closed: the edges are walls.",
    "#imp": "Impervious share of each cell where there is no land cover. Default 40%; 0–100.",
    "#n-imp": "Manning n of the impervious part where there is no land cover. Default 0.015; 0.005–0.5.",
    "#n-perv": "Manning n of the pervious part where there is no land cover. Default 0.10; 0.005–1.",
    "#ks": "Green-Ampt saturated hydraulic conductivity where there are no soils. Default 0.5 in/hr; 0–50.",
    "#psi": "Green-Ampt wetting-front suction head where there are no soils. Default 4 in; 0–50.",
    "#imd": "Initial moisture deficit (porosity minus initial moisture) where there are no soils. Default 0.3; 0–0.6.",
    "#coupling": "Off; One way: node flooding from the .out file spreads on the ground (nothing drains back); Two way: SWMM 5.2.4 runs here and exchanges water through inlets.",
    "#lw": "Weir length of the default inlet at each junction. Default 3 ft; 0–100.",
    "#cw": "Weir coefficient of the default inlet (US units). Default 3.0; 0–4.",
    "#ia": "Orifice (grate opening) area of the default inlet. Default 4 sq ft; 0–100.",
    "#co": "Orifice coefficient of the default inlet. Default 0.6; 0–1.",
    "#clog": "Share of the grate (or curb opening) blocked, for every inlet without its own clog. Default 0%; 0–90. About 50% is a common design allowance for grates in sag.",
    "#def-inl": "Junctions with no inlet in the inlets file: give them the default inlet at the manhole, or let them only overflow.",
    "#csec": "How often SWMM and the 2D exchange water, in seconds. Default 30; 2–300. Shorter is closer coupling and slower.",
    "#rain": "Rain on every grid cell: none, from a SWMM rain gauge, or uniform. With SWMM subcatchments it counts runoff twice where they overlap the grid.",
    "#gauge": "The SWMM rain gauge whose series falls on the grid (intensity, volume or cumulative).",
    "#rain-ih": "Uniform rain intensity. Default 2 in/hr; 0–20.",
    "#rain-h": "How long the uniform rain lasts, from the start of the run. Default 1 hour; 0.1–72.",
    "#t0": "Start of the run, hours from the SWMM start date and time (or from 0 without SWMM). Default 0.",
    "#t1": "End of the run, hours. Default 6.",
    "#outmin": "How often a map is kept, minutes. Default 5; 1–120. More maps: smoother playback, larger saved file.",
    "#engine": "GPU (WebGPU) if the browser has it, else the CPU. Both do the same arithmetic; the GPU is usually much faster.",
    "#cfl": "Courant number: the time step as a share of the time a wave takes to cross a cell. Default 0.7; 0.1–1. Lower is steadier and slower.",
    "#wet": "Water deeper than this counts as flooding in the map, the flooded area and the comparison. Default 0.1 ft; 0.01–5.",
    "#bthr": "A building counts as reached when the water next to it is this deep. Default 0.5 ft; 0.01–5.",
    "#b-run": "Run the model with these settings. Off until a DEM or example is loaded.",
    "#b-stop": "Stop the run; the maps made so far are kept.",
    "#t-map": "Map view: depth, maxima and SWMM nodes over a hillshade or basemap. Click a point for its depth over time.",
    "#t-3d": "3D view of the ground, buildings and water. Drag to rotate, right-drag to pan, scroll to zoom.",
    "#view": "What the map shows: depth at the selected time, the maximum depth, velocity or depth × velocity over the run, or the change against a compared run.",
    "#basemap": "Background: hillshade of the DEM (offline), or OpenStreetMap or USGS imagery (need the internet).",
    "#b-play": "Play the maps in time order.",
    "#slider": "Choose the time shown on the map and marked on the charts.",
    "#x-tif": "Six-band GeoTIFF in the DEM's CRS: maximum depth, maximum water level, time of the maximum, maximum velocity, maximum depth × velocity, critical-speed cap flag.",
    "#x-csv": "Buildings CSV: the deepest water next to each footprint over the run.",
    "#x-nodes": "SWMM exchange CSV: the flow at each coupled node at every map time (cfs).",
    "#x-save": "Save every map and the run's settings as a .fsim.gz file, to reopen or compare later.",
    "#b-cmp": "Open another saved run on the same grid and map the change in maximum depth, this run minus that one.",
    "#b-cmp-clear": "Remove the comparison.",
    "#flow-toggle": "Hide or show the workflow map. The choice is remembered in this browser.",
    "#g-close": "Close the guide (Esc).",
    "#g-search": "Type a word to show only the guide sections that contain it.",
    ".b-src": "Where this polygon's level comes from: a fixed level, routed (rises with the water it gains), or a SWMM storage or outfall node's head.",
    ".b-lvl": "The fixed level, or the starting level of a routed lake (ft, in the DEM's vertical datum).",
    ".b-area": "Surface area of a routed lake, acres. Blank: the part inside the grid. Give the whole lake when the grid holds only part of it.",
    ".lc-n": "Manning n for this land cover class.",
    ".lc-i": "Impervious share of this land cover class, %.",
    ".so-k": "Green-Ampt saturated hydraulic conductivity for this soil group, in/hr.",
    ".so-s": "Green-Ampt suction head for this soil group, in.",
    ".so-m": "Initial moisture deficit for this soil group (porosity − initial moisture).",
    "#dl-rpt": "SWMM's report file of the coupled run.",
    "#dl-out": "SWMM's binary results of the coupled run, for the SWMM GUI or other readers.",
  };
  const KPI_TIPS = {
    "Flooded area now": "Open ground with water deeper than the wet threshold at the selected time.",
    "Peak flooded area": "The largest flooded area at any map time.",
    "Deepest water on land": "The deepest water on open ground (not lakes), now or over the run.",
    "Fastest flow": "The highest cell speed over the run; hatched cells hit the critical-speed cap, so their speed is a lower bound.",
    "Highest depth × velocity": "The highest depth × velocity over the run, a common flood hazard measure.",
    "Buildings reached": "Buildings with water at least the threshold depth next to them.",
    "Water on the surface": "Volume of water standing on open ground at the selected time.",
    "SWMM flooding into the 2D": "Flow from SWMM nodes onto the ground now, and the volume so far.",
    "Newly flooded": "Wet in this run and dry in the compared run.",
    "No longer flooded": "Wet in the compared run and dry in this one.",
    "Deeper": "Maximum depth higher than in the compared run by at least 0.1 ft.",
    "Shallower": "Maximum depth lower than in the compared run by at least 0.1 ft.",
  };
  let tipEl = null, tipFor = null, hideT = null, shownAt = 0, byPointer = false;
  function show(el, pointer = false) {
    const text = el.dataset.tip; if (!text) return;
    clearTimeout(hideT); shownAt = Date.now(); byPointer = pointer; tipFor = el; tipEl.textContent = text; tipEl.hidden = false;
    const r = el.getBoundingClientRect(), w = Math.min(320, window.innerWidth - 32);
    tipEl.style.maxWidth = w + "px";
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let x = Math.min(Math.max(16, r.left), window.innerWidth - 16 - tw), y = r.bottom + 6;
    if (y + th > window.innerHeight - 8) y = Math.max(8, r.top - th - 6);
    tipEl.style.left = x + "px"; tipEl.style.top = y + "px";
    el.setAttribute("aria-describedby", "tip");
    if (matchMedia("(pointer: coarse)").matches) hideT = setTimeout(hide, 6000);
  }
  function hide() { if (tipEl) tipEl.hidden = true; if (tipFor) tipFor.removeAttribute("aria-describedby"); tipFor = null; }
  function applyTips(root = document) {
    for (const [sel, text] of Object.entries(TIPS)) root.querySelectorAll(sel).forEach((el) => { el.dataset.tip = text; });
    root.querySelectorAll(".kpi").forEach((k) => { const l = k.querySelector(".l"); const t = l && KPI_TIPS[l.textContent.trim()]; if (t) { k.dataset.tip = t; k.tabIndex = 0; } });
  }
  function initTips() {
    tipEl = document.createElement("div"); tipEl.id = "tip"; tipEl.className = "tip"; tipEl.setAttribute("role", "tooltip"); tipEl.hidden = true; document.body.appendChild(tipEl);
    applyTips();
    const target = (e) => (e.target && e.target.closest ? e.target.closest("[data-tip]") : null);
    document.addEventListener("pointerover", (e) => { if (e.pointerType === "mouse") { const t = target(e); if (t) show(t, true); } });
    document.addEventListener("pointerout", (e) => { if (e.pointerType === "mouse" && byPointer && tipFor && !tipFor.contains(e.relatedTarget)) hide(); });   // a tip shown by focus stays while the field has focus
    document.addEventListener("focusin", (e) => { const t = target(e); if (t) show(t); else hide(); });
    document.addEventListener("focusout", () => hide());
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
    window.addEventListener("scroll", () => { if (Date.now() - shownAt > 300) hide(); }, true);   // a scroll that brought the element into view does not close its tip
    // tables and KPIs are drawn later: tag them as they appear
    new MutationObserver(() => applyTips()).observe(document.querySelector("main"), { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------- workflow map
  const STEPS = [
    { id: "data", card: "#s-data", guide: "#g-data", title: "1. Data", items: [["DEM", "#f-dem"], ["Buildings", "#f-bld"], ["Lakes", "#f-bnd"], ["Land cover", "#f-lc"], ["Soils", "#f-soil"], ["SWMM .inp/.out", "#f-inp"], ["Inlets", "#f-inl"]] },
    { id: "grid", card: "#s-grid", guide: "#g-grid", title: "2. Grid and surface", items: [["Cell size", "#cell"], ["Buildings as walls", "#use-bld"], ["Edges", "#edges"], ["Roughness", "#n-imp"], ["Infiltration", "#ks"]] },
    { id: "water", card: "#s-water", guide: "#g-water", title: "3. Water sources", items: [["SWMM coupling", "#coupling"], ["Inlets", "#lw"], ["Rain", "#rain"], ["Lake levels", "#bnd-table"], ["Time window", "#t0"]] },
    { id: "run", card: "#s-run", guide: "#g-run", title: "4. Run", items: [["Engine", "#engine"], ["Thresholds", "#wet"], ["Run", "#b-run"]] },
    { id: "results", card: "#map", guide: "#g-results", title: "5. Results", items: [["Map", "#t-map"], ["3D", "#t-3d"], ["Views", "#view"], ["Water balance", "#ledger"], ["Save / export", "#x-save"], ["Compare", "#b-cmp"]] },
  ];
  function state() {
    const S = window.S || {};
    const water = ($("#coupling") && $("#coupling").value !== "off") || ($("#rain") && $("#rain").value !== "none") || (S.bspec && S.bspec.length > 0);
    return { data: !!S.dem, grid: !!S.dem && !!$("#cell").value, water: !!S.dem && !!water, run: !!S.final, results: !!S.final };
  }
  function goTo(sel, step) {
    const el = $(sel); if (!el) return;
    const card = el.closest("details"); if (card) card.open = true;
    if (step && step.card && $(step.card).tagName === "DETAILS") $(step.card).open = true;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600);
    if (el.matches("input,select,button") && !el.disabled && !el.hidden) setTimeout(() => el.focus({ preventScroll: true }), 350);
  }
  function drawFlow() {
    const box = $("#flow-body"); if (!box) return;
    const st = state(), next = STEPS.find((s) => !st[s.id]);
    box.innerHTML = `<div class="flow-root" aria-hidden="true">Flood study</div><ol class="flow">` + STEPS.map((s) => {
      const done = st[s.id], isNext = next && next.id === s.id;
      return `<li class="fstep${done ? " done" : ""}${isNext ? " next" : ""}" data-step="${s.id}">
        <button class="fhead" data-go="${s.card}" data-tip="${esc(`${s.title}: ${done ? "done" : isNext ? "the next step" : "not done yet"}. Click to open it.`)}"><span class="fdot" aria-hidden="true">${done ? "✓" : s.title[0]}</span>${esc(s.title.slice(3))}<span class="vis">${done ? " (done)" : isNext ? " (next)" : ""}</span></button>
        <div class="fleaves">${s.items.map(([n, sel]) => `<button class="leaf" data-go="${sel}" data-tip="${esc(`Go to ${n}`)}">${esc(n)}</button>`).join("")}<button class="leaf gd" data-guide="${s.guide}" data-tip="Read about this step in the User Guide">Guide</button></div></li>`;
    }).join("") + `</ol>`;
    box.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => goTo(b.dataset.go, STEPS.find((s) => s.id === b.closest(".fstep").dataset.step))));
    box.querySelectorAll("[data-guide]").forEach((b) => (b.onclick = () => openGuide(b.dataset.guide)));
    const n = STEPS.filter((s) => st[s.id]).length; $("#flow-state").textContent = n === 5 ? "all steps done" : `${n} of 5 done; next: ${next.title.slice(3)}`;
  }

  // ---------------------------------------------------------------- guide drawer
  function openGuide(anchor) {
    const g = $("#help"); g.hidden = false; $("#b-help").setAttribute("aria-expanded", "true");
    if (anchor) { const t = g.querySelector(anchor); if (t) { t.scrollIntoView({ block: "start" }); t.classList.add("flash"); setTimeout(() => t.classList.remove("flash"), 1600); } }
    else g.scrollTop = 0;
    setTimeout(() => ($("#g-search") || g).focus({ preventScroll: true }), 50);
  }
  function closeGuide() { $("#help").hidden = true; $("#b-help").setAttribute("aria-expanded", "false"); $("#b-help").focus(); }
  function searchGuide(q) {
    q = q.trim().toLowerCase(); let hits = 0;
    document.querySelectorAll("#help .gsec").forEach((s) => { const m = !q || s.textContent.toLowerCase().includes(q); s.hidden = !m; if (m && q) hits++; });
    $("#g-hits").textContent = q ? (hits ? `${hits} section${hits > 1 ? "s mention" : " mentions"} “${q}”.` : `No section mentions “${q}”.`) : "";
  }

  // ---------------------------------------------------------------- tour
  const TOUR = [
    { sel: "header h1", text: "This tour loads the example and makes one run, in eight short steps. Next goes on; Skip ends it." },
    { sel: "#flow", text: "The workflow map: the five steps from data to results. Each turns green when done; click a step or an item to go to it, or Guide to read about it." },
    { sel: "#ex-load", text: "Step 1, Data. Next loads the built-in example: a DEM, buildings, a pond and a SWMM model, with its own run settings.", act: async () => { $("#ex-pick").value = "0"; await loadExample(0); if (!window.S.dem) throw new Error($("#msg").textContent); } },
    { sel: "#cell", text: "Step 2, Grid and surface. The cell size sets detail and run time. Hover over any setting for its units, default and range." },
    { sel: "#coupling", text: "Step 3, Water sources. The example spreads SWMM node flooding from its .out file over the ground, between the start and end hours below." },
    { sel: "#b-run", text: "Step 4, Run. Next starts the run; it takes a few seconds on the GPU and about 15 seconds on the CPU.", act: async () => { await run(); if (!window.S.final) throw new Error($("#msg").textContent); } },
    { sel: "#map", text: "Step 5, Results. Move the time slider or press Play; choose Maximum depth under Show; click the map for the depth over time at a point." },
    { sel: "#ledger", text: "The water balance shows where the water went; closure should be about 0. The User Guide (Guide button) explains every term. That is the tour." },
  ];
  let tourI = -1, tourBox = null;
  async function tourStep(i) {
    tourI = i; const st = TOUR[i]; if (!st) return endTour(true);
    const el = $(st.sel); document.querySelectorAll(".tour-on").forEach((x) => x.classList.remove("tour-on"));
    if (el) { const card = el.closest("details"); if (card) card.open = true; el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("tour-on"); }
    tourBox.querySelector(".tour-text").textContent = st.text;
    tourBox.querySelector(".tour-n").textContent = `${i + 1} of ${TOUR.length}`;
    tourBox.querySelector(".tour-back").disabled = i === 0;
    tourBox.querySelector(".tour-next").textContent = i === TOUR.length - 1 ? "Finish" : st.act ? "Next (does it)" : "Next";
    tourBox.hidden = false; tourBox.querySelector(".tour-next").focus({ preventScroll: true });
  }
  function startTour() {
    hideOffer(); if (!tourBox) {
      tourBox = document.createElement("div"); tourBox.className = "tour"; tourBox.setAttribute("role", "dialog"); tourBox.setAttribute("aria-label", "Guided tour");
      tourBox.innerHTML = `<div class="tour-text" aria-live="polite"></div><div class="row"><span class="tour-n note"></span><span style="flex:1"></span><button class="tour-skip">Skip</button><button class="tour-back">Back</button><button class="tour-next primary">Next</button></div>`;
      document.body.appendChild(tourBox);
      tourBox.querySelector(".tour-skip").onclick = () => endTour(false);
      tourBox.querySelector(".tour-back").onclick = () => tourStep(Math.max(0, tourI - 1));
      tourBox.querySelector(".tour-next").onclick = async () => {
        const st = TOUR[tourI], b = tourBox.querySelector(".tour-next");
        if (st && st.act) { b.disabled = true; b.textContent = "Working…"; try { await st.act(); } catch (e) { tourBox.querySelector(".tour-text").textContent = "That step did not work: " + e.message; b.disabled = false; return; } b.disabled = false; }
        tourStep(tourI + 1);
      };
      tourBox.addEventListener("keydown", (e) => { if (e.key === "Escape") endTour(false); });
    }
    tourStep(0);
  }
  function endTour() { if (tourBox) tourBox.hidden = true; document.querySelectorAll(".tour-on").forEach((x) => x.classList.remove("tour-on")); tourI = -1; try { localStorage.setItem("fsim-tour", "done"); } catch (e) {} drawFlow(); }
  function hideOffer() { const o = $("#tour-offer"); if (o) o.remove(); }
  function offerTour() {
    let seen = null; try { seen = localStorage.getItem("fsim-tour"); } catch (e) {}
    if (seen) return;
    const o = document.createElement("div"); o.id = "tour-offer"; o.className = "tour"; o.setAttribute("role", "dialog"); o.setAttribute("aria-label", "Take the tour?");
    o.innerHTML = `<div>New here? A short tour loads the example and makes one run.</div><div class="row"><span style="flex:1"></span><button id="tour-no">No, thanks</button><button id="tour-yes" class="primary">Take the tour</button></div>`;
    document.body.appendChild(o);
    $("#tour-yes").onclick = startTour; $("#tour-no").onclick = () => { hideOffer(); try { localStorage.setItem("fsim-tour", "declined"); } catch (e) {} };
  }

  function init() {
    initTips();
    $("#b-help").onclick = () => ($("#help").hidden ? openGuide() : closeGuide());
    $("#g-close").onclick = closeGuide;
    $("#help").addEventListener("keydown", (e) => { if (e.key === "Escape") closeGuide(); });
    $("#g-search").addEventListener("input", (e) => searchGuide(e.target.value));
    $("#help").querySelectorAll(".guide-toc a").forEach((a) => (a.onclick = (e) => { e.preventDefault(); searchGuide($("#g-search").value = ""); openGuide(a.getAttribute("href")); }));
    $("#b-tour").onclick = startTour;
    $("#flow-toggle").onclick = () => { const b = $("#flow-body"), open = b.hidden; b.hidden = !open; $("#flow-toggle").setAttribute("aria-expanded", String(open)); $("#flow-toggle").textContent = open ? "Hide" : "Show"; try { localStorage.setItem("fsim-flow", open ? "open" : "closed"); } catch (e) {} };
    try { if (localStorage.getItem("fsim-flow") === "closed") $("#flow-toggle").click(); } catch (e) {}
    drawFlow();
    document.addEventListener("change", () => setTimeout(drawFlow, 0));
    // the run, an example and opened results change the state outside change events: follow the status line
    new MutationObserver(() => drawFlow()).observe($("#msg"), { childList: true, characterData: true, subtree: true });
    setTimeout(offerTour, 600);
  }
  return { init, TIPS, drawFlow, openGuide, startTour, state };
})();
document.addEventListener("DOMContentLoaded", () => UI.init());
