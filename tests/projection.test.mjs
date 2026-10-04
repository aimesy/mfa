// visibility: public
// Local synthetic records exercise projections and metering without live quotas.
import assert from "node:assert/strict";
import { toCsv, parseCsvObjects } from "../lib/csv.js";
import { browseProjection, figureProjection, parseRelease, prepareDetailIds, sourceProjection } from "../worker/projection.js";
import { handleGateway, handleRelease, documentKey, route } from "../worker/release.js";
import { memoryCounters } from "../worker/gate.js";
import { buildModel, summarize } from "../lib/model.js";

const SHA = "1234567890123456789012345678901234567890";
const SITE = "https://mfa.amyc.us";
const BASE = "https://projection-test.example";
const base = { receiving_entity: "City of Example", entity_type: "city", county: "Example", fiscal_year: "2024-25", fee_program: "Parks", fee_category: "parks", measure_as_printed: "Fees collected", is_primary_in_figure_group: "true", physical_pdf_page: "3", source_id: "s1", source_limitations: 'Private note, with "quotes"\nand a new line', arithmetic_check: "10 + 1 = 11", secret_column: "Never publish unknown fields" };
const rows = Array.from({ length: 6 }, (_, i) => ({ ...base, record_id: `r${i}`, figure_group_id: `g${i}`, value_usd: String(i + 10), source_value_text: String(i + 10) }));
const sources = [{ source_id: "s1", receiving_entity: "City of Example", publication_title: "Report", official_source_url: "https://example.com/report.pdf", source_pdf: "sources/s1.pdf", secret_column: "Private source detail" }];
const cols = Object.keys(rows[0]);
const feeCsv = toCsv(cols, rows);
const sourceCsv = toCsv(Object.keys(sources[0]), sources);
const data = parseRelease(feeCsv, sourceCsv);
assert.deepEqual(data.rows, parseCsvObjects(feeCsv).rows, "fast parser preserves quoted fields, escaped quotes and newlines");
const browse = browseProjection(data);
for (const r of browse.rows) {
  for (const k of ["value_usd", "source_value_text", "source_limitations", "arithmetic_check", "secret_column", "outline_rect_pdf_points", "source_pdf"]) assert.equal(Object.hasOwn(r, k), false, `${k} absent from summary`);
}
assert.equal(browse.sources[0].secret_column, undefined);
assert.equal(browse.sources[0].official_source_url, undefined);
assert.equal(browse.aggregates.total, 75);
assert.equal(browseProjection(parseRelease(toCsv(cols, rows.slice(0, 1)), sourceCsv)).aggregates.total, null, "small aggregates do not reveal a record amount");
const model = buildModel(structuredClone(browse.rows), browse.sources, undefined, browse.aggregates);
assert.equal(model.figures[0].value, null);
assert.equal(summarize(model.figures).sum, null, "unknown figures never sum to zero");
assert.equal(model.entities[0].sum, 75);
const unmarked = buildModel([{ ...rows[0], is_primary_in_figure_group: "false" }], sources);
assert.equal(summarize(unmarked.figures).sum, 0, "unmarked fallback rows never enter primary-only sums");
const one = figureProjection(data, "g0");
assert.equal(one.rows.length, 1);
assert.equal(one.rows[0].value_usd, "10");
assert.equal(one.rows[0].source_limitations, base.source_limitations);
assert.equal(JSON.parse(JSON.stringify(one)).rows[0].value_usd, "10", "browse construction never adds circular links to raw records");
assert.equal(figureProjection(data, "missing"), null);
assert.equal(sourceProjection(data, "s1").source_pdf, "sources/s1.pdf");
assert.equal(documentKey(route(`/${SHA}/figures/g0.json`)), "figure:g0");
assert.equal(documentKey(route("/main/figures/g0.json")), "figure:g0", "ref changes do not reset charging");
assert.equal(documentKey(route(`/${SHA}/source-records/s1.json`)), "source:s1");

