// Schedules tab: the fee rates each agency prints for new development, from
// data/fee-schedules.csv, loaded the first time the tab opens. Until the
// release carries that file the tab says so and shows nothing else. Every
// string reaches the page through el(), so through textContent or attributes.

import { el } from "./dom.js";
import { fmtInt, entityTypeLabel } from "./model.js";
import {
  SCHEDULES_PATH, FEE_TYPES, BASES, PURPOSES, RATE_STATUSES, NO_BASIS,
  parseSchedules, buildSchedules, filterSchedules, sortSchedules, facetCounts, evidenceFor,
  conditionParts, footnoteParts, scheduleStats, feeTypeLabel, basisLabel, statusLabel, landUseLabel,
} from "./schedules.js";

export const NOT_PUBLISHED = "Fee schedules are not yet published.";
const PAGE_SIZE = 200;
const DEFAULTS = { agency: "", q: "", type: "", basis: "", purpose: "", status: "", sort: "agency", dir: "asc", page: 1 };

let data = null;
let loadPromise = null;
const selection = { ...DEFAULTS };
let searchTimer = 0;
let host = null;

// The selection keys a caller may set or read back (for the address bar).
export const SELECTION_KEYS = Object.keys(DEFAULTS);

function loadSchedules(ctx) {
  if (!loadPromise) {
    loadPromise = ctx.fetchText(SCHEDULES_PATH).then((text) => {
      const { rows, rejected } = parseSchedules(text);
      data = { built: buildSchedules(rows), rejected };
      return data;
    }, (err) => {
      // The release has not published the file yet: say so instead of failing.
      if (/HTTP 404/.test(String(err && err.message))) {
        data = { absent: true };
        return data;
      }
      throw err;
    });
    loadPromise.catch(() => { loadPromise = null; });
  }
  return loadPromise;
}

// ctx: fetchText(path), isCurrent(), rerender(), openDoc(sourceId, page),
// officialUrl(raw, page), sourceById (Map); optional agencyHref(name), and
// selection with onSelect(selection) as a pair: when the caller keeps the
// selection (in the address bar), selection holds SELECTION_KEYS on every
// render, a missing or empty key meaning its default, and onSelect hears
// each change before the rerender.
export function renderSchedules(content, ctx) {
  if (ctx.selection) {
    for (const k of SELECTION_KEYS) {
      const v = ctx.selection[k];
      selection[k] = v == null || v === "" ? DEFAULTS[k] : String(v);
    }
    selection.page = Math.max(1, Math.floor(Number(selection.page)) || 1);
    if (selection.dir !== "desc") selection.dir = "asc";
  }
  host = content;
  const view = el("div", { class: "stats-view schedules-view" });
  content.append(view);
  if (data) {
    fill(view, ctx);
    return;
  }
  view.append(el("p", { class: "muted", text: "Loading fee schedules…" }));
  loadSchedules(ctx).then(() => {
    if (!ctx.isCurrent || ctx.isCurrent()) ctx.rerender();
  }).catch((err) => {
    if (view.isConnected) view.replaceChildren(el("p", { class: "muted", text: `Failed to load fee schedules: ${err.message}` }));
  });
}

// For tests: forget the loaded file and the selection.
export function resetSchedules() {
  data = null;
  loadPromise = null;
  Object.assign(selection, DEFAULTS);
}

function change(ctx, patch, { top = false } = {}) {
  Object.assign(selection, patch);
  if (!("page" in patch)) selection.page = 1;
  ctx.onSelect?.({ ...selection });
  ctx.rerender();
  if (top) host?.scrollTo?.(0, 0);
}

// "1 row", "3 rows".
const count = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;

// Node.append would print a skipped child as "null"; drop those first.
const append = (node, ...children) => node.append(...children.flat(Infinity).filter((c) => c != null && c !== false));

function fill(view, ctx) {
  if (data.absent) {
    view.append(el("p", { class: "schedules-absent", text: NOT_PUBLISHED }));
    return;
  }
  const agency = selection.agency ? data.built.byName.get(selection.agency) : null;
  if (agency) fillAgency(view, agency, ctx);
  else fillStatewide(view, ctx);
}

