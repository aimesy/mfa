// node tests/worker.test.mjs
// Unit checks for the mfa-data Worker (worker/release.js) with a mocked env,
// a stub for the cached Release entrypoint and a mocked fetch.

import assert from "node:assert/strict";
import { handleGateway, handleRelease, route, RELEASE_PATH, requestShape, documentKey, OPEN_PATHS } from "../worker/release.js";
import { addressKey } from "../worker/gate.js";
import { checkGate } from "../worker/gate.contract.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SITE = "https://mfa.amyc.us";
const BASE = "https://mfa-data.amyc.us";

function limiter(allow = true) {
  const keys = [];
  return { keys, limit: async ({ key }) => { keys.push(key); return { success: allow }; } };
}

function env(extra = {}) {
  return {
    ALLOWED_ORIGINS: "https://mfa.amyc.us https://aimesy.github.io",
    FILE_LIMITER: limiter(),
    SLICE_LIMITER: limiter(),
    SESSION_KEY: "test-session-key",
    TURNSTILE_SECRET_KEY: "test-turnstile-secret",
    ...extra,
  };
}

// Gateway with a stub Release entrypoint that records what it was sent.
const logged = [];
async function gateway(path, { method = "GET", headers = {}, body, e = env(), reply, counters, fetchImpl, now } = {}) {
  const sent = [];
  const release = async (req) => {
    sent.push(req);
    return reply ? reply(req) : new Response("body", { headers: { "Content-Type": "application/pdf", "Cache-Control": "public, max-age=31536000, immutable" } });
  };
  const res = await handleGateway(new Request(`${BASE}${path}`, { method, headers, body }), e, { release, counters, fetchImpl, now, log: (line) => logged.push(line) });
  return { res, sent };
}

// Release entrypoint with a mocked GitHub.
async function release(path, { headers = {}, method = "GET", e = {}, upstream } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return upstream ? upstream(url, init) : new Response("%PDF", { status: 200, headers: { "Content-Length": "4", ETag: '"abc"' } });
  };
  const res = await handleRelease(new Request(`${BASE}${path}`, { method, headers }), e, fetchImpl);
  return { res, calls };
}

// Path allowlist: only what the viewer asks for, at a commit or main.
{
  assert.deepEqual(route(`/${SHA}/manifest.json`), { kind: "file", ref: SHA, path: "manifest.json" });
  assert.deepEqual(route("/main/data/reported-fee-collections.csv"), { kind: "file", ref: "main", path: "data/reported-fee-collections.csv" });
  assert.deepEqual(route(`/${SHA}/evidence/a/b-1.pdf`), { kind: "file", ref: SHA, path: "evidence/a/b-1.pdf" });
  assert.deepEqual(route("/ref"), { kind: "ref" });
  for (const bad of [
    `/${SHA}/.github/workflows/x.yml`, `/${SHA}/validation/x.json`, `/${SHA}/sources/../README.md`, `/${SHA}/sources/a b.pdf`,
    `/${SHA}/sources/a%2e%2e/b.pdf`, `/${SHA.toUpperCase()}/manifest.json`, "/dev/manifest.json", `/${SHA.slice(1)}/manifest.json`,
    "/", "/manifest.json", `/${SHA}/`, `/${SHA}/data`, "/main/README.md/x",
  ]) assert.equal(route(bad), null, `${bad} must be refused`);
  assert.equal(RELEASE_PATH.test("README.md"), true);
}

// Unknown or missing origin: 403, and the Release entrypoint is never called.
{
  for (const headers of [{}, { Origin: "https://evil.example" }, { Origin: "null" }, { Referer: "https://evil.example/mfa/" }, { Origin: "https://evil.example", Referer: `${SITE}/` }]) {
    const { res, sent } = await gateway(`/${SHA}/manifest.json`, { headers });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal(sent.length, 0);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
  }
}

