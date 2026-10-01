import os
import sys
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import backfill_rev_task as bf  # noqa: E402


class FakeClient:
    def __init__(self):
        self.writes = []

    def rpc(self, name, params):
        self.writes.append((name, params["p_rows"]))
        return mock.Mock(execute=lambda: mock.Mock(data=len(params["p_rows"])))


def mrow(mid, title, rev, **extra):
    base = {"id": mid, "title": title, "sort_template_rev": rev, "status": "מיובא ומתועד",
            "is_dictionary_entry": False, "needs_attention": False,
            "rev_task": None, "rev_page_id": None, "rev_page_title": None}
    base.update(extra)
    return base


def fake_get(params):
    if params.get("list") == "recentchanges":
        return {"query": {"recentchanges": [{"revid": 44_000_000}]}}
    pages = [{"pageid": 180218, "ns": 0, "title": "דהוכ (מחוז)", "revisions": [{"revid": 100}]}]
    return {"query": {"pages": pages}}


class BackfillTest(unittest.TestCase):
    def run_scan(self, rows, dry_run=False):
        client = FakeClient()
        with mock.patch.object(bf, "scoped_rows", return_value=iter([rows])), \
             mock.patch("supabase_client.execute_with_retry", side_effect=lambda op, desc, log_fn=None: op()):
            stats, complete = bf.scan(client, fake_get, {"דהוכ": 2328166}, {2328166, 180218}, dry_run, None, 1)
        return client, stats, complete

    def test_writes_only_changed_rows(self):
        rows = [
            mrow(1, "דהוכ", 100),                                                   # חדש: גרסה שגויה
            mrow(2, "דהוכ2", 1, rev_task="bad_rev"),                                # כבר מסומן: בלי כתיבה
            mrow(3, "אחר", None, rev_task="rename", rev_page_id=5, rev_page_title="x"),  # היה rename, עכשיו bad_rev
        ]
        client, stats, complete = self.run_scan(rows)
        self.assertTrue(complete)
        written = client.writes[0][1]
        self.assertEqual({w["id"] for w in written}, {1, 3})
        self.assertEqual(next(w for w in written if w["id"] == 1)["rev_task"], "bad_rev")
        self.assertEqual(next(w for w in written if w["id"] == 3)["rev_page_id"], None)
        self.assertEqual(stats["changed"], 2)

    def test_dry_run_writes_nothing(self):
        client, stats, _ = self.run_scan([mrow(1, "דהוכ", 100)], dry_run=True)
        self.assertEqual(client.writes, [])
        self.assertEqual(stats["changed"], 1)


if __name__ == "__main__":
    unittest.main()