function tile(label, value, sub = "") {
  return el("div", { class: "tile" },
    el("div", { class: "tile-label", text: label }),
    el("div", { class: "tile-value", text: value }),
    sub ? el("div", { class: "tile-sub", text: sub }) : null);
}

function chip(label, control) {
  return el("span", { class: "chip" }, el("label", { class: "chip-lbl", for: control.id, text: label }), control);
}

function selectBox(id, options, value, onChange) {
  const s = el("select", { id, onchange: (e) => onChange(e.target.value) });
  for (const [v, text] of options) s.append(el("option", { value: v, text }));
  s.value = value;
  return s;
}

function facetOptions(rows, key, list, emptyValue, emptyLabel) {
  const opts = [["", "All"]];
  for (const f of facetCounts(rows, key, list)) {
    if (f.value) opts.push([f.value, `${f.label} (${fmtInt(f.count)})`]);
    else if (emptyValue) opts.push([emptyValue, `${emptyLabel} (${fmtInt(f.count)})`]);
  }
  return opts;
}

function rejectedNote(rejected) {
  if (!rejected.length) return null;
  return el("details", { class: "schedules-rejected" },
    el("summary", { text: `${count(rejected.length, "row", "rows")} set aside: they fail the schedule contract` }),
    el("ul", {}, rejected.map((x) => el("li", {}, el("code", { text: x.id || "(no id)" }), ` ${x.problems.join("; ")}`))));
}

function agencyLink(name, ctx) {
  return el("a", {
    href: ctx.agencyHref ? ctx.agencyHref(name) : "#",
    text: name,
    onclick: (ev) => {
      ev.preventDefault();
      change(ctx, { agency: name }, { top: true });
    },
  });
}

function sortTh(label, col, ctx, cls = "") {
  const active = selection.sort === col;
  return el("th", {
    class: `sortable ${cls} ${active ? `sort-${selection.dir}` : ""}`,
    scope: "col",
    "aria-sort": active ? (selection.dir === "asc" ? "ascending" : "descending") : "none",
  }, el("span", { class: "col-head" },
    el("button", {
      type: "button", class: "th-btn",
      onclick: () => change(ctx, active
        ? { dir: selection.dir === "asc" ? "desc" : "asc" }
        : { sort: col, dir: col === "rate" || col === "date" ? "desc" : "asc" }),
    }, el("span", { class: "col-label", text: label }))));
}

function rateCell(r) {
  return el("td", { class: r.rate ? "num" : "num sched-unpriced", text: r.rate_as_printed, title: r.rate ? null : "No amount printed in this cell" });
}

function evidenceCell(r, ctx) {
  const ev = evidenceFor(r, (id) => Boolean(ctx.sourceById && ctx.sourceById.has(id)));
  const off = ctx.officialUrl(ev.url, ev.page);
  return el("td", { class: "col-evidence" }, el("span", { class: "ev-links" },
    ev.sourceId ? el("button", {
      class: "pdf-btn", type: "button", text: ev.page ? `p.${ev.page}` : "Open",
      title: ev.page ? `Open the document at page ${ev.page}` : "Open the document",
      onclick: () => ctx.openDoc(ev.sourceId, ev.page),
    }) : null,
    off ? el("a", {
      class: "pdf-btn ext", href: off, target: "_blank", rel: "noopener",
      title: ev.page ? `Official source, page ${ev.page}` : "Official source", "aria-label": "Official source",
      text: ev.sourceId || !ev.page ? "↗" : `p.${ev.page} ↗`,
    }) : null));
}

function landUseText(r) {
  return r.land_use_as_printed || landUseLabel(r.land_use_class);
}

