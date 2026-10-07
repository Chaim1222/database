"""
בדיקת שחזור לאובדן דף שהועבר בדלתא של ויקיפדיה (נצפה ב-5.10.2026, Morphine (band) -> Morphine, מזהה 2579988):
העברה (עם הפניה), ואחר כך מחיקת ההפניה בכותרת הישנה באותו חלון. המחיקה נעשית לפי כותרת, ובסדר הישן
(יצירות, מחיקות, העברות) היא מחקה את השורה של הדף שהועבר, כי ההעברה עוד לא הוחלה.
לקוח מדומה עם אילוץ ייחודיות על wikipedia_pages.title ועם mechalol_pages (מפתח זר wikipedia_id).
"""
import os
import sys
import types
import unittest
from unittest.mock import patch
from contextlib import ExitStack

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test")
if "supabase" not in sys.modules:
    stub = types.ModuleType("supabase")
    stub.create_client = lambda *a, **k: None
    sys.modules["supabase"] = stub

import fetch_wikipedia_delta as delta  # noqa: E402


class TitleCollision(Exception):
    code = "23505"

    def __str__(self):
        return 'duplicate key value violates unique constraint "wikipedia_pages_title_key"'


class Result:
    def __init__(self, data=None):
        self.data = data or []


class Query:
    def __init__(self, name, store, op, payload=None):
        self.name, self.store, self.op, self.payload = name, store, op, payload
        self.filters = []

    def in_(self, column, values):
        self.filters.append((column, "in", list(values)))
        return self

    def eq(self, column, value):
        self.filters.append((column, "eq", value))
        return self

    def _match(self, row):
        for column, kind, value in self.filters:
            if kind == "in" and row.get(column) not in value:
                return False
            if kind == "eq" and row.get(column) != value:
                return False
        return True

    def _check_titles(self, new_rows):
        if self.name != "wikipedia_pages":
            return
        ids = {r["id"] for r in new_rows}
        titles = {}
        for row in new_rows:
            if row["title"] in titles and titles[row["title"]] != row["id"]:
                raise TitleCollision()
            titles[row["title"]] = row["id"]
        for page_id, row in self.store.items():
            if page_id not in ids and row["title"] in titles:
                raise TitleCollision()

    def execute(self):
        if self.op == "select":
            return Result([dict(r) for r in self.store.values() if self._match(r)])
        if self.op == "delete":
            for page_id in [i for i, r in self.store.items() if self._match(r)]:
                del self.store[page_id]
            return Result()
        if self.op == "upsert":
            self._check_titles(self.payload)
            for row in self.payload:
                self.store[row["id"]] = {**self.store.get(row["id"], {}), **row}
            return Result()
        if self.op == "update":
            for _page_id, row in list(self.store.items()):
                if self._match(row):
                    if "title" in self.payload:
                        self._check_titles([{**row, **self.payload}])
                    row.update(self.payload)
            return Result()
        raise AssertionError(self.op)


class FakeTable:
    def __init__(self, name, store):
        self.name, self.store = name, store

    def select(self, _columns):
        return Query(self.name, self.store, "select")

    def delete(self):
        return Query(self.name, self.store, "delete")

    def upsert(self, rows, on_conflict=None):
        return Query(self.name, self.store, "upsert", rows)

    def update(self, payload):
        return Query(self.name, self.store, "update", payload)


class FakeClient:
    def __init__(self, wiki_rows, mechalol_rows=()):
        self.stores = {
            "wikipedia_pages": {r["id"]: dict(r) for r in wiki_rows},
            "mechalol_pages": {r["id"]: dict(r) for r in mechalol_rows},
        }

    def table(self, name):
        return FakeTable(name, self.stores[name])

    def titles(self):
        return {i: r["title"] for i, r in self.stores["wikipedia_pages"].items()}

    def mechalol_links(self):
        return {i: r.get("wikipedia_id") for i, r in self.stores["mechalol_pages"].items()}


def wrow(page_id, title):
    return {"id": page_id, "title": title}


def move(page_id, old, new, at):
    return {"page_id": page_id, "old_title": old, "new_title": new, "renamed_at": at, "action": "move",
            "suppressredirect": False, "old_title_pageid_valid": False}


