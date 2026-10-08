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
  splitLimitations, EMPTY_FILTERS, NONE, matchesChoice, SORT_COLUMNS, feeKey, fyStartYear, searchTerms,
} from "./lib/model.js";
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
const VIEWS = ["entities", "fees", "sources", "figures", "stats"];
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
    cat: p.get("cat") || "",
    scope: scopeKey(p.get("scope") || ""),
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
  state.fcat = p.get("fcat") || "";
  state.ftype = p.get("ftype") || "";
  state.fcounty = p.get("fcounty") || "";
  state.fentity = p.get("fentity") || "";
  state.fsort = parseSort(p.get("fsort"), DEFAULT_FEE_SORT, FEE_SORTS);
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
    put("q", f.q); put("type", f.type); put("county", f.county); put("cat", f.cat); put("scope", f.scope);
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

function choiceLabel(v, label) {
  return v === NONE ? "not recorded" : label(v);
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
      chip("Type", select("type", choices(model.types, entityTypeLabel), f.type, setF("type"))),
      chip("County", select("county", choices(model.counties, (c) => c), f.county, setF("county"))),
      chip("Category", select("cat", choices(model.categories, humanize), f.cat, setF("cat"))),
      chip("Land use", select("scope", choices(model.scopes, scopeLabel), f.scope, setF("scope"))),
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
      chip("Category", select("fcat", choices(model.categories, humanize), state.fcat, (v) => { state.fcat = v; update(); })),
      chip("Type", select("ftype", choices(model.types, entityTypeLabel), state.ftype, (v) => { state.ftype = v; update(); })),
      chip("County", select("fcounty", choices(model.counties, (c) => c), state.fcounty, (v) => { state.fcounty = v; update(); })),
      el("button", { class: "btn", type: "button", text: "Clear", onclick: () => { state.fq = ""; state.fcat = ""; state.ftype = ""; state.fcounty = ""; state.fentity = ""; toolbarView = ""; update(); } }),
    );
  } else if (key === "sources") {
    bar.append(
      chip("Search", searchInput("sq", state.sq, "agency, title, source id, fiscal year", (v) => { state.sq = v; update(); })),
      el("button", { class: "btn", type: "button", text: "Clear", onclick: () => { state.sq = ""; state.sentity = ""; toolbarView = ""; update(); } }),
    );
  }
}

function syncToolbar() {
  const set = (id, v) => { const n = $(id); if (n && n !== document.activeElement && n.value !== v) n.value = v; };
  const f = state.filters;
  set("q", f.q); set("type", f.type); set("county", f.county); set("cat", f.cat); set("scope", f.scope);
  set("from", f.fyFrom); set("to", f.fyTo); set("arith", f.arith);
  set("eq", state.eq); set("etype", state.etype); set("ecounty", state.ecounty);
  set("sq", state.sq);
  set("fq", state.fq); set("fcat", state.fcat); set("ftype", state.ftype); set("fcounty", state.fcounty);
}

function clearFilters() {
  state.filters = { ...EMPTY_FILTERS };
  state.page = 1;
  toolbarView = "";
  update();
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
    state.fee, state.fq, state.fcat, state.ftype, state.fcounty, state.fentity, state.fsort]);
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
  if (f.entity) tags.push(filterTag(`Jurisdiction: ${f.entity}`, drop("entity")));
  if (f.source) {
    const s = model.sourceById.get(f.source);
    tags.push(filterTag(`Source: ${s ? s.publication_title : f.source}`, drop("source")));
  }
  if (f.q) tags.push(filterTag(`“${f.q}”`, drop("q")));
  if (f.type) tags.push(filterTag(`Type: ${choiceLabel(f.type, entityTypeLabel)}`, drop("type")));
  if (f.county) tags.push(filterTag(`County: ${choiceLabel(f.county, (c) => c)}`, drop("county")));
  if (f.cat) tags.push(filterTag(`Category: ${choiceLabel(f.cat, humanize)}`, drop("cat")));
  if (f.scope) tags.push(filterTag(`Land use: ${choiceLabel(f.scope, scopeLabel)}`, drop("scope")));
  if (f.fyFrom || f.fyTo) tags.push(filterTag(`FY ${fmtFy(f.fyFrom) || "…"} to ${fmtFy(f.fyTo) || "…"}`, () => { state.filters.fyFrom = ""; state.filters.fyTo = ""; update(); }));
  if (f.arith) tags.push(filterTag(`Arithmetic: ${f.arith === "yes" ? "yes" : "no"}`, drop("arith")));
  return tags;
}

function sumNote(summary) {
  return el("span", { class: "sum", title: "Primary rows only" },
    "sum ", el("strong", { text: fmtSum(summary.sum) }));
}

function sortHeader(label, col, sort, onSort, cls = "") {
  const active = sort.col === col;
  const th = el("th", {
    class: `sortable ${cls} ${active ? `sort-${sort.dir}` : ""}`,
    scope: "col",
    "aria-sort": active ? (sort.dir === "asc" ? "ascending" : "descending") : "none",
  }, el("button", { type: "button", class: "th-btn", onclick: () => onSort(col) }, el("span", { class: "col-label", text: label })));
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
      sortHeader("Jurisdiction", "entity", s, onSort, "col-entity"),
      sortHeader("FY", "fy", s, onSort, "col-fy"),
      sortHeader("Fee program", "program", s, onSort, "col-program"),
      sortHeader("Category", "category", s, onSort, "col-cat"),
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
    body.append(el("tr", { class: "empty-row" }, el("td", { colspan: 8, text: "No published figure matches these filters." })));
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
    el("td", { class: "col-cat", text: humanize(fig.category) }),
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
    tbody.append(el("tr", { class: "mx-group" }, el("th", { colspan: years.length + 1, scope: "rowgroup", text: humanize(g.category) || "Category not recorded" })));
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
    if (state.fcat && !matchesChoice(state.fcat, f.category)) return false;
    if (state.ftype && !matchesChoice(state.ftype, p.entity_type)) return false;
    if (state.fcounty && !matchesChoice(state.fcounty, p.county)) return false;
    return terms.every((t) => f.search.includes(t));
  });
  const { col, dir } = state.fsort;
  const d = dir === "asc" ? 1 : -1;
  const key = {
    entity: (f) => f.entity, fee: (f) => f.label, category: (f) => humanize(f.category) || "~",
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
      el("td", { text: humanize(f.category) }),
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
      [humanize(fee.category), `FY ${fyRanges(fee.yearList)}`, `${fmtInt(fee.figures.length)} figures`, `${fmtInt(fee.sources.size)} reports`, `sum ${fmtSum(fee.sum)}`]
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
        statsBlock("Fee category", breakdownTable("Category", figs, (f) => f.category, (v) => humanize(v), (v) => ({ cat: v || NONE })))),
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
      ["Category", humanize(fig.category)],
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