// The printed text behind a row: the row itself, the unit note, footnotes and authority.
function printedCell(r) {
  const parts = [
    ["Row", r.row_as_printed],
    ["Table", r.table_as_printed],
    ["Unit note", r.unit_note_as_printed],
    ...footnoteParts(r.footnote_as_printed).map((f) => ["Footnote", f]),
    ["Date", r.date_as_printed],
    ["Adopted by", r.adopting_instrument],
    ["Local authority", r.local_authority],
    ["Statute", r.statutory_authority ? `${r.statutory_authority} (p.${r.authority_page})` : ""],
    ["Fund", r.fund],
    ["Printed page", r.printed_page],
  ].filter(([, v]) => v);
  return el("td", { class: "sched-printed" },
    el("details", {},
      el("summary", { text: "Text" }),
      el("dl", {}, parts.map(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]))));
}

// ------------------------------------------------------------ statewide

function fillStatewide(view, ctx) {
  const all = data.built.rows;
  const s = scheduleStats(all);
  const list = sortSchedules(filterSchedules(all, selection), { col: selection.sort, dir: selection.dir });
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (selection.page > pages) selection.page = pages;
  const start = (selection.page - 1) * PAGE_SIZE;
  const pageRows = list.slice(start, start + PAGE_SIZE);
  const agencies = new Set(list.map((r) => r.agency)).size;

  const search = el("input", {
    id: "sched-q", type: "search", value: selection.q, placeholder: "Agency, program, land use", autocomplete: "off", spellcheck: "false",
    oninput: (e) => {
      clearTimeout(searchTimer);
      const v = e.target.value;
      searchTimer = setTimeout(() => {
        change(ctx, { q: v });
        const box = document.getElementById("sched-q");
        if (box) {
          box.focus();
          box.setSelectionRange?.(v.length, v.length);
        }
      }, 140);
    },
  });
  const agencyOptions = [["", "All"], ...data.built.agencies.map((a) => [a.name, a.name])];

  const body = el("tbody");
  for (const r of pageRows) {
    body.append(el("tr", {},
      el("td", {}, agencyLink(r.agency, ctx)),
      el("td", { text: r.fee_program }),
      el("td", { text: landUseText(r) }),
      el("td", { text: conditionParts(r.applicability_conditions).join("; ") }),
      rateCell(r),
      el("td", { text: r.unit_as_printed }),
      el("td", { text: basisLabel(r.basis) }),
      el("td", { text: statusLabel(r.rate_status) }),
      el("td", { class: "num", text: r.effective_date }),
      printedCell(r),
      evidenceCell(r, ctx)));
  }
  if (!pageRows.length) body.append(el("tr", { class: "empty-row" }, el("td", { colspan: 11, text: "No rate matches these filters." })));

  append(view,
    el("p", {},
      "The rates each agency prints for new development, one row per printed cell, from ",
      el("code", { text: SCHEDULES_PATH }),
      ". Rates are shown as printed and never added up. A cell that prints no amount (N/A, or a footnote marker) shows what is printed and has no rate."),
    el("div", { class: "tiles" },
      tile("Agencies", fmtInt(s.agencies)),
      tile("Documents", fmtInt(s.documents)),
      tile("Printed amounts", fmtInt(s.priced)),
      tile("Cells without amount", fmtInt(s.unpriced))),
    rejectedNote(data.rejected),
    el("div", { class: "toolbar schedules-toolbar" },
      chip("Search", search),
      chip("Agency", selectBox("sched-agency", agencyOptions, "", (v) => change(ctx, { agency: v }, { top: true }))),
      chip("Fee type", selectBox("sched-type", facetOptions(all, "normalized_fee_type", FEE_TYPES), selection.type, (v) => change(ctx, { type: v }))),
      chip("Basis", selectBox("sched-basis", facetOptions(all, "basis", BASES, NO_BASIS, basisLabel("")), selection.basis, (v) => change(ctx, { basis: v }))),
      chip("Purpose", selectBox("sched-purpose", facetOptions(all, "purpose_category", PURPOSES), selection.purpose, (v) => change(ctx, { purpose: v }))),
      chip("Status", selectBox("sched-status", facetOptions(all, "rate_status", RATE_STATUSES), selection.status, (v) => change(ctx, { status: v })))),
    el("div", { class: "result-bar" },
      el("span", {}, el("strong", { text: fmtInt(list.length) }), ` ${list.length === 1 ? "row" : "rows"} · ${count(agencies, "agency", "agencies")}`)),
    el("div", { class: "table-scroll" },
      el("table", { class: "grid schedules-grid" },
        el("thead", {}, el("tr", {},
          sortTh("Agency", "agency", ctx),
          sortTh("Program", "program", ctx),
          sortTh("Land use", "land", ctx),
          el("th", { scope: "col", text: "Conditions" }),
          sortTh("Rate", "rate", ctx, "num"),
          el("th", { scope: "col", text: "Unit" }),
          sortTh("Basis", "basis", ctx),
          sortTh("Status", "status", ctx),
          sortTh("Effective", "date", ctx, "num"),
          el("th", { scope: "col", text: "Printed" }),
          el("th", { scope: "col", class: "col-evidence", text: "Evidence" }))),
        body)),
    pages > 1 ? el("div", { class: "pager" },
      el("button", { class: "btn", type: "button", text: "Prev", disabled: selection.page <= 1, onclick: () => change(ctx, { page: selection.page - 1 }, { top: true }) }),
      el("span", { class: "muted", text: `page ${selection.page} of ${pages}` }),
      el("button", { class: "btn", type: "button", text: "Next", disabled: selection.page >= pages, onclick: () => change(ctx, { page: selection.page + 1 }, { top: true }) })) : null);
}

