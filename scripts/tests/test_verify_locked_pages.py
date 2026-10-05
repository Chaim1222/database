import os
import sys
import types
import unittest
from pathlib import Path

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import verify_locked_pages as v  # noqa: E402


def info(allevel, missing=False, pageid=None):
    return {"allevel": allevel, "missing": missing, "pageid": pageid}


def res(rid, verdict_, allevel="read", title="ט"):
    return {"id": rid, "title": title, "verdict": verdict_, "allevel": allevel}


class VerdictTest(unittest.TestCase):
    def test_still_locked(self):
        self.assertEqual(v.verdict("read_locked", info("read", pageid=5)), "still_locked")
        self.assertEqual(v.verdict("create_locked", info("create", missing=True)), "still_locked")

    def test_lock_lifted(self):
        self.assertEqual(v.verdict("read_locked", info("none", pageid=5)), "open_now")
        self.assertEqual(v.verdict("create_locked", info("none", missing=True)), "open_now")

    def test_semi_locked_read_is_its_own_verdict_only_for_read(self):
        self.assertEqual(v.verdict("read_locked", info("read-semi", pageid=5)), v.SEMI)
        # נעול ליצירה שהפך לנעול למחצה לקריאה = הדף נוצר: חריג רגיל, לא מוסתר
        self.assertEqual(v.verdict("create_locked", info("read-semi", pageid=5)), "other:" + v.SEMI)

    def test_other_level_and_not_returned(self):
        self.assertEqual(v.verdict("create_locked", info("read", pageid=9)), "other:read_locked")
        self.assertEqual(v.verdict("read_locked", info("edit")), "other:unknown")   # נעילת עריכה לא נחשבת
        self.assertEqual(v.verdict("read_locked", None), "not_returned")

    def test_summarize_and_visible_hide_semi(self):
        self.assertEqual(v.summarize(["still_locked", "open_now", "still_locked"]), {"still_locked": 2, "open_now": 1})
        rows = [res(1, "still_locked"), res(2, v.SEMI, "read-semi"), res(3, "open_now", "none")]
        self.assertEqual([r["id"] for r in v.visible(rows)], [1, 3])

    def test_row_result_keeps_the_raw_level(self):
        self.assertEqual(v.row_result(1, "ט", "read_locked", info("sysop", pageid=1)),
                         {"id": 1, "title": "ט", "verdict": "other:unknown", "allevel": "sysop"})
        self.assertEqual(v.row_result(2, "ט", "read_locked", None)["allevel"], None)


class PlanApplyTest(unittest.TestCase):
    def test_only_open_now_is_fixed_and_levels_cover_read_and_semi(self):
        groups = {
            v.READ_GROUP: [res(1, "still_locked"), res(2, v.SEMI, "read-semi"), res(3, "open_now", "none"),
                           res(4, "other:unknown", "edit"), res(5, "not_returned", None)],
            v.CREATE_GROUP: [res(10, "still_locked", "create"), res(11, "open_now", "none")],
            v.MANUAL_GROUP: [],
        }
        plan = v.plan_apply(groups)
        self.assertEqual(plan["fix_read"], [3])
        self.assertEqual(plan["fix_create"], [11])
        self.assertEqual(plan["fix_manual"], [])
        self.assertEqual(plan["levels"], [(1, "read"), (2, "read-semi")])   # לא open_now, לא other, לא not_returned

    def test_guard_stops_everything_when_too_many_look_open(self):
        rows = [res(i, "still_locked") for i in range(70)] + [res(100 + i, "open_now", "none") for i in range(30)]
        with self.assertRaises(v.GuardError):
            v.plan_apply({v.READ_GROUP: rows, v.CREATE_GROUP: [res(1, "still_locked", "create")] * 25})
        # גם "לא הוחזרו" נספרים: תקלת API ולא שינוי אמיתי
        with self.assertRaises(v.GuardError):
            v.plan_apply({v.READ_GROUP: [res(i, "not_returned", None) for i in range(25)]})

    def test_guard_ignores_tiny_groups(self):
        plan = v.plan_apply({v.READ_GROUP: [res(1, "open_now", "none"), res(2, "still_locked")]})
        self.assertEqual(plan["fix_read"], [1])


