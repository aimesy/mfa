// Fund balances and flows for the Funds tab, from data/fee-account-figures.csv:
// primary rows grouped by agency, fund (fee_program as the source names it)
// and fiscal year. Amounts are exact cents; a measure the source does not
// print stays missing and is never counted as zero.

import { TRUE } from "./model.js";

// Column order. Outflows are subtracted in the balance check whatever sign
// the source printed them with (many print them in parentheses).
export const FUND_MEASURES = [
  { key: "beginning_balance", label: "Beginning balance" },
  { key: "total_fees_collected", label: "Fees collected", flow: 1 },
  { key: "interest_earned", label: "Interest", flow: 1 },
  { key: "other_revenue", label: "Other revenue", flow: 1 },
  { key: "total_revenue", label: "Total revenue", flow: 1 },
  { key: "expenditures", label: "Expenditures", flow: -1 },
  { key: "transfers_in", label: "Transfers in", flow: 1 },
  { key: "transfers_out", label: "Transfers out", flow: -1 },
  { key: "refunds", label: "Refunds", flow: -1 },
  { key: "ending_balance", label: "Ending balance" },
];
const MEASURE_KEYS = new Set(FUND_MEASURES.map((m) => m.key));
const REVENUE_PARTS = ["total_fees_collected", "interest_earned", "other_revenue"];
const OTHER_FLOWS = ["transfers_in", "expenditures", "transfers_out", "refunds"];

