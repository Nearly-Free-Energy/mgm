import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("maintenance", Path(__file__).parents[1] / "credential-key-maintenance.py")
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


class MaintenanceTests(unittest.TestCase):
    def run_cli(self, args, code=0):
        output = io.StringIO()
        key = "synthetic-'replacement-key-" * 2
        with patch.dict("os.environ", {"PGSERVICE": "test-maintenance"}), \
             patch.object(maintenance.getpass, "getpass", return_value=key), \
             patch.object(maintenance.subprocess, "run", return_value=SimpleNamespace(returncode=code, stderr=key)) as run, \
             redirect_stdout(output), redirect_stderr(output):
            result = maintenance.main(args)
        return result, output.getvalue(), run, key

    def test_rotation_defaults_to_rollback_and_keeps_key_out_of_argv(self):
        result, output, run, key = self.run_cli(["rotate"])
        self.assertEqual(result, 0)
        self.assertNotIn(key, str(run.call_args.args))
        self.assertNotIn(key, output)
        self.assertTrue(run.call_args.kwargs["input"].endswith("ROLLBACK;\n"))
        self.assertIn("synthetic-''replacement-key-", run.call_args.kwargs["input"])

    def test_rotation_commit_requires_both_acknowledgments(self):
        with patch.object(maintenance.subprocess, "run") as run, redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                maintenance.main(["rotate", "--commit"])
            run.assert_not_called()

    def test_explicit_commit_and_failure_output(self):
        result, output, run, key = self.run_cli(["rotate", "--commit", "--credential-writes-paused", "--backup-confirmed"], code=1)
        self.assertEqual(result, 1)
        self.assertNotIn(key, output)
        self.assertTrue(run.call_args.kwargs["input"].endswith("COMMIT;\n"))

    def test_retirement_uses_the_validating_helper(self):
        result, _, run, _ = self.run_cli(["retire"])
        self.assertEqual(result, 0)
        self.assertIn("SELECT pg_temp.mgm_retire_legacy_credential_key();", run.call_args.kwargs["input"])

    def test_retirement_commit_keeps_rotation_acknowledgments_separate(self):
        result, _, run, _ = self.run_cli(["retire", "--commit"])
        self.assertEqual(result, 0)
        self.assertTrue(run.call_args.kwargs["input"].endswith("COMMIT;\n"))
        self.assertIn("SELECT pg_temp.mgm_retire_legacy_credential_key();", run.call_args.kwargs["input"])


if __name__ == "__main__":
    unittest.main()
