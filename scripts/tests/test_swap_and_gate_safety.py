import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.modules.setdefault("supabase", types.SimpleNamespace(create_client=lambda *a, **k: None))

import match  # noqa: E402
import swap_temp_to_active as swap  # noqa: E402
import validate_before_swap as gate  # noqa: E402

BEFORE = {"wikipedia_pages": 406048, "wikipedia_pages_temp": 406059, "mechalol_pages": 381813, "mechalol_pages_temp": 381826}
SWAPPED = {"wikipedia_pages": 406059, "wikipedia_pages_temp": 406048, "mechalol_pages": 381826, "mechalol_pages_temp": 381813}


class SwapHappenedTests(unittest.TestCase):
    def test_unchanged_is_false(self):
        self.assertIs(swap.swap_happened(BEFORE, dict(BEFORE)), False)

    def test_exchanged_is_true(self):
        self.assertIs(swap.swap_happened(BEFORE, SWAPPED), True)

    def test_mixed_state_is_unknown(self):
        mixed = dict(BEFORE, wikipedia_pages=406059, wikipedia_pages_temp=406048)
        self.assertIsNone(swap.swap_happened(BEFORE, mixed))


class SwapRetryTests(unittest.TestCase):
    def client(self, error):
        client = mock.Mock()
        client.rpc.return_value.execute.side_effect = error
        return client

    def test_lost_response_after_commit_does_not_swap_back(self):
        client = self.client(ConnectionError("connection reset"))
        with mock.patch.object(swap, "snapshot", side_effect=[BEFORE, SWAPPED]), mock.patch.object(swap.time, "sleep"):
            swap.perform_swap_with_retry(client)  # מחזיר בלי חריגה: ההחלפה כבר קרתה
        self.assertEqual(client.rpc.call_count, 1)

    def test_unknown_error_without_swap_fails_without_retry(self):
        client = self.client(RuntimeError("boom"))
        with mock.patch.object(swap, "snapshot", side_effect=[BEFORE, dict(BEFORE)]), mock.patch.object(swap.time, "sleep"):
            with self.assertRaises(RuntimeError):
                swap.perform_swap_with_retry(client)
        self.assertEqual(client.rpc.call_count, 1)

    def test_lock_timeout_is_retried(self):
        class LockError(Exception):
            code = "55P03"

        client = mock.Mock()
        client.rpc.return_value.execute.side_effect = [LockError("lock timeout"), None]
        with mock.patch.object(swap, "snapshot", return_value=BEFORE), mock.patch.object(swap.time, "sleep"):
            swap.perform_swap_with_retry(client)
        self.assertEqual(client.rpc.call_count, 2)


class QualityIssuesTests(unittest.TestCase):
    ACTIVE = {"unmatched": 3788, "documented": 335469, "missing": 27886}

    def test_todays_build_passes(self):
        self.assertEqual(gate.quality_issues(self.ACTIVE, {"unmatched": 3783, "documented": 335500, "missing": 27900}), [])

    def test_partial_match_is_blocked(self):
        issues = gate.quality_issues(self.ACTIVE, {"unmatched": 150000, "documented": 335469, "missing": 27887})
        self.assertEqual(len(issues), 1)
        self.assertIn("ללא התאמה", issues[0])

    def test_partial_classification_is_blocked(self):
        issues = gate.quality_issues(self.ACTIVE, {"unmatched": 3788, "documented": 100000, "missing": 27887})
        self.assertTrue(any("מתועדים" in i for i in issues))

    def test_missing_not_computed_is_blocked(self):
        issues = gate.quality_issues(self.ACTIVE, {"unmatched": 3788, "documented": 335469, "missing": 0})
        self.assertTrue(any("חסרים" in i for i in issues))

    def test_fewer_unmatched_is_fine(self):
        self.assertEqual(gate.quality_issues(self.ACTIVE, {"unmatched": 100, "documented": 335469, "missing": 27887}), [])


