#!/usr/bin/env python3
"""Browser tests of the built app (Playwright + Chromium): python tests/browser/test_app.py [dist/FloodSimulator.html]   exit 1 on failure.
Runs the paths a user takes: example load, own files through the file inputs, CPU and GPU runs, map, 3D, exports, Stop,
bad input, phone width and dark theme. GPU runs need Chromium with WebGPU (SwiftShader works with --enable-unsafe-webgpu)."""
import json, os, sys, tempfile, time
import numpy as np, rasterio
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
APP = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "dist", "FloodSimulator.html"))
TMP = tempfile.mkdtemp(prefix="fsim_")
res = []
def ok(name, cond, info=""):
    res.append((name, bool(cond))); print(("PASS " if cond else "FAIL ") + name + ("  " + str(info)[:300] if info != "" else ""), flush=True)

def wait_done(pg, timeout=900):
    pg.wait_for_function("/^(Done|Stopped|Run failed)/.test(document.querySelector('#msg').textContent) || /^(err)$/.test(document.querySelector('#msg').className)", timeout=timeout * 1000)
    return pg.inner_text("#msg")

def settings(pg, cell_index=1, t0="0.5", t1="1.5", outmin="10", engine="cpu"):
    pg.select_option("#cell", index=cell_index); pg.fill("#t0", t0); pg.fill("#t1", t1); pg.fill("#outmin", outmin); pg.select_option("#engine", engine)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--enable-unsafe-webgpu", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
    ctx = b.new_context(viewport={"width": 1400, "height": 1000}, accept_downloads=True)
    ctx.route("**/*", lambda r: r.abort() if r.request.url.startswith("http") else r.continue_())   # offline: basemap tiles are blocked
    pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append("PAGE " + str(e)))
    pg.on("console", lambda m: errs.append("CONSOLE " + m.text) if m.type == "error" and "ERR_FAILED" not in m.text and "Failed to load resource" not in m.text else None)
    pg.goto("file://" + APP); pg.wait_for_selector("#ex-load")

    # ---- B1 example loads with SWMM results and the pond tied to the SWMM storage node
    pg.select_option("#ex-pick", "0"); pg.click("#ex-load")
    pg.wait_for_function("/Loaded example|Could not/.test(document.querySelector('#msg').textContent)", timeout=120000)
    ok("B1 example loads (DEM, buildings, pond, SWMM)", "EPSG 2236" in pg.inner_text("#st-dem") and "30 footprints" in pg.inner_text("#st-bld") and "7 nodes flood" in pg.inner_text("#st-out")
       and pg.eval_on_selector(".b-src", "e => e.value") == "POND", pg.inner_text("#st-out"))

    # ---- B2 CPU run: closes, and the SWMM inflow volume equals the trapezoid integral of the node series over the window
    settings(pg); pg.click("#b-run"); msg = wait_done(pg)
    L = pg.evaluate("S.final.ledger")
    expect = pg.evaluate("""(()=>{ const t0=+document.querySelector('#t0').value, t1=+document.querySelector('#t1').value; let v=0;
        for (const s of S.sources) { const n=S.swmm.nodes.find(x=>x.name===s.name); const N=2000; for (let i=0;i<N;i++){ const a=t0+(t1-t0)*i/N, b2=t0+(t1-t0)*(i+1)/N; v+=0.5*(nodeFloodAt(n,a)+nodeFloodAt(n,b2))*(b2-a)*3600; } } return v; })()""")
    ok("B2 CPU run finishes and the water balance closes", msg.startswith("Done") and abs(L["errPct"]) < 0.01, msg)
    ok("B2 SWMM inflow volume matches the node series over the window", abs(L["inflow"] - expect) / expect < 0.002, f"ledger {L['inflow']:.0f} cf, series {expect:.0f} cf")
    nfr = pg.evaluate("S.frames.length")
    ok("B2 one map every 10 minutes", nfr == 6, f"{nfr} maps")
    info = pg.evaluate("S.grid.info")
    ground = info["cells"] - info["nodataCells"]
    ok("B14 land cover and soils set the surface of every ground cell", info["landcoverCells"] > 0.99 * ground and info["soilCells"] == ground and "41 Deciduous forest" in pg.inner_text("#lc-table") and "silt loam" in pg.inner_text("#soil-table"),
       f"{info['landcoverCells']} land cover cells, {info['soilCells']} soil cells of {ground} ground cells")
    cpu_hmax = np.array(pg.evaluate("Array.from(S.final.hmax)"))
    us_type = np.array(pg.evaluate("Array.from(S.grid.type)"))
    cpu_vmax = np.array(pg.evaluate("Array.from(S.final.vmax)")); cpu_fr = np.array(pg.evaluate("Array.from(S.final.froude)"))

    # ---- B3 map shows water, KPIs filled, clicking the map gives a point series
    pix = pg.evaluate("""new Promise(r=>{const im=new Image(); im.onload=()=>{const c=document.createElement('canvas'); c.width=im.width; c.height=im.height; const x=c.getContext('2d'); x.drawImage(im,0,0); const d=x.getImageData(0,0,c.width,c.height).data; let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>0) n++; r(n);}; im.src=MAP._layers2.depth._url;})""")
    ok("B3 depth overlay has wet pixels", pix > 50, f"{pix} pixels")
    kp = pg.inner_text("#kpis")
    ok("B3 KPIs show flooding", "Flooded area" in kp and "SWMM flooding into the 2D" in kp, kp.replace("\n", " | "))
    wettest = int(np.argmax(cpu_hmax))
    pg.evaluate(f"""(()=>{{ const G=S.grid.G, k={wettest}, r=Math.floor(k/G.nx), c=k%G.nx; const x=G.x0+(c+0.5)*G.cs, y=G.y1-(r+0.5)*G.cs; MAP.fire('click', {{latlng: toLL(x,y)}}); }})()""")
    pg.wait_for_timeout(500)
    ok("B3 map click picks a point and charts its depth", pg.evaluate("S.sel") == wettest and pg.evaluate("document.getElementById('c-pt').data[0].y.length") == nfr, pg.evaluate("S.sel"))

    pg.select_option("#view", "vmax"); pg.wait_for_timeout(600)
    nfl = int(cpu_fr.sum())
    ok("B3 velocity view: legend and KPI, with the cells capped at critical speed counted and explained", "Maximum velocity (ft/s)" in pg.inner_text("#legend") and "Fastest flow" in pg.inner_text("#kpis")
       and (nfl == 0 or (f"{nfl:,} cells capped at critical speed" in pg.inner_text("#kpis") and "lower bound" in pg.inner_text("#legend"))), f"{nfl} capped cells; " + pg.inner_text("#kpis").replace("\n", " | ")[:160])
    pg.select_option("#view", "dv"); pg.wait_for_timeout(600)
    ok("B3 depth x velocity view: legend and KPI", "depth × velocity" in pg.inner_text("#legend") and "Highest depth × velocity" in pg.inner_text("#kpis"), "")
    pg.select_option("#view", "now"); pg.wait_for_timeout(300)

    # ---- B4 exports
    with pg.expect_download() as d: pg.click("#x-tif")
    tif = os.path.join(TMP, d.value.suggested_filename); d.value.save_as(tif)
    with rasterio.open(tif) as ds:
        a = ds.read(1); nod = ds.nodata; crs = ds.crs.to_epsg(); nb = ds.count; desc = ds.descriptions
    G = pg.evaluate("S.grid.G"); h_app = cpu_hmax.reshape(G["ny"], G["nx"])
    open_mask = np.array(pg.evaluate("Array.from(S.grid.type)")).reshape(G["ny"], G["nx"]) == 0
    with rasterio.open(tif) as ds: v4 = ds.read(4); v5 = ds.read(5); v6 = ds.read(6)
    vapp = np.array(pg.evaluate("Array.from(S.final.vmax)")).reshape(G["ny"], G["nx"]); wetm = open_mask & (h_app > 0)
    dvapp = np.array(pg.evaluate("Array.from(S.final.dvmax)")).reshape(G["ny"], G["nx"]); frapp = cpu_fr.reshape(G["ny"], G["nx"])
    ok("B4 GeoTIFF velocity, depth x velocity and critical-cap bands equal the run cell by cell", np.allclose(v4[wetm], vapp[wetm], atol=1e-6) and np.allclose(v5[wetm], dvapp[wetm], atol=1e-6) and np.array_equal(v6[wetm], frapp[wetm])
       and v4.max() > 0 and v5.max() > 0 and (v5[~wetm] == -9999).all(), f"max velocity {v4.max():.2f} ft/s, max D x V {v5.max():.2f} ft2/s, {int((v6 == 1).sum())} capped cells")
    ok("B4 GeoTIFF: CRS, 6 bands, NoData, values equal the run", crs == 2236 and nb == 6 and nod == -9999 and np.allclose(a[open_mask], h_app[open_mask], atol=1e-6) and (a[~open_mask] == -9999).all(),
       f"EPSG {crs}, {nb} bands {desc}, max {a.max():.3f} ft")
    with pg.expect_download() as d: pg.click("#x-csv")
    csvb = os.path.join(TMP, "b.csv"); d.value.save_as(csvb); rows = open(csvb).read().strip().splitlines()
    ok("B4 buildings CSV has one row per footprint", len(rows) == 31 and rows[0].startswith("building,"), f"{len(rows) - 1} rows")
    with pg.expect_download() as d: pg.click("#x-nodes")
    csvn = os.path.join(TMP, "n.csv"); d.value.save_as(csvn); rows = open(csvn).read().strip().splitlines()
    ok("B4 SWMM inflow CSV has a column per inflow node", len(rows[0].split(",")) == 2 + len(pg.evaluate("S.sources")) and len(rows) == nfr + 1, rows[0])

    # ---- B16 save, reload the page, open: the same results without the inputs
    # the same view and map on both sides: depth now, at the last map
    pg.select_option("#view", "now"); pg.evaluate("S.frame = S.frames.length - 1; paint()"); pg.wait_for_timeout(300)
    snap = "({kp: document.querySelector('#kpis').innerText, area: Array.from(document.getElementById('c-area').data[0].y), q: Array.from(S.frames[S.frames.length - 1].q), led: document.querySelector('#ledger').innerText})"
    before = pg.evaluate(snap); h0 = cpu_hmax; opts0 = pg.evaluate("({imp: document.querySelector('#imp').value, cfl: document.querySelector('#cfl').value, t1: document.querySelector('#t1').value, n41: document.querySelector('.lc-n[data-c=\"41\"]').value})")
    with pg.expect_download() as d: pg.click("#x-save")
    resf = os.path.join(TMP, d.value.suggested_filename); d.value.save_as(resf)
    pg.reload(); pg.wait_for_selector("#ex-load")
    pg.fill("#imp", "12"); pg.fill("#cfl", "0.3"); pg.fill("#t1", "9")   # the panel holds other values when the file is opened
    pg.set_input_files("#f-res", resf); pg.wait_for_function("/Opened|Could not/.test(document.querySelector('#msg').textContent)", timeout=60000)
    h1 = np.array(pg.evaluate("Array.from(S.final.hmax)"))
    opened = pg.inner_text("#msg")
    pg.select_option("#view", "now"); pg.evaluate("S.frame = S.frames.length - 1; paint()"); pg.wait_for_timeout(300)
    after = pg.evaluate(snap)
    ok("B16 reopened results equal the run (maxima, maps, KPIs, charts, water balance) with no inputs loaded", "Opened" in opened and np.array_equal(h0, h1) and pg.evaluate("S.frames.length") == nfr
       and after["kp"] == before["kp"] and after["area"] == before["area"] and after["q"] == before["q"] and after["led"] == before["led"] and max(before["area"]) > 0,
       f"{opened[:60]}; KPIs {'same' if after['kp'] == before['kp'] else 'differ'}; area chart {'same' if after['area'] == before['area'] else 'differs'}; {os.path.getsize(resf) / 1e6:.2f} MB")
    opts1 = pg.evaluate("({imp: document.querySelector('#imp').value, cfl: document.querySelector('#cfl').value, t1: document.querySelector('#t1').value, n41: document.querySelector('.lc-n[data-c=\"41\"]').value})")
    ok("B16 the panel shows the saved run's settings, not what was typed before opening", opts1 == opts0, f"{opts1} vs run {opts0}")
    pg.select_option("#vunit", "ft"); pg.wait_for_timeout(200)
    ok("B16 Run stays off while saved results are open (also after a settings change)", pg.is_disabled("#b-run") and pg.is_disabled("#f-bld") is False, pg.inner_text("#msg")[:80])
    pg.select_option("#vunit", "auto")
    with pg.expect_download() as d: pg.click("#x-tif")
    tif2 = os.path.join(TMP, "re.tif"); d.value.save_as(tif2)
    with rasterio.open(tif) as a1, rasterio.open(tif2) as a2: same_tif = np.array_equal(a1.read(), a2.read()) and a1.transform == a2.transform and a1.crs == a2.crs
    ok("B16 GeoTIFF from the reopened results is identical", same_tif)
    import gzip as _gz
    raw = _gz.decompress(open(resf, "rb").read())
    for label, data in [("truncated", _gz.compress(raw[: len(raw) // 2])), ("not gzip or results", b"hello world"), ("future version", _gz.compress(raw.replace(b'"version":1', b'"version":9', 1)))]:
        bp = os.path.join(TMP, "bad.fsim.gz"); open(bp, "wb").write(data)
        pg.set_input_files("#f-res", bp); pg.wait_for_function("/Opened|Could not/.test(document.querySelector('#msg').textContent)", timeout=60000)
        ok(f"B16 refuses a {label} file", "Could not open" in pg.inner_text("#msg"), pg.inner_text("#msg"))
    pg.select_option("#ex-pick", "0"); pg.click("#ex-load"); pg.wait_for_function("/Loaded example/.test(document.querySelector('#msg').textContent)", timeout=120000)
    settings(pg); pg.click("#b-run"); wait_done(pg)

    # ---- B5 3D view renders water
    pg.click("#t-3d"); pg.wait_for_timeout(3000)
    ok("B5 3D view renders with water", pg.evaluate("!!document.querySelector('#v3d canvas') && V3.wat.geometry.drawRange.count > 0"), pg.evaluate("V3.wat ? V3.wat.geometry.drawRange.count : null"))
    pg.click("#t-map")

    # ---- B6 GPU run with the same settings matches the CPU
    has_gpu = pg.evaluate("'gpu' in navigator")
    if has_gpu:
        settings(pg, engine="gpu"); pg.click("#b-run"); msg = wait_done(pg)
        gpu_hmax = np.array(pg.evaluate("Array.from(S.final.hmax)"))
        ok("B6 GPU run matches the CPU (max depth within 0.005 ft)", "on the GPU" in msg and np.abs(gpu_hmax - cpu_hmax).max() < 5e-3, f"{msg[:80]}; max diff {np.abs(gpu_hmax - cpu_hmax).max():.2e} ft")
        gpu_vmax = np.array(pg.evaluate("Array.from(S.final.vmax)"))
        ok("B6 GPU velocity maxima match the CPU (within 0.01 ft/s)", np.abs(gpu_vmax - cpu_vmax).max() < 1e-2 and gpu_vmax.max() > 0, f"max diff {np.abs(gpu_vmax - cpu_vmax).max():.2e} ft/s; fastest {gpu_vmax.max():.2f} ft/s")
        gpu_fr = np.array(pg.evaluate("Array.from(S.final.froude)")); nd = int((gpu_fr != cpu_fr).sum())
        ok("B6 GPU critical-cap flags match the CPU (all but a few borderline cells)", nd <= max(5, 0.01 * cpu_fr.sum()), f"CPU {int(cpu_fr.sum())}, GPU {int(gpu_fr.sum())} capped cells; {nd} differ")
    else:
        ok("B6 GPU run (skipped: no WebGPU in this browser)", True, "not tested")

    # ---- B7 bad input is refused where it is typed and at Run
    pg.fill("#t1", "0.2"); pg.fill("#t0", "0.5"); pg.click("#b-run"); pg.wait_for_timeout(300)
    ok("B7 end before start is refused", "end must be after the start" in pg.inner_text("#msg") and pg.evaluate("S.frames.length") == nfr, pg.inner_text("#msg"))
    pg.fill("#imp", "150"); pg.wait_for_timeout(100)
    ok("B7 out-of-range value is marked", pg.get_attribute("#imp", "aria-invalid") == "true")
    pg.click("#b-run"); pg.wait_for_timeout(300)
    ok("B7 out-of-range value blocks the run", "Impervious fraction" in pg.inner_text("#msg"), pg.inner_text("#msg"))
    pg.fill("#imp", "40")

    # ---- B8 own files through the file inputs (SI example), buildings given in lon/lat
    import geopandas as gpd
    si = os.path.join(ROOT, "examples", "synthetic_si")
    pg.fill(".lc-n[data-c=\"41\"]", "0.2"); state0 = pg.evaluate("({lc: JSON.stringify(S.lc && S.lc.classes), ex: S.exName, st: document.querySelector('#st-lc').innerText})")
    badtif = os.path.join(TMP, "bad.tif"); open(badtif, "w").write("not a tiff")
    pg.set_input_files("#f-dem", badtif); pg.wait_for_function("/Could not|Loaded/.test(document.querySelector('#msg').textContent)", timeout=60000)
    state1 = pg.evaluate("({lc: JSON.stringify(S.lc && S.lc.classes), ex: S.exName, st: document.querySelector('#st-lc').innerText})")
    ok("B17 a DEM that fails to load changes nothing (layers, example, table edits)", "Could not read bad.tif" in pg.inner_text("#msg") and state1 == state0 and pg.input_value(".lc-n[data-c=\"41\"]") == "0.2" and pg.input_value("#f-dem") == "",
       pg.inner_text("#msg")[:90])
    # a refused land cover file (too many distinct values) leaves the accepted one in use
    with rasterio.open(os.path.join(ROOT, "examples", "synthetic_us", "landcover.tif")) as src0:
        prof = src0.profile; arr = (np.arange(src0.width * src0.height).reshape(src0.height, src0.width) % 100).astype(prof["dtype"])
    many = os.path.join(TMP, "lc_many.tif")
    with rasterio.open(many, "w", **prof) as dst: dst.write(arr, 1)
    pg.set_input_files("#f-lc", many); pg.wait_for_function("/Could not|Loaded lc_many/.test(document.querySelector('#msg').textContent)", timeout=60000)
    settings(pg); gr = pg.evaluate("call('build', runOptions()).then((g) => g.info.landcoverCells)")
    ok("B17 a refused land cover file leaves the accepted one in use (status, table and the next build)", "Nothing was changed" in pg.inner_text("#msg") and pg.evaluate("JSON.stringify(S.lc.classes)") == state0["lc"] and pg.input_value("#f-lc") == "" and gr == info["landcoverCells"],
       f"{pg.inner_text('#msg')[:70]}; land cover cells {gr} (run {info['landcoverCells']})")
    gpd.read_file(os.path.join(si, "buildings.geojson")).to_crs(4326).to_file(os.path.join(TMP, "bld_lonlat.geojson"), driver="GeoJSON")
    pg.set_input_files("#f-dem", os.path.join(si, "dem.tif")); pg.wait_for_function("/Loaded dem\\.tif|Could not read dem/.test(document.querySelector('#msg').textContent)", timeout=60000)
    ok("B8 a new DEM clears the layers of the previous site", pg.evaluate("!S.bld && !S.bnd && !S.lc && !S.soil && !S.inl && !S.swmm") and "were cleared" in pg.inner_text("#msg"), pg.inner_text("#msg")[:120])
    pg.set_input_files("#f-inl", os.path.join(ROOT, "examples", "synthetic_us", "inlets.geojson")); pg.wait_for_function("/Loaded inlets|Could not/.test(document.querySelector('#msg').textContent)", timeout=60000)
    nmk = pg.evaluate("MAP._layers2.swmm ? MAP._layers2.swmm.getLayers().length : 0")
    ok("B17 inlets show on the map before a SWMM .inp is loaded", nmk == 14 and not pg.evaluate("S.swmm"), f"{nmk} inlet markers")
    pg.set_input_files("#f-bld", os.path.join(TMP, "bld_lonlat.geojson")); pg.wait_for_function("/Loaded bld_lonlat|Could not/.test(document.querySelector('#msg').textContent)", timeout=60000)
    pg.set_input_files("#f-bnd", os.path.join(si, "pond.geojson")); pg.wait_for_function("/Loaded pond|Could not/.test(document.querySelector('#msg').textContent)", timeout=60000)
    pg.set_input_files("#f-lc", os.path.join(si, "landcover.tif")); pg.wait_for_function("/Loaded landcover|Could not/.test(document.querySelector('#msg').textContent)", timeout=60000)
    pg.set_input_files("#f-soil", os.path.join(si, "soils.geojson")); pg.wait_for_function("/Loaded soils|Could not/.test(document.querySelector('#msg').textContent)", timeout=60000)
    ok("B8 land cover and soils load through the file inputs", "EPSG 5070" in pg.inner_text("#st-lc") and "treated as D" in pg.inner_text("#st-soil"), pg.inner_text("#st-lc")[:60] + " | " + pg.inner_text("#st-soil")[:120])
    pg.set_input_files("#f-inp", os.path.join(si, "model.inp")); pg.wait_for_function("/Loaded model.inp|Could not/.test(document.querySelector('#msg').textContent)", timeout=60000)
    pg.set_input_files("#f-out", os.path.join(si, "model.out")); pg.wait_for_function("/Loaded model.out|Could not/.test(document.querySelector('#msg').textContent)", timeout=60000)
    ok("B8 SI files load through the file inputs", "EPSG 26917" in pg.inner_text("#st-dem") and "reprojected from longitude/latitude" in pg.inner_text("#st-bld") and "CMS" in pg.inner_text("#st-inp"),
       pg.inner_text("#st-bld"))
    ok("B8 pond picks up its SWMM node once the SWMM files arrive", pg.eval_on_selector(".b-src", "e => e.value") == "POND", pg.eval_on_selector(".b-src", "e => e.value"))
    settings(pg); pg.click("#b-run"); msg = wait_done(pg)
    if not msg.startswith("Done"): print("B8 run message:", msg)
    si_hmax = np.array(pg.evaluate("Array.from(S.final.hmax)")); Lsi = pg.evaluate("S.final.ledger")
    # building footprints with edges exactly on cell centres rasterize differently in the US grid (ties), so compare the flood as a whole
    dd = np.abs(si_hmax - cpu_hmax); frac = float((dd > 0.05).mean())
    si_type = np.array(pg.evaluate("Array.from(S.grid.type)")); Gx = pg.evaluate("S.grid.G")
    tdiff = np.argwhere((si_type != us_type).reshape(Gx["ny"], Gx["nx"])); kmax = int(np.argmax(dd)); rm, cm = divmod(kmax, Gx["nx"])
    near = bool(len(tdiff)) and int(np.abs(tdiff - [rm, cm]).max(axis=1).min()) <= 3
    ok("B8 the largest US/SI difference sits next to a building cell that rasterized differently", dd.max() < 0.05 or near, f"max {dd.max():.3f} ft at row {rm}, col {cm}; {len(tdiff)} cells differ in type; nearest {int(np.abs(tdiff - [rm, cm]).max(axis=1).min()) if len(tdiff) else None} cells away")
    ok("B8 SI model gives the same flood as the US model (lon/lat buildings reprojected)", msg.startswith("Done") and abs(Lsi["inflow"] - L["inflow"]) / L["inflow"] < 0.01 and frac < 0.005 and abs(si_hmax.max() - cpu_hmax.max()) < 0.05,
       f"inflow {Lsi['inflow']:.0f} vs {L['inflow']:.0f} cf; {100 * frac:.3f}% of cells differ by more than 0.05 ft; deepest {si_hmax.max():.3f} vs {cpu_hmax.max():.3f} ft")

    # ---- B12 two-way coupling: SWMM 5.2.4 runs in the page and takes water back through the inlets
    pg.select_option("#ex-pick", "0"); pg.click("#ex-load"); pg.wait_for_function("/Loaded example/.test(document.querySelector('#msg').textContent)", timeout=120000)
    ok("B17 loading an example clears every file box, inlets included", all(pg.input_value(x) == "" for x in ["#f-dem", "#f-bld", "#f-bnd", "#f-lc", "#f-soil", "#f-inl", "#f-inp", "#f-out"]), "")
    pg.select_option("#rain", "gauge"); pg.evaluate("waterNotes()"); warn_sub = pg.is_visible("#double-warn")
    pg.evaluate("S.swmm.subcatchments = 0; waterNotes()"); warn_none = pg.is_visible("#double-warn")
    ok("B17 the double-counting warning shows only when the SWMM model makes its own runoff (subcatchments)", warn_sub and not warn_none, f"with {pg.evaluate('S.swmm.subcatchmentGauges.length')} gauges used by subcatchments: {warn_sub}; with none: {warn_none}")
    pg.select_option("#rain", "none"); pg.evaluate("waterNotes()")
    pg.select_option("#coupling", "two"); settings(pg, t0="0", t1="1.5")
    pg.click("#b-run"); msg = wait_done(pg)
    r2 = pg.evaluate("S.final.swmm2 && {t: S.final.swmm2.tally, mb: S.final.swmm2.massBalance, L: S.final.ledger}")
    if r2:
        t2, L2 = r2["t"], r2["L"]; net2d, netsw = L2["inflow"] - L2["captured"], t2["fromSwmm"] - t2["sentToSwmm"]
        ok("B12 two-way run: water goes into the inlets and the exchange balances", msg.startswith("Done") and t2["sentToSwmm"] > 1000 and abs(net2d - netsw) / t2["fromSwmm"] < 1e-6 and abs(L2["errPct"]) < 0.01,
           f"into inlets {t2['sentToSwmm']:.0f} cf, out of nodes {t2['fromSwmm']:.0f} cf; net 2D {net2d:.1f} = SWMM {netsw:.1f} cf; 2D closure {L2['errPct']:.5f}%")
        ok("B12 SWMM continuity within 1%", abs(r2["mb"]["flow"]) < 1, f"{r2['mb']['flow']:.3f}%")
        ninl = pg.evaluate("S.final.swmm2.inlets.length"); ok("B15 the 14 listed curb inlets are used", ninl == 14 and "14 inlets on 7 junctions" in pg.inner_text("#st-inl"), f"{ninl} inlets")
    else: ok("B12 two-way run", False, msg)
    ok("B12 exchange chart and SWMM table shown", "exchange" in pg.evaluate("document.getElementById('c-in').layout.title.text") and "two-way coupling" in pg.inner_text("#ledger"), "")
    with pg.expect_download() as d: pg.click("#dl-rpt")
    rp = os.path.join(TMP, "c.rpt"); d.value.save_as(rp); rtxt = open(rp).read()
    with pg.expect_download() as d: pg.click("#dl-out")
    op = os.path.join(TMP, "c.out"); d.value.save_as(op)
    from swmm.toolkit import output as swo, shared_enum as E
    hh = swo.init(); swo.open(hh, op); nper = swo.get_times(hh, E.Time.NUM_PERIODS); swo.close(hh)
    ok("B12 coupled SWMM report and .out download and open in the EPA reader", "Flow Routing Continuity" in rtxt and nper == 72, f"{nper} periods")
    import re as _re
    mext = _re.search(r"Flow Routing Continuity[\s\S]*?External Inflow \.+\s+([\d.]+)", rtxt); ext = float(mext.group(1)) * 43560 if mext else float("nan")
    ok("B12 the 2D run ends at 1.5 h and SWMM at 6 h: SWMM's external inflow equals what the inlets took", r2 and abs(ext - t2["sentToSwmm"]) / t2["sentToSwmm"] < 0.01, f"report {ext:.0f} cf, inlets took {t2['sentToSwmm']:.0f} cf")
    cpu2 = np.array(pg.evaluate("Array.from(S.final.hmax)"))
    if has_gpu:
        settings(pg, t0="0", t1="1.5", engine="gpu"); pg.click("#b-run"); msg = wait_done(pg)
        gpu2 = np.array(pg.evaluate("Array.from(S.final.hmax)"))
        ok("B13 two-way on the GPU matches the CPU (max depth within 0.01 ft)", "on the GPU" in msg and np.abs(gpu2 - cpu2).max() < 0.01, f"max diff {np.abs(gpu2 - cpu2).max():.2e} ft; {msg[:60]}")
    pg.select_option("#coupling", "one")

    # ---- B9 Stop ends a long run and keeps the maps so far
    pg.select_option("#ex-pick", "0"); pg.click("#ex-load"); pg.wait_for_function("/Loaded example/.test(document.querySelector('#msg').textContent)", timeout=120000)
    settings(pg, cell_index=0, t0="0", t1="6", outmin="2", engine="cpu"); pg.click("#b-run")
    pg.wait_for_function("S.frames.length >= 2", timeout=300000)
    nx_run = pg.evaluate("S.grid.G.nx"); pg.set_input_files("#f-res", resf); pg.wait_for_timeout(500)
    ok("B9 saved results cannot be opened while a run is going", "Stop the run first" in pg.inner_text("#msg") and pg.evaluate("S.running") and pg.evaluate("S.grid.G.nx") == nx_run, pg.inner_text("#msg")[:80])
    t = time.time(); pg.click("#b-stop"); pg.wait_for_function("/^Stopped/.test(document.querySelector('#msg').textContent)", timeout=60000); msg = pg.inner_text("#msg"); dt = time.time() - t
    ok("B9 Stop ends the run within 5 s and keeps the maps", msg.startswith("Stopped") and dt < 5 and pg.evaluate("S.frames.length") >= 2, f"{dt:.1f} s; {msg[:90]}")

    # ---- B10 phone width and dark theme
    pg.set_viewport_size({"width": 390, "height": 844}); pg.wait_for_timeout(500)
    sw = pg.evaluate("document.documentElement.scrollWidth")
    ok("B10 no horizontal scroll at 390 px", sw <= 390, f"scrollWidth {sw}")
    pg.screenshot(path=os.path.join(TMP, "phone.png"), full_page=False)
    pg.click("#b-theme"); pg.wait_for_timeout(500)
    bg = pg.evaluate("getComputedStyle(document.body).backgroundColor")
    ok("B10 dark theme applies", bg in ("rgb(17, 22, 28)",), bg)
    pg.set_viewport_size({"width": 1400, "height": 1000}); pg.screenshot(path=os.path.join(TMP, "dark.png"), full_page=True)

    # ---- B11 public-data demo loads offline (basemap tiles blocked) and builds its grid
    pg.select_option("#ex-pick", "1"); pg.click("#ex-load"); pg.wait_for_function("/Loaded example|Could not/.test(document.querySelector('#msg').textContent)", timeout=120000)
    ok("B11 public-data demo loads", "EPSG 6438" in pg.inner_text("#st-dem") and "footprints" in pg.inner_text("#st-bld") and "nodes flood" in pg.inner_text("#st-out"), pg.inner_text("#st-out"))
    ok("Z no page or console errors", not errs, errs[:5])
    print("screenshots in", TMP)
    b.close()
bad = [r for r in res if not r[1]]
print(f"{len(bad)} FAILED" if bad else "ALL PASS"); sys.exit(1 if bad else 0)
