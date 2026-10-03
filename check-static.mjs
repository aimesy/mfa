// node check-static.mjs
// Static contracts for the viewer, in the style of aimesy/tentatives'
// site/check-static.mjs: hosted shared theme, strict page policy, no HTML
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

// Shared theme: five assets, loaded live from the aimesy/themes Pages site, after local CSS.
const THEME_BASE = "https://aimesy.github.io/themes/src/";
const themeAssets = ["theme.css", "theme-bar.css", "bug-report.css", "theme.js", "bug-report.js"];
for (const name of themeAssets) {
  assert.equal(index.split(`"${THEME_BASE}${name}"`).length - 1, 1, `index.html must load ${name} exactly once from ${THEME_BASE}`);
}
const anyTheme = [...index.matchAll(/aimesy\.github\.io\/themes[^"' \s>]*/g)];
assert.equal(anyTheme.length, themeAssets.length, "unexpected shared theme asset reference remains");
for (const [name, src] of Object.entries({ "index.html": index, "app.js": app, "styles.css": styles, ...libs })) {
  assert.doesNotMatch(src, /cdn\.jsdelivr\.net\/gh\/aimesy\/themes/i, `${name} must load the shared theme from ${THEME_BASE}, not a jsDelivr pin`);
}
assert.ok(index.indexOf('href="styles.css') < index.indexOf("/src/theme.css"), "shared theme CSS must load after local viewer CSS");
assert.equal((index.match(/\bdata-theme-toggle\b/g) || []).length, 1, "viewer must contain exactly one theme toggle");
assert.equal((index.match(/\bamyc-theme-bar\b/g) || []).length, 1, "viewer must contain exactly one shared theme bar");
assert.match(index, /data-bug-report-repo="aimesy\/[a-z0-9-]+"/, "bug reporter must name a repository");

// Page policy: same-origin scripts plus the theme host; data only from the release host.
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(index)?.[1] || "";
assert.ok(csp, "Content-Security-Policy meta is missing");
assert.match(csp, /script-src 'self' https:\/\/aimesy\.github\.io;/, "scripts must be same-origin or the shared theme host");
assert.match(csp, /style-src [^;]*https:\/\/aimesy\.github\.io[ ;]/, "styles must allow the shared theme host");
assert.match(csp, /connect-src 'self' https:\/\/mfa-data\.amyc\.us;/, "data may come only from the release Worker");
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
// The release repository is private: the viewer reads it only through the
// Worker in worker/, which serves the same paths the viewer may ask for.
assert.match(app, /const DATA_ROOT = "https:\/\/mfa-data\.amyc\.us\/";/, "viewer must read the release through the mfa-data Worker");
for (const [name, src] of Object.entries({ "index.html": index, "app.js": app, ...libs })) {
  assert.doesNotMatch(src, /raw\.githubusercontent\.com|api\.github\.com|github\.com\/aimesy\/mfa-data/, `${name} must not reach the private release on GitHub directly`);
}
assert.match(app, /const REPO = "aimesy\/mfa-data";/);
const worker = read("./worker/release.js");
const regexOf = (src, name) => new RegExp(`const ${name} = (\\/.+\\/);`).exec(src)?.[1];
for (const name of ["RELEASE_PATH", "ASSET_PATH"]) {
  assert.ok(regexOf(app, name), `app.js must define ${name}`);
  assert.equal(regexOf(worker, name), regexOf(app, name), `worker/release.js must allow exactly the ${name} values app.js asks for`);
}
assert.match(model, /is_primary_in_figure_group === TRUE/, "sums must come from primary rows only");
assert.match(app, /mx-empty/, "the jurisdiction matrix must mark missing cells as missing");
assert.match(evidence, /sha256Hex/, "evidence files must be hash-checked");
assert.match(viewer, /verify\(\)/, "boxes must be checked against the evidence outline before they are drawn");
assert.match(styles, /--figure-mark/);

console.log("Viewer static checks passed.");
