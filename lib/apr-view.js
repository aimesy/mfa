// Permits tab: the units each city and county permitted by fiscal year, from
// Table A2 of the Housing Element Annual Progress Reports (APRs) HCD
// publishes, beside the fees the release reports the agency collected that
// year. apr/apr.json in this repository holds the counts (scripts/apr.mjs
// writes it); it loads the first time the tab opens, with coverage.json's
// roster for the release names of each agency. A scatter of units against
// fees for each agency year sits above a table to sort and page. Every string
// reaches the page through el() and svg(), so through textContent or
// attributes.
//
// app.js passes ctx with exactly these app.js values and functions:
//   model         the release model (buildModel: entities, entityByName)
//   state         the app state object; this tab keeps its own filters,
//                 sort and page in state.permits (emptyPermitsState())
//   update        update(): writes the URL and renders
//   loadCoverage  loadCoverage(): promise of the coverage.json roster
//   showTooltip, hideTooltip
//   entityHref, openEntity
//   sortHeader, toggleSort
//   tile, chip, select, searchInput
// URL parameters: pq, ptype, pcounty, pfy, pshow, psort, ppage
// (readPermitsState and permitsParams).

import { el, svg } from "./dom.js";
import { fmtUsd, fmtSum, fmtInt, fmtFy, fmtBytes, searchTerms } from "./model.js";
import { UNIT_CATS, readApr, joinPermits, median, titleCase, fyLabel } from "./apr.js";

export const APR_URL = "apr/apr.json";
const PAGE = 100;
const ROSTER_TYPES = new Set(["city", "county", "city_and_county"]);
const TYPES = [["", "All"], ["city", "City"], ["county", "County"], ["city_and_county", "City and county"]];
const SHOWS = [["", "Years with units and fees"], ["comparable", "Years with fees per unit"], ["all", "Every year"]];
const SORTS = ["name", "county", "fy", "units", "dr", "records", "ent", "co", "fees", "perUnit", "cov"];
const NUMERIC = new Set(["units", "dr", "records", "ent", "co", "fees", "perUnit"]);
export const DEFAULT_PERMITS_SORT = Object.freeze({ col: "name", dir: "asc" });
const COV_ORDER = { full: 0, partial: 1, none: 2 };
const COV_SHORT = { full: "Full", partial: "Partial", none: "Later reports only" };
const COV_TEXT = {
  full: "Both calendar year reports in hand",
  partial: "One of its two calendar year reports in hand; counts may be short",
  none: "No report for either calendar year; counts are what later reports list",
};

// ------------------------------------------------------------ state

export function emptyPermitsState() {
  return { q: "", type: "", county: "", fy: "", show: "", sort: { ...DEFAULT_PERMITS_SORT }, page: 1 };
}

export function readPermitsState(params) {
  const [col, dir] = String(params.get("psort") || "").split(".");
  const type = params.get("ptype") || "";
  const show = params.get("pshow") || "";
  const fy = params.get("pfy") || "";
  return {
    q: params.get("pq") || "",
    type: TYPES.some(([k]) => k && k === type) ? type : "",
    county: params.get("pcounty") || "",
    fy: /^\d{4}-\d{2}$/.test(fy) ? fy : "",
    show: SHOWS.some(([k]) => k && k === show) ? show : "",
    sort: SORTS.includes(col) && (dir === "asc" || dir === "desc") ? { col, dir } : { ...DEFAULT_PERMITS_SORT },
    page: Math.max(1, Number.parseInt(params.get("ppage"), 10) || 1),
  };
}

// put(k, v) sets k only when v is truthy, as in app.js stateParams.
export function permitsParams(ps, put) {
  put("pq", ps.q); put("ptype", ps.type); put("pcounty", ps.county); put("pfy", ps.fy); put("pshow", ps.show);
  const s = ps.sort;
  put("psort", s.col === DEFAULT_PERMITS_SORT.col && s.dir === DEFAULT_PERMITS_SORT.dir ? "" : `${s.col}.${s.dir}`);
  put("ppage", ps.page > 1 ? String(ps.page) : "");
}

