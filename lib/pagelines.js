// Names the numbers in a bare equation ("20,682,234 + 36,637,032 + 577,716 -
// 12,226,455 = 45,670,527") from the page they were read from: each amount
// takes the words printed before it on its own line of the page's text layer.
// An amount the page does not print under exactly one name gets no name.

const MONEY = /^\(?-?\$?\(?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?$/;
const LETTERS = /[A-Za-z]{2}/;

function moneyValue(text) {
  const t = text.replace(/\$/g, "");
  if (!MONEY.test(text) || !/\d/.test(t)) return null;
  const open = t.startsWith("(");
  if (open !== t.endsWith(")")) return null;
  const v = Number(t.replace(/[(),-]/g, ""));
  return Number.isFinite(v) ? v : null;
}

// pdf.js text items -> [{ value, label, perp, a0, a1, dir }]: every amount
// printed on the page, with the nearest run of words before it on its line.
export function readPageLines(items) {
  const words = [];
  for (const it of items || []) {
    const s = it.str || "";
    if (!s.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    const len = Math.hypot(a, b);
    if (!len) continue;
    const dx = a / len;
    const dy = b / len;
    const size = Math.hypot(c, d) || len;
    const along = e * dx + f * dy;
    const perp = f * dx - e * dy;
    const per = (it.width || 0) / s.length;
    for (const m of s.matchAll(/\S+/g)) {
      if (m[0] === "$") continue;
      words.push({ text: m[0], dir: `${Math.round(dx * 100)},${Math.round(dy * 100)}`, perp, size, a0: along + m.index * per, a1: along + (m.index + m[0].length) * per, item: it });
    }
  }
  const out = [];
  const byDir = new Map();
  for (const w of words) (byDir.get(w.dir) || byDir.set(w.dir, []).get(w.dir)).push(w);
  for (const [dir, ws] of byDir) {
    ws.sort((x, y) => x.perp - y.perp);
    const rows = [];
    for (const w of ws) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(w.perp - row.perp) < 0.4 * Math.max(w.size, row.size)) row.words.push(w);
      else rows.push({ perp: w.perp, size: w.size, words: [w] });
    }
    rows.forEach((row, at) => {
      // Runs of words; an amount is always a run of its own.
      const runs = [];
      for (const w of row.words.sort((x, y) => x.a0 - y.a0)) {
        const value = moneyValue(w.text);
        const run = runs[runs.length - 1];
        if (value == null && run && run.value == null && w.a0 - run.a1 < 0.6 * row.size) {
          // Pieces of one word printed as separate items ("Expen" "ditur" "es").
          run.text += w.item !== run.item && w.a0 - run.a1 < 0.12 * row.size ? w.text : ` ${w.text}`;
          run.a1 = w.a1;
          run.item = w.item;
        } else {
          runs.push({ text: w.text, value, a0: w.a0, a1: w.a1, item: w.item });
        }
      }
      row.runs = runs;
      runs.forEach((r, i) => {
        if (r.value == null) return;
        let name = null;
        let k = i - 1;
        while (k >= 0 && !isName(runs[k])) k -= 1;
        if (k >= 0) {
          // "TOTAL  REVENUE": words a wide space apart are still one name.
          name = { ...runs[k] };
          for (k -= 1; k >= 0 && isName(runs[k]) && name.a0 - runs[k].a1 < 2.5 * row.size; k -= 1) {
            name.text = `${runs[k].text} ${name.text}`;
            name.a0 = runs[k].a0;
          }
        }
        // Words over the name on the line just before it, with no amount of
        // their own, may be the first half of a wrapped name ("REVENUES OVER
        // (UNDER)" / "EXPENDITURES") or a heading; either way it is not read.
        const prev = rows[at + 1];
        const wraps = Boolean(name && prev && prev.perp - row.perp < 1.8 * row.size && prev.words.every((w) => moneyValue(w.text) == null)
          && prev.words.some((w) => w.a0 < name.a1 && name.a0 < w.a1));
        out.push({ value: r.value, label: name ? cleanPageLabel(name.text) : "", wraps, perp: row.perp, a0: r.a0, a1: r.a1, dir });
      });
    });
  }
  return out;
}

// "435-2600-0000-xxxx" is an account code, not a name.
const isName = (run) => run.value == null && LETTERS.test(run.text.replace(/\b[\dx]+(?:-[\dx]+)+\b/gi, ""));

function cleanPageLabel(text) {
  return text.replace(/[.…_]{3,}/g, " ").replace(/\s+/g, " ").replace(/^[\s:–-]+|[\s:–-]+$/g, "").trim();
}

const same = (x, y) => Math.abs(Math.abs(x) - Math.abs(y)) < 0.005;
const overlaps = (x, y) => x.dir === y.dir && x.a0 < y.a1 && y.a0 < x.a1;
const words = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const sameName = (x, y) => {
  const a = words(x || "");
  const b = words(y || "");
  return Boolean(a && b) && (a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `));
};

// A name cut off by a line break ("Balance as of June 30,"), letter-spaced
// ("Beg inn i n g"), or not a name at all is not read.
function wholeName(label) {
  if (!label || !/^[A-Z0-9(]/.test(label) || !LETTERS.test(label)) return false;
  if (/[,(&/–-]$|\b(?:of|as of|to|and|the|for|from|at|in|on|july|june|beginning|ending)$/i.test(label)) return false;
  if ((label.match(/\(/g) || []).length !== (label.match(/\)/g) || []).length) return false;
  const tokens = label.split(" ");
  return tokens.filter((t) => t.length === 1 && /[a-z]/i.test(t)).length * 3 <= tokens.length;
}

// The figure's own amount on the page, where the page prints it once, under
// the name the release records for it: the column its ledger's lines are in.
export function figureColumn(lines, value, label) {
  if (value == null) return null;
  const own = lines.filter((l) => same(l.value, value));
  return own.length === 1 && sameName(own[0].label, label) ? own[0] : null;
}

// -> one name per amount, or null. Every amount must be printed in the
// figure's column, on its own line, under one whole name; no two share a name.
export function namesFromPage(lines, column, values) {
  if (!column) return null;
  const picks = [];
  for (const v of values) {
    if (v == null) return null;
    const hits = lines.filter((l) => same(l.value, v) && overlaps(l, column));
    if (!hits.length || new Set(hits.map((h) => h.label)).size !== 1 || hits.some((h) => h.wraps) || !wholeName(hits[0].label)) return null;
    picks.push(hits[0]);
  }
  const names = picks.map((p) => p.label);
  if (new Set(names.map(words)).size !== names.length) return null;
  return names;
}
