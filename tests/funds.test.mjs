// node tests/funds.test.mjs
// Unit checks for the fund balance model behind the Funds tab. When an
// mfa-data checkout is present (MFA_DATA_ROOT, or ../mfa-data beside this
// repository), it also runs the model on the real fee account figures.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsvObjects } from "../lib/csv.js";
import { buildFunds, balanceCheck, statewideEnding, searchAgencies, toCents, collectionsEntityName, resolveCell, FUND_MEASURES } from "../lib/funds.js";

let seq = 0;
function row(over) {
  seq += 1;
  return {
    record_id: `r${seq}`,
    figure_group_id: `g${seq}`,
    is_primary_in_figure_group: "true",
    receiving_entity: "Madera city",
    entity_type: "city",
    county: "Madera",
    fee_program: "Parks",
    fee_category: "parks",
    fiscal_year: "2022-23",
    measure: "total_fees_collected",
    measure_as_printed: "Fees",
    value_usd: "0",
    source_id: "source-a",
    physical_pdf_page: "4",
    source_pdf: "https://github.com/aimesy/mfa-data/releases/download/sources-1/a.pdf",
    official_source_url: "https://example.org/a.pdf",
    ...over,
  };
}
const fundYear = (funds, agency, fund, fy) => funds.agencyByName.get(agency).funds.find((f) => f.name === fund).years.find((y) => y.fy === fy);

// Cents: exact from the decimal text; blank or unreadable stays null.
{
  assert.equal(toCents("1234.5"), 123450);
  assert.equal(toCents("-0.05"), -5);
  assert.equal(toCents("12"), 1200);
  assert.equal(toCents("7."), 700);
  assert.equal(toCents(""), null);
  assert.equal(toCents("n/a"), null);
  assert.equal(collectionsEntityName("Madera city"), "City of Madera");
  assert.equal(collectionsEntityName("Truckee town"), "Town of Truckee");
  assert.equal(collectionsEntityName("Butte County"), null);
}

// Primary rows only: a corroborating restatement adds nothing.
{
  const rows = [
    row({ measure: "ending_balance", value_usd: "500", figure_group_id: "g-end" }),
    row({ measure: "ending_balance", value_usd: "500", figure_group_id: "g-end", is_primary_in_figure_group: "false", source_id: "source-b" }),
  ];
  const funds = buildFunds(rows);
  assert.equal(funds.stats.rows, 2);
  assert.equal(funds.stats.primary, 1);
  const cell = fundYear(funds, "Madera city", "Parks", "2022-23").cells.ending_balance;
  assert.equal(cell.value, 50000);
  assert.equal(cell.lines.length, 1);
  assert.equal(cell.kind, "printed");
}

// Missing stays missing: no cell, no zero, and the check names what was not printed.
{
  const rows = [
    row({ measure: "beginning_balance", value_usd: "1000" }),
    row({ measure: "total_fees_collected", value_usd: "200" }),
    row({ measure: "ending_balance", value_usd: "1200" }),
    row({ fiscal_year: "2023-24", measure: "total_fees_collected", value_usd: "0", value_is_printed_zero: "true" }),
  ];
  const funds = buildFunds(rows);
  const y = fundYear(funds, "Madera city", "Parks", "2022-23");
  assert.equal(y.cells.interest_earned, undefined);
  assert.equal(y.cells.refunds, undefined);
  assert.equal(y.check.status, "closes");
  assert.deepEqual(y.check.absent, ["interest_earned", "other_revenue", "transfers_in", "expenditures", "transfers_out", "refunds"]);
  const next = fundYear(funds, "Madera city", "Parks", "2023-24");
  assert.equal(next.cells.total_fees_collected.value, 0, "a printed zero is a value");
  assert.equal(next.cells.ending_balance, undefined);
  assert.equal(next.check.status, "none");
  assert.equal(next.check.reason, "balances");
  assert.deepEqual(next.check.missing, ["beginning_balance", "ending_balance"]);
  const sw = statewideEnding(funds);
  assert.deepEqual(sw.map((t) => t.fy), ["2022-23"], "a year with no printed ending balance has no total");
}

