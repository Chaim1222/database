import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import delta_watermark  # noqa: E402


class FakeClient:
    def __init__(self):
        self.calls = []

    def table(self, name):
        self._table = name
        return self

    def update(self, values):
        self._values = values
        return self

    def eq(self, column, value):
        self._eq = (column, value)
        return self

    def execute(self):
        self.calls.append((self._table, self._values, self._eq))
        return self


class DeltaWatermarkTest(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self._orig = delta_watermark.PENDING_DIR
        delta_watermark.PENDING_DIR = Path(self._dir.name)

    def tearDown(self):
        delta_watermark.PENDING_DIR = self._orig
        self._dir.cleanup()

    def test_defer_does_not_touch_db_until_advance(self):
        client = FakeClient()
        delta_watermark.defer("mechalol", "T1")
        delta_watermark.defer("wikipedia", "T2")
        self.assertEqual(client.calls, [])
        self.assertEqual(delta_watermark.advance_pending(client), 2)
        self.assertEqual(
            sorted(c[2][1] for c in client.calls), ["mechalol", "wikipedia"]
        )
        self.assertEqual(delta_watermark.advance_pending(client), 0)

    def test_advance_without_pending_files_does_nothing(self):
        client = FakeClient()
        self.assertEqual(delta_watermark.advance_pending(client), 0)
        self.assertEqual(client.calls, [])


if __name__ == "__main__":
    unittest.main()
