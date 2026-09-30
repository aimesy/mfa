// RFC 4180 CSV parser. The release CSVs quote fields that carry commas,
// quotes and line breaks (arithmetic_check and source_limitations do), so a
// line-splitting reader would misread them.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let quoted = false;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseCsvObjects(text) {
  const [header, ...body] = parseCsv(text);
  if (!header) return { columns: [], rows: [] };
  const rows = [];
  for (const cells of body) {
    if (cells.length === 1 && cells[0] === "") continue;
    if (cells.length !== header.length) {
      throw new Error(`CSV row ${rows.length + 2} has ${cells.length} fields; header has ${header.length}`);
    }
    const obj = {};
    for (let c = 0; c < header.length; c += 1) obj[header[c]] = cells[c];
    rows.push(obj);
  }
  return { columns: header, rows };
}

export function toCsv(columns, rows) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
