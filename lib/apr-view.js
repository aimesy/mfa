// Permits tab: the units each city and county permitted by fiscal year, from
// Table A2 of the Housing Element Annual Progress Reports (APRs) HCD
// publishes, beside the fees the release reports the agency collected that
// year. apr/apr.json in this repository holds the counts (scripts/apr.mjs
// writes it); it loads the first time the tab or a city's or county's page
// opens, with coverage.json's roster for the release names of each agency, and
// apr/population.json (scripts/population.mjs writes it) for each jurisdiction's
// residents. A scatter of fees per unit against units per 1,000 residents, one
// dot for each jurisdiction, sits above a table of agency years to sort and
// page; a city's or county's page shows its own years (renderEntityPermits).
// Every string reaches the page through el() and svg(), so through textContent
// or attributes.
//
// app.js passes ctx with these app.js values and functions:
//   model         the release model (buildModel: entities, entityByName)
//   state         the app state object; this tab keeps its own filters,
//                 sort and page in state.permits (emptyPermitsState())
//   update        update(): writes the URL and renders
//   loadCoverage  loadCoverage(): promise of the coverage.json roster
//   showTooltip, hideTooltip
//   entityHref, openEntity
//   permitsHref, openPermits
//   sortHeader, toggleSort
//   tile, chip, searchInput
// and libCtx(): the filter box helpers, the district filter and siteLink
// (the comment above libCtx in app.js lists them). app.js calls exportPermits
// for the Download menu and the report.
// URL parameters: pq, ptype, pcounty, pfy, pshow, poff, psort, ppage
// (readPermitsState and permitsParams); ptype, pcounty and pfy take several
// values joined by "|". The district filter (ad, sd) is app.js's.

import { el, svg } from "./dom.js";
import { fmtUsd, fmtSum, fmtInt, fmtFy, fmtBytes, searchTerms, NONE, SEP, splitChoice, matchesChoice } from "./model.js";
import { UNIT_CATS, readApr, joinPermits, median, titleCase, fyLabel } from "./apr.js";
import { readPopulation, addPopulation, weightedMedian, pooled, fyEstimateDate } from "./population.js";

export const APR_URL = "apr/apr.json";
export const POP_URL = "apr/population.json";
const PAGE = 100;
const ROSTER_TYPES = new Set(["city", "county", "city_and_county"]);
const TYPES = [["city", "City"], ["county", "County"], ["city_and_county", "City and county"]];
const TYPE_LABEL = new Map(TYPES);
// Three nested scopes, widest last: [key, button text, what it keeps].
const SHOWS = [
  ["", "Units and fees", "Years with units and fees"],
  ["comparable", "Fees per unit", "Years with fees per unit"],
  ["all", "Every year", "Every year, with or without units or fees"],
];
const FY = /^\d{4}-\d{2}$/;
const SORTS = ["name", "county", "fy", "units", "dr", "records", "ent", "co", "fees", "perUnit", "pop", "unitsPer1k", "feesPerRes", "cov"];
const NUMERIC = new Set(["units", "dr", "records", "ent", "co", "fees", "perUnit", "pop", "unitsPer1k", "feesPerRes"]);
export const DEFAULT_PERMITS_SORT = Object.freeze({ col: "name", dir: "asc" });
const COV_ORDER = { full: 0, partial: 1, none: 2 };
const COV_SHORT = { full: "Full", partial: "Partial", none: "Later reports only" };
const COV_TEXT = {
  full: "Both calendar year reports in hand",
  partial: "One of its two calendar year reports in hand; counts may be short",
  none: "No report for either calendar year; counts are what later reports list",
};
// The agency years no dot of the scatter takes in. The note under it counts each
// kind, and each count filters the table.
export const OFF_CHART = {
  noperunit: { test: (r) => r.units > 0 && r.fees > 0 && r.pop > 0 && r.perUnit == null, text: "not fully reported or with fees under two release names" },
  nounits: { test: (r) => r.units === 0 && r.fees != null, text: "with fees and no units permitted" },
  nofees: { test: (r) => r.units > 0 && r.fees != null && r.fees <= 0, text: "with fees of zero or less" },
  nopop: { test: (r) => r.units > 0 && r.fees > 0 && !(r.pop > 0), text: "with no population estimate" },
};
const COUNTY_NOTE = "A county's residents are those of its unincorporated area, where its report lists permits; a county fee program that also charges inside its cities reads high here.";

// ------------------------------------------------------------ state

export function emptyPermitsState() {
  return { q: "", type: "", county: "", fy: "", show: "", off: "", sort: { ...DEFAULT_PERMITS_SORT }, page: 1 };
}

// Each part of a "|" list is checked on its own, so one bad part in a link
// drops only that part; repeats go too. An old link's single value is a list
// of one.
export function cleanParts(raw, ok) {
  const out = [];
  for (const part of splitChoice(raw)) {
    const v = part.trim();
    if (v && ok(v) && !out.includes(v)) out.push(v);
  }
  return out.join(SEP);
}

export function readPermitsState(params) {
  const [col, dir] = String(params.get("psort") || "").split(".");
  const show = params.get("pshow") || "";
  const off = params.get("poff") || "";
  return {
    q: params.get("pq") || "",
    type: cleanParts(params.get("ptype"), (v) => v === NONE || TYPE_LABEL.has(v)),
    county: cleanParts(params.get("pcounty"), (v) => v.length <= 100),
    fy: cleanParts(params.get("pfy"), (v) => FY.test(v)),
    show: SHOWS.some(([k]) => k && k === show) ? show : "",
    off: Object.keys(OFF_CHART).includes(off) ? off : "",
    sort: SORTS.includes(col) && (dir === "asc" || dir === "desc") ? { col, dir } : { ...DEFAULT_PERMITS_SORT },
    page: Math.max(1, Number.parseInt(params.get("ppage"), 10) || 1),
  };
}

// put(k, v) sets k only when v is truthy, as in app.js stateParams.
export function permitsParams(ps, put) {
  put("pq", ps.q); put("ptype", ps.type); put("pcounty", ps.county); put("pfy", ps.fy); put("pshow", ps.show); put("poff", ps.off);
  const s = ps.sort;
  put("psort", s.col === DEFAULT_PERMITS_SORT.col && s.dir === DEFAULT_PERMITS_SORT.dir ? "" : `${s.col}.${s.dir}`);
  put("ppage", ps.page > 1 ? String(ps.page) : "");
}

// What app.js adds to its contentKey for this tab.
export function permitsKey(ps) {
  return ps ? [ps.q, ps.type, ps.county, ps.fy, ps.show, ps.off, ps.sort.col, ps.sort.dir, ps.page] : [];
}

function permitsState(ctx) {
  if (!ctx.state.permits) ctx.state.permits = emptyPermitsState();
  return ctx.state.permits;
}

