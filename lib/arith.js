// Reads an arithmetic_check note into equations: the printed lines, whether
// each is added or taken away, and the printed total they reach. An equation
// whose amounts are all given is kept only when they do reach its total, so a
// note this reader gets wrong is shown in the release's own words instead. A
// printed dash stays a dash: it is left out of the sum and never shown as zero.

const DASH = "‒";
const MONTH = /(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s*$/i;
const NUM = /(?<![\w/.,$-])(\()?(-)?(\$)?\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(\))?(?![\d/%]|,\d{3}|\.\d)|‒/g;
const RESULT = /\s(?:=|gives?|adds?(?: up)? to|sums? to|totals?|equals?|is|are|comes? to)\s/g;
const OPERATOR = /(?:^|\s)(\+|plus|less|minus|with|and outgoings of|outgoings of|(?<=[\d)]\s)-)(?=\s)/g;
const REFERENCE = /^(?:that|this)(?: year's)?(?: (?:total|figure|net|revenue|revenues|sum|subtotal|net change))?$/i;
const OPEN_TOTAL = /^(?:[a-z]+ )?total$/i;
const NARRATION = /\b(?:gives?|adds?|equals?|is|are|was|prints?|printed as|which|shows?|reads?|confirms?)\b|[;:"“]/;

// A dash printed in a cell ("Interest Income -") is a value, not a minus sign.
function markDashes(text) {
  return text.replace(/(?<=[A-Za-z]\)?)\s[-–—](?=\s*(?:[,;.=+]|$)|\s(?:and|plus|less|minus|with|gives?|is|[-–])\s)/g, ` ${DASH}`);
}

function amountsIn(text) {
  const out = [];
  for (const m of text.matchAll(NUM)) {
    if (m[0] === DASH) {
      out.push({ start: m.index, end: m.index + 1, value: null, shown: "–" });
      continue;
    }
    const [whole, open, neg, dollar, digits, close] = m;
    if (Boolean(open) !== Boolean(close)) continue;
    if (!open && !neg && !dollar && !/[.,]/.test(digits)) {
      const n = Number(digits);
      const before = text.slice(0, m.index);
      if ((n >= 1900 && n <= 2099) || MONTH.test(before) || /\bFY\s*$/i.test(before)) continue;
      // "Fees collected 0 +" is a cell; "its 11 expenditure lines" and "[1]" are not.
      if (n < 100 && !(/[A-Za-z)]\s$/.test(before) && /^(?:\s*(?:[+=;,)]|\.(?:\s|$)|$)|\s(?:plus|less|minus|and|with|gives?|is|are|-)\s)/.test(text.slice(m.index + whole.length)))) continue;
    }
    let value = Number(digits.replace(/,/g, ""));
    if (open || neg) value = -value;
    const shown = `${open ? "(" : ""}${neg ? "-" : ""}${digits}${close ? ")" : ""}`;
    out.push({ start: m.index, end: m.index + whole.length, value, shown });
  }
  return out;
}

