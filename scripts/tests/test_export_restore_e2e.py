"""Exports a migrated database and restores it with the runbook's commands.

test_export_database.py replaces pg_dump, pg_dumpall and age with fakes, so it
cannot show that an export restores. This test exports a database built by the
repository's migrations, with fixture data committed to it, using
scripts/backup/export-database.sh, and restores the export into a new, empty
Supabase project with the commands in docs/runbooks/backup-and-restore.md. It
reads those commands out of the runbook each time it runs, so a change to a
command there is tested as written, and removing one fails the test.

It then checks the target against the export and the source: every table in
data.sql holds the export's number of rows, a closed billing period (its line
items, audit trail, payments and tariff) is identical, Auth's sessions, refresh
tokens and MFA factors are absent, merchant accounts are disabled, and schema
public with its privileges, the triggers and policies on Supabase-managed
tables, and the migration history all match the source. It checks that the
runbook's preflight and row-count check fail when they should, the preflight
on the source included, and that every table in schema auth is one the export
knowingly includes or one the script leaves out.

The export runs with the source's `postgres` connection string, the one
`supabase status` prints, which is the connection string the runbook tells
operators to export with.

Two databases, given as connection strings for their `postgres` role:

  MGM_E2E_SOURCE_DB_URL  The repository's local stack (`npx supabase start`),
                         built by the migrations. The test commits fixture
                         rows to it, so use a stack you can reset.
  MGM_E2E_TARGET_DB_URL  A new, empty Supabase project, started from
                         scripts/tests/restore-target.config.toml as that file
                         describes. The test restores into it once; reset it
                         (`npx supabase db reset --workdir <dir>`) before the
                         next run.

The programs, on PATH: psql, pg_dump and pg_dumpall of at least the servers'
major version, age, age-keygen, jq, tar, gzip and sha256sum.

Without both variables the tests are skipped, unless MGM_TEST_REQUIRE_DATABASE=1
is set, as in the Test workflow: then a missing variable, program or database
fails them.
"""
import collections
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
import urllib.parse
import uuid

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "backup" / "export-database.sh"
RUNBOOK = REPO / "docs" / "runbooks" / "backup-and-restore.md"
SOURCE_ENV = "MGM_E2E_SOURCE_DB_URL"
TARGET_ENV = "MGM_E2E_TARGET_DB_URL"
REQUIRE_DATABASE = os.environ.get("MGM_TEST_REQUIRE_DATABASE") == "1"
PROGRAMS = ("bash", "psql", "pg_dump", "pg_dumpall", "age", "age-keygen", "jq", "tar", "gzip", "sha256sum")
UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
PREFLIGHT_REFUSAL = "restore target is not empty"

# Tables in schema auth that the export knowingly includes. Every other table
# there must be one the script leaves out of the data dump
# (DATA_EXCLUDED_TABLES). A Supabase upgrade that adds an Auth table fails
# test_every_auth_table_is_exported_knowingly_or_left_out until the table is
# listed here or in the script; one that holds sessions, tokens, pending
# sign-in state, second factors or a secret belongs in the script.
AUTH_TABLES_EXPORTED = {
    "auth.users": "accounts and password hashes, so users sign in as before",
    "auth.identities": "the sign-in identities of each user",
    "auth.instances": "unused by current Auth; kept as Supabase's dump does",
    "auth.audit_log_entries": "Auth's audit history",
    "auth.sso_providers": "SSO configuration",
    "auth.sso_domains": "SSO configuration",
    "auth.saml_providers": "SSO configuration",
    "auth.oauth_clients": "clients registered with Auth's OAuth server; secrets are stored hashed",
    "auth.oauth_consents": "what users granted to those clients",
    "auth.webauthn_credentials": "passkeys: public keys, no secrets",
}


def database_unavailable(message):
    if REQUIRE_DATABASE:
        raise AssertionError(f"{message} (MGM_TEST_REQUIRE_DATABASE=1 requires it)")
    raise unittest.SkipTest(message)


