import unittest

from refresh_maintenance_tables import summarize


class SummarizeTest(unittest.TestCase):
    def test_dry_run_and_manual_rows(self):
        report = {
            "applied": False,
            "rev_link_check": {"total": 880, "stale": {"page_gone": 5, "rev_changed": 29}},
            "blacklist_titles": {"total": 2233, "stale": {}, "manual_stale_not_deleted": ["x"]},
            "manual_matches": {"total": 77, "stale": {}},
        }
        lines = summarize(report)
        self.assertIn("מיותרות 34", lines[0])
        self.assertTrue(any("ידניות" in line and "['x']" in line for line in lines))
        self.assertFalse(any(line.startswith("נמחקו") for line in lines))

    def test_applied_shows_deleted(self):
        lines = summarize({"applied": True, "deleted": {"rev_link_check": 34}})
        self.assertEqual(lines[-1], "נמחקו: {'rev_link_check': 34}")


if __name__ == "__main__":
    unittest.main()