def redirect_deletion(title, at="2026-10-05T11:48:18Z"):
    """מחיקת ההפניה שנשארה בכותרת הישנה: pageid=0, נמחקת לפי כותרת."""
    return {"page_id": 0, "title": title, "deleted_at": at, "pageid_valid": False, "reason": "log_event"}


MORPHINE_MOVE = move(2579988, "Morphine (band)", "Morphine", "2026-10-05T11:27:20Z")
MORPHINE_DELETION = redirect_deletion("Morphine (band)")


class MovedPageSurvivesRedirectDeletionTests(unittest.TestCase):
    def test_old_order_deletes_the_moved_page(self):
        """מתעד את הבאג: מחיקות לפני העברות מוחקות את הדף שהועבר (השורה עוד נושאת את הכותרת הישנה)."""
        client = FakeClient([wrow(2579988, "Morphine (band)")])
        delta.apply_creations(client, [])
        delta.apply_deletions(client, [MORPHINE_DELETION])
        delta.apply_renames(client, [MORPHINE_MOVE])
        self.assertEqual(client.titles(), {})

    def test_apply_core_keeps_the_moved_page_and_is_replay_safe(self):
        client = FakeClient([wrow(2579988, "Morphine (band)")], [{"id": 1, "wikipedia_id": 2579988}])
        for _ in range(3):
            delta.apply_core(client, [], [MORPHINE_DELETION], [MORPHINE_MOVE])
            self.assertEqual(client.titles(), {2579988: "Morphine"})
            self.assertEqual(client.mechalol_links(), {1: 2579988})  # הקישור מהמכלול לא שוחרר

    def test_moved_page_that_is_really_deleted_at_its_new_title(self):
        """A->B ואז מחיקה אמיתית ב-B: אחרי ההעברה המחיקה לפי כותרת B מוצאת את הדף ומוחקת אותו."""
        client = FakeClient([wrow(5, "A")], [{"id": 1, "wikipedia_id": 5}])
        delta.apply_core(client, [], [redirect_deletion("B")], [move(5, "A", "B", "2026-10-05T09:00:00Z")])
        self.assertEqual(client.titles(), {})
        self.assertEqual(client.mechalol_links(), {1: None})

    def test_move_then_new_page_at_the_old_title(self):
        """הדף שהועבר נשמר, והדף החדש בכותרת הישנה נכתב (בלי להתנגש)."""
        client = FakeClient([wrow(1, "A")])
        creation = {"page_id": 2, "title": "A", "created_at": "2026-10-05T09:10:00Z"}
        delta.apply_core(client, [creation], [], [move(1, "A", "B", "2026-10-05T09:00:00Z")])
        self.assertEqual(client.titles(), {1: "B", 2: "A"})

    def test_title_swap_cycle_and_replay(self):
        renames = [move(1, "A", "B", "2026-10-05T09:01:00Z"), move(2, "B", "A", "2026-10-05T09:01:30Z")]
        client = FakeClient([wrow(1, "A"), wrow(2, "B")])
        for _ in range(2):
            delta.apply_core(client, [], [], renames)
            self.assertEqual(client.titles(), {1: "B", 2: "A"})

    def test_created_and_moved_in_same_window(self):
        creations = [
            {"page_id": 7, "title": "T", "created_at": "2026-10-05T09:00:00Z"},
            {"page_id": 8, "title": "T", "created_at": "2026-10-05T09:10:00Z"},
        ]
        client = FakeClient([])
        delta.apply_core(client, creations, [], [move(7, "T", "U", "2026-10-05T09:05:00Z")])
        self.assertEqual(client.titles(), {7: "U", 8: "T"})

    def test_no_events_nothing_changes(self):
        client = FakeClient([wrow(1, "א")])
        delta.apply_core(client, [], [], [])
        self.assertEqual(client.titles(), {1: "א"})


