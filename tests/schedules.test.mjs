// node tests/schedules.test.mjs
// Checks for the fee schedule reader (lib/schedules.js) and the Schedules tab
// (lib/schedules-view.js), on synthetic rows and a small stand-in for the DOM.
// When MFA_SCHEDULES_CSV names a fee-schedules.csv, or an mfa-data checkout
// (MFA_DATA_ROOT, or ../mfa-data beside this repository) carries
// data/fee-schedules.csv, it also reads that file against the contract; when
// MFA_SCHEDULES_CONTRACT names schedules-contract.json, it checks the code
// lists here against the contract's.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toCsv } from "../lib/csv.js";
import { entityTypeLabel, fmtInt } from "../lib/model.js";
import { categoryLabel, categoryParam, NOT_CLASSIFIED } from "../lib/taxonomy.js";
import {
  SCHEDULES_PATH, SCHEDULE_COLUMNS, FEE_TYPES, PURPOSES, BASES, RATE_STATUSES, LAND_USES, REVIEW_STATUSES,
  NO_BASIS, PURPOSE_CATEGORY, rowProblems, parseSchedules, rateValue, buildSchedules, groupByPurpose,
  filterSchedules, facetCounts, sortSchedules, evidenceFor, conditionParts, footnoteParts, scheduleStats,
  basisLabel, feeTypeLabel, landUseLabel,
} from "../lib/schedules.js";

// ------------------------------------------------------------ a stand-in DOM

const created = [];
let root = null;
let focused = null;

class FakeNode {
  constructor() { this.parentNode = null; this.childNodes = []; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === root;
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v != null && v !== "") this.adopt(new FakeText(String(v)));
  }
  adopt(c) {
    if (c.parentNode) c.parentNode.childNodes.splice(c.parentNode.childNodes.indexOf(c), 1);
    c.parentNode = this;
    this.childNodes.push(c);
  }
  append(...xs) { for (const x of xs) this.adopt(x instanceof FakeNode ? x : new FakeText(String(x))); }
  replaceChildren(...xs) { this.textContent = ""; this.append(...xs); }
}

