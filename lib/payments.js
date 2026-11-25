// Fees charged per permit on a jurisdiction's page: data/fees-charged-per-permit.csv, the fees
// each permit was charged in the spreadsheets an agency sent in reply to a Public Records Act
// request, added up per permit, then the median and spread by year and type of development.
// Loaded the first time a page that could show it opens; a release without the file shows nothing.

import { el } from "./dom.js";
import { parseCsvObjects } from "./csv.js";
import { fmtSum, fmtFy, fmtInt } from "./model.js";

export const PERMITS_PATH = "data/fees-charged-per-permit.csv";
const NEEDED = ["agency", "fiscal_year", "development_type", "measure", "permits", "median_usd", "p25_usd", "p75_usd",
  "min_usd", "max_usd", "fees_counted"];
const ORDER = ["Single family", "New home (production)", "Accessory dwelling unit", "Multifamily or attached",
  "Residential, type not printed", "Nonresidential", "Nonresidential, type not printed", "Mixed types", "Type not printed"];

let data = null;
let loading = null;

export function parsePermits(text) {
  const { columns, rows } = parseCsvObjects(text);
  const missing = NEEDED.filter((c) => !columns.includes(c));
  if (missing.length) throw new Error(`fees-charged-per-permit.csv is missing columns: ${missing.join(", ")}`);
  const byAgency = new Map();
  for (const r of rows) {
    if (!byAgency.has(r.agency)) byAgency.set(r.agency, []);
    byAgency.get(r.agency).push({
      fy: r.fiscal_year, type: r.development_type, measure: r.measure, permits: Number(r.permits),
      median: Number(r.median_usd), p25: Number(r.p25_usd), p75: Number(r.p75_usd),
      min: Number(r.min_usd), max: Number(r.max_usd), covers: r.fees_counted,
    });
  }
  return byAgency;
}

// Types in a fixed order (single family first), then years oldest first, undated last.
export function orderRows(rows) {
  const rank = (t) => (ORDER.includes(t) ? ORDER.indexOf(t) : ORDER.length);
  return [...rows].sort((a, b) => rank(a.type) - rank(b.type) || a.type.localeCompare(b.type)
    || (a.fy ? (b.fy ? a.fy.localeCompare(b.fy) : -1) : (b.fy ? 1 : 0)) || a.measure.localeCompare(b.measure));
}

const span = (a, b) => (Math.round(a) === Math.round(b) ? fmtSum(a) : `${fmtSum(a)} to ${fmtSum(b)}`);

function load(ctx) {
  if (!loading) {
    loading = ctx.fetchText(PERMITS_PATH).then((t) => { data = parsePermits(t); }, (err) => {
      if (!/HTTP 404/.test(String(err && err.message))) throw err;
      data = new Map();
    });
    loading.catch(() => { loading = null; });
  }
  return loading;
}

// Fills box on a jurisdiction's page; nothing for an agency the file leaves out.
export function renderEntityPayments(box, entity, ctx) {
  const draw = () => box.replaceChildren(...sections(data.get(entity.name) || []));
  if (data) {
    draw();
    return;
  }
  load(ctx).then(() => {
    if (box.isConnected) draw();
  }).catch((err) => {
    if (box.isConnected) box.replaceChildren(el("p", { class: "muted", text: `Failed to load fees charged per permit: ${err.message}` }));
  });
}

function sections(rows) {
  if (!rows.length) return [];
  const list = orderRows(rows);
  const charged = list.some((r) => r.measure === "charged");
  const head = ["Fiscal year", "Permits", "Median per permit", "Middle half", "Lowest to highest"];
  const body = [];
  let type = null;
  for (const r of list) {
    if (r.type !== type) {
      type = r.type;
      body.push(el("tr", { class: "mx-group" }, el("th", { colspan: head.length, scope: "rowgroup", text: type })));
    }
    body.push(el("tr", {},
      el("th", { scope: "row", text: `${r.fy ? fmtFy(r.fy) : "No date"}${charged && r.measure === "paid" ? " (paid)" : ""}` }),
      el("td", { class: "num", text: fmtInt(r.permits) }),
      el("td", { class: "num", text: fmtSum(r.median) }),
      el("td", { class: "num", text: span(r.p25, r.p75) }),
      el("td", { class: "num", text: span(r.min, r.max) })));
  }
  return [
    el("h3", { class: "section-label", text: "Fees charged per permit" }),
    el("p", { class: "note", text: `Fees counted: ${list[0].covers}.` }),
    el("div", { class: "table-scroll" }, el("table", { class: "grid payments-list" },
      el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { class: i ? "num" : null, scope: "col", text: h })))),
      el("tbody", {}, body))),
    el("p", { class: "note", text: "Every fee line of a permit added up, from the spreadsheets the agency sent in reply to a Public Records Act request, by the type of development its record prints. A multifamily or nonresidential permit can cover many units or a large building, so its total is per permit, not per unit. The year is that of the permit's first fee; the first and last years may be partial." }),
  ];
}
