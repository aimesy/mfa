// Browser smoke test against a local mfa-data checkout.
//
//   node tests/smoke.mjs
//
// Environment:
//   MFA_DATA_ROOT   release checkout to serve (default: ../mfa-data beside this repo)
//   MFA_EVIDENCE    1 runs the steps that open evidence PDFs and reports, 0
//                   skips them. They are release assets, not checkout files,
//                   so by default they run only when the checkout has a
//                   releases/download/ folder holding them.
//   THEMES_DIR      serve the shared aimesy/themes assets from this checkout
//                   instead of aimesy.github.io (for sandboxes that cannot reach it)
//   BROWSER_PROXY   passed to Chromium as --proxy-server
//   SCREENSHOT_DIR  write screenshots here
//   MFA_SCHEDULES_CSV  serve this file as data/fee-schedules.csv when the
//                   release does not carry one (the Schedules tab otherwise
//                   says the file is not yet published)

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve, VIEWER_ROOT, DATA_ROOT } from "./serve.mjs";
import { parseCsvObjects } from "../lib/csv.js";
import { scopeKey, fmtFy, entityTypeLabel } from "../lib/model.js";
import { FEE_LINKS } from "../lib/fee-links.js";
import { indexDistricts } from "../lib/districts.js";

const root = DATA_ROOT;
const shots = process.env.SCREENSHOT_DIR || "";
if (shots) mkdirSync(shots, { recursive: true });
const evidence = process.env.MFA_EVIDENCE ? process.env.MFA_EVIDENCE === "1" : existsSync(path.join(root, "releases/download"));
const tmp = mkdtempSync(path.join(os.tmpdir(), "mfa-smoke-"));

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const globalRoot = execSync("npm root -g").toString().trim();
    return createRequire(`${globalRoot}/`)("playwright");
  }
}

const rows = parseCsvObjects(readFileSync(path.join(root, "data/reported-fee-collections.csv"), "utf8")).rows;
const primary = rows.filter((r) => r.is_primary_in_figure_group === "true");
const sources = parseCsvObjects(readFileSync(path.join(root, "sources/index.csv"), "utf8")).rows;
const coverage = JSON.parse(readFileSync(path.join(VIEWER_ROOT, "coverage/coverage.json"), "utf8"));
const districts = indexDistricts(JSON.parse(readFileSync(path.join(VIEWER_ROOT, "legislative/districts.json"), "utf8")));

// Each figure as the viewer builds it from the CSV: its primary row, or its
// first row when the release marks none.
const figureRow = new Map();
for (const r of rows) {
  const had = figureRow.get(r.figure_group_id);
  if (!had || (had.is_primary_in_figure_group !== "true" && r.is_primary_in_figure_group === "true")) figureRow.set(r.figure_group_id, r);
}
const figures = [...figureRow.values()];
const sumOf = (list) => list.reduce((s, r) => s + (r.is_primary_in_figure_group === "true" && Number.isFinite(Number(r.value_usd)) ? Number(r.value_usd) : 0), 0);
const usd = (v) => `$${Math.round(v).toLocaleString("en-US")}`;

// Each jurisdiction's type and county: the value most of its figures carry.
function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = "";
  let bestN = -1;
  for (const [v, c] of counts) {
    if (c > bestN || (c === bestN && v && !best)) {
      best = v;
      bestN = c;
    }
  }
  return best;
}
const entityFigures = new Map();
for (const r of figures) {
  if (!entityFigures.has(r.receiving_entity)) entityFigures.set(r.receiving_entity, []);
  entityFigures.get(r.receiving_entity).push(r);
}
const entities = [...entityFigures].map(([name, list]) => ({ name, type: mostCommon(list.map((r) => r.entity_type)), figures: list }));
const inDistrict = (ch, n) => (name, opts) => (districts.districtKeys(name, opts)?.[ch] || []).includes(String(n));
const sharePct = (share) => `${+(share * 100).toFixed(1)}%`;
const DISTRICT_COLUMNS = ["assembly_districts_touching", "senate_districts_touching", "assembly_district_resident_shares", "senate_district_resident_shares"];

const { chromium } = await loadPlaywright();
// Other services on the box hold some ports in 8790 to 8889; try another.
let port;
let server = null;
for (let tries = 1; !server; tries++) {
  port = 8790 + Math.floor(Math.random() * 100);
  server = await serve({ "/mfa/": VIEWER_ROOT, "/mfa-data/": root }, port).catch((err) => {
    if (err.code !== "EADDRINUSE" || tries >= 20) throw err;
    return null;
  });
}
const base = `http://127.0.0.1:${port}/mfa/?data=../mfa-data/`;
const browser = await chromium.launch({ args: process.env.BROWSER_PROXY ? [`--proxy-server=${process.env.BROWSER_PROXY}`] : [] });
const problems = [];

async function newPage(viewport = { width: 1440, height: 900 }, init, options = {}) {
  const page = await browser.newPage({ viewport, acceptDownloads: true, ...options });
  if (process.env.THEMES_DIR) {
    await page.route(/^https:\/\/aimesy\.github\.io\/themes\/src\//, (route) => {
      const name = route.request().url().split("/src/")[1];
      route.fulfill({ path: path.join(process.env.THEMES_DIR, "src", name), contentType: name.endsWith(".css") ? "text/css" : "text/javascript" });
    });
  }
  if (init) await page.addInitScript(init);
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  return page;
}

async function shot(page, name) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

// Red outline pixels along the edge of the viewer's current box; for a figure
// outlined in parts, the least of its parts.
async function redRatio(page) {
  return page.evaluate(() => Math.min(...[...document.querySelectorAll(".pv-box.current")].map((node) => {
    const [x, y, w, h] = JSON.parse(node.dataset.canvasBox);
    const c = document.querySelector(".pv-stage canvas");
    const pad = 6;
    const x0 = Math.max(0, x - pad);
    const y0 = Math.max(0, y - pad);
    const W = Math.min(c.width - x0, w + 2 * pad);
    const H = Math.min(c.height - y0, h + 2 * pad);
    const px = c.getContext("2d").getImageData(x0, y0, W, H).data;
    let red = 0;
    for (let k = 0; k < px.length; k += 4) if (px[k] > 150 && px[k + 1] < 110 && px[k + 2] < 110) red += 1;
    return red / (2 * (w + h));
  })));
}

// The text of the first node matching sel, or null.
const textOf = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
const param = (page, k) => new URL(page.url()).searchParams.get(k);
const paramSet = (page, k) => new Set((param(page, k) || "").split("|").filter(Boolean));
const shownCount = async (page) => Number((await page.locator(".result-bar .count strong").innerText()).replace(/,/g, ""));
const tagTexts = (page) => page.$$eval(".result-bar .filter-tag", (ts) => ts.map((t) => t.textContent.replace(/×$/, "")));
const sideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const waitCount = (page, n) => page.waitForFunction((want) => document.querySelector(".result-bar .count strong")?.textContent.replace(/,/g, "") === String(want), n);

