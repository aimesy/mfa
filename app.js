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

import { parseCsvObjects, toCsv } from "./lib/csv.js";
import {
  buildModel, filterFigures, sortFigures, summarize, entityMatrix, coverageByYear,
  fmtUsd, fmtSum, fmtInt, fmtBytes, fmtFy, fyRanges, humanize, scopeLabel, scopeKey, scopeSymbol, entityTypeLabel,
  basisLabel, grossNetLabel, roleLabel, statusLabel, publicationTypeLabel,
  splitLimitations, EMPTY_FILTERS, NONE, matchesChoice, matchesCategory, splitChoice, SEP, SORT_COLUMNS, feeKey, fyStartYear, searchTerms,
} from "./lib/model.js";
import {
  NAMESPACES, categoryLabel, categoryParam, categoryTree, lawLabel, areaLabel, namespaceLabel, NOT_CLASSIFIED,
} from "./lib/taxonomy.js";
import { readArithmetic } from "./lib/arith.js";
import { PdfViewer } from "./lib/viewer.js";
import { checkOutline, readPageText, setDataFetch } from "./lib/evidence.js";
import { readPageLines, figureColumn, namesFromPage } from "./lib/pagelines.js";
import { el, svg } from "./lib/dom.js";

// ============================================================ CONFIG

const REPO = "aimesy/mfa-data";
const DEFAULT_BRANCH = "main";
// The release Worker (worker/): /<ref>/<path> mirrors the repository's raw
// files, /releases/download/<tag>/<name> its release assets, and /ref answers
// the commit at main.
const DATA_ROOT = "https://mfa-data.amyc.us/";
const VIEWS = ["entities", "fees", "sources", "figures", "coverage", "stats"];
const DEFAULT_VIEW = "entities";
const PAGE_SIZES = [50, 100, 250, 500];
const DEFAULT_SORT = { col: "fy", dir: "desc" };
const DEFAULT_ENTITY_SORT = { col: "sum", dir: "desc" };
const DEFAULT_SOURCE_SORT = { col: "agency", dir: "asc" };
const DEFAULT_FEE_SORT = { col: "entity", dir: "asc" };
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

