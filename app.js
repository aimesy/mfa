// mfa-data viewer. Reads the release's own files (the CSV, the source index
// and, on demand, the manifest and evidence PDFs) from the aimesy/mfa-data
// repository at one commit, through the Worker at mfa-data.amyc.us (the
// repository is private; see worker/), and shows every published figure
// beside the page it was read from.
//
// Pattern follows aimesy/tentatives: static page, URL-driven state so any view
// is a permalink, chip toolbar, table plus detail panel. The difference is the
// unit: a printed figure with an outline on a page, so the detail panel is an
// evidence viewer, sums add primary rows only, and a missing figure is shown
// as missing, never as zero.

import { parseCsvObjects } from "./lib/csv.js";
import {
  buildModel, filterFigures, sortFigures, summarize, entityMatrix, coverageByYear,
  fmtUsd, fmtSum, fmtInt, fmtBytes, fmtFy, fyRanges, humanize, scopeLabel, scopeKey, scopeSymbol, entityTypeLabel,
  basisLabel, grossNetLabel, roleLabel, statusLabel, publicationTypeLabel,
  splitLimitations, EMPTY_FILTERS, NONE, matchesChoice, matchesCategory, splitChoice, SEP, SORT_COLUMNS, feeKey, fyStartYear, searchTerms,
} from "./lib/model.js";
import {
  categoryLabel, categoryParam, categoryTree, lawLabel, areaLabel, namespaceLabel, NOT_CLASSIFIED,
} from "./lib/taxonomy.js";
import {
  filterBoxButton, colFilterButton, closeFilterBox, refreshFilterBoxes, facetOptions, boxSummary,
} from "./lib/filter-box.js";
import { loadDistricts } from "./lib/districts.js";
import { csvText, downloadText, exportFilename, reportHtml } from "./lib/export.js";
import { readArithmetic } from "./lib/arith.js";
import { PdfViewer } from "./lib/viewer.js";
import { checkOutline, readPageText, setDataFetch } from "./lib/evidence.js";
import { readPageLines, figureColumn, namesFromPage } from "./lib/pagelines.js";
import { el, svg } from "./lib/dom.js";
import {
  emptyPermitsState, readPermitsState, permitsParams, permitsKey, permitsToolbar, syncPermitsToolbar, renderPermits, renderEntityPermits,
  exportPermits,
} from "./lib/apr-view.js";
import { renderFunds, exportFunds } from "./lib/funds-view.js";
import { renderSchedules, exportSchedules, SELECTION_KEYS as SCHEDULE_KEYS, SELECTION_PARTS as SCHEDULE_PARTS } from "./lib/schedules-view.js";

// ============================================================ CONFIG

const REPO = "aimesy/mfa-data";
const DEFAULT_BRANCH = "main";
// The release Worker (worker/): /<ref>/<path> mirrors the repository's raw
// files, /releases/download/<tag>/<name> its release assets, and /ref answers
// the commit at main.
const DATA_ROOT = "https://mfa-data.amyc.us/";
const VIEWS = ["entities", "districts", "fees", "sources", "figures", "funds", "schedules", "permits", "coverage", "stats"];
const DEFAULT_VIEW = "entities";
// Exports link here: a report is read away from this page, and a local
// ?data= address means nothing to anyone else.
const SITE_URL = "https://mfa.amyc.us/";
const PAGE_SIZES = [50, 100, 250, 500];
const DEFAULT_SORT = { col: "fy", dir: "desc" };
const DEFAULT_ENTITY_SORT = { col: "sum", dir: "desc" };
const DEFAULT_SOURCE_SORT = { col: "agency", dir: "asc" };
const DEFAULT_FEE_SORT = { col: "entity", dir: "asc" };
const DEFAULT_DISTRICT_SORT = { col: "n", dir: "asc" };
const DEFAULT_DISTRICT_PAGE_SORT = { col: "share", dir: "desc" };
const RELEASE_PATH = /^(?:(?:sources|evidence|data|docs)\/[A-Za-z0-9._\/-]+|manifest\.json|README\.md)$/;
// The release's PDFs are GitHub release assets, which the CSVs list by their
// download URL; the Worker serves them at the same path. Not tied to a commit.
const ASSET_URL_ROOT = `https://github.com/${REPO}/`;
const ASSET_PATH = /^releases\/download\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,200}\.pdf)$/;
// Turnstile site key (public). The Worker exchanges a passed check for a
// session cookie; Managed mode asks for a click only when Cloudflare is unsure.
const TURNSTILE_SITEKEY = "0x4AAAAAAFM3PzdZrBklJy9m";

const $ = (id) => document.getElementById(id);

const cfg = readConfig();

function readConfig() {
  const p = new URLSearchParams(location.search);
  const data = p.get("data");
  const ref = p.get("ref");
  if (data && !/^[a-z][a-z0-9+.-]*:/i.test(data) && !data.startsWith("//") && !data.includes("\\")) {
    const base = new URL(data.endsWith("/") ? data : `${data}/`, location.href);
    if (base.origin === location.origin) return { local: true, base: base.href, ref: "", param: { data } };
  }
  if (ref && /^[A-Za-z0-9._\/-]{1,120}$/.test(ref) && !ref.includes("..")) return { local: false, ref, pinned: true, param: { ref } };
  return { local: false, ref: "", pinned: false, param: {} };
}

// ============================================================ SESSION

let sessionPromise = null;
let refreshing = null;
let widgetId = null;
let pendingCheck = null;
// A browser Cloudflare will not pass is asked at most this often per page
// load, then told so, instead of being asked again for every file.
const MAX_CHECKS = 2;
let failedChecks = 0;
const CHECK_REFUSED = "Cloudflare could not confirm that a person is using this browser. Reload to try again, or try another browser.";
// The Worker asks for a visible check (X-Check: visible) after a batch of
// files, after files opened too fast, or after repeated trips from one
// address. The widget is then shown and carries this action.
const VISIBLE_ACTION = "visible";
let checkVisible = false;
// A trusted key arrives once in the fragment (#key=...), so it never reaches
// a server log or a Referer; it is taken out of the address bar at once and
// sent with the next check.
let trustedKey = takeTrustedKey();

function takeTrustedKey() {
  const m = /(?:^#|&)key=([A-Za-z0-9_-]{32,128})(?:&|$)/.exec(location.hash);
  if (!m) return "";
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return m[1];
}

function turnstileReady(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (window.turnstile?.render) resolve(window.turnstile);
      else if (Date.now() - started > timeoutMs) reject(new Error("The human check did not load."));
      else setTimeout(poll, 50);
    };
    poll();
  });
}

// One Turnstile token. The widget stays invisible unless Cloudflare wants an
// interaction, and then it appears over the page; `visible` shows it from
// the start (appearance "always").
function humanCheckToken(visible = false) {
  return turnstileReady().then((ts) => new Promise((resolve, reject) => {
    const box = $("human-check");
    const show = (on) => {
      box.classList.toggle("show", on);
      box.setAttribute("aria-hidden", on ? "false" : "true");
    };
    // A new check replaces any earlier one, which must not wait forever.
    pendingCheck?.(new Error("The human check was restarted."));
    pendingCheck = reject;
    if (widgetId !== null) ts.remove(widgetId);
    const options = {
      sitekey: TURNSTILE_SITEKEY,
      appearance: visible ? "always" : "interaction-only",
      retry: "never",
      callback: (token) => { show(false); resolve(token); },
      "error-callback": (code) => {
        show(false);
        reject(new Error(`The human check failed (${code}).`));
        return true;
      },
      "before-interactive-callback": () => show(true),
    };
    if (visible) options.action = VISIBLE_ACTION;
    widgetId = ts.render("#human-check-widget", options);
    if (visible) show(true);
  }));
}

// The Worker's own words for a refusal (a limit, a failed check), shown to
// the reader as sent.
class WorkerRefusal extends Error {}
async function refusal(res, fallback) {
  const text = (await res.text().catch(() => "")).trim();
  return new WorkerRefusal(text || fallback);
}

function startSession() {
  if (failedChecks >= MAX_CHECKS) return Promise.reject(new Error(CHECK_REFUSED));
  const attempt = async (visible) => {
    if (!$("loading-banner").hidden) $("loading-detail").textContent = "Checking browser.";
    const token = await humanCheckToken(visible);
    const res = await fetch(`${DATA_ROOT}session`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "text/plain" },
      body: trustedKey ? JSON.stringify({ token, key: trustedKey }) : token,
    });
    if (res.ok) {
      if (res.headers.get("X-Trusted-Key") === "refused") console.warn("The trusted key in this link was not recognized.");
      trustedKey = "";
      checkVisible = false;
      return;
    }
    if (res.status === 401 && res.headers.get("X-Check") === "visible" && !visible) {
      checkVisible = true;
      return attempt(true);
    }
    if (res.headers.get("X-Check") === "visible") checkVisible = true;
    throw await refusal(res, `HTTP ${res.status} starting a session`);
  };
  return attempt(checkVisible).catch((err) => {
    // A limit is the Worker's answer, not a failed check.
    if (err instanceof WorkerRefusal && !/^Human check failed/.test(err.message)) throw err;
    failedChecks += 1;
    console.warn("human check", err);
    throw failedChecks >= MAX_CHECKS ? new Error(CHECK_REFUSED) : err;
  });
}

// The session cookie for the data Worker; `fresh` starts a new one (one at a
// time, however many requests were refused).
function ensureSession(fresh = false) {
  if (cfg.local) return Promise.resolve();
  if (fresh) {
    if (!refreshing) {
      refreshing = startSession().finally(() => { refreshing = null; });
      sessionPromise = refreshing;
      sessionPromise.catch(() => { sessionPromise = null; });
    }
    return refreshing;
  }
  if (!sessionPromise) {
    sessionPromise = startSession();
    sessionPromise.catch(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

// fetch() for release files: with the session cookie, and once more after a
// fresh human check when the Worker asks for one (401; visible when it says
// X-Check: visible). A session lasts 12 hours, so a reload or a new tab uses
// the one it has and the check runs only when the Worker asks. `timeout`
// (ms) applies to each request, not to the check between them. A refusal
// (401 again, 403, 429) throws the Worker's own message.
async function dataFetch(url, { timeout, ...init } = {}) {
  if (cfg.local) return fetch(url, init);
  const get = () => {
    if (!timeout) return fetch(url, { ...init, credentials: "include" });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    return fetch(url, { ...init, signal: ctrl.signal, credentials: "include" }).finally(() => clearTimeout(timer));
  };
  // A check under way sets the cookie this request needs.
  if (sessionPromise) await sessionPromise.catch(() => {});
  let res = await get();
  if (res.status === 401) {
    if (res.headers.get("X-Check") === "visible") checkVisible = true;
    await ensureSession(true);
    res = await get();
  }
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    if (res.headers.get("X-Check") === "visible") checkVisible = true;
    throw await refusal(res, `HTTP ${res.status} reading ${url}`);
  }
  return res;
}

setDataFetch(dataFetch);

async function resolveRef() {
  if (cfg.local || cfg.ref) return;
  try {
    // The timeout leaves out a human check the Worker asks for.
    const res = await dataFetch(`${DATA_ROOT}ref`, { timeout: 6000 });
    const sha = (await res.text()).trim();
    if (res.ok && /^[0-9a-f]{40}$/.test(sha)) {
      cfg.ref = sha;
      return;
    }
  } catch {
    // Offline or timed out: fall back to the branch head.
  }
  cfg.ref = DEFAULT_BRANCH;
}

function safePath(path) {
  if (typeof path !== "string" || path.includes("..")) return null;
  if (path.startsWith(ASSET_URL_ROOT)) {
    const asset = path.slice(ASSET_URL_ROOT.length);
    return ASSET_PATH.test(asset) ? asset : null;
  }
  return RELEASE_PATH.test(path) ? path : null;
}

function dataUrl(path) {
  const p = safePath(path);
  if (!p) return null;
  if (cfg.local) return new URL(p, cfg.base).href;
  return ASSET_PATH.test(p) ? `${DATA_ROOT}${p}` : `${DATA_ROOT}${cfg.ref}/${p}`;
}

// Same-page link that keeps the data source (?data= or a pinned ?ref=) and
// the district filter, which holds across tabs; params may clear it.
function hrefWith(params) {
  const p = new URLSearchParams();
  if (cfg.local) p.set("data", cfg.param.data);
  else if (cfg.pinned) p.set("ref", cfg.ref);
  for (const [k, v] of Object.entries({ view: "", ad: state.ad, sd: state.sd, ...params })) if (v && !(k === "view" && v === DEFAULT_VIEW)) p.set(k, v);
  const qs = p.toString();
  return `${location.pathname}${qs ? `?${qs}` : ""}`;
}

const figuresHref = (params) => hrefWith({ view: "figures", ...params });

function officialUrl(raw, page) {
  const value = String(raw || "").trim();
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (page && !url.hash) url.hash = `page=${page}`;
    return url.href;
  } catch {
    return null;
  }
}

// ============================================================ STATE

// The Figures filters: lib/model.js's, plus fy (fiscal years joined by SEP),
// which replaces its fyFrom and fyTo range.
const FIGURE_FILTERS = Object.freeze({ ...EMPTY_FILTERS, fy: "" });

const state = {
  view: DEFAULT_VIEW,
  filters: { ...FIGURE_FILTERS },
  sort: { ...DEFAULT_SORT },
  page: 1,
  pageSize: 100,
  // Assembly and Senate districts, one filter for every tab.
  ad: "", sd: "",
  entity: "",
  eq: "", etype: "", ecounty: "",
  esort: { ...DEFAULT_ENTITY_SORT },
  sq: "", sentity: "", stype: "", sfy: "",
  ssort: { ...DEFAULT_SOURCE_SORT },
  dch: "ad", dn: "",
  dsort: { ...DEFAULT_DISTRICT_SORT },
  dpsort: { ...DEFAULT_DISTRICT_PAGE_SORT },
  fee: "",
  fq: "", fcat: "", ftype: "", fcounty: "", fentity: "",
  fsort: { ...DEFAULT_FEE_SORT },
  cyr: "", ccls: "", ctype: "", ccounty: "", cq: "", cstat: "",
  csort: { col: "name", dir: "asc" },
  cpage: 1,
  fa: "", faq: "", facounty: "", fatype: "",
  sc: Object.fromEntries(SCHEDULE_KEYS.map((k) => [k, ""])),
  permits: emptyPermitsState(),
  figure: "",
  doc: "",
  tab: "outlined",
  pg: null,
};

let model = null;
let columns = [];
let manifestPromise = null;
let evidenceHashPromise = null;
let figuresByPage = new Map();
let listCache = { key: "", list: [] };
let panelList = [];
let viewer = null;
let viewerRoot = null;
let toolbarView = "";
let searchTimer = null;

function sortParam(s, def) {
  return s.col === def.col && s.dir === def.dir ? "" : `${s.col}.${s.dir}`;
}

function parseSort(raw, def, allowed) {
  const [col, dir] = String(raw || "").split(".");
  return allowed.includes(col) && (dir === "asc" || dir === "desc") ? { col, dir } : { ...def };
}

const ENTITY_SORTS = ["name", "type", "county", "years", "figures", "fees", "sources", "sum"];
const FEE_SORTS = ["entity", "fee", "category", "years", "last", "figures", "sum"];
const SOURCE_SORTS = ["agency", "title", "type", "fy", "pages", "bytes", "figures"];
// The Schedules tab's defaults (lib/schedules-view.js), left out of the URL.
const SCHEDULE_DEFAULTS = { sort: "agency", dir: "asc", page: "1" };

// Every filter takes several values joined by SEP. Each part is checked on
// its own, so one bad part in a link drops only that part.
function cleanChoice(raw, ok = (v) => v.length <= 300, norm = (v) => v) {
  const out = [];
  for (const part of splitChoice(raw)) {
    const v = part.trim();
    if (!v || !ok(v)) continue;
    const n = norm(v);
    if (!out.includes(n)) out.push(n);
  }
  return out.join(SEP);
}

// A fiscal year as the release writes it: "2023-24", or a calendar year
// ("2020") for reports kept on one.
const FY_PART = /^\d{4}(?:-\d{2})?$/;
const fyPart = (v) => v === NONE || FY_PART.test(v);
const seatPart = (max) => (v) => v === NONE || (/^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= max);
const seatNorm = (v) => (v === NONE ? v : String(Number(v)));
const DISTRICT_SORTS = ["n", "counties", "muni", "muniFig", "school", "special", "figures", "sum"];
const DISTRICT_PAGE_SORTS = ["name", "type", "county", "share", "figures", "latest", "sum"];

// Two values: both ticked is no filter.
function cleanArith(raw) {
  const v = cleanChoice(raw, (x) => x === "yes" || x === "no");
  return v.includes(SEP) ? "" : v;
}

// Old links name a range, from= and to=; it becomes the set of fiscal years
// in it once the release's years are known.
let legacyFy = null;

function legacyYears(range) {
  const { from, to } = range;
  const years = model.years.filter((y) => (!from || y >= from) && (!to || y <= to));
  return (years.length ? years : [from || to]).join(SEP);
}

function readState() {
  const p = new URLSearchParams(location.search);
  // view=about is the old name of the Stats tab.
  const view = p.get("view") === "about" ? "stats" : p.get("view");
  state.view = VIEWS.includes(view) ? view : DEFAULT_VIEW;
  state.filters = {
    ...FIGURE_FILTERS,
    q: p.get("q") || "",
    type: cleanChoice(p.get("type")),
    county: cleanChoice(p.get("county")),
    cat: cleanChoice(p.get("cat"), undefined, categoryParam),
    law: cleanChoice(p.get("law")),
    area: cleanChoice(p.get("area")),
    scope: cleanChoice(p.get("scope"), undefined, scopeKey),
    fy: cleanChoice(p.get("fy"), fyPart),
    arith: cleanArith(p.get("arith")),
    entity: cleanChoice(p.get("entity")),
    source: p.get("source") || "",
  };
  legacyFy = null;
  if (!state.filters.fy) {
    const from = FY_PART.test(p.get("from") || "") ? p.get("from") : "";
    const to = FY_PART.test(p.get("to") || "") ? p.get("to") : "";
    if (from || to) {
      if (model) state.filters.fy = legacyYears({ from, to });
      else legacyFy = { from, to };
    }
  }
  state.ad = cleanChoice(p.get("ad"), seatPart(80), seatNorm);
  state.sd = cleanChoice(p.get("sd"), seatPart(40), seatNorm);
  state.sort = parseSort(p.get("sort"), DEFAULT_SORT, SORT_COLUMNS);
  state.page = Math.max(1, Number.parseInt(p.get("page"), 10) || 1);
  const size = Number.parseInt(p.get("size"), 10);
  state.pageSize = PAGE_SIZES.includes(size) ? size : 100;
  state.entity = p.get("e") || "";
  state.eq = p.get("eq") || "";
  state.etype = cleanChoice(p.get("etype"));
  state.ecounty = cleanChoice(p.get("ecounty"));
  state.esort = parseSort(p.get("esort"), DEFAULT_ENTITY_SORT, ENTITY_SORTS);
  state.sq = p.get("sq") || "";
  state.sentity = cleanChoice(p.get("sentity"));
  state.stype = cleanChoice(p.get("stype"), undefined, sourceTypeNorm);
  state.sfy = cleanChoice(p.get("sfy"), fyPart);
  state.ssort = parseSort(p.get("ssort"), DEFAULT_SOURCE_SORT, SOURCE_SORTS);
  state.dch = p.get("dch") === "sd" ? "sd" : "ad";
  state.dn = cleanChoice(p.get("dn"), (v) => v !== NONE && seatPart(state.dch === "sd" ? 40 : 80)(v), seatNorm).split(SEP)[0];
  state.dsort = parseSort(p.get("dsort"), DEFAULT_DISTRICT_SORT, DISTRICT_SORTS);
  state.dpsort = parseSort(p.get("dpsort"), DEFAULT_DISTRICT_PAGE_SORT, DISTRICT_PAGE_SORTS);
  state.fee = state.view === "fees" ? p.get("fee") || "" : "";
  state.fq = p.get("fq") || "";
  state.fcat = cleanChoice(p.get("fcat"), undefined, categoryParam);
  state.ftype = cleanChoice(p.get("ftype"));
  state.fcounty = cleanChoice(p.get("fcounty"));
  state.fentity = cleanChoice(p.get("fentity"));
  state.fsort = parseSort(p.get("fsort"), DEFAULT_FEE_SORT, FEE_SORTS);
  state.cyr = p.get("cyr") === "all" || (!p.has("cyr") && storedCoverageYears() === "all") ? "all" : "";
  state.ccls = cleanChoice(p.get("ccls"), (v) => COVERAGE_CLASSES.includes(v));
  // A type is plain ("unified_school_district", as older links have it) or
  // qualified by its class ("school:unified_school_district").
  state.ctype = cleanChoice(p.get("ctype"), (v) => v.length <= 300 && (!v.includes(":") || COVERAGE_CLASSES.includes(v.slice(0, v.indexOf(":")))));
  state.ccounty = cleanChoice(p.get("ccounty"));
  state.cq = p.get("cq") || "";
  state.cstat = cleanChoice(p.get("cstat"), (v) => COVERAGE_STATUSES.some(([k]) => k && k === v));
  state.csort = parseSort(p.get("csort"), DEFAULT_COVERAGE_SORT, COVERAGE_SORTS);
  state.cpage = Math.max(1, Number.parseInt(p.get("cpage"), 10) || 1);
  state.fa = p.get("fa") || "";
  state.faq = p.get("faq") || "";
  state.facounty = cleanChoice(p.get("facounty"));
  state.fatype = cleanChoice(p.get("fatype"));
  // Schedules' box filters take "|" lists; the rest are single values.
  state.sc = Object.fromEntries(SCHEDULE_KEYS.map((k) => {
    const raw = p.get(`sc${k}`) || "";
    return [k, SCHEDULE_PARTS[k] ? cleanChoice(raw, SCHEDULE_PARTS[k]) : raw];
  }));
  // In place: the Permits toolbar keeps a reference to this object.
  Object.assign(state.permits, readPermitsState(p));
  state.figure = p.get("f") || "";
  state.doc = state.figure ? "" : p.get("doc") || "";
  state.tab = p.get("tab") === "original" ? "original" : "outlined";
  state.pg = Number.parseInt(p.get("pg"), 10) || null;
}

function stateParams({ pinRef = false } = {}) {
  const p = new URLSearchParams();
  if (cfg.local) p.set("data", cfg.param.data);
  else if (cfg.pinned || pinRef) p.set("ref", cfg.ref);
  if (state.view !== DEFAULT_VIEW) p.set("view", state.view);
  const f = state.filters;
  const put = (k, v) => { if (v) p.set(k, v); };
  put("ad", state.ad);
  put("sd", state.sd);
  if (state.view === "figures") {
    put("q", f.q); put("type", f.type); put("county", f.county); put("cat", f.cat); put("law", f.law); put("area", f.area); put("scope", f.scope);
    put("fy", f.fy); put("arith", f.arith); put("entity", f.entity); put("source", f.source);
    put("sort", sortParam(state.sort, DEFAULT_SORT));
    if (state.page > 1) p.set("page", state.page);
    if (state.pageSize !== 100) p.set("size", state.pageSize);
  } else if (state.view === "entities") {
    put("e", state.entity);
    if (!state.entity) {
      put("eq", state.eq); put("etype", state.etype); put("ecounty", state.ecounty);
      put("esort", sortParam(state.esort, DEFAULT_ENTITY_SORT));
    }
  } else if (state.view === "fees") {
    if (state.fee) {
      put("e", state.entity);
      put("fee", state.fee);
    } else {
      put("fq", state.fq); put("fcat", state.fcat); put("ftype", state.ftype); put("fcounty", state.fcounty); put("fentity", state.fentity);
      put("fsort", sortParam(state.fsort, DEFAULT_FEE_SORT));
    }
  } else if (state.view === "sources") {
    put("sq", state.sq); put("sentity", state.sentity); put("stype", state.stype); put("sfy", state.sfy);
    put("ssort", sortParam(state.ssort, DEFAULT_SOURCE_SORT));
  } else if (state.view === "districts") {
    if (state.dch !== "ad") p.set("dch", state.dch);
    put("dn", state.dn);
    if (state.dn) put("dpsort", sortParam(state.dpsort, DEFAULT_DISTRICT_PAGE_SORT));
    else put("dsort", sortParam(state.dsort, DEFAULT_DISTRICT_SORT));
  } else if (state.view === "coverage") {
    put("cyr", state.cyr); put("ccls", state.ccls); put("ctype", state.ctype); put("ccounty", state.ccounty); put("cq", state.cq); put("cstat", state.cstat);
    put("csort", sortParam(state.csort, DEFAULT_COVERAGE_SORT));
    if (state.cpage > 1) p.set("cpage", state.cpage);
  } else if (state.view === "funds") {
    if (state.fa) put("fa", state.fa);
    else {
      put("faq", state.faq);
      put("facounty", state.facounty);
      put("fatype", state.fatype);
    }
  } else if (state.view === "schedules") {
    for (const k of SCHEDULE_KEYS) {
      const v = String(state.sc[k] ?? "");
      if (v !== SCHEDULE_DEFAULTS[k]) put(`sc${k}`, v);
    }
  } else if (state.view === "permits") {
    permitsParams(state.permits, put);
  }
  if (state.figure) {
    p.set("f", state.figure);
    if (state.tab === "original") p.set("tab", "original");
    if (state.tab === "original" && state.pg) p.set("pg", state.pg);
  } else if (state.doc) {
    p.set("doc", state.doc);
    if (state.pg) p.set("pg", state.pg);
  }
  return p;
}

function urlFor(opts) {
  const qs = stateParams(opts).toString();
  return `${location.pathname}${qs ? `?${qs}` : ""}`;
}

function writeUrl(push = false) {
  const url = urlFor();
  if (url === `${location.pathname}${location.search}`) return;
  history[push ? "pushState" : "replaceState"](null, "", url);
}

// ============================================================ LOADING

function showLoading(msg, detail, error = false) {
  const banner = $("loading-banner");
  banner.hidden = false;
  banner.classList.toggle("err", error);
  banner.setAttribute("aria-busy", error ? "false" : "true");
  $("loading-msg").textContent = msg;
  $("loading-detail").textContent = detail;
  $("loading-retry").hidden = !error;
}

async function fetchText(path) {
  const url = dataUrl(path);
  const res = await dataFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} reading ${path}`);
  return res.text();
}

async function fetchJson(path) {
  return JSON.parse(await fetchText(path));
}

function ensureManifest() {
  if (!manifestPromise) {
    manifestPromise = fetchJson("manifest.json").then((m) => {
      const files = new Map();
      for (const f of m.files || []) files.set(f.path, f);
      return { ...m, files };
    });
    manifestPromise.catch(() => { manifestPromise = null; });
  }
  return manifestPromise;
}

// The manifest lists the repository's files. The evidence PDFs are release
// assets, so their hashes come from evidence/index.json.
function ensureEvidenceHashes() {
  if (!evidenceHashPromise) {
    evidenceHashPromise = fetchJson("evidence/index.json").then((rows) => {
      const hashes = new Map();
      for (const r of Array.isArray(rows) ? rows : []) {
        if (r.outlined_figure_pdf && r.outlined_figure_sha256) hashes.set(r.outlined_figure_pdf, r.outlined_figure_sha256);
        if (r.page_extract_pdf && r.page_extract_sha256) hashes.set(r.page_extract_pdf, r.page_extract_sha256);
      }
      return hashes;
    });
    evidenceHashPromise.catch(() => { evidenceHashPromise = null; });
  }
  return evidenceHashPromise;
}

// Resolves to meta(path): what the release records about a file (its sha256,
// and bytes when the manifest lists it), or null. Never rejects; a file whose
// record could not be read is shown with the hash check reporting so.
function ensureFileMeta() {
  return Promise.all([ensureManifest().catch(() => null), ensureEvidenceHashes().catch(() => null)])
    .then(([m, hashes]) => (path) => m?.files.get(path) || (hashes?.has(path) ? { path, sha256: hashes.get(path) } : null));
}

async function boot() {
  try {
    // A key from a #key= link is redeemed with a check; otherwise the first
    // request shows whether this browser still has a session.
    if (!cfg.local && trustedKey) {
      showLoading("Loading", "Checking browser.");
      await ensureSession().catch((err) => console.warn(err));
    }
    showLoading("Loading", "Finding release.");
    await resolveRef();
    renderReleaseLabel();
    showLoading("Loading", "Reading release.");
    const [feeText, sourceText] = await Promise.all([
      fetchText("data/reported-fee-collections.csv"),
      fetchText("sources/index.csv"),
    ]);
    const fees = parseCsvObjects(feeText);
    const sources = parseCsvObjects(sourceText);
    columns = fees.columns;
    model = buildModel(fees.rows, sources.rows);
    if (model.problems.length) console.warn("Figure groups without exactly one primary row:", model.problems);
    indexPages();
    const given = new URLSearchParams(location.search);
    // An about link, or a publication type given by its release code.
    let rewrite = given.get("view") === "about" || (given.has("stype") && given.get("stype") !== state.stype);
    if (legacyFy) {
      state.filters.fy = legacyYears(legacyFy);
      legacyFy = null;
      rewrite = true;
    }
    // A district in the link filters the first rows drawn, so its file
    // comes first; a failure shows on the tab, with Retry.
    if (state.ad || state.sd) {
      showLoading("Loading", "Reading legislative districts.");
      await ensureDistricts().catch((err) => console.warn(err));
    }
    $("loading-banner").hidden = true;
    $("workspace").hidden = false;
    renderStats();
    if (rewrite) writeUrl();
    renderAll();
  } catch (err) {
    console.error(err);
    showLoading("Failed to load", String(err.message || err), true);
  }
}

function indexPages() {
  figuresByPage = new Map();
  for (const fig of model.figures) {
    const r = fig.primary;
    const key = `${r.source_pdf}#${r._page}`;
    if (!figuresByPage.has(key)) figuresByPage.set(key, []);
    figuresByPage.get(key).push(fig);
  }
}