// What app.js adds to its contentKey for this tab.
export function permitsKey(ps) {
  return ps ? [ps.q, ps.type, ps.county, ps.fy, ps.show, ps.sort.col, ps.sort.dir, ps.page] : [];
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
    loadPromise = Promise.all([apr, ctx.loadCoverage()]).then(([a, cov]) => {
      loaded = { apr: a, agencies: cov.agencies.filter((x) => ROSTER_TYPES.has(x.type)) };
      return loaded;
    });
    loadPromise.catch(() => { loadPromise = null; });
  }
  return loadPromise;
}

// The join, once for each release model.
function permitRows(ctx) {
  if (joined.model !== ctx.model) {
    const rows = joinPermits(loaded.apr, loaded.agencies, ctx.model);
    for (const r of rows) r._search = `${r.name} ${r.juris} ${r.county} ${r.entity}`.toLowerCase();
    joined = { model: ctx.model, rows };
  }
  return joined.rows;
}

const BOTH = (r) => r.units != null && r.fees != null;
const SHOW_TEST = { "": BOTH, comparable: (r) => r.perUnit != null, all: () => true };

function filterRows(rows, ps) {
  const terms = searchTerms(ps.q);
  return rows.filter((r) => (!ps.type || r.type === ps.type) && (!ps.county || r.county === ps.county)
    && (!ps.fy || r.fy === ps.fy) && terms.every((t) => r._search.includes(t)));
}

const SORT_VALUE = {
  name: (r) => r.name, county: (r) => r.county, fy: (r) => r.fy, units: (r) => r.units, dr: (r) => r.dr,
  records: (r) => r.records, ent: (r) => r.ent, co: (r) => r.co, fees: (r) => r.fees, perUnit: (r) => r.perUnit,
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

// ------------------------------------------------------------ toolbar

function optionLists(ctx, ps) {
  if (!loaded) {
    return {
      counties: [["", "All"], ...(ps.county ? [[ps.county, ps.county]] : [])],
      fys: [["", "All"], ...(ps.fy ? [[ps.fy, fmtFy(ps.fy)]] : [])],
    };
  }
  const rows = permitRows(ctx);
  const counties = [...new Set(rows.map((r) => r.county).filter(Boolean))].sort();
  const fys = [...new Set(rows.map((r) => r.fy))].sort();
  return {
    counties: [["", "All"], ...counties.map((c) => [c, c])],
    fys: [["", "All"], ...fys.map((fy) => [fy, fmtFy(fy)])],
  };
}

function setOptions(id, options, value) {
  const s = document.getElementById(id);
  if (!s) return;
  s.replaceChildren(...options.map(([v, text]) => el("option", { value: v, text })));
  s.value = value;
}

function patchOptions(ctx) {
  const ps = permitsState(ctx);
  const o = optionLists(ctx, ps);
  setOptions("pcounty", o.counties, ps.county);
  setOptions("pfy", o.fys, ps.fy);
}

// The toolbar nodes for the tab; app.js appends them to #toolbar.
export function permitsToolbar(ctx) {
  const ps = permitsState(ctx);
  const set = (k) => (v) => { ps[k] = v; ps.page = 1; ctx.update(); };
  const o = optionLists(ctx, ps);
  if (!loaded) loadPermits(ctx).then(() => patchOptions(ctx)).catch(() => {});
  return [
    ctx.chip("Search", ctx.searchInput("pq", ps.q, "jurisdiction or county", set("q"))),
    ctx.chip("Type", ctx.select("ptype", TYPES, ps.type, set("type"))),
    ctx.chip("County", ctx.select("pcounty", o.counties, ps.county, set("county"))),
    ctx.chip("FY", ctx.select("pfy", o.fys, ps.fy, set("fy"))),
    ctx.chip("Show", ctx.select("pshow", SHOWS, ps.show, set("show"))),
    el("button", {
      class: "btn", type: "button", text: "Clear",
      onclick: () => { Object.assign(ps, emptyPermitsState()); syncPermitsToolbar(ctx.state); ctx.update(); },
    }),
  ];
}

// Called from app.js syncToolbar: the controls follow the state (back and
// forward, Clear), except the one being typed in.
export function syncPermitsToolbar(state) {
  const ps = state.permits;
  if (!ps) return;
  const set = (id, v) => {
    const n = document.getElementById(id);
    if (n && n !== document.activeElement && n.value !== v) n.value = v;
  };
  set("pq", ps.q); set("ptype", ps.type); set("pcounty", ps.county); set("pfy", ps.fy); set("pshow", ps.show);
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
    patchOptions(ctx);
    if (!view.isConnected) return;
    view.replaceChildren();
    fill(view, ctx);
  }).catch((err) => {
    if (view.isConnected) view.replaceChildren(el("p", { class: "muted", text: `Failed to load permits: ${err.message}` }));
  });
}

