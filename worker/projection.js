// visibility: public
// Fallback projection for older releases. Precomputed outputs remain preferred.
import { buildModel, coverageByYear } from "../lib/model.js";

export const FIGURES_PATH = "data/reported-fee-collections.csv";
export const SOURCES_PATH = "sources/index.csv";
const FIGURE_FIELDS = ["record_id", "figure_group_id", "is_primary_in_figure_group", "receiving_entity", "entity_type", "county", "fiscal_year", "fee_program", "fee_category", "measure_as_printed", "physical_pdf_page", "printed_page", "source_id", "publication_title", "land_use_scope"];
const SOURCE_FIELDS = ["source_id", "receiving_entity", "publication_title", "publication_type", "covers_fiscal_year", "physical_page_count", "source_bytes"];
const LABEL_LIMITS = { receiving_entity: 160, entity_type: 60, county: 60, fiscal_year: 20, fee_program: 180, fee_category: 120, measure_as_printed: 100, printed_page: 20, publication_title: 200, publication_type: 60, covers_fiscal_year: 20, land_use_scope: 120 };
const AMOUNT_LABEL = /\$\s*\d|\d,\d{3}|\d+\.\d{2}\b/;
function pick(row, fields) {
  return Object.fromEntries(fields.map((key) => {
    let value = row[key] || "";
    const limit = LABEL_LIMITS[key];
    if (limit && (value.length > limit || /[\r\n]/.test(value))) value = key === "measure_as_printed" ? "Figure" : value.split(/[\r\n]/)[0].slice(0, limit - 1) + "…";
    if (key === "measure_as_printed" && AMOUNT_LABEL.test(value)) value = "Figure";
    if (["physical_pdf_page", "physical_page_count", "source_bytes"].includes(key) && !/^\d{1,12}$/.test(value)) value = "";
    if (["record_id", "figure_group_id", "source_id"].includes(key) && (value.length > 200 || /[\r\n\0]/.test(value))) throw new Error("Invalid record identifier");
    if (key === "is_primary_in_figure_group" && !["true", "false"].includes(value)) value = "";
    return [key, value];
  }));
}