class FakeText extends FakeNode {
  constructor(s) { super(); this.data = s; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.value = "";
    created.push(this);
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  get id() { return this.getAttribute("id") || ""; }
  get classes() { return (this.getAttribute("class") || "").split(/\s+/).filter(Boolean); }
  get children() { return this.childNodes.filter((c) => c instanceof FakeElement); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) {
    const ev = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  focus() { focused = this; }
  setSelectionRange() {}
  scrollTo() { this.scrolled = (this.scrolled || 0) + 1; }
  set innerHTML(v) { throw new Error("innerHTML was set"); }
  set outerHTML(v) { throw new Error("outerHTML was set"); }
  insertAdjacentHTML() { throw new Error("insertAdjacentHTML was called"); }
}

function walk(node, out = []) {
  for (const c of node.childNodes) {
    if (c instanceof FakeElement) {
      out.push(c);
      walk(c, out);
    }
  }
  return out;
}
const find = (node, pred) => walk(node).filter(pred);
const byClass = (node, cls) => find(node, (e) => e.classes.includes(cls));
const byTag = (node, tag) => find(node, (e) => e.tagName === tag.toUpperCase());
const byId = (node, id) => find(node, (e) => e.id === id)[0] || null;
const texts = (nodes) => nodes.map((n) => n.textContent);

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  getElementById: (id) => (root ? byId(root, id) : null),
};

const settle = () => new Promise((r) => setTimeout(r, 0));

// The view module reads document and Node when it renders, so it is loaded
// after the stand-in is in place.
const { renderSchedules, resetSchedules, NOT_PUBLISHED, SELECTION_KEYS } = await import("../lib/schedules-view.js");

// ------------------------------------------------------------ fixtures

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function row(over = {}) {
  const base = Object.fromEntries(SCHEDULE_COLUMNS.map((c) => [c, ""]));
  return {
    ...base,
    schedule_row_id: "alpha-p3-001",
    agency: "City of Alpha",
    agency_as_printed: "CITY OF ALPHA",
    entity_type: "city",
    county: "Example",
    fee_program: "Park Facilities Fee",
    normalized_fee_type: "development_impact_fee",
    purpose_category: "parks",
    basis: "per_dwelling_unit",
    unit_as_printed: "per unit",
    rate: "1200.50",
    rate_as_printed: "$1,200.50",
    land_use_class: "residential_single_family",
    land_use_as_printed: "Single Family Detached",
    rate_status: "adopted",
    effective_date: "2030-07-01",
    date_as_printed: "Effective July 1, 2030",
    statutory_authority: "Government Code 66000 et seq.",
    authority_page: "2",
    table_as_printed: "Table 1 Fee Schedule",
    source_id: "alpha-fee-schedule",
    source_sha256: SHA_A,
    official_source_url: "https://example.org/alpha/fees.pdf",
    physical_pdf_page: "3",
    printed_page: "Page 3",
    row_as_printed: "Single Family Detached $1,200.50 per unit",
    review_status: "unreviewed",
    ...over,
  };
}

const ROWS = [
  row(),
  row({
    schedule_row_id: "alpha-p3-002", fee_program: "Storm Drain Fee", purpose_category: "drainage", basis: "per_acre",
    unit_as_printed: "per net acre", rate: "", rate_as_printed: "N/A", land_use_class: "industrial",
    land_use_as_printed: "Industrial", row_as_printed: "Industrial N/A", applicability_conditions: "Zone 1; Outside the plan area",
    footnote_as_printed: "First note | Second note", table_as_printed: "Table 2",
  }),
  row({
    schedule_row_id: "alpha-p4-001", fee_program: "Traffic Fee", purpose_category: "transportation", basis: "",
    unit_as_printed: "", rate: "300", rate_as_printed: "$300", land_use_class: "", land_use_as_printed: "Other",
    row_as_printed: "Other $300", physical_pdf_page: "4", effective_date: "", date_as_printed: "",
  }),
  row({
    schedule_row_id: "beta-p5-001", agency: "Beta Water District", agency_as_printed: "Beta Water District",
    entity_type: "special_district", county: "", fee_program: "Capacity Charge", normalized_fee_type: "capacity_charge",
    purpose_category: "water", basis: "per_meter_size", unit_as_printed: "per meter", rate: "0", rate_as_printed: "$0",
    land_use_class: "", land_use_as_printed: "", applicability_conditions: "3/4 inch meter", row_as_printed: "3/4\" $0",
    effective_date: "2029-01-01", date_as_printed: "January 1, 2029", source_id: "", source_sha256: SHA_B,
    official_source_url: "https://example.org/beta/report.pdf", physical_pdf_page: "5", printed_page: "",
    fund: "Fund 100", statutory_authority: "Section 66013", authority_page: "1",
  }),
  row({
    schedule_row_id: "gamma-p1-001", agency: "<img src=x onerror=alert(1)>", entity_type: "school_district",
    fee_program: "<b>School Fee</b>", normalized_fee_type: "school_facilities_fee", purpose_category: "schools",
    basis: "per_square_foot", rate: "5.17", rate_as_printed: "$5.17", row_as_printed: "<script>x</script> $5.17",
    source_id: "", source_sha256: "c".repeat(64), official_source_url: "", physical_pdf_page: "1",
    statutory_authority: "", authority_page: "",
  }),
];

const csvOf = (rows, columns = SCHEDULE_COLUMNS) => toCsv(columns, rows);

// ------------------------------------------------------------ the contract

{
  assert.equal(SCHEDULES_PATH, "data/fee-schedules.csv");
  assert.equal(new Set(SCHEDULE_COLUMNS).size, SCHEDULE_COLUMNS.length);
  for (const r of ROWS) assert.deepEqual(rowProblems(r), [], r.schedule_row_id);

  const problems = (over) => rowProblems(row(over));
  assert.deepEqual(problems({ agency: " " }), ["agency is empty"]);
  assert.deepEqual(problems({ rate: "1300.50" }), ["rate does not match rate_as_printed"]);
  assert.deepEqual(problems({ rate: "1,200.50" }), ["rate is not a decimal amount"]);
  assert.deepEqual(problems({ rate: "", rate_as_printed: "" }), ["rate_as_printed is empty"]);
  assert.deepEqual(problems({ row_as_printed: "Single Family Detached per unit" }), ["rate_as_printed is not inside row_as_printed"]);
  // Spacing inside the printed row does not matter; the characters do.
  assert.deepEqual(problems({ row_as_printed: "Single Family Detached $ 1,200.50 per unit" }), []);
  assert.deepEqual(problems({ basis: "" }), []);
  assert.deepEqual(problems({ land_use_class: "" }), []);
  assert.deepEqual(problems({ basis: "per_unicorn" }), ['basis "per_unicorn" is not a known code']);
  assert.deepEqual(problems({ normalized_fee_type: "tax" }), ['normalized_fee_type "tax" is not a known code']);
  assert.deepEqual(problems({ purpose_category: "" }), ["purpose_category is empty"]);
  assert.deepEqual(problems({ entity_type: "City" }), ["entity_type is not a code"]);
  assert.deepEqual(problems({ effective_date: "2030-13-01" }), ["effective_date is not a date"]);
  assert.deepEqual(problems({ end_date: "July 2031" }), ["end_date is not a date"]);
  assert.deepEqual(problems({ date_as_printed: "" }), ["effective_date has no date_as_printed"]);
  assert.deepEqual(problems({ physical_pdf_page: "0" }), ["physical_pdf_page is not a page number"]);
  assert.deepEqual(problems({ authority_page: "" }), ["statutory_authority has no authority_page"]);
  assert.deepEqual(problems({ source_sha256: SHA_A.toUpperCase() }), ["source_sha256 is not a SHA-256 hash"]);
  assert.deepEqual(problems({ official_source_url: "javascript:alert(1)" }), ["official_source_url is not a web address"]);
  assert.deepEqual(problems({ source_id: "../alpha" }), ["source_id is not an identifier"]);
  assert.deepEqual(problems({ review_status: "approved" }), ['review_status "approved" is not a known code']);
}

// Parsing: missing columns stop the file; bad and repeated rows are set aside.
{
  const short = SCHEDULE_COLUMNS.filter((c) => c !== "review_status" && c !== "fund");
  assert.throws(() => parseSchedules(csvOf(ROWS, short)), /missing columns: fund, review_status/);

  const extra = [...SCHEDULE_COLUMNS, "reviewer_note"];
  assert.equal(parseSchedules(csvOf(ROWS.map((r) => ({ ...r, reviewer_note: "x" })), extra)).rows.length, ROWS.length);

  const bad = [...ROWS, { ...ROWS[0] }, row({ schedule_row_id: "alpha-p9-001", rate: "12" })];
  const { rows, rejected } = parseSchedules(csvOf(bad));
  assert.equal(rows.length, ROWS.length);
  assert.deepEqual(rejected, [
    { id: "alpha-p3-001", problems: ["schedule_row_id repeats an earlier row"] },
    { id: "alpha-p9-001", problems: ["rate does not match rate_as_printed"] },
  ]);
  // A quoted comma, quote and line break inside a printed cell survive the round trip.
  const odd = row({ row_as_printed: 'Single Family, "detached"\n$1,200.50' });
  assert.equal(parseSchedules(csvOf([odd])).rows[0].row_as_printed, odd.row_as_printed);
}

// A missing amount is null, never zero; a printed zero is zero.
{
  assert.equal(rateValue(ROWS[0]), 1200.5);
  assert.equal(rateValue(ROWS[1]), null);
  assert.equal(rateValue(ROWS[3]), 0);
  assert.equal(rateValue(row({ rate: "abc" })), null);
  assert.deepEqual(scheduleStats(ROWS), { rows: 5, agencies: 3, documents: 3, priced: 4, unpriced: 1 });
}

// Grouping: agencies by name, purposes in PURPOSES order, programs split by table.
{
  const built = buildSchedules(ROWS);
  assert.deepEqual(built.agencies.map((a) => a.name), ["<img src=x onerror=alert(1)>", "Beta Water District", "City of Alpha"]);
  const alpha = built.byName.get("City of Alpha");
  assert.equal(alpha.rows.length, 3);
  assert.equal(alpha.sources.size, 1);
  assert.deepEqual(alpha.purposes.map((g) => g.purpose), ["parks", "transportation", "drainage"]);
  assert.deepEqual(alpha.purposes.map((g) => g.label), ["Parks", "Transportation", "Drainage"]);

  const split = groupByPurpose([
    row({ schedule_row_id: "1", table_as_printed: "Table 1" }),
    row({ schedule_row_id: "2", table_as_printed: "Table 2" }),
    row({ schedule_row_id: "3", table_as_printed: "Table 1" }),
    row({ schedule_row_id: "4", purpose_category: "fire", fee_program: "Fire Fee" }),
  ]);
  assert.deepEqual(split.map((g) => g.purpose), ["parks", "fire"]);
  assert.deepEqual(split[0].programs.map((p) => [p.table, p.rows.map((r) => r.schedule_row_id)]), [["Table 1", ["1", "3"]], ["Table 2", ["2"]]]);
  assert.equal(split[1].programs[0].feeType, "development_impact_fee");
}

// Statewide filters, facets and sorting.
{
  const ids = (rows) => rows.map((r) => r.schedule_row_id);
  assert.deepEqual(ids(filterSchedules(ROWS, {})), ids(ROWS));
  assert.deepEqual(ids(filterSchedules(ROWS, { type: "capacity_charge" })), ["beta-p5-001"]);
  assert.deepEqual(ids(filterSchedules(ROWS, { basis: "per_acre" })), ["alpha-p3-002"]);
  assert.deepEqual(ids(filterSchedules(ROWS, { basis: NO_BASIS })), ["alpha-p4-001"]);
  assert.deepEqual(ids(filterSchedules(ROWS, { purpose: "schools" })), ["gamma-p1-001"]);
  assert.deepEqual(ids(filterSchedules(ROWS, { status: "proposed" })), []);
  assert.deepEqual(ids(filterSchedules(ROWS, { q: "alpha zone" })), ["alpha-p3-002"]);
  assert.deepEqual(ids(filterSchedules(ROWS, { q: "single family" })), ["alpha-p3-001", "gamma-p1-001"]);
  assert.deepEqual(ids(filterSchedules(ROWS, { q: "meter" })), ["beta-p5-001"]);

  assert.deepEqual(facetCounts(ROWS, "basis", BASES), [
    { value: "per_dwelling_unit", label: "Per dwelling unit", count: 1 },
    { value: "per_square_foot", label: "Per square foot", count: 1 },
    { value: "per_meter_size", label: "By meter size", count: 1 },
    { value: "per_acre", label: "Per acre", count: 1 },
    { value: "", label: "", count: 1 },
  ]);
  assert.deepEqual(facetCounts(ROWS, "normalized_fee_type", FEE_TYPES).map((f) => f.value),
    ["development_impact_fee", "capacity_charge", "school_facilities_fee"]);

  const rates = (rows) => rows.map((r) => r.rate_as_printed);
  assert.deepEqual(rates(sortSchedules(ROWS, { col: "rate", dir: "asc" })), ["$0", "$5.17", "$300", "$1,200.50", "N/A"]);
  assert.deepEqual(rates(sortSchedules(ROWS, { col: "rate", dir: "desc" })), ["$1,200.50", "$300", "$5.17", "$0", "N/A"]);
  assert.deepEqual(ids(sortSchedules(ROWS, { col: "date", dir: "desc" })),
    ["alpha-p3-001", "alpha-p3-002", "gamma-p1-001", "beta-p5-001", "alpha-p4-001"]);
  assert.deepEqual(ids(sortSchedules(ROWS, { col: "agency", dir: "asc" })),
    ["gamma-p1-001", "beta-p5-001", "alpha-p3-001", "alpha-p3-002", "alpha-p4-001"]);
  assert.deepEqual(ids(sortSchedules(ROWS, { col: "nonsense" })), ids(sortSchedules(ROWS, { col: "agency", dir: "asc" })));
  const before = ids(ROWS);
  sortSchedules(ROWS, { col: "rate", dir: "desc" });
  assert.deepEqual(ids(ROWS), before, "sorting copies");
}

// Evidence, joined fields and labels.
{
  const has = (id) => id === "alpha-fee-schedule";
  assert.deepEqual(evidenceFor(ROWS[0], has), { sourceId: "alpha-fee-schedule", page: 3, url: "https://example.org/alpha/fees.pdf" });
  assert.deepEqual(evidenceFor(ROWS[0], () => false), { sourceId: "", page: 3, url: "https://example.org/alpha/fees.pdf" });
  assert.deepEqual(evidenceFor(ROWS[3], has), { sourceId: "", page: 5, url: "https://example.org/beta/report.pdf" });
  assert.deepEqual(evidenceFor(row({ physical_pdf_page: "" }), has).page, null);

  assert.deepEqual(conditionParts("Zone 1; Outside the plan area"), ["Zone 1", "Outside the plan area"]);
  assert.deepEqual(conditionParts(""), []);
  assert.deepEqual(footnoteParts("First note | Second note"), ["First note", "Second note"]);

  assert.equal(basisLabel(""), "Basis not printed");
  assert.equal(basisLabel("per_edu"), "Per equivalent unit (EDU, ERU)");
  assert.equal(basisLabel("per_unicorn"), "per_unicorn");
  assert.equal(feeTypeLabel("capacity_charge"), "Capacity charge");
  assert.equal(landUseLabel("residential_adu"), "ADU");
}

// Every purpose lands on a category the Figures filter knows.
{
  assert.deepEqual(Object.keys(PURPOSE_CATEGORY).sort(), PURPOSES.map(([k]) => k).sort());
  for (const [purpose, cat] of Object.entries(PURPOSE_CATEGORY)) {
    assert.notEqual(categoryLabel(cat), NOT_CLASSIFIED, purpose);
    assert.equal(categoryParam(cat), cat, purpose);
  }
  for (const list of [FEE_TYPES, PURPOSES, BASES, RATE_STATUSES, LAND_USES, REVIEW_STATUSES]) {
    assert.equal(new Set(list.map(([k]) => k)).size, list.length);
  }
}

// ------------------------------------------------------------ the tab

function mount(fetchText, over = {}) {
  resetSchedules();
  root = new FakeElement("main");
  const content = new FakeElement("div");
  root.append(content);
  const calls = { rerender: 0, opened: [], selected: [] };
  const ctx = {
    fetchText,
    isCurrent: () => true,
    rerender: () => {
      calls.rerender += 1;
      content.replaceChildren();
      renderSchedules(content, ctx);
    },
    openDoc: (id, page) => calls.opened.push([id, page]),
    officialUrl: (raw, page) => (/^https?:\/\//.test(raw || "") ? `${raw}#page=${page}` : null),
    sourceById: new Map([["alpha-fee-schedule", {}]]),
    agencyHref: (name) => `?view=schedules&agency=${encodeURIComponent(name)}`,
    ...over,
  };
  return { content, ctx, calls };
}

const fetchOk = (text) => async (p) => {
  assert.equal(p, SCHEDULES_PATH);
  return text;
};

// Before the release carries the file, the tab says so and shows nothing else.
{
  const { content, ctx, calls } = mount(async (p) => { throw new Error(`HTTP 404 reading ${p}`); });
  renderSchedules(content, ctx);
  assert.equal(content.textContent, "Loading fee schedules…");
  await settle();
  assert.equal(calls.rerender, 1);
  assert.deepEqual(texts(byClass(content, "schedules-absent")), [NOT_PUBLISHED]);
  assert.equal(content.textContent, NOT_PUBLISHED);
  assert.equal(byTag(content, "table").length, 0);
  // A later visit reuses the answer instead of asking again.
  content.replaceChildren();
  renderSchedules(content, ctx);
  assert.equal(content.textContent, NOT_PUBLISHED);
}

// Any other failure is shown as one, and the next visit asks again.
{
  let asked = 0;
  const { content, ctx, calls } = mount(async (p) => {
    asked += 1;
    throw new Error(`HTTP 500 reading ${p}`);
  });
  renderSchedules(content, ctx);
  await settle();
  assert.equal(calls.rerender, 0);
  assert.equal(content.textContent, "Failed to load fee schedules: HTTP 500 reading data/fee-schedules.csv");
  content.replaceChildren();
  renderSchedules(content, ctx);
  await settle();
  assert.equal(asked, 2);
}

// A file whose columns do not match is a failure, not an empty schedule.
{
  const { content, ctx } = mount(fetchOk("agency,rate\nX,1\n"));
  renderSchedules(content, ctx);
  await settle();
  assert.match(content.textContent, /^Failed to load fee schedules: fee-schedules\.csv is missing columns: schedule_row_id/);
}

// Statewide view.
{
  const bad = row({ schedule_row_id: "alpha-p9-001", rate: "12" });
  const { content, ctx, calls } = mount(fetchOk(csvOf([...ROWS, bad])));
  renderSchedules(content, ctx);
  await settle();

  assert.deepEqual(texts(byClass(content, "tile-value")), [fmtInt(3), fmtInt(3), fmtInt(4), fmtInt(1)]);
  assert.match(byClass(content, "schedules-rejected")[0].textContent, /^1 row set aside: they fail the schedule contract/);
  assert.match(byClass(content, "schedules-rejected")[0].textContent, /alpha-p9-001 rate does not match rate_as_printed/);
  assert.equal(byClass(content, "result-bar")[0].textContent, "5 rows · 3 agencies");

  const body = byTag(content, "tbody")[0];
  assert.equal(body.children.length, 5);
  const firstCells = body.children.map((tr) => tr.children[0].textContent);
  assert.deepEqual(firstCells, ["<img src=x onerror=alert(1)>", "Beta Water District", "City of Alpha", "City of Alpha", "City of Alpha"]);

  // Text from the file stays text: no element is ever built from it.
  assert.equal(created.filter((e) => ["IMG", "B", "SCRIPT"].includes(e.tagName)).length, 0);

  // The unpriced cell shows what is printed and is marked as having no amount.
  const unpriced = byClass(content, "sched-unpriced");
  assert.deepEqual(texts(unpriced), ["N/A"]);
  assert.equal(unpriced[0].getAttribute("title"), "No amount printed in this cell");
  assert.equal(texts(body.children[1].children.slice(4, 5))[0], "$0");

  // Evidence: the release's copy when it holds the document, else the agency's file at that page.
  const alphaTr = body.children[2];
  const btn = byTag(alphaTr, "button").find((b) => b.classes.includes("pdf-btn"));
  assert.equal(btn.textContent, "p.3");
  btn.fire("click");
  assert.deepEqual(calls.opened, [["alpha-fee-schedule", 3]]);
  const ext = byClass(alphaTr, "ext")[0];
  assert.equal(ext.getAttribute("href"), "https://example.org/alpha/fees.pdf#page=3");
  assert.equal(ext.textContent, "↗");
  const betaTr = body.children[1];
  assert.equal(byTag(betaTr, "button").filter((b) => b.classes.includes("pdf-btn")).length, 0);
  const betaExt = byClass(betaTr, "ext")[0];
  assert.equal(betaExt.getAttribute("href"), "https://example.org/beta/report.pdf#page=5");
  assert.equal(betaExt.getAttribute("rel"), "noopener");
  assert.equal(betaExt.textContent, "p.5 ↗");
  assert.equal(byClass(body.children[0], "pdf-btn").length, 0, "no link when there is neither copy nor address");

  // The printed text behind a row.
  const printed = byClass(body.children[3], "sched-printed")[0];
  assert.deepEqual(texts(byTag(printed, "dt")), ["Row", "Table", "Footnote", "Footnote", "Date", "Statute", "Printed page"]);
  assert.deepEqual(texts(byTag(printed, "dd")).slice(2, 4), ["First note", "Second note"]);
  assert.equal(texts(byTag(printed, "dd"))[5], "Government Code 66000 et seq. (p.2)");

  // Filters offer only the values present, with counts, and "Basis not printed" for empty bases.
  const basis = byId(content, "sched-basis");
  assert.deepEqual(byTag(basis, "option").map((o) => [o.getAttribute("value"), o.textContent]), [
    ["", "All"], ["per_dwelling_unit", "Per dwelling unit (1)"], ["per_square_foot", "Per square foot (1)"],
    ["per_meter_size", "By meter size (1)"], ["per_acre", "Per acre (1)"], [NO_BASIS, "Basis not printed (1)"],
  ]);
  assert.deepEqual(byTag(byId(content, "sched-type"), "option").map((o) => o.getAttribute("value")),
    ["", "development_impact_fee", "capacity_charge", "school_facilities_fee"]);
  assert.equal(byTag(content, "label").find((l) => l.textContent === "Basis").getAttribute("for"), "sched-basis");

  basis.value = NO_BASIS;
  basis.fire("change");
  assert.equal(byClass(content, "result-bar")[0].textContent, "1 row · 1 agency");
  assert.equal(byId(content, "sched-basis").value, NO_BASIS);
  assert.deepEqual(texts(byTag(content, "tbody")[0].children.map((tr) => tr.children[1])), ["Traffic Fee"]);
  const type = byId(content, "sched-type");
  type.value = "capacity_charge";
  type.fire("change");
  assert.equal(byTag(content, "tbody")[0].textContent, "No rate matches these filters.");
  assert.equal(byTag(content, "tbody")[0].children[0].children[0].getAttribute("colspan"), "11");

  // Sorting by rate puts the largest first and the unpriced cell last.
  byId(content, "sched-basis").value = "";
  byId(content, "sched-basis").fire("change");
  byId(content, "sched-type").value = "";
  byId(content, "sched-type").fire("change");
  const rateTh = byTag(content, "th").find((th) => th.textContent === "Rate");
  byTag(rateTh, "button")[0].fire("click");
  const rateCol = () => texts(byTag(content, "tbody")[0].children.map((tr) => tr.children[4]));
  assert.deepEqual(rateCol(), ["$1,200.50", "$300", "$5.17", "$0", "N/A"]);
  assert.equal(byTag(content, "th").find((th) => th.textContent === "Rate").getAttribute("aria-sort"), "descending");
  byTag(byTag(content, "th").find((th) => th.textContent === "Rate"), "button")[0].fire("click");
  assert.deepEqual(rateCol(), ["$0", "$5.17", "$300", "$1,200.50", "N/A"]);

  // Search waits for typing to pause, then keeps the box focused.
  const q = byId(content, "sched-q");
  q.value = "storm";
  q.fire("input");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(byClass(content, "result-bar")[0].textContent, "1 row · 1 agency");
  assert.equal(focused, byId(content, "sched-q"));
  assert.equal(focused.getAttribute("value"), "storm");

  // An agency link opens that agency's schedule.
  const link = byTag(content, "a").find((a) => a.textContent === "City of Alpha");
  assert.equal(link.getAttribute("href"), "?view=schedules&agency=City%20of%20Alpha");
  assert.equal(link.fire("click").defaultPrevented, true);
  assert.equal(byTag(content, "h2")[0].textContent, "City of Alpha");
  assert.equal(content.scrolled, 1);
}

// One agency: grouped by purpose, then by program, with fund and authority columns.
{
  const { content, ctx } = mount(fetchOk(csvOf(ROWS)), { selection: { agency: "Beta Water District" } });
  renderSchedules(content, ctx);
  await settle();
  assert.equal(byTag(content, "h2")[0].textContent, "Beta Water District");
  assert.equal(byClass(content, "schedules-head")[0].children[2].textContent, `${entityTypeLabel("special_district")} · 1 document · 1 row`);
  assert.deepEqual(texts(byTag(content, "h3")), ["Water"]);
  assert.equal(byTag(content, "h4")[0].textContent, "Capacity Charge Capacity charge");
  const heads = texts(byTag(content, "th"));
  assert.deepEqual(heads, ["Land use", "Conditions", "Rate", "Unit", "Basis", "Status", "Fund", "Authority", "Date", "Printed", "Evidence"]);
  const cells = texts(byTag(content, "tbody")[0].children[0].children.slice(0, 9));
  assert.deepEqual(cells, ["", "3/4 inch meter", "$0", "per meter", "By meter size", "Adopted", "Fund 100", "Section 66013", "January 1, 2029"]);
}

{
  const { content, ctx } = mount(fetchOk(csvOf(ROWS)), { selection: { agency: "City of Alpha" } });
  renderSchedules(content, ctx);
  await settle();
  assert.equal(byClass(content, "schedules-head")[0].children[2].textContent,
    `${entityTypeLabel("city")} · Example County · 1 document · 3 rows`);
  assert.deepEqual(texts(byTag(content, "h3")), ["Parks", "Transportation", "Drainage"]);
  assert.deepEqual(texts(byClass(content, "schedules-table-name")), ["Table 1 Fee Schedule", "Table 1 Fee Schedule", "Table 2"]);
  const traffic = byClass(content, "schedules-program")[1];
  assert.deepEqual(texts(byTag(traffic, "tbody")[0].children[0].children.slice(0, 5)), ["Other", "", "$300", "", "Basis not printed"]);
}

// The caller's selection (the address bar) decides each render; onSelect hears changes first.
{
  const sel = { agency: "City of Alpha" };
  const seen = [];
  const { content, ctx } = mount(fetchOk(csvOf(ROWS)), {
    selection: sel,
    onSelect: (s) => {
      seen.push(s);
      Object.assign(sel, s);
    },
  });
  renderSchedules(content, ctx);
  await settle();
  assert.equal(byTag(content, "h2")[0].textContent, "City of Alpha");
  byClass(content, "back")[0].fire("click");
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]), SELECTION_KEYS);
  assert.equal(seen[0].agency, "");
  assert.equal(byTag(content, "h2").length, 0);
  // A selection the page did not make (the back button) wins over the last one it did.
  sel.agency = "Beta Water District";
  content.replaceChildren();
  renderSchedules(content, ctx);
  assert.equal(byTag(content, "h2")[0].textContent, "Beta Water District");
  sel.agency = "";
  sel.page = "nonsense";
  sel.dir = "sideways";
  content.replaceChildren();
  renderSchedules(content, ctx);
  assert.equal(byClass(content, "result-bar")[0].textContent, "5 rows · 3 agencies");
  // An agency the file does not name falls back to the statewide view.
  sel.agency = "Nowhere";
  content.replaceChildren();
  renderSchedules(content, ctx);
  assert.equal(byTag(content, "h2").length, 0);
}

