import gzip
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from wiki_dump import iter_stub_pages, latest_per_page  # noqa: E402

STUB = """<mediawiki xmlns="http://www.mediawiki.org/xml/export-0.11/" version="0.11" xml:lang="he">
  <siteinfo><sitename>ויקיפדיה</sitename></siteinfo>
  <page>
    <title>אבא</title><ns>0</ns><id>10</id>
    <revision><id>1001</id><parentid>1000</parentid><timestamp>2026-09-01T10:00:00Z</timestamp>
      <contributor><username>x</username><id>5</id></contributor><sha1>abc</sha1></revision>
  </page>
  <page>
    <title>הפניה</title><ns>0</ns><id>11</id><redirect title="אבא" />
    <revision><id>1002</id><timestamp>2026-09-02T10:00:00Z</timestamp></revision>
  </page>
  <page>
    <title>שיחה:אבא</title><ns>1</ns><id>12</id>
    <revision><id>1003</id><timestamp>2026-09-03T10:00:00Z</timestamp></revision>
  </page>
  <page>
    <title>אמא</title><ns>0</ns><id>13</id>
    <revision><id>1004</id><timestamp>2026-09-04T10:00:00Z</timestamp>
      <contributor><username>y</username><id>6</id></contributor></revision>
  </page>
</mediawiki>"""


class IterStubPagesTests(unittest.TestCase):
    def test_only_main_namespace_non_redirects(self):
        rows = list(iter_stub_pages(io.BytesIO(STUB.encode("utf-8"))))
        self.assertEqual(rows, [
            (10, 1001, "2026-09-01T10:00:00Z"),
            (13, 1004, "2026-09-04T10:00:00Z"),
        ])

    def test_reads_gzip_stream(self):
        raw = gzip.compress(STUB.encode("utf-8"))
        rows = list(iter_stub_pages(gzip.GzipFile(fileobj=io.BytesIO(raw))))
        self.assertEqual([r[0] for r in rows], [10, 13])

    def test_contributor_id_is_not_taken_as_revision_id(self):
        rows = dict((p, r) for p, r, _ in iter_stub_pages(io.BytesIO(STUB.encode("utf-8"))))
        self.assertEqual(rows[13], 1004)

    def test_empty_dump(self):
        xml = '<mediawiki xmlns="http://www.mediawiki.org/xml/export-0.11/"></mediawiki>'
        self.assertEqual(list(iter_stub_pages(io.BytesIO(xml.encode()))), [])


class LatestPerPageTests(unittest.TestCase):
    def test_keeps_latest_timestamp(self):
        changes = [
            (1, 10, "2026-09-01T00:00:00Z"),
            (1, 12, "2026-09-03T00:00:00Z"),
            (1, 11, "2026-09-02T00:00:00Z"),
            (2, 20, "2026-09-01T00:00:00Z"),
        ]
        self.assertEqual(latest_per_page(changes), {
            1: (12, "2026-09-03T00:00:00Z"),
            2: (20, "2026-09-01T00:00:00Z"),
        })

    def test_tie_on_timestamp_uses_higher_revision(self):
        changes = [(1, 11, "2026-09-01T00:00:00Z"), (1, 10, "2026-09-01T00:00:00Z")]
        self.assertEqual(latest_per_page(changes)[1][0], 11)


if __name__ == "__main__":
    unittest.main()
