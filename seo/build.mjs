// node seo/build.mjs <release dir> <output dir>
//
// Writes static, crawlable pages for the viewer from the release's own files:
// jurisdictions/index.html (every jurisdiction, by county), one page for each
// jurisdiction at jurisdictions/<slug>/index.html, about/index.html and
// sitemap.xml. The viewer draws everything else with JavaScript, so these are
// the only pages a search engine can read.
//
// The pages name jurisdictions, fee programs, fiscal years and counts. They
// never print an amount, a report URL or a PDF link: the figures stay in the
// viewer. Every value from the release is HTML-escaped. The same release
// gives the same bytes; only sitemap.xml carries the build date.
//
// <release dir> holds data/reported-fee-collections.csv and sources/index.csv.
// In CI it runs in the repository root with <output dir> ".".

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsvObjects } from "../lib/csv.js";
import { buildModel, entityTypeLabel, fmtFy, fmtInt, fyRanges } from "../lib/model.js";
import { FEE_LINKS } from "../lib/fee-links.js";

export const SITE = "https://mfa.amyc.us";
export const DB_NAME = "California Mitigation Fee Database";
const GENERATOR = "mfa seo/build.mjs";
const THEME_CSS = "https://aimesy.github.io/themes/src/theme.css";
const TERMS = "https://amyc.us/terms";
const CSP = "default-src 'self'; style-src 'self' https://aimesy.github.io; img-src 'self' data:; script-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";

// ------------------------------------------------------------ text

const HTML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESC[c]);
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Collated order, with a code point tie break so the order is total.
const byName = (a, b) => collator.compare(a, b) || byCodepoint(a, b);

const count = (n, one, many) => (n === 1 ? `one ${one}` : `${fmtInt(n)} ${many}`);
const quoted = (s) => `“${esc(s)}”`;

