# visibility: public
import csv, importlib.util, json, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("build_browse", ROOT / "scripts/build-browse.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

class Projections(unittest.TestCase):
    def setUp(self):
        staging = ROOT / ".qa-tmp"
        staging.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=staging)
        self.repo = Path(self.temp.name)
        self.rows = [{"record_id": "r" + str(i), "figure_group_id": "group" + str(i), "is_primary_in_figure_group": "true", "receiving_entity": "Example City", "entity_type": "city", "county": "Example", "fiscal_year": "2020-21", "fee_program": "Road", "physical_pdf_page": "1", "printed_page": "1", "source_id": "report", "measure_as_printed": "Fees Collected", "value_usd": str(i + 1), "source_value_text": "Original printed value " + str(i), "arithmetic_check": "", "source_limitations": "", "unknown_future_column": "Full source excerpt", "outlined_figure_pdf": "evidence/report.pdf"} for i in range(6)]
        self.rows[0]["figure_group_id"] = "unsafe / group"
        self.rows[0]["measure_as_printed"] = "Collected $1,234.00"
        self.rows[1]["measure_as_printed"] = "Long source sentence " * 30
        self.rows[5]["receiving_entity"] = "Small City"
        self.rows[5]["is_primary_in_figure_group"] = "false"
        self.sources = [{"source_id": "report", "receiving_entity": entity, "publication_title": "Report", "publication_type": "annual", "covers_fiscal_year": "2020-21", "physical_page_count": "1", "source_bytes": "100", "source_url": "https://example.test/full-report.pdf", "source_limitations": "Full original note"} for entity in ("Example City", "Small City")]
        for rel, rows in (("data/reported-fee-collections.csv", self.rows), ("sources/index.csv", self.sources)):
            p = self.repo / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            with p.open("w", encoding="utf8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0]))
                w.writeheader(); w.writerows(rows)
        (self.repo / "evidence").mkdir()
        (self.repo / "evidence/index.json").write_text(json.dumps([{"outlined_figure_pdf": "evidence/report.pdf", "outlined_figure_sha256": "a" * 64}]), encoding="utf8")

    def tearDown(self):
        self.temp.cleanup()

    def test_browse_whitelist_and_exact_individual_inputs(self):
        builder.generate(self.repo)
        browse = json.loads((self.repo / "browse.json").read_text(encoding="utf8"))
        self.assertEqual(browse["rows"][0]["measure_as_printed"], "Figure")
        self.assertEqual(browse["rows"][1]["measure_as_printed"], "Figure")
        self.assertNotIn("value_usd", browse["rows"][0])
        self.assertNotIn("unknown_future_column", browse["rows"][0])
        self.assertNotIn("source_url", browse["sources"][0])
        self.assertEqual(len(browse["sources"]), 2)
        self.assertEqual(browse["aggregates"]["entities"], [{"name": "Example City", "sum": 15.0}, {"name": "Small City", "sum": None}])
        self.assertEqual(browse["aggregates"]["total"], 15.0)
        detail = json.loads((self.repo / "figures" / (browse["rows"][0]["_detailId"] + ".json")).read_text(encoding="utf8"))
        self.assertEqual(detail["rows"], [self.rows[0]])
        self.assertEqual(detail["sources"], self.sources)
        self.assertEqual(detail["hashes"], [{"path": "evidence/report.pdf", "sha256": "a" * 64}])
        self.assertEqual(json.loads((self.repo / "source-records/report.json").read_text()), self.sources[-1])
        builder.verify(self.repo)
        (self.repo / "browse.json").write_bytes(b"{}")
        with self.assertRaises(AssertionError):
            builder.verify(self.repo)

    def test_withdrawn_record_tombstone(self):
        (self.repo / "figures").mkdir()
        (self.repo / "figures/withdrawn.json").write_text('{"value_usd":"1234"}')
        builder.generate(self.repo)
        self.assertEqual((self.repo / "figures/withdrawn.json").read_bytes(), b"null\n")
        builder.verify(self.repo)

if __name__ == "__main__":
    unittest.main()
