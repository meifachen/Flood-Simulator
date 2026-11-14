# Winter Haven (Lake Martha) example — how the evidence pack is built

This directory is where `python/make_winter_haven_demo.py` writes the Winter Haven example: a
real-data model of the Lake Martha area built entirely from public sources. A completed run
leaves the generated files here (DEM, lakes, buildings, land cover, soils, inlets and the SWMM
model, plus `build_report.json`); the report records, per file, the source it came from and
whether its figures were measured from the data or supplied, and its checks section reconciles
the model's node and pipe counts against the City inventory. The Winter Haven numbers quoted
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

## State at 0.6.1

No completed regeneration exists in this repository. The pack was generated during the 0.5.0
review in the review environment, whose outputs were not committed here; fresh regenerations
were attempted for 0.6.0 (2026-11-13, twice) and for 0.6.1 (2026-11-14, once), and every attempt
stopped at the soils step: the USDA Soil Data Access service
(`sdmdataaccess.sc.egov.usda.gov`) did not answer within the 300 s read timeout. Every step
before soils (DEM, lakes, sewer model, buildings, land cover) completed each time. The quoted
Winter Haven numbers therefore remain the review environment's run until a regeneration
completes; when one does, commit the generated files and `build_report.json` here and update
the site document's inventory counts to match it.
