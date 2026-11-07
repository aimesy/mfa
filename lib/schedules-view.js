// Schedules tab: the fee rates each agency prints for new development, from
// data/fee-schedules.csv, loaded the first time the tab opens. Until the
// release carries that file the tab says so and shows nothing else. Every
// string reaches the page through el(), so through textContent or attributes.
// The statewide table filters through checkbox boxes (agencies, county, fee
// type, basis, purpose, status) and the shared district boxes; one agency's
// schedule opens from its name. URL parameters (app.js): sc plus each
// SELECTION_KEYS key; the SELECTION_PARTS keys take values joined by "|".

import { el } from "./dom.js";
import { fmtInt, entityTypeLabel, NONE, splitChoice } from "./model.js";
import {
  SCHEDULES_PATH, SCHEDULE_COLUMNS, FEE_TYPES, BASES, PURPOSES, RATE_STATUSES, FILTER_FIELDS,
  parseSchedules, buildSchedules, filterSchedules, sortSchedules, evidenceFor,
  conditionParts, footnoteParts, scheduleStats, feeTypeLabel, purposeLabel, basisLabel, statusLabel, landUseLabel,
} from "./schedules.js";

export const NOT_PUBLISHED = "Fee schedules are not yet published.";
const PAGE_SIZE = 200;
// agency opens one agency's schedule; agencies filters the statewide table.
const DEFAULTS = {
  agency: "", agencies: "", q: "", county: "", type: "", basis: "", purpose: "", status: "", sort: "agency", dir: "asc", page: 1,
};

let data = null;
let loadPromise = null;
const selection = { ...DEFAULTS };
let searchTimer = 0;
let host = null;

// The selection keys a caller may set or read back (for the address bar).
export const SELECTION_KEYS = Object.keys(DEFAULTS);

// The keys that take several values joined by "|", with the test each part
// of a link must pass; an old link's single value is a list of one.
const inCodes = (list) => {
  const set = new Set(list.map(([k]) => k));
  return (v) => set.has(v);
};
export const SELECTION_PARTS = {
  agencies: (v) => v.length <= 300,
  county: (v) => v === NONE || v.length <= 100,
  type: inCodes(FEE_TYPES),
  basis: (v) => v === NONE || inCodes(BASES)(v),
  purpose: inCodes(PURPOSES),
  status: inCodes(RATE_STATUSES),
};

