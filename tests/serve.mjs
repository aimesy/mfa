// Static server with byte-range support, for trying the viewer against a
// local mfa-data checkout:
//
//   node site/tests/serve.mjs [root] [port]
//   open http://127.0.0.1:8765/site/?data=../
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

export function serve(root, port = 8765) {
  const base = path.resolve(root);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let file = path.join(base, decodeURIComponent(url.pathname));
    if (!file.startsWith(base)) {
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
  const root = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const port = Number(process.argv[3]) || 8765;
  await serve(root, port);
  console.log(`serving ${root} at http://127.0.0.1:${port}/site/?data=../`);
}
