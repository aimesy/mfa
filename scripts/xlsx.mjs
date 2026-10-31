// A minimal reader for the worksheets of an .xlsx file: enough for the
// Department of Finance population tables scripts/population.mjs reads.
// Node only (zlib); no dependency. Cells come back as numbers, strings or
// booleans, empty cells as null; dates and formulas are read as their stored values.

import { inflateRawSync } from "node:zlib";

// The largest archive entry read, uncompressed (the DOF sheets are a few MB).
const MAX_ENTRY = 64 << 20;

// The files of a zip archive, by name, from its central directory.
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files.set(name, () => {
      if (usize > MAX_ENTRY) throw new Error(`${name}: ${usize} bytes uncompressed, over the ${MAX_ENTRY} byte limit`);
      return method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) }) : null;
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === "#"
  ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
  : ENTITIES[e] ?? m));
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
const text = (xml) => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

// "AB12" -> 27 (zero based column).
function colIndex(ref) {
  let c = 0;
  for (const ch of /^[A-Z]+/.exec(ref)[0]) c = c * 26 + ch.charCodeAt(0) - 64;
  return c - 1;
}

// { sheetName: rows } with each row an array of cells.
export function readXlsx(buf) {
  const files = unzip(buf);
  const read = (name) => {
    const f = files.get(name);
    if (!f) return "";
    const b = f();
    if (!b) throw new Error(`${name}: unsupported zip compression`);
    return b.toString("utf8");
  };
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => text(m[1]));
  const rels = new Map([...read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)]
    .map((m) => [attr(m[0], "Id"), attr(m[0], "Target")]));
  const out = {};
  for (const m of read("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)) {
    const target = rels.get(attr(m[0], "r:id")) || "";
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const rows = [];
    for (const r of read(path).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = attr(c[1], "t");
        const body = c[2] || "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value = null;
        if (type === "s") value = v === undefined ? null : shared[Number(v)];
        else if (type === "inlineStr") value = text(body);
        else if (type === "str" || type === "e") value = v === undefined ? null : decode(v);
        else if (type === "b") value = v === undefined ? null : v === "1";
        else if (v !== undefined) value = Number(v);
        row[colIndex(attr(c[1], "r"))] = value;
      }
      rows.push(Array.from(row, (x) => (x === undefined ? null : x)));
    }
    out[decode(attr(m[0], "name"))] = rows;
  }
  return out;
}