// On a phone the boxes fold behind Filters; the tab redraws on each change,
// so whether they are open is kept here.
let filtersOpen = false;

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
// each change before the rerender. app.js's libCtx() adds the filter boxes,
// the district filter, siteLink and siteHref; app.js calls exportSchedules.
export function renderSchedules(content, ctx) {
  seedSelection(ctx);
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

function seedSelection(ctx) {
  if (!ctx.selection) return;
  for (const k of SELECTION_KEYS) {
    const v = ctx.selection[k];
    selection[k] = v == null || v === "" ? DEFAULTS[k] : String(v);
  }
  selection.page = Math.max(1, Math.floor(Number(selection.page)) || 1);
  if (selection.dir !== "desc") selection.dir = "asc";
}

// For tests: forget the loaded file and the selection.
export function resetSchedules() {
  data = null;
  loadPromise = null;
  filtersOpen = false;
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

// ------------------------------------------------------------ filters

// The name districts.json knows an agency by.
const agencyOf = (r) => [r.agency, { type: r.entity_type, county: r.county }];

function districtFilterOn(ctx) {
  const f = ctx.districtFilter?.() || {};
  return Boolean(f.ad || f.sd);
}

// Rows the statewide table lists: the tab's filters, less skip, then the
// district filter.
function listed(ctx, opts) {
  const rows = filterSchedules(data.built.rows, selection, opts);
  return districtFilterOn(ctx) && ctx.rowPassesDistricts ? rows.filter((r) => ctx.rowPassesDistricts(...agencyOf(r))) : rows;
}

const BOXES = {
  agencies: {
    key: "scagencies", label: "Agency", many: true, text: (v) => v,
    placeholder: "Type an agency name…", hint: "Type an agency name, then tick.",
  },
  county: { key: "sccounty", label: "County", text: (v) => (v === NONE ? "(no county)" : v) },
  type: { key: "sctype", label: "Fee type", text: feeTypeLabel },
  basis: { key: "scbasis", label: "Basis", text: (v) => basisLabel(v === NONE ? "" : v) },
  purpose: { key: "scpurpose", label: "Purpose", text: purposeLabel },
  status: { key: "scstatus", label: "Status", text: statusLabel },
};

function ready(ctx) {
  return Promise.all([loadSchedules(ctx), districtFilterOn(ctx) && ctx.ensureDistricts ? ctx.ensureDistricts() : null]);
}

// A box counts rows the table would list under the other filters.
function boxSpec(ctx, k) {
  const b = BOXES[k];
  const field = FILTER_FIELDS[k];
  return {
    key: b.key,
    label: b.label,
    many: b.many,
    placeholder: b.placeholder,
    hint: b.hint,
    text: b.text,
    get: () => selection[k],
    apply: (raw) => change(ctx, { [k]: raw }),
    options: () => ready(ctx).then(() => (data.absent ? [] : ctx.facetOptions(listed(ctx, { skip: k }), (r) => r[field], b.text))),
  };
}

// The shared Assembly and Senate boxes, counting the rows the tab's own
// filters leave. app.js applies them; the table starts again on page 1.
function districtBoxSpecs(ctx) {
  if (!ctx.districtSpecs) return [];
  return ctx.districtSpecs(() => (data && !data.absent ? filterSchedules(data.built.rows, selection) : []), agencyOf).map((spec) => {
    const s = Object.create(spec);
    s.options = () => loadSchedules(ctx).then(() => spec.options());
    s.apply = (raw) => {
      selection.page = 1;
      ctx.onSelect?.({ ...selection });
      spec.apply(raw);
    };
    return s;
  });
}

function filterTags(ctx) {
  if (!ctx.filterTag) return [];
  const tags = [];
  if (selection.q) tags.push(ctx.filterTag(`“${selection.q}”`, () => change(ctx, { q: "" })));
  for (const k of Object.keys(BOXES)) {
    if (!selection[k]) continue;
    const spec = boxSpec(ctx, k);
    tags.push(ctx.filterTag(`${spec.label}: ${ctx.boxSummary(spec, selection[k])}`, () => spec.apply("")));
  }
  return [...tags, ...(ctx.districtTags?.() || [])];
}

function filterWords() {
  const out = [];
  if (selection.q) out.push({ label: "Search", value: `“${selection.q}”` });
  for (const [k, b] of Object.entries(BOXES)) {
    if (selection[k]) out.push({ label: b.label, value: splitChoice(selection[k]).map(b.text).join(" or ") });
  }
  return out;
}

function filtersToggle() {
  const b = el("button", {
    class: "btn filters-toggle", type: "button", "aria-expanded": String(filtersOpen), "aria-controls": "sched-filters", text: "Filters",
    onclick: () => {
      filtersOpen = !filtersOpen;
      b.closest?.(".toolbar")?.classList.toggle("open", filtersOpen);
      b.setAttribute("aria-expanded", String(filtersOpen));
    },
  });
  return b;
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

// A sortable header; spec adds the ▾ of that column's filter box.
function sortTh(label, col, ctx, cls = "", spec = null) {
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
    }, el("span", { class: "col-label", text: label })),
    spec && ctx.colFilterButton ? ctx.colFilterButton(spec) : null));
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
  const list = sortSchedules(listed(ctx), { col: selection.sort, dir: selection.dir });
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (selection.page > pages) selection.page = pages;
  const start = (selection.page - 1) * PAGE_SIZE;
  const pageRows = list.slice(start, start + PAGE_SIZE);
  const agencies = new Set(list.map((r) => r.agency)).size;
  const boxes = ctx.filterBoxButton ? Object.keys(BOXES).map((k) => ctx.filterBoxButton(boxSpec(ctx, k))) : [];
  const col = (k) => (ctx.colFilterButton ? boxSpec(ctx, k) : null);

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
      ". Rates are shown as printed and never added up. A cell that prints no amount (N/A, or a footnote marker) shows what is printed and has no rate. Select an agency's name for its whole schedule."),
    selection.agency ? el("p", { class: "muted", text: `No agency named ${selection.agency} has fee schedules.` }) : null,
    el("div", { class: "tiles" },
      tile("Agencies", fmtInt(s.agencies)),
      tile("Documents", fmtInt(s.documents)),
      tile("Printed amounts", fmtInt(s.priced)),
      tile("Cells without amount", fmtInt(s.unpriced))),
    rejectedNote(data.rejected),
    el("div", { class: `toolbar schedules-toolbar${filtersOpen ? " open" : ""}` },
      chip("Search", search),
      boxes.length ? filtersToggle() : null,
      el("span", { class: "filters-more", id: "sched-filters" },
        boxes,
        ctx.filterBoxButton ? districtBoxSpecs(ctx).map((spec) => ctx.filterBoxButton(spec)) : null),
      el("button", {
        class: "btn", type: "button", text: "Clear",
        onclick: () => {
          ctx.clearDistrictFilter?.();
          change(ctx, { agencies: "", q: "", county: "", type: "", basis: "", purpose: "", status: "" });
        },
      })),
    districtFilterOn(ctx) ? el("p", { class: "district-callout", text: `${ctx.districtCaveat?.() || ""} A rate shows under every district its agency touches.`.trim() }) : null,
    el("div", { class: "result-bar" },
      el("span", { class: "count" }, el("strong", { text: fmtInt(list.length) }), ` ${list.length === 1 ? "row" : "rows"} · ${count(agencies, "agency", "agencies")}`),
      el("span", { class: "active-filters" }, filterTags(ctx)),
      ctx.districtNote?.() || null),
    el("div", { class: "table-scroll" },
      el("table", { class: "grid schedules-grid" },
        el("thead", {}, el("tr", {},
          sortTh("Agency", "agency", ctx, "", col("agencies")),
          sortTh("Program", "program", ctx),
          sortTh("Land use", "land", ctx),
          el("th", { scope: "col", text: "Conditions" }),
          sortTh("Rate", "rate", ctx, "num"),
          el("th", { scope: "col", text: "Unit" }),
          sortTh("Basis", "basis", ctx, "", col("basis")),
          sortTh("Status", "status", ctx, "", col("status")),
          sortTh("Effective", "date", ctx, "num"),
          el("th", { scope: "col", text: "Printed" }),
          el("th", { scope: "col", class: "col-evidence", text: "Evidence" }))),
        body)),
    pages > 1 ? el("div", { class: "pager" },
      el("button", { class: "btn", type: "button", text: "Prev", disabled: selection.page <= 1, onclick: () => change(ctx, { page: selection.page - 1 }, { top: true }) }),
      el("span", { class: "muted", text: `page ${selection.page} of ${pages}` }),
      el("button", { class: "btn", type: "button", text: "Next", disabled: selection.page >= pages, onclick: () => change(ctx, { page: selection.page + 1 }, { top: true }) })) : null);
}

