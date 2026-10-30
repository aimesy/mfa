// node tests/apr.test.mjs
// Unit checks for the APR Table A2 rules (lib/apr.js): fiscal year
// assignment, dates outside a report, rows entered twice, repeats across
// reports, matching APR names to the roster, partial years and the join to
// release fees, where a missing year or activity stays missing. Also the Permits tab's URL state and sort
// (lib/apr-view.js), and the shape of apr/apr.json when it is present.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UNIT_CATS, CAT_COLUMNS, ROW_COLUMNS, JURISDICTION_COLUMNS, parseDate, fyLabel, fyOf, dateProblem, normId,
  dedupeActivity, fyCoverage, normName, rosterKeys, rosterIndex, matchJurisdiction, APR_ALIASES, releaseKey, releaseIndex,
  releaseNamesFor, agencyFees, readApr, titleCase, joinPermits, median,
} from "../lib/apr.js";
import { emptyPermitsState, readPermitsState, permitsParams, permitsKey, sortPermitRows, DEFAULT_PERMITS_SORT } from "../lib/apr-view.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Every dated record is a copy within one report, a repeat on a key, a
// repeat by ID and units, or kept.
const balanced = (stats) => assert.equal(stats.dated,
  stats.same_report_copies + stats.dropped + stats.id_units_repeats + stats.kept, "dated records all accounted for");

// Dates and fiscal years: July 1 starts the year; June 30 ends it.
{
  assert.deepEqual(parseDate("2020-02-29"), { y: 2020, m: 2, d: 29 });
  assert.equal(parseDate("2019-02-29"), null, "2019 is not a leap year");
  assert.equal(parseDate("2019-02-30"), null);
  assert.equal(parseDate("2019-13-01"), null);
  assert.equal(parseDate("2019-00-10"), null);
  assert.equal(parseDate("2019-06-00"), null);
  assert.equal(parseDate("06/30/2019"), null);
  assert.equal(parseDate(""), null);
  assert.equal(parseDate(null), null);
  assert.equal(fyLabel(2019), "2019-20");
  assert.equal(fyLabel(1999), "1999-00");
  assert.equal(fyOf("2019-06-30"), "2018-19");
  assert.equal(fyOf("2019-07-01"), "2019-20");
  assert.equal(fyOf("2019-12-31"), "2019-20");
  assert.equal(fyOf("2020-01-01"), "2019-20");
  assert.equal(fyOf("2020-06-30"), "2019-20");
  assert.equal(fyOf("2019-02-30"), "");
  assert.equal(fyOf(""), "");
}

// A date after the report's calendar year is late; before the table's first
// fiscal year it is early; not a real date it is malformed.
{
  assert.equal(dateProblem("2019-12-31", 2019), "");
  assert.equal(dateProblem("2020-01-01", 2019), "late");
  assert.equal(dateProblem("2017-07-01", 2019, "2017-07-01"), "");
  assert.equal(dateProblem("2017-06-30", 2019, "2017-07-01"), "early");
  assert.equal(dateProblem("2015-03-04", 2019), "", "no minDate, no early");
  assert.equal(dateProblem("2019-02-30", 2019), "malformed");
  assert.equal(dateProblem("3/4/2019", 2019), "malformed");
}

// Identifiers: formats meet, placeholders and zeros are no identifier.
{
  assert.equal(normId("5629-006-018"), "5629006018");
  assert.equal(normId(" 5629006018 "), "5629006018");
  assert.equal(normId("bp-2019-0012"), "BP20190012");
  for (const v of ["", "N/A", "n/a", "NA", "none", "TBD", "Unknown", "NULL", "pending", "0", "000-000-000", null, undefined]) {
    assert.equal(normId(v), "", `placeholder ${v}`);
  }
}

