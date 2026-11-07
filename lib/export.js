// Downloads of the current view: a CSV of its rows and a self-contained HTML
// report. Both are built as strings. The report is a separate document the
// reader opens from disk, so every value from the release passes through
// esc() and the page carries no script and loads nothing.

import { el } from "./dom.js";

// ------------------------------------------------------------ CSV

// A spreadsheet reads a cell that starts with one of these as a formula
// (CSV injection), so such text gets a leading apostrophe. A plain number,
// signed or with thousands separators, cannot carry a formula and is left as
// is so it stays numeric.
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const GROUPED_NUMBER = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

function cellString(v) {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : "";
  if (Array.isArray(v)) return v.map(cellString).filter((s) => s !== "").join("; ");
  // A link cell ({ text, href }) exports its address, which is what a reader
  // of the spreadsheet needs.
  if (typeof v === "object") return cellString(v.href ?? v.text ?? "");
  return String(v);
}

export function csvCell(v) {
  let s = cellString(v);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s) && !GROUPED_NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function normColumns(columns) {
  return (columns || []).map((c) => (typeof c === "string" ? { key: c, label: c } : { ...c, label: c.label ?? c.key }));
}

function cellValue(col, row, i) {
  if (typeof col.value === "function") return col.value(row);
  if (Array.isArray(row)) return row[i];
  return row == null ? undefined : row[col.key];
}

// Excel opens a UTF-8 file as UTF-8 only when it starts with a BOM.
export function csvText(columns, rows, { bom = true } = {}) {
  const cols = normColumns(columns);
  const lines = [cols.map((c) => csvCell(c.label)).join(",")];
  for (const row of rows || []) lines.push(cols.map((c, i) => csvCell(cellValue(c, row, i))).join(","));
  return `${bom ? "\uFEFF" : ""}${lines.join("\r\n")}\r\n`;
}

