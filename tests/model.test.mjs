// node tests/model.test.mjs
// Unit checks for the CSV reader, the figure model and the outline geometry.
// When an mfa-data checkout is present (MFA_DATA_ROOT, or ../mfa-data beside
// this repository), it also checks the model against the real release.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, parseCsvObjects, toCsv } from "../lib/csv.js";
import { buildModel, filterFigures, sortFigures, summarize, entityMatrix, fyRanges, fmtUsd, fmtSum, NONE, searchTerms, scopeLabel, scopeKey, scopeSymbol, basisLabel, grossNetLabel } from "../lib/model.js";
import { readArithmetic } from "../lib/arith.js";
import { outlineToPdfRect, outlineAgrees, isOutlineRed } from "../lib/evidence.js";

// CSV: quoted commas, doubled quotes, embedded CRLF, BOM
{
  const text = '﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"line1\r\nline2",\r\n';
  const rows = parseCsv(text);
  assert.deepEqual(rows, [["a", "b", "c"], ["1", "x, y", 'say "hi"'], ["2", "line1\r\nline2", ""]]);
  const { columns, rows: objs } = parseCsvObjects(text);
  assert.deepEqual(columns, ["a", "b", "c"]);
  assert.equal(objs[1].b, "line1\r\nline2");
  assert.deepEqual(parseCsv(toCsv(columns, objs)).slice(1), rows.slice(1));
  assert.throws(() => parseCsvObjects("a,b\n1\n"), /has 1 fields/);
}

// Model: one printed figure recorded at two grains is shown and summed once.
{
  const base = {
    receiving_entity: "City of Example", entity_type: "city", county: "Alpha", fee_program: "Parks",
    fee_category: "parks", measure_as_printed: "Fees Collected", physical_pdf_page: "3", source_id: "s1",
    source_pdf: "sources/s1.pdf", outline_rect_pdf_points: "[10, 20, 60, 30]", land_use_scope: "not_split_in_source",
    source_limitations: "One | Two", arithmetic_check: "", value_is_printed_zero: "false",
  };
  const rows = [
    { ...base, record_id: "r1", figure_group_id: "g1", is_primary_in_figure_group: "true", fiscal_year: "2022-23", value_usd: "100.50" },
    { ...base, record_id: "r1b", figure_group_id: "g1", is_primary_in_figure_group: "false", fiscal_year: "2022-23", value_usd: "100.50", measure: "mixed" },
    { ...base, record_id: "r2", figure_group_id: "g2", is_primary_in_figure_group: "true", fiscal_year: "2024-25", value_usd: "0", value_is_printed_zero: "true", arithmetic_check: "1 + 1 = 2" },
    { ...base, record_id: "r3", figure_group_id: "g3", is_primary_in_figure_group: "true", fiscal_year: "2024-25", value_usd: "25", county: "", fee_category: "", receiving_entity: "Other District", entity_type: "special_district" },
  ];
  const m = buildModel(rows, [{ source_id: "s1", source_bytes: "1000", physical_page_count: "9" }]);
  assert.equal(m.figures.length, 3);
  assert.equal(m.problems.length, 0);
  const g1 = m.figureById.get("g1");
  assert.equal(g1.rows.length, 2);
  assert.equal(g1.restatements.length, 1);
  assert.equal(summarize(m.figures).sum, 125.5);
  assert.equal(m.entityByName.get("City of Example").sum, 100.5);
  assert.equal(m.sourceById.get("s1")._figures, 3);
  assert.deepEqual(g1.primary._rect, [10, 20, 60, 30]);

  assert.equal(filterFigures(m.figures, { county: NONE }).length, 1);
  assert.equal(filterFigures(m.figures, { cat: NONE }).length, 1);
  assert.equal(filterFigures(m.figures, { county: "Alpha" }).length, 2);
  assert.equal(filterFigures(m.figures, { arith: "yes" }).length, 1);
  assert.equal(filterFigures(m.figures, { fyFrom: "2023-24" }).length, 2);
  assert.equal(filterFigures(m.figures, { q: "two example" }).length, 2, "search reaches limitations and names");
  assert.equal(filterFigures(m.figures, { q: '"city of example" 2024' }).length, 1);
  assert.deepEqual(searchTerms('a "b c" d'), ["a", "b c", "d"]);
  assert.deepEqual(sortFigures(m.figures, { col: "value", dir: "desc" }).map((f) => f.id), ["g1", "g3", "g2"]);

  const mx = entityMatrix(m.entityByName.get("City of Example"));
  assert.deepEqual(mx.years, ["2022-23", "2024-25"]);
  assert.equal(mx.groups[0].programs[0].cells.get("2022-23").length, 1);
  assert.deepEqual(mx.totals.map((t) => t.sum), [100.5, 0]);
}

