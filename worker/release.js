// Logic for the mfa-data Worker, kept free of Workers-only imports so
// tests/worker.test.mjs can run it under Node. index.js wires it up.
//
// The release repository aimesy/mfa-data is private. The viewer reads it
// through this Worker at https://mfa-data.amyc.us/, whose URLs mirror GitHub's:
//   /<ref>/<path>                   a file in the repository (raw.githubusercontent.com)
//   /releases/download/<tag>/<name> a release asset; the release's PDFs live there
//   /ref                            the commit at main
//
// Two entrypoints:
//   gateway (default export, never cached): CORS preflight, the origin check
//     and the per-IP rate limit, then a clean request to the Release entrypoint.
//   release (the Release entrypoint, cached by Workers Caching): fetches the
//     file from GitHub with the read-only token and returns it with fresh headers.
// The cache sits in front of each entrypoint, so the gateway must stay
// uncached or a cache hit would skip the origin check and the rate limit.

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
const RETRY_AFTER_SECONDS = "60"; // the period of the RATE_LIMITER binding in wrangler.toml

const IMMUTABLE = "public, max-age=31536000, immutable";
const SHORT = "public, max-age=60";
// An asset can be replaced under its name, so it is kept a day, not a year.
const ASSET = "public, max-age=86400";
// The name to asset id map of one release, looked up on each asset miss.
const ASSET_MAP = "public, max-age=600";
const API_VERSION = "2022-11-28";
const NO_STORE = "no-store";

const CONTENT_TYPES = {
  pdf: "application/pdf",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  md: "text/plain; charset=utf-8",
};

const ROBOTS = "User-agent: *\nDisallow: /\n";

// Which file a path names: { kind: "robots" | "ref" | "file", ref, path },
// { kind: "asset", tag, name }, or null for anything the viewer would never ask for.
export function route(pathname) {
  if (pathname === "/robots.txt") return { kind: "robots" };
  if (pathname === "/ref") return { kind: "ref" };
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

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
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

// Default export. `release(request)` calls the cached Release entrypoint
// (ctx.exports.Release.fetch in index.js; a stub in the tests).
export async function handleGateway(request, env, release) {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === "/robots.txt" && (method === "GET" || method === "HEAD")) {
    return new Response(method === "HEAD" ? null : ROBOTS, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400", "X-Robots-Tag": "noindex" },
    });
  }

  const origins = allowedOrigins(env);
  const origin = callerOrigin(request, origins);

  if (method === "OPTIONS") {
    if (!origin) return plain(403, "Forbidden\n");
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin),
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  if (!origin) return plain(403, "Forbidden\n");
  if (method !== "GET" && method !== "HEAD") {
    return plain(405, "Method not allowed\n", { ...corsHeaders(origin), Allow: "GET, HEAD, OPTIONS", Vary: "Origin" });
  }

  if (env.RATE_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return plain(429, "Too many requests. Try again in a minute.\n", {
        ...corsHeaders(origin),
        "Retry-After": RETRY_AFTER_SECONDS,
        Vary: "Origin",
      });
    }
  }

  const target = route(url.pathname);
  if (!target || target.kind === "robots") return plain(404, "Not found\n", { ...corsHeaders(origin), Vary: "Origin" });

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
  if (!target || target.kind === "robots") return plain(404, "Not found\n");

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
