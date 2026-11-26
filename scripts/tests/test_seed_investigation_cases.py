"""Safety tests for scripts/seed-investigation-cases.sh.

npx (for `supabase status`), docker and psql are replaced by fakes on PATH, so
these tests need no Supabase stack, Docker daemon or database. Each run gets a
PATH that holds only the fakes and the system programs the script is expected
to use, so a new dependency shows up here as a failure rather than on a
developer's machine. The SQL file's own guards are covered by
src/lib/metering/fixture/__tests__/seed-investigation-cases.test.ts and the
Test job's rehearsal.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "seed-investigation-cases.sh"
SEED_FILE = "supabase/scripts/seed-investigation-cases.sql"
DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
CONTAINER = "supabase_db_mgm"
SYSTEM_IDENTIFIER = "7700000000000000001"
SYSTEM_TOOLS = ["bash", "dirname", "env", "grep", "head", "tr", "wc"]
PG_VARIABLES = ["PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"]
# The Test workflow sets this, so that a missing shellcheck fails the gate
# instead of silently skipping the lint check.
REQUIRE_TOOLS = os.environ.get("MGM_TEST_REQUIRE_TOOLS") == "1"

# Each fake appends {"tool", "argv", "env"} to FAKE_LOG and answers from
# FAKE_* variables the test sets.
FAKE = f"""#!{sys.executable}
import json, os, sys
tool = os.path.basename(sys.argv[0])
args = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps({{
        "tool": tool,
        "argv": args,
        "env": {{k: os.environ[k] for k in {PG_VARIABLES!r} if k in os.environ}},
    }}) + "\\n")

def answer(name, default=""):
    value = os.environ.get(name, default)
    if value:
        print(value)

if tool == "npx":
    if os.environ.get("FAKE_STATUS_FAIL"):
        sys.exit(1)
    print('API_URL="http://127.0.0.1:54321"')
    if "FAKE_DB_URL" in os.environ:
        print('DB_URL="' + os.environ["FAKE_DB_URL"] + '"')
elif tool == "docker":
    if args[:1] == ["ps"]:
        answer("FAKE_CONTAINERS")
    elif args[:1] == ["exec"]:
        answer("FAKE_ID_INSIDE")
    else:
        sys.exit(64)
elif tool == "psql":
    if "-f" in args:
        sys.exit(int(os.environ.get("FAKE_SEED_EXIT", "0")))
    query = args[args.index("-c") + 1]
    if "system_identifier" in query:
        answer("FAKE_ID_BEHIND")
    elif "public.organizations" in query:
        answer("FAKE_ORG_COUNT", "2")
    elif "tgenabled" in query:
        answer("FAKE_TGENABLED", "O")
    else:
        sys.exit(64)