// Allowed by Origin (fetch) or by Referer (a PDF opened in a new tab); CORS on the answer.
{
  const { res, sent } = await gateway(`/${SHA}/evidence/x.pdf`, { headers: { Origin: SITE } });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.match(res.headers.get("Vary"), /Origin/);
  assert.equal(res.headers.get("Access-Control-Expose-Headers"), "Content-Range, Content-Length, Accept-Ranges, Retry-After, X-Check, X-Limit, X-MFA-Session, X-Trusted-Key");
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.equal(await res.text(), "body");

  const viaReferer = await gateway(`/${SHA}/evidence/x.pdf`, { headers: { Referer: "https://aimesy.github.io/mfa/?view=figures" } });
  assert.equal(viaReferer.res.status, 200);
  assert.equal(viaReferer.res.headers.get("Access-Control-Allow-Origin"), "https://aimesy.github.io");

  const kept = await gateway(`/${SHA}/manifest.json`, { headers: { Origin: SITE }, reply: () => new Response("x", { headers: { Vary: "Accept-Encoding" } }) });
  assert.equal(kept.res.headers.get("Vary"), "Accept-Encoding, Origin");
  // Shared caches keep nothing. The browser keeps an index file at a commit,
  // never a document (it must pass the gate each time), /ref or main.
  const cached = { "Cache-Control": "public, max-age=31536000, immutable", "CDN-Cache-Control": "max-age=31536000", "Cloudflare-CDN-Cache-Control": "max-age=31536000", "Surrogate-Control": "max-age=31536000", Age: "60", Expires: "Wed, 21 Oct 2037 07:28:00 GMT" };
  const index = await gateway(`/${SHA}/data/reported-fee-collections.csv`, { headers: { Origin: SITE }, reply: () => new Response("a,b\n", { headers: cached }) });
  assert.equal(index.res.headers.get("Cache-Control"), "private, max-age=31536000, immutable");
  const head = await gateway("/main/sources/index.csv", { headers: { Origin: SITE }, reply: () => new Response("a,b\n", { headers: { "Cache-Control": "public, max-age=60" } }) });
  assert.equal(head.res.headers.get("Cache-Control"), "private, no-store");
  const ref = await gateway("/ref", { headers: { Origin: SITE }, reply: () => new Response(SHA, { headers: { "Cache-Control": "public, max-age=60" } }) });
  assert.equal(ref.res.headers.get("Cache-Control"), "private, no-store");
  const document = await gateway(`/${SHA}/evidence/x.pdf`, { headers: { Origin: SITE }, reply: () => new Response("%PDF", { headers: cached }) });
  assert.equal(document.res.headers.get("Cache-Control"), "private, no-store");
  const asset = await gateway("/releases/download/pdf-napa-001/x.pdf", { headers: { Origin: SITE }, reply: () => new Response("%PDF", { headers: cached }) });
  assert.equal(asset.res.headers.get("Cache-Control"), "private, no-store");
  const missing = await gateway(`/${SHA}/manifest.json`, { headers: { Origin: SITE }, reply: () => new Response("Not found\n", { status: 404, headers: { "Cache-Control": "public, max-age=31536000, immutable" } }) });
  assert.equal(missing.res.headers.get("Cache-Control"), "private, no-store");
  for (const r of [index, document]) for (const name of ["CDN-Cache-Control", "Cloudflare-CDN-Cache-Control", "Surrogate-Control", "Age", "Expires"]) assert.equal(r.res.headers.has(name), false);
}

// Query stripping and Range forwarding: the inner request carries the path and Range only.
{
  const { sent } = await gateway(`/${SHA}/evidence/x.pdf?cachebust=1&token=x`, {
    headers: { Origin: SITE, Range: "bytes=0-262143", Cookie: "a=b", Authorization: "Bearer nope", "Cache-Control": "no-cache" },
  });
  const inner = sent[0];
  assert.equal(inner.url, `${BASE}/${SHA}/evidence/x.pdf`);
  assert.deepEqual([...inner.headers.keys()], ["range"]);
  assert.equal(inner.headers.get("Range"), "bytes=0-262143");
  assert.equal(inner.method, "GET");

  const plain = await gateway(`/${SHA}/manifest.json`, { headers: { Origin: SITE, Accept: "*/*" } });
  assert.deepEqual([...plain.sent[0].headers.keys()], []);
}

