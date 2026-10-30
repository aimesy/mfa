#!/usr/bin/env node
// Writes apr/apr.json, the Permits tab's data: housing units each city and
// county permitted, entitled and completed in each fiscal year, from HCD's
// Housing Element Annual Progress Report (APR) Table A2.
//
//   node scripts/apr.mjs [tablea2.csv] [out.json] [--coverage coverage.json]
//                        [--updated YYYY-MM-DD] [--offline]
//
// Source: "Housing Element Annual Progress Report (APR) Data by Jurisdiction
// and Year", California Department of Housing and Community Development,
// https://data.ca.gov/dataset/housing-element-annual-progress-report-apr-data-by-jurisdiction-and-year,
// resource "APR Table A2" (tablea2.csv, resource id RESOURCE_ID below). The
// file is read from the collection project
// (projects/mitigation-fee-act/apr/tablea2.csv) unless a path is given. The
// output records the file's size, SHA-256 and MD5, and the portal's
// last_modified date for the resource when the portal's MD5 matches the file
// (checked live unless --offline; --updated sets the date by hand, for a
// run when the portal does not answer).
//
// What goes out: one row per jurisdiction and fiscal year with unit counts
// only. No addresses, APNs, tracking IDs, project names, notes or
// coordinates leave this script.
//
// Fiscal years run July 1 to June 30 ("2019-20" starts 2019-07-01). Each
// activity is assigned by its own first date: building permits by
// BP_ISSUE_DT1 (units NO_BUILDING_PERMITS), entitlements by ENT_APPROVE_DT1
// (NO_ENTITLEMENTS), certificates of occupancy by CO_ISSUE_DT1
// (NO_OTHER_FORMS_OF_READINESS). Deed restricted units are the *_DR income
// columns; the rest are the *_NDR columns plus *_ABOVE_MOD_INCOME, which sum
// with them to the total.
//
// Dedupe rule (lib/apr.js dedupeActivity): a project returns in later
// reports carrying the date and units an earlier report already counted. For
// each activity:
//   - Rows with no date, a malformed date or a date before the first fiscal
//     year any report reaches are left out, and so are rows dated after the
//     report's calendar year, except a row dated January to June of the next
//     year, with an ID or APN, when the jurisdiction filed the next report
//     and that report lists neither identifier for the activity.
//   - Rows of one report identical in every source column count once.
//   - A row's keys are (jurisdiction, UNIT_CAT, activity date, normalized
//     JURS_TRACKING_ID) and the same with normalized APN. A row counts only
//     if its report YEAR is the earliest report year of every key it has;
//     later reports of a key are dropped, so the earliest report's units
//     stand. Rows of one key in that earliest report all count (one report
//     lists separate units under one ID). A row with neither identifier
//     counts.
//   - A row dated before its own report year is dropped when an earlier
//     report lists the same jurisdiction, tracking ID and units under a date
//     in the same or an earlier fiscal year, whatever its UNIT_CAT. Both
//     reports must list that ID and units on one row (a tract permit number
//     covers many houses), and for a single unit the APNs must agree or one
//     be missing.
// The script logs every count before and after.
//
// Coverage: a jurisdiction's report years are the years in which it has at
// least one Table A2 row (report_years_mask). A fiscal year is full when the
// reports for both of its calendar years are present and partial when one
// is. A year that no report reaches is missing, never zero.
//
// Names: each APR jurisdiction (JURIS_NAME, CNTY_NAME) is matched to one
// city or county on the coverage roster (coverage/coverage.json) by
// lib/apr.js matchJurisdiction: "X COUNTY" to "X County", San Francisco to
// "City and County of San Francisco", anything else to "X city" or "X town"
// (or the parenthetical name, "San Buenaventura (Ventura) city" for VENTURA),
// and the roster agency must be in the same county. Five HCD spellings go
// through lib/apr.js APR_ALIASES (CATHEDRAL in Riverside County to Cathedral
// City, and so on), still within the county, and match as alias_and_county.
// Anything else is listed as unmatched, ambiguous or county_differs and left
// without an agency; nothing is guessed.
//
// A later join: JURS_TRACKING_ID and APN identify each project, so permit
// fee payment records from Public Records Act responses could be joined to
// these rows by permit. This script does not build that join and publishes
// neither field.

