#!/usr/bin/env python3
"""Build the single-file app: dist/FloodSimulator.html (offline; libraries, worker, CRS catalog and examples inlined).

    python tools/build.py [--no-examples]

Writes dist/FloodSimulator.html and dist/FloodSimulator.manifest.json (SHA-256 of every input and of the output).
"""
import argparse, base64, gzip, hashlib, json, os, sys, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.3.0"
SRC, VEN, EXA = ROOT / "src", ROOT / "vendor", ROOT / "examples"
EXAMPLES = [("synthetic_us", "none"), ("public_demo", "osm"), ("synthetic_si", "none")]


def read(p):
    return Path(p).read_text(encoding="utf-8")


def b64gz(data):
    return base64.b64encode(gzip.compress(data, 9, mtime=0)).decode()


def main(a):
    used = []
    def r(p):
        used.append(Path(p)); return read(p)
    libs = "\n;\n".join(r(VEN / f) for f in ["leaflet/leaflet.js", "three/three.min.js", "three/OrbitControls.js", "plotly/plotly-basic.min.js", "proj4/proj4.js",
                                              ]) + "\n;\n" + "\n;\n".join(r(SRC / f) for f in ["engine/flood2d.js", "core/model.js"])
    worker = "\n;\n".join(r(p) for p in [VEN / "geotiff/geotiff.js", VEN / "proj4/proj4.js", SRC / "engine/flood2d.js", SRC / "io/swmm.js", SRC / "core/model.js", VEN / "swmm-wasm/swmm5.js", SRC / "core/couple2way.js", SRC / "app/worker.js"])
    app = r(SRC / "app/results_io.js") + "\n;\n" + r(SRC / "app/view3d.js") + "\n;\n" + r(SRC / "app/app.js")
    cat = (VEN / "crs_catalog.json").read_bytes(); used.append(VEN / "crs_catalog.json")
    exs = []
    if not a.no_examples:
        for d, bm in EXAMPLES:
            meta = json.loads(read(EXA / d / "example.json")); used.append(EXA / d / "example.json")
            files = {}
            for k in ("dem", "buildings", "boundaries", "landcover", "soils", "inp", "out", "inlets"):
                if meta.get(k):
                    p = EXA / d / meta[k]; used.append(p); files[k] = b64gz(p.read_bytes())
            exs.append({"name": meta["name"], "note": meta.get("note", ""), "basemap": bm, "files": files})
    html = r(SRC / "app/index.html")
    build = {"version": VERSION, "built": datetime.date.today().isoformat()}
    subs = {"/*__LEAFLET_CSS__*/": r(VEN / "leaflet/leaflet.css"), "/*__HELP__*/": r(SRC / "app/help.html"), "/*__LIBS__*/": libs, "/*__WORKER__*/": worker,
            "/*__CATALOG__*/": b64gz(cat), "/*__EXAMPLES__*/": json.dumps(exs), "/*__BUILD__*/null": json.dumps(build), "/*__APP__*/": app}
    for k, v in subs.items():
        if html.count(k) != 1: sys.exit(f"marker {k} found {html.count(k)} times")
        if k not in ("/*__LEAFLET_CSS__*/", "/*__HELP__*/") and "</script" in v.lower():
            v = v.replace("</script", "<\\/script").replace("</SCRIPT", "<\\/SCRIPT")
        html = html.replace(k, v, 1)
    out = ROOT / "dist" / "FloodSimulator.html"; out.parent.mkdir(exist_ok=True)
    out.write_text(html, encoding="utf-8")
    h = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
    man = {"app": out.name, "version": VERSION, "bytes": out.stat().st_size, "sha256": h(out),
           "inputs": [{"file": str(p.relative_to(ROOT)), "sha256": h(p)} for p in sorted(set(used + [SRC / "app/index.html"]))]}
    (ROOT / "dist" / "FloodSimulator.manifest.json").write_text(json.dumps(man, indent=1))
    print(f"wrote {out} ({out.stat().st_size / 1e6:.2f} MB), {len(exs)} examples")



if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--no-examples", action="store_true"); main(ap.parse_args())