// ------------------------------------------------------------ downloads

// The rows of one agency's schedule when it is open and page is true, else
// the statewide table's under its filters, every page, in its order. Rates
// stay as printed. The Download menu and the report call it with a ctx built
// like renderSchedules's, so the tab need not be open. Before the release
// carries the file, the export is empty and says so.
export async function exportSchedules(ctx, { page = true } = {}) {
  seedSelection(ctx);
  await loadSchedules(ctx);
  if (data.absent) return { label: "Schedules", base: "schedules", rows: [], columns: [], csv: [], filters: [], intro: NOT_PUBLISHED, empty: NOT_PUBLISHED };
  const one = page && selection.agency ? data.built.byName.get(selection.agency) : null;
  let rows;
  if (one) rows = one.purposes.flatMap((g) => g.programs.flatMap((p) => p.rows));
  else {
    if (districtFilterOn(ctx) && ctx.ensureDistricts) await ctx.ensureDistricts();
    rows = sortSchedules(listed(ctx), { col: selection.sort, dir: selection.dir });
  }
  const pageUrl = (name) => (ctx.siteHref ? ctx.siteHref({ view: "schedules", scagency: name }) : "");
  const official = (r) => ctx.officialUrl(r.official_source_url, Number(r.physical_pdf_page) || null);
  return {
    label: one ? one.name : "Schedules",
    base: one ? `${one.name} schedules` : "schedules",
    subtitle: one ? one.name : "",
    rows,
    filters: one ? [{ label: "Agency", value: one.name }] : filterWords(),
    agency: agencyOf,
    intro: "One row for each printed rate cell, as the agency's schedule prints it.",
    note: "Rates are as printed and never added up; a cell that prints no amount has no rate.",
    columns: [
      { key: "agency", label: "Agency", kind: "link", value: (r) => (ctx.siteLink ? ctx.siteLink(r.agency, { view: "schedules", scagency: r.agency }) : r.agency) },
      { key: "county", label: "County", value: (r) => r.county },
      { key: "program", label: "Program", value: (r) => r.fee_program },
      { key: "type", label: "Fee type", value: (r) => feeTypeLabel(r.normalized_fee_type) },
      { key: "purpose", label: "Purpose", value: (r) => purposeLabel(r.purpose_category) },
      { key: "land", label: "Land use", value: landUseText },
      { key: "conditions", label: "Conditions", value: (r) => conditionParts(r.applicability_conditions).join("; ") },
      { key: "rate", label: "Rate as printed", value: (r) => r.rate_as_printed },
      { key: "unit", label: "Unit", value: (r) => r.unit_as_printed },
      { key: "basis", label: "Basis", value: (r) => basisLabel(r.basis) },
      { key: "status", label: "Status", value: (r) => statusLabel(r.rate_status) },
      { key: "effective", label: "Effective", value: (r) => r.effective_date },
      { key: "official", label: "Publisher's copy", kind: "link", value: (r) => { const href = official(r); return href ? { text: r.physical_pdf_page ? `p.${r.physical_pdf_page}` : "document", href } : ""; } },
    ],
    csv: [
      ...SCHEDULE_COLUMNS.map((k) => ({ key: k, value: (r) => (k === "official_source_url" ? ctx.officialUrl(r[k]) || "" : r[k]) })),
      { key: "fee_type_label", value: (r) => feeTypeLabel(r.normalized_fee_type) },
      { key: "purpose_label", value: (r) => purposeLabel(r.purpose_category) },
      { key: "basis_label", value: (r) => basisLabel(r.basis) },
      { key: "rate_status_label", value: (r) => statusLabel(r.rate_status) },
      { key: "land_use_label", value: (r) => landUseLabel(r.land_use_class) },
      { key: "page_url", value: (r) => pageUrl(r.agency) },
    ],
  };
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