// More rows than one page: a pager, and the page number stays inside the range.
{
  const many = Array.from({ length: 205 }, (_, i) => row({ schedule_row_id: `alpha-p3-${String(i).padStart(3, "0")}` }));
  const sel = { page: "9" };
  const { content, ctx } = mount(fetchOk(csvOf(many)), { selection: sel, onSelect: (s) => Object.assign(sel, s) });
  renderSchedules(content, ctx);
  await settle();
  assert.equal(byClass(content, "pager")[0].children[1].textContent, "page 2 of 2");
  assert.equal(byTag(content, "tbody")[0].children.length, 5);
  const [prev, , next] = byClass(content, "pager")[0].children;
  assert.equal(next.hasAttribute("disabled"), true);
  prev.fire("click");
  assert.equal(sel.page, 1);
  assert.equal(byTag(content, "tbody")[0].children.length, 200);
}

// ------------------------------------------------------------ real files, when present

const here = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = process.env.MFA_DATA_ROOT || path.resolve(here, "..", "..", "mfa-data");
const realCsv = [process.env.MFA_SCHEDULES_CSV, path.join(dataRoot, SCHEDULES_PATH)].filter(Boolean).find((p) => existsSync(p));
if (realCsv) {
  const { rows, rejected } = parseSchedules(readFileSync(realCsv, "utf8"));
  assert.deepEqual(rejected, [], `${realCsv}: rows fail the contract`);
  const built = buildSchedules(rows);
  for (const a of built.agencies) for (const g of a.purposes) assert.ok(PURPOSE_CATEGORY[g.purpose], g.purpose);
  const s = scheduleStats(rows);
  console.log(`  ${path.basename(realCsv)}: ${s.rows} rows, ${s.agencies} agencies, ${s.documents} documents, ${s.unpriced} cells without amount`);
}

const contractPath = process.env.MFA_SCHEDULES_CONTRACT;
if (contractPath && existsSync(contractPath)) {
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  assert.deepEqual(contract.columns.map((c) => c.name), SCHEDULE_COLUMNS);
  const codes = (list) => list.map(([k]) => k);
  assert.deepEqual(Object.keys(contract.codes.normalized_fee_type), codes(FEE_TYPES));
  assert.deepEqual(Object.keys(contract.codes.purpose_category), codes(PURPOSES));
  assert.deepEqual(Object.keys(contract.codes.basis), codes(BASES));
  assert.deepEqual(Object.keys(contract.codes.rate_status), codes(RATE_STATUSES));
  assert.deepEqual(Object.keys(contract.codes.land_use_class), codes(LAND_USES));
  assert.deepEqual(Object.keys(contract.codes.review_status), codes(REVIEW_STATUSES));
  assert.deepEqual(contract.purpose_taxonomy_category, PURPOSE_CATEGORY);
  console.log(`  ${path.basename(contractPath)}: code lists match`);
}

console.log("schedules tests passed");
