// Fee taxonomy: the law a fee is charged under, what it pays for (a category
// namespace and a subcategory within it, as Water > Wastewater), and whether
// it applies to the whole agency or only part of it.
//
// The release carries these as fee_law, fee_namespace, fee_subcategory,
// geographic_scope and area_name once its reviewers have tagged a row; a
// tagged value always wins. Until then the viewer places the row in a
// namespace from the release's own fee_category (and, where that is blank or
// "unknown", from words in the fee name, marked as inferred). Law and area
// are never inferred: an untagged row shows them as not yet classified.

export const LAWS = [
  ["mfa", "Mitigation Fee Act"],
  ["mfa-66013", "MFA utility capacity charges (§66013)"],
  ["quimby", "Quimby Act"],
  ["school", "School facilities fees"],
  ["map-act", "Subdivision Map Act"],
  ["dev-agreement", "Development agreement"],
  ["inclusionary", "Inclusionary housing in-lieu"],
  ["regional", "Regional program"],
  ["other", "Other law"],
  ["not-fee", "Not a fee (tax, assessment, service fee)"],
];

export const NAMESPACES = [
  ["water", "Water", [
    ["supply", "Water supply and capacity"], ["wastewater", "Wastewater and sewer"], ["recycled", "Recycled water"],
    ["stormwater", "Stormwater and drainage"], ["flood", "Flood control"], ["groundwater", "Groundwater"]]],
  ["transport", "Transportation", [
    ["streets", "Streets and roads"], ["signals", "Traffic signals"], ["bridges", "Bridges and major thoroughfares"],
    ["transit", "Transit"], ["active", "Bicycle and pedestrian"], ["regional", "Regional transportation"], ["parking", "Parking in-lieu"]]],
  ["parks", "Parks", [
    ["land", "Parkland dedication and in-lieu"], ["development", "Park development"], ["recreation", "Recreation facilities"],
    ["trails", "Trails"], ["open-space", "Open space"]]],
  ["environment", "Environment", [
    ["habitat", "Habitat conservation"], ["agriculture", "Agricultural land"], ["trees", "Trees and oak woodland"],
    ["air", "Air quality"], ["wetlands", "Wetlands"]]],
  ["safety", "Public safety", [
    ["police", "Police"], ["fire", "Fire"], ["ems", "Emergency medical"], ["animal", "Animal services"]]],
  ["civic", "Community facilities", [
    ["libraries", "Libraries"], ["government", "General government"], ["community", "Community centers"],
    ["corp-yard", "Corporation yards"], ["child-care", "Child care"], ["art", "Public art and culture"]]],
  ["schools", "Schools", [
    ["level-1", "Level 1"], ["level-2", "Level 2"], ["level-3", "Level 3"], ["mitigation", "Mitigation agreement"]]],
  ["housing", "Housing", [
    ["inclusionary", "Inclusionary in-lieu"], ["linkage", "Commercial linkage"], ["impact", "Residential housing impact"]]],
  ["utilities", "Utilities", [
    ["undergrounding", "Undergrounding"], ["solid-waste", "Solid waste"], ["broadband", "Broadband"]]],
  ["combined", "Combined", []],
  ["admin", "Administration", [["program", "Fee program administration"], ["studies", "Nexus studies and updates"]]],
  ["other", "Other", []],
];

export const AREAS = [
  ["agency-wide", "Agency-wide"],
  ["area", "Part of the agency"],
  ["regional", "Regional"],
];

export const NOT_CLASSIFIED = "Not yet classified";

const LAW_LABEL = new Map(LAWS);
const AREA_LABEL = new Map(AREAS);
const NS_LABEL = new Map(NAMESPACES.map(([k, l]) => [k, l]));
const SUB_LABEL = new Map(NAMESPACES.flatMap(([k, , subs]) => subs.map(([s, l]) => [`${k}/${s}`, l])));
const NS_ORDER = new Map(NAMESPACES.map(([k], i) => [k, i]));
const SUB_ORDER = new Map(NAMESPACES.flatMap(([k, , subs]) => subs.map(([s], i) => [`${k}/${s}`, i])));