class DraftHistoryTests(unittest.TestCase):
    def test_draft_logs_collected_without_entering_mainspace_application(self):
        moved = dict(move(9, "ערך", "טיוטה:ערך", "2026-10-07T09:00:00Z"),
                     old_ns=0, new_ns=118, old_title_pageid=0)
        draft_move = dict(move(9, "טיוטה:ערך", "טיוטה:חדש", "2026-10-07T10:00:00Z"),
                          old_ns=118, new_ns=118)
        deleted = redirect_deletion("טיוטה:חדש", "2026-10-07T11:00:00Z")
        restored = {"page_id": 9, "title": "טיוטה:חדש", "created_at": "2026-10-07T12:00:00Z"}
        with ExitStack() as stack:
            mocks = {}
            for name in ("get_client", "get_watermark", "fetch_new_pages", "fetch_delete_log", "fetch_move_log",
                         "fetch_tagged_changes", "revived_articles", "fetch_redirect_status", "detect_became_redirect",
                         "write_delta_tables", "write_move_maintenance_events", "apply_core", "write_changed_ids_file"):
                mocks[name] = stack.enter_context(patch.object(delta, name))
            stack.enter_context(patch("sys.argv", ["fetch_wikipedia_delta.py"]))
            mocks["get_watermark"].return_value = "2026-10-07T00:00:00Z"
            mocks["fetch_new_pages"].return_value = []
            mocks["fetch_delete_log"].side_effect = [([], []), ([deleted], [restored])]
            mocks["fetch_move_log"].return_value = [moved, draft_move]
            for name in ("fetch_tagged_changes", "revived_articles", "detect_became_redirect"):
                mocks[name].return_value = []
            stack.enter_context(patch.object(delta.delta_watermark, "advance"))
            delta.main()
            self.assertEqual(mocks["fetch_delete_log"].call_args_list[1].kwargs, {"namespace":118})
            history = mocks["write_delta_tables"].call_args.args
            self.assertEqual(history[1], [])
            self.assertNotIn(deleted, history[2])
            self.assertEqual(history[3], [])
            journal = mocks["write_move_maintenance_events"].call_args.args
            self.assertEqual(journal[1:], ([moved, draft_move], [deleted], [restored]))
            applied = mocks["apply_core"].call_args.args
            self.assertEqual(applied[1], [])
            self.assertEqual(applied[3], [])
            self.assertNotIn(deleted, applied[2])

    def test_history_only_does_not_apply_pages_or_advance_watermark(self):
        for dry in (False, True):
            with patch("sys.argv", ["delta", "--move-history-only", "--since", "2026-10-01T00:00:00Z"] + (["--dry-run"] if dry else [])), \
                 patch.object(delta, "get_client"), \
                 patch.object(delta, "fetch_move_log", return_value=[]), \
                 patch.object(delta, "fetch_delete_log", return_value=([], [])), \
                 patch.object(delta, "write_move_maintenance_events") as write, \
                 patch.object(delta, "write_delta_tables") as old_write, \
                 patch.object(delta, "apply_core") as apply, \
                 patch.object(delta, "get_watermark") as read_mark, \
                 patch.object(delta.delta_watermark, "advance") as advance:
                delta.main()
                self.assertEqual(write.call_count, 0 if dry else 1)
                apply.assert_not_called(); advance.assert_not_called(); read_mark.assert_not_called(); old_write.assert_not_called()

    def test_journal_preserves_namespaces_and_deduplicates_without_touching_delta_logs(self):
        from unittest.mock import MagicMock
        client = MagicMock()
        event = dict(move(9, "ערך", "טיוטה:ערך", "2026-10-07T09:00:00Z"), old_ns=0, new_ns=118)
        deleted = redirect_deletion("טיוטה:ערך", "2026-10-07T10:00:00Z")
        restored = {"page_id":9, "title":"טיוטה:ערך", "created_at":"2026-10-07T11:00:00Z"}
        delta.write_move_maintenance_events(client, [event, event], [deleted], [restored])
        client.table.assert_called_once_with("maintenance_wikipedia_events")
        args, kwargs = client.table.return_value.upsert.call_args
        self.assertEqual(len(args[0]), 3)
        self.assertEqual([r["namespace"] for r in args[0]], [0,118,118])
        self.assertEqual(args[0][0]["target_namespace"],118)
        self.assertEqual(kwargs, {"on_conflict":"kind,title,target_title,event_at", "ignore_duplicates":True})

    def test_delete_log_namespace_is_explicit_and_defaults_to_mainspace(self):
        import delta_api
        with patch.object(delta_api, "_api_get_with_retry", return_value={"query":{"logevents":[]}}) as get:
            delta_api.fetch_delete_log("api", "start", namespace=118)
            self.assertEqual(get.call_args.args[1]["lenamespace"],118)
            delta_api.fetch_delete_log("api", "start")
            self.assertEqual(get.call_args.args[1]["lenamespace"],0)


if __name__ == "__main__":
    unittest.main()