function figuresOnPage(sourcePdf, page) {
  return figuresByPage.get(`${sourcePdf}#${page}`) || [];
}

// ============================================================ HEADER

function renderReleaseLabel() {
  const a = $("release-label");
  if (cfg.local) {
    a.textContent = "local files";
    a.removeAttribute("href");
    return;
  }
  // The release repository is private, so the commit is shown as text.
  const short = /^[0-9a-f]{40}$/.test(cfg.ref) ? cfg.ref.slice(0, 7) : cfg.ref;
  a.textContent = `release @ ${short}`;
  a.removeAttribute("href");
  a.title = `${REPO} @ ${cfg.ref}`;
}

function renderStats() {
  $("stats").textContent = `${fmtInt(model.figures.length)} printed figures · ${fmtInt(model.rows.length)} rows · ${fmtInt(model.entities.length)} jurisdictions · ${fmtInt(model.sources.length)} publications`;
}

function renderTabs() {
  let open = null;
  for (const a of document.querySelectorAll(".view-tab")) {
    const active = a.dataset.view === state.view;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    a.href = hrefWith({ view: a.dataset.view });
    if (active) open = a;
  }
  revealTab(open);
  renderExportButton();
}

// On a phone the tab strip scrolls sideways, and a link straight to Permits
// opened with its tab out of sight. Moves the strip only; scrollIntoView
// would also move the page.
function revealTab(tab) {
  const strip = tab?.parentElement;
  if (!strip || strip.scrollWidth <= strip.clientWidth) return;
  const s = strip.getBoundingClientRect();
  const t = tab.getBoundingClientRect();
  if (t.left < s.left) strip.scrollLeft -= s.left - t.left + 8;
  else if (t.right > s.right) strip.scrollLeft += t.right - s.right + 8;
}

function updateTitle() {
  const base = "California Mitigation Fee Database";
  const fig = state.figure && model?.figureById.get(state.figure);
  let t = base;
  if (fig) t = `${fig.entity} · ${fmtFy(fig.fy)} · ${fig.program} · ${base}`;
  else if (state.view === "entities" && state.entity) t = `${state.entity} · ${base}`;
  else if (state.view === "figures") t = `Figures · ${base}`;
  else if (state.view === "fees" && currentFee()) t = `${currentFee().label} · ${state.entity} · ${base}`;
  else if (state.view === "fees") t = `Fees · ${base}`;
  else if (state.view === "sources") t = `Sources · ${base}`;
  else if (state.view === "funds" && state.fa) t = `${state.fa} · Funds · ${base}`;
  else if (state.view === "funds") t = `Funds · ${base}`;
  else if (state.view === "schedules" && state.sc.agency) t = `${state.sc.agency} · Schedules · ${base}`;
  else if (state.view === "schedules") t = `Schedules · ${base}`;
  else if (state.view === "permits") t = `Permits · ${base}`;
  else if (state.view === "coverage") t = `Coverage · ${base}`;
  else if (state.view === "districts" && state.dn) t = `${CHAMBER[state.dch].label} ${state.dn} · Districts · ${base}`;
  else if (state.view === "districts") t = `Districts · ${base}`;
  else if (state.view === "stats") t = `Stats · ${base}`;
  document.title = t;
}

// ============================================================ TOOLBAR

function chip(label, control) {
  return el("span", { class: "chip" }, el("label", { class: "chip-lbl", for: control.id, text: label }), control);
}

function choices(values, label) {
  return [["", "All"], ...values.map((v) => [v || NONE, v ? label(v) : "(not recorded)"])];
}

function select(id, options, value, onChange) {
  const s = el("select", { id, onchange: (e) => onChange(e.target.value) });
  for (const [v, text] of options) s.append(el("option", { value: v, text }));
  s.value = value;
  return s;
}

function searchInput(id, value, placeholder, onInput) {
  return el("input", {
    id, type: "search", value, placeholder, autocomplete: "off", spellcheck: "false",
    oninput: (e) => {
      clearTimeout(searchTimer);
      const v = e.target.value;
      searchTimer = setTimeout(() => onInput(v), 140);
    },
  });
}

function copyButton(label, getText) {
  const b = el("button", {
    class: "btn", type: "button", text: label,
    onclick: async () => {
      const text = getText();
      const ok = await copyText(text);
      flash(b, ok ? "Copied" : "Copy failed", label);
      if (!ok) window.prompt("Copy this:", text);
    },
  });
  return b;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function flash(button, text, restore) {
  button.textContent = text;
  setTimeout(() => { button.textContent = restore; }, 1400);
}

// ------------------------------------------------------------ FILTER BOXES
// Every filter is a checkbox box (lib/filter-box.js): tick any number of
// values (any of them matches; different boxes must all match), each with
// its count among the rows the tab's other filters leave. A tab's filters
// are one object, its own fields plus ad and sd, and its rows a function of
// that object, so a box counts by running the tab's filter without itself.

const noneText = (fn, none = "(not recorded)") => (v) => (v === NONE || v === "" ? none : fn(v));
const catText = (v) => (v === NONE ? NOT_CLASSIFIED : categoryLabel(v.includes("/") ? v : `${v}/`));

const CHAMBER = {
  ad: { label: "Assembly District", box: "Assembly district", short: "AD", word: "Assembly", seats: 80, csv: "assembly" },
  sd: { label: "Senate District", box: "Senate district", short: "SD", word: "Senate", seats: 40, csv: "senate" },
};
const CHAMBERS = ["ad", "sd"];

// The same words as districts.json's meta.caveat, for a box opened before
// the file has loaded.
const DISTRICT_CAVEAT = "Each agency is listed under every Assembly and Senate district its territory reaches, even by a small part (for a special district, a part that holds a 2020 census block or is over 100 meters wide), so many appear under more than one district and district totals overlap.";
const districtCaveat = () => districts?.meta.caveat || DISTRICT_CAVEAT;
const districtLabel = (ch, v) => (v === NONE ? "(not mapped)" : `${CHAMBER[ch].short} ${v}`);

function categoryOptions(cats) {
  const counts = new Map();
  for (const c of cats) counts.set(c || "", (counts.get(c || "") || 0) + 1);
  return categoryTree(counts);
}

const latestPrimary = (fee) => fee.figures[fee.figures.length - 1].primary;

// What each tab filters on. filter() is the tab's filter object now, rows(f)
// its rows under any such object, set(k, v) stores one field, clear() its own
// fields, agency(row) the [name, opts] that districts.js looks up, boxes the
// toolbar boxes (the district boxes follow) and tags the order of the tags
// in its result bar.
const TABS = {
  figures: {
    label: "Figures",
    filter: () => ({ ...state.filters, ad: state.ad, sd: state.sd }),
    rows: (f) => figureRows(f),
    set: (k, v) => { state.filters[k] = v; },
    clear: () => { state.filters = { ...FIGURE_FILTERS }; },
    agency: (fig) => releaseWhere(fig.entity),
    boxes: ["cat", "law", "area", "type", "county", "scope", "fy", "arith"],
    tags: ["entity", "cat", "law", "area", "type", "county", "scope", "fy", "arith"],
    defs: {
      cat: { label: "Category", tree: true, sort: "given", text: catText, options: (rows) => categoryOptions(rows.map((f) => f.cat)) },
      law: { label: "Law", value: (f) => f.law, text: noneText(lawLabel, NOT_CLASSIFIED) },
      area: { label: "Area", value: (f) => f.area, text: noneText(areaLabel, NOT_CLASSIFIED) },
      type: { label: "Type", value: (f) => f.primary.entity_type, text: noneText(entityTypeLabel) },
      county: { label: "County", value: (f) => f.primary.county, text: noneText((c) => c) },
      scope: { label: "Land use", value: (f) => scopeKey(f.primary.land_use_scope), text: noneText(scopeLabel) },
      fy: { label: "Fiscal year", sort: "num", value: (f) => f.fy, text: noneText(fmtFy) },
      arith: { label: "Arithmetic", value: (f) => (f.arith ? "yes" : "no"), text: (v) => (v === "yes" ? "Checked" : "Not checked") },
      entity: { label: "Jurisdiction", many: true, value: (f) => f.entity, text: (v) => v },
    },
  },
  entities: {
    label: "Jurisdictions",
    filter: () => ({ eq: state.eq, etype: state.etype, ecounty: state.ecounty, ad: state.ad, sd: state.sd }),
    rows: (f) => entityMatches(f),
    set: (k, v) => { state[k] = v; },
    clear: () => { state.eq = ""; state.etype = ""; state.ecounty = ""; },
    agency: (e) => releaseWhere(e.name),
    boxes: ["etype", "ecounty"],
    tags: ["etype", "ecounty"],
    defs: {
      etype: { label: "Type", value: (e) => e.type, text: noneText(entityTypeLabel) },
      ecounty: { label: "County", value: (e) => e.county, text: noneText((c) => c) },
    },
  },
  fees: {
    label: "Fees",
    filter: () => ({ fq: state.fq, fcat: state.fcat, ftype: state.ftype, fcounty: state.fcounty, fentity: state.fentity, ad: state.ad, sd: state.sd }),
    rows: (f) => feeMatches(f),
    set: (k, v) => { state[k] = v; },
    clear: () => { state.fq = ""; state.fcat = ""; state.ftype = ""; state.fcounty = ""; state.fentity = ""; },
    agency: (fee) => releaseWhere(fee.entity),
    boxes: ["fcat", "ftype", "fcounty"],
    tags: ["fentity", "fcat", "ftype", "fcounty"],
    defs: {
      fentity: { label: "Jurisdiction", many: true, value: (fee) => fee.entity, text: (v) => v },
      fcat: { label: "Category", tree: true, sort: "given", text: catText, options: (rows) => categoryOptions(rows.map((fee) => fee.cat)) },
      ftype: { label: "Type", value: (fee) => latestPrimary(fee).entity_type, text: noneText(entityTypeLabel) },
      fcounty: { label: "County", value: (fee) => latestPrimary(fee).county, text: noneText((c) => c) },
    },
  },
  sources: {
    label: "Sources",
    filter: () => ({ sq: state.sq, sentity: state.sentity, stype: state.stype, sfy: state.sfy, ad: state.ad, sd: state.sd }),
    rows: (f) => sourceMatches(f),
    set: (k, v) => { state[k] = v; },
    clear: () => { state.sq = ""; state.sentity = ""; state.stype = ""; state.sfy = ""; },
    agency: (s) => releaseWhere(s.receiving_entity),
    boxes: ["stype", "sfy"],
    tags: ["sentity", "stype", "sfy"],
    defs: {
      sentity: { label: "Agency", many: true, value: (s) => s.receiving_entity, text: (v) => v },
      stype: { label: "Publication type", value: sourceType, text: noneText((v) => v) },
      sfy: { label: "Covers", sort: "num", value: (s) => coversYears(s), text: noneText(fmtFy, "(no year named)") },
    },
  },
  coverage: {
    label: "Coverage",
    filter: () => ({ ccls: state.ccls, ctype: state.ctype, ccounty: state.ccounty, cq: state.cq, cstat: state.cstat, ad: state.ad, sd: state.sd }),
    rows: (f) => (coverageData ? coverageMatches(coverageData, f) : []),
    set: (k, v) => { state[k] = v; },
    clear: () => { state.ccls = ""; state.ctype = ""; state.ccounty = ""; state.cq = ""; state.cstat = ""; },
    agency: (a) => [a.name, { type: a.type, county: a.county }],
    needs: () => loadCoverage(),
    boxes: ["ctype", "ccounty", "cstat"],
    tags: ["ctype", "ccounty", "cstat"],
    defs: {
      // One tree for class (parents) and type (children); see coverageTypeTest.
      ctype: {
        label: "Type", tree: true, sort: "given", clear: { ccls: "" },
        text: coverageTypeText, options: coverageTypeOptions, get: coverageTypeRaw, apply: (v) => setCoverageTypes(v),
      },
      ccounty: { label: "County", value: (a) => a.county, text: noneText((c) => c) },
      cstat: { label: "Status", sort: "given", text: (v) => COVERAGE_STATUS_LABEL.get(v) || v, options: coverageStatusOptions },
    },
  },
};

// Pages reset when a filter changes, and the district filter reaches every tab.
function resetPages() {
  state.page = 1;
  state.cpage = 1;
}

function setFilter(view, key, value) {
  if (key === "ad" || key === "sd") state[key] = value;
  else TABS[view].set(key, value);
  resetPages();
  update();
}

function clearTab(view) {
  TABS[view].clear();
  state.ad = "";
  state.sd = "";
  resetPages();
  update();
}

const filtersActive = (f) => Object.values(f).some(Boolean);

// A release agency's name with the type and county the release gives it, for
// a district lookup, so a namesake's record in another county never answers.
// A figure, fee or source takes its agency's, so every tab places it alike.
function releaseWhere(name) {
  const e = model?.entityByName.get(name);
  return e ? [name, { type: e.type, county: e.county }] : [name];
}

// What a district box counts for one row: the districts its agency touches,
// none (NONE) when it is not mapped.
function chamberValues(where, ch) {
  const [name, opts] = Array.isArray(where) ? where : [where];
  return agencyDistricts(name, opts)?.[ch] ?? [];
}

function districtDef(ch, agency) {
  return {
    label: CHAMBER[ch].box, sort: "num", many: false,
    note: districtCaveat, needs: ensureDistricts,
    text: (v) => districtLabel(ch, v),
    value: (row) => chamberValues(agency(row), ch),
  };
}

// A box's spec from its definition. rows(f) and agency(row) come from the tab
// (or a lib view through ctx.districtBoxes); options run once the files they
// need have loaded, so a box opened early shows Loading.
function makeSpec(key, def, { filter, rows, apply, needs }) {
  return {
    key,
    label: def.label,
    text: def.text,
    many: def.many,
    tree: def.tree,
    sort: def.sort,
    placeholder: def.placeholder,
    hint: def.hint,
    get note() { return typeof def.note === "function" ? def.note() : def.note; },
    get: def.get || (() => filter()[key] || ""),
    apply: def.apply || ((v) => apply(key, v)),
    options: () => {
      const f = { ...filter(), [key]: "", ...(def.clear || {}) };
      const run = () => {
        const list = rows(f);
        return def.options ? def.options(list) : facetOptions(list, def.value, def.text);
      };
      const waits = [needs?.(), def.needs?.(), (f.ad || f.sd) && !districts ? ensureDistricts() : null].filter(Boolean);
      return waits.length ? Promise.all(waits).then(run) : run();
    },
  };
}

const specCache = new Map();

// The spec for one of an app tab's boxes; the same object every time, so a
// toolbar button and a column ▾ name one box.
function boxSpec(view, key) {
  const id = `${view}:${key}`;
  if (!specCache.has(id)) {
    const tab = TABS[view];
    const def = key === "ad" || key === "sd" ? districtDef(key, tab.agency) : tab.defs[key];
    if (!def) return null;
    specCache.set(id, makeSpec(key, def, {
      filter: tab.filter, rows: tab.rows, needs: tab.needs, apply: (k, v) => setFilter(view, k, v),
    }));
  }
  return specCache.get(id);
}

function filtersToggle(bar) {
  const toggle = el("button", {
    class: "btn filters-toggle", type: "button", "aria-expanded": bar.classList.contains("open") ? "true" : "false", "aria-controls": "filters-more", text: "Filters",
    onclick: () => {
      const open = bar.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    },
  });
  return toggle;
}

// Search, then the boxes (folded behind Filters on a phone), then Clear.
function filterToolbar(bar, view, search, after = []) {
  const tab = TABS[view];
  bar.append(
    search,
    filtersToggle(bar),
    el("span", { class: "filters-more", id: "filters-more" }, [...tab.boxes, ...CHAMBERS].map((k) => filterBoxButton(boxSpec(view, k)))),
    el("button", { class: "btn", type: "button", text: "Clear", onclick: () => { toolbarView = ""; clearTab(view); } }),
    ...after,
  );
}

const copyLinkButton = () => copyButton("Copy link", () => new URL(urlFor(), location.href).href);

function renderToolbar() {
  const bar = $("toolbar");
  const dossier = (state.view === "entities" && state.entity) || (state.view === "fees" && state.fee);
  const key = dossier ? "dossier" : state.view;
  if (key === toolbarView) {
    syncToolbar();
    return;
  }
  toolbarView = key;
  bar.replaceChildren();
  // Funds and Schedules draw their own controls above their tables.
  bar.hidden = key === "stats" || key === "dossier" || key === "funds" || key === "schedules";
  const sep = () => el("span", { class: "sep" });
  if (key === "figures") {
    const setQ = (v) => { state.filters.q = v; state.page = 1; update(); };
    filterToolbar(bar, "figures", chip("Search", searchInput("q", state.filters.q, "jurisdiction, fee, label…", setQ)), [sep(), copyLinkButton()]);
  } else if (key === "entities") {
    filterToolbar(bar, "entities", chip("Search", searchInput("eq", state.eq, "jurisdiction or county", (v) => { state.eq = v; update(); })));
  } else if (key === "fees") {
    filterToolbar(bar, "fees", chip("Search", searchInput("fq", state.fq, "jurisdiction, fee, fund number", (v) => { state.fq = v; update(); })));
  } else if (key === "sources") {
    filterToolbar(bar, "sources", chip("Search", searchInput("sq", state.sq, "agency, title, source id, fiscal year", (v) => { state.sq = v; update(); })));
  } else if (key === "coverage") {
    filterToolbar(bar, "coverage", chip("Search", searchInput("cq", state.cq, "jurisdiction or county", (v) => { state.cq = v; state.cpage = 1; update(); })),
      [sep(), copyLinkButton(), coverageYearsToggle()]);
  } else if (key === "districts") {
    bar.append(chamberSwitch(), sep(), copyLinkButton());
  } else if (key === "permits") {
    bar.append(...permitsToolbar(permitsCtx()));
  }
}

function syncToolbar() {
  const set = (id, v) => { const n = $(id); if (n && n !== document.activeElement && n.value !== v) n.value = v; };
  set("q", state.filters.q);
  set("eq", state.eq);
  set("sq", state.sq);
  set("fq", state.fq);
  set("cq", state.cq);
  refreshFilterBoxes();
  for (const b of document.querySelectorAll(".cov-years-toggle [data-cyr]")) b.setAttribute("aria-pressed", b.dataset.cyr === state.cyr ? "true" : "false");
  for (const b of document.querySelectorAll(".chamber-switch [data-dch]")) b.setAttribute("aria-pressed", b.dataset.dch === state.dch ? "true" : "false");
  syncPermitsToolbar(state);
}

// ============================================================ RENDER

function update({ push = false } = {}) {
  writeUrl(push);
  renderAll();
}

let contentKey = "";
let panelKey = "";

function renderAll() {
  if (!model) return;
  // A render redraws what an open box counts and where it sits.
  closeFilterBox({ focus: false });
  renderTabs();
  renderToolbar();
  const ck = JSON.stringify([state.view, state.filters, state.sort, state.page, state.pageSize, state.entity, state.ad, state.sd, Boolean(districts),
    state.eq, state.etype, state.ecounty, state.esort, state.sq, state.sentity, state.stype, state.sfy, state.ssort,
    state.fee, state.fq, state.fcat, state.ftype, state.fcounty, state.fentity, state.fsort,
    state.cyr, state.ccls, state.ctype, state.ccounty, state.cq, state.cstat, state.csort, state.cpage,
    state.dch, state.dn, state.dsort, state.dpsort,
    state.fa, state.facounty, state.fatype, state.sc, permitsKey(state.permits)]);
  if (ck !== contentKey) {
    contentKey = ck;
    renderContent();
  }
  renderPanel();
  updateTitle();
}

function renderContent() {
  const content = $("content");
  content.replaceChildren();
  if (districtGate(content)) return;
  if (state.view === "figures") renderFigures(content);
  else if (state.view === "entities") {
    if (state.entity) renderEntityDossier(content);
    else renderEntities(content);
  } else if (state.view === "fees") {
    if (state.fee) renderFeePage(content);
    else renderFees(content);
  } else if (state.view === "sources") renderSources(content);
  else if (state.view === "funds") renderFundsTab(content);
  else if (state.view === "schedules") renderSchedulesTab(content);
  else if (state.view === "permits") renderPermits(content, permitsCtx());
  else if (state.view === "coverage") renderCoverage(content);
  else if (state.view === "districts") renderDistricts(content);
  else renderStatsView(content);
}

function currentFigures() {
  const key = JSON.stringify([state.filters, state.sort, state.ad, state.sd, Boolean(districts)]);
  if (listCache.key !== key) {
    listCache = { key, list: sortFigures(figureRows(TABS.figures.filter()), state.sort) };
  }
  return listCache.list;
}

// Figures under a filter object: lib/model.js's filters, then the fiscal
// years and the districts, which it does not know.
function figureRows(f) {
  const inDistricts = districtTest(f);
  return filterFigures(model.figures, { ...f, fyFrom: "", fyTo: "" })
    .filter((fig) => (!f.fy || matchesChoice(f.fy, fig.fy)) && (!inDistricts || inDistricts(...releaseWhere(fig.entity))));
}

function filterTag(label, onRemove) {
  return el("span", { class: "filter-tag" }, label,
    el("button", { type: "button", "aria-label": `Remove filter ${label}`, title: "Remove filter", text: "×", onclick: onRemove }));
}

// One tag for each box in use, in the tab's order, then the districts.
function boxTags(view) {
  const tab = TABS[view];
  const f = tab.filter();
  const tags = [];
  for (const k of tab.tags) {
    const spec = boxSpec(view, k);
    const raw = spec.get();
    if (raw) tags.push(filterTag(`${spec.label}: ${boxSummary(spec, raw)}`, () => spec.apply("")));
  }
  for (const ch of CHAMBERS) {
    if (f[ch]) tags.push(filterTag(`${CHAMBER[ch].box}: ${boxSummary(boxSpec(view, ch), f[ch])}`, () => setFilter(view, ch, "")));
  }
  return tags;
}

function searchTag(q, onRemove) {
  return q ? filterTag(`“${q}”`, onRemove) : null;
}

// districts.json's caveat, short in its summary and whole once opened, so a
// tap or the keyboard reaches it as well as a pointer. One element for every
// place a district list or filter shows.
const DISTRICT_APPROX = "A few agencies are placed by approximate boundaries and may be missing from some districts.";
function districtCaveatBox(summary = "Agencies count in every district they touch") {
  return el("details", { class: "district-caveat" },
    el("summary", { text: summary }),
    el("span", { class: "district-caveat-body", text: `${districtCaveat()} ${DISTRICT_APPROX}` }));
}

function districtNote() {
  if (!state.ad && !state.sd) return null;
  return districtCaveatBox();
}

// Districts and Stats do not apply the district filter. While one is set
// they say so, show its tags and offer Clear, so it is never carried unseen.
function districtElsewhereNote(what) {
  if (!state.ad && !state.sd) return null;
  const words = districtFilterWords().map((w) => w.value).join("; ");
  return el("div", { class: "district-elsewhere", role: "note" },
    el("span", { text: `${what} The district filter (${words}) applies on the other tabs.` }),
    el("span", { class: "active-filters" }, districtTags()),
    el("button", { class: "btn", type: "button", text: "Clear district filter", onclick: () => { state.ad = ""; state.sd = ""; resetPages(); update(); } }));
}

function activeFilterTags() {
  const f = state.filters;
  const drop = (k) => () => setFilter("figures", k, "");
  const s = f.source ? model.sourceById.get(f.source) : null;
  return [
    f.source ? filterTag(`Source: ${s ? s.publication_title : f.source}`, drop("source")) : null,
    searchTag(f.q, drop("q")),
    ...boxTags("figures"),
  ].filter(Boolean);
}

// "12 of 1,234 figures" when filtered, "1,234 figures" when not.
function countOf(n, total, noun, filtered, plural = `${noun}s`) {
  return [el("strong", { text: fmtInt(n) }), filtered && total !== undefined ? ` of ${fmtInt(total)} ${total === 1 ? noun : plural}` : ` ${n === 1 ? noun : plural}`];
}

// Under a district filter a sum adds whole agencies, each counted in every
// district it touches, so it is labelled as such.
function sumNote(summary) {
  const districted = Boolean(state.ad || state.sd);
  return el("span", {
    class: "sum",
    title: districted ? "Primary rows only. Each agency's whole total, counted in every district it touches, so district totals overlap." : "Primary rows only",
  }, districted ? "whole-agency sum " : "sum ", el("strong", { text: fmtSum(summary.sum) }));
}

// filter adds the column's filter box (the ▾ beside its name): a spec from
// lib/filter-box.js, or the key of one of the current tab's boxes.
function sortHeader(label, col, sort, onSort, cls = "", filter = null) {
  const spec = typeof filter === "string" ? (filter && TABS[state.view] ? boxSpec(state.view, filter) : null) : filter;
  const active = sort.col === col;
  const th = el("th", {
    class: `sortable ${cls} ${active ? `sort-${sort.dir}` : ""}`,
    scope: "col",
    "aria-sort": active ? (sort.dir === "asc" ? "ascending" : "descending") : "none",
  }, el("span", { class: "col-head" },
    el("button", { type: "button", class: "th-btn", onclick: () => onSort(col) }, el("span", { class: "col-label", text: label })),
    spec ? colFilterButton(spec) : null));
  return th;
}

function toggleSort(sort, col, numeric) {
  if (sort.col === col) return { col, dir: sort.dir === "asc" ? "desc" : "asc" };
  return { col, dir: numeric ? "desc" : "asc" };
}

const NUMERIC_SORTS = new Set(["value", "fy", "sum", "figures", "fees", "sources", "years", "pages", "bytes"]);

// ------------------------------------------------------------ FIGURES

function renderFigures(content) {
  const list = currentFigures();
  const pages = Math.max(1, Math.ceil(list.length / state.pageSize));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * state.pageSize;
  const pageRows = list.slice(start, start + state.pageSize);
  const summary = summarize(list);

  const bar = el("div", { class: "result-bar" },
    el("span", { class: "count" }, countOf(summary.count, model.figures.length, "figure", filtersActive(TABS.figures.filter())), ` · ${fmtInt(summary.entities)} jurisdiction${summary.entities === 1 ? "" : "s"}`,
      summary.firstYear ? ` · FY ${fmtFy(summary.firstYear)}${summary.lastYear !== summary.firstYear ? ` to ${fmtFy(summary.lastYear)}` : ""}` : ""),
    summary.count ? sumNote(summary) : null,
    el("span", { class: "active-filters" }, activeFilterTags()),
    districtNote(),
  );

  const onSort = (col) => { state.sort = toggleSort(state.sort, col, NUMERIC_SORTS.has(col)); state.page = 1; update(); };
  const s = state.sort;
  const table = el("table", { class: "grid figures-grid" },
    el("thead", {}, el("tr", {},
      sortHeader("Jurisdiction", "entity", s, onSort, "col-entity", "entity"),
      sortHeader("FY", "fy", s, onSort, "col-fy", "fy"),
      sortHeader("Fee program", "program", s, onSort, "col-program"),
      sortHeader("Category", "category", s, onSort, "col-cat", "cat"),
      sortHeader("Law", "law", s, onSort, "col-law", "law"),
      sortHeader("Area", "area", s, onSort, "col-area", "area"),
      sortHeader("Printed label", "label", s, onSort, "col-label"),
      sortHeader("Amount", "value", s, onSort, "col-amount num"),
      el("th", { class: "col-notes", scope: "col" }, el("span", { class: "col-label", text: "Notes" })),
      sortHeader("Evidence", "page", s, onSort, "col-evidence"),
    )),
  );
  const body = el("tbody");
  for (const fig of pageRows) body.append(figureRow(fig, list));
  table.append(body);
  if (!pageRows.length) {
    body.append(el("tr", { class: "empty-row" }, el("td", { colspan: 10, text: "No published figure matches these filters." })));
  }

  const pager = el("div", { class: "pager" },
    el("button", { class: "btn", type: "button", text: "Prev", disabled: state.page <= 1, onclick: () => { state.page -= 1; update(); scrollContentTop(); } }),
    el("span", { class: "muted", text: `page ${state.page} of ${pages}` }),
    el("button", { class: "btn", type: "button", text: "Next", disabled: state.page >= pages, onclick: () => { state.page += 1; update(); scrollContentTop(); } }),
    el("span", { class: "sep" }),
    el("label", { class: "muted", for: "page-size", text: "Rows" }),
    select("page-size", PAGE_SIZES.map((n) => [String(n), String(n)]), String(state.pageSize), (v) => { state.pageSize = Number(v); state.page = 1; update(); }),
  );

  content.append(bar, el("div", { class: "table-scroll" }, table), pager);
}

function scrollContentTop() {
  $("content").scrollTo(0, 0);
}

function badge(text, tip, cls = "") {
  const one = [...text].length === 1 ? " one" : "";
  return el("span", { class: `badge ${cls}${one}`, role: "img", tabindex: "0", "aria-label": tip, "data-tip": tip },
    el("span", { class: "t", "aria-hidden": "true", text }));
}

// A badge that lists every figure sharing it.
function tagLink(filters, tip, cls, ...body) {
  return el("a", {
    class: `badge tag ${cls}`, href: figuresHref(filters), "data-tip": tip, "aria-label": `${tip}: show all`,
    onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); showFiltered(filters); },
  }, body);
}

