import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import snapshot_io  # noqa: E402
from reconcile_compare import (  # noqa: E402
    STATUS_DOC_IN_DB_ONLY, collect_window, compare_classification, compare_titles, explain, render_markdown,
    summarize_site,
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

    def test_documented_in_db_only_is_a_gap_with_unverified_origin(self):
        db = {1: self.cls(status="מיובא ומתועד")}
        changes = compare_classification({1: self.cls()}, db)
        self.assertEqual(list(changes), [STATUS_DOC_IN_DB_ONLY])
        site = summarize_site("mechalol", 1, 1, compare_titles({1: "א"}, {1: "א"}), changes, set(), set(),
                              source_titles={1: "א"})
        info = site["classes"][STATUS_DOC_IN_DB_ONLY]
        self.assertTrue(info["origin_unverified"])
        self.assertEqual(info["unexplained"], 1)
        self.assertEqual(site["unexplained_findings"], 1)  # נספר בסך הפערים, לא מוחרג כקידום

    def test_reverse_direction_is_real_status_change(self):
        db = {1: self.cls()}
        changes = compare_classification({1: self.cls(status="מיובא ומתועד")}, db)
        self.assertEqual(list(changes), ["status"])


class FakeApi:
    """api_get מדומה: מחזיר את האירועים לפי list ומתעלם מ-continue."""

    def __init__(self, rc=(), moves=(), deletes=()):
        self.calls = []
        self.data = {"recentchanges": list(rc), "move": list(moves), "delete": list(deletes)}

    def __call__(self, params):
        self.calls.append(params)
        if params["list"] == "recentchanges":
            return {"query": {"recentchanges": self.data["recentchanges"]}}
        return {"query": {"logevents": self.data[params["letype"]]}}


class CollectWindowTests(unittest.TestCase):
    SINCE, UNTIL = "2026-10-04T10:00:00Z", "2026-10-04T12:00:00Z"

    def test_closed_window_enforced_in_request_and_results(self):
        api = FakeApi(rc=[
            {"pageid": 1, "title": "בתוך", "timestamp": "2026-10-04T11:00:00Z"},
            {"pageid": 2, "title": "אחרי הסגירה", "timestamp": "2026-10-04T12:00:01Z"},
        ])
        ids, titles, counts = collect_window(api, self.SINCE, self.UNTIL)
        self.assertEqual(ids, {1})
        self.assertEqual(titles, {"בתוך"})
        self.assertEqual(counts["edit_new"], 1)
        rc = api.calls[0]
        self.assertEqual((rc["rcstart"], rc["rcend"]), (self.SINCE, self.UNTIL))
        logs = [c for c in api.calls if c["list"] == "logevents"]
        self.assertTrue(logs and all(c["leend"] == self.UNTIL and c["lestart"] == self.SINCE for c in logs))

    def test_moves_deletes_and_restores_included(self):
        api = FakeApi(
            moves=[{"logpage": 5, "title": "ישן", "timestamp": "2026-10-04T11:00:00Z",
                    "params": {"target_title": "חדש"}}],
            deletes=[{"logpage": 6, "title": "נמחק", "timestamp": "2026-10-04T11:30:00Z"},
                     {"logpage": 9, "title": "מאוחר", "timestamp": "2026-10-04T13:00:00Z"}],
        )
        ids, titles, counts = collect_window(api, self.SINCE, self.UNTIL)
        self.assertEqual(ids, {5, 6})
        self.assertEqual(titles, {"ישן", "חדש", "נמחק"})
        self.assertEqual((counts["move"], counts["delete"]), (1, 1))

    def test_rename_in_window_is_explained(self):
        api = FakeApi(moves=[{"logpage": 5, "title": "ישן", "timestamp": "2026-10-04T11:00:00Z",
                              "params": {"target_title": "חדש"}}])
        ids, titles, _ = collect_window(api, self.SINCE, self.UNTIL)
        diff = compare_titles({5: "חדש"}, {5: "ישן"})
        site = summarize_site("wikipedia", 1, 1, diff, {}, ids, titles, source_titles={5: "חדש"})
        self.assertEqual(site["classes"]["title"]["explained_by_window"], 1)
        self.assertEqual(site["unexplained_findings"], 0)


class WindowGuardTests(unittest.TestCase):
    def test_inverted_window_is_rejected(self):
        with self.assertRaises(ValueError):
            collect_window(FakeApi(), "2026-10-05T10:00:00Z", "2026-10-04T12:00:00Z")


class UniquePagesTests(unittest.TestCase):
    def test_page_with_two_changed_fields_counts_once_in_pages(self):
        cls = {"status": "מיובא ללא תיעוד", "source_type": "missing_sort", "needs_attention": False, "is_dictionary_entry": False}
        new = {**cls, "status": "מיובא ומתועד", "source_type": "wikipedia_documented"}
        changes = compare_classification({1: new, 2: new}, {1: cls, 2: cls})
        site = summarize_site("mechalol", 2, 2, compare_titles({1: "א", 2: "ב"}, {1: "א", 2: "ב"}), changes,
                              {2}, set(), source_titles={1: "א", 2: "ב"})
        self.assertEqual(site["unexplained_findings"], 2)  # id=1: status + source_type
        self.assertEqual(site["unexplained_pages"], 1)     # ערך ייחודי אחד (id=2 הוסבר בחלון)
        self.assertIn("ייחודיים", render_markdown({"run_id": "r", "snapshot": {}, "sites": [site]}))


class SnapshotIoTests(unittest.TestCase):
    def test_roundtrip_converts_ids_to_int_and_batches(self):
        import tempfile
        snap = {"run_id": "r", "wikipedia": {"pages": {3: "ג", 1: "א", 2: "ב"}},
                "mechalol": {"pages": {7: "ז"}, "classification": {7: {"status": "x"}}}}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.json.gz")
            snapshot_io.save(path, snap)
            loaded = snapshot_io.load(path)
        self.assertEqual(loaded["wikipedia"]["pages"], {1: "א", 2: "ב", 3: "ג"})
        self.assertEqual(loaded["mechalol"]["classification"], {7: {"status": "x"}})
        batches = list(snapshot_io.wikipedia_batches(loaded, 2))
        self.assertEqual([len(b) for b in batches], [2, 1])
        self.assertEqual(batches[0][0], {"id": 1, "title": "א"})
        self.assertEqual(list(snapshot_io.mechalol_batches(loaded, 10)), [[("ז", 7)]])


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
