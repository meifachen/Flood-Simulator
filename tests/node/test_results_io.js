// Saved results (.fsim.gz): round trip and refusal of files whose header does not match their contents. node tests/node/test_results_io.js
const fs = require("fs"), path = require("path"), vm = require("vm"), zlib = require("zlib");
const res = []; const ok = (name, pass, info) => { res.push({ name, pass: !!pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + "  " + info); };
const ctx = vm.createContext({ Blob, Response, CompressionStream, DecompressionStream, TextEncoder, TextDecoder, Uint8Array, Float32Array, Float64Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, ArrayBuffer, DataView, JSON, Math, Number, Object, String, Array, Error, Date });
vm.runInContext(fs.readFileSync(path.join(__dirname, process.env.RIOJS || "../../src/app/results_io.js"), "utf8") + "\nthis.RIO = RIO;", ctx);
const RIO = ctx.RIO;

// a 2 x 2 run with two maps
const N = 4, f32 = (v) => new Float32Array(N).fill(v);
const S = { grid: { G: { nx: 2, ny: 2, x0: 0, y1: 0, cs: 1, dxFt: 1 }, info: { nx: 2, ny: 2 }, opts: { imperv: 0.77, boundaries: [{ key: "P", level: NaN }] }, z: f32(1), type: new Uint8Array(N) },
  frames: [{ q: new Uint8Array(N).fill(1), sum: { tHours: 0 } }, { q: new Uint8Array(N).fill(2), sum: { tHours: 1 } }],
  final: { hmax: f32(2), tmax: f32(1), bMax: f32(7), vmax: f32(3), dvmax: f32(4), froude: Uint8Array.from([0, 1, 0, 1]), froudeCells: 2, ledger: { errPct: NaN, inf: Infinity } }, dem: {}, swmm: null };
// take a packed file apart, let a function edit the header, and put it back together with the same array bytes
const raw = (gz) => new Uint8Array(zlib.gunzipSync(Buffer.from(gz)));
function rebuild(gz, edit) {
  const u8 = raw(gz), hl = new DataView(u8.buffer).getUint32(8, true), h = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + hl)));
  const body = u8.subarray(Math.ceil((12 + hl) / 4) * 4); edit(h);
  const hb = new TextEncoder().encode(JSON.stringify(h)), start = Math.ceil((12 + hb.length) / 4) * 4, out = new Uint8Array(start + body.length);
  out.set(u8.subarray(0, 8)); new DataView(out.buffer).setUint32(8, hb.length, true); out.set(hb, 12); out.set(body, start); return out;
}
const refused = async (buf) => { try { await RIO.unpack(buf); return "opened"; } catch (e) { return e.message; } };

(async () => {
  const gz = await RIO.pack(S, "test"), r = await RIO.unpack(gz);
  ok("a saved run opens with the same maps and maxima, including the critical-flow flags", Array.from(r.final.froude || []).join() === "0,1,0,1" && r.final.vmax[0] === 3 && r.frames[1].q[0] === 2 && r.grid.opts.imperv === 0.77, `froude ${Array.from(r.final.froude || [])}, vmax ${r.final.vmax[0]}`);
  ok("numbers JSON cannot hold (NaN, Infinity) come back as themselves, not null", Number.isNaN(r.final.ledger.errPct) && r.final.ledger.inf === Infinity && Number.isNaN(r.grid.opts.boundaries[0].level), `errPct ${r.final.ledger.errPct}, inf ${r.final.ledger.inf}, level ${r.grid.opts.boundaries[0].level}`);
  const bad = {
    "a negative length": (h) => { h.arrays.find((a) => a.name === "final.bMax").length = -4; },
    "a missing array entry (the rest would shift)": (h) => { h.arrays = h.arrays.filter((a) => a.name !== "final.vmax"); },
    "a wrong array type": (h) => { h.arrays.find((a) => a.name === "final.bMax").type = "U8"; },
    "a fractional length": (h) => { h.arrays.find((a) => a.name === "final.bMax").length = 2.5; },
    "a grid whose size disagrees with its info": (h) => { h.grid.G.nx = 1; h.grid.G.ny = 4; },
    "a repeated array": (h) => { h.arrays.push(Object.assign({}, h.arrays[0])); },
  };
  const out = []; for (const [what, edit] of Object.entries(bad)) out.push(`${what}: ${await refused(rebuild(gz, edit))}`);
  ok("files whose header does not match their contents are refused", out.every((m) => !/: opened$/.test(m)), out.join(" | "));
  const b2 = raw(gz), extra = new Uint8Array(b2.length + 8); extra.set(b2);
  ok("bytes beyond what the header lists are refused", /bytes more than its header lists/.test(await refused(extra)), await refused(extra));
  const bad2 = res.filter((x) => !x.pass).length; console.log(bad2 ? `${bad2} FAILED` : "ALL PASS"); process.exit(bad2 ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
