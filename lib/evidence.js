// Loads release PDFs with pdf.js, checks their bytes against the SHA-256 the
// release records, and maps each figure's recorded outline onto the page.

const VENDOR = new URL("../vendor/pdfjs-4.10.38/", import.meta.url);

// Originals above this size are read by byte range, so opening one page of an
// 80 MB report does not download the whole report. Their hash can still be
// checked on request by downloading the full file.
export const RANGE_THRESHOLD = 12 * 1024 * 1024;
const RANGE_CHUNK = 256 * 1024;

// outline_rect_pdf_points is [x0, y0, x1, y1] in MuPDF page coordinates: the
// unrotated page, origin at the CropBox's top-left corner, y growing down.
// pdf.js wants PDF user space: origin bottom-left, y growing up. `view` is
// pdf.js's page.view, the CropBox in user space.
export function outlineToPdfRect(view, rect) {
  const [vx0, , , vy1] = view;
  const [x0, y0, x1, y1] = rect;
  return [vx0 + x0, vy1 - y1, vx0 + x1, vy1 - y0];
}

// Box in viewport pixels for a recorded outline. The viewport carries scale
// and the page's /Rotate, so rotated pages come out right.
export function outlineBox(viewport, view, rect) {
  const [a, b, c, d] = viewport.convertToViewportRectangle(outlineToPdfRect(view, rect));
  return { left: Math.min(a, c), top: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b) };
}

let pdfjsPromise = null;
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(new URL("pdf.min.mjs", VENDOR).href).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", VENDOR).href;
      return lib;
    });
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

const DOC_OPTIONS = {
  isEvalSupported: false,
  enableXfa: false,
  standardFontDataUrl: new URL("standard_fonts/", VENDOR).href,
  cMapUrl: new URL("cmaps/", VENDOR).href,
  cMapPacked: true,
};

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readBody(res, onProgress, expectedBytes) {
  if (!res.body || !onProgress) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, expectedBytes || 0);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

