import os
import sys
from pathlib import Path
os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import rev_match as subject
import unittest
from unittest.mock import patch

LIVE = {"pageid": 5, "title": "חי", "ns": 0, "revisions": [{"revid": 50}]}


class RevisionResponseTests(unittest.TestCase):
    def resolve(self, reply, ids=(50, 70)):
        with patch.object(subject, 'REQUEST_DELAY_SECONDS', 0):
            return subject.resolve_revisions(lambda params: reply, ids)

    def test_confirmed_missing_and_live(self):
        result = self.resolve({"query": {"pages": [LIVE],
                              "badrevids": {"70": {"revid": 70, "missing": True}}}})
        self.assertEqual(result[50]["page_id"], 5)
        self.assertIsNone(result[70])

    def test_all_confirmed_missing_without_pages(self):
        self.assertEqual(self.resolve({"query": {"badrevids": {
            "70": {"revid": 70, "missing": True}}}}, (70,)), {70: None})

    def test_partial_or_malformed_reply_fails(self):
        for reply in ({}, {"query": {}}, {"query": {"pages": [LIVE]}},
                      {"query": {"pages": None}}, {"query": {"pages": [dict(LIVE, ns=None)]}},
                      {"query": {"badrevids": {"70": {"revid": 70}}}}):
            with self.subTest(reply=reply), self.assertRaises(RuntimeError):
                self.resolve(reply)

    def test_duplicate_unexpected_or_contradictory_identity_fails(self):
        for query in ({"pages": [LIVE, LIVE]},
                      {"pages": [LIVE], "badrevids": {"50": {"revid": 50, "missing": True}}},
                      {"pages": [dict(LIVE, revisions=[{"revid": 99}])]},
                      {"badrevids": {"99": {"revid": 99, "missing": True}}}):
            with self.subTest(query=query), self.assertRaises(RuntimeError):
                self.resolve({"query": query}, (50,))

    def test_continued_reply_is_not_complete(self):
        with self.assertRaises(RuntimeError):
            self.resolve({"continue": {"rvcontinue": "x"}, "query": {"pages": [LIVE]}}, (50,))

    def test_empty_request_does_not_fetch(self):
        with patch.object(subject, 'REQUEST_DELAY_SECONDS', 0):
            self.assertEqual(subject.resolve_revisions(lambda _: self.fail('unexpected fetch'), []), {})

    def test_hidden_revision_does_not_change_page_identity(self):
        page = dict(LIVE, revisions=[{"revid": 50, "texthidden": True}])
        self.assertEqual(self.resolve({"query": {"pages": [page]}}, (50,))[50]["page_id"], 5)
