import os
import sys
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import match  # noqa: E402
import fetch_wikipedia_revisions  # noqa: E402


class FakeQuery:
    def __init__(self, client, name):
        self.client, self.name = client, name

    def upsert(self, rows, on_conflict=None):
        self.client.upserts.extend(rows)
        return self

    def execute(self):
        return mock.Mock(data=[])


class FakeClient:
    def __init__(self):
        self.upserts = []
        self.rpcs = []

    def table(self, name):
        return FakeQuery(self, name)

    def rpc(self, name, params=None):
        self.rpcs.append(name)
        return FakeQuery(self, name)


def mrow(mid, title, rev, **extra):
    base = {"id": mid, "title": title, "sort_template_rev": rev, "status": "מיובא ומתועד",
            "is_dictionary_entry": False, "needs_attention": False, "wikipedia_id": None,
            "match_type": "ללא התאמה", "maybe_deleted_from_wikipedia": False,
            "template_referenced_title": None, "template_check_access_denied_at": None,
            "rev_task": None, "rev_page_id": None, "rev_page_title": None}
    base.update(extra)
    return base


REVS = {
    100: {"page_id": 180218, "title": "דהוכ (מחוז)", "ns": 0, "redirect": False},
    200: {"page_id": 555, "title": "הטבח בפסטיבל נובה", "ns": 0, "redirect": False},
    300: {"page_id": 777, "title": "יעד", "ns": 0, "redirect": True},
}


def fake_wikipedia_get(params):
    if params.get("list") == "recentchanges":
        return {"query": {"recentchanges": [{"revid": 44_000_000}]}}
    revs = [int(r) for r in params["revids"].split("|")]
    pages = [{"pageid": REVS[r]["page_id"], "ns": REVS[r]["ns"], "title": REVS[r]["title"],
              "redirect": REVS[r]["redirect"], "revisions": [{"revid": r}]} for r in revs if r in REVS]
    return {"query": {"pages": pages}}