// Repeats across reports: the earliest report's record stands.
{
  const rec = (o) => ({ j: 0, cat: "SFD", id: "", apn: "", units: 1, ...o });
  const { kept, stats } = dedupeActivity([
    rec({ year: 2019, id: "A1", apn: "P1", date: "2019-03-01", units: 2, tag: "first" }),
    rec({ year: 2020, id: "A1", apn: "P1", date: "2019-03-01", units: 2, tag: "relisted" }),
    rec({ year: 2021, id: "A1", apn: "P1", date: "2019-03-01", units: 3, tag: "relisted, more units" }),
  ], { minDate: "2017-07-01" });
  assert.deepEqual(kept.map((r) => r.tag), ["first"]);
  assert.equal(stats.dropped, 2);
  assert.equal(stats.dropped_units, 5);
  assert.equal(stats.kept_units, 2);
  assert.equal(stats.repeat_keys, 1);
  assert.equal(stats.more_units_later, 1);
  assert.equal(stats.fewer_units_later, 0);
}
{
  // The later report changed the tracking ID format; the APN still meets.
  const { kept, stats } = dedupeActivity([
    { j: 0, cat: "ADU", year: 2020, id: "B7", apn: "1234", date: "2020-05-01", units: 1, tag: "first" },
    { j: 0, cat: "ADU", year: 2021, id: "2020B7", apn: "1234", date: "2020-05-01", units: 1, tag: "repeat by APN" },
  ]);
  assert.deepEqual(kept.map((r) => r.tag), ["first"]);
  assert.equal(stats.dropped, 1);
}
{
  // Records that differ in jurisdiction, category or date are not repeats.
  const { kept } = dedupeActivity([
    { j: 0, cat: "SFD", year: 2019, id: "C1", apn: "", date: "2019-04-01", units: 1 },
    { j: 1, cat: "SFD", year: 2020, id: "C1", apn: "", date: "2019-04-01", units: 1 },
    { j: 0, cat: "ADU", year: 2020, id: "C1", apn: "", date: "2019-04-01", units: 1 },
    { j: 0, cat: "SFD", year: 2020, id: "C1", apn: "", date: "2019-04-02", units: 1 },
  ]);
  assert.equal(kept.length, 4);
}
{
  // One report listing two units under one ID counts both; a record with
  // no identifier cannot repeat and counts; undated and bad dates are out.
  // No next report is filed here, so the late record stays out (the
  // exception for late records has its own test below).
  const { kept, stats } = dedupeActivity([
    { j: 0, cat: "SFA", year: 2022, id: "D1", apn: "", date: "2022-02-01", units: 1 },
    { j: 0, cat: "SFA", year: 2022, id: "D1", apn: "", date: "2022-02-01", units: 1 },
    { j: 0, cat: "SFA", year: 2023, id: "", apn: "", date: "2022-02-01", units: 4 },
    { j: 0, cat: "SFA", year: 2022, id: "D2", apn: "", date: "", units: 9 },
    { j: 0, cat: "SFA", year: 2022, id: "D3", apn: "", date: "2023-01-05", units: 6 },
    { j: 0, cat: "SFA", year: 2022, id: "D4", apn: "", date: "2016-01-05", units: 7 },
    { j: 0, cat: "SFA", year: 2022, id: "D5", apn: "", date: "2022-02-30", units: 8 },
  ], { minDate: "2017-07-01", filed: () => false });
  assert.equal(kept.length, 3);
  assert.equal(stats.same_report_repeats, 1);
  assert.equal(stats.unkeyed, 1);
  assert.equal(stats.kept_units, 6);
  assert.equal(stats.kept_before_report_year, 1, "the unkeyed 2023 record dated 2022");
  assert.deepEqual([stats.undated, stats.undated_units], [1, 9]);
  assert.deepEqual([stats.late, stats.late_units], [1, 6]);
  assert.deepEqual([stats.early, stats.early_units], [1, 7]);
  assert.equal(stats.malformed, 1);
  assert.equal(stats.dated, 3);
  assert.equal(stats.rows, 7);
  assert.equal(stats.late_kept, 0);
  balanced(stats);
}
{
  // A record kept by its ID key but whose APN key began in an earlier report
  // is a repeat.
  const { kept } = dedupeActivity([
    { j: 0, cat: "5+", year: 2019, id: "", apn: "777", date: "2019-08-01", units: 40, tag: "first" },
    { j: 0, cat: "5+", year: 2020, id: "E9", apn: "777", date: "2019-08-01", units: 40, tag: "repeat with a new ID" },
  ]);
  assert.deepEqual(kept.map((r) => r.tag), ["first"]);
}
{
  // Dropped on the APN key with a new ID and other units: still dropped, but
  // counted apart as possibly a separate permit.
  const { kept, stats } = dedupeActivity([
    { j: 0, cat: "5+", year: 2019, id: "", apn: "777", date: "2019-08-01", units: 40, tag: "first" },
    { j: 0, cat: "5+", year: 2020, id: "E9", apn: "777", date: "2019-08-01", units: 40, tag: "same units" },
    { j: 0, cat: "5+", year: 2020, id: "N9", apn: "777", date: "2019-08-01", units: 12, tag: "other units" },
  ]);
  assert.deepEqual(kept.map((r) => r.tag), ["first"]);
  assert.equal(stats.dropped, 2);
  assert.deepEqual([stats.apn_only_dropped, stats.apn_only_dropped_units], [1, 12]);
  balanced(stats);
}
{
  // One source row entered twice in a report counts once; two rows that
  // differ in any column both count.
  const { kept, stats } = dedupeActivity([
    { j: 0, cat: "SFD", year: 2020, id: "S7", apn: "", date: "2020-03-01", units: 2, sig: "x" },
    { j: 0, cat: "SFD", year: 2020, id: "S7", apn: "", date: "2020-03-01", units: 2, sig: "x" },
    { j: 0, cat: "SFD", year: 2020, id: "S7", apn: "", date: "2020-03-01", units: 2, sig: "y" },
  ]);
  assert.equal(kept.length, 2);
  assert.deepEqual([stats.same_report_copies, stats.same_report_copy_units], [1, 2]);
  assert.equal(stats.same_report_repeats, 1);
  assert.equal(stats.kept_units, 4);
  balanced(stats);
}
{
  // A later report edits the date or category of a row it repeats: dropped
  // when it is dated before its report year and an earlier report lists the
  // same ID and units, once, under a date in the same or an earlier fiscal
  // year.
  const rec = (o) => ({ j: 0, cat: "5+", apn: "", ...o });
  const { kept, stats } = dedupeActivity([
    rec({ year: 2019, id: "F1", date: "2019-05-30", units: 362, tag: "F1 first" }),
    rec({ year: 2023, id: "F1", date: "2019-12-23", units: 362, tag: "F1 redated" }),
    rec({ year: 2021, id: "G1", date: "2021-01-29", units: 98, tag: "G1 first" }),
    rec({ year: 2023, id: "G1", cat: "2 to 4", date: "2021-01-29", units: 98, tag: "G1 recategorized" }),
    rec({ year: 2021, id: "H1", date: "2021-02-01", units: 20, tag: "H1 first" }),
    rec({ year: 2022, id: "H1", date: "2022-02-01", units: 20, tag: "H1 dated in its own report year" }),
    rec({ year: 2021, id: "K1", date: "2020-10-01", units: 5, tag: "K1 first" }),
    rec({ year: 2022, id: "K1", date: "2020-01-15", units: 5, tag: "K1 in an earlier fiscal year" }),
    rec({ year: 2019, id: "M1", date: "2019-03-01", units: 4, tag: "M1 first" }),
    rec({ year: 2020, id: "M1", date: "2019-06-01", units: 5, tag: "M1 other units" }),
    rec({ year: 2020, id: "S1", cat: "SFD", apn: "Q1", date: "2020-02-01", units: 1, tag: "S1 first" }),
    rec({ year: 2021, id: "S1", cat: "SFD", apn: "Q1", date: "2020-04-01", units: 1, tag: "S1 same APN" }),
    rec({ year: 2020, id: "T1", cat: "SFD", apn: "P1", date: "2020-02-01", units: 1, tag: "T1 first" }),
    rec({ year: 2021, id: "T1", cat: "SFD", apn: "P2", date: "2020-11-01", units: 1, tag: "T1 another parcel" }),
    rec({ year: 2020, id: "TR9", cat: "SFD", date: "2020-02-01", units: 1, tag: "TR9 house 1" }),
    rec({ year: 2020, id: "TR9", cat: "SFD", date: "2020-05-01", units: 1, tag: "TR9 house 2" }),
    rec({ year: 2021, id: "TR9", cat: "SFD", date: "2020-12-08", units: 1, tag: "TR9 house 3" }),
  ]);
  const dropped = ["F1 redated", "G1 recategorized", "S1 same APN"];
  assert.deepEqual(kept.map((r) => r.tag).filter((t) => dropped.includes(t)), []);
  assert.equal(kept.length, 14);
  assert.deepEqual([stats.id_units_repeats, stats.id_units_repeat_units], [3, 461]);
  assert.equal(stats.dropped, 0);
  balanced(stats);
}
{
  // A row dated January to June of the year after its report counts when
  // the jurisdiction filed that next report and it lists neither the ID nor
  // the APN; otherwise it stays out as late.
  const rec = (o) => ({ j: 0, cat: "ADU", apn: "", units: 2, ...o });
  const { kept, stats } = dedupeActivity([
    rec({ year: 2021, id: "L1", date: "2022-03-01", tag: "L1 kept" }),
    rec({ year: 2021, id: "L2", date: "2022-03-01", tag: "L2 late" }),
    rec({ year: 2022, id: "L2", date: "2022-03-01", tag: "L2 in the next report" }),
    rec({ year: 2021, id: "L3", apn: "88", date: "2022-04-01", tag: "L3 late, APN in the next report" }),
    rec({ year: 2022, id: "", apn: "88", date: "2022-01-09", tag: "APN 88" }),
    rec({ year: 2021, id: "L4", date: "2022-08-01", tag: "L4 late, after June" }),
    rec({ year: 2021, id: "", date: "2022-03-01", tag: "late, no identifier" }),
    rec({ j: 1, year: 2021, id: "L5", date: "2022-03-01", tag: "L5 late, next report not filed" }),
  ], { filed: (j, y) => j === 0 && y <= 2022 });
  assert.deepEqual(kept.map((r) => r.tag), ["L1 kept", "L2 in the next report", "APN 88"]);
  assert.deepEqual([stats.late_kept, stats.late_kept_units], [1, 2]);
  assert.deepEqual([stats.late, stats.late_units], [5, 10]);
  balanced(stats);
}