// Paths outside the allowlist: 404 without reaching GitHub.
{
  const { res, sent } = await gateway(`/${SHA}/.git/config`, { headers: { Origin: SITE } });
  assert.equal(res.status, 404);
  assert.equal(sent.length, 0);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
}

// Rate limit: per CF-Connecting-IP; over the limit, 429 with Retry-After and CORS so the viewer sees it.
{
  const e = env({ FILE_LIMITER: limiter(false) });
  const { res, sent } = await gateway(`/${SHA}/manifest.json`, { headers: { Origin: SITE, "CF-Connecting-IP": "203.0.113.9" }, e });
  assert.equal(res.status, 429);
  assert.equal(sent.length, 0);
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.equal(res.headers.get("Access-Control-Expose-Headers"), "Content-Range, Content-Length, Accept-Ranges, Retry-After, X-Check, X-Limit, X-MFA-Session, X-Trusted-Key");
  assert.deepEqual(e.FILE_LIMITER.keys, ["203.0.113.9"]);

  const ok = env();
  await gateway(`/${SHA}/manifest.json`, { headers: { Origin: SITE, "CF-Connecting-IP": "198.51.100.4" }, e: ok });
  assert.deepEqual(ok.FILE_LIMITER.keys, ["198.51.100.4"]);
}

