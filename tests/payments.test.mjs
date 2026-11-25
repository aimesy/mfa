// node tests/payments.test.mjs
import assert from "node:assert/strict";
import { parsePermits, orderRows } from "../lib/payments.js";

const head = "agency,fiscal_year,development_type,measure,permits,median_usd,p25_usd,p75_usd,min_usd,max_usd,types_as_printed,fees_counted,source_sha256";
const by = parsePermits([head,
  "City of A,2024-25,Nonresidential,paid,2,9000.00,8000.00,10000.00,7000.00,11000.00,COMMERCIAL,Impact fees,aa",
  "City of A,2024-25,Single family,paid,10,30000.00,29000.00,31000.00,1000.00,40000.00,SFR,Impact fees,aa",
  "City of A,,Single family,paid,1,500.00,500.00,500.00,500.00,500.00,SFR,Impact fees,aa",
  "City of A,2023-24,Single family,paid,4,28000.00,27000.00,29000.00,26000.00,30000.00,SFR,Impact fees,aa",
].join("\n") + "\n");
const rows = orderRows(by.get("City of A"));
assert.deepEqual(rows.map((r) => [r.type, r.fy]), [
  ["Single family", "2023-24"], ["Single family", "2024-25"], ["Single family", ""], ["Nonresidential", "2024-25"]]);
assert.equal(rows[1].median, 30000);
assert.throws(() => parsePermits("agency\nX\n"), /missing columns/);
console.log("permits ok");
