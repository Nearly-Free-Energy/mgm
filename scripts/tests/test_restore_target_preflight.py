"""Keeps the restore-target check, and the files around it, in the logical restore.

supabase/scripts/restore-target-preflight.sql stops a logical restore unless
its target is empty, so a restore pointed at a live database writes nothing.
docs/runbooks/backup-and-restore.md runs it on its own before any export is
decrypted, and again as the first file of the restore transaction. These tests
fail if the runbook stops doing either, or if the check starts writing or
managing a transaction itself. What the check accepts and refuses is
exercised against real databases by the end-to-end restore test.

supabase/scripts/restore-default-privileges.sql must run in the same
transaction before schema.sql creates any object, or the restored objects'
privileges differ from the source's. The end-to-end restore test compares
them; the test here keeps the order without a database.
"""
from pathlib import Path
import re
import shlex
import unittest

REPO = Path(__file__).resolve().parents[2]
PREFLIGHT = REPO / "supabase" / "scripts" / "restore-target-preflight.sql"
RUNBOOK = REPO / "docs" / "runbooks" / "backup-and-restore.md"
GENERATED_TYPES = REPO / "src" / "lib" / "types" / "database.gen.ts"
PREFLIGHT_ARG = "$MGM_CHECKOUT/supabase/scripts/restore-target-preflight.sql"
DEFAULT_PRIVILEGES = REPO / "supabase" / "scripts" / "restore-default-privileges.sql"
DEFAULT_PRIVILEGES_ARG = "$MGM_CHECKOUT/supabase/scripts/restore-default-privileges.sql"


def bash_blocks():
    return re.findall(r"```bash\n(.*?)```", RUNBOOK.read_text(), re.S)


def psql_inputs(block):
    """The --file and --command arguments of the psql command in a block, in order."""
    words = shlex.split(block.replace("\\\n", " "), comments=True)
    inputs = []
    for option, value in zip(words, words[1:]):
        if option in ("--file", "-f", "--command", "-c"):
            inputs.append((option, value))
    return inputs


def sql_without_comments_and_strings(text):
    text = re.sub(r"--[^\n]*", "", text)
    return re.sub(r"'(?:[^']|'')*'", "''", text)


def restore_inputs(test):
    restores = [
        block for block in bash_blocks()
        if "--single-transaction" in block and "restore-managed-schema-objects.sql" in block
    ]
    test.assertEqual(len(restores), 1, "expected one restore command in the runbook; has it moved?")
    return psql_inputs(restores[0])


class RestoreTargetPreflightTests(unittest.TestCase):
    def test_restore_transaction_runs_the_check_first(self):
        inputs = restore_inputs(self)
        self.assertTrue(inputs, "no --file or --command found in the restore command; has the parser broken?")
        self.assertEqual(
            inputs[0], ("--file", PREFLIGHT_ARG),
            "the restore transaction must run restore-target-preflight.sql before anything else, "
            "so a target that is not empty stops the restore before it writes",
        )

    def test_restore_transaction_clears_default_privileges_before_creating_objects(self):
        self.assertTrue(DEFAULT_PRIVILEGES.is_file(), f"{DEFAULT_PRIVILEGES.relative_to(REPO)} is missing")
        inputs = restore_inputs(self)
        self.assertIn(("--file", DEFAULT_PRIVILEGES_ARG), inputs, "the restore must run restore-default-privileges.sql")
        self.assertIn(("--file", "schema.sql"), inputs, "no schema.sql in the restore command; has it moved?")
        self.assertLess(
            inputs.index(("--file", DEFAULT_PRIVILEGES_ARG)), inputs.index(("--file", "schema.sql")),
            "restore-default-privileges.sql must run before schema.sql creates the objects it applies to",
        )
        sql = sql_without_comments_and_strings(DEFAULT_PRIVILEGES.read_text())
        statements = [s.strip() for s in sql.split(";") if s.strip()]
        self.assertTrue(statements, "restore-default-privileges.sql has no statements")
        for statement in statements:
            with self.subTest(statement=statement):
                self.assertRegex(
                    statement, r"(?is)^ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+postgres\s+IN\s+SCHEMA\s+public\s+REVOKE\s",
                    "restore-default-privileges.sql only narrows default privileges in schema public",
                )

    def test_runbook_runs_the_check_before_decrypting(self):
        blocks = bash_blocks()
        standalone = [
            i for i, block in enumerate(blocks)
            if PREFLIGHT_ARG in block and "--single-transaction" not in block
        ]
        decrypt = [i for i, block in enumerate(blocks) if "age --decrypt" in block]
        self.assertTrue(standalone, "the runbook must run restore-target-preflight.sql when it confirms the target")
        self.assertTrue(decrypt, "no decryption command found in the runbook; has it moved?")
        self.assertLess(
            standalone[0], decrypt[0],
            "confirm the target before decrypting an export, so personal data is not decrypted for the wrong target",
        )
        self.assertIn("ON_ERROR_STOP=1", blocks[standalone[0]], "a failed check must make psql exit non-zero")

    def test_check_writes_nothing_and_leaves_the_transaction_to_the_caller(self):
        sql = sql_without_comments_and_strings(PREFLIGHT.read_text())
        self.assertIsNone(
            re.search(r"^\s*(BEGIN\s*;|COMMIT|ROLLBACK|START\s+TRANSACTION|END\s*;)", sql, re.I | re.M),
            "the runbook runs this check inside psql --single-transaction",
        )
        self.assertIsNone(
            re.search(r"\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|DROP|ALTER|GRANT|REVOKE|COPY|SET)\b", sql, re.I),
            "the check must write nothing: it also runs on its own against a target that is not yet confirmed",
        )

    def test_tables_the_check_counts_exist(self):
        # The counts explain a refusal; the check on schema public decides it.
        # A renamed table would be skipped silently, so keep the list current.
        listed = re.search(r"live_tables\s+CONSTANT\s+text\[\]\s*:=\s*ARRAY\[(.*?)\]", PREFLIGHT.read_text(), re.S)
        self.assertIsNotNone(listed, "live_tables not found in the check; has the parser broken?")
        generated = GENERATED_TYPES.read_text()
        for name in re.findall(r"'public\.([a-z_]+)'", listed.group(1)):
            with self.subTest(table=name):
                self.assertRegex(
                    generated, rf"\n\s+{name}: \{{\n\s+Row: \{{",
                    "restore-target-preflight.sql counts a table that is no longer in the schema",
                )


if __name__ == "__main__":
    unittest.main()