class MatchRevTest(unittest.TestCase):
    def run_match(self, rows, wikipedia_map, extra_args=(), template=None, manual=None):
        # template: {id: None | (wikipedia_id, value) | ("unresolved", value)}; id שחסר בו = הבדיקה נדחתה (נעילה).
        # ברירת מחדל (None): לכל השורות נבדק ואין תבנית.
        client = FakeClient()
        existing = set(wikipedia_map.values()) | {555, 180218}
        argv = ["match.py", *extra_args]
        with mock.patch.object(match, "get_client", return_value=client), \
             mock.patch.object(match, "load_wikipedia_map", return_value=(wikipedia_map, existing)), \
             mock.patch.object(match, "load_manual_matches", return_value=manual or {}), \
             mock.patch.object(match, "iter_mechalol_rows", return_value=iter([rows])), \
             mock.patch.object(match, "execute_with_retry", side_effect=lambda op, desc: op()), \
             mock.patch.object(match, "resolve_pending_via_template",
                               side_effect=lambda pending, wmap: {
                                   r["id"]: (template or {}).get(r["id"]) for r, _ in pending
                                   if template is None or r["id"] in template}), \
             mock.patch.object(fetch_wikipedia_revisions, "wikipedia_get", side_effect=fake_wikipedia_get), \
             mock.patch.object(sys, "argv", argv):
            match.main()
        return {u["id"]: u for u in client.upserts}

    def test_decisions_are_written_per_row(self):
        wikipedia_map = {"דהוכ": 2328166, "אחר": 9}
        rows = [
            mrow(1, "דהוכ", 100),                            # הגרסה שייכת לדף אחר מהקישור לפי כותרת
            mrow(2, "הטבח במסיבת הטבע ליד רעים", 200),       # אין התאמת כותרת, שם שונה
            mrow(3, "אחר", 300),                              # דף הגרסה הפך להפניה
            mrow(4, "אחר2", 1),                               # גרסה 1 = שגויה
            mrow(5, "ללא גרסה", None, status="מיובא ללא תיעוד"),  # מחוץ להיקף
        ]
        written = self.run_match(rows, wikipedia_map)

        self.assertEqual((written[1]["rev_task"], written[1]["wikipedia_id"], written[1]["rev_page_id"]),
                         ("bad_rev", 2328166, 180218))          # הקישור לפי כותרת נשמר
        self.assertEqual((written[2]["rev_task"], written[2]["wikipedia_id"], written[2]["rev_page_title"]),
                         ("rename", 555, "הטבח בפסטיבל נובה"))   # הקישור לפי גרסה
        self.assertEqual((written[3]["rev_task"], written[3]["wikipedia_id"]), ("redirect", 9))
        self.assertEqual(written[4]["rev_task"], "bad_rev")
        self.assertIsNone(written[5]["rev_task"])
        self.assertIsNone(written[5]["rev_page_id"])

    def test_template_link_to_another_page_is_not_overridden_by_the_revision(self):
        # הגרסה (דף 555) שייכת לדף אחר מזה שהתבנית מקשרת אליו (9): גרסה שגויה, והקישור נשאר 9
        written = self.run_match([mrow(2, "שם בתבנית", 200)], {"אחר": 9}, template={2: (9, "אחר")})
        self.assertEqual((written[2]["rev_task"], written[2]["wikipedia_id"], written[2]["rev_page_id"]),
                         ("bad_rev", 9, 555))

    def test_template_link_agreeing_with_the_revision_with_different_name_is_rename(self):
        written = self.run_match([mrow(2, "שם ישן", 200)], {"x": 1}, template={2: (555, "הטבח בפסטיבל נובה")})
        self.assertEqual((written[2]["rev_task"], written[2]["wikipedia_id"]), ("rename", 555))

    def test_skip_template_check_links_by_revision_without_evidence(self):
        written = self.run_match([mrow(2, "הטבח במסיבת הטבע ליד רעים", 200)], {"x": 1},
                                 extra_args=("--skip-template-check",))
        self.assertEqual((written[2]["rev_task"], written[2]["wikipedia_id"]), ("rename", 555))

    def test_locked_template_row_without_revision_is_not_bad_rev(self):
        # נעול לקריאה: אין גרסה כי התבנית לא ניתנת לקריאה - שייך ל"נעולים", לא ל"גרסה שגויה"
        rows = [mrow(1, "נעול", None, sort_template_denied_at="2026-09-30T00:00:00Z")]
        written = self.run_match(rows, {"נעול": 7})
        self.assertIsNone(written[1]["rev_task"])

    def test_template_denied_during_match_is_not_bad_rev(self):
        rows = [mrow(1, "חדש נעול", None)]
        written = self.run_match(rows, {"אחר": 7}, template={})  # אין תוצאה לשורה = נדחה
        self.assertIsNone(written[1]["rev_task"])

    def test_manual_match_clears_the_task(self):
        rows = [mrow(1, "דהוכ", 100, rev_task="bad_rev", rev_page_id=180218, rev_page_title="x")]
        written = self.run_match(rows, {"דהוכ": 2328166}, manual={1: 2328166})
        self.assertIsNone(written[1]["rev_task"])
        self.assertEqual(written[1]["wikipedia_id"], 2328166)

    def test_stale_task_is_cleared_when_resolved(self):
        rows = [mrow(1, "דהוכ", 100, rev_task="rename", rev_page_id=5, rev_page_title="x")]
        written = self.run_match(rows, {"דהוכ": 180218})  # הגרסה והכותרת מסכימות
        self.assertIsNone(written[1]["rev_task"])
        self.assertIsNone(written[1]["rev_page_title"])

    def test_skip_rev_check_leaves_task_columns_untouched(self):
        rows = [mrow(1, "דהוכ", 100, rev_task="rename", rev_page_id=5, rev_page_title="x")]
        written = self.run_match(rows, {"דהוכ": 180218}, extra_args=("--skip-rev-check",))
        self.assertEqual(written[1]["rev_task"], "rename")

    def test_rows_without_task_columns_still_work(self):
        row = mrow(1, "דהוכ", 100)
        for key in ("rev_task", "rev_page_id", "rev_page_title"):
            del row[key]
        written = self.run_match([row], {"דהוכ": 180218})
        self.assertNotIn("rev_task", written[1])
        self.assertEqual(written[1]["wikipedia_id"], 180218)


if __name__ == "__main__":
    unittest.main()
