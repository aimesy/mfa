// Population for the Permits tab: the California Department of Finance E-4
// city and county estimates as scripts/population.mjs reads them into
// apr/population.json, the match of each DOF row to an APR jurisdiction, and
// the per capita measures and population weights the tab draws from them.
// Pure functions with no DOM, so tests/apr.test.mjs covers them in node.
//
// Rules:
//   - A fiscal year (July 1 to June 30) takes the estimate for the January 1
//     inside it: FY 2019-20 takes January 1, 2020.
//   - A city takes its own row. A county's APR reports its unincorporated
//     area, where the county issues permits and charges its fees, so a
//     county takes DOF's unincorporated row ("Balance of County" or
//     "Unincorporated"), or its county total when it has no cities. San
//     Francisco, a city and county, takes its city row, which is the county.
//   - A year with no estimate is missing, never zero. A population of zero
//     or less gives no per capita figure.

import { normName, APR_ALIASES, fyLabel } from "./apr.js";

// "1/1/2020" or "4/1/2020" (a heading of the E-4 tables) as "2020-01-01".
export function headingDate(s) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(String(s ?? ""));
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
}

// The January 1 estimate that goes with a fiscal year: the one inside it.
export function fyEstimateDate(fy) {
  const m = /^(\d{4})-\d{2}$/.exec(String(fy || ""));
  return m ? `${Number(m[1]) + 1}-01-01` : "";
}

export function estimateFy(date) {
  const m = /^(\d{4})-01-01$/.exec(String(date || ""));
  return m ? fyLabel(Number(m[1]) - 1) : "";
}

const SF = "sf";
const UNINCORPORATED = /^(?:Balance of County|Unincorporated)$/i;
const TOTALS = /^(?:Incorporated|County Total|Balance of State Total|Incorporated State Total|Unincorporated State Total|Incorporated Total|State Total)$/i;

// DOF names that differ from the APR's beyond normName, by normalized DOF
// name and county, to the name the APR uses after APR_ALIASES. The county
// must still agree, and every name left unmatched is reported. A DOF name
// with a parenthetical ("El Paso de Robles (Paso Robles)") answers to the
// name in parentheses; the 2011-2020 table prints the long name alone.
export const DOF_ALIASES = new Map([
  ["AMADOR|AMADOR", "AMADOR CITY"],
  ["ANGELS CITY|CALAVERAS", "ANGELS"],
  ["EL PASO DE ROBLES|SAN LUIS OBISPO", "PASO ROBLES"],
  ["SAN BUENAVENTURA|VENTURA", "VENTURA"],
]);

// The key an APR jurisdiction answers to: "county|X", "sf", or "place|X|C"
// with X the place under its APR_ALIASES name and C its county.
export function aprPopKey(juris, county) {
  const j = normName(juris);
  const c = normName(county);
  if (["SAN FRANCISCO", "SAN FRANCISCO COUNTY", "CITY AND COUNTY OF SAN FRANCISCO"].includes(j)) return SF;
  if (j.endsWith(" COUNTY")) return `county|${j.slice(0, -" COUNTY".length)}`;
  return `place|${APR_ALIASES.get(`${j}|${c}`) || j}|${c}`;
}

export function dofPlaceKey(name, county) {
  const raw = String(name).replace(/\*/g, "").trim();
  const n = normName(/\(([^()]+)\)$/.exec(raw)?.[1] || raw);
  const c = normName(county);
  if (n === "SAN FRANCISCO" && c === "SAN FRANCISCO") return SF;
  return `place|${DOF_ALIASES.get(`${n}|${c}`) || n}|${c}`;
}

// E-4 "Table 2 City County" rows (arrays of cells) to { dates, places },
// where dates are the January 1 headings ("2020-01-01") and each place is
// { key, name, county, area, pop: { date: n } } with area "city",
// "unincorporated" or "county" (a county with no cities, whose total is its
// unincorporated area). Census benchmarks (April 1) are left out. Rows after
// the first "X County" heading and before the next are that county's.
export function readE4Table2(rows) {
  const head = rows.findIndex((r) => /^(?:COUNTY\/CITY|State\/County\/City)$/i.test(String(r[0] ?? "").trim()));
  if (head < 0) throw new Error("E-4 Table 2 heading row not found");
  const cols = [];
  rows[head].forEach((h, i) => {
    const d = headingDate(h);
    if (/-01-01$/.test(d)) cols.push([i, d]);
  });
  if (!cols.length) throw new Error("E-4 Table 2 has no January 1 columns");
  const places = [];
  let county = "";
  let block = [];
  const close = () => {
    if (!county) return;
    // A county with no city rows: its total is its unincorporated area.
    if (!block.some((p) => p.area === "unincorporated") && block.total && !block.some((p) => p.area === "city")) {
      places.push({ ...block.total, key: county === "San Francisco" ? SF : `county|${normName(county)}`, area: "county" });
    }
    for (const p of block) places.push(p);
  };
  for (const r of rows.slice(head + 1)) {
    const label = String(r[0] ?? "").trim();
    if (!label) continue;
    const pop = {};
    for (const [i, d] of cols) if (typeof r[i] === "number" && Number.isFinite(r[i])) pop[d] = r[i];
    const has = Object.keys(pop).length > 0;
    const m = /^(.+) County$/.exec(label);
    if (m && !has) {
      close();
      county = m[1];
      block = [];
      continue;
    }
    if (!county || !has) continue;
    if (/^County Total$/i.test(label)) block.total = { name: `${county} County`, county, pop };
    if (TOTALS.test(label)) continue;
    if (UNINCORPORATED.test(label)) {
      block.push({ key: `county|${normName(county)}`, name: `${county} County unincorporated`, county, area: "unincorporated", pop });
    } else {
      const name = label.replace(/\*/g, "").trim();
      block.push({ key: dofPlaceKey(name, county), name, county, area: "city", pop });
    }
  }
  close();
  return { dates: cols.map(([, d]) => d), places };
}

