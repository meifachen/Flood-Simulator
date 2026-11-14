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
  // R-C3 (new in 0.6.0, E-04 and E-09) a saved run carries its provenance (app version, engine settings, input file hashes)
  // and the time-of-max-velocity and duration arrays; the provenance of two runs can be diffed. New in 0.6.0: on 0.5.0 the
  // header has no prov and the final has no tvmax/dvdur, so these checks fail there.
  {
    const prov = { app: "0.6.0", settings: { engine: "gpu", cfl: 0.7, coupling: "two", couplingSec: 30, t0: 0, t1: 6, outputSec: 300, rainSource: "gauge", dvThresh: 0.5 },
      inputs: [{ kind: "dem", name: "dem.tif", sha256: "a".repeat(64) }, { kind: "inp", name: "model.inp", sha256: "b".repeat(64) }] };
    const S2 = Object.assign({}, S, { prov, final: Object.assign({}, S.final, { tvmax: f32(1.5), dvdur: f32(600) }) });
    const r2 = await RIO.unpack(await RIO.pack(S2, "0.6.0"));
    const prov2 = JSON.parse(JSON.stringify(prov)); prov2.settings.cfl = 0.5; prov2.inputs[1].sha256 = "c".repeat(64);
    const d = RIO.provDiff(prov, prov2), dSame = RIO.provDiff(prov, prov);
    ok("R-C3 provenance and the velocity-time arrays round-trip in a saved run; provenance diffs name the changed settings and files",
      r2.h.prov.settings.cfl === 0.7 && r2.h.prov.inputs[0].sha256 === "a".repeat(64) && r2.final.tvmax[0] === 1.5 && r2.final.dvdur[0] === 600 &&
      d.length === 2 && /cfl: 0.7 vs 0.5/.test(d[0]) && /inp file differs/.test(d[1]) && dSame.length === 0 && /sha256 aaaaaaaaaaaa/.test(RIO.provLine(prov)),
      `diff: ${d.join("; ") || "none"}; line: ${RIO.provLine(prov).slice(0, 90)}…`);
    // the whole provenance object, inputs included, comes back deep-equal (0.6.1, review 0.6.0 F-04)
    const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ok("R-C3 the provenance of a saved run reopens deep-equal to what was saved, inputs included",
      deepEq(r2.h.prov, prov), `saved ${JSON.stringify(prov).length} chars, reopened ${JSON.stringify(r2.h.prov).length} chars`);
    // the settings recorded since 0.6.1 (rain, drain, dtMax, inlet panel, boundary specs) are diffed by name:
    // two runs differing only in their uniform rain are NOT "the same settings" (0.6.1, review 0.6.0 F-03;
    // on 0.6.0 provDiff did not know these keys and returned no difference)
    const pA = JSON.parse(JSON.stringify(prov)); pA.settings = Object.assign({}, pA.settings, { rainSource: "uniform", rainInHr: 1, rainHours: 6, gauge: null, drainInHr: 0, dtMax: 5, inlets: { lw: 5, cw: 3, inletArea: 3, co: 0.6, clog: 0, defaultInlets: true }, boundaries: [{ key: "Pond", node: null, routed: true, level: 54.8, areaAc: null }] });
    const pB = JSON.parse(JSON.stringify(pA)); pB.settings.rainInHr = 4; pB.settings.rainHours = 2;
    const pC = JSON.parse(JSON.stringify(pA)); pC.settings.inlets.clog = 0.25; pC.settings.boundaries[0].level = 55.5;
    const dRain = RIO.provDiff(pA, pB), dInl = RIO.provDiff(pA, pC);
    ok("R-C3 provenance diffs name a rain-only difference, an inlet-panel difference and a boundary-level difference",
      dRain.length === 2 && /rainInHr: 1 vs 4/.test(dRain[0]) && /rainHours: 6 vs 2/.test(dRain[1]) &&
      dInl.length === 2 && /inlet clog: 0 vs 0.25/.test(dInl[0]) && /boundary Pond level: 54.8 vs 55.5/.test(dInl[1]),
      `rain: ${dRain.join("; ") || "none"}; inlet/boundary: ${dInl.join("; ") || "none"}`);
    // R-C4 (review 0.6.1 WRK6-3, P-03) the grid and surface settings are compared too: two runs differing only in Manning n pervious,
    // closed edges or the vertical unit are named as different; and a run with no provenance gives null (unknown), not "no difference"
    const sur = { cellSize: 12, vUnitFt: 1, useBuildings: true, closedEdges: false, nPerv: 0.1, lcTable: { 41: { n: 0.36, imp: 0 } } };
    const pD = JSON.parse(JSON.stringify(pA)); pD.settings.surface = sur;
    const pE = JSON.parse(JSON.stringify(pD)); Object.assign(pE.settings.surface, { nPerv: 0.4, closedEdges: true, vUnitFt: 0.3048 });
    const pF = JSON.parse(JSON.stringify(pD)); pF.settings.surface.lcTable = { 41: { n: 0.2, imp: 0 } };
    const dS = RIO.provDiff(pD, pE), dT = RIO.provDiff(pD, pF);
    ok("R-C4 differences in Manning n, closed edges, vertical unit and the land cover table are named; missing provenance is unknown (null), not identical",
      dS.length === 3 && dS.some((x) => /nPerv: 0.1 vs 0.4/.test(x)) && dS.some((x) => /closedEdges: false vs true/.test(x)) && dS.some((x) => /vUnitFt: 1 vs 0.3048/.test(x)) && dT.length === 1 && /lcTable/.test(dT[0]) &&
      RIO.provDiff(pD, null) === null && RIO.provDiff(null, null) === null && RIO.provDiff(pD, pD).length === 0,
      `${dS.join("; ")} | ${dT.join("; ")} | null case: ${JSON.stringify(RIO.provDiff(pD, null))}`);
  }
  // R-C1 comparing two runs on the same grid: per-cell change in maximum depth and the areas gained and lost (hand-made 2 x 2 runs)
  {
    const G = { nx: 2, ny: 2, x0: 0, y1: 0, cs: 10, dxFt: 10 }, ga = { G, type: Uint8Array.from([0, 0, 0, 1]) }, gb = { G, type: Uint8Array.from([0, 0, 0, 1]) };
    const fa = { hmax: Float32Array.from([0.5, 0.05, 1.0, 9]), bReached: 3 }, fb = { hmax: Float32Array.from([0.2, 0.3, 1.05, 9]), bReached: 1 };
    const c = RIO.compare(ga, fa, gb, fb, 0.1, 0.1), ac = 100 / 43560;
    ok("R-C1 change in maximum depth per cell, with cells dry in both and walls left out", Math.abs(c.diff[0] - 0.3) < 1e-6 && Math.abs(c.diff[1] + 0.25) < 1e-6 && Math.abs(c.diff[2] + 0.05) < 1e-6 && Number.isNaN(c.diff[3]),
      Array.from(c.diff).map((v) => (Number.isNaN(v) ? "NaN" : v.toFixed(2))).join(", "));
    ok("R-C1 areas: wet only here, only in the other run, in both; deeper and shallower by at least 0.1 ft", Math.abs(c.acres.onlyThis) < 1e-12 && Math.abs(c.acres.onlyOther - ac) < 1e-12 && Math.abs(c.acres.both - 2 * ac) < 1e-12 &&
      Math.abs(c.acres.deeper - ac) < 1e-12 && Math.abs(c.acres.shallower - ac) < 1e-12 && Math.abs(c.maxRise - 0.3) < 1e-6 && Math.abs(c.maxDrop + 0.25) < 1e-6 && c.buildings.this === 3 && c.buildings.other === 1, JSON.stringify(c.acres));
    let m = ""; try { RIO.compare(ga, fa, { G: Object.assign({}, G, { cs: 5 }), type: gb.type }, fb, 0.1); } catch (e) { m = e.message; }
    ok("R-C1 runs on different grids are refused, naming the difference", /different grids \(cell size: 10 vs 5\)/.test(m), m);
    let m2 = ""; try { RIO.compare(ga, fa, { G: Object.assign({}, G, { dxFt: 10 / 0.3048 }), type: gb.type }, fb, 0.1); } catch (e) { m2 = e.message; }
    ok("R-C1 the same numbers in feet and in meters are refused", /cell size in feet/.test(m2), m2);
  }
  // R-C2 the "deeper" count uses the per-cell change as it is stored and mapped (Float32), so a cell mapped as deeper is counted as deeper
  {
    const G = { nx: 1, ny: 1, x0: 0, y1: 0, cs: 1, dxFt: 1 }, g = { G, type: new Uint8Array(1) };
    const c = RIO.compare(g, { hmax: Float32Array.of(0.1) }, g, { hmax: Float32Array.of(3e-9) }, 0.05, 0.1);
    ok("R-C2 a change stored as 0.1 ft (Float32) is counted as deeper by 0.1 ft, as the map shows it", c.diff[0] >= 0.1 && c.acres.deeper === 1 / 43560, `stored change ${c.diff[0]}; deeper ${c.acres.deeper * 43560} cells`);
  }
  const bad2 = res.filter((x) => !x.pass).length; console.log(bad2 ? `${bad2} FAILED` : `ALL PASS (${res.length} checks)`); process.exit(bad2 ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