// "City of San José" -> "city-of-san-jose"; "Smith & Jones" -> "smith-and-jones".
export function slugify(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// One slug per name. Names that share a slug are ordered by code point; the
// first keeps the plain slug and each other one adds the start of the SHA-256
// of its exact name, so its slug does not depend on which other names exist.
export function assignSlugs(names) {
  const groups = new Map();
  for (const name of [...new Set(names)].sort(byCodepoint)) {
    const base = slugify(name) || "jurisdiction";
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(name);
  }
  const slugs = new Map();
  const taken = new Set();
  for (const [base, list] of groups) {
    slugs.set(list[0], base);
    taken.add(base);
  }
  for (const [base, list] of groups) {
    for (const name of list.slice(1)) {
      const hash = createHash("sha256").update(name, "utf8").digest("hex");
      let len = 6;
      let slug = `${base}-${hash.slice(0, len)}`;
      while (taken.has(slug)) slug = `${base}-${hash.slice(0, (len += 2))}`;
      slugs.set(name, slug);
      taken.add(slug);
    }
  }
  return slugs;
}

// ------------------------------------------------------------ model

// The model's county for a jurisdiction is the most common value on its
// figures, which can be blank where most rows leave it blank. A county that
// some of its own rows record is used then; otherwise it stays unrecorded.
function countyOf(entity) {
  if (entity.county) return entity.county;
  const counts = new Map();
  for (const f of entity.figures) {
    const c = f.primary.county;
    if (c) counts.set(c, (counts.get(c) || 0) + 1);
  }
  const [best] = [...counts].sort((a, b) => b[1] - a[1] || byName(a[0], b[0]));
  return best ? best[0] : "";
}

function yearsOf(list) {
  return [...new Set(list)].filter(Boolean).sort();
}

export function describe(model) {
  const slugs = assignSlugs(model.entities.map((e) => e.name));
  const jurisdictions = model.entities
    .map((e) => {
      const years = yearsOf(e.yearList);
      const fees = [...e.fees]
        .sort((a, b) => byName(a.label, b.label) || byName(a.id, b.id))
        .map((fee) => ({
          label: fee.label,
          names: fee.names,
          years: yearsOf(fee.yearList),
          noYear: fee.figures.filter((f) => !f.fy).length,
        }));
      return {
        name: e.name,
        slug: slugs.get(e.name),
        type: e.type,
        typeLabel: entityTypeLabel(e.type),
        county: countyOf(e),
        figures: e.figures.length,
        reports: e.sources.size,
        years,
        fees,
      };
    })
    .sort((a, b) => byName(a.name, b.name));
  const years = yearsOf(model.figures.map((f) => f.fy));
  return {
    jurisdictions,
    figures: model.figures.length,
    reports: new Set(model.figures.map((f) => f.sourceId)).size,
    firstYear: years[0] || "",
    lastYear: years[years.length - 1] || "",
  };
}

// ------------------------------------------------------------ pages

function page({ urlPath, title, description, body, head = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(SITE + urlPath)}">
<meta name="generator" content="${GENERATOR}">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/pages.css">
<link rel="stylesheet" href="${THEME_CSS}">
${head}</head>
<body>
<header class="site">
<div class="bar">
<a class="home" href="/">${esc(DB_NAME)}</a>
<nav aria-label="Site"><a href="/jurisdictions/">Jurisdictions</a> <a href="/about/">About</a></nav>
</div>
</header>
<main>
${body}</main>
</body>
</html>
`;
}

const jurisdictionPath = (j) => `/jurisdictions/${j.slug}/`;
const viewerLink = (name) => `${SITE}/?e=${encodeURIComponent(name)}`;
const countyName = (county) => (county ? `${county} County` : "County not recorded");

function yearSpan(years) {
  if (!years.length) return "";
  if (years.length === 1) return `fiscal year ${fmtFy(years[0])}`;
  return `fiscal years ${fmtFy(years[0])} to ${fmtFy(years[years.length - 1])}`;
}

function jurisdictionPage(j) {
  const type = j.type ? j.typeLabel.toLowerCase() : "jurisdiction";
  const where = j.county ? `${esc(j.county)} County, California` : "California";
  const sentences = [
    `${esc(j.name)} is a ${esc(type)} in ${where}.`,
    `The database holds ${count(j.figures, "published figure", "published figures")} for it, read from ${count(j.reports, "report", "reports")}.`,
  ];
  if (j.years.length === 1) {
    sentences.push(`${j.figures === 1 ? "It is" : "They are"} for fiscal year ${fmtFy(j.years[0])}.`);
  } else if (j.years.length) {
    sentences.push(`The earliest is for fiscal year ${fmtFy(j.years[0])} and the latest for ${fmtFy(j.years[j.years.length - 1])}.`);
  }
  const fees = j.fees
    .map((fee) => {
      let years = fee.years.length ? `FY ${esc(fyRanges(fee.years))}` : "Fiscal year not recorded";
      if (fee.years.length && fee.noYear) years += `, and ${count(fee.noYear, "figure", "figures")} with no fiscal year recorded`;
      const printed = fee.names.length > 1 || fee.names[0] !== fee.label
        ? `\n<span class="printed">Printed as ${fee.names.map(quoted).join(", then ")}.</span>`
        : "";
      return `<li><span class="fee">${esc(fee.label)}</span> <span class="years">${years}</span>${printed}</li>`;
    })
    .join("\n");
  const where2 = j.county ? `, ${j.county} County` : "";
  const description = `Impact fee reports from ${j.name}${where2}, California: ${j.figures === 1 ? "one published figure" : `${fmtInt(j.figures)} published figures`} from ${j.reports === 1 ? "one report" : `${fmtInt(j.reports)} reports`}${j.years.length ? `, ${yearSpan(j.years)}` : ""}, in the ${DB_NAME}.`;
  const body = `<p class="crumbs"><a href="/jurisdictions/">Jurisdictions</a> · ${esc(countyName(j.county))}</p>
<h1>${esc(j.name)} impact fee reports</h1>
<p class="lede">${sentences.join(" ")}</p>
<p class="open"><a class="button" href="${esc(viewerLink(j.name))}">Open ${esc(j.name)} in the database</a></p>
<h2>Fee programs</h2>
<p class="note">Each fee program as its reports print it, with the fiscal years for which the database holds a figure.</p>
<ul class="fees">
${fees}
</ul>
<p class="foot-links"><a href="/jurisdictions/">All jurisdictions</a> · <a href="/about/">About the database</a></p>
`;
  return page({ urlPath: jurisdictionPath(j), title: `${j.name} impact fee reports | ${DB_NAME}`, description, body });
}

function countyGroups(jurisdictions) {
  const groups = new Map();
  for (const j of jurisdictions) {
    if (!groups.has(j.county)) groups.set(j.county, []);
    groups.get(j.county).push(j);
  }
  // Counties in alphabetical order; jurisdictions with no county last.
  return [...groups.entries()]
    .sort((a, b) => (!a[0] - !b[0]) || byName(a[0], b[0]))
    .map(([county, list]) => ({ county, id: county ? `${slugify(county)}-county` : "county-not-recorded", list }));
}

function hubPage(summary) {
  const groups = countyGroups(summary.jurisdictions);
  const index = groups.map((g) => `<a href="#${g.id}">${esc(countyName(g.county))}</a>`).join("\n");
  const sections = groups
    .map((g) => {
      const items = g.list
        .map((j) => `<li><a href="${jurisdictionPath(j)}">${esc(j.name)}</a> <span class="kind">· ${esc(j.typeLabel)}</span></li>`)
        .join("\n");
      return `<section class="county" id="${g.id}">
<h2>${esc(countyName(g.county))}</h2>
<ul class="jurisdictions">
${items}
</ul>
</section>`;
    })
    .join("\n");
  const n = summary.jurisdictions.length;
  const body = `<h1>California jurisdictions in the Mitigation Fee Database</h1>
<p class="lede">The ${esc(DB_NAME)} holds impact fee figures from ${fmtInt(n)} California ${n === 1 ? "jurisdiction" : "jurisdictions"}, listed here by county. Each page lists a jurisdiction’s fee programs and the fiscal years for which the database holds a figure, with a link to open it in the database.</p>
<nav class="counties" aria-label="Counties">
${index}
</nav>
${sections}
<p class="foot-links"><a href="/">Open the database</a> · <a href="/about/">About the database</a></p>
`;
  return page({
    urlPath: "/jurisdictions/",
    title: `California jurisdictions in the Mitigation Fee Database`,
    description: `Impact fee reports from ${fmtInt(n)} California cities, counties, school districts, special districts and other local agencies, listed by county, in the ${DB_NAME}.`,
    body,
  });
}

function datasetLd(summary) {
  const startYear = summary.firstYear.slice(0, 4);
  const endYear = summary.lastYear ? String(Number(summary.lastYear.slice(0, 4)) + 1) : "";
  const ld = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: DB_NAME,
    description: "Impact fee collections that California cities, counties, school districts, special districts and other local agencies reported. Every published figure was read from the original report, outlined on the page it sits on, checked against the source’s own arithmetic, and reviewed twice before release.",
    url: `${SITE}/`,
    keywords: ["mitigation fee", "impact fee", "development impact fee", "AB 1600", "California"],
    spatialCoverage: { "@type": "Place", name: "California" },
    ...(startYear && endYear ? { temporalCoverage: `${startYear}/${endYear}` } : {}),
    isAccessibleForFree: true,
    license: TERMS,
  };
  // A data block, never executed; "<" is escaped so no value can close the tag.
  return `<script type="application/ld+json">\n${JSON.stringify(ld, null, 2).replace(/</g, "\\u003c")}\n</script>\n`;
}

function aboutPage(summary) {
  const span = summary.firstYear === summary.lastYear
    ? `fiscal year ${fmtFy(summary.firstYear)}`
    : `fiscal years ${fmtFy(summary.firstYear)} to ${fmtFy(summary.lastYear)}`;
  const body = `<h1>About the California Mitigation Fee Database</h1>
<p class="lede">The ${esc(DB_NAME)} holds the impact fee collections that California cities, counties, school districts, special districts and other local agencies reported, each figure shown on the page of the report it was read from. Every published figure was read from the original report, outlined on the page it sits on, checked against the source’s own arithmetic, and reviewed twice before release.</p>
<p class="open"><a class="button" href="${SITE}/">Open the database</a></p>
<h2>Coverage</h2>
<p>The current release holds ${fmtInt(summary.figures)} published figures from ${fmtInt(summary.jurisdictions.length)} jurisdictions, read from ${fmtInt(summary.reports)} reports, for ${span}. Coverage differs by agency and year. A program year with no figure stays empty, and a zero appears only where the report prints one.</p>
<p>These are amounts the agencies reported collecting. Names appear as the source prints them. Some rows are not Mitigation Fee Act fees: Quimby Act park in lieu accounts and section 66013 capacity charges appear where the agency reported them beside its impact fees, and each such row says so.</p>
<h2>How each figure is checked</h2>
<ul>
<li>Opening a figure in the database shows the outlined evidence page, scrolled to the figure. One click then opens the complete original report at that page.</li>
<li>Each evidence file and original report is hashed in the browser (SHA-256) and compared with the hash the release records.</li>
<li>A box is drawn around a figure only after the viewer confirms it sits on the red outline in that figure’s own evidence file. Where it does not, the viewer draws nothing and says why.</li>
<li>A printed number recorded at two measure grains is shown once and added once.</li>
</ul>
<h2>What the database shows</h2>
<ul>
<li><strong>Jurisdictions.</strong> Each agency’s fees by fiscal year. Every cell opens its evidence, and a program year with no figure stays empty.</li>
<li><strong>Fees.</strong> Each fee’s history, year by year, with the name the report printed and the page. An agency that renamed or renumbered a fund keeps one fee, labelled with every number it carried.</li>
<li><strong>Sources.</strong> Each original report, with every published figure in it listed and boxed.</li>
<li><strong>Figures.</strong> One row for each printed figure, to filter, search, sort and export.</li>
<li><strong>Stats.</strong> Figures by fiscal year, fee category, jurisdiction type and land use.</li>
</ul>
<p>Every view is in the URL, so any figure, filter or page is a link.</p>
<p class="foot-links"><a href="${SITE}/">Open the database</a> · <a href="/jurisdictions/">Jurisdictions by county</a> · <a href="${TERMS}">Terms of use</a></p>
`;
  return page({
    urlPath: "/about/",
    title: `About the ${DB_NAME}`,
    description: `What the ${DB_NAME} holds: impact fee collections from ${fmtInt(summary.jurisdictions.length)} California jurisdictions for ${span}, and how each figure is checked against the report it was read from.`,
    body,
    head: datasetLd(summary),
  });
}

function sitemap(paths, date) {
  const urls = paths.map((p) => `  <url><loc>${esc(SITE + p)}</loc><lastmod>${date}</lastmod></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

// ------------------------------------------------------------ build

// The pages must never carry an amount or a link to the release's files.
const FORBIDDEN = [
  [/\$\s*\(?\s*\d/, "a dollar amount"],
  [/releases\/download|github\.com\/aimesy\/mfa-data|raw\.githubusercontent\.com/i, "a link to the release's files"],
];

function checkPage(rel, html) {
  for (const [re, what] of FORBIDDEN) {
    if (re.test(html)) throw new Error(`${rel} would publish ${what}: ${re.exec(html)[0]}`);
  }
}

export function buildDate(date) {
  if (date) return date;
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  return (Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date()).toISOString().slice(0, 10);
}

export function renderSite({ feesCsv, sourcesCsv, date, links = FEE_LINKS }) {
  const fees = parseCsvObjects(feesCsv);
  const sources = parseCsvObjects(sourcesCsv);
  const model = buildModel(fees.rows, sources.rows, links);
  const summary = describe(model);
  const files = new Map();
  files.set("jurisdictions/index.html", hubPage(summary));
  for (const j of summary.jurisdictions) files.set(`jurisdictions/${j.slug}/index.html`, jurisdictionPage(j));
  files.set("about/index.html", aboutPage(summary));
  for (const [rel, html] of files) checkPage(rel, html);
  const paths = ["/", "/about/", "/jurisdictions/", ...summary.jurisdictions.map(jurisdictionPath)];
  files.set("sitemap.xml", sitemap(paths, buildDate(date)));
  return { files, summary, paths, problems: model.problems, feeProblems: model.feeProblems };
}

// Remove jurisdiction pages this script wrote before for names no longer in
// the release. Only a directory whose index.html carries the generator mark
// is touched.
function removeStale(outDir, keep) {
  const dir = path.join(outDir, "jurisdictions");
  if (!existsSync(dir)) return [];
  const removed = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    const index = path.join(dir, entry.name, "index.html");
    if (!existsSync(index) || !readFileSync(index, "utf8").includes(`content="${GENERATOR}"`)) continue;
    rmSync(index);
    if (readdirSync(path.join(dir, entry.name)).length === 0) rmdirSync(path.join(dir, entry.name));
    removed.push(entry.name);
  }
  return removed;
}

export function build(releaseDir, outDir, opts = {}) {
  const feesCsv = readFileSync(path.join(releaseDir, "data", "reported-fee-collections.csv"), "utf8");
  const sourcesCsv = readFileSync(path.join(releaseDir, "sources", "index.csv"), "utf8");
  const result = renderSite({ feesCsv, sourcesCsv, ...opts });
  const removed = removeStale(outDir, new Set(result.summary.jurisdictions.map((j) => j.slug)));
  for (const [rel, text] of result.files) {
    const file = path.join(outDir, ...rel.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
  }
  return { ...result, removed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [releaseDir, outDir] = process.argv.slice(2);
  if (!releaseDir || !outDir) {
    console.error("usage: node seo/build.mjs <release dir> <output dir>");
    process.exit(2);
  }
  const r = build(path.resolve(releaseDir), path.resolve(outDir));
  console.log(`seo: ${r.summary.jurisdictions.length} jurisdiction pages, ${r.files.size - 1} pages in all, ${r.paths.length} sitemap URLs (${r.summary.figures} figures, ${r.summary.reports} reports, FY ${fmtFy(r.summary.firstYear)} to ${fmtFy(r.summary.lastYear)})`);
  if (r.removed.length) console.log(`seo: removed ${r.removed.length} stale jurisdiction pages: ${r.removed.join(", ")}`);
}
