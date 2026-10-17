#!/usr/bin/env python3
"""Reference values for the JavaScript SWMM readers, taken from the EPA SWMM engine itself (swmm-toolkit):
node names, types, inverts and max depths from the solver API; times, flooding and head series from the output API;
total rainfall from the report. Writes <example>/swmm_reference.json.

    python tests/py/make_swmm_reference.py examples/synthetic_us
"""
import json, os, re, sys
from swmm.toolkit import solver, output, shared_enum as E


def main(d):
    inp, rpt, out = (os.path.join(d, f) for f in ("model.inp", "model.rpt", "model.out"))
    ref = {"nodes": []}
    solver.swmm_open(inp, os.path.join(d, ".ref.rpt"), os.path.join(d, ".ref.out"))
    try:
        n = solver.project_get_count(E.ObjectType.NODE)
        for i in range(n):
            ref["nodes"].append({"name": solver.project_get_id(E.ObjectType.NODE, i),
                                 "type": solver.node_get_type(i).name if hasattr(solver.node_get_type(i), "name") else int(solver.node_get_type(i)),
                                 "invert": solver.node_get_parameter(i, E.NodeProperty.INVERT_ELEVATION),
                                 "maxDepth": solver.node_get_parameter(i, E.NodeProperty.FULL_DEPTH)})
        ref["flowUnits"] = solver.simulation_get_unit(E.UnitProperty.FLOW_UNIT) if hasattr(solver, "simulation_get_unit") else None
    finally:
        solver.swmm_close()
        for f in (".ref.rpt", ".ref.out"):
            p = os.path.join(d, f)
            if os.path.exists(p): os.remove(p)
    h = output.init(); output.open(h, out)
    try:
        nper = output.get_times(h, E.Time.NUM_PERIODS); step = output.get_times(h, E.Time.REPORT_STEP)
        ref["nPeriods"], ref["reportStepSec"] = nper, step
        ref["startDays"] = output.get_start_date(h)
        names = [output.get_elem_name(h, E.ElementType.NODE, i) for i in range(len(ref["nodes"]))]
        ref["outNodeNames"] = names
        ref["flooding"] = {nm: list(output.get_node_series(h, i, E.NodeAttribute.FLOODING_LOSSES, 0, nper - 1)) for i, nm in enumerate(names)}
        ref["head"] = {nm: list(output.get_node_series(h, i, E.NodeAttribute.HYDRAULIC_HEAD, 0, nper - 1)) for i, nm in enumerate(names)}
        ref["depth"] = {nm: list(output.get_node_series(h, i, E.NodeAttribute.INVERT_DEPTH, 0, nper - 1)) for i, nm in enumerate(names)}
    finally:
        output.close(h)
    txt = open(rpt).read()
    m = re.search(r"Total Precipitation \.+\s+([\d.]+)\s+([\d.]+)", txt)
    ref["rptTotalPrecipDepth"] = float(m.group(2)) if m else None   # inches (US) or mm (SI)
    m = re.search(r"Flooding Loss \.+\s+([\d.]+)\s+([\d.]+)", txt)
    ref["rptFloodingLoss"] = [float(m.group(1)), float(m.group(2))] if m else None   # acre-ft and 10^6 gal (US) / ha-m and 10^6 L (SI)
    json.dump(ref, open(os.path.join(d, "swmm_reference.json"), "w"))
    print("wrote", os.path.join(d, "swmm_reference.json"), len(ref["nodes"]), "nodes", ref["nPeriods"], "periods")


if __name__ == "__main__":
    main(sys.argv[1])
