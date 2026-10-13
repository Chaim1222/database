"""שם בתבנית המיון של דף שהועבר בוויקיפדיה מתאים למזהה הדף (ממצא 13.10: ערכים שהועברו הופיעו כחסרים)."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import match
from normalize import hygiene


def events(*rows):
    return [{"id": i + 1, "page_id": pid, "title": title} for i, (pid, title) in enumerate(rows)]


class MovedTitlesTests(unittest.TestCase):
    def load(self, rows, title_map, existing_ids):
        with patch.object(match, "execute_with_retry", return_value=SimpleNamespace(data=rows)):
            return match.load_moved_titles(object(), title_map, existing_ids)

    def test_old_title_maps_to_moved_page(self):
        title_map = {hygiene("מתקפה"): 1223651}
        moved = self.load(events((1223651, "התקפה (צורת קרב)")), title_map, {1223651})
        self.assertEqual(moved, {hygiene("התקפה (צורת קרב)"): 1223651})

    def test_old_title_held_by_another_live_page_is_not_used(self):
        title_map = {hygiene("ב"): 3, hygiene("ב חדש"): 2}
        self.assertEqual(self.load(events((2, "ב")), title_map, {2, 3}), {})

    def test_ambiguous_or_gone_pages_are_skipped(self):
        rows = events((5, "ה"), (6, "ה"), (7, "ז"))
        self.assertEqual(self.load(rows, {}, {5, 6}), {})   # "ה" של שני מזהים; 7 כבר לא חי

    def test_template_with_old_title_resolves_to_page_id(self):
        row = {"id": 186085, "title": "התקפה (צורת קרב)"}
        moved = {hygiene("התקפה (צורת קרב)"): 1223651}
        with patch.object(match, "fetch_template_titles", return_value={row["title"]: "התקפה (צורת קרב)"}), \
                patch.object(match, "log"):
            resolved = match.resolve_pending_via_template([(row, row["title"])], {}, moved)
            self.assertEqual(resolved[186085], (1223651, "התקפה (צורת קרב)"))
            # בלי היסטוריית ההעברות: "בעיה בשם", כמו קודם
            resolved = match.resolve_pending_via_template([(row, row["title"])], {})
            self.assertEqual(resolved[186085], ("unresolved", "התקפה (צורת קרב)"))

    def test_live_title_wins_over_history(self):
        row = {"id": 10, "title": "א"}
        with patch.object(match, "fetch_template_titles", return_value={"א": "ב"}), patch.object(match, "log"):
            resolved = match.resolve_pending_via_template([(row, "א")], {hygiene("ב"): 3}, {hygiene("ב"): 2})
        self.assertEqual(resolved[10], (3, "ב"))


if __name__ == "__main__":
    unittest.main()