// ------------------------------------------------------------ data

let loaded = null;
let loadPromise = null;
let joined = { model: null, rows: [] };

function loadPermits(ctx) {
  if (!loadPromise) {
    const apr = fetch(new URL(APR_URL, document.baseURI), { cache: "no-cache" }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} reading ${APR_URL}`);
      return readApr(await res.json());
    });
    // Without population the tab still shows the counts, with the per
    // resident figures blank and a note saying why.
    const pop = fetch(new URL(POP_URL, document.baseURI), { cache: "no-cache" }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} reading ${POP_URL}`);
      return { population: readPopulation(await res.json()), popError: "" };
    }).catch((err) => ({ population: null, popError: err.message }));
    loadPromise = Promise.all([apr, ctx.loadCoverage(), pop]).then(([a, cov, p]) => {
      loaded = { apr: a, agencies: cov.agencies.filter((x) => ROSTER_TYPES.has(x.type)), ...p };
      return loaded;
    });
    loadPromise.catch(() => { loadPromise = null; });
  }
  return loadPromise;
}

// The join, once for each release model.
function permitRows(ctx) {
  if (joined.model !== ctx.model) {
    const rows = addPopulation(joinPermits(loaded.apr, loaded.agencies, ctx.model), loaded.population);
    for (const r of rows) r._search = `${r.name} ${r.juris} ${r.county} ${r.entity}`.toLowerCase();
    joined = { model: ctx.model, rows };
  }
  return joined.rows;
}

const BOTH = (r) => r.units != null && r.fees != null;
const SHOW_TEST = { "": BOTH, comparable: (r) => r.perUnit != null, all: () => true };

// The name districts.json knows an agency year by: the roster agency, or for
// an APR name with no roster match, the APR name in its county.
export function permitAgency(r) {
  return r.agency ? [r.agency, { type: r.type, county: r.county }] : [r.juris, { county: r.aprCounty }];
}

// Rows under the search and the Type, County and FY boxes, leaving out the
// box named skip (a box counts by the other filters); districts is a row
// test or null.
export function filterRows(rows, ps, { skip = "", districts = null } = {}) {
  const terms = searchTerms(ps.q);
  const pick = (k, v) => skip === k || !ps[k] || matchesChoice(ps[k], v);
  return rows.filter((r) => pick("type", r.type) && pick("county", r.county) && pick("fy", r.fy)
    && terms.every((t) => r._search.includes(t)) && (!districts || districts(r)));
}

// The current district filter as a row test, or null when it is off.
function districtTest(ctx) {
  const f = ctx.districtFilter?.() || {};
  if (!f.ad && !f.sd) return null;
  return (r) => ctx.rowPassesDistricts(...permitAgency(r));
}

const districted = (ctx) => Boolean(districtTest(ctx));

// The agency years the table lists: the filters, then Show and the off
// chart count. skip and districts as in filterRows.
function listedRows(ctx, opts = {}) {
  const ps = permitsState(ctx);
  const list = filterRows(permitRows(ctx), ps, opts).filter(SHOW_TEST[ps.show] || BOTH);
  return ps.off ? list.filter(OFF_CHART[ps.off].test) : list;
}

const SORT_VALUE = {
  name: (r) => r.name, county: (r) => r.county, fy: (r) => r.fy, units: (r) => r.units, dr: (r) => r.dr,
  records: (r) => r.records, ent: (r) => r.ent, co: (r) => r.co, fees: (r) => r.fees, perUnit: (r) => r.perUnit,
  pop: (r) => r.pop, unitsPer1k: (r) => r.unitsPer1k, feesPerRes: (r) => r.feesPerRes,
  cov: (r) => COV_ORDER[r.cov],
};

// Missing values sort last in either direction.
export function sortPermitRows(list, sort) {
  const value = SORT_VALUE[sort.col] || SORT_VALUE.name;
  const sign = sort.dir === "asc" ? 1 : -1;
  const tie = (a, b) => a.name.localeCompare(b.name) || a.fy.localeCompare(b.fy);
  return [...list].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x == null || y == null) return x == null && y == null ? tie(a, b) : x == null ? 1 : -1;
    const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
    return sign * c || tie(a, b);
  });
}

// ------------------------------------------------------------ filter boxes

// The tab's own boxes: field in state.permits, box key, label, row value.
const BOXES = {
  type: { key: "ptype", label: "Type", value: (r) => r.type, text: (v) => (v === NONE ? "(no roster match)" : TYPE_LABEL.get(v) || v) },
  county: { key: "pcounty", label: "County", value: (r) => r.county, text: (v) => (v === NONE ? "(not recorded)" : v) },
  fy: { key: "pfy", label: "Fiscal year", sort: "num", value: (r) => r.fy, text: (v) => (v === NONE ? "(no year)" : fmtFy(v)) },
};

// The files a box counts from; a box opened while they load shows Loading.
function ready(ctx) {
  const f = ctx.districtFilter?.() || {};
  const districts = (f.ad || f.sd) && ctx.districtsLoaded && !ctx.districtsLoaded() ? ctx.ensureDistricts() : null;
  return Promise.all([loadPermits(ctx), districts]);
}

// A box's counts are agency years the table would list with the tab's other
// filters, Show and the off chart count included.
function boxSpec(ctx, k) {
  const b = BOXES[k];
  const ps = permitsState(ctx);
  return {
    key: b.key,
    label: b.label,
    sort: b.sort,
    text: b.text,
    get: () => ps[k],
    apply: (raw) => { ps[k] = raw; ps.page = 1; ctx.update(); },
    options: () => ready(ctx).then(() => ctx.facetOptions(listedRows(ctx, { skip: k, districts: districtTest(ctx) }), b.value, b.text)),
  };
}

// The shared Assembly and Senate boxes, counting the rows the tab's own
// filters leave; a new district list starts the table on page 1.
function districtBoxSpecs(ctx) {
  if (!ctx.districtSpecs) return [];
  const ps = permitsState(ctx);
  return ctx.districtSpecs(() => (loaded ? listedRows(ctx) : []), permitAgency).map((spec) => {
    const s = Object.create(spec);
    s.options = () => loadPermits(ctx).then(() => spec.options());
    s.apply = (raw) => { ps.page = 1; spec.apply(raw); };
    return s;
  });
}

// One tag for each filter in use, for the result bar.
function filterTags(ctx) {
  const ps = permitsState(ctx);
  const tags = [];
  if (ps.q) tags.push(ctx.filterTag(`“${ps.q}”`, () => { ps.q = ""; ps.page = 1; ctx.update(); }));
  for (const k of Object.keys(BOXES)) {
    if (!ps[k]) continue;
    const spec = boxSpec(ctx, k);
    tags.push(ctx.filterTag(`${spec.label}: ${ctx.boxSummary(spec, ps[k])}`, () => spec.apply("")));
  }
  return [...tags, ...(ctx.districtTags?.() || [])];
}

