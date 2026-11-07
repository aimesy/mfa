// Funds tab: each agency's impact fee accounts by fund and fiscal year, from
// data/fee-account-figures.csv, loaded the first time the tab opens. Every
// string reaches the page through el(), so through textContent or attributes.
//
// ctx (app.js): fetchText, dataUrl, officialUrl, collections, entityLink,
// agencyHref, isCurrent, rerender, and the selection: agency, q, county and
// type, with onSelect hearing each change. libCtx() adds the filter boxes,
// the district filter and siteLink; app.js calls exportFunds.
// URL parameters (app.js): fa, faq, facounty, fatype; facounty and fatype
// take several values joined by "|". The district filter (ad, sd) is app.js's.

import { el } from "./dom.js";
import { parseCsvObjects } from "./csv.js";
import { fmtUsd, fmtFy, fmtInt, entityTypeLabel, NONE, splitChoice } from "./model.js";
import { FUND_MEASURES, buildFunds, statewideEnding, filterFundAgencies, fundsStats } from "./funds.js";

const FUNDS_PATH = "data/fee-account-figures.csv";
const COLLECTIONS_PATH = "data/reported-fee-collections.csv";
// Shown for every agency; the others only where the agency prints them.
const OPTIONAL = new Set(["other_revenue", "total_revenue"]);
const LABEL = Object.fromEntries(FUND_MEASURES.map((m) => [m.key, m.label]));

let funds = null;
let fundsPromise = null;
const selection = { agency: "", q: "", county: "", type: "" };
let searchTimer = 0;
let host = null;

function loadFunds(ctx) {
  if (!fundsPromise) {
    const collections = ctx.collections
      ? Promise.resolve(ctx.collections)
      : ctx.fetchText(COLLECTIONS_PATH).then((text) => parseCsvObjects(text).rows);
    fundsPromise = Promise.all([ctx.fetchText(FUNDS_PATH), collections]).then(([text, rows]) => {
      funds = buildFunds(parseCsvObjects(text).rows, rows);
      return funds;
    });
    fundsPromise.catch(() => { fundsPromise = null; });
  }
  return fundsPromise;
}

// The address bar's selection, which ctx carries, becomes the tab's.
function seedSelection(ctx) {
  for (const k of ["agency", "q", "county", "type"]) if (typeof ctx[k] === "string") selection[k] = ctx[k];
}

export function renderFunds(content, ctx) {
  seedSelection(ctx);
  host = content;
  const view = el("div", { class: "stats-view funds-view" });
  content.append(view);
  if (funds) {
    fillFunds(view, funds, ctx);
    return;
  }
  view.append(el("p", { class: "muted", text: "Loading fund accounts…" }));
  loadFunds(ctx).then(() => {
    if (ctx.isCurrent()) ctx.rerender();
  }).catch((err) => {
    if (view.isConnected) view.replaceChildren(el("p", { class: "muted", text: `Failed to load fund accounts: ${err.message}` }));
  });
}

// For tests: forget the loaded files and the selection.
export function resetFunds() {
  funds = null;
  fundsPromise = null;
  Object.assign(selection, { agency: "", q: "", county: "", type: "" });
}

function change(ctx, patch, { top = false } = {}) {
  Object.assign(selection, patch);
  ctx.onSelect?.({ ...selection });
  ctx.rerender();
  if (top) host?.scrollTo?.(0, 0);
}

function select(ctx, agency) {
  change(ctx, { agency }, { top: true });
}

// ------------------------------------------------------------ filters

// The name districts.json knows an agency by.
const agencyOf = (a) => [a.name, { type: a.type, county: a.county }];

function districtFilterOn(ctx) {
  const f = ctx.districtFilter?.() || {};
  return Boolean(f.ad || f.sd);
}

const byDistrict = (ctx, list) => (districtFilterOn(ctx) && ctx.rowPassesDistricts ? list.filter((a) => ctx.rowPassesDistricts(...agencyOf(a))) : list);

// Agencies under the boxes and the district filter, and the search when
// withSearch; skip leaves one box out, so a box counts against the others.
function scoped(ctx, { skip = "", withSearch = false } = {}) {
  const f = { county: selection.county, type: selection.type, q: withSearch ? selection.q : "" };
  if (skip) f[skip] = "";
  return byDistrict(ctx, filterFundAgencies(funds, f));
}

