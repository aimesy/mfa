// node tests/worker.test.mjs
// Unit checks for the mfa-data Worker (worker/release.js) with a mocked env,
// a stub for the cached Release entrypoint and a mocked fetch.

import assert from "node:assert/strict";
import { handleGateway, handleRelease, route, RELEASE_PATH, addressKey, applyQuota, makeSession, sessionState, requestShape } from "../worker/release.js";

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

// A stand-in for the DailyQuota Durable Object, with the real counting rule.
function counter(limitOverride) {
  const records = new Map();
  const charges = [];
  const take = async (address, day, units, limit) => {
    charges.push({ address, day, units, limit });
    const { ok, record } = applyQuota(records.get(address), day, units, limitOverride ?? limit);
    if (ok) records.set(address, record);
    return { ok, used: record.used };
  };
  return { take, charges, records };
}

// Gateway with a stub Release entrypoint that records what it was sent.
const logged = [];
async function gateway(path, { method = "GET", headers = {}, body, e = env(), reply, quota, fetchImpl, now } = {}) {
  const sent = [];
  const release = async (req) => {
    sent.push(req);
    return reply ? reply(req) : new Response("body", { headers: { "Content-Type": "application/pdf", "Cache-Control": "public, max-age=31536000, immutable" } });
  };
  const res = await handleGateway(new Request(`${BASE}${path}`, { method, headers, body }), e, { release, quota, fetchImpl, now, log: (line) => logged.push(line) });
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
  assert.equal(res.headers.get("Access-Control-Expose-Headers"), "Content-Range, Content-Length, Accept-Ranges, X-MFA-Session");
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
  assert.equal(await res.text(), "body");

  const viaReferer = await gateway(`/${SHA}/evidence/x.pdf`, { headers: { Referer: "https://aimesy.github.io/mfa/?view=figures" } });
  assert.equal(viaReferer.res.status, 200);
  assert.equal(viaReferer.res.headers.get("Access-Control-Allow-Origin"), "https://aimesy.github.io");

  const kept = await gateway(`/${SHA}/data/x.csv`, { headers: { Origin: SITE }, reply: () => new Response("x", { headers: { Vary: "Accept-Encoding" } }) });
  assert.equal(kept.res.headers.get("Vary"), "Accept-Encoding, Origin");
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
  assert.equal(res.headers.get("Access-Control-Expose-Headers"), "Content-Range, Content-Length, Accept-Ranges, X-MFA-Session");
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

// Daily cap: a file is one unit, a slice counts by size (4 MB a unit), /ref is free.
{
  const day = Date.UTC(2026, 9, 3, 23, 0, 0);
  const q = counter();
  const headers = { Origin: SITE, "CF-Connecting-IP": "203.0.113.20" };
  await gateway(`/${SHA}/manifest.json`, { headers, quota: q.take, now: day });
  await gateway(`/${SHA}/sources/big.pdf`, { headers: { ...headers, Range: "bytes=0-1048575" }, quota: q.take, now: day });
  await gateway("/ref", { headers, quota: q.take, now: day });
  assert.deepEqual(q.charges.map((c) => c.units), [1, 0.25]);
  assert.equal(q.charges[0].limit, 1000);
  assert.equal(q.charges[0].day, "2026-10-03");
  assert.equal(q.charges[0].address, "203.0.113.20");

  const full = counter(1);
  const first = await gateway(`/${SHA}/manifest.json`, { headers, quota: full.take, now: day });
  assert.equal(first.res.status, 200);
  const second = await gateway(`/${SHA}/data/x.csv`, { headers, quota: full.take, now: day });
  assert.equal(second.res.status, 429);
  assert.equal(second.sent.length, 0);
  assert.equal(second.res.headers.get("Retry-After"), "3600", "until midnight UTC");
  assert.equal(second.res.headers.get("Access-Control-Allow-Origin"), SITE);
  const nextDay = await gateway(`/${SHA}/data/x.csv`, { headers, quota: full.take, now: day + 2 * 3600 * 1000 });
  assert.equal(nextDay.res.status, 200, "the count starts again the next UTC day");

  const limited = await gateway(`/${SHA}/manifest.json`, { headers, quota: counter().take, e: env({ DAILY_FILE_LIMIT: "5" }), now: day });
  assert.equal(limited.res.status, 200);

  const broken = await gateway(`/${SHA}/manifest.json`, { headers, quota: async () => { throw new Error("down"); }, now: day });
  assert.equal(broken.res.status, 200, "an unreachable counter does not take the site down");
}

// Sessions: POST /session with a Turnstile token sets a cookie bound to the address.
{
  const verify = (out) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return Response.json(out);
    };
    return { calls, fetchImpl };
  };
  const headers = { Origin: SITE, "CF-Connecting-IP": "203.0.113.30", "Content-Type": "text/plain" };
  const ok = verify({ success: true, hostname: "mfa.amyc.us" });
  const { res, sent } = await gateway("/session", { method: "POST", headers, body: "tok", fetchImpl: ok.fetchImpl });
  assert.equal(res.status, 204);
  assert.equal(sent.length, 0);
  assert.equal(ok.calls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  const form = new URLSearchParams(ok.calls[0].body);
  assert.equal(form.get("secret"), "test-turnstile-secret");
  assert.equal(form.get("response"), "tok");
  assert.equal(form.get("remoteip"), "203.0.113.30");
  const cookie = res.headers.get("Set-Cookie");
  assert.match(cookie, /^mfa_session=v1\.\d+\.[A-Za-z0-9_-]+; Max-Age=43200; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
  assert.equal(res.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.equal(res.headers.get("Cache-Control"), "no-store");

  const value = cookie.split(";")[0];
  const withCookie = (ip) => new Request(BASE, { headers: { Cookie: `other=1; ${value}` } });
  assert.equal(await sessionState(withCookie(), env(), "203.0.113.30"), "ok");
  assert.equal(await sessionState(withCookie(), env(), "203.0.113.31"), "invalid", "bound to the address");
  assert.equal(await sessionState(withCookie(), env({ SESSION_KEY: "another-key" }), "203.0.113.30"), "invalid", "a new deploy key ends it");
  assert.equal(await sessionState(withCookie(), env(), "203.0.113.30", Date.now() + 13 * 3600 * 1000), "invalid", "expires after 12 hours");
  assert.equal(await sessionState(new Request(BASE), env(), "203.0.113.30"), "missing");
  assert.equal(await sessionState(new Request(BASE, { headers: { Cookie: "mfa_session=v1.99999999999.forged" } }), env(), "203.0.113.30"), "invalid");

  const wrongHost = verify({ success: true, hostname: "evil.example" });
  assert.equal((await gateway("/session", { method: "POST", headers, body: "tok", fetchImpl: wrongHost.fetchImpl })).res.status, 403);
  const failed = verify({ success: false, "error-codes": ["invalid-input-response"] });
  const refused = await gateway("/session", { method: "POST", headers, body: "tok", fetchImpl: failed.fetchImpl });
  assert.equal(refused.res.status, 403);
  assert.match(await refused.res.text(), /invalid-input-response/);
  assert.equal((await gateway("/session", { method: "POST", headers, body: "", fetchImpl: ok.fetchImpl })).res.status, 400);
  assert.equal((await gateway("/session", { method: "POST", headers, body: "tok", fetchImpl: ok.fetchImpl, e: env({ SESSION_KEY: "" }) })).res.status, 503);
  assert.equal((await gateway("/session", { method: "GET", headers: { Origin: SITE } })).res.status, 405);
  assert.equal((await gateway("/session", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "tok", fetchImpl: ok.fetchImpl })).res.status, 403, "origin still checked");
  assert.equal(ok.calls.length, 1, "Turnstile is asked only for a token that could pass");

  const githubIo = verify({ success: true, hostname: "aimesy.github.io" });
  assert.equal((await gateway("/session", { method: "POST", headers, body: "tok", fetchImpl: githubIo.fetchImpl })).res.status, 204);
}

// Enforcement: with REQUIRE_SESSION "true" a request needs a valid session; otherwise the state is only reported.
{
  const ip = "203.0.113.40";
  const value = await makeSession("test-session-key", ip);
  const headers = { Origin: SITE, "CF-Connecting-IP": ip };
  const strict = env({ REQUIRE_SESSION: "true" });

  const none = await gateway(`/${SHA}/manifest.json`, { headers, e: strict });
  assert.equal(none.res.status, 401);
  assert.equal(none.sent.length, 0);
  assert.equal(none.res.headers.get("X-MFA-Session"), "missing");
  assert.equal(none.res.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.equal(none.res.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.equal(none.res.headers.get("Cache-Control"), "no-store");

  const good = await gateway(`/${SHA}/manifest.json`, { headers: { ...headers, Cookie: `mfa_session=${value}` }, e: strict });
  assert.equal(good.res.status, 200);
  assert.equal(good.res.headers.get("X-MFA-Session"), "ok");
  assert.equal(good.res.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.equal(good.sent[0].headers.get("Cookie"), null, "the cookie never reaches the cached entrypoint");

  const moved = await gateway(`/${SHA}/manifest.json`, { headers: { ...headers, "CF-Connecting-IP": "203.0.113.41", Cookie: `mfa_session=${value}` }, e: strict });
  assert.equal(moved.res.status, 401);
  assert.equal(moved.res.headers.get("X-MFA-Session"), "invalid");

  const report = await gateway(`/${SHA}/manifest.json`, { headers, e: env() });
  assert.equal(report.res.status, 200);
  assert.equal(report.res.headers.get("X-MFA-Session"), "missing");

  const ref = await gateway("/ref", { headers, e: strict });
  assert.equal(ref.res.status, 401, "/ref needs a session too");
  const robots = await gateway("/robots.txt", { e: strict });
  assert.equal(robots.res.status, 200);
}

// The Release entrypoint never serves /session.
{
  const { res, calls } = await release("/session");
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
}

// Each data request is logged with its kind and session state, never an address.
{
  logged.length = 0;
  await gateway(`/${SHA}/manifest.json`, { headers: { Origin: SITE, "CF-Connecting-IP": "203.0.113.50" } });
  assert.deepEqual(JSON.parse(logged.at(-1)), { kind: "file", slice: false, session: "missing" });
  assert.ok(logged.every((line) => !line.includes("203.0.113.50")));
}

console.log("worker tests passed");