// The filters in words, for the report (the district filter is app.js's).
function filterWords(ctx) {
  const ps = permitsState(ctx);
  const out = [];
  if (ps.q) out.push({ label: "Search", value: `“${ps.q}”` });
  for (const [k, b] of Object.entries(BOXES)) {
    if (ps[k]) out.push({ label: b.label, value: splitChoice(ps[k]).map(b.text).join(" or ") });
  }
  const show = SHOWS.find(([key]) => key === ps.show);
  out.push({ label: "Show", value: show[2] });
  if (ps.off) out.push({ label: "Only", value: `agency years ${OFF_CHART[ps.off].text}` });
  return out;
}

// ------------------------------------------------------------ downloads

const cents = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// The rows the table lists, every page, in its order, for the Download menu
// and the report. The CSV keeps raw numbers and the APR's own names. It
// reads ctx.state, so the tab need not be open.
export async function exportPermits(ctx) {
  await loadPermits(ctx);
  const districts = districtTest(ctx);
  if (districts && ctx.ensureDistricts) await ctx.ensureDistricts();
  const ps = permitsState(ctx);
  const rows = sortPermitRows(listedRows(ctx, { districts: districtTest(ctx) }), ps.sort);
  const page = (r) => (r.entity && ctx.siteHref ? ctx.siteHref({ view: "entities", e: r.entity }) : "");
  return {
    label: "Permits",
    base: "permits",
    rows,
    filters: filterWords(ctx),
    agency: permitAgency,
    intro: "One row for each agency year: units permitted from Table A2 of the Housing Element Annual Progress Reports, beside the fees the release reports the agency collected that year.",
    note: `A blank is missing, not zero; a year that is not full may count short.${districts ? " Units, fees and residents are each agency's whole totals." : ""}`,
    columns: [
      { key: "name", label: "Jurisdiction", kind: "link", value: (r) => (r.entity && ctx.siteLink ? ctx.siteLink(r.name, { view: "entities", e: r.entity }) : r.name) },
      { key: "county", label: "County", value: (r) => r.county },
      { key: "fy", label: "Fiscal year", kind: "fy", value: (r) => r.fy },
      { key: "units", label: "Units permitted", kind: "int", value: (r) => r.units },
      { key: "dr", label: "Deed restricted", kind: "int", value: (r) => r.dr },
      { key: "ent", label: "Entitled", kind: "int", value: (r) => r.ent },
      { key: "co", label: "Completed", kind: "int", value: (r) => r.co },
      { key: "fees", label: "Fees collected", kind: "usd", value: (r) => r.fees },
      { key: "perUnit", label: "Fees per unit", kind: "usd", value: (r) => cents(r.perUnit) },
      { key: "pop", label: "Population", kind: "int", value: (r) => r.pop },
      { key: "unitsPer1k", label: "Units per 1,000 residents", kind: "int", value: (r) => r.unitsPer1k },
      { key: "feesPerRes", label: "Fees per resident", kind: "usd", value: (r) => cents(r.feesPerRes) },
      { key: "cov", label: "Coverage", value: (r) => COV_SHORT[r.cov] },
    ],
    csv: [
      { key: "jurisdiction", value: (r) => r.name },
      { key: "apr_jurisdiction", value: (r) => r.juris },
      { key: "apr_county", value: (r) => r.aprCounty },
      { key: "roster_agency", value: (r) => r.agency },
      { key: "agency_type", value: (r) => r.type },
      { key: "county", value: (r) => r.county },
      { key: "release_name", value: (r) => r.entity },
      { key: "release_names", value: (r) => r.releaseNames },
      { key: "fiscal_year", value: (r) => r.fy },
      { key: "coverage", value: (r) => r.cov },
      { key: "units_permitted", value: (r) => r.units },
      { key: "deed_restricted", value: (r) => r.dr },
      { key: "not_deed_restricted", value: (r) => r.ndr },
      { key: "permit_records", value: (r) => r.records },
      ...UNIT_CATS.map((c, i) => ({ key: `units_${c.toLowerCase().replace(/\+/g, "plus").replace(/[^a-z0-9]+/g, "_")}`, value: (r) => r.cats[i] })),
      { key: "entitled_units", value: (r) => r.ent },
      { key: "completed_units", value: (r) => r.co },
      { key: "fees_collected_usd", value: (r) => r.fees },
      { key: "fee_figures", value: (r) => r.feeFigures },
      { key: "fee_release_names", value: (r) => r.feeNames },
      { key: "fees_per_unit_usd", value: (r) => r.perUnit },
      { key: "population", value: (r) => r.pop },
      { key: "units_per_1000_residents", value: (r) => r.unitsPer1k },
      { key: "fees_per_resident_usd", value: (r) => r.feesPerRes },
      { key: "page_url", value: page },
    ],
  };
}

// ------------------------------------------------------------ toolbar

// Folds the boxes away on a phone, as app.js's toolbars do.
function filtersToggle() {
  const open = Boolean(document.getElementById("toolbar")?.classList.contains("open"));
  const b = el("button", {
    class: "btn filters-toggle", type: "button", "aria-expanded": String(open), "aria-controls": "filters-more", text: "Filters",
    onclick: () => {
      const bar = b.closest(".toolbar");
      if (bar) b.setAttribute("aria-expanded", String(bar.classList.toggle("open")));
    },
  });
  return b;
}

// Show: three nested scopes, so one of three buttons rather than a box.
function showSwitch(ctx) {
  const ps = permitsState(ctx);
  return el("span", { class: "chamber-switch permits-show", role: "group", "aria-label": "Agency years shown" },
    SHOWS.map(([k, text, title]) => el("button", {
      class: "btn", type: "button", "data-pshow": k, "aria-pressed": String(ps.show === k), text, title,
      onclick: () => {
        if (ps.show === k) return;
        ps.show = k;
        ps.page = 1;
        ctx.update();
      },
    })));
}

// The toolbar nodes for the tab; app.js appends them to #toolbar.
export function permitsToolbar(ctx) {
  const ps = permitsState(ctx);
  const set = (k) => (v) => { ps[k] = v; ps.page = 1; ctx.update(); };
  if (!loaded) loadPermits(ctx).catch(() => {});
  return [
    ctx.chip("Search", ctx.searchInput("pq", ps.q, "jurisdiction or county", set("q"))),
    filtersToggle(),
    el("span", { class: "filters-more", id: "filters-more" },
      ["type", "county", "fy"].map((k) => ctx.filterBoxButton(boxSpec(ctx, k))),
      districtBoxSpecs(ctx).map((s) => ctx.filterBoxButton(s)),
      showSwitch(ctx)),
    el("button", {
      class: "btn", type: "button", text: "Clear",
      onclick: () => {
        Object.assign(ps, emptyPermitsState());
        ctx.clearDistrictFilter?.();
        syncPermitsToolbar(ctx.state);
        ctx.update();
      },
    }),
  ];
}

