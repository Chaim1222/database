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


class WorkflowCompletionTests(unittest.TestCase):
    def test_optional_failure_is_reported_after_all_work(self):
        import subprocess
        import tempfile
        import os
        from pathlib import Path
        source = (Path(__file__).resolve().parents[2] / '.github/workflows/maintenance_refresh.yml').read_text()
        block = source.split('          status=failed\n', 1)[1].split('\n      - name:', 1)[0]
        script = 'status=failed\n' + '\n'.join(line[10:] for line in block.splitlines())
        # Capture the final status instead of touching Supabase.
        script = 'python() { echo "$2" > "$FIXTURE_STATUS"; }\n' + script
        for job, moves, locks, expected in [('success','success','success','success'),
                                          ('success','failure','success','failed'),
                                          ('success','success','failure','failed'),
                                          ('failure','skipped','skipped','failed')]:
            with self.subTest(job=job, moves=moves, locks=locks), tempfile.TemporaryDirectory() as tmp:
                env = dict(os.environ, REFRESH_JOB_STATUS=job, MOVE_SOURCES_OUTCOME=moves, LOCKS_OUTCOME=locks,
                           GITHUB_STEP_SUMMARY=tmp+'/summary', FIXTURE_STATUS=tmp+'/status')
                result = subprocess.run(['bash','-e','-c',script], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(Path(tmp+'/status').read_text().strip(), expected)
                self.assertIn('Move-source verification: '+moves, Path(tmp+'/summary').read_text())
