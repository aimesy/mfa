// Static server with byte-range support, for trying the viewer against a
// local mfa-data checkout. It serves this repository at /mfa/ and the release
// at /mfa-data/, so the viewer reads it same-origin with ?data=../mfa-data/:
//
//   node tests/serve.mjs [mfa-data checkout] [port]
//   open http://127.0.0.1:8765/mfa/?data=../mfa-data/
//
// The release defaults to MFA_DATA_ROOT, then to an mfa-data checkout next to
// this repository.
//
// Python's http.server ignores Range, which would hide bugs in the viewer's
// range loader for large reports.

import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
};

export const VIEWER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_ROOT = path.resolve(process.env.MFA_DATA_ROOT || path.join(VIEWER_ROOT, "..", "mfa-data"));

// mounts: { "/mfa/": dir, ... }. Each URL prefix is served from its directory.
export function serve(mounts, port = 8765) {
  const roots = Object.entries(mounts).map(([prefix, dir]) => [prefix, path.resolve(dir)]);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (roots.some(([prefix]) => url.pathname === prefix.slice(0, -1))) {
      res.writeHead(301, { Location: `${url.pathname}/${url.search}` }).end();
      return;
    }
    const mount = roots.find(([prefix]) => url.pathname.startsWith(prefix));
    if (!mount) {
      res.writeHead(404).end("not found");
      return;
    }
    const [prefix, base] = mount;
    let file = path.join(base, decodeURIComponent(url.pathname.slice(prefix.length)));
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    let stat;
    try {
      stat = statSync(file);
      if (stat.isDirectory()) {
        file = path.join(file, "index.html");
        stat = statSync(file);
      }
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    const headers = {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || end < start) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${stat.size}` });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = path.resolve(process.argv[2] || DATA_ROOT);
  const port = Number(process.argv[3]) || 8765;
  await serve({ "/mfa/": VIEWER_ROOT, "/mfa-data/": data }, port);
  console.log(`serving ${VIEWER_ROOT} and ${data} at http://127.0.0.1:${port}/mfa/?data=../mfa-data/`);
}
