import os
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest import mock

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "x")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.modules.setdefault("supabase", types.SimpleNamespace(create_client=lambda *a, **k: None))

import weekly_build as weekly
import log_reconciliation_diff as audit


def state(phase):
    return {"build_id": "build-1", "phase": phase,
            "audit_id": 88 if weekly.PHASES.index(phase) >= 5 else None,
            "delta_watermarks": {"wikipedia": "2026-10-04T00:00:00Z"}}


class BuildRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.client = mock.Mock()
        self.runner = mock.Mock()
        self.current = state("matched")
        self.calls = []
        self.fail_step = None
        self.stack = mock.patch.object(weekly, "load_state", side_effect=lambda _: dict(self.current))
        self.stack.start()
        self.addCleanup(self.stack.stop)
        patch = mock.patch.object(weekly, "rpc_state", side_effect=self.rpc)
        patch.start()
        self.addCleanup(patch.stop)
        self.classify = mock.patch.object(audit, "classify_timing").start()
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(audit, "record_full_diff").start()

    def rpc(self, client, name, params):
        self.calls.append((name, params))
        if name == "begin_weekly_build":
            self.current = state("building")
        elif params["p_step"] == self.fail_step:
            raise RuntimeError("RPC failed")
        elif weekly.PHASES.index(params["p_step"]) > weekly.PHASES.index(self.current["phase"]):
            self.current = state(params["p_step"])
        return dict(self.current)

    def test_every_post_swap_resume_skips_fetch_match_gate_and_swap(self):
        for phase in weekly.PHASES[3:]:
            with self.subTest(phase=phase):
                self.current = state(phase)
                self.calls.clear()
                self.runner.reset_mock()
                weekly.build(self.client, resume=True, runner=self.runner)
                scripts = [c.args[0] for c in self.runner.call_args_list]
                self.assertFalse(set(scripts) & {"fetch_wikipedia.py", "fetch_mechalol.py", "match.py",
                                               "validate_before_swap.py", "forward_fill_enrichment.py"})
                # Resuming 'swapped' invokes one idempotent identity check.
                self.assertEqual(sum(p.get("p_step") == "swapped" for _, p in self.calls),
                                 1 if phase == "swapped" else 0)
                self.assertEqual(self.current["phase"], "complete")

    def test_matched_and_ready_resume_always_rerun_gate_before_swap(self):
        for phase in ("matched", "ready"):
            self.current = state(phase)
            self.runner.reset_mock()
            weekly.build(self.client, resume=True, runner=self.runner)
            self.runner.assert_any_call("validate_before_swap.py")
            self.assertFalse(any(c.args[0].startswith("fetch_") for c in self.runner.call_args_list))

    def test_building_cannot_resume(self):
        self.current = state("building")
        with self.assertRaisesRegex(RuntimeError, "fresh"):
            weekly.build(self.client, resume=True, runner=self.runner)
        self.runner.assert_not_called()

    def test_gate_failure_keeps_matched_and_never_swaps(self):
        def fail_gate(name, *args, **kwargs):
            if name == "validate_before_swap.py":
                raise RuntimeError("quality gate failed")
        self.runner.side_effect = fail_gate
        with self.assertRaises(RuntimeError):
            weekly.build(self.client, resume=True, runner=self.runner)
        self.assertEqual(self.current["phase"], "matched")
        self.assertFalse(any(p.get("p_step") == "swapped" for _, p in self.calls))

    def test_recompute_failure_retains_swapped_for_recovery(self):
        self.current = state("swapped")
        self.runner.side_effect = RuntimeError("recompute failed")
        with self.assertRaises(RuntimeError):
            weekly.build(self.client, resume=True, runner=self.runner)
        self.assertEqual(self.current["phase"], "swapped")

    def test_audit_failure_never_cleans(self):
        self.current = state("source_recomputed")
        self.fail_step = "audited"
        with self.assertRaises(RuntimeError):
            weekly.build(self.client, resume=True, runner=self.runner)
        self.assertEqual(self.current["phase"], "source_recomputed")
        self.assertFalse(any(p.get("p_step") == "cleaned" for _, p in self.calls))

    def test_full_diff_failure_does_not_block_cleanup_or_completion(self):
        mock.patch.stopall()
        self.calls.clear()
        mock.patch.object(weekly, "load_state", side_effect=lambda _: dict(self.current)).start()
        mock.patch.object(weekly, "rpc_state", side_effect=self.rpc).start()
        mock.patch.object(audit, "classify_timing").start()
        client = mock.MagicMock()
        client.rpc.return_value.execute.side_effect = RuntimeError("statement timeout")
        self.current = state("source_recomputed")
        weekly.build(client, resume=True, runner=self.runner)
        self.assertEqual(self.current["phase"], "complete")
        self.assertTrue(any(p.get("p_step") == "cleaned" for _, p in self.calls))
        full_diff_calls = [c for c in client.rpc.call_args_list if c.args[0] == "log_reconciliation_diff_all"]
        self.assertEqual(len(full_diff_calls), 1)  # בלי ניסיונות חוזרים

    def test_cleanup_failure_retains_audit_id(self):
        self.current = state("audited")
        self.fail_step = "cleaned"
        with self.assertRaises(RuntimeError):
            weekly.build(self.client, resume=True, runner=self.runner)
        self.assertEqual(self.current["phase"], "audited")
        self.assertEqual(self.current["audit_id"], 88)

    def test_classification_failure_reuses_audit_and_original_watermark(self):
        self.current = state("cleaned")
        self.classify.side_effect = RuntimeError("API unavailable")
        with self.assertRaises(RuntimeError):
            weekly.build(self.client, resume=True, runner=self.runner)
        self.assertEqual(self.current["phase"], "cleaned")
        self.classify.side_effect = None
        weekly.build(self.client, resume=True, runner=self.runner)
        self.assertEqual(self.classify.call_args.args[1], 88)
        self.assertEqual(str(self.classify.call_args.kwargs["watermarks"]["wikipedia"]),
                         "2026-10-04 00:00:00+00:00")

    def test_table_identity_validation_precedes_recovery_scripts(self):
        self.current = state("swapped")
        self.fail_step = "swapped"  # Initial resume identity check fails.
        with self.assertRaises(RuntimeError):
            weekly.build(self.client, resume=True, runner=self.runner)
        self.runner.assert_not_called()

    def test_fresh_build_preserves_delta_order_and_temp_environment(self):
        weekly.build(self.client, source="api", runner=self.runner)
        calls = self.runner.call_args_list
        self.assertEqual([c.args[0] for c in calls[:4]], ["fetch_mechalol_delta.py",
                         "fetch_wikipedia_delta.py", "match.py", "advance_delta_watermarks.py"])
        self.runner.assert_any_call("fetch_wikipedia.py", "--source", "api", temp=True)
        self.runner.assert_any_call("fetch_mechalol.py", temp=True)
        self.runner.assert_any_call("match.py", "--login", temp=True)