import { createReadStream, readFileSync, writeFileSync, renameSync, statSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UNIT_CATS, ROW_COLUMNS, JURISDICTION_COLUMNS, fyOf, normId, normApn, dedupeActivity,
  rosterIndex, matchJurisdiction, normName,
} from "../lib/apr.js";

const DATASET_URL = "https://data.ca.gov/dataset/housing-element-annual-progress-report-apr-data-by-jurisdiction-and-year";
const RESOURCE_ID = "fe505d9b-8c36-42ba-ba30-08bc4f34e022";
const RESOURCE_API = `https://data.ca.gov/api/3/action/resource_show?id=${RESOURCE_ID}`;
// The resource's download address as resource_show gave it on 2026-10-30;
// a live answer from the portal replaces it.
const RESOURCE_URL = `https://publish.data.ca.gov/dataset/81b0841f-2802-403e-b48e-2ef4b751f77c/resource/${RESOURCE_ID}/download/tablea2.csv`;

const opt = {};
const positional = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--coverage" || arg === "--updated") opt[arg.slice(2)] = process.argv[++i];
  else if (arg === "--offline") opt.offline = true;
  else positional.push(arg);
}
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const [csvPath = here("../../mitigation-fee-act/apr/tablea2.csv"), out = here("../apr/apr.json")] = positional;
const coveragePath = opt.coverage || here("../coverage/coverage.json");
if (opt.updated !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(opt.updated || "")) {
  console.error("usage: node scripts/apr.mjs [tablea2.csv] [out.json] [--coverage coverage.json] [--updated YYYY-MM-DD] [--offline]");
  process.exit(2);
}

// ------------------------------------------------------------ CSV

// RFC 4180 records from a byte stream, hashing the bytes as they pass.
async function* parseCsv(path, hashes) {
  const decoder = new StringDecoder("utf8");
  let field = "";
  let row = [];
  let quoted = false;
  let pendingQuote = false;
  let skipLf = false;
  let first = true;
  const feed = function* (s) {
    let i = 0;
    if (first && s.length) {
      first = false;
      if (s.charCodeAt(0) === 0xfeff) i = 1;
    }
    for (; i < s.length; i += 1) {
      const ch = s[i];
      if (skipLf) {
        skipLf = false;
        if (ch === "\n") continue;
      }
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') {
          field += '"';
          continue;
        }
        quoted = false;
      }
      if (quoted) {
        if (ch === '"') pendingQuote = true;
        else field += ch;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n" || ch === "\r") {
        row.push(field);
        yield row;
        row = [];
        field = "";
        if (ch === "\r") skipLf = true;
      } else field += ch;
    }
  };
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
    for (const h of hashes) h.update(chunk);
    yield* feed(decoder.write(chunk));
  }
  yield* feed(decoder.end());
  if (pendingQuote) quoted = false;
  if (quoted) throw new Error(`${path} ends inside a quoted field`);
  if (field !== "" || row.length) {
    row.push(field);
    yield row;
  }
}

// ------------------------------------------------------------ read

