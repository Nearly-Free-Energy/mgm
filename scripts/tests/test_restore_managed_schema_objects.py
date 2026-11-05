"""Keeps supabase/scripts/restore-managed-schema-objects.sql in step with the migrations.

A logical restore (docs/runbooks/backup-and-restore.md) loses every object MGM's
migrations attach to tables in schemas Supabase manages, because the Supabase
CLI's schema dump leaves those schemas out. The restore script re-creates them.
These tests replay the migrations' CREATE and DROP statements for triggers and
policies on such tables, and require the script to hold exactly the surviving
statements. Anything else a migration does to a Supabase-managed table (a
grant, an index, ALTER TABLE, ALTER POLICY) is not modelled here and fails the
build until the script, the runbook and this test handle it.

The parser reads statements that start a line and end at the first semicolon,
which is how the migrations write them. If a migration starts creating these
objects another way (dynamic SQL in a DO block, say), the reference check below
still flags the table name; revisit both the parser and the script then.

The export also leaves out pg_cron's jobs (scripts/backup/export-database.sh),
so a production replacement re-creates at the cutover every job the
migrations schedule. The last tests replay the migrations' cron.schedule and
cron.unschedule calls and require the runbook to schedule each surviving job
with the same name, schedule and command.
"""
from pathlib import Path
import re
import unittest

REPO = Path(__file__).resolve().parents[2]
MIGRATIONS = REPO / "supabase" / "migrations"
RESTORE_SCRIPT = REPO / "supabase" / "scripts" / "restore-managed-schema-objects.sql"
RUNBOOK = REPO / "docs" / "runbooks" / "backup-and-restore.md"

# Schemas the Supabase CLI's schema dump leaves out that MGM could plausibly
# attach objects to.
MANAGED_SCHEMAS = (
    "auth", "storage", "realtime", "supabase_functions", "cron", "net", "vault",
    "extensions", "graphql", "graphql_public", "pgsodium", "pgbouncer", "pgmq",
)
MANAGED = "|".join(MANAGED_SCHEMAS)
IDENT = r'(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)'
QUALIFIED = rf"{IDENT}(?:\s*\.\s*{IDENT})?"

STATEMENT = re.compile(
    r"^[ \t]*(?P<verb>CREATE(?:\s+OR\s+REPLACE)?(?:\s+CONSTRAINT)?|DROP|ALTER)\s+"
    r"(?P<kind>TRIGGER|POLICY)\b(?P<rest>[^;]*);",
    re.IGNORECASE | re.MULTILINE,
)
TARGET = re.compile(
    rf"^\s*(?P<if_exists>IF\s+EXISTS\s+)?(?P<name>{IDENT})\s.*?\bON\s+(?:ONLY\s+)?(?P<table>{QUALIFIED})",
    re.IGNORECASE | re.DOTALL,
)
MANAGED_REFERENCE = re.compile(
    rf"\b(?:ON|TABLE)\s+"
    rf"(?:(?:TABLE|FUNCTION|ROUTINE|PROCEDURE|SEQUENCE|SCHEMA|IF\s+EXISTS|"
    rf"ALL\s+(?:TABLES|FUNCTIONS|ROUTINES|PROCEDURES|SEQUENCES)\s+IN\s+SCHEMA)\s+)?"
    rf'(?:ONLY\s+)?"?(?:{MANAGED})"?(?:\s*\.|\b)',
    re.IGNORECASE,
)


SQL_TEXT = r"'((?:[^']|'')*)'"
CRON_SCHEDULE = re.compile(rf"cron\.schedule\s*\(\s*{SQL_TEXT}\s*,\s*{SQL_TEXT}\s*,\s*{SQL_TEXT}\s*\)", re.I)
CRON_UNSCHEDULE = re.compile(rf"cron\.unschedule\s*\(\s*{SQL_TEXT}\s*\)", re.I)
CRON_CALL = re.compile(r"\bcron\.\w+\s*\(", re.I)


def strip_comments(sql):
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    return re.sub(r"--[^\n]*", "", sql)


def identifier(text):
    text = text.strip()
    return text[1:-1] if text.startswith('"') else text.lower()


def qualified(text):
    parts = [identifier(part) for part in re.findall(IDENT, text)]
    return ".".join(parts) if len(parts) == 2 else "public." + parts[0]


def normalise(statement):
    return re.sub(r"\s+", " ", statement).strip()


def statements(sql):
    """Yields (verb, kind, schema.table, name, if_exists, normalised text, span)."""
    for match in STATEMENT.finditer(sql):
        target = TARGET.match(match.group("rest"))
        if not target:
            raise AssertionError(f"cannot read the target of: {normalise(match.group(0))}")
        verb = normalise(match.group("verb")).upper()
        table = qualified(target.group("table"))
        yield (
            verb.split()[0], match.group("kind").upper(), table, identifier(target.group("name")),
            bool(target.group("if_exists")), normalise(match.group(0)), match.span(),
        )


def is_managed(table):
    return table.split(".", 1)[0] in MANAGED_SCHEMAS


def migration_files():
    return sorted(MIGRATIONS.glob("*.sql"))