// Opens a filter box from a toolbar button or a column ▾ and waits for its
// values; returns the rows as listed.
async function openBox(page, selector) {
  await page.locator(selector).click();
  await page.waitForSelector('.col-filter-pop .cf-list[aria-busy="false"]');
  return boxRows(page);
}

const boxRows = (page) => page.$$eval(".col-filter-pop .cf-row", (list) => list.map((r) => ({
  label: r.querySelector(".cf-label").textContent,
  count: r.querySelector(".cf-count") ? Number(r.querySelector(".cf-count").textContent.replace(/,/g, "")) : null,
  kind: r.classList.contains("cf-all") ? "all" : r.classList.contains("cf-sub") ? "sub" : r.classList.contains("cf-ns") ? "ns" : "",
  checked: r.querySelector("input").checked,
})));

// Ticks exactly the rows with these labels (the first row of each label,
// in the kind given as "label|kind" when labels repeat), then applies.
async function tickOnly(page, labels) {
  const all = page.locator(".col-filter-pop .cf-row.cf-all input");
  await all.check();
  await all.uncheck();
  for (const want of labels) {
    const [label, kind] = want.split("|");
    const i = (await boxRows(page)).findIndex((r) => r.label === label && (!kind || r.kind === kind));
    assert.ok(i >= 0, `the box lists ${want}`);
    await page.locator(".col-filter-pop .cf-row").nth(i).locator("input").check();
  }
  await page.click(".col-filter-pop .cf-apply");
  await page.waitForSelector(".col-filter-pop", { state: "detached" });
}

// The rect of the open box against the viewport.
const boxRect = (page) => page.$eval(".col-filter-pop", (n) => {
  const r = n.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: document.documentElement.clientWidth, vh: innerHeight };
});

// Downloads carry data rows only: no release document, Worker or GitHub
// address, whatever tab they come from.
const DOCUMENT_LINK = /releases\/download|github\.com|mfa-data\.amyc\.us/;

// "CSV of this tab" from the Download menu: the menu's label and the file.
async function downloadCsv(page) {
  await page.click("#export-btn");
  const item = page.locator(".dl-menu .dl-item").first();
  await page.waitForFunction(() => /\([\d,]+ rows?\)$/.test(document.querySelector(".dl-menu .dl-item")?.textContent || ""));
  const label = await item.innerText();
  const [dl] = await Promise.all([page.waitForEvent("download"), item.click()]);
  const text = readFileSync(await dl.path(), "utf8");
  assert.doesNotMatch(text, DOCUMENT_LINK, `${dl.suggestedFilename()} links no release document`);
  const parsed = parseCsvObjects(text);
  return { label, name: dl.suggestedFilename(), text, columns: parsed.columns, rows: parsed.rows };
}

// An agency opened from a tab's list goes into the address bar, and back and
// forward move between the list and the agency.
async function roundTrip(page, { param: key, title, list }) {
  const name = new URL(page.url()).searchParams.get(key);
  await page.goBack();
  await page.waitForSelector(list);
  assert.equal(new URL(page.url()).searchParams.get(key), null, `back leaves ${name}`);
  await page.goForward();
  await page.waitForFunction(([s, n]) => document.querySelector(s)?.textContent === n, [title, name]);
  assert.equal(new URL(page.url()).searchParams.get(key), name, `forward returns to ${name}`);
}

async function openFigureById(page, id) {
  await page.evaluate((id) => {
    const u = new URL(location.href);
    u.searchParams.set("f", id);
    history.pushState(null, "", u);
    dispatchEvent(new PopStateEvent("popstate"));
  }, id);
}

