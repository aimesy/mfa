#!/usr/bin/env node
// Writes apr/population.json, the population of each APR jurisdiction for
// each fiscal year of apr/apr.json, from the California Department of
// Finance E-4 population estimates for cities, counties and the state.
//
//   node scripts/population.mjs <E-4 2011-2020.xlsx> <E-4 2021-2026.xlsx>
//                               [out.json] [--apr apr.json] [--offline]
//
// Sources (SOURCES below, titled as DOF's pages title them): the E-4 reports
// for 2011 to 2020 (2010 census benchmark) and for 2021 to 2026 (2020 census
// benchmark; the latest January is provisional), each read from its "Table 2
// City County" sheet. The output records each file's size and SHA-256, the
// title and release date its "About the Data" sheet prints, and the server's Last-Modified date when a live request for
// the file's URL answers with the same size (unless --offline).
//
// Rules (lib/population.js): a fiscal year takes the January 1 estimate
// inside it (FY 2019-20, January 1, 2020); a city takes its own row; a
// county takes its unincorporated area (DOF's "Balance of County" or
// "Unincorporated" row, or its total when it has no cities), since its APR
// covers that area; San Francisco takes its city row. DOF names are matched
// to APR jurisdictions within the county the way lib/apr.js matches the
// roster, with lib/population.js DOF_ALIASES for four spellings. A year with
// no estimate is null, never zero. The script lists every APR jurisdiction
// left without population and every DOF row no jurisdiction took.

import { readFileSync, writeFileSync, renameSync, statSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readXlsx } from "./xlsx.mjs";
import { readApr } from "../lib/apr.js";
import { readE4Table2, mergeE4, matchPopulation, fyEstimateDate } from "../lib/population.js";

const PAGE = "https://dof.ca.gov/forecasting/demographics/estimates/";
const SOURCES = [
  {
    title: "E-4 Population Estimates for Cities, Counties, and the State, 2011-2020 with 2010 and 2020 Census Benchmarks",
    page_url: `${PAGE}e-4-population-estimates-for-cities-counties-and-the-state-2011-2020-with-2010-and-2020-census-benchmark/`,
    file_url: "https://dof.ca.gov/media/docs/forecasting/Demographics/estimates/e-4-population-estimates-for-cities-counties-and-the-state-2011-2020-with-2010-and-2020-census-benchmark/E-4_2010-2020-Internet-Version.xlsx",
  },
  {
    title: "E-4 Population Estimates for Cities, Counties, and the State, 2021-2026 with 2020 Census Benchmark",
    page_url: `${PAGE}e-4-population-estimates-for-cities-counties-and-the-state-2021-2026-with-2020-census-benchmark/`,
    file_url: "https://dof.ca.gov/media/docs/forecasting/Demographics/estimates/e-4-population-estimates-for-cities-counties-and-the-state-2021-2026-with-2020-census-benchmark/E-4_2026_InternetVersion.xlsx",
  },
];
const SHEET = "Table 2 City County";
const USAGE = "usage: node scripts/population.mjs <E-4 2011-2020.xlsx> <E-4 2021-2026.xlsx> [out.json] [--apr apr.json] [--offline]";

const opt = {};
const positional = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--apr") opt.apr = process.argv[++i];
  else if (arg === "--offline") opt.offline = true;
  else positional.push(arg);
}
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const [oldPath, newPath, out = here("../apr/population.json")] = positional;
if (!oldPath || !newPath) {
  console.error(USAGE);
  process.exit(2);
}
const aprPath = opt.apr || here("../apr/apr.json");

// ------------------------------------------------------------ read

const sources = [];
const tables = [];
for (const [i, path] of [oldPath, newPath].entries()) {
  const buf = readFileSync(path);
  const book = readXlsx(buf);
  if (!book[SHEET]) throw new Error(`${path} has no sheet "${SHEET}"`);
  const cells = (book["About the Data"] || []).flat().map((c) => String(c ?? "").trim()).filter(Boolean);
  const about = cells.find((c) => /^Released:/i.test(c)) || "";
  // The report's own title: the lines between "Report E-4" and "Released:".
  const top = cells.findIndex((c) => /^Report E-4$/i.test(c));
  const fileTitle = top >= 0 ? cells.slice(top + 1, cells.indexOf(about)).join(" ").replace(/\s+/g, " ").trim() : "";
  const t = readE4Table2(book[SHEET]);
  tables.push(t);
  sources.push({
    ...SOURCES[i],
    publisher: "California Department of Finance, Demographic Research Unit",
    report: "E-4",
    file_title: fileTitle || null,
    sheet: SHEET,
    released: about.replace(/^\s*Released:\s*/i, "").trim() || null,
    last_modified: null,
    file_bytes: statSync(path).size,
    file_sha256: createHash("sha256").update(buf).digest("hex"),
    estimates: t.dates,
  });
}

