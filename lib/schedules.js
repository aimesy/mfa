// Fee schedules: the rates agencies print for new development, read from
// data/fee-schedules.csv. One row is one printed rate cell: the agency, the
// fee program, the land use and conditions it applies to, the basis it is
// charged on, and the document page that prints it. Rates are never added up
// or carried across rows; a cell the schedule leaves without an amount ("N/A",
// a footnote marker) keeps an empty rate and shows what is printed. No DOM.

import { parseCsvObjects } from "./csv.js";

export const SCHEDULES_PATH = "data/fee-schedules.csv";

export const SCHEDULE_COLUMNS = [
  "schedule_row_id", "agency", "agency_as_printed", "entity_type", "county", "fee_program",
  "normalized_fee_type", "purpose_category", "basis", "unit_as_printed", "unit_note_as_printed",
  "rate", "rate_as_printed", "land_use_class", "land_use_as_printed", "applicability_conditions",
  "footnote_as_printed", "rate_status", "effective_date", "end_date", "date_as_printed",
  "adopting_instrument", "local_authority", "fund", "statutory_authority", "authority_page",
  "table_as_printed", "source_id", "source_sha256", "official_source_url", "physical_pdf_page",
  "printed_page", "row_as_printed", "review_status",
];

export const FEE_TYPES = [
  ["development_impact_fee", "Development impact fee"],
  ["capacity_charge", "Capacity charge"],
  ["school_facilities_fee", "School facilities fee"],
  ["parkland_in_lieu_fee", "Parkland in-lieu fee"],
  ["mitigation_in_lieu_fee", "Mitigation in-lieu fee"],
  ["housing_in_lieu_fee", "Housing in-lieu fee"],
  ["other", "Other"],
];

export const PURPOSES = [
  ["parks", "Parks"],
  ["transportation", "Transportation"],
  ["schools", "Schools"],
  ["water", "Water"],
  ["wastewater", "Wastewater"],
  ["drainage", "Drainage"],
  ["fire", "Fire"],
  ["police", "Police"],
  ["libraries", "Libraries"],
  ["general_public_facilities", "General public facilities"],
  ["affordable_housing", "Affordable housing"],
  ["habitat", "Habitat"],
  ["other", "Other"],
];

export const BASES = [
  ["per_dwelling_unit", "Per dwelling unit"],
  ["per_square_foot", "Per square foot"],
  ["per_bedroom", "Per bedroom"],
  ["per_trip", "Per trip"],
  ["per_edu", "Per equivalent unit (EDU, ERU)"],
  ["per_meter_size", "By meter size"],
  ["per_acre", "Per acre"],
  ["percent_of_valuation", "Percent of valuation"],
  ["flat", "Flat amount"],
  ["per_other_unit", "Per other printed unit"],
];

export const RATE_STATUSES = [
  ["adopted", "Adopted"],
  ["reported", "Reported"],
  ["proposed", "Proposed"],
  ["maximum_justified", "Maximum justified"],
];

export const LAND_USES = [
  ["residential_single_family", "Single family"],
  ["residential_multifamily", "Multifamily"],
  ["residential_adu", "ADU"],
  ["residential_addition_or_remodel", "Addition or remodel"],
  ["residential_unspecified", "Residential"],
  ["commercial", "Commercial"],
  ["industrial", "Industrial"],
  ["mixed_use_unallocated", "Mixed use"],
  ["other_nonresidential", "Other nonresidential"],
  ["unknown", "Unknown"],
];

export const REVIEW_STATUSES = [
  ["unreviewed", "Unreviewed"],
  ["verified", "Verified"],
];

// The value a filter uses for rows whose basis the schedule does not print.
export const NO_BASIS = "__none";

// Where each purpose sits in the viewer's fee taxonomy (lib/taxonomy.js), as
// a Figures category filter value: a namespace, or namespace/subcategory.
export const PURPOSE_CATEGORY = {
  parks: "parks", transportation: "transport", schools: "schools", water: "water/supply",
  wastewater: "water/wastewater", drainage: "water/stormwater", fire: "safety/fire", police: "safety/police",
  libraries: "civic/libraries", general_public_facilities: "civic", affordable_housing: "housing",
  habitat: "environment/habitat", other: "other",
};

const maps = (list) => new Map(list);
const FEE_TYPE = maps(FEE_TYPES);
const PURPOSE = maps(PURPOSES);
const BASIS = maps(BASES);
const STATUS = maps(RATE_STATUSES);
const LAND_USE = maps(LAND_USES);
const REVIEW = maps(REVIEW_STATUSES);
const PURPOSE_ORDER = new Map(PURPOSES.map(([k], i) => [k, i]));

