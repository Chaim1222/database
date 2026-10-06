import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from check_move_sources import check, proof_of, strict_revision_get


class MoveProofTests(unittest.TestCase):
    def setUp(self):
        self.row = {"id": 10, "rev_id": 200, "sort_template_parsed_rev": 200,
                    "sort_template_rev": 300}
        self.fetched = {"rev_id": 200, "content": "{{מיון ויקיפדיה|דף=בית האזרח|גרסה=300}}"}
        self.resolved = {300: {"page_id": 20, "title": "בית האזרח", "ns": 0, "redirect": False}}

    def test_current_explicit_source_proves_identity(self):
        self.assertEqual(proof_of(self.row, self.fetched, self.resolved)["source_wikipedia_id"], 20)

    def test_stale_db_or_unparsed_revision_cannot_hide(self):
        for field in ("rev_id", "sort_template_parsed_rev", "sort_template_rev"):
            with self.subTest(field=field):
                row = dict(self.row, **{field: 999})
                self.assertIsNone(proof_of(row, self.fetched, self.resolved)["source_wikipedia_id"])

    def test_denied_missing_no_template_or_missing_source_cannot_hide(self):
        for item in (None, object(), {"rev_id": 200, "content": ""}):
            self.assertIsNone(proof_of(self.row, item, self.resolved)["source_wikipedia_id"])
        self.assertIsNone(proof_of(self.row, self.fetched, {})["source_wikipedia_id"])

    def test_real_move_retained_when_old_name_reused(self):
        # The title-only mirror link could point to new page 20, but the template
        # revision still belongs to the original, moved page 30.
        resolved = {300: dict(self.resolved[300], page_id=30, title="בית האזרח (רמת גן)")}
        self.assertIsNone(proof_of(self.row, self.fetched, resolved)["source_wikipedia_id"])

    def test_redirect_or_draft_is_not_positive_suppression_evidence(self):
        for change in ({"redirect": True}, {"ns": 118}):
            resolved = {300: dict(self.resolved[300], **change)}
            self.assertIsNone(proof_of(self.row, self.fetched, resolved)["source_wikipedia_id"])

    def test_omitted_reply_and_malformed_identity_fail(self):
        params = {"revids": "300"}
        for data in ({}, {"query": {"pages": []}},
                     {"query": {"pages": [{"pageid": None, "ns": 0,
                                             "revisions": [{"revid": 300}]}]}},
                     {"error": {}, "query": {"pages": []}}):
            with self.assertRaises(RuntimeError):
                strict_revision_get(lambda _: data, params)

    def test_explicit_bad_revision_is_not_an_omitted_reply(self):
        data = {"query": {"pages": [], "badrevids": {"300": {"revid": 300}}}}
        self.assertEqual(strict_revision_get(lambda _: data, {"revids": "300"}), data)

    def test_complete_positive_reply(self):
        data = {"query": {"pages": [{"pageid": 20, "ns": 0,
                                      "revisions": [{"revid": 300}]}]}}
        self.assertEqual(strict_revision_get(lambda _: data, {"revids": "300"}), data)

    def test_ambiguous_revision_identity_fails(self):
        data = {"query": {"pages": [
            {"pageid": 20, "ns": 0, "revisions": [{"revid": 300}]},
            {"pageid": 30, "ns": 0, "revisions": [{"revid": 300}]}]}}
        with self.assertRaises(RuntimeError):
            strict_revision_get(lambda _: data, {"revids": "300"})

    def test_refresh_writes_only_evidence_and_dry_run_writes_nothing(self):
        fixture = self

        class Query:
            def __init__(self, client, table):
                self.client, self.table, self.after, self.payload = client, table, 0, None

            def select(self, *_): return self
            def order(self, *_): return self
            def limit(self, *_): return self
            def in_(self, *_): return self

            def gt(self, _, after):
                self.after = after
                return self

            def upsert(self, payload, **_):
                self.payload = payload
                return self

            def execute(self):
                if self.payload is not None:
                    self.client.writes.append((self.table, self.payload))
                    return SimpleNamespace(data=self.payload)
                if self.table == "report_wikipedia_move_candidates":
                    return SimpleNamespace(data=[{"id": 10}] if self.after == 0 else [])
                if self.table == "mechalol_pages":
                    return SimpleNamespace(data=[fixture.row])
                raise AssertionError(f"Unexpected table: {self.table}")

        class Client:
            def __init__(self): self.writes = []
            def table(self, name): return Query(self, name)

        for dry in (False, True):
            client = Client()
            result = check(client, lambda _: {10: self.fetched}, lambda _: self.resolved, dry)
            self.assertEqual(result, (1, 1))
            self.assertEqual(len(client.writes), 0 if dry else 1)
            if not dry:
                self.assertEqual(client.writes[0][0], "maintenance_move_sources")
                self.assertEqual(client.writes[0][1][0]["source_wikipedia_id"], 20)


if __name__ == "__main__":
    unittest.main()