function symbol(ch) {
  return el("span", { class: "sym", "aria-hidden": "true", text: ch });
}

function showFiltered(filters) {
  state.view = "figures";
  state.filters = { ...FIGURE_FILTERS, ...filters };
  state.page = 1;
  state.entity = "";
  state.figure = "";
  state.doc = "";
  state.pg = null;
  update({ push: true });
  scrollContentTop();
}

// A jurisdiction's name, wherever it is clicked: shows only its rows in the
// tab being read (Fees and Sources filter themselves; any other tab, the
// figures table), in place of that table's other filters, and once they are
// showing, opens its page. From a panel the figure or report stays open.
function entityFiltered(name) {
  if (state.view === "fees") return !state.fee && state.fentity === name;
  if (state.view === "sources") return state.sentity === name;
  return state.view === "figures" && state.filters.entity === name;
}

function entityFilterHref(name) {
  if (state.view === "fees") return hrefWith({ view: "fees", fentity: name });
  if (state.view === "sources") return hrefWith({ view: "sources", sentity: name });
  return figuresHref({ entity: name });
}

function filterToEntity(name) {
  if (state.view === "fees") {
    state.fee = "";
    state.entity = "";
    state.fq = ""; state.fcat = ""; state.ftype = ""; state.fcounty = "";
    state.fentity = name;
  } else if (state.view === "sources") {
    state.sq = ""; state.stype = ""; state.sfy = "";
    state.sentity = name;
  } else {
    state.view = "figures";
    state.filters = { ...FIGURE_FILTERS, entity: name };
    state.page = 1;
    state.entity = "";
  }
}

function entityFilterLink(name, keepPanel = false) {
  const page = model.entityByName.has(name);
  // An agency with reports but no figures has no page to open.
  if (!page && entityFiltered(name)) return name;
  return el("a", {
    class: "entity-link", href: entityFiltered(name) ? entityHref(name) : entityFilterHref(name), text: name,
    onclick: (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (entityFiltered(name)) {
        if (!page) return;
        if (!keepPanel) return openEntity(name);
        state.view = "entities";
        state.entity = name;
      } else {
        filterToEntity(name);
        if (!keepPanel) {
          state.figure = "";
          state.doc = "";
          state.pg = null;
        }
      }
      update({ push: true });
      scrollContentTop();
    },
  });
}

// A click anywhere in a row's jurisdiction cell is a click on its name.
function entityCellClick(ev) {
  const a = ev.target.closest("td.col-entity")?.querySelector("a.entity-link");
  if (!a || ev.target.closest("a,button")) return false;
  a.click();
  return true;
}

function scopeTag(code, named = false) {
  const key = scopeKey(code);
  const sym = scopeSymbol(code);
  if (!sym) return null;
  const name = scopeLabel(code);
  return tagLink({ scope: key }, `Land use: ${name}`, `b-scope scope-${key}${named ? "" : " one"}`,
    symbol(sym), named ? el("span", { class: "t", text: name }) : null);
}

function figureBadges(fig) {
  const p = fig.primary;
  const out = [scopeTag(p.land_use_scope)];
  // Nearly every figure has an arithmetic check, so only its absence is tagged.
  if (!fig.arith) out.push(tagLink({ arith: "no" }, "No arithmetic check", "b-noarith one", symbol("\u{1F4F7}\uFE0E")));
  if (fig.restatements.length) out.push(badge(`×${fig.rows.length}`, `${fig.rows.length} rows, counted once`, "b-restated"));
  if (fig.thousands) out.push(badge("000s", "Printed in thousands", "b-thousands"));
  if (fig.zero) out.push(badge("0", "Printed zero", "b-zero"));
  return out;
}

function evidenceCell(fig, list) {
  const p = fig.primary;
  const off = officialUrl(p.official_source_url, fig.page);
  return el("td", { class: "col-evidence" },
    el("span", { class: "ev-links" },
      el("button", {
        class: "pdf-btn", type: "button", text: fig.page ? `p.${fig.page}` : "page",
        title: `Open outlined page${fig.page ? ` (PDF page ${fig.page})` : ""}`,
        onclick: (e) => { e.stopPropagation(); openFigure(fig.id, { list }); },
      }),
      off ? el("a", { class: "pdf-btn ext", href: off, target: "_blank", rel: "noopener", title: `Official source${fig.page ? `, page ${fig.page}` : ""}`, "aria-label": "Official source", text: "↗", onclick: (e) => e.stopPropagation() }) : null,
    ));
}

function figureRow(fig, list) {
  const p = fig.primary;
  const tr = el("tr", {
    class: fig.id === state.figure ? "selected-row" : "",
    dataset: { id: fig.id },
    onclick: (e) => { if (!entityCellClick(e) && !e.target.closest("a,button")) openFigure(fig.id, { list }); },
  },
    el("td", { class: "col-entity", title: `${fig.entity}\n${entityTypeLabel(p.entity_type)}${p.county ? ` · ${p.county} County` : ""}` }, entityFilterLink(fig.entity)),
    el("td", { class: "col-fy", text: fmtFy(fig.fy) }),
    el("td", { class: "col-program", title: fig.program, text: fig.program }),
    el("td", {
      class: `col-cat${fig.catInferred ? " inferred" : ""}${fig.cat ? "" : " unclassified"}`,
      title: fig.catInferred ? `${categoryLabel(fig.cat)}\nPlaced from the fee name; the report's category is not recorded` : categoryLabel(fig.cat),
      text: categoryLabel(fig.cat),
    }),
    el("td", { class: `col-law${fig.law ? "" : " unclassified"}`, text: fig.law ? lawLabel(fig.law) : "—", title: fig.law ? lawLabel(fig.law) : NOT_CLASSIFIED }),
    el("td", {
      class: `col-area${fig.area ? "" : " unclassified"}`,
      title: fig.area ? [areaLabel(fig.area), fig.areaName].filter(Boolean).join(": ") : NOT_CLASSIFIED,
      text: fig.area ? (fig.areaName || areaLabel(fig.area)) : "—",
    }),
    el("td", { class: "col-label", title: fig.label, text: fig.label }),
    el("td", { class: "col-amount num", title: `Printed as “${p.source_value_text}”` }, fmtUsd(fig.value)),
    el("td", { class: "col-notes" }, figureBadges(fig)),
    evidenceCell(fig, list),
  );
  return tr;
}

// ------------------------------------------------------------ ENTITIES

function entityMatches(f) {
  const q = (f.eq || "").trim().toLowerCase();
  const inDistricts = districtTest(f);
  return model.entities.filter((e) => {
    if (f.etype && !matchesChoice(f.etype, e.type)) return false;
    if (f.ecounty && !matchesChoice(f.ecounty, e.county)) return false;
    if (q && !`${e.name}\n${e.county}`.toLowerCase().includes(q)) return false;
    return !inDistricts || inDistricts(...releaseWhere(e.name));
  });
}

function entityRows(f = TABS.entities.filter()) {
  let list = entityMatches(f);
  const { col, dir } = state.esort;
  const d = dir === "asc" ? 1 : -1;
  const key = {
    name: (e) => e.name, type: (e) => entityTypeLabel(e.type), county: (e) => e.county || "~",
    years: (e) => e.years.size, figures: (e) => e.figures.length, fees: (e) => e.fees.size,
    sources: (e) => e.sources.size, sum: (e) => e.sum,
  }[col];
  list = [...list].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
    return c * d || a.name.localeCompare(b.name);
  });
  return list;
}

function renderEntities(content) {
  const list = entityRows();
  const total = list.reduce((s, e) => s + e.sum, 0);
  const figures = list.reduce((s, e) => s + e.figures.length, 0);
  const onSort = (col) => { state.esort = toggleSort(state.esort, col, NUMERIC_SORTS.has(col)); update(); };
  const s = state.esort;
  const body = el("tbody");
  for (const e of list) {
    body.append(el("tr", { onclick: (ev) => { if (!ev.target.closest("a,button")) openEntity(e.name); } },
      el("td", { class: "col-entity" }, el("a", { href: entityHref(e.name), onclick: (ev) => { ev.preventDefault(); openEntity(e.name); }, text: e.name })),
      el("td", { text: entityTypeLabel(e.type) }),
      el("td", { text: e.county || "" }),
      el("td", { class: "col-years", title: fyRanges(e.yearList), text: fyRanges(e.yearList) }),
      el("td", { class: "num", text: fmtInt(e.years.size) }),
      el("td", { class: "num", text: fmtInt(e.figures.length) }),
      el("td", { class: "num", text: fmtInt(e.fees.size) }),
      el("td", { class: "num", text: fmtInt(e.sources.size) }),
      el("td", { class: "num", text: fmtSum(e.sum) }),
    ));
  }
  if (!list.length) body.append(el("tr", { class: "empty-row" }, el("td", { colspan: 9, text: "No jurisdiction matches." })));
  content.append(
    el("div", { class: "result-bar" },
      el("span", { class: "count" }, countOf(list.length, model.entities.length, "jurisdiction", filtersActive(TABS.entities.filter())), ` · ${fmtInt(figures)} figures`),
      sumNote({ sum: total }),
      el("span", { class: "active-filters" }, searchTag(state.eq, () => setFilter("entities", "eq", "")), boxTags("entities")),
      districtNote()),
    el("div", { class: "table-scroll" }, el("table", { class: "grid entities-grid" },
      el("thead", {}, el("tr", {},
        sortHeader("Jurisdiction", "name", s, onSort, "col-entity"),
        sortHeader("Type", "type", s, onSort, "", "etype"),
        sortHeader("County", "county", s, onSort, "", "ecounty"),
        el("th", { scope: "col", class: "col-years" }, el("span", { class: "col-label", text: "Fiscal years" })),
        sortHeader("Years", "years", s, onSort, "num"),
        sortHeader("Figures", "figures", s, onSort, "num"),
        sortHeader("Fees", "fees", s, onSort, "num"),
        sortHeader("Reports", "sources", s, onSort, "num"),
        sortHeader("Sum of figures", "sum", s, onSort, "num"),
      )),
      body)),
  );
}

function entityHref(name) {
  return hrefWith({ view: "entities", e: name });
}

function openEntity(name) {
  state.view = "entities";
  state.entity = name;
  state.figure = "";
  state.doc = "";
  update({ push: true });
  scrollContentTop();
}

function entityFigureOrder(entity) {
  return sortFigures(entity.figures, { col: "fy", dir: "asc" });
}

function renderEntityDossier(content) {
  const e = model.entityByName.get(state.entity);
  if (!e) {
    content.append(el("div", { class: "empty-state" }, `No jurisdiction named “${state.entity}” in this release. `,
      el("a", { href: hrefWith({ view: "entities" }), onclick: (ev) => { ev.preventDefault(); state.entity = ""; update({ push: true }); }, text: "All jurisdictions" })));
    return;
  }
  const matrix = entityMatrix(e);
  const order = entityFigureOrder(e).map((f) => f.id);
  const head = el("div", { class: "dossier-head" },
    el("a", { class: "back", href: hrefWith({ view: "entities" }), onclick: (ev) => { ev.preventDefault(); state.entity = ""; update({ push: true }); }, text: "← All jurisdictions" }),
    el("h2", { text: e.name }),
    el("div", { class: "dossier-meta" },
      [entityTypeLabel(e.type), e.county ? `${e.county} County` : "", `${fmtInt(e.figures.length)} figures`, `${fmtInt(e.fees.size)} fees`, `${fmtInt(e.sources.size)} reports`, `FY ${fyRanges(e.yearList)}`]
        .filter(Boolean).map((t) => el("span", { text: t }))),
    districtLines(...releaseWhere(e.name)),
    el("div", { class: "dossier-actions" },
      el("a", { class: "btn", href: figuresHref({ entity: e.name, sort: "fy.asc" }), onclick: (ev) => {
        ev.preventDefault();
        state.view = "figures";
        state.filters = { ...FIGURE_FILTERS, entity: e.name };
        state.sort = { col: "fy", dir: "asc" };
        state.page = 1;
        state.entity = "";
        update({ push: true });
      }, text: "Show in figures table" }),
      copyButton("Copy link", () => new URL(urlFor(), location.href).href)),
  );

  const years = matrix.years;
  const thead = el("thead", {}, el("tr", {},
    el("th", { class: "mx-program", scope: "col", text: "Fee" }),
    years.map((y) => el("th", { class: "num", scope: "col", text: fmtFy(y) }))));
  const tbody = el("tbody");
  for (const g of matrix.groups) {
    tbody.append(el("tr", { class: "mx-group" }, el("th", { colspan: years.length + 1, scope: "rowgroup", text: g.category ? namespaceLabel(g.category) : NOT_CLASSIFIED })));
    for (const row of g.fees) {
      tbody.append(el("tr", {},
        el("th", { class: "mx-program", scope: "row", title: row.fee.names.join(", then ") }, feeLink(row.fee)),
        years.map((y) => {
          const figs = row.cells.get(y);
          if (!figs) return el("td", { class: "mx-empty", title: "No figure" }, el("span", { "aria-label": "no figure", text: "·" }));
          return el("td", { class: "num" }, figs.map((fig) => el("button", {
            class: `mx-cell ${fig.id === state.figure ? "selected" : ""}`,
            type: "button",
            dataset: { id: fig.id },
            title: `${row.fee.names.length > 1 ? `${fig.program}\n` : ""}${fig.label}: printed “${fig.primary.source_value_text}” on PDF page ${fig.page}`,
            onclick: () => openFigure(fig.id, { list: order }),
          }, fmtUsd(fig.value), fig.restatements.length ? el("sup", { text: `×${fig.rows.length}` }) : null)));
        }),
      ));
    }
  }
  const tfoot = el("tfoot", {},
    el("tr", {}, el("th", { scope: "row", text: "Sum of figures" }), matrix.totals.map((t) => el("td", { class: "num", title: `${t.count} figure${t.count === 1 ? "" : "s"} in FY ${fmtFy(t.fy)}`, text: fmtSum(t.sum) }))),
    el("tr", { class: "mx-count" }, el("th", { scope: "row", text: "Figures" }), matrix.totals.map((t) => el("td", { class: "num", text: fmtInt(t.count) }))),
  );

  const sources = [...e.sources].map((id) => model.sourceById.get(id)).filter(Boolean)
    .sort((a, b) => String(a.covers_fiscal_year).localeCompare(String(b.covers_fiscal_year)));
  const permits = el("section", { class: "dossier-permits" });

  content.append(
    head,
    el("div", { class: "table-scroll" }, el("table", { class: "grid matrix" }, thead, tbody, tfoot)),
    permits,
    el("h3", { class: "section-label", text: `Reports (${sources.length})` }),
    sourcesTable(sources, { compact: true }),
  );
  renderEntityPermits(permits, e, permitsCtx());
}

// ------------------------------------------------------------ FEES

function currentFee() {
  return state.fee ? model.feeByKey.get(feeKey(state.entity, state.fee)) || null : null;
}

function feeHref(fee) {
  return hrefWith({ view: "fees", e: fee.entity, fee: fee.figures[fee.figures.length - 1].program });
}

function openFee(fee) {
  state.view = "fees";
  state.entity = fee.entity;
  state.fee = fee.figures[fee.figures.length - 1].program;
  state.figure = "";
  state.doc = "";
  update({ push: true });
  scrollContentTop();
}

function feeLink(fee, text = fee.label) {
  return el("a", { href: feeHref(fee), text, onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); openFee(fee); } });
}

function feeMatches(q) {
  const terms = searchTerms(q.fq);
  const inDistricts = districtTest(q);
  return model.fees.filter((f) => {
    const p = latestPrimary(f);
    if (q.fentity && !matchesChoice(q.fentity, f.entity)) return false;
    if (q.fcat && !matchesCategory(q.fcat, f.cat)) return false;
    if (q.ftype && !matchesChoice(q.ftype, p.entity_type)) return false;
    if (q.fcounty && !matchesChoice(q.fcounty, p.county)) return false;
    if (!terms.every((t) => f.search.includes(t))) return false;
    return !inDistricts || inDistricts(...releaseWhere(f.entity));
  });
}

function feeRows(q = TABS.fees.filter()) {
  let list = feeMatches(q);
  const { col, dir } = state.fsort;
  const d = dir === "asc" ? 1 : -1;
  const key = {
    entity: (f) => f.entity, fee: (f) => f.label, category: (f) => (f.cat ? categoryLabel(f.cat) : "~"),
    years: (f) => f.years.size, last: (f) => f.yearList[f.yearList.length - 1], figures: (f) => f.figures.length, sum: (f) => f.sum,
  }[col];
  list = [...list].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
    return c * d || a.entity.localeCompare(b.entity) || a.label.localeCompare(b.label);
  });
  return list;
}

function renderFees(content) {
  const list = feeRows();
  const total = list.reduce((s, f) => s + f.sum, 0);
  const entities = new Set(list.map((f) => f.entity)).size;
  const onSort = (col) => { state.fsort = toggleSort(state.fsort, col, NUMERIC_SORTS.has(col)); update(); };
  const s = state.fsort;
  const body = el("tbody");
  for (const f of list) {
    body.append(el("tr", { onclick: (ev) => { if (!entityCellClick(ev) && !ev.target.closest("a,button")) openFee(f); } },
      el("td", { class: "col-entity" }, entityFilterLink(f.entity)),
      el("td", { class: "col-fee", title: f.names.length > 1 ? `Printed as ${f.names.join(", then ")}` : null }, feeLink(f)),
      el("td", { text: categoryLabel(f.cat) }),
      el("td", { class: "col-years", title: fyRanges(f.yearList), text: fyRanges(f.yearList) }),
      el("td", { class: "num", text: fmtInt(f.years.size) }),
      el("td", { class: "num", text: fmtInt(f.figures.length) }),
      el("td", { class: "num", text: fmtSum(f.sum) }),
    ));
  }
  if (!list.length) body.append(el("tr", { class: "empty-row" }, el("td", { colspan: 7, text: "No fee matches." })));
  content.append(
    el("div", { class: "result-bar" },
      el("span", { class: "count" }, countOf(list.length, model.fees.length, "fee", filtersActive(TABS.fees.filter())), ` · ${fmtInt(entities)} jurisdiction${entities === 1 ? "" : "s"}`),
      sumNote({ sum: total }),
      el("span", { class: "active-filters" }, searchTag(state.fq, () => setFilter("fees", "fq", "")), boxTags("fees")),
      districtNote()),
    el("div", { class: "table-scroll" }, el("table", { class: "grid fees-grid" },
      el("thead", {}, el("tr", {},
        sortHeader("Jurisdiction", "entity", s, onSort, "col-entity", "fentity"),
        sortHeader("Fee", "fee", s, onSort, "col-fee"),
        sortHeader("Category", "category", s, onSort, "", "fcat"),
        sortHeader("Fiscal years", "last", s, onSort, "col-years"),
        sortHeader("Years", "years", s, onSort, "num"),
        sortHeader("Figures", "figures", s, onSort, "num"),
        sortHeader("Sum of figures", "sum", s, onSort, "num"),
      )),
      body)),
  );
}

// How a later name was joined to an earlier one (see fee-links.js).
const JOINED = {
  balance: ["Balance", "Its opening balance is the old name's closing balance"],
  reprint: ["Reprint", "Its report reprints the old name's figures"],
  restated: ["Restated", "Same name, renumbered; opening balance restated"],
  renamed: ["Fund", "Same fund number, retitled"],
  wording: ["Wording", "Names differ only in wording"],
};

function joinedCell(join) {
  if (!join) return el("td", { class: "col-joined" });
  const [label, tip] = JOINED[join.evidence] || [join.evidence, ""];
  const raw = String(join.detail || "");
  const detail = `${/^\d{4}-\d{2}\b/.test(raw) ? "FY " : ""}${raw.replace(/\b\d{4}-\d{2}\b/g, (m) => fmtFy(m))}`;
  return el("td", { class: "col-joined" }, el("span", { "data-tip": tip, tabindex: "0", text: detail ? `${label} ${detail}` : label }));
}

function renderFeePage(content) {
  const fee = currentFee();
  const back = el("a", { class: "back", href: hrefWith({ view: "fees" }), onclick: (ev) => { ev.preventDefault(); state.fee = ""; state.entity = ""; update({ push: true }); }, text: "← All fees" });
  if (!fee) {
    content.append(el("div", { class: "empty-state" }, `No fee named “${state.fee}” at ${state.entity || "this jurisdiction"}. `, back));
    return;
  }
  const order = fee.figures.map((f) => f.id);
  const first = fee.yearList[0];
  const last = fee.yearList[fee.yearList.length - 1];
  const span = [];
  for (let y = fyStartYear(first); y <= fyStartYear(last); y += 1) span.push(`${y}-${String((y + 1) % 100).padStart(2, "0")}`);
  const head = el("div", { class: "dossier-head" },
    back,
    el("h2", { text: fee.label }),
    el("div", { class: "dossier-meta" },
      el("span", {}, el("a", { href: entityHref(fee.entity), onclick: (ev) => { ev.preventDefault(); openEntity(fee.entity); }, text: fee.entity })),
      [categoryLabel(fee.cat), `FY ${fyRanges(fee.yearList)}`, `${fmtInt(fee.figures.length)} figures`, `${fmtInt(fee.sources.size)} reports`, `sum ${fmtSum(fee.sum)}`]
        .filter(Boolean).map((t) => el("span", { text: t }))),
    districtLines(...releaseWhere(fee.entity)),
    el("div", { class: "dossier-actions" }, copyButton("Copy link", () => new URL(urlFor(), location.href).href)),
  );
  const joinTo = new Map(fee.joins.map((j) => [j.to, j]));
  const body = el("tbody");
  let prevName = null;
  for (const fy of span) {
    const figs = fee.figures.filter((f) => f.fy === fy);
    if (!figs.length) {
      body.append(el("tr", { class: "fee-missing" },
        el("td", { class: "col-fy", text: fmtFy(fy) }),
        el("td", { class: "num", text: "·" }),
        el("td", { class: "muted", text: "No figure" }),
        el("td"), el("td", { class: "col-joined" })));
      continue;
    }
    for (const fig of figs) {
      const changed = fig.program !== prevName;
      const join = changed && prevName !== null ? joinTo.get(fig.program) : null;
      body.append(el("tr", {
        class: fig.id === state.figure ? "selected-row" : "",
        dataset: { id: fig.id },
        onclick: (ev) => { if (!ev.target.closest("a,button")) openFigure(fig.id, { list: order }); },
      },
        el("td", { class: "col-fy", text: fmtFy(fy) }),
        el("td", { class: "num", text: fmtUsd(fig.value) }),
        el("td", { class: `col-printed ${changed ? "" : "same"}`, title: fig.program, text: changed ? fig.program : "″" }),
        el("td", {}, el("button", { class: "pdf-btn", type: "button", text: `p.${fig.page}`, title: "Open outlined page", onclick: () => openFigure(fig.id, { list: order }) })),
        joinedCell(join),
      ));
      prevName = fig.program;
    }
  }
  content.append(
    head,
    feeChart(fee, span),
    el("div", { class: "table-scroll fee-history" }, el("table", { class: "grid fee-grid" },
      el("thead", {}, el("tr", {},
        ["FY", "Collected", "Printed as", "Page", "Joined by"].map((h, i) => el("th", { scope: "col", class: i === 1 ? "num" : "", text: h })))),
      body)),
  );
}

