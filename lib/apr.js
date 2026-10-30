// Housing Element Annual Progress Report (APR) Table A2 helpers: the rules
// scripts/apr.mjs uses to build apr/apr.json, and the join the Permits tab
// draws from it. Pure functions with no DOM, so tests/apr.test.mjs covers
// them in node.
//
// The join puts each jurisdiction's permitted units for a fiscal year beside
// the fees the release prints for that agency and year. Fees per unit exist
// only where both exist, the year is fully covered by APRs and the fees come
// from one release name. A missing year is missing, never zero.

export const UNIT_CATS = ["SFD", "SFA", "2 to 4", "5+", "ADU", "MH"];
export const CAT_COLUMNS = ["bp_sfd", "bp_sfa", "bp_2to4", "bp_5plus", "bp_adu", "bp_mh"];
export const ROW_COLUMNS = ["j", "fy", "bp_units", "bp_records", "bp_dr", "bp_ndr", ...CAT_COLUMNS,
  "ent_units", "ent_records", "co_units", "co_records"];
export const JURISDICTION_COLUMNS = ["juris_name", "county", "agency", "match", "report_years_mask"];

// ------------------------------------------------------------ dates

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(s) {
  const m = DATE.exec(String(s || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d > last ? null : { y, m: mo, d };
}

// Fiscal years run July 1 to June 30 and are labeled by both calendar years:
// FY 2019-20 starts 2019-07-01.
export function fyLabel(start) {
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function fyOf(date) {
  const p = parseDate(date);
  return p ? fyLabel(p.m >= 7 ? p.y : p.y - 1) : "";
}

// An APR covers one calendar year, so a date after December 31 of that year
// cannot belong to it ("late"). A date before minDate (YYYY-MM-DD) falls in a
// fiscal year no report in the table reaches ("early"). "malformed" is not a
// real YYYY-MM-DD date.
export function dateProblem(date, reportYear, minDate = "") {
  const p = parseDate(date);
  if (!p) return "malformed";
  if (p.y > reportYear) return "late";
  return minDate && date < minDate ? "early" : "";
}

// ------------------------------------------------------------ identifiers

const PLACEHOLDERS = new Set(["", "NA", "NONE", "TBD", "UNKNOWN", "NULL", "PENDING"]);

// Tracking IDs and APNs: uppercase letters and digits only, so formats that
// changed between reports (5629-006-018 and 5629006018) still meet.
// Placeholders and strings of zeros mean no identifier.
export function normId(s) {
  const v = String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return PLACEHOLDERS.has(v) || /^0+$/.test(v) ? "" : v;
}

export const normApn = normId;

// ------------------------------------------------------------ dedupe

// The same project comes back in later reports (a certificate of occupancy
// issues, or the project is listed again), carrying the activity date and
// units an earlier report already counted. For one activity (building
// permit, entitlement or certificate of occupancy), a record is
//   { j, year, cat, id, apn, date, units, sig, ... }
// with id and apn already normalized and sig, when given, identifying the
// whole source row (report year included).
//
// Records with no date, or a date that is not a real date, falls before
// minDate or falls after the report's calendar year, are left out, with one
// exception: a record dated January to June of the next year, with an ID or
// APN, counts when the jurisdiction filed that next report and the next
// report lists neither identifier for this activity (filed(j, year) says
// which reports a jurisdiction filed; by default, those with a record here).
//
// Then, in order:
//   1. Records of one report with the same sig are one source row entered
//      more than once and count once.
//   2. A record's keys are jurisdiction, unit category, activity date and
//      tracking ID, and the same with the APN in place of the ID. A record
//      counts only if its report year is the earliest report year of every
//      key it has: a key's later reports are repeats and are dropped, so the
//      earliest report's units stand. All records of a key in that earliest
//      report count, since one report lists separate units under one ID. A
//      record with neither identifier cannot repeat and counts.
//   3. Later reports also edit the date or the category of a record they
//      repeat. A record dated before its own report year with a tracking ID
//      is dropped when an earlier report lists the same jurisdiction,
//      tracking ID and units under a date in the same or an earlier fiscal
//      year, whatever the category. Both reports must list that ID and
//      units once, since one tract permit number can cover many houses; a
//      single unit record must also have the same APN as the earlier one,
//      or one of them none.
// Records dropped on the APN key while their ID key is new and no earlier
// record on that APN key has the same units may be separate permits; they
// are counted in apn_only_dropped.
export function dedupeActivity(records, { minDate = "", filed = null } = {}) {
  const stats = {
    rows: records.length, undated: 0, undated_units: 0, malformed: 0, late: 0, late_units: 0,
    late_kept: 0, late_kept_units: 0, early: 0, early_units: 0, dated: 0,
    same_report_copies: 0, same_report_copy_units: 0, unkeyed: 0, kept: 0, dropped: 0, dropped_units: 0,
    apn_only_dropped: 0, apn_only_dropped_units: 0, id_units_repeats: 0, id_units_repeat_units: 0, kept_units: 0,
    repeat_keys: 0, more_units_later: 0, fewer_units_later: 0, same_report_repeats: 0,
    kept_before_report_year: 0, kept_before_report_year_units: 0,
  };
  const idKey = (r) => (r.id ? `${r.j}|${r.cat}|${r.date}|i|${r.id}` : "");
  const apnKey = (r) => (r.apn ? `${r.j}|${r.cat}|${r.date}|a|${r.apn}` : "");
  if (!filed) {
    const years = new Set(records.map((r) => `${r.j}|${r.year}`));
    filed = (j, y) => years.has(`${j}|${y}`);
  }
  // Every identifier each report lists for this activity, dated or not.
  const listed = new Set();
  for (const r of records) {
    if (r.id) listed.add(`${r.j}|${r.year}|i|${r.id}`);
    if (r.apn) listed.add(`${r.j}|${r.year}|a|${r.apn}`);
  }
  const lateKept = (r) => {
    const p = parseDate(r.date);
    const next = r.year + 1;
    return p.y === next && p.m <= 6 && Boolean(r.id || r.apn) && filed(r.j, next)
      && !(r.id && listed.has(`${r.j}|${next}|i|${r.id}`)) && !(r.apn && listed.has(`${r.j}|${next}|a|${r.apn}`));
  };
  const valid = [];
  for (const r of records) {
    if (!r.date) {
      stats.undated += 1;
      stats.undated_units += r.units;
      continue;
    }
    const problem = dateProblem(r.date, r.year, minDate);
    if (problem === "late" && lateKept(r)) {
      stats.late_kept += 1;
      stats.late_kept_units += r.units;
    } else if (problem) {
      stats[problem] += 1;
      if (problem !== "malformed") stats[`${problem}_units`] += r.units;
      continue;
    }
    valid.push(r);
  }
  stats.dated = valid.length;

  // 1. One source row entered more than once in a report.
  const sigs = new Set();
  const rows = [];
  for (const r of valid) {
    if (r.sig) {
      if (sigs.has(r.sig)) {
        stats.same_report_copies += 1;
        stats.same_report_copy_units += r.units;
        continue;
      }
      sigs.add(r.sig);
    }
    rows.push(r);
  }

  // 2. Earliest and latest report year of every key.
  const first = new Map();
  const last = new Map();
  const apnUnits = new Map();
  for (const r of rows) {
    for (const k of [idKey(r), apnKey(r)]) {
      if (!k) continue;
      const y = first.get(k);
      if (y === undefined || r.year < y) first.set(k, r.year);
      if (k === idKey(r) && (last.get(k) ?? 0) < r.year) last.set(k, r.year);
    }
    const ka = apnKey(r);
    if (ka) {
      const k = `${ka}|${r.units}`;
      if (!(apnUnits.get(k) <= r.year)) apnUnits.set(k, r.year);
    }
  }

  // 3. Where each (jurisdiction, ID, units) is listed: report year, fiscal
  // year start and APN.
  const fyStart = (date) => {
    const p = parseDate(date);
    return p.m >= 7 ? p.y : p.y - 1;
  };
  const tuKey = (r) => `${r.j}|${r.id}|${r.units}`;
  const listings = new Map();
  const perReport = new Map();
  for (const r of rows) {
    if (!r.id) continue;
    const k = tuKey(r);
    if (!listings.has(k)) listings.set(k, []);
    listings.get(k).push({ year: r.year, fy: fyStart(r.date), apn: r.apn });
    perReport.set(`${k}|${r.year}`, (perReport.get(`${k}|${r.year}`) || 0) + 1);
  }
  const listedEarlier = (r) => {
    const k = tuKey(r);
    const once = (y) => perReport.get(`${k}|${y}`) === 1;
    const fy = fyStart(r.date);
    return once(r.year) && (listings.get(k) || []).some((e) => e.year < r.year && e.fy <= fy && once(e.year)
      && (r.units > 1 || !e.apn || !r.apn || e.apn === r.apn));
  };

  // Units by report year for ID keys seen in more than one report.
  const spread = new Map();
  for (const [k, y] of last) if (y !== first.get(k)) spread.set(k, new Map());
  stats.repeat_keys = spread.size;

  const kept = [];
  const seen = new Set();
  for (const r of rows) {
    const ki = idKey(r);
    const ka = apnKey(r);
    const s = spread.get(ki);
    if (s) s.set(r.year, (s.get(r.year) || 0) + r.units);
    const keep = (!ki || first.get(ki) === r.year) && (!ka || first.get(ka) === r.year);
    if (!keep) {
      stats.dropped += 1;
      stats.dropped_units += r.units;
      if (ki && first.get(ki) === r.year && !(apnUnits.get(`${ka}|${r.units}`) < r.year)) {
        stats.apn_only_dropped += 1;
        stats.apn_only_dropped_units += r.units;
      }
      continue;
    }
    const before = Number(r.date.slice(0, 4)) < r.year;
    if (ki && before && listedEarlier(r)) {
      stats.id_units_repeats += 1;
      stats.id_units_repeat_units += r.units;
      continue;
    }
    if (!ki && !ka) stats.unkeyed += 1;
    if (ki) {
      if (seen.has(ki)) stats.same_report_repeats += 1;
      else seen.add(ki);
    }
    stats.kept_units += r.units;
    if (before) {
      stats.kept_before_report_year += 1;
      stats.kept_before_report_year_units += r.units;
    }
    kept.push(r);
  }
  for (const [k, byYear] of spread) {
    const base = byYear.get(first.get(k)) || 0;
    let more = false;
    let fewer = false;
    for (const [y, u] of byYear) {
      if (y === first.get(k)) continue;
      if (u > base) more = true;
      if (u < base) fewer = true;
    }
    if (more) stats.more_units_later += 1;
    if (fewer) stats.fewer_units_later += 1;
  }
  stats.kept = kept.length;
  return { kept, stats };
}

// ------------------------------------------------------------ coverage

// A jurisdiction's report years are the APR years in which it has at least
// one Table A2 row (bit i of the mask is reportYears[i]). A fiscal year
// spans two calendar years: full when both reports are in hand, partial when
// one is, none otherwise. A year with no rows may be a report listing no
// projects, but the table cannot tell that apart from no report, so it
// counts as missing.
export function fyCoverage(mask, fy, reportYears) {
  const start = Number(String(fy).slice(0, 4));
  const has = (y) => {
    const i = reportYears.indexOf(y);
    return i >= 0 && (mask & (1 << i)) !== 0;
  };
  const n = Number(has(start)) + Number(has(start + 1));
  return n === 2 ? "full" : n === 1 ? "partial" : "none";
}

// ------------------------------------------------------------ names

export function normName(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[-‐-―/]/g, " ")
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SF = "sf|SAN FRANCISCO";

// A roster name ("Adelanto city", "Amador County", "City and County of San
// Francisco") as the keys it answers to. A parenthetical gives the common
// name too: "San Buenaventura (Ventura) city" answers to both.
export function rosterKeys(name) {
  const n = String(name || "").trim();
  if (/^City and County of San Francisco$/i.test(n)) return [SF];
  let m = /^(.+) County$/.exec(n);
  if (m) return [`county|${normName(m[1])}`];
  m = /^(.+) (?:city|town)$/.exec(n);
  if (!m) return [];
  const p = /^(.+?) \((.+)\)$/.exec(m[1]);
  const bases = p ? [m[1], p[1], p[2]] : [m[1]];
  return [...new Set(bases.map((b) => `place|${normName(b)}`))];
}

// Roster agencies ({ name, county }) by key.
export function rosterIndex(agencies) {
  const index = new Map();
  for (const a of agencies) {
    for (const k of rosterKeys(a.name)) {
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(a);
    }
  }
  return index;
}

// HCD spellings of a city the roster spells another way, by normalized APR
// name and county: "CATHEDRAL" in Riverside County is Cathedral City. The
// county must still agree, and a name not listed here is reported, never
// guessed.
export const APR_ALIASES = new Map([
  ["AMADOR|AMADOR", "AMADOR CITY"],
  ["ANGELS CAMP|CALAVERAS", "ANGELS"],
  ["CARMEL|MONTEREY", "CARMEL BY THE SEA"],
  ["CATHEDRAL|RIVERSIDE", "CATHEDRAL CITY"],
  ["SAINT HELENA|NAPA", "ST HELENA"],
]);

// An APR jurisdiction (JURIS_NAME, CNTY_NAME) to one roster agency. A county
// is "X COUNTY"; San Francisco is the city and county; anything else is a
// city or town, under its APR_ALIASES name when it has one. The roster
// agency must also sit in the APR's county. No candidate, a candidate only
// in another county, or more than one candidate is reported, never guessed.
export function matchJurisdiction(juris, county, index) {
  const j = normName(juris);
  const c = normName(county);
  const alias = APR_ALIASES.get(`${j}|${c}`) || "";
  let key;
  if (["SAN FRANCISCO", "SAN FRANCISCO COUNTY", "CITY AND COUNTY OF SAN FRANCISCO"].includes(j)) key = SF;
  else if (j.endsWith(" COUNTY")) key = `county|${j.slice(0, -" COUNTY".length)}`;
  else key = `place|${alias || j}`;
  const cands = index.get(key) || [];
  const here = cands.filter((a) => normName(a.county) === c);
  if (here.length === 1) return { agency: here[0].name, match: alias ? "alias_and_county" : "name_and_county", candidates: [] };
  if (here.length > 1) return { agency: "", match: "ambiguous", candidates: here.map((a) => a.name) };
  if (cands.length) return { agency: "", match: "county_differs", candidates: cands.map((a) => `${a.name} (${a.county})`) };
  return { agency: "", match: "unmatched", candidates: [] };
}

// A release name ("City of Hawthorne", "Hawthorne city", "County of Napa")
// as a roster key, when its entity type agrees with the form of the name.
const PLACE_TYPES = new Set(["city", "town", "incorporated_city_or_town", "city_and_county", ""]);
const COUNTY_TYPES = new Set(["county", "city_and_county", ""]);

export function releaseKey(name, type = "") {
  const n = String(name || "").trim();
  let key = "";
  let m;
  if (/^City (?:and|&) County of San Francisco$/i.test(n)) return SF;
  if ((m = /^(?:City|Town) of (.+)$/i.exec(n))) key = `place|${normName(m[1])}`;
  else if ((m = /^County of (.+)$/i.exec(n))) key = `county|${normName(m[1])}`;
  else if ((m = /^(.+) (?:city|town)$/i.exec(n))) key = `place|${normName(m[1])}`;
  else if ((m = /^(.+) County$/i.exec(n))) key = `county|${normName(m[1])}`;
  if (!key) return "";
  if (key.endsWith("|SAN FRANCISCO")) return SF;
  const ok = key.startsWith("place|") ? PLACE_TYPES.has(type || "") : COUNTY_TYPES.has(type || "");
  return ok ? key : "";
}

// Release entity names by roster key.
export function releaseIndex(entities) {
  const index = new Map();
  for (const e of entities) {
    const k = releaseKey(e.name, e.type);
    if (!k) continue;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(e.name);
  }
  return index;
}

// The release names for one roster agency: the names coverage.json records
// for it, plus release entities whose name has the same key.
export function releaseNamesFor(agency, index) {
  const names = new Set(agency.names || []);
  for (const k of rosterKeys(agency.name)) for (const n of index.get(k) || []) names.add(n);
  return [...names].sort();
}

// The July to June fiscal year a fee figure reports, or "" when it reports
// none. A figure whose recorded start or end falls on other dates is left
// out. A bare year label ("2022") joins only with a recorded June 30 end,
// which names the year ending then (FY 2021-22).
export function feeYear(fig) {
  const start = fig.primary?.fiscal_year_start || "";
  const end = fig.primary?.fiscal_year_end || "";
  if ((start && !/-07-01$/.test(start)) || (end && !/-06-30$/.test(end))) return "";
  if (/^\d{4}-\d{2}$/.test(fig.fy || "")) return fig.fy;
  const m = /^(\d{4})-06-30$/.exec(end);
  return m && fig.fy === m[1] ? fyLabel(Number(m[1]) - 1) : "";
}

// Fees by fiscal year across those names: primary rows with a value only,
// as every sum in the viewer. A year with no such row is missing.
export function agencyFees(names, entityByName) {
  const out = new Map();
  for (const name of names) {
    const e = entityByName.get(name);
    if (!e) continue;
    for (const fig of e.figures) {
      const fy = feeYear(fig);
      if (!fy || !fig.primary?._primary || !Number.isFinite(fig.value)) continue;
      let y = out.get(fy);
      if (!y) out.set(fy, (y = { sum: 0, figures: 0, names: new Set() }));
      y.sum += fig.value;
      y.figures += 1;
      y.names.add(name);
    }
  }
  return out;
}

// ------------------------------------------------------------ apr.json

export function readApr(d) {
  const jc = Object.fromEntries(d.jurisdiction_columns.map((c, i) => [c, i]));
  return {
    ...d,
    jurisdictions: d.jurisdictions.map((r) => ({
      juris: r[jc.juris_name], county: r[jc.county], agency: r[jc.agency], match: r[jc.match], mask: r[jc.report_years_mask],
    })),
    rows: d.rows.map((r) => Object.fromEntries(d.columns.map((c, i) => [c, r[i]]))),
  };
}

// "LA CANADA FLINTRIDGE" -> "La Canada Flintridge", for APR names with no
// roster match.
export function titleCase(s) {
  return String(s || "").toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
}

// One row per jurisdiction and fiscal year: every fiscal year one of its
// reports touches, plus any year a dated activity falls in.
//   apr       readApr(apr.json)
//   agencies  coverage roster agencies ({ name, type, county, names })
//   model     buildModel() result (entities, entityByName)
// A count is 0 only where both reports are in hand and list no such
// activity. Where the year is not fully covered, each activity (permits,
// entitlements, completions) with no record counted is null (missing); one
// with records keeps its count, which for a year with neither report is
// what later reports list.
export function joinPermits(apr, agencies, model) {
  const byName = new Map(agencies.map((a) => [a.name, a]));
  const relIndex = releaseIndex(model.entities);
  const rowsByJ = new Map();
  for (const r of apr.rows) {
    if (!rowsByJ.has(r.j)) rowsByJ.set(r.j, []);
    rowsByJ.get(r.j).push(r);
  }
  const out = [];
  apr.jurisdictions.forEach((jur, j) => {
    const agency = jur.agency ? byName.get(jur.agency) || null : null;
    const names = agency ? releaseNamesFor(agency, relIndex) : [];
    const fees = agencyFees(names, model.entityByName);
    // The release name with the most figures opens the agency.
    const entity = names.map((n) => model.entityByName.get(n)).filter(Boolean)
      .sort((a, b) => b.figures.length - a.figures.length || a.name.localeCompare(b.name))[0]?.name || "";
    const byFy = new Map((rowsByJ.get(j) || []).map((r) => [r.fy, r]));
    const fys = new Set(byFy.keys());
    apr.report_years.forEach((y, i) => {
      if (jur.mask & (1 << i)) {
        fys.add(fyLabel(y - 1));
        fys.add(fyLabel(y));
      }
    });
    for (const fy of [...fys].sort()) {
      const cov = fyCoverage(jur.mask, fy, apr.report_years);
      const r = byFy.get(fy);
      const val = (act, k) => (cov === "full" ? (r ? r[k] : 0) : r && r[`${act}_records`] > 0 ? r[k] : null);
      const f = fees.get(fy);
      const units = val("bp", "bp_units");
      const fee = f ? f.sum : null;
      const feeNames = f ? f.names.size : 0;
      out.push({
        j,
        juris: jur.juris,
        aprCounty: jur.county,
        agency: agency ? agency.name : "",
        name: agency ? agency.name : titleCase(jur.juris),
        type: agency ? agency.type : "",
        county: agency ? agency.county : titleCase(jur.county),
        entity,
        fy,
        cov,
        units,
        records: val("bp", "bp_records"),
        dr: val("bp", "bp_dr"),
        ndr: val("bp", "bp_ndr"),
        cats: CAT_COLUMNS.map((c) => val("bp", c)),
        ent: val("ent", "ent_units"),
        co: val("co", "co_units"),
        fees: fee,
        feeFigures: f ? f.figures : 0,
        feeNames,
        perUnit: cov === "full" && fee != null && feeNames === 1 && units > 0 ? fee / units : null,
      });
    }
  });
  return out;
}

// A tick step of 1, 2 or 5 times a power of ten.
export function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(Math.max(x, 1e-9)));
  const n = x / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