// Coverage: a fiscal year spans two report years.
{
  const years = [2018, 2019, 2020, 2021];
  const mask = 0b0110; // reports for 2019 and 2020
  assert.equal(fyCoverage(mask, "2019-20", years), "full");
  assert.equal(fyCoverage(mask, "2018-19", years), "partial");
  assert.equal(fyCoverage(mask, "2020-21", years), "partial");
  assert.equal(fyCoverage(mask, "2017-18", years), "none");
  assert.equal(fyCoverage(mask, "2021-22", years), "none");
  assert.equal(fyCoverage(0b1111, "2021-22", years), "partial", "2022 is outside the table");
}

// Names: APR jurisdictions to roster agencies, never guessed.
{
  assert.equal(normName("Cañada  Flintridge"), "CANADA FLINTRIDGE");
  assert.equal(normName("Carmel-by-the-Sea"), "CARMEL BY THE SEA");
  assert.equal(normName("St. Helena"), "ST HELENA");
  assert.equal(normName("Paso Robles & Co"), "PASO ROBLES AND CO");
  assert.deepEqual(rosterKeys("Adelanto city"), ["place|ADELANTO"]);
  assert.deepEqual(rosterKeys("Apple Valley town"), ["place|APPLE VALLEY"]);
  assert.deepEqual(rosterKeys("Amador County"), ["county|AMADOR"]);
  assert.deepEqual(rosterKeys("City and County of San Francisco"), ["sf|SAN FRANCISCO"]);
  assert.deepEqual(rosterKeys("San Buenaventura (Ventura) city"),
    ["place|SAN BUENAVENTURA VENTURA", "place|SAN BUENAVENTURA", "place|VENTURA"]);
  assert.deepEqual(rosterKeys("Some district"), []);

  const roster = [
    { name: "Amador County", county: "Amador" },
    { name: "Amador City city", county: "Amador" },
    { name: "City and County of San Francisco", county: "San Francisco" },
    { name: "San Buenaventura (Ventura) city", county: "Ventura" },
    { name: "Mountain View city", county: "Santa Clara" },
    { name: "Plainview city", county: "Alpha" },
    { name: "Plainview town", county: "Alpha" },
  ];
  const index = rosterIndex(roster);
  const m = (j, c) => matchJurisdiction(j, c, index);
  assert.deepEqual(m("AMADOR COUNTY", "AMADOR"), { agency: "Amador County", match: "name_and_county", candidates: [] });
  assert.equal(m("SAN FRANCISCO", "SAN FRANCISCO").agency, "City and County of San Francisco");
  assert.equal(m("SAN FRANCISCO COUNTY", "SAN FRANCISCO").agency, "City and County of San Francisco");
  assert.equal(m("VENTURA", "VENTURA").agency, "San Buenaventura (Ventura) city");
  assert.equal(m("SAN BUENAVENTURA", "VENTURA").agency, "San Buenaventura (Ventura) city");
  assert.equal(m("MOUNTAIN VIEW", "SANTA CLARA").match, "name_and_county");
  assert.deepEqual(m("MOUNTAIN VIEW", "SAN MATEO"),
    { agency: "", match: "county_differs", candidates: ["Mountain View city (Santa Clara)"] });
  assert.deepEqual(m("PLAINVIEW", "ALPHA"), { agency: "", match: "ambiguous", candidates: ["Plainview city", "Plainview town"] });
  // HCD's "AMADOR" in Amador County is Amador City, through APR_ALIASES;
  // the alias holds only in its county, and other names are not guessed.
  assert.equal(APR_ALIASES.get("AMADOR|AMADOR"), "AMADOR CITY");
  assert.deepEqual(m("AMADOR", "AMADOR"), { agency: "Amador City city", match: "alias_and_county", candidates: [] });
  assert.deepEqual(m("AMADOR", "CALAVERAS"), { agency: "", match: "unmatched", candidates: [] });
  assert.deepEqual(m("AMADORA", "AMADOR"), { agency: "", match: "unmatched", candidates: [] });
  assert.equal(titleCase("LA CANADA FLINTRIDGE"), "La Canada Flintridge");
  assert.equal(titleCase("SAINT HELENA"), "Saint Helena");
}