const env = { ALLOWED_ORIGINS: SITE, SESSION_KEY: "synthetic-session", TURNSTILE_SECRET_KEY: "synthetic-turnstile", REQUIRE_SESSION: "true", DOCUMENTS_PER_CHECK: "1" };
const counters = memoryCounters();
let cookie = "";
const calls = [];
const run = (path, init = {}) => handleGateway(new Request(`${BASE}${path}`, { ...init, headers: { Origin: SITE, "CF-Connecting-IP": "192.0.2.90", Cookie: cookie, ...init.headers } }), env, {
  counters,
  fetchImpl: async () => Response.json({ success: true, hostname: "mfa.amyc.us" }),
  release: async (req) => { calls.push(req.url); return Response.json({ ok: true }); }, log: () => {},
});
const session = await run("/session", { method: "POST", body: "valid" });
assert.equal(session.status, 204);
cookie = session.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
for (const ref of [SHA, "main"]) for (const path of ["data/reported-fee-collections.csv", "sources/index.csv", "evidence/index.json", "data/residential-cash-receipts.csv", "README.md", "docs/README.md", "data/dump.json", "sources/dump.csv"]) {
  for (const method of ["GET", "HEAD"]) assert.equal((await run(`/${ref}/${path}?ignored=1`, { method, headers: { Range: "bytes=0-100" } })).status, 404, "raw tables remain blocked after a valid check");
}
assert.equal(calls.length, 0);
for (let i = 0; i < 3; i++) assert.equal((await run(`/${SHA}/browse.json`)).status, 200);
assert.equal((await run(`/${SHA}/figures/g0.json`)).status, 200);
assert.equal((await run(`/${SHA}/figures/g0.json`)).status, 200, "reopening same record is free");
assert.equal((await run(`/${SHA}/source-records/s1.json`)).status, 401, "a different record consumes the next allowance");
assert.equal((await run(`/${SHA}/browse.json`)).status, 200, "spent session keeps summary browsing");

const fetchRaw = async (url, init) => {
  assert.equal(init.headers.Range, undefined, "projected JSON never forwards Range");
  if (url.endsWith("/browse.json")) return Response.json(browse);
  if (url.endsWith("/figures/g1.json")) return Response.json(figureProjection(data, "g1"));
  return new Response("missing", { status: 404 });
};
const projected = await handleRelease(new Request(`${BASE}/${SHA}/browse.json`, { headers: { Range: "bytes=0-10" } }), {}, fetchRaw);
assert.equal(projected.status, 200);
assert.equal((await projected.json()).rows.length, 6, "Range cannot turn a raw file into a projection bypass");
const details = await handleRelease(new Request(`${BASE}/${SHA}/figures/g1.json`), {}, fetchRaw);
assert.equal((await details.json()).rows[0].value_usd, "11");
assert.equal((await handleRelease(new Request(`${BASE}/${SHA}/figures/missing.json`), {}, fetchRaw)).status, 404);
const rawCalls = [];
const fallbackFetch = async (url, init) => {
  rawCalls.push(url);
  assert.equal(init.headers.Range, undefined);
  if (url.endsWith("/data/reported-fee-collections.csv")) return new Response(feeCsv);
  if (url.endsWith("/sources/index.csv")) return new Response(sourceCsv);
  if (url.endsWith("/evidence/index.json")) return Response.json([]);
  return new Response("missing", { status: 404 });
};
const fallbackEnv = { MFA_PROJECTION_FALLBACK: "true" };
const fbBrowse = await handleRelease(new Request(`${BASE}/${SHA}/browse.json`, { headers: { Range: "bytes=0-10" } }), fallbackEnv, fallbackFetch);
assert.equal(fbBrowse.status, 200);
assert.deepEqual(await fbBrowse.json(), browse, "fallback uses the same browse projection");
const fbFigure = await handleRelease(new Request(`${BASE}/${SHA}/figures/g0.json`), fallbackEnv, fallbackFetch);
assert.equal((await fbFigure.json()).rows[0].source_value_text, rows[0].source_value_text);
rawCalls.length = 0;
const fbSource = await handleRelease(new Request(`${BASE}/${SHA}/source-records/s1.json`), fallbackEnv, fallbackFetch);
assert.deepEqual(await fbSource.json(), sources[0]);
assert.equal(rawCalls.some((u) => u.endsWith(".csv") && u.includes("reported-fee")), false, "source detail never parses the fee CSV");
for (const ref of [SHA, "main"]) assert.equal((await run(`/_projection-input/${ref}/data/reported-fee-collections.csv`)).status, 404, "internal cached inputs are never gateway routes");
const labels = parseRelease(toCsv(cols, [{ ...rows[0], figure_group_id: "group / unsafe", measure_as_printed: "Collected $1234.00" }]), sourceCsv);
await prepareDetailIds(labels);
assert.equal(browseProjection(labels).rows[0].measure_as_printed, "Figure");
assert.equal(figureProjection(labels, browseProjection(labels).rows[0]._detailId).rows[0].figure_group_id, "group / unsafe");
console.log("projection tests passed");
