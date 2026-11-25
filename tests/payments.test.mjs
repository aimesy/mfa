// node tests/payments.test.mjs
import assert from "node:assert/strict";
import { parsePayments, sumBy, shareText } from "../lib/payments.js";

const head = "agency,fiscal_year,fee_program,measure,total_usd,stated_residential_usd,stated_nonresidential_usd,unknown_usd,line_count,export_first_date,export_last_date";
const by = parsePayments(`${head}\nCity of A,2023-24,Park,paid,100.00,80.00,10.00,10.00,4,2023-07-02,2025-01-01\nCity of A,2023-24,Traffic,paid,100.00,0.00,100.00,0.00,1,2023-07-02,2025-01-01\n`);
const rows = by.get("City of A");
assert.equal(rows.length, 2);
const [y] = sumBy(rows, "fy");
assert.deepEqual(y, { key: "2023-24", lines: 5, total: 200, res: 80, non: 110, unknown: 10 });
assert.equal(shareText(y), "40% to 45%");
assert.equal(shareText({ total: 100, res: 25, non: 75, unknown: 0 }), "25%");
assert.equal(shareText({ total: 100, res: 120, non: -20, unknown: 0 }), "", "a negative part has no share");
assert.equal(shareText({ total: 0, res: 0, non: 0, unknown: 0 }), "");
assert.throws(() => parsePayments("agency\nX\n"), /missing columns/);
console.log("payments ok");