// Same-page link that keeps the data source (?data= or a pinned ?ref=).
function hrefWith(params) {
  const p = new URLSearchParams();
  if (cfg.local) p.set("data", cfg.param.data);
  else if (cfg.pinned) p.set("ref", cfg.ref);
  for (const [k, v] of Object.entries(params)) if (v && !(k === "view" && v === DEFAULT_VIEW)) p.set(k, v);
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

const state = {
  view: DEFAULT_VIEW,
  filters: { ...EMPTY_FILTERS },
  sort: { ...DEFAULT_SORT },
  page: 1,
  pageSize: 100,
  entity: "",
  eq: "", etype: "", ecounty: "",
  esort: { ...DEFAULT_ENTITY_SORT },
  sq: "", sentity: "",
  ssort: { ...DEFAULT_SOURCE_SORT },
  fee: "",
  fq: "", fcat: "", ftype: "", fcounty: "", fentity: "",
  fsort: { ...DEFAULT_FEE_SORT },
  cyr: "", ccls: "", ctype: "", ccounty: "", cq: "", cstat: "",
  csort: { col: "name", dir: "asc" },
  cpage: 1,
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

function readState() {
  const p = new URLSearchParams(location.search);
  // view=about is the old name of the Stats tab.
  const view = p.get("view") === "about" ? "stats" : p.get("view");
  state.view = VIEWS.includes(view) ? view : DEFAULT_VIEW;
  state.filters = {
    ...EMPTY_FILTERS,
    q: p.get("q") || "",
    type: p.get("type") || "",
    county: p.get("county") || "",
    cat: splitChoice(p.get("cat")).map(categoryParam).join(SEP),
    law: p.get("law") || "",
    area: p.get("area") || "",
    scope: splitChoice(p.get("scope")).map(scopeKey).join(SEP),
    fyFrom: p.get("from") || "",
    fyTo: p.get("to") || "",
    arith: ["yes", "no"].includes(p.get("arith")) ? p.get("arith") : "",
    entity: p.get("entity") || "",
    source: p.get("source") || "",
  };
  state.sort = parseSort(p.get("sort"), DEFAULT_SORT, SORT_COLUMNS);
  state.page = Math.max(1, Number.parseInt(p.get("page"), 10) || 1);
  const size = Number.parseInt(p.get("size"), 10);
  state.pageSize = PAGE_SIZES.includes(size) ? size : 100;
  state.entity = p.get("e") || "";
  state.eq = p.get("eq") || "";
  state.etype = p.get("etype") || "";
  state.ecounty = p.get("ecounty") || "";
  state.esort = parseSort(p.get("esort"), DEFAULT_ENTITY_SORT, ENTITY_SORTS);
  state.sq = p.get("sq") || "";
  state.sentity = p.get("sentity") || "";
  state.ssort = parseSort(p.get("ssort"), DEFAULT_SOURCE_SORT, SOURCE_SORTS);
  state.fee = state.view === "fees" ? p.get("fee") || "" : "";
  state.fq = p.get("fq") || "";
  state.fcat = categoryParam(p.get("fcat") || "");
  state.ftype = p.get("ftype") || "";
  state.fcounty = p.get("fcounty") || "";
  state.fentity = p.get("fentity") || "";
  state.fsort = parseSort(p.get("fsort"), DEFAULT_FEE_SORT, FEE_SORTS);
  state.cyr = p.get("cyr") === "all" || (!p.has("cyr") && storedCoverageYears() === "all") ? "all" : "";
  state.ccls = COVERAGE_CLASSES.includes(p.get("ccls")) ? p.get("ccls") : "";
  state.ctype = p.get("ctype") || "";
  state.ccounty = p.get("ccounty") || "";
  state.cq = p.get("cq") || "";
  state.cstat = COVERAGE_STATUSES.some(([k]) => k && k === p.get("cstat")) ? p.get("cstat") : "";
  state.csort = parseSort(p.get("csort"), DEFAULT_COVERAGE_SORT, COVERAGE_SORTS);
  state.cpage = Math.max(1, Number.parseInt(p.get("cpage"), 10) || 1);
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
  if (state.view === "figures") {
    put("q", f.q); put("type", f.type); put("county", f.county); put("cat", f.cat); put("law", f.law); put("area", f.area); put("scope", f.scope);
    put("from", f.fyFrom); put("to", f.fyTo); put("arith", f.arith); put("entity", f.entity); put("source", f.source);
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
    put("sq", state.sq); put("sentity", state.sentity);
    put("ssort", sortParam(state.ssort, DEFAULT_SOURCE_SORT));
  } else if (state.view === "coverage") {
    put("cyr", state.cyr); put("ccls", state.ccls); put("ctype", state.ctype); put("ccounty", state.ccounty); put("cq", state.cq); put("cstat", state.cstat);
    put("csort", sortParam(state.csort, DEFAULT_COVERAGE_SORT));
    if (state.cpage > 1) p.set("cpage", state.cpage);
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
    $("loading-banner").hidden = true;
    $("workspace").hidden = false;
    renderStats();
    if (new URLSearchParams(location.search).get("view") === "about") writeUrl();
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
  for (const a of document.querySelectorAll(".view-tab")) {
    const active = a.dataset.view === state.view;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    a.href = hrefWith({ view: a.dataset.view });
  }
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
  else if (state.view === "coverage") t = `Coverage · ${base}`;
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

function renderToolbar() {
  const bar = $("toolbar");
  const dossier = (state.view === "entities" && state.entity) || (state.view === "fees" && state.fee);
  const key = dossier ? "dossier" : state.view;
  $("export-btn").hidden = !(state.view === "figures" || (state.view === "entities" && state.entity));
  if (key === toolbarView) {
    syncToolbar();
    return;
  }
  toolbarView = key;
  bar.replaceChildren();
  bar.hidden = key === "stats" || key === "dossier";
  if (key === "figures") {
    const f = state.filters;
    const years = model.years;
    const setF = (k) => (v) => { state.filters[k] = v; state.page = 1; update(); };
    const more = el("span", { class: "filters-more", id: "filters-more" });
    const toggle = el("button", {
      class: "btn filters-toggle", type: "button", "aria-expanded": "false", "aria-controls": "filters-more", text: "Filters",
      onclick: () => {
        const open = bar.classList.toggle("open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      },
    });
    more.append(
      filterBoxButton("cat"),
      filterBoxButton("law"),
      filterBoxButton("area"),
      filterBoxButton("type"),
      filterBoxButton("county"),
      filterBoxButton("scope"),
      chip("FY from", select("from", [["", "Any"], ...years.map((y) => [y, fmtFy(y)])], f.fyFrom, setF("fyFrom"))),
      chip("to", select("to", [["", "Any"], ...years.map((y) => [y, fmtFy(y)])], f.fyTo, setF("fyTo"))),
      chip("Arithmetic", select("arith", [["", "Any"], ["yes", "Yes"], ["no", "No"]], f.arith, setF("arith"))),
    );
    bar.append(
      chip("Search", searchInput("q", f.q, "jurisdiction, fee, label…", setF("q"))),
      toggle,
      more,
      el("button", { class: "btn", type: "button", text: "Clear", onclick: clearFilters }),
      el("span", { class: "sep" }),
      copyButton("Copy link", () => new URL(urlFor(), location.href).href),
    );
  } else if (key === "entities") {
    bar.append(
      chip("Search", searchInput("eq", state.eq, "jurisdiction or county", (v) => { state.eq = v; update(); })),
      chip("Type", select("etype", choices(model.types, entityTypeLabel), state.etype, (v) => { state.etype = v; update(); })),
      chip("County", select("ecounty", choices(model.counties, (c) => c), state.ecounty, (v) => { state.ecounty = v; update(); })),
      el("button", { class: "btn", type: "button", text: "Clear", onclick: () => { state.eq = ""; state.etype = ""; state.ecounty = ""; toolbarView = ""; update(); } }),
    );
  } else if (key === "fees") {
    bar.append(
      chip("Search", searchInput("fq", state.fq, "jurisdiction, fee, fund number", (v) => { state.fq = v; update(); })),
      chip("Category", select("fcat", categoryChoices(), state.fcat, (v) => { state.fcat = v; update(); })),
      chip("Type", select("ftype", choices(model.types, entityTypeLabel), state.ftype, (v) => { state.ftype = v; update(); })),
      chip("County", select("fcounty", choices(model.counties, (c) => c), state.fcounty, (v) => { state.fcounty = v; update(); })),
      el("button", { class: "btn", type: "button", text: "Clear", onclick: () => { state.fq = ""; state.fcat = ""; state.ftype = ""; state.fcounty = ""; state.fentity = ""; toolbarView = ""; update(); } }),
    );
  } else if (key === "sources") {
    bar.append(
      chip("Search", searchInput("sq", state.sq, "agency, title, source id, fiscal year", (v) => { state.sq = v; update(); })),
      el("button", { class: "btn", type: "button", text: "Clear", onclick: () => { state.sq = ""; state.sentity = ""; toolbarView = ""; update(); } }),
    );
  } else if (key === "coverage") {
    const d = coverageData;
    const set = (k, rebuild = false) => (v) => { state[k] = v; state.cpage = 1; if (rebuild) toolbarView = ""; update(); };
    bar.append(
      chip("Class", select("ccls", [["", "All"], ...(d?.classes || []).map((c) => [c.key, c.label])], state.ccls, (v) => { state.ctype = ""; set("ccls", true)(v); })),
      chip("Type", select("ctype", [["", "All"], ...coverageTypes(d)], state.ctype, set("ctype"))),
      chip("County", select("ccounty", [["", "All"], ...coverageCounties(d)], state.ccounty, set("ccounty"))),
      chip("Search", searchInput("cq", state.cq, "jurisdiction or county", set("cq"))),
      chip("Status", select("cstat", COVERAGE_STATUSES, state.cstat, set("cstat"))),
      el("button", { class: "btn", type: "button", text: "Clear", onclick: () => setCoverage({ ccls: "", ctype: "", ccounty: "", cq: "", cstat: "" }, false) }),
      el("span", { class: "sep" }),
      copyButton("Copy link", () => new URL(urlFor(), location.href).href),
      coverageYearsToggle(),
    );
  }
}

function syncToolbar() {
  const set = (id, v) => { const n = $(id); if (n && n !== document.activeElement && n.value !== v) n.value = v; };
  const f = state.filters;
  set("q", f.q);
  for (const b of document.querySelectorAll(".fbox-btn[data-key]")) setFilterBoxText(b);
  set("from", f.fyFrom); set("to", f.fyTo); set("arith", f.arith);
  set("eq", state.eq); set("etype", state.etype); set("ecounty", state.ecounty);
  set("sq", state.sq);
  set("fq", state.fq); set("fcat", state.fcat); set("ftype", state.ftype); set("fcounty", state.fcounty);
  for (const b of document.querySelectorAll(".cov-years-toggle [data-cyr]")) b.setAttribute("aria-pressed", b.dataset.cyr === state.cyr ? "true" : "false");
  set("ccls", state.ccls); set("ctype", state.ctype); set("ccounty", state.ccounty); set("cq", state.cq); set("cstat", state.cstat);
}

function clearFilters() {
  state.filters = { ...EMPTY_FILTERS };
  state.page = 1;
  toolbarView = "";
  update();
}

// ------------------------------------------------------------ FILTER BOXES

// One box per field, patterned on the column filters of aimesy/sfsc and
// tentatives: tick any number of values (any of them matches; different
// boxes must all match), with each value's count among the figures the other
// filters leave. Category is a tree: a namespace ticks everything under it.
const FILTER_BOXES = {
  cat: { label: "Category", value: (f) => f.cat, text: categoryLabel, tree: true },
  law: { label: "Law", value: (f) => f.law, text: lawLabel },
  area: { label: "Area", value: (f) => f.area, text: areaLabel },
  type: { label: "Type", value: (f) => f.primary.entity_type, text: entityTypeLabel },
  county: { label: "County", value: (f) => f.primary.county, text: (c) => c },
  scope: { label: "Land use", value: (f) => scopeKey(f.primary.land_use_scope), text: scopeLabel },
  entity: { label: "Jurisdiction", value: (f) => f.entity, text: (v) => v, many: true },
};

function boxValueText(key, v) {
  if (v === NONE) return key === "cat" || key === "law" || key === "area" ? NOT_CLASSIFIED : "(not recorded)";
  if (key === "cat") return categoryLabel(v.includes("/") ? v : `${v}/`);
  return FILTER_BOXES[key].text(v);
}

function boxSummary(key, raw) {
  const vals = splitChoice(raw);
  return vals.length <= 2 ? vals.map((v) => boxValueText(key, v)).join(" or ") : `${vals.length} values`;
}

function filterBoxButton(key) {
  const b = el("button", {
    type: "button", class: "btn fbox-btn", dataset: { key }, "aria-haspopup": "dialog",
    onclick: (e) => { e.stopPropagation(); openFilterBox(key, e.currentTarget); },
  });
  setFilterBoxText(b);
  return el("span", { class: "chip" }, b);
}

function setFilterBoxText(b) {
  const key = b.dataset.key;
  const raw = state.filters[key];
  b.textContent = `${FILTER_BOXES[key].label}: ${raw ? boxSummary(key, raw) : "All"} ▾`;
  b.classList.toggle("active", Boolean(raw));
}

function categoryChoices() {
  const out = [["", "All"]];
  for (const [ns, label, subs] of NAMESPACES) {
    if (!model.fees.some((f) => (f.cat || "").split("/")[0] === ns)) continue;
    out.push([ns, label]);
    for (const [sub, sl] of subs) if (model.fees.some((f) => f.cat === `${ns}/${sub}`)) out.push([`${ns}/${sub}`, `${label} › ${sl}`]);
  }
  if (model.fees.some((f) => !f.cat)) out.push([NONE, NOT_CLASSIFIED]);
  return out;
}

function boxOptions(key) {
  const box = FILTER_BOXES[key];
  const figs = filterFigures(model.figures, { ...state.filters, [key]: "" });
  const counts = new Map();
  for (const f of figs) {
    const v = box.value(f) || "";
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  if (box.tree) return categoryTree(counts);
  return [...counts].map(([v, count]) => ({ value: v || NONE, label: boxValueText(key, v || NONE), count, children: [] }));
}

let openBox = null;

function closeFilterBox() {
  if (!openBox) return;
  openBox.pop.remove();
  document.removeEventListener("mousedown", openBox.outside, true);
  openBox.anchor.focus?.();
  openBox = null;
}

function openFilterBox(key, anchor) {
  const reopen = openBox?.key === key;
  closeFilterBox();
  if (reopen) return;
  const box = FILTER_BOXES[key];
  const options = boxOptions(key);
  const leaves = options.flatMap((o) => (o.children.length ? o.children : [o]));
  const current = new Set(splitChoice(state.filters[key]));
  // Nothing chosen means everything shown: start with every value ticked,
  // except in a long list (jurisdictions), which starts empty for searching.
  const selected = new Set();
  for (const o of options) {
    for (const leaf of o.children.length ? o.children : [o]) {
      const on = current.has(leaf.value) || current.has(o.value) || (box.tree && current.has(`${o.value}/`));
      if (current.size ? on : !box.many) selected.add(leaf.value);
    }
  }
  let sortMode = box.tree ? "tree" : box.many ? "az" : "count";
  let search = "";

  const list = el("div", { class: "cf-list", role: "group", "aria-label": `${box.label} values` });
  const sortBtn = (mode, text) => el("button", {
    type: "button", class: mode === sortMode ? "active" : "", text,
    onclick: (e) => { sortMode = mode; for (const b of e.currentTarget.parentNode.children) b.classList.toggle("active", b === e.currentTarget); renderList(); },
  });
  const searchBox = el("input", {
    class: "cf-search", type: "search", placeholder: box.many ? "Type to search, then tick…" : "Search values…",
    "aria-label": `Search ${box.label} values`, oninput: (e) => { search = e.target.value.toLowerCase(); renderList(); },
  });
  const apply = el("button", { type: "button", class: "cf-apply", text: "Apply", onclick: () => {
    let vals;
    if (box.tree) {
      vals = [];
      for (const o of options) {
        const kids = o.children.length ? o.children : [o];
        const on = kids.filter((c) => selected.has(c.value));
        if (on.length === kids.length) vals.push(o.value);
        else vals.push(...on.map((c) => c.value));
      }
    } else vals = leaves.filter((o) => selected.has(o.value)).map((o) => o.value);
    const all = !box.many && vals.length === options.length;
    state.filters[key] = all || !vals.length ? "" : vals.join(SEP);
    state.page = 1;
    closeFilterBox();
    update();
  } });
  const pop = el("div", { class: "col-filter-pop open", role: "dialog", "aria-label": `Filter by ${box.label}` },
    el("div", { class: "cf-title", text: `Filter · ${box.label}` }),
    box.tree ? null : el("div", { class: "cf-sort" }, sortBtn("az", "A to Z"), sortBtn("za", "Z to A"), sortBtn("count", "By count")),
    searchBox,
    list,
    el("div", { class: "cf-actions" },
      apply,
      el("button", { type: "button", class: "cf-clear", text: "Clear", onclick: () => { state.filters[key] = ""; state.page = 1; closeFilterBox(); update(); } }),
      el("button", { type: "button", class: "cf-cancel", text: "Cancel", onclick: closeFilterBox })),
  );

  const row = (o, cls, onChange, checked, indeterminate = false) => {
    const cb = el("input", { type: "checkbox", onchange: onChange });
    cb.checked = checked;
    cb.indeterminate = indeterminate;
    return el("label", { class: `cf-row ${cls}` }, cb,
      el("span", { class: "cf-label", title: o.label, text: o.label }),
      el("span", { class: "cf-count", text: fmtInt(o.count) }));
  };

  function visible(o) {
    return !search || o.label.toLowerCase().includes(search) || o.children.some((c) => c.label.toLowerCase().includes(search));
  }

  function renderList() {
    let view = options.filter(visible);
    if (sortMode === "az") view.sort((a, b) => a.label.localeCompare(b.label));
    else if (sortMode === "za") view.sort((a, b) => b.label.localeCompare(a.label));
    else if (sortMode === "count") view.sort((a, b) => b.count - a.count);
    if (box.many && !search) view = view.filter((o) => selected.has(o.value));
    const nodes = [];
    if (box.many && view.length > 200) {
      nodes.push(el("div", { class: "cf-empty", text: `Showing 200 of ${fmtInt(view.length)}; type more to narrow.` }));
      view = view.slice(0, 200);
    }
    const shown = view.flatMap((o) => (o.children.length ? o.children : [o]));
    if (!view.length) {
      nodes.push(el("div", { class: "cf-empty", text: box.many && !search ? "Type a name, then tick." : "No matching values." }));
    } else {
      const allOn = shown.every((o) => selected.has(o.value));
      nodes.push(row({ label: search || box.many ? "(Select all shown)" : "(Select all)", count: shown.reduce((n, o) => n + o.count, 0) }, "cf-all", (e) => {
        for (const o of shown) e.target.checked ? selected.add(o.value) : selected.delete(o.value);
        renderList();
      }, allOn));
      for (const o of view) {
        if (o.children.length) {
          const on = o.children.filter((c) => selected.has(c.value)).length;
          nodes.push(row(o, "cf-ns", (e) => {
            for (const c of o.children) e.target.checked ? selected.add(c.value) : selected.delete(c.value);
            renderList();
          }, on === o.children.length, on > 0 && on < o.children.length));
          for (const c of o.children) {
            nodes.push(row(c, "cf-sub", (e) => { e.target.checked ? selected.add(c.value) : selected.delete(c.value); renderList(); }, selected.has(c.value)));
          }
        } else {
          nodes.push(row(o, box.tree ? "cf-ns" : "", (e) => { e.target.checked ? selected.add(o.value) : selected.delete(o.value); renderList(); }, selected.has(o.value)));
        }
      }
    }
    list.replaceChildren(...nodes);
    apply.disabled = !box.many && selected.size === 0;
  }
  renderList();

  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth || 300;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + window.scrollX - 8))}px`;
  pop.style.top = `${r.bottom + window.scrollY + 4}px`;
  const outside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) closeFilterBox(); };
  document.addEventListener("mousedown", outside, true);
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeFilterBox(); }
    if (e.key === "Enter" && e.target.tagName === "INPUT" && !apply.disabled) apply.click();
  });
  openBox = { key, pop, anchor, outside };
  searchBox.focus();
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
  renderTabs();
  renderToolbar();
  const ck = JSON.stringify([state.view, state.filters, state.sort, state.page, state.pageSize, state.entity,
    state.eq, state.etype, state.ecounty, state.esort, state.sq, state.sentity, state.ssort,
    state.fee, state.fq, state.fcat, state.ftype, state.fcounty, state.fentity, state.fsort,
    state.cyr, state.ccls, state.ctype, state.ccounty, state.cq, state.cstat, state.csort, state.cpage]);
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
  if (state.view === "figures") renderFigures(content);
  else if (state.view === "entities") {
    if (state.entity) renderEntityDossier(content);
    else renderEntities(content);
  } else if (state.view === "fees") {
    if (state.fee) renderFeePage(content);
    else renderFees(content);
  } else if (state.view === "sources") renderSources(content);
  else if (state.view === "coverage") renderCoverage(content);
  else renderStatsView(content);
}

function currentFigures() {
  const key = JSON.stringify([state.filters, state.sort]);
  if (listCache.key !== key) {
    listCache = { key, list: sortFigures(filterFigures(model.figures, state.filters), state.sort) };
  }
  return listCache.list;
}

function filterTag(label, onRemove) {
  return el("span", { class: "filter-tag" }, label,
    el("button", { type: "button", "aria-label": `Remove filter ${label}`, title: "Remove filter", text: "×", onclick: onRemove }));
}

function activeFilterTags() {
  const f = state.filters;
  const tags = [];
  const drop = (k) => () => { state.filters[k] = ""; state.page = 1; update(); };
  if (f.entity) tags.push(filterTag(`Jurisdiction: ${boxSummary("entity", f.entity)}`, drop("entity")));
  if (f.source) {
    const s = model.sourceById.get(f.source);
    tags.push(filterTag(`Source: ${s ? s.publication_title : f.source}`, drop("source")));
  }
  if (f.q) tags.push(filterTag(`“${f.q}”`, drop("q")));
  for (const k of ["cat", "law", "area", "type", "county", "scope"]) {
    if (f[k]) tags.push(filterTag(`${FILTER_BOXES[k].label}: ${boxSummary(k, f[k])}`, drop(k)));
  }
  if (f.fyFrom || f.fyTo) tags.push(filterTag(`FY ${fmtFy(f.fyFrom) || "…"} to ${fmtFy(f.fyTo) || "…"}`, () => { state.filters.fyFrom = ""; state.filters.fyTo = ""; update(); }));
  if (f.arith) tags.push(filterTag(`Arithmetic: ${f.arith === "yes" ? "yes" : "no"}`, drop("arith")));
  return tags;
}

function sumNote(summary) {
  return el("span", { class: "sum", title: "Primary rows only" },
    "sum ", el("strong", { text: fmtSum(summary.sum) }));
}

// filterKey adds the column's filter box (the ▾ beside its name).
function sortHeader(label, col, sort, onSort, cls = "", filterKey = "") {
  const active = sort.col === col;
  const th = el("th", {
    class: `sortable ${cls} ${active ? `sort-${sort.dir}` : ""}`,
    scope: "col",
    "aria-sort": active ? (sort.dir === "asc" ? "ascending" : "descending") : "none",
  }, el("span", { class: "col-head" },
    el("button", { type: "button", class: "th-btn", onclick: () => onSort(col) }, el("span", { class: "col-label", text: label })),
    filterKey ? el("button", {
      type: "button", class: `col-filter-btn${state.filters[filterKey] ? " active" : ""}`, text: "▾",
      title: `Filter by ${FILTER_BOXES[filterKey].label}`, "aria-label": `Filter by ${FILTER_BOXES[filterKey].label}`,
      "aria-haspopup": "dialog",
      onclick: (e) => { e.stopPropagation(); openFilterBox(filterKey, e.currentTarget); },
    }) : null));
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
    el("span", { class: "count" }, el("strong", { text: fmtInt(summary.count) }), ` figure${summary.count === 1 ? "" : "s"} · ${fmtInt(summary.entities)} jurisdiction${summary.entities === 1 ? "" : "s"}`,
      summary.firstYear ? ` · FY ${fmtFy(summary.firstYear)}${summary.lastYear !== summary.firstYear ? ` to ${fmtFy(summary.lastYear)}` : ""}` : ""),
    summary.count ? sumNote(summary) : null,
    el("span", { class: "active-filters" }, activeFilterTags()),
  );

  const onSort = (col) => { state.sort = toggleSort(state.sort, col, NUMERIC_SORTS.has(col)); state.page = 1; update(); };
  const s = state.sort;
  const table = el("table", { class: "grid figures-grid" },
    el("thead", {}, el("tr", {},
      sortHeader("Jurisdiction", "entity", s, onSort, "col-entity", "entity"),
      sortHeader("FY", "fy", s, onSort, "col-fy"),
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
  state.filters = { ...EMPTY_FILTERS, ...filters };
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
    state.sq = "";
    state.sentity = name;
  } else {
    state.view = "figures";
    state.filters = { ...EMPTY_FILTERS, entity: name };
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

function entityTag(name, onRemove) {
  return el("span", { class: "active-filters" }, name ? filterTag(`Jurisdiction: ${name}`, onRemove) : null);
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

function entityRows() {
  const q = state.eq.trim().toLowerCase();
  let list = model.entities.filter((e) => {
    if (state.etype && !matchesChoice(state.etype, e.type)) return false;
    if (state.ecounty && !matchesChoice(state.ecounty, e.county)) return false;
    if (q && !`${e.name}\n${e.county}`.toLowerCase().includes(q)) return false;
    return true;
  });
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
      el("span", {}, el("strong", { text: fmtInt(list.length) }), ` jurisdiction${list.length === 1 ? "" : "s"} · ${fmtInt(figures)} figures`),
      el("span", { class: "sum", title: "Primary rows only" }, "sum ", el("strong", { text: fmtSum(total) }))),
    el("div", { class: "table-scroll" }, el("table", { class: "grid entities-grid" },
      el("thead", {}, el("tr", {},
        sortHeader("Jurisdiction", "name", s, onSort, "col-entity"),
        sortHeader("Type", "type", s, onSort),
        sortHeader("County", "county", s, onSort),
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
    el("div", { class: "dossier-actions" },
      el("a", { class: "btn", href: figuresHref({ entity: e.name, sort: "fy.asc" }), onclick: (ev) => {
        ev.preventDefault();
        state.view = "figures";
        state.filters = { ...EMPTY_FILTERS, entity: e.name };
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

  content.append(
    head,
    el("div", { class: "table-scroll" }, el("table", { class: "grid matrix" }, thead, tbody, tfoot)),
    el("h3", { class: "section-label", text: `Reports (${sources.length})` }),
    sourcesTable(sources, { compact: true }),
  );
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

function feeRows() {
  const terms = searchTerms(state.fq);
  let list = model.fees.filter((f) => {
    const p = f.figures[f.figures.length - 1].primary;
    if (state.fentity && f.entity !== state.fentity) return false;
    if (state.fcat && !matchesCategory(state.fcat, f.cat)) return false;
    if (state.ftype && !matchesChoice(state.ftype, p.entity_type)) return false;
    if (state.fcounty && !matchesChoice(state.fcounty, p.county)) return false;
    return terms.every((t) => f.search.includes(t));
  });
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
      el("span", {}, el("strong", { text: fmtInt(list.length) }), ` fee${list.length === 1 ? "" : "s"} · ${fmtInt(entities)} jurisdiction${entities === 1 ? "" : "s"}`),
      el("span", { class: "sum", title: "Primary rows only" }, "sum ", el("strong", { text: fmtSum(total) })),
      entityTag(state.fentity, () => { state.fentity = ""; update(); })),
    el("div", { class: "table-scroll" }, el("table", { class: "grid fees-grid" },
      el("thead", {}, el("tr", {},
        sortHeader("Jurisdiction", "entity", s, onSort, "col-entity"),
        sortHeader("Fee", "fee", s, onSort, "col-fee"),
        sortHeader("Category", "category", s, onSort),
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

function sourceRows() {
  const q = state.sq.trim().toLowerCase();
  let list = model.sources.filter((s) => (!state.sentity || s.receiving_entity === state.sentity) && (!q || s._search.includes(q)));
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
  const th = (label, col, cls = "") => (sortable ? sortHeader(label, col, s, onSort, cls) : el("th", { scope: "col", class: cls }, el("span", { class: "col-label", text: label })));
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
      compact ? null : th("Agency", "agency", "col-entity"),
      th("Publication", "title", "col-title"),
      th("Type", "type", "col-type"),
      th("Covers", "fy", "col-fy"),
      th("Pages", "pages", "num"),
      th("Size", "bytes", "num"),
      th("Figures", "figures", "num"),
      el("th", { scope: "col", class: "col-evidence" }, el("span", { class: "col-label", text: "Report" })))),
    body));
}

function showSourceFigures(sourceId) {
  state.view = "figures";
  state.filters = { ...EMPTY_FILTERS, source: sourceId };
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
      el("span", {}, el("strong", { text: fmtInt(list.length) }), ` publication${list.length === 1 ? "" : "s"} · ${fmtInt(pages)} pages`),
      entityTag(state.sentity, () => { state.sentity = ""; update(); })),
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

function coverageTypes(d) {
  if (!d) return [];
  const types = new Set(d.agencies.filter((a) => !state.ccls || a.cls === state.ccls).map((a) => a.type));
  return [...types].map((t) => [t || NONE, t ? humanize(t) : "(not recorded)"]).sort((a, b) => a[1].localeCompare(b[1]));
}

function coverageCounties(d) {
  if (!d) return [];
  return [...new Set(d.agencies.map((a) => a.county))].sort().map((c) => [c || NONE, c || "(not recorded)"]);
}

const choiceIs = (wanted, v) => !wanted || (wanted === NONE ? !v : v === wanted);

// The roster under the class, type and county filters, which every table uses.
function coverageScope(d) {
  return d.agencies.filter((a) => (!state.ccls || a.cls === state.ccls) && choiceIs(state.ctype, a.type) && choiceIs(state.ccounty, a.county));
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
// a link that narrows the tab to it.
function coverageGroups(list, key, label, param, byName = false) {
  const groups = new Map();
  for (const a of list) {
    const k = key(a) || "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  return [...groups.entries()]
    .sort((x, y) => (byName ? 0 : y[1].length - x[1].length) || label(x[0]).localeCompare(label(y[0])))
    .map(([k, items]) => ({ label: coverageLink(label(k), { [param]: k || NONE }), list: items }));
}

function setCoverage(params, push = true) {
  Object.assign(state, params, { cpage: 1 });
  toolbarView = "";
  update({ push });
  scrollContentTop();
}

function coverageLink(text, params) {
  return el("a", {
    href: hrefWith({ view: "coverage", cyr: state.cyr, ccls: state.ccls, ctype: state.ctype, ccounty: state.ccounty, ...params }), text,
    onclick: (ev) => { ev.preventDefault(); setCoverage(params); },
  });
}

function coverageStatus(a, m) {
  const h = a.h & m;
  const p = a.p & m;
  if (state.cstat === "none") return !h && !a.nofee;
  if (state.cstat === "gaps") return h !== m && !a.nofee;
  if (state.cstat === "waiting") return (h & ~p) !== 0;
  if (state.cstat === "done") return p === m;
  if (state.cstat === "nofee") return a.nofee;
  return true;
}

function coverageRows(scope, m) {
  const terms = searchTerms(state.cq);
  const list = scope.filter((a) => coverageStatus(a, m) &&
    terms.every((t) => `${a.name} ${a.county} ${a.names.join(" ")}`.toLowerCase().includes(t)));
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

function coverageList(d, scope, m) {
  const list = coverageRows(scope, m);
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
      el("span", {}, el("strong", { text: fmtInt(list.length) }), ` jurisdiction${list.length === 1 ? "" : "s"}`),
      el("span", { class: "cov-legend" }, swatch("p", "Processed"), swatch("h", "Harvested, not yet processed"), swatch("n", "Charges no such fees"), swatch("m", "Not harvested"))),
    el("div", { class: "table-scroll" }, el("table", { class: "grid cov-list" },
      el("thead", {}, el("tr", {},
        sortHeader("Jurisdiction", "name", s, onSort, "col-entity"),
        sortHeader("Type", "type", s, onSort),
        sortHeader("County", "county", s, onSort),
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
  const classes = d.classes.filter((c) => !state.ccls || c.key === state.ccls);
  const byClass = classes.map((c) => ({ label: coverageLink(c.label, { ccls: c.key }), list: scope.filter((a) => a.cls === c.key) }));
  if (byClass.length > 1) byClass.push({ label: "All", list: scope, cls: "cov-total" });
  const leftOut = classes.filter((c) => c.left_out.length)
    .map((c) => `${c.label}: ${c.left_out.map((x) => `${fmtInt(x.count)} ${x.label.toLowerCase()}`).join(", ")}`);
  const asOf = new Date(d.inventory_utc);
  const when = Number.isNaN(asOf.getTime()) ? d.inventory_utc
    : `${asOf.toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" })} PT`;
  const narrowed = [state.ccls && classes[0]?.label, state.ctype && (state.ctype === NONE ? "type not recorded" : humanize(state.ctype)),
    state.ccounty && (state.ccounty === NONE ? "county not recorded" : `${state.ccounty} County`)].filter(Boolean);
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
      t.nfH ? ` ${fmtInt(t.nfH)} of the ${fmtInt(t.n)} jurisdictions counted charge no such fees.` : ""),
    el("div", { class: "tiles" },
      coverageTile("Jurisdictions harvested", t.anyH, t.nfH, t.n, ", any year"),
      coverageTile("Jurisdictions processed", t.anyP, t.nfP, t.n, ", any year"),
      coverageTile("Jurisdiction-years harvested", t.yH, t.ynfH, t.years),
      coverageTile("Jurisdiction-years processed", t.yP, t.ynfP, t.years)),
    statsBlock("By class", coverageTable("Class", byClass, m)),
    statsBlock("By fiscal year", coverageYearTable(d, scope, m)),
    statsBlock("By agency type", coverageTable("Type", coverageGroups(scope, (a) => a.type, (k) => (k ? humanize(k) : "(not recorded)"), "ctype"), m)),
    el("details", { class: "cov-more", open: Boolean(state.ccounty) },
      el("summary", { class: "section-label", text: "By county" }),
      el("div", { class: "table-scroll" }, coverageTable("County", coverageGroups(scope, (a) => a.county, (k) => k || "(not recorded)", "ccounty", true), m))),
    ...coverageList(d, scope, m),
  );
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

// ============================================================ EXPORT

function exportCsv() {
  let figs = [];
  let name = "mfa-figures";
  if (state.view === "figures") figs = currentFigures();
  else if (state.view === "entities" && state.entity) {
    const e = model.entityByName.get(state.entity);
    figs = e ? entityFigureOrder(e) : [];
    name = `mfa-${state.entity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  }
  const rows = figs.map((f) => f.primary);
  const blob = new Blob([toCsv(columns, rows)], { type: "text/csv;charset=utf-8" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `${name}-${rows.length}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ============================================================ WIRING

function wire() {
  $("loading-retry").addEventListener("click", () => boot());
  $("export-btn").addEventListener("click", exportCsv);
  for (const a of document.querySelectorAll(".view-tab")) {
    a.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      if (!model) return;
      state.view = a.dataset.view;
      state.entity = "";
      state.fee = "";
      state.figure = "";
      state.doc = "";
      update({ push: true });
      scrollContentTop();
    });
  }
  window.addEventListener("popstate", () => {
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
