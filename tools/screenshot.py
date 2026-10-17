#!/usr/bin/env python3
"""README screenshot: public-data demo, two-way coupling, map and 3D at the time of the largest flooded area -> docs/screenshot.png"""
import os, sys
from playwright.sync_api import sync_playwright
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); APP = os.path.join(ROOT, "dist", "FloodSimulator.html"); TMP = "/tmp"
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"]); pg = b.new_page(viewport={"width": 1400, "height": 950})
    pg.route("**/*", lambda r: r.abort() if r.request.url.startswith("http") else r.continue_())
    pg.goto("file://" + APP); pg.select_option("#ex-pick", "1"); pg.click("#ex-load")
    pg.wait_for_function("/Loaded example/.test(document.querySelector('#msg').textContent)", timeout=120000)
    pg.select_option("#basemap", "none"); pg.select_option("#coupling", "two"); pg.select_option("#cell", index=1); pg.fill("#t1", "2"); pg.select_option("#engine", "cpu")
    pg.click("#b-run"); pg.wait_for_function("/^(Done|Stopped|Run failed)/.test(document.querySelector('#msg').textContent)", timeout=3600000)
    print(pg.inner_text("#msg"))
    k = pg.evaluate("(()=>{let b=0;S.frames.forEach((f,i)=>{if(f.sum.wetAc>S.frames[b].sum.wetAc)b=i});return b})()")
    pg.evaluate(f"S.view='now'; document.querySelector('#view').value='now'; S.frame={k}; document.querySelector('#slider').value={k}; paint(); pointChart();")
    pg.wait_for_timeout(1500); pg.locator("#map").screenshot(path=f"{TMP}/s_map.png")
    pg.click("#t-3d"); pg.wait_for_timeout(5000); pg.locator("#v3d").screenshot(path=f"{TMP}/s_3d.png")
    b.close()
a, c = Image.open(f"{TMP}/s_map.png"), Image.open(f"{TMP}/s_3d.png"); h = 520
a = a.resize((int(a.width * h / a.height), h)); c = c.resize((int(c.width * h / c.height), h))
out = Image.new("RGB", (a.width + c.width + 12, h), "white"); out.paste(a, (0, 0)); out.paste(c, (a.width + 12, 0)); out.save(os.path.join(ROOT, "docs", "screenshot.png"), optimize=True)
print("wrote docs/screenshot.png", out.size)
