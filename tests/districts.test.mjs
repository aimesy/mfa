// node tests/districts.test.mjs
// Checks lib/districts.js on a small fixture, then legislative/districts.json
// itself: shape, coverage of the roster, shares and spot checks verified
// against the PL 94-171 place codes. When an mfa-data checkout is present
// (MFA_DATA_ROOT, or ../mfa-data beside this repository), it also checks that
// every name the release prints resolves.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DISTRICTS_URL, indexDistricts, loadDistricts } from "../lib/districts.js";
import { parseCsvObjects } from "../lib/csv.js";
import { buildModel } from "../lib/model.js";

const repo = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

// ------------------------------------------------------------ fixture

function fixture() {
  const chamber = (n) => Array.from({ length: n }, (_, i) => [i + 1, [0]]);
  return {
    meta: { plan: "p", plan_note: "n", source: "s", method: "m", caveat: "c.", built_utc: "2026-01-01T00:00:00Z", vintage: "v", counts: {} },
    counties: ["Alpha", "Beta", "Alpha, Beta"],
    types: ["city", "elementary_school_district", "special_district"],
    classes: ["municipal", "school", "special"],
    bases: ["boundary", "district_boundary", "same_as", "approximate", "unmapped"],
    notes: ["A note."],
    chambers: { ad: chamber(80), sd: chamber(40) },
    columns: ["name", "type", "county", "class", "basis", "note", "ad", "sd", "release", "roster"],
    district_columns: ["n", "share_permille", "area_share_permille"],
    agencies: [
      ["Example city", 0, 0, 0, 0, -1, [3, 950, 800, 1, 50, 150, 2, 0, 50], [1, 1000, 1000], ["City of Example"], 1],
      ["Lakeside Union", 1, 0, 1, 0, -1, [4, 1000, 1000], [2, 1000, 1000], [], 1],
      ["Lakeside Union", 1, 1, 1, 0, -1, [5, 1000, 1000], [3, 1000, 1000], [], 1],
      ["Empty District", 2, 2, 2, 1, 0, [7, null, 1000], [4, null, 1000], [], 1],
      ["Nowhere JPA", 2, 1, 2, 4, 0, [], [], [], 0],
    ],
    aliases: { "Example": 0, "Lakeside": [1, 2] },
  };
}

{
  const d = indexDistricts(fixture());
  assert.equal(DISTRICTS_URL, "legislative/districts.json");
  assert.equal(d.chambers.ad.length, 80);
  assert.equal(d.chambers.sd[39].label, "Senate District 40");
  assert.deepEqual(d.chambers.ad[0].counties, ["Alpha"]);

  const ex = d.lookup("Example city");
  assert.equal(ex.key, "Example city|city|Alpha");
  assert.equal(d.lookup("City of Example"), ex, "a release name finds its record");
  assert.equal(d.lookup("Example"), ex, "an alias finds its record");
  assert.deepEqual(ex.ad.map((x) => [x.n, x.share, x.area_share, x.edge]), [[3, 0.95, 0.8, false], [1, 0.05, 0.15, false], [2, 0, 0.05, true]]);
  assert.deepEqual(ex.ad.map((x) => x.counts), [true, true, false], "an edge contact does not count");
  assert.deepEqual(d.districtKeys("City of Example"), { ad: ["3", "1"], sd: ["1"] }, "filters skip edge contacts");
  assert.ok(Object.isFrozen(ex) && Object.isFrozen(ex.ad) && Object.isFrozen(ex.ad[0]));

  assert.equal(d.lookup("Lakeside Union"), null, "two records share the name");
  assert.equal(d.lookup("Lakeside Union", { county: "Beta" }).county, "Beta");
  assert.equal(d.lookup("Lakeside", { type: "elementary_school_district", county: "Alpha" }).ad[0].n, 4);
  assert.equal(d.lookup("Lakeside Union", { county: "Gamma" }), null, "no county match leaves the tie");

  const empty = d.lookup("Empty District");
  assert.equal(empty.ad[0].share, null);
  assert.equal(empty.ad[0].edge, true, "no residents is an edge contact");
  assert.equal(empty.ad[0].counts, true, "an agency with no residents counts where it reaches");
  assert.deepEqual(d.districtKeys("Empty District"), { ad: ["7"], sd: ["4"] });
  assert.equal(empty.basis_note, "A note.");
  assert.equal(empty.county, "Alpha, Beta");
  assert.equal(d.lookup("Empty District", { county: "Beta" }), empty, "one candidate needs no filter");
  assert.equal(d.lookup("Example city", { county: "Alpha" }), ex);
  assert.equal(d.lookup("Example city", { county: "Gamma" }), null, "a lone record in another county is not the agency");
  assert.equal(d.districtKeys("Example city", { county: "Gamma" }), null);

  assert.equal(d.lookup("Nowhere JPA").basis, "unmapped");
  assert.equal(d.districtKeys("Nowhere JPA"), null);
  assert.equal(d.districtKeys("Not An Agency"), null);
  assert.equal(d.lookup("Not An Agency"), null);
  assert.equal(d.agencies().length, 4, "agencies() leaves out unmapped records");

  const bad = (mut, re) => {
    const j = fixture();
    mut(j);
    assert.throws(() => indexDistricts(j), re);
  };
  bad((j) => j.chambers.ad.pop(), /ad must list 80/);
  bad((j) => (j.columns = j.columns.slice(1)), /unexpected columns/);
  bad((j) => (j.agencies[0][6] = [3, 950]), /triples/);
  bad((j) => (j.agencies[0][1] = 9), /bad lookup index/);
  bad((j) => (j.aliases.Example = 99), /points nowhere/);
  bad((j) => delete j.meta, /meta is missing/);
}