// Called from app.js syncToolbar: the controls follow the state (back and
// forward, Clear), except the one being typed in. app.js repaints the boxes.
export function syncPermitsToolbar(state) {
  const ps = state.permits;
  if (!ps || typeof document === "undefined") return;
  const q = document.getElementById("pq");
  if (q && q !== document.activeElement && q.value !== ps.q) q.value = ps.q;
  for (const b of document.querySelectorAll(".permits-show [data-pshow]")) b.setAttribute("aria-pressed", String(b.dataset.pshow === ps.show));
}

// ------------------------------------------------------------ render

export function renderPermits(content, ctx) {
  const view = el("div", { class: "stats-view permits-view" });
  content.append(view);
  if (loaded) {
    fill(view, ctx);
    return;
  }
  view.append(el("p", { class: "muted", text: "Loading permits…" }));
  loadPermits(ctx).then(() => {
    if (!view.isConnected) return;
    view.replaceChildren();
    fill(view, ctx);
  }).catch((err) => {
    if (view.isConnected) view.replaceChildren(el("p", { class: "muted", text: `Failed to load permits: ${err.message}` }));
  });
}

const sum = (list, k) => list.reduce((s, r) => s + (Number.isFinite(r[k]) ? r[k] : 0), 0);
const rate2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdCents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRate = (v) => (Number.isFinite(v) ? rate2.format(v) : "");
const fmtCents = (v) => (Number.isFinite(v) ? (v < 0 ? `(${usdCents.format(-v)})` : usdCents.format(v)) : "");

// The summaries the tiles and the chart print for the rows in scope: the
// median fees per unit with every agency year counted once (med), and with
// each counted by its residents (wmed, so half the residents counted live in
// agency years at or below it); units per 1,000 residents over the years
// fully reported, and fees per resident, each as all units or all fees over
// all residents of the agency years counted.
export function permitsSummary(scope) {
  const comparable = scope.filter((r) => r.perUnit != null);
  const weighed = comparable.filter((r) => r.pop > 0);
  const units = pooled(scope.filter((r) => r.cov === "full"), "units", "pop");
  return {
    comparable,
    med: median(comparable.map((r) => r.perUnit)),
    weighed,
    wmed: weightedMedian(weighed.map((r) => [r.perUnit, r.pop])),
    unitsPer1k: units ? { ...units, value: units.value * 1000 } : null,
    feesPerRes: pooled(scope, "fees", "pop"),
  };
}

// The scatter's dots, one for each jurisdiction: its agency years with fees per
// unit above zero and a population, as all their fees over all their units and
// all their units over all their residents, so a slow permit year does not read
// as an expensive one. pop is its residents in an average year of them.
export function chartPoints(list) {
  const byJ = new Map();
  for (const r of list) {
    if (!(r.perUnit > 0 && r.pop > 0)) continue;
    const key = `${r.juris}|${r.aprCounty}`;
    if (byJ.has(key)) byJ.get(key).push(r);
    else byJ.set(key, [r]);
  }
  return [...byJ.values()].map((rows) => {
    const years = [...rows].sort((a, b) => a.fy.localeCompare(b.fy));
    const perUnit = pooled(years, "fees", "units");
    const rate = pooled(years, "units", "pop");
    const { name, entity } = years[years.length - 1];
    return {
      name,
      entity,
      fys: years.map((r) => r.fy),
      fees: perUnit.num,
      units: perUnit.den,
      perUnit: perUnit.value,
      unitsPer1k: rate.value * 1000,
      pop: rate.den / years.length,
      dr: sum(years, "dr"),
      cats: UNIT_CATS.map((_, i) => years.reduce((s, r) => s + (r.cats[i] || 0), 0)),
    };
  });
}

function fill(view, ctx) {
  const ps = permitsState(ctx);
  const { apr } = loaded;
  const rows = permitRows(ctx);
  const scope = filterRows(rows, ps, { districts: districtTest(ctx) });
  const list = scope.filter(SHOW_TEST[ps.show] || BOTH);
  const both = scope.filter(BOTH);
  const { comparable, med, weighed, wmed, unitsPer1k, feesPerRes } = permitsSummary(scope);
  const fys = [...new Set(scope.filter((r) => r.units != null).map((r) => r.fy))].sort();
  const matched = apr.jurisdictions.filter((j) => j.agency).length;
  const firstReport = apr.report_years[0];
  const parts = [
    el("p", {},
      "Units each city and county permitted in a fiscal year, from the building permits it lists in Table A2 of its Housing Element Annual Progress Reports to HCD, beside the fees the release reports it collected that year (every primary figure for the agency, all fee programs together). A permit counts in the fiscal year (July 1 to June 30) of its issue date, and only in the first report that lists it. ",
      el("strong", { text: "Entitled" }), " and ", el("strong", { text: "Completed" }),
      " count units the same way by entitlement approval and by certificate of occupancy."),
    el("p", {},
      "Each report covers one calendar year, so a fiscal year needs two. With both in hand the year is ",
      el("strong", { text: "full" }), "; with one it is ", el("strong", { text: "partial" }),
      " and its counts may be short; with neither, its counts are only what later reports list. In a year that is not full, a column with nothing listed is blank: missing, not zero. ",
      firstReport ? `FY ${fmtFy(fyLabel(firstReport - 1))} is never full: the table starts with the ${firstReport} reports, so its July to December ${firstReport - 1} permits are only those the ${firstReport} and later reports list. ` : "",
      el("strong", { text: "Fees per unit" }),
      " divides fees by units only for a full year with units above zero and fees under one release name. Fees count only from figures that report a July to June year; a figure whose recorded dates run otherwise is left out. Long Beach's fiscal year runs October to September, and the release records those dates on only some of its figures, so the rest join the July to June year with the same label."),
    el("p", {},
      el("strong", { text: "Population" }),
      " is the Department of Finance estimate for the January 1 inside the fiscal year; for a county it is the unincorporated area its report covers (the rule is under the table). ",
      el("strong", { text: "Units per 1,000 residents" }), " and ", el("strong", { text: "Fees per resident" }),
      " divide by it. The plain median counts every agency year once, so a town of 2,000 weighs as much as Los Angeles. The ",
      el("strong", { text: "median weighted by population" }),
      " counts each agency year by its residents: half the residents counted live in agency years at or below it. The tiles for units per 1,000 residents and fees per resident divide all units, or all fees, by all residents of the agency years counted, so each place weighs by its size; units count there only from years fully reported."),
    districted(ctx) ? el("p", { class: "district-callout", text: `${ctx.districtCaveat()} Units, fees and residents here are each agency's whole totals, not the part inside a district.` }) : null,
    el("div", { class: "tiles" },
      ctx.tile(districted(ctx) ? "Units permitted, whole agencies" : "Units permitted", fmtInt(sum(scope, "units")), fys.length ? `FY ${fmtFy(fys[0])} to ${fmtFy(fys[fys.length - 1])}, including years not fully reported` : ""),
      ctx.tile("Agency years with units and fees", fmtInt(both.length), `${fmtInt(comparable.length)} with fees per unit`),
      ctx.tile("Median fees per unit", med == null ? "None" : fmtSum(med), `over ${fmtInt(comparable.length)} agency years, each counted once`),
      ctx.tile("Median weighted by population", wmed == null ? "None" : fmtSum(wmed), weighed.length ? `fees per unit over ${fmtInt(weighed.length)} agency years, each counted by its residents` : ""),
      ctx.tile("Units per 1,000 residents", unitsPer1k ? fmtRate(unitsPer1k.value) : "None", unitsPer1k ? `a year, over ${fmtInt(unitsPer1k.rows)} agency years fully reported` : ""),
      ctx.tile("Fees per resident", feesPerRes ? fmtCents(feesPerRes.value) : "None", feesPerRes ? `a year, over ${fmtInt(feesPerRes.rows)} agency years with fees` : ""),
      ctx.tile("APR jurisdictions matched", `${fmtInt(matched)} of ${fmtInt(apr.jurisdictions.length)}`, "to a city or county on the roster")),
    ...scatter(list, ps, ctx),
    ...permitsTable(ps.off ? list.filter(OFF_CHART[ps.off].test) : list, ps, ctx),
    unmatchedNote(apr),
    sourceNote(apr),
    populationNote(apr, rows),
  ];
  view.append(...parts.filter(Boolean));
}

