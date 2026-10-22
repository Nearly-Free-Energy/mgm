"""Safety tests for scripts/backup/export-database.sh.

pg_dump, pg_dumpall and age are replaced by fakes on PATH, so these tests need
no database or key material; some tests also replace sha256sum, shasum or wc
to make a checksum or size fail. Each run gets a PATH that holds only the fakes
and the system programs the script is expected to use, so a new dependency
shows up here as a failure rather than on an operator's host.
"""
from datetime import datetime, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "backup" / "export-database.sh"
DUMP_FILES = ["roles.sql", "schema.sql", "data.sql", "history_schema.sql", "history_data.sql"]
SECRET_PASSWORD = "s3cret-Pa55word"
DB_URL = f"postgresql://export_user:{SECRET_PASSWORD}@db.example.invalid:5432/postgres"
DB_URL_WITHOUT_PASSWORD = "postgresql://export_user@db.example.invalid:5432/postgres"
EXPORT_NAME = re.compile(r"^mgm-db-export-\d{8}T\d{6}Z$")
ENCRYPTED_NAME = re.compile(r"^mgm-db-export-\d{8}T\d{6}Z\.tar\.gz\.age$")
UTC_TIME = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"
SYSTEM_TOOLS = ["bash", "awk", "sed", "date", "mkdir", "mktemp", "mv", "rm", "wc", "tar", "gzip", "sha256sum", "shasum"]
# The Test workflow sets this, so that a missing age or shellcheck fails the
# gate instead of silently skipping the real-encryption and lint checks.
REQUIRE_TOOLS = os.environ.get("MGM_TEST_REQUIRE_TOOLS") == "1"

MANAGED_SCHEMAS = (
    "information_schema|pg_*|_analytics|_realtime|_supavisor|auth|etl|extensions|pgbouncer|realtime|storage|"
    "supabase_functions|supabase_migrations|cron|dbdev|graphql|graphql_public|net|pgmq|pgsodium|pgsodium_masks|"
    "pgtle|repack|tiger|tiger_data|timescaledb_*|_timescaledb_*|topology|vault"
)
# The data dump reads these schemas and nothing else: in particular not cron
# or net, whose rows would start jobs and replay requests in a restored copy.
DATA_SCHEMAS = ["public", "auth", "storage", "supabase_functions"]
# Platform ledgers and Storage's vector tables, then Auth's session state,
# second factors and pending sign-in state, which must never reach an export,
# and Auth's custom OAuth providers, which hold client secrets. Auth's OAuth
# clients, OAuth consents and WebAuthn credentials are exported, so they are
# not here.
DATA_EXCLUDED_TABLES = [
    "auth.schema_migrations", "storage.migrations", "supabase_functions.migrations",
    "storage.buckets_vectors", "storage.vector_indexes",
    "auth.sessions", "auth.refresh_tokens", "auth.mfa_factors", "auth.mfa_challenges", "auth.mfa_amr_claims",
    "auth.flow_state", "auth.one_time_tokens", "auth.saml_relay_states",
    "auth.oauth_authorizations", "auth.oauth_client_states", "auth.webauthn_challenges",
    "auth.custom_oauth_providers",
]

# What the fake programs print. They follow pg_dump's and pg_dumpall's plain
# output closely enough to exercise every filter the script applies.
ROLES_SAMPLE = """\
--
-- PostgreSQL database cluster dump
--

\\restrict cafe01

SET default_transaction_read_only = off;

CREATE ROLE "postgres";
ALTER ROLE "postgres" WITH NOSUPERUSER INHERIT CREATEROLE CREATEDB LOGIN NOREPLICATION BYPASSRLS;
CREATE ROLE "supabase_auth_admin";
CREATE ROLE "mgm_reporting";
ALTER ROLE "mgm_reporting" WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION BYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE "mgm_reporting" SET "default_transaction_read_only" TO 'on';
ALTER ROLE "authenticator" SET "pgrst.db_schemas" TO 'public, graphql_public';
ALTER ROLE "authenticator" SET "search_path" TO 'public';
GRANT "pg_read_all_data" TO "service_role" GRANTED BY "supabase_admin";
GRANT "authenticated" TO "mgm_custom" GRANTED BY "postgres";
GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";
GRANT SET ON PARAMETER "work_mem" TO "mgm_custom";

\\unrestrict cafe01
"""

ROLES_EXPECTED = """\
--
-- PostgreSQL database cluster dump
--

-- \\restrict cafe01

SET default_transaction_read_only = off;

-- CREATE ROLE "postgres";
-- ALTER ROLE "postgres" WITH INHERIT CREATEROLE CREATEDB LOGIN BYPASSRLS;
-- CREATE ROLE "supabase_auth_admin";
CREATE ROLE "mgm_reporting";
ALTER ROLE "mgm_reporting" WITH INHERIT NOCREATEROLE NOCREATEDB LOGIN BYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE "mgm_reporting" SET "default_transaction_read_only" TO 'on';
ALTER ROLE "authenticator" SET "pgrst.db_schemas" TO 'public, graphql_public';
-- ALTER ROLE "authenticator" SET "search_path" TO 'public';
-- GRANT "pg_read_all_data" TO "service_role" GRANTED BY "supabase_admin";
GRANT "authenticated" TO "mgm_custom" GRANTED BY "postgres";
-- GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";
GRANT SET ON PARAMETER "work_mem" TO "mgm_custom";

-- \\unrestrict cafe01
"""

SCHEMA_SAMPLE = """\
\\restrict beef02
SET transaction_timeout = 0;
CREATE SCHEMA "supabase_migrations";
CREATE EXTENSION IF NOT EXISTS "pgsodium" WITH SCHEMA "pgsodium";
COMMENT ON EXTENSION "pg_net" IS 'Async HTTP';
CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";
CREATE FUNCTION "public"."fn_example"() RETURNS integer
    LANGUAGE "sql"
    AS $$
-- a comment inside a function body stays
SELECT 1
$$;
CREATE TABLE "public"."households" (
    "id" "uuid" NOT NULL
);
CREATE SEQUENCE "public"."invoice_seq";
CREATE VIEW "public"."v_example" AS SELECT 1;
CREATE TRIGGER "trg_example" AFTER INSERT ON "public"."households" FOR EACH ROW EXECUTE FUNCTION "public"."fn_example"();
CREATE EVENT TRIGGER "issue_pg_cron_access" ON "ddl_command_end"
         WHEN TAG IN ('CREATE EXTENSION')
   EXECUTE FUNCTION "extensions"."grant_pg_cron_access"();
ALTER EVENT TRIGGER "issue_pg_cron_access" OWNER TO "supabase_admin";
CREATE PUBLICATION "supabase_realtime" WITH (publish = 'insert, update, delete, truncate');
ALTER PUBLICATION "supabase_realtime_messages_publication" OWNER TO "supabase_admin";
ALTER FOREIGN DATA WRAPPER "wrapper" OWNER TO "supabase_admin";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
GRANT ALL ON FOREIGN DATA WRAPPER "wrapper" TO "postgres" WITH GRANT OPTION;
GRANT USAGE ON SCHEMA "supabase_migrations" TO "postgres";
REVOKE ALL ON FUNCTION "extensions"."grant_pg_cron_access"() FROM PUBLIC;
GRANT USAGE ON SCHEMA "public" TO "anon";
CREATE POLICY "cron_job_policy" ON "cron"."job" USING (true);
ALTER TABLE "cron"."job" ENABLE ROW LEVEL SECURITY;
\\unrestrict beef02
"""