def required_url(name):
    url = os.environ.get(name, "")
    if not url:
        database_unavailable(f"{name} is not set; see this module's docstring")
    return url


def require_programs():
    missing = [program for program in PROGRAMS if not shutil.which(program)]
    if missing:
        database_unavailable(f"not on PATH: {', '.join(missing)}")


def client_env(extra=None):
    """The test's environment without PG* variables, which would steer psql elsewhere."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    env.update(extra or {})
    return env


def run(command, *, cwd=None, env=None, timeout=600):
    return subprocess.run(
        command, cwd=cwd, env=env or client_env(), capture_output=True, text=True, timeout=timeout
    )


def output_of(result):
    return f"exit {result.returncode}\n--- stdout\n{result.stdout}\n--- stderr\n{result.stderr}"


def psql_value(url, sql):
    """Runs one statement that returns a single value (JSON for anything structured)."""
    result = run(["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "--dbname", url, "-c", sql])
    if result.returncode != 0:
        raise AssertionError(f"psql failed on: {sql}\n{output_of(result)}")
    return result.stdout.strip()


def psql_json(url, sql):
    return json.loads(psql_value(url, sql))


def server_major(url):
    """The server's major version; skips (or fails, when required) if the server cannot be reached."""
    try:
        return int(psql_value(url, "SHOW server_version_num")) // 10000
    except AssertionError as error:
        database_unavailable(f"cannot reach the database: {error}")


def script_array(name):
    """The words of a `readonly NAME=( ... )` array in the export script."""
    match = re.search(rf"^readonly {name}=\((.*?)\)", SCRIPT.read_text(), re.M | re.S)
    if not match:
        raise AssertionError(f"cannot find {name} in {SCRIPT}")
    return [word for line in match.group(1).splitlines() for word in line.split("#", 1)[0].split()]


def code_blocks(text):
    """Yields (language, body) for each fenced block, indentation removed."""
    body = None
    for line in text.splitlines():
        stripped = line.lstrip(" ")
        if body is None:
            if stripped.startswith("```"):
                indent, language, body = len(line) - len(stripped), stripped[3:].strip(), []
        elif stripped.startswith("```"):
            yield language, "\n".join(body) + "\n"
            body = None
        else:
            body.append(line[indent:] if line[:indent].strip() == "" else line)


def runbook_command(description, *containing, excluding=()):
    """The one bash block in the runbook that contains every string in `containing`."""
    found = [
        body for language, body in code_blocks(RUNBOOK.read_text())
        if language == "bash" and all(s in body for s in containing) and not any(s in body for s in excluding)
    ]
    if len(found) != 1:
        raise AssertionError(
            f"expected one bash block in {RUNBOOK.relative_to(REPO)} for {description} "
            f"(containing {containing}, not {excluding}); found {len(found)}"
        )
    return found[0]


def fill(command, values):
    """Replaces the runbook's placeholders, and refuses a command with one left over."""
    for placeholder, value in values.items():
        command = command.replace(placeholder, value)
    leftover = re.findall(r"<[a-z][a-z0-9 _-]*>|/path/to/\S+", command)
    if leftover:
        raise AssertionError(f"the runbook's command has placeholders this test does not fill: {leftover}\n{command}")
    return command


def run_runbook(command, cwd, env):
    """Runs a runbook command as an operator pasting it would: no -e, no pipefail."""
    return run(["bash", "-c", command], cwd=cwd, env=env)


def service_env(directory, service, url):
    """A PostgreSQL service file and password file naming `url` as `service`, as the runbook sets up."""
    directory.mkdir(parents=True, exist_ok=True)
    parts = urllib.parse.urlsplit(url)
    params = {
        "host": parts.hostname,
        "port": str(parts.port or 5432),
        "dbname": urllib.parse.unquote(parts.path.lstrip("/")) or "postgres",
        "user": urllib.parse.unquote(parts.username or "postgres"),
    }
    params.update(urllib.parse.parse_qsl(parts.query))
    service_file = directory / "pg_service.conf"
    service_file.write_text(f"[{service}]\n" + "".join(f"{key}={value}\n" for key, value in params.items()))
    password_file = directory / "pgpass"
    fields = [params["host"], params["port"], params["dbname"], params["user"], urllib.parse.unquote(parts.password or "")]
    password_file.write_text(":".join(f.replace("\\", "\\\\").replace(":", "\\:") for f in fields) + "\n")
    password_file.chmod(0o600)
    return client_env({"PGSERVICEFILE": str(service_file), "PGPASSFILE": str(password_file), "MGM_CHECKOUT": str(REPO)})


