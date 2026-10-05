"""
בדיקת שחזור לאובדן דף שהועבר בדלתא של המכלול (נצפה ב-5.10.2026, מזהה 710987):
העברה בלי הפניה -> יצירת דף חדש בשם הישן -> שני המזהים צריכים להישאר בשמות הנכונים.
משתמש בלקוח מדומה עם אילוץ ייחודיות על title, כמו mechalol_pages_title_key.
"""
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test")
if "supabase" not in sys.modules:  # החבילה אינה בהכרח מותקנת; הבדיקה לא פונה לרשת
    stub = types.ModuleType("supabase")
    stub.create_client = lambda *a, **k: None
    sys.modules["supabase"] = stub

import fetch_mechalol_delta as delta  # noqa: E402


class TitleCollision(Exception):
    code = "23505"

    def __str__(self):
        return 'duplicate key value violates unique constraint "mechalol_pages_title_key"'


class Result:
    def __init__(self, data=None):
        self.data = data or []


class Query:
    def __init__(self, store, op, payload=None):
        self.store, self.op, self.payload = store, op, payload
        self.filters = []

    def in_(self, column, values):
        self.filters.append((column, "in", list(values)))
        return self

    def eq(self, column, value):
        self.filters.append((column, "eq", value))
        return self

    def _match(self, row):
        for column, kind, value in self.filters:
            if kind == "in" and row[column] not in value:
                return False
            if kind == "eq" and row[column] != value:
                return False
        return True

    def _check_titles(self, new_rows):
        titles = {}
        for row in new_rows:
            if row["title"] in titles and titles[row["title"]] != row["id"]:
                raise TitleCollision()
            titles[row["title"]] = row["id"]
        for page_id, row in self.store.items():
            if row["title"] in titles and titles[row["title"]] != page_id and page_id not in {r["id"] for r in new_rows}:
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
            for page_id, row in list(self.store.items()):
                if self._match(row):
                    self._check_titles([{**row, **self.payload}])
                    row.update(self.payload)
            return Result()
        raise AssertionError(self.op)


class FakeTable:
    def __init__(self, store):
        self.store = store

    def select(self, _columns):
        return Query(self.store, "select")

    def delete(self):
        return Query(self.store, "delete")

    def upsert(self, rows, on_conflict=None):
        return Query(self.store, "upsert", rows)

    def update(self, payload):
        return Query(self.store, "update", payload)


class FakeClient:
    def __init__(self, rows):
        self.store = {r["id"]: dict(r) for r in rows}

    def table(self, name):
        assert name == "mechalol_pages"
        return FakeTable(self.store)

    def titles(self):
        return {i: r["title"] for i, r in self.store.items()}


def row(page_id, title):
    return {"id": page_id, "title": title, "status": "מיובא ומתועד"}


def creation(page_id, title, at="2026-10-05T09:04:52Z"):
    return {"page_id": page_id, "title": title, "created_at": at}


def move(page_id, old, new, at):
    return {"page_id": page_id, "old_title": old, "new_title": new, "renamed_at": at, "action": "move",
            "suppressredirect": True, "old_title_pageid_valid": True}


MOVE = move(710987, "בית האזרח", "בית האזרח (רמת גן)", "2026-10-05T09:02:50Z")
NEW_PAGE = creation(1178368, "בית האזרח")


class MovedPageSurvivesTests(unittest.TestCase):
    def test_old_order_loses_the_moved_page(self):
        """מתעד את הבאג: יצירות ← מחיקות ← העברות (הסדר הישן) מוחק את הדף שהועבר."""
        client = FakeClient([row(710987, "בית האזרח")])
        delta.apply_creations(client, [NEW_PAGE], {})
        delta.apply_deletions(client, [])
        delta.apply_renames(client, [MOVE])
        self.assertEqual(client.titles(), {1178368: "בית האזרח"})  # 710987 נעלם

    def test_apply_core_keeps_both_pages_with_correct_titles(self):
        client = FakeClient([row(710987, "בית האזרח")])
        delta.apply_core(client, [NEW_PAGE], [], [MOVE], {})
        self.assertEqual(client.titles(), {710987: "בית האזרח (רמת גן)", 1178368: "בית האזרח"})

    def test_page_created_and_moved_in_same_window(self):
        """דף שנוצר בכותרת T והועבר ל-U באותו חלון: נשאר בכותרת U (ההעברה לא מוקדמת ליצירה שלו)."""
        client = FakeClient([])
        delta.apply_core(client, [creation(5, "טיוטה")], [], [move(5, "טיוטה", "ערך", "2026-10-05T09:10:00Z")], {})
        self.assertEqual(client.titles(), {5: "ערך"})

    def test_move_chain_and_reuse_of_old_title(self):
        """id=1: A->B ואז B->C; דף חדש id=2 נוצר ב-A. תוצאה: 1=C, 2=A, גם כשסדר הרשימה הפוך."""
        renames = [move(1, "B", "C", "2026-10-05T09:30:00Z"), move(1, "A", "B", "2026-10-05T09:00:00Z")]
        client = FakeClient([row(1, "A")])
        delta.apply_core(client, [creation(2, "A", "2026-10-05T09:10:00Z")], [], renames, {})
        self.assertEqual(client.titles(), {1: "C", 2: "A"})

    def test_without_renames_or_creations_nothing_changes(self):
        client = FakeClient([row(1, "א")])
        delta.apply_core(client, [], [], [], {})
        self.assertEqual(client.titles(), {1: "א"})

    def test_untouched_collision_still_replaces_stale_row(self):
        """התנגשות אמיתית בלי העברה ברשימה (שורה מיושנת): ההתנהגות הקיימת נשמרת, השורה המיושנת נמחקת."""
        client = FakeClient([row(9, "ערך")])
        delta.apply_core(client, [creation(10, "ערך")], [], [], {})
        self.assertEqual(client.titles(), {10: "ערך"})


if __name__ == "__main__":
    unittest.main()
