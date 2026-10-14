# Manual credential-key maintenance

This tooling is separate from the MGM rename deployment. Merge and deploy the
key-name migration first. No deployment, schedule, or workflow invokes these
operations against production. CI rehearsals use a disposable local database.

## Before committing an operation

1. Back up the current key in the password manager. For rotation, generate a
   new key there and save it before use.
2. Pause credential configuration writes and drain in-flight requests. Keep
   them paused until verification completes. Table locks do not drain requests
   that already encrypted a secret before the maintenance transaction.
3. Select the intended database explicitly through a PostgreSQL service entry
   (`PGSERVICE`) or `PGDATABASE` and normal `PG*` connection variables. Keep
   connection passwords out of command arguments and repository files.
4. Use PostgreSQL client tools (`psql`) and a privileged maintenance connection.
   Follow the team's controls for sensitive SQL and database logging; do not
   use statement tracing or paste key-bearing SQL into shared logs.

## Rehearse first

From the repository root:

```bash
PGSERVICE=your-maintenance-service python3 scripts/credential-key-maintenance.py rotate
PGSERVICE=your-maintenance-service python3 scripts/credential-key-maintenance.py retire
```

Both commands default to rollback. Rotation asks for the replacement key twice
using a hidden prompt; it is transmitted through psql stdin, not command-line
arguments or a temporary file. Client diagnostics are suppressed because SQL
error context can include the key. A failed command requires checking database
state through a privileged connection before retrying, especially if the
connection failed around commit.

The rotation helper rekeys current credentials and historical merchant
snapshots. The retirement helper refuses missing MGM keys or conflicting key
values, removes only the legacy key, and verifies all protected values after
removal. A verification error aborts the transaction. Repeating retirement is
safe when the legacy key is already absent.

## Commit only the selected operation

After the dry run passes and the prerequisites above are fulfilled:

```bash
PGSERVICE=your-maintenance-service python3 scripts/credential-key-maintenance.py rotate --commit --credential-writes-paused --backup-confirmed
PGSERVICE=your-maintenance-service python3 scripts/credential-key-maintenance.py retire --commit --credential-writes-paused --backup-confirmed
```

These are independent operations; retirement does not require rotating the
key. The flags are operator acknowledgments, not automatic downtime detection.
Run one at a time. Verify an OpenEMS connection, the active Pesapal account,
and an existing payment attempt before resuming credential writes. Keep the
old key backup until the verification is complete. See [the DEK runbook](dek.md)
for recovery and the list of protected data.