const INCOMES = ["ACUTELY_LOW_INCOME", "EXTREMELY_LOW_INCOME", "VLOW_INCOME", "LOW_INCOME", "MOD_INCOME"];
const ACTIVITIES = [
  { key: "bp", prefix: "BP_", total: "NO_BUILDING_PERMITS", date: "BP_ISSUE_DT1" },
  { key: "ent", prefix: "", total: "NO_ENTITLEMENTS", date: "ENT_APPROVE_DT1" },
  { key: "co", prefix: "CO_", total: "NO_OTHER_FORMS_OF_READINESS", date: "CO_ISSUE_DT1" },
];
const NEEDED = ["JURIS_NAME", "CNTY_NAME", "YEAR", "APN", "JURS_TRACKING_ID", "UNIT_CAT",
  ...ACTIVITIES.flatMap((a) => [a.total, a.date, `${a.prefix}ABOVE_MOD_INCOME`, ...INCOMES.flatMap((n) => [`${a.prefix}${n}_DR`, `${a.prefix}${n}_NDR`])])];

const sha256 = createHash("sha256");
const md5 = createHash("md5");
const jurIndex = new Map();
const jurList = [];
const jurYears = [];
const reportYears = new Set();
const records = Object.fromEntries(ACTIVITIES.map((a) => [a.key, []]));
const tally = {
  rows: 0, bad_width: 0, bad_year: 0, unknown_cat: 0,
  ...Object.fromEntries(ACTIVITIES.flatMap((a) => [[`${a.key}_bad_units`, 0], [`${a.key}_zero_units`, 0], [`${a.key}_split_differs`, 0]])),
};
const unknownCats = new Map();
let header = null;
let col = null;

const num = (s) => (s === "" || s == null ? 0 : Number(s));

for await (const r of parseCsv(csvPath, [sha256, md5])) {
  if (!header) {
    header = r;
    col = Object.fromEntries(header.map((h, i) => [h, i]));
    const missing = NEEDED.filter((c) => !(c in col));
    if (missing.length) throw new Error(`tablea2.csv lacks ${missing.join(", ")}`);
    continue;
  }
  if (r.length === 1 && r[0] === "") continue;
  tally.rows += 1;
  if (r.length !== header.length) {
    tally.bad_width += 1;
    continue;
  }
  const year = Number(r[col.YEAR]);
  if (!/^\d{4}$/.test(r[col.YEAR])) {
    tally.bad_year += 1;
    continue;
  }
  const juris = r[col.JURIS_NAME].trim();
  const county = r[col.CNTY_NAME].trim();
  const jk = `${juris}|${county}`;
  let j = jurIndex.get(jk);
  if (j === undefined) {
    j = jurList.push([juris, county]) - 1;
    jurIndex.set(jk, j);
    jurYears.push(new Set());
  }
  jurYears[j].add(year);
  reportYears.add(year);
  const cat = r[col.UNIT_CAT].trim();
  if (!UNIT_CATS.includes(cat)) {
    tally.unknown_cat += 1;
    unknownCats.set(cat, (unknownCats.get(cat) || 0) + 1);
  }
  const id = normId(r[col.JURS_TRACKING_ID]);
  const apn = normApn(r[col.APN]);
  // The whole source row, report year included, to find a row entered twice
  // in one report.
  let sig = "";
  for (const a of ACTIVITIES) {
    const date = r[col[a.date]].trim();
    const units = num(r[col[a.total]]);
    if (!Number.isFinite(units) || units < 0) {
      tally[`${a.key}_bad_units`] += 1;
      continue;
    }
    if (!units) {
      if (date) tally[`${a.key}_zero_units`] += 1;
      continue;
    }
    let dr = 0;
    let ndr = num(r[col[`${a.prefix}ABOVE_MOD_INCOME`]]);
    for (const n of INCOMES) {
      dr += num(r[col[`${a.prefix}${n}_DR`]]);
      ndr += num(r[col[`${a.prefix}${n}_NDR`]]);
    }
    if (!Number.isFinite(dr + ndr) || dr + ndr !== units) tally[`${a.key}_split_differs`] += 1;
    if (!sig) sig = createHash("sha1").update(r.join("\u001f")).digest("base64");
    records[a.key].push({ j, year, cat, id, apn, date, units, sig, dr: Number.isFinite(dr) ? dr : 0, ndr: Number.isFinite(ndr) ? ndr : 0 });
  }
}