// One bar per fiscal year in the fee's span; a year with no figure has none.
function feeChart(fee, span) {
  const W = 760;
  const H = 170;
  const m = { top: 10, right: 8, bottom: 24, left: 64 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const byYear = new Map(span.map((fy) => [fy, fee.figures.filter((f) => f.fy === fy)]));
  const total = (figs) => figs.reduce((s, f) => s + (Number.isFinite(f.value) ? f.value : 0), 0);
  const values = [...byYear.values()].filter((figs) => figs.length).map(total);
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const step = niceStep((max - min) / 4);
  const top = Math.ceil(max / step) * step;
  const bottom = Math.floor(min / step) * step;
  const y = (v) => m.top + ((top - v) / (top - bottom)) * ih;
  const band = iw / span.length;
  const bw = Math.min(28, Math.max(2, band - 3));
  const root = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${fee.label}: fees collected by fiscal year` });
  for (let v = bottom; v <= top + 1e-9; v += step) {
    root.append(
      svg("line", { class: "grid-line", x1: m.left, x2: W - m.right, y1: y(v), y2: y(v) }),
      svg("text", { class: "tick", x: m.left - 6, y: y(v) + 3, "text-anchor": "end", text: fmtSum(v) }),
    );
  }
  const every = Math.ceil(span.length / 10);
  span.forEach((fy, i) => {
    const figs = byYear.get(fy);
    const x = m.left + i * band + (band - bw) / 2;
    if (figs.length) {
      const v = total(figs);
      const y0 = y(Math.max(0, v));
      const h = Math.max(1, Math.abs(y(v) - y(0)));
      const bar = svg("rect", { class: "bar", x, y: y0, width: bw, height: h, rx: Math.min(3, bw / 2) });
      const hit = svg("rect", { class: "hit", x: m.left + i * band, y: m.top, width: band, height: ih, tabindex: 0, "aria-label": `FY ${fmtFy(fy)}: ${fmtUsd(v)}` });
      const show = (ev) => {
        bar.classList.add("on");
        showTooltip(ev, [el("strong", { text: fmtUsd(v) }), el("div", { text: `FY ${fmtFy(fy)}` })]);
      };
      const hide = () => { bar.classList.remove("on"); hideTooltip(); };
      hit.addEventListener("pointermove", show);
      hit.addEventListener("pointerleave", hide);
      hit.addEventListener("focus", show);
      hit.addEventListener("blur", hide);
      hit.addEventListener("click", () => openFigure(figs[0].id, { list: fee.figures.map((f) => f.id) }));
      root.append(bar, hit);
    }
    if (i % every === 0 || i === span.length - 1) {
      root.append(svg("text", { class: "tick", x: m.left + i * band + band / 2, y: H - 7, "text-anchor": "middle", text: fmtFy(fy) }));
    }
  });
  root.append(svg("line", { class: "axis", x1: m.left, x2: W - m.right, y1: y(0), y2: y(0) }));
  return el("div", { class: "chart-wrap fee-chart" }, root);
}

// ------------------------------------------------------------ SOURCES

// covers_fiscal_year is free text in the release ("2023-24; 2024-25",
// ["2023-24"], "2023-2024"); the Covers box takes the fiscal years it names.
const coversCache = new WeakMap();

function coversYears(s) {
  let v = coversCache.get(s);
  if (!v) {
    const text = String(s.covers_fiscal_year || "");
    const found = [...text.matchAll(/\b(\d{4})-(\d{2}|\d{4})\b/g)]
      .filter((m) => Number(m[2].slice(-2)) === (Number(m[1]) + 1) % 100)
      .map((m) => `${m[1]}-${m[2].slice(-2)}`);
    // A report kept on a calendar year names it alone ("2024", "2003;2004"),
    // as the Figures fiscal year box lists it; a range or a date is not one.
    const calendar = [...text.matchAll(/(?<!\d[-/])\b((?:19|20)\d{2})\b(?![-/]\d)/g)].map((m) => m[1]);
    v = [...new Set([...found, ...calendar])].sort();
    coversCache.set(s, v);
  }
  return v;
}

function coversMatch(want, s) {
  const set = new Set(splitChoice(want));
  const years = coversYears(s);
  return years.length ? years.some((y) => set.has(y)) : set.has(NONE);
}

// The Publication type box keys on the label the table shows, since many
// release codes share one label. A code in the address reads as its label.
function sourceType(s) {
  return publicationTypeLabel(s.publication_type);
}

function sourceTypeNorm(v) {
  return v !== NONE && /^[a-z0-9_]+$/.test(v) ? publicationTypeLabel(v) : v;
}

function sourceMatches(f) {
  const q = (f.sq || "").trim().toLowerCase();
  const inDistricts = districtTest(f);
  return model.sources.filter((s) => (!f.sentity || matchesChoice(f.sentity, s.receiving_entity)) &&
    (!f.stype || matchesChoice(f.stype, sourceType(s))) &&
    (!f.sfy || coversMatch(f.sfy, s)) &&
    (!q || s._search.includes(q)) &&
    (!inDistricts || inDistricts(...releaseWhere(s.receiving_entity))));
}

function sourceRows(f = TABS.sources.filter()) {
  let list = sourceMatches(f);
  const { col, dir } = state.ssort;
  const d = dir === "asc" ? 1 : -1;
  const key = {
    agency: (s) => s.receiving_entity, title: (s) => s.publication_title, type: (s) => s.publication_type,
    fy: (s) => s.covers_fiscal_year, pages: (s) => s._pages || 0, bytes: (s) => s._bytes || 0, figures: (s) => s._figures,
  }[col];
  list = [...list].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
    return c * d || String(a.covers_fiscal_year).localeCompare(String(b.covers_fiscal_year));
  });
  return list;
}

function sourcesTable(list, { compact = false, sortable = false } = {}) {
  const s = state.ssort;
  const onSort = (col) => { state.ssort = toggleSort(state.ssort, col, NUMERIC_SORTS.has(col)); update(); };
  const th = (label, col, cls = "", filter = "") => (sortable ? sortHeader(label, col, s, onSort, cls, filter && boxSpec("sources", filter)) : el("th", { scope: "col", class: cls }, el("span", { class: "col-label", text: label })));
  const body = el("tbody");
  for (const src of list) {
    const off = officialUrl(src.official_source_url);
    body.append(el("tr", {
      class: src.source_id === state.doc ? "selected-row" : "",
      dataset: { doc: src.source_id },
      onclick: (ev) => { if (!entityCellClick(ev) && !ev.target.closest("a,button")) openDoc(src.source_id); },
    },
      compact ? null : el("td", { class: "col-entity" }, entityFilterLink(src.receiving_entity)),
      el("td", { class: "col-title", title: src.publication_title, text: src.publication_title }),
      el("td", { class: "col-type", title: src.publication_type, text: publicationTypeLabel(src.publication_type) }),
      el("td", { class: "col-fy", text: fmtFy(src.covers_fiscal_year) }),
      el("td", { class: "num", text: src._pages ? fmtInt(src._pages) : "" }),
      el("td", { class: "num", text: fmtBytes(src._bytes) }),
      el("td", { class: "num" }, src._figures ? el("a", {
        href: figuresHref({ source: src.source_id, sort: "page.asc" }),
        title: "Show these figures in table",
        onclick: (ev) => { ev.preventDefault(); showSourceFigures(src.source_id); },
        text: fmtInt(src._figures),
      }) : "0"),
      el("td", { class: "col-evidence" }, el("span", { class: "ev-links" },
        el("button", { class: "pdf-btn", type: "button", text: "Open", title: "Open report", onclick: () => openDoc(src.source_id) }),
        off ? el("a", { class: "pdf-btn ext", href: off, target: "_blank", rel: "noopener", title: "Official source", "aria-label": "Official source", text: "↗" }) : null)),
    ));
  }
  if (!list.length) body.append(el("tr", { class: "empty-row" }, el("td", { colspan: compact ? 7 : 8, text: "No source matches." })));
  return el("div", { class: "table-scroll" }, el("table", { class: `grid sources-grid ${compact ? "compact" : ""}` },
    el("thead", {}, el("tr", {},
      compact ? null : th("Agency", "agency", "col-entity", "sentity"),
      th("Publication", "title", "col-title"),
      th("Type", "type", "col-type", "stype"),
      th("Covers", "fy", "col-fy", "sfy"),
      th("Pages", "pages", "num"),
      th("Size", "bytes", "num"),
      th("Figures", "figures", "num"),
      el("th", { scope: "col", class: "col-evidence" }, el("span", { class: "col-label", text: "Report" })))),
    body));
}

function showSourceFigures(sourceId) {
  state.view = "figures";
  state.filters = { ...FIGURE_FILTERS, source: sourceId };
  state.sort = { col: "page", dir: "asc" };
  state.page = 1;
  state.entity = "";
  update({ push: true });
}

function renderSources(content) {
  const list = sourceRows();
  const pages = list.reduce((s, x) => s + (x._pages || 0), 0);
  content.append(
    el("div", { class: "result-bar" },
      el("span", { class: "count" }, countOf(list.length, model.sources.length, "publication", filtersActive(TABS.sources.filter())), ` · ${fmtInt(pages)} pages`),
      el("span", { class: "active-filters" }, searchTag(state.sq, () => setFilter("sources", "sq", "")), boxTags("sources")),
      districtNote()),
    sourcesTable(list, { sortable: true }),
  );
}

// ------------------------------------------------------------ STATS

let statsData = null;

function renderStatsView(content) {
  const figs = model.figures;
  const firstFy = model.years[0];
  const lastFy = model.years[model.years.length - 1];
  const basisStated = (f) => !["", "Not stated"].includes(basisLabel(f.primary.accounting_basis_source_read));
  content.append(el("div", { class: "stats-view" },
    districtElsewhereNote("Stats cover the whole release, and their links open the other tabs under the filter."),
    el("div", { class: "tiles" },
      tile("Printed figures", fmtInt(figs.length)),
      tile("Data rows", fmtInt(model.rows.length)),
      tile("Jurisdictions", fmtInt(model.entities.length)),
      tile("Fees", fmtInt(model.fees.length)),
      tile("Source publications", fmtInt(model.sources.length)),
      tile("Fiscal years", fmtInt(model.years.length), `${fmtFy(firstFy)} to ${fmtFy(lastFy)}`)),
    el("h3", { class: "section-label", text: "Figures by fiscal year" }),
    coverageChart(coverageByYear(figs)),
    el("div", { class: "stats-cols" },
      el("div", { class: "stats-col" },
        statsBlock("Fee category", breakdownTable("Category", figs, (f) => (f.cat || "").split("/")[0], namespaceLabel, (v) => ({ cat: v || NONE }))),
        statsBlock("Law", breakdownTable("Law", figs, (f) => f.law, lawLabel, (v) => ({ law: v || NONE }))),
        statsBlock("Area", breakdownTable("Area", figs, (f) => f.area, areaLabel, (v) => ({ area: v || NONE })))),
      el("div", { class: "stats-col" },
        statsBlock("Jurisdiction type", breakdownTable("Type", figs, (f) => f.primary.entity_type, entityTypeLabel, (v) => ({ type: v || NONE }))),
        statsBlock("Land use", breakdownTable("Land use", figs, (f) => scopeKey(f.primary.land_use_scope), scopeLabel, (v) => ({ scope: v || NONE }))),
        statsBlock("Figures", shareTable(figs, [
          ["Arithmetic check", (f) => f.arith, { arith: "yes" }],
          ["Accounting basis stated", basisStated],
          ["Restated", (f) => f.restatements.length > 0],
          ["Printed in thousands", (f) => f.thousands],
          ["Printed zero", (f) => f.zero],
        ])))),
    el("div", { id: "stats-release" }, el("p", { class: "muted", text: "Loading…" })),
  ));
  loadStats().then(() => fillStats()).catch((err) => {
    const slot = $("stats-release");
    if (slot) slot.replaceChildren(el("p", { class: "muted", text: `Failed to load: ${err.message}` }));
  });
}

function tile(label, value, sub = "") {
  return el("div", { class: "tile" },
    el("div", { class: "tile-label", text: label }),
    el("div", { class: "tile-value", text: value }),
    sub ? el("div", { class: "tile-sub", text: sub }) : null);
}

function statsBlock(title, table) {
  return el("section", { class: "stats-block" },
    el("h3", { class: "section-label", text: title }),
    el("div", { class: "table-scroll" }, table));
}

function statsTable(heads, rows) {
  return el("table", { class: "grid" },
    el("thead", {}, el("tr", {}, heads.map((h, i) => el("th", { scope: "col", class: i ? "num" : "", text: h })))),
    el("tbody", {}, rows));
}

// A name in a stats table that lists the figures it counts.
function filterLink(text, filters) {
  return el("a", {
    href: figuresHref(filters), text,
    onclick: (ev) => { ev.preventDefault(); showFiltered(filters); },
  });
}

// Figures, jurisdictions and sum for each value of key, most figures first.
function breakdownTable(head, figs, key, label, filters) {
  const groups = new Map();
  for (const f of figs) {
    const k = key(f) || "";
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { k, figures: 0, entities: new Set(), sum: 0 }));
    g.figures += 1;
    g.entities.add(f.entity);
    if (f.primary._primary && Number.isFinite(f.value)) g.sum += f.value;
  }
  const name = (k) => (k ? label(k) : "Not recorded");
  const rows = [...groups.values()]
    .sort((a, b) => b.figures - a.figures || name(a.k).localeCompare(name(b.k)))
    .map((g) => el("tr", {},
      el("td", {}, filterLink(name(g.k), filters(g.k))),
      el("td", { class: "num", text: fmtInt(g.figures) }),
      el("td", { class: "num", text: fmtInt(g.entities.size) }),
      el("td", { class: "num", text: fmtSum(g.sum) })));
  return statsTable([head, "Figures", "Jurisdictions", "Sum"], rows);
}

function shareTable(figs, tests) {
  return statsTable(["", "Figures", "Share"], tests.map(([text, test, filters]) => {
    const n = figs.filter(test).length;
    return el("tr", {},
      el("td", {}, filters ? filterLink(text, filters) : text),
      el("td", { class: "num", text: fmtInt(n) }),
      el("td", { class: "num", text: `${Math.round((100 * n) / figs.length)}%` }));
  }));
}

const DATA_TABLES = ["reported-fee-collections", "residential-cash-receipts", "capital-spending", "residential-funded-shares"];

async function loadStats() {
  if (statsData) return statsData;
  const [cohort, refusals, manifest] = await Promise.all([
    fetchJson("data/cohort-accounting.json"),
    fetchText("data/refusals-by-reason.csv").then((t) => parseCsvObjects(t).rows),
    ensureManifest(),
  ]);
  const tables = await Promise.all(DATA_TABLES.map(async (name) => {
    const rows = name === "reported-fee-collections" ? model.rows.length : parseCsvObjects(await fetchText(`data/${name}.csv`)).rows.length;
    return { name, rows };
  }));
  statsData = { cohort, refusals, manifest, tables };
  return statsData;
}

function fillStats() {
  const slot = $("stats-release");
  if (!slot || !statsData) return;
  const { cohort, refusals, manifest, tables } = statsData;
  const doc = (path, label) => el("a", { href: dataUrl(path), target: "_blank", rel: "noopener", text: label });
  const kv = (k, v) => el("tr", {}, el("th", { scope: "row", text: k }), el("td", { class: "num", text: v }));
  const links = (k, ...items) => el("tr", {}, el("th", { scope: "row", text: k }),
    el("td", {}, items.flatMap((a, i) => (i ? [" · ", a] : [a]))));
  slot.replaceChildren(el("div", { class: "stats-cols" },
    el("div", { class: "stats-col" },
      el("section", { class: "stats-block" },
        el("h3", { class: "section-label", text: "Review" }),
        el("table", { class: "grid kv" }, el("tbody", {},
          kv("Cohort reviewed", fmtInt(cohort.reviewed)),
          kv("Cohort published", fmtInt(cohort.published)),
          kv("Refused", fmtInt(cohort.refused)),
          kv("Undecided", fmtInt(cohort.remaining_undecided)),
          kv("Statewide lane", fmtInt(cohort.statewide_lane_rows_in_data_file)),
          kv("Total rows", fmtInt(cohort.total_rows_in_data_file))))),
      statsBlock("Tables", statsTable(["File", "Rows"], tables.map((t) => el("tr", {},
        el("td", { text: `${t.name}.csv` }),
        el("td", { class: "num", text: fmtInt(t.rows) }))))),
      el("section", { class: "stats-block" },
        el("h3", { class: "section-label", text: "Release" }),
        el("table", { class: "grid kv" }, el("tbody", {},
          kv("Release", manifest.release || ""),
          kv("Built (UTC)", manifest.built_utc || ""),
          kv("Files, each with a SHA-256", fmtInt(manifest.file_count || manifest.files.size)),
          kv("Total size", fmtBytes(manifest.total_bytes)),
          links("Method", doc("docs/methodology.md", "methodology"), doc("docs/data-dictionary.md", "data dictionary"),
            doc("docs/coverage.md", "coverage and gaps")))))),
    el("div", { class: "stats-col" },
      statsBlock("Refusals", statsTable(["Reason", "Rows", "Agencies", "Documents"], refusals.map((r) => el("tr", {},
        el("td", { text: humanize(r.refusal_reason_code) }),
        el("td", { class: "num", text: fmtInt(Number(r.rows_refused)) }),
        el("td", { class: "num", text: fmtInt(Number(r.agencies_affected)) }),
        el("td", { class: "num", text: fmtInt(Number(r.source_documents_affected)) }))))))));
}

// Single series, so no legend: the heading names it. Bars carry the theme's
// bar fill; every value is also in the table below the chart.
function coverageChart(data) {
  const W = 760;
  const H = 210;
  const m = { top: 12, right: 8, bottom: 26, left: 40 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const max = Math.max(1, ...data.map((d) => d.figures));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const band = iw / data.length;
  const bw = Math.min(24, Math.max(2, band - 2));
  const y = (v) => m.top + ih - (v / top) * ih;
  const root = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Published figures by fiscal year" });
  for (let v = 0; v <= top + 1e-9; v += step) {
    root.append(
      svg("line", { class: "grid-line", x1: m.left, x2: W - m.right, y1: y(v), y2: y(v) }),
      svg("text", { class: "tick", x: m.left - 6, y: y(v) + 3, "text-anchor": "end", text: fmtInt(v) }),
    );
  }
  data.forEach((d, i) => {
    const x = m.left + i * band + (band - bw) / 2;
    const yTop = y(d.figures);
    const h = m.top + ih - yTop;
    const r = Math.min(4, bw / 2, h);
    const path = h > 0
      ? `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + bw - r} Q${x + bw},${yTop} ${x + bw},${yTop + r} V${yTop + h} Z`
      : "";
    const bar = svg("path", { class: "bar", d: path });
    const hit = svg("rect", {
      class: "hit", x: m.left + i * band, y: m.top, width: band, height: ih, tabindex: 0,
      "aria-label": `FY ${fmtFy(d.fy)}: ${d.figures} figures from ${d.entities} jurisdictions`,
    });
    const show = (ev) => {
      bar.classList.add("on");
      showTooltip(ev, [
        el("strong", { text: `${fmtInt(d.figures)} figure${d.figures === 1 ? "" : "s"}` }),
        el("div", { text: `FY ${fmtFy(d.fy)}` }),
        el("div", { class: "muted", text: `${fmtInt(d.entities)} jurisdiction${d.entities === 1 ? "" : "s"} · sum ${fmtSum(d.sum)}` }),
      ]);
    };
    const hide = () => { bar.classList.remove("on"); hideTooltip(); };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("focus", show);
    hit.addEventListener("blur", hide);
    root.append(bar, hit);
    const start = Number(d.fy.slice(0, 4));
    if (start % 5 === 0 || i === data.length - 1) {
      root.append(svg("text", { class: "tick", x: m.left + i * band + band / 2, y: H - 8, "text-anchor": "middle", text: fmtFy(d.fy) }));
    }
  });
  root.append(svg("line", { class: "axis", x1: m.left, x2: W - m.right, y1: m.top + ih, y2: m.top + ih }));
  const table = el("details", { class: "chart-table" },
    el("summary", { text: "Show as a table" }),
    el("table", { class: "grid" },
      el("thead", {}, el("tr", {}, ["Fiscal year", "Figures", "Jurisdictions", "Sum of figures"].map((h, i) => el("th", { scope: "col", class: i ? "num" : "", text: h })))),
      el("tbody", {}, data.map((d) => el("tr", {},
        el("td", { text: fmtFy(d.fy) }), el("td", { class: "num", text: fmtInt(d.figures) }),
        el("td", { class: "num", text: fmtInt(d.entities) }), el("td", { class: "num", text: fmtSum(d.sum) }))))));
  return el("figure", { class: "chart-wrap" }, root, table);
}

function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(Math.max(x, 1e-9)));
  const n = x / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

// Short tips for tags (data-tip), shown at once on hover
// or focus. A title attribute waits a second and cannot be styled.
function initTips() {
  const tip = $("tooltip");
  let current = null;
  const show = (t) => {
    current = t;
    tip.className = "tooltip tip-short";
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    const r = t.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))}px`;
    const above = r.top - tip.offsetHeight - 6;
    tip.style.top = `${above >= 8 ? above : r.bottom + 6}px`;
  };
  const hide = () => {
    if (!current) return;
    current = null;
    tip.hidden = true;
  };
  document.addEventListener("pointerover", (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (t && t !== current) show(t);
    else if (!t) hide();
  });
  document.addEventListener("focusin", (e) => { const t = e.target.closest?.("[data-tip]"); if (t) show(t); });
  document.addEventListener("focusout", hide);
  document.addEventListener("click", hide);
  document.addEventListener("scroll", hide, true);
}

function showTooltip(ev, children) {
  const tip = $("tooltip");
  tip.className = "tooltip";
  tip.replaceChildren(...children);
  tip.hidden = false;
  const r = ev.target.getBoundingClientRect();
  const x = ev.clientX ?? r.left + r.width / 2;
  const yPos = ev.clientY ?? r.top;
  const w = tip.offsetWidth;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x + 12))}px`;
  tip.style.top = `${Math.max(8, yPos - tip.offsetHeight - 10)}px`;
}

function hideTooltip() {
  $("tooltip").hidden = true;
}

// ------------------------------------------------------------ COVERAGE
// How much of the roster's annual fee reports has been harvested, and how
// much the release has processed, by jurisdiction and fiscal year. The counts
// are coverage/coverage.json in this repository, which scripts/coverage.mjs
// writes from the collection project's screening inventory; they are not part
// of the release.

const COVERAGE_URL = "coverage/coverage.json";
// The tab counts fiscal years from RECENT_FROM on unless the toggle at the
// top right says "All years" (cyr=all). This browser remembers the choice
// under COVERAGE_YEARS_KEY; a link's cyr=all wins over it.
const RECENT_FROM = "2022-23";
const COVERAGE_YEARS_KEY = "mfa.coverage.years";
const COVERAGE_PAGE = 100;
const COVERAGE_CLASSES = ["municipal", "school", "special"];
const COVERAGE_STATUSES = [
  ["", "All"],
  ["none", "Nothing harvested"],
  ["gaps", "A year not harvested"],
  ["waiting", "Harvested, not yet processed"],
  ["done", "Every year processed"],
  ["nofee", "Charges no such fees"],
];
const COVERAGE_STATUS_LABEL = new Map(COVERAGE_STATUSES.filter(([k]) => k));
// h and p are the years harvested and processed, as bits within m.
const COVERAGE_STATUS_TEST = {
  none: (a, h) => !h && !a.nofee,
  gaps: (a, h, p, m) => h !== m && !a.nofee,
  waiting: (a, h, p) => (h & ~p) !== 0,
  done: (a, h, p, m) => p === m,
  nofee: (a) => a.nofee,
};
const COVERAGE_SORTS = ["name", "type", "county", "harvested", "processed"];
const DEFAULT_COVERAGE_SORT = { col: "name", dir: "asc" };
let coverageData = null;
let coveragePromise = null;

function loadCoverage() {
  if (!coveragePromise) {
    coveragePromise = fetch(new URL(COVERAGE_URL, document.baseURI), { cache: "no-cache" }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} reading ${COVERAGE_URL}`);
      const d = await res.json();
      const col = Object.fromEntries(d.columns.map((c, i) => [c, i]));
      coverageData = {
        ...d,
        agencies: d.agencies.map((a) => ({
          name: a[col.name], cls: d.classes[a[col.class]].key, type: d.types[a[col.type]], county: d.counties[a[col.county]],
          h: a[col.harvested], p: a[col.processed], nofee: Boolean(a[col.no_fees]), names: a[col.release_names] || [],
        })),
      };
      return coverageData;
    });
    coveragePromise.catch(() => { coveragePromise = null; });
  }
  return coveragePromise;
}

const bitCount = (n) => { let c = 0; for (let x = n; x; x &= x - 1) c += 1; return c; };

// The fiscal years being counted, as bits of coverage.years.
function coverageMask(d) {
  return d.years.reduce((m, fy, i) => (state.cyr === "all" || fy >= RECENT_FROM ? m | (1 << i) : m), 0);
}

function storedCoverageYears() {
  try {
    return localStorage.getItem(COVERAGE_YEARS_KEY) === "all" ? "all" : "";
  } catch {
    return "";
  }
}

function coverageYearsToggle() {
  const pick = (v, text) => el("button", {
    class: "btn", type: "button", "data-cyr": v, "aria-pressed": state.cyr === v ? "true" : "false", text,
    onclick: () => {
      try {
        localStorage.setItem(COVERAGE_YEARS_KEY, v);
      } catch {
        // Storage blocked: the choice still holds for this page and its URL.
      }
      if (state.cyr !== v) setCoverage({ cyr: v });
    },
  });
  return el("span", { class: "cov-years-toggle", role: "group", "aria-label": "Fiscal years counted" },
    pick("", `FY ${fmtFy(RECENT_FROM)} onward`), pick("all", "All years"));
}

