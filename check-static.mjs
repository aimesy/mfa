// node check-static.mjs
// Static contracts for the viewer, in the style of aimesy/tentatives'
// site/check-static.mjs: hosted shared theme, strict page policy, no HTML
// injection of release text, and the data rules the release depends on.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

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

// Page policy: same-origin scripts plus the theme host and Turnstile; data only from the release Worker.
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(index)?.[1] || "";
assert.ok(csp, "Content-Security-Policy meta is missing");
assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+' https:\/\/aimesy\.github\.io https:\/\/challenges\.cloudflare\.com;/, "scripts must be same-origin, the import map, the shared theme host or Turnstile");

// The import map gives every lib module the app.js cache key, so a deploy
// never pairs a new app.js with a lib file the browser kept; script-src
// allows exactly its text and no other inline script.
const appKey = /<script type="module" src="app\.js\?v=([^"]+)"><\/script>/.exec(index)?.[1];
assert.ok(appKey, "app.js must load with a ?v= cache key");
assert.ok(index.includes(`href="styles.css?v=${appKey}"`), "styles.css carries the app.js key");
const maps = [...index.matchAll(/<script type="importmap">([^<]*)<\/script>/g)];
assert.equal(maps.length, 1, "index.html has one import map");
assert.ok(index.indexOf('<script type="importmap">') < index.indexOf('<script type="module"'), "the import map comes before the module script");
const importMap = JSON.parse(maps[0][1]).imports;
const libFiles = Object.keys(libs).filter((f) => f.endsWith(".js")).sort();
assert.deepEqual(Object.keys(importMap).sort(), libFiles.map((f) => `./lib/${f}`), "the import map lists every lib module");
for (const f of libFiles) assert.equal(importMap[`./lib/${f}`], `./lib/${f}?v=${appKey}`, `lib/${f} carries the app.js key`);
const mapHash = createHash("sha256").update(maps[0][1], "utf8").digest("base64");
assert.deepEqual([...csp.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]), [mapHash], "script-src allows the import map's hash and nothing else inline");
assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com;/, "only Turnstile may be framed");
assert.equal((index.match(/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/g) || []).length, 1, "Turnstile loads once, rendered by app.js");
assert.match(app, /const TURNSTILE_SITEKEY = "0x[0-9A-Za-z_-]+";/, "app.js must name the Turnstile site key");
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
assert.match(app, /credentials: "include"/, "release requests must carry the session cookie");
assert.match(evidence, /dataFetch\(url/, "evidence PDFs must be fetched with the session");
assert.doesNotMatch(app, /reported-fee-collections\.json|mfa-reviewed-collections\.xlsx|links\("Downloads"/, "no bulk download links");
const worker = read("./worker/release.js");
const regexOf = (src, name) => new RegExp(`const ${name} = (\\/.+\\/);`).exec(src)?.[1];
for (const name of ["RELEASE_PATH", "ASSET_PATH"]) {
  assert.ok(regexOf(app, name), `app.js must define ${name}`);
  assert.equal(regexOf(worker, name), regexOf(app, name), `worker/release.js must allow exactly the ${name} values app.js asks for`);
}
// Downloads carry data rows only: no CSV column holds a release document
// address (the Worker serves the same files), and the Figures CSV drops the
// release's three document columns.
assert.match(app, /const DOCUMENT_COLUMNS = new Set\(\["source_pdf", "page_extract_pdf", "outlined_figure_pdf"\]\);/, "app.js must name the release's document columns");
assert.match(app, /columns\.filter\(\(k\) => !DOCUMENT_COLUMNS\.has\(k\)\)/, "the Figures CSV must leave out the document columns");
for (const [name, src] of Object.entries({ "app.js": app, ...libs })) {
  assert.doesNotMatch(src, /key: "[a-z_]*_pdf"/, `${name} must not export a document address column`);
}
assert.match(model, /is_primary_in_figure_group === TRUE/, "sums must come from primary rows only");
assert.match(app, /mx-empty/, "the jurisdiction matrix must mark missing cells as missing");
assert.match(evidence, /sha256Hex/, "evidence files must be hash-checked");
assert.match(viewer, /verify\(\)/, "boxes must be checked against the evidence outline before they are drawn");
assert.match(styles, /--figure-mark/);

console.log("Viewer static checks passed.");
