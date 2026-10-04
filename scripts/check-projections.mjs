// visibility: public
// Refuse the gateway deploy until the canonical writer published scoped data.
import assert from "node:assert/strict";
import { browseProjection, figureHashes, figureProjection, parseRelease, prepareDetailIds, sourceProjection } from "../worker/projection.js";
const token = process.env.MFA_DATA_ACCESS;
assert(token, "MFA_DATA_ACCESS is required");
const headers = { Authorization: `Bearer ${token}` };
const ref = await fetch("https://api.github.com/repos/aimesy/mfa-data/commits/main", { headers: { ...headers, Accept: "application/vnd.github.sha" } });
assert(ref.ok, "Could not read the canonical release head");
const sha = (await ref.text()).trim();
assert(/^[0-9a-f]{40}$/.test(sha));
async function response(path) {
  const response = await fetch(`https://raw.githubusercontent.com/aimesy/mfa-data/${sha}/${path}`, { headers });
  return response;
}
let data = null;
const initial = await response("browse.json");
assert(initial.ok || initial.status === 404 && process.env.MFA_PROJECTION_FALLBACK === "true", "Canonical projections must be ready or paid fallback enabled");
if (!initial.ok) {
  const [fees, sources] = await Promise.all([response("data/reported-fee-collections.csv"), response("sources/index.csv")]);
  assert(fees.ok && sources.ok, "Published projection inputs are unavailable");
  data = parseRelease(await fees.text(), await sources.text());
  await prepareDetailIds(data);
}
async function read(path) {
  const res = await response(path);
  if (res.ok) return res.json();
  assert.equal(res.status, 404);
  assert(data, `Required projection is not published: ${path}`);
  if (path.startsWith("figures/")) {
    const figure = figureProjection(data, path.slice(8, -5));
    const evidence = await response("evidence/index.json");
    assert(evidence.ok, "Published evidence hashes are unavailable");
    return { ...figure, hashes: figureHashes(figure.rows, await evidence.json()) };
  }
  if (path.startsWith("source-records/")) return sourceProjection(data, path.slice(15, -5));
  throw new Error("Unknown projection");
}
const browse = initial.ok ? await initial.json() : browseProjection(data);
assert.equal(browse.schema, 1);
assert(browse.rows.length && browse.sources.length);
assert(browse.rows.every((r) => r._summary && !Object.hasOwn(r, "value_usd") && !Object.hasOwn(r, "source_value_text")));
const figure = browse.rows[0]._detailId || browse.rows[0].figure_group_id || browse.rows[0].record_id;
const source = browse.sources[0].source_id;
assert(/^[A-Za-z0-9._-]{1,200}$/.test(figure) && !figure.includes(".."));
assert(/^[A-Za-z0-9._-]{1,200}$/.test(source) && !source.includes(".."));
const detail = await read(`figures/${figure}.json`);
assert(detail.rows.length && detail.sources.length && Array.isArray(detail.hashes));
assert.equal((await read(`source-records/${source}.json`)).source_id, source);
console.log(`Scoped projection inputs are ready at ${sha}${data ? " (paid fallback)" : " (precomputed)"}`);
