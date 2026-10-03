// node tests/seo.test.mjs
// Checks the static pages seo/build.mjs writes: built from a small fixture
// release in a temporary directory, then (when MFA_SEO_RELEASE names a
// directory holding data/reported-fee-collections.csv and sources/index.csv)
// from the real release, also into a temporary directory.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toCsv } from "../lib/csv.js";
import { build, slugify, assignSlugs, esc, SITE } from "../seo/build.mjs";

const DATE = "2026-01-02";

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}

function readSite(dir) {
  const files = walk(dir);
  const html = new Map(files.filter((f) => f.endsWith(".html")).map((f) => [f, readFileSync(path.join(dir, f), "utf8")]));
  const sitemap = readFileSync(path.join(dir, "sitemap.xml"), "utf8");
  return { files, html, sitemap };
}

const urlOf = (rel) => `${SITE}/${rel.replace(/index\.html$/, "")}`;
const one = (re, text, what) => {
  const all = [...text.matchAll(re)];
  assert.equal(all.length, 1, `exactly one ${what}`);
  return all[0][1];
};

// Contracts every generated site meets, fixture or real.
function checkSite(dir) {
  const { html, sitemap } = readSite(dir);
  assert.ok(html.has("jurisdictions/index.html"), "hub page");
  assert.ok(html.has("about/index.html"), "about page");
  const titles = new Set();
  const descriptions = new Set();
  for (const [rel, text] of html) {
    assert.ok(text.startsWith("<!doctype html>\n<html lang=\"en\">"), `${rel}: doctype and lang`);
    assert.match(text, /<meta charset="utf-8">/, `${rel}: charset`);
    assert.match(text, /<meta name="viewport" content="width=device-width, initial-scale=1">/, `${rel}: viewport`);
    assert.match(text, /http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' https:\/\/aimesy\.github\.io; img-src 'self' data:; script-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'"/, `${rel}: CSP`);
    assert.equal(one(/<link rel="canonical" href="([^"]+)">/g, text, `${rel} canonical`), urlOf(rel), `${rel}: canonical URL`);
    titles.add(one(/<title>([^<]*)<\/title>/g, text, `${rel} title`));
    descriptions.add(one(/<meta name="description" content="([^"]*)">/g, text, `${rel} description`));
    assert.match(text, /<link rel="stylesheet" href="\/pages\.css">\n<link rel="stylesheet" href="https:\/\/aimesy\.github\.io\/themes\/src\/theme\.css">/, `${rel}: stylesheets`);
    assert.doesNotMatch(text, /\$\s*\(?\s*\d/, `${rel}: no dollar amount`);
    assert.doesNotMatch(text, /\.pdf\b|releases\/download|github\.com\/aimesy\/mfa-data/i, `${rel}: no PDF or release link`);
    assert.doesNotMatch(text, /<script(?![^>]*type="application\/ld\+json")/, `${rel}: no executable script`);
  }
  assert.equal(titles.size, html.size, "every title is unique");
  assert.equal(descriptions.size, html.size, "every description is unique");

  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(new Set(locs).size, locs.length, "no URL twice in the sitemap");
  const pages = [...html.keys()].map(urlOf);
  assert.deepEqual([...locs].sort(), [`${SITE}/`, ...pages].sort(), "the sitemap lists the home page and every generated page");
  assert.equal([...sitemap.matchAll(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g)].length, locs.length, "every URL has a lastmod");

  const jurisdictionPages = [...html.keys()].filter((f) => /^jurisdictions\/[^/]+\/index\.html$/.test(f));
  const slugs = jurisdictionPages.map((f) => f.split("/")[1]);
  assert.equal(new Set(slugs).size, slugs.length, "slugs are unique");
  for (const s of slugs) assert.match(s, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `slug ${s} is lowercase ASCII words joined by hyphens`);
  const hub = html.get("jurisdictions/index.html");
  for (const s of slugs) assert.ok(hub.includes(`href="/jurisdictions/${s}/"`), `the hub links to ${s}`);

  const about = html.get("about/index.html");
  const ldText = one(/<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/g, about, "JSON-LD block");
  const ld = JSON.parse(ldText);
  assert.equal(ld["@type"], "Dataset");
  assert.equal(ld.name, "California Mitigation Fee Database");
  assert.equal(ld.url, `${SITE}/`);
  assert.equal(ld.isAccessibleForFree, true);
  assert.equal(ld.license, "https://amyc.us/terms");
  assert.deepEqual(ld.keywords, ["mitigation fee", "impact fee", "development impact fee", "AB 1600", "California"]);
  assert.match(ld.temporalCoverage, /^\d{4}\/\d{4}$/);
  assert.ok(!("creator" in ld) && !("distribution" in ld), "no creator, no download entries");
  return { html, sitemap, locs, slugs, ld };
}

// ------------------------------------------------------------ helpers

{
  assert.equal(slugify("City of San José"), "city-of-san-jose");
  assert.equal(slugify("Smith & Jones <Water> District"), "smith-and-jones-water-district");
  assert.equal(slugify("DIAMOND SPRINGS – EL DORADO FIRE PROTECTION DISTRICT"), "diamond-springs-el-dorado-fire-protection-district");
  assert.equal(slugify("St. Mary’s Unified"), "st-marys-unified");
  const s = assignSlugs(["Cafe Town", "Café Town", "CAFE TOWN"]);
  assert.equal(new Set(s.values()).size, 3);
  assert.equal(s.get("CAFE TOWN"), "cafe-town", "the first name in code point order keeps the plain slug");
  assert.match(s.get("Café Town"), /^cafe-town-[0-9a-f]{6}$/);
  assert.equal(assignSlugs(["Café Town", "Cafe Town", "CAFE TOWN", "Other"]).get("Café Town"), s.get("Café Town"), "a suffixed slug does not depend on the other names");
  assert.equal(esc(`a & b <c> "d" 'e'`), "a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;");
}

// ------------------------------------------------------------ fixture release

const tmp = mkdtempSync(path.join(os.tmpdir(), "mfa-seo-"));
try {
  const release = path.join(tmp, "release");
  mkdirSync(path.join(release, "data"), { recursive: true });
  mkdirSync(path.join(release, "sources"), { recursive: true });

  const AMOUNTS = ["987654.32", "4242424", "-55555.5", "31337.07"];
  const columns = [
    "record_id", "receiving_entity", "entity_type", "county", "fiscal_year", "fee_program", "fee_category", "measure_as_printed",
    "figure_group_id", "is_primary_in_figure_group", "value_usd", "source_value_text", "value_is_printed_zero", "source_id",
    "physical_pdf_page", "outline_rect_pdf_points", "source_pdf", "official_source_url",
  ];
  let n = 0;
  const row = (entity, type, county, fy, program, value, source) => {
    n += 1;
    return {
      record_id: `r${n}`, receiving_entity: entity, entity_type: type, county, fiscal_year: fy, fee_program: program,
      fee_category: "parks", measure_as_printed: "Fees Collected", figure_group_id: `g${n}`, is_primary_in_figure_group: "true",
      value_usd: value, source_value_text: Number(value).toLocaleString("en-US"), value_is_printed_zero: value === "0" ? "true" : "false",
      source_id: source, physical_pdf_page: "2", outline_rect_pdf_points: "[1, 2, 3, 4]",
      source_pdf: `https://github.com/aimesy/mfa-data/releases/download/pdf-x/${source}.pdf`, official_source_url: `https://example.gov/${source}.pdf`,
    };
  };
  const ODD = "Smith & Jones <Water> District";
  const rows = [
    row("City of Example", "city", "Alpha", "2014-15", "Water Facility", AMOUNTS[0], "s1"),
    row("City of Example", "city", "Alpha", "2016-17", "Water", AMOUNTS[1], "s2"),
    row("City of Example", "city", "Alpha", "2017-18", "Parks (Fund 101)", AMOUNTS[2], "s2"),
    row("City of Example", "city", "Alpha", "2015-16", "Parks (Fund 101)", "0", "s3"),
    row("CITY OF EXAMPLE", "city", "Alpha", "2016-17", "Roads", AMOUNTS[3], "s4"),
    row(ODD, "special_district", "", "", "Capacity \"A\" & <B>", AMOUNTS[0], "s5"),
    row("Café Town", "town", "Beta", "2015-16", "Parks", "12", "s6"),
    row("Cafe Town", "city", "Beta", "2015-16", "Parks", "13", "s7"),
    row("Mixed City", "city", "", "2014-15", "Sewer", "14", "s8"),
    row("Mixed City", "city", "", "2015-16", "Sewer", "15", "s8"),
    row("Mixed City", "city", "Gamma", "2016-17", "Sewer", "16", "s9"),
    row("Mixed City", "city", "", "", "Sewer", "17", "s9"),
  ];
  // A restatement of the first figure at another grain: one figure, one report.
  rows.push({ ...rows[0], record_id: "r1b", is_primary_in_figure_group: "false" });
  writeFileSync(path.join(release, "data", "reported-fee-collections.csv"), toCsv(columns, rows));
  const sourceIds = [...new Set(rows.map((r) => r.source_id))];
  writeFileSync(path.join(release, "sources", "index.csv"), toCsv(
    ["source_id", "receiving_entity", "publication_title", "source_pdf", "official_source_url"],
    sourceIds.map((id) => ({ source_id: id, receiving_entity: "", publication_title: `Report ${id}`, source_pdf: `${id}.pdf`, official_source_url: `https://example.gov/${id}.pdf` })),
  ));

  const links = [["City of Example", "Water Facility", "Water", "balance", "$1"]];
  const out = path.join(tmp, "out");
  const r = build(release, out, { date: DATE, links });
  assert.equal(r.summary.jurisdictions.length, 6);
  assert.equal(r.summary.figures, 12);
  const site = checkSite(out);
  assert.equal(site.slugs.length, 6);
  assert.equal(site.locs.length, 3 + 6);
  assert.equal(site.ld.temporalCoverage, "2014/2018");
  assert.ok(site.sitemap.includes(`<lastmod>${DATE}</lastmod>`));

  // No amount, in any form the release prints it, reaches any page; and the
  // page copy (the fixture's names have none) uses no em dash.
  for (const [rel, text] of site.html) {
    assert.doesNotMatch(text, /—/, `${rel}: no em dash`);
    for (const v of AMOUNTS) {
      const abs = String(Math.abs(Number(v)));
      for (const form of [v, abs, Number(abs).toLocaleString("en-US"), abs.split(".")[0]]) {
        assert.ok(!text.includes(form), `${rel} prints ${form}`);
      }
    }
  }

  const bySlug = (slug) => site.html.get(`jurisdictions/${slug}/index.html`);
  // "CITY OF EXAMPLE" comes before "City of Example" in code point order, so it keeps the plain slug.
  assert.match(bySlug("city-of-example"), /<h1>CITY OF EXAMPLE impact fee reports<\/h1>/);
  const exampleSlug = site.slugs.find((s) => /^city-of-example-[0-9a-f]{6}$/.test(s));
  const city = bySlug(exampleSlug);
  assert.match(city, /<h1>City of Example impact fee reports<\/h1>/);
  assert.match(city, /City of Example is a city in Alpha County, California\. The database holds 4 published figures for it, read from 3 reports\. The earliest is for fiscal year 2014–15 and the latest for 2017–18\./);
  assert.ok(city.includes(`href="${SITE}/?e=City%20of%20Example">Open City of Example in the database</a>`));
  assert.ok(city.includes('<span class="fee">Water</span> <span class="years">FY 2014–15, 2016–17</span>\n<span class="printed">Printed as “Water Facility”, then “Water”.</span>'), "joined fee names are listed in order");
  assert.ok(city.includes('<span class="fee">Parks (Fund 101)</span> <span class="years">FY 2015–16, 2017–18</span></li>'), "a missing year stays missing");
  assert.ok(city.includes('href="/jurisdictions/"') && city.includes('href="/about/"'));

  const odd = bySlug("smith-and-jones-water-district");
  assert.ok(odd.includes("<h1>Smith &amp; Jones &lt;Water&gt; District impact fee reports</h1>"), "names are escaped");
  assert.ok(odd.includes("<title>Smith &amp; Jones &lt;Water&gt; District impact fee reports | California Mitigation Fee Database</title>"));
  assert.ok(odd.includes('<span class="fee">Capacity &quot;A&quot; &amp; &lt;B&gt;</span> <span class="years">Fiscal year not recorded</span>'));
  assert.ok(odd.includes(`href="${SITE}/?e=${encodeURIComponent(ODD)}"`));
  assert.ok(!odd.includes("<Water>") && !odd.includes("<B>"), "no raw markup from the data");
  assert.match(odd, /is a special district in California\. The database holds one published figure for it, read from one report\.<\/p>/, "no year sentence when no year is recorded");

  assert.match(bySlug("mixed-city"), /Mixed City is a city in Gamma County, California\./, "a county some of its rows record is used");
  assert.ok(bySlug("mixed-city").includes('<span class="years">FY 2014–15 to 2016–17, and one figure with no fiscal year recorded</span>'), "a figure with no year is counted, never placed in a year");
  const hub = site.html.get("jurisdictions/index.html");
  assert.ok(hub.indexOf('id="alpha-county"') < hub.indexOf('id="beta-county"') && hub.indexOf('id="gamma-county"') < hub.indexOf('id="county-not-recorded"'), "counties in order, unrecorded last");
  assert.ok(hub.includes("Smith &amp; Jones &lt;Water&gt; District</a> <span class=\"kind\">· Special district</span>"));
  assert.ok(hub.includes("Café Town</a> <span class=\"kind\">· Town</span>"));
  assert.match(site.html.get("about/index.html"), /holds 12 published figures from 6 jurisdictions, read from 9 reports, for fiscal years 2014–15 to 2017–18\./);

  // Same input, same bytes (the sitemap carries the build date).
  const again = path.join(tmp, "again");
  build(release, again, { date: DATE, links });
  const files = walk(out);
  assert.deepEqual(walk(again), files);
  for (const f of files) assert.equal(readFileSync(path.join(again, f), "utf8"), readFileSync(path.join(out, f), "utf8"), `${f} is deterministic`);

  // A page left from an earlier build for a name no longer present is removed;
  // other files are left alone.
  mkdirSync(path.join(out, "jurisdictions", "gone-city"));
  writeFileSync(path.join(out, "jurisdictions", "gone-city", "index.html"), bySlug("mixed-city"));
  mkdirSync(path.join(out, "jurisdictions", "hand-made"));
  writeFileSync(path.join(out, "jurisdictions", "hand-made", "index.html"), "<!doctype html><p>not generated</p>");
  const rebuilt = build(release, out, { date: DATE, links });
  assert.deepEqual(rebuilt.removed, ["gone-city"]);
  assert.ok(!existsSync(path.join(out, "jurisdictions", "gone-city")));
  assert.ok(existsSync(path.join(out, "jurisdictions", "hand-made", "index.html")));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------ real release

const releaseDir = process.env.MFA_SEO_RELEASE;
if (releaseDir && existsSync(path.join(releaseDir, "data", "reported-fee-collections.csv"))) {
  const out = mkdtempSync(path.join(os.tmpdir(), "mfa-seo-release-"));
  try {
    const r = build(path.resolve(releaseDir), out, { date: DATE });
    const site = checkSite(out);
    assert.equal(site.slugs.length, r.summary.jurisdictions.length);
    // A comma-grouped number on a jurisdiction page must come from its own
    // fee program names; on the hub and about page, from the counts.
    const counts = new Set([r.summary.figures, r.summary.reports, r.summary.jurisdictions.length].map((v) => v.toLocaleString("en-US")));
    for (const [rel, text] of site.html) {
      const j = r.summary.jurisdictions.find((x) => rel === `jurisdictions/${x.slug}/index.html`);
      const allowed = j ? [j.name, j.figures, j.reports, ...j.fees.flatMap((f) => [f.label, ...f.names])].map((v) => v.toLocaleString("en-US")).join("\n") : "";
      for (const m of text.matchAll(/\d{1,3}(?:,\d{3})+/g)) {
        assert.ok(j ? allowed.includes(m[0]) : counts.has(m[0]), `${rel} prints ${m[0]}`);
      }
    }
    const noCounty = r.summary.jurisdictions.filter((j) => !j.county).length;
    console.log(`release: ${r.summary.jurisdictions.length} jurisdictions (${noCounty} with no county recorded), ${site.html.size} pages, ${site.locs.length} sitemap URLs, ${r.summary.figures} figures, ${r.summary.reports} reports, ${r.problems.length} figure groups without one primary row`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

console.log("seo tests passed");