// Release names to roster keys, only when the entity type fits the name.
{
  assert.equal(releaseKey("City of Hawthorne", "city"), "place|HAWTHORNE");
  assert.equal(releaseKey("Town of Apple Valley", "town"), "place|APPLE VALLEY");
  assert.equal(releaseKey("Hawthorne city", ""), "place|HAWTHORNE");
  assert.equal(releaseKey("County of Napa", "county"), "county|NAPA");
  assert.equal(releaseKey("Napa County", ""), "county|NAPA");
  assert.equal(releaseKey("City and County of San Francisco", "city_and_county"), "sf|SAN FRANCISCO");
  assert.equal(releaseKey("City of San Francisco", "city"), "sf|SAN FRANCISCO");
  assert.equal(releaseKey("City of Hawthorne", "special_district"), "", "a district named like a city is not the city");
  assert.equal(releaseKey("County of Napa", "city"), "");
  assert.equal(releaseKey("Napa Sanitation District", ""), "");

  const index = releaseIndex([
    { name: "City of Hawthorne", type: "city" },
    { name: "Hawthorne city", type: "" },
    { name: "Hawthorne Water District", type: "special_district" },
  ]);
  assert.deepEqual(releaseNamesFor({ name: "Hawthorne city", names: ["Hawthorne (City)"] }, index),
    ["City of Hawthorne", "Hawthorne (City)", "Hawthorne city"]);
}