// ------------------------------------------------------------ one agency

function fillAgency(view, a, ctx) {
  const meta = [entityTypeLabel(a.entityType), a.county ? `${a.county} County` : "", count(a.sources.size, "document", "documents"), count(a.rows.length, "row", "rows")]
    .filter(Boolean).join(" · ");
  append(view,
    el("div", { class: "schedules-head" },
      el("a", { class: "back", href: ctx.agencyHref ? ctx.agencyHref("") : "#", text: "← All agencies", onclick: (ev) => { ev.preventDefault(); change(ctx, { agency: "" }, { top: true }); } }),
      el("h2", { text: a.name }),
      el("p", { class: "muted", text: meta })),
    a.purposes.map((g) => el("section", { class: "stats-block" },
      el("h3", { class: "section-label", text: g.label }),
      g.programs.map((p) => programBlock(p, ctx)))));
}

function programBlock(p, ctx) {
  const body = el("tbody");
  for (const r of p.rows) {
    body.append(el("tr", {},
      el("td", { text: landUseText(r) }),
      el("td", { text: conditionParts(r.applicability_conditions).join("; ") }),
      rateCell(r),
      el("td", { text: r.unit_as_printed }),
      el("td", { text: basisLabel(r.basis) }),
      el("td", { text: statusLabel(r.rate_status) }),
      el("td", { text: r.fund }),
      el("td", { text: footnoteParts(r.statutory_authority).join("; ") }),
      el("td", { text: r.date_as_printed }),
      printedCell(r),
      evidenceCell(r, ctx)));
  }
  return el("div", { class: "schedules-program" },
    el("h4", {}, p.program, el("span", { class: "muted schedules-type", text: ` ${feeTypeLabel(p.feeType)}` })),
    p.table ? el("p", { class: "muted schedules-table-name", text: p.table }) : null,
    el("div", { class: "table-scroll" },
      el("table", { class: "grid schedules-grid" },
        el("thead", {}, el("tr", {},
          el("th", { scope: "col", text: "Land use" }),
          el("th", { scope: "col", text: "Conditions" }),
          el("th", { scope: "col", class: "num", text: "Rate" }),
          el("th", { scope: "col", text: "Unit" }),
          el("th", { scope: "col", text: "Basis" }),
          el("th", { scope: "col", text: "Status" }),
          el("th", { scope: "col", text: "Fund" }),
          el("th", { scope: "col", text: "Authority" }),
          el("th", { scope: "col", text: "Date" }),
          el("th", { scope: "col", text: "Printed" }),
          el("th", { scope: "col", class: "col-evidence", text: "Evidence" }))),
        body)));
}