export const feeTypeLabel = (k) => FEE_TYPE.get(k) || k || "";
export const purposeLabel = (k) => PURPOSE.get(k) || k || "";
export const basisLabel = (k) => (k ? BASIS.get(k) || k : "Basis not printed");
export const statusLabel = (k) => STATUS.get(k) || k || "";
export const landUseLabel = (k) => LAND_USE.get(k) || k || "";

const DECIMAL = /^\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const POSITIVE_INT = /^[1-9]\d*$/;
const squash = (s) => String(s || "").replace(/\s+/g, "");

// Problems with one row, as short sentences; an empty list means the row
// meets the schedule contract the viewer relies on.
export function rowProblems(r) {
  const out = [];
  const need = (k) => { if (!String(r[k] ?? "").trim()) out.push(`${k} is empty`); };
  for (const k of ["schedule_row_id", "agency", "entity_type", "fee_program", "normalized_fee_type", "purpose_category",
    "rate_as_printed", "rate_status", "source_sha256", "physical_pdf_page", "row_as_printed", "review_status"]) need(k);
  // Required codes are checked for emptiness above; basis and land_use_class may be empty.
  const inList = (k, m) => {
    const v = r[k] || "";
    if (v && !m.has(v)) out.push(`${k} ${JSON.stringify(v)} is not a known code`);
  };
  inList("normalized_fee_type", FEE_TYPE);
  inList("purpose_category", PURPOSE);
  inList("basis", BASIS);
  inList("land_use_class", LAND_USE);
  inList("rate_status", STATUS);
  inList("review_status", REVIEW);
  if (r.entity_type && !/^[a-z_]+$/.test(r.entity_type)) out.push("entity_type is not a code");
  if (r.rate) {
    if (!DECIMAL.test(r.rate)) out.push("rate is not a decimal amount");
    else if (r.rate_as_printed.replace(/[$,\s]/g, "") !== r.rate) out.push("rate does not match rate_as_printed");
  }
  if (r.rate_as_printed && r.row_as_printed && !squash(r.row_as_printed).includes(squash(r.rate_as_printed))) {
    out.push("rate_as_printed is not inside row_as_printed");
  }
  for (const k of ["effective_date", "end_date"]) if (r[k] && !ISO_DATE.test(r[k])) out.push(`${k} is not a date`);
  if (r.effective_date && !r.date_as_printed) out.push("effective_date has no date_as_printed");
  if (r.physical_pdf_page && !POSITIVE_INT.test(r.physical_pdf_page)) out.push("physical_pdf_page is not a page number");
  if (r.authority_page && !POSITIVE_INT.test(r.authority_page)) out.push("authority_page is not a page number");
  if (r.statutory_authority && !r.authority_page) out.push("statutory_authority has no authority_page");
  if (r.source_sha256 && !/^[0-9a-f]{64}$/.test(r.source_sha256)) out.push("source_sha256 is not a SHA-256 hash");
  if (r.official_source_url && !/^https?:\/\//i.test(r.official_source_url)) out.push("official_source_url is not a web address");
  if (r.source_id && !/^[A-Za-z0-9._-]+$/.test(r.source_id)) out.push("source_id is not an identifier");
  return out;
}

// Parse the file. Rows that fail the contract are held out of every view and
// listed in rejected, so the page can say how many it set aside and why.
export function parseSchedules(text) {
  const { columns, rows } = parseCsvObjects(text);
  const missing = SCHEDULE_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length) throw new Error(`fee-schedules.csv is missing columns: ${missing.join(", ")}`);
  const seen = new Set();
  const good = [];
  const rejected = [];
  for (const r of rows) {
    const problems = rowProblems(r);
    if (r.schedule_row_id && seen.has(r.schedule_row_id)) problems.push("schedule_row_id repeats an earlier row");
    seen.add(r.schedule_row_id);
    if (problems.length) rejected.push({ id: r.schedule_row_id || "", problems });
    else good.push(r);
  }
  return { rows: good, rejected };
}

// The printed amount as a number, or null when the cell prints none. A
// missing amount is never read as zero.
export function rateValue(r) {
  return r.rate && DECIMAL.test(r.rate) ? Number(r.rate) : null;
}