// Balance check: exact cents, outflows subtracted whatever their printed sign.
{
  const cells = (pairs, source = "source-a") => Object.fromEntries(pairs.map(([k, v]) => [k, { value: toCents(v), lines: [{ sourceId: source }], kind: "printed" }]));
  const ok = balanceCheck(cells([
    ["beginning_balance", "1000"], ["total_fees_collected", "200"], ["interest_earned", "10.50"],
    ["expenditures", "-300"], ["transfers_out", "50"], ["ending_balance", "860.50"],
  ]));
  assert.equal(ok.status, "closes");
  assert.equal(ok.computed, 86050);
  assert.deepEqual(ok.terms.map((t) => t.cents), [20000, 1050, -30000, -5000]);
  const tenths = balanceCheck(cells([["beginning_balance", "0.10"], ["total_fees_collected", "0.20"], ["ending_balance", "0.30"]]));
  assert.equal(tenths.status, "closes", "0.10 + 0.20 = 0.30 in cents");
  const short = balanceCheck(cells([["beginning_balance", "1000"], ["expenditures", "300"], ["ending_balance", "705"]]));
  assert.equal(short.status, "incomplete", "a gap with terms absent from the release is not called off");
  assert.equal(short.diff, 500);
  assert.equal(short.printed, 70500, "the printed ending balance is kept, never replaced");
  assert.deepEqual(short.absent, ["total_fees_collected", "interest_earned", "other_revenue", "transfers_in", "transfers_out", "refunds"]);
  const every = [["total_revenue", "50"], ["expenditures", "300"], ["transfers_in", "0"], ["transfers_out", "0"], ["refunds", "0"]];
  const off = balanceCheck(cells([["beginning_balance", "1000"], ...every, ["ending_balance", "755"]]));
  assert.equal(off.status, "differs", "off only when every term is present");
  assert.equal(off.diff, 500);
  assert.deepEqual(off.absent, []);
  assert.equal(off.mixed, false);
  const mixedCells = { ...cells([...every, ["ending_balance", "751"]]), ...cells([["beginning_balance", "1000"]], "source-b") };
  const rounding = balanceCheck(mixedCells);
  assert.equal(rounding.mixed, true);
  assert.equal(rounding.status, "rounding", "$1 between two reports is rounding");
  assert.equal(balanceCheck({ ...mixedCells, ending_balance: { ...mixedCells.ending_balance, value: 75101 } }).status, "differs");
  assert.equal(balanceCheck(cells([["beginning_balance", "1000"], ...every, ["ending_balance", "751"]])).status, "differs", "one report $1 off is not rounding");
  const total = balanceCheck(cells([
    ["beginning_balance", "100"], ["total_fees_collected", "40"], ["interest_earned", "10"], ["total_revenue", "50"], ["ending_balance", "150"],
  ]));
  assert.equal(total.status, "closes", "a printed total revenue stands for its parts");
  assert.deepEqual(total.terms.map((t) => t.measure), ["total_revenue"]);
  const noFlows = balanceCheck(cells([["beginning_balance", "100"], ["ending_balance", "100"]]));
  assert.equal(noFlows.status, "none");
  assert.equal(noFlows.reason, "flows");
  const split = balanceCheck({ ...cells([["beginning_balance", "100"], ["ending_balance", "90"]]), expenditures: { value: null, lines: [], kind: "differs" } });
  assert.equal(split.status, "none");
  assert.equal(split.reason, "sources");
  assert.deepEqual(split.missing, ["expenditures"]);
  const conflict = balanceCheck({ ...cells([["beginning_balance", "100"], ["expenditures", "10"]]), ending_balance: { value: null, lines: [], kind: "unresolved" } });
  assert.equal(conflict.reason, "unresolved", "one report printing two totals is not two reports disagreeing");
  assert.deepEqual(conflict.missing, ["ending_balance"]);
}

