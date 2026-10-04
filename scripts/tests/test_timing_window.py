import os
import sys
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("SUPABASE_URL", "x")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import log_reconciliation_diff as audit  # noqa: E402
import timing_window as tw  # noqa: E402
import weekly_build as weekly  # noqa: E402


def ex(side, cls, page_id, title="דף", old=None, new=None):
    return {"side": side, "change_class": cls, "page_id": page_id, "title": title, "old_value": old, "new_value": new}


class ClassifyTests(unittest.TestCase):
    def test_page_id_or_title_in_window_is_explained(self):
        rows = [ex("mechalol", "status", 1), ex("mechalol", "status", 2, title="אחר"), ex("mechalol", "title", 3, old="ישן", new="חדש")]
        explained, unexplained = tw.classify_examples(rows, {1}, {"חדש"})
        self.assertEqual([r["page_id"] for r in explained], [1, 3])
        self.assertEqual([r["page_id"] for r in unexplained], [2])

    def test_summary_notes_sample_and_missing_window(self):
        summary = [
            {"side": "mechalol", "change_class": "status", "n": 300, "n_known_to_delta": 0},
            {"side": "wikipedia", "change_class": "is_missing", "n": 2, "n_known_to_delta": 2},
            {"side": "wikipedia", "change_class": "title", "n": 1, "n_known_to_delta": 0},
        ]
        examples = [ex("mechalol", "status", i) for i in range(200)] + [ex("wikipedia", "title", 9)]
        rows = tw.summarize(summary, examples, {"mechalol": ({0}, set())})
        by_key = {(r[0], r[1]): r for r in rows}
        self.assertEqual(len(rows), 2)  # שורה שכולה ידועה לדלתא לא מופיעה
        self.assertIn("מדגם בלבד", by_key[("mechalol", "status")][6])
        self.assertEqual(by_key[("mechalol", "status")][5], 199)
        self.assertEqual(by_key[("wikipedia", "title")][4], None)  # אין חלון לוויקיפדיה


class WindowsTests(unittest.TestCase):
    def test_windows_use_stored_watermarks_and_fetch_finish_per_site(self):
        state = {"delta_watermarks": {"wikipedia": "2026-10-04T17:36:50.123+00:00", "mechalol": "2026-10-04T17:36:39+00:00", "other": "x"}}
        windows = weekly.timing_windows(state, {"mechalol": "2026-10-04T17:52:00Z"})
        self.assertEqual(windows["mechalol"], ("2026-10-04T17:36:39Z", "2026-10-04T17:52:00Z"))
        self.assertEqual(windows["wikipedia"], ("2026-10-04T17:36:50Z", None))
        self.assertNotIn("other", windows)

    def test_timing_failure_is_non_blocking(self):
        client = mock.MagicMock()
        with mock.patch.object(audit, "execute_with_retry", side_effect=RuntimeError("down")):
            lines = audit.explain_timing(client, 8, [{"side": "mechalol", "change_class": "status", "n": 1, "n_known_to_delta": 0}],
                                         {"mechalol": ("2026-10-04T17:36:39Z", None)})
        self.assertEqual(lines, [])


if __name__ == "__main__":
    unittest.main()
