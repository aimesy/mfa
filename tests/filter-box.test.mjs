// node tests/filter-box.test.mjs
// Unit checks for the list logic of lib/filter-box.js: counts, sorting,
// search, what a box starts with ticked and what Apply stores. They run in
// node without a DOM, which also proves the module imports without one.

import assert from "node:assert/strict";
import { NONE, SEP } from "../lib/model.js";
import {
  RENDER_CAP, facetOptions, sortOptions, visibleOptions, ensureOptions, initialSelection, selectionToRaw, canApply,
  boxSummary, boxLabel, buttonLabel, rememberOptions, defaultSort, sortModes, leafValues, placement,
  isFilterBoxOpen, closeFilterBox, refreshFilterBoxes,
} from "../lib/filter-box.js";

const values = (opts) => opts.map((o) => o.value);
const opt = (value, count, label = value, children = []) => ({ value, label, count, children });

// No DOM: the DOM entry points are safe no-ops.
{
  assert.equal(typeof document, "undefined");
  assert.equal(isFilterBoxOpen(), false);
  assert.equal(isFilterBoxOpen("type"), false);
  closeFilterBox();
  refreshFilterBoxes();
  refreshFilterBoxes(null);
}

// facetOptions: blanks count under NONE, labels come from labelFn (NONE included).
{
  const rows = [{ t: "city" }, { t: "county" }, { t: "city" }, { t: "" }, { t: null }, {}];
  const out = facetOptions(rows, (r) => r.t, (v) => (v === NONE ? "(not recorded)" : v.toUpperCase()));
  assert.deepEqual(out, [
    { value: "city", label: "CITY", count: 2, children: [] },
    { value: "county", label: "COUNTY", count: 1, children: [] },
    { value: NONE, label: "(not recorded)", count: 3, children: [] },
  ]);
}

// facetOptions: an array counts once under each distinct value; an empty
// array (or only blanks) counts under NONE; numbers become strings.
{
  const rows = [{ ad: ["12", "14"] }, { ad: ["12", "12"] }, { ad: [] }, { ad: ["", null] }, { ad: [7] }];
  const out = facetOptions(rows, (r) => r.ad);
  assert.deepEqual(out.map((o) => [o.value, o.count]), [["12", 2], ["14", 1], [NONE, 2], ["7", 1]]);
}

// facetOptions include: ticked values stay listed with count 0, as an array or a raw string.
{
  const rows = [{ c: "Fresno" }];
  assert.deepEqual(facetOptions(rows, (r) => r.c, (v) => v, { include: ["Kern", "Fresno", ""] }).map((o) => [o.value, o.count]), [["Fresno", 1], ["Kern", 0]]);
  assert.deepEqual(facetOptions(rows, (r) => r.c, (v) => v, { include: `Kern${SEP}${NONE}` }).map((o) => [o.value, o.count]), [["Fresno", 1], ["Kern", 0], [NONE, 0]]);
  assert.deepEqual(facetOptions([], (r) => r.c), []);
  assert.equal(facetOptions([{ c: "x" }], (r) => r.c, () => "")[0].label, "x", "an empty label falls back to the value");
}

// Sorting: by count with ties broken by label (never by row order); A to Z
// numeric aware; NONE last except by count; input left alone.
{
  const input = [opt("b", 5, "Bravo"), opt("a", 5, "alpha"), opt("c", 9, "Charlie"), opt(NONE, 7, "(not mapped)"), opt("d", 1, "District 10"), opt("e", 1, "District 2")];
  const before = JSON.stringify(input);
  assert.deepEqual(values(sortOptions(input, "count")), ["c", NONE, "a", "b", "e", "d"]);
  assert.deepEqual(values(sortOptions(input, "az")), ["a", "b", "c", "e", "d", NONE]);
  assert.deepEqual(values(sortOptions(input, "za")), ["d", "e", "c", "b", "a", NONE]);
  assert.deepEqual(values(sortOptions(input, "given")), values(input));
  assert.equal(JSON.stringify(input), before, "sorting copies");
}

