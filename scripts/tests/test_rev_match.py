import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import rev_match as rm  # noqa: E402

MAX_REV = 44_000_000
EXISTS = lambda page_id: True  # noqa: E731


def row(title="דהוכ", rev=22338104, **extra):
    base = {"id": 265071, "title": title, "sort_template_rev": rev, "status": "מיובא ומתועד",
            "is_dictionary_entry": False, "needs_attention": False}
    base.update(extra)
    return base


def page(page_id, title, ns=0, redirect=False):
    return {"page_id": page_id, "title": title, "ns": ns, "redirect": redirect}


class DecideTest(unittest.TestCase):
    def decide(self, r, resolved, exists=EXISTS, template=None):
        return rm.decide(r, resolved, MAX_REV, exists, template_name=template)

    def test_out_of_scope_rows_get_no_decision(self):
        for extra in ({"status": "מיובא ללא תיעוד"}, {"is_dictionary_entry": True}, {"needs_attention": True},
                      {"sort_template_denied_at": "2026-09-30T00:00:00Z"},   # תבנית נעולה לקריאה
                      {"template_check_access_denied_at": "2026-09-30T00:00:00Z"}):
            self.assertEqual(self.decide(row(**extra), page(1, "x")), rm.NO_DECISION)

    def test_invalid_revisions_are_bad_rev(self):
        for rev in (None, 0, 1):
            self.assertEqual(self.decide(row(rev=rev), None).task, rm.TASK_BAD_REV)

    def test_missing_revision_deleted_or_bad_by_range(self):
        self.assertEqual(self.decide(row(rev=30_000_000), None).task, rm.TASK_DELETED)
        self.assertEqual(self.decide(row(rev=4_208_831_936_456), None).task, rm.TASK_BAD_REV)

    def test_other_namespace_and_redirect(self):
        self.assertEqual(self.decide(row(), page(5, "טיוטה:x", ns=118)).task, rm.TASK_BAD_REV)
        decision = self.decide(row(), page(5, "x", redirect=True))
        self.assertEqual((decision.task, decision.page_id, decision.page_title), (rm.TASK_REDIRECT, 5, "x"))

    def test_our_title_equal_to_the_current_one_needs_no_template(self):
        self.assertEqual(self.decide(row(title="דהוכ"), page(9, "דהוכ")), rm.NO_DECISION)

    def test_different_title_asks_for_the_template_name(self):
        decision = rm.decide(row(), page(9, "דהוכ (מחוז)"), MAX_REV, EXISTS)  # template_name=UNKNOWN
        self.assertTrue(decision.needs_template)

    def test_template_name_equal_to_current_title_is_no_task_even_if_ours_differs(self):
        # הכותרת שלנו היא בחירה מקומית (קידומת "רבי"); התבנית עודכנה לשם הנוכחי
        decision = self.decide(row(title="חג הפסח"), page(9, "פסח"), template="פסח")
        self.assertEqual(decision, rm.NO_DECISION)

    def test_both_names_differ_from_the_current_title_is_rename(self):
        # דהוכ: הכותרת והתבנית עדיין "דהוכ", ודף הגרסה הועבר ל"דהוכ (מחוז)" (והשם הישן תפוס בערך אחר)
        decision = self.decide(row(), page(180218, "דהוכ (מחוז)"), template="דהוכ")
        self.assertEqual((decision.task, decision.page_id, decision.page_title),
                         (rm.TASK_RENAME, 180218, "דהוכ (מחוז)"))

    def test_old_template_name_but_our_title_already_equal_is_no_task(self):
        decision = self.decide(row(title="ספין (פיזיקה)"), page(9, "ספין (פיזיקה)"), template="ספין")
        self.assertEqual(decision, rm.NO_DECISION)

    def test_missing_or_empty_template_name_counts_as_not_matching(self):
        self.assertEqual(self.decide(row(), page(9, "x"), template=None).task, rm.TASK_RENAME)

    def test_rav_prefix_and_suffix_do_not_make_a_rename(self):
        self.assertEqual(self.decide(row(title="רבי שלום מנצורה"), page(9, "שלום מנצורה (רב)"), template="x").task,
                         None)

    def test_live_page_missing_from_wikipedia_pages_is_left_for_next_run(self):
        self.assertEqual(self.decide(row(), page(9, "x"), exists=lambda page_id: False), rm.NO_DECISION)


class NamesMatchTest(unittest.TestCase):
    def test_hygiene_normalization_and_rav_prefix(self):
        self.assertTrue(rm.names_match("הקולג׳", "הקולג'"))
        self.assertTrue(rm.names_match("אליל", "אל"))
        self.assertTrue(rm.names_match("רבי אהרן כהן", "אהרן כהן"))
        self.assertTrue(rm.names_match("אהרן כהן", "הרב אהרן כהן"))
        self.assertTrue(rm.names_match("רבי שלום מנצורה", "שלום מנצורה (רב)"))
        self.assertTrue(rm.names_match("הרב דוד כהנא", "דוד כהנא (רב)"))
        self.assertFalse(rm.names_match("רבי אהרן כהן", "אהרן כהן (ראש ישיבה)"))
        self.assertFalse(rm.names_match("דהוכ", "דהוכ (מחוז)"))
        self.assertFalse(rm.names_match(None, "x"))


class ResolveTest(unittest.TestCase):
    def test_resolve_many_batches_and_marks_missing(self):
        calls = []

        def fake_get(params):
            revs = [int(r) for r in params["revids"].split("|")]
            calls.append(len(revs))
            pages = [{"pageid": r, "ns": 0, "title": f"p{r}", "revisions": [{"revid": r}]} for r in revs if r != 3]
            return {"query": {"pages": pages}}

        resolved = rm.resolve_many(fake_get, list(range(1, 121)), workers=3)
        self.assertEqual(sorted(calls), [20, 50, 50])
        self.assertEqual(resolved[5]["page_id"], 5)
        self.assertIsNone(resolved[3])

    def test_fetch_max_rev(self):
        self.assertEqual(rm.fetch_max_rev(lambda p: {"query": {"recentchanges": [{"revid": 44006211}]}}), 44006211)
        self.assertEqual(rm.fetch_max_rev(lambda p: {"query": {}}), 0)


if __name__ == "__main__":
    unittest.main()