// Several lines for one measure: the printed total line, else their sum;
// reports that disagree leave the cell without a value.
{
  const line = (label, v, source = "source-a") => ({ label, cents: toCents(v), sourceId: source });
  const total = resolveCell("expenditures", [line("Contracted Services", "199"), line("Developer Reimbursement", "113325"), line("Total Expenditures for year", "113524")]);
  assert.equal(total.kind, "total");
  assert.equal(total.value, 11352400);
  assert.equal(total.used.length, 1);
  const sum = resolveCell("expenditures", [line("New Classroom Building; Total Cost", "353527"), line("Administration; Total Cost", "67494")]);
  assert.equal(sum.kind, "sum", "a line item whose label merely mentions a total is not the total line");
  assert.equal(sum.value, 42102100);
  const agree = resolveCell("expenditures", [line("Total Expenditures for year", "113524", "source-a"), line("Contracted Services", "199", "source-b"), line("Developer Reimbursement", "113325", "source-b")]);
  assert.equal(agree.kind, "agree");
  assert.equal(agree.value, 11352400);
  const differs = resolveCell("beginning_balance", [line("Beginning Balance", "27945", "source-a"), line("Beginning Balance", "9592", "source-b")]);
  assert.equal(differs.kind, "differs");
  assert.equal(differs.value, null);
}

// Grouping: agency, then fund, then fiscal year, each in order.
{
  const rows = [
    row({ receiving_entity: "Zeta city", fee_program: "Traffic", fiscal_year: "2021-22", measure: "ending_balance", value_usd: "5" }),
    row({ receiving_entity: "Alpha County", entity_type: "county", fee_program: "Roads", fiscal_year: "2023-24", measure: "ending_balance", value_usd: "7" }),
    row({ receiving_entity: "Alpha County", entity_type: "county", fee_program: "Roads", fiscal_year: "2022-23", measure: "ending_balance", value_usd: "3" }),
    row({ receiving_entity: "Alpha County", entity_type: "county", fee_program: "Fire", fiscal_year: "2022-23", measure: "expenditures", value_usd: "1" }),
    row({ receiving_entity: "Alpha County", entity_type: "county", fee_program: "Fire", fiscal_year: "2022-23", measure: "not_a_fund_measure", value_usd: "9" }),
  ];
  const funds = buildFunds(rows);
  assert.deepEqual(funds.agencies.map((a) => a.name), ["Alpha County", "Zeta city"]);
  const alpha = funds.agencyByName.get("Alpha County");
  assert.equal(alpha.type, "county");
  assert.deepEqual(alpha.funds.map((f) => f.name), ["Fire", "Roads"]);
  assert.deepEqual(alpha.funds[1].years.map((y) => y.fy), ["2022-23", "2023-24"]);
  assert.deepEqual(Object.keys(alpha.funds[0].years[0].cells), ["expenditures"]);
  assert.deepEqual(alpha.years, ["2022-23", "2023-24"]);
  assert.equal(funds.stats.funds, 3);
  assert.equal(funds.stats.fundYears, 4);
  assert.deepEqual(searchAgencies(funds, "roads").map((a) => a.name), ["Alpha County"]);
  assert.equal(searchAgencies(funds, "").length, 2);
  const sw = statewideEnding(funds);
  assert.deepEqual(sw.map((t) => [t.fy, t.cents, t.agencies, t.funds]), [["2021-22", 500, 1, 1], ["2022-23", 300, 1, 1], ["2023-24", 700, 1, 1]]);
}

// Fees collected: from the fund table, else from reported-fee-collections
// for the same agency, fund and fiscal year, marked as such.
{
  const rows = [
    row({ fiscal_year: "2021-22", measure: "beginning_balance", value_usd: "100" }),
    row({ fiscal_year: "2021-22", measure: "ending_balance", value_usd: "130" }),
    row({ fiscal_year: "2022-23", measure: "total_fees_collected", value_usd: "45" }),
  ];
  const collections = [
    { receiving_entity: "City of Madera", fee_program: "Parks", fiscal_year: "2021-22", measure: "total_fees_collected", value_usd: "30", is_primary_in_figure_group: "true", source_id: "source-c", record_id: "c1" },
    { receiving_entity: "City of Madera", fee_program: "Parks", fiscal_year: "2021-22", measure: "total_fees_collected", value_usd: "30", is_primary_in_figure_group: "false", source_id: "source-d", record_id: "c2" },
    { receiving_entity: "City of Madera", fee_program: "Parks", fiscal_year: "2022-23", measure: "total_fees_collected", value_usd: "45", is_primary_in_figure_group: "true", source_id: "source-c", record_id: "c3" },
    { receiving_entity: "City of Madera", fee_program: "Other fund", fiscal_year: "2021-22", measure: "total_fees_collected", value_usd: "99", is_primary_in_figure_group: "true", source_id: "source-c", record_id: "c4" },
  ];
  const funds = buildFunds(rows, collections);
  const madera = funds.agencyByName.get("Madera city");
  assert.equal(madera.collectionsName, "City of Madera");
  assert.deepEqual(madera.funds.map((f) => f.name), ["Parks"], "collections add no funds of their own");
  const filled = fundYear(funds, "Madera city", "Parks", "2021-22").cells.total_fees_collected;
  assert.equal(filled.from, "collections");
  assert.equal(filled.value, 3000);
  assert.equal(filled.lines.length, 1, "corroborating collections rows are not used");
  assert.equal(fundYear(funds, "Madera city", "Parks", "2021-22").check.status, "closes");
  assert.equal(fundYear(funds, "Madera city", "Parks", "2022-23").cells.total_fees_collected.from, "accounts");
  assert.deepEqual(funds.stats.fees, { accounts: 1, collections: 1, both: 1, bothEqual: 1 });
  assert.equal(buildFunds(rows).agencyByName.get("Madera city").collectionsName, null);
}

