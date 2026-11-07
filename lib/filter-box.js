// Checkbox filter boxes for every tab, patterned on the column filters of
// aimesy/sfsc and tentatives: tick any number of values (any of them
// matches; different boxes must all match), each with its row count. A box
// opens from a toolbar button ("Type: All ▾") or from the ▾ in a column
// header. Built with el() only, so release text never reaches innerHTML.
//
// Kept from MFA on purpose, where SFSC differs:
// - a tree parent is tri-state and stands for all of its children;
// - Apply is disabled when nothing is ticked (SFSC stores an empty filter
//   that then matches everything);
// - search matches the shown label, since values are keys such as "__none";
// - a long list (many) shows only the ticked values until the user types.
//
// The pure helpers below need no DOM, so tests/filter-box.test.mjs runs them
// in node; nothing touches document or window at import time.

import { el } from "./dom.js";
import { NONE, SEP, splitChoice, fmtInt } from "./model.js";

// A long list renders at most this many rows; typing narrows it.
export const RENDER_CAP = 200;

const POP_ID = "cf-pop";
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

const hasDom = () => typeof document !== "undefined";
const kids = (o) => (o.children && o.children.length ? o.children : null);

// Case and accent blind, so "canada" finds La Cañada Flintridge.
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function leafValues(options) {
  return options.flatMap((o) => (kids(o) ? o.children.map((c) => c.value) : [o.value]));
}

// Counts per value. valueFn may return an array: the row then counts once
// under each distinct value (an agency in several districts), and an empty
// array counts under NONE. include lists values ticked now, so they stay in
// the list with count 0 and Apply never drops them.
export function facetOptions(rows, valueFn, labelFn = (v) => v, { include = [] } = {}) {
  const counts = new Map();
  const bump = (v) => counts.set(v, (counts.get(v) || 0) + 1);
  for (const row of rows || []) {
    const v = valueFn(row);
    if (Array.isArray(v)) {
      const vals = new Set(v.filter((x) => x != null && x !== "").map(String));
      if (!vals.size) vals.add(NONE);
      for (const x of vals) bump(x);
    } else bump(v == null || v === "" ? NONE : String(v));
  }
  const extra = typeof include === "string" ? splitChoice(include) : include || [];
  for (const v of extra) if (v != null && v !== "" && !counts.has(String(v))) counts.set(String(v), 0);
  const out = [...counts].map(([value, count]) => {
    const label = labelFn(value);
    return { value, label: label == null || label === "" ? value : String(label), count, children: [] };
  });
  return out;
}

// ------------------------------------------------------------ labels

// Labels seen in each box's options, so a button can name a value without
// computing the options again. Keyed by key and label, since keys are
// unique only within a tab.
const labelCache = new Map();
const cacheKey = (spec) => `${spec.key}\u0001${spec.label}`;

export function rememberOptions(spec, options) {
  const k = cacheKey(spec);
  const m = labelCache.get(k) || new Map();
  for (const o of options) {
    m.set(o.value, o.label);
    for (const c of o.children || []) {
      m.set(c.value, c.label.startsWith(o.label) ? c.label : `${o.label} › ${c.label}`);
    }
  }
  labelCache.set(k, m);
}

export function boxLabel(spec, value) {
  const cached = labelCache.get(cacheKey(spec))?.get(value);
  if (cached != null) return cached;
  const t = spec.text ? spec.text(value) : null;
  if (t != null && t !== "") return String(t);
  return value === NONE ? "(not recorded)" : String(value);
}

// "a or b" for one or two values, otherwise "N values".
export function boxSummary(spec, raw) {
  const vals = splitChoice(raw);
  return vals.length <= 2 ? vals.map((v) => boxLabel(spec, v)).join(" or ") : `${fmtInt(vals.length)} values`;
}

export function buttonLabel(spec, raw) {
  return `${spec.label}: ${raw ? boxSummary(spec, raw) : "All"}`;
}

// ------------------------------------------------------------ list logic

