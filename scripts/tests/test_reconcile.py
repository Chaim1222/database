import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from reconcile_compare import (  # noqa: E402
    PROMOTED_BY_MATCH, compare_classification, compare_titles, explain, render_markdown, summarize_site,
)


class CompareTitlesTests(unittest.TestCase):
    def test_create_delete_rename(self):
        source = {1: "א", 2: "ב חדש", 4: "ד"}
        db = {1: "א", 2: "ב", 3: "ג"}
        diff = compare_titles(source, db)
        self.assertEqual(diff["only_source"], [(4, "ד")])
        self.assertEqual(diff["only_db"], [(3, "ג")])
        self.assertEqual(diff["title"], [(2, "ב", "ב חדש")])

    def test_identical(self):
        diff = compare_titles({1: "א"}, {1: "א"})
        self.assertEqual(diff, {"only_source": [], "only_db": [], "title": []})


class CompareClassificationTests(unittest.TestCase):
    def cls(self, **kw):
        base = {"status": "מיובא ללא תיעוד", "source_type": "unknown", "needs_attention": False, "is_dictionary_entry": False}
        return {**base, **kw}

    def test_only_shared_ids_compared(self):
        changes = compare_classification({1: self.cls(), 2: self.cls()}, {1: self.cls(source_type="missing_sort")})
        self.assertEqual(changes, {"source_type": [(1, "missing_sort", "unknown")]})

    def test_promotion_by_match_reported_separately(self):
        db = {1: self.cls(status="מיובא ומתועד")}
        changes = compare_classification({1: self.cls()}, db)
        self.assertEqual(list(changes), [PROMOTED_BY_MATCH])

    def test_reverse_direction_is_real_status_change(self):
        db = {1: self.cls()}
        changes = compare_classification({1: self.cls(status="מיובא ומתועד")}, db)
        self.assertEqual(list(changes), ["status"])


class ExplainTests(unittest.TestCase):
    def test_by_id_or_title(self):
        explained, unexplained = explain([(1, "א"), (2, "ב"), (3, None)], {1}, {"ב"})
        self.assertEqual([i for i, _ in explained], [1, 2])
        self.assertEqual([i for i, _ in unexplained], [3])


class SummarizeTests(unittest.TestCase):
    def test_counts_and_delete_rate(self):
        diff = compare_titles({1: "א", 5: "ה"}, {1: "א", 3: "ג"})
        site = summarize_site("mechalol", 2, 2, diff, {}, {5}, set(), source_titles={1: "א", 5: "ה"})
        self.assertEqual(site["classes"]["only_source"]["explained_by_window"], 1)
        self.assertEqual(site["classes"]["only_db"]["unexplained"], 1)
        self.assertEqual(site["delete_rate"]["n"], 1)
        self.assertTrue(site["delete_rate"]["would_exceed_provisional_gate"])  # 1/2 > 0.1%

    def test_markdown_renders(self):
        diff = compare_titles({1: "א"}, {1: "א"})
        report = {"run_id": "r", "snapshot": {"k": "v"}, "sites": [summarize_site("wikipedia", 1, 1, diff, {}, set(), set())]}
        text = render_markdown(report)
        self.assertIn("wikipedia", text)
        self.assertIn("לא מוכיח", text)


class ReadOnlyGuardTests(unittest.TestCase):
    def test_reconcile_does_not_write(self):
        path = os.path.join(os.path.dirname(__file__), "..", "reconcile.py")
        with open(path, encoding="utf-8") as fh:
            code = fh.read()
        code = re.sub(r'""".*?"""', "", code, flags=re.S)  # בלי docstrings
        for forbidden in (".insert(", ".upsert(", ".update(", ".delete(", ".rpc("):
            self.assertNotIn(forbidden, code, forbidden)


if __name__ == "__main__":
    unittest.main()
