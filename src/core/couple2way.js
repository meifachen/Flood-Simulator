/* Two-way SWMM <-> 2D coupling with EPA SWMM 5.2.4 compiled to WebAssembly (vendor/swmm-wasm/swmm5.js).
 *
 * Each coupling interval [t0, t1] (one engine chunk):
 *   1. before the interval (sourceAt): read the 2D depth at each inlet cell and set each inlet's demand
 *        Qin = min(weir Cw*Lw*Hw^1.5, orifice Co*A*sqrt(2 g Ho)), Hw = water depth over the inlet crest (at most the cell depth),
 *        Ho = Hw while the node head Hn is at or below the crest, else the smaller of Hw and (H2 - Hn) (H2 = 2D water level; no capture once Hn >= H2).
 *        The two regimes meet at Hn = crest, so the exchange does not jump when a flooding node sits exactly at its rim.
 *        The 2D gets the demand as a sink and the overflow SWMM produced in the previous interval as a source (its volume, spread over this one);
 *   2. the 2D runs the interval. Each step a sink takes what its cell holds, at most the demand; what the cell could not supply is the
 *        clamp at that cell, so no water is created and the inlet takes no more than reaches it (no per-interval cap tied to the cell size);
 *   3. after the interval (afterChunk): the volume each inlet actually took (demand x interval - its share of the clamp at its cell) goes to
 *        SWMM as lateral inflow while SWMM steps over the same interval; the node overflow (ALLOW_PONDING NO) is stored for the next interval.
 * Explicit: the 2D sees SWMM's overflow one interval later; SWMM receives exactly the water the 2D lost through the inlets.
 * Nodes that are outside the grid or have no open cell nearby are not coupled; their flooding leaves the system and is tallied as lost.
 */
