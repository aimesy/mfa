# visibility: public
"""Build and exactly verify projections of already published MFA records."""
from pathlib import Path
from collections import defaultdict
import csv, hashlib, json, re, sys

FIGURE_FIELDS = "record_id figure_group_id is_primary_in_figure_group receiving_entity entity_type county fiscal_year fee_program fee_category measure_as_printed physical_pdf_page printed_page source_id publication_title land_use_scope".split()
SOURCE_FIELDS = "source_id receiving_entity publication_title publication_type covers_fiscal_year physical_page_count source_bytes".split()
IDENTIFIER = re.compile(r"^[A-Za-z0-9._-]{1,200}$")
PRIVATE = re.compile(rb"(?i)(?:[A-Z]:[/\\](?:Users|mfa-sources|Windows)|work[/\\]private|\.sensitive|BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY|(?:github_pat_|ghp_)[A-Za-z0-9_]{15,}|non-public:private|archive-internal|ssh-config|\bNew User\b|AfterQuery|Amybot)")
LABEL_LIMITS = {"receiving_entity": 160, "entity_type": 60, "county": 60, "fiscal_year": 20, "fee_program": 180, "fee_category": 120, "measure_as_printed": 100, "printed_page": 20, "publication_title": 200, "publication_type": 60, "covers_fiscal_year": 20, "land_use_scope": 120}
AMOUNT_LABEL = re.compile(r"\$\s*\d|\d,\d{3}|\d+\.\d{2}\b")

def metadata(record, fields):
    result = {}
    for key in fields:
        value = record.get(key, "")
        if key in LABEL_LIMITS:
            limit = LABEL_LIMITS[key]
            if len(value) > limit or "\n" in value or "\r" in value:
                value = "Figure" if key == "measure_as_printed" else value.splitlines()[0][:limit - 1] + "…"
            if key == "measure_as_printed" and AMOUNT_LABEL.search(value):
                value = "Figure"
        elif key in ("physical_pdf_page", "physical_page_count", "source_bytes"):
            value = value if re.fullmatch(r"\d{1,12}", value) else ""
        elif key in ("record_id", "figure_group_id", "source_id"):
            assert len(value) <= 200 and not re.search(r"[\r\n\x00]", value)
        elif key == "is_primary_in_figure_group":
            value = value if value in ("true", "false") else ""
        result[key] = value
    return result

def read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        return reader.fieldnames, list(reader)