// OPTIONS preflight: allowed origin gets Range; unknown origin gets 403.
{
  const { res, sent } = await gateway(`/${SHA}/evidence/x.pdf`, {
    method: "OPTIONS", headers: { Origin: SITE, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range" },
  });
  assert.equal(res.status, 204);
  assert.equal(sent.length, 0);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /Range/);
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /GET/);
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.equal(res.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.match(res.headers.get("Vary"), /Origin/);
  const denied = await gateway(`/${SHA}/evidence/x.pdf`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(denied.res.status, 403);
}

// Other methods are refused.
{
  const { res, sent } = await gateway(`/${SHA}/manifest.json`, { method: "POST", headers: { Origin: SITE } });
  assert.equal(res.status, 405);
  assert.equal(sent.length, 0);
}

// robots.txt disallows everything, for anyone.
{
  const { res, sent } = await gateway("/robots.txt");
  assert.equal(res.status, 200);
  assert.equal(sent.length, 0);
  assert.equal(await res.text(), "User-agent: *\nDisallow: /\n");
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
}

// Upstream: Authorization only when the token is set, User-Agent always, Range passed through.
{
  const withToken = await release(`/${SHA}/manifest.json`, { e: { MFA_DATA_TOKEN: "t0ken" } });
  assert.equal(withToken.calls[0].url, `https://raw.githubusercontent.com/aimesy/mfa-data/${SHA}/manifest.json`);
  assert.equal(withToken.calls[0].init.headers.Authorization, "Bearer t0ken");
  assert.match(withToken.calls[0].init.headers["User-Agent"], /mfa-data-worker/);

  const without = await release(`/${SHA}/manifest.json`);
  assert.equal("Authorization" in without.calls[0].init.headers, false);

  const ranged = await release(`/${SHA}/sources/big.pdf`, {
    headers: { Range: "bytes=262144-524287" },
    upstream: () => new Response("part", { status: 206, headers: { "Content-Range": "bytes 262144-524287/90000000", "Content-Length": "262144" } }),
  });
  assert.equal(ranged.calls[0].init.headers.Range, "bytes=262144-524287");
  assert.equal(ranged.res.status, 206);
  assert.equal(ranged.res.headers.get("Content-Range"), "bytes 262144-524287/90000000");
  assert.equal(ranged.res.headers.get("Content-Length"), "262144");
  assert.equal(ranged.res.headers.get("Accept-Ranges"), "bytes");
}

// Cache headers: a commit is immutable, main is short; errors are never stored.
{
  const pinned = await release(`/${SHA}/evidence/x.pdf`);
  assert.equal(pinned.res.status, 200);
  assert.equal(pinned.res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(pinned.res.headers.get("Content-Type"), "application/pdf");
  assert.equal(pinned.res.headers.get("ETag"), '"abc"');
  assert.equal(pinned.res.headers.get("Content-Length"), "4");
  assert.equal(pinned.res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(pinned.res.headers.get("Content-Security-Policy"), null, "PDFs open in the browser's viewer");

  const head = await release("/main/data/reported-fee-collections.csv");
  assert.equal(head.res.headers.get("Cache-Control"), "public, max-age=60");
  assert.equal(head.res.headers.get("Content-Type"), "text/csv; charset=utf-8");
  assert.equal(head.res.headers.get("Content-Security-Policy"), "default-src 'none'; sandbox");

  assert.equal((await release(`/${SHA}/manifest.json`)).res.headers.get("Content-Type"), "application/json");
  assert.equal((await release(`/${SHA}/README.md`)).res.headers.get("Content-Type"), "text/plain; charset=utf-8");

  const missing = await release(`/${SHA}/manifest.json`, { upstream: () => new Response("404: Not Found", { status: 404 }) });
  assert.equal(missing.res.status, 404);
  assert.equal(missing.res.headers.get("Cache-Control"), "no-store");
  const broken = await release(`/${SHA}/manifest.json`, { upstream: () => new Response("", { status: 500 }) });
  assert.equal(broken.res.status, 502);
  assert.equal(broken.res.headers.get("Cache-Control"), "no-store");
  const down = await release(`/${SHA}/manifest.json`, { upstream: () => { throw new Error("connect failed"); } });
  assert.equal(down.res.status, 502);
  assert.equal(down.res.headers.get("Cache-Control"), "no-store");
}

// Content-Length is dropped when the upstream body was encoded (the runtime decodes it).
{
  const { res } = await release(`/${SHA}/data/x.csv`, {
    upstream: () => new Response("a,b\n", { headers: { "Content-Encoding": "gzip", "Content-Length": "31" } }),
  });
  assert.equal(res.headers.get("Content-Length"), null);
  assert.equal(res.headers.get("Content-Encoding"), null);
}

// /ref: the commit at main from the API, cached for 60 s.
{
  const { res, calls } = await release("/ref", {
    e: { MFA_DATA_TOKEN: "t0ken" },
    upstream: () => new Response(`${SHA}\n`, { status: 200 }),
  });
  assert.equal(calls[0].url, "https://api.github.com/repos/aimesy/mfa-data/commits/main");
  assert.equal(calls[0].init.headers.Accept, "application/vnd.github.sha");
  assert.equal(calls[0].init.headers.Authorization, "Bearer t0ken");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), SHA);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=60");

  const denied = await release("/ref", { upstream: () => new Response('{"message":"Not Found"}', { status: 404 }) });
  assert.equal(denied.res.status, 502);
  assert.equal(denied.res.headers.get("Cache-Control"), "no-store");

  const viaGateway = await gateway("/ref?x=1", { headers: { Origin: SITE } });
  assert.equal(viaGateway.sent[0].url, `${BASE}/ref`);
}

// The Release entrypoint refuses paths outside the allowlist on its own too.
{
  const { res, calls } = await release(`/${SHA}/.github/x.yml`);
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
}

// Release assets: the release's PDFs. Paths mirror github.com's download URLs.
const TAGGED = "/releases/download/pdf-napa-001/american-canyon__evidence__outlined__p002-f0927f65.pdf";
{
  assert.deepEqual(route(TAGGED), { kind: "asset", tag: "pdf-napa-001", name: "american-canyon__evidence__outlined__p002-f0927f65.pdf" });
  for (const bad of [
    "/releases/download/pdf-napa-001/x.exe", "/releases/download/pdf-napa-001/a/b.pdf", "/releases/download/pdf-napa-001/..pdf",
    "/releases/download/pdf napa/x.pdf", "/releases/latest", "/releases/download//x.pdf", "/_assets/pdf-napa-001",
  ]) assert.equal(route(bad), null, `${bad} must be refused`);

  // Through the gateway: path only, Range kept, never the internal map.
  const { res, sent } = await gateway(`${TAGGED}?x=1`, { headers: { Origin: SITE, Range: "bytes=0-9" } });
  assert.equal(res.status, 200);
  assert.equal(sent[0].url, `${BASE}${TAGGED}`);
  assert.deepEqual([...sent[0].headers.keys()], ["range"]);
  const internal = await gateway("/_assets/pdf-napa-001", { headers: { Origin: SITE } });
  assert.equal(internal.res.status, 404);
  assert.equal(internal.sent.length, 0);
}

// The internal name -> id map walks every page of the release's assets with the token.
{
  const page = (n, from) => Array.from({ length: n }, (_, i) => ({ name: `f${from + i}.pdf`, id: 1000 + from + i }));
  const { res, calls } = await release("/_assets/pdf-napa-001", {
    e: { MFA_DATA_TOKEN: "t0ken" },
    upstream: (url) => {
      if (url.endsWith("/releases/tags/pdf-napa-001")) return Response.json({ id: 77 });
      if (url.includes("/releases/77/assets?per_page=100&page=1")) return Response.json(page(100, 0));
      if (url.includes("/releases/77/assets?per_page=100&page=2")) return Response.json(page(3, 100));
      return new Response("unexpected", { status: 500 });
    },
  });
  assert.equal(res.status, 200);
  const ids = await res.json();
  assert.equal(Object.keys(ids).length, 103);
  assert.equal(ids["f102.pdf"], 1102);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=600");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.init.headers.Authorization === "Bearer t0ken"));

  const none = await release("/_assets/pdf-nowhere-001", { upstream: () => new Response("{}", { status: 404 }) });
  assert.equal(none.res.status, 404);
  assert.equal(none.res.headers.get("Cache-Control"), "no-store");
  const failed = await release("/_assets/pdf-napa-001", { upstream: () => new Response("{}", { status: 403 }) });
  assert.equal(failed.res.status, 502);
  assert.equal(failed.res.headers.get("Cache-Control"), "no-store");
}

// An asset: the API with the token, then the signed URL without it.
{
  const name = "american-canyon__evidence__outlined__p002-f0927f65.pdf";
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === "https://api.github.com/repos/aimesy/mfa-data/releases/assets/4242") {
      return new Response(null, { status: 302, headers: { Location: "https://release-assets.githubusercontent.com/github-production-release-asset/1/x?sig=abc" } });
    }
    return new Response("%PDF-1.7", { status: 200, headers: { "Content-Length": "8", "Content-Type": "application/octet-stream", ETag: '"e1"' } });
  };
  const res = await handleRelease(new Request(`${BASE}${TAGGED}`), { MFA_DATA_TOKEN: "t0ken" }, fetchImpl, async (tag) => (tag === "pdf-napa-001" ? { [name]: 4242 } : null));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "%PDF-1.7");
  assert.equal(calls[0].init.headers.Authorization, "Bearer t0ken");
  assert.equal(calls[0].init.headers.Accept, "application/octet-stream");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[1].url.startsWith("https://release-assets.githubusercontent.com/"), true);
  assert.equal("Authorization" in calls[1].init.headers, false, "the token never follows the redirect");
  assert.equal(res.headers.get("Content-Type"), "application/pdf");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=86400");
  assert.equal(res.headers.get("Content-Length"), "8");
  assert.equal(res.headers.get("ETag"), '"e1"');
  assert.equal(res.headers.get("Content-Security-Policy"), null);

  const unknown = await handleRelease(new Request(`${BASE}/releases/download/pdf-napa-001/other.pdf`), {}, fetchImpl, async () => ({ [name]: 4242 }));
  assert.equal(unknown.status, 404);
  const noRelease = await handleRelease(new Request(`${BASE}${TAGGED}`), {}, fetchImpl, async () => null);
  assert.equal(noRelease.status, 404);
  const noMap = await handleRelease(new Request(`${BASE}${TAGGED}`), {}, fetchImpl, async () => undefined);
  assert.equal(noMap.status, 502);
  assert.equal(noMap.headers.get("Cache-Control"), "no-store");

  const elsewhere = await handleRelease(new Request(`${BASE}${TAGGED}`), {}, async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/x.pdf" } }), async () => ({ [name]: 1 }));
  assert.equal(elsewhere.status, 502);

  const ranged = [];
  await handleRelease(new Request(`${BASE}${TAGGED}`, { headers: { Range: "bytes=0-262143" } }), {}, async (url, init) => {
    ranged.push(init.headers.Range);
    return url.includes("/releases/assets/")
      ? new Response(null, { status: 302, headers: { Location: "https://release-assets.githubusercontent.com/a" } })
      : new Response("x", { status: 206, headers: { "Content-Range": "bytes 0-262143/90000000" } });
  }, async () => ({ [name]: 1 }));
  assert.deepEqual(ranged, ["bytes=0-262143", "bytes=0-262143"]);
}