// "-1234.5" -> -123450. Exact for up to two decimals; null for a blank or
// unreadable value.
export function toCents(text) {
  const s = String(text ?? "").trim();
  const m = /^(-?)(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (m) {
    const cents = Number(m[2]) * 100 + Number((m[3] || "").padEnd(2, "0"));
    return m[1] ? -cents : cents;
  }
  const n = Number(s);
  return s && Number.isFinite(n) ? Math.round(n * 100) : null;
}

// The collections file names cities "City of Madera" where this file has
// "Madera city"; towns likewise.
export function collectionsEntityName(name) {
  const m = /^(.*\S) (city|town)$/.exec(String(name || ""));
  return m ? `${m[2] === "city" ? "City" : "Town"} of ${m[1]}` : null;
}

const isTotalLine = (line) => /^\s*total\b/i.test(line.label);

function lineOf(r, from) {
  const page = Number(r.physical_pdf_page) || null;
  return {
    id: r.record_id,
    group: r.figure_group_id,
    measure: r.measure,
    label: r.measure_as_printed || "",
    cents: toCents(r.value_usd),
    text: r.source_value_text || "",
    zero: r.value_is_printed_zero === TRUE,
    sourceId: r.source_id,
    title: r.publication_title || "",
    page,
    printedPage: r.printed_page || "",
    pdf: r.source_pdf || "",
    official: r.official_source_url || "",
    // The fund name as this table prints it; one report can print a fund in two tables.
    table: fundKey(r.fee_program),
    arith: r.arithmetic_check || "",
    // Whole thousands: value_usd is already in dollars, rounded to the thousand.
    thousands: /^Amounts are expressed in whole thousands\./.test(r.source_limitations || ""),
    from,
  };
}

// One table's figure for a measure: the single line, the line printed as
// the total, or the sum of the printed lines when no total is printed. A
// line that is not labeled a total but equals the sum of all the others, to
// the cent, is the total.
function tableFigure(lines) {
  if (lines.length === 1) return { kind: "printed", value: lines[0].cents, used: lines };
  const totals = lines.filter(isTotalLine);
  if (totals.length === 1) return { kind: "total", value: totals[0].cents, used: totals };
  if (totals.length > 1) {
    const same = totals.every((t) => t.cents === totals[0].cents);
    return same ? { kind: "total", value: totals[0].cents, used: [totals[0]] } : { kind: "unresolved", value: null, used: [] };
  }
  if (lines.some((l) => l.cents == null)) return { kind: "unresolved", value: null, used: [] };
  const sum = lines.reduce((a, l) => a + l.cents, 0);
  if (lines.length >= 3) {
    const whole = lines.filter((l) => l.cents * 2 === sum);
    if (whole.length === 1) return { kind: "total", value: whole[0].cents, used: whole };
  }
  return { kind: "sum", value: sum, used: lines };
}

// One source's figure: each table the source prints the fund in resolves on
// its own, and tables that agree give their figure once.
function sourceFigure(lines) {
  const byTable = new Map();
  for (const l of lines) {
    if (!byTable.has(l.table)) byTable.set(l.table, []);
    byTable.get(l.table).push(l);
  }
  const figures = [...byTable.values()].map(tableFigure);
  if (figures.length === 1) return figures[0];
  const agree = figures[0].value != null && figures.every((f) => f.value === figures[0].value);
  return agree ? figures[0] : { kind: "unresolved", value: null, used: [] };
}

// A cell resolves to one value only when every source agrees on it.
// Sources that disagree leave the cell without a value.
export function resolveCell(measure, lines, from = "accounts") {
  const bySource = new Map();
  for (const l of lines) {
    if (!bySource.has(l.sourceId)) bySource.set(l.sourceId, []);
    bySource.get(l.sourceId).push(l);
  }
  const figures = [...bySource.values()].map(sourceFigure);
  const first = figures[0];
  const cell = { measure, from, lines, sources: figures.length, kind: first.kind, value: first.value, used: first.used };
  if (figures.length > 1) {
    const agree = first.value != null && figures.every((f) => f.value === first.value);
    cell.kind = agree ? "agree" : "differs";
    if (!agree) {
      cell.value = null;
      cell.used = [];
    }
  }
  return cell;
}

const hasValue = (cell) => cell != null && cell.value != null;

// One report printing conflicting totals is not a disagreement between reports.
const blockedReason = (cells, keys) => (keys.every((k) => cells[k].kind === "unresolved") ? "unresolved" : "sources");

// beginning + revenue + transfers in - expenditures - transfers out - refunds
// = ending, over the terms in this release. A printed total revenue stands
// for its parts. Runs only when both balances and at least one flow resolve.
// A gap is "incomplete" while a term is absent from the release, and
// "rounding" when it is $1 or less and the terms come from different reports.
export function balanceCheck(cells) {
  const begin = cells.beginning_balance;
  const end = cells.ending_balance;
  const unresolved = FUND_MEASURES.filter((m) => cells[m.key] && !hasValue(cells[m.key])).map((m) => m.key);
  if (!begin || !end) {
    return { status: "none", reason: "balances", missing: ["beginning_balance", "ending_balance"].filter((k) => !cells[k]) };
  }
  const flows = hasValue(cells.total_revenue) ? ["total_revenue", ...OTHER_FLOWS] : [...REVENUE_PARTS, ...OTHER_FLOWS];
  const blocked = ["beginning_balance", "ending_balance", ...flows].filter((k) => unresolved.includes(k));
  if (blocked.length) return { status: "none", reason: blockedReason(cells, blocked), missing: blocked };
  const terms = [];
  for (const key of flows) {
    const cell = cells[key];
    if (!hasValue(cell)) continue;
    const sign = FUND_MEASURES.find((m) => m.key === key).flow;
    terms.push({ measure: key, cents: sign < 0 ? -Math.abs(cell.value) : cell.value });
  }
  if (!terms.length) return { status: "none", reason: "flows", missing: [] };
  const computed = begin.value + terms.reduce((a, t) => a + t.cents, 0);
  const diff = end.value - computed;
  const absent = flows.filter((k) => !cells[k]);
  // The reports each term can come from; none in common means the check mixes reports.
  const common = [begin, end, ...terms.map((t) => cells[t.measure])]
    .map((c) => new Set(c.lines.map((l) => l.sourceId)))
    .reduce((a, b) => new Set([...a].filter((id) => b.has(id))));
  const mixed = common.size === 0;
  let status = "differs";
  if (diff === 0) status = "closes";
  else if (mixed && Math.abs(diff) <= 100) status = "rounding";
  else if (absent.length) status = "incomplete";
  return { status, begin: begin.value, terms, computed, printed: end.value, diff, absent, mixed };
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = "";
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

// Reports print one fund's name in different case or across a line break
// ("LIBRARY", "Library"); those spellings are one fund.
const spaced = (name) => String(name ?? "").trim().replace(/\s+/g, " ");
export const fundKey = (name) => spaced(name).toLowerCase();

// Rows of one figure group print one figure, so the fund names they carry
// (Fontana's "Fire Facility" and "Fire Facility (631)") name one account.
// Joins the fund keys of each agency over shared figure groups; returns the
// joined key for an agency and fund key.
function fundJoins(rows) {
  const parent = new Map();
  const find = (n) => {
    while (parent.get(n) !== n) {
      parent.set(n, parent.get(parent.get(n)));
      n = parent.get(n);
    }
    return n;
  };
  const firstInGroup = new Map();
  for (const r of rows) {
    const node = [r.receiving_entity, fundKey(r.fee_program)].join("\u0000");
    if (!parent.has(node)) parent.set(node, node);
    if (!r.figure_group_id) continue;
    const group = [r.receiving_entity, r.figure_group_id].join("\u0000");
    const other = firstInGroup.get(group);
    if (!other) firstInGroup.set(group, node);
    else {
      const a = find(node);
      const b = find(other);
      if (a !== b) parent.set(a, b);
    }
  }
  return (agency, key) => {
    const node = [agency, key].join("\u0000");
    return parent.has(node) ? find(node).slice(agency.length + 1) : key;
  };
}

// Primary total_fees_collected rows of reported-fee-collections, keyed by
// agency, fund and fiscal year.
function collectionsIndex(rows) {
  const index = new Map();
  const names = new Set();
  for (const r of rows || []) {
    names.add(r.receiving_entity);
    if (r.is_primary_in_figure_group !== TRUE || r.measure !== "total_fees_collected") continue;
    const key = [r.receiving_entity, fundKey(r.fee_program), r.fiscal_year].join("\u0000");
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(lineOf(r, "collections"));
  }
  return { index, names };
}

export function buildFunds(feeAccountRows, collectionsRows = []) {
  const rows = feeAccountRows || [];
  const primary = rows.filter((r) => r.is_primary_in_figure_group === TRUE);
  const joined = fundJoins(rows);
  const agencyMap = new Map();
  for (const r of primary) {
    if (!MEASURE_KEYS.has(r.measure)) continue;
    let a = agencyMap.get(r.receiving_entity);
    if (!a) {
      a = { name: r.receiving_entity, fundMap: new Map(), _types: [], _counties: [] };
      agencyMap.set(a.name, a);
    }
    a._types.push(r.entity_type);
    a._counties.push(r.county);
    const key = joined(a.name, fundKey(r.fee_program));
    let f = a.fundMap.get(key);
    if (!f) {
      f = { key, keys: new Set(), spellings: new Map(), _categories: [], yearMap: new Map() };
      a.fundMap.set(key, f);
    }
    f._categories.push(r.fee_category);
    let y = f.yearMap.get(r.fiscal_year);
    if (!y) {
      y = { fy: r.fiscal_year, byMeasure: new Map() };
      f.yearMap.set(y.fy, y);
    }
    if (!y.byMeasure.has(r.measure)) y.byMeasure.set(r.measure, []);
    y.byMeasure.get(r.measure).push(lineOf(r, "accounts"));
  }
  // Every name a joined fund carries, corroborating rows included.
  for (const r of rows) {
    const f = agencyMap.get(r.receiving_entity)?.fundMap.get(joined(r.receiving_entity, fundKey(r.fee_program)));
    if (!f) continue;
    f.keys.add(fundKey(r.fee_program));
    const name = spaced(r.fee_program);
    if ((f.spellings.get(name) ?? "") < r.fiscal_year) f.spellings.set(name, r.fiscal_year);
  }

  const { index: feeIndex, names: collectionNames } = collectionsIndex(collectionsRows);
  const stats = {
    rows: rows.length,
    primary: primary.length,
    agencies: 0,
    funds: 0,
    fundYears: 0,
    years: [],
    checks: { closes: 0, rounding: 0, incomplete: 0, differs: 0, withinDollar: 0, none: 0 },
    fees: { accounts: 0, collections: 0, both: 0, bothEqual: 0 },
    cells: { printed: 0, total: 0, sum: 0, agree: 0, differs: 0, unresolved: 0 },
  };
  const years = new Set();

  const agencies = [...agencyMap.values()].map((a) => {
    const mapped = collectionsEntityName(a.name);
    const collectionsName = collectionNames.has(a.name) ? a.name : mapped && collectionNames.has(mapped) ? mapped : null;
    const funds = [...a.fundMap.values()].map((f) => {
      // The fund takes the spelling of its latest report; the others are kept.
      const names = [...f.spellings].sort((p, q) => q[1].localeCompare(p[1]) || p[0].localeCompare(q[0])).map(([n]) => n);
      const fundName = names[0];
      const fundYears = [...f.yearMap.values()].map((y) => {
        const cells = {};
        for (const [measure, lines] of y.byMeasure) cells[measure] = resolveCell(measure, lines);
        const fill = collectionsName ? [...f.keys].flatMap((k) => feeIndex.get([collectionsName, k, y.fy].join("\u0000")) || []) : [];
        if (fill.length) {
          const filled = resolveCell("total_fees_collected", fill, "collections");
          if (!cells.total_fees_collected) {
            cells.total_fees_collected = filled;
            stats.fees.collections += 1;
          } else {
            stats.fees.both += 1;
            if (filled.value != null && filled.value === cells.total_fees_collected.value) stats.fees.bothEqual += 1;
          }
        }
        if (cells.total_fees_collected?.from === "accounts") stats.fees.accounts += 1;
        for (const c of Object.values(cells)) stats.cells[c.kind] += 1;
        const check = balanceCheck(cells);
        if (check.status === "differs" && Math.abs(check.diff) <= 100) stats.checks.withinDollar += 1;
        stats.checks[check.status] += 1;
        years.add(y.fy);
        return { fy: y.fy, agency: a.name, fund: fundName, cells, check };
      }).sort((p, q) => p.fy.localeCompare(q.fy));
      stats.fundYears += fundYears.length;
      return { name: fundName, otherNames: names.slice(1), agency: a.name, category: mostCommon(f._categories), years: fundYears };
    }).sort((p, q) => p.name.localeCompare(q.name));
    const yearSet = new Set(funds.flatMap((f) => f.years.map((y) => y.fy)));
    return {
      name: a.name,
      type: mostCommon(a._types),
      county: mostCommon(a._counties),
      collectionsName,
      funds,
      years: [...yearSet].sort(),
      search: [a.name, mostCommon(a._counties), ...funds.flatMap((f) => [f.name, ...f.otherNames])].join("\n").toLowerCase(),
    };
  }).sort((p, q) => p.name.localeCompare(q.name));

  stats.agencies = agencies.length;
  stats.funds = agencies.reduce((n, a) => n + a.funds.length, 0);
  stats.years = [...years].sort();
  return { agencies, agencyByName: new Map(agencies.map((a) => [a.name, a])), stats };
}

// Total ending balances held, by fiscal year, over the fund years whose
// ending balance resolves to one printed value. Agencies without one for a
// year are left out of that year and the counts say so. A report can print
// one account in two tables under two names: funds of one agency and year
// whose beginning and ending balances match from the same report count once
// (twins), unless both balances are zero.
export function statewideEnding(funds) {
  const byYear = new Map();
  for (const a of funds.agencies) {
    for (const f of a.funds) {
      for (const y of f.years) {
        const cell = y.cells.ending_balance;
        if (!cell) continue;
        let t = byYear.get(y.fy);
        if (!t) {
          t = { fy: y.fy, cents: 0, agencies: new Set(), funds: 0, unresolved: 0, twins: 0, seen: new Set() };
          byYear.set(y.fy, t);
        }
        if (cell.value == null) {
          t.unresolved += 1;
          continue;
        }
        const begin = y.cells.beginning_balance;
        if (hasValue(begin) && (begin.value || cell.value)) {
          const sources = [...new Set(cell.lines.map((l) => l.sourceId))].sort().join(" ");
          const twin = [a.name, sources, begin.value, cell.value].join("\u0000");
          if (t.seen.has(twin)) {
            t.twins += 1;
            continue;
          }
          t.seen.add(twin);
        }
        t.cents += cell.value;
        t.agencies.add(a.name);
        t.funds += 1;
      }
    }
  }
  return [...byYear.values()]
    .map((t) => ({ fy: t.fy, cents: t.cents, agencies: t.agencies.size, funds: t.funds, unresolved: t.unresolved, twins: t.twins }))
    .sort((p, q) => p.fy.localeCompare(q.fy));
}

export function searchAgencies(funds, q) {
  const terms = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? funds.agencies.filter((a) => terms.every((t) => a.search.includes(t))) : funds.agencies;
}
