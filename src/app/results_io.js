/* Save and reopen a run: .fsim.gz = gzip("FSIM0001" | u32 header length | header JSON | padding to 4 | typed arrays, each 4-byte aligned).
 * The file holds everything the results views need (grid, maps, maxima, SWMM summary, inputs shown on the map), so a reopened run
 * shows the map, 3D, charts and exports without the input files. Rerunning needs the inputs again. */
"use strict";
const RIO = {
  MAGIC: "FSIM0001", VERSION: 1,
  TYPES: { F32: Float32Array, F64: Float64Array, U8: Uint8Array, I8: Int8Array, U16: Uint16Array, I16: Int16Array, U32: Uint32Array, I32: Int32Array },
  typeName(a) { for (const [n, T] of Object.entries(RIO.TYPES)) if (a instanceof T) return n; throw new Error(`Cannot save an array of type ${a && a.constructor && a.constructor.name}`); },
  async gz(u8, dir) { const s = new Blob([u8]).stream().pipeThrough(dir === "in" ? new DecompressionStream("gzip") : new CompressionStream("gzip")); return new Uint8Array(await new Response(s).arrayBuffer()); },
  // build the file from the page state S
  async pack(S, appVersion) {
    if (!S.final || !S.grid || !S.frames.length) throw new Error("There are no results to save");
    const arrays = [], blobs = [], add = (name, a) => { arrays.push({ name, type: RIO.typeName(a), length: a.length }); blobs.push(a); };
    add("grid.z", S.grid.z); add("grid.type", S.grid.type);
    S.frames.forEach((f, i) => add(`frame.${i}.q`, f.q));
    for (const k of ["hmax", "tmax", "bMax", "vmax", "dvmax", "froude"]) if (S.final[k]) add(`final.${k}`, S.final[k]);
    const fin = {}; for (const [k, v] of Object.entries(S.final)) if (!ArrayBuffer.isView(v) && k !== "swmm2") fin[k] = v;
    let swmm2 = null;
    if (S.final.swmm2) { const { out, ...rest } = S.final.swmm2; swmm2 = rest; if (out) add("swmm2.out", new Uint8Array(out)); }
    const header = { format: "flood-simulator-results", version: RIO.VERSION, app: appVersion, saved: new Date().toISOString(),
      dem: S.dem, grid: { G: S.grid.G, info: S.grid.info, opts: S.grid.opts, warnings: S.grid.warnings || [] },
      frames: S.frames.map((f) => f.sum), final: fin, swmm2, swmm: S.swmm, bld: S.bld, bnd: S.bnd, inl: S.inl || null, lc: S.lc || null, soil: S.soil || null,
      sources: S.sources || [], nodeMap: S.nodeMap || [], exName: S.exName || null, arrays };
    // numbers JSON cannot hold (NaN, Infinity) are written as {"$num": "NaN"} and read back as numbers, so they are not turned into null (and then 0)
    const hb = new TextEncoder().encode(JSON.stringify(header, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? { $num: String(v) } : v)));
    let size = Math.ceil((12 + hb.length) / 4) * 4; const offs = [];
    for (const a of blobs) { offs.push(size); size += Math.ceil(a.byteLength / 4) * 4; }
    const out = new Uint8Array(size), dv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) out[i] = RIO.MAGIC.charCodeAt(i);
    dv.setUint32(8, hb.length, true); out.set(hb, 12);
    blobs.forEach((a, i) => out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offs[i]));
    return RIO.gz(out, "out");
  },
  // parse and check a file; returns the pieces to restore
  async unpack(buf) {
    let u8 = new Uint8Array(buf);
    if (u8.length < 2) throw new Error("The file is empty");
    if (u8[0] === 0x1f && u8[1] === 0x8b) { try { u8 = await RIO.gz(u8, "in"); } catch (e) { throw new Error("The file is not a complete gzip file"); } }
    if (u8.length < 12 || String.fromCharCode(...u8.subarray(0, 8)) !== RIO.MAGIC) throw new Error("Not a Flood Simulator results file");
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), hl = dv.getUint32(8, true);
    if (12 + hl > u8.length) throw new Error("The results file is truncated (header)");
    let h; try { h = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + hl)), (k, v) => (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$num === "string" ? Number(v.$num) : v)); } catch (e) { throw new Error("The results header is not valid"); }
    if (h.format !== "flood-simulator-results") throw new Error("Unknown results format");
    if (h.version !== RIO.VERSION) throw new Error(`Results file version ${h.version} is not supported (this app reads version ${RIO.VERSION})`);
    const G = h.grid && h.grid.G; if (!G || !(G.nx > 0) || !(G.ny > 0)) throw new Error("The results file has no grid");
    const N = G.nx * G.ny, nf = Array.isArray(h.frames) ? h.frames.length : 0; if (!nf) throw new Error("The results file has no maps");
    if (!Number.isInteger(G.nx) || !Number.isInteger(G.ny) || (h.grid.info && (h.grid.info.nx !== G.nx || h.grid.info.ny !== G.ny))) throw new Error("The results file's grid size is not consistent");
    // every known array: its length and its type; optional ones need only be right when present
    const want = { "grid.z": N, "grid.type": N, "final.hmax": N, "final.tmax": N }, opt = { "final.vmax": N, "final.dvmax": N, "final.froude": N };
    const TYPE = { "grid.z": "F32", "grid.type": "U8", "final.hmax": "F32", "final.tmax": "F32", "final.bMax": "F32", "final.vmax": "F32", "final.dvmax": "F32", "final.froude": "U8", "swmm2.out": "U8" };
    for (let i = 0; i < nf; i++) { want[`frame.${i}.q`] = N; TYPE[`frame.${i}.q`] = "U8"; }
    let off = Math.ceil((12 + hl) / 4) * 4; const A = Object.create(null);
    for (const a of h.arrays || []) {
      const T = RIO.TYPES[a.type]; if (!T) throw new Error(`Unknown array type ${a.type} in the file`);
      if (!(Number.isInteger(a.length) && a.length >= 0)) throw new Error(`Array ${a.name} has an invalid length (${a.length})`);
      if (A[a.name]) throw new Error(`Array ${a.name} appears twice in the file`);
      if (TYPE[a.name] && a.type !== TYPE[a.name]) throw new Error(`Array ${a.name} is ${a.type}; ${TYPE[a.name]} expected`);
      const need = want[a.name] ?? opt[a.name]; if (need !== undefined && a.length !== need) throw new Error(`Array ${a.name} has ${a.length} values; ${need} expected`);
      const bytes = a.length * T.BYTES_PER_ELEMENT; if (off + bytes > u8.length) throw new Error("The results file is truncated");
      A[a.name] = new T(u8.buffer.slice(u8.byteOffset + off, u8.byteOffset + off + bytes)); off += Math.ceil(bytes / 4) * 4;
    }
    if (off !== u8.length) throw new Error(`The results file has ${u8.length - off} bytes more than its header lists`);
    for (const n of Object.keys(want)) if (!A[n]) throw new Error(`The results file is missing ${n}`);
    const final = Object.assign({}, h.final, { hmax: A["final.hmax"], tmax: A["final.tmax"], bMax: A["final.bMax"] || new Float32Array(0), vmax: A["final.vmax"] || null, dvmax: A["final.dvmax"] || null, froude: A["final.froude"] || null });
    if (h.swmm2) final.swmm2 = Object.assign({}, h.swmm2, { out: A["swmm2.out"] ? A["swmm2.out"].buffer : null });
    return { h, grid: Object.assign({}, h.grid, { z: A["grid.z"], type: A["grid.type"] }), frames: h.frames.map((sum, i) => ({ sum, q: A[`frame.${i}.q`] })), final };
  },
};