SCHEMA_EXPECTED_HEAD = """\
-- \\restrict beef02
-- SET transaction_timeout = 0;
CREATE SCHEMA IF NOT EXISTS "supabase_migrations";
CREATE EXTENSION IF NOT EXISTS "pgsodium";
-- COMMENT ON EXTENSION "pg_net" IS 'Async HTTP';
CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";
CREATE OR REPLACE FUNCTION "public"."fn_example"() RETURNS integer
    LANGUAGE "sql"
    AS $$
-- a comment inside a function body stays
SELECT 1
$$;
CREATE TABLE IF NOT EXISTS "public"."households" (
    "id" "uuid" NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS "public"."invoice_seq";
CREATE OR REPLACE VIEW "public"."v_example" AS SELECT 1;
CREATE OR REPLACE TRIGGER "trg_example" AFTER INSERT ON "public"."households" FOR EACH ROW EXECUTE FUNCTION "public"."fn_example"();
-- CREATE EVENT TRIGGER "issue_pg_cron_access" ON "ddl_command_end"
--          WHEN TAG IN ('CREATE EXTENSION')
--    EXECUTE FUNCTION "extensions"."grant_pg_cron_access"();
-- ALTER EVENT TRIGGER "issue_pg_cron_access" OWNER TO "supabase_admin";
-- CREATE PUBLICATION "supabase_realtime" WITH (publish = 'insert, update, delete, truncate');
-- ALTER PUBLICATION "supabase_realtime_messages_publication" OWNER TO "supabase_admin";
-- ALTER FOREIGN DATA WRAPPER "wrapper" OWNER TO "supabase_admin";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
-- GRANT ALL ON FOREIGN DATA WRAPPER "wrapper" TO "postgres" WITH GRANT OPTION;
"""

# The main schema dump comments out grants on Supabase-managed schemas; the
# migration-history dump has no such list, so it keeps them.
SCHEMA_EXPECTED_GRANTS = """\
-- GRANT USAGE ON SCHEMA "supabase_migrations" TO "postgres";
-- REVOKE ALL ON FUNCTION "extensions"."grant_pg_cron_access"() FROM PUBLIC;
GRANT USAGE ON SCHEMA "public" TO "anon";
"""
HISTORY_SCHEMA_EXPECTED_GRANTS = """\
GRANT USAGE ON SCHEMA "supabase_migrations" TO "postgres";
REVOKE ALL ON FUNCTION "extensions"."grant_pg_cron_access"() FROM PUBLIC;
GRANT USAGE ON SCHEMA "public" TO "anon";
"""

SCHEMA_EXPECTED_TAIL = """\
-- CREATE POLICY "cron_job_policy" ON "cron"."job" USING (true);
-- ALTER TABLE "cron"."job" ENABLE ROW LEVEL SECURITY;
-- \\unrestrict beef02
"""

DATA_SAMPLE = """\
\\restrict f00d03
--
-- PostgreSQL database dump
--

-- Dumped from database version {server_version}
-- Dumped by pg_dump version 17.6

COPY "public"."households" ("id") FROM stdin;
00000000-0000-0000-0000-000000000001
\\.

\\unrestrict f00d03
"""

FAKE_PG = f"""#!{sys.executable}
import json, os, sys, time
program = os.path.basename(sys.argv[0])
args = sys.argv[1:]
if args == ["--version"]:
    print(os.environ.get("FAKE_PG_VERSION", program + " (PostgreSQL) 17.6"))
    sys.exit(0)
record = {{"program": program, "argv": args, "PGPASSWORD": os.environ.get("PGPASSWORD"), "time": time.time()}}
watch = os.environ.get("FAKE_PG_WATCH")
if watch:
    record["watched"] = sorted(os.listdir(watch))
with open(os.environ["FAKE_PG_LOG"], "a") as log:
    log.write(json.dumps(record) + "\\n")
dbname = next(arg.split("=", 1)[1] for arg in args if arg.startswith("--dbname="))
flags = " ".join(arg for arg in args if not arg.startswith("--dbname="))
password = os.environ.get("PGPASSWORD", "")
# Chatter that repeats the connection string and the password, to prove the
# script never passes the programs' output through unredacted.
sys.stderr.write("connecting to " + dbname + " with password " + password + "\\n")
if os.environ.get("FAKE_PG_FAIL_ON", "\\0") in flags:
    sys.stderr.write(program + ": error: connection to " + dbname + " (password " + password + ") failed: password authentication failed\\n")
    sys.exit(1)
if os.environ.get("FAKE_PG_EMPTY_ON", "\\0") in flags:
    sys.exit(0)
kind = "roles" if "--roles-only" in args else "schema" if "--schema-only" in args else "data"
with open(os.path.join(os.environ["FAKE_PG_SAMPLES"], kind + ".sql")) as sample:
    text = sample.read()
sys.stdout.write(text.replace("{{server_version}}", os.environ.get("FAKE_PG_SERVER_VERSION", "17.6")))
sys.stdout.flush()
if os.environ.get("FAKE_PG_DELAY_ON", "\\0") in flags:
    time.sleep(float(os.environ["FAKE_PG_DELAY"]))
if os.environ.get("FAKE_PG_HANG_ON", "\\0") in flags:
    with open(os.environ["FAKE_PG_READY"], "w") as ready:
        ready.write("dumping\\n")
    time.sleep(120)
"""

FAKE_AGE = f"""#!{sys.executable}
import json, os, sys, time
args = sys.argv[1:]
with open(os.environ["FAKE_AGE_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
data = sys.stdin.buffer.read()
output = args[args.index("-o") + 1]
if output == "/dev/null":
    # The script's recipients check: parse the file, encrypt nothing.
    with open(args[args.index("-R") + 1]) as recipients:
        if "invalid" in recipients.read():
            sys.stderr.write("age: error: malformed recipient at line 1\\n")
            sys.exit(1)
    sys.exit(0)
mode = os.environ.get("FAKE_AGE_MODE", "ok")
if mode == "fail":
    sys.stderr.write("age: error: simulated failure\\n")
    sys.exit(1)
header = b"not an age file\\n" if mode == "garbage" else b"age-encryption.org/v1\\n"
with open(output, "wb") as out:
    out.write(header + data)
    if mode == "hang":
        out.flush()
        with open(os.environ["FAKE_AGE_READY"], "w") as ready:
            ready.write("encrypting\\n")
        time.sleep(120)
"""