// loadDistricts is memoized, and a failed load is forgotten.
{
  let calls = 0;
  await assert.rejects(loadDistricts(async () => {
    calls++;
    throw new Error("offline");
  }), /offline/);
  const ok = async (url) => {
    calls++;
    assert.equal(url, DISTRICTS_URL);
    return fixture();
  };
  const p = loadDistricts(ok);
  assert.equal(loadDistricts(ok), p, "one load at a time");
  assert.equal((await p).chambers.sd.length, 40);
  assert.equal(await loadDistricts(ok), await p);
  assert.equal(calls, 2, "a retry after a failure loads again; later calls reuse it");
}

// ------------------------------------------------------------ the built file

const raw = JSON.parse(readFileSync(repo("legislative/districts.json"), "utf8"));
const d = indexDistricts(raw);
const meta = d.meta;
for (const k of ["plan", "plan_note", "source", "method", "caveat", "built_utc", "vintage"]) {
  assert.equal(typeof meta[k], "string", `meta.${k}`);
  assert.ok(meta[k].length, `meta.${k} is not empty`);
}
assert.match(meta.plan, /^2021 Citizens Redistricting Commission maps/);
assert.equal(meta.caveat.split(/\.\s/).length, 1, "the caveat is one sentence");
assert.doesNotMatch(JSON.stringify(raw), /\$\s?\d/, "no dollar amounts");
assert.doesNotMatch(JSON.stringify(raw.meta), /—/, "no em dashes in the prose");
assert.ok(readFileSync(repo("legislative/districts.json")).length < 1.5e6, "districts.json stays under 1.5 MB");

for (const [ch, n, label] of [["ad", 80, "Assembly District"], ["sd", 40, "Senate District"]]) {
  assert.equal(d.chambers[ch].length, n);
  d.chambers[ch].forEach((x, i) => {
    assert.equal(x.n, i + 1);
    assert.equal(x.label, `${label} ${i + 1}`);
    assert.ok(x.counties.length > 0 && x.counties.every((c) => typeof c === "string" && c), `${x.label} has counties`);
  });
}
assert.deepEqual(d.chambers.ad[16].counties, ["San Francisco"], "AD 17 is all San Francisco");

// Shares, edges and order.
let records = 0;
for (const r of d.agencies()) {
  records++;
  assert.ok(r.ad.length > 0 && r.sd.length > 0, `${r.key} is in at least one district of each chamber`);
  for (const ch of ["ad", "sd"]) {
    const l = r[ch];
    const nulls = l.filter((x) => x.share === null).length;
    assert.ok(nulls === 0 || nulls === l.length, `${r.key} ${ch}: shares are all null or none`);
    if (!nulls) {
      const sum = l.reduce((s, x) => s + x.share, 0);
      assert.ok(Math.abs(sum - 1) <= 0.002, `${r.key} ${ch}: shares sum to ${sum}`);
    }
    for (let i = 0; i < l.length; i++) {
      const x = l[i];
      assert.ok(x.n >= 1 && x.n <= (ch === "ad" ? 80 : 40), `${r.key} ${ch} ${x.n}`);
      assert.equal(x.edge, x.share === null || x.share < 0.01, `${r.key} ${ch} ${x.n} edge flag`);
      assert.ok(x.area_share >= 0 && x.area_share <= 1);
      if (i) {
        const p = l[i - 1];
        assert.ok((p.share ?? -1) > (x.share ?? -1) || ((p.share ?? -1) === (x.share ?? -1) && p.n < x.n), `${r.key} ${ch} is sorted`);
      }
    }
  }
  assert.notEqual(r.basis, "unmapped");
  if (r.basis === "approximate") assert.ok(r.basis_note, `${r.key} says what stands in for its boundary`);
}
assert.equal(records, raw.agencies.filter((a) => a[4] !== 4).length);