export const lawLabel = (k) => LAW_LABEL.get(k) || (k ? k : NOT_CLASSIFIED);
export const areaLabel = (k) => AREA_LABEL.get(k) || (k ? k : NOT_CLASSIFIED);
export const namespaceLabel = (ns) => NS_LABEL.get(ns) || NOT_CLASSIFIED;

// "water/wastewater" -> "Water › Wastewater and sewer"; "water/" -> "Water".
export function categoryLabel(key) {
  const [ns, sub] = String(key || "").split("/");
  if (!ns) return NOT_CLASSIFIED;
  const sl = sub ? SUB_LABEL.get(`${ns}/${sub}`) || sub : "";
  return sl ? `${namespaceLabel(ns)} › ${sl}` : namespaceLabel(ns);
}

export function subLabel(key) {
  const [ns, sub] = String(key || "").split("/");
  return sub ? SUB_LABEL.get(`${ns}/${sub}`) || sub : "No subcategory";
}

// Sort order: namespaces in the order above, then subcategories in theirs;
// unclassified rows last.
export function categoryRank(key) {
  const [ns, sub] = String(key || "").split("/");
  const a = NS_ORDER.has(ns) ? NS_ORDER.get(ns) : 99;
  const b = sub ? (SUB_ORDER.has(`${ns}/${sub}`) ? SUB_ORDER.get(`${ns}/${sub}`) + 1 : 50) : 0;
  return a * 100 + b;
}

// fee_category codes found in the release, read as namespace/subcategory.
const CATEGORY_CODES = {
  water: "water/supply", water_capacity: "water/supply",
  wastewater: "water/wastewater", sewer: "water/wastewater",
  drainage_stormwater_flood: "water/stormwater", stormwater: "water/stormwater", storm_drainage: "water/stormwater",
  drainage: "water/stormwater", storm_drain: "water/stormwater", drainage_stormwater: "water/stormwater",
  stormwater_drainage: "water/stormwater", stormwater_flood_control: "water/stormwater", flood_control: "water/flood",
  transportation: "transport/", traffic: "transport/streets", streets: "transport/streets", transit: "transport/transit",
  parks_recreation_open_space: "parks/", parks: "parks/", parks_recreation: "parks/", parks_and_recreation: "parks/",
  park_land: "parks/land", quimby: "parks/land", open_space: "parks/open-space", trails: "parks/trails",
  fire_emergency: "safety/fire", fire: "safety/fire", police: "safety/police", law_enforcement: "safety/police",
  police_law_enforcement: "safety/police", public_safety: "safety/", animal_control: "safety/animal",
  libraries: "civic/libraries", library: "civic/libraries", general_public_facilities: "civic/",
  public_facilities: "civic/", public_improvements: "civic/", community_facilities: "civic/community",
  general_government: "civic/government", public_art: "civic/art", child_care: "civic/child-care",
  affordable_housing: "housing/", housing_in_lieu: "housing/", schools: "schools/",
  tree_mitigation: "environment/trees", habitat: "environment/habitat", other: "other/",
};