def surviving_objects():
    """Replays the migrations; returns ({key: statement}, [unmodelled references])."""
    objects, unmodelled = {}, []
    for path in migration_files():
        sql = strip_comments(path.read_text())
        modelled_spans = []
        for verb, kind, table, name, _, text, span in statements(sql):
            if not is_managed(table):
                continue
            key = (kind, table, name)
            if verb == "CREATE":
                objects[key] = text
            elif verb == "DROP":
                objects.pop(key, None)
            else:
                unmodelled.append(f"{path.name}: {text}")
            modelled_spans.append(span)
        for reference in MANAGED_REFERENCE.finditer(sql):
            if not any(start <= reference.start() < end for start, end in modelled_spans):
                line = sql.count("\n", 0, reference.start()) + 1
                unmodelled.append(f"{path.name} line {line}: {normalise(reference.group(0))}")
    return objects, unmodelled


def scheduled_jobs():
    """Replays the migrations' pg_cron calls; returns ({name: (schedule, command)}, [unmodelled calls])."""
    jobs, unmodelled = {}, []
    for path in migration_files():
        sql = strip_comments(path.read_text())
        events = [(m.start(), "schedule", m.groups()) for m in CRON_SCHEDULE.finditer(sql)]
        events += [(m.start(), "unschedule", m.groups()) for m in CRON_UNSCHEDULE.finditer(sql)]
        modelled = {start for start, _, _ in events}
        for call in CRON_CALL.finditer(sql):
            if call.start() not in modelled:
                line = sql.count("\n", 0, call.start()) + 1
                unmodelled.append(f"{path.name} line {line}: {call.group(0)}")
        for _, kind, groups in sorted(events):
            name = groups[0].replace("''", "'")
            if kind == "schedule":
                jobs[name] = groups[1:]
            else:
                jobs.pop(name, None)
    return jobs, unmodelled


class RestoreManagedSchemaObjectsTests(unittest.TestCase):
    def setUp(self):
        self.script = strip_comments(RESTORE_SCRIPT.read_text())
        self.script_statements = list(statements(self.script))

    def test_parser_finds_the_migrations_objects(self):
        objects, _ = surviving_objects()
        self.assertTrue(objects, "no trigger or policy on a Supabase-managed table found; has the parser broken?")

    def test_every_change_to_a_managed_table_is_modelled(self):
        _, unmodelled = surviving_objects()
        self.assertEqual(
            unmodelled, [],
            "a migration changes a table in a Supabase-managed schema in a way this test does not model; "
            "a logical restore loses it. Re-create it in supabase/scripts/restore-managed-schema-objects.sql, "
            "describe it in docs/runbooks/backup-and-restore.md, and extend this test.",
        )

    def test_script_recreates_exactly_the_surviving_objects(self):
        objects, _ = surviving_objects()
        created = {
            (kind, table, name): text
            for verb, kind, table, name, _, text, _ in self.script_statements
            if verb == "CREATE"
        }
        self.assertEqual(
            created, objects,
            "restore-managed-schema-objects.sql must hold, verbatim, the newest CREATE statement of every "
            "trigger and policy the migrations leave on Supabase-managed tables, and nothing else.",
        )

    def test_script_drops_each_object_before_creating_it(self):
        dropped = set()
        for verb, kind, table, name, if_exists, text, _ in self.script_statements:
            key = (kind, table, name)
            if verb == "DROP":
                self.assertTrue(if_exists, f"use DROP ... IF EXISTS so the script is idempotent: {text}")
                dropped.add(key)
            elif verb == "CREATE":
                self.assertIn(key, dropped, f"drop the object before creating it: {text}")
            else:
                self.fail(f"unexpected statement in the restore script: {text}")

    def test_script_leaves_transaction_control_to_the_caller(self):
        self.assertIsNone(
            re.search(r"^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b", self.script, re.I | re.M),
            "the runbook runs this script inside psql --single-transaction",
        )

    def test_runbook_runs_the_script(self):
        self.assertTrue(
            "supabase/scripts/restore-managed-schema-objects.sql" in RUNBOOK.read_text(),
            "the logical restore steps in docs/runbooks/backup-and-restore.md must run the script",
        )

    def test_parser_finds_the_scheduled_jobs(self):
        jobs, _ = scheduled_jobs()
        self.assertIn("mgm-payments-reconcile", jobs, "no pg_cron job found; has the parser broken?")

    def test_every_pg_cron_call_is_modelled(self):
        _, unmodelled = scheduled_jobs()
        self.assertEqual(
            unmodelled, [],
            "a migration calls pg_cron in a form this test does not read; the export leaves pg_cron's jobs "
            "out, so make sure the cutover in docs/runbooks/backup-and-restore.md re-creates what it does, "
            "and extend this test.",
        )

    def test_runbook_schedules_every_job_the_migrations_schedule(self):
        jobs, _ = scheduled_jobs()
        runbook = RUNBOOK.read_text()
        for name, (schedule, command) in jobs.items():
            with self.subTest(job=name):
                statement = f"SELECT cron.schedule('{name}', '{schedule}', '{command}');"
                self.assertIn(
                    statement, runbook,
                    "the export leaves pg_cron's jobs out, so the cutover in docs/runbooks/backup-and-restore.md "
                    "must schedule this job exactly as the newest migration that schedules it does",
                )


if __name__ == "__main__":
    unittest.main()