// "1 to 9" sorts on the value as a number: districts and fiscal years.
{
  const ad = ["10", "2", "1", NONE, "80"].map((v) => opt(v, 1, v === NONE ? "(not mapped)" : `Assembly District ${v}`));
  assert.deepEqual(values(sortOptions(ad, "num")), ["1", "2", "10", "80", NONE]);
  const fy = ["2022-23", "2019-20", "2021-22"].map((v) => opt(v, 1));
  assert.deepEqual(values(sortOptions(fy, "num")), ["2019-20", "2021-22", "2022-23"]);
  assert.deepEqual(sortModes({ sort: "num" }).map(([m]) => m), ["num", "az", "za", "count"]);
  assert.deepEqual(sortModes({}).map(([m]) => m), ["az", "za", "count"]);
  assert.deepEqual(sortModes({ sort: "given" }).map(([m]) => m), ["given", "az", "za", "count"], "a listed order box can go back to it");
  assert.equal(defaultSort({ sort: "given" }), "given");
  assert.equal(defaultSort({}), "count");
  assert.equal(defaultSort({ many: true }), "az");
  assert.equal(defaultSort({ sort: "num" }), "num");
  assert.equal(defaultSort({ tree: true }), "count");
}

// Category-like tree used below: two namespaces, one leaf namespace, NOT_CLASSIFIED.
const tree = () => [
  opt("water", 9, "Water", [opt("water/storm", 4, "Stormwater"), opt("water/supply", 2, "Supply"), opt("water/", 3, "No subcategory")]),
  opt("parks", 3, "Parks", [opt("parks/quimby", 3, "Quimby")]),
  opt("fire", 12, "Fire"),
  opt(NONE, 1, "Not yet classified"),
];

// Tree sort: parents follow the mode, children stay under their parent, sorted the same way.
{
  const byCount = sortOptions(tree(), "count");
  assert.deepEqual(values(byCount), ["fire", "water", "parks", NONE]);
  assert.deepEqual(values(byCount[1].children), ["water/storm", "water/", "water/supply"]);
  const az = sortOptions(tree(), "az");
  assert.deepEqual(values(az), ["fire", "parks", "water", NONE]);
  assert.deepEqual(values(az[2].children), ["water/", "water/storm", "water/supply"]);
  assert.deepEqual(leafValues(tree()), ["water/storm", "water/supply", "water/", "parks/quimby", "fire", NONE]);
}

// Search: on labels, case and accent blind. A parent that matches keeps all
// its children; otherwise it stays only for its matching children.
{
  const cities = [opt("La Cañada Flintridge", 2), opt("Fresno", 3), opt("Canada City", 1)];
  assert.deepEqual(values(visibleOptions(cities, { search: "  CANADA ", sort: "az" }).view), ["Canada City", "La Cañada Flintridge"]);
  const water = visibleOptions(tree(), { search: "water", sort: "given" }).view;
  assert.deepEqual(values(water), ["water"]);
  assert.equal(water[0].children.length, 3);
  const storm = visibleOptions(tree(), { search: "storm", sort: "given" }).view;
  assert.deepEqual(values(storm), ["water"]);
  assert.deepEqual(values(storm[0].children), ["water/storm"]);
  assert.deepEqual(values(storm[0].allChildren), ["water/storm", "water/supply", "water/"], "the parent box still covers every child");
  assert.deepEqual(visibleOptions(tree(), { search: "zzz" }).view, []);
}

// A long list (many) shows only ticked values until the user types, and caps at RENDER_CAP.
{
  const names = Array.from({ length: 450 }, (_, i) => opt(`Agency ${String(i).padStart(3, "0")}`, 1));
  const idle = visibleOptions(names, { many: true, sort: "az", selected: new Set(["Agency 007", "Agency 300"]) });
  assert.deepEqual(values(idle.view), ["Agency 007", "Agency 300"]);
  assert.equal(idle.capped, false);
  const typed = visibleOptions(names, { many: true, sort: "az", search: "agency" });
  assert.equal(RENDER_CAP, 200);
  assert.equal(typed.view.length, 200);
  assert.equal(typed.total, 450);
  assert.equal(typed.capped, true);
  assert.equal(typed.view[0].value, "Agency 000");
  const narrow = visibleOptions(names, { many: true, sort: "az", search: "agency 1" });
  assert.equal(narrow.total, 100);
  assert.equal(narrow.capped, false);
  const plain = visibleOptions(names, { sort: "az" });
  assert.equal(plain.view.length, 450, "only a many box is capped");
}

// Initial selection: no filter ticks every value, except a many box, which starts empty.
{
  const opts = [opt("city", 2), opt("county", 1), opt(NONE, 1)];
  assert.deepEqual([...initialSelection({}, opts, "")], ["city", "county", NONE]);
  assert.deepEqual([...initialSelection({ many: true }, opts, "")], []);
  assert.deepEqual([...initialSelection({}, opts, `county${SEP}${NONE}`)], ["county", NONE]);
  assert.deepEqual([...initialSelection({ many: true }, opts, "city")], ["city"]);
}