const years = [...reportYears].sort((a, b) => a - b);
// The first fiscal year any report reaches: the one in progress on January 1
// of the first report year.
const minDate = `${years[0] - 1}-07-01`;

// ------------------------------------------------------------ dedupe

const counts = {};
const kept = {};
for (const a of ACTIVITIES) {
  const { kept: k, stats } = dedupeActivity(records[a.key], { minDate, filed: (j, y) => jurYears[j].has(y) });
  stats.zero_units_dated = tally[`${a.key}_zero_units`];
  stats.bad_units = tally[`${a.key}_bad_units`];
  stats.split_differs = tally[`${a.key}_split_differs`];
  counts[a.key] = stats;
  kept[a.key] = k;
}

// ------------------------------------------------------------ aggregate

const CAT_INDEX = new Map(UNIT_CATS.map((c, i) => [c, i]));
const agg = new Map();
const rowFor = (j, fy) => {
  const k = `${j}|${fy}`;
  let x = agg.get(k);
  if (!x) agg.set(k, (x = { j, fy, bp: [0, 0, 0, 0], cats: UNIT_CATS.map(() => 0), ent: [0, 0], co: [0, 0] }));
  return x;
};
for (const r of kept.bp) {
  const x = rowFor(r.j, fyOf(r.date));
  x.bp[0] += r.units;
  x.bp[1] += 1;
  x.bp[2] += r.dr;
  x.bp[3] += r.ndr;
  const c = CAT_INDEX.get(r.cat);
  if (c !== undefined) x.cats[c] += r.units;
}
for (const key of ["ent", "co"]) {
  for (const r of kept[key]) {
    const x = rowFor(r.j, fyOf(r.date));
    x[key][0] += r.units;
    x[key][1] += 1;
  }
}

// ------------------------------------------------------------ names

const coverage = JSON.parse(readFileSync(coveragePath, "utf8"));
const cc = Object.fromEntries(coverage.columns.map((c, i) => [c, i]));
const MUNICIPAL_TYPES = new Set(["city", "county", "city_and_county"]);
const roster = coverage.agencies
  .map((a) => ({ name: a[cc.name], type: coverage.types[a[cc.type]], county: coverage.counties[a[cc.county]] }))
  .filter((a) => MUNICIPAL_TYPES.has(a.type));
const index = rosterIndex(roster);

// Jurisdictions sorted by name and county; rows refer to them by position.
const order = jurList.map((_, j) => j).sort((a, b) => jurList[a][0].localeCompare(jurList[b][0]) || jurList[a][1].localeCompare(jurList[b][1]));
const newIndex = new Map(order.map((j, i) => [j, i]));
const mask = (set) => years.reduce((m, y, i) => (set.has(y) ? m | (1 << i) : m), 0);
const unitsByJ = new Map();
for (const x of agg.values()) unitsByJ.set(x.j, (unitsByJ.get(x.j) || 0) + x.bp[0]);

const matches = order.map((j) => ({ j, ...matchJurisdiction(jurList[j][0], jurList[j][1], index) }));
// Two APR jurisdictions on one roster agency would double its fees; list
// them and match neither.
const byAgency = new Map();
for (const m of matches) if (m.agency) byAgency.set(m.agency, [...(byAgency.get(m.agency) || []), m]);
const shared = [];
for (const [agency, ms] of byAgency) {
  if (ms.length < 2) continue;
  shared.push({ agency, jurisdictions: ms.map((m) => `${jurList[m.j][0]} (${jurList[m.j][1]})`) });
  for (const m of ms) {
    m.candidates = [agency];
    m.agency = "";
    m.match = "shared_agency";
  }
}

