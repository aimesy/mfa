// Logic for the mfa-data Worker, kept free of Workers-only imports so
// tests/worker.test.mjs can run it under Node. index.js wires it up.
//
// The release repository aimesy/mfa-data is private. The viewer reads it
// through this Worker at https://mfa-data.amyc.us/, whose URLs mirror GitHub's:
//   /<ref>/<path>                   a file in the repository (raw.githubusercontent.com)
//   /releases/download/<tag>/<name> a release asset; the release's PDFs live there
//   /ref                            the commit at main
//   /session                        POST a Turnstile token; answers with a session cookie
//
// Two entrypoints:
//   gateway (default export, never cached): CORS preflight, the origin check,
//     the session check and the limits for each address, then a clean request
//     to the Release entrypoint.
//   release (the Release entrypoint, cached by Workers Caching): fetches the
//     file from GitHub with the read-only token and returns it with fresh headers.
// The cache sits in front of each entrypoint, so the gateway must stay
// uncached or a cache hit would skip the checks and the limits.

export const REPO = "aimesy/mfa-data";
export const BRANCH = "main";
// Copied from app.js; check-static.mjs fails if the two differ.
export const RELEASE_PATH = /^(?:(?:sources|evidence|data|docs)\/[A-Za-z0-9._\/-]+|manifest\.json|README\.md)$/;
// Release assets, as the CSVs list them after https://github.com/aimesy/mfa-data/.
// Copied from app.js; check-static.mjs fails if the two differ.
export const ASSET_PATH = /^releases\/download\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,200}\.pdf)$/;
const SHA = /^[0-9a-f]{40}$/;
const TAG = /^[A-Za-z0-9._-]{1,100}$/;
const USER_AGENT = "mfa-data-worker (+https://github.com/aimesy/mfa)";

const IMMUTABLE = "public, max-age=31536000, immutable";
const SHORT = "public, max-age=60";
// An asset can be replaced under its name, so it is kept a day, not a year.
const ASSET = "public, max-age=86400";
// The name to asset id map of one release, looked up on each asset miss.
const ASSET_MAP = "public, max-age=600";
const API_VERSION = "2022-11-28";
const NO_STORE = "no-store";

// Limits for each address (an IPv4 address, or an IPv6 /64). A "file" is a
// request without a byte range; a "slice" is one byte range of a file (the
// viewer reads big reports in 256 KB slices). Files and slices each have a
// limit a minute (FILE_LIMITER, SLICE_LIMITER in wrangler.toml); files have a
// daily cap (DAILY_FILE_LIMIT), toward which slices count by size.
const RETRY_AFTER_SECONDS = "60"; // the period of FILE_LIMITER and SLICE_LIMITER
const SLICE_UNIT = 4 * 1024 * 1024; // this many bytes of slices count as one file a day
const MAX_SLICE = 8 * 1024 * 1024; // a larger range counts as a whole file
const DEFAULT_DAILY_FILES = 1000;

// Sessions: the viewer passes Turnstile once, and the Worker sets a cookie
// bound to the visitor's address, good for SESSION_SECONDS. REQUIRE_SESSION
// "true" refuses data requests without one; otherwise the state is only
// reported in X-MFA-Session.
const SESSION_COOKIE = "mfa_session";
const SESSION_SECONDS = 12 * 60 * 60;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const CONTENT_TYPES = {
  pdf: "application/pdf",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  md: "text/plain; charset=utf-8",
};

const ROBOTS = "User-agent: *\nDisallow: /\n";

// Which file a path names: { kind: "robots" | "ref" | "session" | "file", ref, path },
// { kind: "asset", tag, name }, or null for anything the viewer would never ask for.
export function route(pathname) {
  if (pathname === "/robots.txt") return { kind: "robots" };
  if (pathname === "/ref") return { kind: "ref" };
  if (pathname === "/session") return { kind: "session" };
  if (pathname.startsWith("/releases/")) {
    const a = ASSET_PATH.exec(pathname.slice(1));
    return a && !pathname.includes("..") ? { kind: "asset", tag: a[1], name: a[2] } : null;
  }
  const m = /^\/([^/]+)\/(.+)$/.exec(pathname);
  if (!m) return null;
  const [, ref, path] = m;
  if (!(SHA.test(ref) || ref === BRANCH)) return null;
  if (!RELEASE_PATH.test(path) || path.includes("..")) return null;
  return { kind: "file", ref, path };
}

export function allowedOrigins(env) {
  return String(env?.ALLOWED_ORIGINS || "").split(/[\s,]+/).filter(Boolean);
}