// Addresses: IPv4 as is; IPv6 by its /64, since one household can use any of it.
{
  assert.equal(addressKey("203.0.113.9"), "203.0.113.9");
  assert.equal(addressKey("2001:db8:1:2:3:4:5:6"), addressKey("2001:db8:1:2:ffff::7"));
  assert.notEqual(addressKey("2001:db8:1:2::1"), addressKey("2001:db8:1:3::1"));
  assert.equal(addressKey("::ffff:198.51.100.4"), "198.51.100.4");
  assert.equal(addressKey(""), "unknown");
}

// Files and slices: one closed byte range up to 8 MB is a slice, anything else a file.
{
  const shape = (range) => requestShape(new Request(BASE, { headers: range ? { Range: range } : {} }));
  assert.deepEqual(shape("bytes=262144-524287"), { slice: true, size: 262144 });
  assert.deepEqual(shape("bytes=0-"), { slice: false, size: 0 });
  assert.deepEqual(shape("bytes=0-99999999"), { slice: false, size: 0 });
  assert.deepEqual(shape("bytes=0-1,5-9"), { slice: false, size: 0 });
  assert.deepEqual(shape(null), { slice: false, size: 0 });

  const e = env();
  await gateway(`/${SHA}/sources/big.pdf`, { headers: { Origin: SITE, "CF-Connecting-IP": "2001:db8:1:2::9", Range: "bytes=0-262143" }, e });
  await gateway(`/${SHA}/manifest.json`, { headers: { Origin: SITE, "CF-Connecting-IP": "2001:db8:1:2::9" }, e });
  assert.deepEqual(e.SLICE_LIMITER.keys, ["2001:db8:1:2::/64"]);
  assert.deepEqual(e.FILE_LIMITER.keys, ["2001:db8:1:2::/64"]);

  const busy = env({ SLICE_LIMITER: limiter(false) });
  const { res } = await gateway(`/${SHA}/sources/big.pdf`, { headers: { Origin: SITE, Range: "bytes=0-262143" }, e: busy });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
}