// For an unmatched jurisdiction, the roster agencies in its county that no
// APR jurisdiction matched: a list for review, never a match.
const reached = new Set(matches.map((m) => m.agency).filter(Boolean));
const unreachedIn = (county) => roster.filter((a) => !reached.has(a.name) && normName(a.county) === normName(county)).map((a) => a.name);
const describe = (m) => ({
  juris_name: jurList[m.j][0], county: jurList[m.j][1], bp_units: unitsByJ.get(m.j) || 0,
  report_years: years.filter((y) => jurYears[m.j].has(y)),
  ...(m.candidates.length ? { candidates: m.candidates } : {}),
  ...(m.match === "unmatched" ? { unmatched_roster_in_county: unreachedIn(jurList[m.j][1]) } : {}),
});
const listOf = (kind) => matches.filter((m) => m.match === kind).map(describe);

const jurisdictions = matches.map((m) => [jurList[m.j][0], jurList[m.j][1], m.agency, m.match, mask(jurYears[m.j])]);
const rows = [...agg.values()]
  .map((x) => [newIndex.get(x.j), x.fy, ...x.bp, ...x.cats, ...x.ent, ...x.co])
  .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
if (ROW_COLUMNS.length !== rows[0]?.length) throw new Error("row width differs from ROW_COLUMNS");

// ------------------------------------------------------------ source

