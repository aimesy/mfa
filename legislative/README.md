# Legislative districts

`districts.json` lists, for each agency the viewer knows, the California
Assembly (80) and Senate (40) districts its territory touches. It drives the
district filter through `lib/districts.js`.

- Districts: the 2021 Citizens Redistricting Commission maps, in effect from
  the 2022 election, from Census TIGER/Line 2026. Fiscal years before 2022-23
  were collected under the 2011 maps; the filter always uses the current map.
- Cities, counties and school districts: their TIGER/Line 2026 polygons. A
  district counts when the polygons overlap by at least 1 square meter in
  California Albers (EPSG:3310), and only then: a 2020 block of the next
  county whose interior point now falls inside the polygon adds no district.
- Special districts and joint powers authorities: the polygon named in
  `sources.csv` (CAL FIRE, CSDA, DWR or a county layer). A district counts
  when a 2020 census block whose interior point lies inside the polygon
  belongs to it, or when the polygon, shrunk by 50 meters because these
  layers do not share TIGER's edges, still overlaps it by 10,000 square
  meters or by 0.5% of the agency's area, whichever is smaller. A district
  found only by area holds none of the agency's residents, so it is an edge
  contact. Roster agencies are matched only on exact name and county; the
  rest are left unmapped.
- `share` is the fraction of the agency's 2020 residents in the districts
  listed, from block interior points and the Commission's block equivalency
  files. `area_share` is the fraction of its area. Under 1% of residents, or
  none, is an edge contact.
- `lib/districts.js` matches a name only to a record in the county the
  caller names, so a roster agency the build did not map never takes a
  namesake's districts in another county.

`sources.csv` has one row for every agency whose boundary is not its own
TIGER polygon: the basis, the layer, the feature ids and a note.

## Caveat

Each agency is listed under every Assembly and Senate district its territory
reaches, even by a small part (for a special district, a part that holds a
2020 census block or is over 100 meters wide), so many appear under more than
one district and district totals overlap.

## Rebuild

```sh
python -I scripts/legislative.py fetch --geo ../geo/raw
nice -n 19 python -I scripts/legislative.py build --geo ../geo/raw --data-root ../mfa-data
```

`fetch` downloads only missing inputs, about one request a second per host.
`build` needs shapely 2, pyshp and pyproj, takes about two minutes and is
deterministic: with unchanged inputs it rewrites the same bytes.
`--report <file>` writes every exception it met (unmatched names, polygons
with no block inside) for review.