// The calling page's origin: Origin when the browser sent one (every fetch()),
// else the origin of Referer (a PDF opened in a new tab). Null unless listed.
export function callerOrigin(request, origins) {
  const origin = request.headers.get("Origin");
  if (origin !== null) return origins.includes(origin) ? origin : null;
  const referer = request.headers.get("Referer");
  if (!referer) return null;
  try {
    const o = new URL(referer).origin;
    return origins.includes(o) ? o : null;
  } catch {
    return null;
  }
}

// The key limits and sessions are kept under: the IPv4 address, or the /64
// network of an IPv6 address (a household or phone can use any address in
// its /64, so counting each one separately would count nothing).
export function addressKey(ip) {
  const value = String(ip || "").trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  if (mapped) return mapped[1];
  if (!value.includes(":")) return value || "unknown";
  const [head, tail = ""] = value.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = value.includes("::") && tail ? tail.split(":") : [];
  const groups = value.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
}

// A single closed byte range no larger than MAX_SLICE is a slice of that
// size; anything else is a whole file.
export function requestShape(request) {
  const m = /^bytes=(\d+)-(\d+)$/.exec((request.headers.get("Range") || "").trim());
  if (m) {
    const size = Number(m[2]) - Number(m[1]) + 1;
    if (size > 0 && size <= MAX_SLICE) return { slice: true, size };
  }
  return { slice: false, size: 0 };
}

export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function secondsToMidnightUtc(now) {
  const d = new Date(now);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

// The daily count the DailyQuota Durable Object keeps for one address (one
// record, reset when the UTC day changes). Refused requests are not counted.
export function applyQuota(record, day, units, limit) {
  const used = record && record.day === day ? record.used : 0;
  if (used + units > limit) return { ok: false, record: { day, used } };
  return { ok: true, record: { day, used: used + units } };
}

const encoder = new TextEncoder();

async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(text)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function makeSession(key, address, now = Date.now()) {
  const exp = Math.floor(now / 1000) + SESSION_SECONDS;
  return `v1.${exp}.${await hmac(key, `v1.${exp}.${address}`)}`;
}

// "ok", "missing" or "invalid" (expired, forged, or from another address).
export async function sessionState(request, env, address, now = Date.now()) {
  const value = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!value) return "missing";
  const m = /^v1\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!env?.SESSION_KEY || !m || Number(m[1]) * 1000 < now) return "invalid";
  return sameString(await hmac(env.SESSION_KEY, `v1.${m[1]}.${address}`), m[2]) ? "ok" : "invalid";
}

function turnstileHostnames(env) {
  if (env?.TURNSTILE_HOSTNAMES) return String(env.TURNSTILE_HOSTNAMES).split(/[\s,]+/).filter(Boolean);
  return allowedOrigins(env).map((o) => {
    try {
      return new URL(o).hostname;
    } catch {
      return "";
    }
  }).filter(Boolean);
}

async function verifyTurnstile(token, ip, env, fetchImpl) {
  if (!env?.TURNSTILE_SECRET_KEY) return { ok: false, why: "not configured" };
  try {
    const res = await fetchImpl(SITEVERIFY, {
      method: "POST",
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
    });
    const out = await res.json();
    if (out.success === true && turnstileHostnames(env).includes(out.hostname)) return { ok: true };
    return { ok: false, why: (out["error-codes"] || []).join(" ") || `hostname ${out.hostname}` };
  } catch {
    return { ok: false, why: "Turnstile did not answer" };
  }
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, X-MFA-Session",
  };
}

function addVary(headers, name) {
  const vary = headers.get("Vary");
  if (!vary) headers.set("Vary", name);
  else if (!vary.split(",").some((v) => v.trim().toLowerCase() === name.toLowerCase())) headers.set("Vary", `${vary}, ${name}`);
}

function plain(status, text, headers = {}) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": NO_STORE,
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
      ...headers,
    },
  });
}

