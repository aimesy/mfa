#!/usr/bin/env node
// Writes coverage/coverage.json, the Coverage tab's data, from the collection
// project's PRA screening inventory (agency-inventory.json and
// inventory-summary.json, written by its pra_inventory.py).
//
//   node scripts/coverage.mjs <inventory-dir> [out.json]
//
// For each agency on the roster and each fiscal year the inventory targets:
// harvested means an annual fee report for that year is held (the
// inventory's annual_years_held_provisional) or the release publishes
// figures for it; processed means the release publishes figures for it (its
// published_years). Agencies the inventory shows do not charge development
// fees (screening_status excluded_with_evidence) stay in the counts with
// no_fees set: the tab fills their share of each bar in yellow, since they
// have no report to harvest. Merged duplicates and entries recorded on another
// roster are left out of every count; none holds a report.
//
// Two collection lanes add to the inventory (2026-10-15):
//   --screening <MUNICIPAL-SCREENING.jsonl>, the municipal screening lane's
//     verdicts: no_fees marks a city or county as charging no development fees
//     (no_fees 1), collects_regional_only as collecting only fees that other
//     agencies impose (no_fees 2; it has no report of its own either), and
//     charges_fees clears a no-fee mark from the inventory.
//   --harvest <HARVEST-BY-AGENCY-YEAR.csv>, the crawl sorting lane's checked
//     documents: an annual 66006, school developer fee or 66013(d) report
//     counts its fiscal year as harvested.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseCsvObjects } from "../lib/csv.js";

const opt = {};
const positional = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--screening" || arg === "--harvest") opt[arg.slice(2)] = process.argv[++i];
  else positional.push(arg);
}
const [dir, out = new URL("../coverage/coverage.json", import.meta.url).pathname] = positional;
if (!dir || Object.values(opt).some((v) => !v)) {
  console.error("usage: node scripts/coverage.mjs <inventory-dir> [out.json] [--screening MUNICIPAL-SCREENING.jsonl] [--harvest HARVEST-BY-AGENCY-YEAR.csv]");
  process.exit(2);
}

const CLASSES = [
  ["municipal", "Cities and counties"],
  ["school", "School districts"],
  ["special", "Special districts"],
];
const LEFT_OUT = {
  merged_duplicate: "Merged duplicates",
  other_lane_reference: "Recorded on another roster",
};
const NO_FEES = "excluded_with_evidence";
const RELEASE_FILE = "reported-fee-collections.csv";

const summary = JSON.parse(readFileSync(join(dir, "inventory-summary.json"), "utf8"));
const inventory = JSON.parse(readFileSync(join(dir, "agency-inventory.json"), "utf8"));

const startYear = (fy) => Number(fy.slice(0, 4));
const years = [...new Set(Object.values(inventory).flatMap((a) => [
  ...a.annual_years_held_provisional, ...a.published_years, ...a.fiscal_years_missing_provisional,
]))].sort();
// Every agency lists each target year as held or missing; check that the
// years are a run of consecutive fiscal years.
years.forEach((fy, i) => {
  if (!/^\d{4}-\d{2}$/.test(fy) || (i && startYear(fy) !== startYear(years[i - 1]) + 1)) throw new Error(`unexpected fiscal year ${fy}`);
});
const bit = new Map(years.map((fy, i) => [fy, 1 << i]));
const mask = (list) => list.reduce((m, fy) => m | (bit.get(fy) || 0), 0);

