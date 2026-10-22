"""Safety tests for scripts/backup/export-database.sh.

pg_dump, pg_dumpall and age are replaced by fakes on PATH, so these tests need
no database or key material. Each run gets a PATH that holds only the fakes
and the system programs the script is expected to use, so a new dependency
shows up here as a failure rather than on an operator's host.
"""
import hashlib
import io
import json
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
# Platform ledgers and Storage's vector tables, then Auth's session state and
# second factors, which must never reach an export.
DATA_EXCLUDED_TABLES = [
    "auth.schema_migrations", "storage.migrations", "supabase_functions.migrations",
    "storage.buckets_vectors", "storage.vector_indexes",
    "auth.sessions", "auth.refresh_tokens", "auth.mfa_factors", "auth.mfa_challenges", "auth.mfa_amr_claims",
    "auth.flow_state", "auth.one_time_tokens", "auth.saml_relay_states",
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
CREATE ROLE "mgm_export_reader";
ALTER ROLE "mgm_export_reader" WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION BYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE "mgm_export_reader" SET "default_transaction_read_only" TO 'on';
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
CREATE ROLE "mgm_export_reader";
ALTER ROLE "mgm_export_reader" WITH INHERIT NOCREATEROLE NOCREATEDB LOGIN BYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE "mgm_export_reader" SET "default_transaction_read_only" TO 'on';
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
record = {{"program": program, "argv": args, "PGPASSWORD": os.environ.get("PGPASSWORD")}}
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
if os.environ.get("FAKE_PG_HANG_ON", "\\0") in flags:
    with open(os.environ["FAKE_PG_READY"], "w") as ready:
        ready.write("dumping\\n")
    time.sleep(120)
"""

FAKE_AGE = f"""#!{sys.executable}
import json, os, sys
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
header = b"age-encryption.org/v1\\n" if mode == "ok" else b"not an age file\\n"
with open(output, "wb") as out:
    out.write(header + data)
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
        return self.run_script(
            "--db-url-env", "MGM_EXPORT_DB_URL", "--out", str(self.out), *extra, env=env, secrets=secrets
        )

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
        result = self.export(env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        entries = os.listdir(self.out)
        self.assertEqual(len(entries), 1, entries)
        return result, self.out / entries[0]

    def assert_manifest(self, export_dir):
        manifest = json.loads((export_dir / "manifest.json").read_text())
        self.assertEqual(manifest["format"], "mgm-database-export/1")
        self.assertRegex(manifest["created_utc"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
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
        self.assertIn("--db-url-env <ENV_VAR_NAME> --out <dir> [--age-recipients <file>]", result.stdout)

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
                result = self.export(env={"MGM_EXPORT_DB_URL": value})
                self.assertEqual(result.returncode, 3)
                self.assertIn("MGM_EXPORT_DB_URL is not set or is empty", result.stderr)
        self.assertEqual(self.pg_calls(), [])
        self.assertFalse(self.out.exists())

    def test_variable_without_a_connection_string_is_refused_without_echo(self):
        result = self.export(env={"MGM_EXPORT_DB_URL": SECRET_PASSWORD})
        self.assertEqual(result.returncode, 3)
        self.assertIn("value not shown", result.stderr)
        self.assertEqual(self.pg_calls(), [])

    def test_missing_postgresql_client_is_reported(self):
        for program in ("pg_dump", "pg_dumpall"):
            with self.subTest(program=program):
                (self.fake_bin / program).unlink()
                result = self.export()
                self.assertEqual(result.returncode, 3)
                self.assertIn(f"'{program}' is not on PATH", result.stderr)
                self.write_fake(program, FAKE_PG)
        self.assertEqual(self.pg_calls(), [])

    def test_output_path_that_is_a_file_is_refused(self):
        self.out.write_text("")
        result = self.export()
        self.assertEqual(result.returncode, 3)
        self.assertEqual(self.pg_calls(), [])

    # --- the password stays out of the programs' command lines --------------

    def test_password_reaches_the_programs_through_the_environment(self):
        result = self.export()
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
        result = self.export(env={"MGM_EXPORT_DB_URL": url}, secrets=(encoded, decoded, url))
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
                result = self.export(env={"MGM_EXPORT_DB_URL": DB_URL_WITHOUT_PASSWORD, "PGPASSWORD": caller_password})
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
                result = self.export(env={"MGM_EXPORT_DB_URL": url}, secrets=(password, url))
                self.assertEqual(result.returncode, 3)
                self.assertIn(message, result.stderr)
        self.assertEqual(self.pg_calls(), [])

    def test_password_in_the_query_string_is_refused(self):
        url = f"{DB_URL_WITHOUT_PASSWORD}?sslmode=require&password={SECRET_PASSWORD}"
        result = self.export(env={"MGM_EXPORT_DB_URL": url}, secrets=(url,))
        self.assertEqual(result.returncode, 3)
        self.assertIn("password= parameter", result.stderr)
        self.assertEqual(self.pg_calls(), [])

    # --- what is dumped ------------------------------------------------------

    def test_dumps_run_without_switching_role(self):
        self.export()
        calls = self.pg_calls()
        self.assertEqual(len(calls), 5)
        for _, argv in calls:
            # `supabase db dump` adds --role postgres; a read-only login that
            # is not a member of postgres cannot run that.
            self.assertFalse([arg for arg in argv if arg.split("=", 1)[0] in ("--role", "-r")], argv)
            self.assertFalse([arg for arg in argv if "SET ROLE" in arg.upper()], argv)
            self.assertIn("--no-password", argv)

    def test_plaintext_export_runs_the_documented_dumps(self):
        self.export()
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
        self.export()
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
        result = self.run_script("--db-url-env", "MGM_EXPORT_DB_URL", "--out", str(self.out), trace=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_dump_failure_is_redacted_and_leaves_nothing(self):
        result = self.export(env={"FAKE_PG_FAIL_ON": "--exclude-table"})
        self.assertEqual(result.returncode, 4)
        self.assertIn("[redacted]", result.stderr)
        self.assertIn("password authentication failed", result.stderr)
        self.assertIn("dumping data failed", result.stderr)
        self.assertEqual(os.listdir(self.out), [])

    def test_a_dump_that_writes_nothing_is_a_failure(self):
        for flag, label in (("--roles-only", "roles"), ("--exclude-table", "data"), ("--exclude-schema", "schema")):
            with self.subTest(label=label):
                shutil.rmtree(self.out, ignore_errors=True)
                result = self.export(env={"FAKE_PG_EMPTY_ON": flag})
                self.assertEqual(result.returncode, 4)
                self.assertIn(f"the {label} dump wrote nothing", result.stderr)
                self.assertEqual(os.listdir(self.out), [])

    # --- encrypted export --------------------------------------------------

    def test_encrypted_export_leaves_only_the_encrypted_tarball(self):
        result = self.export("--age-recipients", str(self.recipients))
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
        self.assertEqual(partial.name, f".{entries[0]}.partial")
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
        result = self.export("--age-recipients", str(self.recipients), env={"FAKE_PG_WATCH": str(self.out)})
        self.assertEqual(result.returncode, 0, result.stderr)
        records = self.pg_records()
        self.assertEqual(len(records), 5)
        for record in records:
            self.assertEqual(record["watched"], [])

    def test_killed_encrypted_run_leaves_no_plaintext_in_the_output_directory(self):
        ready = self.tmp / "ready"
        process = subprocess.Popen(
            [str(SCRIPT), "--db-url-env", "MGM_EXPORT_DB_URL", "--out", str(self.out),
             "--age-recipients", str(self.recipients)],
            env=self.environment({"FAKE_PG_HANG_ON": "--exclude-table", "FAKE_PG_READY": str(ready)}),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 60
            while not ready.exists():
                self.assertIsNone(process.poll(), "the export finished before the data dump could be interrupted")
                self.assertLess(time.monotonic(), deadline, "the data dump never started")
                time.sleep(0.05)
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=30)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=30)
        self.assertEqual(list(self.out.rglob("*")), [])
        # The plaintext stayed in the staging directory under TMPDIR, which no
        # trap can clean after SIGKILL; that is where the runbook expects it.
        self.assertTrue(list(self.staging_tmp.rglob("data.sql")))

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
        result = self.export("--age-recipients", str(self.recipients))
        self.assertEqual(result.returncode, 3)
        self.assertIn("'age'", result.stderr)
        self.assertEqual(self.pg_calls(), [])

    def test_encryption_failure_removes_plaintext(self):
        for mode in ("fail", "garbage"):
            with self.subTest(mode=mode):
                result = self.export("--age-recipients", str(self.recipients), env={"FAKE_AGE_MODE": mode})
                self.assertEqual(result.returncode, 5)
                self.assertEqual(os.listdir(self.out), [])
                self.assertEqual(os.listdir(self.staging_tmp), [])

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
        result = self.export("--age-recipients", str(self.recipients))
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