// Every class and type pair on the roster: class order, types by name.
let coveragePairs = { d: null, byClass: new Map() };

function coverageTypePairs(d) {
  if (coveragePairs.d !== d) {
    const sets = new Map(d.classes.map((c) => [c.key, new Set()]));
    for (const a of d.agencies) sets.get(a.cls)?.add(a.type || NONE);
    const byClass = new Map([...sets].map(([cls, types]) => [cls, [...types].sort((x, y) => coverageTypeName(x).localeCompare(coverageTypeName(y)))]));
    coveragePairs = { d, byClass };
  }
  return coveragePairs.byClass;
}

const coverageTypeName = (t) => (t && t !== NONE ? humanize(t) : "(not recorded)");
const coverageClassLabel = (k) => coverageData?.classes.find((c) => c.key === k)?.label || humanize(k);
const coveragePair = (a) => `${a.cls}:${a.type || NONE}`;

function coverageTypeText(v) {
  const i = v.indexOf(":");
  if (i > 0) return `${coverageClassLabel(v.slice(0, i))} › ${coverageTypeName(v.slice(i + 1))}`;
  return COVERAGE_CLASSES.includes(v) ? coverageClassLabel(v) : coverageTypeName(v);
}

// The Type box is one tree: classes (ccls) with their types under them
// (ctype). A qualified type ("school:unified_school_district") adds to the
// classes ticked whole; a plain type, as older links and the By agency type
// table wrote it, narrows the classes instead (or the whole roster).
function coverageTypeTest(f) {
  const classes = new Set(splitChoice(f.ccls));
  const types = splitChoice(f.ctype);
  if (!classes.size && !types.length) return null;
  const pairs = new Set(types.filter((t) => t.includes(":")));
  const plain = new Set(types.filter((t) => !t.includes(":")));
  return (a) => {
    if (pairs.has(coveragePair(a))) return true;
    if (plain.size) return (!classes.size || classes.has(a.cls)) && plain.has(a.type || NONE);
    return classes.has(a.cls);
  };
}

// The box's value in its own terms: classes ticked whole, then pairs. A
// plain type becomes the pairs it selects.
function coverageTypeRaw() {
  const classes = splitChoice(state.ccls);
  const types = splitChoice(state.ctype);
  const plain = types.filter((t) => !t.includes(":"));
  if (!plain.length || !coverageData) return [...classes, ...types].join(SEP);
  const out = types.filter((t) => t.includes(":"));
  for (const [cls, list] of coverageTypePairs(coverageData)) {
    if (classes.length && !classes.includes(cls)) continue;
    for (const t of list) if (plain.includes(t)) out.push(`${cls}:${t}`);
  }
  return [...new Set(out)].join(SEP);
}

function setCoverageTypes(raw) {
  const parts = splitChoice(raw);
  state.ccls = parts.filter((v) => COVERAGE_CLASSES.includes(v)).join(SEP);
  state.ctype = parts.filter((v) => v.includes(":")).join(SEP);
  resetPages();
  update();
}

function coverageTypeOptions(rows) {
  const counts = new Map();
  for (const a of rows) counts.set(coveragePair(a), (counts.get(coveragePair(a)) || 0) + 1);
  const out = [];
  for (const [cls, types] of coverageTypePairs(coverageData)) {
    const children = types.filter((t) => counts.get(`${cls}:${t}`))
      .map((t) => ({ value: `${cls}:${t}`, label: coverageTypeName(t), count: counts.get(`${cls}:${t}`) }));
    if (children.length) out.push({ value: cls, label: coverageClassLabel(cls), count: children.reduce((n, c) => n + c.count, 0), children });
  }
  return out;
}

// The roster under the type, county and district filters, which every
// table uses; the status and the search narrow only the list.
function coverageScope(d, f = TABS.coverage.filter()) {
  const typeOk = coverageTypeTest(f);
  const inDistricts = districtTest(f);
  return d.agencies.filter((a) => (!typeOk || typeOk(a)) && (!f.ccounty || matchesChoice(f.ccounty, a.county)) &&
    (!inDistricts || inDistricts(a.name, { type: a.type, county: a.county })));
}

// The classes the type filter leaves any part of.
function coverageClasses(d, f = TABS.coverage.filter()) {
  const typeOk = coverageTypeTest(f);
  if (!typeOk) return d.classes;
  const pairs = coverageTypePairs(d);
  return d.classes.filter((c) => (pairs.get(c.key) || []).some((t) => typeOk({ cls: c.key, type: t === NONE ? "" : t })));
}

// Harvested and processed counts, plus the share each bar fills in yellow:
// agencies shown to charge no such fees, for what they have not harvested
// (or not processed), since they have no report to collect.
function coverageTally(list, m) {
  const t = { n: list.length, anyH: 0, anyP: 0, years: list.length * bitCount(m), yH: 0, yP: 0, nfH: 0, nfP: 0, ynfH: 0, ynfP: 0 };
  for (const a of list) {
    const h = a.h & m;
    const p = a.p & m;
    if (h) t.anyH += 1;
    if (p) t.anyP += 1;
    t.yH += bitCount(h);
    t.yP += bitCount(p);
    if (a.nofee) {
      if (!h) t.nfH += 1;
      if (!p) t.nfP += 1;
      t.ynfH += bitCount(m & ~h);
      t.ynfP += bitCount(m & ~p);
    }
  }
  return t;
}

function fmtPct(n, d) {
  if (!d) return "–";
  const pct = (100 * n) / d;
  if (n && pct < 0.1) return "<0.1%";
  if (n < d && pct > 99.9) return ">99.9%";
  return `${n === d || !n ? Math.round(pct) : pct.toFixed(1)}%`;
}

// A bar fills with the harvested (or processed) count, then in yellow with
// the agencies that charge no such fees; the percentage is the whole fill.
function coverageBar(n, d, kind, what, nf = 0) {
  const pct = d ? (100 * n) / d : 0;
  const nfPct = d ? (100 * nf) / d : 0;
  const text = nf
    ? `${fmtPct(n + nf, d)} filled: ${fmtInt(n)} ${kind} and ${fmtInt(nf)} charging no such fees, of ${fmtInt(d)} ${what}`
    : `${fmtPct(n, d)}: ${fmtInt(n)} of ${fmtInt(d)} ${what} ${kind}`;
  return el("div", { class: `cov-bar ${kind}`, title: text },
    el("span", {
      class: "cov-track", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(d), "aria-valuenow": String(n + nf),
      "aria-valuetext": text, "aria-label": `${what} ${kind}`,
    },
    el("span", { class: "cov-fill", style: { width: n ? `max(2px, ${pct}%)` : "0" } }),
    nf ? el("span", { class: "cov-fill cov-nofee", style: { width: `max(2px, ${nfPct}%)` } }) : null),
    el("span", { class: "cov-pct", text: fmtPct(n + nf, d) }),
    el("span", { class: "cov-of" }, nf
      ? [`${fmtInt(n)}`, el("span", { class: "cov-nf", text: `+${fmtInt(nf)}` }), ` / ${fmtInt(d)}`]
      : `${fmtInt(n)} / ${fmtInt(d)}`));
}

const barCell = (...args) => el("td", { class: "cov-bar-cell" }, coverageBar(...args));

// One row per group: jurisdictions with any year harvested and processed,
// then jurisdiction-years harvested and processed.
function coverageTable(head, groups, m) {
  const rows = groups.map(({ label, list, cls }) => {
    const t = coverageTally(list, m);
    return el("tr", { class: cls || "" },
      el("th", { scope: "row" }, label),
      el("td", { class: "num", text: fmtInt(t.n) }),
      barCell(t.anyH, t.n, "harvested", "jurisdictions", t.nfH),
      barCell(t.anyP, t.n, "processed", "jurisdictions", t.nfP),
      el("td", { class: "num cov-split", text: fmtInt(t.years) }),
      barCell(t.yH, t.years, "harvested", "jurisdiction-years", t.ynfH),
      barCell(t.yP, t.years, "processed", "jurisdiction-years", t.ynfP));
  });
  return el("table", { class: "grid cov-grid" },
    el("thead", {},
      el("tr", {},
        el("th", { scope: "col", rowspan: "2", text: head }),
        el("th", { scope: "colgroup", colspan: "3", class: "cov-group", text: "Jurisdictions (any year)" }),
        el("th", { scope: "colgroup", colspan: "3", class: "cov-group cov-split", text: "Jurisdiction-years" })),
      el("tr", {},
        el("th", { scope: "col", class: "num", text: "Count" }),
        el("th", { scope: "col", text: "Harvested" }),
        el("th", { scope: "col", text: "Processed" }),
        el("th", { scope: "col", class: "num cov-split", text: "Count" }),
        el("th", { scope: "col", text: "Harvested" }),
        el("th", { scope: "col", text: "Processed" }))),
    el("tbody", {}, rows));
}

function coverageYearTable(d, list, m) {
  const rows = d.years.flatMap((fy, i) => {
    const b = 1 << i;
    if (!(m & b)) return [];
    let h = 0;
    let p = 0;
    let nfH = 0;
    let nfP = 0;
    for (const a of list) {
      if (a.h & b) h += 1;
      else if (a.nofee) nfH += 1;
      if (a.p & b) p += 1;
      else if (a.nofee) nfP += 1;
    }
    return el("tr", {},
      el("th", { scope: "row", text: `FY ${fmtFy(fy)}` }),
      el("td", { class: "num", text: fmtInt(list.length) }),
      barCell(h, list.length, "harvested", `FY ${fmtFy(fy)} reports`, nfH),
      barCell(p, list.length, "processed", `FY ${fmtFy(fy)} reports`, nfP));
  }).reverse();
  return el("table", { class: "grid cov-grid cov-years-grid" },
    el("thead", {}, el("tr", {},
      el("th", { scope: "col", text: "Fiscal year" }),
      el("th", { scope: "col", class: "num", text: "Jurisdictions" }),
      el("th", { scope: "col", text: "Report harvested" }),
      el("th", { scope: "col", text: "Processed" }))),
    el("tbody", {}, rows));
}

