// node tests/export.test.mjs
// Checks for the downloads (lib/export.js): the CSV guards and layout, the
// file name, and that the HTML report escapes every value, emits only web
// links, leaves missing cells empty and stays a script-free document.

import assert from "node:assert/strict";
import { parseCsv, toCsv } from "../lib/csv.js";
import { csvCell, csvText, downloadText, esc, exportFilename, reportHtml } from "../lib/export.js";

// ------------------------------------------------------------ csvCell

// Text a spreadsheet would run as a formula gets an apostrophe.
for (const [v, want] of [
  ["=1+1", "'=1+1"],
  ["+x", "'+x"],
  ["-x", "'-x"],
  ["-abc", "'-abc"],
  ["@x", "'@x"],
  ["\tx", "'\tx"],
  ["\rx", "\"'\rx\""],
  ["=HYPERLINK(\"http://x\",\"y\")", "\"'=HYPERLINK(\"\"http://x\"\",\"\"y\"\")\""],
  ["-1+2", "'-1+2"],
  ["+1 (415) 555-1212", "'+1 (415) 555-1212"],
  ["-", "'-"],
]) assert.equal(csvCell(v), want, `csvCell(${JSON.stringify(v)})`);

// Plain numbers stay numeric, signed or grouped.
for (const [v, want] of [
  [-1234.5, "-1234.5"],
  ["-1234.5", "-1234.5"],
  ["+42", "+42"],
  ["-0.25", "-0.25"],
  ["-.5", "-.5"],
  ["-1e-7", "-1e-7"],
  [-1e-7, "-1e-7"],
  ["-1,234.50", "\"-1,234.50\""],
  ["+1,234", "\"+1,234\""],
  [0, "0"],
  [43805, "43805"],
]) assert.equal(csvCell(v), want, `csvCell(${JSON.stringify(v)})`);
// Not a grouped number: a bad group is text.
assert.equal(csvCell("-1,23"), "\"'-1,23\"");

// Quoting, missing values and the shapes a row may carry.
assert.equal(csvCell("a,b"), "\"a,b\"");
assert.equal(csvCell('say "hi"'), "\"say \"\"hi\"\"\"");
assert.equal(csvCell("line1\nline2"), "\"line1\nline2\"");
assert.equal(csvCell("line1\r\nline2"), "\"line1\r\nline2\"");
assert.equal(csvCell("plain"), "plain");
assert.equal(csvCell(null), "");
assert.equal(csvCell(undefined), "");
assert.equal(csvCell(""), "");
assert.equal(csvCell(NaN), "");
assert.equal(csvCell(true), "true");
assert.equal(csvCell(["12", "14"]), "12; 14");
assert.equal(csvCell({ text: "report", href: "https://example.gov/a.pdf" }), "https://example.gov/a.pdf");
assert.equal(csvCell({ text: "=evil" }), "'=evil");

// ------------------------------------------------------------ csvText

{
  const columns = [{ key: "name", label: "Agency" }, { key: "fy", label: "Fiscal year" }, { key: "usd", label: "Value (USD)" }, "note"];
  const rows = [
    { name: "Madera city", fy: "2019-20", usd: "43805.0", note: "" },
    { name: "=cmd|' /C calc'!A0", fy: "2020-21", usd: -1234.5, note: 'has "quotes", commas\r\nand a break' },
    { name: "Davis, City of", fy: "2021-22", usd: null },
  ];
  const text = csvText(columns, rows);
  assert.ok(text.startsWith("\uFEFFAgency,Fiscal year,Value (USD),note\r\n"), "BOM, then the header labels");
  assert.ok(text.endsWith("\r\n"), "ends with CRLF");
  assert.doesNotMatch(text, /[^\r]\n/, "line breaks are CRLF");
  const lines = text.slice(1).split("\r\n");
  assert.equal(lines[1], "Madera city,2019-20,43805.0,");
  const parsed = parseCsv(text);
  assert.deepEqual(parsed[0], ["Agency", "Fiscal year", "Value (USD)", "note"]);
  assert.deepEqual(parsed[2], ["'=cmd|' /C calc'!A0", "2020-21", "-1234.5", 'has "quotes", commas\r\nand a break']);
  assert.deepEqual(parsed[3], ["Davis, City of", "2021-22", "", ""], "a missing value is an empty cell, never 0");
  assert.equal(parsed.length, 4);

  const noBom = csvText(["a", "b"], [{ a: 1, b: 2 }], { bom: false });
  assert.equal(noBom, "a,b\r\n1,2\r\n");
  // Same layout as lib/csv.js toCsv for safe values, which stays unchanged.
  assert.equal(noBom, toCsv(["a", "b"], [{ a: 1, b: 2 }]));
  assert.equal(csvText(["a"], []), "\uFEFFa\r\n");
  // Rows may be arrays, and a column may compute its value.
  assert.equal(csvText(["x", "y"], [[1, "two"]], { bom: false }), "x,y\r\n1,two\r\n");
  assert.equal(csvText([{ key: "d", label: "Districts", value: (r) => r.ad }], [{ ad: ["7", "8"] }], { bom: false }), "Districts\r\n7; 8\r\n");
}