// ------------------------------------------------------------ scatter

const W = 760;
const H = 380;
const M = { top: 16, right: 18, bottom: 44, left: 70 };
const HIT_PX = 24;

function compact(v) {
  for (const [d, s] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]]) {
    if (v >= d) return `${Number((v / d).toFixed(v / d < 10 ? 1 : 0))}${s}`;
  }
  return String(Math.round(v));
}

function catText(r) {
  return UNIT_CATS.map((c, i) => [c, r.cats[i]]).filter(([, n]) => n > 0).map(([c, n]) => `${c} ${fmtInt(n)}`).join(", ");
}

const unitsText = (n) => `${fmtInt(n)} unit${n === 1 ? "" : "s"}`;

const fysText = (fys) => (fys.length === 1 ? `FY ${fmtFy(fys[0])}` : `${fmtInt(fys.length)} full years from FY ${fmtFy(fys[0])} to ${fmtFy(fys[fys.length - 1])}`);

function tipFor(p) {
  const cats = catText(p);
  return [
    el("strong", { text: p.name }),
    el("div", { text: fysText(p.fys) }),
    el("div", { text: `${fmtSum(p.perUnit)} per unit` }),
    el("div", { text: `${fmtRate(p.unitsPer1k)} units a year per 1,000 residents` }),
    el("div", { text: `${unitsText(p.units)} permitted${cats ? ` (${cats})` : ""}` }),
    p.dr ? el("div", { text: `${fmtInt(p.dr)} deed restricted` }) : null,
    el("div", { text: `Fees ${fmtUsd(p.fees)}` }),
    el("div", { text: `${p.fys.length > 1 ? "Average population" : "Population"} ${fmtInt(Math.round(p.pop))}` }),
  ].filter(Boolean);
}

function describe(p) {
  return `${p.name}, ${fysText(p.fys)}: ${fmtSum(p.perUnit)} per unit, ${fmtRate(p.unitsPer1k)} units a year per 1,000 residents, ${unitsText(p.units)}, fees ${fmtUsd(p.fees)}.`;
}

// A tick at a power of ten: one and up as compact() prints them, below one
// as a decimal (0.1, 0.01).
const tickText = (v) => (v >= 1 ? compact(v) : String(Number(v.toPrecision(1))));

// Filters the table to one kind of agency year the chart leaves out, or to all
// of them with "". The chart and its counts stay as they are. Filtering moves
// to the list, with focus on its way back; undoing returns to the count. The
// browser's Back button also undoes it.
function setOff(ps, ctx, key) {
  const was = ps.off;
  ps.off = key;
  ps.page = 1;
  ctx.update({ push: true });
  if (key) {
    document.getElementById("permits-list")?.scrollIntoView({ block: "start" });
    document.querySelector(".permits-off .btn")?.focus({ preventScroll: true });
  } else {
    document.querySelector(`[data-off="${was}"]`)?.focus();
  }
}

// Every count is a button; a count still shows at zero while it is the filter
// (another filter can empty it), so it can be turned off where it was turned on.
function offChartNote(list, ps, ctx) {
  const items = Object.entries(OFF_CHART).map(([key, o]) => {
    const n = list.filter(o.test).length;
    const pressed = ps.off === key;
    if (!n && !pressed) return null;
    return el("button", {
      class: "link-btn", type: "button", "data-off": key, "aria-pressed": String(pressed),
      text: `${fmtInt(n)} agency year${n === 1 ? "" : "s"} ${o.text}`,
      onclick: () => setOff(ps, ctx, pressed ? "" : key),
    });
  }).filter(Boolean);
  if (!items.length) return null;
  return el("div", { class: "note permits-off-note" },
    "Not on the chart:",
    el("ul", {}, items.map((b) => el("li", {}, b))),
    "Select a count to list only those years in the table; select it again to list every year.");
}