const BOXES = {
  county: { key: "facounty", label: "County", value: (a) => a.county, text: (v) => (v === NONE ? "(not recorded)" : v) },
  type: { key: "fatype", label: "Type", value: (a) => a.type, text: (v) => (v === NONE ? "(not recorded)" : entityTypeLabel(v)) },
};

function ready(ctx) {
  return Promise.all([loadFunds(ctx), districtFilterOn(ctx) && ctx.ensureDistricts ? ctx.ensureDistricts() : null]);
}

// A box counts agencies under the other box, the district filter and the search.
function boxSpec(ctx, k) {
  const b = BOXES[k];
  return {
    key: b.key,
    label: b.label,
    text: b.text,
    get: () => selection[k],
    apply: (raw) => change(ctx, { [k]: raw }),
    options: () => ready(ctx).then(() => ctx.facetOptions(scoped(ctx, { skip: k, withSearch: true }), b.value, b.text)),
  };
}

function districtBoxSpecs(ctx) {
  if (!ctx.districtSpecs) return [];
  return ctx.districtSpecs(() => (funds ? scoped(ctx, { withSearch: true }) : []), agencyOf).map((spec) => {
    const s = Object.create(spec);
    s.options = () => loadFunds(ctx).then(() => spec.options());
    return s;
  });
}

