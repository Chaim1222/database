import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import rev_link_scan as rls  # noqa: E402

REVS = {
    100: {"page_id": 180218, "title": "דהוכ (מחוז)", "ns": 0, "redirect": False},
    200: {"page_id": 555, "title": "הטבח בפסטיבל נובה", "ns": 0, "redirect": False},
    300: {"page_id": 777, "title": "יעד", "ns": 0, "redirect": True},
}


def fake_get(params):
    if params.get("list") == "recentchanges":
        return {"query": {"recentchanges": [{"revid": 44_000_000}]}}
    revs = [int(r) for r in params["revids"].split("|")]
    pages = [{"pageid": REVS[r]["page_id"], "ns": 0, "title": REVS[r]["title"], "redirect": REVS[r]["redirect"],
              "revisions": [{"revid": r}]} for r in revs if r in REVS]
    return {"query": {"pages": pages}}


class FakeStore:
    def __init__(self, previous=None, manual=()):
        self._previous, self._manual = previous or {}, set(manual)
        self.upserts, self.deletes = [], set()

    def manual_ids(self):
        return self._manual

    def previous(self):
        return dict(self._previous)

    def upsert(self, findings):
        self.upserts.extend(findings)

    def delete(self, ids):
        self.deletes |= set(ids)


def mrow(mid, title, rev, **extra):
    base = {"id": mid, "title": title, "sort_template_rev": rev, "status": "מיובא ומתועד",
            "is_dictionary_entry": False, "needs_attention": False, "wikipedia_id": None}
    base.update(extra)
    return base


def finding(mid, task, rev, linked, page_id, title):
    return {"rev_task": task, "rev_id": rev, "linked_wikipedia_id": linked, "rev_page_id": page_id,
            "rev_page_title": title}


class ScanTest(unittest.TestCase):
    # שמות התבנית שנקראים לערכים שהכותרת שלהם לא תואמת לכותרת הנוכחית
    TEMPLATES = {1: "דהוכ", 2: "הטבח במסיבת הטבע ליד רעים", 3: "אחר", 7: "דהוכ (מחוז)"}

    def run_scan(self, rows, store, dry_run=False):
        existing = {2328166, 180218, 555, 9}
        original = rls.fetch_template_names
        rls.fetch_template_names = lambda ids: {i: self.TEMPLATES.get(i) for i in ids}
        try:
            return rls.scan(store, fake_get, existing, iter([rows]), dry_run, None, 1)
        finally:
            rls.fetch_template_names = original

    def test_findings_per_task(self):
        store = FakeStore()
        rows = [
            mrow(1, "דהוכ", 100, wikipedia_id=2328166),                    # הועבר, השם הישן תפוס: העברה
            mrow(2, "הטבח במסיבת הטבע ליד רעים", 200, wikipedia_id=555),   # ויקיפדיה העבירה, לא עקבנו: העברה
            mrow(3, "אחר", 300, wikipedia_id=9),                            # דף הגרסה הפך להפניה
            mrow(4, "אחר2", 1),                                             # גרסה 1
            mrow(5, "נעול", None, sort_template_denied_at="2026-09-30"),    # תבנית נעולה
            mrow(6, "דהוכ (מחוז)", 100, wikipedia_id=180218),               # כותרת שלנו שווה לנוכחית
            mrow(7, "כותרת מקומית", 100, wikipedia_id=180218),              # התבנית עודכנה לשם הנוכחי
        ]
        stats, complete = self.run_scan(rows, store)
        tasks = {f["mechalol_id"]: f["rev_task"] for f in store.upserts}
        self.assertEqual(tasks, {1: "rename", 2: "rename", 3: "redirect", 4: "bad_rev"})
        self.assertTrue(complete)
        self.assertEqual(stats["ok"], 3)

    def test_manual_match_is_not_a_task(self):
        store = FakeStore(manual={1})
        self.run_scan([mrow(1, "דהוכ", 100, wikipedia_id=2328166)], store)
        self.assertEqual(store.upserts, [])

    def test_unchanged_findings_are_not_rewritten_and_healed_ones_deleted(self):
        previous = {
            1: finding(1, "rename", 100, 2328166, 180218, "דהוכ (מחוז)"),    # זהה: בלי כתיבה
            6: finding(6, "rename", 100, 5, 180218, "x"),                     # תוקן: נמחק
            99: finding(99, "bad_rev", 1, None, None, None),                  # לא נראה יותר: נמחק
        }
        store = FakeStore(previous=previous)
        rows = [mrow(1, "דהוכ", 100, wikipedia_id=2328166), mrow(6, "דהוכ (מחוז)", 100, wikipedia_id=180218)]
        self.run_scan(rows, store)
        self.assertEqual(store.upserts, [])
        self.assertEqual(store.deletes, {6, 99})

    def test_dry_run_writes_nothing(self):
        store = FakeStore(previous={6: finding(6, "rename", 100, 5, 180218, "x")})
        self.run_scan([mrow(1, "דהוכ", 100, wikipedia_id=2328166), mrow(6, "דהוכ (מחוז)", 100, wikipedia_id=180218)],
                      store, dry_run=True)
        self.assertEqual((store.upserts, store.deletes), ([], set()))


if __name__ == "__main__":
    unittest.main()
