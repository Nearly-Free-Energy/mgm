#!/usr/bin/env python3
"""Manual DEK maintenance. Dry-run by default; secrets never enter argv/files."""
import argparse
import getpass
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def sql_literal(value):
    return "'" + value.replace("'", "''") + "'"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["rotate", "retire"])
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--credential-writes-paused", action="store_true")
    parser.add_argument("--backup-confirmed", action="store_true")
    args = parser.parse_args(argv)
    if args.commit and not (args.credential_writes_paused and args.backup_confirmed):
        parser.error("Commit requires --credential-writes-paused and --backup-confirmed")
    if not (os.environ.get("PGSERVICE") or os.environ.get("PGDATABASE")):
        parser.error("Configure PGSERVICE or PGDATABASE for the intended database")
    if args.operation == "rotate":
        key = getpass.getpass("Replacement key (already saved in password manager): ")
        if len(key) < 32 or key != getpass.getpass("Confirm replacement key: "):
            parser.error("Replacement keys must match and contain at least 32 characters")
        helper = "rotate-credential-key.sql"
        call = "SELECT pg_temp.mgm_rotate_credential_key(" + sql_literal(key) + ");"
    else:
        helper = "retire-legacy-credential-key.sql"
        call = "SELECT pg_temp.mgm_retire_legacy_credential_key();"
    sql = "BEGIN;\nSET standard_conforming_strings=on;\nSET lock_timeout='10s';\nSET statement_timeout='5min';\n"
    sql += (ROOT / "supabase" / "scripts" / helper).read_text() + "\n" + call
    sql += "\nCOMMIT;\n" if args.commit else "\nROLLBACK;\n"
    try:
        result = subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1"],
                                input=sql, text=True, capture_output=True)
    except FileNotFoundError:
        print("Install PostgreSQL client tools (psql) before maintenance.", file=sys.stderr)
        return 1
    # Do not echo psql diagnostics: SQL context can contain the replacement key.
    if result.returncode:
        print("Maintenance did not confirm completion. Verify database state through a privileged connection before retrying.", file=sys.stderr)
        return 1
    print("Maintenance committed." if args.commit else "Dry run passed; all changes rolled back.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