(function (root) {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports;
  const Model = isNode ? require("./model.js") : root.FloodModel;
  const P = { NODE_TYPE: 300, NODE_ELEV: 301, NODE_MAXDEPTH: 302, NODE_DEPTH: 303, NODE_HEAD: 304, NODE_LATFLOW: 306, NODE_OVERFLOW: 308, FLOWUNITS: 8 };
  const QF = [1, 1 / 448.831, 1.547229, 35.3146667, 0.0353146667, 0.408734569];   // cfs per CFS, GPM, MGD, CMS, LPS, MLD
  const G = 32.174;

  /* force ALLOW_PONDING NO (overflow must leave the node to reach the 2D) and a report step no shorter than the input's */
  function prepareInp(text) {
    const notes = []; let found = false;
    const lines = text.split(/\r?\n/).map((ln) => {
      if (/^\s*ALLOW_PONDING\s+/i.test(ln)) { found = true; if (!/\bNO\b/i.test(ln)) { notes.push("ALLOW_PONDING was YES; set to NO so that node overflow reaches the 2D surface"); return "ALLOW_PONDING        NO"; } }
      return ln;
    });
    let out = lines.join("\n");
    if (!found) out = out.replace(/\[OPTIONS\][^\n]*\n/i, (m) => m + "ALLOW_PONDING        NO\n");
    return { text: out, notes };
  }

  class SwmmEngine {
    static async open(createSWMM, inpText) {
      const e = new SwmmEngine(); const M = e.M = await createSWMM({ print: () => {}, printErr: () => {} });
      const prep = prepareInp(inpText); e.notes = prep.notes;
      M.FS.writeFile("/model.inp", prep.text);
      e.call = (n, r, t, a) => M.ccall(n, r, t, a);
      let err = e.call("swmm_open", "number", ["string", "string", "string"], ["/model.inp", "/model.rpt", "/model.out"]);
      if (err) throw new Error("SWMM could not open the model: " + e.error(err));
      err = e.call("swmm_start", "number", ["number"], [1]); if (err) throw new Error("SWMM could not start: " + e.error(err));
      e.nNodes = M._swmm_getCount(2); e.names = []; const buf = M._malloc(64);
      for (let i = 0; i < e.nNodes; i++) { M._swmm_getName(2, i, buf, 63); e.names.push(M.UTF8ToString(buf)); }
      M._free(buf);
      const fu = Math.round(M._swmm_getValue(P.FLOWUNITS, 0)); e.qf = QF[fu]; e.lf = fu >= 3 ? 1 / 0.3048 : 1; e.flowUnits = ["CFS", "GPM", "MGD", "CMS", "LPS", "MLD"][fu];
      e.pTime = M._malloc(8); M.setValue(e.pTime, 0, "double"); e.tSec = 0; e.done = false;
      return e;
    }
    error(code) { const b = this.M._malloc(256); this.M._swmm_getError(b, 255); const s = this.M.UTF8ToString(b); this.M._free(b); return s || "error " + code; }
    get(prop, i) { return this.M._swmm_getValue(prop, i); }
    set(prop, i, v) { this.M._swmm_setValue(prop, i, v); }
    /* step to tSec (seconds from the start); returns the time-weighted mean overflow (cfs) of each node over the interval */
    advance(tSec, nodes) {
      const n = nodes.length, acc = new Float64Array(n); let t0 = this.tSec, last = this.tSec;
      if (this.done) return acc;
      while (this.tSec < tSec - 1e-6) {
        const err = this.M._swmm_step(this.pTime); if (err) throw new Error("SWMM stopped: " + this.error(err));
        const el = this.M.getValue(this.pTime, "double");
        if (el === 0) { this.done = true; break; }   // end of the SWMM simulation
        this.tSec = el * 86400; const dt = this.tSec - last; last = this.tSec;
        for (let i = 0; i < n; i++) acc[i] += this.get(P.NODE_OVERFLOW, nodes[i]) * this.qf * dt;
      }
      const span = Math.max(last - t0, 1e-9); for (let i = 0; i < n; i++) acc[i] /= span;
      return acc;
    }
    /* zero the lateral inflow set on the given nodes (a value set through the API stays in force for later steps) */
    clearInflow(nodes) { for (const i of nodes) this.set(P.NODE_LATFLOW, i, 0); }
    finish() {
      const M = this.M; let rpt = "", out = null;
      try { this.call("swmm_end", "number", [], []); this.call("swmm_report", "number", [], []); } catch (e) {}
      const pr = M._malloc(12); M._swmm_getMassBalErr(pr, pr + 4, pr + 8); const mb = { runoff: M.getValue(pr, "float"), flow: M.getValue(pr + 4, "float") }; M._free(pr);
      this.call("swmm_close", "number", [], []);
      try { rpt = M.FS.readFile("/model.rpt", { encoding: "utf8" }); out = M.FS.readFile("/model.out"); } catch (e) {}
      return { massBalance: mb, rpt, out };
    }
  }

  /* B: model.buildGrid result; opts: {cw (3.0), lw ft (3), co (0.6), area sq ft (4), capFrac (none), searchFt (30),
   *   inlets: [{x, y, node, lw, area, cw, co, rimFt}] (optional; inlet points in the grid CRS, each tied to a SWMM junction;
   *     rimFt, the inlet crest, defaults to the SWMM rim of its node, the same crest a default inlet has),
   *   defaultInlets: true (junctions with no inlet in the list get one at the node with the default size; a junction whose listed inlets
   *     were all rejected gets none), maxLeadFt: 300 (an inlet farther than this from its node is reported), crestTolFt: 0.5}
   * Overflow leaves SWMM at each coupled node's cell; capture enters through each inlet's cell. The engine gets one source per node
   * (overflow, >= 0) and one sink per inlet (<= 0). rates() gives the net exchange per coupled node (+ out of SWMM). */
  async function makeCoupler(B, createSWMM, inpText, model, o = {}) {
    const sw = await SwmmEngine.open(createSWMM, inpText);
    const W = sw.notes.slice(), Gd = B.G, A = Gd.dxFt * Gd.dxFt, searchFt = o.searchFt ?? 30, maxCells = Math.max(1, Math.ceil(searchFt / Gd.dxFt));
    const def = { cw: o.cw ?? 3.0, lw: o.lw ?? 3.0, co: o.co ?? 0.6, area: o.area ?? 4.0 }, capFrac = o.capFrac ?? Infinity;   // capFrac: optional extra limit (fraction of the cell's water per interval)
    const links = [], nodeMap = [], byName = {};
    for (let i = 0; i < sw.nNodes; i++) {
      const name = sw.names[i], nd = model.nodes[model.nodeIndex[name]], type = Math.round(sw.get(P.NODE_TYPE, i));
      const rec = { name, type: ["JUNCTION", "OUTFALL", "STORAGE", "DIVIDER"][type], status: "", inlets: 0 }; nodeMap.push(rec);
      if (!nd || !Number.isFinite(nd.x)) { rec.status = "no coordinates: not coupled"; continue; }
      const k0 = Model.cellOf(Gd, nd.x, nd.y); if (k0 < 0) { rec.status = "outside the grid: not coupled"; continue; }
      if (B.type[k0] === 2) { rec.status = "inside a level boundary: not coupled"; continue; }
      if (type === 1) { rec.status = "outfall: not coupled"; continue; }
      const k = Model.nearestOpen(B.type, Gd, k0, maxCells); if (k < 0) { rec.status = `no open cell within ${searchFt} ft: not coupled`; continue; }
      const rim = (sw.get(P.NODE_ELEV, i) + sw.get(P.NODE_MAXDEPTH, i)) * sw.lf;
      rec.status = type === 0 ? "two-way" : "overflow only"; rec.cell = k; rec.rimFt = rim;
      byName[name] = links.length; links.push({ i, k, rim, z: B.g.aux[4 * k], junction: type === 0, name, rec, x: nd.x, y: nd.y });
    }
    // inlets: from the list, else one default inlet at each coupled junction
    const inlets = [], given = new Set(), maxLeadFt = o.maxLeadFt ?? 300, crestTol = o.crestTolFt ?? 0.5;
    const NAMES = { lw: "weir length", area: "grate area", cw: "weir coefficient", co: "orifice coefficient" };
    const show = (v) => (typeof v === "string" ? JSON.stringify(v) : String(v));
    const crestNote = (label, rim, z) => { if (Math.abs(rim - z) > crestTol) W.push(`${label}: crest ${rim.toFixed(2)} ft is ${Math.abs(rim - z).toFixed(2)} ft ${rim > z ? "above" : "below"} the ground of its cell (${z.toFixed(2)} ft)`); };
    for (const [n, it] of (o.inlets || []).entries()) {
      const label = `Inlet ${n + 1} (${it.node})`;
      const p = { lw: it.lw ?? def.lw, area: it.area ?? def.area, cw: it.cw ?? def.cw, co: it.co ?? def.co };
      for (const [key, v] of Object.entries(p)) if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) throw new Error(`${label}: ${NAMES[key]} ${show(v)} is not a positive number`);
      if (it.rimFt !== undefined && it.rimFt !== null && !(typeof it.rimFt === "number" && Number.isFinite(it.rimFt))) throw new Error(`${label}: crest elevation ${show(it.rimFt)} is not a number`);
      const j = byName[it.node];
      if (j === undefined) { W.push(`Inlet ${n + 1}: node ${it.node} is not a coupled SWMM junction; inlet ignored`); continue; }
      if (!links[j].junction) { W.push(`Inlet ${n + 1}: node ${it.node} is not a junction; inlet ignored`); continue; }
      given.add(j);   // listed for this junction: it gets no default inlet, even if this one is rejected below
      const k = Model.nearestOpen(B.type, Gd, Model.cellOf(Gd, it.x, it.y), maxCells);
      if (k < 0) { W.push(`${label} has no open cell within ${searchFt} ft; inlet ignored (and ${it.node} gets no default inlet)`); continue; }
      const lead = Math.hypot(it.x - links[j].x, it.y - links[j].y);
      if (lead > maxLeadFt) W.push(`${label} is ${Math.round(lead)} ft from its node; check the node name`);
      const rim = Number.isFinite(it.rimFt) ? it.rimFt : links[j].rim, z = B.g.aux[4 * k];
      crestNote(label, rim, z);
      inlets.push(Object.assign({ j, k, z, rim, name: `${it.node} inlet ${n + 1}` }, p)); links[j].rec.inlets++;
    }
    if (o.defaultInlets !== false) links.forEach((l, j) => { if (l.junction && !given.has(j)) { crestNote(`${l.name} inlet (default)`, l.rim, l.z); inlets.push(Object.assign({ j, k: l.k, z: l.z, rim: l.rim, name: `${l.name} inlet` }, def)); l.rec.inlets++; } });
    for (const l of links) if (l.junction && !l.rec.inlets) l.rec.status = "overflow only (no inlet)";
    // engine sources: overflow at each node cell, capture at each inlet cell
    const sources = links.map((l) => ({ cell: l.k, name: l.name })).concat(inlets.map((it) => ({ cell: it.k, name: it.name, sink: true })));
    // several inlets in one cell share the cell's water
    const perCell = {}; for (const it of inlets) perCell[it.k] = (perCell[it.k] || 0) + 1;
    const tally = { sentToSwmm: 0, fromSwmm: 0, lostOverflow: 0, demanded: 0, shortfall: 0, pendingOverflow: 0, perNode: links.map(() => ({ in: 0, out: 0 })), perInlet: inlets.map(() => 0) };
    const allIdx = Array.from({ length: sw.nNodes }, (_, i) => i), coupledSet = new Set(links.map((l) => l.i));
    let lastRates = links.map(() => 0), pendV = links.map(() => 0), cur = null;
    const inletCells = inlets.map((it) => it.k), cells = [...new Set(inletCells)];
    const clampAt = async (solver) => (solver.readClamp ? await solver.readClamp(cells) : new Float64Array(cells.length));
    /* before an interval: inlet demands from the depths now, and last interval's overflow volume as this interval's source */
    async function sourceAt(h0, h1, solver) {
      const dt = (h1 - h0) * 3600; if (!(dt > 0)) return sources.map(() => 0);
      if (sw.tSec < h0 * 3600 - 1e-6) sw.advance(h0 * 3600, []);   // a run that starts later than SWMM: SWMM catches up without exchange
      const h = await solver.readCells(inletCells);
      const qin = inlets.map((it, m) => {
        if (sw.done) return 0;   // after the SWMM run ends nothing can be passed to it
        const d = Math.max(h[m], 0); if (!(d > 1e-3)) return 0;
        const l = links[it.j], H2 = it.z + d, Hn = sw.get(P.NODE_HEAD, l.i) * sw.lf, rim = it.rim;
        const hw = Math.min(d, Math.max(H2 - rim, 0)), ho = Hn <= rim ? hw : Math.min(hw, H2 - Hn);
        let q = 0;
        if (hw > 0 && ho > 0) q = Math.min(it.cw * it.lw * Math.pow(hw, 1.5), it.co * it.area * Math.sqrt(2 * G * ho));
        return Math.min(q, capFrac * d * A / dt / perCell[it.k]);
      });
      const over = pendV.map((v) => v / dt); pendV = links.map(() => 0);
      cur = { h0, qin, over, c0: await clampAt(solver) };
      return over.concat(qin.map((q) => -q));
    }
    /* after an interval (h1 is where it stopped): what the inlets took goes to SWMM, which steps over the same interval */
    async function afterChunk(h0, h1, solver) {
      if (!cur) return; const c = cur; cur = null; const dt = (h1 - h0) * 3600; if (!(dt > 0)) return;
      const c1 = await clampAt(solver), demCell = {};
      inlets.forEach((it, m) => (demCell[it.k] = (demCell[it.k] || 0) + c.qin[m] * dt));
      // the clamp that built up at an inlet cell over this interval is demand the cell could not supply; inlets in a cell share it by demand.
      // (the tallies are reset when the 2D writes a map, which happens after this call, so c1 - c0 is this interval's clamp)
      const shortCell = {}; cells.forEach((k, i) => (shortCell[k] = Math.min(Math.max((c1[i] - c.c0[i]) * A, 0), demCell[k] || 0)));
      const lat = new Float64Array(links.length), took = inlets.map((it, m) => {
        const dem = c.qin[m] * dt, v = dem - (demCell[it.k] > 0 ? shortCell[it.k] * dem / demCell[it.k] : 0);
        tally.demanded += dem; tally.shortfall += dem - v; lat[it.j] += v / dt; return v;
      });
      links.forEach((l, j) => { if (l.junction && !sw.done) sw.set(P.NODE_LATFLOW, l.i, lat[j] / sw.qf); });
      const t0 = sw.tSec, ov = sw.advance(h1 * 3600, allIdx), dts = Math.max(sw.tSec - t0, 0);
      for (let i = 0; i < sw.nNodes; i++) if (!coupledSet.has(i)) tally.lostOverflow += ov[i] * dts;
      lastRates = links.map((l, j) => {
        const v = ov[l.i] * dts; pendV[j] += v; tally.fromSwmm += v; tally.perNode[j].out += v; tally.perNode[j].in += lat[j] * dt; tally.sentToSwmm += lat[j] * dt;
        return c.over[j] - lat[j];   // net exchange during this interval (+ out of SWMM onto the 2D)
      });
      took.forEach((v, m) => (tally.perInlet[m] += v));
      tally.pendingOverflow = pendV.reduce((a, v) => a + v, 0);   // overflow SWMM made in the last interval, given to the 2D in the next one
    }
    const uncoupled = nodeMap.filter((r) => /not coupled/.test(r.status)).length;
    if (uncoupled) W.push(`${uncoupled} SWMM nodes are not coupled (outside the grid, outfalls, inside a level boundary or without an open cell nearby); their overflow is counted as lost`);
    const headFt = (name) => { const i = sw.names.indexOf(name); if (i < 0) throw new Error(`Node ${name} is not in the SWMM model`); return sw.get(P.NODE_HEAD, i) * sw.lf; };
    const junctionIdx = links.filter((l) => l.junction).map((l) => l.i);
    /* end the exchange: zero the inlet inflow at every coupled junction (otherwise SWMM keeps adding the last capture for the rest of its run) */
    const stop = () => { if (!sw.done) sw.clearInflow(junctionIdx); };
    /* stop the exchange, run SWMM to the end of its simulation and close it */
    const finish = () => { stop(); sw.advance(1e12, []); return sw.finish(); };
    return { sources, nodes: links.map((l) => ({ name: l.name, cell: l.k })), inlets: inlets.map((it) => ({ name: it.name, cell: it.k, node: links[it.j].name, lw: it.lw, area: it.area, rimFt: it.rim })),
      sourceAt, afterChunk, tally, nodeMap, warnings: W, engine: sw, headFt, rates: () => lastRates.slice(), stop, finish };
  }

  const api = { makeCoupler, prepareInp, SwmmEngine, P };
  if (isNode) module.exports = api; else root.Couple2 = api;
})(typeof self !== "undefined" ? self : this);