// Fees: primary rows with a value only; a year with none is missing.
{
  const entityByName = new Map([
    ["City of A", { name: "City of A", figures: [
      { fy: "2019-20", value: 100, primary: { _primary: true } },
      { fy: "2019-20", value: 999, primary: { _primary: false } },
      { fy: "2019-20", value: 50, primary: { _primary: true } },
      { fy: "2020-21", value: NaN, primary: { _primary: true } },
      { fy: "", value: 7, primary: { _primary: true } },
      { fy: "2021-22", value: -20, primary: { _primary: true } },
    ] }],
    ["A city", { name: "A city", figures: [{ fy: "2019-20", value: 5, primary: { _primary: true } }] }],
  ]);
  const fees = agencyFees(["City of A", "A city", "Not in release"], entityByName);
  assert.deepEqual([...fees.keys()].sort(), ["2019-20", "2021-22"]);
  assert.equal(fees.get("2019-20").sum, 155);
  assert.equal(fees.get("2019-20").figures, 3);
  assert.equal(fees.get("2019-20").names.size, 2);
  assert.equal(fees.get("2021-22").sum, -20);
  assert.equal(fees.has("2020-21"), false, "no finite primary value: missing, not zero");
}

// The join: units and fees by agency year; missing stays missing.
{
  const raw = {
    report_years: [2019, 2020, 2021],
    unit_cats: UNIT_CATS,
    jurisdiction_columns: JURISDICTION_COLUMNS,
    // Alpha reports 2019 and 2020; Beta 2021 only; Gamma matches nothing.
    jurisdictions: [
      ["ALPHA", "ONE", "Alpha city", "name_and_county", 0b011],
      ["BETA", "ONE", "Beta city", "name_and_county", 0b100],
      ["GAMMA", "TWO", "", "unmatched", 0b001],
    ],
    columns: ROW_COLUMNS,
    rows: [
      // j, fy, bp_units, bp_records, bp_dr, bp_ndr, six categories, ent_units, ent_records, co_units, co_records
      [0, "2019-20", 10, 4, 2, 8, 6, 0, 0, 0, 4, 0, 3, 1, 5, 2],
      [0, "2018-19", 3, 3, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [1, "2021-22", 7, 7, 0, 7, 7, 0, 0, 0, 0, 0, 0, 0, 2, 2],
      [2, "2018-19", 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ],
  };
  const apr = readApr(raw);
  assert.deepEqual(apr.jurisdictions[0], { juris: "ALPHA", county: "ONE", agency: "Alpha city", match: "name_and_county", mask: 3 });
  assert.equal(apr.rows[0].bp_units, 10);
  assert.equal(apr.rows[0].bp_adu, 4);
  const agencies = [
    { name: "Alpha city", type: "city", county: "One", names: ["City of Alpha"] },
    { name: "Beta city", type: "city", county: "One", names: ["City of Beta", "Beta Public Financing Authority"] },
  ];
  const fig = (fy, value) => ({ fy, value, primary: { _primary: true } });
  const entities = [
    { name: "City of Alpha", type: "city", figures: [fig("2019-20", 50000), fig("2020-21", 9000), fig("2017-18", 1)] },
    { name: "Alpha city", type: "", figures: [fig("2018-19", 300)] },
    { name: "City of Beta", type: "city", figures: [fig("2021-22", 700)] },
    { name: "Beta Public Financing Authority", type: "jpa", figures: [fig("2021-22", 100), fig("2022-23", 5)] },
  ];
  const model = { entities, entityByName: new Map(entities.map((e) => [e.name, e])) };
  const rows = joinPermits(apr, agencies, model);
  const get = (j, fy) => rows.find((r) => r.j === j && r.fy === fy);

  // Alpha: reports 2019 and 2020, so FY 2018-19, 2019-20 and 2020-21.
  assert.deepEqual(rows.filter((r) => r.j === 0).map((r) => [r.fy, r.cov]),
    [["2018-19", "partial"], ["2019-20", "full"], ["2020-21", "partial"]]);
  const a = get(0, "2019-20");
  assert.equal(a.name, "Alpha city");
  assert.equal(a.entity, "City of Alpha", "the release name with the most figures opens the agency");
  assert.deepEqual([a.units, a.records, a.dr, a.ndr, a.ent, a.co], [10, 4, 2, 8, 3, 5]);
  assert.deepEqual(a.cats, [6, 0, 0, 0, 4, 0]);
  assert.equal(a.fees, 50000);
  assert.equal(a.feeNames, 1);
  assert.equal(a.perUnit, 5000);
  // A partial year with a row keeps its counts but gets no fees per unit.
  const p = get(0, "2018-19");
  assert.equal(p.units, 3);
  assert.equal(p.fees, 300, "fees found under the second release name");
  assert.equal(p.perUnit, null);
  // A partial year with no row: units missing, not zero.
  const q = get(0, "2020-21");
  assert.equal(q.units, null);
  assert.equal(q.records, null);
  assert.deepEqual(q.cats, [null, null, null, null, null, null]);
  assert.equal(q.fees, 9000);
  assert.equal(q.perUnit, null);
  // A fee year no report reaches gets no row at all.
  assert.equal(get(0, "2017-18"), undefined);

  // Beta: one report (2021), so both its fiscal years are partial; fees from
  // two release names stay summed but are flagged.
  const b = get(1, "2021-22");
  assert.equal(b.cov, "partial");
  assert.equal(b.units, 7);
  assert.equal(b.fees, 800);
  assert.equal(b.feeNames, 2);
  assert.equal(b.perUnit, null);
  assert.equal(get(1, "2020-21").units, null);

  // Gamma: no roster agency, so no fees; its name comes from the APR.
  const g = get(2, "2018-19");
  assert.equal(g.agency, "");
  assert.equal(g.name, "Gamma");
  assert.equal(g.county, "Two");
  assert.equal(g.entity, "");
  assert.equal(g.fees, null);
  assert.equal(g.perUnit, null);
}
{
  // A full year with no row is zero activity; fees per unit need units
  // above zero, fees present and one release name.
  const apr = readApr({
    report_years: [2019, 2020],
    jurisdiction_columns: JURISDICTION_COLUMNS,
    jurisdictions: [["DELTA", "ONE", "Delta city", "name_and_county", 0b11]],
    columns: ROW_COLUMNS,
    rows: [[0, "2018-19", 2, 2, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  });
  const entities = [{ name: "City of Delta", type: "city", figures: [{ fy: "2019-20", value: 1000, primary: { _primary: true } }] }];
  const rows = joinPermits(apr, [{ name: "Delta city", type: "city", county: "One", names: [] }],
    { entities, entityByName: new Map(entities.map((e) => [e.name, e])) });
  const d = rows.find((r) => r.fy === "2019-20");
  assert.equal(d.cov, "full");
  assert.equal(d.units, 0);
  assert.equal(d.records, 0);
  assert.deepEqual(d.cats, [0, 0, 0, 0, 0, 0]);
  assert.equal(d.fees, 1000);
  assert.equal(d.perUnit, null, "no units permitted");
  assert.equal(d.entity, "City of Delta", "found by key though coverage.json lists no release name");
  const e = rows.find((r) => r.fy === "2020-21");
  assert.equal(e.cov, "partial");
  assert.equal(e.units, null);
  assert.equal(e.fees, null);
}
{
  // In a year that is not full, an activity with no record counted is
  // missing even when the row has another activity's counts; one with
  // records keeps them, including a year with neither report.
  const apr = readApr({
    report_years: [2018, 2019, 2020, 2021],
    jurisdiction_columns: JURISDICTION_COLUMNS,
    // Epsilon reports 2019 and 2021 only.
    jurisdictions: [["EPSILON", "ONE", "Epsilon city", "name_and_county", 0b1010]],
    columns: ROW_COLUMNS,
    rows: [
      // FY 2018-19, partial: entitlements only.
      [0, "2018-19", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 2, 0, 0],
      // FY 2017-18, neither report: permits a later report lists.
      [0, "2017-18", 6, 2, 0, 6, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      // FY 2019-20, partial: completions only.
      [0, "2019-20", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 1],
    ],
  });
  const rows = joinPermits(apr, [{ name: "Epsilon city", type: "city", county: "One", names: [] }],
    { entities: [], entityByName: new Map() });
  const at = (fy) => rows.find((r) => r.fy === fy);
  const p = at("2018-19");
  assert.equal(p.cov, "partial");
  assert.deepEqual([p.units, p.records, p.dr, p.ndr, p.ent, p.co], [null, null, null, null, 12, null]);
  assert.deepEqual(p.cats, [null, null, null, null, null, null]);
  const n = at("2017-18");
  assert.equal(n.cov, "none");
  assert.deepEqual([n.units, n.records, n.ent, n.co], [6, 2, null, null]);
  assert.deepEqual(n.cats, [6, 0, 0, 0, 0, 0]);
  const c = at("2019-20");
  assert.deepEqual([c.cov, c.units, c.ent, c.co], ["partial", null, null, 3]);
}

// Median.
{
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([NaN, 5, null, Infinity]), 5);
}

// The Permits tab's URL state and sort.
{
  const ps = readPermitsState(new URLSearchParams("pq=san&ptype=county&pcounty=Napa&pfy=2019-20&pshow=all&psort=perUnit.desc&ppage=3"));
  assert.deepEqual(ps, { q: "san", type: "county", county: "Napa", fy: "2019-20", show: "all", sort: { col: "perUnit", dir: "desc" }, page: 3 });
  const bad = readPermitsState(new URLSearchParams("ptype=district&pfy=2019&pshow=x&psort=bogus.desc&ppage=-2"));
  assert.deepEqual(bad, emptyPermitsState());
  const out = {};
  const put = (k, v) => { if (v) out[k] = v; };
  permitsParams(ps, put);
  assert.deepEqual(out, { pq: "san", ptype: "county", pcounty: "Napa", pfy: "2019-20", pshow: "all", psort: "perUnit.desc", ppage: "3" });
  const none = {};
  permitsParams(emptyPermitsState(), (k, v) => { if (v) none[k] = v; });
  assert.deepEqual(none, {}, "the default state writes no parameters");
  assert.deepEqual(DEFAULT_PERMITS_SORT, { col: "name", dir: "asc" });
  assert.equal(permitsKey(ps).length, 8);
  assert.deepEqual(permitsKey(undefined), []);

  const r = (name, fy, units, perUnit = null) => ({ name, fy, units, perUnit, cov: "full" });
  const list = [r("B", "2019-20", 5), r("A", "2020-21", null), r("A", "2019-20", 9, 10), r("C", "2019-20", 0, 3)];
  const order = (sort) => sortPermitRows(list, sort).map((x) => `${x.name} ${x.fy}`);
  assert.deepEqual(order({ col: "units", dir: "desc" }), ["A 2019-20", "B 2019-20", "C 2019-20", "A 2020-21"]);
  assert.deepEqual(order({ col: "units", dir: "asc" }), ["C 2019-20", "B 2019-20", "A 2019-20", "A 2020-21"], "missing sorts last either way");
  assert.deepEqual(order({ col: "perUnit", dir: "asc" }), ["C 2019-20", "A 2019-20", "A 2020-21", "B 2019-20"]);
  assert.deepEqual(order({ col: "name", dir: "asc" }), ["A 2019-20", "A 2020-21", "B 2019-20", "C 2019-20"]);
}

// apr/apr.json, when present: the published columns only, no addresses,
// APNs, project names or coordinates, and counts that agree.
{
  const file = path.join(here, "..", "apr", "apr.json");
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(raw.columns, ROW_COLUMNS);
    assert.deepEqual(raw.jurisdiction_columns, JURISDICTION_COLUMNS);
    assert.deepEqual(raw.unit_cats, UNIT_CATS);
    assert.equal(CAT_COLUMNS.length, UNIT_CATS.length);
    const text = JSON.stringify(raw);
    for (const f of ["STREET_ADDRESS", "APN", "PROJECT_NAME", "LATITUDE", "LONGITUDE", "JURS_TRACKING_ID"]) {
      assert.ok(!raw.columns.includes(f) && !raw.columns.includes(f.toLowerCase()), `no ${f} column`);
    }
    assert.ok(!/\b\d{3}-\d{3}-\d{3}\b/.test(JSON.stringify(raw.rows)), "no APN shaped values in rows");
    assert.ok(text.length < 2_000_000, "apr.json stays small");
    assert.match(raw.source.file_sha256, /^[0-9a-f]{64}$/);
    assert.ok(raw.source.dataset_url.startsWith("https://data.ca.gov/"));
    const apr = readApr(raw);
    const fyRe = /^\d{4}-\d{2}$/;
    const seen = new Set();
    for (const row of apr.rows) {
      assert.ok(fyRe.test(row.fy), `fiscal year ${row.fy}`);
      assert.ok(row.j >= 0 && row.j < apr.jurisdictions.length);
      const k = `${row.j}|${row.fy}`;
      assert.ok(!seen.has(k), `one row per jurisdiction and fiscal year (${k})`);
      seen.add(k);
      for (const c of ROW_COLUMNS.slice(2)) assert.ok(Number.isInteger(row[c]) && row[c] >= 0, `${c} ${row[c]}`);
      assert.equal(CAT_COLUMNS.reduce((s, c) => s + row[c], 0), row.bp_units, `categories sum to units (${k})`);
      assert.equal(row.bp_dr + row.bp_ndr, row.bp_units, `deed restricted split sums to units (${k})`);
    }
    for (const jur of apr.jurisdictions) {
      assert.ok(jur.mask > 0 && jur.mask < 2 ** apr.report_years.length);
      assert.equal(Boolean(jur.agency), jur.match === "name_and_county" || jur.match === "alias_and_county");
    }
    const unmatched = apr.jurisdictions.filter((j) => j.match === "unmatched").length;
    assert.equal((raw.unmatched || []).length, unmatched, "every unmatched name is reported");
  }
}

console.log("apr tests passed");