if (!opt.offline) {
  for (const s of sources) {
    try {
      const res = await fetch(s.file_url, { method: "HEAD", signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const size = Number(res.headers.get("content-length"));
      const lm = res.headers.get("last-modified");
      if (size === s.file_bytes && lm) s.last_modified = new Date(lm).toISOString().slice(0, 10);
      else console.log(`live: ${s.file_url} answers ${size} bytes, the file has ${s.file_bytes}; last_modified not recorded`);
    } catch (err) {
      console.log(`live: could not read ${s.file_url} (${err.message}); last_modified not recorded`);
    }
  }
}

// ------------------------------------------------------------ match

const apr = readApr(JSON.parse(readFileSync(aprPath, "utf8")));
const fiscalYears = [...new Set(apr.rows.map((r) => r.fy))].sort();
const merged = mergeE4(tables);
const m = matchPopulation(apr.jurisdictions, merged, fiscalYears);
const estimateFor = (date) => sources.findLast((s) => s.estimates.includes(date));

const data = {
  written_utc: new Date().toISOString(),
  sources,
  rule: "Population from the California Department of Finance E-4 estimates. A fiscal year takes the January 1 estimate inside it: FY 2019-20 takes January 1, 2020. A city takes its own row. A county takes its unincorporated area (DOF's balance of county, or its total when it has no cities), the area its Annual Progress Report covers; San Francisco takes the city and county. Estimates to January 1, 2020 are benchmarked to the 2010 census and those from January 1, 2021 to the 2020 census, so a step between the two can be the change of benchmark rather than of residents. The latest January is provisional. A year with no estimate is missing, never zero.",
  fiscal_years: fiscalYears,
  estimate_dates: fiscalYears.map(fyEstimateDate),
  estimate_source: fiscalYears.map((fy) => {
    const s = estimateFor(fyEstimateDate(fy));
    return s ? sources.indexOf(s) : null;
  }),
  columns: ["juris_name", "county", "dof_name", "area", "population"],
  rows: m.rows,
  unmatched: m.unmatched,
  unused: m.unused,
  duplicates: m.duplicates,
};

mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.tmp`;
writeFileSync(tmp, `${JSON.stringify(data)}\n`);
renameSync(tmp, out);

// ------------------------------------------------------------ log

const fmt = (n) => Number(n).toLocaleString("en-US");
console.log(`${out}: ${fmt(statSync(out).size)} bytes, ${m.rows.length} of ${apr.jurisdictions.length} APR jurisdictions with population`);
for (const s of sources) console.log(`source: ${s.file_url} ${fmt(s.file_bytes)} bytes sha256 ${s.file_sha256} released ${s.released || "not printed"} last_modified ${s.last_modified || "not recorded"}; January estimates ${s.estimates[0]} to ${s.estimates[s.estimates.length - 1]}`);
console.log(`fiscal years ${fiscalYears.join(", ")}; estimates ${data.estimate_dates.join(", ")}`);
const byArea = {};
for (const r of m.rows) byArea[r[3]] = (byArea[r[3]] || 0) + 1;
console.log(`by area: ${Object.entries(byArea).map(([k, v]) => `${k} ${v}`).join(", ")}`);
const gaps = m.rows.filter((r) => r[4].some((v) => v == null));
console.log(`jurisdictions missing an estimate for some fiscal year: ${gaps.length}${gaps.length ? `: ${gaps.map((r) => `${r[0]} (${r[1]}) ${fiscalYears.filter((_, i) => r[4][i] == null).join(",")}`).join("; ")}` : ""}`);
for (const u of m.unmatched) console.log(`  unmatched APR: ${u.juris_name} (${u.county})`);
for (const u of m.unused) console.log(`  DOF row with no APR jurisdiction: ${u.name} (${u.county}, ${u.area})`);
for (const k of m.duplicates) console.log(`  duplicate DOF key, matched to nothing: ${k}`);