// Documents: release assets and repository PDFs; everything else is an index file.
{
  assert.equal(documentKey(route(TAGGED)), "asset:pdf-napa-001/american-canyon__evidence__outlined__p002-f0927f65.pdf");
  assert.equal(documentKey(route(`/${SHA}/sources/a/report.pdf`)), "file:sources/a/report.pdf");
  assert.equal(documentKey(route("/main/sources/a/report.pdf")), "file:sources/a/report.pdf", "one document whatever the ref");
  for (const index of [`/${SHA}/manifest.json`, `/${SHA}/sources/index.csv`, `/${SHA}/evidence/index.json`, "/main/data/reported-fee-collections.csv", "/ref"]) {
    assert.equal(documentKey(route(index)), null, `${index} is an index file`);
  }
  assert.deepEqual(OPEN_PATHS, []);
}

// The browser check and the document limits (worker/gate.js), through this gateway.
await checkGate({
  handle: (path, { method = "GET", headers = {}, body, env: e, counters, fetchImpl, now, log = () => {} }) =>
    handleGateway(new Request(`${BASE}${path}`, { method, headers, body }), e, {
      release: async () => new Response("%PDF", { headers: { "Content-Type": "application/pdf" } }),
      counters, fetchImpl, now, log,
    }),
  env: (extra = {}) => env(extra),
  site: SITE,
  document: (i) => `/releases/download/pdf-napa-001/doc-${i}.pdf`,
  slices: true,
  index: `/${SHA}/manifest.json`,
  open: null,
  cookiePrefix: "mfa",
  sessionHeader: "X-MFA-Session",
});

// The Release entrypoint never serves /session.
{
  const { res, calls } = await release("/session");
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
}

console.log("worker tests passed");
