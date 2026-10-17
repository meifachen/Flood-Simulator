/* Two-way SWMM <-> 2D coupling with EPA SWMM 5.2.4 compiled to WebAssembly (vendor/swmm-wasm/swmm5.js).
 *
 * Each coupling interval [t0, t1] (one engine chunk):
 *   1. read the 2D depth at each coupled cell;
 *   2. inlet capture Qin (surface -> SWMM) at each coupled junction:
 *        node head below the rim:  Qin = min(weir Cw*Lw*H^1.5, orifice Co*A*sqrt(2 g H)), H = water depth over the rim (or the cell depth if the rim is below the ground);
 *        node head above the rim:  Qin = Co*A*sqrt(2 g (H2 - Hn)) while the 2D water level H2 is above the node head Hn, else 0;
 *        capped at a fraction of the water standing in the cell over the interval;
 *   3. SWMM gets Qin as lateral inflow and steps to t1; the node overflow (SWMM flooding, ALLOW_PONDING NO) is averaged over its steps;
 *   4. the 2D gets (overflow - Qin) at the cell. Explicit, so the 2D sees SWMM's response one interval later.
 * Nodes that are outside the grid or have no open cell nearby are not coupled; their flooding leaves the system and is tallied as lost.
 * Water conservation is tallied on both sides: volume sent to SWMM = volume taken from the 2D (any shortfall shows as the 2D clamp term).
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
    finish() {
      const M = this.M; let rpt = "", out = null;
      try { this.call("swmm_end", "number", [], []); this.call("swmm_report", "number", [], []); } catch (e) {}
      const pr = M._malloc(12); M._swmm_getMassBalErr(pr, pr + 4, pr + 8); const mb = { runoff: M.getValue(pr, "float"), flow: M.getValue(pr + 4, "float") }; M._free(pr);
      this.call("swmm_close", "number", [], []);
      try { rpt = M.FS.readFile("/model.rpt", { encoding: "utf8" }); out = M.FS.readFile("/model.out"); } catch (e) {}
      return { massBalance: mb, rpt, out };
    }
  }

  /* B: model.buildGrid result; opts: {cw (3.0), lw ft (3), co (0.6), area sq ft (4), capFrac (0.5), searchFt (30)}
   * Returns {sources, sourceAt (async), tally, nodeMap, warnings, finish()} for Flood2D.simulate. */
  async function makeCoupler(B, createSWMM, inpText, model, o = {}) {
    const sw = await SwmmEngine.open(createSWMM, inpText);
    const W = sw.notes.slice(), Gd = B.G, A = Gd.dxFt * Gd.dxFt, maxCells = Math.max(1, Math.ceil((o.searchFt ?? 30) / Gd.dxFt));
    const cw = o.cw ?? 3.0, lw = o.lw ?? 3.0, co = o.co ?? 0.6, area = o.area ?? 4.0, capFrac = o.capFrac ?? 0.5;
    const sources = [], links = [], nodeMap = [];
    for (let i = 0; i < sw.nNodes; i++) {
      const name = sw.names[i], nd = model.nodes[model.nodeIndex[name]], type = Math.round(sw.get(P.NODE_TYPE, i));
      const rec = { name, type: ["JUNCTION", "OUTFALL", "STORAGE", "DIVIDER"][type], status: "" }; nodeMap.push(rec);
      if (!nd || !Number.isFinite(nd.x)) { rec.status = "no coordinates: not coupled"; continue; }
      const k0 = Model.cellOf(Gd, nd.x, nd.y); if (k0 < 0) { rec.status = "outside the grid: not coupled"; continue; }
      if (B.type[k0] === 2) { rec.status = "inside a level boundary: not coupled"; continue; }
      if (type === 1) { rec.status = "outfall: not coupled"; continue; }
      const k = Model.nearestOpen(B.type, Gd, k0, maxCells); if (k < 0) { rec.status = `no open cell within ${o.searchFt ?? 30} ft: not coupled`; continue; }
      const rim = (sw.get(P.NODE_ELEV, i) + sw.get(P.NODE_MAXDEPTH, i)) * sw.lf;
      rec.status = type === 0 ? "two-way (inlet and overflow)" : "overflow only"; rec.cell = k; rec.rimFt = rim;
      sources.push({ cell: k, name, sink: type === 0 }); links.push({ i, k, rim, z: B.g.aux[4 * k], inlet: type === 0 });
    }
    const tally = { sentToSwmm: 0, fromSwmm: 0, lostOverflow: 0, perNode: links.map(() => ({ in: 0, out: 0 })) };
    const allIdx = Array.from({ length: sw.nNodes }, (_, i) => i), coupledSet = new Set(links.map((l) => l.i));
    let lastRates = links.map(() => 0);
    async function sourceAt(h0, h1, solver) {
      const dt = (h1 - h0) * 3600; if (!(dt > 0)) return lastRates;
      if (sw.tSec < h0 * 3600 - 1e-6) sw.advance(h0 * 3600, []);   // a run that starts later than SWMM: SWMM catches up without exchange
      const h = await solver.readCells(links.map((l) => l.k));
      const qin = links.map((l, j) => {
        if (!l.inlet || sw.done) return 0;   // after the SWMM run ends nothing can be passed to it
        const d = Math.max(h[j], 0); if (!(d > 1e-3)) { sw.set(P.NODE_LATFLOW, l.i, 0); return 0; }
        const H2 = l.z + d, Hn = sw.get(P.NODE_HEAD, l.i) * sw.lf;
        let q = 0;
        if (Hn <= l.rim) { const hw = Math.min(d, Math.max(H2 - l.rim, 0)); if (hw > 0) q = Math.min(cw * lw * Math.pow(hw, 1.5), co * area * Math.sqrt(2 * G * hw)); }
        else if (H2 > Hn) q = co * area * Math.sqrt(2 * G * (H2 - Hn));
        q = Math.min(q, capFrac * d * A / dt);
        sw.set(P.NODE_LATFLOW, l.i, q / sw.qf);
        return q;
      });
      const over = sw.advance(h1 * 3600, allIdx);
      for (let i = 0; i < sw.nNodes; i++) if (!coupledSet.has(i)) tally.lostOverflow += over[i] * dt;
      lastRates = links.map((l, j) => { const qo = over[l.i]; tally.perNode[j].in += qin[j] * dt; tally.perNode[j].out += qo * dt; tally.sentToSwmm += qin[j] * dt; tally.fromSwmm += qo * dt; return qo - qin[j]; });
      return lastRates;
    }
    const uncoupledFlooding = nodeMap.filter((r) => /not coupled/.test(r.status)).length;
    if (uncoupledFlooding) W.push(`${uncoupledFlooding} SWMM nodes are not coupled (outside the grid, outfalls, inside a level boundary or without an open cell nearby); their overflow is counted as lost`);
    const headFt = (name) => { const i = sw.names.indexOf(name); if (i < 0) throw new Error(`Node ${name} is not in the SWMM model`); return sw.get(P.NODE_HEAD, i) * sw.lf; };
    return { sources, sourceAt, tally, nodeMap, warnings: W, engine: sw, headFt, rates: () => lastRates.slice(), finish: () => sw.finish() };
  }

  const api = { makeCoupler, prepareInp, SwmmEngine, P };
  if (isNode) module.exports = api; else root.Couple2 = api;
})(typeof self !== "undefined" ? self : this);