class WriterGuardTests(unittest.TestCase):
    def test_blocks_only_snapshot_sensitive_post_swap_phases(self):
        for phase in weekly.PHASES:
            with mock.patch.object(weekly, "load_state", return_value=state(phase)):
                if phase in {"swapped", "source_recomputed", "audited"}:
                    with self.assertRaises(RuntimeError):
                        weekly.check_writable(mock.Mock())
                else:
                    weekly.check_writable(mock.Mock())

    def test_only_missing_migration_can_bypass_guard(self):
        class DatabaseError(Exception):
            def __init__(self, code):
                self.code = code
        for code in ("PGRST205", "42P01", "42501", "57014"):
            with mock.patch.object(weekly, "load_state", side_effect=DatabaseError(code)):
                if code in {"PGRST205", "42P01"}:
                    weekly.check_writable(mock.Mock())
                else:
                    with self.assertRaises(DatabaseError):
                        weekly.check_writable(mock.Mock())


class RpcAndRunnerTests(unittest.TestCase):
    def test_lost_swap_response_retries_same_build_and_step(self):
        client = mock.Mock()
        client.rpc.return_value.execute.side_effect = [ConnectionError("lost response"),
                                                       types.SimpleNamespace(data=state("swapped"))]
        params = {"p_build_id": "build-1", "p_step": "swapped"}
        with mock.patch("supabase_client.time.sleep"):
            result = weekly.rpc_state(client, "advance_weekly_build", params)
        self.assertEqual(result["phase"], "swapped")
        self.assertEqual(client.rpc.call_args_list, [mock.call("advance_weekly_build", params)] * 2)

    def test_optional_failure_and_table_suffix_isolation(self):
        with mock.patch.object(weekly.subprocess, "run", return_value=types.SimpleNamespace(
                returncode=1, args=["script"])) as run, mock.patch.dict(os.environ, {"TARGET_TABLE_SUFFIX": "_temp"}):
            weekly.run_script("log_db_size.py", "before_fetch", optional=True)
            self.assertNotIn("TARGET_TABLE_SUFFIX", run.call_args.kwargs["env"])
            with self.assertRaises(subprocess.CalledProcessError):
                weekly.run_script("match.py", temp=True)
            self.assertEqual(run.call_args.kwargs["env"]["TARGET_TABLE_SUFFIX"], "_temp")


if __name__ == "__main__":
    unittest.main()