const sum = (list, k) => list.reduce((s, r) => s + (Number.isFinite(r[k]) ? r[k] : 0), 0);

function fill(view, ctx) {
  const ps = permitsState(ctx);
  const { apr } = loaded;
  const rows = permitRows(ctx);
  const scope = filterRows(rows, ps);
  const list = scope.filter(SHOW_TEST[ps.show] || BOTH);
  const both = scope.filter(BOTH);
  const comparable = scope.filter((r) => r.perUnit != null);
  const med = median(comparable.map((r) => r.perUnit));
  const fys = [...new Set(scope.filter((r) => r.units != null).map((r) => r.fy))].sort();
  const matched = apr.jurisdictions.filter((j) => j.agency).length;
  const firstReport = apr.report_years[0];
  view.append(
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
      " divides fees by units only for a full year with units above zero and fees under one release name."),
    el("div", { class: "tiles" },
      ctx.tile("Units permitted", fmtInt(sum(scope, "units")), fys.length ? `FY ${fmtFy(fys[0])} to ${fmtFy(fys[fys.length - 1])}, including years not fully reported` : ""),
      ctx.tile("Agency years with units and fees", fmtInt(both.length), `${fmtInt(comparable.length)} with fees per unit`),
      ctx.tile("Median fees per unit", med == null ? "None" : fmtSum(med), `over ${fmtInt(comparable.length)} agency years`),
      ctx.tile("APR jurisdictions matched", `${fmtInt(matched)} of ${fmtInt(apr.jurisdictions.length)}`, "to a city or county on the roster")),
    ...scatter(list, med, ctx),
    ...permitsTable(list, ps, ctx),
    unmatchedNote(apr),
    sourceNote(apr),
  );
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

function noPerUnit(r) {
  if (r.units == null || r.fees == null) return "No fees per unit: units or fees missing";
  if (r.cov !== "full") return "No fees per unit: a calendar year report is missing";
  if (r.feeNames > 1) return "No fees per unit: fees under two release names";
  if (!(r.units > 0)) return "No fees per unit: no units permitted";
  return "No fees per unit";
}

function tipFor(r) {
  const cats = catText(r);
  return [
    el("strong", { text: r.name }),
    el("div", { text: `FY ${fmtFy(r.fy)}` }),
    el("div", { text: r.units == null ? "Units not reported" : `${unitsText(r.units)} permitted${cats ? ` (${cats})` : ""}` }),
    r.dr ? el("div", { text: `${fmtInt(r.dr)} deed restricted` }) : null,
    el("div", { text: r.fees == null ? "No fees reported" : `Fees ${fmtUsd(r.fees)}` }),
    el("div", { text: r.perUnit != null ? `${fmtSum(r.perUnit)} per unit` : noPerUnit(r) }),
    el("div", { class: "muted", text: COV_TEXT[r.cov] }),
  ].filter(Boolean);
}

function describe(r) {
  return `${r.name}, FY ${fmtFy(r.fy)}: ${unitsText(r.units)}, fees ${fmtUsd(r.fees)}${r.perUnit != null ? `, ${fmtSum(r.perUnit)} per unit` : ""}.`;
}

