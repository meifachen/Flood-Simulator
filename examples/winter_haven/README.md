# Winter Haven (Lake Martha) example — how the evidence pack is built

This directory is where `python/make_winter_haven_demo.py` writes the Winter Haven example: a
real-data model of the Lake Martha area built entirely from public sources. A completed run
leaves the generated files here (DEM, lakes, buildings, land cover, soils, inlets and the SWMM
model, plus `build_report.json`). The report records the sources used (`sources`), the
assumptions and notes (`notes`), and checks: the sewer model's pipe, node and outfall counts and
the structures it had to adjust (`checks.sewer`), inverts above the lidar ground, the soils, the
rain, the DEM and the land cover. It does not record the City inventory's own feature counts, so
it does not reconcile against them. The Winter Haven numbers quoted
in STATUS.md and in `docs/sites/winter-haven-lake-martha.md` come from the review-environment
run described under "State" below; no generated files are committed at 0.6.1.

## Regenerating (one command)

```
python python/make_winter_haven_demo.py examples/winter_haven
```

Needs network access to the public sources (USGS, USDA Soil Data Access, the City of Winter
Haven's public layers, OpenStreetMap) and the Python packages listed in the builder's header.
Optional: `--outlets outlets.csv` adds lake outlet structures from a user-supplied CSV (see the
builder's docstring); the City's structures are not in the public layers, so none are invented.

## State at 0.6.2

No generated files are committed. A full regeneration with the builder at 0.6.1 completed on
2026-11-14 in about 2 minutes (the USDA Soil Data Access query answered in 0.6 s); its
`build_report.json` matches the 2026-11-10 report of the run the quoted figures come from on
every check (sewer counts, inverts above the ground, soils, rain, DEM, land cover), apart from an
added whole-lake area field and two corrected issue labels. Earlier attempts on 2026-11-13 and
14 had stopped at the soils step when that service did not answer.

Committing the generated files here would put City of Winter Haven data in the public
repository. That has not been decided; ask the owner first (CLAUDE.md, "Always ask").
