// California Assembly and Senate districts for each agency, from
// legislative/districts.json (built by scripts/legislative.py). Pure, with no
// DOM, so tests/districts.test.mjs covers it in node.
//
// An agency is listed under every district its territory reaches, even by a
// small part, so lists overlap and district totals double count. share is the
// fraction of the agency's 2020 residents in the district (null when it has
// none); a district under 1% of residents is an edge contact. Lookups are by
// exact name: the build resolves every spelling the viewer meets.

export const DISTRICTS_URL = "legislative/districts.json";

const COLUMNS = ["name", "type", "county", "class", "basis", "note", "ad", "sd", "release", "roster"];
const BASES = ["boundary", "district_boundary", "same_as", "approximate", "unmapped"];
const SEATS = { ad: 80, sd: 40 };
const LABEL = { ad: "Assembly District", sd: "Senate District" };
const EDGE = 0.01;

function fail(msg) {
  throw new Error(`districts.json: ${msg}`);
}

function splitCounties(c) {
  return String(c || "").split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

// [n, share permille or null, area permille, ...] to district entries.
function districtList(flat, where) {
  if (!Array.isArray(flat) || flat.length % 3) fail(`${where} is not a flat list of triples`);
  const out = [];
  for (let i = 0; i < flat.length; i += 3) {
    const [n, s, a] = flat.slice(i, i + 3);
    if (!Number.isInteger(n) || (s !== null && !Number.isInteger(s)) || !Number.isInteger(a)) fail(`${where} has a bad entry`);
    const share = s === null ? null : s / 1000;
    out.push(Object.freeze({ n, share, area_share: a / 1000, edge: share === null || share < EDGE }));
  }
  return Object.freeze(out);
}

export function indexDistricts(json) {
  if (!json || typeof json !== "object") fail("not an object");
  const { meta, counties, types, classes, bases, notes, chambers, columns, agencies, aliases } = json;
  if (!meta || typeof meta.caveat !== "string" || typeof meta.plan !== "string") fail("meta is missing");
  if (!Array.isArray(counties) || !Array.isArray(types) || !Array.isArray(classes) || !Array.isArray(notes)) fail("lookup tables are missing");
  if (JSON.stringify(columns) !== JSON.stringify(COLUMNS)) fail("unexpected columns");
  if (JSON.stringify(bases) !== JSON.stringify(BASES)) fail("unexpected bases");
  if (!Array.isArray(agencies) || !aliases || typeof aliases !== "object") fail("agencies are missing");

  const outChambers = {};
  for (const ch of Object.keys(SEATS)) {
    const rows = chambers?.[ch];
    if (!Array.isArray(rows) || rows.length !== SEATS[ch]) fail(`${ch} must list ${SEATS[ch]} districts`);
    outChambers[ch] = Object.freeze(rows.map(([n, cs], i) => {
      if (n !== i + 1) fail(`${ch} districts are out of order`);
      return Object.freeze({ n, label: `${LABEL[ch]} ${n}`, counties: Object.freeze(cs.map((c) => counties[c])) });
    }));
  }
  Object.freeze(outChambers);

  const records = agencies.map((row, i) => {
    if (!Array.isArray(row) || row.length !== COLUMNS.length) fail(`agency ${i} has the wrong width`);
    const [name, t, c, cl, b, note, ad, sd] = row;
    const rec = {
      key: `${name}|${types[t]}|${counties[c]}`,
      name,
      type: types[t],
      county: counties[c],
      class: classes[cl],
      basis: BASES[b],
      basis_note: note >= 0 ? notes[note] : "",
      ad: districtList(ad, `${name} ad`),
      sd: districtList(sd, `${name} sd`),
    };
    if (typeof name !== "string" || rec.type === undefined || rec.county === undefined || !rec.class || !rec.basis) {
      fail(`agency ${i} has a bad lookup index`);
    }
    return Object.freeze(rec);
  });

  // Every name a record answers to: its own, the release's, and the aliases.
  const byName = new Map();
  const add = (n, i) => {
    const l = byName.get(n);
    if (!l) byName.set(n, [i]);
    else if (!l.includes(i)) l.push(i);
  };
  agencies.forEach((row, i) => {
    add(row[0], i);
    for (const n of row[8]) add(n, i);
  });
  for (const [n, v] of Object.entries(aliases)) {
    for (const i of Array.isArray(v) ? v : [v]) {
      if (!records[i]) fail(`alias ${n} points nowhere`);
      add(n, i);
    }
  }

  // Several records can share a name (roster rows in two counties); type
  // then county settle it, and a tie stays unresolved. A county the caller
  // names must overlap the record's even when one record has the name, so an
  // agency the build did not map never takes a namesake's districts.
  function lookup(name, { type, county } = {}) {
    let c = (byName.get(name) || []).map((i) => records[i]);
    if (c.length > 1 && type) {
      const t = c.filter((r) => r.type === type);
      if (t.length) c = t;
    }
    const want = splitCounties(county);
    const inCounty = (r) => {
      const has = splitCounties(r.county);
      return !want.length || !has.length || has.some((x) => want.includes(x));
    };
    if (c.length > 1 && want.length) {
      const k = c.filter(inCounty);
      if (k.length) c = k;
    }
    return c.length === 1 && inCounty(c[0]) ? c[0] : null;
  }

  function districtKeys(name, opts) {
    const r = lookup(name, opts);
    if (!r || r.basis === "unmapped") return null;
    return { ad: r.ad.map((d) => String(d.n)), sd: r.sd.map((d) => String(d.n)) };
  }

  const mapped = Object.freeze(records.filter((r) => r.basis !== "unmapped"));
  return Object.freeze({ meta: Object.freeze({ ...meta }), chambers: outChambers, lookup, districtKeys, agencies: () => mapped });
}

let memo = null;

// fetchJson(url) is the caller's loader. A failed load is forgotten so the
// next call tries again.
export function loadDistricts(fetchJson) {
  if (memo) return memo;
  const p = Promise.resolve().then(() => fetchJson(DISTRICTS_URL)).then(indexDistricts);
  memo = p;
  p.catch(() => {
    if (memo === p) memo = null;
  });
  return p;
}