// Initial selection in a tree: a parent value ticks all its children; "ns/"
// ticks a namespace that has no children, but only the "No subcategory"
// child of a namespace that has them.
{
  const spec = { tree: true };
  assert.deepEqual([...initialSelection(spec, tree(), "water")], ["water/storm", "water/supply", "water/"]);
  assert.deepEqual([...initialSelection(spec, tree(), "fire/")], ["fire"]);
  assert.deepEqual([...initialSelection(spec, tree(), "water/")], ["water/"]);
  assert.deepEqual([...initialSelection(spec, tree(), `parks/quimby${SEP}${NONE}`)], ["parks/quimby", NONE]);
}

// Apply: every value ticked on a box that opened unfiltered stores no
// filter; a subset joins with SEP in list order.
{
  const opts = [opt("city", 2), opt("county", 1), opt(NONE, 1)];
  assert.equal(selectionToRaw({}, opts, new Set(["city", "county", NONE])), "");
  assert.equal(selectionToRaw({}, opts, new Set(["city", "county", NONE]), { raw: "" }), "");
  assert.equal(selectionToRaw({}, opts, new Set([NONE, "city"])), `city${SEP}${NONE}`);
  assert.equal(selectionToRaw({}, opts, new Set()), "");
  assert.equal(selectionToRaw({ many: true }, opts, new Set(["city", "county", NONE])), "", "a long list ticked through stores no filter too");
  assert.equal(canApply({}, new Set()), false, "Apply is disabled with nothing ticked");
  assert.equal(canApply({ many: true }, new Set()), true, "an empty many box applies as Clear");
  assert.equal(canApply({}, new Set(["city"])), true);
}

// Apply with nothing changed on a district box (a multi-valued facet, with
// "(not mapped)" listed) filters nothing, so it stores no filter.
{
  const opts = facetOptions([{ ad: ["1", "2"] }, { ad: ["2"] }, { ad: [] }], (r) => r.ad);
  assert.deepEqual(values(opts), ["1", "2", NONE]);
  const sel = initialSelection({ sort: "num" }, opts, "");
  assert.equal(selectionToRaw({ sort: "num" }, opts, sel, { raw: "" }), "");
  sel.delete(NONE);
  assert.equal(selectionToRaw({ sort: "num" }, opts, sel, { raw: "" }), `1${SEP}2`, "unticking (not mapped) is a filter");
}

// Apply with nothing changed keeps a filter the box opened with, even when
// the other filters leave only the ticked values (or none of some of them).
{
  const spec = { key: "county-y", label: "County" };
  const narrowed = ensureOptions(spec, [opt("Fresno", 1)], `Kern${SEP}Fresno`);
  const sel = initialSelection(spec, narrowed, `Kern${SEP}Fresno`);
  assert.equal(selectionToRaw(spec, narrowed, sel, { raw: `Kern${SEP}Fresno` }), `Fresno${SEP}Kern`);
  const types = [opt("city", 41), opt("county", 28)];
  const tsel = initialSelection({}, types, `city${SEP}county`);
  assert.equal(selectionToRaw({}, types, tsel, { raw: `city${SEP}county` }), `city${SEP}county`);
  // Ticking the only value left stores it.
  assert.equal(selectionToRaw({}, [opt("parks", 3)], new Set(["parks"]), { raw: "water" }), "parks");
}

// Apply in a tree: a fully ticked parent collapses to the parent; a partial
// one stores its children. A partial parent plus a leaf must not read as
// "all ticked" just because the counts line up (an old bug).
{
  const spec = { tree: true };
  const all = new Set(leafValues(tree()));
  assert.equal(selectionToRaw(spec, tree(), all), "");
  assert.equal(selectionToRaw(spec, tree(), new Set(["water/storm", "water/supply", "water/", "fire"])), `water${SEP}fire`);
  assert.equal(selectionToRaw(spec, tree(), new Set(["water/storm", "parks/quimby", "fire", NONE])), `water/storm${SEP}parks${SEP}fire${SEP}${NONE}`);
  const two = [opt("a", 2, "A", [opt("a/1", 1, "One"), opt("a/2", 1, "Two")]), opt("b", 1, "B")];
  assert.equal(selectionToRaw(spec, two, new Set(["a/1", "b"])), `a/1${SEP}b`);
  // Round trip: what Apply stores opens with the same boxes ticked.
  for (const raw of ["water", `water/storm${SEP}fire`, `parks${SEP}${NONE}`, "water/"]) {
    assert.equal(selectionToRaw(spec, tree(), initialSelection(spec, tree(), raw)), raw);
  }
}

