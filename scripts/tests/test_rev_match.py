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
    def decide(self, r, resolved, title_link=None, exists=EXISTS, evidence=None):
        return rm.decide(r, resolved, title_link, MAX_REV, exists, evidence_link_id=evidence)

    def test_out_of_scope_rows_get_no_decision(self):
        for extra in ({"status": "מיובא ללא תיעוד"}, {"is_dictionary_entry": True}, {"needs_attention": True}):
            self.assertEqual(self.decide(row(**extra), page(1, "x")), rm.NO_DECISION)

    def test_invalid_revisions_are_bad_rev(self):
        for rev in (None, 0, 1):
            self.assertEqual(self.decide(row(rev=rev), None).task, rm.TASK_BAD_REV)

    def test_missing_revision_deleted_or_bad_by_range(self):
        self.assertEqual(self.decide(row(rev=30_000_000), None).task, rm.TASK_DELETED)
        self.assertEqual(self.decide(row(rev=4_208_831_936_456), None).task, rm.TASK_BAD_REV)
        self.assertEqual(self.decide(row(rev=30_000_000), None).link_id, None)

    def test_other_namespace_and_redirect(self):
        self.assertEqual(self.decide(row(), page(5, "טיוטה:x", ns=118)).task, rm.TASK_BAD_REV)
        decision = self.decide(row(), page(5, "x", redirect=True))
        self.assertEqual((decision.task, decision.page_id, decision.page_title), (rm.TASK_REDIRECT, 5, "x"))

    def test_title_link_to_another_page_is_bad_rev_and_keeps_title_link(self):
        # דהוכ: הגרסה שייכת ל"דהוכ (מחוז)", והתאמת הכותרת קישרה לערך אחר בשם הישן
        decision = self.decide(row(), page(180218, "דהוכ (מחוז)"), title_link=2328166)
        self.assertEqual((decision.task, decision.link_id, decision.page_id), (rm.TASK_BAD_REV, None, 180218))

    def test_agreement_with_title_link_is_clean(self):
        self.assertEqual(self.decide(row(), page(7, "דהוכ"), title_link=7), rm.NO_DECISION)

    def test_no_title_link_links_by_revision(self):
        decision = self.decide(row(title="אברהם דוב"), page(9, "אברהם דוב"))
        self.assertEqual((decision.link_id, decision.task), (9, None))

    def test_no_title_link_with_different_name_is_rename(self):
        decision = self.decide(row(title="הטבח במסיבת הטבע ליד רעים"), page(9, "הטבח בפסטיבל נובה"))
        self.assertEqual((decision.link_id, decision.task, decision.page_title),
                         (9, rm.TASK_RENAME, "הטבח בפסטיבל נובה"))

    def test_rav_prefix_difference_is_not_a_rename(self):
        decision = self.decide(row(title="הרב אברהם רזניק"), page(9, "אברהם רזניק"))
        self.assertEqual((decision.link_id, decision.task), (9, None))

    def test_no_title_link_and_unchecked_evidence_asks_for_evidence(self):
        decision = rm.decide(row(), page(9, "x"), None, MAX_REV, EXISTS)  # evidence_link_id=UNKNOWN
        self.assertTrue(decision.needs_evidence)
        self.assertIsNone(decision.task)

    def test_template_link_to_another_page_is_bad_rev_and_keeps_the_link(self):
        # "רבי יעקב שמשון משפטיבקה": התבנית מקשרת לדף הנכון, והגרסה שייכת לדף לא קשור
        decision = self.decide(row(title="רבי יעקב שמשון משפטיבקה"), page(2562611, "שחיקה דמוקרטית בישראל"),
                               evidence=78873)
        self.assertEqual((decision.task, decision.link_id, decision.page_id), (rm.TASK_BAD_REV, None, 2562611))

    def test_template_link_agreeing_with_revision_is_rename_when_names_differ(self):
        decision = self.decide(row(title="רבי שלום מנצורה"), page(776399, "שלום מנצורה (ראש ישיבה)"), evidence=776399)
        self.assertEqual((decision.link_id, decision.task), (776399, rm.TASK_RENAME))

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