function legendDot(cls) {
  return svg("svg", { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": "true" }, svg("circle", { class: `pt ${cls}`, cx: 6, cy: 6, r: 4 }));
}

function scatter(list, med, ctx) {
  const pts = list.filter((r) => r.units > 0 && r.fees > 0);
  const noUnits = list.filter((r) => r.units === 0 && r.fees != null).length;
  const noFees = list.filter((r) => r.units > 0 && r.fees != null && r.fees <= 0).length;
  const left = noUnits || noFees
    ? el("p", { class: "note" },
      `Not on the chart, whose scales are logarithmic: ${[
        noUnits ? `${fmtInt(noUnits)} agency year${noUnits === 1 ? "" : "s"} with fees and no units permitted` : "",
        noFees ? `${fmtInt(noFees)} with fees of zero or less` : "",
      ].filter(Boolean).join(", and ")}. The table lists them.`)
    : null;
  if (!pts.length) {
    return [el("p", { class: "muted", text: "No agency year here has both units and fees above zero to plot." }), left];
  }
  const log = Math.log10;
  const bounds = (vals) => {
    let lo = Math.floor(log(Math.min(...vals)));
    let hi = Math.ceil(log(Math.max(...vals)));
    if (hi === lo) hi += 1;
    return [lo, hi];
  };
  const [x0, x1] = bounds(pts.map((r) => r.units));
  const [y0, y1] = bounds(pts.map((r) => r.fees));
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const XL = (l) => M.left + ((l - x0) / (x1 - x0)) * iw;
  const YL = (l) => M.top + ih - ((l - y0) / (y1 - y0)) * ih;
  const root = svg("svg", {
    class: "chart permits-chart", viewBox: `0 0 ${W} ${H}`, role: "group",
    "aria-label": `Units permitted against fees collected for ${fmtInt(pts.length)} agency years, both on logarithmic scales`,
  });
  for (let k = x0; k <= x1; k += 1) {
    root.append(
      svg("line", { class: "grid-line", x1: XL(k), x2: XL(k), y1: M.top, y2: M.top + ih }),
      svg("text", { class: "tick", x: XL(k), y: M.top + ih + 14, "text-anchor": "middle", text: compact(10 ** k) }),
    );
  }
  for (let k = y0; k <= y1; k += 1) {
    root.append(
      svg("line", { class: "grid-line", x1: M.left, x2: M.left + iw, y1: YL(k), y2: YL(k) }),
      svg("text", { class: "tick", x: M.left - 6, y: YL(k) + 3, "text-anchor": "end", text: `$${compact(10 ** k)}` }),
    );
  }
  root.append(
    svg("line", { class: "axis", x1: M.left, x2: M.left + iw, y1: M.top + ih, y2: M.top + ih }),
    svg("line", { class: "axis", x1: M.left, x2: M.left, y1: M.top, y2: M.top + ih }),
    svg("text", { class: "axis-title", x: M.left + iw / 2, y: H - 6, "text-anchor": "middle", text: "Units permitted in the fiscal year" }),
    svg("text", {
      class: "axis-title", x: 0, y: 0, "text-anchor": "middle",
      transform: `translate(14 ${M.top + ih / 2}) rotate(-90)`, text: "Fees collected",
    }),
  );
  // The median fees per unit as a line: fees = median × units.
  if (med > 0) {
    const lm = log(med);
    const a = Math.max(x0, y0 - lm);
    const b = Math.min(x1, y1 - lm);
    // The legend names the line and its value; a label inside the plot would
    // sit on the densest points.
    if (b > a) root.append(svg("line", { class: "median", x1: XL(a), y1: YL(a + lm), x2: XL(b), y2: YL(b + lm) }));
  }
  // Points not comparable first, so the comparable ones sit on top.
  const dots = [...pts]
    .sort((a, b) => Number(a.perUnit != null) - Number(b.perUnit != null))
    .map((r) => {
      const x = XL(log(r.units));
      const y = YL(log(r.fees));
      return { r, x, y, node: svg("circle", { class: `pt ${r.perUnit != null ? "cmp" : "alt"}`, cx: x.toFixed(1), cy: y.toFixed(1), r: 4 }) };
    });
  root.append(...dots.map((d) => d.node));
  const nav = [...dots].sort((a, b) => a.r.units - b.r.units || a.r.fees - b.r.fees || a.r.name.localeCompare(b.r.name));
  const live = el("p", { class: "permits-live", "aria-live": "polite" });
  const hit = svg("rect", {
    class: "hit", x: M.left - 8, y: M.top - 8, width: iw + 16, height: ih + 16, tabindex: 0,
    "aria-label": "Agency years plotted. Arrow keys move from point to point, Enter opens the jurisdiction, Escape hides the details.",
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
  return [
    el("h3", { class: "section-label", text: "Units and fees by agency year" }),
    el("div", { class: "permits-legend" },
      el("span", { class: "permits-key" }, legendDot("cmp"), "Fees per unit computed"),
      el("span", { class: "permits-key" }, legendDot("alt"), "Year not fully reported, or fees under two release names"),
      med > 0 ? el("span", { class: "permits-key" },
        svg("svg", { width: 20, height: 12, viewBox: "0 0 20 12", "aria-hidden": "true" }, svg("line", { class: "median", x1: 1, x2: 19, y1: 6, y2: 6 })),
        `Median fees per unit, ${fmtSum(med)}`) : null),
    el("div", { class: "chart-wrap" }, root),
    live,
    left,
  ];
}

// ------------------------------------------------------------ table

function permitsTable(list, ps, ctx) {
  const sorted = sortPermitRows(list, ps.sort);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  if (ps.page > pages) ps.page = pages;
  const start = (ps.page - 1) * PAGE;
  const onSort = (c) => { ps.sort = ctx.toggleSort(ps.sort, c, NUMERIC.has(c)); ps.page = 1; ctx.update(); };
  const h = (label, col, cls = "") => ctx.sortHeader(label, col, ps.sort, onSort, cls);
  const num = (v, fmt = fmtInt) => el("td", { class: "num", text: v == null ? "" : fmt(v) });
  const body = el("tbody", {}, sorted.slice(start, start + PAGE).map((r) => {
    const flags = [r.feeNames > 1 ? "fees under two release names" : "", r.agency ? "" : "no roster match"].filter(Boolean);
    return el("tr", {},
      el("td", { class: "col-entity" }, r.entity
        ? el("a", {
          href: ctx.entityHref(r.entity), title: `APR name ${r.juris}; open ${r.entity} in the release`, text: r.name,
          onclick: (ev) => { ev.preventDefault(); ctx.openEntity(r.entity); },
        })
        : el("span", { title: `APR name ${r.juris}`, text: r.name })),
      el("td", { text: r.county || "" }),
      el("td", { class: "permits-fy", text: fmtFy(r.fy) }),
      el("td", { class: "num", title: catText(r) || null, text: r.units == null ? "" : fmtInt(r.units) }),
      num(r.dr),
      num(r.records),
      num(r.ent),
      num(r.co),
      num(r.fees, fmtSum),
      num(r.perUnit, fmtSum),
      el("td", { class: "permits-cov", title: COV_TEXT[r.cov] },
        COV_SHORT[r.cov],
        flags.length ? el("span", { class: "permits-flag", text: flags.join("; ") }) : null));
  }));
  if (!sorted.length) body.append(el("tr", { class: "empty-row" }, el("td", { colspan: 11, text: "No agency year matches." })));
  const page = (n) => () => {
    ps.page = n;
    ctx.update();
    document.getElementById("permits-list")?.scrollIntoView({ block: "start" });
  };
  return [
    el("h3", { class: "section-label", id: "permits-list", text: "By agency and fiscal year" }),
    el("div", { class: "result-bar" },
      el("span", {}, el("strong", { text: fmtInt(sorted.length) }), ` agency year${sorted.length === 1 ? "" : "s"}`),
      el("span", {}, "units ", el("strong", { text: fmtInt(sum(sorted, "units")) })),
      el("span", {}, "fees ", el("strong", { text: fmtSum(sum(sorted, "fees")) }))),
    el("div", { class: "table-scroll" }, el("table", { class: "grid permits-list" },
      el("thead", {}, el("tr", {},
        h("Jurisdiction", "name", "col-entity"),
        h("County", "county"),
        h("FY", "fy"),
        h("Units permitted", "units", "num"),
        h("Deed restricted", "dr", "num"),
        h("Permit records", "records", "num"),
        h("Entitled", "ent", "num"),
        h("Completed", "co", "num"),
        h("Fees collected", "fees", "num"),
        h("Fees per unit", "perUnit", "num"),
        h("Coverage", "cov"))),
      body)),
    el("div", { class: "pager" },
      el("button", { class: "btn", type: "button", text: "Prev", disabled: ps.page <= 1, onclick: page(ps.page - 1) }),
      el("span", { class: "muted", text: `page ${ps.page} of ${pages}` }),
      el("button", { class: "btn", type: "button", text: "Next", disabled: ps.page >= pages, onclick: page(ps.page + 1) })),
  ];
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