// Ticked values missing from the options (0 rows under the other filters)
// are added with count 0, so Apply keeps them.
{
  const spec = { key: "county-x", label: "County", text: (v) => (v === NONE ? "(not recorded)" : `${v} County`) };
  const opts = [opt("Fresno", 3)];
  const out = ensureOptions(spec, opts, `Kern${SEP}Fresno${SEP}${NONE}`);
  assert.deepEqual(out.map((o) => [o.value, o.label, o.count]), [["Fresno", "Fresno", 3], ["Kern", "Kern County", 0], [NONE, "(not recorded)", 0]]);
  assert.equal(ensureOptions(spec, opts, "Fresno"), opts, "nothing to add returns the same list");
  const sel = initialSelection(spec, out, `Kern${SEP}${NONE}`);
  assert.equal(selectionToRaw(spec, out, sel), `Kern${SEP}${NONE}`);
  // A tree value covered by its parent or by a leaf namespace is not duplicated.
  assert.equal(ensureOptions({ tree: true }, tree(), `water${SEP}water/storm${SEP}fire/`).length, tree().length);
}

// Summaries: one or two values by name, more by count; option labels win
// once a box has shown them, then spec.text, then the value.
{
  const spec = { key: "type-x", label: "Type", text: (v) => (v === NONE ? "(not recorded)" : `T:${v}`) };
  assert.equal(boxSummary(spec, ""), "");
  assert.equal(boxSummary(spec, "city"), "T:city");
  assert.equal(boxSummary(spec, `city${SEP}${NONE}`), "T:city or (not recorded)");
  assert.equal(boxSummary(spec, `a${SEP}b${SEP}c`), "3 values");
  assert.equal(boxSummary(spec, Array.from({ length: 1200 }, (_, i) => `v${i}`).join(SEP)), "1,200 values");
  assert.equal(buttonLabel(spec, ""), "Type: All");
  assert.equal(buttonLabel(spec, "city"), "Type: T:city");
  rememberOptions(spec, [opt("city", 3, "City")]);
  assert.equal(boxLabel(spec, "city"), "City");
  assert.equal(boxLabel(spec, "county"), "T:county");
  assert.equal(boxLabel({ key: "other", label: "Type" }, "city"), "city", "the cache is per box");
  assert.equal(boxLabel({ key: "plain", label: "Plain" }, NONE), "(not recorded)");
  const cat = { key: "cat-x", label: "Category", tree: true };
  rememberOptions(cat, tree());
  assert.equal(boxSummary(cat, `water/storm${SEP}fire`), "Water › Stormwater or Fire");
  assert.equal(boxLabel(cat, "water"), "Water");
}

// Placement: below the anchor when the list fits, flipped above when there
// is more room there, the list shortened when neither side fits, and the
// box kept inside a 390 px phone screen.
{
  const base = { popWidth: 300, chromeHeight: 130, listMax: 300, viewWidth: 1280, viewHeight: 800 };
  const below = placement({ ...base, rect: { left: 100, top: 100, bottom: 120 } });
  assert.deepEqual(below, { left: 92, top: 124, bottom: null, up: false, listMax: null });
  const up = placement({ ...base, rect: { left: 100, top: 700, bottom: 720 } });
  assert.equal(up.up, true);
  assert.equal(up.top, null);
  assert.equal(up.bottom, 800 - 700 + 4);
  assert.equal(up.listMax, null);
  const tight = placement({ ...base, viewHeight: 500, rect: { left: 100, top: 240, bottom: 260 } });
  assert.equal(tight.up, false, "below has more room");
  assert.equal(tight.listMax, 500 - 260 - 4 - 8 - 130);
  assert.ok(tight.top + 130 + tight.listMax <= 500 - 8);
  const phone = placement({ ...base, popWidth: 300, viewWidth: 390, viewHeight: 844, rect: { left: 360, top: 50, bottom: 70 } });
  assert.equal(phone.left, 390 - 300 - 8);
  const narrow = placement({ ...base, popWidth: 374, viewWidth: 390, viewHeight: 844, rect: { left: 4, top: 50, bottom: 70 } });
  assert.equal(narrow.left, 8);
  const tiny = placement({ ...base, viewHeight: 300, rect: { left: 0, top: 140, bottom: 160 } });
  assert.equal(tiny.listMax, 96, "the list never shrinks below a few rows");
  assert.ok(tiny.top >= 8);
}

console.log("Filter box checks passed.");