// ------------------------------------------------------------ exportFilename

{
  const day = new Date(2026, 10, 6, 23, 30);
  assert.equal(exportFilename("figures", "csv", day), "mfa-figures-2026-11-06.csv");
  assert.equal(exportFilename("mfa-figures", ".CSV", day), "mfa-figures-2026-11-06.csv");
  assert.equal(exportFilename("Assembly District 12: Fees & Funds", "html", day), "mfa-assembly-district-12-fees-funds-2026-11-06.html");
  assert.equal(exportFilename("Cañada Unified", "csv", new Date(2026, 0, 2)), "mfa-canada-unified-2026-01-02.csv");
  assert.equal(exportFilename("../../etc/passwd", "csv", day), "mfa-etc-passwd-2026-11-06.csv");
  assert.equal(exportFilename("", "", day), "mfa-export-2026-11-06.txt");
  assert.match(exportFilename("x".repeat(300), "csv", day), /^mfa-x{80}-2026-11-06\.csv$/);
  assert.match(exportFilename("figures", "csv"), /^mfa-figures-\d{4}-\d{2}-\d{2}\.csv$/);
}

// ------------------------------------------------------------ esc

assert.equal(esc(`<a href="x" title='y'>&amp;</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;");
assert.equal(esc(null), "");
assert.equal(esc(undefined), "");
assert.equal(esc(0), "0");

// ------------------------------------------------------------ reportHtml: hostile values

const IMG = "<img src=x onerror=alert(1)>";
const STYLE_BREAK = '"</style><script>alert(2)</script>';
const ATTR_BREAK = `" onmouseover="alert(3)" x='`;
const hostile = (tag) => `${tag} ${IMG} ${STYLE_BREAK} ${ATTR_BREAK}`;

const ALLOWED_TAGS = new Set([
  "html", "head", "meta", "title", "style", "body", "header", "div", "p", "h1", "h2", "dl", "dt", "dd", "time", "code",
  "a", "span", "main", "strong", "aside", "ul", "li", "section", "input", "label", "table", "thead", "tbody", "tr", "th", "td", "footer",
]);

const ALLOWED_ATTRS = new Set([
  "lang", "charset", "name", "content", "http-equiv", "class", "id", "datetime", "title", "href", "rel", "target",
  "type", "checked", "for", "aria-labelledby", "aria-hidden", "scope", "tabindex", "role",
]);

// The attributes of one tag, reading quoted values whole so a quoted
// "onerror=" is a value, not an attribute.
function attrsOf(src) {
  const out = [];
  const re = /\s*([^\s=>"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  let m;
  while ((m = re.exec(src)) && m[0]) out.push({ name: m[1].toLowerCase(), value: m[2] });
  return out;
}

function tagsOf(html) {
  return [...html.matchAll(/<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)].map((m) => ({ name: m[1].toLowerCase(), attrs: m[2], raw: m[0] }));
}

function styleBlock(html) {
  const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  assert.equal(blocks.length, 1, "exactly one style block");
  return blocks[0][1];
}

function hrefs(html) {
  return [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);
}

{
  const report = {
    title: hostile("Title"),
    subtitle: hostile("Subtitle"),
    generated_utc: "2026-11-06T18:05:00Z",
    release: hostile("Release"),
    permalink: "javascript:alert(4)",
    filters: [hostile("Filter A"), { label: hostile("Label"), value: hostile("Value") }],
    caveats: [hostile("Caveat")],
    stats: [
      { label: hostile("Stat label"), value: hostile("Stat value"), note: hostile("Stat note") },
      { label: "Fees collected", value: 1234567.5, kind: "usd" },
      { label: "Missing", value: "" },
    ],
    tabs: [
      {
        key: hostile("key"),
        label: hostile("Tab A"),
        intro: hostile("Intro"),
        note: hostile("Note"),
        columns: [
          { key: "name", label: hostile("Col name"), kind: "text" },
          { key: "src", label: hostile("Col link"), kind: "link" },
          { key: "usd", label: "Collected", kind: "usd" },
          { key: "n", label: "Figures", kind: "int" },
          { key: "fy", label: "FY", kind: "fy" },
          { key: "share", label: "Residents in district", kind: "pct" },
          { key: "ad", label: "Assembly", kind: "list" },
        ],
        rows: [
          { name: hostile("Cell"), src: { text: hostile("Link text"), href: "javascript:alert(5)" }, usd: "43805.0", n: "12", fy: "2019-20", share: 0.4237, ad: ["7", hostile("AD")] },
          { name: "Davis city", src: { text: "Report", href: " JaVaScRiPt:alert(6)" }, usd: "", n: null, fy: "", share: null, ad: [] },
          { name: "Data link", src: { text: "Data", href: "data:text/html,<script>alert(7)</script>" }, usd: undefined, n: "", fy: null, share: "", ad: null },
          { name: "Vb link", src: { text: "Vb", href: "vbscript:msgbox(1)" }, usd: -1234, n: 0, fy: "2024-25", share: 0, ad: "12" },
          { name: "Ok link", src: { text: "City report", href: 'https://example.gov/r.pdf?a=1&b="2"' }, usd: 1234567, n: 1234, fy: "2020-21", share: 1, ad: ["1"] },
          { name: "Bare url", src: "https://example.gov/plain", usd: "1,234.50", n: 3, fy: "2021-22", share: 0.0004, ad: ["2"] },
          { name: "File link", src: { text: "Local", href: "file:///etc/passwd" }, usd: 0.5, n: 1, fy: "2022-23", share: 0.9996, ad: ["3"] },
        ],
      },
      { key: "b", label: hostile("Tab B"), columns: [{ key: "x", label: "X" }], rows: [] },
      { key: "c", label: "Tab C", columns: ["x"], rows: [{ x: hostile("C cell") }] },
    ],
  };
  const html = reportHtml(report);

  // A full document.
  assert.ok(html.startsWith("<!doctype html>\n<html lang=\"en\">"), "starts with a doctype");
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<\/body>\n<\/html>\n$/);
  assert.equal((html.match(/<head>/g) || []).length, 1);
  assert.equal((html.match(/<body>/g) || []).length, 1);

  // No markup from data: every tag is one the builder writes, with no handler.
  for (const t of tagsOf(html)) {
    assert.ok(ALLOWED_TAGS.has(t.name), `unexpected tag <${t.name}>: ${t.raw.slice(0, 80)}`);
    for (const at of attrsOf(t.attrs)) {
      assert.ok(ALLOWED_ATTRS.has(at.name), `unexpected attribute ${at.name} in ${t.raw.slice(0, 80)}`);
      assert.ok(at.value == null || at.value.startsWith('"'), `unquoted attribute value in ${t.raw.slice(0, 80)}`);
      // The policy meta is the one constant that quotes with apostrophes.
      const unsafe = t.name === "meta" && /http-equiv="Content-Security-Policy"/.test(t.attrs) ? /[<>]/ : /['<>]/;
      assert.doesNotMatch((at.value || "").slice(1, -1), unsafe, `unescaped character in ${at.name}`);
    }
  }
  assert.doesNotMatch(html, /<script/i, "no script element");
  assert.doesNotMatch(html, /<img/i, "no image element");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "the hostile name is shown as text");
  assert.ok(html.includes("&quot;&lt;/style&gt;&lt;script&gt;alert(2)&lt;/script&gt;"), "a style breakout is shown as text");
  assert.ok(html.includes("&quot; onmouseover=&quot;alert(3)&quot; x=&#39;"), "an attribute breakout is shown as text");

  // Every field reached the page, escaped.
  for (const tag of ["Title", "Subtitle", "Release", "Filter A", "Label", "Value", "Caveat", "Stat label", "Stat value", "Stat note",
    "Tab A", "Intro", "Note", "Col name", "Col link", "Cell", "Link text", "AD", "Tab B", "C cell"]) {
    assert.ok(html.includes(esc(hostile(tag))), `${tag} is shown, escaped`);
  }
  // The <title> holds the escaped title only.
  assert.equal(/<title>([^<]*)<\/title>/.exec(html)?.[1], esc(hostile("Title")));

  // The stylesheet is the same constant whatever the data.
  const plain = reportHtml({ title: "x", tabs: [{ label: "A", columns: ["a"], rows: [{ a: 1 }] }] });
  assert.equal(styleBlock(html), styleBlock(plain), "no report value reaches the style block");
  assert.doesNotMatch(styleBlock(html), /alert|Title|Tab A/);

  // Only http and https links are emitted.
  const links = hrefs(html);
  assert.deepEqual(links, ["https://example.gov/r.pdf?a=1&amp;b=%222%22", "https://example.gov/plain"], "only web links survive");
  assert.doesNotMatch(html, /href="\s*(javascript|data|vbscript|file):/i);
  assert.ok(!html.includes("Open this view on"), "a javascript: permalink is dropped");
  assert.ok(html.includes(">Report</td>") && html.includes(">Data</td>") && html.includes(">Vb</td>") && html.includes(">Local</td>"), "a dropped link keeps its text");

  // Cells: missing is empty, never 0; formats by kind.
  const rowsOf = (h) => [...h.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1]));
  const tableA = rowsOf(html.slice(html.indexOf('id="ph-0"'), html.indexOf('id="tab-1"')));
  assert.deepEqual(tableA[0], [esc(hostile("Col name")), esc(hostile("Col link")), "Collected", "Figures", "FY", "Residents in district", "Assembly"]);
  assert.deepEqual(tableA[1].slice(2), ["$43,805", "12", "2019\u201320", "42.4%", `7; ${esc(hostile("AD"))}`]);
  assert.deepEqual(tableA[2].slice(2), ["", "", "", "", ""], "blank strings and nulls stay empty");
  assert.deepEqual(tableA[3].slice(2), ["", "", "", "", ""], "undefined and empty stay empty");
  assert.deepEqual(tableA[4].slice(2), ["($1,234)", "0", "2024\u201325", "0%", "12"], "a real zero is shown");
  assert.deepEqual(tableA[5].slice(2), ["$1,234,567", "1,234", "2020\u201321", "100%", "1"]);
  assert.deepEqual(tableA[6].slice(2), ["$1,234.50", "3", "2021\u201322", "&lt;0.1%", "2"], "cents are kept");
  assert.deepEqual(tableA[7].slice(2), ["$0.50", "1", "2022\u201323", "&gt;99.9%", "3"]);
  assert.equal(tableA.length, 8, "a header row and seven body rows");
  assert.match(html, /<td class="num">\$43,805<\/td>/, "numbers are right aligned");
  assert.match(html, /<th scope="col" class="num">Collected<\/th>/);

  // Stats tiles.
  assert.match(html, /<dd class="tv num">\$1,234,567\.50<\/dd>/, "a number tile is marked so it never wraps");
  assert.match(html, /<dd class="tv missing">\u2013<\/dd>/, "a missing stat is marked, not 0");
  assert.ok(html.indexOf("Key statistics") < html.indexOf('class="tabs"'), "statistics come before the tabs");
  assert.ok(html.indexOf("Before you use these numbers") < html.indexOf("Key statistics"), "the caveats come before the statistics");

  // Tabs: one radio per tab, the first checked, each with a panel.
  const radios = [...html.matchAll(/<input class="tab-radio" type="radio" name="report-tab" id="tab-(\d+)"( checked)?>/g)];
  assert.deepEqual(radios.map((m) => m[1]), ["0", "1", "2"]);
  assert.deepEqual(radios.map((m) => Boolean(m[2])), [true, false, false]);
  assert.equal((html.match(/<input /g) || []).length, 3, "no other inputs");
  assert.equal((html.match(/<label class="tab" for="tab-\d+">/g) || []).length, 3);
  assert.equal((html.match(/<section class="panel"/g) || []).length, 3);
  assert.match(html, /<p class="rowcount">7 rows<\/p>/);
  assert.match(html, /<p class="rowcount">0 rows<\/p>\n<p class="empty">No rows match these filters\.<\/p>/);
  assert.match(html, /<p class="rowcount">1 row<\/p>/);

  // A cut table says so in its badge and in a notice that points to the CSV.
  const cut = reportHtml({ tabs: [{ label: "Figures", columns: ["a"], rows: [{ a: 1 }, { a: 2 }], total: 11818 }] });
  assert.match(cut, /<span class="tab-n">2 of 11,818<span class="vh"> rows<\/span><\/span>/);
  assert.match(cut, /<p class="rowcount cut">This table shows the first 2 of 11,818 rows, in the tab&#39;s order\. The CSV of this tab holds every row\.<\/p>/);
  assert.match(reportHtml({ tabs: [{ label: "A", columns: ["a"], rows: [{ a: 1 }], total: 1 }] }), /<p class="rowcount">1 row<\/p>/, "a whole table has no notice");

  // Printed, the report turns landscape and sets wide tables smaller.
  assert.match(styleBlock(html), /@page \{ size: letter landscape;/);
  assert.match(styleBlock(html), /table:has\(thead th:nth-child\(10\)\) \{ font-size: 7pt; \}/);
  assert.match(styleBlock(html), /@media print \{[^]*td\.link \{ min-width: 0; overflow-wrap: anywhere; \}/, "printed, no link column forces a table off the page");

  // Generated time in UTC and Pacific.
  assert.match(html, /<time datetime="2026-11-06T18:05:00\.000Z">2026-11-06 18:05 UTC \(Nov 6, 2026, 10:05 AM PST\)<\/time>/);
}

// ------------------------------------------------------------ reportHtml: an ordinary view

{
  const html = reportHtml({
    title: "Assembly District 12",
    subtitle: "Impact fee collections by agencies that touch the district",
    generated_utc: "2026-07-01T16:00:00Z",
    release: "1b613cb2f0e4a1c7d9e8f6a5b4c3d2e1f0a9b8c7",
    permalink: "https://mfa.amyc.us/?view=figures&ad=12",
    filters: ["Assembly District: 12"],
    caveats: ["An agency counts when any part of it lies in the district."],
    stats: [{ label: "Figures", value: 1234 }],
    stats_scope: "From the Figures tab.",
    tabs: [{ label: "Figures", columns: [{ key: "a", label: "A" }], rows: [{ a: "x" }] }],
  });
  assert.match(html, /<a class="open-link" href="https:\/\/mfa\.amyc\.us\/\?view=figures&amp;ad=12" rel="noopener noreferrer" target="_blank">Open this view on mfa\.amyc\.us /);
  assert.match(html, /<code title="1b613cb2f0e4a1c7d9e8f6a5b4c3d2e1f0a9b8c7">1b613cb<\/code>/, "a commit is shown short, in full on hover");
  assert.match(html, /\(Jul 1, 2026, 9:00 AM PDT\)/, "Pacific time follows daylight saving");
  assert.match(html, /<strong>Filtered to<\/strong> <span class="f">Assembly District: 12<\/span>\./);
  assert.match(html, /<dd class="tv num">1,234<\/dd>/);
  assert.match(html, /<h2 class="section-h" id="stats-h">Key statistics<\/h2>\n<p class="stats-scope">From the Figures tab\.<\/p>/, "the tiles say what they count");
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'/);

  const many = reportHtml({ filters: ["A: 1", "B: 2", "C: 3"] });
  assert.match(many, /<span class="f">A: 1<\/span>, <span class="f">B: 2<\/span> and <span class="f">C: 3<\/span>\./);
  const none = reportHtml({});
  assert.match(none, /<strong>Filters:<\/strong> none\./);
  assert.doesNotMatch(none, /class="tabs"|class="callout"|class="stats"/, "empty parts are left out");
  assert.match(none, /<title>Impact fee report<\/title>/);
  assert.equal(reportHtml(null).startsWith("<!doctype html>"), true);
}

// ------------------------------------------------------------ downloadText, with a stand-in DOM

{
  const made = [];
  const body = { children: [], append(n) { this.children.push(n); n.parent = this; } };
  globalThis.document = {
    body,
    createElement(tag) {
      const node = {
        tag, attrs: {}, clicked: 0, parent: null,
        setAttribute(k, v) { this.attrs[k] = v; },
        click() { this.clicked += 1; },
        remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
      };
      made.push(node);
      return node;
    },
  };
  const revoked = [];
  const created = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { created.push(blob); return `blob:test/${created.length}`; };
  URL.revokeObjectURL = (u) => { revoked.push(u); };
  try {
    downloadText("a,b\r\n", "mfa-figures-2026-11-06.csv", "text/csv");
    assert.equal(made.length, 1);
    const a = made[0];
    assert.equal(a.tag, "a");
    assert.equal(a.attrs.href, "blob:test/1");
    assert.equal(a.attrs.download, "mfa-figures-2026-11-06.csv");
    assert.equal(a.clicked, 1);
    assert.equal(created[0].type, "text/csv;charset=utf-8");
    assert.equal(await created[0].text(), "a,b\r\n");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepEqual(revoked, ["blob:test/1"], "the object URL is revoked");
    assert.equal(body.children.length, 0, "the link is removed");
    downloadText("<!doctype html>", "r.html", "text/html;charset=utf-8");
    assert.equal(created[1].type, "text/html;charset=utf-8");
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    delete globalThis.document;
  }
}

console.log("export tests passed");
