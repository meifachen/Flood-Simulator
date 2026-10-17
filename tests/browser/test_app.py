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
    cpu_hmax = np.array(pg.evaluate("Array.from(S.final.hmax)"))
    us_type = np.array(pg.evaluate("Array.from(S.grid.type)"))

    # ---- B3 map shows water, KPIs filled, clicking the map gives a point series
    pix = pg.evaluate("""new Promise(r=>{const im=new Image(); im.onload=()=>{const c=document.createElement('canvas'); c.width=im.width; c.height=im.height; const x=c.getContext('2d'); x.drawImage(im,0,0); const d=x.getImageData(0,0,c.width,c.height).data; let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>0) n++; r(n);}; im.src=MAP._layers2.depth._url;})""")
    ok("B3 depth overlay has wet pixels", pix > 50, f"{pix} pixels")
    kp = pg.inner_text("#kpis")
    ok("B3 KPIs show flooding", "Flooded area" in kp and "SWMM flooding into the 2D" in kp, kp.replace("\n", " | "))
    wettest = int(np.argmax(cpu_hmax))
    pg.evaluate(f"""(()=>{{ const G=S.grid.G, k={wettest}, r=Math.floor(k/G.nx), c=k%G.nx; const x=G.x0+(c+0.5)*G.cs, y=G.y1-(r+0.5)*G.cs; MAP.fire('click', {{latlng: toLL(x,y)}}); }})()""")
    pg.wait_for_timeout(500)
    ok("B3 map click picks a point and charts its depth", pg.evaluate("S.sel") == wettest and pg.evaluate("document.getElementById('c-pt').data[0].y.length") == nfr, pg.evaluate("S.sel"))

    # ---- B4 exports
    with pg.expect_download() as d: pg.click("#x-tif")
    tif = os.path.join(TMP, d.value.suggested_filename); d.value.save_as(tif)
    with rasterio.open(tif) as ds:
        a = ds.read(1); nod = ds.nodata; crs = ds.crs.to_epsg(); nb = ds.count; desc = ds.descriptions
    G = pg.evaluate("S.grid.G"); h_app = cpu_hmax.reshape(G["ny"], G["nx"])
    open_mask = np.array(pg.evaluate("Array.from(S.grid.type)")).reshape(G["ny"], G["nx"]) == 0
    ok("B4 GeoTIFF: CRS, 3 bands, NoData, values equal the run", crs == 2236 and nb == 3 and nod == -9999 and np.allclose(a[open_mask], h_app[open_mask], atol=1e-6) and (a[~open_mask] == -9999).all(),
       f"EPSG {crs}, {nb} bands {desc}, max {a.max():.3f} ft")
    with pg.expect_download() as d: pg.click("#x-csv")
    csvb = os.path.join(TMP, "b.csv"); d.value.save_as(csvb); rows = open(csvb).read().strip().splitlines()
    ok("B4 buildings CSV has one row per footprint", len(rows) == 31 and rows[0].startswith("building,"), f"{len(rows) - 1} rows")
    with pg.expect_download() as d: pg.click("#x-nodes")
    csvn = os.path.join(TMP, "n.csv"); d.value.save_as(csvn); rows = open(csvn).read().strip().splitlines()
    ok("B4 SWMM inflow CSV has a column per inflow node", len(rows[0].split(",")) == 2 + len(pg.evaluate("S.sources")) and len(rows) == nfr + 1, rows[0])

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
    gpd.read_file(os.path.join(si, "buildings.geojson")).to_crs(4326).to_file(os.path.join(TMP, "bld_lonlat.geojson"), driver="GeoJSON")
    pg.set_input_files("#f-dem", os.path.join(si, "dem.tif")); pg.wait_for_function("/Loaded dem.tif|Could not/.test(document.querySelector('#msg').textContent)", timeout=60000)
    pg.set_input_files("#f-bld", os.path.join(TMP, "bld_lonlat.geojson")); pg.wait_for_function("/Loaded bld_lonlat|Could not/.test(document.querySelector('#msg').textContent)", timeout=60000)
    pg.set_input_files("#f-bnd", os.path.join(si, "pond.geojson")); pg.wait_for_function("/Loaded pond|Could not/.test(document.querySelector('#msg').textContent)", timeout=60000)
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
    pg.select_option("#coupling", "two"); settings(pg, t0="0", t1="1.5")
    pg.click("#b-run"); msg = wait_done(pg)
    r2 = pg.evaluate("S.final.swmm2 && {t: S.final.swmm2.tally, mb: S.final.swmm2.massBalance, L: S.final.ledger}")
    if r2:
        t2, L2 = r2["t"], r2["L"]; net2d, netsw = L2["inflow"] - L2["captured"], t2["fromSwmm"] - t2["sentToSwmm"]
        ok("B12 two-way run: water goes into the inlets and the exchange balances", msg.startswith("Done") and t2["sentToSwmm"] > 1000 and abs(net2d - netsw) / t2["fromSwmm"] < 1e-6 and abs(L2["errPct"]) < 0.01,
           f"into inlets {t2['sentToSwmm']:.0f} cf, out of nodes {t2['fromSwmm']:.0f} cf; net 2D {net2d:.1f} = SWMM {netsw:.1f} cf; 2D closure {L2['errPct']:.5f}%")
        ok("B12 SWMM continuity within 1%", abs(r2["mb"]["flow"]) < 1, f"{r2['mb']['flow']:.3f}%")
    else: ok("B12 two-way run", False, msg)
    ok("B12 exchange chart and SWMM table shown", "exchange" in pg.evaluate("document.getElementById('c-in').layout.title.text") and "two-way coupling" in pg.inner_text("#ledger"), "")
    with pg.expect_download() as d: pg.click("#dl-rpt")
    rp = os.path.join(TMP, "c.rpt"); d.value.save_as(rp); rtxt = open(rp).read()
    with pg.expect_download() as d: pg.click("#dl-out")
    op = os.path.join(TMP, "c.out"); d.value.save_as(op)
    from swmm.toolkit import output as swo, shared_enum as E
    hh = swo.init(); swo.open(hh, op); nper = swo.get_times(hh, E.Time.NUM_PERIODS); swo.close(hh)
    ok("B12 coupled SWMM report and .out download and open in the EPA reader", "Flow Routing Continuity" in rtxt and nper == 72, f"{nper} periods")
    cpu2 = np.array(pg.evaluate("Array.from(S.final.hmax)"))
    if has_gpu:
        settings(pg, t0="0", t1="1.5", engine="gpu"); pg.click("#b-run"); msg = wait_done(pg)
        gpu2 = np.array(pg.evaluate("Array.from(S.final.hmax)"))
        ok("B13 two-way on the GPU matches the CPU (max depth within 0.01 ft)", "on the GPU" in msg and np.abs(gpu2 - cpu2).max() < 0.01, f"max diff {np.abs(gpu2 - cpu2).max():.2e} ft; {msg[:60]}")
    pg.select_option("#coupling", "one")

    # ---- B9 Stop ends a long run and keeps the maps so far
    pg.select_option("#ex-pick", "0"); pg.click("#ex-load"); pg.wait_for_function("/Loaded example/.test(document.querySelector('#msg').textContent)", timeout=120000)
    settings(pg, cell_index=0, t0="0", t1="6", outmin="2", engine="cpu"); pg.click("#b-run")
    pg.wait_for_function("S.frames.length >= 2", timeout=300000); t = time.time(); pg.click("#b-stop"); msg = wait_done(pg, 60); dt = time.time() - t
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