export function defaultSort(spec) {
  return spec.sort || (spec.many ? "az" : "count");
}

export function sortModes(spec) {
  const modes = [["az", "A to Z"], ["za", "Z to A"], ["count", "By count"]];
  if (spec.sort === "num") return [["num", "1 to 9"], ...modes];
  if (spec.sort === "given") return [["given", "Listed order"], ...modes];
  return modes;
}

const countOf = (o) => (typeof o.count === "number" ? o.count : -1);
const byLabel = (a, b) => collator.compare(a.label, b.label) || collator.compare(a.value, b.value);
const numOf = (v) => Number.parseFloat(v);

// NONE is not a name or a number, so it goes last in the A to Z, Z to A and
// 1 to 9 orders; by count it takes its place like any other value. Count
// ties fall back to the label, so the order never depends on row order.
export function compareOptions(mode) {
  const noneLast = (cmp) => (a, b) => (a.value === NONE) - (b.value === NONE) || cmp(a, b);
  if (mode === "az") return noneLast(byLabel);
  if (mode === "za") return noneLast((a, b) => byLabel(b, a));
  if (mode === "num") {
    return noneLast((a, b) => {
      const x = numOf(a.value);
      const y = numOf(b.value);
      return Number.isNaN(x) - Number.isNaN(y) || x - y || byLabel(a, b);
    });
  }
  return (a, b) => countOf(b) - countOf(a) || byLabel(a, b);
}

// Parents follow the mode and keep their children under them, sorted the
// same way. "given" keeps the caller's order (for example the taxonomy).
export function sortOptions(options, mode) {
  if (mode === "given") return [...options];
  const cmp = compareOptions(mode);
  return options.map((o) => (kids(o) ? { ...o, children: [...o.children].sort(cmp) } : o)).sort(cmp);
}

// The rows to draw. A search keeps a parent whose label matches with all of
// its children, and otherwise keeps a parent only for its matching children
// (allChildren still holds every child, which the parent box ticks). A long
// list shows only ticked values until the user types, and at most cap rows.
export function visibleOptions(options, { search = "", sort = "count", many = false, selected = new Set(), cap = RENDER_CAP } = {}) {
  const q = fold(search).trim();
  let view = sortOptions(options, sort);
  if (q) {
    const hit = (o) => fold(o.label).includes(q);
    view = view.flatMap((o) => {
      if (hit(o)) return [o];
      const c = kids(o) ? o.children.filter(hit) : [];
      return c.length ? [{ ...o, children: c, allChildren: o.children }] : [];
    });
  } else if (many) {
    view = view.filter((o) => (kids(o) || [o]).some((c) => selected.has(c.value)));
  }
  const total = view.length;
  if (many && total > cap) view = view.slice(0, cap);
  return { view, total, capped: view.length < total };
}

// Values ticked now must stay in the list even when no row under the other
// filters has them; otherwise Apply would drop them without a word.
export function ensureOptions(spec, options, raw) {
  const known = new Set([...options.map((o) => o.value), ...leafValues(options)]);
  const extra = [];
  for (const v of splitChoice(raw)) {
    if (known.has(v)) continue;
    // "water/" (no subcategory) is the same as a namespace with no children.
    if (spec.tree && v.endsWith("/") && options.some((o) => !kids(o) && `${o.value}/` === v)) continue;
    known.add(v);
    extra.push({ value: v, label: boxLabel(spec, v), count: 0, children: [] });
  }
  return extra.length ? [...options, ...extra] : options;
}

// Nothing chosen means everything shown: every value starts ticked, except
// in a long list, which starts empty for searching.
export function initialSelection(spec, options, raw) {
  const current = new Set(splitChoice(raw));
  const selected = new Set();
  for (const o of options) {
    const children = kids(o);
    for (const leaf of children || [o]) {
      if (!current.size) {
        if (!spec.many) selected.add(leaf.value);
      } else if (current.has(leaf.value) || current.has(o.value) || (spec.tree && !children && current.has(`${o.value}/`))) {
        selected.add(leaf.value);
      }
    }
  }
  return selected;
}