const file = statSync(csvPath);
const fileSha = sha256.digest("hex");
const fileMd5 = md5.digest("hex");
const source = {
  title: "Housing Element Annual Progress Report (APR) Data by Jurisdiction and Year",
  table: "APR Table A2",
  publisher: "California Department of Housing and Community Development",
  dataset_url: DATASET_URL,
  resource_id: RESOURCE_ID,
  resource_url: RESOURCE_URL,
  last_modified: opt.updated || null,
  last_modified_from: opt.updated ? "set by hand with --updated" : null,
  file_bytes: file.size,
  file_sha256: fileSha,
  file_md5: fileMd5,
  records: tally.rows,
};
if (!opt.offline) {
  try {
    const res = await fetch(RESOURCE_API, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = (await res.json()).result;
    if (meta.url) source.resource_url = meta.url;
    if (meta.hash === fileMd5 && Number(meta.size) === file.size) {
      if (!opt.updated) {
        source.last_modified = meta.last_modified || meta.metadata_modified || null;
        source.last_modified_from = "data.ca.gov resource_show, MD5 and size match the file";
      }
    } else {
      console.log(`portal: resource MD5 ${meta.hash} size ${meta.size} differ from the file (${fileMd5}, ${file.size}); last_modified not recorded`);
    }
  } catch (err) {
    console.log(`portal: could not read ${RESOURCE_API} (${err.message}); last_modified not recorded`);
  }
}

const data = {
  written_utc: new Date().toISOString(),
  source,
  rule: "Fiscal years July 1 to June 30, by each activity's first date. A row counts only in the earliest report year of its (jurisdiction, unit category, date, tracking ID) and (jurisdiction, unit category, date, APN) keys. Rows of one report identical in every column count once. A row dated before its own report year does not count when an earlier report lists the same tracking ID and units, on one row in each report, under a date in the same or an earlier fiscal year, whatever the unit category. A row dated January to June of the year after its report counts only when the next report lists neither its tracking ID nor its APN. Report years are years with at least one Table A2 row; a fiscal year is full when both of its calendar years are reported.",
  report_years: years,
  unit_cats: UNIT_CATS,
  jurisdiction_columns: JURISDICTION_COLUMNS,
  jurisdictions,
  columns: ROW_COLUMNS,
  rows,
  unmatched: listOf("unmatched"),
  ambiguous: listOf("ambiguous"),
  county_differs: listOf("county_differs"),
  shared_agency: shared,
  counts: { rows: tally.rows, bad_width: tally.bad_width, bad_year: tally.bad_year, unknown_cat: tally.unknown_cat, ...counts },
};

mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.tmp`;
writeFileSync(tmp, `${JSON.stringify(data)}\n`);
renameSync(tmp, out);

// ------------------------------------------------------------ log

const fmt = (n) => Number(n).toLocaleString("en-US");
const fys = [...new Set(rows.map((r) => r[1]))].sort();
const matched = matches.filter((m) => m.agency).length;
console.log(`${out}: ${fmt(statSync(out).size)} bytes, ${fmt(rows.length)} rows by jurisdiction and fiscal year`);
console.log(`source: ${fmt(tally.rows)} records, ${fmt(file.size)} bytes, sha256 ${fileSha}, last_modified ${source.last_modified || "not recorded"}`);
console.log(`report years ${years.join(", ")}; fiscal years ${fys[0]} to ${fys[fys.length - 1]} (${fys.length})`);
if (tally.bad_width || tally.bad_year || tally.unknown_cat) console.log(`skipped: ${tally.bad_width} rows of the wrong width, ${tally.bad_year} without a year; ${tally.unknown_cat} rows with an unknown UNIT_CAT ${JSON.stringify([...unknownCats])}`);
for (const a of ACTIVITIES) {
  const s = counts[a.key];
  console.log(`${a.key}: ${fmt(s.rows)} rows with units; left out ${fmt(s.undated)} undated (${fmt(s.undated_units)} units), ${fmt(s.malformed)} malformed, ${fmt(s.late)} late (${fmt(s.late_units)} units), ${fmt(s.early)} before ${minDate} (${fmt(s.early_units)} units); ${fmt(s.late_kept)} dated early in the next year kept (${fmt(s.late_kept_units)} units); dedupe ${fmt(s.dated)} dated -> ${fmt(s.kept)} kept, ${fmt(s.same_report_copies)} copies within one report (${fmt(s.same_report_copy_units)} units), ${fmt(s.dropped)} repeats dropped (${fmt(s.dropped_units)} units; ${fmt(s.apn_only_dropped)} of them on the APN alone with a new ID and other units, ${fmt(s.apn_only_dropped_units)} units), ${fmt(s.id_units_repeats)} repeats by ID and units under another date or category (${fmt(s.id_units_repeat_units)} units); ${fmt(s.kept_units)} units kept; ${fmt(s.unkeyed)} kept rows had no ID or APN; ${fmt(s.repeat_keys)} tracking ID keys in more than one report (${fmt(s.more_units_later)} with more units later, ${fmt(s.fewer_units_later)} fewer); ${fmt(s.same_report_repeats)} repeats within one report kept; ${fmt(s.kept_before_report_year)} kept rows dated before their report year (${fmt(s.kept_before_report_year_units)} units); ${fmt(s.zero_units_dated)} dated rows with zero units; ${fmt(s.split_differs)} rows whose income split differs from the total`);
}
console.log(`jurisdictions: ${matches.length}, matched ${matched}, unmatched ${data.unmatched.length}, ambiguous ${data.ambiguous.length}, county_differs ${data.county_differs.length}, shared_agency ${shared.reduce((n, s) => n + s.jurisdictions.length, 0)}`);
for (const kind of ["unmatched", "ambiguous", "county_differs"]) {
  for (const u of data[kind]) console.log(`  ${kind}: ${u.juris_name} (${u.county}) ${fmt(u.bp_units)} permitted units, reports ${u.report_years.join(",")}${u.candidates ? ` -> ${u.candidates.join("; ")}` : ""}${u.unmatched_roster_in_county ? `; roster agencies in that county with no APR match: ${u.unmatched_roster_in_county.join("; ") || "none"}` : ""}`);
}
for (const s of shared) console.log(`  shared_agency: ${s.agency} <- ${s.jurisdictions.join("; ")}`);
const unreached = roster.filter((a) => !byAgency.has(a.name));
console.log(`roster: ${roster.length} cities and counties, ${unreached.length} with no APR jurisdiction${unreached.length ? `: ${unreached.map((a) => a.name).join("; ")}` : ""}`);
