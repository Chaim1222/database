import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import log_db_size  # noqa: E402

MIB = 1024 * 1024


class FormatReportTest(unittest.TestCase):
    ROWS = [
        {"item": "small", "total_bytes": 1 * MIB, "table_bytes": 1 * MIB, "index_bytes": 0},
        {"item": "DATABASE", "total_bytes": 413 * MIB, "table_bytes": None, "index_bytes": None},
        {"item": "mechalol_pages", "total_bytes": 191 * MIB, "table_bytes": 94 * MIB, "index_bytes": 97 * MIB},
        {"item": "wikipedia_pages", "total_bytes": 129 * MIB, "table_bytes": 72 * MIB, "index_bytes": 57 * MIB},
    ]

    def test_database_total_and_table_order(self):
        out = log_db_size.format_report("peak", self.ROWS, top=2)
        self.assertIn("### גודל מסד: peak", out)
        self.assertIn("**סך הכול: 413.0 MiB**", out)
        self.assertLess(out.index("mechalol_pages"), out.index("wikipedia_pages"))
        self.assertNotIn("small", out)  # מחוץ ל-top

    def test_missing_database_row_does_not_crash(self):
        out = log_db_size.format_report("x", [r for r in self.ROWS if r["item"] != "DATABASE"])
        self.assertIn("**סך הכול: ? MiB**", out)


class MainTest(unittest.TestCase):
    def test_returns_zero_when_rpc_fails(self):
        # supabase_client.get_client ייצור לקוח מול localhost שלא קיים -> כשל רשת, עדיין exit 0
        self.assertEqual(log_db_size.main(["log_db_size.py", "x"]), 0)

    def test_usage_returns_zero(self):
        self.assertEqual(log_db_size.main(["log_db_size.py"]), 0)


if __name__ == "__main__":
    unittest.main()
