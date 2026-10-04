import io
import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from wiki_dump import iter_stub_titles  # noqa: E402
from wikipedia_title_gap import chunks, classify_pages, gap_start, log_event_refs  # noqa: E402

STUB = """<mediawiki xmlns="http://www.mediawiki.org/xml/export-0.11/">
  <page><title>אבא</title><ns>0</ns><id>10</id>
    <revision><id>1001</id><timestamp>2026-09-01T10:00:00Z</timestamp></revision></page>
  <page><title>הפניה</title><ns>0</ns><id>11</id><redirect title="אבא" />
    <revision><id>1002</id><timestamp>2026-09-02T10:00:00Z</timestamp></revision></page>
  <page><title>שיחה:אבא</title><ns>1</ns><id>12</id>
    <revision><id>1003</id><timestamp>2026-09-03T10:00:00Z</timestamp></revision></page>
</mediawiki>"""


class DumpTitlesTests(unittest.TestCase):
    def test_titles_main_namespace_only(self):
        rows = list(iter_stub_titles(io.BytesIO(STUB.encode("utf-8"))))
        self.assertEqual(rows, [(10, "אבא", 1001, "2026-09-01T10:00:00Z")])


class GapStartTests(unittest.TestCase):
    now = datetime(2026, 10, 4, tzinfo=timezone.utc)

    def test_margin_before_newest(self):
        self.assertEqual(gap_start("2026-10-01T12:00:00Z", self.now), "2026-09-29T12:00:00Z")

    def test_too_old_dump_raises(self):
        with self.assertRaises(RuntimeError):
            gap_start("2026-06-01T00:00:00Z", self.now)


class LogRefsTests(unittest.TestCase):
    def test_move_collects_page_title_and_target(self):
        events = [
            {"logpage": 5, "title": "ישן", "params": {"target_title": "חדש"}},
            {"logpage": 0, "title": "נמחק"},
        ]
        self.assertEqual(log_event_refs(events), ({5}, {"ישן", "חדש", "נמחק"}))


class ClassifyTests(unittest.TestCase):
    def test_states(self):
        pages = [
            {"pageid": 1, "ns": 0, "title": "חי"},
            {"pageid": 2, "ns": 0, "title": "הפניה", "redirect": ""},
            {"pageid": 3, "ns": 118, "title": "טיוטה:א"},
            {"pageid": 4, "missing": ""},
            {"title": "אין", "missing": ""},
        ]
        keep, drop_ids, drop_titles = classify_pages(pages)
        self.assertEqual(keep, [{"id": 1, "title": "חי"}])
        self.assertEqual(drop_ids, {2, 3, 4})
        self.assertEqual(drop_titles, {"אין"})


class ChunksTests(unittest.TestCase):
    def test_chunks(self):
        self.assertEqual(list(chunks(range(5), 2)), [[0, 1], [2, 3], [4]])


if __name__ == "__main__":
    unittest.main()