def copy_row_counts(data_sql):
    """{table: rows} for each COPY block in a pg_dump data file."""
    counts, table = {}, None
    with open(data_sql, encoding="utf-8") as lines:
        for line in lines:
            if table is None:
                match = re.match(r"^COPY (\S+) ", line)
                if match:
                    table = match.group(1)
                    counts[table] = 0
            elif line.rstrip("\n") == "\\.":
                table = None
            else:
                counts[table] += 1
    return counts


def quoted(table):
    schema, name = table.split(".", 1)
    return f'"{schema}"."{name}"'


def public_schema(url):
    """The lines of pg_dump's schema-only dump of schema public, privileges and default privileges included."""
    result = run(["pg_dump", "--dbname", url, "--schema-only", "--schema=public", "--quote-all-identifiers"])
    if result.returncode != 0:
        raise AssertionError(f"pg_dump failed\n{output_of(result)}")
    return collections.Counter(
        line for line in result.stdout.splitlines() if line.strip() and not re.match(r"\\(un)?restrict ", line)
    )


def row_counts(url, tables):
    if not tables:
        return {}
    union = " UNION ALL ".join(f"SELECT '{table}' AS t, count(*) AS n FROM {table}" for table in sorted(tables))
    return psql_json(url, f"SELECT json_object_agg(t, n) FROM ({union}) counts")