"""


def needs(*tools):
    """Skips a test whose tools are missing, unless the run requires them."""
    missing = [tool for tool in tools if not shutil.which(tool)]
    return unittest.skipIf(bool(missing) and not REQUIRE_TOOLS, f"not installed: {', '.join(missing)}")


class SeedInvestigationCasesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mgm-seed-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.fake_bin = self.tmp / "fake-bin"
        self.system_bin = self.tmp / "system-bin"
        for directory in (self.fake_bin, self.system_bin):
            directory.mkdir()
        for tool in SYSTEM_TOOLS:
            found = shutil.which(tool)
            if found:
                (self.system_bin / tool).symlink_to(found)
        (self.system_bin / "python3").symlink_to(sys.executable)
        for tool in ("npx", "docker", "psql"):
            path = self.fake_bin / tool
            path.write_text(FAKE)
            path.chmod(0o755)
        self.log = self.tmp / "calls.jsonl"

    def run_script(self, *args, env=None):
        environment = {
            "PATH": f"{self.fake_bin}{os.pathsep}{self.system_bin}",
            "HOME": str(self.tmp),
            "LC_ALL": "C",
            "FAKE_LOG": str(self.log),
            "FAKE_DB_URL": DB_URL,
            "FAKE_CONTAINERS": CONTAINER,
            "FAKE_ID_INSIDE": SYSTEM_IDENTIFIER,
            "FAKE_ID_BEHIND": SYSTEM_IDENTIFIER,
        }
        for key, value in (env or {}).items():
            if value is None:
                environment.pop(key, None)
            else:
                environment[key] = value
        return subprocess.run(
            [str(SCRIPT), *args], capture_output=True, text=True, env=environment, timeout=60
        )

    def calls(self, tool=None):
        if not self.log.exists():
            return []
        entries = [json.loads(line) for line in self.log.read_text().splitlines()]
        return [e for e in entries if tool is None or e["tool"] == tool]

    def seed_calls(self):
        return [c for c in self.calls("psql") if "-f" in c["argv"]]

    def assert_refused_before_database(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Refusing", result.stderr)
        self.assertEqual(self.calls("psql"), [])
        self.assertEqual(self.calls("docker"), [])

    def test_requires_the_disposable_flag(self):
        for args in ([], ["--yes"], ["--disposable", "--disposable"], ["--disposable=1"]):
            with self.subTest(args=args):
                result = self.run_script(*args)
                self.assertEqual(result.returncode, 2)
                self.assertIn("Usage:", result.stderr)
                self.assertEqual(self.calls(), [])

    def test_refuses_when_status_fails_or_prints_no_url(self):
        for env in ({"FAKE_STATUS_FAIL": "1"}, {"FAKE_DB_URL": None}, {"FAKE_DB_URL": ""}):
            with self.subTest(env=env):
                result = self.run_script("--disposable", env=env)
                self.assert_refused_before_database(result)

    def test_refuses_every_url_but_a_single_loopback_postgres_uri(self):
        bad = {
            "not-a-uri": "is not a postgres URI",
            "http://postgres:postgres@127.0.0.1:54322/postgres": "is not a postgres URI",
            "postgresql://postgres:postgres@127.0.0.1,10.0.0.1:54322/postgres": "names more than one host",
            "postgresql://postgres:postgres@10.0.0.1:54322/postgres": "loopback",
            "postgresql://postgres:postgres@db.example.invalid:54322/postgres": "loopback",
            "postgresql://postgres:postgres@%31%32%37.0.0.1:54322/postgres": "loopback",
            "postgresql://postgres:postgres@127.0.0.1:99999/postgres": "invalid port",
            "postgresql://postgres:postgres@127.0.0.1:port/postgres": "invalid port",
            "postgresql://postgres:postgres@127.0.0.1:54322/postgres?host=10.0.0.1": "connection parameters",
            "postgresql://postgres:postgres@127.0.0.1:54322/postgres#x": "connection parameters",
            "postgresql:///postgres?host=127.0.0.1": "is not a postgres URI",
        }
        for url, reason in bad.items():
            with self.subTest(url=url):
                if self.log.exists():
                    self.log.unlink()
                result = self.run_script("--disposable", env={"FAKE_DB_URL": url})
                self.assert_refused_before_database(result)
                self.assertIn(reason, result.stderr)

    def test_accepts_each_loopback_host(self):
        for url in (
            DB_URL,
            "postgres://postgres:postgres@localhost:54322/postgres",
            "postgresql://postgres:postgres@[::1]:54322/postgres",
        ):
            with self.subTest(url=url):
                if self.log.exists():
                    self.log.unlink()
                result = self.run_script("--disposable", env={"FAKE_DB_URL": url})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(self.seed_calls()), 1)
                self.assertIn(url, self.seed_calls()[0]["argv"])

    def test_asks_docker_for_the_container_publishing_the_urls_port(self):
        result = self.run_script("--disposable")
        self.assertEqual(result.returncode, 0, result.stderr)
        ps, execute = self.calls("docker")
        self.assertEqual(ps["argv"][0], "ps")
        self.assertIn("publish=54322", ps["argv"])
        self.assertIn("name=supabase_db_", ps["argv"])
        self.assertEqual(execute["argv"][:2], ["exec", CONTAINER])
        self.assertIn("SELECT system_identifier FROM pg_control_system()", execute["argv"])
        behind = [c for c in self.calls("psql") if "system_identifier" in " ".join(c["argv"])]
        self.assertEqual(len(behind), 1)
        self.assertIn(DB_URL, behind[0]["argv"])

    def test_refuses_unless_exactly_one_container_publishes_the_port(self):
        for containers in ("", f"{CONTAINER}\nsupabase_db_other"):
            with self.subTest(containers=containers):
                if self.log.exists():
                    self.log.unlink()
                result = self.run_script("--disposable", env={"FAKE_CONTAINERS": containers})
                self.assertEqual(result.returncode, 1)
                self.assertIn("no single supabase_db_* container", result.stderr)
                self.assertEqual(self.calls("psql"), [])

    def test_refuses_a_database_that_is_not_the_containers(self):
        for env in (
            {"FAKE_ID_BEHIND": "7700000000000000002"},
            {"FAKE_ID_INSIDE": "", "FAKE_ID_BEHIND": ""},
            {"FAKE_ID_INSIDE": ""},
        ):
            with self.subTest(env=env):
                if self.log.exists():
                    self.log.unlink()
                result = self.run_script("--disposable", env=env)
                self.assertEqual(result.returncode, 1)
                self.assertIn("is not the one in container", result.stderr)
                self.assertEqual(self.seed_calls(), [])

    def test_runs_the_seed_in_one_transaction_without_psqlrc_or_pg_variables(self):
        hostile = {name: "10.0.0.1" for name in PG_VARIABLES}
        result = self.run_script("--disposable", env=hostile)
        self.assertEqual(result.returncode, 0, result.stderr)
        psql = self.calls("psql")
        self.assertGreaterEqual(len(psql), 4)
        for call in psql:
            self.assertEqual(call["argv"][0], "-X")
            self.assertEqual(call["argv"][1], DB_URL)
            self.assertEqual(call["env"], {})
        (seed,) = self.seed_calls()
        argv = seed["argv"]
        self.assertIn("--single-transaction", argv)
        self.assertEqual(argv[argv.index("-f") + 1], SEED_FILE)
        options = [argv[k + 1] for k, value in enumerate(argv) if value == "-v"]
        self.assertIn("disposable=1", options)
        self.assertIn("ON_ERROR_STOP=1", options)
        self.assertIn("Done.", result.stdout)

    def test_stops_when_the_seed_fails(self):
        result = self.run_script("--disposable", env={"FAKE_SEED_EXIT": "3"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.calls("psql")), 2)
        self.assertNotIn("Done.", result.stdout)

    def test_fails_when_the_organizations_were_not_written(self):
        for count in ("0", "1", ""):
            with self.subTest(count=count):
                result = self.run_script("--disposable", env={"FAKE_ORG_COUNT": count})
                self.assertEqual(result.returncode, 1)
                self.assertIn("did not write organizations A and B", result.stderr)
                self.assertNotIn("Done.", result.stdout)

    def test_fails_when_the_component_id_trigger_is_not_enabled(self):
        for state in ("D", "R", "A", ""):
            with self.subTest(state=state):
                result = self.run_script("--disposable", env={"FAKE_TGENABLED": state})
                self.assertEqual(result.returncode, 1)
                self.assertIn("trg_device_openems_component_valid is not enabled", result.stderr)
                self.assertNotIn("Done.", result.stdout)

    @needs("shellcheck")
    def test_shellcheck_clean(self):
        self.assertTrue(shutil.which("shellcheck"), "shellcheck is required but not installed")
        result = subprocess.run(["shellcheck", str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