// Groups of the scope by key, largest first (or by name), each labelled with
// a link that narrows the tab to it. params(k, items) is that link's change.
function coverageGroups(list, key, label, params, byName = false) {
  const groups = new Map();
  for (const a of list) {
    const k = key(a) || "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  return [...groups.entries()]
    .sort((x, y) => (byName ? 0 : y[1].length - x[1].length) || label(x[0]).localeCompare(label(y[0])))
    .map(([k, items]) => ({ label: coverageLink(label(k), params(k, items)), list: items }));
}

// A type row narrows to the class and type pairs it holds, so it never
// widens a type filter already set.
const coveragePairsOf = (items) => ({ ccls: "", ctype: [...new Set(items.map(coveragePair))].join(SEP) });

function setCoverage(params, push = true) {
  Object.assign(state, params, { cpage: 1 });
  toolbarView = "";
  update({ push });
  scrollContentTop();
}

function coverageLink(text, params) {
  return el("a", {
    href: hrefWith({ view: "coverage", cyr: state.cyr, ccls: state.ccls, ctype: state.ctype, ccounty: state.ccounty, cq: state.cq, cstat: state.cstat, ...params }), text,
    onclick: (ev) => { ev.preventDefault(); setCoverage(params); },
  });
}

// Any status ticked matches.
function coverageStatus(a, m, f) {
  const want = splitChoice(f.cstat);
  if (!want.length) return true;
  const h = a.h & m;
  const p = a.p & m;
  return want.some((k) => COVERAGE_STATUS_TEST[k]?.(a, h, p, m));
}

// The list's rows: the scope under the status and the search.
function coverageMatches(d, f = TABS.coverage.filter()) {
  const m = coverageMask(d);
  const terms = searchTerms(f.cq);
  return coverageScope(d, f).filter((a) => coverageStatus(a, m, f) &&
    terms.every((t) => `${a.name} ${a.county} ${a.names.join(" ")}`.toLowerCase().includes(t)));
}

function coverageStatusOptions(rows) {
  const m = coverageData ? coverageMask(coverageData) : 0;
  return COVERAGE_STATUSES.filter(([k]) => k).map(([value, label]) => ({
    value, label, children: [],
    count: rows.filter((a) => COVERAGE_STATUS_TEST[value](a, a.h & m, a.p & m, m)).length,
  }));
}

function coverageRows(m, f = TABS.coverage.filter()) {
  const list = coverageMatches(coverageData, f);
  const { col, dir } = state.csort;
  const sign = dir === "asc" ? 1 : -1;
  const value = {
    name: (a) => a.name, type: (a) => humanize(a.type), county: (a) => a.county,
    harvested: (a) => (a.nofee ? bitCount(m) : bitCount(a.h & m)), processed: (a) => (a.nofee ? bitCount(m) : bitCount(a.p & m)),
  }[col];
  return list.sort((x, y) => {
    const a = value(x);
    const b = value(y);
    const c = typeof a === "number" ? a - b : String(a).localeCompare(String(b));
    return sign * c || x.name.localeCompare(y.name);
  });
}

// A square for each year counted; under "All years" a gap sets off the years
// from RECENT_FROM on.
function coverageYearCells(d, a, m) {
  return el("span", { class: "cov-yrs" }, d.years.flatMap((fy, i) => {
    const b = 1 << i;
    if (!(m & b)) return [];
    const kind = a.p & b ? "p" : a.h & b ? "h" : a.nofee ? "n" : "m";
    const said = { p: "processed", h: "harvested, not yet processed", n: "charges no such fees", m: "not harvested" }[kind];
    return el("span", { class: `cov-yr ${kind}${i && fy === RECENT_FROM ? " first" : ""}`, title: `FY ${fmtFy(fy)}: ${said}` });
  }));
}

function coverageList(d, m) {
  const f = TABS.coverage.filter();
  const list = coverageRows(m, f);
  const pages = Math.max(1, Math.ceil(list.length / COVERAGE_PAGE));
  if (state.cpage > pages) state.cpage = pages;
  const start = (state.cpage - 1) * COVERAGE_PAGE;
  const span = bitCount(m);
  const counted = d.years.filter((fy, i) => m & (1 << i));
  const onSort = (c) => { state.csort = toggleSort(state.csort, c, c === "harvested" || c === "processed"); state.cpage = 1; update(); };
  const s = state.csort;
  const body = el("tbody", {}, list.slice(start, start + COVERAGE_PAGE).map((a) => el("tr", {},
    el("td", { class: "col-entity" }, a.names.length
      ? el("a", { href: entityHref(a.names[0]), title: `Open ${a.names.join(", ")} in the release`, onclick: (ev) => { ev.preventDefault(); openEntity(a.names[0]); }, text: a.name })
      : a.name),
    el("td", { text: humanize(a.type) }),
    el("td", { text: a.county || "" }),
    el("td", { class: "cov-yrs-cell" }, coverageYearCells(d, a, m)),
    barCell(bitCount(a.h & m), span, "harvested", "years", a.nofee ? bitCount(m & ~a.h) : 0),
    barCell(bitCount(a.p & m), span, "processed", "years", a.nofee ? bitCount(m & ~a.p) : 0))));
  if (!list.length) body.append(el("tr", { class: "empty-row" }, el("td", { colspan: 6, text: "No jurisdiction matches." })));
  const page = (n) => () => { state.cpage = n; update(); $("cov-list")?.scrollIntoView({ block: "start" }); };
  const swatch = (kind, text) => el("span", { class: "cov-key" }, el("span", { class: `cov-yr ${kind}` }), text);
  return [
    el("h3", { class: "section-label", id: "cov-list", text: "Jurisdictions" }),
    el("div", { class: "result-bar" },
      el("span", { class: "count" }, ...countOf(list.length, d.agencies.length, "jurisdiction", filtersActive(f))),
      el("span", { class: "active-filters" }, searchTag(f.cq, () => setFilter("coverage", "cq", "")), ...boxTags("coverage")),
      districtNote(),
      el("span", { class: "cov-legend" }, swatch("p", "Processed"), swatch("h", "Harvested, not yet processed"), swatch("n", "Charges no such fees"), swatch("m", "Not harvested"))),
    el("div", { class: "table-scroll" }, el("table", { class: "grid cov-list" },
      el("thead", {}, el("tr", {},
        sortHeader("Jurisdiction", "name", s, onSort, "col-entity"),
        sortHeader("Type", "type", s, onSort, "", "ctype"),
        sortHeader("County", "county", s, onSort, "", "ccounty"),
        el("th", { scope: "col", class: "cov-yrs-cell" }, el("span", { class: "col-label", text: `FY ${fmtFy(counted[0])} to ${fmtFy(counted[counted.length - 1])}` })),
        sortHeader("Harvested", "harvested", s, onSort),
        sortHeader("Processed", "processed", s, onSort))),
      body)),
    el("div", { class: "pager" },
      el("button", { class: "btn", type: "button", text: "Prev", disabled: state.cpage <= 1, onclick: page(state.cpage - 1) }),
      el("span", { class: "muted", text: `page ${state.cpage} of ${pages}` }),
      el("button", { class: "btn", type: "button", text: "Next", disabled: state.cpage >= pages, onclick: page(state.cpage + 1) })),
  ];
}

// A headline figure: the bar's whole fill, with what makes it up.
function coverageTile(label, n, nf, d, extra = "") {
  return tile(label, fmtPct(n + nf, d), nf
    ? `${fmtInt(n)} plus ${fmtInt(nf)} with no such fees, of ${fmtInt(d)}${extra}`
    : `${fmtInt(n)} of ${fmtInt(d)}${extra}`);
}

function renderCoverage(content) {
  const view = el("div", { class: "stats-view coverage-view" });
  content.append(view);
  if (coverageData) {
    fillCoverage(view, coverageData);
    return;
  }
  view.append(el("p", { class: "muted", text: "Loading coverage…" }));
  loadCoverage().then(() => {
    if (state.view !== "coverage") return;
    toolbarView = "";
    contentKey = "";
    renderAll();
  }).catch((err) => {
    if (view.isConnected) view.replaceChildren(el("p", { class: "muted", text: `Failed to load coverage: ${err.message}` }));
  });
}

function fillCoverage(view, d) {
  const m = coverageMask(d);
  const span = d.years.filter((fy, i) => m & (1 << i));
  const range = `FY ${fmtFy(span[0])} to ${fmtFy(span[span.length - 1])}`;
  const scope = coverageScope(d);
  const t = coverageTally(scope, m);
  const f = TABS.coverage.filter();
  const classes = coverageClasses(d, f);
  const typeOk = coverageTypeTest(f);
  const whole = (cls) => !typeOk || (coverageTypePairs(d).get(cls) || []).every((t) => typeOk({ cls, type: t === NONE ? "" : t }));
  const byClass = classes.map((c) => {
    const list = scope.filter((a) => a.cls === c.key);
    return { label: coverageLink(c.label, whole(c.key) || !list.length ? { ccls: c.key, ctype: "" } : coveragePairsOf(list)), list };
  });
  if (byClass.length > 1) byClass.push({ label: "All", list: scope, cls: "cov-total" });
  const leftOut = classes.filter((c) => c.left_out.length)
    .map((c) => `${c.label}: ${c.left_out.map((x) => `${fmtInt(x.count)} ${x.label.toLowerCase()}`).join(", ")}`);
  const asOf = new Date(d.inventory_utc);
  const when = Number.isNaN(asOf.getTime()) ? d.inventory_utc
    : `${asOf.toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" })} PT`;
  const narrowed = ["ctype", "ccounty", "ad", "sd"].map((k) => {
    const spec = boxSpec("coverage", k);
    const raw = spec.get();
    return raw ? `${spec.label.toLowerCase()} ${boxSummary(spec, raw)}` : "";
  }).filter(Boolean);
  view.append(
    el("p", {},
      `Each agency on the roster counts once for each fiscal year from FY ${fmtFy(span[0])} to ${fmtFy(span[span.length - 1])}${state.cyr === "all" ? "" : ` (All years, at the top right, goes back to FY ${fmtFy(d.years[0])})`}. `,
      el("strong", { text: "Harvested" }),
      " means its annual fee report for that year (Gov. Code § 66006) is in hand, or the release already publishes figures for it. ",
      el("strong", { text: "Processed" }),
      " means the release publishes figures for it. ",
      el("span", { class: "cov-key" }, el("span", { class: "cov-yr n" }), el("strong", { text: "Yellow" })),
      " fills the share of agencies shown not to charge development fees (so far, special districts screened on their legal powers and accounts): they have no report to harvest. Otherwise a year counts only once its report is in hand: an agency that never wrote a report still counts as not harvested, and reports collected but not yet matched to an agency and a year are not counted."),
    el("p", { class: "muted" },
      `Counting ${range}${narrowed.length ? `, ${narrowed.join(", ")}` : ""}. Inventory as of ${when}; release ${String(d.release_commit || "").slice(0, 7)}.`,
      leftOut.length ? ` Left out of every count, holding no report: ${leftOut.join("; ")}.` : "",
      t.nfH ? ` ${fmtInt(t.nfH)} of the ${fmtInt(t.n)} jurisdictions counted charge no such fees.` : "",
      districtMappedOnly(state) ? ` Under the district filter only agencies with a mapped boundary count. ${unmappedRosterText(d)}` : ""),
    el("div", { class: "tiles" },
      coverageTile("Jurisdictions harvested", t.anyH, t.nfH, t.n, ", any year"),
      coverageTile("Jurisdictions processed", t.anyP, t.nfP, t.n, ", any year"),
      coverageTile("Jurisdiction-years harvested", t.yH, t.ynfH, t.years),
      coverageTile("Jurisdiction-years processed", t.yP, t.ynfP, t.years)),
    statsBlock("By class", coverageTable("Class", byClass, m)),
    statsBlock("By fiscal year", coverageYearTable(d, scope, m)),
    statsBlock("By agency type", coverageTable("Type", coverageGroups(scope, (a) => a.type, (k) => (k ? humanize(k) : "(not recorded)"), (k, items) => coveragePairsOf(items)), m)),
    el("details", { class: "cov-more", open: Boolean(state.ccounty) },
      el("summary", { class: "section-label", text: "By county" }),
      el("div", { class: "table-scroll" }, coverageTable("County", coverageGroups(scope, (a) => a.county, (k) => k || "(not recorded)", (k) => ({ ccounty: k || NONE }), true), m))),
    ...coverageList(d, m),
  );
}

// ------------------------------------------------------------ DISTRICTS
// legislative/districts.json loads only when something needs it: a district
// box opened, ad or sd in the address, the Districts tab, a page's district
// lines or a download with district columns. It is a site file like
// coverage.json, so it comes from this origin and never through the Worker.

let districts = null;
const districtCache = new Map();

function ensureDistricts() {
  if (districts) return Promise.resolve(districts);
  return loadDistricts(async (url) => {
    const res = await fetch(new URL(url, document.baseURI), { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status} reading ${url}`);
    return res.json();
  }).then((d) => {
    if (!districts) {
      districts = d;
      districtCache.clear();
    }
    return districts;
  });
}

// The districts one agency touches, as { ad: ["12"], sd: ["7"] }; null when
// it is not mapped or its name does not resolve.
function agencyDistricts(name, opts) {
  if (!districts || !name) return null;
  const k = `${name}\u0001${opts?.type || ""}\u0001${opts?.county || ""}`;
  if (!districtCache.has(k)) districtCache.set(k, districts.districtKeys(name, opts));
  return districtCache.get(k);
}

// A row passes when its agency touches a ticked district in each chamber
// filtered; an agency not mapped passes only "(not mapped)".
function districtTest(f) {
  const want = CHAMBERS.filter((ch) => f[ch]).map((ch) => [ch, new Set(splitChoice(f[ch]))]);
  if (!want.length) return null;
  return (name, opts) => {
    const keys = agencyDistricts(name, opts);
    return want.every(([ch, set]) => (keys?.[ch]?.length ? keys[ch].some((n) => set.has(n)) : set.has(NONE)));
  };
}

function rowPassesDistricts(name, opts) {
  const test = districtTest({ ad: state.ad, sd: state.sd });
  return !test || test(name, opts);
}

// Roster agencies with no mapped boundary sit in no district, so a district
// filter leaves them out of Coverage unless "(not mapped)" is ticked.
function unmappedRoster(cov) {
  const out = { all: 0, special: 0, school: 0 };
  for (const a of cov?.agencies || []) {
    if (agencyDistricts(a.name, { type: a.type, county: a.county })) continue;
    out.all += 1;
    if (a.cls === "special") out.special += 1;
    else if (a.cls === "school") out.school += 1;
  }
  return out;
}

// Whether a district filter passes only mapped agencies: one with no boundary
// passes only when every chamber filtered ticks "(not mapped)".
function districtMappedOnly(df) {
  const on = CHAMBERS.filter((ch) => df[ch]);
  return on.length > 0 && !on.every((ch) => splitChoice(df[ch]).includes(NONE));
}

function unmappedRosterText(cov) {
  const u = unmappedRoster(cov);
  return `${fmtInt(u.all)} roster agencies have no mapped boundary (${fmtInt(u.special)} special districts and ${fmtInt(u.school)} school agencies), so no district lists them; tick "(not mapped)" in a district box to see them.`;
}

// A list under a district filter waits for the file rather than draw every
// row as if it were filtered. Pages of one agency draw at once and fill in
// their district lines later.
function districtGate(content) {
  if (districts) return false;
  const page = (state.view === "entities" && state.entity) || (state.view === "fees" && state.fee);
  const needs = state.view === "districts" || ((state.ad || state.sd) && !page && state.view !== "stats");
  if (!needs) return false;
  const msg = el("p", { class: "muted", text: "Loading legislative districts…" });
  content.append(msg);
  ensureDistricts().then(() => {
    contentKey = "";
    renderAll();
  }).catch((err) => {
    if (!msg.isConnected) return;
    msg.replaceChildren(`Failed to load the district file: ${err.message}. `,
      el("button", { class: "btn", type: "button", text: "Retry", onclick: () => { contentKey = ""; renderAll(); } }));
  });
  return true;
}

const DISTRICT_BASIS = {
  boundary: "its Census TIGER/Line boundary",
  district_boundary: "its own mapped boundary, counted by 2020 census blocks",
  same_as: "another agency's boundary",
  approximate: "an approximate boundary",
  unmapped: "no boundary",
};
const DISTRICT_BASIS_SHORT = {
  boundary: "TIGER boundary", district_boundary: "District layer", same_as: "Same as another", approximate: "Approximate", unmapped: "Not mapped",
};

const byShare = (a, b) => (b.share ?? -1) - (a.share ?? -1) || a.n - b.n;
const sharePct = (share) => (share === null ? "" : `${+(share * 100).toFixed(1)}%`);

// The record of a row's agency: a record itself, or [name, opts] to look up.
function districtRecord(where) {
  if (!districts || !where) return null;
  if (where.basis && Array.isArray(where.ad)) return where;
  const [name, opts] = Array.isArray(where) ? where : [where];
  return districts.lookup(name, opts);
}

// "Assembly: 18 (89%), 14 (11%), 20 (edge)", each number a link to
// Jurisdictions in that district. Kept apart from .dossier-meta.
function districtLines(name, opts) {
  const box = el("div", { class: "dossier-districts" });
  const fill = () => {
    const rec = districts.lookup(name, opts);
    if (!rec) return;
    if (rec.basis === "unmapped") {
      box.append(el("p", { class: "muted", text: `Legislative districts: not mapped.${rec.basis_note ? ` ${rec.basis_note}` : ""}` }));
      return;
    }
    for (const ch of CHAMBERS) {
      const list = [...rec[ch]].sort(byShare);
      box.append(el("p", { class: "district-line" },
        el("span", { class: "dl-chamber", text: `${CHAMBER[ch].word}:` }), " ",
        list.flatMap((d, i) => [i ? ", " : null, districtFilterLink(ch, d.n),
          d.edge
            ? el("span", { class: "edge-badge", title: "Under 1% of its 2020 residents", text: " (edge)" })
            : ` (${Math.round(d.share * 100)}%)`])));
    }
    const note = rec.basis === "approximate" || rec.basis === "same_as" ? rec.basis_note : "";
    // An approximate boundary that leaves part of the agency out (members
    // only, or a note that it may miss districts) can miss a district.
    const subset = rec.basis === "approximate" && /not mapped|may miss/i.test(rec.basis_note);
    box.append(el("div", { class: "muted district-basis" },
      `Placed by ${DISTRICT_BASIS[rec.basis]}${note ? `: ${note.replace(/\.$/, "")}` : ""}. Shares are of its 2020 residents. `,
      districtCaveatBox(subset ? "May be missing from districts its unmapped territory touches" : "Listed in every district it touches")));
  };
  if (districts) fill();
  else ensureDistricts().then(fill, (err) => console.warn(err));
  return box;
}

// Opens a tab with only the one district as its filter.
function openFiltered(view, ch, n) {
  TABS[view].clear();
  state.ad = ch === "ad" ? String(n) : "";
  state.sd = ch === "sd" ? String(n) : "";
  state.view = view;
  state.entity = "";
  state.fee = "";
  state.figure = "";
  state.doc = "";
  state.pg = null;
  resetPages();
  toolbarView = "";
  update({ push: true });
  scrollContentTop();
}

function districtFilterLink(ch, n, view = "entities", text = String(n)) {
  return el("a", {
    href: hrefWith({ view, ad: ch === "ad" ? String(n) : "", sd: ch === "sd" ? String(n) : "" }), text,
    title: `${TABS[view].label} in ${CHAMBER[ch].label} ${n}`,
    onclick: (ev) => { ev.preventDefault(); openFiltered(view, ch, n); },
  });
}

function chamberSwitch() {
  return el("span", { class: "chamber-switch", role: "group", "aria-label": "Chamber" },
    CHAMBERS.map((ch) => el("button", {
      class: "btn", type: "button", "data-dch": ch, "aria-pressed": state.dch === ch ? "true" : "false", text: CHAMBER[ch].word,
      onclick: () => {
        if (state.dch === ch && !state.dn) return;
        state.dch = ch;
        state.dn = "";
        update({ push: true });
      },
    })));
}

// Every district's agencies and totals, worked out once for each load of the
// release and the district file.
let districtAgg = null;

function districtAggregates() {
  if (districtAgg?.districts === districts && districtAgg.model === model) return districtAgg;
  const byRecord = new Map();
  for (const e of model.entities) {
    const rec = districts.lookup(...releaseWhere(e.name));
    if (!rec) continue;
    if (!byRecord.has(rec.key)) byRecord.set(rec.key, []);
    byRecord.get(rec.key).push(e);
  }
  // What the release publishes for each record: its figures, its sum of
  // primary rows and the fiscal years with figures, over every release name
  // (names, most figures first) that resolves to it.
  const published = new Map();
  for (const [key, list] of byRecord) {
    const years = new Set();
    let figures = 0;
    let sum = 0;
    for (const e of list) {
      figures += e.figures.length;
      sum += e.sum;
      for (const y of e.years) years.add(y);
    }
    const names = [...list].sort((a, b) => b.figures.length - a.figures.length || a.name.localeCompare(b.name));
    published.set(key, { main: names[0], names, figures, sum, years: [...years].sort() });
  }
  const out = { districts, model, published };
  for (const ch of CHAMBERS) {
    const rows = districts.chambers[ch].map((c) => ({
      n: c.n, label: c.label, counties: c.counties, agencies: [], muni: 0, muniFig: 0, school: 0, special: 0, figures: 0, sum: 0, withFigures: 0,
    }));
    for (const rec of districts.agencies()) {
      const pub = published.get(rec.key) || null;
      for (const d of rec[ch]) {
        const row = rows[d.n - 1];
        if (!row) continue;
        row.agencies.push({ rec, d, pub });
        if (rec.class === "municipal") {
          row.muni += 1;
          if (pub) row.muniFig += 1;
        } else if (rec.class === "school") row.school += 1;
        else row.special += 1;
        if (pub) {
          row.figures += pub.figures;
          row.sum += pub.sum;
          row.withFigures += 1;
        }
      }
    }
    out[ch] = rows;
  }
  districtAgg = out;
  return out;
}

const DISTRICT_SUM_TIP = "Primary rows of every agency touching the district, each agency's whole total; an agency in several districts counts in each, so district sums overlap.";

function districtCallout() {
  const m = districts.meta;
  return el("div", { class: "district-callout", role: "note" },
    el("p", {}, el("strong", { text: "Districts overlap. " }), `${m.caveat} ${DISTRICT_APPROX}`),
    el("p", { class: "muted", text: `${m.plan}. ${m.plan_note}` }),
    el("details", {},
      el("summary", { text: "How agencies are placed" }),
      el("p", { text: m.method }),
      el("p", { text: m.source }),
      el("p", { class: "muted", text: `${m.vintage}. Built ${m.built_utc}.` })));
}

function renderDistricts(content) {
  const agg = districtAggregates();
  const ch = state.dch;
  const row = state.dn ? agg[ch][Number(state.dn) - 1] : null;
  content.append(el("div", { class: "districts-view" }, districtCallout(),
    districtElsewhereNote(row ? `This page lists every agency touching ${row.label}.` : "This tab lists every district."),
    row ? districtPage(agg, ch, row) : districtList(agg, ch)));
}

function districtRows(agg, ch) {
  const s = state.dsort;
  const val = {
    n: (r) => r.n, counties: (r) => r.counties.length, muni: (r) => r.muni, muniFig: (r) => r.muniFig,
    school: (r) => r.school, special: (r) => r.special, figures: (r) => r.figures, sum: (r) => (r.withFigures ? r.sum : -Infinity),
  }[s.col];
  const sign = s.dir === "asc" ? 1 : -1;
  return [...agg[ch]].sort((a, b) => sign * (val(a) - val(b)) || a.n - b.n);
}

function openDistrict(ch, n) {
  state.dch = ch;
  state.dn = String(n);
  update({ push: true });
  scrollContentTop();
}

function districtHref(ch, n = "") {
  return hrefWith({ view: "districts", dch: ch === "ad" ? "" : ch, dn: n ? String(n) : "" });
}

function districtList(agg, ch) {
  const rows = districtRows(agg, ch);
  const s = state.dsort;
  const onSort = (c) => { state.dsort = toggleSort(state.dsort, c, c !== "n"); update(); };
  const num = (v) => el("td", { class: "num", text: fmtInt(v) });
  const body = el("tbody", {}, rows.map((r) => el("tr", {},
    el("td", { class: "col-entity col-district" }, el("a", {
      href: districtHref(ch, r.n), text: r.label,
      onclick: (ev) => { ev.preventDefault(); openDistrict(ch, r.n); },
    })),
    el("td", { class: "col-counties", text: r.counties.join(", ") }),
    num(r.muni), num(r.muniFig), num(r.school), num(r.special), num(r.figures),
    el("td", { class: "num", text: r.withFigures ? fmtSum(r.sum) : "" }))));
  return [
    el("div", { class: "result-bar" },
      el("span", { class: "count" }, el("strong", { text: fmtInt(rows.length) }), ` ${CHAMBER[ch].word} districts`),
      el("span", { class: "muted", text: districts.meta.plan.split(" (")[0] }),
      districtCaveatBox()),
    el("div", { class: "table-scroll" }, el("table", { class: "grid districts-grid" },
      el("thead", {}, el("tr", {},
        sortHeader("District", "n", s, onSort, "col-entity"),
        sortHeader("Counties touched", "counties", s, onSort, "col-counties"),
        sortHeader("Cities and counties touching", "muni", s, onSort, "num"),
        sortHeader("Of those with published figures", "muniFig", s, onSort, "num"),
        sortHeader("School districts touching", "school", s, onSort, "num"),
        sortHeader("Special districts touching (mapped only)", "special", s, onSort, "num"),
        sortHeader("Published figures of touching agencies", "figures", s, onSort, "num"),
        sortHeader("Sum of primary rows", "sum", s, onSort, "num"))),
      body)),
    el("p", { class: "muted district-sum-note", text: DISTRICT_SUM_TIP }),
  ];
}

function districtPageRows(row) {
  const s = state.dpsort;
  const items = row.agencies.map(({ rec, d, pub }) => ({ rec, d, pub }));
  const val = {
    name: (x) => x.rec.name, type: (x) => humanize(x.rec.type), county: (x) => x.rec.county,
    share: (x) => x.d.share ?? -1, figures: (x) => x.pub?.figures ?? 0, latest: (x) => x.pub?.years.at(-1) || "",
    sum: (x) => (x.pub ? x.pub.sum : -Infinity),
  }[s.col];
  const sign = s.dir === "asc" ? 1 : -1;
  return items.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
    return sign * c || a.rec.name.localeCompare(b.rec.name);
  });
}

// A touching agency's name opens its page, or its Coverage row when the
// release publishes nothing for it. A row that adds up several release
// names links each one too, since each is its own page.
function districtAgencyLink(x, ch, n) {
  if (x.pub) {
    const open = (name, text) => el("a", { href: entityHref(name), text, onclick: (ev) => { ev.preventDefault(); openEntity(name); } });
    const main = open(x.pub.main.name, x.rec.name);
    if (x.pub.names.length < 2) return main;
    return [main, el("span", { class: "also-names" }, "Published as ",
      x.pub.names.flatMap((e, i) => [i ? ", " : null, open(e.name, e.name), ` (${fmtInt(e.figures.length)})`]))];
  }
  const cq = `"${x.rec.name}"`;
  const at = { ad: ch === "ad" ? String(n) : "", sd: ch === "sd" ? String(n) : "" };
  return el("a", {
    href: hrefWith({ view: "coverage", cq, ...at }), text: x.rec.name, title: "Its row in Coverage",
    onclick: (ev) => {
      ev.preventDefault();
      TABS.coverage.clear();
      Object.assign(state, at, { view: "coverage", cq });
      resetPages();
      toolbarView = "";
      update({ push: true });
      scrollContentTop();
    },
  });
}

function districtPage(agg, ch, row) {
  const rows = districtPageRows(row);
  const spellings = rows.reduce((t, x) => t + (x.pub ? x.pub.names.length : 0), 0);
  const s = state.dpsort;
  const onSort = (c) => { state.dpsort = toggleSort(state.dpsort, c, ["share", "figures", "latest", "sum"].includes(c)); update(); };
  const back = el("a", {
    class: "back", href: districtHref(ch), text: `← All ${CHAMBER[ch].word} districts`,
    onclick: (ev) => { ev.preventDefault(); state.dn = ""; update({ push: true }); },
  });
  const opens = ["figures", "entities", "fees", "coverage"].map((v) => districtFilterLink(ch, row.n, v, TABS[v].label));
  const body = el("tbody", {}, rows.map((x) => el("tr", {},
    el("td", { class: "col-entity" }, districtAgencyLink(x, ch, row.n)),
    el("td", { text: humanize(x.rec.type) || "(not recorded)" }),
    el("td", { text: x.rec.county }),
    el("td", { class: "num" }, x.d.share === null ? "n/a" : sharePct(x.d.share),
      x.d.edge ? el("span", { class: "edge-badge", title: "Under 1% of its 2020 residents", text: "edge" }) : null),
    el("td", { title: x.rec.basis_note || null, text: DISTRICT_BASIS_SHORT[x.rec.basis] }),
    el("td", { class: "num", text: x.pub ? fmtInt(x.pub.figures) : "" }),
    el("td", { text: x.pub ? fyRanges(x.pub.years) : "" }),
    el("td", { class: "col-fy", text: x.pub ? fmtFy(x.pub.years.at(-1)) : "" }),
    el("td", { class: "num", text: x.pub ? fmtSum(x.pub.sum) : "" }))));
  if (!rows.length) body.append(el("tr", { class: "empty-row" }, el("td", { colspan: 9, text: "No mapped agency touches this district." })));
  return [
    el("div", { class: "dossier-head" },
      back,
      el("h2", { text: row.label }),
      el("div", { class: "dossier-meta" },
        [`${fmtInt(rows.length)} agencies touching`, `${fmtInt(row.muni)} cities and counties`, `${fmtInt(row.school)} school districts`,
          `${fmtInt(row.special)} special districts`, `${fmtInt(row.figures)} published figures`]
          .map((t) => el("span", { text: t }))),
      el("p", { class: "muted", text: `Counties touched: ${row.counties.join(", ") || "none recorded"}.` }),
      el("p", { class: "district-open" }, "Open filtered to this district: ", opens.flatMap((a, i) => [i ? " / " : null, a])),
      spellings > row.withFigures
        ? el("p", { class: "muted", text: `The ${fmtInt(row.withFigures)} agencies with figures are published under ${fmtInt(spellings)} names, which the other tabs list apart; a row here adds up every name it is published under.` })
        : null),
    el("div", { class: "result-bar" },
      el("span", { class: "count" }, el("strong", { text: fmtInt(rows.length) }), ` agenc${rows.length === 1 ? "y" : "ies"}`, ` · ${fmtInt(row.withFigures)} with published figures`),
      row.withFigures ? el("span", { class: "sum", title: DISTRICT_SUM_TIP }, "whole-agency sum ", el("strong", { text: fmtSum(row.sum) })) : null,
      districtCaveatBox()),
    el("div", { class: "table-scroll" }, el("table", { class: "grid districts-grid" },
      el("thead", {}, el("tr", {},
        sortHeader("Agency", "name", s, onSort, "col-entity"),
        sortHeader("Type", "type", s, onSort),
        sortHeader("County", "county", s, onSort),
        sortHeader("2020 residents in district", "share", s, onSort, "num"),
        el("th", { scope: "col" }, el("span", { class: "col-label", text: "Basis" })),
        sortHeader("Figures", "figures", s, onSort, "num"),
        el("th", { scope: "col" }, el("span", { class: "col-label", text: "Fiscal years with figures" })),
        sortHeader("Latest FY", "latest", s, onSort, "col-fy"),
        sortHeader("Sum of primary rows", "sum", s, onSort, "num"))),
      body)),
    el("p", { class: "muted district-sum-note", text: `${DISTRICT_SUM_TIP} A missing year is missing, not zero.` }),
  ];
}

// ------------------------------------------------------------ FUNDS, SCHEDULES, PERMITS
// Each tab is its own module (lib/funds-view.js, lib/schedules-view.js,
// lib/apr-view.js), which loads its file the first time it opens and takes
// the app functions it uses from these ctx objects.

// Redraws the content once a tab's file has loaded or its selection changed.
function rerenderContent() {
  contentKey = "";
  update();
}

function renderFundsTab(content) {
  renderFunds(content, fundsCtx());
}

// The Funds tab's ctx, built from the address bar; the Download menu and the
// report build one too, so they reach the tab before it has been opened.
function fundsCtx() {
  return {
    ...libCtx(),
    fetchText, dataUrl, officialUrl,
    collections: model.rows,
    entityLink: (name) => entityFilterLink(name),
    agencyHref: (name) => hrefWith({ view: "funds", fa: name }),
    agency: state.fa,
    q: state.faq,
    county: state.facounty,
    type: state.fatype,
    isCurrent: () => state.view === "funds",
    rerender: rerenderContent,
    // The search filters the list in place; only the address bar follows it.
    onSelect: ({ agency, q, county, type }) => {
      const push = agency !== state.fa;
      state.fa = agency;
      state.faq = q;
      state.facounty = county;
      state.fatype = type;
      writeUrl(push);
    },
  };
}

function renderSchedulesTab(content) {
  renderSchedules(content, schedulesCtx());
}

function schedulesCtx() {
  return {
    ...libCtx(),
    fetchText, officialUrl, openDoc,
    sourceById: model.sourceById,
    agencyHref: (name) => hrefWith({ view: "schedules", scagency: name }),
    selection: state.sc,
    isCurrent: () => state.view === "schedules",
    rerender: rerenderContent,
    onSelect: (s) => {
      const push = s.agency !== state.sc.agency;
      state.sc = Object.fromEntries(SCHEDULE_KEYS.map((k) => [k, String(s[k] ?? "")]));
      writeUrl(push);
    },
  };
}

function permitsCtx() {
  return {
    ...libCtx(),
    model, state, update, loadCoverage, showTooltip, hideTooltip, entityHref, openEntity,
    permitsHref: () => hrefWith({ view: "permits" }),
    openPermits: () => openView("permits"),
    sortHeader, toggleSort, tile, chip, select, searchInput,
  };
}

// ============================================================ PANEL

function openFigure(id, { list, tab = "outlined", push = true } = {}) {
  if (list) panelList = list.map((x) => (typeof x === "string" ? x : x.id));
  state.figure = id;
  state.doc = "";
  state.tab = tab;
  state.pg = null;
  update({ push });
}

function openDoc(sourceId, page = null) {
  state.doc = sourceId;
  state.figure = "";
  state.pg = page;
  update({ push: true });
}

function closePanel() {
  const returnTo = state.figure;
  state.figure = "";
  state.doc = "";
  state.pg = null;
  update({ push: true });
  if (returnTo) {
    const row = document.querySelector(`[data-id="${CSS.escape(returnTo)}"]`);
    const target = row?.matches("button") ? row : row?.querySelector("button");
    target?.focus({ preventScroll: false });
  }
}

function panelContextList() {
  if (panelList.includes(state.figure)) return panelList;
  if (state.view === "figures") return currentFigures().map((f) => f.id);
  if (state.view === "entities" && state.entity) {
    const e = model.entityByName.get(state.entity);
    if (e) return entityFigureOrder(e).map((f) => f.id);
  }
  if (state.view === "fees" && currentFee()) return currentFee().figures.map((f) => f.id);
  return [];
}

function ensureViewer() {
  if (!viewer) {
    viewerRoot = el("div", { class: "viewer-root" });
    viewer = new PdfViewer(viewerRoot, {
      onBoxClick: (id) => openFigure(id, { tab: "original" }),
      onPageChange: (page) => { state.pg = page; writeUrl(false); },
    });
  }
  return viewer;
}

function renderPanel() {
  const panel = $("panel");
  const fig = state.figure ? model.figureById.get(state.figure) : null;
  const src = !fig && state.doc ? model.sourceById.get(state.doc) : null;
  document.querySelectorAll("tr.selected-row, .mx-cell.selected").forEach((n) => n.classList.remove("selected-row", "selected"));
  if (!fig && !src) {
    panel.hidden = true;
    panelKey = "";
    $("workspace").classList.remove("with-panel");
    viewer?.clear();
    return;
  }
  panel.hidden = false;
  $("workspace").classList.add("with-panel");
  if (fig) {
    document.querySelectorAll(`[data-id="${CSS.escape(fig.id)}"]`).forEach((n) => n.classList.add(n.matches("tr") ? "selected-row" : "selected"));
  } else {
    document.querySelectorAll(`tr[data-doc="${CSS.escape(src.source_id)}"]`).forEach((n) => n.classList.add("selected-row"));
  }
  const list = fig ? panelContextList() : [];
  const key = JSON.stringify([state.figure, state.doc, state.tab, list.indexOf(state.figure), list.length]);
  if (key === panelKey && panel.childElementCount) return;
  panelKey = key;
  if (fig) renderFigurePanel(panel, fig, list);
  else renderDocPanel(panel, src);
}

function panelTop(children) {
  return el("div", { class: "panel-top" }, children,
    el("span", { class: "grow" }),
    el("button", { class: "btn panel-close", type: "button", "aria-label": "Close", title: "Close (Esc)", text: "×", onclick: closePanel }));
}

function renderFigurePanel(panel, fig, list) {
  const p = fig.primary;
  const idx = list.indexOf(fig.id);
  const step = (d) => openFigure(list[idx + d], { list, tab: state.tab, push: false });
  const nav = idx >= 0 ? [
    el("button", { class: "btn", type: "button", text: "‹ Prev", title: "Previous figure in this list", disabled: idx <= 0, onclick: () => step(-1) }),
    el("span", { class: "muted pos", text: `${fmtInt(idx + 1)} of ${fmtInt(list.length)}` }),
    el("button", { class: "btn", type: "button", text: "Next ›", title: "Next figure in this list", disabled: idx >= list.length - 1, onclick: () => step(1) }),
  ] : [];

  const tabs = el("div", { class: "ev-tabs", role: "tablist", "aria-label": "Evidence file" },
    evTab("outlined", `Outlined page · p.${fig.page}`, "This figure's page, outlined"),
    evTab("original", `Original report · p.${state.tab === "original" && state.pg ? state.pg : fig.page}`, "Full report"),
  );

  const off = officialUrl(p.official_source_url, fig.page);
  const links = el("div", { class: "ev-files" },
    fileLink(p.outlined_figure_pdf, "Outlined PDF"),
    fileLink(p.page_extract_pdf, "Page extract"),
    fileLink(p.source_pdf, "Original report"),
    off ? el("a", { href: off, target: "_blank", rel: "noopener", text: `Official source p.${fig.page} ↗` }) : null,
  );

  panel.replaceChildren(
    panelTop([...nav, copyButton("Copy link", () => new URL(urlFor({ pinRef: false }), location.href).href), copyButton("Cite", () => citation(fig))]),
    el("div", { class: "panel-head" },
      el("div", { class: "kicker", text: [entityTypeLabel(p.entity_type), p.county ? `${p.county} County` : ""].filter(Boolean).join(" · ") }),
      el("h2", {}, entityFilterLink(fig.entity, true)),
      el("div", { class: "sub" }, `FY ${fmtFy(fig.fy)} · `, feeLink(fig.fee, fig.program)),
      el("div", { class: "amount-line" },
        el("span", { class: "amount", text: fmtUsd(fig.value) }),
        el("span", { class: "printed" }, "printed ", el("code", { text: p.source_value_text }), " on the line ", el("q", { text: fig.label }))),
      el("div", { class: "badges" }, figureBadges(fig)),
    ),
    tabs,
    ensureViewer() && viewerRoot,
    links,
    figureDetails(fig),
  );
  showFigureEvidence(fig);
}

function evTab(tab, label, title) {
  const active = state.tab === tab;
  return el("button", {
    class: `ev-tab ${active ? "active" : ""}`, type: "button", role: "tab", "aria-selected": active ? "true" : "false", title, text: label,
    onclick: () => {
      if (state.tab === tab) return;
      state.tab = tab;
      state.pg = null;
      update();
    },
  });
}

function fileLink(path, label) {
  const href = dataUrl(path);
  return href ? el("a", { href, target: "_blank", rel: "noopener", title: path, text: `${label} ↗` }) : null;
}

async function showFigureEvidence(fig) {
  const p = fig.primary;
  const v = ensureViewer();
  // The page renders either way; the hash check reports what it could not do.
  const meta = await ensureFileMeta();
  if (state.figure !== fig.id) return;
  if (state.tab === "outlined") {
    const m = meta(p.outlined_figure_pdf);
    v.show({
      url: dataUrl(p.outlined_figure_pdf),
      sha256: m?.sha256 || "",
      bytes: m?.bytes || 0,
      page: 1,
      paging: false,
      outlineInFile: true,
      mismatchNote: "Recorded rectangle doesn't match drawn outline. No marker added.",
      boxesForPage: () => [figureBox(fig, true)],
      goToDocument: () => openDoc(p.source_id, state.pg || fig.page),
    });
  } else {
    const m = meta(p.source_pdf);
    const src = model.sourceById.get(p.source_id);
    v.show({
      url: dataUrl(p.source_pdf),
      sha256: p.source_sha256 || m?.sha256 || "",
      bytes: m?.bytes || src?._bytes || 0,
      page: state.pg || fig.page,
      paging: true,
      outlineInFile: false,
      mismatchNote: "No box: recorded rectangle doesn't match outline. See Outlined page.",
      boxesForPage: (n) => figuresOnPage(p.source_pdf, n).map((f) => figureBox(f, f.id === fig.id)),
      goToDocument: () => openDoc(p.source_id, state.pg || fig.page),
    });
  }
}

// Confirms a figure's recorded rectangle against the outline drawn in its own
// evidence file before the viewer draws a box from it (see checkOutline).
function verifyOutline(fig) {
  const p = fig.primary;
  return ensureFileMeta().then((meta) => {
    const m = meta(p.outlined_figure_pdf);
    return checkOutline(dataUrl(p.outlined_figure_pdf), p._rects, { sha256: m?.sha256, bytes: m?.bytes });
  });
}

function figureBox(f, current) {
  return {
    rects: f.primary._rects,
    id: f.id,
    current,
    label: `${f.program} · FY ${fmtFy(f.fy)} · ${f.label}: ${f.primary.source_value_text}`,
    verify: () => verifyOutline(f),
  };
}

function section(title, ...body) {
  return el("section", { class: "detail" }, el("h3", { text: title }), body);
}

function para(text, empty = "") {
  return text && text.trim() ? el("p", { text }) : el("p", { class: "muted", text: empty });
}

// What lib/arith.js may use to name the numbers in a bare equation: the
// figure as printed, the agency's other figures, and the page.
function arithmeticContext(fig, page) {
  const p = fig.primary;
  const printed = String(p.source_value_text || "").replace(/[\s$]/g, "");
  const n = Number(printed.replace(/[(),]/g, ""));
  const siblings = new Map();
  for (const f of model.figures) {
    // Small amounts could match by chance.
    if (f.entity !== fig.entity || f.id === fig.id || !Number.isFinite(f.value) || Math.abs(f.value) < 100) continue;
    siblings.set(f.value, siblings.has(f.value) && siblings.get(f.value) !== f.program ? null : f.program);
  }
  for (const [v, name] of siblings) if (!name) siblings.delete(v);
  return {
    value: printed && Number.isFinite(n) ? (/^\(.*\)$/.test(printed) ? -n : n) : null,
    label: fig.label,
    program: fig.program,
    siblings,
    pageNames: page ? (values) => namesFromPage(page.lines, page.column, values) : null,
  };
}

// The figure's page as lib/pagelines.js reads it, or null (also when it is
// slow to arrive: the tables are then named from the note alone).
const PAGE_WAIT_MS = 8000;
function pageFor(fig) {
  const p = fig.primary;
  return ensureFileMeta()
    .then((meta) => {
      const m = meta(p.outlined_figure_pdf);
      const read = readPageText(dataUrl(p.outlined_figure_pdf), { sha256: m?.sha256, bytes: m?.bytes });
      return Promise.race([read, new Promise((resolve) => setTimeout(resolve, PAGE_WAIT_MS, null))]);
    })
    .then((items) => {
      if (!items) return null;
      const lines = readPageLines(items);
      const column = figureColumn(lines, arithmeticContext(fig).value, fig.label);
      return column ? { lines, column } : null;
    })
    .catch(() => null);
}

// The release's arithmetic_check as tables: equations, then the context the
// note states (headings, dates), then whatever lib/arith.js could not place.
// Lines are named as the figure's page prints them, so the tables wait for it.
function arithmeticView(fig) {
  const text = fig.primary.arithmetic_check;
  if (!text || !text.trim()) return para("", "None recorded.");
  const box = el("div", { class: "arith-view" }, para("", "Reading page…"));
  pageFor(fig).then((page) => box.replaceChildren(...[arithmeticTables(fig, text, page)].flat().filter(Boolean)));
  return box;
}

function arithmeticTables(fig, text, page) {
  const { groups, facts, notes } = readArithmetic(text, arithmeticContext(fig, page));
  if (!groups.length && !facts.length) return para(text);
  const row = (op, t, cls = "") => el("tr", { class: cls },
    el("td", { class: "op", text: op }),
    el("th", { scope: "row", text: t.label }),
    el("td", { class: "num", text: t.amount }));
  // A note whose own sum does not close is shown as its printed lines, with no
  // operators, so the table never claims arithmetic the release does not show.
  const caption = (g) => g.caption || (g.printed ? "Lines as printed" : "");
  return [
    groups.length ? el("table", { class: "grid arith" },
      el("thead", {}, el("tr", {}, el("th", { class: "op", scope: "col" }), el("th", { scope: "col", text: "Line" }), el("th", { class: "num", scope: "col", text: "Amount" }))),
      groups.map((g) => el("tbody", { class: g.printed ? "printed" : "" },
        caption(g) ? el("tr", { class: "cap" }, el("th", { colspan: 3, scope: "rowgroup", text: caption(g) })) : null,
        g.terms.map((t) => row(t.op, t)),
        g.total ? row(g.printed ? "" : "=", g.total, "total") : null))) : null,
    facts.length ? el("table", { class: "grid facts" }, el("tbody", {},
      facts.map((f) => el("tr", {}, el("th", { scope: "row", text: f.label }), el("td", { text: f.value }))))) : null,
    notes.length ? el("ul", { class: "arith-notes" }, notes.map((n) => el("li", { text: n }))) : null,
  ];
}

function figureDetails(fig) {
  const p = fig.primary;
  const lims = splitLimitations(p.source_limitations);
  const dl = (pairs) => el("dl", { class: "kv-list" }, pairs.filter(([, v]) => v !== "" && v != null).map(([k, v]) => [el("dt", { text: k }), el("dd", {}, v)]));
  const mono = (t) => el("code", { class: "wrap", text: t });
  return el("div", { class: "details" },
    el("section", { class: "detail" }, dl([
      ["Land use", scopeTag(p.land_use_scope, true) || scopeLabel(p.land_use_scope)],
      ["Basis", basisLabel(p.accounting_basis_source_read)],
      ["Gross/net", grossNetLabel(p.gross_or_net_source_read)],
      ["Fiscal year", el("span", { title: humanize(p.fiscal_year_basis), text: `${fmtFy(fig.fy)} · ${p.fiscal_year_start} to ${p.fiscal_year_end}` })],
      ["Category", fig.catInferred ? `${categoryLabel(fig.cat)} (placed from the fee name)` : categoryLabel(fig.cat)],
      ["Law", fig.law ? lawLabel(fig.law) : NOT_CLASSIFIED],
      ["Area", fig.area ? [areaLabel(fig.area), fig.areaName].filter(Boolean).join(": ") : NOT_CLASSIFIED],
    ])),
    section("Arithmetic", arithmeticView(fig)),
    section("Notes", dl([
      ["Location", p.measure_read_from_source],
      ["Land use", p.land_use_basis],
      ["Limits", lims.length ? el("ul", {}, lims.map((t) => el("li", { text: t }))) : ""],
    ])),
    fig.rows.length > 1 ? section("Rows",
      el("table", { class: "grid rows" },
        el("thead", {}, el("tr", {}, ["Record", "Measure", "Role"].map((h) => el("th", { scope: "col", text: h })))),
        el("tbody", {}, fig.rows.map((r) => el("tr", {},
          el("td", {}, mono(r.record_id)),
          el("td", { text: humanize(r.measure) }),
          el("td", { text: roleLabel(r.measure_role) }))))),
      el("p", { class: "note", text: "Only the primary row is summed." })) : null,
    section("Source", dl([
      ["Publication", p.publication_title],
      ["Type", publicationTypeLabel(p.publication_type)],
      ["Page", `PDF ${fig.page}${p.printed_page ? ` · printed ${p.printed_page}` : ""}`],
      ["Located at", p.internal_identifier],
      ["Source id", mono(p.source_id)],
      ["SHA-256", mono(p.source_sha256)],
      ["Retrieved", p.retrieved_utc],
      ["Official URL", p.official_source_url ? el("a", { href: officialUrl(p.official_source_url) || "#", target: "_blank", rel: "noopener", class: "wrap", text: p.official_source_url }) : ""],
      ["Outline", mono(p.outline_rect_pdf_points)],
    ])),
    section("Review", dl([
      ["Status", statusLabel(p.validation_status)],
      ["Batch", p.review_batch],
      ["Reviewed (UTC)", p.reviewed_utc],
      ["Record", mono(p.record_id)],
    ])),
  );
}

function citation(fig) {
  const p = fig.primary;
  const page = `PDF page ${fig.page}${p.printed_page ? ` (printed page ${p.printed_page})` : ""}`;
  const ref = cfg.local ? "local files" : `release ${/^[0-9a-f]{40}$/.test(cfg.ref) ? cfg.ref.slice(0, 7) : cfg.ref}`;
  const link = new URL(urlFor({ pinRef: true }), location.href).href;
  return `${fig.entity}, “${p.publication_title}”, ${page}, ${p.internal_identifier}: ${p.source_value_text} (FY ${fmtFy(fig.fy)}, ${fig.program}). mfa-data ${ref}, record ${p.record_id}. ${link}`;
}

function renderDocPanel(panel, src) {
  const figs = [...(model.figures.filter((f) => f.rows.some((r) => r.source_id === src.source_id)))]
    .sort((a, b) => (a.page || 0) - (b.page || 0) || a.program.localeCompare(b.program));
  const off = officialUrl(src.official_source_url, state.pg || undefined);
  panel.replaceChildren(
    panelTop([copyButton("Copy link", () => new URL(urlFor(), location.href).href)]),
    el("div", { class: "panel-head" },
      el("div", { class: "kicker", text: `${publicationTypeLabel(src.publication_type)} · FY ${fmtFy(src.covers_fiscal_year)}` }),
      el("h2", { text: src.publication_title }),
      el("div", { class: "sub" },
        state.view === "sources" || model.entityByName.has(src.receiving_entity)
          ? entityFilterLink(src.receiving_entity, true)
          : src.receiving_entity,
        ` · ${fmtInt(src._pages || 0)} pages · ${fmtBytes(src._bytes)}`)),
    ensureViewer() && viewerRoot,
    el("div", { class: "ev-files" },
      fileLink(src.source_pdf, "Original report"),
      off ? el("a", { href: off, target: "_blank", rel: "noopener", text: "Official source ↗" }) : null),
    el("div", { class: "details" },
      section(`Figures (${figs.length})`,
        figs.length ? el("table", { class: "grid rows" },
          el("thead", {}, el("tr", {}, ["Page", "FY", "Fee program", "Amount"].map((h, i) => el("th", { scope: "col", class: i === 3 ? "num" : "", text: h })))),
          el("tbody", {}, figs.map((f) => el("tr", { onclick: () => openFigure(f.id, { list: figs, tab: "original" }) },
            el("td", {}, el("button", { class: "pdf-btn", type: "button", text: `p.${f.page}`, onclick: (ev) => { ev.stopPropagation(); viewer.goToPage(f.page); state.pg = f.page; writeUrl(false); } })),
            el("td", { text: fmtFy(f.fy) }),
            el("td", { text: f.program }),
            el("td", { class: "num", text: fmtUsd(f.value) }))))) : para("", "None.")),
      section("Source", el("dl", { class: "kv-list" },
        el("dt", { text: "Source id" }), el("dd", {}, el("code", { class: "wrap", text: src.source_id })),
        el("dt", { text: "SHA-256" }), el("dd", {}, el("code", { class: "wrap", text: src.source_sha256 })),
        el("dt", { text: "Retrieved" }), el("dd", { text: src.retrieved_utc }),
        el("dt", { text: "Official URL" }), el("dd", {}, el("a", { href: officialUrl(src.official_source_url) || "#", target: "_blank", rel: "noopener", class: "wrap", text: src.official_source_url }))))),
  );
  ensureManifest().catch(() => null).then((manifest) => {
    if (state.doc !== src.source_id) return;
    const m = manifest?.files.get(src.source_pdf);
    viewer.show({
      url: dataUrl(src.source_pdf),
      sha256: src.source_sha256 || m?.sha256 || "",
      bytes: m?.bytes || src._bytes || 0,
      page: state.pg || figs[0]?.page || 1,
      paging: true,
      outlineInFile: false,
      boxesForPage: (n) => figuresOnPage(src.source_pdf, n).map((f) => figureBox(f, false)),
    });
  });
}

// ============================================================ DOWNLOADS
// The Download menu: the current tab's rows as CSV, or an HTML report of
// any tabs. Both carry data rows only, never PDFs or Worker document URLs
// (approved by Amy on 2026-11-06); their links point at mfa.amyc.us and at
// the publisher's own copy.

const DATA_VIEWS = ["entities", "districts", "fees", "sources", "figures", "funds", "schedules", "permits", "coverage"];
const REPORT_TABS = ["entities", "fees", "figures", "sources", "funds", "schedules", "permits", "coverage", "districts"];
const LIB_VIEWS = ["funds", "schedules", "permits"];
const VIEW_LABEL = {
  entities: "Jurisdictions", districts: "Districts", fees: "Fees", sources: "Sources", figures: "Figures",
  funds: "Funds", schedules: "Schedules", permits: "Permits", coverage: "Coverage", stats: "Stats",
};
// A report table stops here; its tab says how many rows it left out.
const REPORT_ROW_CAP = 5000;
const SUM_CAVEAT = "Sums add primary rows only and are sums of what is shown, not statewide totals; a missing year is missing, not zero.";

// The lib tabs' rows for the downloads. Each call builds the tab's ctx from
// the address bar, so a tab never opened in this visit can be downloaded or
// ticked in the report; the lib view loads its file the first time.
const exportProviders = new Map([
  ["funds", (opts) => exportFunds(fundsCtx(), opts)],
  ["schedules", (opts) => exportSchedules(schedulesCtx(), opts)],
  ["permits", (opts) => exportPermits(permitsCtx(), opts)],
]);

// A link to the public site, pinned to this release. A local copy's data=
// means nothing to anyone else, so it never appears.
function siteHref(params) {
  const p = new URLSearchParams();
  if (!cfg.local && cfg.ref) p.set("ref", cfg.ref);
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const qs = p.toString();
  return `${SITE_URL}${qs ? `?${qs}` : ""}`;
}

function sitePermalink() {
  const p = stateParams({ pinRef: true });
  p.delete("data");
  if (cfg.local) p.delete("ref");
  const qs = p.toString();
  return `${SITE_URL}${qs ? `?${qs}` : ""}`;
}

const siteLink = (text, params) => ({ text, href: siteHref(params) });
const officialLink = (text, raw, page) => {
  const href = officialUrl(raw, page);
  return href ? { text, href } : text;
};

// The four district columns every agency row carries in a CSV.
function districtCsvColumns(agency) {
  const rec = (row) => {
    const r = districtRecord(agency(row));
    return r && r.basis !== "unmapped" ? r : null;
  };
  return [
    ...CHAMBERS.map((ch) => ({
      key: `${CHAMBER[ch].csv}_districts_touching`,
      value: (row) => rec(row)?.[ch].map((d) => d.n).sort((a, b) => a - b).join("; ") ?? "",
    })),
    ...CHAMBERS.map((ch) => ({
      key: `${CHAMBER[ch].csv}_district_resident_shares`,
      value: (row) => rec(row)?.[ch].slice().sort(byShare).map((d) => `${d.n}: ${d.share === null ? "n/a" : sharePct(d.share)}`).join("; ") ?? "",
    })),
  ];
}

// The tab's own filters in words, search first.
function tabFilterWords(view) {
  const tab = TABS[view];
  if (!tab) return [];
  const f = tab.filter();
  const out = [];
  const q = { figures: f.q, entities: f.eq, fees: f.fq, sources: f.sq, coverage: f.cq }[view];
  if (q) out.push({ label: "Search", value: `“${q}”` });
  if (view === "figures" && f.source) out.push({ label: "Source", value: model.sourceById.get(f.source)?.publication_title || f.source });
  for (const k of tab.tags) {
    const spec = boxSpec(view, k);
    const raw = spec.get();
    if (raw) out.push({ label: spec.label, value: splitChoice(raw).map((v) => spec.text(v)).join(" or ") });
  }
  if (view === "coverage") out.push({ label: "Years", value: state.cyr === "all" ? "all fiscal years" : `FY ${fmtFy(RECENT_FROM)} on` });
  return out;
}

function districtFilterWords() {
  return CHAMBERS.filter((ch) => state[ch])
    .map((ch) => ({ label: CHAMBER[ch].box, value: splitChoice(state[ch]).map((v) => (v === NONE ? "not mapped" : districtLabel(ch, v))).join(" or ") }));
}

// Every release column but the release's own document addresses, which map
// onto the Worker's document URLs: a CSV carries data rows, a link to the
// figure on mfa.amyc.us and the publisher's own copy.
const DOCUMENT_COLUMNS = new Set(["source_pdf", "page_extract_pdf", "outlined_figure_pdf"]);
const figureCsvColumns = () => [
  ...columns.filter((k) => !DOCUMENT_COLUMNS.has(k)).map((k) => ({
    key: k,
    value: k === "official_source_url" ? (fig) => officialUrl(fig.primary[k]) || "" : (fig) => fig.primary[k],
  })),
  { key: "figure_url", value: (fig) => siteHref({ view: "figures", f: fig.id }) },
];

// A money sum in a CSV, to the cent: float sums carry noise (6189861.170000001).
const cents = (v) => (Number.isFinite(v) ? (Math.round(v * 100) / 100).toFixed(2) : "");

const FIGURE_REPORT_COLUMNS = [
  { key: "entity", label: "Jurisdiction", kind: "link", value: (f) => siteLink(f.entity, { view: "entities", e: f.entity }) },
  { key: "fy", label: "Fiscal year", kind: "fy", value: (f) => f.fy },
  { key: "program", label: "Fee program", value: (f) => f.program },
  { key: "category", label: "Category", value: (f) => (f.cat ? categoryLabel(f.cat) : NOT_CLASSIFIED) },
  { key: "label", label: "Printed label", value: (f) => f.label },
  { key: "value", label: "Amount", kind: "usd", value: (f) => f.value },
  { key: "figure", label: "Figure", kind: "link", value: (f) => siteLink(`page ${f.primary.printed_page || f.page || ""}`.trim(), { view: "figures", f: f.id }) },
  { key: "official", label: "Publisher's copy", kind: "link", value: (f) => officialLink(f.primary.publication_title || "report", f.primary.official_source_url, f.page) },
];

function coverageYearWords(d, m) {
  return d.years.flatMap((fy, i) => {
    const b = 1 << i;
    if (!(m & b)) return [];
    return [{
      key: `fy_${fy.replace("-", "_")}`,
      value: (a) => (a.p & b ? "processed" : a.h & b ? "harvested" : a.nofee ? "no such fees" : "not harvested"),
    }];
  });
}

// Each tab's rows for the downloads, under its filters: label, report
// columns, CSV columns, rows, filters in words and the agency of a row.
// Async, since Coverage and Districts may need their files first.
async function tabExport(view, { page = true } = {}) {
  const words = tabFilterWords(view);
  if ((state.ad || state.sd) && view !== "districts") await ensureDistricts();
  // figures marks rows that are figures, which the report's key statistics
  // count; scope names them. An agency or fee page names itself in filters
  // and subtitle, so its report says whose rows it holds.
  if (view === "figures") {
    return { view, label: "Figures", base: "figures", rows: currentFigures(), columns: FIGURE_REPORT_COLUMNS, csv: figureCsvColumns(), agency: (f) => releaseWhere(f.entity), filters: words,
      figures: true, scope: "the figures on the Figures tab, under its filters",
      note: "Primary rows only; a figure's restatements are on its page." };
  }
  if (view === "entities" && page && state.entity) {
    const e = model.entityByName.get(state.entity);
    const rows = e ? entityFigureOrder(e) : [];
    return { view, label: state.entity, base: `${state.entity} figures`, rows, columns: FIGURE_REPORT_COLUMNS, csv: figureCsvColumns(), agency: (f) => releaseWhere(f.entity),
      filters: [{ label: "Jurisdiction", value: state.entity }], subtitle: state.entity, figures: true, scope: `the figures of ${state.entity}` };
  }
  if (view === "fees" && page && state.fee) {
    const fee = currentFee();
    const label = fee?.label || state.fee;
    return { view, label, base: `${state.entity} ${state.fee}`, rows: fee ? fee.figures : [], columns: FIGURE_REPORT_COLUMNS, csv: figureCsvColumns(), agency: (f) => releaseWhere(f.entity),
      filters: [{ label: "Jurisdiction", value: state.entity }, { label: "Fee", value: label }], subtitle: `${label}, ${state.entity}`, figures: true,
      scope: `the figures of ${label}, ${state.entity}` };
  }
  if (view === "entities") {
    return {
      view, label: "Jurisdictions", base: "jurisdictions", rows: entityRows(), agency: (e) => releaseWhere(e.name), filters: words,
      columns: [
        { key: "name", label: "Jurisdiction", kind: "link", value: (e) => siteLink(e.name, { view: "entities", e: e.name }) },
        { key: "type", label: "Type", value: (e) => entityTypeLabel(e.type) },
        { key: "county", label: "County", value: (e) => e.county },
        { key: "years", label: "Fiscal years", value: (e) => fyRanges(e.yearList) },
        { key: "figures", label: "Figures", kind: "int", value: (e) => e.figures.length },
        { key: "fees", label: "Fees", kind: "int", value: (e) => e.fees.size },
        { key: "reports", label: "Reports", kind: "int", value: (e) => e.sources.size },
        { key: "sum", label: "Sum of primary rows", kind: "usd", value: (e) => e.sum },
      ],
      csv: [
        { key: "jurisdiction", value: (e) => e.name },
        { key: "entity_type", value: (e) => e.type },
        { key: "entity_type_label", value: (e) => entityTypeLabel(e.type) },
        { key: "county", value: (e) => e.county },
        { key: "fiscal_years", value: (e) => e.yearList.join("; ") },
        { key: "years", value: (e) => e.years.size },
        { key: "figures", value: (e) => e.figures.length },
        { key: "fees", value: (e) => e.fees.size },
        { key: "reports", value: (e) => e.sources.size },
        { key: "sum_of_primary_rows_usd", value: (e) => cents(e.sum) },
        { key: "page_url", value: (e) => siteHref({ view: "entities", e: e.name }) },
      ],
    };
  }
  if (view === "fees") {
    const program = (fee) => fee.figures[fee.figures.length - 1].program;
    return {
      view, label: "Fees", base: "fees", rows: feeRows(), agency: (fee) => releaseWhere(fee.entity), filters: words,
      columns: [
        { key: "entity", label: "Jurisdiction", kind: "link", value: (fee) => siteLink(fee.entity, { view: "entities", e: fee.entity }) },
        { key: "fee", label: "Fee", kind: "link", value: (fee) => siteLink(fee.label, { view: "fees", e: fee.entity, fee: program(fee) }) },
        { key: "category", label: "Category", value: (fee) => (fee.cat ? categoryLabel(fee.cat) : NOT_CLASSIFIED) },
        { key: "years", label: "Fiscal years", value: (fee) => fyRanges(fee.yearList) },
        { key: "figures", label: "Figures", kind: "int", value: (fee) => fee.figures.length },
        { key: "sum", label: "Sum of primary rows", kind: "usd", value: (fee) => fee.sum },
      ],
      csv: [
        { key: "jurisdiction", value: (fee) => fee.entity },
        { key: "fee", value: (fee) => fee.label },
        { key: "names_as_printed", value: (fee) => fee.names.join("; ") },
        { key: "fee_category", value: (fee) => fee.cat },
        { key: "fee_category_label", value: (fee) => (fee.cat ? categoryLabel(fee.cat) : NOT_CLASSIFIED) },
        { key: "entity_type", value: (fee) => latestPrimary(fee).entity_type },
        { key: "county", value: (fee) => latestPrimary(fee).county },
        { key: "fiscal_years", value: (fee) => fee.yearList.join("; ") },
        { key: "figures", value: (fee) => fee.figures.length },
        { key: "sum_of_primary_rows_usd", value: (fee) => cents(fee.sum) },
        { key: "page_url", value: (fee) => siteHref({ view: "fees", e: fee.entity, fee: program(fee) }) },
      ],
    };
  }
  if (view === "sources") {
    return {
      view, label: "Sources", base: "sources", rows: sourceRows(), agency: (s) => releaseWhere(s.receiving_entity), filters: words,
      columns: [
        { key: "agency", label: "Agency", value: (s) => s.receiving_entity },
        { key: "title", label: "Publication", kind: "link", value: (s) => officialLink(s.publication_title, s.official_source_url) },
        { key: "type", label: "Type", value: (s) => publicationTypeLabel(s.publication_type) },
        { key: "covers", label: "Covers", value: (s) => coversYears(s).map(fmtFy).join(", ") || s.covers_fiscal_year },
        { key: "pages", label: "Pages", kind: "int", value: (s) => s._pages },
        { key: "figures", label: "Figures", kind: "int", value: (s) => s._figures },
        { key: "source", label: "Source id", kind: "link", value: (s) => siteLink(s.source_id, { view: "sources", doc: s.source_id }) },
      ],
      csv: [
        { key: "source_id", value: (s) => s.source_id },
        { key: "agency", value: (s) => s.receiving_entity },
        { key: "publication_title", value: (s) => s.publication_title },
        { key: "publication_type", value: (s) => s.publication_type },
        { key: "publication_type_label", value: (s) => publicationTypeLabel(s.publication_type) },
        { key: "covers_fiscal_year", value: (s) => s.covers_fiscal_year },
        { key: "fiscal_years_named", value: (s) => coversYears(s).join("; ") },
        { key: "pages", value: (s) => s._pages },
        { key: "bytes", value: (s) => s._bytes },
        { key: "figures", value: (s) => s._figures },
        { key: "official_source_url", value: (s) => officialUrl(s.official_source_url) || "" },
        { key: "retrieved_utc", value: (s) => s.retrieved_utc },
        { key: "source_sha256", value: (s) => s.source_sha256 },
        { key: "page_url", value: (s) => siteHref({ view: "sources", doc: s.source_id }) },
      ],
    };
  }
  if (view === "coverage") {
    const d = await loadCoverage();
    const m = coverageMask(d);
    const span = bitCount(m);
    return {
      view, label: "Coverage", base: "coverage", rows: coverageRows(m), agency: (a) => [a.name, { type: a.type, county: a.county }], filters: words,
      columns: [
        { key: "name", label: "Jurisdiction", kind: "link", value: (a) => (a.names.length ? siteLink(a.name, { view: "entities", e: a.names[0] }) : a.name) },
        { key: "class", label: "Class", value: (a) => coverageClassLabel(a.cls) },
        { key: "type", label: "Type", value: (a) => coverageTypeName(a.type) },
        { key: "county", label: "County", value: (a) => a.county },
        { key: "harvested", label: `Years harvested of ${span}`, kind: "int", value: (a) => bitCount(a.h & m) },
        { key: "processed", label: `Years processed of ${span}`, kind: "int", value: (a) => bitCount(a.p & m) },
        { key: "nofee", label: "Charges no such fees", value: (a) => (a.nofee ? "yes" : "") },
      ],
      csv: [
        { key: "jurisdiction", value: (a) => a.name },
        { key: "class", value: (a) => a.cls },
        { key: "agency_type", value: (a) => a.type },
        { key: "county", value: (a) => a.county },
        { key: "release_names", value: (a) => a.names.join("; ") },
        { key: "charges_no_such_fees", value: (a) => (a.nofee ? "yes" : "") },
        { key: "years_counted", value: () => span },
        { key: "years_harvested", value: (a) => bitCount(a.h & m) },
        { key: "years_processed", value: (a) => bitCount(a.p & m) },
        ...coverageYearWords(d, m),
      ],
    };
  }
  if (view === "districts") {
    await ensureDistricts();
    const agg = districtAggregates();
    const ch = state.dch;
    const row = state.dn ? agg[ch][Number(state.dn) - 1] : null;
    const filters = [{ label: "Chamber", value: CHAMBER[ch].word }];
    if (row) {
      return {
        view, label: row.label, base: row.label, rows: districtPageRows(row), agency: (x) => x.rec, filters: [...filters, { label: "District", value: row.label }],
        subtitle: `Agencies touching ${row.label}`, district: { [ch]: String(row.n) },
        note: DISTRICT_SUM_TIP,
        columns: [
          { key: "name", label: "Agency", kind: "link", value: (x) => (x.pub ? siteLink(x.rec.name, { view: "entities", e: x.pub.main.name }) : x.rec.name) },
          { key: "type", label: "Type", value: (x) => humanize(x.rec.type) },
          { key: "county", label: "County", value: (x) => x.rec.county },
          { key: "share", label: "2020 residents in district", kind: "pct", value: (x) => x.d.share },
          { key: "edge", label: "Edge", value: (x) => (x.d.edge ? "edge" : "") },
          { key: "basis", label: "Basis", value: (x) => DISTRICT_BASIS_SHORT[x.rec.basis] },
          { key: "figures", label: "Figures", kind: "int", value: (x) => x.pub?.figures },
          { key: "years", label: "Fiscal years with figures", value: (x) => (x.pub ? fyRanges(x.pub.years) : "") },
          { key: "sum", label: "Sum of primary rows", kind: "usd", value: (x) => x.pub?.sum },
        ],
        csv: [
          { key: "chamber", value: () => CHAMBER[ch].csv },
          { key: "district", value: () => row.n },
          { key: "agency", value: (x) => x.rec.name },
          { key: "agency_type", value: (x) => x.rec.type },
          { key: "county", value: (x) => x.rec.county },
          { key: "class", value: (x) => x.rec.class },
          { key: "basis", value: (x) => x.rec.basis },
          { key: "basis_note", value: (x) => x.rec.basis_note },
          { key: "resident_share_2020", value: (x) => x.d.share },
          { key: "area_share", value: (x) => x.d.area_share },
          { key: "edge", value: (x) => (x.d.edge ? "yes" : "") },
          { key: "release_names", value: (x) => x.pub?.names.map((e) => e.name).join("; ") || "" },
          { key: "figures", value: (x) => x.pub?.figures ?? "" },
          { key: "fiscal_years_with_figures", value: (x) => x.pub?.years.join("; ") || "" },
          { key: "latest_fy", value: (x) => x.pub?.years.at(-1) || "" },
          { key: "whole_agency_sum_of_primary_rows_usd", value: (x) => (x.pub ? cents(x.pub.sum) : "") },
          { key: "district_sum_note", value: () => DISTRICT_SUM_TIP },
        ],
      };
    }
    return {
      view, label: `${CHAMBER[ch].word} districts`, base: `${CHAMBER[ch].csv} districts`, rows: districtRows(agg, ch), filters, note: DISTRICT_SUM_TIP,
      columns: [
        { key: "n", label: "District", kind: "link", value: (r) => siteLink(r.label, { view: "districts", dch: ch === "ad" ? "" : ch, dn: String(r.n) }) },
        { key: "counties", label: "Counties touched", value: (r) => r.counties.join(", ") },
        { key: "muni", label: "Cities and counties touching", kind: "int", value: (r) => r.muni },
        { key: "muniFig", label: "Of those with published figures", kind: "int", value: (r) => r.muniFig },
        { key: "school", label: "School districts touching", kind: "int", value: (r) => r.school },
        { key: "special", label: "Special districts touching (mapped only)", kind: "int", value: (r) => r.special },
        { key: "figures", label: "Published figures of touching agencies", kind: "int", value: (r) => r.figures },
        { key: "sum", label: "Sum of primary rows", kind: "usd", value: (r) => (r.withFigures ? r.sum : null) },
      ],
      csv: [
        { key: "chamber", value: () => CHAMBER[ch].csv },
        { key: "district", value: (r) => r.n },
        { key: "counties_touched", value: (r) => r.counties.join("; ") },
        { key: "cities_and_counties_touching", value: (r) => r.muni },
        { key: "of_those_with_published_figures", value: (r) => r.muniFig },
        { key: "school_districts_touching", value: (r) => r.school },
        { key: "special_districts_touching_mapped", value: (r) => r.special },
        { key: "published_figures", value: (r) => r.figures },
        { key: "whole_agency_sum_of_primary_rows_usd", value: (r) => (r.withFigures ? cents(r.sum) : "") },
        { key: "district_sum_note", value: () => DISTRICT_SUM_TIP },
        { key: "page_url", value: (r) => siteHref({ view: "districts", dch: ch === "ad" ? "" : ch, dn: String(r.n) }) },
      ],
    };
  }
  if (LIB_VIEWS.includes(view)) {
    const provider = exportProviders.get(view);
    if (!provider) return null;
    const x = await provider({ page });
    if (!x) return null;
    const agency = typeof x.agency === "function" ? (row) => { const a = x.agency(row); return Array.isArray(a) ? a : [a]; } : null;
    const columns = x.columns || [];
    return {
      view, label: x.label || VIEW_LABEL[view], base: x.base || x.label || view,
      rows: x.rows || [], columns, csv: x.csv || columns, filters: x.filters || [],
      agency, intro: x.intro, note: x.note, subtitle: x.subtitle || "", empty: x.empty || "",
    };
  }
  return null;
}

// ------------------------------------------------------------ menu

let downloadMenu = null;

function renderExportButton() {
  const b = $("export-btn");
  if (!b) return;
  b.hidden = !DATA_VIEWS.includes(state.view);
  if (downloadMenu && downloadMenu.dataset.view !== state.view) closeDownloadMenu(false);
}

function closeDownloadMenu(focus = true) {
  if (!downloadMenu) return;
  downloadMenu.remove();
  downloadMenu = null;
  document.removeEventListener("pointerdown", onDownloadOutside, true);
  window.removeEventListener("resize", onDownloadResize);
  const b = $("export-btn");
  b.setAttribute("aria-expanded", "false");
  if (focus) b.focus();
}

function onDownloadOutside(ev) {
  if (!downloadMenu || downloadMenu.contains(ev.target) || $("export-btn").contains(ev.target)) return;
  closeDownloadMenu(false);
}

function onDownloadResize() {
  if (downloadMenu) placeDownloadMenu();
}

// Right-aligned with the button, but kept on screen when the header wraps
// it to the left on a phone.
function placeDownloadMenu() {
  const r = $("export-btn").getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const w = downloadMenu.offsetWidth;
  downloadMenu.style.top = `${Math.round(r.bottom + 4)}px`;
  downloadMenu.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, vw - w - 8)))}px`;
}

function toggleDownloadMenu() {
  if (downloadMenu) closeDownloadMenu();
  else openDownloadMenu();
}

const csvLabel = (n) => `CSV of this tab (${fmtInt(n)} row${n === 1 ? "" : "s"})`;

function openDownloadMenu() {
  if (!model) return;
  closeFilterBox({ focus: false });
  const view = state.view;
  const csvItem = el("button", { type: "button", role: "menuitem", class: "dl-item", text: "CSV of this tab (…)", disabled: true });
  const reportItem = el("button", {
    type: "button", role: "menuitem", class: "dl-item", text: "HTML report…",
    onclick: () => { closeDownloadMenu(false); openReportDialog(); },
  });
  // The status line is a live region beside the menu, not one of its items.
  const status = el("p", { class: "dl-status muted", role: "status" });
  const items = () => [...downloadMenu.querySelectorAll(".dl-item:not(:disabled)")];
  const menu = el("div", { class: "dl-menu-items", role: "menu", "aria-label": "Download" }, csvItem, reportItem);
  downloadMenu = el("div", {
    class: "dl-menu", dataset: { view },
    onkeydown: (ev) => {
      const list = items();
      const i = list.indexOf(document.activeElement);
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeDownloadMenu(); }
      // The menu sits at the end of the page, so Tab goes on from the button
      // as if the menu were not there.
      else if (ev.key === "Tab") {
        $("export-btn").focus();
        closeDownloadMenu(false);
      }
      else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const step = ev.key === "ArrowDown" ? 1 : -1;
        list[(i + step + list.length) % list.length]?.focus();
      } else if (ev.key === "Home" || ev.key === "End") {
        ev.preventDefault();
        list[ev.key === "Home" ? 0 : list.length - 1]?.focus();
      }
    },
  }, menu, status);
  document.body.append(downloadMenu);
  placeDownloadMenu();
  $("export-btn").setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", onDownloadOutside, true);
  window.addEventListener("resize", onDownloadResize);
  reportItem.focus();
  const open = downloadMenu;
  tabExport(view).then((x) => {
    if (downloadMenu !== open) return;
    const n = x ? x.rows.length : 0;
    csvItem.textContent = x ? csvLabel(n) : "CSV of this tab";
    csvItem.disabled = !n;
    csvItem.title = !x ? "This tab has no rows to download yet" : n ? `${x.label}: every row under this tab's filters` : x.empty || "No rows match this tab's filters";
    csvItem.onclick = () => downloadCsv(x, csvItem, status);
    if (n) csvItem.focus();
  }).catch((err) => {
    if (downloadMenu !== open) return;
    csvItem.textContent = "CSV of this tab";
    csvItem.title = `Could not read this tab: ${err.message}`;
    status.textContent = `Could not read this tab: ${err.message}`;
  });
}

// Under the district filter a CSV says so in every row, with the overlap
// caveat, and its filename names the districts. The Districts tab lists
// every district, so it takes neither.
function districtFilterCsv(x) {
  if (!(state.ad || state.sd) || x.view === "districts") return { cols: [], base: x.base };
  const words = districtFilterWords().map((f) => `${f.label} ${f.value}`).join("; ");
  const tag = CHAMBERS.filter((ch) => state[ch]).map((ch) => {
    const vals = splitChoice(state[ch]);
    return `${CHAMBER[ch].short} ${vals.length > 3 ? `${vals.length} districts` : vals.map((v) => (v === NONE ? "not mapped" : v)).join(" ")}`;
  }).join(" ");
  return {
    cols: [
      { key: "district_filter", value: () => words },
      { key: "district_caveat", value: () => `${districtCaveat()} ${DISTRICT_APPROX}` },
    ],
    base: `${x.base} ${tag}`,
  };
}

async function downloadCsv(x, item, status) {
  item.disabled = true;
  status.textContent = "Preparing…";
  try {
    let cols = x.csv || x.columns;
    if (x.agency) {
      await ensureDistricts();
      cols = [...cols, ...districtCsvColumns(x.agency)];
    }
    const dist = districtFilterCsv(x);
    cols = [...cols, ...dist.cols];
    downloadText(csvText(cols, x.rows), exportFilename(dist.base, "csv"), "text/csv");
    closeDownloadMenu();
  } catch (err) {
    item.disabled = false;
    status.textContent = `Download failed: ${err.message}`;
  }
}

// ------------------------------------------------------------ report

// district names the district filter in force ("" for none).
const REPORT_TEXT = (district) => `One file with key statistics and a table for each tab ticked, each under its own filters${district ? ` and the district filter, ${district} (except Districts, which lists every district)` : ""}. The statistics are worked out from the ticked tabs and say which rows they count. A table stops at ${fmtInt(REPORT_ROW_CAP)} rows; the CSV of a tab holds every row. Data rows only; links go to mfa.amyc.us and the publisher's copy.`;

function openReportDialog() {
  const here = state.view;
  const boxes = REPORT_TABS.map((v) => el("label", { class: "rd-tab" },
    el("input", { type: "checkbox", name: "report-tab", value: v, checked: v === here }), ` ${VIEW_LABEL[v]}`));
  const capNote = el("p", { class: "rd-cap", hidden: true });
  const progress = el("p", { class: "rd-progress muted", role: "status", "aria-live": "polite" });
  const go = el("button", { class: "btn primary", type: "button", text: "Download" });
  const cancel = el("button", { class: "btn", type: "button", text: "Cancel" });
  const dialog = el("div", { class: "report-dialog", role: "dialog", "aria-modal": "true", tabindex: "-1", "aria-labelledby": "rd-title", "aria-describedby": "rd-desc" },
    el("h2", { id: "rd-title", text: "HTML report" }),
    el("p", { id: "rd-desc", class: "muted", text: REPORT_TEXT(districtFilterWords().map((f) => `${f.label} ${f.value}`).join("; ")) }),
    el("fieldset", { class: "rd-tabs" }, el("legend", { text: "Tabs" }), boxes),
    capNote,
    progress,
    el("div", { class: "rd-actions" }, cancel, go));
  const backdrop = el("div", { class: "report-backdrop" }, dialog);
  const app = $("app");
  const ticked = () => [...dialog.querySelectorAll("input[name=report-tab]:checked")].map((n) => n.value);

  // Escape and Tab are heard on the whole document, so a click on the
  // dialog's text never leaves them behind; the page behind is inert.
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      return;
    }
    if (ev.key !== "Tab") return;
    const f = [...dialog.querySelectorAll("button, input, a[href]")].filter((n) => !n.disabled);
    if (!f.length) return;
    const at = document.activeElement;
    if (!dialog.contains(at) || at === dialog) {
      ev.preventDefault();
      (ev.shiftKey ? f[f.length - 1] : f[0]).focus();
    } else if (ev.shiftKey && at === f[0]) {
      ev.preventDefault();
      f[f.length - 1].focus();
    } else if (!ev.shiftKey && at === f[f.length - 1]) {
      ev.preventDefault();
      f[0].focus();
    }
  };
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (app) app.inert = false;
    $("export-btn")?.focus();
  };

  // A tab over the row cap is named before the download. Counting a lib tab
  // loads its file, which the report would need anyway.
  const counts = new Map();
  const rowCount = (v) => {
    if (!counts.has(v)) counts.set(v, tabExport(v, { page: v === here }).then((x) => (x ? x.rows.length : 0), () => 0));
    return counts.get(v);
  };
  let capRun = 0;
  const syncCap = async () => {
    const run = ++capRun;
    const views = ticked();
    const ns = await Promise.all(views.map(rowCount));
    if (run !== capRun || !backdrop.isConnected) return;
    const over = views.map((v, i) => [v, ns[i]]).filter(([, n]) => n > REPORT_ROW_CAP);
    capNote.hidden = !over.length;
    capNote.textContent = over.length
      ? `${over.map(([v, n]) => `${VIEW_LABEL[v]} has ${fmtInt(n)} rows`).join(" and ")}; ${over.length === 1 ? "its report table stops" : "their report tables stop"} at ${fmtInt(REPORT_ROW_CAP)}. Download the CSV of ${over.length === 1 ? "the tab" : "each tab"} for every row.`
      : "";
  };
  const sync = () => {
    go.disabled = !ticked().length;
    syncCap();
  };
  dialog.addEventListener("change", sync);
  cancel.addEventListener("click", close);
  backdrop.addEventListener("pointerdown", (ev) => { if (ev.target === backdrop) close(); });
  document.addEventListener("keydown", onKey, true);
  go.addEventListener("click", async () => {
    const views = ticked();
    // Focus stays in the dialog while Download is disabled.
    dialog.focus();
    go.disabled = true;
    try {
      const html = await buildReport(views, (msg) => { progress.textContent = msg; });
      downloadText(html, exportFilename("report", "html"), "text/html");
      close();
    } catch (err) {
      console.error(err);
      progress.textContent = `Report failed: ${err.message}`;
      go.disabled = false;
      go.focus();
    }
  });
  document.body.append(backdrop);
  if (app) app.inert = true;
  sync();
  (dialog.querySelector("input:checked") || dialog.querySelector("input") || go).focus();
}