# Stand-ins for sha256sum and `wc -c` that answer correctly for the first
# FAKE_GOOD_CALLS calls and then misbehave as FAKE_MODE says: fail with or
# without output, or succeed with output that is not a usable result.
FAKE_MEASURE = f"""#!{sys.executable}
import hashlib, os, sys
program = os.path.basename(sys.argv[0])
data = sys.stdin.buffer.read()
counter = os.environ["FAKE_COUNTER"]
calls = int(open(counter).read()) if os.path.exists(counter) else 0
with open(counter, "w") as file:
    file.write(str(calls + 1))
if program == "sha256sum":
    digest = hashlib.sha256(data).hexdigest()
    good = digest + "  -\\n"
    bad = {{
        "empty": "",
        "short": digest[:63] + "  -\\n",
        "long": digest + "0  -\\n",
        "uppercase": digest.upper() + "  -\\n",
        "not-hex": "g" * 64 + "  -\\n",
    }}
else:
    good = "%8d\\n" % len(data)
    bad = {{"empty": "\\n", "not-a-number": "  many\\n"}}
if calls < int(os.environ.get("FAKE_GOOD_CALLS", "0")):
    sys.stdout.write(good)
    sys.exit(0)
mode = os.environ["FAKE_MODE"]
if mode == "fail":
    sys.stderr.write(program + ": -: Input/output error\\n")
    sys.exit(1)
if mode == "fail-after-output":
    sys.stdout.write(good)
    sys.exit(1)
sys.stdout.write(bad[mode])
"""


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def extract(payload, destination):
    """Extracts a gzipped tarball held in memory and returns its member names."""
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        names = archive.getnames()
        if hasattr(tarfile, "data_filter"):
            archive.extractall(destination, filter="data")
        else:
            archive.extractall(destination)
    return names


def needs(*tools):
    """Skips a test whose tools are missing, unless the run requires them."""
    missing = [tool for tool in tools if not shutil.which(tool)]
    return unittest.skipIf(bool(missing) and not REQUIRE_TOOLS, f"not installed: {', '.join(missing)}")


def quoted(table):
    schema, name = table.split(".", 1)
    return f'"{schema}"."{name}"'


def utc_seconds(text):
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


def finished_process_id():
    """The ID of a process that has exited, as a killed export's would be."""
    process = subprocess.Popen([sys.executable, "-c", ""])
    process.wait()
    return process.pid


class ExportDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mgm-export-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.fake_bin = self.tmp / "fake-bin"
        self.system_bin = self.tmp / "system-bin"
        self.staging_tmp = self.tmp / "tmpdir"
        self.samples = self.tmp / "samples"
        for directory in (self.fake_bin, self.system_bin, self.staging_tmp, self.samples):
            directory.mkdir()
        for tool in SYSTEM_TOOLS:
            found = shutil.which(tool)
            if found:
                (self.system_bin / tool).symlink_to(found)
        self.write_fake("pg_dump", FAKE_PG)
        self.write_fake("pg_dumpall", FAKE_PG)
        self.write_fake("age", FAKE_AGE)
        (self.samples / "roles.sql").write_text(ROLES_SAMPLE)
        (self.samples / "schema.sql").write_text(SCHEMA_SAMPLE)
        (self.samples / "data.sql").write_text(DATA_SAMPLE)
        self.pg_log = self.tmp / "pg.jsonl"
        self.age_log = self.tmp / "age.jsonl"
        self.out = self.tmp / "exports"
        self.recipients = self.tmp / "recipients.txt"
        self.recipients.write_text("# backup key\nage1examplepublicrecipientonlyforthetestsxxxxxxxxxxxxxxxxxxxxxx\n")

    def write_fake(self, name, source):
        path = self.fake_bin / name
        path.write_text(source)
        path.chmod(0o755)

    def environment(self, env=None):
        environment = {
            "PATH": f"{self.fake_bin}{os.pathsep}{self.system_bin}",
            "HOME": str(self.tmp),
            "TMPDIR": str(self.staging_tmp),
            "LC_ALL": "C",
            "FAKE_PG_LOG": str(self.pg_log),
            "FAKE_PG_SAMPLES": str(self.samples),
            "FAKE_AGE_LOG": str(self.age_log),
            "MGM_EXPORT_DB_URL": DB_URL,
        }
        for key, value in (env or {}).items():
            if value is None:
                environment.pop(key, None)
            else:
                environment[key] = value
        return environment

    def run_script(self, *args, env=None, trace=False, secrets=()):
        command = [str(self.system_bin / "bash"), "-x", str(SCRIPT)] if trace else [str(SCRIPT)]
        result = subprocess.run(
            command + list(args), env=self.environment(env), capture_output=True, text=True, timeout=120
        )
        output = result.stdout + result.stderr
        for secret in (SECRET_PASSWORD, DB_URL, *secrets):
            self.assertNotIn(secret, output)
        return result

    def export(self, *extra, env=None, secrets=()):
        """Runs an export with only the arguments given after --db-url-env and --out."""
        return self.run_script(
            "--db-url-env", "MGM_EXPORT_DB_URL", "--out", str(self.out), *extra, env=env, secrets=secrets
        )

    def export_plaintext(self, *extra, env=None, secrets=()):
        return self.export("--plaintext", *extra, env=env, secrets=secrets)

    def export_encrypted(self, *extra, env=None, secrets=()):
        return self.export("--age-recipients", str(self.recipients), *extra, env=env, secrets=secrets)

    def pg_records(self):
        if not self.pg_log.exists():
            return []
        return [json.loads(line) for line in self.pg_log.read_text().splitlines()]

    def pg_calls(self):
        return [(record["program"], record["argv"]) for record in self.pg_records()]

    def age_calls(self):
        if not self.age_log.exists():
            return []
        return [json.loads(line) for line in self.age_log.read_text().splitlines()]

    def plaintext_export(self, env=None):
        result = self.export_plaintext(env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        entries = os.listdir(self.out)
        self.assertEqual(len(entries), 1, entries)
        return result, self.out / entries[0]

    def assert_manifest(self, export_dir):
        manifest = json.loads((export_dir / "manifest.json").read_text())
        self.assertEqual(manifest["format"], "mgm-database-export/1")
        self.assertRegex(manifest["created_utc"], UTC_TIME)
        self.assertRegex(manifest["data_dump_started_utc"], UTC_TIME)
        self.assertLessEqual(utc_seconds(manifest["created_utc"]), utc_seconds(manifest["data_dump_started_utc"]))
        self.assertEqual([entry["name"] for entry in manifest["files"]], DUMP_FILES)
        for entry in manifest["files"]:
            path = export_dir / entry["name"]
            self.assertEqual(entry["bytes"], path.stat().st_size)
            self.assertEqual(entry["sha256"], sha256(path))
        return manifest

    # --- arguments ---------------------------------------------------------

    def test_help_describes_the_interface(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("--db-url-env <ENV_VAR_NAME> --out <dir> (--age-recipients <file> | --plaintext)", result.stdout)
        self.assertIn("Exactly one of --age-recipients and --plaintext is required.", result.stdout)

    def test_an_export_without_a_mode_is_refused(self):
        # Leaving --age-recipients off must not quietly produce plaintext.
        result = self.export()
        self.assertEqual(result.returncode, 2)
        self.assertIn("choose --age-recipients <file> to encrypt the export, or --plaintext", result.stderr)
        self.assertIn("--help", result.stderr)
        self.assertEqual(self.pg_calls(), [])
        self.assertEqual(self.age_calls(), [])
        self.assertFalse(self.out.exists())

    def test_encryption_and_plaintext_together_are_refused(self):
        cases = {
            "both": (["--age-recipients", str(self.recipients), "--plaintext"], "cannot be used together"),
            "both, plaintext first": (["--plaintext", "--age-recipients", str(self.recipients)], "cannot be used together"),
            "plaintext twice": (["--plaintext", "--plaintext"], "--plaintext given more than once"),
            "plaintext with a value": (["--plaintext=yes"], "unknown argument: --plaintext"),
        }
        for label, (args, message) in cases.items():
            with self.subTest(label):
                result = self.export(*args)
                self.assertEqual(result.returncode, 2)
                self.assertIn(message, result.stderr)
        self.assertEqual(self.pg_calls(), [])
        self.assertEqual(self.age_calls(), [])
        self.assertFalse(self.out.exists())

    def test_required_arguments(self):
        cases = [
            [],
            ["--out", str(self.out)],
            ["--db-url-env", "MGM_EXPORT_DB_URL"],
            ["--db-url-env", "MGM_EXPORT_DB_URL", "--out"],
            ["--db-url-env", "--out", str(self.out)],
            ["--db-url-env", "MGM_EXPORT_DB_URL", "--out", str(self.out), "--out", str(self.out)],
        ]
        for args in cases:
            with self.subTest(args=args):
                result = self.run_script(*args)
                self.assertEqual(result.returncode, 2)
                self.assertIn("--help", result.stderr)
        self.assertEqual(self.pg_calls(), [])

    def test_connection_string_in_arguments_is_refused_without_echo(self):
        for args in (
            ["--db-url-env", DB_URL, "--out", str(self.out)],
            ["--db-url", DB_URL, "--out", str(self.out)],
            [f"--db-url={DB_URL}", "--out", str(self.out)],
            ["--db-url-env", "MGM_EXPORT_DB_URL", "--out", str(self.out), DB_URL],
        ):
            with self.subTest(args=args[:1]):
                result = self.run_script(*args)
                self.assertEqual(result.returncode, 2)
        self.assertEqual(self.pg_calls(), [])

    def test_missing_or_empty_variable_is_refused(self):
        for value in (None, ""):
            with self.subTest(value=value):
                result = self.export_plaintext(env={"MGM_EXPORT_DB_URL": value})
                self.assertEqual(result.returncode, 3)
                self.assertIn("MGM_EXPORT_DB_URL is not set or is empty", result.stderr)
        self.assertEqual(self.pg_calls(), [])
        self.assertFalse(self.out.exists())

    def test_variable_without_a_connection_string_is_refused_without_echo(self):
        result = self.export_plaintext(env={"MGM_EXPORT_DB_URL": SECRET_PASSWORD})
        self.assertEqual(result.returncode, 3)
        self.assertIn("value not shown", result.stderr)
        self.assertEqual(self.pg_calls(), [])

    def test_missing_postgresql_client_is_reported(self):
        for program in ("pg_dump", "pg_dumpall"):
            with self.subTest(program=program):
                (self.fake_bin / program).unlink()
                result = self.export_plaintext()
                self.assertEqual(result.returncode, 3)
                self.assertIn(f"'{program}' is not on PATH", result.stderr)
                self.write_fake(program, FAKE_PG)
        self.assertEqual(self.pg_calls(), [])

    def test_output_path_that_is_a_file_is_refused(self):
        self.out.write_text("")
        result = self.export_plaintext()
        self.assertEqual(result.returncode, 3)
        self.assertEqual(self.pg_calls(), [])

    # --- the password stays out of the programs' command lines --------------

    def test_password_reaches_the_programs_through_the_environment(self):
        result = self.export_plaintext()
        self.assertEqual(result.returncode, 0, result.stderr)
        records = self.pg_records()
        self.assertEqual(len(records), 5)
        for record in records:
            argv = record["argv"]
            self.assertEqual(argv[0], f"--dbname={DB_URL_WITHOUT_PASSWORD}")
            self.assertFalse(any(SECRET_PASSWORD in arg for arg in argv), argv)
            self.assertEqual(record["PGPASSWORD"], SECRET_PASSWORD)

    def test_percent_encoded_password_is_decoded_for_the_programs(self):
        encoded = "p%40ss%3Aw%2Frd%25x%C3%A9"
        decoded = "p@ss:w/rd%xé"
        url = f"postgresql://postgres.project:{encoded}@pooler.example.invalid:5432/postgres?sslmode=require"
        result = self.export_plaintext(env={"MGM_EXPORT_DB_URL": url}, secrets=(encoded, decoded, url))
        self.assertEqual(result.returncode, 0, result.stderr)
        for record in self.pg_records():
            argv = record["argv"]
            self.assertEqual(
                argv[0],
                "--dbname=postgresql://postgres.project@pooler.example.invalid:5432/postgres?sslmode=require",
            )
            self.assertFalse(any(encoded in arg or decoded in arg for arg in argv), argv)
            self.assertEqual(record["PGPASSWORD"], decoded)

    def test_url_without_password_leaves_the_environment_alone(self):
        for caller_password in (None, "from-the-caller"):
            with self.subTest(caller_password=caller_password):
                self.pg_log.unlink(missing_ok=True)
                shutil.rmtree(self.out, ignore_errors=True)
                result = self.export_plaintext(env={"MGM_EXPORT_DB_URL": DB_URL_WITHOUT_PASSWORD, "PGPASSWORD": caller_password})
                self.assertEqual(result.returncode, 0, result.stderr)
                for record in self.pg_records():
                    self.assertEqual(record["argv"][0], f"--dbname={DB_URL_WITHOUT_PASSWORD}")
                    self.assertEqual(record["PGPASSWORD"], caller_password)

    def test_password_that_cannot_be_moved_out_of_the_url_is_refused(self):
        cases = {
            "bad%zzescape": "not percent-encoded correctly",
            "short%4": "not percent-encoded correctly",
            "trailing%": "not percent-encoded correctly",
            "back\\slash": "not percent-encoded correctly",
            "nul%00byte": "not percent-encoded correctly",
            "un/encoded": "percent-encode",
        }
        for password, message in cases.items():
            with self.subTest(password=password):
                url = f"postgresql://export_user:{password}@db.example.invalid:5432/postgres"
                result = self.export_plaintext(env={"MGM_EXPORT_DB_URL": url}, secrets=(password, url))
                self.assertEqual(result.returncode, 3)
                self.assertIn(message, result.stderr)
        self.assertEqual(self.pg_calls(), [])

    def test_password_in_the_query_string_is_refused(self):
        url = f"{DB_URL_WITHOUT_PASSWORD}?sslmode=require&password={SECRET_PASSWORD}"
        result = self.export_plaintext(env={"MGM_EXPORT_DB_URL": url}, secrets=(url,))
        self.assertEqual(result.returncode, 3)
        self.assertIn("password= parameter", result.stderr)
        self.assertEqual(self.pg_calls(), [])

    # --- what is dumped ------------------------------------------------------

    def test_dumps_run_without_switching_role(self):
        self.export_plaintext()
        calls = self.pg_calls()
        self.assertEqual(len(calls), 5)
        for _, argv in calls:
            # `supabase db dump` adds --role postgres; the script runs as the
            # login in the connection string and adds no role of its own.
            self.assertFalse([arg for arg in argv if arg.split("=", 1)[0] in ("--role", "-r")], argv)
            self.assertFalse([arg for arg in argv if "SET ROLE" in arg.upper()], argv)
            self.assertIn("--no-password", argv)

    def test_plaintext_export_runs_the_documented_dumps(self):
        self.export_plaintext()
        dbname = f"--dbname={DB_URL_WITHOUT_PASSWORD}"
        common = [dbname, "--no-password"]
        data_selection = [f'--schema="{schema}"' for schema in DATA_SCHEMAS]
        data_selection += [f"--exclude-table={quoted(table)}" for table in DATA_EXCLUDED_TABLES]
        self.assertEqual(self.pg_calls(), [
            ("pg_dumpall", common + ["--roles-only", "--quote-all-identifiers", "--no-role-passwords", "--no-comments"]),
            ("pg_dump", common + ["--schema-only", "--quote-all-identifiers", f"--exclude-schema={MANAGED_SCHEMAS}"]),
            ("pg_dump", common + ["--data-only", "--quote-all-identifiers"] + data_selection),
            ("pg_dump", common + ["--schema-only", "--quote-all-identifiers", "--schema=supabase_migrations"]),
            ("pg_dump", common + ["--data-only", "--quote-all-identifiers", "--schema=supabase_migrations"]),
        ])

    def test_data_dump_never_reads_scheduled_jobs_or_queued_requests(self):
        self.export_plaintext()
        _, data_argv = self.pg_calls()[2]
        included = [arg for arg in data_argv if arg.startswith("--schema")]
        self.assertEqual(included, [f'--schema="{schema}"' for schema in DATA_SCHEMAS])
        self.assertFalse([arg for arg in data_argv if arg.startswith("--exclude-schema")], data_argv)
        for schema in ("cron", "net", "vault", "pgsodium"):
            self.assertFalse([arg for arg in included if schema in arg])

    def test_roles_are_filtered_like_the_supabase_cli(self):
        _, export_dir = self.plaintext_export()
        self.assertEqual((export_dir / "roles.sql").read_text(), ROLES_EXPECTED + "RESET ALL;\n")

    def test_schema_is_filtered_like_the_supabase_cli(self):
        _, export_dir = self.plaintext_export()
        self.assertEqual(
            (export_dir / "schema.sql").read_text(),
            SCHEMA_EXPECTED_HEAD + SCHEMA_EXPECTED_GRANTS + SCHEMA_EXPECTED_TAIL,
        )
        self.assertEqual(
            (export_dir / "history_schema.sql").read_text(),
            SCHEMA_EXPECTED_HEAD + HISTORY_SCHEMA_EXPECTED_GRANTS + SCHEMA_EXPECTED_TAIL,
        )

    def test_data_disables_triggers_and_resets_the_session(self):
        _, export_dir = self.plaintext_export()
        body = DATA_SAMPLE.replace("{server_version}", "17.6")
        body = body.replace("\\restrict f00d03", "-- \\restrict f00d03").replace("\\unrestrict f00d03", "-- \\unrestrict f00d03")
        expected = "SET session_replication_role = replica;\n\n" + body + "RESET ALL;\n"
        for name in ("data.sql", "history_data.sql"):
            with self.subTest(name=name):
                self.assertEqual((export_dir / name).read_text(), expected)

    def test_plaintext_export_writes_files_and_manifest_privately(self):
        result, export_dir = self.plaintext_export()
        self.assertRegex(export_dir.name, EXPORT_NAME)
        self.assertEqual(result.stdout.strip(), str(export_dir.resolve()))
        self.assertEqual(sorted(os.listdir(export_dir)), sorted(DUMP_FILES + ["manifest.json"]))
        manifest = self.assert_manifest(export_dir)
        self.assertEqual(manifest["pg_dump_version"], "pg_dump (PostgreSQL) 17.6")
        self.assertEqual(manifest["server_version"], "17.6")
        self.assertEqual(export_dir.stat().st_mode & 0o777, 0o700)
        for name in DUMP_FILES + ["manifest.json"]:
            self.assertEqual((export_dir / name).stat().st_mode & 0o077, 0, name)
        self.assertIn(f"sha256 {sha256(export_dir / 'manifest.json')}  {export_dir.name}/manifest.json", result.stderr)
        self.assertIn("wrote plaintext export", result.stderr)
        self.assertEqual(self.age_calls(), [])

    def test_plaintext_export_needs_no_encryption_tools(self):
        (self.fake_bin / "age").unlink()
        for tool in ("tar", "gzip"):
            (self.system_bin / tool).unlink()
        _, export_dir = self.plaintext_export()
        self.assert_manifest(export_dir)

    def test_manifest_records_when_the_data_dump_started(self):
        # The schema dump takes over a second, so the data dump, and the
        # snapshot its rows come from, start measurably later than the export.
        _, export_dir = self.plaintext_export(env={"FAKE_PG_DELAY_ON": "--exclude-schema", "FAKE_PG_DELAY": "1.2"})
        manifest = self.assert_manifest(export_dir)
        created = utc_seconds(manifest["created_utc"])
        data_started = utc_seconds(manifest["data_dump_started_utc"])
        schema_call, data_call = (
            next(record for record in self.pg_records() if any(arg.startswith(flag) for arg in record["argv"]))
            for flag in ("--exclude-schema", "--exclude-table")
        )
        self.assertGreater(data_started, created)
        # Read after the schema dump finished and no later than the data dump began.
        self.assertGreaterEqual(data_started, math.floor(schema_call["time"] + 1.2))
        self.assertLessEqual(data_started, data_call["time"])

    def test_versions_cannot_break_the_manifest(self):
        _, export_dir = self.plaintext_export(env={
            "FAKE_PG_VERSION": 'pg_dump 17.6", "injected": "1',
            "FAKE_PG_SERVER_VERSION": '17.6", "injected": "2',
        })
        manifest = self.assert_manifest(export_dir)
        self.assertNotIn("injected", manifest)
        for field in ("pg_dump_version", "server_version"):
            self.assertRegex(manifest[field], r"^[A-Za-z0-9._+() -]+$")

    def test_tracing_does_not_reveal_the_connection_string(self):
        result = self.run_script("--db-url-env", "MGM_EXPORT_DB_URL", "--out", str(self.out), "--plaintext", trace=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_dump_failure_is_redacted_and_leaves_nothing(self):
        result = self.export_plaintext(env={"FAKE_PG_FAIL_ON": "--exclude-table"})
        self.assertEqual(result.returncode, 4)
        self.assertIn("[redacted]", result.stderr)
        self.assertIn("password authentication failed", result.stderr)
        self.assertIn("dumping data failed", result.stderr)
        self.assertEqual(os.listdir(self.out), [])

    def test_a_dump_that_writes_nothing_is_a_failure(self):
        for flag, label in (("--roles-only", "roles"), ("--exclude-table", "data"), ("--exclude-schema", "schema")):
            with self.subTest(label=label):
                shutil.rmtree(self.out, ignore_errors=True)
                result = self.export_plaintext(env={"FAKE_PG_EMPTY_ON": flag})
                self.assertEqual(result.returncode, 4)
                self.assertIn(f"the {label} dump wrote nothing", result.stderr)
                self.assertEqual(os.listdir(self.out), [])

    # --- encrypted export --------------------------------------------------

    def test_encrypted_export_leaves_only_the_encrypted_tarball(self):
        result = self.export_encrypted()
        self.assertEqual(result.returncode, 0, result.stderr)
        entries = os.listdir(self.out)
        self.assertEqual(len(entries), 1, entries)
        self.assertRegex(entries[0], ENCRYPTED_NAME)
        encrypted = self.out / entries[0]
        self.assertEqual(result.stdout.strip(), str(encrypted.resolve()))
        self.assertEqual(encrypted.stat().st_mode & 0o077, 0)
        self.assertIn(f"sha256 {sha256(encrypted)}  {entries[0]}", result.stderr)
        check, encrypt = self.age_calls()
        self.assertEqual(check, ["-R", str(self.recipients), "-o", "/dev/null"])
        self.assertEqual(encrypt[:2], ["-R", str(self.recipients)])
        partial = Path(encrypt[encrypt.index("-o") + 1])
        self.assertEqual(partial.parent, self.out.resolve())
        self.assertRegex(partial.name, rf"^\.{re.escape(entries[0])}\.[1-9][0-9]*\.partial$")
        self.assertEqual(os.listdir(self.staging_tmp), [])

        payload = encrypted.read_bytes().split(b"\n", 1)[1]
        extracted = self.tmp / "extracted"
        names = extract(payload, extracted)
        export_name = entries[0][: -len(".tar.gz.age")]
        self.assertEqual(
            sorted(names),
            sorted([export_name] + [f"{export_name}/{name}" for name in DUMP_FILES + ["manifest.json"]]),
        )
        self.assert_manifest(extracted / export_name)

    def test_encrypted_export_never_writes_plaintext_into_the_output_directory(self):
        result = self.export_encrypted(env={"FAKE_PG_WATCH": str(self.out)})
        self.assertEqual(result.returncode, 0, result.stderr)
        records = self.pg_records()
        self.assertEqual(len(records), 5)
        for record in records:
            self.assertEqual(record["watched"], [])

    def interrupt(self, mode_args, env, ready, sig):
        """Starts an export, waits for the fake named in env to create `ready`,
        then sends `sig` to the export's process group. Returns the export's
        process ID and exit status."""
        process = subprocess.Popen(
            [str(SCRIPT), "--db-url-env", "MGM_EXPORT_DB_URL", "--out", str(self.out), *mode_args],
            env=self.environment(env), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 60
            while not ready.exists():
                self.assertIsNone(process.poll(), "the export finished before it could be interrupted")
                self.assertLess(time.monotonic(), deadline, "the export never reached the point to interrupt")
                time.sleep(0.05)
            os.killpg(process.pid, sig)
            returncode = process.wait(timeout=30)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=30)
        ready.unlink()
        return process.pid, returncode

    def hang_during(self, point):
        ready = self.tmp / "ready"
        if point == "dump":
            return {"FAKE_PG_HANG_ON": "--exclude-table", "FAKE_PG_READY": str(ready)}, ready
        return {"FAKE_AGE_MODE": "hang", "FAKE_AGE_READY": str(ready)}, ready

    def test_killed_encrypted_run_leaves_no_plaintext_in_the_output_directory(self):
        env, ready = self.hang_during("dump")
        pid, _ = self.interrupt(["--age-recipients", str(self.recipients)], env, ready, signal.SIGKILL)
        self.assertEqual(list(self.out.rglob("*")), [])
        # The plaintext stayed in the staging directory under TMPDIR, which no
        # trap can clean after SIGKILL; that is where the runbook expects it.
        stages = os.listdir(self.staging_tmp)
        self.assertEqual(len(stages), 1, stages)
        self.assertRegex(stages[0], rf"^mgm-export\.{pid}\.[A-Za-z0-9]{{6}}$")
        self.assertTrue(list(self.staging_tmp.rglob("data.sql")))

        # The next run removes it.
        result = self.export_encrypted()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(os.listdir(self.staging_tmp), [])
        self.assertIn(
            f"removed the staging directory of an earlier run that did not finish: {self.staging_tmp / stages[0]}",
            result.stderr,
        )
        entries = os.listdir(self.out)
        self.assertEqual(len(entries), 1, entries)
        self.assertRegex(entries[0], ENCRYPTED_NAME)

    def test_run_killed_while_encrypting_leaves_a_partial_file_the_next_run_removes(self):
        env, ready = self.hang_during("encryption")
        pid, _ = self.interrupt(["--age-recipients", str(self.recipients)], env, ready, signal.SIGKILL)
        leftovers = os.listdir(self.out)
        self.assertEqual(len(leftovers), 1, leftovers)
        self.assertRegex(leftovers[0], rf"^\.mgm-db-export-\d{{8}}T\d{{6}}Z\.tar\.gz\.age\.{pid}\.partial$")
        self.assertEqual(len(os.listdir(self.staging_tmp)), 1)

        result = self.export_encrypted()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            "removed the partial encrypted export of an earlier run that did not finish: "
            f"{self.out.resolve() / leftovers[0]}",
            result.stderr,
        )
        self.assertEqual(os.listdir(self.staging_tmp), [])
        entries = os.listdir(self.out)
        self.assertEqual(len(entries), 1, entries)
        self.assertRegex(entries[0], ENCRYPTED_NAME)

    def test_stopped_run_removes_its_staging_directory_and_partial_file(self):
        cases = [
            ("encrypted", "dump"),
            ("encrypted", "encryption"),
            ("plaintext", "dump"),
        ]
        for sig, code in ((signal.SIGTERM, 143), (signal.SIGHUP, 129), (signal.SIGINT, 130)):
            for mode, point in cases:
                with self.subTest(signal=sig.name, mode=mode, point=point):
                    mode_args = ["--plaintext"] if mode == "plaintext" else ["--age-recipients", str(self.recipients)]
                    env, ready = self.hang_during(point)
                    _, returncode = self.interrupt(mode_args, env, ready, sig)
                    self.assertEqual(returncode, code)
                    self.assertEqual(os.listdir(self.out), [])
                    self.assertEqual(os.listdir(self.staging_tmp), [])

    def test_recipients_file_must_exist_and_list_a_recipient(self):
        comments_only = self.tmp / "comments.txt"
        comments_only.write_text("# no recipients yet\n\n   \n")
        for path, message in ((self.tmp / "missing.txt", "not found"), (comments_only, "lists no recipients")):
            with self.subTest(path=path.name):
                result = self.export("--age-recipients", str(path))
                self.assertEqual(result.returncode, 3)
                self.assertIn(message, result.stderr)
        self.assertEqual(self.pg_calls(), [])

    def test_malformed_recipient_fails_before_dumping(self):
        malformed = self.tmp / "malformed.txt"
        malformed.write_text("# backup key\nage1invalidrecipient\n")
        result = self.export("--age-recipients", str(malformed))
        self.assertEqual(result.returncode, 3)
        self.assertIn("age cannot use an entry", result.stderr)
        self.assertEqual(self.pg_calls(), [])
        self.assertFalse(self.out.exists())

    def test_recipients_file_with_a_secret_key_is_refused_without_echo(self):
        secret_key = "AGE-SECRET-KEY-1TESTONLYNOTAREALKEYQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ"
        identity = self.tmp / "identity.txt"
        identity.write_text(f"# created: test\n# public key: age1example\n{secret_key}\n")
        result = self.export("--age-recipients", str(identity))
        self.assertEqual(result.returncode, 3)
        self.assertIn("contains a secret key", result.stderr)
        self.assertNotIn(secret_key, result.stdout + result.stderr)
        self.assertEqual(self.pg_calls(), [])

    def test_recipients_without_age_fail_before_dumping(self):
        (self.fake_bin / "age").unlink()
        result = self.export_encrypted()
        self.assertEqual(result.returncode, 3)
        self.assertIn("'age'", result.stderr)
        self.assertEqual(self.pg_calls(), [])

    def test_encryption_without_tar_or_gzip_fails_before_dumping(self):
        for tool in ("tar", "gzip"):
            with self.subTest(tool=tool):
                link = self.system_bin / tool
                self.assertTrue(link.is_symlink(), f"{tool} is not installed")
                target = os.readlink(link)
                link.unlink()
                try:
                    result = self.export_encrypted()
                finally:
                    link.symlink_to(target)
                self.assertEqual(result.returncode, 3)
                self.assertIn(f"--age-recipients needs the '{tool}' program on PATH", result.stderr)
        self.assertEqual(self.pg_calls(), [])
        self.assertFalse(self.out.exists())

    def test_encryption_failure_removes_plaintext(self):
        for mode in ("fail", "garbage"):
            with self.subTest(mode=mode):
                result = self.export_encrypted(env={"FAKE_AGE_MODE": mode})
                self.assertEqual(result.returncode, 5)
                self.assertEqual(os.listdir(self.out), [])
                self.assertEqual(os.listdir(self.staging_tmp), [])

    # --- sizes and checksums ------------------------------------------------

    def measure_env(self, mode, good_calls=0):
        counter = self.tmp / "measure-calls"
        counter.unlink(missing_ok=True)
        return {"FAKE_COUNTER": str(counter), "FAKE_MODE": mode, "FAKE_GOOD_CALLS": str(good_calls)}

    def assert_no_checksum_reported(self, result):
        self.assertNotRegex(result.stderr, r"(?m)^export-database\.sh: sha256 ")
        self.assertEqual(result.stdout, "")

    def test_a_checksum_that_fails_or_is_malformed_fails_the_export(self):
        modes = ("fail", "fail-after-output", "empty", "short", "long", "uppercase", "not-hex")
        for program in ("sha256sum", "shasum"):
            # The script prefers sha256sum, and uses shasum only without it.
            for name in ("sha256sum", "shasum"):
                for directory in (self.fake_bin, self.system_bin):
                    (directory / name).unlink(missing_ok=True)
            self.write_fake(program, FAKE_MEASURE)
            for mode in modes:
                with self.subTest(program=program, mode=mode):
                    shutil.rmtree(self.out, ignore_errors=True)
                    result = self.export_plaintext(env=self.measure_env(mode))
                    self.assertEqual(result.returncode, 5, result.stderr)
                    self.assertIn("cannot compute the SHA-256 of roles.sql", result.stderr)
                    self.assert_no_checksum_reported(result)
                    self.assertEqual(os.listdir(self.out), [])

    def test_a_failed_final_checksum_leaves_no_export(self):
        self.write_fake("sha256sum", FAKE_MEASURE)
        # The manifest's five entries get good answers; the next call, for
        # manifest.json or the encrypted file, does not.
        cases = (
            (self.export_plaintext, "cannot compute the SHA-256 of manifest.json"),
            (self.export_encrypted, "cannot compute the SHA-256 of the encrypted export"),
        )
        for run, message in cases:
            for mode in ("fail", "empty", "short"):
                with self.subTest(message=message, mode=mode):
                    shutil.rmtree(self.out, ignore_errors=True)
                    result = run(env=self.measure_env(mode, good_calls=len(DUMP_FILES)))
                    self.assertEqual(result.returncode, 5, result.stderr)
                    self.assertIn(message, result.stderr)
                    self.assert_no_checksum_reported(result)
                    self.assertEqual(os.listdir(self.out), [])
                    self.assertEqual(os.listdir(self.staging_tmp), [])

    def test_a_size_that_fails_or_is_malformed_fails_the_export(self):
        self.write_fake("wc", FAKE_MEASURE)
        # Each data dump measures its file before and after pg_dump writes to
        # it (four calls in all); the manifest measures every file after that.
        cases = (
            (0, 4, "dumping data failed"),
            (1, 4, "dumping data failed"),
            (4, 5, "cannot read the size of roles.sql"),
        )
        for good_calls, code, message in cases:
            for mode in ("fail", "fail-after-output", "empty", "not-a-number"):
                with self.subTest(good_calls=good_calls, mode=mode):
                    shutil.rmtree(self.out, ignore_errors=True)
                    result = self.export_plaintext(env=self.measure_env(mode, good_calls))
                    self.assertEqual(result.returncode, code, result.stderr)
                    self.assertIn(message, result.stderr)
                    self.assert_no_checksum_reported(result)
                    self.assertEqual(os.listdir(self.out), [])

    # --- leftovers of killed runs -----------------------------------------

    def test_leftovers_of_runs_that_are_gone_are_removed(self):
        gone = finished_process_id()
        running = os.getpid()
        elsewhere = self.tmp / "elsewhere"
        for label, run in (("plaintext", self.export_plaintext), ("encrypted", self.export_encrypted)):
            with self.subTest(label):
                for directory in (self.out, self.staging_tmp, elsewhere):
                    shutil.rmtree(directory, ignore_errors=True)
                    directory.mkdir()
                (elsewhere / "keep.sql").write_text("not the script's\n")
                stale = [
                    self.staging_tmp / f"mgm-export.{gone}.aB3dE9",
                    self.out / f".mgm-export.{gone}.Qw12Er",
                    self.out / f".mgm-db-export-20260101T000000Z.tar.gz.age.{gone}.partial",
                ]
                kept = [
                    # Runs still in progress.
                    self.staging_tmp / f"mgm-export.{running}.Zx98Cv",
                    self.out / f".mgm-export.{running}.Zx98Cv",
                    self.out / f".mgm-db-export-20260101T000000Z.tar.gz.age.{running}.partial",
                    # Finished exports.
                    self.out / "mgm-db-export-20260101T000000Z.tar.gz.age",
                    self.out / "mgm-db-export-20260101T000001Z",
                    # Names this script does not give, or not in that place.
                    self.staging_tmp / "mgm-export.notapid.aB3dE9",
                    self.staging_tmp / f"mgm-export.{gone}.aB3dE9x",
                    self.staging_tmp / f".mgm-export.{gone}.aB3dE9",
                    self.out / f"mgm-export.{gone}.aB3dE9",
                    self.out / ".mgm-db-export-20260101T000000Z.tar.gz.age.partial",
                    self.out / ".notes.partial",
                ]
                for path in stale + kept:
                    if path.name.endswith((".partial", ".age")):
                        path.write_bytes(b"age-encryption.org/v1\n")
                    else:
                        path.mkdir()
                        (path / "data.sql").write_text("COPY\n")
                # A symbolic link with a leftover's name is not followed or removed.
                link = self.staging_tmp / f"mgm-export.{gone}.LnK123"
                link.symlink_to(elsewhere)

                result = run()
                self.assertEqual(result.returncode, 0, result.stderr)
                for path in stale:
                    self.assertFalse(path.exists(), path)
                for path in kept:
                    self.assertTrue(path.exists(), path)
                self.assertTrue(link.is_symlink())
                self.assertEqual((elsewhere / "keep.sql").read_text(), "not the script's\n")
                out = self.out.resolve()
                for line in (
                    f"removed the staging directory of an earlier run that did not finish: {stale[0]}",
                    f"removed the staging directory of an earlier run that did not finish: {out / stale[1].name}",
                    f"removed the partial encrypted export of an earlier run that did not finish: {out / stale[2].name}",
                ):
                    self.assertIn(line, result.stderr)
                self.assertEqual(result.stderr.count(" of an earlier run "), 3, result.stderr)

    def test_a_leftover_with_this_runs_process_id_is_stale(self):
        # A container can give every run the same process ID. The wrapper
        # leaves a staging directory under its own ID, then replaces itself
        # with the script, which keeps that ID.
        wrapper = self.tmp / "same-id.sh"
        wrapper.write_text(
            '#!/bin/sh\n'
            'mkdir "$TMPDIR/mgm-export.$$.SaMe01" "$MGM_TEST_OUT/.mgm-export.$$.SaMe01"\n'
            'exec "$MGM_TEST_SCRIPT" "$@"\n'
        )
        wrapper.chmod(0o755)
        self.out.mkdir()
        result = subprocess.run(
            [str(wrapper), "--db-url-env", "MGM_EXPORT_DB_URL", "--out", str(self.out), "--age-recipients", str(self.recipients)],
            env=self.environment({"MGM_TEST_SCRIPT": str(SCRIPT), "MGM_TEST_OUT": str(self.out)}),
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr.count(" of an earlier run that did not finish: "), 2, result.stderr)
        self.assertEqual(os.listdir(self.staging_tmp), [])
        entries = os.listdir(self.out)
        self.assertEqual(len(entries), 1, entries)
        self.assertRegex(entries[0], ENCRYPTED_NAME)

    def assert_installed(self, *tools):
        for tool in tools:
            self.assertTrue(shutil.which(tool), f"{tool} is not installed")

    # The Test workflow installs age and requires these to run. Locally they
    # need age, age-keygen and shellcheck on PATH, and are skipped otherwise.
    @needs("age", "age-keygen")
    def test_round_trip_with_real_age(self):
        self.assert_installed("age", "age-keygen")
        (self.fake_bin / "age").unlink()
        (self.system_bin / "age").symlink_to(shutil.which("age"))
        identity = self.tmp / "identity.txt"
        subprocess.run(["age-keygen", "-o", str(identity)], check=True, capture_output=True)
        recipient = subprocess.run(["age-keygen", "-y", str(identity)], check=True, capture_output=True, text=True).stdout
        self.recipients.write_text(f"# test recipient\n{recipient}")
        result = self.export_encrypted()
        self.assertEqual(result.returncode, 0, result.stderr)
        encrypted = Path(result.stdout.strip())
        decrypted = subprocess.run(
            ["age", "--decrypt", "-i", str(identity), str(encrypted)], check=True, capture_output=True
        ).stdout
        extracted = self.tmp / "extracted"
        extract(decrypted, extracted)
        self.assert_manifest(extracted / encrypted.name[: -len(".tar.gz.age")])

    @needs("age")
    def test_real_age_rejects_a_malformed_recipient_before_dumping(self):
        self.assert_installed("age")
        (self.fake_bin / "age").unlink()
        (self.system_bin / "age").symlink_to(shutil.which("age"))
        malformed = self.tmp / "malformed.txt"
        malformed.write_text("age1notavalidrecipient\n")
        result = self.export("--age-recipients", str(malformed))
        self.assertEqual(result.returncode, 3)
        self.assertEqual(self.pg_calls(), [])

    @needs("shellcheck")
    def test_shellcheck_clean(self):
        self.assert_installed("shellcheck")
        result = subprocess.run(["shellcheck", str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
