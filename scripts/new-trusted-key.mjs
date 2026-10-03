#!/usr/bin/env node
// node scripts/new-trusted-key.mjs <label>
//
// Makes one trusted key for the data Workers (worker/gate.js, rule 7 of
// TURNSTILE-SPEC.md). It prints the key once, the links to give the person,
// and the line to add to TRUSTED_KEY_HASHES in all five wrangler.toml files
// (aimesy/mfa, kcsc, nysc, tentatives, sfsc). Only the hash is ever
// committed; the key is not stored anywhere, so copy it now.
//
// The label is a short tag such as an initial, never a name or an email.
// Revoke a key by deleting its line and redeploying each Worker.

import { createHash, randomBytes } from "node:crypto";

const label = process.argv[2] || "";
if (!/^[A-Za-z0-9._-]{1,12}$/.test(label)) {
  console.error("Usage: node scripts/new-trusted-key.mjs <label>   (1 to 12 letters, digits, dot, dash or underscore; an initial, never a name)");
  process.exit(2);
}

const key = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(key, "utf8").digest("hex");
const viewers = ["https://mfa.amyc.us", "https://kcsc.amyc.us", "https://nysc.amyc.us", "https://tentatives.amyc.us", "https://sfsc.amyc.us"];

console.log("Key (shown once; give it only to the person it is for):");
console.log(`  ${key}`);
console.log("");
console.log("Links (open each once in the browser that should be trusted):");
for (const v of viewers) console.log(`  ${v}/#key=${key}`);
console.log("");
console.log("Add to TRUSTED_KEY_HASHES in each data Worker's wrangler.toml, then redeploy:");
console.log(`  ${hash} ${label}`);