// One fund printed in different case or across a line break is one fund,
// named as its latest report prints it, with the other spellings kept.
{
  const rows = [
    row({ fee_program: "LIBRARY", fiscal_year: "2022-23", measure: "ending_balance", value_usd: "10" }),
    row({ fee_program: "Library", fiscal_year: "2024-25", measure: "beginning_balance", value_usd: "10" }),
    row({ fee_program: "Library", fiscal_year: "2024-25", measure: "ending_balance", value_usd: "12" }),
    row({ fee_program: "Library\nFacilities", fiscal_year: "2024-25", measure: "ending_balance", value_usd: "1" }),
    row({ fee_program: "Library  Facilities ", fiscal_year: "2024-25", measure: "beginning_balance", value_usd: "1" }),
  ];
  const collections = [
    { receiving_entity: "City of Madera", fee_program: "library", fiscal_year: "2024-25", measure: "total_fees_collected", value_usd: "2", is_primary_in_figure_group: "true", source_id: "source-c", record_id: "c1" },
  ];
  const funds = buildFunds(rows, collections);
  const madera = funds.agencyByName.get("Madera city");
  assert.deepEqual(madera.funds.map((f) => [f.name, f.otherNames]), [["Library", ["LIBRARY"]], ["Library Facilities", []]]);
  assert.deepEqual(madera.funds[0].years.map((y) => y.fy), ["2022-23", "2024-25"]);
  const y = fundYear(funds, "Madera city", "Library", "2024-25");
  assert.equal(y.fund, "Library");
  assert.equal(y.cells.total_fees_collected.from, "collections");
  assert.equal(y.check.status, "closes");
  assert.equal(fundYear(funds, "Madera city", "Library Facilities", "2024-25").check.reason, "flows");
  assert.deepEqual(searchAgencies(funds, "LIBRARY").map((a) => a.name), ["Madera city"]);
}

// Names that share a figure group are one fund: Fontana prints a cost
// allocation under "Fire Facility" whose restatement is under "Fire Facility (631)".
{
  const rows = [
    row({ receiving_entity: "Fontana city", fee_program: "Fire Facility (631)", measure: "beginning_balance", value_usd: "666331" }),
    row({ receiving_entity: "Fontana city", fee_program: "Fire Facility (631)", measure: "total_fees_collected", value_usd: "256594" }),
    row({ receiving_entity: "Fontana city", fee_program: "Fire Facility (631)", measure: "interest_earned", value_usd: "6354" }),
    row({ receiving_entity: "Fontana city", fee_program: "Fire Facility (631)", measure: "ending_balance", value_usd: "606389" }),
    row({ receiving_entity: "Fontana city", fee_program: "Fire Facility", measure: "expenditures", value_usd: "-322890", figure_group_id: "g-cost" }),
    row({ receiving_entity: "Fontana city", fee_program: "Fire Facility (631)", measure: "expenditures", value_usd: "-322890", figure_group_id: "g-cost", is_primary_in_figure_group: "false" }),
    row({ receiving_entity: "Fontana city", fee_program: "Police Facilities", measure: "ending_balance", value_usd: "5" }),
    row({ receiving_entity: "Rialto city", fee_program: "Fire Facility", measure: "ending_balance", value_usd: "5", figure_group_id: "g-cost" }),
  ];
  const funds = buildFunds(rows);
  const fontana = funds.agencyByName.get("Fontana city");
  assert.deepEqual(fontana.funds.map((f) => [f.name, f.otherNames]), [["Fire Facility", ["Fire Facility (631)"]], ["Police Facilities", []]]);
  const y = fundYear(funds, "Fontana city", "Fire Facility", "2022-23");
  assert.equal(y.cells.expenditures.value, -32289000);
  assert.equal(y.check.status, "closes");
  assert.equal(funds.agencyByName.get("Rialto city").funds.length, 1, "a figure group never joins two agencies");
}