def encoded(obj):
    return (json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf8")

def outputs(repo):
    columns, rows = read_csv(repo / "data/reported-fee-collections.csv")
    _, sources = read_csv(repo / "sources/index.csv")
    evidence = json.loads((repo / "evidence/index.json").read_text(encoding="utf-8-sig"))
    groups = defaultdict(list)
    # Combined source files may be listed for several receiving entities. Match
    # the viewer's existing sourceById Map while retaining every row in browsing.
    by_source = {s["source_id"]: s for s in sources}
    hashes = {}
    for e in evidence:
        for prefix in ("outlined_figure", "page_extract"):
            path, digest = e.get(prefix + "_pdf"), e.get(prefix + "_sha256")
            if path and re.fullmatch(r"[0-9a-f]{64}", digest or ""):
                assert path not in hashes or hashes[path] == digest
                hashes[path] = digest
    for row in rows:
        ident = row["figure_group_id"] or row["record_id"]
        assert ident and len(ident) <= 200
        groups[ident].append(row)
    detail_ids = {ident: ident if IDENTIFIER.fullmatch(ident) and ".." not in ident else "encoded-" + hashlib.sha256(ident.encode("utf8")).hexdigest() for ident in groups}
    assert len(set(detail_ids.values())) == len(groups), "Projected identifier collision"
    figures = []
    for ident, rs in groups.items():
        primary = next((r for r in rs if r["is_primary_in_figure_group"] == "true"), rs[0])
        figures.append((ident, primary))
    entities, names, years = defaultdict(list), defaultdict(list), defaultdict(list)
    for ident, r in figures:
        entities[r["receiving_entity"]].append(r)
        names[(r["receiving_entity"], r["fee_program"])].append(r)
        if r["fiscal_year"]:
            years[r["fiscal_year"]].append(r)
    parents = {k: k for k in names}
    def find(k):
        while parents[k] != k:
            k = parents[k]
        return k
    links = json.loads(Path(__file__).with_name("browse-fee-links.json").read_text(encoding="utf8"))
    for entity, old, new, *_ in links:
        a, b = (entity, old), (entity, new)
        if a in parents and b in parents:
            parents[find(a)] = find(b)
    fees = defaultdict(list)
    for k, rs in names.items():
        fees[find(k)].extend(rs)
    def amount(rs):
        return sum(float(r["value_usd"]) for r in rs if r["is_primary_in_figure_group"] == "true" and r["value_usd"])
    def aggregate(rs):
        return amount(rs) if len(rs) >= 5 else None
    fee_sums = []
    for rs in fees.values():
        rs.sort(key=lambda r: (r["fiscal_year"], int(r["physical_pdf_page"] or 0)))
        last = rs[-1]
        labels = metadata(last, ("receiving_entity", "fee_program"))
        fee_sums.append({"id": labels["receiving_entity"] + "\n" + labels["fee_program"], "sum": aggregate(rs)})
    def collision_safe(entries, key):
        counts = defaultdict(int)
        for entry in entries:
            counts[entry[key]] += 1
        return [{**e, "sum": e["sum"] if counts[e[key]] == 1 else None} for e in entries]
    browse = {
        "schema": 1, "rowCount": len(rows),
        "rows": [{**metadata(r, FIGURE_FIELDS), "_detailId": detail_ids[r["figure_group_id"] or r["record_id"]], "_summary": True, "_summary_arith": bool(r.get("arithmetic_check", "").strip()), "_summary_thousands": r.get("source_limitations", "").startswith("Amounts are expressed in whole thousands.")} for r in rows],
        "sources": [{**metadata(s, SOURCE_FIELDS), "_summary": True} for s in sources],
        "aggregates": {"total": aggregate([r for _, r in figures]), "entities": collision_safe([{"name": metadata({"receiving_entity": e}, ("receiving_entity",))["receiving_entity"], "sum": aggregate(rs)} for e, rs in entities.items()], "name"), "fees": collision_safe(fee_sums, "id"), "years": collision_safe([{"fy": metadata({"fiscal_year": fy}, ("fiscal_year",))["fiscal_year"], "figures": len(rs), "entities": len({r["receiving_entity"] for r in rs}), "sum": aggregate(rs)} for fy, rs in sorted(years.items())], "fy")},
    }
    result = {"browse.json": browse}
    for ident, rs in groups.items():
        source_ids = {r["source_id"] for r in rs}
        paths = {r.get(k) for r in rs for k in ("outlined_figure_pdf", "page_extract_pdf")}
        result[f"figures/{detail_ids[ident]}.json"] = {"columns": columns, "rows": rs, "sources": [s for s in sources if s["source_id"] in source_ids], "hashes": [{"path": p, "sha256": hashes[p]} for p in sorted(paths - {None, ""}) if p in hashes]}
    for ident, s in by_source.items():
        assert IDENTIFIER.fullmatch(ident) and ".." not in ident
        result[f"source-records/{ident}.json"] = s
    # Withdrawn projected records become explicit tombstones, preserving the
    # original files/history while ensuring they expose no obsolete amount.
    for directory in ("figures", "source-records"):
        for p in (repo / directory).glob("*.json"):
            rel = p.relative_to(repo).as_posix()
            if rel not in result:
                result[rel] = None
    return result

def generate(repo):
    result = outputs(repo)
    for rel, value in result.items():
        payload = encoded(value)
        assert not PRIVATE.search(payload), "Private material in projection: " + rel
        path = repo / rel
        if path.exists() and path.read_bytes() == payload:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".json.new")
        temp.write_bytes(payload)
        temp.replace(path)
    return verify(repo)

def verify(repo):
    result = outputs(repo)
    assert set(p.relative_to(repo).as_posix() for d in ("figures", "source-records") for p in (repo/d).glob("*.json")) == set(result) - {"browse.json"}
    for rel, value in result.items():
        payload = encoded(value)
        assert not PRIVATE.search(payload), rel
        assert (repo / rel).read_bytes() == payload, "Projection differs from published input: " + rel
    return sorted(result)

if __name__ == "__main__":
    repo = Path(sys.argv[1]).resolve()
    paths = verify(repo) if "--verify" in sys.argv[2:] else generate(repo)
    print(json.dumps({"schema": 1, "projected_files": len(paths), "passed": True}))