// Spot checks, verified independently from the PL 94-171 PLACE code and the
// Commission's block equivalency file.
const ad = (name, opts) => d.lookup(name, opts).ad;
const nums = (l) => l.map((x) => x.n).sort((a, b) => a - b);
const edges = (l) => nums(l.filter((x) => x.edge));
{
  const oak = ad("Oakland city");
  assert.deepEqual(nums(oak), [14, 18, 20]);
  assert.deepEqual(edges(oak), [20]);
  assert.equal(oak[0].n, 18);
  assert.ok(Math.abs(oak[0].share - 0.891) <= 0.001);
  assert.deepEqual(nums(ad("Fremont city")), [24]);
  assert.deepEqual(nums(ad("Mountain House city")), [13]);
  const sf = ad("City and County of San Francisco");
  assert.ok([17, 19].every((n) => sf.some((x) => x.n === n && !x.edge)), "San Francisco is in AD 17 and 19");
  assert.ok([12, 18].every((n) => sf.some((x) => x.n === n && x.edge)), "San Francisco touches AD 12 and 18 only by water");
  const la = ad("Los Angeles city");
  assert.ok(la.length >= 13 && la.length <= 15, `Los Angeles touches ${la.length} Assembly districts`);
  assert.equal(la.filter((x) => !x.edge).length, 12);
  assert.ok(la.some((x) => x.n === 41 && x.share === 0), "a corner of AD 41 with no residents");
  const sac = ad("Sacramento city");
  assert.deepEqual(nums(sac.filter((x) => !x.edge)), [6, 10]);
  assert.deepEqual(edges(sac), [7, 9]);
  assert.deepEqual(nums(d.lookup("Oakland city").sd), [7]);
  assert.deepEqual(d.districtKeys("Fremont city"), { ad: ["24"], sd: ["10"] });
  // The 1% rule: edge contacts stay on the record but leave the filter.
  assert.deepEqual(d.districtKeys("City and County of San Francisco").ad.sort(), ["17", "19"]);
  assert.ok(!d.districtKeys("City and County of San Francisco").sd.includes("7"), "San Francisco does not count in SD 7");
  assert.deepEqual(d.districtKeys("Sacramento city").ad.sort(), ["10", "6"]);
  assert.deepEqual(d.districtKeys("San Leandro city"), { ad: ["20"], sd: ["9"] });

  // A 2020 block of the next county does not put a polygon in a district it
  // never reaches (AD 17 is San Francisco only; AD 12 holds no part of Napa).
  for (const name of ["Daly City city", "San Mateo County", "Bayshore Elementary", "Jefferson Union High", "San Mateo County Office of Education"]) {
    assert.ok(!nums(ad(name)).includes(17), `${name} is not in AD 17`);
  }
  for (const name of ["Napa County", "Saint Helena Unified", "Napa County Office of Education"]) assert.ok(!nums(ad(name)).includes(12), `${name} is not in AD 12`);

  // A special district's part holding no block interior point still counts.
  const special = (name) => d.agencies().find((r) => r.name === name);
  assert.deepEqual(nums(special("Donner Summit Public Utility District").sd), [1, 4]);
  assert.ok(nums(special("Orange Cove Police Protection District").ad).includes(8));
  assert.ok(nums(special("Orange Cove Police Protection District").sd).includes(12));
  assert.ok(nums(special("Coachella Valley Water District").ad).includes(75));
  for (const r of d.agencies()) {
    if (r.basis !== "district_boundary") continue;
    for (const ch of ["ad", "sd"]) {
      const area = r[ch].reduce((s, x) => s + x.area_share, 0);
      assert.ok(area >= 0.98, `${r.key} ${ch}: the districts listed hold ${area} of its area`);
    }
  }
}

