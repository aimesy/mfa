// node check-static.mjs
// Static contracts for the viewer, in the style of aimesy/tentatives'
// site/check-static.mjs: pinned shared theme, strict page policy, no HTML
// injection of release text, and the data rules the release depends on.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const index = read("./index.html");
const app = read("./app.js");
const styles = read("./styles.css");
const libs = Object.fromEntries(readdirSync(new URL("./lib/", import.meta.url)).map((f) => [f, read(`./lib/${f}`)]));
const model = libs["model.js"];
const evidence = libs["evidence.js"];
const viewer = libs["viewer.js"];

// Shared theme: five assets, one immutable aimesy/themes commit, loaded after local CSS.
const themeAssets = new Set(["theme.css", "theme-bar.css", "bug-report.css", "theme.js", "bug-report.js"]);
const pinned = [...index.matchAll(/https:\/\/cdn\.jsdelivr\.net\/gh\/aimesy\/themes@([0-9a-f]{40})\/src\/(theme\.css|theme-bar\.css|bug-report\.css|theme\.js|bug-report\.js)/g)];
const anyTheme = [...index.matchAll(/https:\/\/cdn\.jsdelivr\.net\/gh\/aimesy\/themes[^"' \s>]*/g)];
assert.equal(pinned.length, themeAssets.size, "shared theme asset set must contain exactly five pinned assets");
assert.equal(anyTheme.length, themeAssets.size, "unexpected shared theme asset reference remains");
assert.deepEqual(new Set(pinned.map((m) => m[2])), themeAssets, "shared theme asset set is incomplete or duplicated");
assert.equal(new Set(pinned.map((m) => m[1])).size, 1, "shared theme assets must use one commit SHA");
assert.doesNotMatch(index, /aimesy\/themes(?:\/|@(master|main|latest)\/)/i, "mutable or unversioned shared theme reference remains");
assert.ok(index.indexOf('href="styles.css') < index.indexOf("/src/theme.css"), "shared theme CSS must load after local viewer CSS");
assert.equal((index.match(/\bdata-theme-toggle\b/g) || []).length, 1, "viewer must contain exactly one theme toggle");
assert.equal((index.match(/\bamyc-theme-bar\b/g) || []).length, 1, "viewer must contain exactly one shared theme bar");
assert.match(index, /data-bug-report-repo="aimesy\/[a-z0-9-]+"/, "bug reporter must name a repository");

// Page policy: same-origin scripts plus the theme CDN; data only from the release host.
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(index)?.[1] || "";
assert.ok(csp, "Content-Security-Policy meta is missing");
assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net;/, "scripts must be same-origin or the pinned theme CDN");
assert.match(csp, /connect-src 'self' https:\/\/raw\.githubusercontent\.com https:\/\/api\.github\.com;/, "data may come only from the release host");
assert.match(csp, /object-src 'none'/);
assert.doesNotMatch(csp, /unsafe-eval/, "no eval");

// Release text reaches the page as text, never as markup.
for (const [name, src] of Object.entries({ "app.js": app, ...libs })) {
  assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/, `${name} must not inject HTML`);
}

// pdf.js is vendored at one version and loaded without eval.
const pdfVersion = /vendor\/pdfjs-([0-9.]+)\//.exec(evidence)?.[1];
assert.ok(pdfVersion, "evidence.js must load the vendored pdf.js");
for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs", "LICENSE", "standard_fonts", "cmaps"]) {
  assert.ok(existsSync(new URL(`./vendor/pdfjs-${pdfVersion}/${f}`, import.meta.url)), `vendored pdf.js is missing ${f}`);
}
assert.match(evidence, /isEvalSupported: false/);

// The data rules the release states.
assert.match(app, /raw\.githubusercontent\.com\/\$\{REPO\}\//, "viewer must read the release from GitHub");
assert.match(app, /const REPO = "aimesy\/mfa-data";/);
assert.match(model, /is_primary_in_figure_group === TRUE/, "sums must come from primary rows only");
assert.match(app, /never zero/, "the page must say a missing figure is not a zero");
assert.match(app, /mx-empty/, "the jurisdiction matrix must mark missing cells as missing");
assert.match(evidence, /sha256Hex/, "evidence files must be hash-checked");
assert.match(viewer, /verify\(\)/, "boxes must be checked against the evidence outline before they are drawn");
assert.match(styles, /--figure-mark/);

console.log("Viewer static checks passed.");