FIXTURE = """
DO $fixture$
DECLARE
  v_org uuid := '{org}';
  v_user uuid := '{user}';
  v_session uuid := gen_random_uuid();
  v_community uuid; v_microgrid uuid; v_household uuid; v_neighbour uuid; v_tariff uuid;
  v_closed uuid; v_open uuid; v_item billing_line_items%ROWTYPE;
BEGIN
  INSERT INTO organizations(id, name) VALUES (v_org, 'Export and restore test');
  INSERT INTO auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token)
  VALUES ('00000000-0000-0000-0000-000000000000', v_user, 'authenticated', 'authenticated',
    'export-restore-' || v_user || '@test.local', extensions.crypt('not-a-real-password', extensions.gen_salt('bf')),
    now(), '{{"provider": "email", "providers": ["email"]}}', '{{}}', now(), now(), '', '', '', '');
  INSERT INTO auth.identities(provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  VALUES (v_user::text, v_user, jsonb_build_object('sub', v_user::text), 'email', now(), now(), now());
  -- Session state and a second factor, which the export must leave out.
  INSERT INTO auth.sessions(id, user_id, created_at, updated_at, aal) VALUES (v_session, v_user, now(), now(), 'aal1');
  INSERT INTO auth.refresh_tokens(instance_id, token, user_id, revoked, created_at, updated_at, session_id)
  VALUES ('00000000-0000-0000-0000-000000000000', '{refresh_token}', v_user::text, false, now(), now(), v_session);
  INSERT INTO auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  VALUES (gen_random_uuid(), v_user, 'authenticator', 'totp', 'verified', now(), now(), '{totp_secret}');
  INSERT INTO user_roles(user_id, role, scope_type, scope_id) VALUES (v_user, 'org_manager', 'org', v_org);

  -- Billing as the org manager, through the same functions the application calls.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
  SET ROLE authenticated;
  INSERT INTO communities(org_id, name, invoice_prefix) VALUES (v_org, 'Export and restore community', 'ER')
  RETURNING id INTO v_community;
  INSERT INTO microgrids(community_id, name, currency, timezone) VALUES (v_community, 'Export and restore microgrid', 'UGX', 'Africa/Kampala')
  RETURNING id INTO v_microgrid;
  INSERT INTO households(microgrid_id, display_name, primary_phone) VALUES (v_microgrid, 'Household A', '+256700000001')
  RETURNING id INTO v_household;
  INSERT INTO households(microgrid_id, display_name, primary_phone) VALUES (v_microgrid, 'Household B', '+256700000002')
  RETURNING id INTO v_neighbour;
  INSERT INTO rate_schedules(microgrid_id, tiers, service_charge, tax_rate)
  VALUES (v_microgrid, '[{{"label": "T1", "min_kwh": 1, "max_kwh": 10, "rate_per_kwh": 100}},
                         {{"label": "T2", "min_kwh": 11, "max_kwh": null, "rate_per_kwh": 200}}]', 500, 0)
  RETURNING id INTO v_tariff;

  SELECT id INTO v_closed FROM fn_create_billing_period(v_microgrid, '2026-08-01', '2026-08-31');
  SELECT * INTO v_item FROM fn_record_line_item_with_audit(v_closed, v_household, NULL, 12.5, 100.0, 112.5,
    '[{{"label": "T1", "kwh": 10, "amount": 1000}}, {{"label": "T2", "kwh": 2.5, "amount": 500}}]', 2000, 'edge',
    NULL, NULL, v_user, '{{}}', v_tariff, 'human', NULL);
  PERFORM fn_apply_payment_event(v_item.id, 'paid', 'manual', v_user, '{{"payment_notes": "cash"}}', 'human', NULL);
  PERFORM fn_record_line_item_with_audit(v_closed, v_neighbour, NULL, 4, 50, 54,
    '[{{"label": "T1", "kwh": 4, "amount": 400}}]', 900, 'manual',
    v_user, 'meter unreadable', v_user, '{{}}', v_tariff, 'human', NULL);
  PERFORM fn_next_invoice_number(v_community, 2026);
  PERFORM fn_close_billing_period(v_closed, false);

  SELECT id INTO v_open FROM fn_create_billing_period(v_microgrid, '2026-09-01', '2026-09-30');
  PERFORM fn_record_line_item_with_audit(v_open, v_household, NULL, 3, 112.5, 115.5,
    '[{{"label": "T1", "kwh": 3, "amount": 300}}]', 800, 'edge', NULL, NULL, v_user, '{{}}', v_tariff, 'human', NULL);
  RESET ROLE;

  INSERT INTO payment_merchant_accounts(org_id, consumer_key, secret_encrypted, base_url, ipn_id, last_test_status, is_default)
  VALUES (v_org, 'test-consumer-key', '\\x00', 'https://merchant.example.invalid', 'ipn-test', 'success', true);
  INSERT INTO storage.objects(bucket_id, name, owner_id, metadata)
  VALUES ('invoice-logos', v_org || '/logo.png', v_user::text, '{{"size": 1, "mimetype": "image/png"}}');
END
$fixture$;
"""

# The closed period as the target must hold it: the period, its line items,
# their audit trail and payment events, and the tariff it is pinned to.
CLOSED_PERIOD = """
SELECT jsonb_build_object(
  'period', (SELECT to_jsonb(p) FROM billing_periods p WHERE p.id = '{period}'),
  'line_items', (SELECT coalesce(jsonb_agg(to_jsonb(li) ORDER BY li.id), '[]')
                 FROM billing_line_items li WHERE li.billing_period_id = '{period}'),
  'audit', (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]')
            FROM billing_audit_log a WHERE a.billing_period_id = '{period}'),
  'payment_events', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]')
                     FROM payment_events e JOIN billing_line_items li ON li.id = e.line_item_id
                     WHERE li.billing_period_id = '{period}'),
  'tariff', (SELECT to_jsonb(r) FROM rate_schedules r
             WHERE r.id = (SELECT rate_schedule_id FROM billing_periods WHERE id = '{period}'))
)
"""

