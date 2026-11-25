// Payments by land use on a jurisdiction's page: data/fee-payments-by-land-use.csv,
// sums of the payment lines an agency sent in reply to a Public Records Act
// request, split by the land use those records state. Loaded the first time a
// page that could show it opens; a release without the file shows nothing.

import { el } from "./dom.js";
import { parseCsvObjects } from "./csv.js";
import { fmtSum, fmtFy, fmtInt } from "./model.js";

export const PAYMENTS_PATH = "data/fee-payments-by-land-use.csv";
const NEEDED = ["agency", "fiscal_year", "fee_program", "measure", "total_usd", "stated_residential_usd",
  "stated_nonresidential_usd", "unknown_usd", "line_count", "export_first_date", "export_last_date"];
const MEASURES = ["paid", "charged on permit", "no paid date"];
const MEASURE_TEXT = {
  paid: "Paid",
  "charged on permit": "Charged on permits (the records do not show payment)",
  "no paid date": "Listed with no payment date",
};

let data = null;
let loading = null;

export function parsePayments(text) {
  const { columns, rows } = parseCsvObjects(text);
  const missing = NEEDED.filter((c) => !columns.includes(c));
  if (missing.length) throw new Error(`fee-payments-by-land-use.csv is missing columns: ${missing.join(", ")}`);
  const byAgency = new Map();
  for (const r of rows) {
    if (!byAgency.has(r.agency)) byAgency.set(r.agency, []);
    byAgency.get(r.agency).push({
      fy: r.fiscal_year, fee: r.fee_program, measure: r.measure, lines: Number(r.line_count),
      total: Number(r.total_usd), res: Number(r.stated_residential_usd),
      non: Number(r.stated_nonresidential_usd), unknown: Number(r.unknown_usd),
      first: r.export_first_date, last: r.export_last_date,
    });
  }
  return byAgency;
}

// Rows with the same key added together, in the order of the sort given.
export function sumBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!out.has(k)) out.set(k, { key: k, lines: 0, total: 0, res: 0, non: 0, unknown: 0 });
    const o = out.get(k);
    for (const f of ["lines", "total", "res", "non", "unknown"]) o[f] += r[f];
  }
  return [...out.values()];
}

// The residential share as the records allow it: one percentage when every
// dollar has a stated land use, otherwise the range from none to all of the
// unknown dollars being residential. Blank where refunds make a part negative.
export function shareText(r) {
  if (!(r.total > 0) || r.res < 0 || r.non < 0 || r.unknown < -0.005) return "";
  const pct = (v) => `${Math.round((100 * v) / r.total)}%`;
  const lo = pct(r.res);
  const hi = pct(r.res + Math.max(0, r.unknown));
  return lo === hi ? lo : `${lo} to ${hi}`;
}

function load(ctx) {
  if (!loading) {
    loading = ctx.fetchText(PAYMENTS_PATH).then((t) => { data = parsePayments(t); }, (err) => {
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
    if (box.isConnected) box.replaceChildren(el("p", { class: "muted", text: `Failed to load payments by land use: ${err.message}` }));
  });
}

function table(label, list, name) {
  const head = [label, "Residential", "Nonresidential", "Land use unknown", "Total", "Residential share", "Payment lines"];
  const total = sumBy(list.map((r) => ({ ...r, all: "" })), "all")[0];
  const cells = (r) => [
    ...[r.res, r.non, r.unknown, r.total].map((v) => el("td", { class: "num", text: fmtSum(v) })),
    el("td", { class: "num", text: shareText(r) }),
    el("td", { class: "num", text: fmtInt(r.lines) }),
  ];
  return el("div", { class: "table-scroll" }, el("table", { class: "grid payments-list" },
    el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { class: i ? "num" : null, scope: "col", text: h })))),
    el("tbody", {}, list.map((r) => el("tr", {}, el("th", { scope: "row", text: name(r.key) }), cells(r)))),
    el("tfoot", {}, el("tr", {}, el("th", { scope: "row", text: "Sum" }), cells(total)))));
}

function sections(rows) {
  if (!rows.length) return [];
  const out = [el("h3", { class: "section-label", text: "Payments by land use" })];
  for (const m of MEASURES) {
    const list = rows.filter((r) => r.measure === m);
    if (!list.length) continue;
    const span = list.find((r) => r.first);
    out.push(el("p", { class: "note", text: `${MEASURE_TEXT[m]}${span ? `, ${span.first} to ${span.last}` : ""}` }));
    const years = sumBy(list, "fy").sort((a, b) => a.key.localeCompare(b.key));
    if (years.some((y) => y.key)) out.push(table("Fiscal year", years, (k) => (k ? fmtFy(k) : "No date")));
    const fees = sumBy(list, "fee").sort((a, b) => b.total - a.total);
    if (fees.length > 1 || !years.some((y) => y.key)) {
      out.push(el("details", { class: "payments-fees" },
        el("summary", { text: `By fee (${fees.length})` }), table("Fee", fees, (k) => k || "No fee name")));
    }
  }
  out.push(el("p", { class: "note", text: "Summed from the spreadsheets the agency sent in reply to a Public Records Act request, by the land use its own record states. Unknown belongs to neither side, so where some is unknown the residential share is a range. The first and last fiscal years may be partial, and these sums need not equal the fund revenue the agency reports." }));
  return out;
}