// Formatting
{
  assert.equal(fmtUsd(102184.6), "$102,184.60");
  assert.equal(fmtUsd(5000), "$5,000");
  assert.equal(fmtUsd(-531574), "($531,574)");
  assert.equal(fmtSum(1234.5), "$1,235");
  assert.equal(fyRanges(["2014-15", "2015-16", "2016-17", "2019-20"]), "2014–15 to 2016–17, 2019–20");
  assert.equal(fyRanges(["2002-03"]), "2002–03");
}

// Short labels: several release codes share one name, and prose stays as written.
{
  assert.equal(scopeLabel("residential_and_nonresidential_not_split"), "Mixed");
  assert.equal(scopeLabel("mixed_residential_and_nonresidential_stated_in_source"), "Mixed");
  assert.equal(scopeLabel("residential_only_printed_subtotal"), "Residential");
  assert.equal(scopeLabel("nonresidential_only_stated_in_source"), "Non-residential");
  assert.equal(scopeLabel("not_split_in_source"), "Not split");
  assert.equal(scopeLabel(""), "Not recorded");
  assert.equal(scopeKey(NONE), NONE);
  assert.equal(scopeSymbol("residential_and_nonresidential_not_split"), "\u{1F3D9}\uFE0E");
  assert.equal(scopeSymbol("residential_only_stated_in_source"), "\u{1F3E0}\uFE0E");
  assert.equal(scopeSymbol("nonresidential_only_stated_in_source"), "\u{1F3E2}\uFE0E");
  assert.equal(scopeSymbol(""), "");
  assert.equal(basisLabel("cash_basis_report_is_titled_cash_balances_and_activities"), "Cash");
  assert.equal(basisLabel("modified_accrual; Note1 physical27"), "Modified accrual");
  assert.equal(basisLabel("Governmental funds use modified accrual."), "Governmental funds use modified accrual.");
  assert.equal(grossNetLabel("gross_refunds_reported_separately_in_source"), "Gross");
}

// Arithmetic: a note becomes tables only where its printed amounts close.
{
  const a = readArithmetic("The row's printed roll-forward closes: beginning fund balance 72,547 + Revenue 186,348 + Expenditure (219,686), which the report prints as a negative, + Interest Income 1,333 = the printed ending fund balance 40,542.");
  assert.deepEqual(a.groups.map((g) => [g.terms.map((t) => [t.op, t.label, t.amount]), g.total.label, g.total.amount]), [[
    [["", "Beginning fund balance", "72,547"], ["+", "Revenue", "186,348"], ["+", "Expenditure", "(219,686)"], ["+", "Interest Income", "1,333"]],
    "Ending fund balance", "40,542",
  ]]);
  assert.deepEqual(a.notes, []);

  // A printed dash stays a dash and is not added in; "less (x)" is the bracketed cell added.
  const b = readArithmetic("The ledger's own printed lines account for each other: BEGINNING BALANCE 07/01/19 5,057.32 plus FEES COLLECTED 11,841.83 and INTEREST EARNED 471.42, less REFUNDS - and EXPENDITURES (1,000.00), gives the printed ENDING BALANCE 6/30/20 of 16,370.57. The table is headed 2019/20.");
  assert.deepEqual(b.groups[0].terms.map((t) => [t.op, t.label, t.amount]), [
    ["", "BEGINNING BALANCE 07/01/19", "5,057.32"], ["+", "FEES COLLECTED", "11,841.83"], ["+", "INTEREST EARNED", "471.42"],
    ["−", "REFUNDS", "–"], ["+", "EXPENDITURES", "(1,000.00)"],
  ]);
  assert.equal(b.groups[0].total.label, "ENDING BALANCE 6/30/20");
  assert.deepEqual(b.notes, ["The table is headed 2019/20."]);

  // "that total" refers back; lines the note names without amounts stay blank.
  const c = readArithmetic("The column headed FY 2019/20 accounts for itself: its revenue lines give the printed revenue total of 1,184; opening balance 18,552 (Fund Balance, Beginning of Year) plus that total, less the expenditure total and plus the financing total, gives the printed Fund Balance, End of Year of 19,736.");
  assert.deepEqual(c.groups[0].terms.map((t) => [t.op, t.label, t.amount]), [
    ["", "Fund Balance, Beginning of Year", "18,552"], ["+", "Revenue total", "1,184"], ["−", "Expenditure total", ""], ["+", "Financing total", ""],
  ]);
  assert.deepEqual(c.notes, []);

  // Bare numbers take the figure's own label, the lines the reading quotes,
  // then a marked inferred role.
  const e = readArithmetic("The table reconciles exactly: 10,760,449.18 + 3,171,016.75 + 665,354.12 - 1,432,160.06 = 13,164,659.99, the printed ending balance.",
    { value: 3171016.75, label: "Amount of Reportable Fees Collected", hints: ["Amount of Reportable Fees Collected", "Interest Earned", "Expenditures"] });
  assert.deepEqual(e.groups[0].terms.map((t) => [t.op, t.label, t.amount, Boolean(t.inferred)]), [
    ["", "Beginning balance", "10,760,449.18", true], ["+", "Amount of Reportable Fees Collected", "3,171,016.75", false],
    ["+", "Interest Earned", "665,354.12", true], ["−", "Expenditures", "1,432,160.06", true],
  ]);
  assert.equal(e.groups[0].total.label, "Ending balance");
  assert.deepEqual(e.notes, []);

  // Lines the note names once, then gives per fund in numbers; captions name the fund.
  const f = readArithmetic("Every column reconciles: Fees + Interest equals the printed Total Revenues for each fund (for example ADMIN 19,356 + 4,546 = 23,902; SEWER 329,478 + 126,850 = 456,328).");
  assert.deepEqual(f.groups.map((g) => [g.caption, g.terms.map((t) => t.label), g.total.label, g.total.amount]), [
    ["ADMIN", ["Fees", "Interest"], "Total Revenues", "23,902"], ["SEWER", ["Fees", "Interest"], "Total Revenues", "456,328"],
  ]);

  // An equation that does not close is left in the release's words.
  const d = readArithmetic("Beginning balance 100 + Fees 50 = the printed Ending balance 175.");
  assert.equal(d.groups.length, 0);
  assert.deepEqual(d.notes, ["Beginning balance 100 + Fees 50 = the printed Ending balance 175."]);
  assert.deepEqual(readArithmetic(""), { groups: [], notes: [] });
}

