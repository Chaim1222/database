import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import verify_locked_pages as v  # noqa: E402


def info(allevel, missing=False, pageid=None):
    return {"allevel": allevel, "missing": missing, "pageid": pageid}


class VerdictTest(unittest.TestCase):
    def test_still_locked(self):
        self.assertEqual(v.verdict("read_locked", info("read", pageid=5)), "still_locked")
        self.assertEqual(v.verdict("create_locked", info("create", missing=True)), "still_locked")

    def test_lock_lifted(self):
        self.assertEqual(v.verdict("read_locked", info("none", pageid=5)), "open_now")
        self.assertEqual(v.verdict("create_locked", info("none", missing=True)), "open_now")

    def test_other_level_and_not_returned(self):
        # נעול ליצירה שהפך לנעול לקריאה = הדף נוצר; רמה לא מוכרת לא נחשבת "פתוח"
        self.assertEqual(v.verdict("create_locked", info("read", pageid=9)), "other:read_locked")
        self.assertEqual(v.verdict("read_locked", info("weird")), "other:unknown")
        self.assertEqual(v.verdict("read_locked", None), "not_returned")

    def test_summarize(self):
        self.assertEqual(v.summarize(["still_locked", "open_now", "still_locked"]), {"still_locked": 2, "open_now": 1})


class FakeClient:
    """מחזיר דפי שורות לפי הסדר; מתעלם משרשרת הסינון."""

    def __init__(self, rows):
        self.rows = rows


class CheckTest(unittest.TestCase):
    def test_read_locked_maps_results_by_page_id_and_respects_limit(self):
        rows = [{"id": 1, "title": "א"}, {"id": 2, "title": "ב"}, {"id": 3, "title": "ג"}]
        original_read, original_fetch = v.read_all, v.fetch_page_lock_info
        calls = []
        v.read_all = lambda client, build, label: rows
        v.fetch_page_lock_info = lambda pageids=None, titles=None: calls.append(pageids) or {
            "א": info("read", pageid=1), "ב": info("none", pageid=2)}   # ג לא הוחזר
        try:
            out = v.check_read_locked(None, None)
            limited = v.check_read_locked(None, 2)
        finally:
            v.read_all, v.fetch_page_lock_info = original_read, original_fetch
        self.assertEqual([r["verdict"] for r in out], ["still_locked", "open_now", "not_returned"])
        self.assertEqual(calls, [[1, 2, 3], [1, 2]])
        self.assertEqual(len(limited), 2)

    def test_create_locked_uses_titles(self):
        original_read, original_fetch = v.read_all, v.fetch_page_lock_info
        v.read_all = lambda client, build, label: [{"id": 7, "title": "כותרת"}, {"id": 8, "title": "אחרת"}]
        v.fetch_page_lock_info = lambda pageids=None, titles=None: {"כותרת": info("create", missing=True), "אחרת": info("none", missing=True)}
        try:
            out = v.check_create_locked(None, None)
        finally:
            v.read_all, v.fetch_page_lock_info = original_read, original_fetch
        self.assertEqual([r["verdict"] for r in out], ["still_locked", "open_now"])


if __name__ == "__main__":
    unittest.main()