export async function fetchVerified(url, expectedSha256, { onProgress, bytes } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} reading ${url}`);
  const buf = await readBody(res, onProgress, bytes);
  const hash = await sha256Hex(buf);
  let status = "unchecked";
  if (expectedSha256) status = hash === expectedSha256.toLowerCase() ? "match" : "mismatch";
  return { buf, verification: { status, hash, expected: expectedSha256 || "", bytes: buf.byteLength } };
}

function rangeTransport(lib, url, length, onError) {
  class Transport extends lib.PDFDataRangeTransport {
    requestDataRange(begin, end) {
      fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } })
        .then(async (res) => {
          if (res.status === 206) return new Uint8Array(await res.arrayBuffer());
          if (res.ok) return new Uint8Array(await res.arrayBuffer()).slice(begin, end);
          throw new Error(`HTTP ${res.status} reading bytes ${begin}-${end - 1} of ${url}`);
        })
        .then((chunk) => this.onDataRange(begin, chunk))
        .catch(onError);
    }
  }
  return new Transport(length, null);
}

// A small LRU of open documents so paging through figures on the same report
// does not refetch it.
const MAX_DOCS = 6;
const docs = new Map();

function remember(key, promise) {
  docs.set(key, promise);
  promise.catch(() => docs.delete(key));
  while (docs.size > MAX_DOCS) {
    const [oldKey, old] = docs.entries().next().value;
    docs.delete(oldKey);
    old.then((d) => d.doc.destroy()).catch(() => {});
  }
  return promise;
}

export function openPdf(url, { sha256 = "", bytes = 0, onProgress } = {}) {
  if (docs.has(url)) {
    const hit = docs.get(url);
    docs.delete(url);
    docs.set(url, hit);
    return hit;
  }
  const promise = (async () => {
    const lib = await loadPdfjs();
    if (bytes > RANGE_THRESHOLD) {
      let fail;
      const failed = new Promise((_, reject) => { fail = reject; });
      failed.catch(() => {});
      const task = lib.getDocument({
        ...DOC_OPTIONS,
        range: rangeTransport(lib, url, bytes, (err) => fail(err)),
        rangeChunkSize: RANGE_CHUNK,
        disableAutoFetch: true,
        disableStream: true,
      });
      const doc = await Promise.race([task.promise, failed]);
      return { doc, failed, verification: { status: "partial", expected: sha256, bytes } };
    }
    const { buf, verification } = await fetchVerified(url, sha256, { onProgress, bytes });
    const doc = await lib.getDocument({ ...DOC_OPTIONS, data: new Uint8Array(buf) }).promise;
    return { doc, failed: null, verification };
  })();
  return remember(url, promise);
}

// Does the recorded rectangle sit on the red outline drawn in the figure's
// evidence file? The drawn outline is what the reviewers looked at; the
// rectangle is metadata about it. Where the two disagree (a handful of rotated
// pages record the rectangle in rotated coordinates), the viewer must not draw
// a box from the rectangle, so it checks before it draws.
export const OUTLINE_SCALE = 3;
// A side counts as outlined where red ink runs along it; corner-tick outlines
// cover little of each side, a full rectangle nearly all of it.
export const OUTLINE_MIN_SIDE = 0.1;
const OUTLINE_PAD = 12;
const OUTLINE_REACH = 7;
const outlineChecks = new Map();

// Red, including the pink an anti-aliased hairline renders as; not black,
// grey or yellow ink.
export function isOutlineRed(r, g, b) {
  return r > 170 && r - Math.max(g, b) > 45;
}

// Fraction of each side of the mapped box ([top, right, bottom, left]) with
// red ink within OUTLINE_REACH pixels of it.
export async function measureOutline(page, rect) {
  const viewport = page.getViewport({ scale: OUTLINE_SCALE });
  const box = outlineBox(viewport, page.view, rect);
  const x0 = Math.max(0, Math.floor(box.left - OUTLINE_PAD));
  const y0 = Math.max(0, Math.floor(box.top - OUTLINE_PAD));
  const x1 = Math.min(Math.floor(viewport.width), Math.ceil(box.left + box.width + OUTLINE_PAD));
  const y1 = Math.min(Math.floor(viewport.height), Math.ceil(box.top + box.height + OUTLINE_PAD));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return [0, 0, 0, 0];
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -x0, -y0] }).promise;
  const px = ctx.getImageData(0, 0, w, h).data;
  const red = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const k = (y * w + x) * 4;
    return isOutlineRed(px[k], px[k + 1], px[k + 2]);
  };
  const bx0 = Math.round(box.left - x0);
  const by0 = Math.round(box.top - y0);
  const bx1 = Math.round(box.left + box.width - x0);
  const by1 = Math.round(box.top + box.height - y0);
  const run = (from, to, hit) => {
    let n = 0;
    let len = 0;
    for (let t = from; t <= to; t += 1) {
      len += 1;
      for (let d = -OUTLINE_REACH; d <= OUTLINE_REACH; d += 1) {
        if (hit(t, d)) {
          n += 1;
          break;
        }
      }
    }
    return len ? n / len : 0;
  };
  return [
    run(bx0, bx1, (x, d) => red(x, by0 + d)),
    run(by0, by1, (y, d) => red(bx1 + d, y)),
    run(bx0, bx1, (x, d) => red(x, by1 + d)),
    run(by0, by1, (y, d) => red(bx0 + d, y)),
  ];
}

// Ink along both of a pair of opposite sides, or along three sides. Corner
// ticks and loose boxes pass; a box landing elsewhere on the page, or one row
// off (touching the real outline along a single edge), does not.
export function outlineAgrees(sides) {
  const [top, right, bottom, left] = sides.map((c) => c >= OUTLINE_MIN_SIDE);
  return (top && bottom) || (left && right) || [top, right, bottom, left].filter(Boolean).length >= 3;
}

// At most a few evidence files are fetched at once when a busy page asks for
// every figure on it to be checked.
const CHECK_CONCURRENCY = 4;
const CHECK_TIMEOUT_MS = 30000;
let checksRunning = 0;
const checkQueue = [];

function limited(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      checksRunning += 1;
      task().then(resolve, reject).finally(() => {
        checksRunning -= 1;
        checkQueue.shift()?.();
      });
    };
    if (checksRunning < CHECK_CONCURRENCY) run();
    else checkQueue.push(run);
  });
}

export function checkOutline(url, rect, { sha256 = "", bytes = 0 } = {}) {
  const key = `${url}#${rect.join(",")}`;
  if (outlineChecks.has(key)) return outlineChecks.get(key);
  const promise = limited(async () => {
    const lib = await loadPdfjs();
    let entry = docs.has(url) ? await docs.get(url).catch(() => null) : null;
    let doc = entry?.doc;
    let own = false;
    if (!doc) {
      const { buf } = await fetchVerified(url, sha256, { bytes });
      doc = await lib.getDocument({ ...DOC_OPTIONS, data: new Uint8Array(buf) }).promise;
      own = true;
    }
    try {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("outline check timed out")), CHECK_TIMEOUT_MS);
      });
      const sides = await Promise.race([measureOutline(await doc.getPage(1), rect), timeout]).finally(() => clearTimeout(timer));
      return { agrees: outlineAgrees(sides), sides };
    } finally {
      if (own) doc.destroy();
    }
  });
  promise.catch(() => outlineChecks.delete(key));
  outlineChecks.set(key, promise);
  return promise;
}

// Replace a range-loaded document's "partial" status with a full-file check.
export async function verifyWholeFile(url, sha256, bytes, onProgress) {
  const { verification } = await fetchVerified(url, sha256, { onProgress, bytes });
  const hit = docs.get(url);
  if (hit) hit.then((d) => { d.verification = verification; }).catch(() => {});
  return verification;
}