// One report printing a fund in two tables under two names gives each figure
// once (Pomona prints its art fund on p8 and again on p13); tables that print
// different amounts leave the cell unresolved.
{
  const art = (over) => row({ receiving_entity: "Pomona city", fiscal_year: "2019-20", ...over });
  const rows = [
    art({ fee_program: "Art Fee (133)", fiscal_year: "2018-19", measure: "ending_balance", value_usd: "100", figure_group_id: "g-art" }),
    art({ fee_program: "Art Program Fee", fiscal_year: "2018-19", measure: "ending_balance", value_usd: "100", figure_group_id: "g-art", is_primary_in_figure_group: "false" }),
    art({ fee_program: "Art Fee (133)", measure: "beginning_balance", value_usd: "100" }),
    art({ fee_program: "Art Fee (133)", measure: "total_fees_collected", value_usd: "50" }),
    art({ fee_program: "Art Fee (133)", measure: "ending_balance", value_usd: "150" }),
    art({ fee_program: "Art Program Fee", measure: "beginning_balance", value_usd: "100", physical_pdf_page: "13" }),
    art({ fee_program: "Art Program Fee", measure: "total_fees_collected", value_usd: "50", physical_pdf_page: "13" }),
    art({ fee_program: "Art Program Fee", measure: "ending_balance", value_usd: "160", physical_pdf_page: "13" }),
  ];
  const [fund] = buildFunds(rows).agencyByName.get("Pomona city").funds;
  const y = fund.years.find((v) => v.fy === "2019-20");
  assert.equal(y.cells.beginning_balance.value, 10000);
  assert.equal(y.cells.total_fees_collected.value, 5000);
  assert.deepEqual([y.cells.ending_balance.kind, y.cells.ending_balance.value], ["unresolved", null]);
}

// A line not labeled a total that equals the sum of the others, to the cent,
// is the total: San Marino prints the year's school fees on p3 and their
// residential and commercial parts on p6.
{
  const rows = [
    row({ measure: "total_fees_collected", measure_as_printed: "Statutory School Fees Collected", value_usd: "81339.07", physical_pdf_page: "3" }),
    row({ measure: "total_fees_collected", measure_as_printed: "Residential Fees", value_usd: "80456.40", physical_pdf_page: "6" }),
    row({ measure: "total_fees_collected", measure_as_printed: "Commercial Fees", value_usd: "882.67", physical_pdf_page: "6" }),
  ];
  const cell = fundYear(buildFunds(rows), "Madera city", "Parks", "2022-23").cells.total_fees_collected;
  assert.deepEqual([cell.kind, cell.value, cell.used.length], ["total", 8133907, 1]);
  const pair = [row({ measure: "total_fees_collected", value_usd: "50" }), row({ measure: "total_fees_collected", value_usd: "50" })];
  const two = fundYear(buildFunds(pair), "Madera city", "Parks", "2022-23").cells.total_fees_collected;
  assert.deepEqual([two.kind, two.value], ["sum", 10000], "two equal lines are two lines, not a total and its part");
}

// Statewide ending balances: an account one report prints in two tables
// under two names counts once; zero balances are never taken for twins.
{
  const rows = [
    row({ fee_program: "Public Safety Fee", measure: "beginning_balance", value_usd: "100" }),
    row({ fee_program: "Public Safety Fee", measure: "ending_balance", value_usd: "630.18" }),
    row({ fee_program: "Public Safety", measure: "beginning_balance", value_usd: "100" }),
    row({ fee_program: "Public Safety", measure: "ending_balance", value_usd: "630.18" }),
    row({ fee_program: "Parks", measure: "beginning_balance", value_usd: "100" }),
    row({ fee_program: "Parks", measure: "ending_balance", value_usd: "630.18", source_id: "source-b" }),
    row({ fee_program: "Library", measure: "beginning_balance", value_usd: "0" }),
    row({ fee_program: "Library", measure: "ending_balance", value_usd: "0" }),
    row({ fee_program: "Art", measure: "beginning_balance", value_usd: "0" }),
    row({ fee_program: "Art", measure: "ending_balance", value_usd: "0" }),
  ];
  const [t] = statewideEnding(buildFunds(rows));
  assert.deepEqual([t.cents, t.funds, t.twins], [126036, 4, 1]);
}