class FakeQuery:
    def __init__(self, log, table, op, payload=None, kwargs=None):
        self.log, self.table, self.op, self.payload, self.kwargs, self.filters = log, table, op, payload, kwargs, []

    def in_(self, col, values):
        self.filters.append(("in", col, list(values)))
        return self

    def like(self, col, pattern):
        self.filters.append(("like", col, pattern))
        return self

    def execute(self):
        self.log.append((self.table, self.op, self.payload, self.kwargs, self.filters))


class FakeTable:
    def __init__(self, log, name):
        self.log, self.name = log, name

    def upsert(self, rows, on_conflict=None):
        return FakeQuery(self.log, self.name, "upsert", rows, {"on_conflict": on_conflict})

    def update(self, values):
        return FakeQuery(self.log, self.name, "update", values)

    def delete(self):
        return FakeQuery(self.log, self.name, "delete")


class FakeClient:
    def __init__(self):
        self.log = []

    def table(self, name):
        return FakeTable(self.log, name)


class ApplyPlanTest(unittest.TestCase):
    def test_writes_levels_resets_and_deletes_only_auto_rows(self):
        stub = types.ModuleType("supabase_client")
        stub.execute_with_retry = lambda op, description, log_fn=None: op()
        previous = sys.modules.get("supabase_client")
        sys.modules["supabase_client"] = stub
        try:
            client = FakeClient()
            v.apply_plan(client, {"fix_read": [3], "fix_create": [11], "fix_manual": [7], "levels": [(1, "read"), (2, "read-semi")]})
        finally:
            if previous is None:
                del sys.modules["supabase_client"]
            else:
                sys.modules["supabase_client"] = previous
        by = {(t, op): (payload, kw, filters) for t, op, payload, kw, filters in client.log}
        payload, kw, _ = by[("page_lock_levels", "upsert")]
        self.assertEqual(payload, [{"mechalol_id": 1, "allevel": "read"}, {"mechalol_id": 2, "allevel": "read-semi"}])
        self.assertEqual(kw, {"on_conflict": "mechalol_id"})
        payload, _, filters = by[("mechalol_pages", "update")]
        self.assertEqual(payload, {"sort_template_denied_at": None, "template_check_access_denied_at": None})
        self.assertEqual(filters, [("in", "id", [3])])
        self.assertEqual(by[("blacklist_titles", "delete")][2], [("in", "id", [11]), ("like", "reason", "נעול ליצירה%")])
        self.assertEqual(by[("manual_matches", "delete")][2], [("in", "id", [7]), ("like", "reason", "נעול לקריאה%")])


class CheckTest(unittest.TestCase):
    def test_read_locked_maps_results_by_page_id_and_respects_limit(self):
        rows = [{"id": 1, "title": "א"}, {"id": 2, "title": "ב"}, {"id": 3, "title": "ג"}, {"id": 4, "title": "ד"}]
        original_read, original_fetch = v.read_all, v.fetch_page_lock_info
        calls = []
        v.read_all = lambda client, build, label: rows
        v.fetch_page_lock_info = lambda pageids=None, titles=None: calls.append(pageids) or {
            "א": info("read", pageid=1), "ב": info("none", pageid=2), "ד": info("read-semi", pageid=4)}   # ג לא הוחזר
        try:
            out = v.check_read_locked(None, None)
            limited = v.check_read_locked(None, 2)
        finally:
            v.read_all, v.fetch_page_lock_info = original_read, original_fetch
        self.assertEqual([r["verdict"] for r in out], ["still_locked", "open_now", "not_returned", v.SEMI])
        self.assertEqual([r["allevel"] for r in out], ["read", "none", None, "read-semi"])
        self.assertEqual(calls, [[1, 2, 3, 4], [1, 2]])
        self.assertEqual(len(limited), 2)

    def test_create_locked_uses_titles(self):
        original_read, original_fetch = v.read_all, v.fetch_page_lock_info
        v.read_all = lambda client, build, label: [{"id": 7, "title": "כותרת"}, {"id": 8, "title": "אחרת"}]
        v.fetch_page_lock_info = lambda pageids=None, titles=None: {"כותרת": info("create", missing=True), "אחרת": info("none", missing=True)}
        try:
            out = v.check_create_locked(None, None)
        finally:
            v.read_all, v.fetch_page_lock_info = original_read, original_fetch
        self.assertEqual([r["verdict"] for r in out], ["still_locked", "open_now"])


if __name__ == "__main__":
    unittest.main()
