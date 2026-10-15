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

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const [dir, out = new URL("../coverage/coverage.json", import.meta.url).pathname] = process.argv.slice(2);
if (!dir) {
  console.error("usage: node scripts/coverage.mjs <inventory-dir> [out.json]");
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

const classIndex = new Map(CLASSES.map(([k], i) => [k, i]));
const types = [];
const counties = [];
const indexOf = (list, v) => {
  let i = list.indexOf(v);
  if (i < 0) i = list.push(v) - 1;
  return i;
};

const leftOut = {};
const agencies = [];
for (const a of Object.values(inventory)) {
  if (!classIndex.has(a.class)) throw new Error(`unknown class ${a.class} for ${a.agency_id}`);
  const harvested = mask([...a.annual_years_held_provisional, ...a.published_years]);
  const processed = mask(a.published_years);
  const reason = LEFT_OUT[a.screening_status];
  if (reason && !harvested) {
    leftOut[a.class] ??= {};
    leftOut[a.class][a.screening_status] = (leftOut[a.class][a.screening_status] || 0) + 1;
    continue;
  }
  // The names the release prints for this agency, so the tab can open them.
  const names = new Set();
  for (const recs of Object.values(a.published_records || {})) {
    for (const r of recs) if (r.file === RELEASE_FILE && r.row?.receiving_entity) names.add(r.row.receiving_entity.trim());
  }
  const row = [a.agency_name.trim(), classIndex.get(a.class), indexOf(types, a.agency_type || ""), indexOf(counties, a.county || ""), harvested, processed,
    a.screening_status === NO_FEES ? 1 : 0];
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
    key, label, roster: roster[key] ?? null,
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