class FreshnessTests(unittest.TestCase):
    def test_fresh_build_passes(self):
        self.assertIsNone(gate.freshness_issue(406059, 406059))

    def test_old_active_after_swap_is_blocked(self):
        # אחרי החלפה הזמנית מחזיקה את הפעילה הקודמת: רק שורות שהדלתא הוסיפה טריות
        self.assertIn("אינה בנייה טרייה", gate.freshness_issue(406048, 40))

    def test_empty_temp_is_blocked(self):
        self.assertIn("ריקה", gate.freshness_issue(0, 0))

    def test_threshold_is_ninety_percent(self):
        self.assertIsNone(gate.freshness_issue(1000, 900))
        self.assertIsNotNone(gate.freshness_issue(1000, 899))


class TemplateErrorTests(unittest.TestCase):
    def test_only_accessdenied_is_marked_denied(self):
        responses = [{"error": {"code": "accessdenied"}}]
        with mock.patch.object(match, "api_get_with_retry", side_effect=responses), mock.patch.object(match.time, "sleep"):
            result = match.fetch_template_titles(["דף"])
        self.assertIs(result["דף"], match.ACCESS_DENIED)

    def test_transient_error_is_retried_then_recovers(self):
        ok = {"query": {"pages": [{"title": "דף", "revisions": [{"slots": {"main": {"content": "{{מיון ויקיפדיה|דף=אבא}}"}}}]}]}}
        responses = [{"error": {"code": "ratelimited"}}, ok]
        with mock.patch.object(match, "api_get_with_retry", side_effect=responses), mock.patch.object(match.time, "sleep"):
            result = match.fetch_template_titles(["דף"])
        self.assertEqual(result["דף"], "אבא")

    def test_persistent_transient_error_raises_instead_of_marking_denied(self):
        responses = [{"error": {"code": "internal_api_error_X"}}] * 3
        with mock.patch.object(match, "api_get_with_retry", side_effect=responses), mock.patch.object(match.time, "sleep"):
            with self.assertRaises(RuntimeError):
                match.fetch_template_titles(["דף"])


    def _fetch(self, response):
        with mock.patch.object(match, "api_get_with_retry", side_effect=[response]), mock.patch.object(match.time, "sleep"):
            return match.fetch_template_titles(["דף"])

    def test_response_without_query_raises(self):
        with self.assertRaises(RuntimeError):
            self._fetch({"batchcomplete": True})

    def test_page_without_revisions_and_not_missing_raises(self):
        with self.assertRaises(RuntimeError):
            self._fetch({"query": {"pages": [{"title": "דף"}]}})

    def test_missing_page_is_just_no_template(self):
        result = self._fetch({"query": {"pages": [{"title": "דף", "missing": True}]}})
        self.assertIsNone(result["דף"])

    def test_page_without_content_raises(self):
        with self.assertRaises(RuntimeError):
            self._fetch({"query": {"pages": [{"title": "דף", "revisions": [{"slots": {"main": {}}}]}]}})

    def test_empty_content_is_no_template(self):
        result = self._fetch({"query": {"pages": [{"title": "דף", "revisions": [{"slots": {"main": {"content": ""}}}]}]}})
        self.assertIsNone(result["דף"])


    def test_query_without_pages_raises(self):
        with self.assertRaises(RuntimeError):
            self._fetch({"query": {}})

    def test_empty_pages_list_raises(self):
        with self.assertRaises(RuntimeError):
            self._fetch({"query": {"pages": []}})

    def test_requested_title_not_returned_raises(self):
        with self.assertRaises(RuntimeError):
            self._fetch({"query": {"pages": [{"title": "אחר", "missing": True}]}})

    def test_normalized_title_maps_back_to_requested(self):
        page = {"title": "אבא ב", "revisions": [{"slots": {"main": {"content": "{{מיון ויקיפדיה|דף=גג}}"}}}]}
        with mock.patch.object(match, "api_get_with_retry", side_effect=[{"query": {"normalized": [{"from": "אבא_ב", "to": "אבא ב"}], "pages": [page]}}]), \
                mock.patch.object(match.time, "sleep"):
            result = match.fetch_template_titles(["אבא_ב"])
        self.assertEqual(result["אבא_ב"], "גג")


if __name__ == "__main__":
    unittest.main()