// POST /session: verify the Turnstile token and set the session cookie.
async function startSession(request, env, ip, address, cors, fetchImpl, now) {
  const token = (await request.text()).trim();
  if (!token || token.length > 2048) return plain(400, "Missing human check token\n", cors);
  if (!env.SESSION_KEY) return plain(503, "Sessions are not configured\n", cors);
  const check = await verifyTurnstile(token, ip, env, fetchImpl);
  if (!check.ok) return plain(403, `Human check failed: ${check.why}\n`, cors);
  const value = await makeSession(env.SESSION_KEY, address, now);
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      "Cache-Control": NO_STORE,
      "X-Robots-Tag": "noindex",
      "Set-Cookie": `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    },
  });
}

// Default export. `release(request)` calls the cached Release entrypoint
// (ctx.exports.Release.fetch in index.js; a stub in the tests).
// `quota(address, day, units, limit)` charges the daily cap (the DailyQuota
// Durable Object in index.js) and answers { ok }.
export async function handleGateway(request, env, { release, quota, fetchImpl = fetch, now = Date.now() } = {}) {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === "/robots.txt" && (method === "GET" || method === "HEAD")) {
    return new Response(method === "HEAD" ? null : ROBOTS, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400", "X-Robots-Tag": "noindex" },
    });
  }

  const origin = callerOrigin(request, allowedOrigins(env));

  if (method === "OPTIONS") {
    if (!origin) return plain(403, "Forbidden\n");
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin),
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Range",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  if (!origin) return plain(403, "Forbidden\n");
  const cors = { ...corsHeaders(origin), Vary: "Origin" };

  const target = route(url.pathname);
  const methods = target?.kind === "session" ? ["POST"] : ["GET", "HEAD"];
  if (!methods.includes(method)) return plain(405, "Method not allowed\n", { ...cors, Allow: [...methods, "OPTIONS"].join(", ") });

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const address = addressKey(ip);
  const shape = requestShape(request);

  const limiter = shape.slice ? env.SLICE_LIMITER : env.FILE_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: address });
    if (!success) return plain(429, "Too many requests. Try again in a minute.\n", { ...cors, "Retry-After": RETRY_AFTER_SECONDS });
  }

  if (!target || target.kind === "robots") return plain(404, "Not found\n", cors);
  if (target.kind === "session") return startSession(request, env, ip, address, cors, fetchImpl, now);

  const session = await sessionState(request, env, address, now);
  if (session !== "ok" && env.REQUIRE_SESSION === "true") {
    return plain(401, "Open the database at https://mfa.amyc.us; it checks that a person is reading.\n", { ...cors, "X-MFA-Session": session });
  }

  if (target.kind !== "ref" && quota) {
    const limit = Number(env.DAILY_FILE_LIMIT) || DEFAULT_DAILY_FILES;
    try {
      const { ok } = await quota(address, utcDay(now), shape.slice ? shape.size / SLICE_UNIT : 1, limit);
      if (!ok) {
        return plain(429, "This address has reached its daily limit. It resets at midnight UTC.\n", {
          ...cors,
          "Retry-After": String(secondsToMidnightUtc(now)),
        });
      }
    } catch (err) {
      // A counter that cannot be reached must not take the site down.
      console.error("daily quota unavailable", err);
    }
  }

  // A fresh request from the path alone: no query string (the cache key is
  // path plus query) and no headers but Range (Authorization or cookies would
  // make the cache bypass).
  const headers = {};
  const range = request.headers.get("Range");
  if (range) headers.Range = range;
  const res = await release(new Request(new URL(url.pathname, url.origin), { method, headers }));

  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v);
  addVary(out.headers, "Origin");
  out.headers.set("X-Robots-Tag", "noindex");
  out.headers.set("X-MFA-Session", session);
  return out;
}

function upstreamHeaders(env, extra = {}) {
  const headers = { "User-Agent": USER_AGENT, ...extra };
  // Absent in local development while the repository was public.
  if (env?.MFA_DATA_TOKEN) headers.Authorization = `Bearer ${env.MFA_DATA_TOKEN}`;
  return headers;
}

function contentType(path) {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

// Turns GitHub's answer for one file into the Worker's: fresh headers only.
function fileResponse(res, path, cacheControl, method) {
  if (res.status === 404 || res.status === 410) return plain(404, "Not found\n");
  if (res.status === 416) {
    const cr = res.headers.get("Content-Range");
    return plain(416, "Range not satisfiable\n", cr ? { "Content-Range": cr } : {});
  }
  if (res.status !== 200 && res.status !== 206) return plain(502, `GitHub answered ${res.status}\n`);

  const type = contentType(path);
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  });
  const etag = res.headers.get("ETag");
  if (etag) headers.set("ETag", etag);
  // The runtime decodes a gzip body, so the upstream length would be wrong.
  const length = res.headers.get("Content-Length");
  if (length && !res.headers.get("Content-Encoding")) headers.set("Content-Length", length);
  if (res.status === 206) {
    const cr = res.headers.get("Content-Range");
    if (cr) headers.set("Content-Range", cr);
  }
  if (type !== "application/pdf") headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  return new Response(method === "HEAD" ? null : res.body, { status: res.status, headers });
}

function json(status, body, cacheControl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": cacheControl, "X-Content-Type-Options": "nosniff" },
  });
}

// Internal (never routed by the gateway): name -> asset id for one release,
// from the API, so an asset miss costs one cached lookup, not a page walk.
async function assetMap(tag, env, fetchImpl) {
  const headers = upstreamHeaders(env, { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION });
  try {
    const rel = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, { headers });
    if (rel.status === 404) return json(404, { error: "no such release" }, NO_STORE);
    if (!rel.ok) return json(502, { error: `GitHub answered ${rel.status}` }, NO_STORE);
    const { id } = await rel.json();
    const ids = {};
    for (let page = 1; page <= 30; page++) {
      const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/${id}/assets?per_page=100&page=${page}`, { headers });
      if (!res.ok) return json(502, { error: `GitHub answered ${res.status}` }, NO_STORE);
      const assets = await res.json();
      for (const a of assets) ids[a.name] = a.id;
      if (assets.length < 100) break;
    }
    return json(200, ids, ASSET_MAP);
  } catch {
    return json(502, { error: "GitHub did not answer" }, NO_STORE);
  }
}