function filterTags(ctx) {
  if (!ctx.filterTag) return [];
  const tags = [];
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

function filterBar(ctx) {
  if (!ctx.filterBoxButton) return null;
  return el("div", { class: "toolbar funds-toolbar" },
    ["county", "type"].map((k) => ctx.filterBoxButton(boxSpec(ctx, k))),
    districtBoxSpecs(ctx).map((s) => ctx.filterBoxButton(s)),
    el("button", {
      class: "btn", type: "button", text: "Clear",
      onclick: () => {
        ctx.clearDistrictFilter?.();
        change(ctx, { q: "", county: "", type: "" });
      },
    }));
}

// ------------------------------------------------------------ statewide

function fillFunds(view, f, ctx) {
  const agency = selection.agency ? f.agencyByName.get(selection.agency) : null;
  if (agency) {
    fillAgency(view, agency, ctx);
    return;
  }
  const inScope = scoped(ctx);
  const whole = districtFilterOn(ctx);
  const s = fundsStats(inScope);
  const run = s.checks.closes + s.checks.rounding + s.checks.incomplete + s.checks.differs;
  append(view,
    el("p", {},
      "Balances and flows each agency's annual report prints for its impact fee accounts, by fund and fiscal year, from ",
      el("code", { text: FUNDS_PATH }),
      ". Primary figures only: a dot (·) marks a figure not in this release. ",
      el("strong", { text: "Check" }),
      " adds the flows in this release to the beginning balance and compares the result with the printed ending balance; it is incomplete while a flow is not in this release."),
    selection.agency ? el("p", { class: "muted", text: `No agency named ${selection.agency} has fund figures.` }) : null,
    filterBar(ctx),
    whole ? el("p", { class: "district-callout", text: `${ctx.districtCaveat?.() || ""} Balances are each agency's whole accounts, not the part inside a district.`.trim() }) : null,
    el("div", { class: "tiles" },
      tile("Agencies", fmtInt(s.agencies)),
      tile("Funds", fmtInt(s.funds)),
      tile("Fund years", fmtInt(s.fundYears), s.years.length ? `FY ${fmtFy(s.years[0])} to ${fmtFy(s.years[s.years.length - 1])}` : ""),
      tile("Check closes", fmtInt(s.checks.closes), `of ${fmtInt(run)} run, ${fmtInt(s.checks.incomplete)} incomplete; ${fmtInt(s.checks.none)} not run`)),
    statewideBlock(inScope, whole),
    agencyIndex(f, inScope, ctx));
}

// Node.append would print a skipped child as "null"; el() drops it.
const append = (node, ...children) => node.append(...children.flat(Infinity).filter((c) => c != null && c !== false));

function tile(label, value, sub = "") {
  return el("div", { class: "tile" },
    el("div", { class: "tile-label", text: label }),
    el("div", { class: "tile-value", text: value }),
    sub ? el("div", { class: "tile-sub", text: sub }) : null);
}

function block(title, ...children) {
  return el("section", { class: "stats-block" }, el("h3", { class: "section-label", text: title }), ...children);
}

const usd = (cents) => fmtUsd(cents / 100);

function statewideBlock(agencies, whole) {
  const rows = statewideEnding({ agencies }).map((t) => el("tr", {},
    el("td", { text: fmtFy(t.fy) }),
    el("td", { class: "num", text: usd(t.cents) }),
    el("td", { class: "num", text: fmtInt(t.agencies) }),
    el("td", { class: "num", text: fmtInt(t.funds) }),
    el("td", { class: "num", text: fmtInt(t.unresolved) }),
    el("td", { class: "num", text: fmtInt(t.twins) })));
  if (!rows.length) rows.push(el("tr", { class: "empty-row" }, el("td", { colspan: 6, text: "No agency here prints an ending balance." })));
  return block(whole ? "Ending balances held by whole agencies, by fiscal year" : "Ending balances held, by fiscal year",
    el("p", { class: "muted funds-note", text: "Sum of the ending balances printed for each fiscal year, for the agencies the filters above keep. An agency counts in a year only if it prints an ending balance for that year. A fund whose ending balance does not resolve to one amount is left out. A report can print one account in two tables under two names: funds of one agency and year whose beginning and ending balances match, from the same report, count once, and Printed twice counts the copies left out." }),
    el("div", { class: "table-scroll" },
      el("table", { class: "grid" },
        el("thead", {}, el("tr", {},
          el("th", { scope: "col", text: "Fiscal year" }),
          el("th", { scope: "col", class: "num", text: whole ? "Ending balances, whole agencies" : "Ending balances" }),
          el("th", { scope: "col", class: "num", text: "Agencies" }),
          el("th", { scope: "col", class: "num", text: "Funds" }),
          el("th", { scope: "col", class: "num", text: "Left out", title: "Funds whose ending balance does not resolve to one amount" }),
          el("th", { scope: "col", class: "num", text: "Printed twice", title: "Funds counted once because the report prints the same balances under another name" }))),
        el("tbody", {}, rows))));
}

function agencyLink(a, ctx) {
  return el("a", {
    href: ctx.agencyHref ? ctx.agencyHref(a.name) : "#",
    text: a.name,
    onclick: (ev) => {
      ev.preventDefault();
      select(ctx, a.name);
    },
  });
}

// A header with a ▾ for its box, laid out as app.js's sortable headers are.
function boxHead(label, spec, ctx) {
  return el("th", { scope: "col" }, el("span", { class: "col-head" },
    el("span", { class: "col-label", text: label }),
    ctx.colFilterButton ? ctx.colFilterButton(spec) : null));
}

// The search narrows this list in place; the boxes above narrow the tiles too.
function agencyIndex(f, inScope, ctx) {
  const rowFor = new Map(inScope.map((a) => {
    const checks = a.funds.flatMap((fund) => fund.years.map((y) => y.check.status));
    const closes = checks.filter((c) => c === "closes").length;
    const run = checks.filter((c) => c !== "none").length;
    return [a, el("tr", {},
      el("td", {}, agencyLink(a, ctx)),
      el("td", { text: a.county }),
      el("td", { text: entityTypeLabel(a.type) }),
      el("td", { class: "num", text: fmtInt(a.funds.length) }),
      el("td", { class: "num", text: a.years.length ? `${fmtFy(a.years[0])} to ${fmtFy(a.years[a.years.length - 1])}` : "" }),
      el("td", { class: "num", text: run ? `${fmtInt(closes)} of ${fmtInt(run)}` : "" }))];
  }));
  const tbody = el("tbody");
  const count = el("span", { class: "funds-count" });
  const show = () => {
    const keep = new Set(filterFundAgencies(f, { q: selection.q }));
    const list = inScope.filter((a) => keep.has(a));
    tbody.replaceChildren(...list.map((a) => rowFor.get(a)));
    if (!list.length) tbody.append(el("tr", { class: "empty-row" }, el("td", { colspan: 6, text: "No agency matches." })));
    count.textContent = `${fmtInt(list.length)} of ${fmtInt(f.agencies.length)} agencies`;
  };
  const input = el("input", {
    type: "search", id: "funds-q", value: selection.q, placeholder: "Agency, county or fund", "aria-label": "Search agencies",
    oninput: () => {
      selection.q = input.value;
      show();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => ctx.onSelect?.({ ...selection }), 140);
    },
  });
  show();
  return block("Agencies",
    el("div", { class: "funds-search" },
      el("span", { class: "chip" }, el("label", { class: "chip-lbl", for: "funds-q", text: "Search" }), input),
      count,
      // funds-count gives the tags the result bar's small type.
      el("span", { class: "funds-count active-filters" }, filterTags(ctx)),
      el("span", { class: "funds-count" }, ctx.districtNote?.() || null)),
    el("div", { class: "table-scroll" },
      el("table", { class: "grid" },
        el("thead", {}, el("tr", {},
          el("th", { scope: "col", text: "Agency" }),
          boxHead("County", boxSpec(ctx, "county"), ctx),
          boxHead("Type", boxSpec(ctx, "type"), ctx),
          el("th", { scope: "col", class: "num", text: "Funds" }),
          el("th", { scope: "col", class: "num", text: "Fiscal years" }),
          el("th", { scope: "col", class: "num", text: "Check closes" }))),
        tbody)));
}