// Agencies, each with its rows grouped by purpose (in PURPOSES order) and,
// within a purpose, by fee program in the order the file lists them.
export function buildSchedules(rows) {
  const byName = new Map();
  for (const r of rows) {
    let a = byName.get(r.agency);
    if (!a) {
      a = { name: r.agency, entityType: r.entity_type, county: r.county || "", rows: [], sources: new Set() };
      byName.set(r.agency, a);
    }
    a.rows.push(r);
    a.sources.add(r.source_sha256);
  }
  const agencies = [...byName.values()].sort((x, y) => x.name.localeCompare(y.name));
  for (const a of agencies) a.purposes = groupByPurpose(a.rows);
  return { rows, agencies, byName };
}

export function groupByPurpose(rows) {
  const groups = new Map();
  for (const r of rows) {
    let g = groups.get(r.purpose_category);
    if (!g) {
      g = { purpose: r.purpose_category, label: purposeLabel(r.purpose_category), programs: new Map() };
      groups.set(r.purpose_category, g);
    }
    const key = `${r.fee_program}\u0000${r.source_sha256}\u0000${r.table_as_printed}`;
    let p = g.programs.get(key);
    if (!p) {
      p = { program: r.fee_program, feeType: r.normalized_fee_type, table: r.table_as_printed || "", rows: [] };
      g.programs.set(key, p);
    }
    p.rows.push(r);
  }
  return [...groups.values()]
    .sort((x, y) => (PURPOSE_ORDER.get(x.purpose) ?? 99) - (PURPOSE_ORDER.get(y.purpose) ?? 99))
    .map((g) => ({ ...g, programs: [...g.programs.values()] }));
}

// Statewide filters. Each is a code or "" for all; basis also takes NO_BASIS.
export function filterSchedules(rows, f = {}) {
  const terms = String(f.q || "").toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (f.type && r.normalized_fee_type !== f.type) return false;
    if (f.purpose && r.purpose_category !== f.purpose) return false;
    if (f.status && r.rate_status !== f.status) return false;
    if (f.basis) {
      if (f.basis === NO_BASIS ? r.basis : r.basis !== f.basis) return false;
    }
    if (terms.length) {
      const hay = [r.agency, r.county, r.fee_program, r.land_use_as_printed, r.applicability_conditions,
        r.unit_as_printed, landUseLabel(r.land_use_class)].join("\n").toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
}

// How many rows carry each value of key, in the order of the code list.
export function facetCounts(rows, key, list) {
  const counts = new Map();
  for (const r of rows) counts.set(r[key] || "", (counts.get(r[key] || "") || 0) + 1);
  const out = list.filter(([k]) => counts.get(k)).map(([k, label]) => ({ value: k, label, count: counts.get(k) }));
  if (counts.get("")) out.push({ value: "", label: "", count: counts.get("") });
  return out;
}

export const SORTS = {
  agency: (r) => r.agency.toLowerCase(),
  program: (r) => r.fee_program.toLowerCase(),
  land: (r) => (r.land_use_as_printed || landUseLabel(r.land_use_class) || "").toLowerCase(),
  rate: rateValue,
  basis: (r) => basisLabel(r.basis).toLowerCase(),
  status: (r) => statusLabel(r.rate_status).toLowerCase(),
  date: (r) => r.effective_date || "",
};

// Sort a copy. Rows with no printed amount sort after every amount in both
// directions; ties keep file order.
export function sortSchedules(rows, sort = { col: "agency", dir: "asc" }) {
  const key = SORTS[sort.col] || SORTS.agency;
  const sign = sort.dir === "desc" ? -1 : 1;
  return rows
    .map((r, i) => ({ r, i, k: key(r) }))
    .sort((a, b) => {
      const an = a.k == null || a.k === "";
      const bn = b.k == null || b.k === "";
      if (an !== bn) return an ? 1 : -1;
      if (!an && a.k !== b.k) return (a.k < b.k ? -1 : 1) * sign;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

// Where the evidence links go: the release's own copy of the document when
// the release holds it, and the agency's published file, both at that page.
export function evidenceFor(r, hasSource) {
  const page = Number(r.physical_pdf_page) || null;
  const sourceId = r.source_id && hasSource(r.source_id) ? r.source_id : "";
  return { sourceId, page, url: r.official_source_url || "" };
}

// Split a "; " or " | " joined field back into its printed parts.
export const conditionParts = (s) => String(s || "").split("; ").filter(Boolean);
export const footnoteParts = (s) => String(s || "").split(" | ").filter(Boolean);

export function scheduleStats(rows) {
  const agencies = new Set(rows.map((r) => r.agency));
  const documents = new Set(rows.map((r) => r.source_sha256));
  const priced = rows.filter((r) => rateValue(r) != null).length;
  return { rows: rows.length, agencies: agencies.size, documents: documents.size, priced, unpriced: rows.length - priced };
}
