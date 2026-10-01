import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import check_rev_links as crl  # noqa: E402


def page(page_id, title, ns=0, redirect=False):
    return {"page_id": page_id, "title": title, "ns": ns, "redirect": redirect}


def row(title="דהוכ", wikipedia_id=2328166, rev=22338104, mid=265071):
    return {"id": mid, "title": title, "wikipedia_id": wikipedia_id, "sort_template_rev": rev}


class ClassifyTest(unittest.TestCase):
    def test_matching_link_is_ok(self):
        self.assertIsNone(crl.classify(row(wikipedia_id=180218), page(180218, "דהוכ (מחוז)")))

    def test_moved_page_with_new_article_at_old_name(self):
        finding = crl.classify(row(), page(180218, "דהוכ (מחוז)"))
        self.assertEqual(finding["status"], "other_page")
        self.assertEqual(finding["rev_page_id"], 180218)
        self.assertEqual(finding["linked_wikipedia_id"], 2328166)
        self.assertFalse(finding["name_equiv"])

    def test_unlinked_row_resolving_to_live_page(self):
        finding = crl.classify(row(wikipedia_id=None), page(180218, "דהוכ (מחוז)"))
        self.assertEqual(finding["status"], "unlinked_resolves")

    def test_redirect_and_namespace_and_missing(self):
        self.assertEqual(crl.classify(row(), page(5, "x", redirect=True))["status"], "rev_page_redirect")
        self.assertEqual(crl.classify(row(), page(5, "x", ns=2))["status"], "other_namespace")
        finding = crl.classify(row(), None)
        self.assertEqual(finding["status"], "rev_missing")
        self.assertIsNone(finding["rev_page_id"])

    def test_names_equivalent_uses_normalization(self):
        self.assertTrue(crl.names_equivalent("הקולג׳", "הקולג'"))
        self.assertTrue(crl.names_equivalent("אליל", "אל"))
        self.assertFalse(crl.names_equivalent("דהוכ", "דהוכ (מחוז)"))
        self.assertFalse(crl.names_equivalent(None, "x"))


class ResolveTest(unittest.TestCase):
    def test_maps_revisions_to_pages_and_marks_missing(self):
        payload = {"query": {"pages": [{
            "pageid": 180218, "ns": 0, "title": "דהוכ (מחוז)", "revisions": [{"revid": 22338104}],
        }]}}
        resolved = crl.resolve_revisions(lambda params: payload, [22338104, 1])
        self.assertEqual(resolved[22338104]["page_id"], 180218)
        self.assertFalse(resolved[22338104]["redirect"])
        self.assertIsNone(resolved[1])


if __name__ == "__main__":
    unittest.main()