export async function prepareDetailIds(data) {
  const ids = [...new Set(data.rows.map((r) => r.figure_group_id || r.record_id))];
  data.detailIds = new Map(await Promise.all(ids.map(async (id) => {
    if (/^[A-Za-z0-9._-]{1,200}$/.test(id) && !id.includes("..")) return [id, id];
    if (!id || id.length > 200) throw new Error("Invalid figure identifier");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
    return [id, "encoded-" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")];
  })));
  if (new Set(data.detailIds.values()).size !== ids.length) throw new Error("Projected identifier collision");
}

// Slice fields once rather than allocating a string at each character of
// the 12 MB CSV. Quoted commas, newlines and escaped quotes stay intact.
function parseRecords(text) {
  const table = [];
  let cells = [], start = text.charCodeAt(0) === 0xfeff ? 1 : 0, quoted = false, end = null, escaped = false;
  const pushField = (i) => {
    const value = text.slice(start, end ?? i);
    cells.push(escaped ? value.replace(/""/g, '"') : value);
    end = null; escaped = false;
  };
  for (let i = start; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (quoted) {
      if (code === 34) {
        if (text.charCodeAt(i + 1) === 34) { escaped = true; i++; }
        else { quoted = false; end = i; }
      }
    } else if (code === 34 && i === start) { quoted = true; start = i + 1; }
    else if (code === 44) { pushField(i); start = i + 1; }
    else if (code === 10 || code === 13) {
      pushField(i); table.push(cells); cells = [];
      if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (start < text.length || cells.length) { pushField(text.length); table.push(cells); }
  const columns = table.shift() || [];
  const rows = table.filter((cells) => !(cells.length === 1 && cells[0] === "")).map((cells) => {
    if (cells.length !== columns.length) throw new Error("CSV row width differs from header");
    return Object.fromEntries(columns.map((column, i) => [column, cells[i]]));
  });
  return { columns, rows };
}

export function parseRelease(feeText, sourceText) {
  const fees = parseRecords(feeText);
  const sources = parseRecords(sourceText);
  return { columns: fees.columns, rows: fees.rows, sources: sources.rows };
}

export function browseProjection(data) {
  // The aggregate model needs grouping labels and primary values only.
  // Keeping full excerpts out avoids duplicating their search strings in a
  // 128 MB Worker isolate; the original rows remain intact for detail routes.
  const modelFields = ["record_id", "figure_group_id", "is_primary_in_figure_group", "receiving_entity", "entity_type", "county", "fiscal_year", "fee_program", "fee_category", "physical_pdf_page", "source_id", "land_use_scope", "value_usd"];
  const model = buildModel(data.rows.map((r) => Object.fromEntries(modelFields.map((key) => [key, r[key] || ""]))));
  // Small groups reveal the amounts they contain. Only broad aggregates
  // are published; an individual amount always needs its record request.
  const aggregate = (count, sum) => count >= 5 ? sum : null;
  const safe = (entries, key) => {
    const counts = new Map();
    for (const entry of entries) counts.set(entry[key], (counts.get(entry[key]) || 0) + 1);
    return entries.map((entry) => ({ ...entry, sum: counts.get(entry[key]) === 1 ? entry.sum : null }));
  };
  return {
    schema: 1,
    rowCount: data.rows.length,
    rows: data.rows.map((r) => ({ ...pick(r, FIGURE_FIELDS), _detailId: data.detailIds?.get(r.figure_group_id || r.record_id) || r.figure_group_id || r.record_id, _summary: true, _summary_arith: Boolean(r.arithmetic_check?.trim()), _summary_thousands: /^Amounts are expressed in whole thousands\./.test(r.source_limitations || "") })),
    sources: data.sources.map((s) => ({ ...pick(s, SOURCE_FIELDS), _summary: true })),
    aggregates: {
      total: aggregate(model.figures.length, sumPrimary(model.figures)),
      entities: safe(model.entities.map((e) => ({ name: pick({ receiving_entity: e.name }, ["receiving_entity"]).receiving_entity, sum: aggregate(e.figures.length, sumPrimary(e.figures)) })), "name"),
      fees: safe(model.fees.map((f) => { const labels = pick({ receiving_entity: f.entity, fee_program: f.figures.at(-1).program }, ["receiving_entity", "fee_program"]); return { id: labels.receiving_entity + "\n" + labels.fee_program, sum: aggregate(f.figures.length, sumPrimary(f.figures)) }; }), "id"),
      years: safe(coverageByYear(model.figures).map((y) => ({ ...y, fy: pick({ fiscal_year: y.fy }, ["fiscal_year"]).fiscal_year, sum: aggregate(y.figures, sumPrimary(model.figures.filter((f) => f.fy === y.fy))) })), "fy"),
    },
  };
}

function sumPrimary(figures) {
  return figures.reduce((sum, f) => sum + (f.primary._primary && Number.isFinite(f.value) ? f.value : 0), 0);
}

export function figureProjection(data, id) {
  const rows = data.rows.filter((r) => (data.detailIds?.get(r.figure_group_id || r.record_id) || r.figure_group_id || r.record_id) === id);
  if (!rows.length) return null;
  const sourceIds = new Set(rows.map((r) => r.source_id));
  return { columns: data.columns, rows, sources: data.sources.filter((s) => sourceIds.has(s.source_id)) };
}

export function sourceProjection(data, id) {
  return data.sources.filter((s) => s.source_id === id).at(-1) || null;
}

export function figureHashes(rows, evidence) {
  const paths = new Set(rows.flatMap((r) => [r.outlined_figure_pdf, r.page_extract_pdf]).filter(Boolean));
  const hashes = new Map();
  for (const entry of evidence) for (const prefix of ["outlined_figure", "page_extract"]) {
    const file = entry[`${prefix}_pdf`], digest = entry[`${prefix}_sha256`];
    if (paths.has(file) && /^[0-9a-f]{64}$/.test(digest || "")) {
      if (hashes.has(file) && hashes.get(file) !== digest) throw new Error("Conflicting evidence hash");
      hashes.set(file, digest);
    }
  }
  return [...hashes].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 }));
}