ENABLED_ACCOUNTS = "SELECT coalesce(json_agg(id ORDER BY id), '[]') FROM payment_merchant_accounts WHERE NOT disabled"

MANAGED_OBJECTS = """
SELECT jsonb_build_object(
  'triggers', (SELECT coalesce(jsonb_agg(t.tgrelid::regclass::text || ' ' || t.tgname
                                         ORDER BY t.tgrelid::regclass::text, t.tgname), '[]')
               FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
               WHERE c.relnamespace::regnamespace::text IN ('auth', 'storage') AND NOT t.tgisinternal),
  'policies', (SELECT coalesce(jsonb_agg(schemaname || '.' || tablename || ' ' || policyname
                                         ORDER BY schemaname, tablename, policyname), '[]')
               FROM pg_policies WHERE schemaname IN ('auth', 'storage'))
)
"""


class ExportRestoreEndToEndTests(unittest.TestCase):
    """One export and one restore, in setUpClass; the tests check what they left."""

    @classmethod
    def setUpClass(cls):
        cls.source = required_url(SOURCE_ENV)
        cls.target = required_url(TARGET_ENV)
        require_programs()
        cls.work = Path(tempfile.mkdtemp(prefix="mgm-export-restore-"))
        cls.addClassCleanup(shutil.rmtree, cls.work, ignore_errors=True)

        source_major, target_major = server_major(cls.source), server_major(cls.target)
        if source_major != target_major:
            raise AssertionError(
                f"the source runs PostgreSQL {source_major} and the target {target_major}; they must match"
            )
        in_use = "SELECT to_regclass('public.organizations') IS NOT NULL OR EXISTS (SELECT FROM auth.users)"
        if psql_value(cls.target, in_use) == "t":
            raise AssertionError(
                f"the database in {TARGET_ENV} is not a new project; reset it "
                "(npx supabase db reset --workdir <its directory>) before running this test"
            )

        cls.seed_source()
        cls.export()
        cls.restore()

    @classmethod
    def seed_source(cls):
        cls.org, cls.user = str(uuid.uuid4()), str(uuid.uuid4())
        cls.refresh_token = f"e2e-refresh-{uuid.uuid4().hex}"
        cls.totp_secret = f"E2ETOTP{uuid.uuid4().hex.upper()}"
        fixture = cls.work / "fixture.sql"
        fixture.write_text(FIXTURE.format(
            org=cls.org, user=cls.user, refresh_token=cls.refresh_token, totp_secret=cls.totp_secret
        ))
        result = run([
            "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "--dbname", cls.source,
            "-f", str(fixture),
        ])
        if result.returncode != 0:
            raise AssertionError(f"cannot commit the fixture to the source\n{output_of(result)}")
        cls.closed_period = psql_value(cls.source, f"""
            SELECT bp.id FROM billing_periods bp
            JOIN microgrids m ON m.id = bp.microgrid_id JOIN communities c ON c.id = m.community_id
            WHERE c.org_id = '{cls.org}' AND bp.status = 'closed'""")
        cls.enabled_accounts = psql_json(cls.source, ENABLED_ACCOUNTS)

    @classmethod
    def export(cls):
        identity = cls.work / "age-identity.txt"
        cls.identity = identity
        result = run(["age-keygen", "-o", str(identity)])
        if result.returncode != 0:
            raise AssertionError(output_of(result))
        recipients = cls.work / "recipients.txt"
        recipient = run(["age-keygen", "-y", str(identity)]).stdout
        recipients.write_text(f"# test recipient\n{recipient}")
        staging = cls.work / "tmp"
        staging.mkdir()
        result = run(
            [str(SCRIPT), "--db-url-env", SOURCE_ENV, "--out", str(cls.work / "exports"),
             "--age-recipients", str(recipients)],
            env=client_env({SOURCE_ENV: cls.source, "TMPDIR": str(staging)}),
        )
        if result.returncode != 0:
            raise AssertionError(f"the export failed\n{output_of(result)}")
        encrypted = Path(result.stdout.strip())
        match = re.fullmatch(r"mgm-db-export-(\d{8}T\d{6}Z)\.tar\.gz\.age", encrypted.name)
        if not match:
            raise AssertionError(f"unexpected export name: {encrypted}")
        cls.export_time = match.group(1)
        cls.export_name = f"mgm-db-export-{cls.export_time}"
        recorded = re.search(rf"sha256 ([0-9a-f]{{64}})  {re.escape(encrypted.name)}$", result.stderr, re.M)
        if not recorded:
            raise AssertionError(f"the export did not report the encrypted file's SHA-256\n{result.stderr}")
        cls.recorded_sha256 = recorded.group(1)
        # Export storage, then a trusted machine: the runbook works on a copy.
        cls.restore_dir = cls.work / "restore"
        cls.restore_dir.mkdir()
        shutil.copy2(encrypted, cls.restore_dir / encrypted.name)

    @classmethod
    def restore(cls):
        cls.restore_command = runbook_command("the restore", "--file roles.sql", "--file data.sql")
        service = re.search(r"\bPGSERVICE=([A-Za-z0-9_.-]+)", cls.restore_command)
        if not service:
            raise AssertionError(f"the runbook's restore command names no PGSERVICE:\n{cls.restore_command}")
        cls.service = service.group(1)
        cls.target_env = service_env(cls.work / "target-service", cls.service, cls.target)
        values = {"<time>": cls.export_time, "/path/to/age-identity.txt": str(cls.identity)}

        # Step 1, Prepare the target: the extensions the runbook says to
        # enable, as the migrations create them.
        psql_value(cls.target, "CREATE EXTENSION IF NOT EXISTS pg_cron")
        psql_value(cls.target, "CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions")
        psql_value(cls.target, "CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault")

        cls.preflight_command = fill(runbook_command(
            "confirming the restore target", "restore-target-preflight.sql", excluding=("roles.sql",)), values)
        cls.preflight_result = cls.step("the preflight on the new target", cls.preflight_command, cls.restore_dir)

        cls.decrypt_result = cls.step(
            "decrypting and checking the export", fill(runbook_command("decrypting the export", "age --decrypt"), values),
            cls.restore_dir,
        )
        cls.export_dir = cls.restore_dir / cls.export_name
        cls.restore_result = cls.step("the restore", fill(cls.restore_command, values), cls.export_dir)
        cls.history_result = cls.step(
            "restoring the migration history",
            fill(runbook_command("restoring the migration history", "--file history_schema.sql"), values),
            cls.export_dir,
        )
        cls.row_count_command = fill(runbook_command("comparing row counts", "/^COPY /"), values)
        cls.row_count_result = run_runbook(cls.row_count_command, cls.export_dir, cls.target_env)

    @classmethod
    def step(cls, description, command, cwd):
        result = run_runbook(command, cwd, cls.target_env)
        if result.returncode != 0:
            raise AssertionError(f"the runbook's command for {description} failed\n{command}\n{output_of(result)}")
        return result

    def export_tables(self):
        return copy_row_counts(self.export_dir / "data.sql")

    # --- the runbook's own checks ---------------------------------------------

    def test_preflight_accepts_the_new_target(self):
        self.assertIn("restore target is empty", self.preflight_result.stdout + self.preflight_result.stderr)

    def test_encrypted_file_checksum_matches_the_one_the_export_reported(self):
        self.assertIn(f"{self.recorded_sha256}  {self.export_name}.tar.gz.age", self.decrypt_result.stdout)

    def test_manifest_checksums_pass(self):
        manifest = json.loads((self.export_dir / "manifest.json").read_text())
        for entry in manifest["files"]:
            self.assertIn(f"{entry['name']}: OK", self.decrypt_result.stdout)

    def test_runbook_row_count_check_passes(self):
        result = self.row_count_result
        self.assertEqual(result.returncode, 0, output_of(result))
        self.assertNotIn("MISMATCH", result.stdout + result.stderr, output_of(result))

    def test_runbook_row_count_check_reports_a_mismatch(self):
        # A check that never finds a mismatch would pass every restore.
        doctored = self.work / "mismatch"
        doctored.mkdir()
        (doctored / "data.sql").write_text(
            'COPY "public"."organizations" ("id", "name") FROM stdin;\n'
            + "".join(f"{uuid.uuid4()}\textra\n" for _ in range(self.export_tables()['"public"."organizations"'] + 1))
            + "\\.\n"
        )
        result = run_runbook(self.row_count_command, doctored, self.target_env)
        self.assertNotEqual(result.returncode, 0, output_of(result))
        self.assertIn('MISMATCH "public"."organizations"', result.stdout + result.stderr, output_of(result))

    def test_runbook_row_count_check_fails_when_psql_fails(self):
        broken = self.work / "psql-error"
        broken.mkdir()
        (broken / "data.sql").write_text('COPY "public"."no_such_table" ("id") FROM stdin;\n1\n\\.\n')
        result = run_runbook(self.row_count_command, broken, self.target_env)
        self.assertNotEqual(result.returncode, 0, output_of(result))

    def test_preflight_refuses_a_database_that_is_not_empty(self):
        for name, url in (("the restored target", self.target), ("the source", self.source)):
            with self.subTest(database=name):
                env = service_env(self.work / f"preflight-{name.split()[-1]}", self.service, url)
                result = run_runbook(self.preflight_command, self.restore_dir, env)
                self.assertNotEqual(result.returncode, 0, output_of(result))
                self.assertIn(PREFLIGHT_REFUSAL, result.stderr, output_of(result))

    def test_restore_refuses_the_source_and_changes_nothing(self):
        before = row_counts(self.source, self.export_tables())
        accounts = psql_json(self.source, ENABLED_ACCOUNTS)
        env = service_env(self.work / "restore-into-source", self.service, self.source)
        result = run_runbook(fill(self.restore_command, {}), self.export_dir, env)
        self.assertNotEqual(result.returncode, 0, output_of(result))
        self.assertIn(PREFLIGHT_REFUSAL, result.stderr, output_of(result))
        self.assertEqual(row_counts(self.source, self.export_tables()), before)
        self.assertEqual(psql_json(self.source, ENABLED_ACCOUNTS), accounts)

    # --- the target against the export and the source -------------------------

    def test_export_reads_every_table_it_should(self):
        schemas = script_array("DATA_SCHEMAS")
        excluded = {quoted(table) for table in script_array("DATA_EXCLUDED_TABLES")}
        in_source = set(psql_json(self.source, f"""
            SELECT coalesce(json_agg('"' || schemaname || '"."' || tablename || '"'), '[]') FROM pg_tables
            WHERE schemaname IN ({", ".join(f"'{schema}'" for schema in schemas)})"""))
        exported = set(self.export_tables())
        self.assertEqual(sorted(exported), sorted(in_source - excluded))
        self.assertFalse(exported & excluded)

    def test_every_exported_table_has_its_rows_in_the_target(self):
        expected = self.export_tables()
        self.assertGreater(expected['"public"."billing_line_items"'], 0)
        self.assertEqual(row_counts(self.target, expected), expected)

    def test_closed_billing_period_is_identical(self):
        query = CLOSED_PERIOD.format(period=self.closed_period)
        source, target = psql_json(self.source, query), psql_json(self.target, query)
        self.assertEqual(source["period"]["status"], "closed")
        self.assertEqual(len(source["line_items"]), 2)
        self.assertTrue(source["payment_events"])
        self.assertTrue(source["audit"])
        self.assertIsNotNone(source["tariff"])
        self.assertEqual(target, source)

    def test_sessions_refresh_tokens_and_mfa_factors_stay_out(self):
        data = (self.export_dir / "data.sql").read_text()
        self.assertNotIn(self.refresh_token, data)
        self.assertNotIn(self.totp_secret, data)
        counts = f"""
            SELECT json_build_object(
              'sessions', (SELECT count(*) FROM auth.sessions WHERE user_id = '{self.user}'),
              'refresh_tokens', (SELECT count(*) FROM auth.refresh_tokens WHERE user_id = '{self.user}'),
              'mfa_factors', (SELECT count(*) FROM auth.mfa_factors WHERE user_id = '{self.user}'),
              'users', (SELECT count(*) FROM auth.users WHERE id = '{self.user}'),
              'identities', (SELECT count(*) FROM auth.identities WHERE user_id = '{self.user}'))"""
        self.assertEqual(
            psql_json(self.source, counts),
            {"sessions": 1, "refresh_tokens": 1, "mfa_factors": 1, "users": 1, "identities": 1},
        )
        self.assertEqual(
            psql_json(self.target, counts),
            {"sessions": 0, "refresh_tokens": 0, "mfa_factors": 0, "users": 1, "identities": 1},
        )

    def test_restore_disables_merchant_accounts_and_reports_them(self):
        self.assertTrue(self.enabled_accounts)
        self.assertEqual(sorted(set(UUID.findall(self.restore_result.stdout))), sorted(self.enabled_accounts))
        self.assertEqual(psql_value(self.target, "SELECT count(*) FROM payment_merchant_accounts WHERE NOT disabled"), "0")

    def test_schema_public_and_its_privileges_match_the_source(self):
        # Compared as lines, so the order pg_dump lists grantees in does not matter.
        source, target = public_schema(self.source), public_schema(self.target)
        only_source = sorted((source - target).elements())
        only_target = sorted((target - source).elements())
        self.assertEqual(
            (only_source, only_target), ([], []),
            "schema public in the target differs from the source's, in definitions or privileges.\n"
            "Only in the source:\n  " + "\n  ".join(only_source[:40])
            + "\nOnly in the target:\n  " + "\n  ".join(only_target[:40]),
        )

    def test_objects_on_supabase_managed_tables_match_the_source(self):
        self.assertEqual(psql_json(self.target, MANAGED_OBJECTS), psql_json(self.source, MANAGED_OBJECTS))

    def test_migration_history_matches_the_source(self):
        query = "SELECT coalesce(json_agg(version ORDER BY version), '[]') FROM supabase_migrations.schema_migrations"
        source = psql_json(self.source, query)
        self.assertTrue(source)
        self.assertEqual(psql_json(self.target, query), source)

    def test_target_schedules_no_jobs(self):
        query = "SELECT count(*) FROM cron.job WHERE jobname = 'mgm-payments-reconcile'"
        self.assertEqual(psql_value(self.source, query), "1")
        self.assertEqual(psql_value(self.target, query), "0")