export function downloadText(text, filename, type = "text/plain") {
  const mime = /^text\//i.test(type) && !/charset=/i.test(type) ? `${type};charset=utf-8` : type;
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el("a", { href: url, download: filename, rel: "noopener" });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

function slug(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^mfa-/, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

// The date is the reader's local date: it names the day they saved the file.
export function exportFilename(base, ext, date = new Date()) {
  const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const ymd = [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("-");
  const x = String(ext ?? "").replace(/^\.+/, "").toLowerCase().replace(/[^a-z0-9]+/g, "") || "txt";
  return `mfa-${slug(base) || "export"}-${ymd}.${x}`;
}

// ------------------------------------------------------------ HTML report

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

// Only web links leave the report; javascript:, data:, file: and anything
// unparsable render as text.
function webHref(href) {
  const s = String(href ?? "").trim();
  if (!/^https?:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

const int0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const num2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

const isBlank = (v) => v == null || (typeof v === "string" && v.trim() === "") || (typeof v === "number" && !Number.isFinite(v));

// Release values arrive as text ("43805.0", "1,234.50"). Callers check
// isBlank first because Number("") is 0; text that is not a number stays text.
function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/,/g, "").replace(/^(-?)\$/, "$1");
  return PLAIN_NUMBER.test(s) ? Number(s) : null;
}

// Negative amounts in parentheses, as lib/model.js fmtUsd and the reports print them.
function fmtUsd(n) {
  const s = Number.isInteger(n) ? usd0.format(Math.abs(n)) : usd2.format(Math.abs(n));
  return n < 0 ? `(${s})` : s;
}

// A share is a fraction from 0 to 1.
function fmtPct(n) {
  const pct = n * 100;
  if (n > 0 && pct < 0.1) return "<0.1%";
  if (n < 1 && pct > 99.9) return ">99.9%";
  return `${Number.isInteger(Math.round(pct * 10) / 10) ? Math.round(pct) : pct.toFixed(1)}%`;
}

function plainText(v) {
  if (isBlank(v)) return "";
  if (Array.isArray(v)) return v.map(plainText).filter(Boolean).join("; ");
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : "";
  if (typeof v === "object") return plainText(v.text ?? v.href ?? "");
  return String(v);
}

const NUMERIC_KINDS = new Set(["int", "usd", "pct"]);

// Returns escaped HTML for one value. Missing stays empty, never 0.
function formatCell(v, kind) {
  if (isBlank(v)) return "";
  switch (kind) {
    case "int": {
      const n = toNumber(v);
      return esc(n == null ? plainText(v) : Number.isInteger(n) ? int0.format(n) : num2.format(n));
    }
    case "usd": {
      const n = toNumber(v);
      return esc(n == null ? plainText(v) : fmtUsd(n));
    }
    case "pct": {
      if (typeof v === "string" && /%\s*$/.test(v)) return esc(v.trim());
      const n = toNumber(v);
      return esc(n == null ? plainText(v) : fmtPct(n));
    }
    case "fy":
      return esc(plainText(v).replace(/^(\d{4})-(\d{2})$/, "$1\u2013$2"));
    case "list":
      return esc(plainText(v));
    case "link": {
      if (Array.isArray(v)) return esc(plainText(v));
      const href = webHref(typeof v === "object" ? v.href : v);
      const text = plainText(typeof v === "object" ? (v.text ?? v.href) : v);
      if (!href) return esc(text);
      return `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${esc(text || href)}</a>`;
    }
    default:
      return esc(plainText(v));
  }
}

function whenText(value) {
  const d = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(d.getTime())) return { iso: "", text: plainText(value) };
  const iso = d.toISOString();
  const pacific = d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).replace(/\u202f/g, " ");
  return { iso, text: `${iso.slice(0, 16).replace("T", " ")} UTC (${pacific})` };
}

function hostOf(href) {
  try {
    return new URL(href).host;
  } catch {
    return "";
  }
}

function filterText(f) {
  if (f && typeof f === "object" && !Array.isArray(f)) return f.label != null ? `${plainText(f.label)}: ${plainText(f.value)}` : plainText(f.text);
  return plainText(f);
}

// "A", "A and B", "A, B and C"
function andList(items) {
  if (items.length < 3) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function rowsLabel(n) {
  return `${int0.format(n)} ${n === 1 ? "row" : "rows"}`;
}

// The stylesheet is a constant: no value from the report is ever written
// into it. Tabs switch with radio inputs and flex order, so it needs no rule
// per tab either.
const LIGHT = `
  --paper: #fbfaf6; --paper-2: #f2efe7; --paper-3: #e7e1d5; --plain: #fff;
  --ink: #27231f; --ink-2: #514b43; --ink-3: #6b6359; --rule: #d8d0c3; --rule-2: #ebe5dc;
  --accent: #604716; --link: #2f5160; --head: #f2efe7; --zebra: #f8f5ee; --hover: #f3ecdf;
  --warn-bg: #fbf3df; --warn-border: #dac58c; --warn-ink: #5e4510; --tile: #fff;`;
const DARK = `
  --paper: #171512; --paper-2: #100e0c; --paper-3: #26211b; --plain: #1d1a16;
  --ink: #f0eadf; --ink-2: #d6cdbd; --ink-3: #ab9f8d; --rule: #3d362d; --rule-2: #2c2721;
  --accent: #d6b46a; --link: #93c7bd; --head: #24201b; --zebra: #1a1814; --hover: #2a251e;
  --warn-bg: #2a2116; --warn-border: #806633; --warn-ink: #ecc977; --tile: #1d1a16;`;

const STYLE = `
:root { color-scheme: light dark;${LIGHT}
  --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --serif: Georgia, "Times New Roman", serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
@media (prefers-color-scheme: dark) { :root {${DARK} } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; background: var(--paper-2); color: var(--ink); font: 15px/1.5 var(--sans); }
a { color: var(--link); text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
code { font-family: var(--mono); font-size: 0.92em; }
.vh { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 24px; }
.top { background: var(--paper); border-bottom: 1px solid var(--rule); }
.top .wrap { padding-top: 28px; padding-bottom: 22px; }
.kicker { margin: 0 0 6px; color: var(--accent); font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
h1 { margin: 0; font: 600 30px/1.2 var(--serif); letter-spacing: -0.01em; overflow-wrap: break-word; }
.subtitle { margin: 8px 0 0; color: var(--ink-2); font-size: 17px; max-width: 70ch; overflow-wrap: break-word; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 28px; margin: 18px 0 0; padding: 0; font-size: 13px; color: var(--ink-2); }
.meta div { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.meta dt { color: var(--ink-3); }
.meta dd { margin: 0; overflow-wrap: anywhere; }
.open-link { display: inline-block; margin-top: 16px; padding: 7px 14px; border: 1px solid var(--rule); border-radius: 6px; background: var(--plain); font-weight: 600; font-size: 14px; text-decoration: none; }
.open-link:hover { border-color: var(--accent); text-decoration: none; }
.open-link span { color: var(--ink-3); font-weight: 400; }
main.wrap { padding-top: 22px; padding-bottom: 40px; }
.filters { margin: 0 0 16px; color: var(--ink-2); font-size: 14px; overflow-wrap: anywhere; }
.filters strong { color: var(--ink); }
.filters .f { display: inline; padding: 1px 7px; border: 1px solid var(--rule); border-radius: 999px; background: var(--plain); color: var(--ink); box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.callout { margin: 0 0 22px; padding: 12px 16px; border: 1px solid var(--warn-border); border-left-width: 4px; border-radius: 6px; background: var(--warn-bg); color: var(--warn-ink); font-size: 14px; }
.callout h2 { margin: 0 0 4px; font-size: 14px; color: var(--warn-ink); }
.callout ul { margin: 0; padding-left: 18px; }
.callout li + li { margin-top: 4px; }
.section-h { margin: 0 0 10px; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
.stats { margin: 0 0 28px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; margin: 0; }
.tile { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px 12px; border: 1px solid var(--rule); border-radius: 8px; background: var(--tile); min-width: 0; container-type: inline-size; }
.tile dd { margin: 0; }
.stats-scope { margin: -4px 0 10px; color: var(--ink-2); font-size: 14px; max-width: 90ch; overflow-wrap: anywhere; }
/* A number never wraps, so a sum with cents never reads as two numbers; it
   scales with the tile so a ten digit sum with cents fits a phone tile. */
.tile .tv { order: -1; font-size: 24px; font-size: clamp(12px, 8.5cqi, 26px); font-weight: 650; line-height: 1.15; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tile .tv.text { font-size: 19px; font-size: clamp(14px, 8.5cqi, 19px); line-height: 1.25; white-space: normal; overflow-wrap: break-word; }
.tile .tv.missing { color: var(--ink-3); }
.tile dt { color: var(--ink-2); font-size: 13px; font-weight: 600; }
.tile .tn { color: var(--ink-3); font-size: 12px; line-height: 1.35; }
.tabs { position: relative; display: flex; flex-wrap: wrap; align-items: flex-end; column-gap: 4px; }
.tab-radio { position: absolute; top: 0; left: 0; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
.tab { order: 0; position: relative; z-index: 1; margin: 4px 0 -1px; padding: 8px 14px; border: 1px solid var(--rule); border-bottom-color: var(--rule); border-radius: 7px 7px 0 0; background: var(--paper-3); color: var(--ink-2); font-size: 14px; font-weight: 600; cursor: pointer; user-select: none; overflow-wrap: anywhere; }
.tab:hover { color: var(--ink); background: var(--hover); }
.tab .tab-n { margin-left: 2px; color: var(--ink-3); font-weight: 400; font-variant-numeric: tabular-nums; }
.tab-radio:checked + .tab { background: var(--plain); color: var(--ink); border-bottom-color: var(--plain); }
.tab-radio:focus-visible + .tab { outline: 2px solid var(--accent); outline-offset: 2px; }
.panel { order: 1; display: none; flex: 0 0 100%; width: 100%; min-width: 0; padding: 16px 18px 18px; border: 1px solid var(--rule); border-radius: 0 8px 8px 8px; background: var(--plain); }
.tab-radio:checked + .tab + .panel { display: block; }
.panel-title { margin: 0 0 6px; font: 600 20px/1.25 var(--serif); }
.intro { margin: 0 0 8px; color: var(--ink-2); max-width: 90ch; overflow-wrap: anywhere; }
.rowcount { margin: 0 0 10px; color: var(--ink-3); font-size: 13px; font-variant-numeric: tabular-nums; }
.rowcount.cut { padding: 8px 12px; border: 1px solid var(--warn-border); border-left-width: 4px; border-radius: 6px; background: var(--warn-bg); color: var(--warn-ink); font-size: 14px; }
.note { margin: 10px 0 0; color: var(--ink-3); font-size: 13px; max-width: 90ch; overflow-wrap: anywhere; }
.empty { margin: 0; padding: 18px; border: 1px dashed var(--rule); border-radius: 6px; color: var(--ink-3); text-align: center; }
.tw { max-height: 78vh; overflow: auto; border: 1px solid var(--rule); border-radius: 6px; -webkit-overflow-scrolling: touch; }
.tw:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; line-height: 1.4; }
th, td { padding: 6px 10px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--rule-2); }
thead th { position: sticky; top: 0; z-index: 1; background: var(--head); color: var(--ink-2); font-size: 12px; font-weight: 700; border-bottom: 1px solid var(--rule); white-space: nowrap; }
tbody tr:nth-child(even) td { background: var(--zebra); }
tbody tr:hover td { background: var(--hover); }
tbody tr:last-child td { border-bottom: 0; }
td { min-width: 6em; max-width: 34em; overflow-wrap: break-word; }
td.link { min-width: 14em; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; min-width: 0; }
.fy { white-space: nowrap; font-variant-numeric: tabular-nums; min-width: 0; }
.nb { white-space: nowrap; }
td a { overflow-wrap: anywhere; }
footer { border-top: 1px solid var(--rule); color: var(--ink-3); font-size: 12px; }
footer .wrap { padding-top: 14px; padding-bottom: 24px; }
footer p { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 640px) {
  body { font-size: 14px; }
  .wrap { padding: 0 16px; }
  .top .wrap { padding-top: 20px; padding-bottom: 18px; }
  h1 { font-size: 24px; }
  .subtitle { font-size: 15px; }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .tile { padding: 10px 12px; }
  .tile .tv { font-size: 20px; font-size: clamp(12px, 8.5cqi, 22px); }
  .tab { padding: 6px 10px; font-size: 13px; }
  .panel { padding: 12px 10px 14px; border-radius: 0 6px 6px 6px; }
  .tw { max-height: 70vh; }
}
@media print {
  :root {${LIGHT} color-scheme: light; }
  /* Landscape, with wide tables set smaller, so no column is cut off. */
  @page { size: letter landscape; margin: 12mm 10mm; }
  body { background: #fff; font-size: 10pt; }
  .wrap { max-width: none; padding: 0; }
  .top { background: none; border-bottom: 2px solid var(--ink); }
  .top .wrap { padding: 0 0 10pt; }
  .open-link { padding: 0; border: 0; background: none; font-weight: 400; }
  .open-link::after { content: " (" attr(href) ")"; color: var(--ink-3); overflow-wrap: anywhere; }
  main.wrap { padding: 12pt 0 0; }
  .callout, .tile, .stats { break-inside: avoid; }
  .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6pt; }
  .tile { padding: 7pt 8pt; }
  .tile .tv.text { font-size: 11pt; }
  .tabs { display: block; }
  .tab, .tab-radio { display: none !important; }
  .panel, .tab-radio:checked + .tab + .panel { display: block; padding: 0; border: 0; border-radius: 0; margin-top: 16pt; }
  .panel-title { break-after: avoid; }
  .tw { max-height: none; overflow: visible; border: 0; border-radius: 0; }
  table { font-size: 8pt; }
  thead { display: table-header-group; }
  thead th { position: static; white-space: normal; border-bottom: 1.5pt solid var(--ink); }
  tr, td, th { break-inside: avoid; page-break-inside: avoid; }
  tbody tr:nth-child(even) td, tbody tr:hover td { background: none; }
  th, td { padding: 3pt 5pt; }
  td { max-width: none; min-width: 0; }
  td.link { min-width: 0; overflow-wrap: anywhere; }
  table:has(thead th:nth-child(10)) { font-size: 7pt; }
  table:has(thead th:nth-child(10)) th, table:has(thead th:nth-child(10)) td { padding: 2pt 3pt; }
  a { color: inherit; text-decoration: none; }
}
`;

function headerHtml(r, when) {
  const meta = [];
  meta.push(`<div><dt>Generated</dt><dd>${when.iso ? `<time datetime="${esc(when.iso)}">${esc(when.text)}</time>` : esc(when.text)}</dd></div>`);
  const release = plainText(r.release);
  if (release) {
    const short = /^[0-9a-f]{40}$/i.test(release) ? release.slice(0, 7) : release;
    meta.push(`<div><dt>Release</dt><dd><code title="${esc(release)}">${esc(short)}</code></dd></div>`);
  }
  const permalink = webHref(r.permalink);
  let open = "";
  if (permalink) {
    const host = hostOf(permalink) || "mfa.amyc.us";
    open = `<a class="open-link" href="${esc(permalink)}" rel="noopener noreferrer" target="_blank">Open this view on ${esc(host)} <span aria-hidden="true">\u2197</span></a>`;
  }
  const subtitle = plainText(r.subtitle);
  return `<header class="top"><div class="wrap">
<p class="kicker">California Mitigation Fee Database</p>
<h1>${esc(plainText(r.title) || "Impact fee report")}</h1>
${subtitle ? `<p class="subtitle">${esc(subtitle)}</p>\n` : ""}<dl class="meta">${meta.join("")}</dl>
${open}
</div></header>`;
}

function filtersHtml(filters) {
  const items = (filters || []).map(filterText).filter(Boolean);
  if (!items.length) return `<p class="filters"><strong>Filters:</strong> none. Every row in the release is included.</p>`;
  return `<p class="filters"><strong>Filtered to</strong> ${andList(items.map((f) => `<span class="f">${esc(f)}</span>`))}.</p>`;
}

function caveatsHtml(caveats) {
  const items = (caveats || []).map(plainText).filter(Boolean);
  if (!items.length) return "";
  return `<aside class="callout" aria-labelledby="caveats-h"><h2 id="caveats-h">Before you use these numbers</h2><ul>${items.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></aside>`;
}

// A fiscal year such as 2024-25 or 2024\u201325 would otherwise wrap at its
// dash in a narrow tile. Runs on escaped HTML, where entities hold no such token.
const keepYears = (html) => html.replace(/\b(\d{4}[-\u2013]\d{2})\b/g, '<span class="nb">$1</span>');

// scope says what the tiles count (which tab's rows, or the whole release).
function statsHtml(stats, scope) {
  const tiles = (stats || []).filter((s) => s && plainText(s.label));
  if (!tiles.length) return "";
  const said = plainText(scope);
  const body = tiles.map((s) => {
    const numeric = NUMERIC_KINDS.has(s.kind) || (!s.kind && typeof s.value === "number");
    let value = isBlank(s.value) ? "" : formatCell(s.value, s.kind || (numeric ? "int" : "text"));
    const missing = value === "";
    if (missing) value = "\u2013";
    const cls = missing ? " missing" : numeric ? " num" : " text";
    const note = plainText(s.note);
    return `<div class="tile"><dt>${keepYears(esc(plainText(s.label)))}</dt><dd class="tv${cls}">${keepYears(value)}</dd>${note ? `<dd class="tn">${keepYears(esc(note))}</dd>` : ""}</div>`;
  }).join("\n");
  return `<section class="stats" aria-labelledby="stats-h"><h2 class="section-h" id="stats-h">Key statistics</h2>
${said ? `<p class="stats-scope">${esc(said)}</p>\n` : ""}<dl class="tiles">
${body}
</dl></section>`;
}

function tableHtml(tab, i) {
  const cols = normColumns(tab.columns);
  const rows = tab.rows || [];
  if (!rows.length) return `<p class="empty">${esc(plainText(tab.empty) || "No rows match these filters.")}</p>`;
  const cls = (kind) => (NUMERIC_KINDS.has(kind) ? ' class="num"' : kind === "fy" || kind === "link" ? ` class="${kind}"` : "");
  const head = cols.map((c) => `<th scope="col"${cls(c.kind)}>${esc(plainText(c.label))}</th>`).join("");
  const body = rows.map((row) => `<tr>${cols.map((c, j) => `<td${cls(c.kind)}>${formatCell(cellValue(c, row, j), c.kind)}</td>`).join("")}</tr>`);
  return `<div class="tw" tabindex="0" role="region" aria-labelledby="ph-${i}"><table>
<thead><tr>${head}</tr></thead>
<tbody>
${body.join("\n")}
</tbody></table></div>`;
}

function tabsHtml(tabs) {
  const list = tabs || [];
  if (!list.length) return "";
  const parts = list.map((tab, i) => {
    const label = plainText(tab.label) || plainText(tab.key) || `Table ${i + 1}`;
    const n = (tab.rows || []).length;
    const total = Number.isFinite(tab.total) && tab.total > n ? tab.total : null;
    // A cut table says so in its badge and in a notice above it.
    const count = total == null ? rowsLabel(n)
      : `This table shows the first ${int0.format(n)} of ${rowsLabel(total)}, in the tab's order. ${plainText(tab.cut_note) || "The CSV of this tab holds every row."}`;
    const badge = total == null ? int0.format(n) : `${int0.format(n)} of ${int0.format(total)}`;
    const shown = total ?? n;
    const intro = plainText(tab.intro);
    const note = plainText(tab.note);
    return `<input class="tab-radio" type="radio" name="report-tab" id="tab-${i}"${i === 0 ? " checked" : ""}>
<label class="tab" for="tab-${i}">${esc(label)} <span class="tab-n">${esc(badge)}<span class="vh"> ${shown === 1 ? "row" : "rows"}</span></span></label>
<section class="panel" aria-labelledby="ph-${i}">
<h2 class="panel-title" id="ph-${i}">${esc(label)}</h2>
${intro ? `<p class="intro">${esc(intro)}</p>\n` : ""}<p class="rowcount${total == null ? "" : " cut"}">${esc(count)}</p>
${tableHtml(tab, i)}
${note ? `<p class="note">${esc(note)}</p>\n` : ""}</section>`;
  });
  return `<h2 class="vh">Tables</h2>
<div class="tabs">
${parts.join("\n")}
</div>`;
}

// report: { title, subtitle, generated_utc, release, permalink, filters: [text],
// caveats: [text], stats: [{ label, value, note, kind? }], stats_scope: text,
// tabs: [{ key, label, intro, note, columns: [{ key, label, kind, value? }],
// rows, total?, cut_note?, empty? }] }. total is the row count before rows
// was cut; empty replaces "No rows match these filters." for an empty table.
// Kinds: text, int, usd, fy ("2024-25"), pct (a fraction from 0 to 1), link
// ({ text, href }, only http and https become links) and list (an array).
// A blank value renders as an empty cell, never as 0.
export function reportHtml(report = {}) {
  const r = report || {};
  const title = plainText(r.title) || "Impact fee report";
  const release = plainText(r.release);
  const when = whenText(r.generated_utc);
  const host = hostOf(webHref(r.permalink)) || "mfa.amyc.us";
  const footer = [`California Mitigation Fee Database (${host})`];
  if (release) footer.push(`release ${release}`);
  if (when.iso) footer.push(`generated ${when.iso.slice(0, 16).replace("T", " ")} UTC`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${headerHtml(r, when)}
<main class="wrap">
${filtersHtml(r.filters)}
${caveatsHtml(r.caveats)}
${statsHtml(r.stats, r.stats_scope)}
${tabsHtml(r.tabs)}
</main>
<footer><div class="wrap"><p>${esc(footer.join(" \u00b7 "))}. This file is a snapshot of the view when it was saved.</p></div></footer>
</body>
</html>
`;
}
