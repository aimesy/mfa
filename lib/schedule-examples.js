// Example developments: what three model homes pay in one agency's own
// development fees, from data/fee-schedule-examples.csv. Each line names the
// schedule row it applies (schedule_row_id) and how; each example has one
// total row with whether the agency's fees are complete and what is left
// out. Like a health plan's coverage examples: fixed cases, the same in every
// jurisdiction, so the totals compare. No DOM.

import { parseCsvObjects } from "./csv.js";

export const EXAMPLES_PATH = "data/fee-schedule-examples.csv";

export const EXAMPLES = [
  { id: "detached_house", label: "Detached house", spec: "2,000 sq ft, 4 bedrooms, 5 homes per acre", sqft: 2000 },
  { id: "townhome", label: "Townhome", spec: "1,500 sq ft, 3 bedrooms, 20 homes per acre", sqft: 1500 },
  { id: "apartment", label: "Apartment", spec: "1,000 sq ft, 2 bedrooms, 50 homes per acre", sqft: 1000 },
];

// The statutory Level 1 school fee maximum (Ed. Code 17620; State Allocation
// Board, January 28, 2026). School districts charge it, not the agency.
export const SCHOOL_RATE = 5.38;

export function parseExamples(text) {
  const { rows } = parseCsvObjects(text);
  const byAgency = new Map();
  for (const r of rows) {
    if (!EXAMPLES.some((e) => e.id === r.example)) continue;
    const a = byAgency.get(r.agency) || new Map();
    byAgency.set(r.agency, a);
    const ex = a.get(r.example) || { lines: [], total: null, complete: false, notIncluded: [], scenario: "" };
    a.set(r.example, ex);
    if (r.row_type === "total") {
      ex.total = Number(r.total);
      ex.complete = r.complete === "yes";
      ex.notIncluded = String(r.not_included || "").split("; ").map((s) => s.trim()).filter(Boolean);
      ex.scenario = r.scenario || "";
    } else if (r.row_type === "line") {
      ex.lines.push({ program: r.fee_program, rowId: r.schedule_row_id, amount: r.amount === "" ? null : Number(r.amount), how: r.how, inputs: r.inputs, note: r.note });
    }
  }
  return byAgency;
}

export const money = (n) => (n == null || !Number.isFinite(n) ? "" : `$${Math.round(n).toLocaleString("en-US")}`);
export const schoolFee = (example) => example.sqft * SCHOOL_RATE;
