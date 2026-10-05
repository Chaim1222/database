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


class RedirectTargetsTest(unittest.TestCase):
    def test_targets_are_resolved_with_normalization_and_missing_targets_are_none(self):
        calls = []

        def fake(params):
            calls.append(params)
            return {"query": {"normalized": [{"from": "א_ב", "to": "א ב"}],
                              "redirects": [{"from": "א ב", "to": "יעד"}, {"from": "ג", "to": "יעד 2"}]}}

        result = rm.resolve_redirect_targets(fake, ["א_ב", "ג", "ד"])
        self.assertEqual(result, {"א_ב": "יעד", "ג": "יעד 2", "ד": None})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["redirects"], "1")

    def test_batches_of_fifty(self):
        calls = []
        rm.resolve_redirect_targets(lambda p: calls.append(p) or {"query": {}}, ["t%d" % i for i in range(120)])
        self.assertEqual(len(calls), 3)


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
        decision = rm.decide(row(), page(5, "x", redirect=True), MAX_REV, EXISTS, template_name="אחר", redirect_target="יעד")
        self.assertEqual((decision.task, decision.page_id, decision.page_title), (rm.TASK_REDIRECT, 5, "x"))

    def test_redirect_asks_for_target_and_template_name(self):
        decision = rm.decide(row(), page(5, "x", redirect=True), MAX_REV, EXISTS)
        self.assertEqual((decision.task, decision.needs_template, decision.needs_redirect), (None, True, True))
        only_target = rm.decide(row(), page(5, "x", redirect=True), MAX_REV, EXISTS, template_name="דף")
        self.assertEqual((only_target.needs_template, only_target.needs_redirect), (False, True))

    def test_redirect_whose_target_is_the_template_name_is_handled(self):
        # הגרסה על הפניה ישנה, אבל שם התבנית כבר הוא היעד: אין שינוי חדש לטיפול
        decision = rm.decide(row(), page(5, "ישן", redirect=True), MAX_REV, EXISTS, template_name="יעד חדש", redirect_target="יעד חדש")
        self.assertEqual(decision, rm.NO_DECISION)

    def test_redirect_target_matches_template_name_after_normalization(self):
        decision = rm.decide(row(), page(5, "ישן", redirect=True), MAX_REV, EXISTS, template_name="הרב יעד", redirect_target="יעד (רב)")
        self.assertEqual(decision, rm.NO_DECISION)

    def test_redirect_with_stale_template_or_unknown_target_stays_a_task(self):
        old_name = rm.decide(row(), page(5, "ישן", redirect=True), MAX_REV, EXISTS, template_name="ישן", redirect_target="יעד חדש")
        self.assertEqual(old_name.task, rm.TASK_REDIRECT)
        broken = rm.decide(row(), page(5, "ישן", redirect=True), MAX_REV, EXISTS, template_name="ישן", redirect_target=None)
        self.assertEqual(broken.task, rm.TASK_REDIRECT)
        no_template = rm.decide(row(), page(5, "ישן", redirect=True), MAX_REV, EXISTS, template_name=None, redirect_target="יעד")
        self.assertEqual(no_template.task, rm.TASK_REDIRECT)

    def test_our_title_equal_to_the_current_one_needs_no_template(self):
        self.assertEqual(self.decide(row(title="דהוכ"), page(9, "דהוכ")), rm.NO_DECISION)

    def test_template_name_equal_to_current_title_is_no_task_even_if_ours_differs(self):
        # הכותרת שלנו היא בחירה מקומית (קידומת "רבי"); התבנית עודכנה לשם הנוכחי
        decision = self.decide(row(title="חג הפסח"), page(9, "פסח"), template="פסח")
        self.assertEqual(decision, rm.NO_DECISION)

    def test_live_page_under_another_name_is_not_a_task_anymore(self):
        # העברת שם כבר לא משימה (הטאב "הועברו בוויקיפדיה" מכסה אותה ישר מהדלתא)
        self.assertEqual(self.decide(row(), page(180218, "דהוכ (מחוז)"), template="דהוכ"), rm.NO_DECISION)
        self.assertEqual(rm.decide(row(), page(180218, "דהוכ (מחוז)"), MAX_REV, EXISTS), rm.NO_DECISION)

    def test_old_template_name_but_our_title_already_equal_is_no_task(self):
        decision = self.decide(row(title="ספין (פיזיקה)"), page(9, "ספין (פיזיקה)"), template="ספין")
        self.assertEqual(decision, rm.NO_DECISION)

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