function scatter(list, ps, ctx) {
  const pts = chartPoints(list);
  const heading = el("h3", { class: "section-label", text: "Fees per unit and units per 1,000 residents by jurisdiction" });
  const left = offChartNote(list, ps, ctx);
  if (!pts.length) {
    return [heading, el("p", { class: "muted", text: "No jurisdiction here has fees per unit and a population to plot." }), left];
  }
  const log = Math.log10;
  const bounds = (vals) => {
    let lo = Math.floor(log(Math.min(...vals)));
    let hi = Math.ceil(log(Math.max(...vals)));
    if (hi === lo) hi += 1;
    return [lo, hi];
  };
  const [x0, x1] = bounds(pts.map((p) => p.unitsPer1k));
  const [y0, y1] = bounds(pts.map((p) => p.perUnit));
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const XL = (l) => M.left + ((l - x0) / (x1 - x0)) * iw;
  const YL = (l) => M.top + ih - ((l - y0) / (y1 - y0)) * ih;
  const root = svg("svg", {
    class: "chart permits-chart", viewBox: `0 0 ${W} ${H}`, role: "group",
    "aria-label": `Units permitted a year per 1,000 residents against fees collected per unit for ${fmtInt(pts.length)} jurisdiction${pts.length === 1 ? "" : "s"}, both on logarithmic scales`,
  });
  for (let k = x0; k <= x1; k += 1) {
    root.append(
      svg("line", { class: "grid-line", x1: XL(k), x2: XL(k), y1: M.top, y2: M.top + ih }),
      svg("text", { class: "tick", x: XL(k), y: M.top + ih + 14, "text-anchor": "middle", text: tickText(10 ** k) }),
    );
  }
  for (let k = y0; k <= y1; k += 1) {
    root.append(
      svg("line", { class: "grid-line", x1: M.left, x2: M.left + iw, y1: YL(k), y2: YL(k) }),
      svg("text", { class: "tick", x: M.left - 6, y: YL(k) + 3, "text-anchor": "end", text: `$${tickText(10 ** k)}` }),
    );
  }
  root.append(
    svg("line", { class: "axis", x1: M.left, x2: M.left + iw, y1: M.top + ih, y2: M.top + ih }),
    svg("line", { class: "axis", x1: M.left, x2: M.left, y1: M.top, y2: M.top + ih }),
    svg("text", { class: "axis-title", x: M.left + iw / 2, y: H - 6, "text-anchor": "middle", text: "Units permitted a year per 1,000 residents" }),
    svg("text", {
      class: "axis-title", x: 0, y: 0, "text-anchor": "middle",
      transform: `translate(14 ${M.top + ih / 2}) rotate(-90)`, text: "Fees collected per unit",
    }),
  );
  // The medians of the dots as flat lines, the weighted one counting each
  // jurisdiction by its residents. The legend names the lines and their values;
  // a label inside the plot would sit on the densest points.
  const med = median(pts.map((p) => p.perUnit));
  const wmed = weightedMedian(pts.map((p) => [p.perUnit, p.pop]));
  for (const [m, cls] of [[med, "median"], [wmed, "median weighted"]]) {
    root.append(svg("line", { class: cls, x1: M.left, x2: M.left + iw, y1: YL(log(m)), y2: YL(log(m)) }));
  }
  const dots = pts.map((r) => {
    const x = XL(log(r.unitsPer1k));
    const y = YL(log(r.perUnit));
    return { r, x, y, node: svg("circle", { class: "pt", cx: x.toFixed(1), cy: y.toFixed(1), r: 4 }) };
  });
  root.append(...dots.map((d) => d.node));
  const nav = [...dots].sort((a, b) => a.r.unitsPer1k - b.r.unitsPer1k || a.r.perUnit - b.r.perUnit || a.r.name.localeCompare(b.r.name));
  const live = el("p", { class: "permits-live", "aria-live": "polite" });
  const hit = svg("rect", {
    class: "hit", x: M.left - 8, y: M.top - 8, width: iw + 16, height: ih + 16, tabindex: 0,
    "aria-label": "Jurisdictions plotted. Arrow keys move from point to point, Enter opens the jurisdiction, Escape hides the details.",
  });
  root.append(hit);
  let active = null;
  let at = -1;
  const on = (d, ev) => {
    if (active && active !== d) active.node.classList.remove("on");
    active = d;
    d.node.classList.add("on");
    root.insertBefore(d.node, hit);
    ctx.showTooltip(ev || { target: d.node }, tipFor(d.r));
  };
  const off = () => {
    if (active) active.node.classList.remove("on");
    active = null;
    ctx.hideTooltip();
  };
  const nearest = (ev) => {
    const box = root.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const sx = box.width / W;
    const sy = box.height / H;
    const px = (ev.clientX - box.left) / sx;
    const py = (ev.clientY - box.top) / sy;
    let best = null;
    let bd = Infinity;
    for (const d of dots) {
      const dx = (d.x - px) * sx;
      const dy = (d.y - py) * sy;
      const dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = d; }
    }
    return bd <= HIT_PX * HIT_PX ? best : null;
  };
  const step = (i) => {
    at = Math.max(0, Math.min(nav.length - 1, i));
    on(nav[at], null);
    live.textContent = describe(nav[at].r);
  };
  hit.addEventListener("pointermove", (ev) => {
    const d = nearest(ev);
    if (d) on(d, ev);
    else off();
  });
  hit.addEventListener("pointerleave", off);
  hit.addEventListener("click", (ev) => {
    const d = nearest(ev);
    if (!d) return;
    // A tap shows the details first; a second tap opens the jurisdiction.
    if (ev.pointerType === "touch" && active !== d) {
      ev.stopPropagation();
      on(d, ev);
      return;
    }
    if (d.r.entity) ctx.openEntity(d.r.entity);
  });
  hit.addEventListener("focus", () => step(at < 0 ? 0 : at));
  hit.addEventListener("blur", off);
  hit.addEventListener("keydown", (ev) => {
    const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    if (move) step(at + move);
    else if (ev.key === "Home") step(0);
    else if (ev.key === "End") step(nav.length - 1);
    else if (ev.key === "Enter" && active?.r.entity) ctx.openEntity(active.r.entity);
    else if (ev.key === "Escape") off();
    else return;
    ev.preventDefault();
  });
  const legendLine = (m, cls, text) => el("span", { class: "permits-key" },
    svg("svg", { width: 20, height: 12, viewBox: "0 0 20 12", "aria-hidden": "true" }, svg("line", { class: cls, x1: 1, x2: 19, y1: 6, y2: 6 })),
    `${text}, ${fmtSum(m)}`);
  return [
    heading,
    el("div", { class: "permits-legend" },
      legendLine(med, "median", "Median jurisdiction"),
      legendLine(wmed, "median weighted", "Weighted by population")),
    el("div", { class: "chart-wrap" }, root),
    live,
    el("p", {
      class: "note",
      text: "Each dot combines a jurisdiction's full years with fees and units above zero: all its fees over all its units, and all its units over all its residents, so a slow permit year does not read as an expensive one. With fiscal years chosen, a dot combines only those years. Fees are what the agency collected, not what it charges. The lines are the medians of the dots, so they differ from the tiles, which count agency years. " + COUNTY_NOTE,
    }),
    left,
  ];
}

// ------------------------------------------------------------ table

// The columns of one agency year, in the tab's table and on a jurisdiction's page.
const YEAR_COLUMNS = [
  ["FY", "fy", ""],
  ["Units permitted", "units", "num"],
  ["Deed restricted", "dr", "num"],
  ["Permit records", "records", "num"],
  ["Entitled", "ent", "num"],
  ["Completed", "co", "num"],
  ["Fees collected", "fees", "num"],
  ["Fees per unit", "perUnit", "num"],
  ["Population", "pop", "num"],
  ["Units per 1,000 residents", "unitsPer1k", "num"],
  ["Fees per resident", "feesPerRes", "num"],
  ["Coverage", "cov", ""],
];

