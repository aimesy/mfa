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
const REFERENCE = /^(?:that|this|the)(?: year's)?(?: (?:total|figure|net|revenue|revenues|sum|subtotal|net change|income|excess))?$/i;
const OPEN_TOTAL = /^(?:[a-z]+ )?total$/i;
const NARRATION = /\b(?:gives?|adds?|equals?|is|are|was|prints?|printed as|which|shows?|reads?|confirms?)\b|[;:"“]/;

// A dash printed in a cell ("Interest Income -") is a value, not a minus sign.
function markDashes(text) {
  return text
    .replace(/\$\s?\(/g, "($")
    .replace(/\s[-–—](?=\s(?:plus|less|minus|and|with|gives?)\s)/g, ` ${DASH}`)
    .replace(/(?<=(?:[A-Za-z*]\)?|\$))\s[-–—](?=\s*(?:[,;.=+]|$)|\s(?:and|plus|less|minus|with|gives?|adds?|sums?|totals?|equals?|is|are|which|[-–])\s)/g, ` ${DASH}`);
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
      // "Bridge 4255500 53135/53142 428,634": account numbers, not amounts.
      if (/^\s+\d/.test(text.slice(m.index + whole.length)) || /\d[\s/]+$/.test(before)) continue;
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
      .replace(/[,;:(<>\s]+$/, "")
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
function readTerms(text, known, openRefs = false) {
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
    // "that total, interest 563.79 and ...": the earlier total, then more lines.
    const lead = /^\s*(?:that|this) (?:total|figure|net)\b,?\s*(?=\S)/i.exec(part.text);
    if (lead && known.last && amountsIn(part.text).length) {
      terms.push({ op: part.op, ...known.last, ref: true });
      part.text = part.text.slice(lead[0].length);
    }
    const amounts = amountsIn(part.text);
    let at = 0;
    for (const a of amounts) {
      const raw = part.text.slice(at, a.start);
      let label = cleanLabel(raw);
      if (!label && a.value != null && known.has(a.value)) label = known.get(a.value);
      // An unnamed amount is named later from the figure, the note or its role.
      if (label && !cleanEnough(label)) return null;
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
    if (!rest || /^no other\b/i.test(rest)) {
      if (!rest && !amounts.length && terms.length) return null;
      continue;
    }
    // "TOTAL REVENUES less ...": a line named without its amount, given earlier.
    const named = [...known].find(([, l]) => typeof l === "string" && l.toLowerCase() === rest.toLowerCase());
    if (named) {
      terms.push({ op: part.op, label: named[1], amount: known.shown?.get(named[0]) || fmtKnown(named[0]), value: named[0] });
      continue;
    }
    // "..., interest 53,981.32 and what left the fund": a trailing line with no amount.
    if (amounts.length) {
      if (rest.split(" ").length > 5 || !cleanEnough(rest)) return null;
      terms.push({ op: /\bleft\b|out/i.test(rest) ? "−" : part.op, label: rest, amount: "", value: undefined });
      continue;
    }
    if (REFERENCE.test(rest) && known.last && !openRefs) terms.push({ op: part.op, ...known.last, ref: true });
    else if (REFERENCE.test(rest)) terms.push({ op: part.op, label: /net/i.test(rest) ? "Net change" : /revenue|income/i.test(rest) ? "Revenue" : known.last?.label || "Total", amount: "", value: undefined });
    else if (OPEN_TOTAL.test(rest)) terms.push({ op: part.op, label: rest, amount: "", value: undefined });
    else return null;
  }
  return terms.length ? terms : null;
}

function fmtKnown(v) {
  const s = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
}

function closes(terms, total) {
  let sum = 0;
  for (const t of terms) {
    if (t.value == null) continue;
    // "less Expenditures (592,607)": the brackets are how the report prints an outflow.
    sum += t.op === "−" ? -Math.abs(t.value) : t.value;
  }
  // Reports round each line, so a printed total can differ from its lines by up to $1.
  return Math.abs(sum - total.value) <= 1;
}

// "LHS gives the printed Total 65,879" or "LHS = 65,879, the printed Total".
// Returns the first reading that closes; failing that, one whose lines are all
// printed, shown without operators (`printed`), since the note's own sum is off.
function readEquation(clause, known, ctx = {}, template = null) {
  let fallback = null;
  for (const m of clause.matchAll(RESULT)) {
    const rhs = clause.slice(m.index + m[0].length);
    const found = amountsIn(rhs);
    if (!found.length) continue;
    const a = found[0];
    let label = cleanLabel(rhs.slice(0, a.start));
    const after = rhs.slice(a.end).replace(/^,?\s*(?:the\s+)?printed\s+/i, " ");
    if (!label && !/^,?\s*which\b/i.test(rhs.slice(a.end))) label = cleanLabel(after.split(/[,;]|\.(?:\s|$)/)[0]);
    if (label && !cleanEnough(label)) continue;
    const total = { label, amount: a.shown, value: a.value };

    let lhs = clause.slice(0, m.index);
    const firstAmount = amountsIn(lhs)[0];
    const head = firstAmount ? lhs.slice(0, firstAmount.start) : lhs;
    const colon = head.lastIndexOf(":");
    if (colon >= 0 && !/\S/.test(head[colon + 1] ?? "")) lhs = lhs.slice(colon + 1);
    if (!amountsIn(lhs).length) {
      // "its revenue lines give the printed revenue total of 1,184": a total
      // without its lines, which a later "that total" may refer to.
      const lines = /\b([a-z]+) lines\b/.exec(lhs);
      if (/^total$/i.test(label) && lines) total.label = `Total ${lines[1]}s`;
      if (!total.label) {
        const named = cleanLabel(lhs.replace(/\b(?:the|its)\b/gi, " "));
        if (!named || !cleanEnough(named) || named.split(" ").length > 6) continue;
        total.label = /\btotals?$/i.test(named) ? named : `${named} total`;
      }
      return { total, terms: [] };
    }
    let terms = readTerms(lhs, known);
    // "Capital Projects - add to the printed Total Uses of Funds of -"
    if (total.value == null) {
      if (terms && total.label && terms.every((t) => t.value === null && t.label)) return { total, terms };
      continue;
    }
    if (!terms) continue;
    // "plus that year's revenue is ...": when the earlier total does not
    // close the sentence, the line is shown as the note gives it, unstated.
    if (terms.some((t) => t.ref) && terms.every((t) => t.value !== undefined) && !closes(terms, total)) terms = readTerms(lhs, known, true);
    if (!terms) continue;
    const given = terms.filter((t) => t.value !== undefined);
    if (!given.some((t) => t.value != null)) continue;
    const g = { total, terms };
    if (given.length === terms.length && !closes(terms, total)) {
      if (!fallback && terms.length >= 2 && total.label && terms.every((t) => /[A-Za-z]{2}/.test(t.label || ""))) fallback = { ...g, printed: true, terms: terms.map((t) => ({ ...t, op: "" })) };
      continue;
    }
    if (given.length !== terms.length && terms.length < 2) continue;
    if (!total.label) {
      total.label = "Total";
      total.inferred = true;
    }
    if (terms.some((t) => !t.label)) labelChain(g, ctx, known, null);
    // "..., which is 4,765,869.03 above the printed ending balance of 4,160,736.41"
    const gap = /^,?\s*which is (.+?) (above|below) the printed (.+?) of (.+?)\.?$/i.exec(rhs.slice(a.end));
    if (gap) {
      const d = amountsIn(gap[1])[0];
      const e = amountsIn(gap[4])[0];
      if (d && e && d.value != null && e.value != null) {
        g.after = { terms: [{ op: "", label: total.label, amount: total.amount, value: total.value }, { op: "−", label: cleanLabel(gap[3]), amount: e.shown, value: e.value }], total: { label: "Difference", amount: d.shown, value: gap[2] === "above" ? d.value : -d.value } };
        if (!closes(g.after.terms, g.after.total)) delete g.after;
      }
    }
    return g;
  }
  return fallback;
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

// Equations the note writes in bare numbers: "10,760,449.18 + 3,171,016.75 +
// 665,354.12 - 1,432,160.06 = 13,164,659.99, the printed ending balance".
// Each number gets the best label the release gives for it; a label this
// reader had to infer is marked `inferred`.
const N = String.raw`\(?-?\$?\s?\d[\d,]*(?:\.\d+)?\)?`;
const CHAIN = new RegExp(String.raw`(?<![\d,.])(${N}(?:\s*[-+−]\s*${N})+)\s*=\s*(${N})(?![\d,]*\d)|(?<![\d,.])(${N})\s*=\s*(${N}(?:\s*[-+−]\s*${N})+)(?![\d,]*\d)`, "g");
const OUTFLOW = /expend|refund|transfers? ?out|uses|disburse|outflow|payment|project|withdraw/i;

function parseAmount(text) {
  let t = text.replace(/[\s$]/g, "");
  if (t.startsWith("(") !== t.endsWith(")")) t = t.replace(/[()]/g, "");
  const neg = /^\(.*\)$/.test(t) || t.startsWith("-");
  const digits = t.replace(/[()-]/g, "");
  if (!/^\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^\d+(?:\.\d+)?$/.test(digits)) return null;
  const v = Number(digits.replace(/,/g, ""));
  return { amount: t, value: neg ? -v : v };
}

function splitChain(text) {
  const terms = [];
  let op = "";
  for (const piece of text.split(/\s*([+−]|(?<=[\d)])\s*-\s*(?=[\d($]))\s*/)) {
    if (/^[+−-]$/.test(piece.trim())) {
      op = piece.trim() === "+" ? "+" : "−";
      continue;
    }
    const a = parseAmount(piece);
    if (!a) return null;
    terms.push({ op, label: "", ...a });
    op = "";
  }
  return terms;
}

// "Beginning Fund Balance + Fee Revenues + Interest Income - Total Uses of
// Funds equals the printed Ending Fund Balance": the lines, named in order.
function readTemplate(text) {
  const m = /((?:[A-Z][\w'’/&.]*(?: [\w'’/&.]+){0,5})(?:\s+[-+−]\s+[A-Z][\w'’/&.]*(?: [\w'’/&.]+){0,5})+)\s+(?:=|equals)\s+(?:the printed\s+)?([A-Z][\w'’/&.]*(?: [\w'’/&.]+){0,4}?)(?=\s*[.,;(]|\s+for\b|$)/.exec(text);
  if (!m) return null;
  const terms = [];
  let op = "";
  for (const piece of m[1].split(/\s+([-+−])\s+/)) {
    if (/^[-+−]$/.test(piece)) op = piece === "+" ? "+" : "−";
    else terms.push({ op, label: cleanLabel(piece) });
  }
  return { terms, total: cleanLabel(m[2]) };
}

function chainTotalLabel(clause, start, end) {
  const after = clause.slice(end).replace(/^,?\s*(?:which is|matching|and|exact(?:ly)?)?\s*(?:the\s+)?(?:printed\s+)?/i, "");
  const tail = cleanLabel(after.split(/[,;.(]|\s(?:and|which|matching)\s/)[0]);
  if (tail && tail.split(" ").length <= 6 && cleanEnough(tail) && !/^\d/.test(tail)) return tail;
  const before = /(?:to|equals?|gives?)\s+(?:the\s+)?printed\s+([^:(]+?)\s*(?:[:(][^:(]*)*$/.exec(clause.slice(0, start));
  const named = before && cleanLabel(before[1].replace(/\s+for (?:each|every|all)\b.*$/i, ""));
  return named && cleanEnough(named) && named.split(" ").length <= 7 ? named : "";
}

function chainCaption(clause, start) {
  const head = clause.slice(0, start).split(/[:;(]\s*|,\s+and\s+/).filter((x) => x.trim()).pop() || "";
  const cap = cleanLabel(head.replace(/\b(?:for example|e\.g\.)\s*/i, ""));
  return cap && /^[A-Z0-9]/.test(cap) && cap.split(" ").length <= 5 && cleanEnough(cap) && !amountsIn(cap).some((a) => a.value != null && /[.,]/.test(a.amount ?? a.shown))
    && !/\b(?:reconcil\w*|closes|sums?|total|each|every|both|printed)\b/i.test(cap) ? cap : "";
}

function labelChain(g, ctx, known, template) {
  const unlabeled = () => g.terms.filter((t) => !t.label);
  if (template && g.terms.every((t) => !t.label) && template.terms.length === g.terms.length && template.terms.every((t, i) => i === 0 || t.op === g.terms[i].op)) {
    g.terms.forEach((t, i) => { t.label = template.terms[i].label; });
    if (template.total) g.total.label = template.total;
  }
  // The figure itself, other figures of the same agency (a sum across its
  // funds), and totals earlier in the note.
  let self = null;
  let across = false;
  for (const t of g.terms) {
    if (t.label) continue;
    if (ctx.value != null && Math.abs(t.value - ctx.value) < 0.005 && ctx.label) {
      t.label = ctx.label;
      self = t;
    } else if (ctx.siblings?.has(t.value)) {
      t.label = ctx.siblings.get(t.value);
      across = true;
    } else if (known.has(t.value)) t.label = known.get(t.value);
  }
  if (self && across && ctx.program) self.label = ctx.program;
  // Line names the reviewer's reading quotes, matched to inflows and outflows in order.
  const hints = (ctx.hints || []).filter((h) => !g.terms.some((t) => t.label === h) && h !== g.total.label);
  const outs = hints.filter((h) => OUTFLOW.test(h));
  const ins = hints.filter((h) => !OUTFLOW.test(h) && !/balance/i.test(h));
  const rest = unlabeled();
  const restIn = rest.filter((t, i) => t.op !== "−" && !(i === 0 && g.terms[0] === t && /balance|ending|closing/i.test(g.total.label)));
  const restOut = rest.filter((t) => t.op === "−");
  if (restIn.length === ins.length && restOut.length === outs.length && hints.length) {
    restIn.forEach((t, i) => { t.label = ins[i]; t.inferred = true; });
    restOut.forEach((t, i) => { t.label = outs[i]; t.inferred = true; });
  }
  const rollForward = /balance|ending|closing|end of/i.test(g.total.label);
  g.terms.forEach((t, i) => {
    if (t.label) return;
    t.inferred = true;
    if (rollForward && i === 0) t.label = "Beginning balance";
    else if (rollForward) t.label = t.op === "−" ? "Outflow" : "Inflow";
    else t.label = `Line ${i + 1}`;
  });
  if (!g.total.label) {
    g.total.label = "Total";
    g.total.inferred = true;
  }
}

function readChains(clause, known, ctx, template) {
  const groups = [];
  for (const m of clause.matchAll(CHAIN)) {
    const [lhs, rhs] = m[1] ? [m[1], m[2]] : [m[4], m[3]];
    const terms = splitChain(lhs);
    const total = parseAmount(rhs);
    if (!terms || terms.length < 2 || !total) continue;
    if (!closes(terms, total)) continue;
    const g = { terms, total: { ...total, label: m[1] ? chainTotalLabel(clause, m.index, m.index + m[0].length) : "" } };
    const caption = chainCaption(clause, m.index);
    if (caption) g.caption = caption;
    labelChain(g, ctx, known, template);
    groups.push(g);
    if (!g.total.inferred) known.set(g.total.value, g.total.label);
  }
  return groups;
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

// "The block accounts for itself: Beginning Balance, July 1, 2015 $ 72,858,
// with Fees collected $ 5,326 and Interest earned $ 616; the receipts give the
// printed total $ 5,942, and outgoings of Total Expenditures $ 0.00, gives
// Ending Balance, June 30, 2016 $ 78,800."
function readBlock(first, second, known) {
  const m = /^the receipts give the printed total (.+?), and outgoings of (.+?),? gives (.+?)\.?$/i.exec(second);
  if (!m) return null;
  const terms = readTerms(first.replace(/^[^:]*:\s+/, ""), known);
  const receipts = amountsIn(m[1])[0];
  const out = readTerms(m[2].replace(/\s*\([^)]*\)\s*$/, ""), known);
  const end = amountsIn(m[3]);
  if (!terms || terms.length < 2 || !receipts || receipts.value == null || !out || out.length !== 1 || end.length !== 1) return null;
  const inflow = terms.slice(1).map((t) => ({ ...t, op: "+" }));
  const sub = { label: "Receipts", amount: receipts.shown, value: receipts.value };
  const o = { ...out[0], op: "−", label: out[0].label || "Outgoings" };
  const total = { label: cleanLabel(m[3].slice(0, end[0].start)) || "Ending balance", amount: end[0].shown, value: end[0].value };
  const roll = [{ ...terms[0], op: "" }, { ...sub, op: "+" }, o];
  if (inflow.some((t) => !t.label) || !closes(inflow, sub) || !closes(roll, total)) return null;
  inflow[0].op = "";
  return [{ terms: inflow, total: sub }, { terms: roll, total }];
}

// Context the note states in words (headings, dates, a balance that matches
// the year before) as rows of a facts table. A sentence becomes facts only
// when every clause of it does.
const DROP_CLAUSE = /^(?:so|which is what)\b.*\b(?:year its heading says|this fund|column is the year)\b|^so the column is the year its heading says$/i;
const FACT_RULES = [
  [/^(?:every (?:figure|line) stands in )?(?:the )?columns? (?:is |are )?headed (.+)$/i, (m) => ["Column heading", m[1]]],
  [/^(?:under )?the page heading (.+)$/i, (m) => ["Page heading", m[1]]],
  [/^(?:the )?(table|page|listing|report|statement|matrix|summary|ledger|block|document|schedule)(?:'s)? (?:is |are )?(?:headed|titled) (.+)$/i, (m) => [`${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} heading`, m[2]]],
  [/^(?:the )?(table|page|column) is captioned with (.+)$/i, (m) => ["Caption", m[2]]],
  [/^(?:the |its )?(?:balance columns|balances) (?:are )?dated (.+)$/i, (m) => ["Balances dated", m[1]]],
  [/^(?:the )?page names (.+?) and no other .+$/i, (m) => ["Date on page", `${m[1]} only`]],
  [/^(?:the )?page's years run (.+?)(?:, closing on the column read)?$/i, (m) => ["Years on page", m[1]]],
  [/^so (?:that|the) column is (?:the )?(.+)$/i, (m) => ["Column is", m[1]]],
  [/^(?:its )?(?:opening|beginning) balance is the (?:closing|ending) balance (?:the same table prints|printed) (?:for the year before it|under \S+|in the column headed \S+)$|^opening equals the preceding printed closing$|^the beginning balance printed for this year is also the ending balance printed for the next older year$/i, () => ["Opening balance", "Equals prior year's closing"]],
  [/^the report itemises no fee[- ]funded expenditure for this fund in this year$/i, () => ["Spending from fees", "None itemised"]],
  [/^(?:the )?(?:table|statement|schedule|report) runs over pages (.+)$/i, (m) => ["Pages", m[1]]],
];

function readFacts(sentence) {
  // A record the release wrote as JSON: {"page": 167, "fee": 138913, ...}
  if (/^\{.*\}\.?$/.test(sentence.trim())) {
    try {
      const o = JSON.parse(sentence.trim().replace(/\.$/, ""));
      const flat = [];
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) flat.push([k2, v2]);
        else flat.push([k, v]);
      }
      const rows = flat.filter(([, v]) => v === null || ["string", "number"].includes(typeof v));
      if (rows.length) return rows.map(([k, v]) => ({ label: `${k[0].toUpperCase()}${k.slice(1).replace(/_/g, " ")}`, value: v === null ? "–" : typeof v === "number" && Math.abs(v) >= 1000 ? v.toLocaleString("en-US") : String(v) }));
    } catch {
      return null;
    }
  }
  // "The rows' fees add to the table's total row, 173,276.08."
  const sum = /^(?:and )?(.+?) add (?:up )?to (?:(.+?),\s*)?(\(?-?\$?[\d,]+(?:\.\d+)?\)?)(?:,\s*(.+?))?\.?$/i.exec(sentence.trim());
  if (sum && !/[+=]|\d/.test(sum[1])) {
    const what = cleanLabel(sum[1].replace(/,\s*from [^,]+,/i, "").replace(/\b(?:the|its)\b/gi, " "));
    if (what && cleanEnough(what) && what.split(" ").length <= 6) return [{ label: `${what} sum to`, value: sum[3] }];
  }
  const text = sentence.replace(/\.$/, "").replace(/^every figure listed under item \([A-Z]\) is counted, and /i, "");
  const clauses = text.split(/,\s+(?:and\s+)?(?=(?:under|the|its|so)\s)|\s+and\s+(?=(?:its|the) balances?\b)/);
  const facts = [];
  for (const c of clauses) {
    const clause = c.trim();
    if (DROP_CLAUSE.test(clause)) continue;
    const rule = FACT_RULES.find(([re]) => re.test(clause));
    if (!rule) return null;
    const [label, value] = rule[1](rule[0].exec(clause));
    // A value is a heading or a date, never a sentence or an amount.
    if (value.length > 90 || /[:;]|\b(?:accounts?|gives?|adds?|prints?)\b/.test(value) || amountsIn(value).some((a) => /,\d{3}|\.\d{2}\b/.test(a.shown))) return null;
    facts.push({ label, value: value.trim().replace(/^[a-z]/, (ch) => ch.toUpperCase()) });
  }
  return facts.length ? facts : null;
}

// "this fee's printed beginning balance (2,534,356.16) is the ending balance
// printed for it in the FY2017-18 report", and the same within one table.
function readMatch(sentence) {
  const s = sentence.replace(/^[^:]*:\s+/, "");
  let m = /^(?:this|the) (?:fee|fund)'s printed beginning balance (.+?) is the ending balance printed for it in the (.+?) report\.?$/i.exec(s);
  if (m) {
    const a = amountsIn(m[1]);
    if (a.length !== 1 || a[0].value == null) return null;
    return { caption: "Across reports", terms: [{ op: "", label: "Beginning balance, this report", amount: a[0].shown, value: a[0].value }], total: { label: `Ending balance, ${m[2]} report`, amount: a[0].shown, value: a[0].value } };
  }
  m = /^its printed ending balance of (.+?) is the beginning balance printed for (?:this fee|this fund|it) in the (.+?) report\.?$/i.exec(s);
  if (m) {
    const a = amountsIn(m[1]);
    if (a.length !== 1 || a[0].value == null) return null;
    return { caption: "Across reports", terms: [{ op: "", label: "Ending balance, this report", amount: a[0].shown, value: a[0].value }], total: { label: `Beginning balance, ${m[2]} report`, amount: a[0].shown, value: a[0].value } };
  }
  m = /^opening equals (?:the )?preceding (?:annual |printed )*closing (.+?)\.?$/i.exec(s);
  if (m) {
    const a = amountsIn(m[1]);
    if (a.length !== 1 || a[0].value == null) return null;
    return { caption: "Year before", terms: [{ op: "", label: "Opening balance", amount: a[0].shown, value: a[0].value }], total: { label: "Prior year's closing balance", amount: a[0].shown, value: a[0].value } };
  }
  m = /^its opening balance (.+?) is the closing balance the same table prints for the year before it(?:, so .*)?\.?$/i.exec(s);
  if (m) {
    const a = amountsIn(m[1]);
    if (a.length !== 1 || a[0].value == null) return null;
    return { caption: "Year before", terms: [{ op: "", label: "Opening balance", amount: a[0].shown, value: a[0].value }], total: { label: "Prior year's closing balance", amount: a[0].shown, value: a[0].value } };
  }
  return null;
}

// Once a table shows the arithmetic, these sentences only say it again.
const RESTATES = /establishes that the column|gives the ending balance|reproduces? the printed|residuals zero|add to the table's printed totals|cells remain as shown|receipt columns give the printed total|printed dash is not assigned zero|reconciles? exactly$|signed balances reconcile|remain NULL|confirms? .*read correctly|agree on this figure|^every (?:column|fund|year) reconciles$/i;

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
export function readArithmetic(text, ctx = {}) {
  const items = [];
  const known = new Map();
  const template = readTemplate(String(text || ""));
  let cells = null;
  const facts = [];
  for (const raw of sentences(text)) {
    const s = markDashes(raw);
    const last = items[items.length - 1];
    const block = last?.note && readBlock(markDashes(last.note), s, known);
    if (block) {
      items.pop();
      for (const g of block) items.push({ group: g });
      known.last = block[1].total;
      continue;
    }
    const match = readMatch(s);
    if (match) {
      items.push({ group: match });
      continue;
    }
    const fact = readFacts(raw);
    if (fact) {
      facts.push(...fact);
      continue;
    }
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
    const eq = readEquation(s, known, ctx, template) || readInflows(s, prev);
    // A sentence that names the lines and then gives them as bare numbers.
    const chains = eq && eq.terms.length ? [] : readChains(s, known, ctx, template);
    if (chains.length) {
      cells = null;
      for (const g of chains) {
        items.push({ group: g });
        known.last = g.total;
      }
      continue;
    }
    if (eq) {
      cells = null;
      items.push(eq.terms.length ? { group: eq } : { note: raw, total: eq.total });
      if (eq.after) items.push({ group: eq.after });
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
      facts.push(...it.group.terms.map((t) => ({ label: t.label, value: t.amount })));
    } else if (it.total && groups.some((g) => g.terms.some((t) => t.value === it.total.value && t.label === it.total.label))) {
      continue;
    } else if (it.total) {
      facts.push({ label: it.total.label, value: it.total.amount });
    } else if (!(groups.length && !/\d/.test(it.note) && RESTATES.test(it.note.replace(/\.$/, "")))) {
      notes.push(it.note);
    }
  }
  const seen = new Set();
  const uniqueFacts = facts.filter((f) => !seen.has(`${f.label}|${f.value}`) && seen.add(`${f.label}|${f.value}`));
  return { groups, facts: uniqueFacts, notes: notes.map((n) => (/[.!?"”)]$/.test(n) ? n : `${n}.`)) };
}