// Whole thousands are flagged on the line; the amount is already in dollars.
{
  const funds = buildFunds([row({ measure: "ending_balance", value_usd: "24332000", source_limitations: "Amounts are expressed in whole thousands. Other text." })]);
  const cell = fundYear(funds, "Madera city", "Parks", "2022-23").cells.ending_balance;
  assert.equal(cell.lines[0].thousands, true);
  assert.equal(cell.value, 2433200000);
}

// Measure keys the view shows are the ones the model reads.
assert.deepEqual(FUND_MEASURES.map((m) => m.key), [
  "beginning_balance", "total_fees_collected", "interest_earned", "other_revenue", "total_revenue",
  "expenditures", "transfers_in", "transfers_out", "refunds", "ending_balance",
]);

const releaseRoot = path.resolve(process.env.MFA_DATA_ROOT || fileURLToPath(new URL("../../mfa-data", import.meta.url)));
const releaseCsv = path.join(releaseRoot, "data/fee-account-figures.csv");
if (existsSync(releaseCsv)) {
  const fees = parseCsvObjects(readFileSync(releaseCsv, "utf8"));
  const collectionsCsv = path.join(releaseRoot, "data/reported-fee-collections.csv");
  const collections = existsSync(collectionsCsv) ? parseCsvObjects(readFileSync(collectionsCsv, "utf8")).rows : [];
  const funds = buildFunds(fees.rows, collections);
  const s = funds.stats;
  const used = new Set();
  for (const a of funds.agencies) for (const f of a.funds) for (const y of f.years) {
    for (const c of Object.values(y.cells)) for (const l of c.lines) if (l.from === "accounts") used.add(l.id);
  }
  const primary = fees.rows.filter((r) => r.is_primary_in_figure_group === "true");
  assert.equal(used.size, primary.filter((r) => FUND_MEASURES.some((m) => m.key === r.measure)).length, "every primary fund row lands in one cell");
  assert.ok(fees.rows.every((r) => r.is_primary_in_figure_group === "true" || !used.has(r.record_id)), "no corroborating row is used");
  const pomona = fundYear(funds, "Pomona city", "Art in Public Places Fee (133-1712-40119-00000)", "2019-20");
  assert.deepEqual([pomona.cells.beginning_balance.value, pomona.cells.ending_balance.value], [166032200, 238583600], "Pomona's p8 and p13 tables count once");
  assert.equal(fundYear(funds, "San Marino Unified", "Capital Facilities Fund", "2020-21").cells.total_fees_collected.value, 8133907);
  const c = s.checks;
  const run = c.closes + c.rounding + c.incomplete + c.differs;
  console.log(`release: ${s.rows} rows, ${s.primary} primary, ${s.agencies} agencies, ${s.funds} funds, ${s.fundYears} fund years, ${s.years.length} fiscal years (${s.years[0]} to ${s.years[s.years.length - 1]})`);
  console.log(`balance check: ${run} run, ${c.closes} close, ${c.rounding} within $1 across reports, ${c.incomplete} incomplete, ${c.differs} off (${c.withinDollar} by $1 or less), ${c.none} not run`);
  console.log(`fees collected: ${s.fees.accounts} from fund tables, ${s.fees.collections} from collections, ${s.fees.bothEqual} of ${s.fees.both} printed in both agree`);
  const sw = statewideEnding(funds);
  console.log(`cells: ${Object.entries(s.cells).map(([k, n]) => `${n} ${k}`).join(", ")}; statewide years: ${sw.length}`);
  console.log(`statewide twins counted once: ${sw.filter((t) => t.twins).map((t) => `${t.fy} ${t.twins}`).join(", ")}`);
}
console.log("funds tests passed");
