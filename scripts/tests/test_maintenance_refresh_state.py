import unittest
from datetime import datetime, timezone

from maintenance_refresh_state import fields_for

NOW = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc)


class FieldsForTest(unittest.TestCase):
    def test_start_clears_finish(self):
        fields = fields_for("running", NOW)
        self.assertEqual(fields["status"], "running")
        self.assertIsNone(fields["finished_at"])
        self.assertEqual(fields["started_at"], NOW.isoformat())

    def test_finish_keeps_start(self):
        fields = fields_for("failed", NOW)
        self.assertEqual(fields["status"], "failed")
        self.assertNotIn("started_at", fields)
        self.assertEqual(fields["finished_at"], NOW.isoformat())


if __name__ == "__main__":
    unittest.main()
