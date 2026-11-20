# Fee schedule sample: method (2026-11-20)

Five agencies picked to show the range. This sample is a draft and is not part of the MFA dataset.

| Agency | Why it is in the sample | Source (file, physical page) |
|---|---|---|
| City of Brentwood | full city schedule incl. water and wastewater; nexus study formulas | Development Fee Program 2026 (2021 update, Res. 2021-20), p. 9; methods pp. 15 to 44. [link](https://www.brentwoodca.gov/home/showpublisheddocument/4664/639172887286070000) |
| County of Stanislaus | county PFF, 14 programs, unincorporated table | FY2017-18 PFF annual report, Attachment 3 Table 7, p. 22 (rates effective 2018-06-30). [link](https://www.stancounty.com/bos/agenda/2018/20181211/B04.pdf) |
| City of Redwood City | meter-based water, EDU and per DU sewer, transport fee tiered by Caltrain distance | FY2025-26 Master Fee Schedule pp. 14, 17, 18, 22; 2023 capacity fee study for formulas. [link](https://www.redwoodcity.org/departments/finance/financial-information-reports/development-impact-fee-transparency) |
| City of Paso Robles | area tiers A/B/C, ENR indexing, ADU per sq ft | DIF summary, Res. 19-017 Exh. A-2, July 1, 2026, p. 1 (PRA production, no public link) |
| City of Fortuna | small city master fee schedule; water connection by meter LUE; sewer by fixture units | FY26-27 Adopted Fee Schedule (Res. 2026-18) pp. 21 to 23, 45, 46. [link](https://www.friendlyfortuna.com/departments/finance/annual_fee_schedule.php) |

Cited pages are in `pages/` as PNG.

## Columns
- `fee-schedules-sample.csv`: one row per printed rate cell (fee program x land use x tier or meter size). The 34 viewer columns of `lib/schedules.js` in order, then `tier_or_band, methodology_formula, nexus_study, indexing_rule, exemptions_credits`.
- Every row cites `source_sha256`, `physical_pdf_page`, `printed_page` and `row_as_printed`. Cells printed "N/A" or "No Fee" keep an empty `rate`. Printed totals are not extracted.
- Viewer check: `parseSchedules` accepts all 470 rows. It ignores the 5 extra columns. It rejects `review_status = held` (it knows only `unreviewed` and `verified`), so held rows must be mapped to `unreviewed` before any load.
- `fee-schedules-sample.xlsx`: one sheet per agency plus Per-unit and Completeness.

## Verification
- Claude extracted the rows. Codex re-extracted each agency on its own from the file paths and page numbers, without seeing our rows.
- Rows were matched on page, program, land use, tier and rate. A row is `verified` when both extractions agree on rate, basis and unit.
- 470 rows: 293 matched outright; 177 disputed. 161 disputes were resolved:
  - 119: rate and printed unit agree, basis code differs (mostly Stanislaus "per thousand square feet", which we code `per_other_unit`).
  - 40: both extractions read the cell as blank.
  - 1: we read the page image ourselves (Redwood $7.91 x gallons per day).
  - 1: basis left empty because no unit is printed (Fortuna parking in-lieu).
- 16 held: Stanislaus special-case cells that print no amount. The matcher could not pair them, and they affect no total.
- Every dispute, with both values, is in `disputes.csv`.

## Model units (`prototypes.json`, set by Amy)
- Detached house: 2,000 sq ft, 4 BR, 5 per acre, 1 inch meter.
- Townhome: 1,500 sq ft, 3 BR, 20 per acre, 3/4 inch meter. Classed the way each schedule does.
- Apartment: 1,000 sq ft, 2 BR, 50 per acre. Water and sewer are a share of one master meter.
- Site and pricing: 1 acre site; market rate; vacant serviced infill lot; no credits or exemptions; existing lots, so no per parcel map charges.
- Added assumption: one 3 inch master meter for 50 apartments, since no sample schedule prints a sizing rule.
- School fees: a separate line at the state Level 1 rate only where the agency passes them through. None of the five does.
- `calc-rules.json` lists, per agency and prototype, which verified row applies and how: per unit, rate x sq ft, one meter per unit, or master meter / 50. It also records the chosen tier and townhome class.
- `calc_per_unit.py` (stdlib) writes the line items and totals.
- Codex recomputed all 15 totals from the verified rows and the same scenario choices; 15 of 15 agree (`calc-checks.csv`).

## Completeness flags
- `total_per_unit` is blank when anything is missing; it is never zero. `subtotal_computed` sums the lines that could be computed.
- A total is incomplete when:
  - the agency charges a program whose rate is not in our files (Paso Robles water and sewer; Redwood City parks and housing; Brentwood fire facility);
  - a basis needs an input the model units lack (frontage, impervious area);
  - a line is only a lower bound (Fortuna sewer, fixture units).
- Fees set by other agencies (school districts, regional transport authorities, flood control, water districts) are listed in `missing` and `completeness.csv`.
- Other flags:
  - Stanislaus rates are the June 30, 2018 schedule; our files hold nothing newer.
  - Townhome class is ambiguous in Stanislaus and Redwood City; it is flagged on every line.
  - Every meter assumption is flagged.
- Result: 3 complete totals (Stanislaus), 12 incomplete.