// Several E-4 tables (oldest first) into one place list keyed as above; a
// later table's estimate for a date replaces an earlier one's.
// The newest table's name stands. Two rows of one table on one key are
// listed in duplicates and matched to nothing.
export function mergeE4(tables) {
  const byKey = new Map();
  const dates = new Set();
  const duplicates = new Set();
  for (const t of tables) {
    for (const d of t.dates) dates.add(d);
    const seen = new Set();
    for (const p of t.places) {
      if (seen.has(p.key)) duplicates.add(p.key);
      seen.add(p.key);
      const x = byKey.get(p.key);
      if (x) Object.assign(x, { name: p.name, area: p.area, pop: { ...x.pop, ...p.pop } });
      else byKey.set(p.key, { ...p, pop: { ...p.pop } });
    }
  }
  return { dates: [...dates].sort(), places: [...byKey.values()].filter((p) => !duplicates.has(p.key)), duplicates: [...duplicates] };
}

// APR jurisdictions ({ juris, county }) to population rows for the fiscal
// years given: { rows: [[juris, county, dofName, area, [pop or null per fy]]],
// unmatched: APR jurisdictions with no DOF row, unused: DOF rows no APR
// jurisdiction took, duplicates: DOF keys on more than one row }.
export function matchPopulation(jurisdictions, merged, fys) {
  const byKey = new Map(merged.places.map((p) => [p.key, p]));
  const duplicates = merged.duplicates || [];
  const used = new Set();
  const rows = [];
  const unmatched = [];
  for (const j of jurisdictions) {
    const p = byKey.get(aprPopKey(j.juris, j.county));
    if (!p) {
      unmatched.push({ juris_name: j.juris, county: j.county });
      continue;
    }
    used.add(p.key);
    rows.push([j.juris, j.county, p.name, p.area, fys.map((fy) => {
      const v = p.pop[fyEstimateDate(fy)];
      return Number.isFinite(v) ? v : null;
    })]);
  }
  const unused = merged.places.filter((p) => !used.has(p.key)).map((p) => ({ name: p.name, county: p.county, area: p.area }));
  return { rows, unmatched, unused, duplicates };
}

// population.json to a lookup: pop(juris, county, fy) is the population or
// null, and info(juris, county) is { dofName, area } or null.
export function readPopulation(d) {
  const fyIndex = new Map((d.fiscal_years || []).map((fy, i) => [fy, i]));
  const byJ = new Map((d.rows || []).map((r) => [`${r[0]}|${r[1]}`, r]));
  return {
    ...d,
    pop(juris, county, fy) {
      const r = byJ.get(`${juris}|${county}`);
      const i = fyIndex.get(fy);
      const v = r && i !== undefined ? r[4][i] : null;
      return Number.isFinite(v) ? v : null;
    },
    info(juris, county) {
      const r = byJ.get(`${juris}|${county}`);
      return r ? { dofName: r[2], area: r[3] } : null;
    },
  };
}

// Adds population and per capita measures to joinPermits rows in place:
// pop, unitsPer1k (units per 1,000 residents) and feesPerRes (fees per
// resident). Each is null where a part is missing or the population is not
// above zero.
export function addPopulation(rows, population) {
  for (const r of rows) {
    const p = population ? population.pop(r.juris, r.aprCounty, r.fy) : null;
    r.pop = p;
    const ok = p != null && p > 0;
    r.unitsPer1k = ok && r.units != null ? (r.units / p) * 1000 : null;
    r.feesPerRes = ok && r.fees != null ? r.fees / p : null;
  }
  return rows;
}

// The weighted median: the smallest value at which the weights of values at
// or below it reach half the total weight (the lower one where a value
// splits the weight exactly in two, averaged with the next). Pairs whose
// value or weight is not finite, or whose weight is not above zero, are
// left out.
export function weightedMedian(pairs) {
  const v = pairs.filter(([x, w]) => Number.isFinite(x) && Number.isFinite(w) && w > 0).sort((a, b) => a[0] - b[0]);
  if (!v.length) return null;
  const total = v.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (let i = 0; i < v.length; i += 1) {
    acc += v[i][1];
    if (acc > total / 2) return v[i][0];
    if (acc === total / 2) return i + 1 < v.length ? (v[i][0] + v[i + 1][0]) / 2 : v[i][0];
  }
  return v[v.length - 1][0];
}

// Ratio of two sums over rows that have both parts: Σnum / Σden, the mean of
// num/den weighted by den (fees per resident over every resident counted).
export function pooled(rows, num, den) {
  let a = 0;
  let b = 0;
  let n = 0;
  for (const r of rows) {
    if (!Number.isFinite(r[num]) || !Number.isFinite(r[den]) || !(r[den] > 0)) continue;
    a += r[num];
    b += r[den];
    n += 1;
  }
  return n ? { value: a / b, rows: n, num: a, den: b } : null;
}