// ------------------------------------------------------------ downloads

const CHECK_TEXT = { closes: "closes", rounding: "within $1", incomplete: "incomplete", differs: "differs", none: "not run" };
const dollars = (cell) => (cell && cell.value != null ? cell.value / 100 : null);

// One row for each fund year: the agency page's when one is open and page
// is true, else the agencies listed. The Download menu and the report call
// it with a ctx built like renderFunds's, so the tab need not be open.
export async function exportFunds(ctx, { page = true } = {}) {
  seedSelection(ctx);
  await loadFunds(ctx);
  const one = page && selection.agency ? funds.agencyByName.get(selection.agency) : null;
  let agencies;
  if (one) agencies = [one];
  else {
    if (districtFilterOn(ctx) && ctx.ensureDistricts) await ctx.ensureDistricts();
    agencies = scoped(ctx, { withSearch: true });
  }
  const rows = agencies.flatMap((a) => a.funds.flatMap((fund) => fund.years.map((y) => ({ a, fund, y }))));
  const pageUrl = (name) => (ctx.siteHref ? ctx.siteHref({ view: "funds", fa: name }) : "");
  return {
    label: one ? one.name : "Funds",
    base: one ? `${one.name} funds` : "funds",
    subtitle: one ? one.name : "",
    rows,
    filters: one ? [{ label: "Agency", value: one.name }] : filterWords(),
    agency: (r) => agencyOf(r.a),
    intro: "One row for each fund and fiscal year, with the balances and flows the agency's annual report prints.",
    note: `A blank is not in this release, or the reports disagree; it is never zero.${!one && districtFilterOn(ctx) ? " Balances are each agency's whole accounts." : ""}`,
    columns: [
      { key: "agency", label: "Agency", kind: "link", value: (r) => (ctx.siteLink ? ctx.siteLink(r.a.name, { view: "funds", fa: r.a.name }) : r.a.name) },
      { key: "county", label: "County", value: (r) => r.a.county },
      { key: "type", label: "Type", value: (r) => entityTypeLabel(r.a.type) },
      { key: "fund", label: "Fund", value: (r) => r.fund.name },
      { key: "fy", label: "Fiscal year", kind: "fy", value: (r) => r.y.fy },
      ...["beginning_balance", "total_fees_collected", "interest_earned", "expenditures", "ending_balance"]
        .map((k) => ({ key: k, label: LABEL[k], kind: "usd", value: (r) => dollars(r.y.cells[k]) })),
      { key: "check", label: "Check", value: (r) => CHECK_TEXT[r.y.check.status] || r.y.check.status },
    ],
    csv: [
      { key: "agency", value: (r) => r.a.name },
      { key: "agency_type", value: (r) => r.a.type },
      { key: "county", value: (r) => r.a.county },
      { key: "fund", value: (r) => r.fund.name },
      { key: "fund_other_names", value: (r) => r.fund.otherNames },
      { key: "fee_category", value: (r) => r.fund.category },
      { key: "fiscal_year", value: (r) => r.y.fy },
      ...FUND_MEASURES.flatMap((m) => [
        { key: `${m.key}_usd`, value: (r) => dollars(r.y.cells[m.key]) },
        { key: `${m.key}_resolved_as`, value: (r) => r.y.cells[m.key]?.kind || "" },
      ]),
      { key: "fees_collected_from", value: (r) => r.y.cells.total_fees_collected?.from || "" },
      { key: "check", value: (r) => r.y.check.status },
      { key: "check_difference_usd", value: (r) => (r.y.check.diff == null ? "" : r.y.check.diff / 100) },
      { key: "page_url", value: (r) => pageUrl(r.a.name) },
    ],
  };
}