// Spellings: "City of X" and "X city" are the same lookup.
{
  let n = 0;
  for (const r of d.agencies()) {
    const m = /^(.+) (city|town)$/.exec(r.name);
    if (r.class !== "municipal" || !m) continue;
    const word = m[2] === "city" ? "City" : "Town";
    assert.equal(d.lookup(`${word} of ${m[1]}`), r, `${word} of ${m[1]}`);
    assert.equal(d.lookup(`${m[1]} ${m[2]}`), r);
    n++;
  }
  assert.ok(n >= 480, `${n} cities and towns`);
  assert.equal(d.lookup("County of Alameda"), d.lookup("Alameda County"));
  assert.equal(d.lookup("City of San Francisco"), d.lookup("City and County of San Francisco"));
}

// Every municipal roster agency is mapped.
{
  const cov = JSON.parse(readFileSync(repo("coverage/coverage.json"), "utf8"));
  const col = Object.fromEntries(cov.columns.map((c, i) => [c, i]));
  let muni = 0;
  let schools = 0;
  for (const a of cov.agencies) {
    const cls = cov.classes[a[col.class]].key;
    const opts = { type: cov.types[a[col.type]], county: cov.counties[a[col.county]] };
    const r = d.lookup(a[col.name], opts);
    if (cls === "municipal") {
      muni++;
      assert.ok(r && r.basis === "boundary", `${a[col.name]} is mapped`);
      assert.equal(r.class, "municipal");
    }
    if (cls === "school" && r) schools++;
    if (r) {
      assert.equal(r.name, a[col.name], "a roster name finds its own record");
      const want = opts.county.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
      assert.ok(!want.length || r.county.split(/[;,]/).some((x) => want.includes(x.trim())), `${a[col.name]} [${opts.county}] finds a record in its county, not ${r.county}`);
    }
  }
  assert.equal(muni, cov.classes.find((c) => c.key === "municipal").roster);
  assert.ok(schools >= 1000, `${schools} school roster agencies mapped`);
}

// The release, when a checkout is present.
const releaseRoot = path.resolve(process.env.MFA_DATA_ROOT || fileURLToPath(new URL("../../mfa-data", import.meta.url)));
const releaseCsv = path.join(releaseRoot, "data/reported-fee-collections.csv");
if (existsSync(releaseCsv)) {
  const fees = parseCsvObjects(readFileSync(releaseCsv, "utf8"));
  const sources = parseCsvObjects(readFileSync(path.join(releaseRoot, "sources/index.csv"), "utf8"));
  const m = buildModel(fees.rows, sources.rows);
  const tiger = new Set(["city", "town", "incorporated_city_or_town", "city_and_county", "county",
    "school_district", "unified_school_district", "elementary_school_district", "high_school_district"]);
  let inScope = 0;
  const unmapped = [];
  for (const e of m.entities) {
    const r = d.lookup(e.name, { type: e.type, county: e.county });
    assert.ok(r, `${e.name} has a record`);
    if (tiger.has(e.type)) {
      inScope++;
      assert.equal(r.basis, "boundary", `${e.name} [${e.type}] maps by its TIGER boundary`);
    }
    if (!d.districtKeys(e.name, { type: e.type, county: e.county })) unmapped.push(e.name);
  }
  assert.ok(unmapped.length <= 1, `unmapped release agencies: ${unmapped.join("; ")}`);
  for (const s of sources.rows) assert.ok(d.lookup(s.receiving_entity), `source index name ${s.receiving_entity}`);
  const fundsCsv = path.join(releaseRoot, "data/fee-account-figures.csv");
  if (existsSync(fundsCsv)) {
    for (const r of parseCsvObjects(readFileSync(fundsCsv, "utf8")).rows) {
      assert.ok(d.lookup(r.receiving_entity, { type: r.entity_type, county: r.county }), `funds name ${r.receiving_entity}`);
    }
  }
  console.log(`release: ${m.entities.length} names, ${inScope} cities, counties and schools, unmapped: ${unmapped.join("; ") || "none"}`);
}

// Permits tab names (apr/apr.json) resolve to the agency it records.
{
  const apr = JSON.parse(readFileSync(repo("apr/apr.json"), "utf8"));
  const col = Object.fromEntries(apr.jurisdiction_columns.map((c, i) => [c, i]));
  for (const j of apr.jurisdictions) {
    const r = d.lookup(j[col.juris_name], { county: j[col.county] });
    assert.ok(r, `APR ${j[col.juris_name]}`);
    assert.equal(r.name, j[col.agency], `APR ${j[col.juris_name]} is ${j[col.agency]}`);
  }
}

console.log(`districts tests passed: ${records} mapped agencies`);
