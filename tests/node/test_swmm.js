// SWMM readers against the EPA SWMM engine (swmm-toolkit reference files): node tests/node/test_swmm.js   (exit 1 on failure)
// Reference files are made by tests/py/make_swmm_reference.py.
const fs = require("fs"), path = require("path");
const S = require(process.env.SWMMJS || "../../src/io/swmm.js");
const res = []; const ok = (name, pass, info) => { res.push({ name, pass: !!pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + "  " + info); };
const ex = (d) => path.join(__dirname, "../../examples", d);
function expectError(name, fn, re) { try { fn(); ok(name, false, "no error"); } catch (e) { ok(name, re.test(e.message), "error: " + e.message); } }

for (const d of ["synthetic_us", "synthetic_si", "public_demo"]) {
  const ref = JSON.parse(fs.readFileSync(path.join(ex(d), "swmm_reference.json")));
  const m = S.parseInp(fs.readFileSync(path.join(ex(d), "model.inp"), "utf8"));
  // nodes: names, types, inverts, depths as the SWMM engine reads them
  let worst = 0, typeOk = true;
  for (const r of ref.nodes) {
    const n = m.nodes[m.nodeIndex[r.name]]; if (!n) { typeOk = false; continue; }
    if (n.type !== r.type) typeOk = false;
    if (r.type !== "OUTFALL") worst = Math.max(worst, Math.abs(n.maxDepth - r.maxDepth));
    worst = Math.max(worst, Math.abs(n.invert - r.invert));
  }
  ok(`[${d}] .inp nodes match the SWMM engine`, m.nodes.length === ref.nodes.length && typeOk && worst < 1e-3, `${m.nodes.length} nodes; worst invert/depth difference ${worst.toExponential(2)}; types ${typeOk ? "match" : "differ"}`);
  ok(`[${d}] .inp nodes all have coordinates`, m.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)) && m.warnings.length === 0, `warnings: ${JSON.stringify(m.warnings)}`);
  ok(`[${d}] .inp units`, m.unitSystem === (d.endsWith("si") ? "SI" : "US") && m.reportStepSec === 300 && m.start.toISOString() === (d === "public_demo" ? "2024-08-01T00:00:00.000Z" : "2024-07-15T00:00:00.000Z"), `${m.flowUnits} ${m.unitSystem}, report step ${m.reportStepSec} s, start ${m.start.toISOString()}`);
  // rain: the gauge total equals the report's total precipitation (inches; SI report is mm)
  const rain = S.gaugeRain(m, "RG1"), rptIn = d.endsWith("si") ? ref.rptTotalPrecipDepth / 25.4 : ref.rptTotalPrecipDepth;
  ok(`[${d}] rain gauge total equals the SWMM report`, Math.abs(rain.totalIn - rptIn) < 0.01 && rain.stepSec === 300, `${rain.totalIn.toFixed(4)} in from the series, ${rptIn.toFixed(4)} in in the report, step ${rain.stepSec} s, ${rain.values.length} intervals`);
  // .out
  const o = S.readOut(fs.readFileSync(path.join(ex(d), "model.out")));
  ok(`[${d}] .out header`, o.nPeriods === ref.nPeriods && o.reportStepSec === ref.reportStepSec && o.nodeNames.join() === ref.outNodeNames.join() && o.unitSystem === m.unitSystem,
    `${o.nPeriods} periods, ${o.reportStepSec} s step, ${o.nodeNames.length} nodes, ${o.flowUnits}`);
  const startMs = Math.round((ref.startDays - 25569) * 86400000);
  ok(`[${d}] .out times: first value one report step after the start`, o.start.getTime() === startMs && o.times[0].getTime() === startMs + 300000 && Math.abs(o.dateAt(0).getTime() - o.times[0].getTime()) < 1000,
    `start ${o.start.toISOString()}, first ${o.times[0].toISOString()}, stored ${o.dateAt(0).toISOString()}`);
  let wf = 0, wh = 0;
  for (const nm of ref.outNodeNames) {
    const f = o.getNodeSeries(nm, "flooding"), h = o.getNodeSeries(nm, "head");
    ref.flooding[nm].forEach((v, i) => { wf = Math.max(wf, Math.abs(f[i] - v)); }); ref.head[nm].forEach((v, i) => { wh = Math.max(wh, Math.abs(h[i] - v)); });
  }
  ok(`[${d}] .out flooding and head series equal the SWMM output API`, wf === 0 && wh === 0, `max difference flooding ${wf}, head ${wh}`);
  // flooding volume from the series against the report's flooding loss (point samples, so within a few percent)
  let vol = 0; for (const nm of o.nodeNames) for (const q of o.getNodeSeries(nm, "flooding")) vol += q * o.reportStepSec;   // file flow units x s
  const rptVol = d.endsWith("si") ? ref.rptFloodingLoss[1] * 1e6 / 1000 : ref.rptFloodingLoss[0] * 43560;   // m3 or cf
  ok(`[${d}] flooding volume from the series is close to the report`, Math.abs(vol - rptVol) / rptVol < 0.05, `${vol.toFixed(0)} from the series, ${rptVol.toFixed(0)} in the report (${(100 * (vol - rptVol) / rptVol).toFixed(2)}%)`);
}
// refusals
const good = fs.readFileSync(path.join(ex("synthetic_us"), "model.out"));
expectError("refuses a file that is not SWMM output", () => S.readOut(new Uint8Array(100)), /Not a SWMM/);
expectError("refuses a truncated output file", () => S.readOut(good.subarray(0, good.length - 1000)), /incomplete|truncated/);
expectError("refuses an empty input file", () => S.parseInp("  \n"), /empty/);
expectError("refuses text that is not SWMM input", () => S.parseInp("hello\nworld"), /does not look like/);
expectError("refuses a rain series out of time order", () => S.gaugeRain(S.parseInp("[OPTIONS]\nFLOW_UNITS CFS\nSTART_DATE 01/01/2024\nSTART_TIME 0:00\n[RAINGAGES]\nRG INTENSITY 0:05 1 TIMESERIES T\n[TIMESERIES]\nT 0:10 1\nT 0:05 2\n"), "RG"), /time order/);
expectError("refuses a rain gauge that reads a file", () => S.gaugeRain(S.parseInp("[OPTIONS]\nFLOW_UNITS CFS\n[RAINGAGES]\nRG INTENSITY 0:05 1 FILE rain.dat STA IN\n"), "RG"), /rainfall file/);
expectError("refuses a non-numeric junction elevation", () => S.parseInp("[JUNCTIONS]\nJ1 abc 5\n"), /Junction J1 elevation/);
expectError("refuses a node defined twice", () => S.parseInp("[JUNCTIONS]\nJ1 10 5\nJ1 11 5\n"), /defined twice/);
// rain formats: VOLUME and CUMULATIVE give the same intensity as INTENSITY
{
  const mk = (fmt, vals) => S.gaugeRain(S.parseInp(`[OPTIONS]\nFLOW_UNITS CFS\nSTART_DATE 01/01/2024\nSTART_TIME 0:00\n[RAINGAGES]\nRG ${fmt} 0:15 1 TIMESERIES T\n[TIMESERIES]\n` + vals.map((v, i) => `T ${Math.floor(i * 15 / 60)}:${String(i * 15 % 60).padStart(2, "0")} ${v}`).join("\n") + "\n"), "RG").values;
  const a = mk("INTENSITY", [2, 4, 0]), b = mk("VOLUME", [0.5, 1, 0]), c = mk("CUMULATIVE", [0, 0.5, 1.5, 1.5]);
  ok("rain formats agree (intensity, volume, cumulative)", JSON.stringify(a.slice(0, 2)) === JSON.stringify([2, 4]) && JSON.stringify(b.slice(0, 2)) === "[2,4]" && JSON.stringify(c.slice(0, 2)) === "[2,4]", `${a.slice(0, 2)} | ${b.slice(0, 2)} | ${c.slice(0, 2)}`);
}
// dated time series spanning midnight
{
  const m = S.parseInp("[OPTIONS]\nFLOW_UNITS CFS\nSTART_DATE 01/01/2024\nSTART_TIME 23:00\n[RAINGAGES]\nRG INTENSITY 1:00 1 TIMESERIES T\n[TIMESERIES]\nT 01/01/2024 23:00 1\nT 01/02/2024 00:00 2\nT 01:00 3\n");
  const r = S.gaugeRain(m, "RG"); ok("dated series across midnight", JSON.stringify(r.values) === "[1,2,3]", JSON.stringify(r.values));
}
const bad = res.filter((r) => !r.pass).length; console.log(bad ? `${bad} FAILED` : "ALL PASS"); process.exit(bad ? 1 : 0);