// ------------------------------------------------------------ one agency

function fillAgency(view, a, ctx) {
  const cells = a.funds.flatMap((fund) => fund.years.map((y) => y.cells));
  const measures = FUND_MEASURES.filter((m) => !OPTIONAL.has(m.key) || cells.some((c) => c[m.key]));
  const filled = cells.some((c) => c.total_fees_collected?.from === "collections");
  const thousands = cells.some((c) => Object.values(c).some((cell) => cell.used.some((l) => l.thousands)));
  const link = a.collectionsName && ctx.entityLink ? ctx.entityLink(a.collectionsName) : null;
  append(view,
    el("div", { class: "funds-head" },
      el("a", {
        class: "back", href: ctx.agencyHref ? ctx.agencyHref("") : "#", text: "← All agencies",
        onclick: (ev) => {
          ev.preventDefault();
          select(ctx, "");
        },
      }),
      el("h2", { text: a.name }),
      el("div", { class: "dossier-meta" },
        el("span", { text: entityTypeLabel(a.type) }),
        a.county ? el("span", { text: `${a.county} County` }) : null,
        el("span", { text: `${fmtInt(a.funds.length)} ${a.funds.length === 1 ? "fund" : "funds"}` }),
        a.years.length ? el("span", { text: `FY ${fmtFy(a.years[0])} to ${fmtFy(a.years[a.years.length - 1])}` }) : null),
      link ? el("p", { class: "note" }, "Fee collections: ", link) : null),
    el("p", { class: "muted funds-note" },
      "A dot (·) marks a figure not in this release. Where a report prints several lines for one measure, the cell shows its printed total, or the sum of the lines when it prints none; where reports disagree, or one report prints conflicting totals, the cell shows no amount.",
      filled ? " Fees marked collections come from reported-fee-collections.csv (same agency, fund and fiscal year) because the fund table prints none." : "",
      thousands ? " Amounts marked 000s are printed in whole thousands and shown in dollars." : ""),
    a.funds.map((fund) => block(fund.name,
      fund.otherNames.length ? el("p", { class: "muted funds-note", text: `Also printed as ${fund.otherNames.join("; ")}` }) : null,
      el("div", { class: "table-scroll" }, fundTable(fund, measures, ctx)))));
}

function fundTable(fund, measures, ctx) {
  return el("table", { class: "grid funds-grid" },
    el("thead", {}, el("tr", {},
      el("th", { scope: "col", text: "Fiscal year" }),
      measures.map((m) => el("th", {
        scope: "col", class: "num", text: m.label,
        title: m.key === "total_fees_collected" ? "From the fund table, or from reported-fee-collections.csv where marked collections" : null,
      })),
      el("th", { scope: "col", text: "Check" }))),
    el("tbody", {}, fund.years.map((y) => el("tr", {},
      el("th", { scope: "row", text: fmtFy(y.fy) }),
      measures.map((m) => amountCell(y.cells[m.key], ctx)),
      checkCell(y.check, y.cells)))));
}

function evidenceLinks(line, ctx) {
  const where = `${line.title || line.sourceId}${line.page ? `, page ${line.page}` : ""}`;
  const text = line.page ? `p.${line.page}` : "page";
  let open = null;
  if (ctx.openEvidence) {
    open = el("button", {
      class: "pdf-btn", type: "button", text, title: `Open ${where}`,
      onclick: (ev) => {
        ev.stopPropagation();
        ctx.openEvidence(line);
      },
    });
  } else {
    const href = ctx.dataUrl(line.pdf);
    if (href) open = el("a", { class: "pdf-btn", href: line.page ? `${href}#page=${line.page}` : href, target: "_blank", rel: "noopener", title: `Open ${where}`, text });
  }
  const off = ctx.officialUrl(line.official, line.page);
  return el("span", { class: "ev-links" },
    open,
    off ? el("a", {
      class: "pdf-btn ext", href: off, target: "_blank", rel: "noopener",
      title: `Official source${line.page ? `, page ${line.page}` : ""}`, "aria-label": "Official source", text: "↗",
    }) : null);
}