const unknown = { screening: 0, harvest: 0 };
const VERDICT_NO_FEES = { no_fees: 1, collects_regional_only: 2, charges_fees: 0 };
const verdicts = new Map();
if (opt.screening) {
  for (const line of readFileSync(opt.screening, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (!Object.hasOwn(inventory, r.agency_id ?? "")) unknown.screening += 1;
    else if (r.verdict in VERDICT_NO_FEES) verdicts.set(r.agency_id, VERDICT_NO_FEES[r.verdict]);
  }
}
const HARVEST_TYPES = new Set(["annual_66006", "school_developer_fee", "connection_capacity_66013d"]);
const crawlHarvested = new Map();
if (opt.harvest) {
  for (const r of parseCsvObjects(readFileSync(opt.harvest, "utf8")).rows) {
    if (!HARVEST_TYPES.has(r.doc_type)) continue;
    if (!Object.hasOwn(inventory, r.agency_id ?? "")) {
      unknown.harvest += 1;
      continue;
    }
    const fy = r.fiscal_year.trim().replace(/^FY\s*/i, "");
    crawlHarvested.set(r.agency_id, (crawlHarvested.get(r.agency_id) || 0) | (bit.get(fy) || 0));
  }
}

const classIndex = new Map(CLASSES.map(([k], i) => [k, i]));
const types = [];
const counties = [];
const indexOf = (list, v) => {
  let i = list.indexOf(v);
  if (i < 0) i = list.push(v) - 1;
  return i;
};

// The inventory's class is the roster that holds an agency, and the
// municipal roster also holds school districts, special
// districts and joint powers authorities its lane screens. The tab sorts by
// what an agency is: only cities and counties count as cities and counties,
// school types as school districts, and every other type on the municipal
// roster as a special district. The roster counts move with them.
const MUNICIPAL_TYPES = new Set(["city", "county", "city_and_county"]);
const SCHOOL_TYPE = /school|education|charter|community_college|regional_occupational/;
const classOf = (a) => {
  const type = a.agency_type || "";
  if (MUNICIPAL_TYPES.has(type)) return "municipal";
  if (a.class !== "municipal" || !type) return a.class;
  return SCHOOL_TYPE.test(type) ? "school" : "special";
};
const moved = {};

const leftOut = {};
const agencies = [];
for (const a of Object.values(inventory)) {
  if (!classIndex.has(a.class)) throw new Error(`unknown class ${a.class} for ${a.agency_id}`);
  const cls = classOf(a);
  if (cls !== a.class) {
    moved[a.class] = (moved[a.class] || 0) - 1;
    moved[cls] = (moved[cls] || 0) + 1;
  }
  const harvested = mask([...a.annual_years_held_provisional, ...a.published_years]) | (crawlHarvested.get(a.agency_id) || 0);
  const processed = mask(a.published_years);
  const reason = LEFT_OUT[a.screening_status];
  if (reason && !harvested) {
    leftOut[cls] ??= {};
    leftOut[cls][a.screening_status] = (leftOut[cls][a.screening_status] || 0) + 1;
    continue;
  }
  // The names the release prints for this agency, so the tab can open them.
  const names = new Set();
  for (const recs of Object.values(a.published_records || {})) {
    for (const r of recs) if (r.file === RELEASE_FILE && r.row?.receiving_entity) names.add(r.row.receiving_entity.trim());
  }
  const row = [a.agency_name.trim(), classIndex.get(cls), indexOf(types, a.agency_type || ""), indexOf(counties, a.county || ""), harvested, processed,
    verdicts.get(a.agency_id) ?? (a.screening_status === NO_FEES ? 1 : 0)];
  if (names.size) row.push([...names].sort());
  agencies.push(row);
}
agencies.sort((x, y) => x[0].localeCompare(y[0]));

const roster = summary.roster_count_by_class || {};
const data = {
  written_utc: new Date().toISOString(),
  inventory_utc: summary.written_utc,
  release_commit: summary.published_commit,
  years,
  classes: CLASSES.map(([key, label]) => ({
    key, label, roster: roster[key] == null ? null : roster[key] + (moved[key] || 0),
    left_out: Object.entries(leftOut[key] || {}).map(([status, count]) => ({ label: LEFT_OUT[status], count })),
  })),
  types,
  counties,
  columns: ["name", "class", "type", "county", "harvested", "processed", "no_fees", "release_names"],
  agencies,
};
for (const c of data.classes) {
  const kept = agencies.filter((r) => CLASSES[r[1]][0] === c.key).length;
  const dropped = c.left_out.reduce((n, x) => n + x.count, 0);
  if (c.roster !== null && kept + dropped !== c.roster) throw new Error(`${c.key}: ${kept} kept + ${dropped} left out != roster ${c.roster}`);
}

const tmp = `${out}.tmp`;
writeFileSync(tmp, `${JSON.stringify(data)}\n`);
renameSync(tmp, out);
console.log(`${out}: ${agencies.length} agencies (${agencies.filter((r) => r[6]).length} charge no development fees), ${years[0]} to ${years[years.length - 1]}, inventory ${summary.written_utc}, release ${String(summary.published_commit).slice(0, 7)}`);
const movedOut = Object.values(moved).filter((n) => n < 0).reduce((n, x) => n - x, 0);
if (movedOut) console.log(`class: ${movedOut} agencies sorted by type into another class (${CLASSES.map(([k]) => `${k} ${moved[k] > 0 ? "+" : ""}${moved[k] || 0}`).join(", ")})`);
if (opt.screening) console.log(`screening: ${verdicts.size} verdicts used, ${unknown.screening} rows with an agency_id not in the inventory`);
if (opt.harvest) console.log(`harvest: ${crawlHarvested.size} agencies with crawl reports, ${unknown.harvest} rows with an agency_id not in the inventory`);
