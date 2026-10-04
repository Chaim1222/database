import os
import sys
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import delta_api  # noqa: E402
import redirect_tags as rt  # noqa: E402


def ev(page_id, title, ts):
    return {"page_id": page_id, "title": title, "timestamp": ts}


class LatestByPageTests(unittest.TestCase):
    def test_keeps_latest_event_per_page(self):
        events = [ev(1, "א", "2026-10-01T00:00:00Z"), ev(1, "א", "2026-10-03T00:00:00Z"), ev(2, "ב", "2026-10-02T00:00:00Z")]
        result = {e["page_id"]: e["timestamp"] for e in rt.latest_by_page(events)}
        self.assertEqual(result, {1: "2026-10-03T00:00:00Z", 2: "2026-10-02T00:00:00Z"})

    def test_ignores_events_without_page_id(self):
        self.assertEqual(rt.latest_by_page([ev(0, "גלוי", "2026-10-01T00:00:00Z")]), [])


class UnionCandidatesTests(unittest.TestCase):
    def test_counts_tag_only_candidates(self):
        edited = [{"page_id": 1, "title": "א"}, {"page_id": 2, "title": "ב"}]
        tagged = [ev(2, "ב", "t"), ev(3, "ג", "t")]
        merged, tag_only = rt.union_candidates(edited, tagged)
        self.assertEqual(sorted(c["page_id"] for c in merged), [1, 2, 3])
        self.assertEqual(tag_only, 1)

    def test_no_tags(self):
        merged, tag_only = rt.union_candidates([{"page_id": 1, "title": "א"}], [])
        self.assertEqual((len(merged), tag_only), (1, 0))


class RevivedArticlesTests(unittest.TestCase):
    def test_only_pages_that_are_regular_articles_now(self):
        removed = [ev(1, "ערך", "2026-10-01T00:00:00Z"), ev(2, "חזר להפניה", "2026-10-01T00:00:00Z"), ev(3, "נמחק", "2026-10-01T00:00:00Z")]
        status = {"ערך": False, "חזר להפניה": True}  # "נמחק" חסר = לא קיים
        revived = rt.revived_articles(removed, status)
        self.assertEqual(revived, [{"page_id": 1, "title": "ערך", "created_at": "2026-10-01T00:00:00Z"}])


class FetchTaggedChangesTests(unittest.TestCase):
    def test_paginates_filters_by_tag_and_dedupes(self):
        pages = [
            {"query": {"recentchanges": [
                {"pageid": 1, "title": "א", "timestamp": "2026-10-01T00:00:00Z"},
                {"pageid": 2, "title": "ב", "timestamp": "2026-10-01T01:00:00Z"}]},
             "continue": {"rccontinue": "x"}},
            {"query": {"recentchanges": [{"pageid": 1, "title": "א", "timestamp": "2026-10-02T00:00:00Z"}]}},
        ]
        with mock.patch.object(delta_api, "_api_get_with_retry", side_effect=pages) as call:
            result = delta_api.fetch_tagged_changes("https://example/api.php", "2026-09-30T00:00:00Z", rt.REDIRECT_REMOVED_TAG)
        self.assertEqual(call.call_count, 2)
        first_params = call.call_args_list[0].args[1]
        self.assertEqual(first_params["rctag"], "mw-removed-redirect")
        self.assertEqual(first_params["rcnamespace"], 0)
        self.assertEqual(call.call_args_list[1].args[1]["rccontinue"], "x")
        self.assertEqual({e["page_id"]: e["timestamp"] for e in result},
                         {1: "2026-10-02T00:00:00Z", 2: "2026-10-01T01:00:00Z"})


if __name__ == "__main__":
    unittest.main()