function cleanLabel(text) {
  let s = text.replace(/\s+/g, " ").trim();
  let prev;
  do {
    prev = s;
    s = s
      .replace(/^[,;:.\s]+/, "")
      .replace(/^[-–]\s+/, "")
      .replace(/^[a-z]\d*[.)]?\s+(?=[A-Z])/, "")
      .replace(/^(?:and|then|so|the|its|their|this|these|those|a|an|of|own|printed|as|each|every|column's|row's|fund's|page's|block's|ledger's|report's|table's)\s+/i, "")
      .replace(/[,;:(\s]+$/, "")
      .replace(/\s+(?:of|was|is|and)$/i, "");
  } while (s !== prev);
  s = s.replace(/^\$\s*/, "");
  // "the four programs' fees, General Administration": narration, then the line.
  if (/^[a-z]/.test(s) && s.includes(", ")) s = s.slice(s.lastIndexOf(", ") + 2);
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

function cleanEnough(label) {
  return label && label.length <= 70 && !NARRATION.test(label);
}

// One side of an equation: "Fees 30,000 + Interest 35,879", read against the
// amounts earlier equations in the note already named (`known`).
function readTerms(text, known) {
  const parts = [];
  let op = "+";
  let from = 0;
  for (const m of text.matchAll(OPERATOR)) {
    parts.push({ op, text: text.slice(from, m.index) });
    op = /^(?:\+|plus|with)$/.test(m[1]) ? "+" : "−";
    from = m.index + m[0].length;
  }
  parts.push({ op, text: text.slice(from) });

  const terms = [];
  for (const part of parts) {
    const amounts = amountsIn(part.text);
    let at = 0;
    for (const a of amounts) {
      const raw = part.text.slice(at, a.start);
      let label = cleanLabel(raw);
      if (!label && a.value != null && known.has(a.value)) label = known.get(a.value);
      if (!cleanEnough(label)) return null;
      // "less Expenditures (592,607)" is shown as the bracketed cell it is, added.
      const op = part.op === "−" && a.value < 0 ? "+" : part.op;
      terms.push({ op, label, amount: a.shown, value: a.value, out: part.op === "−" });
      at = a.end;
      // "18,552 (Fund Balance, Beginning of Year)" names the printed line.
      const alias = /^\s*\(([^()]*[A-Za-z][^()]*)\)/.exec(part.text.slice(at));
      if (alias) {
        const printed = cleanLabel(alias[1]);
        if (cleanEnough(printed)) terms[terms.length - 1].label = printed;
        at += alias[0].length;
      }
    }
    const rest = cleanLabel(part.text.slice(at).replace(/,?\s*which\b.*$/i, ""));
    if (!rest) {
      if (!amounts.length && terms.length) return null;
      continue;
    }
    if (amounts.length) return null;
    if (REFERENCE.test(rest) && known.last) terms.push({ op: part.op, ...known.last });
    else if (OPEN_TOTAL.test(rest)) terms.push({ op: part.op, label: rest, amount: "", value: undefined });
    else return null;
  }
  return terms.length ? terms : null;
}

function closes(terms, total) {
  let sum = 0;
  let cents = false;
  for (const t of terms) {
    if (t.value == null) continue;
    // "less Expenditures (592,607)": the brackets are how the report prints an outflow.
    sum += t.op === "−" ? -Math.abs(t.value) : t.value;
    if (/\.\d/.test(t.amount)) cents = true;
  }
  // Whole-dollar reports round each line, so their totals can differ by $1.
  return Math.abs(sum - total.value) <= (cents ? 0.011 : 1);
}

// "LHS gives the printed Total 65,879" or "LHS = 65,879, the printed Total".
function readEquation(clause, known) {
  for (const m of clause.matchAll(RESULT)) {
    const rhs = clause.slice(m.index + m[0].length);
    const found = amountsIn(rhs);
    if (!found.length || found[0].value == null) continue;
    const a = found[0];
    let label = cleanLabel(rhs.slice(0, a.start));
    const after = rhs.slice(a.end).replace(/^,?\s*(?:the\s+)?printed\s+/i, " ");
    if (!label) label = cleanLabel(after.split(/[,;]|\.\s/)[0]);
    if (!cleanEnough(label)) continue;
    const total = { label, amount: a.shown, value: a.value };

    let lhs = clause.slice(0, m.index);
    const firstAmount = amountsIn(lhs)[0];
    const head = firstAmount ? lhs.slice(0, firstAmount.start) : lhs;
    const colon = head.lastIndexOf(": ");
    if (colon >= 0) lhs = lhs.slice(colon + 2);
    if (!amountsIn(lhs).length) {
      // "its revenue lines give the printed revenue total of 1,184": a total
      // without its lines, which a later "that total" may refer to.
      const lines = /\b([a-z]+) lines\b/.exec(lhs);
      if (/^total$/i.test(label) && lines) total.label = `Total ${lines[1]}s`;
      return { total, terms: [] };
    }
    const terms = readTerms(lhs, known);
    if (!terms) continue;
    const given = terms.filter((t) => t.value !== undefined);
    if (!given.some((t) => t.value != null)) continue;
    if (given.length === terms.length ? !closes(terms, total) : terms.length < 2) continue;
    return { total, terms };
  }
  return null;
}

// "A (2,455,621), B 98,322, C 92,903, D (39,561), Ending E (2,303,957)": a
// printed row listed in order, kept as an equation only when it closes.
function readRow(clause) {
  const text = clause.replace(/^[^:]*:\s+/, "");
  const amounts = amountsIn(text);
  if (amounts.length < 4) return null;
  const terms = [];
  let at = 0;
  for (const a of amounts) {
    const label = cleanLabel(text.slice(at, a.start));
    if (!cleanEnough(label) || /\b(?:plus|less|with|minus)\b|[+=]/.test(text.slice(at, a.start))) return null;
    terms.push({ op: "+", label, amount: a.shown, value: a.value });
    at = a.end;
  }
  if (cleanLabel(text.slice(at))) return null;
  const { label, amount, value } = terms.pop();
  const total = { label, amount, value };
  if (!/\b(?:end|ending|closing)\b/i.test(label) || value == null) return null;
  if (closes(terms, total)) return [{ terms, total }];
  // "..., Total Revenue 687,324, ..." is a subtotal of the lines before it.
  const i = terms.findIndex((t, k) => k >= 3 && /^total\b/i.test(t.label) && t.value != null && closes(terms.slice(1, k), t));
  if (i < 0) return null;
  const sub = terms[i];
  const outer = [terms[0], sub, ...terms.slice(i + 1)];
  if (!closes(outer, total)) return null;
  return [{ terms: terms.slice(1, i), total: { label: sub.label, amount: sub.amount, value: sub.value } }, { terms: outer, total }];
}

// "The printed Total Revenues of 2,055 is the sum of the inflows printed above it."
function readInflows(clause, prev) {
  const m = /^The printed (.+?) of (.+?) is the sum of the inflows printed above it\.?$/.exec(clause);
  if (!m || !prev) return null;
  const found = amountsIn(m[2]);
  if (found.length !== 1 || found[0].value == null) return null;
  const terms = prev.terms.slice(1).filter((t) => !t.out && t.value !== undefined).map((t) => ({ ...t, op: "+" }));
  const total = { label: cleanLabel(m[1]), amount: found[0].shown, value: found[0].value };
  return terms.length >= 2 && closes(terms, total) ? { terms, total } : null;
}

// A bare list of printed cells: "opening 611,923; DIF Fees 139,895; ...".
function readCell(clause) {
  const text = clause.replace(/^[^:]*:\s+(?=[^:]*$)/, "");
  const amounts = amountsIn(text);
  if (amounts.length !== 1) return null;
  const a = amounts[0];
  if (cleanLabel(text.slice(a.end))) return null;
  const label = cleanLabel(text.slice(0, a.start));
  if (!cleanEnough(label) || label.split(" ").length > 6) return null;
  return { op: "", label, amount: a.shown, value: a.value };
}

// Splits at "; " and at sentence ends, but not after "Beg." or "D.I.F.".
function sentences(text) {
  const out = [];
  let start = 0;
  const s = String(text || "").replace(/[\u00a0\u2009]/g, " ");
  for (const m of s.matchAll(/;\s+|\.\s+(?=[A-Z("“])/g)) {
    if (m[0][0] === "." && /(?:\b[A-Z][a-z]{0,3}|\b[A-Za-z]|\.[A-Z])$/.test(s.slice(start, m.index))) continue;
    out.push(s.slice(start, m.index + (m[0][0] === "." ? 1 : 0)));
    start = m.index + m[0].length;
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim().replace(/^and\s+/, "")).filter(Boolean);
}

// -> { groups: [{ terms, total? }], notes: [string] }. A group is an equation,
// or a run of printed cells the note lists without adding them up. Notes are
// the sentences this reader could not put in a group, in the release's words.
export function readArithmetic(text) {
  const items = [];
  const known = new Map();
  let cells = null;
  for (const raw of sentences(text)) {
    const s = markDashes(raw);
    const prev = [...items].reverse().find((it) => it.group && it.group.total)?.group;
    const row = readRow(s);
    if (row) {
      cells = null;
      for (const g of row) {
        items.push({ group: g });
        known.set(g.total.value, g.total.label);
        known.last = g.total;
      }
      continue;
    }
    const eq = readEquation(s, known) || readInflows(s, prev);
    if (eq) {
      cells = null;
      items.push(eq.terms.length ? { group: eq } : { note: raw, total: eq.total });
      known.set(eq.total.value, eq.total.label);
      known.last = eq.total;
      for (const t of eq.terms) if (t.value != null && t.label) known.set(t.value, t.label);
      continue;
    }
    const cell = readCell(s);
    if (cell) {
      if (!cells) items.push({ group: (cells = { terms: [] }), cells: true });
      cells.terms.push(cell);
      continue;
    }
    cells = null;
    items.push({ note: raw });
  }
  const groups = items.filter((it) => it.group && (!it.cells || it.group.terms.length >= 3)).map((it) => it.group);
  for (const g of groups) if (g.terms[0]?.op === "+") g.terms[0].op = "";
  const notes = [];
  for (const it of items) {
    if (groups.includes(it.group)) continue;
    if (it.group) {
      notes.push(...it.group.terms.map((t) => `${t.label} ${t.amount}`));
    } else if (!it.total || !groups.some((g) => g.terms.some((t) => t.value === it.total.value && t.label === it.total.label))) {
      notes.push(it.note);
    }
  }
  return { groups, notes: notes.map((n) => (/[.!?"”)]$/.test(n) ? n : `${n}.`)) };
}