function yearCells(r) {
  const num = (v, fmt = fmtInt) => el("td", { class: "num", text: v == null ? "" : fmt(v) });
  const flags = [r.feeNames > 1 ? "fees under two release names" : "", r.agency ? "" : "no roster match"].filter(Boolean);
  return [
    el("td", { class: "permits-fy", text: fmtFy(r.fy) }),
    el("td", { class: "num", title: catText(r) || null, text: r.units == null ? "" : fmtInt(r.units) }),
    num(r.dr),
    num(r.records),
    num(r.ent),
    num(r.co),
    num(r.fees, fmtSum),
    num(r.perUnit, fmtSum),
    el("td", { class: "num", title: popTitle(r), text: r.pop == null ? "" : fmtInt(r.pop) }),
    num(r.unitsPer1k, fmtRate),
    num(r.feesPerRes, fmtCents),
    el("td", { class: "permits-cov", title: COV_TEXT[r.cov] },
      COV_SHORT[r.cov],
      flags.length ? el("span", { class: "permits-flag", text: flags.join("; ") }) : null),
  ];
}

function permitsTable(list, ps, ctx) {
  const sorted = sortPermitRows(list, ps.sort);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  if (ps.page > pages) ps.page = pages;
  const start = (ps.page - 1) * PAGE;
  // Units and fees stay whole-agency totals when a district filter is on.
  const whole = districted(ctx);
  const onSort = (c) => { ps.sort = ctx.toggleSort(ps.sort, c, NUMERIC.has(c)); ps.page = 1; ctx.update(); };
  const h = (label, col, cls = "", spec = null) => ctx.sortHeader(label, col, ps.sort, onSort, cls, spec);
  const body = el("tbody", {}, sorted.slice(start, start + PAGE).map((r) => el("tr", {},
    el("td", { class: "col-entity" }, r.entity
      ? el("a", {
        href: ctx.entityHref(r.entity), title: `APR name ${r.juris}; open ${r.entity} in the release`, text: r.name,
        onclick: (ev) => { ev.preventDefault(); ctx.openEntity(r.entity); },
      })
      : el("span", { title: `APR name ${r.juris}`, text: r.name })),
    el("td", { text: r.county || "" }),
    yearCells(r))));
  if (!sorted.length) body.append(el("tr", { class: "empty-row" }, el("td", { colspan: 14, text: "No agency year matches." })));
  const page = (n) => () => {
    ps.page = n;
    ctx.update();
    document.getElementById("permits-list")?.scrollIntoView({ block: "start" });
  };
  return [
    el("h3", { class: "section-label", id: "permits-list", text: "By agency and fiscal year" }),
    el("div", { class: "result-bar" },
      el("span", {}, el("strong", { text: fmtInt(sorted.length) }), ` agency year${sorted.length === 1 ? "" : "s"}`),
      el("span", {}, whole ? "whole-agency units " : "units ", el("strong", { text: fmtInt(sum(sorted, "units")) })),
      el("span", {}, whole ? "whole-agency fees " : "fees ", el("strong", { text: fmtSum(sum(sorted, "fees")) })),
      el("span", { class: "active-filters" }, filterTags(ctx)),
      ctx.districtNote?.() || null,
      ps.off ? el("span", { class: "permits-off" },
        `only those ${OFF_CHART[ps.off].text}`,
        el("button", { class: "btn", type: "button", text: "Show all agency years", onclick: () => setOff(ps, ctx, "") })) : null),
    el("div", { class: "table-scroll" }, el("table", { class: "grid permits-list" },
      el("thead", {}, el("tr", {},
        h("Jurisdiction", "name", "col-entity"),
        h("County", "county", "", boxSpec(ctx, "county")),
        YEAR_COLUMNS.map(([label, col, cls]) => h(label, col, cls, col === "fy" ? boxSpec(ctx, "fy") : null)))),
      body)),
    el("div", { class: "pager" },
      el("button", { class: "btn", type: "button", text: "Prev", disabled: ps.page <= 1, onclick: page(ps.page - 1) }),
      el("span", { class: "muted", text: `page ${ps.page} of ${pages}` }),
      el("button", { class: "btn", type: "button", text: "Next", disabled: ps.page >= pages, onclick: page(ps.page + 1) })),
  ];
}

// ------------------------------------------------------------ a jurisdiction's page

// The types a city's or county's own release name carries. A district the
// roster lists under a city keeps its own page, with no permits on it.
const JURISDICTION_TYPES = new Set(["city", "town", "incorporated_city_or_town", "county", "city_and_county"]);

// One jurisdiction's agency years under any of its release names, oldest first.
export function entityPermitRows(rows, name) {
  return rows.filter((r) => r.releaseNames.includes(name)).sort((a, b) => a.fy.localeCompare(b.fy));
}

// The heading, tiles, table and note for a release name; nothing when no
// agency year joins it. The ratios are the jurisdiction's dot on the tab's
// chart, beside the medians of every dot with no filter on.
function entityPermits(name, ctx) {
  const rows = permitRows(ctx);
  const years = entityPermitRows(rows, name);
  if (!years.length) return [];
  const every = chartPoints(rows);
  const [dot] = chartPoints(years);
  const listed = years.filter((r) => r.units != null);
  const units = sum(listed, "units");
  const dr = sum(listed, "dr");
  const over = dot ? `${fmtInt(dot.fys.length)} full year${dot.fys.length === 1 ? "" : "s"}` : "";
  const noDot = loaded.population ? "no full year with fees, units and residents above zero" : "population did not load";
  const names = years[0].releaseNames.filter((n) => ctx.model.entityByName.has(n));
  const nameLink = (n) => (n === name ? n : el("a", {
    href: ctx.entityHref(n), text: n,
    onclick: (ev) => { ev.preventDefault(); ctx.openEntity(n); },
  }));
  return [
    el("h3", { class: "section-label", text: "Permits" }),
    el("div", { class: "tiles" },
      ctx.tile("Units permitted", listed.length ? fmtInt(units) : "None", listed.length
        ? `FY ${fmtFy(listed[0].fy)} to ${fmtFy(listed[listed.length - 1].fy)}${listed.some((r) => r.cov !== "full") ? ", including years not fully reported" : ""}`
        : ""),
      ctx.tile("Deed restricted", listed.length ? fmtInt(dr) : "None", units > 0 ? `${Math.round((dr / units) * 100)}% of units permitted` : ""),
      ctx.tile("Fees per unit", dot ? fmtSum(dot.perUnit) : "None", dot ? `over ${over}; median jurisdiction ${fmtSum(median(every.map((p) => p.perUnit)))}` : noDot),
      ctx.tile("Units per 1,000 residents", dot ? fmtRate(dot.unitsPer1k) : "None", dot ? `a year, over ${over}; median jurisdiction ${fmtRate(median(every.map((p) => p.unitsPer1k)))}` : noDot)),
    el("div", { class: "table-scroll" }, el("table", { class: "grid permits-list" },
      el("thead", {}, el("tr", {}, YEAR_COLUMNS.map(([label, , cls]) => el("th", { class: cls || null, scope: "col", text: label })))),
      el("tbody", {}, years.map((r) => el("tr", {}, yearCells(r)))))),
    el("p", { class: "note" },
      "Units are the building permits the agency lists in Table A2 of its Housing Element Annual Progress Reports to HCD, in the fiscal year of each issue date. Fees are what the release reports it collected that year, not what it charges, from figures that report a July to June year. Fees per unit and units per 1,000 residents combine its full years with fees and units above zero, as its dot on the Permits chart does. In a year not fully reported, a column with nothing listed is blank: missing, not zero. ",
      years[0].type === "county" ? `${COUNTY_NOTE} ` : "",
      names.length > 1 ? ["Fees count every release name of this agency: ", joinParts(names.map(nameLink), ", "), ". "] : "",
      loaded.population ? "" : `Population did not load (${loaded.popError}), so the per resident figures are blank. `,
      "The ",
      el("a", { href: ctx.permitsHref(), text: "Permits tab", onclick: (ev) => { ev.preventDefault(); ctx.openPermits(); } }),
      " explains the counts and plots every jurisdiction."),
  ];
}