export function canApply(spec, selected) {
  return Boolean(spec.many) || selected.size > 0;
}

// The filter value Apply stores. A parent with every child ticked is stored
// as the parent. Every value ticked stores "" (no filter) only when the box
// opened with no filter (raw ""): the options are counted under the tab's
// other filters, so with a filter already set "every value" means every
// value left, and Apply must keep that filter. Nothing ticked stores "" too,
// which only a long list allows; Clear is the way to drop a filter.
export function selectionToRaw(spec, options, selected, { raw = "" } = {}) {
  const vals = [];
  for (const o of options) {
    const children = kids(o);
    if (!children) {
      if (selected.has(o.value)) vals.push(o.value);
      continue;
    }
    const on = children.filter((c) => selected.has(c.value));
    if (on.length === children.length) vals.push(o.value);
    else for (const c of on) vals.push(c.value);
  }
  if (!vals.length) return "";
  if (!raw && leafValues(options).every((v) => selected.has(v))) return "";
  return vals.join(SEP);
}

// Where the box goes, in viewport pixels for position: fixed. Below the
// anchor when the full list fits there, else on the roomier side, with the
// list shortened to fit. Above, it is pinned by its bottom edge so a shorter
// list stays against the anchor.
export function placement({ rect, popWidth, chromeHeight, listMax, viewWidth, viewHeight, margin = 8, gap = 4, minList = 96 }) {
  const left = Math.max(margin, Math.min(viewWidth - popWidth - margin, rect.left - 8));
  const below = viewHeight - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  const need = chromeHeight + listMax;
  const up = need > below && above > below;
  const room = up ? above : below;
  const list = need > room ? Math.max(minList, Math.floor(room - chromeHeight)) : null;
  const height = chromeHeight + (list ?? listMax);
  if (up) {
    const bottom = Math.max(margin, Math.min(viewHeight - rect.top + gap, viewHeight - margin - height));
    return { left, top: null, bottom, up, listMax: list };
  }
  const top = Math.max(margin, Math.min(rect.bottom + gap, viewHeight - margin - height));
  return { left, top, bottom: null, up, listMax: list };
}

// ------------------------------------------------------------ buttons

// Every button made below, with the spec it reads, so refreshFilterBoxes can
// repaint buttons that outlive a render (the toolbar).
const specs = new WeakMap();
let openBox = null;

function paint(b) {
  const spec = specs.get(b);
  if (!spec) return;
  const raw = String(spec.get() || "");
  b.classList.toggle("active", Boolean(raw));
  b.setAttribute("aria-expanded", openBox?.anchor === b ? "true" : "false");
  if (b.classList.contains("col-filter-btn")) {
    const t = raw ? `Filter by ${spec.label} (now ${boxSummary(spec, raw)})` : `Filter by ${spec.label}`;
    b.title = t;
    b.setAttribute("aria-label", t);
    return;
  }
  const label = buttonLabel(spec, raw);
  b.textContent = `${label} ▾`;
  b.setAttribute("aria-label", label);
  const vals = splitChoice(raw);
  if (vals.length > 2) {
    const names = vals.slice(0, 12).map((v) => boxLabel(spec, v)).join(", ");
    b.title = `${spec.label}: ${names}${vals.length > 12 ? ` and ${fmtInt(vals.length - 12)} more` : ""}`;
  } else b.removeAttribute("title");
}

function trigger(spec, cls, attrs) {
  const b = el("button", {
    type: "button", class: cls, dataset: { key: spec.key }, "aria-haspopup": "dialog", "aria-expanded": "false", ...attrs,
    onclick: (e) => { e.stopPropagation(); openFilterBox(specs.get(e.currentTarget) || spec, e.currentTarget); },
  });
  specs.set(b, spec);
  paint(b);
  return b;
}

// Toolbar box: span.chip > button.btn.fbox-btn, "Label: All ▾".
export function filterBoxButton(spec) {
  return el("span", { class: "chip" }, trigger(spec, "btn fbox-btn"));
}

