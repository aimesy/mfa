// Builds the viewer's in-memory model from the release's own files, without
// deriving new figures. The unit shown everywhere is the printed figure: one
// figure_group_id, one primary row, plus any restatements of the same printed
// number at another measure grain. Sums only ever add primary rows.

import { FEE_LINKS } from "./fee-links.js";

export const TRUE = "true";

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("en-US");

export function fmtUsd(value) {
  if (value == null || !Number.isFinite(value)) return "";
  const s = Number.isInteger(value) ? usd0.format(Math.abs(value)) : usd2.format(Math.abs(value));
  return value < 0 ? `(${s})` : s;
}

export function fmtSum(value) {
  if (!Number.isFinite(value)) return "";
  const s = usd0.format(Math.abs(Math.round(value)));
  return value < 0 ? `(${s})` : s;
}

export function fmtInt(value) {
  return int.format(value);
}

export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// "2024-25" -> "2024–25" (en dash, as the README prints fiscal years)
export function fmtFy(fy) {
  return String(fy || "").replace(/^(\d{4})-(\d{2})$/, "$1–$2");
}

export function humanize(code) {
  const s = String(code || "").replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

export const ENTITY_TYPE_LABELS = {
  city: "City",
  county: "County",
  special_district: "Special district",
  school_district: "School district",
  joint_powers_authority: "Joint powers authority",
};

// Land-use scope. Several release codes say the same thing; the viewer
// groups them under one short name, and filters by that group.
const SCOPE_NAMES = {
  residential: "Residential",
  nonresidential: "Non-residential",
  mixed: "Mixed",
  not_split: "Not split",
};

export function scopeKey(code) {
  const c = String(code || "");
  if (!c || c === NONE) return c;
  if (c in SCOPE_NAMES) return c;
  if (c.startsWith("not_split")) return "not_split";
  if (c.startsWith("mixed") || c.startsWith("residential_and_nonresidential")) return "mixed";
  if (c.startsWith("nonresidential")) return "nonresidential";
  if (c.startsWith("residential")) return "residential";
  return c;
}

// Drawn in black and white from the vendored Noto Emoji subset (styles.css);
// U+FE0E asks for the text form, not the colour emoji.
const SCOPE_SYMBOLS = {
  residential: "\u{1F3E0}\uFE0E",
  nonresidential: "\u{1F3E2}\uFE0E",
  mixed: "\u{1F3D9}\uFE0E",
  not_split: "\u2754\uFE0E",
};

export function scopeSymbol(code) {
  return SCOPE_SYMBOLS[scopeKey(code)] || "";
}

export function scopeLabel(code) {
  if (!code) return "Not recorded";
  return SCOPE_NAMES[scopeKey(code)] || humanize(code);
}

// Short names for the release's reading codes. A value written as a sentence
// is the reviewer's own reading and is shown as written.
function leadingCode(v) {
  const m = /^([a-z_]+)(?:;|$)/.exec(String(v || "").trim());
  return m ? m[1] : null;
}

export function basisLabel(v) {
  const c = leadingCode(v);
  if (c == null) return String(v || "").trim();
  if (c.startsWith("not_stated")) return "Not stated";
  if (c.startsWith("modified_accrual")) return "Modified accrual";
  if (c.startsWith("modified_cash")) return "Modified cash";
  if (c.startsWith("cash")) return "Cash";
  if (c.includes("accrual")) return "Accrual";
  return humanize(c);
}

export function grossNetLabel(v) {
  const c = leadingCode(v);
  if (c == null) return String(v || "").trim();
  if (c.startsWith("not_stated")) return "Not stated";
  if (c.startsWith("gross")) return "Gross";
  if (c.startsWith("net_of_refunds")) return "Net of refunds";
  if (c.startsWith("net")) return "Net";
  return humanize(c);
}

export function roleLabel(v) {
  const c = String(v || "");
  if (c.startsWith("primary")) return "Primary";
  if (c.startsWith("secondary")) return "Restatement";
  if (c.startsWith("corroborating")) return "Corroborating";
  if (c.startsWith("stronger")) return "Candidate";
  return humanize(c);
}

export function statusLabel(v) {
  const c = String(v || "");
  const release = /_in_release_(\d+)$/.exec(c);
  if (release) return `Reviewed, release ${release[1]}`;
  if (c.includes("reviewed")) return "Reviewed";
  return humanize(c);
}

export function publicationTypeLabel(v) {
  const c = String(v || "");
  const draft = c.startsWith("draft_") ? "Draft " : "";
  let name;
  if (/annual.*five_year|five_year.*annual/.test(c)) name = "annual and five-year report";
  else if (c.includes("five_year")) name = "five-year findings";
  else if (c.includes("capacity_charge")) name = "capacity charge report";
  else if (c.includes("acfr")) name = "ACFR";
  else if (/audited|financial_statement/.test(c)) name = "financial statements";
  else if (c.includes("financial_report") && !c.includes("66006")) name = "financial report";
  else if (c.includes("budget")) name = "budget";
  else if (/annual.*(?:fee|66006)|66006|fee_program_annual/.test(c)) name = "annual fee report";
  else return humanize(c);
  const s = draft + name;
  return s[0].toUpperCase() + s.slice(1);
}

export function entityTypeLabel(code) {
  return ENTITY_TYPE_LABELS[code] || humanize(code) || "Not recorded";
}

export function fyStartYear(fy) {
  const m = /^(\d{4})-\d{2}$/.exec(String(fy || ""));
  return m ? Number(m[1]) : null;
}

// Compress fiscal years into runs: 2014-15..2016-17, 2019-20
export function fyRanges(years) {
  const sorted = [...new Set(years)].filter(Boolean).sort();
  const runs = [];
  for (const fy of sorted) {
    const y = fyStartYear(fy);
    const last = runs[runs.length - 1];
    if (last && y != null && last.endYear + 1 === y) {
      last.end = fy;
      last.endYear = y;
    } else {
      runs.push({ start: fy, end: fy, endYear: y });
    }
  }
  return runs.map((r) => (r.start === r.end ? fmtFy(r.start) : `${fmtFy(r.start)} to ${fmtFy(r.end)}`)).join(", ");
}

export function splitLimitations(text) {
  return String(text || "")
    .split(/\s+\|\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = "";
  let bestN = -1;
  for (const [v, c] of counts) {
    if (c > bestN || (c === bestN && v && !best)) {
      best = v;
      bestN = c;
    }
  }
  return best;
}

// outline_rect_pdf_points is one rectangle, [x0, y0, x1, y1], or a list of
// them where the outlined words run over more than one printed line.
const isRect = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite);
function parseRects(text) {
  try {
    const v = JSON.parse(text);
    if (isRect(v)) return [v];
    return Array.isArray(v) && v.length && v.every(isRect) ? v : null;
  } catch {
    return null;
  }
}

const SEARCH_FIELDS = [
  "receiving_entity", "county", "fiscal_year", "fee_program", "fee_category", "measure_as_printed",
  "source_value_text", "publication_title", "source_id", "internal_identifier", "record_id",
  "figure_group_id", "land_use_scope", "land_use_basis", "measure_read_from_source",
  "arithmetic_check", "source_limitations", "review_batch", "printed_page",
];

export function buildModel(feeRows, sourceRows = [], links = FEE_LINKS) {
  const groups = new Map();
  for (const r of feeRows) {
    r._value = Number(r.value_usd);
    r._primary = r.is_primary_in_figure_group === TRUE;
    r._page = Number.parseInt(r.physical_pdf_page, 10) || null;
    r._rects = parseRects(r.outline_rect_pdf_points);
    const id = r.figure_group_id || r.record_id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }

  const figures = [];
  const problems = [];
  for (const [id, rows] of groups) {
    const primaries = rows.filter((r) => r._primary);
    if (primaries.length !== 1) problems.push(`${id}: ${primaries.length} primary rows`);
    const primary = primaries[0] || rows[0];
    const fig = {
      id,
      primary,
      rows: [primary, ...rows.filter((r) => r !== primary)],
      restatements: rows.filter((r) => r !== primary),
      entity: primary.receiving_entity,
      fy: primary.fiscal_year,
      program: primary.fee_program,
      category: primary.fee_category,
      label: primary.measure_as_printed,
      value: primary._value,
      page: primary._page,
      sourceId: primary.source_id,
      arith: Boolean(primary.arithmetic_check && primary.arithmetic_check.trim()),
      zero: primary.value_is_printed_zero === TRUE,
      thousands: /^Amounts are expressed in whole thousands\./.test(primary.source_limitations || ""),
      search: "",
    };
    fig.search = rows
      .flatMap((r) => SEARCH_FIELDS.map((k) => r[k] || ""))
      .concat([entityTypeLabel(primary.entity_type), scopeLabel(primary.land_use_scope)])
      .join("\n")
      .toLowerCase();
    for (const r of rows) r._figure = fig;
    figures.push(fig);
  }

  const { fees, feeByKey, problems: feeProblems } = buildFees(figures, links);

  const entityMap = new Map();
  for (const fig of figures) {
    let e = entityMap.get(fig.entity);
    if (!e) {
      e = { name: fig.entity, figures: [], years: new Set(), programs: new Set(), fees: new Set(), sources: new Set(), sum: 0, _types: [], _counties: [] };
      entityMap.set(fig.entity, e);
    }
    e.figures.push(fig);
    e.years.add(fig.fy);
    e.programs.add(fig.program);
    e.fees.add(fig.fee);
    e.sources.add(fig.sourceId);
    if (Number.isFinite(fig.value)) e.sum += fig.value;
    e._types.push(fig.primary.entity_type);
    e._counties.push(fig.primary.county);
  }
  const entities = [...entityMap.values()].map((e) => {
    e.type = mostCommon(e._types);
    e.county = mostCommon(e._counties);
    e.yearList = [...e.years].sort();
    delete e._types;
    delete e._counties;
    return e;
  });

  const figuresBySource = new Map();
  for (const fig of figures) {
    for (const r of fig.rows) {
      if (!figuresBySource.has(r.source_id)) figuresBySource.set(r.source_id, new Set());
      figuresBySource.get(r.source_id).add(fig);
    }
  }
  const sources = sourceRows.map((s) => ({
    ...s,
    _bytes: Number(s.source_bytes) || null,
    _pages: Number(s.physical_page_count) || null,
    _figures: figuresBySource.get(s.source_id)?.size || 0,
    _search: [s.source_id, s.receiving_entity, s.publication_title, s.publication_type, s.covers_fiscal_year, s.source_pdf]
      .join("\n").toLowerCase(),
  }));
  const sourceById = new Map(sources.map((s) => [s.source_id, s]));

  const distinct = (fn) => [...new Set(figures.map(fn))].sort((a, b) => String(a).localeCompare(String(b)));

  return {
    rows: feeRows,
    figures,
    figureById: new Map(figures.map((f) => [f.id, f])),
    entities,
    entityByName: entityMap,
    fees,
    feeByKey,
    feeProblems,
    sources,
    sourceById,
    years: distinct((f) => f.fy).filter(Boolean),
    counties: distinct((f) => f.primary.county),
    types: distinct((f) => f.primary.entity_type),
    categories: distinct((f) => f.category),
    scopes: distinct((f) => scopeKey(f.primary.land_use_scope)),
    problems,
  };
}

// Whitespace-separated terms, all required; "quoted phrases" stay whole.
export function searchTerms(q) {
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(q || "").toLowerCase()))) terms.push(m[1] || m[2]);
  return terms;
}

