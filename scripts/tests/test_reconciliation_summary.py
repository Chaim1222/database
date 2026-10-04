import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from reconciliation_summary import format_summary  # noqa: E402


class FormatSummaryTests(unittest.TestCase):
    def test_empty(self):
        self.assertIn("אין הבדלים", format_summary([], 7))

    def test_unknown_to_delta_is_total_minus_known(self):
        rows = [
            {"side": "wikipedia", "change_class": "is_missing", "n": 11, "n_known_to_delta": 1},
            {"side": "mechalol", "change_class": "status", "n": 5, "n_known_to_delta": 5},
        ]
        text = format_summary(rows, 7)
        self.assertIn("| ויקיפדיה | `is_missing` | 11 | 1 | 10 |", text)
        self.assertIn("| מכלול | `status` | 5 | 5 | 0 |", text)
        self.assertIn("סך הכול 16 שינויים, מתוכם 10 שהדלתא לא ידעה עליהם", text)

    def test_order_is_stable_by_side_then_class(self):
        rows = [
            {"side": "mechalol", "change_class": "title", "n": 1, "n_known_to_delta": 0},
            {"side": "mechalol", "change_class": "only_new", "n": 1, "n_known_to_delta": 0},
        ]
        text = format_summary(rows, 1)
        self.assertLess(text.index("only_new"), text.index("`title`"))


if __name__ == "__main__":
    unittest.main()