try {
  if (!evidence) console.log("evidence PDFs absent: skipping the steps that open them (MFA_EVIDENCE=1 forces them)");

  // Figures table
  const page = await newPage();
  await page.goto(`${base}&view=figures`);
  await page.waitForSelector(".figures-grid tbody tr");
  const count = await page.locator(".result-bar .count strong").innerText();
  assert.equal(count.replace(/,/g, ""), String(new Set(rows.map((r) => r.figure_group_id)).size), "table counts printed figures");
  const sum = primary.reduce((s, r) => s + Number(r.value_usd), 0);
  const shown = await page.locator(".result-bar .sum strong").innerText();
  assert.equal(shown, `$${Math.round(sum).toLocaleString("en-US")}`, "sum adds primary rows only");
  await shot(page, "01-figures");

  await page.fill("#q", "Quimby");
  await page.waitForFunction(() => /“Quimby”/.test(document.querySelector(".result-bar")?.innerText || ""));
  assert.ok(await page.locator(".figures-grid tbody tr:not(.empty-row)").count() > 0, "search reaches limitations text");
  await page.click(".result-bar .filter-tag button");

  // A land-use tag lists every figure with that scope.
  const tag = page.locator(".figures-grid tbody tr .col-notes a.b-scope").first();
  const key = /scope-(\S+)/.exec(await tag.getAttribute("class"))[1];
  const sizes = await page.$$eval(".figures-grid .col-notes .badge", (bs) => bs.map((b) => {
    const r = b.getBoundingClientRect();
    return { one: b.classList.contains("one"), w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
  }));
  const ones = sizes.filter((x) => x.one);
  assert.ok(ones.length > 0 && ones.every((x) => x.w === ones[0].w && x.h === ones[0].h && x.w === x.h), `one-character tags are one square size: ${JSON.stringify([...new Set(ones.map((x) => `${x.w}x${x.h}`))])}`);
  assert.ok(sizes.every((x) => x.h === ones[0].h), "every tag has the same height");
  assert.ok(await page.evaluate(() => document.fonts.ready.then(() => [...document.fonts].some((f) => f.family.includes("Noto Emoji") && f.status === "loaded"))), "land-use symbols use the black-and-white font");
  await tag.click();
  // The tag sets the Land use box: in the address and on its button.
  await page.waitForFunction((k) => new URL(location.href).searchParams.get("scope") === k &&
    document.querySelector('#toolbar .fbox-btn[data-key="scope"]')?.classList.contains("active"), key);
  const inScope = new Set(primary.filter((r) => scopeKey(r.land_use_scope) === key).map((r) => r.figure_group_id)).size;
  await waitCount(page, inScope);
  await page.click(".result-bar .filter-tag button");

  // Tags answer on hover at once, in a few words.
  await page.locator(".figures-grid tbody tr .col-notes a.b-scope").first().hover();
  await page.waitForSelector("#tooltip.tip-short:not([hidden])", { timeout: 2000 });
  assert.match(await page.locator("#tooltip").innerText(), /^Land use: \S+( \S+)?$/);
  await page.mouse.move(0, 0);

  if (evidence) {
    // Evidence panel: outlined page, hash check, box on the drawn outline
    await page.locator(".figures-grid tbody tr").first().click();
    await page.waitForSelector(".pv-box.current", { state: "attached" });
    await page.waitForFunction(() => /SHA-256 .* matches/.test(document.querySelector(".pv-verify")?.innerText || ""));
    assert.ok(await redRatio(page) > 0.3, "the mapped box sits on the evidence file's red outline");
    const headings = await page.locator(".detail h3").allInnerTexts();
    assert.ok(headings.every((h) => ["ARITHMETIC", "NOTES", "ROWS", "SOURCE", "REVIEW"].includes(h.toUpperCase())), `detail headings: ${headings}`);
    await page.waitForTimeout(400);
    await shot(page, "02-evidence-outlined");

    // Original report at the same page, with the box drawn by the viewer
    await page.click(".ev-tab:nth-child(2)");
    await page.waitForSelector(".pv-box.current:not(.in-file)", { state: "attached" });
    assert.match(await page.locator(".pv-page").innerText(), /^Page \d+ of \d+$/);
    await page.waitForTimeout(400);
    await shot(page, "03-evidence-original");
    // Go to document opens the whole report at the page being read.
    const onPage = await page.locator(".pv-page").innerText();
    await page.locator(".pv-toolbar button", { hasText: "Go to document" }).click();
    await page.waitForFunction(() => /[?&]doc=/.test(location.search) && !/[?&]f=/.test(location.search));
    await page.waitForSelector("#panel .details table.rows");
    await page.waitForFunction((p) => document.querySelector(".pv-page")?.innerText === p, onPage);
    assert.equal(await page.locator(".pv-toolbar button", { hasText: "Go to document" }).isVisible(), false, "no document button on the document itself");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#panel", { state: "hidden" });

    // A figure whose recorded rectangle disagrees with its evidence outline gets no box.
    const mismatch = primary.find((r) => r.figure_group_id === "city-of-anderson-city-of-anderson-parks-capital-2003-04");
    if (mismatch) {
      await openFigureById(page, mismatch.figure_group_id);
      await page.waitForSelector(".pv-note:not([hidden])");
      assert.equal(await page.locator(".pv-box.current").count(), 0, "no box drawn from a rectangle that fails the outline check");
      await shot(page, "04-outline-mismatch");
      await page.keyboard.press("Escape");
    }

    // Words outlined over two printed lines get a box on each line, on both tabs.
    const twoPart = primary.find((r) => r.outline_rect_pdf_points.startsWith("[["));
    if (twoPart) {
      const parts = JSON.parse(twoPart.outline_rect_pdf_points).length;
      await openFigureById(page, twoPart.figure_group_id);
      await page.waitForFunction((n) => document.querySelectorAll(".pv-box.current").length === n, parts);
      assert.ok(await redRatio(page) > 0.3, "each part's box sits on its red outline");
      await shot(page, "04a-two-part-outline");
      await page.click(".ev-tab:nth-child(2)");
      await page.waitForFunction((n) => document.querySelectorAll(".pv-box.current:not(.in-file)").length === n, parts);
      await page.keyboard.press("Escape");
    }

    // A bare-number equation takes its line names from the page, never a guess.
    const bare = primary.find((r) => r.figure_group_id === "city-of-santa-clara-2022-23-parks-mitigation-fee-fund-532");
    if (bare) {
      await openFigureById(page, bare.figure_group_id);
      await page.waitForSelector(".grid.arith");
      const names = await page.locator(".grid.arith tbody th[scope=row]").allInnerTexts();
      assert.deepEqual(names, ["FY 2021-22 Ending Fund Balance", "Fees Collected", "Interest Earned", "Expenditures", "FY 2022-23 Ending Fund Balance"]);
      await shot(page, "04b-arithmetic-from-page");
      await page.keyboard.press("Escape");
    }
  }

  // A jurisdiction's name filters the table to that jurisdiction.
  await page.goto(`${base}&view=figures`);
  await page.waitForSelector(".figures-grid tbody tr .col-entity a");
  const named = await page.locator(".figures-grid tbody tr .col-entity a").first().innerText();
  await page.locator(".figures-grid tbody tr .col-entity a").first().click();
  await page.waitForSelector(".filter-tag");
  assert.equal(await page.locator("#panel").isVisible(), false, "the name filters; it does not open the figure");
  const listed = new Set(await page.locator(".figures-grid tbody tr .col-entity").allInnerTexts());
  assert.deepEqual([...listed], [named]);
  const expected = primary.filter((r) => r.receiving_entity === named).length;
  assert.equal((await page.locator(".result-bar .count strong").innerText()).replace(/,/g, ""), String(expected));
  // Clicked again, it opens the jurisdiction's page.
  await page.locator(".figures-grid tbody tr .col-entity a").first().click();
  await page.waitForSelector(".matrix");
  assert.equal(await page.locator(".dossier-head h2").innerText(), named);
  assert.match(page.url(), /[?&]e=/);
  assert.doesNotMatch(page.url(), /view=/, "Jurisdictions is the default view");

  // Jurisdiction dossier: matrix totals are primary sums per year
  const entity = "City of Brentwood";
  await page.goto(`${base}&view=entities&e=${encodeURIComponent(entity)}`);
  await page.waitForSelector(".matrix tfoot");
  const years = new Set(primary.filter((r) => r.receiving_entity === entity).map((r) => r.fiscal_year));
  assert.equal(await page.locator(".matrix thead th").count(), years.size + 1, "one column per fiscal year present");
  assert.ok(await page.locator(".matrix .mx-empty").count() > 0, "missing cells are shown as missing");
  if (evidence) {
    // A cell opens its figure's evidence. Some recorded rectangles fail the
    // outline check and get no box (Anderson's above; Brentwood's before
    // 2008-09), so take the first cell that gets one, from a fresh page each
    // time so a note left by the previous figure is not read as this one's.
    const cellIds = await page.locator(".mx-cell").evaluateAll((cells) => cells.map((c) => c.dataset.id));
    let boxed = null;
    for (const [i, id] of cellIds.entries()) {
      if (i) {
        await page.goto(`${base}&e=${encodeURIComponent(entity)}`);
        await page.waitForSelector(".mx-cell");
      }
      await page.locator(`.mx-cell[data-id=${JSON.stringify(id)}]`).click();
      await page.waitForSelector(`.pv-box.current[data-figure=${JSON.stringify(id)}], .pv-note:not([hidden])`, { state: "attached" });
      if (await page.locator(".pv-box.current").count()) {
        boxed = id;
        break;
      }
    }
    assert.ok(boxed, `no ${entity} figure gets a box`);
    assert.match(page.url(), new RegExp(`[?&]f=${encodeURIComponent(boxed)}(&|$)`), "the cell opens its own figure");
    assert.ok(await redRatio(page) > 0.3, "the dossier figure's box sits on its red outline");
  }
  await shot(page, "05-dossier");

  // Fees: one row per fee; a renumbered fund is one fee, its history year by year
  await page.goto(`${base}&view=fees`);
  await page.waitForSelector(".fees-grid tbody tr");
  const feeCount = new Set(primary.map((r) => `${r.receiving_entity}|${r.fee_program}`)).size - FEE_LINKS.length;
  assert.equal((await page.locator(".result-bar strong").first().innerText()).replace(/,/g, ""), String(feeCount));
  await page.fill("#fq", "woodland road development");
  await page.waitForFunction(() => document.querySelectorAll(".fees-grid tbody tr").length === 1);
  await page.locator(".fees-grid tbody tr .col-fee a").click();
  await page.waitForSelector(".fee-grid");
  assert.equal(await page.locator(".dossier-head h2").innerText(), "Road Development Fund (Fund 582/1582)");
  const printed = await page.locator(".fee-grid .col-printed:not(.same)").allInnerTexts();
  assert.deepEqual(printed, ["Road Development Fund (Fund 582)", "Road Development Fund (Fund 1582)"]);
  assert.match(await page.locator(".fee-grid .col-joined span").innerText(), /^Reprint FY 2018–19 to 2020–21$/);
  const woodland = primary.filter((r) => r.receiving_entity === "City of Woodland" && /^Road Development Fund/.test(r.fee_program));
  assert.equal(await page.locator(".fee-grid tbody tr[data-id]").count(), woodland.length);
  assert.ok(await page.locator(".fee-grid .fee-missing").count() > 0, "a year with no figure is shown as missing");
  assert.equal(await page.locator(".fee-chart .bar").count(), new Set(woodland.map((r) => r.fiscal_year)).size);
  if (evidence) {
    await page.locator(".fee-grid tbody tr[data-id] .pdf-btn").last().click();
    await page.waitForSelector(".pv-box.current", { state: "attached" });
    await shot(page, "05b-fee");
    await page.keyboard.press("Escape");
  }
  // The jurisdiction's matrix shows the fee once, under its joined name.
  await page.locator(".dossier-meta a").click();
  await page.waitForSelector(".matrix");
  const feeRowsShown = await page.locator(".matrix .mx-program a").allInnerTexts();
  assert.ok(feeRowsShown.includes("Road Development Fund (Fund 582/1582)"));
  assert.ok(!feeRowsShown.some((n) => n.startsWith("Road Development Fund (Fund 582)") || n.startsWith("Road Development Fund (Fund 1582)")));

  // In Fees and Sources too, a jurisdiction's name filters the list to it and,
  // clicked again, opens its page.
  for (const [view, grid, expected] of [
    ["fees", ".fees-grid", (n) => new Set(primary.filter((r) => r.receiving_entity === n).map((r) => r.fee_program)).size - FEE_LINKS.filter((l) => l[0] === n).length],
    ["sources", ".sources-grid", (n) => sources.filter((s) => s.receiving_entity === n).length],
  ]) {
    await page.goto(`${base}&view=${view}`);
    const link = page.locator(`${grid} tbody tr .col-entity a`);
    await link.first().waitFor();
    const name = await link.first().innerText();
    await link.first().click();
    await page.waitForSelector(".result-bar .filter-tag");
    assert.equal(await page.locator("#panel").isVisible(), false, `${view}: the name filters; it does not open the row`);
    assert.match(page.url(), new RegExp(`[?&]${view[0]}entity=`));
    assert.deepEqual([...new Set(await page.locator(`${grid} tbody tr .col-entity`).allInnerTexts())], [name]);
    assert.equal((await page.locator(".result-bar strong").first().innerText()).replace(/,/g, ""), String(expected(name)), `${view}: count for ${name}`);
    await link.first().click();
    await page.waitForSelector(".matrix");
    assert.equal(await page.locator(".dossier-head h2").innerText(), name);
    await page.goBack();
    await page.waitForSelector(".result-bar .filter-tag");
    await page.click(".result-bar .filter-tag button");
    await page.waitForFunction((g) => new Set([...document.querySelectorAll(`${g} tbody tr .col-entity`)].map((td) => td.innerText)).size > 1, grid);
    // A click in the cell beside the name is a click on the name.
    const cell = page.locator(`${grid} tbody tr .col-entity`).nth(1);
    const cellName = await cell.innerText();
    const box = await cell.boundingBox();
    await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
    await page.waitForSelector(".result-bar .filter-tag");
    assert.equal(await page.locator("#panel").isVisible(), false, `${view}: the cell filters; it does not open the row`);
    assert.deepEqual([...new Set(await page.locator(`${grid} tbody tr .col-entity`).allInnerTexts())], [cellName]);
  }

  if (evidence) {
    // The name in an open report or figure filters the tab being read, and
    // the panel stays open.
    await page.goto(`${base}&view=sources`);
    await page.locator(".sources-grid tbody tr .col-title").first().click();
    await page.locator("#panel .panel-head .sub a.entity-link").click();
    await page.waitForSelector(".result-bar .filter-tag");
    assert.match(page.url(), /[?&]sentity=/);
    assert.match(page.url(), /[?&]doc=/, "the report stays open");
    assert.doesNotMatch(page.url(), /view=figures/);
    await page.goto(`${base}&view=fees&fq=${encodeURIComponent("woodland road development")}`);
    await page.locator(".fees-grid tbody tr .col-fee a").click();
    await page.locator(".fee-grid tbody tr[data-id] .pdf-btn").first().click();
    await page.locator("#panel .panel-head h2 a.entity-link").click();
    await page.waitForSelector(".result-bar .filter-tag");
    assert.match(page.url(), /[?&]fentity=City\+of\+Woodland/);
    assert.match(page.url(), /[?&]f=/, "the figure stays open");
    assert.deepEqual([...new Set(await page.locator(".fees-grid tbody tr .col-entity").allInnerTexts())], ["City of Woodland"]);

    // Sources: a large report opens by byte range, with the page's figures boxed
    const big = sources
      .filter((s) => Number(s.source_bytes) > 12 * 1024 * 1024 && Number(s.published_data_rows_from_this_source) > 0)
      .sort((a, b) => Number(a.source_bytes) - Number(b.source_bytes))[0];
    if (big) {
      await page.goto(`${base}&view=sources&doc=${encodeURIComponent(big.source_id)}`);
      await page.waitForFunction(() => /Hash not checked/.test(document.querySelector(".pv-verify")?.innerText || ""), null, { timeout: 60000 });
      await page.waitForSelector(".pv-box.other", { state: "attached", timeout: 60000 });
      await shot(page, "06-source-range");
    }
  }

  // Stats: one bar per fiscal year; a category row lists its figures
  await page.goto(`${base}&view=about`);
  await page.waitForSelector(".chart .bar");
  assert.match(page.url(), /view=stats/, "the old About link opens Stats");
  assert.equal(await page.locator(".view-tab.active").innerText(), "Stats");
  assert.equal(await page.locator(".chart .bar").count(), new Set(primary.map((r) => r.fiscal_year)).size);
  await page.waitForSelector("#stats-release table");
  await shot(page, "07-stats");
  const cat = page.locator(".stats-block").first().locator("tbody tr").first();
  const catCount = (await cat.locator("td").nth(1).innerText()).replace(/,/g, "");
  await cat.locator("a").click();
  await page.waitForSelector(".filter-tag");
  assert.equal((await page.locator(".result-bar .count strong").innerText()).replace(/,/g, ""), catCount);

  // Funds: an agency in the list opens its accounts.
  await page.goto(`${base}&view=funds`);
  const fundLink = page.locator('.funds-view tbody a[href*="fa="]').first();
  await fundLink.waitFor();
  const fundAgency = await fundLink.textContent();
  await fundLink.click();
  await page.waitForFunction((n) => document.querySelector(".funds-head h2")?.textContent === n, fundAgency);
  assert.equal(new URL(page.url()).searchParams.get("fa"), fundAgency);
  assert.ok(await page.locator(".funds-grid").count() > 0, "the agency's funds are tabled");
  await shot(page, "07a-funds");
  await roundTrip(page, { param: "fa", title: ".funds-head h2", list: "#funds-q" });

  // Schedules: with no file in the release the tab says so, and the 404 for
  // it (with the console line Chromium logs for it) is expected.
  const schedulesCsv = process.env.MFA_SCHEDULES_CSV || "";
  const schedulesInRelease = existsSync(path.join(root, "data/fee-schedules.csv"));
  if (schedulesCsv && !schedulesInRelease) {
    await page.route(/\/data\/fee-schedules\.csv(\?|$)/, (route) => route.fulfill({ path: schedulesCsv, contentType: "text/csv" }));
  }
  const mark = problems.length;
  await page.goto(`${base}&view=schedules`);
  if (schedulesCsv || schedulesInRelease) {
    const schedLink = page.locator('.schedules-grid tbody a[href*="scagency="]').first();
    await schedLink.waitFor();
    const schedAgency = await schedLink.textContent();
    await schedLink.click();
    await page.waitForFunction((n) => document.querySelector(".schedules-head h2")?.textContent === n, schedAgency);
    assert.equal(new URL(page.url()).searchParams.get("scagency"), schedAgency);
    await shot(page, "07b-schedules");
    await roundTrip(page, { param: "scagency", title: ".schedules-head h2", list: ".schedules-toolbar" });
  } else {
    await page.waitForSelector(".schedules-absent");
    assert.equal(await textOf(page, ".schedules-absent"), "Fee schedules are not yet published.");
    const expected = (p) => /^HTTP 404 \S*\/data\/fee-schedules\.csv(\?\S*)?$/.test(p) || /^console: Failed to load resource: .*\b404\b/.test(p);
    problems.splice(mark, problems.length - mark, ...problems.slice(mark).filter((p) => !expected(p)));
  }

  // Permits: the chart steps from point to point by keyboard, and a name in
  // the table opens its jurisdiction.
  await page.goto(`${base}&view=permits`);
  await page.waitForSelector(".permits-chart .hit");
  assert.ok(await page.locator(".permits-chart .pt").count() > 1, "the chart plots more than one jurisdiction");
  await page.focus(".permits-chart .hit");
  await page.waitForSelector(".permits-chart .pt.on");
  const firstPoint = await textOf(page, ".permits-live");
  assert.ok(firstPoint, "focus reads out the first point");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((t) => document.querySelector(".permits-live")?.textContent !== t, firstPoint);
  assert.equal(await page.locator(".permits-chart .pt.on").count(), 1, "one point is active");
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction((t) => document.querySelector(".permits-live")?.textContent === t, firstPoint);
  await shot(page, "07c-permits");
  // The chart is fees per unit by jurisdiction, and its off-chart counts filter
  // the table.
  assert.match(await page.locator(".permits-chart").getAttribute("aria-label"), /per 1,000 residents against fees collected per unit for [\d,]+ jurisdictions/);
  assert.match(firstPoint, /\$[\d,]+ per unit, [\d,.]+ units a year per 1,000 residents/);
  const offCount = page.locator(".permits-off-note .link-btn").first();
  const offLabel = await offCount.textContent();
  const offKey = await offCount.getAttribute("data-off");
  const offN = Number(offLabel.match(/^[\d,]+/)[0].replace(/,/g, ""));
  const allRows = await textOf(page, ".result-bar strong");
  const dots = await page.locator(".permits-chart .pt").count();
  await offCount.click();
  await page.waitForSelector(".permits-off .btn");
  assert.equal(new URL(page.url()).searchParams.get("poff"), offKey, "the filter is in the URL");
  assert.equal(Number((await textOf(page, ".result-bar strong")).replace(/,/g, "")), offN, "the table lists what the count says");
  assert.equal(await page.locator(".permits-chart .pt").count(), dots, "the chart does not change");
  assert.equal(await page.locator(".permits-off-note .link-btn[aria-pressed=true]").count(), 1, "the count reads as selected");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Show all agency years", "focus lands on the way back");
  assert.equal(await page.evaluate(() => document.querySelector(".app").getBoundingClientRect().top), 0, "moving to the list leaves the tabs and filters in place");
  assert.doesNotMatch(await page.locator(".permits-view").innerText(), /\bnull\b/, "an empty note prints nothing");
  await page.locator(".permits-off .btn").click();
  await page.waitForFunction((t) => document.querySelector(".result-bar strong")?.textContent === t, allRows);
  assert.equal(new URL(page.url()).searchParams.get("poff"), null, "Show all drops the filter");
  await page.locator(".permits-off-note .link-btn").first().click();
  await page.waitForSelector(".permits-off .btn");
  await page.locator(".permits-off-note .link-btn[aria-pressed=true]").click();
  await page.waitForFunction((t) => document.querySelector(".result-bar strong")?.textContent === t, allRows);
  await page.locator(".permits-off-note .link-btn").first().click();
  await page.waitForSelector(".permits-off .btn");
  await page.goBack();
  await page.waitForFunction((t) => document.querySelector(".result-bar strong")?.textContent === t, allRows);
  assert.equal(new URL(page.url()).searchParams.get("poff"), null, "Back drops the filter");
  const permitLink = page.locator(".permits-list tbody .col-entity a").first();
  const permitEntity = new URL(await permitLink.getAttribute("href"), page.url()).searchParams.get("e");
  await permitLink.click();
  await page.waitForFunction((n) => document.querySelector(".dossier-head h2")?.textContent === n, permitEntity);
  assert.equal(new URL(page.url()).searchParams.get("e"), permitEntity);
  // Its page shows the agency's permits.
  await page.waitForSelector(".dossier-permits .tiles .tile");
  assert.ok(await page.locator(".dossier-permits .permits-list tbody tr").count() > 0, "the page lists the agency's years");
  assert.doesNotMatch(await page.locator(".dossier-permits").innerText(), /\bnull\b/, "an empty value prints nothing");
  await page.goBack();
  await page.waitForSelector(".permits-chart .hit");
  assert.match(page.url(), /[?&]view=permits/, "back returns to Permits");
  await page.goForward();
  await page.waitForFunction((n) => document.querySelector(".dossier-head h2")?.textContent === n, permitEntity);

  // Filter boxes on Figures: a toolbar box, then a column ▾. Each ticks two
  // values; the address, the tags and the count follow, and the count is the
  // CSV's.
  const fb = await newPage();
  await fb.goto(`${base}&view=figures`);
  await fb.waitForSelector(".figures-grid tbody tr");
  const counties = ["Alameda", "Yolo"];
  const inCounties = figures.filter((r) => counties.includes(r.county));
  const countyRows = await openBox(fb, '#toolbar .fbox-btn[data-key="county"]');
  assert.equal(await textOf(fb, ".col-filter-pop .cf-title"), "Filter · County");
  assert.deepEqual(await fb.$$eval(".col-filter-pop .cf-sort button", (bs) => bs.map((b) => b.textContent)), ["A to Z", "Z to A", "By count"]);
  assert.equal(countyRows[0].label, "(Select all)");
  for (const c of counties) {
    assert.equal(countyRows.find((r) => r.label === c)?.count, figures.filter((r) => r.county === c).length, `County box counts ${c}`);
  }
  const listedCounts = countyRows.filter((r) => r.kind !== "all").map((r) => r.count);
  assert.deepEqual(listedCounts, [...listedCounts].sort((a, b) => b - a), "the County box lists by count");
  await shot(fb, "11-figures-box");
  await tickOnly(fb, counties);
  assert.deepEqual(paramSet(fb, "county"), new Set(counties), "county=Alameda|Yolo");
  await waitCount(fb, inCounties.length);
  assert.ok((await tagTexts(fb)).some((t) => /^County: (Alameda or Yolo|Yolo or Alameda)$/.test(t)), `county tag: ${await tagTexts(fb)}`);
  assert.match(await fb.locator('#toolbar .fbox-btn[data-key="county"]').innerText(), /^County: (Alameda or Yolo|Yolo or Alameda) ▾$/, "the County button names its values");
  assert.ok(await fb.locator('#toolbar .fbox-btn[data-key="county"].active').count(), "the County button reads as set");

  const fys = [...new Set(inCounties.map((r) => r.fiscal_year))].sort().slice(-2);
  const fyRows = await openBox(fb, 'th .col-filter-btn[data-key="fy"]');
  assert.equal(await fb.locator('th .col-filter-btn[data-key="fy"]').getAttribute("aria-expanded"), "true");
  assert.match(await fb.locator(".col-filter-pop .cf-sort button.active").innerText(), /^1 to 9$/, "fiscal years sort as numbers");
  for (const fy of fys) {
    assert.equal(fyRows.find((r) => r.label === fmtFy(fy))?.count, inCounties.filter((r) => r.fiscal_year === fy).length, `FY box counts ${fy} under the county filter`);
  }
  await tickOnly(fb, fys.map(fmtFy));
  assert.deepEqual(paramSet(fb, "fy"), new Set(fys), `fy=${fys.join("|")}`);
  assert.equal(param(fb, "from"), null, "only fy is written");
  const both = inCounties.filter((r) => fys.includes(r.fiscal_year));
  await waitCount(fb, both.length);
  assert.ok((await tagTexts(fb)).some((t) => t === `Fiscal year: ${fys.map(fmtFy).join(" or ")}` || t === `Fiscal year: ${[...fys].reverse().map(fmtFy).join(" or ")}`), `fy tag: ${await tagTexts(fb)}`);
  assert.equal(await fb.locator(".result-bar .sum strong").innerText(), usd(sumOf(both)), "the sum adds the primary rows of the filtered figures");
  assert.ok(await fb.locator('th .col-filter-btn[data-key="fy"].active').count(), "the FY ▾ reads as set");

  // CSV of this tab: a BOM, the release columns but the document addresses,
  // a link to each figure, the district columns, one row per figure listed.
  const figCsv = await downloadCsv(fb);
  assert.equal(figCsv.label, `CSV of this tab (${both.length.toLocaleString("en-US")} rows)`);
  assert.match(figCsv.name, /^mfa-figures-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(figCsv.text.startsWith("﻿"), "the CSV starts with a BOM");
  assert.ok(figCsv.text.includes("\r\n"), "the CSV ends lines with CRLF");
  for (const c of [...DISTRICT_COLUMNS, "figure_group_id", "receiving_entity", "value_usd", "figure_url"]) assert.ok(figCsv.columns.includes(c), `Figures CSV has ${c}`);
  for (const c of ["source_pdf", "page_extract_pdf", "outlined_figure_pdf"]) assert.ok(!figCsv.columns.includes(c), `Figures CSV leaves out ${c}`);
  assert.equal(figCsv.rows.length, both.length, "one CSV row per figure listed");
  assert.deepEqual(new Set(figCsv.rows.map((r) => r.figure_group_id)), new Set(both.map((r) => r.figure_group_id)), "the CSV holds the figures listed");
  for (const r of figCsv.rows.slice(0, 50)) {
    const keys = districts.districtKeys(r.receiving_entity);
    assert.equal(r.assembly_districts_touching, keys ? keys.ad.map(Number).sort((a, b) => a - b).join("; ") : "", `Assembly districts of ${r.receiving_entity}`);
  }

  // The Jurisdictions Type box.
  await fb.goto(`${base}&view=entities`);
  await fb.waitForSelector(".entities-grid tbody tr");
  const types = ["city", "county"];
  const typeRows = await openBox(fb, '#toolbar .fbox-btn[data-key="etype"]');
  for (const t of types) assert.equal(typeRows.find((r) => r.label === entityTypeLabel(t))?.count, entities.filter((e) => e.type === t).length, `Type box counts ${t}`);
  await tickOnly(fb, types.map(entityTypeLabel));
  assert.deepEqual(paramSet(fb, "etype"), new Set(types), "etype=city|county");
  await waitCount(fb, entities.filter((e) => types.includes(e.type)).length);
  assert.ok((await tagTexts(fb)).some((t) => /^Type: (City or County|County or City)$/.test(t)), `type tag: ${await tagTexts(fb)}`);
  assert.deepEqual(new Set(await fb.locator(".entities-grid tbody tr td:nth-child(2)").allInnerTexts()), new Set(types.map(entityTypeLabel)));

  // Assembly District 18: Oakland is listed, the overlap caveat shows, and
  // the tag's × takes the district off.
  await fb.goto(`${base}&view=entities`);
  await fb.waitForSelector(".entities-grid tbody tr");
  const in18 = entities.filter((e) => inDistrict("ad", 18)(e.name));
  assert.ok(in18.some((e) => e.name === "City of Oakland"), "the district file puts Oakland in AD 18");
  const adRows = await openBox(fb, '#toolbar .fbox-btn[data-key="ad"]');
  assert.equal(await textOf(fb, ".col-filter-pop .cf-note"), districts.meta.caveat, "the box carries the overlap caveat");
  assert.equal(adRows.find((r) => r.label === "AD 18")?.count, in18.length, "AD box counts AD 18");
  await tickOnly(fb, ["AD 18"]);
  assert.equal(param(fb, "ad"), "18");
  await waitCount(fb, in18.length);
  assert.ok((await tagTexts(fb)).includes("Assembly district: AD 18"), `district tag: ${await tagTexts(fb)}`);
  const names18 = await fb.locator(".entities-grid tbody tr .col-entity").allInnerTexts();
  assert.ok(names18.includes("City of Oakland"), `Oakland is listed: ${names18}`);
  assert.deepEqual(new Set(names18), new Set(in18.map((e) => e.name)));
  const caveat = fb.locator(".result-bar details.district-caveat");
  assert.ok(await caveat.isVisible(), "the caveat shows beside the count");
  assert.ok(!(await caveat.locator(".district-caveat-body").isVisible()), "the caveat opens on request");
  await caveat.locator("summary").click();
  assert.ok((await caveat.locator(".district-caveat-body").innerText()).startsWith(districts.meta.caveat), "a tap or Enter shows the whole caveat");
  assert.match(await fb.locator(".result-bar .sum").innerText(), /^whole-agency sum /, "the sum says it adds whole agencies");
  await shot(fb, "12-entities-ad18");

  // Its CSV carries the district columns, and every row touches AD 18.
  const entCsv = await downloadCsv(fb);
  assert.equal(entCsv.label, `CSV of this tab (${in18.length} rows)`);
  assert.ok(entCsv.text.startsWith("﻿"), "the CSV starts with a BOM");
  for (const c of DISTRICT_COLUMNS) assert.ok(entCsv.columns.includes(c), `Jurisdictions CSV has ${c}`);
  assert.equal(entCsv.rows.length, in18.length);
  assert.ok(entCsv.rows.every((r) => r.assembly_districts_touching.split("; ").includes("18")), "every row touches AD 18");
  const oakRow = entCsv.rows.find((r) => r.jurisdiction === "City of Oakland");
  assert.equal(oakRow.assembly_districts_touching, districts.districtKeys("City of Oakland").ad.map(Number).sort((a, b) => a - b).join("; "));
  assert.match(oakRow.assembly_district_resident_shares, /^18: \d+(\.\d)?%/, "the largest share comes first");

  // The HTML report: two tabs, key statistics up top, no script.
  await fb.click("#export-btn");
  await fb.locator(".dl-menu .dl-item", { hasText: "HTML report" }).waitFor();
  await shot(fb, "16-download-menu");
  await fb.locator(".dl-menu .dl-item", { hasText: "HTML report" }).click();
  await fb.waitForSelector(".report-dialog");
  assert.ok(await fb.locator('.report-dialog input[value="entities"]').isChecked(), "the tab being read is ticked");
  assert.equal(await fb.locator(".report-dialog input:disabled").count(), 0, "every tab can be ticked, opened or not");
  assert.match(await fb.locator("#rd-desc").innerText(), /district filter, Assembly district AD 18/, "the dialog names the district filter");
  await fb.check('.report-dialog input[value="figures"]');
  await shot(fb, "17-report-dialog");
  const [reportDl] = await Promise.all([fb.waitForEvent("download"), fb.click(".report-dialog .rd-actions .btn.primary")]);
  assert.match(reportDl.suggestedFilename(), /^mfa-report-\d{4}-\d{2}-\d{2}\.html$/);
  const reportFile = path.join(tmp, reportDl.suggestedFilename());
  await reportDl.saveAs(reportFile);
  const html = readFileSync(reportFile, "utf8");
  assert.doesNotMatch(html, /<script/i, "the report has no script");
  assert.doesNotMatch(html, DOCUMENT_LINK, "the report links no release document");
  const report = await newPage();
  const fetched = [];
  report.on("request", (r) => fetched.push(r.url()));
  await report.goto(pathToFileURL(reportFile).href);
  assert.ok(fetched.every((u) => u.startsWith("file:")), `the report loads nothing else: ${fetched}`);
  assert.equal(await report.locator("script").count(), 0);
  assert.ok(await report.locator(".stats .tiles .tile").count() >= 5, "key statistics tiles up top");
  const statsTop = await report.locator(".stats").boundingBox();
  const tabsTop = await report.locator(".tabs").boundingBox();
  assert.ok(statsTop.y < tabsTop.y, "the statistics come before the tabs");
  assert.match(await report.locator(".stats-scope").innerText(), /^Counted from the figures on the Figures tab, under its filters\./, "the tiles say what they count");
  assert.equal(await report.locator("input.tab-radio").count(), 2, "one radio for each tab ticked");
  assert.deepEqual(await report.$$eval("label.tab", (ls) => ls.map((l) => l.firstChild.textContent.trim())), ["Jurisdictions", "Figures"]);
  assert.match(await report.locator(".callout").innerText(), new RegExp(districts.meta.caveat.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the report shows the caveat");
  const figs18 = figures.filter((r) => inDistrict("ad", 18)(r.receiving_entity));
  assert.deepEqual(await report.locator(".panel .rowcount").allInnerTexts(), [`${in18.length} rows`, `${figs18.length} rows`]);
  await shot(report, "18-report");
  await report.click('label.tab[for="tab-1"]');
  assert.ok(await report.locator(".panel").nth(1).isVisible(), "a tab label shows its panel");
  assert.equal(await report.locator(".panel").nth(0).isVisible(), false, "and hides the other");
  await report.close();

  await fb.click(".result-bar .filter-tag button");
  await waitCount(fb, entities.length);
  assert.equal(param(fb, "ad"), null, "the tag's × drops the district");
  assert.equal(await fb.locator(".result-bar .district-caveat").count(), 0, "no caveat without a district filter");

  // Districts tab: AD 18 lists Oakland and Alameda County with their shares.
  await fb.click('.view-tab[data-view="districts"]');
  await fb.waitForSelector(".districts-grid tbody tr");
  assert.equal(await fb.locator(".districts-grid tbody tr").count(), 80);
  assert.ok(await fb.locator(".district-callout").isVisible(), "the list opens with the caveat");
  await shot(fb, "13-districts");
  await fb.locator(".districts-grid tbody a", { hasText: /^Assembly District 18$/ }).click();
  await fb.waitForFunction(() => document.querySelector(".dossier-head h2")?.textContent === "Assembly District 18");
  assert.equal(param(fb, "view"), "districts");
  assert.equal(param(fb, "dn"), "18");
  const touching = districts.agencies().filter((r) => r.ad.some((d) => d.n === 18 && d.counts));
  assert.equal(await fb.locator(".districts-grid tbody tr").count(), touching.length, "one row per agency with 1% of its residents in AD 18");
  const edges18 = districts.agencies().filter((r) => r.ad.some((d) => d.n === 18 && !d.counts));
  if (edges18.length) {
    assert.match(await fb.locator(".district-edges summary").innerText(), new RegExp(`^Also touches ${edges18.length.toLocaleString("en-US")} agenc`), "edge contacts are named apart");
  } else assert.equal(await fb.locator(".district-edges").count(), 0);
  // A row's first link is the agency; a row adding up several release names
  // lists them after it.
  const distRows = await fb.$$eval(".districts-grid tbody tr", (trs) => trs.map((tr) => [...tr.cells].map((td, i) => (i ? td.textContent : td.querySelector("a").textContent))));
  for (const name of ["City of Oakland", "Alameda County"]) {
    const rec = districts.lookup(name);
    const d = rec.ad.find((x) => x.n === 18);
    const got = distRows.find((r) => r[0] === rec.name);
    assert.ok(got, `${name} is listed as ${rec.name}`);
    assert.ok(got[3].startsWith(sharePct(d.share)), `${name}: ${got[3]} against ${sharePct(d.share)}`);
  }
  await shot(fb, "14-district-18");

  // Stats and Districts do not apply the district filter, and say so while
  // it is set, with its tag and a Clear.
  await fb.goto(`${base}&view=stats&ad=18`);
  await fb.waitForSelector(".stats-view .district-elsewhere");
  assert.match(await fb.locator(".district-elsewhere").innerText(), /whole release[\s\S]*AD 18/);
  await fb.locator(".district-elsewhere button", { hasText: "Clear district filter" }).click();
  await fb.waitForFunction(() => !document.querySelector(".district-elsewhere"));
  assert.equal(param(fb, "ad"), null, "Clear drops the district filter");

  // The Coverage Type tree: a whole class and one type of another.
  await fb.goto(`${base}&view=coverage`);
  await fb.waitForSelector(".cov-list tbody tr");
  const ctRows = await openBox(fb, '#toolbar .fbox-btn[data-key="ctype"]');
  assert.deepEqual(ctRows.filter((r) => r.kind === "ns").map((r) => r.label), coverage.classes.map((c) => c.label), "a parent for each class");
  await shot(fb, "15-coverage-type");
  const cls = (a) => coverage.classes[a[1]].key;
  const type = (a) => coverage.types[a[2]];
  const covWant = coverage.agencies.filter((a) => cls(a) === "municipal" || (cls(a) === "school" && type(a) === "unified_school_district"));
  assert.equal(ctRows.find((r) => r.label === "Cities and counties").count, coverage.agencies.filter((a) => cls(a) === "municipal").length);
  await tickOnly(fb, ["Cities and counties|ns", "Unified school district|sub"]);
  assert.equal(param(fb, "ccls"), "municipal");
  assert.equal(param(fb, "ctype"), "school:unified_school_district");
  await waitCount(fb, covWant.length);
  assert.ok((await tagTexts(fb)).some((t) => t.startsWith("Type: ")), `coverage tag: ${await tagTexts(fb)}`);
  await fb.close();

  // Dark theme
  const dark = await newPage({ width: 1280, height: 800 }, () => localStorage.setItem("amyc-theme", "cypress"));
  if (evidence) {
    await dark.goto(`${base}&view=figures&f=${encodeURIComponent(primary[0].figure_group_id)}`);
    await dark.waitForSelector(".pv-box.current", { state: "attached" });
  } else {
    await dark.goto(`${base}&view=figures`);
    await openBox(dark, '#toolbar .fbox-btn[data-key="fy"]');
  }
  await dark.waitForTimeout(400);
  await shot(dark, "08-dark");

  // Phone width: no tab scrolls the page sideways, and an open box fits.
  const phone = await newPage({ width: 390, height: 844 }, null, { isMobile: true, hasTouch: true });
  await phone.goto(`${base}&view=figures`);
  await phone.waitForSelector(".figures-grid tbody tr");
  const overflow = await sideScroll(phone);
  assert.ok(overflow <= 1, `page must not scroll sideways at phone width (overflow ${overflow}px)`);
  if (evidence) {
    await phone.locator(".figures-grid tbody tr .pdf-btn").first().click();
    await phone.waitForSelector(".pv-box.current", { state: "attached" });
    await shot(phone, "09-phone");
    await phone.keyboard.press("Escape");
  }
  await phone.click("#toolbar .filters-toggle");
  for (const key of ["county", "ad"]) {
    await openBox(phone, `#toolbar .fbox-btn[data-key="${key}"]`);
    const r = await boxRect(phone);
    assert.ok(r.left >= 0 && r.right <= r.vw && r.top >= 0 && r.bottom <= r.vh, `the ${key} box fits a phone screen: ${JSON.stringify(r)}`);
    assert.ok(await sideScroll(phone) <= 1, `an open ${key} box does not widen the page`);
    if (key === "county") await shot(phone, "19-phone-box");
    await phone.locator(".col-filter-pop .cf-cancel").click();
  }
  for (const [view, ready] of [
    ["entities", ".entities-grid tbody tr"], ["coverage", ".cov-list tbody tr"], ["districts", ".districts-grid tbody tr"],
  ]) {
    await phone.goto(`${base}&view=${view}`);
    await phone.waitForSelector(ready);
    const sideways = await sideScroll(phone);
    assert.ok(sideways <= 1, `${view} must not scroll sideways at phone width (overflow ${sideways}px)`);
  }
  await phone.goto(`${base}&view=districts&dn=18`);
  await phone.waitForSelector(".districts-grid tbody tr");
  assert.ok(await sideScroll(phone) <= 1, "a district page must not scroll sideways at phone width");
  await shot(phone, "20-phone-district");
  // The tab strip scrolls inside itself, so the last tabs are reachable and
  // the page still does not scroll sideways.
  await phone.goto(`${base}&view=figures`);
  await phone.waitForSelector(".figures-grid tbody tr");
  await phone.locator('.view-tab[data-view="permits"]').click();
  await phone.waitForSelector(".permits-chart .hit");
  assert.match(phone.url(), /[?&]view=permits/);
  assert.equal(await textOf(phone, ".view-tab.active"), "Permits");
  const phoneOverflow = await sideScroll(phone);
  assert.ok(phoneOverflow <= 1, `Permits must not scroll sideways at phone width (overflow ${phoneOverflow}px)`);
  await shot(phone, "10-phone-permits");
  // A link straight to a far tab scrolls the strip so the open tab shows.
  await phone.goto(`${base}&view=permits`);
  await phone.waitForSelector(".permits-chart .hit");
  const tabInSight = await phone.$eval(".view-tab.active", (t) => {
    const s = t.parentElement.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    return r.left >= s.left - 1 && r.right <= s.right + 1;
  });
  assert.ok(tabInSight, "the open tab is in sight in the phone tab strip");
  assert.ok(await sideScroll(phone) <= 1, "revealing the tab must not scroll the page sideways");

  assert.deepEqual(problems, [], "no page errors, console errors or failed requests");
  console.log("smoke test passed");
} finally {
  await browser.close();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