// Words in a fee name, tried in order, for rows whose category is blank or
// "unknown". The first match wins.
const NAME_RULES = [
  [/recycled/, "water/recycled"], [/sewer|wastewater|sanitar|treatment plant/, "water/wastewater"],
  [/storm|drain|flood/, "water/stormwater"], [/water/, "water/supply"],
  [/traffic|transport|road|street|circulation|thoroughfare|bridge|freeway|interchange|highway/, "transport/"],
  [/transit/, "transport/transit"], [/bicycle|bike|pedestrian/, "transport/active"],
  [/quimby|park ?land|in[- ]lieu park/, "parks/land"], [/park|recreation|open space|trail/, "parks/"],
  [/habitat|hcp|species/, "environment/habitat"], [/tree|oak/, "environment/trees"], [/agricultur/, "environment/agriculture"],
  [/fire/, "safety/fire"], [/police|sheriff|law enforcement/, "safety/police"], [/animal/, "safety/animal"],
  [/librar/, "civic/libraries"], [/art in public|public art|cultural/, "civic/art"], [/child ?care/, "civic/child-care"],
  [/school/, "schools/"], [/housing|inclusionary|linkage/, "housing/"], [/underground/, "utilities/undergrounding"],
  [/solid waste|refuse/, "utilities/solid-waste"], [/general government|city hall|civic center|administrative facilit/, "civic/government"],
  [/community (center|facilit)/, "civic/community"], [/public facilit|capital (facilit|improvement)/, "civic/"],
];

function normalize(code) {
  return String(code || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function validCategory(ns, sub) {
  if (!NS_LABEL.has(ns)) return "";
  return sub && SUB_LABEL.has(`${ns}/${sub}`) ? `${ns}/${sub}` : `${ns}/`;
}

// The taxonomy of one release row. cat is "namespace/subcategory" (the
// subcategory may be empty); catInferred is true when it was read from the
// fee name rather than recorded.
export function classifyRow(r) {
  let cat = "";
  let catInferred = false;
  if (r.fee_namespace) cat = validCategory(normalize(r.fee_namespace).replace(/_/g, "-"), normalize(r.fee_subcategory).replace(/_/g, "-"));
  if (!cat) {
    const code = normalize(r.fee_category);
    cat = CATEGORY_CODES[code] || "";
    if (!cat && code && code !== "unknown") cat = nameRule(code.replace(/_/g, " "));
    if (!cat) {
      cat = nameRule(String(r.fee_program || "").toLowerCase());
      catInferred = Boolean(cat);
    }
  }
  const law = r.fee_law ? normalize(r.fee_law).replace(/_/g, "-") : "";
  const area = r.geographic_scope ? normalize(r.geographic_scope).replace(/_/g, "-") : "";
  return { cat, catInferred, law, area, areaName: (r.area_name || "").trim() };
}

function nameRule(text) {
  for (const [re, cat] of NAME_RULES) if (re.test(text)) return cat;
  return "";
}

// Older links used a release fee_category code in cat=; read those as their
// taxonomy key so they keep working.
export function categoryParam(v) {
  if (!v || v === "__none") return v;
  const [ns] = v.split("/");
  if (NS_LABEL.has(ns)) return v.includes("/") ? v : ns;
  const mapped = CATEGORY_CODES[normalize(v)];
  return mapped ? mapped.replace(/\/$/, "") : v;
}

// A category filter value holds namespaces ("water") and subcategories
// ("water/stormwater", or "water/" for rows with no subcategory).
export function categoryMatches(wanted, key) {
  if (!key) return wanted.has("__none");
  const [ns] = key.split("/");
  return wanted.has(ns) || wanted.has(key);
}

// Every namespace and subcategory, in display order, for building a filter
// tree; counts come from the figures.
export function categoryTree(counts) {
  const out = [];
  for (const [ns, label, subs] of NAMESPACES) {
    const children = [];
    for (const [s, sl] of subs) {
      const k = `${ns}/${s}`;
      if (counts.get(k)) children.push({ value: k, label: sl, count: counts.get(k) });
    }
    const bare = counts.get(`${ns}/`) || 0;
    const total = bare + children.reduce((n, c) => n + c.count, 0);
    if (!total) continue;
    if (bare && children.length) children.push({ value: `${ns}/`, label: "No subcategory", count: bare });
    out.push({ value: ns, label, count: total, children });
  }
  if (counts.get("")) out.push({ value: "__none", label: NOT_CLASSIFIED, count: counts.get(""), children: [] });
  return out;
}