// Fills box on a jurisdiction's page, loading the tab's files the first time.
export function renderEntityPermits(box, entity, ctx) {
  if (!JURISDICTION_TYPES.has(entity.type)) return;
  const draw = () => box.replaceChildren(...entityPermits(entity.name, ctx));
  if (loaded) {
    draw();
    return;
  }
  const heading = el("h3", { class: "section-label", text: "Permits" });
  box.append(heading, el("p", { class: "muted", text: "Loading permits…" }));
  loadPermits(ctx).then(() => {
    if (box.isConnected) draw();
  }).catch((err) => {
    if (box.isConnected) box.replaceChildren(heading, el("p", { class: "muted", text: `Failed to load permits: ${err.message}` }));
  });
}

// ------------------------------------------------------------ notes

function unmatchedNote(apr) {
  const list = apr.unmatched || [];
  if (!list.length) return null;
  return el("p", { class: "note" },
    "APR names with no city or county on the roster, listed under the APR name with no fees beside them: ",
    list.map((u) => {
      const open = u.unmatched_roster_in_county || [];
      return `${titleCase(u.juris_name)}, ${u.county} County${open.length ? ` (roster agencies there with no APR match: ${open.join(", ")})` : ""}`;
    }).join("; "), ".");
}

function sourceNote(apr) {
  const s = apr.source || {};
  const link = /^https:\/\//.test(s.dataset_url || "")
    ? el("a", { href: s.dataset_url, target: "_blank", rel: "noopener", text: `${s.publisher}, ${s.title}` })
    : `${s.publisher || ""}, ${s.title || ""}`;
  const facts = [
    s.table,
    s.file_bytes ? fmtBytes(s.file_bytes) : "",
    s.records ? `${fmtInt(s.records)} rows` : "",
    s.last_modified ? `updated ${String(s.last_modified).slice(0, 10)}` : "",
  ].filter(Boolean).join(", ");
  return el("p", { class: "note" },
    "Source: ", link, `${facts ? ` (${facts}` : ""}${s.file_sha256 ? `; SHA-256 ${s.file_sha256}` : ""}${facts ? ")" : ""}. `,
    apr.rule || "");
}

// Parts (strings or nodes) with sep between them.
const joinParts = (parts, sep) => parts.filter(Boolean).flatMap((p, i) => (i ? [sep, p] : [p]));

// The title of a population cell: the DOF row and the January it is from.
function popTitle(r) {
  const info = loaded?.population?.info(r.juris, r.aprCounty);
  if (!info) return "No population estimate for this jurisdiction";
  const date = fyEstimateDate(r.fy);
  const when = date ? `January 1, ${date.slice(0, 4)}` : "";
  return r.pop == null ? `${info.dofName}: no estimate for ${when}` : `${info.dofName}, Department of Finance estimate for ${when}`;
}

// The population sources and rule, every APR jurisdiction or fiscal year
// left without an estimate, and the DOF rows no APR jurisdiction took.
function populationNote(apr, rows) {
  const d = loaded.population;
  if (!d) return el("p", { class: "note", text: `Population did not load (${loaded.popError}), so the per resident figures are blank.` });
  const dates = d.estimate_dates || [];
  const sources = (d.sources || []).map((s, i) => {
    const years = dates.filter((_, k) => (d.estimate_source || [])[k] === i).map((x) => x.slice(0, 4));
    const title = `${s.publisher || ""}, ${s.title || ""}`;
    const facts = joinParts([
      /^https:\/\//.test(s.file_url || "") ? el("a", { href: s.file_url, target: "_blank", rel: "noopener", text: s.file_url.split("/").pop() }) : "",
      s.file_bytes ? fmtBytes(s.file_bytes) : "",
      s.released ? `released ${s.released}` : "",
      s.last_modified ? `updated ${s.last_modified}` : "",
      years.length ? `used for January 1, ${years[0]}${years.length > 1 ? ` to ${years[years.length - 1]}` : ""}` : "",
    ], ", ");
    return [
      /^https:\/\//.test(s.page_url || "") ? el("a", { href: s.page_url, target: "_blank", rel: "noopener", text: title }) : title,
      facts.length ? [" (", ...facts, s.file_sha256 ? `; SHA-256 ${s.file_sha256}` : "", ")"] : "",
    ];
  });
  const fys = [...new Set(rows.map((r) => r.fy))].sort();
  const known = new Set(d.fiscal_years || []);
  const none = apr.jurisdictions.filter((j) => !d.info(j.juris, j.county));
  const noYear = fys.filter((fy) => !known.has(fy));
  const holes = (d.rows || []).filter((r) => r[4].some((v) => v == null));
  const missing = [
    none.length ? `APR jurisdictions with no population estimate, so no per resident figures: ${none.map((j) => `${titleCase(j.juris)} (${j.county})`).join("; ")}.` : "",
    noYear.length ? `No estimate for FY ${noYear.map(fmtFy).join(", ")}.` : "",
    holes.length ? `Missing a January estimate: ${holes.map((r) => `${titleCase(r[0])} (${r[1]}), FY ${(d.fiscal_years || []).filter((_, i) => r[4][i] == null).map(fmtFy).join(", ")}`).join("; ")}.` : "",
  ].filter(Boolean);
  const unused = d.unused || [];
  return el("p", { class: "note" },
    "Population: ", joinParts(sources, "; "), ". ",
    d.rule || "", " ",
    missing.length ? missing.join(" ") : "Every APR jurisdiction has an estimate for every fiscal year.",
    unused.length ? ` Department of Finance rows no APR jurisdiction takes: ${unused.map((u) => `${u.name} (${u.county})`).join(", ")}.` : "");
}