export const EMPTY_FILTERS = Object.freeze({
  q: "", type: "", county: "", cat: "", scope: "", fyFrom: "", fyTo: "", arith: "", entity: "", source: "",
});

// Filter value that selects rows where the field is blank.
export const NONE = "__none";

export function matchesChoice(want, have) {
  return want === NONE ? !have : have === want;
}

export function filterFigures(figures, f) {
  const terms = searchTerms(f.q);
  return figures.filter((fig) => {
    const p = fig.primary;
    if (f.entity && fig.entity !== f.entity) return false;
    if (f.source && !fig.rows.some((r) => r.source_id === f.source)) return false;
    if (f.type && !matchesChoice(f.type, p.entity_type)) return false;
    if (f.county && !matchesChoice(f.county, p.county)) return false;
    if (f.cat && !matchesChoice(f.cat, fig.category)) return false;
    if (f.scope && !matchesChoice(scopeKey(f.scope), scopeKey(p.land_use_scope))) return false;
    if (f.fyFrom && fig.fy < f.fyFrom) return false;
    if (f.fyTo && fig.fy > f.fyTo) return false;
    if (f.arith === "yes" && !fig.arith) return false;
    if (f.arith === "no" && fig.arith) return false;
    for (const t of terms) if (!fig.search.includes(t)) return false;
    return true;
  });
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

const SORT_KEYS = {
  entity: (a, b) => collator.compare(a.entity, b.entity),
  fy: (a, b) => String(a.fy).localeCompare(String(b.fy)),
  program: (a, b) => collator.compare(a.program, b.program),
  category: (a, b) => collator.compare(a.category, b.category),
  label: (a, b) => collator.compare(a.label, b.label),
  value: (a, b) => (a.value || 0) - (b.value || 0),
  page: (a, b) => (a.page || 0) - (b.page || 0),
};

export const SORT_COLUMNS = Object.keys(SORT_KEYS);

export function sortFigures(list, sort) {
  const primary = SORT_KEYS[sort.col] || SORT_KEYS.fy;
  const dir = sort.dir === "asc" ? 1 : -1;
  const ties = [SORT_KEYS.entity, SORT_KEYS.fy, SORT_KEYS.program, SORT_KEYS.value];
  return [...list].sort((a, b) => {
    const d = primary(a, b) * dir;
    if (d) return d;
    for (const t of ties) {
      const x = t(a, b);
      if (x) return x;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function summarize(figures) {
  let sum = 0;
  const entities = new Set();
  const years = new Set();
  for (const f of figures) {
    if (Number.isFinite(f.value)) sum += f.value;
    entities.add(f.entity);
    years.add(f.fy);
  }
  const ys = [...years].sort();
  return { count: figures.length, sum, entities: entities.size, firstYear: ys[0] || "", lastYear: ys[ys.length - 1] || "" };
}

// Entity dossier matrix: fees (grouped by category) x fiscal years. A cell
// holds every primary figure printed for that fee in that year; an empty cell
// means the release has no figure there, never a zero.
export function entityMatrix(entity) {
  const years = [...entity.years].sort();
  const byCat = new Map();
  for (const fig of entity.figures) {
    const cat = fig.fee.category || "";
    if (!byCat.has(cat)) byCat.set(cat, new Map());
    const fees = byCat.get(cat);
    if (!fees.has(fig.fee)) fees.set(fig.fee, new Map());
    const cells = fees.get(fig.fee);
    if (!cells.has(fig.fy)) cells.set(fig.fy, []);
    cells.get(fig.fy).push(fig);
  }
  const groups = [...byCat.entries()]
    .sort((a, b) => collator.compare(a[0] || "~", b[0] || "~"))
    .map(([category, fees]) => ({
      category,
      fees: [...fees.entries()]
        .sort((a, b) => collator.compare(a[0].label, b[0].label))
        .map(([fee, cells]) => ({ fee, cells })),
    }));
  const totals = years.map((fy) => {
    const figs = entity.figures.filter((f) => f.fy === fy);
    return { fy, count: figs.length, sum: figs.reduce((s, f) => s + (Number.isFinite(f.value) ? f.value : 0), 0) };
  });
  return { years, groups, totals };
}

// ------------------------------------------------------------ fees

// A fee is one fee program's history at one jurisdiction. Most are one
// printed name; the links in fee-links.js join names an agency changed.

export const feeKey = (entity, name) => `${entity}\n${name}`;

// Fund and account numbers in a name: "(Fund 582)", "Fund 600-606", "(1061)".
const FUND_NO = /(\bFund\s+|\bAccount\s+|\()(\d[\d-]*)(?=[)\s,\]]|$)/g;
const bareNo = (n) => n.replace(/^0+(?=\d)/, "");

// Named by its latest printed name, with every fund number it has carried in
// order: "Road Development Fund (Fund 582/1582)".
export function feeLabel(names, latest = names[names.length - 1]) {
  const nums = [];
  for (const name of names) {
    for (const m of name.matchAll(FUND_NO)) if (!nums.some((n) => bareNo(n) === bareNo(m[2]))) nums.push(m[2]);
  }
  const own = [...latest.matchAll(FUND_NO)];
  if (nums.length < 2 || own.length !== 1) return latest;
  const m = own[0];
  return `${latest.slice(0, m.index)}${m[1]}${nums.join("/")}${latest.slice(m.index + m[0].length)}`;
}

export function buildFees(figures, links = FEE_LINKS) {
  const byName = new Map();
  for (const f of figures) {
    const k = feeKey(f.entity, f.program);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(f);
  }
  const parent = new Map([...byName.keys()].map((k) => [k, k]));
  const find = (k) => {
    while (parent.get(k) !== k) k = parent.get(k);
    return k;
  };
  const problems = [];
  const joins = [];
  for (const [entity, from, to, evidence, detail] of links) {
    const a = feeKey(entity, from);
    const b = feeKey(entity, to);
    if (!byName.has(a) || !byName.has(b)) {
      problems.push(`not in the release: ${entity} / ${byName.has(a) ? to : from}`);
      continue;
    }
    parent.set(find(a), find(b));
    joins.push({ entity, from, to, evidence, detail });
  }
  const groups = new Map();
  for (const k of byName.keys()) {
    const root = find(k);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(...byName.get(k));
  }
  const fees = [];
  const feeByKey = new Map();
  for (const figs of groups.values()) {
    figs.sort((a, b) => String(a.fy).localeCompare(String(b.fy)) || (a.page || 0) - (b.page || 0));
    const names = [...new Set(figs.map((f) => f.program))];
    const latest = figs[figs.length - 1];
    const entity = latest.entity;
    for (const fy of new Set(figs.map((f) => f.fy))) {
      const printed = new Set(figs.filter((f) => f.fy === fy).map((f) => f.program));
      if (printed.size > 1) problems.push(`${entity}: ${[...printed].join(" and ")} both printed for ${fy}`);
    }
    const fee = {
      id: feeKey(entity, latest.program),
      entity,
      names,
      label: feeLabel(names, latest.program),
      category: latest.category,
      figures: figs,
      years: new Set(figs.map((f) => f.fy)),
      sources: new Set(figs.map((f) => f.sourceId)),
      sum: figs.reduce((s, f) => s + (Number.isFinite(f.value) ? f.value : 0), 0),
      joins: joins.filter((j) => j.entity === entity && names.includes(j.to)),
    };
    fee.yearList = [...fee.years].sort();
    fee.search = [entity, fee.label, ...names, latest.primary.county].join("\n").toLowerCase();
    for (const f of figs) f.fee = fee;
    for (const n of names) feeByKey.set(feeKey(entity, n), fee);
    feeByKey.set(feeKey(entity, fee.label), fee);
    fees.push(fee);
  }
  return { fees, feeByKey, problems };
}

export function coverageByYear(figures) {
  const map = new Map();
  for (const f of figures) {
    if (!f.fy) continue;
    if (!map.has(f.fy)) map.set(f.fy, { fy: f.fy, figures: 0, entities: new Set(), sum: 0 });
    const y = map.get(f.fy);
    y.figures += 1;
    y.entities.add(f.entity);
    if (Number.isFinite(f.value)) y.sum += f.value;
  }
  return [...map.values()]
    .sort((a, b) => a.fy.localeCompare(b.fy))
    .map((y) => ({ fy: y.fy, figures: y.figures, entities: y.entities.size, sum: y.sum }));
}
