#!/usr/bin/env python3
"""Claims gate (review E-01): the key figures STATUS.md quotes are checked against what the test suites print.

STATUS quotes measured values (the L12 storage rise, the L13 weir errors, the C18 external inflow, the soil
infiltration volumes, the B20 pond level). Prose drifts silently when a number changes underneath it, so this
script runs the node suites, parses the measured values out of their output, and compares them with the
values STATUS quotes. Any drift, or a suite that does not pass, fails the gate.

    python tools/check_claims.py [--browser-log tests/browser-last.log]

The browser figure (B20) is gated only when a browser-suite log is given: capture one with
`python tests/browser/test_app.py 2>&1 | tee tests/browser-last.log`. Without a log it is reported as
not gated in this run, not as passed. The log is accepted only with the suite's stamp (app version
and dist sha256) matching the dist in this tree, so a stale log cannot pass the figure.
"""
import argparse, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# (claim, suite file or None, measured-value regex on the suite output, STATUS regex, formatter)
CLAIMS = [
    ("L12 storage rise (ft)",
     "tests/node/test_lakes.js",
     r"table ([\d.]+) ft \(hand [\d.]+\)",
     r"L12 \(storage by hand: \+([\d.]+) ft",
     lambda a, b: abs(a[0] - b[0]) < 1e-6),
    ("C18 external inflow (cf)",
     "tests/node/test_couple2way.js",
     r"report external inflow (\d+) vs",
     r"external inflow \+([\d,]+) of 18,000 cf",
     lambda a, b: a == b),
    ("soil infiltration A / D / rain (ac-ft)",
     "tests/node/test_landcover.js",
     r"infiltration A ([\d.]+) ac-ft, D ([\d.]+) ac-ft of ([\d.]+) ac-ft rain",
     r"infiltrates ([\d.]+) ac-ft against ([\d.]+) for group D on the same storm \(of ([\d.]+) ac-ft",
     lambda a, b: a == b),
]


def run_suite(rel):
    p = subprocess.run(["node", rel], cwd=ROOT, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def nums(groups, comma=False):
    out = []
    for g in groups:
        out.append(float(g.replace(",", "")) if comma or "." in g else int(g.replace(",", "")))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--browser-log", help="a captured log of tests/browser/test_app.py; gates the B20 figure too")
    a = ap.parse_args()
    status = (ROOT / "STATUS.md").read_text(encoding="utf-8")
    bad = 0
    cache = {}
    for name, suite, mre, sre, eq in CLAIMS:
        if suite not in cache:
            cache[suite] = run_suite(suite)
        rc, out = cache[suite]
        if rc != 0 or "ALL PASS" not in out:
            print(f"FAIL {name}: {suite} did not pass (exit {rc})"); bad += 1; continue
        m = re.search(mre, out); s = re.search(sre, status)
        if not m:
            print(f"FAIL {name}: the measured value was not found in the output of {suite}"); bad += 1; continue
        if not s:
            print(f"FAIL {name}: STATUS.md does not quote the figure in the expected form"); bad += 1; continue
        mv = nums(m.groups(), comma=True); sv = nums(s.groups(), comma=True)
        if eq(mv, sv):
            print(f"PASS {name}: measured {mv} = STATUS {sv}")
        else:
            print(f"FAIL {name}: measured {mv} but STATUS quotes {sv}"); bad += 1
    # L13 is a bound, not a value: STATUS's quoted bound must equal the tolerance the test asserts, and the measured errors must sit inside it.
    # The asserted tolerance is printed in the check's result line from the same constant the assertion uses (0.6.1, review 0.6.0 F-10);
    # before, it was parsed out of the check's name, so loosening the assertion alone would still have passed the gate.
    if "tests/node/test_lakes.js" not in cache:
        cache["tests/node/test_lakes.js"] = run_suite("tests/node/test_lakes.js")
    rc, out = cache["tests/node/test_lakes.js"]
    m = re.search(r"largest error ([\d.]+) / ([\d.]+) ft", out)
    t = re.search(r"asserted bound ([\d.]+) ft", out)
    s = re.search(r"L13 \(weir drawdown against the closed-form level-pool solution within ([\d.]+) ft", status)
    if not (m and t and s):
        print("FAIL L13 weir errors: a needed figure was not found"); bad += 1
    else:
        errs = [float(m.group(1)), float(m.group(2))]; bound = float(s.group(1))
        if bound == float(t.group(1)) and max(errs) <= bound:
            print(f"PASS L13 weir errors (ft): measured {errs} inside the quoted bound {bound}")
        else:
            print(f"FAIL L13 weir errors: measured {errs}, test bound {t.group(1)}, STATUS bound {bound}"); bad += 1
    # B20 comes from the browser suite; gate it only with a captured log. The log must carry the suite's stamp
    # (app version and the dist file's sha256, printed by test_app.py) matching the dist in this tree, so a stale
    # log from an older build cannot pass the figure (0.6.1, review 0.6.0 F-10).
    s = re.search(r"B20: routed pond, rise = budget ÷ area; GPU = CPU, ([\d.]+) ft", status)
    if a.browser_log:
        log = Path(a.browser_log).read_text(encoding="utf-8", errors="replace")
        stamp = re.search(r"SUITE STAMP: app ([\d.]+), dist sha256 ([0-9a-f]+), (\S+)", log)
        import hashlib, json as _json
        dist = ROOT / "dist" / "FloodSimulator.html"
        man = _json.loads((ROOT / "dist" / "FloodSimulator.manifest.json").read_text(encoding="utf-8")) if (ROOT / "dist" / "FloodSimulator.manifest.json").exists() else {}
        sha = hashlib.sha256(dist.read_bytes()).hexdigest() if dist.exists() else ""
        if not stamp:
            print("FAIL B20 pond level: the browser log has no suite stamp; recapture it with the current test_app.py"); bad += 1
        elif stamp.group(1) != str(man.get("version", "")) or not sha.startswith(stamp.group(2)):
            print(f"FAIL B20 pond level: the browser log is stale (stamp app {stamp.group(1)}, dist sha256 {stamp.group(2)}; this tree's dist is app {man.get('version')}, sha256 {sha[:len(stamp.group(2))]})"); bad += 1
        else:
            m = re.search(r"CPU ([\d.]+), GPU [\d.]+ ft", log[stamp.end():])
            if not (m and s):
                print("FAIL B20 pond level: a needed figure was not found"); bad += 1
            elif abs(float(m.group(1)) - float(s.group(1))) < 5e-5:
                print(f"PASS B20 pond level (ft): browser log {m.group(1)} = STATUS {s.group(1)} (log stamped {stamp.group(3)}, app {stamp.group(1)})")
            else:
                print(f"FAIL B20 pond level: browser log {m.group(1)} but STATUS quotes {s.group(1)}"); bad += 1
    else:
        print(f"SKIP B20 pond level: no browser log given (STATUS quotes {s.group(1) if s else '?'} ft); pass --browser-log to gate it")
    print("CLAIMS GATE: " + ("FAILED" if bad else "ALL GATED CLAIMS PASS"))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
