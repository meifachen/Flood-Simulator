# Winter Haven (Lake Martha) example — evidence pack

This directory holds the generated Winter Haven example: a real-data model of the Lake Martha
area built entirely from public sources by `python/make_winter_haven_demo.py`. The generated
files (DEM, lakes, buildings, land cover, soils, inlets and the SWMM model, plus
`build_report.json`) are the frozen evidence behind the Winter Haven numbers quoted in
STATUS.md and in `docs/sites/winter-haven-lake-martha.md`: the report records, per file, the
source it came from and whether its figures were measured from the data or supplied, and its
checks section reconciles the model's node and pipe counts against the City inventory.

## Regenerating (one command)

```
python python/make_winter_haven_demo.py examples/winter_haven
```

Needs network access to the public sources (USGS, USDA Soil Data Access, the City of Winter
Haven's public layers, OpenStreetMap) and the Python packages listed in the builder's header.
Optional: `--outlets outlets.csv` adds lake outlet structures from a user-supplied CSV (see the
builder's docstring); the City's structures are not in the public layers, so none are invented.

## State at 0.6.0

The pack was regenerated during the 0.5.0 review in the review environment; a fresh regeneration
was attempted twice for 0.6.0 (2026-11-13) and both attempts stopped at the soils step: the USDA
Soil Data Access service (`sdmdataaccess.sc.egov.usda.gov`) did not answer within the 300 s read
timeout. Every step before soils (DEM, lakes, sewer model, buildings, land cover) completed.
The committed numbers therefore remain the review environment's run until a regeneration
completes; when one does, commit the new `build_report.json` here and update the site document's
inventory counts to match it.