// The ▾ beside a column name, for a th .col-head.
export function colFilterButton(spec) {
  return trigger(spec, "col-filter-btn", { text: "▾" });
}

export function refreshFilterBoxes(root = hasDom() ? document : null) {
  if (!root?.querySelectorAll) return;
  for (const b of root.querySelectorAll(".fbox-btn[data-key], .col-filter-btn[data-key]")) paint(b);
}

export function isFilterBoxOpen(key) {
  return key == null ? Boolean(openBox) : openBox?.spec.key === key;
}

// A render replaces the buttons, so focus goes to the new button of the same
// kind and key when the old one is gone.
function focusTrigger(key, kind, anchor) {
  if (!hasDom()) return;
  let target = anchor?.isConnected ? anchor : null;
  if (!target) {
    const same = [...document.querySelectorAll(".fbox-btn[data-key], .col-filter-btn[data-key]")].filter((b) => b.dataset.key === key);
    target = same.find((b) => b.classList.contains(kind)) || same[0] || null;
  }
  target?.focus({ preventScroll: true });
}

// focus: false leaves focus alone (a click elsewhere already moved it).
export function closeFilterBox({ focus = true } = {}) {
  const box = openBox;
  if (!box) return;
  openBox = null;
  const active = document.activeElement;
  const hadFocus = !active || active === document.body || box.pop.contains(active);
  for (const [target, type, fn, opt] of box.listeners) target.removeEventListener(type, fn, opt);
  box.pop.remove();
  box.anchor.setAttribute("aria-expanded", "false");
  box.anchor.removeAttribute("aria-controls");
  if (focus && hadFocus) focusTrigger(box.spec.key, box.kind, box.anchor);
}

// ------------------------------------------------------------ the box