// One clause per chamber: "Agencies touching Assembly District 53", "Agencies
// not mapped to an Assembly district", or both joined with "or".
function districtSubtitle() {
  const clauses = CHAMBERS.filter((ch) => state[ch]).map((ch) => {
    const vals = splitChoice(state[ch]);
    const named = vals.filter((v) => v !== NONE);
    const word = CHAMBER[ch].word;
    return [
      named.length ? `touching ${CHAMBER[ch].label}${named.length > 1 ? "s" : ""} ${named.join(", ")}` : "",
      vals.includes(NONE) ? `not mapped to ${/^[AEIOU]/.test(word) ? "an" : "a"} ${word} district` : "",
    ].filter(Boolean).join(" or ");
  });
  return clauses.length ? `Agencies ${clauses.join(" and ")}` : "";
}

async function buildReport(views, progress) {
  const tabs = [];
  const xs = [];
  const district = districtFilterWords();
  const filters = [...district];
  for (const v of views) {
    progress(`Reading ${VIEW_LABEL[v]}…`);
    // The open tab comes as it is shown, so an agency or fee page gives that
    // agency's rows, as its CSV does; the other tabs give their lists.
    const x = await tabExport(v, { page: v === state.view });
    if (!x) {
      // A ticked tab is never dropped without a word.
      tabs.push({ key: v, label: VIEW_LABEL[v], intro: "This tab had no rows to report.", columns: [], rows: [], empty: "No rows." });
      continue;
    }
    xs.push(x);
    const words = x.filters || [];
    for (const f of words) filters.push({ label: `${VIEW_LABEL[v]} › ${f.label}`, value: f.value });
    // Every tab but Districts applies the district filter; Districts lists
    // every district, and says so.
    const all = v === "districts";
    const scope = all ? words : [...district, ...words];
    const intro = [
      x.intro,
      scope.length ? `Filtered to ${scope.map((f) => `${f.label}: ${f.value}`).join("; ")}.` : "No filters on this tab.",
      all && district.length ? "Lists every district; the district filter does not apply to this tab." : "",
    ].filter(Boolean).join(" ");
    tabs.push({
      key: v, label: v === state.view && x.subtitle ? x.label : VIEW_LABEL[v], intro, note: x.note, empty: x.empty,
      columns: x.columns, rows: x.rows.slice(0, REPORT_ROW_CAP), total: x.rows.length,
    });
  }
  progress("Working out key statistics…");
  const stats = await reportStats(xs);
  progress("Writing the file…");
  const caveats = [];
  // The overlap caveat goes wherever a district filter or list is in the report.
  if (state.ad || state.sd || xs.some((x) => x.view === "districts")) caveats.push(districtCaveat(), DISTRICT_APPROX, districts?.meta.plan_note || "");
  caveats.push(...stats.caveats, SUM_CAVEAT);
  const cut = tabs.filter((t) => t.total > t.rows.length).map((t) => t.label);
  if (cut.length) {
    caveats.push(`The ${cut.join(" and ")} ${cut.length === 1 ? "table stops" : "tables stop"} at ${fmtInt(REPORT_ROW_CAP)} rows; the key statistics count every row, and the CSV of a tab holds them all.`);
  }
  const open = xs.find((x) => x.view === state.view && x.subtitle);
  // The report header already names the database above the title.
  return reportHtml({
    title: "Impact fee report",
    subtitle: [open?.subtitle, districtSubtitle()].filter(Boolean).join("; "),
    generated_utc: new Date().toISOString(),
    release: cfg.local ? "local files" : cfg.ref,
    permalink: sitePermalink(),
    filters,
    caveats: caveats.filter(Boolean),
    stats: stats.tiles,
    stats_scope: stats.scope,
    tabs,
  });
}

