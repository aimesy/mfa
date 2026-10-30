// Browser smoke test against a local mfa-data checkout.
//
//   node tests/smoke.mjs
//
// Environment:
//   MFA_DATA_ROOT   release checkout to serve (default: ../mfa-data beside this repo)
//   THEMES_DIR      serve the shared aimesy/themes assets from this checkout
//                   instead of aimesy.github.io (for sandboxes that cannot reach it)
//   BROWSER_PROXY   passed to Chromium as --proxy-server
//   SCREENSHOT_DIR  write screenshots here
//   MFA_SCHEDULES_CSV  serve this file as data/fee-schedules.csv when the
//                   release does not carry one (the Schedules tab otherwise
//                   says the file is not yet published)

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { serve, VIEWER_ROOT, DATA_ROOT } from "./serve.mjs";
import { parseCsvObjects } from "../lib/csv.js";
import { scopeKey } from "../lib/model.js";
import { FEE_LINKS } from "../lib/fee-links.js";

const root = DATA_ROOT;
const shots = process.env.SCREENSHOT_DIR || "";
if (shots) mkdirSync(shots, { recursive: true });

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

const { chromium } = await loadPlaywright();
const port = 8790 + Math.floor(Math.random() * 100);
const server = await serve({ "/mfa/": VIEWER_ROOT, "/mfa-data/": root }, port);
const base = `http://127.0.0.1:${port}/mfa/?data=../mfa-data/`;
const browser = await chromium.launch({ args: process.env.BROWSER_PROXY ? [`--proxy-server=${process.env.BROWSER_PROXY}`] : [] });
const problems = [];

async function newPage(viewport = { width: 1440, height: 900 }, init) {
  const page = await browser.newPage({ viewport });
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

// An agency opened from a tab's list goes into the address bar, and back and
// forward move between the list and the agency.
async function roundTrip(page, { param, title, list }) {
  const name = new URL(page.url()).searchParams.get(param);
  await page.goBack();
  await page.waitForSelector(list);
  assert.equal(new URL(page.url()).searchParams.get(param), null, `back leaves ${name}`);
  await page.goForward();
  await page.waitForFunction(([s, n]) => document.querySelector(s)?.textContent === n, [title, name]);
  assert.equal(new URL(page.url()).searchParams.get(param), name, `forward returns to ${name}`);
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
  await page.waitForFunction((k) => document.querySelector("#scope")?.value === k, key);
  const inScope = new Set(primary.filter((r) => scopeKey(r.land_use_scope) === key).map((r) => r.figure_group_id)).size;
  await page.waitForFunction((n) => document.querySelector(".result-bar .count strong")?.innerText.replace(/,/g, "") === String(n), inScope);
  await page.click(".result-bar .filter-tag button");

  // Tags answer on hover at once, in a few words.
  await page.locator(".figures-grid tbody tr .col-notes a.b-scope").first().hover();
  await page.waitForSelector("#tooltip.tip-short:not([hidden])", { timeout: 2000 });
  assert.match(await page.locator("#tooltip").innerText(), /^Land use: \S+( \S+)?$/);
  await page.mouse.move(0, 0);

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
  await page.locator(".fee-grid tbody tr[data-id] .pdf-btn").last().click();
  await page.waitForSelector(".pv-box.current", { state: "attached" });
  await shot(page, "05b-fee");
  await page.keyboard.press("Escape");
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

  // The name in an open report or figure filters the tab being read, and the
  // panel stays open.
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
  assert.ok(await page.locator(".permits-chart .pt").count() > 1, "the chart plots more than one agency year");
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
  const permitLink = page.locator(".permits-list tbody .col-entity a").first();
  const permitEntity = new URL(await permitLink.getAttribute("href"), page.url()).searchParams.get("e");
  await permitLink.click();
  await page.waitForFunction((n) => document.querySelector(".dossier-head h2")?.textContent === n, permitEntity);
  assert.equal(new URL(page.url()).searchParams.get("e"), permitEntity);
  await page.goBack();
  await page.waitForSelector(".permits-chart .hit");
  assert.match(page.url(), /[?&]view=permits/, "back returns to Permits");
  await page.goForward();
  await page.waitForFunction((n) => document.querySelector(".dossier-head h2")?.textContent === n, permitEntity);

  // Dark theme and a phone-width layout
  const dark = await newPage({ width: 1280, height: 800 }, () => localStorage.setItem("amyc-theme", "cypress"));
  await dark.goto(`${base}&view=figures&f=${encodeURIComponent(primary[0].figure_group_id)}`);
  await dark.waitForSelector(".pv-box.current", { state: "attached" });
  await dark.waitForTimeout(400);
  await shot(dark, "08-dark");

  const phone = await newPage({ width: 390, height: 844 });
  await phone.goto(`${base}&view=figures`);
  await phone.waitForSelector(".figures-grid tbody tr");
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `page must not scroll sideways at phone width (overflow ${overflow}px)`);
  await phone.locator(".figures-grid tbody tr .pdf-btn").first().click();
  await phone.waitForSelector(".pv-box.current", { state: "attached" });
  await shot(phone, "09-phone");
  await phone.keyboard.press("Escape");
  // The tab strip scrolls inside itself, so the last tabs are reachable and
  // the page still does not scroll sideways.
  await phone.locator('.view-tab[data-view="permits"]').click();
  await phone.waitForSelector(".permits-chart .hit");
  assert.match(phone.url(), /[?&]view=permits/);
  assert.equal(await textOf(phone, ".view-tab.active"), "Permits");
  const phoneOverflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(phoneOverflow <= 1, `Permits must not scroll sideways at phone width (overflow ${phoneOverflow}px)`);
  await shot(phone, "10-phone-permits");

  assert.deepEqual(problems, [], "no page errors, console errors or failed requests");
  console.log("smoke test passed");
} finally {
  await browser.close();
  server.close();
}