// GitHub hands an asset out through a short-lived signed URL on its own hosts.
function signedAssetUrl(location) {
  try {
    const u = new URL(location);
    return u.protocol === "https:" && /(^|\.)(githubusercontent\.com|github\.com)$/.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

async function assetResponse(request, target, env, fetchImpl, lookup) {
  let ids;
  try {
    ids = await lookup(target.tag);
  } catch {
    ids = undefined;
  }
  if (ids === null) return plain(404, "Not found\n");
  if (!ids) return plain(502, "Could not list the release's assets\n");
  const id = Object.hasOwn(ids, target.name) ? ids[target.name] : null;
  if (!Number.isInteger(id)) return plain(404, "Not found\n");

  const extra = {};
  const range = request.headers.get("Range");
  if (range) extra.Range = range;
  let res;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/assets/${id}`, {
      headers: upstreamHeaders(env, { Accept: "application/octet-stream", "X-GitHub-Api-Version": API_VERSION, ...extra }),
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const signed = signedAssetUrl(res.headers.get("Location"));
      if (!signed) return plain(502, "GitHub sent the asset somewhere unexpected\n");
      // The signed URL carries its own authorization; the token must not follow it.
      res = await fetchImpl(signed, { method: request.method === "HEAD" ? "HEAD" : "GET", headers: { "User-Agent": USER_AGENT, ...extra } });
    }
  } catch {
    return plain(502, "GitHub did not answer\n");
  }
  return fileResponse(res, target.name, ASSET, request.method);
}

// Release entrypoint. Fetches one file, one release asset, or the commit at
// main from GitHub. `lookup(tag)` answers a release's name -> id map (null if
// there is no such release); index.js routes it through the cached /_assets/<tag>.
export async function handleRelease(request, env, fetchImpl = fetch, lookup = async () => undefined) {
  const url = new URL(request.url);

  const internal = /^\/_assets\/([^/]+)$/.exec(url.pathname);
  if (internal) return TAG.test(internal[1]) ? assetMap(internal[1], env, fetchImpl) : plain(404, "Not found\n");

  const target = route(url.pathname);
  if (!target || target.kind === "robots" || target.kind === "session") return plain(404, "Not found\n");

  if (target.kind === "ref") {
    let res;
    try {
      res = await fetchImpl(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
        headers: upstreamHeaders(env, { Accept: "application/vnd.github.sha", "X-GitHub-Api-Version": API_VERSION }),
      });
    } catch {
      return plain(502, "GitHub did not answer\n");
    }
    const sha = res.ok ? (await res.text()).trim() : "";
    if (!SHA.test(sha)) return plain(502, `GitHub answered ${res.status} for ${BRANCH}\n`);
    return new Response(sha, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": SHORT,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }

  if (target.kind === "asset") return assetResponse(request, target, env, fetchImpl, lookup);

  const extra = {};
  const range = request.headers.get("Range");
  if (range) extra.Range = range;
  let res;
  try {
    res = await fetchImpl(`https://raw.githubusercontent.com/${REPO}/${target.ref}/${target.path}`, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: upstreamHeaders(env, extra),
    });
  } catch {
    return plain(502, "GitHub did not answer\n");
  }
  return fileResponse(res, target.path, SHA.test(target.ref) ? IMMUTABLE : SHORT, request.method);
}