function linesList(cell, ctx) {
  return el("details", { class: "funds-lines" },
    el("summary", { text: `${fmtInt(cell.lines.length)} lines` }),
    el("ul", {}, cell.lines.map((l) => el("li", {},
      el("span", { class: "funds-line-label", text: l.label }),
      el("span", { class: "funds-line-amt", text: l.cents == null ? "" : usd(l.cents) }),
      evidenceLinks(l, ctx)))));
}

const KIND_TAG = {
  total: () => ["total", "Printed total line"],
  sum: () => ["sum", "Sum of the printed lines; the report prints no total"],
  agree: (cell) => [`${cell.sources} reports`, "Printed alike in each report"],
};

// A cell without an amount: reports that disagree, or one report whose total
// lines differ or whose line carries no amount.
function nullLabel(cell) {
  if (cell.kind === "differs") return ["Sources differ", "The reports print different amounts"];
  const totals = cell.lines.filter((l) => /^\s*total\b/i.test(l.label));
  return totals.length > 1
    ? ["Totals conflict", "The report prints total lines with different amounts"]
    : ["Amount missing", "A line the report prints has no amount in this release"];
}

function amountCell(cell, ctx) {
  if (!cell) return el("td", { class: "mx-empty", title: "Not in this release" }, el("span", { "aria-label": "not in this release", text: "·" }));
  const many = cell.lines.length > 1;
  if (cell.value == null) {
    const [text, title] = nullLabel(cell);
    return el("td", { class: "num funds-cell" },
      el("div", { class: "funds-differs", text, title }),
      linesList(cell, ctx));
  }
  const tag = KIND_TAG[cell.kind]?.(cell);
  return el("td", { class: "num funds-cell" },
    el("div", { class: "funds-amt" },
      cell.from === "collections" ? el("span", { class: "funds-tag", text: "collections", title: "From reported-fee-collections.csv" }) : null,
      cell.used.some((l) => l.thousands) ? el("span", { class: "funds-tag", text: "000s", title: "Printed in whole thousands" }) : null,
      tag ? el("span", { class: "funds-tag", text: tag[0], title: tag[1] }) : null,
      el("span", { text: usd(cell.value) })),
    cell.used.length === 1 ? evidenceLinks(cell.used[0], ctx) : null,
    many ? linesList(cell, ctx) : null);
}

const termList = (keys) => keys.map((k) => LABEL[k].toLowerCase()).join(", ");

function checkTerms(check, cells) {
  const parts = [`${LABEL.beginning_balance} ${usd(check.begin)}`];
  for (const t of check.terms) parts.push(`${t.cents < 0 ? "−" : "+"} ${LABEL[t.measure]} ${usd(Math.abs(t.cents))}`);
  // The release's own arithmetic, which can count terms this release does not carry.
  const arith = check.status === "closes" ? [] : [...new Set(cells.ending_balance.used.map((l) => l.arith).filter(Boolean))];
  return [
    `${parts.join(" ")} = ${usd(check.computed)}`,
    `Printed ending balance ${usd(check.printed)}${check.diff ? `; difference ${usd(check.diff)}` : ""}`,
    check.absent.length ? `Not in this release: ${termList(check.absent)}` : "",
    check.mixed ? "Terms come from different reports." : "",
    ...arith.map((a) => `Release arithmetic check: ${a}`),
  ].filter(Boolean);
}

const NOT_RUN = {
  balances: "Needs a beginning and ending balance in this release",
  sources: "Reports disagree on a term",
  unresolved: "Report prints conflicting figures for a term",
  flows: "No flows in this release",
};

const VERDICT = {
  closes: () => ["funds-ok", "closes", ""],
  rounding: () => ["funds-ok", "within $1", "Terms come from different reports, which round differently"],
  incomplete: (check) => ["funds-part", "incomplete", `Not in this release: ${termList(check.absent)}`],
  differs: (check) => ["funds-off", `off ${usd(check.diff)}`, ""],
};

function checkCell(check, cells) {
  if (check.status === "none") {
    const why = NOT_RUN[check.reason] + (check.missing?.length ? `: ${termList(check.missing)}` : "");
    return el("td", { class: "funds-check" }, el("span", { class: "muted", text: "not run", title: why }));
  }
  const [cls, text, title] = VERDICT[check.status](check);
  return el("td", { class: "funds-check" },
    el("details", {},
      el("summary", { class: cls, text, title: title || null }),
      el("div", { class: "funds-formula" }, checkTerms(check, cells).map((line) => el("div", { text: line })))));
}