class AuthTableClassificationTests(unittest.TestCase):
    """The data dump reads all of schema auth except the tables the script names."""

    def test_every_auth_table_is_exported_knowingly_or_left_out(self):
        source = required_url(SOURCE_ENV)
        require_programs()
        server_major(source)
        excluded = {table for table in script_array("DATA_EXCLUDED_TABLES") if table.startswith("auth.")}
        self.assertTrue(excluded, "cannot read the script's excluded tables")
        self.assertEqual(sorted(excluded & set(AUTH_TABLES_EXPORTED)), [], "listed as both exported and left out")
        tables = psql_json(
            source,
            "SELECT coalesce(json_agg('auth.' || tablename ORDER BY tablename), '[]') FROM pg_tables WHERE schemaname = 'auth'",
        )
        self.assertIn("auth.users", tables)
        unclassified = sorted(set(tables) - excluded - set(AUTH_TABLES_EXPORTED))
        self.assertEqual(
            unclassified, [],
            "Auth has tables that scripts/backup/export-database.sh neither leaves out (DATA_EXCLUDED_TABLES) "
            "nor this test lists as knowingly exported (AUTH_TABLES_EXPORTED). Decide for each: a table holding "
            "sessions, tokens, pending sign-in state, second factors or a secret goes into the script's "
            "exclusions; anything else goes into AUTH_TABLES_EXPORTED.",
        )


if __name__ == "__main__":
    unittest.main()