// Key statistics, worked out from the report's own rows so they agree with
// its tables: the figures of the open agency or fee page, else of the
// Figures tab, else of the jurisdictions or fees listed. With no ticked tab
// that lists figures they cover the whole release under the district filter
// (a district page counts as one). Roster tiles come from the Coverage tab,
// or from the whole roster when the figures do. scope says what was counted.
async function reportStats(xs) {
  const by = new Map(xs.map((x) => [x.view, x]));
  const open = by.get(state.view);
  const figTab = open?.figures ? open : xs.find((x) => x.figures);
  const listTab = figTab ? null : by.get("entities") || by.get("fees");
  const whole = !figTab && !listTab;
  const df = open?.district || { ad: state.ad, sd: state.sd };
  const districted = Boolean(df.ad || df.sd);
  if (districted) await ensureDistricts();
  const test = districtTest(df);
  let figs;
  let from;
  if (figTab) {
    figs = figTab.rows;
    from = figTab.scope;
  } else if (listTab) {
    figs = listTab.rows.flatMap((r) => r.figures);
    from = listTab.view === "entities" ? "the figures of the jurisdictions on the Jurisdictions tab, under its filters" : "the figures of the fees on the Fees tab, under its filters";
  } else {
    figs = test ? model.figures.filter((f) => test(...releaseWhere(f.entity))) : model.figures;
    const who = open?.district ? `every agency touching ${open.label}` : districted ? "every agency under the district filter" : "";
    from = `${who ? `the figures of ${who} across` : ""} the whole release (no ticked tab lists figures, so the tabs' own filters do not apply)`.trim();
  }
  const sum = summarize(figs);
  const tiles = [];
  const caveats = [];

  const covTab = by.get("coverage");
  const cov = covTab || whole ? await loadCoverage().catch((err) => { console.warn(err); return null; }) : null;
  let roster = null;
  if (covTab) roster = covTab.rows;
  else if (whole && cov) roster = test ? cov.agencies.filter((a) => test(a.name, { type: a.type, county: a.county })) : cov.agencies;
  // Under a district filter without "(not mapped)", only agencies with a
  // mapped boundary can pass, which leaves most special districts out.
  const mappedOnly = districtMappedOnly(df);
  if (roster) {
    for (const c of cov.classes) {
      tiles.push({ label: `${c.label} in scope`, value: roster.filter((a) => a.cls === c.key).length, kind: "int", note: mappedOnly ? "Mapped agencies on the coverage roster" : "On the coverage roster" });
    }
    if (mappedOnly) caveats.push(`Roster counts under the district filter hold only agencies with a mapped boundary. ${unmappedRosterText(cov)}`);
  }
  tiles.push({ label: "Jurisdictions with published figures", value: sum.entities, kind: "int" });
  tiles.push({ label: "Published figures", value: sum.count, kind: "int" });
  const sources = by.get("sources");
  if (sources) tiles.push({ label: "Reports", value: sources.rows.length, kind: "int", note: "Listed on the Sources tab" });
  else if (whole) tiles.push({ label: "Reports", value: test ? model.sources.filter((s) => test(...releaseWhere(s.receiving_entity))).length : model.sources.length, kind: "int", note: "Publications in the release" });
  else tiles.push({ label: "Reports", value: new Set(figs.map((f) => f.primary.source_id).filter(Boolean)).size, kind: "int", note: "That these figures come from" });
  tiles.push({
    label: "Fiscal years", kind: "text",
    value: sum.firstYear ? `FY ${fmtFy(sum.firstYear)}${sum.lastYear !== sum.firstYear ? ` to ${fmtFy(sum.lastYear)}` : ""}` : "",
  });
  tiles.push({
    label: "Sum of primary rows", kind: "usd", value: sum.count ? sum.sum : null,
    note: districted ? "Whole-agency totals; agencies count in every district they touch" : whole ? "Every published primary row; not all California fees" : "Primary rows of the figures counted",
  });
  if (roster) {
    const want = ["2022-23", "2023-24", "2024-25"].map((y) => cov.years.indexOf(y)).filter((i) => i >= 0);
    const muni = roster.filter((a) => a.cls === "municipal");
    let processed = 0;
    let harvested = 0;
    for (const a of muni) {
      for (const i of want) {
        const b = 1 << i;
        if (a.p & b || a.nofee) processed += 1;
        if (a.h & b || a.nofee) harvested += 1;
      }
    }
    const slots = muni.length * want.length;
    tiles.push({
      label: "FY 2022-23 to 2024-25 processed, cities and counties", kind: "pct", value: slots ? processed / slots : null,
      note: `${fmtInt(processed)} of ${fmtInt(slots)} jurisdiction-years; ${fmtInt(harvested)} harvested`,
    });
  }
  if (state.ad || state.sd) {
    const n = CHAMBERS.reduce((k, ch) => k + splitChoice(state[ch]).filter((v) => v !== NONE).length, 0);
    tiles.push({ label: "Districts in the filter", value: n, kind: "int", note: districtFilterWords().map((f) => f.value).join("; ") });
  }
  const scope = [`Counted from ${from}.`];
  if (roster) scope.push(covTab ? "Roster counts come from the Coverage tab, under its filters." : `Roster counts cover the whole coverage roster${districted ? " under the district filter" : ""}.`);
  return { tiles, caveats, scope: scope.join(" ") };
}

// ------------------------------------------------------------ lib views
// What lib views take from ctx besides their own helpers: the filter boxes,
// the district filter and the downloads. permitsCtx and the funds and
// schedules ctx all spread libCtx(); the old select and chip still work.
//   filterBoxButton(spec), colFilterButton(spec), facetOptions(rows, valueFn,
//     labelFn, {include}), refreshFilterBoxes(root), boxSummary(spec, raw) and
//     filterTag(label, onRemove) are the filter box helpers.
//   districtFilter() gives {ad, sd}; setDistrictFilter(ch, v) sets one.
//   districtSpecs(rowsFn, agencyFn) and districtBoxes(rowsFn, agencyFn) give
//     the AD and SD box specs or buttons; agencyFn(row) returns a name or
//     [name, {type, county}].
//   districtsFor(name, opts) is the crosswalk record, or null until loaded.
//   rowPassesDistricts(name, opts) tests the current ad and sd; before the
//     file loads only "(not mapped)" passes, so await ensureDistricts().
//   ensureDistricts() loads districts.json once; districtsLoaded() says if
//     it has. districtTags() and districtNote() go in the result bar;
//     districtCaveat() and caveat are the overlap caveat text.
//   clearDistrictFilter() empties ad and sd without a render, for a tab's
//     Clear that then renders once.
//   siteHref(params) and siteLink(text, params) point at the public site,
//     for CSV page_url columns and report links.
// Each lib view also exports its downloads (exportFunds, exportSchedules,
// exportPermits), which exportProviders calls with a fresh ctx. They take
// {page} and return {label, columns, rows, csv?, filters?, agency?, intro?,
// note?, base?, subtitle?, empty?}; page is false for a report tab that is
// not the open one, which wants the tab's list rather than one agency's
// page. filters are {label, value} pairs; agency(row) gives a name or
// [name, {type, county}] for the four district columns of the CSV; empty
// says why there are no rows.

function districtSpecs(rowsFn, agencyFn) {
  const agency = (row) => {
    const a = agencyFn(row);
    return Array.isArray(a) ? a : [a];
  };
  return CHAMBERS.map((ch) => makeSpec(ch, districtDef(ch, agency), {
    filter: () => ({ ad: state.ad, sd: state.sd }),
    rows: (f) => {
      const list = rowsFn() || [];
      const test = districtTest(f);
      return test ? list.filter((r) => test(...agency(r))) : list;
    },
    apply: (k, v) => setFilter(state.view, k, v),
  }));
}

function districtTags() {
  return CHAMBERS.filter((ch) => state[ch]).map((ch) => filterTag(`${CHAMBER[ch].box}: ${splitChoice(state[ch]).map((v) => districtLabel(ch, v)).join(" or ")}`,
    () => setFilter(state.view, ch, "")));
}

function libCtx() {
  return {
    filterBoxButton, colFilterButton, facetOptions, refreshFilterBoxes, boxSummary, filterTag,
    districtFilter: () => ({ ad: state.ad, sd: state.sd }),
    setDistrictFilter: (ch, v) => setFilter(state.view, ch, v),
    districtSpecs,
    districtBoxes: (rowsFn, agencyFn) => districtSpecs(rowsFn, agencyFn).map(filterBoxButton),
    districtsFor: (name, opts) => (districts ? districts.lookup(name, opts) : null),
    rowPassesDistricts,
    ensureDistricts,
    districtsLoaded: () => Boolean(districts),
    districtTags,
    districtNote,
    districtCaveat,
    caveat: districtCaveat(),
    clearDistrictFilter: () => {
      state.ad = "";
      state.sd = "";
      resetPages();
    },
    siteHref,
    siteLink,
  };
}

// ============================================================ WIRING

function openView(view) {
  state.view = view;
  state.entity = "";
  state.fee = "";
  state.fa = "";
  state.sc.agency = "";
  state.figure = "";
  state.doc = "";
  update({ push: true });
  scrollContentTop();
}

function wire() {
  $("loading-retry").addEventListener("click", () => boot());
  $("export-btn").addEventListener("click", toggleDownloadMenu);
  for (const a of document.querySelectorAll(".view-tab")) {
    a.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      if (!model) return;
      openView(a.dataset.view);
    });
  }
  window.addEventListener("popstate", () => {
    closeFilterBox({ focus: false });
    closeDownloadMenu(false);
    readState();
    renderAll();
  });
  initTips();
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !(state.figure || state.doc)) return;
    const t = e.target;
    if (t?.matches?.("input, select, textarea")) return;
    // Leave Escape to the shared theme picker and bug reporter while they are open.
    const shared = document.querySelectorAll(".theme-panel, .bug-report-modal, .bug-report-backdrop, .bug-report-hover");
    if ([...shared].some((n) => n.offsetParent !== null || n.getClientRects().length)) return;
    closePanel();
  });
  // The shared bug reporter picks these up with each report.
  window.AMYC_BUG_REPORT = {
    context: () => ({
      release: cfg.local ? "local" : cfg.ref,
      view: state.view,
      figure: state.figure || null,
      recordId: state.figure ? model?.figureById.get(state.figure)?.primary.record_id || null : null,
      source: state.doc || null,
      evidenceTab: state.figure ? state.tab : null,
    }),
  };
}

readState();
wire();
boot();