// Geometry: MuPDF top-left coordinates relative to the CropBox -> PDF user space.
{
  assert.deepEqual(outlineToPdfRect([0, 0, 612, 792], [100, 200, 150, 210]), [100, 582, 150, 592]);
  // CropBox offset from the origin (as on the Belmont and Big Bear Lake pages).
  assert.deepEqual(outlineToPdfRect([-12, 12, 600, 804], [486, 532.5, 522.8, 549.9]).map((v) => Math.round(v * 10) / 10), [474, 254.1, 510.8, 271.5]);
}

// Outline check: which ink patterns count as the evidence outline around a box.
{
  assert.ok(outlineAgrees([1, 1, 1, 1]), "full rectangle");
  assert.ok(outlineAgrees([0.09, 0.17, 0, 0.21]), "corner ticks (Corona style)");
  assert.ok(outlineAgrees([0, 0.28, 0, 0.28]), "box taller than the recorded rectangle");
  assert.ok(!outlineAgrees([1, 0.07, 0, 0.07]), "a box one row off touches the outline along one edge only");
  assert.ok(!outlineAgrees([0, 0, 0, 0.26]), "stray red on one side");
  assert.ok(!outlineAgrees([0, 0, 0, 0]), "nothing there");
  assert.ok(isOutlineRed(217, 0, 0) && isOutlineRed(255, 153, 153), "outline red and hairline pink");
  assert.ok(!isOutlineRed(0, 0, 0) && !isOutlineRed(128, 128, 128) && !isOutlineRed(255, 220, 0), "not ink, grey or yellow");
}

// The real release, when a checkout is present.
const releaseRoot = path.resolve(process.env.MFA_DATA_ROOT || fileURLToPath(new URL("../../mfa-data", import.meta.url)));
const releaseCsv = path.join(releaseRoot, "data/reported-fee-collections.csv");
if (existsSync(releaseCsv)) {
  const fees = parseCsvObjects(readFileSync(releaseCsv, "utf8"));
  const sources = parseCsvObjects(readFileSync(path.join(releaseRoot, "sources/index.csv"), "utf8"));
  const m = buildModel(fees.rows, sources.rows);
  assert.deepEqual(m.problems, [], "every figure group has exactly one primary row");
  const groups = new Set(fees.rows.map((r) => r.figure_group_id));
  assert.equal(m.figures.length, groups.size);
  const primarySum = fees.rows.filter((r) => r.is_primary_in_figure_group === "true").reduce((s, r) => s + Number(r.value_usd), 0);
  assert.ok(Math.abs(summarize(m.figures).sum - primarySum) < 0.01, "model sum equals the sum of primary rows");
  assert.ok(m.figures.every((f) => f.primary._rect && f.page), "every figure has an outline rectangle and a page");
  const unknownSources = m.figures.filter((f) => !m.sourceById.has(f.sourceId));
  assert.equal(unknownSources.length, 0, "every figure's source is in sources/index.csv");
  console.log(`release: ${fees.rows.length} rows, ${m.figures.length} figures, ${m.entities.length} jurisdictions, ${m.sources.length} sources`);
}

console.log("model tests passed");