export function openFilterBox(spec, anchor) {
  const reopen = openBox && openBox.spec.key === spec.key && openBox.anchor === anchor;
  closeFilterBox({ focus: false });
  if (reopen) return;

  const raw = String(spec.get() || "");
  const kind = anchor.classList.contains("col-filter-btn") ? "col-filter-btn" : "fbox-btn";
  let options = null; // null while loading
  let failed = null;
  let selected = new Set();
  let sort = defaultSort(spec);
  let search = "";
  let rows = [];
  let token = 0;
  let placed = false;

  const list = el("div", { class: "cf-list", role: "group", "aria-label": `${spec.label} values` });
  const apply = el("button", {
    type: "button", class: "cf-apply", text: "Apply", disabled: true,
    onclick: () => { if (options) finish(selectionToRaw(spec, options, selected, { raw })); },
  });
  const sortRow = el("div", { class: "cf-sort", role: "group", "aria-label": "Sort values" },
    sortModes(spec).map(([mode, text]) => el("button", {
      type: "button", class: mode === sort ? "active" : "", "aria-pressed": String(mode === sort), dataset: { sort: mode }, text,
      onclick: () => {
        sort = mode;
        for (const b of sortRow.children) {
          b.classList.toggle("active", b.dataset.sort === mode);
          b.setAttribute("aria-pressed", String(b.dataset.sort === mode));
        }
        render(true);
      },
    })));
  const searchBox = el("input", {
    class: "cf-search", type: "search", autocomplete: "off", spellcheck: "false",
    placeholder: spec.placeholder || (spec.many ? "Type to search, then tick…" : "Search values…"),
    "aria-label": `Search ${spec.label} values`,
    oninput: (e) => { search = e.target.value; render(true); },
  });
  const noteId = `${POP_ID}-note`;
  const pop = el("div", {
    class: "col-filter-pop open", id: POP_ID, role: "dialog", tabindex: "-1",
    "aria-label": `Filter by ${spec.label}`, "aria-describedby": spec.note ? noteId : null,
  },
  el("div", { class: "cf-title", text: `Filter · ${spec.label}` }),
  spec.note ? el("div", { class: "cf-note", id: noteId, text: spec.note }) : null,
  sortRow,
  searchBox,
  list,
  el("div", { class: "cf-actions" },
    apply,
    el("button", { type: "button", class: "cf-clear", text: "Clear", onclick: () => finish("") }),
    el("button", { type: "button", class: "cf-cancel", text: "Cancel", onclick: () => closeFilterBox() })));

  function finish(value) {
    closeFilterBox({ focus: false });
    const done = () => { refreshFilterBoxes(); focusTrigger(spec.key, kind, anchor); };
    const result = spec.apply(value);
    if (result && typeof result.then === "function") result.then(done, done);
    else done();
  }

  // The count is read as part of the checkbox's name ("AD 1, 43 rows"), not
  // as a bare number after the value.
  const row = (label, count, cls, values, value) => {
    const counted = typeof count === "number";
    const cb = el("input", {
      type: "checkbox", value: value ?? null,
      "aria-label": counted ? `${label}, ${fmtInt(count)} ${count === 1 ? "row" : "rows"}` : null,
      onchange: (e) => {
        for (const v of values) e.target.checked ? selected.add(v) : selected.delete(v);
        sync();
      },
    });
    rows.push({ cb, values });
    return el("label", { class: cls ? `cf-row ${cls}` : "cf-row" }, cb,
      el("span", { class: "cf-label", title: label, text: label }),
      counted ? el("span", { class: "cf-count", "aria-hidden": "true", text: fmtInt(count) }) : null);
  };

  // Ticking updates the boxes in place, so the list keeps its scroll and the
  // focused box stays focused; only search, sort and loading redraw it.
  function sync() {
    for (const r of rows) {
      const on = r.values.reduce((n, v) => n + (selected.has(v) ? 1 : 0), 0);
      r.cb.checked = r.values.length > 0 && on === r.values.length;
      r.cb.indeterminate = on > 0 && on < r.values.length;
    }
    apply.disabled = !options || !canApply(spec, selected);
  }

  function render(resetScroll = false) {
    const top = resetScroll ? 0 : list.scrollTop;
    rows = [];
    const nodes = [];
    if (failed) {
      const why = failed?.message ? `: ${failed.message}` : ".";
      nodes.push(el("div", { class: "cf-empty cf-error", role: "alert" }, `Could not load the values${why}`,
        el("button", { type: "button", class: "cf-retry", text: "Retry", onclick: load })));
    } else if (!options) {
      nodes.push(el("div", { class: "cf-empty", text: "Loading…" }));
    } else {
      const q = search.trim();
      const { view, total, capped } = visibleOptions(options, { search, sort, many: spec.many, selected });
      if (capped) nodes.push(el("div", { class: "cf-cap", text: `Showing ${fmtInt(view.length)} of ${fmtInt(total)}; type more to narrow.` }));
      if (!view.length) {
        const text = q ? "No matching values." : spec.many ? spec.hint || "Type a name, then tick." : "No values.";
        nodes.push(el("div", { class: "cf-empty", text }));
      } else {
        const shown = view.flatMap((o) => (kids(o) ? o.children : [o])).map((o) => o.value);
        nodes.push(row(q || spec.many ? "(Select all visible)" : "(Select all)", null, "cf-all", shown));
        for (const o of view) {
          if (kids(o)) {
            nodes.push(row(o.label, o.count, "cf-ns", (o.allChildren || o.children).map((c) => c.value), o.value));
            for (const c of o.children) nodes.push(row(c.label, c.count, "cf-sub", [c.value], c.value));
          } else {
            nodes.push(row(o.label, o.count, spec.tree ? "cf-ns" : "", [o.value], o.value));
          }
        }
      }
    }
    list.setAttribute("aria-busy", String(!options && !failed));
    list.replaceChildren(...nodes);
    list.scrollTop = top;
    sync();
  }

  function ready(opts) {
    options = ensureOptions(spec, Array.isArray(opts) ? opts : [], raw);
    rememberOptions(spec, options);
    selected = initialSelection(spec, options, raw);
    render(true);
    if (placed) place();
  }

  // options() may return a promise (a file still loading): show Loading,
  // then the list, or the error with Retry.
  function load() {
    const mine = ++token;
    failed = null;
    options = null;
    let result;
    try {
      result = spec.options();
    } catch (err) {
      result = Promise.reject(err);
    }
    if (!result || typeof result.then !== "function") {
      ready(result);
      return;
    }
    render(true);
    if (placed) place();
    const current = () => mine === token && openBox?.pop === pop;
    result.then(
      (opts) => { if (current()) ready(opts); },
      (err) => {
        if (!current()) return;
        failed = err instanceof Error ? err : new Error(String(err ?? "unknown error"));
        render(true);
        place();
      });
  }

  function place() {
    if (!anchor.isConnected) {
      closeFilterBox({ focus: false });
      return;
    }
    list.style.maxHeight = "";
    const listMax = Number.parseFloat(getComputedStyle(list).maxHeight) || 300;
    const p = placement({
      rect: anchor.getBoundingClientRect(),
      popWidth: pop.offsetWidth,
      chromeHeight: pop.offsetHeight - list.offsetHeight,
      listMax,
      viewWidth: document.documentElement.clientWidth || window.innerWidth,
      viewHeight: window.innerHeight,
    });
    pop.style.left = `${p.left}px`;
    pop.style.top = p.top == null ? "auto" : `${p.top}px`;
    pop.style.bottom = p.bottom == null ? "auto" : `${p.bottom}px`;
    if (p.listMax != null) list.style.maxHeight = `${p.listMax}px`;
    placed = true;
  }

  load();
  document.body.append(pop);
  place();

  const outside = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) closeFilterBox({ focus: false });
  };
  // Escape here, ahead of the page's own Escape handlers: the box is on top.
  const escape = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeFilterBox();
  };
  // A width change (rotation, window resize) closes the box. A height change
  // alone is often the phone keyboard opening for the search box, so the box
  // only moves.
  const width = window.innerWidth;
  const resize = () => (window.innerWidth !== width ? closeFilterBox() : place());
  // Scrolling #content, or anything holding the anchor, moves the anchor
  // away from the box; a page scroll just moves the box with it.
  const content = document.getElementById("content");
  const scroll = (e) => {
    const t = e.target;
    if (t === pop || (t instanceof Node && pop.contains(t))) return;
    if (t === document || t === document.documentElement || t === document.body) place();
    else if (t === content || (t instanceof Node && t.contains(anchor))) closeFilterBox();
  };
  // pointerdown as well: iOS sends no mousedown for a tap on plain text.
  const listeners = [
    [document, "pointerdown", outside, true],
    [document, "mousedown", outside, true],
    [document, "keydown", escape, true],
    [document, "scroll", scroll, true],
    [window, "resize", resize, false],
  ];
  for (const [target, type, fn, opt] of listeners) target.addEventListener(type, fn, opt);

  pop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT") {
      e.preventDefault();
      if (!apply.disabled) apply.click();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const boxes = [searchBox, ...list.querySelectorAll("input[type=checkbox]")];
      const i = boxes.indexOf(e.target);
      if (i < 0) return;
      e.preventDefault();
      boxes[Math.max(0, Math.min(boxes.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].focus();
    } else if (e.key === "Tab") {
      // Keep Tab inside the box; it sits at the end of the page.
      const stops = [...pop.querySelectorAll("button, input")].filter((n) => !n.disabled);
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (e.shiftKey && (e.target === first || e.target === pop)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && e.target === last) { e.preventDefault(); first.focus(); }
    }
  });

  openBox = { spec, anchor, pop, kind, listeners };
  anchor.setAttribute("aria-expanded", "true");
  anchor.setAttribute("aria-controls", POP_ID);

  // On a phone, focusing the search would raise the keyboard over the list;
  // focus the box itself unless the list is one you must type into.
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
  (spec.many || !coarse ? searchBox : pop).focus({ preventScroll: true });
}
