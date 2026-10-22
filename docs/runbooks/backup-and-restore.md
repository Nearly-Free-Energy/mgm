# Runbook: backup and restore

An MGM installation is recoverable only when you hold more than a database
export. Stored credentials need the credential encryption key, uploaded files
live in Supabase Storage, and Auth and application settings live outside the
database. This runbook covers what to keep, how to export on a schedule, what
your Supabase plan changes, the two kinds of restore, how to keep a restored
copy away from live payments, and how to verify and record a restore.

Rehearse every procedure here in an isolated target before you need it.
Restoring a production replacement uses the same steps, plus the cutover
steps at the end of [Keep restore targets away from live payments](#keep-restore-targets-away-from-live-payments).
Details of the credential key are in [the credential key runbook](dek.md).

Keep environment identifiers, URLs, account details and verification records
in your private operations records, not in this repository.

## Recovery inputs

| Input | Where it lives | In the database export | How to keep it |
|---|---|---|---|
| Schema and data, including Auth users and Storage object metadata | Postgres | Yes: `schema.sql`, `data.sql`. Auth sessions and refresh tokens, MFA factors, pending sign-in and OAuth authorization state, WebAuthn challenges and custom OAuth providers are left out ([Run an export](#run-an-export)). | Scheduled, encrypted exports |
| Scheduled jobs (pg_cron) and queued outbound requests (pg_net) | Postgres, in schemas Supabase manages | No | MGM's payment reconciliation job is re-created at the [cutover](#keep-restore-targets-away-from-live-payments). Record any job you add yourself. |
| MGM's triggers and policies on tables in `auth` and `storage` | Postgres, in schemas Supabase manages | No | Re-created from the release by [`supabase/scripts/restore-managed-schema-objects.sql`](../../supabase/scripts/restore-managed-schema-objects.sql) |
| Database roles | Postgres cluster | Yes, without passwords: `roles.sql` | Keep custom login role passwords offline |
| Migration history | `supabase_migrations` schema | Yes: `history_schema.sql`, `history_data.sql` | Part of the export |
| Credential encryption key | Vault secret `mgm_ems_dek` | No | An offline copy, required in addition to any password-manager entry ([dek.md](dek.md)) |
| Payment worker URL and secret | Vault secrets `payments_worker_url`, `payments_worker_secret`; the application's `PAYMENTS_WORKER_SECRET` | No | An offline copy of the secret, in addition to any password-manager entry; the URL in your records ([payments rollout](../payments-rollout.md)) |
| Uploaded files (invoice logos) | Supabase Storage | Metadata only | An encrypted file copy ([Copy Storage files](#copy-storage-files)) |
| Auth settings: site URL, redirect URLs, SMTP, email templates, providers, including any custom OAuth provider | Supabase project settings, and Auth's `custom_oauth_providers` table | No | A private record, with the SMTP password and provider client secrets kept as secrets |
| Extensions MGM needs: Vault, pg_cron, pg_net | Supabase project | Do not rely on it | Enable them in the target before restoring |
| Application configuration | Your hosting environment | No | A private record, with secrets kept offline |
| Payment provider notification registrations, one per merchant account | The payment provider | Registration IDs only | A private record |
| The age identity that decrypts exports | Offline | n/a | At least two offline copies |
| The SHA-256 of each export | The export scheduler's log | n/a | Kept outside export storage |

The Vault secrets in this table are the ones MGM's migrations read. If a
migration adds a Vault secret, add it here and to the restore steps below.

The schema dump leaves out the schemas Supabase manages, such as `auth` and
`storage`, and with them any trigger, policy or grant a migration puts on
their tables. If a migration adds one, add it to
`restore-managed-schema-objects.sql` and to this runbook. The data dump leaves
out pg_cron's jobs, so a job a migration schedules must be re-created at the
cutover. `scripts/tests/test_restore_managed_schema_objects.py` fails until the
script matches the migrations' triggers and policies and this runbook
schedules every job the migrations schedule, and fails on any other change to
those tables until the test is extended to cover it.

An export contains personal data (Auth users and their password hashes,
households, bills and payments) and the ciphertext of every stored
credential. Treat it as confidential even when it is encrypted. It leaves out
Auth's sessions, refresh tokens and MFA factors, so it cannot be used to resume
anyone's session. Everyone signs in again after a restore, and users who had
enrolled an MFA factor enroll it again.

## Keep keys and exports apart

An export plus the credential key is every stored credential in plaintext.

- Store key copies (the credential key, the payment worker secret, the age
  identity) somewhere other than export storage: a different account,
  provider and set of credentials. Never put them in the same bucket or
  archive as an export.
- **Treat the export connection string as a full-access secret.** Exports
  run with the database's `postgres` connection string
  ([Requirements](#requirements)). That login can read every table and every
  Vault secret, including the credential key and the payment worker secret,
  and can change the database, so whoever holds it holds as much as an export
  and its keys together. Keep it in the scheduler's secret store, give it only
  to the export job and the people who run it, and change the database
  password, and the stored connection string with it, when one of them
  leaves.
- The host that runs exports needs only the age *public* recipient, so the
  exports it writes are unreadable without the offline identity. It does hold
  the connection string, so protect it as you would the database itself.
- Keep the age identity offline, with at least two copies held by different
  people. Losing it makes every export unreadable, so decrypt one in each
  rehearsal.
- When you replace the age key, keep the old identity for as long as you keep
  exports encrypted to it.
- Never paste a key into an issue, pull request, chat or log.

## What your Supabase plan changes

The procedures in this runbook need no paid Supabase feature; Storage files
have a copy method for any plan ([Copy Storage files](#copy-storage-files)). A
plan changes only what you have besides them. Supabase's plans change,
so check these points against its current
[database backups](https://supabase.com/docs/guides/platform/backups),
[billing](https://supabase.com/docs/guides/platform/billing-on-supabase) and
[upgrading](https://supabase.com/docs/guides/platform/upgrading) pages before
relying on them:

- **Provider backups.** Supabase backs up Pro, Team and Enterprise projects
  daily and offers point-in-time recovery as an add-on. The free plan has
  neither, and Supabase's guidance for it is to export regularly with the CLI
  and keep copies off-site. On the free plan, the scheduled exports, the
  Storage copy, your settings records and the offline key copies described
  here are your only way back, so treat them as required.
- **Restore to a new project** needs a paid plan with physical backups.
  Without it, a restore into a new project is a
  [logical restore](#logical-restore-steps).
- **Project limit.** The free plan grants a fixed number of free projects
  across the organizations you own or administer; paused projects do not
  count. A restore target is a project of its own, so plan rehearsals within
  that limit and delete the target when the rehearsal ends.
- **Pausing.** Free projects can be paused. Treat a failed or missing export
  as an incident, whatever the cause.

The paid features are optional tradeoffs, not requirements. Provider backups
and point-in-time recovery restore in place and can shorten the time since the
last good copy. Restore to a new project carries Vault's root key, but starts
scheduled jobs immediately ([New environment](#new-environment)). None of them
replaces the exports, which remain the copy you hold outside the provider
account.

## Scheduled exports

[`scripts/backup/export-database.sh`](../../scripts/backup/export-database.sh)
runs `pg_dump` and `pg_dumpall` with the options and output filters of the
Supabase CLI's `supabase db dump`, so the files restore with the commands in
Supabase's
[backup and restore guide](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
Unlike the CLI, its data dump reads only the schemas MGM's data lives in, and
it writes a manifest.

### Requirements

- The PostgreSQL client programs `pg_dump` and `pg_dumpall`, of at least the
  database server's major version (`SHOW server_version;`): `pg_dump` refuses
  to dump a newer server. Operating systems and CI images often ship an older
  client; the PostgreSQL project's package repositories provide every
  supported version. Neither the Supabase CLI nor Docker is needed.
- `bash`, `sed`, `awk`, and `sha256sum` or `shasum`; to encrypt, also `age`,
  `tar` and `gzip`.
- The database's `postgres` connection string, from the project's **Connect**
  dialog. Use the session pooler string unless the export host has IPv6 or the
  project has the IPv4 add-on. Put the password in the string's user-info part
  (`postgresql://user:password@host...`) and percent-encode its special
  characters. The script refuses a `password=` parameter. Treat the string as
  a full-access secret ([Keep keys and exports apart](#keep-keys-and-exports-apart)).

#### Why the export uses the `postgres` login

Two kinds of dedicated login were tried for exports:

- **From explicit grants**, holding `SELECT` on just the tables the export
  reads. Such a login cannot read the Auth tables a restore needs: `postgres`
  can pass on read access to some of them, such as `auth.users`, but not
  access to the `auth` schema itself. Granting that only raises a warning,
  and the login is then refused with "permission denied for schema auth".
- **With `pg_read_all_data` and `BYPASSRLS`.** Such a login can run the
  export. It also reads Auth's session and refresh-token tables, which hold
  what is needed to act as any signed-in user, so it has to be guarded as
  closely as `postgres`. Nor is it read-only in effect:
  `default_transaction_read_only = on` on the login is only a default, which
  a session can turn off with `SET default_transaction_read_only = off`,
  `SET TRANSACTION READ WRITE` or `BEGIN READ WRITE`.

So the export uses the `postgres` login every project already has, and the
protection goes on the connection string: who and what can read it
([Keep keys and exports apart](#keep-keys-and-exports-apart)). Where the
scheduler offers a protected secret scope, such as a deployment environment
with required reviewers, keep the string there.

Revisit this section if Supabase lets `postgres` pass on access to the `auth`
schema, which may make a login built from explicit grants possible. This
returns `false` until it does:

```sql
SELECT has_schema_privilege('postgres', 'auth', 'USAGE WITH GRANT OPTION');
```

### Run an export

The script reads the connection string from the environment variable you name
and never takes it as an argument. Provide the variable from a secret store;
do not type the value on a command line, where shell history keeps it. Every
run must name either the age recipients to encrypt to (`--age-recipients`) or
`--plaintext`; naming neither, or both, is a usage error.

```bash
# MGM_EXPORT_DB_URL comes from the scheduler's secret store.
scripts/backup/export-database.sh \
  --db-url-env MGM_EXPORT_DB_URL \
  --out /srv/mgm-exports \
  --age-recipients /etc/mgm/export-recipients.txt
```

Each run adds `mgm-db-export-<UTC time>.tar.gz.age` to `--out`. It prints the
file's path on stdout and its SHA-256 on stderr, as
`export-database.sh: sha256 <hex>  <file name>`. The archive holds one
directory:

| File | Contents |
|---|---|
| `roles.sql` | Cluster roles, without passwords. Statements about roles Supabase manages are commented out. |
| `schema.sql` | Schema, excluding schemas Supabase manages |
| `data.sql` | Data of the `public`, `auth`, `storage` and `supabase_functions` schemas: MGM's data, Auth users and Storage metadata. It deliberately leaves out Auth's sessions, refresh tokens, MFA factors, challenges and claims, pending sign-in flows, one-time tokens, SAML relay states, pending OAuth authorizations and client states, and WebAuthn challenges: refresh tokens are usable values that do not expire by default ([User sessions](https://supabase.com/docs/guides/auth/sessions)), MFA factors hold TOTP secrets, and pending authorizations hold authorization codes. It also leaves out custom OAuth providers, which hold each provider's client secret; re-create them from your Auth settings record. It keeps the clients registered with Auth's OAuth server, whose secrets Auth stores only as hashes, the consents users gave those clients, and WebAuthn credentials, which are public keys. Because it reads only those schemas, it also leaves out pg_cron's jobs and pg_net's request queue, so a restored database starts no scheduled job and sends no queued request until you choose. |
| `history_schema.sql`, `history_data.sql` | The Supabase CLI migration history |
| `manifest.json` | UTC start time of the export (`created_utc`) and of its data dump (`data_dump_started_utc`), `pg_dump` and server versions, and each file's size and SHA-256 |

Each file comes from a separate `pg_dump` or `pg_dumpall` run, so together
they are not one snapshot. **Do not export during a deploy.** A migration
applied while an export runs can leave `schema.sql` from before it and
`data.sql` from after it, and such an export may not restore. The script
reads the migration history before its first dump and compares it with
`history_data.sql`, its last, and fails with exit code 4 if a migration was
recorded in between; export again once the deploy has finished. It cannot
see a schema change made without recording a migration, such as one made in
the SQL editor. The data dump's snapshot is taken just after
`data_dump_started_utc`, so `data.sql` holds every change committed before
that time, and may lack any change committed later.

The data dump reads every table in `auth` except those named in the script's
`DATA_EXCLUDED_TABLES`, so a table that a Supabase upgrade adds to `auth` is
exported unless it is added there. A test fails when a database built from
the migrations has an Auth table that nobody has reviewed. Your project's
Auth can be newer than the local stack that test runs on, so after each
Supabase upgrade, and at each restore rehearsal, list the project's Auth
tables and compare them with the list from your last review:

```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'auth' ORDER BY 1;
```

A new table that holds sessions, tokens or second factors must be added to
`DATA_EXCLUDED_TABLES` before the next export. Record the reviewed list either
way.

`--plaintext` writes the same files as an unencrypted directory. Use it only
on an encrypted disk for an immediate restore, never on a schedule.

| Exit code | Meaning |
|---|---|
| 0 | Export written |
| 2 | Usage error, including naming neither or both of `--age-recipients` and `--plaintext` |
| 3 | Missing or unusable input: the environment variable, output directory, staging directory, recipients file or a required program. Nothing was dumped. |
| 4 | `pg_dump` or `pg_dumpall` failed or wrote nothing; its error is shown, with the connection string and password removed. Or the migration history changed while the export ran: a deploy ran, and the export must be run again after it. |
| 5 | Computing a size or SHA-256, packaging, encryption or moving the export into place failed |

The script checks everything it can before the first dump, including that
`age` accepts every entry in the recipients file. It hands the password to
`pg_dump` and `pg_dumpall` in the `PGPASSWORD` environment variable, so it
never appears in the process list. It redacts the connection string and
password from any output of theirs it shows.

With `--age-recipients`, the plaintext dumps are staged in a private
directory under `$TMPDIR` (default `/tmp`), never in `--out`. `age` writes to a
hidden `.<name>.tar.gz.age.<process ID>.partial` file in `--out`, which is
renamed when complete. With `--plaintext`, staging is a hidden directory
inside `--out`. On any failure, and after encryption, the script deletes the
staging directory, the plaintext in it and any partial file.

A run that is killed outright (out of memory, power loss, `kill -9`) cannot
clean up. Plaintext can then remain in the staging directory under
`$TMPDIR`, and a `.partial` file in `--out`, until a later run on the same
host removes them. Before it starts, each run deletes the staging directories
and partial files that this script's earlier runs left there, except those
whose name carries the process ID of a process of yours that is running at
that moment. The script checks only whether a process with that ID is
running, not whether it is the run that made the files: a run still in
progress keeps its files, and so does a leftover whose ID another process of
yours has since taken, until a run finds that ID no longer running. So:

- Run exports on a host no one else uses, such as an ephemeral CI runner or a
  dedicated machine with an encrypted disk, and keep `$TMPDIR` on that
  encrypted disk or in memory.
- Make `--out` a local directory, not a mounted bucket or a synced folder, and
  copy only `*.tar.gz.age` files out of it.

### Schedule it

- Export at least daily, and before every upgrade, but not while a deploy
  runs: schedule exports away from deploys, and retry an export that exits
  with code 4 because the migration history changed.
- Pass the connection string to the export step only, as an environment
  variable from the scheduler's secret store.
- Always pass `--age-recipients`, never `--plaintext`, and make the job fail
  unless the path the script prints ends in `.tar.gz.age`, so a `--plaintext`
  added by mistake fails the job instead of storing an unencrypted export.
- Keep the SHA-256 the script prints in the scheduler's log, or another record
  outside export storage. At restore time it shows the file is the one the
  export wrote: anyone who can write to export storage can encrypt a file to
  your public recipients, so the manifest inside an archive proves only that
  the archive is intact.
- Install the PostgreSQL client for the server's major version on the export
  host, and update it when Supabase upgrades the project's Postgres.
- After each Supabase upgrade, check the project's Auth tables against the
  script ([Run an export](#run-an-export)).
- Copy each encrypted export to private storage, kept apart from key copies,
  and apply a retention schedule.
- Alert on a non-zero exit and on a missing export. Watch the export size: a
  sudden drop can mean the wrong database.
- Keep exporting even when Supabase also backs up the project. The exports
  are the copy held outside the provider account, and on the free plan they
  are the only backup ([What your Supabase plan changes](#what-your-supabase-plan-changes)).

### Copy Storage files

Database backups and exports hold only Storage metadata, so copy the files
separately. MGM keeps uploaded invoice logos in the private `invoice-logos`
bucket. They change rarely: a copy after each logo change, or weekly, is
usually enough, and the copy can run on a different host and schedule from the
database export.

Supabase documents two ways to read a bucket:

- The [S3-compatible endpoint](https://supabase.com/docs/guides/storage/s3/compatibility),
  `https://<project-ref>.storage.supabase.co/storage/v1/s3`, with S3 access
  keys created in the project's Storage settings, where the endpoint is also
  enabled. It supports listing, downloading and uploading objects. Check that
  your plan offers it.
- The Storage API with the project's service-role (secret) key, as in the
  "Migrating storage objects" script in Supabase's
  [backup and restore guide](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

Both credentials give read and write access to every bucket and bypass
row-level security ([S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication)).
Keep them out of the export host's secret store unless your policy allows
them there, and never next to key copies.

Which tool you use is your choice; the restore rehearsal must show that it
copies every object and that the copy restores. With the AWS CLI and the S3
endpoint, for example:

```bash
# AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are the project's S3 access
# keys, from a secret store. Run this in a private directory on an encrypted
# disk; the plaintext copy is removed after encryption.
set -euo pipefail
copy="storage-copy-$(date -u +%Y%m%dT%H%M%SZ)"
aws s3 sync s3://invoice-logos "$copy/invoice-logos" \
  --endpoint-url "https://<project-ref>.storage.supabase.co/storage/v1/s3" \
  --region "<project-region>"
tar -czf - "$copy" | age -R /etc/mgm/export-recipients.txt -o "$copy.tar.gz.age"
rm -rf "$copy"
```

### Record Auth settings

Record Auth settings whenever they change, from the dashboard or the
Management API ([`GET /v1/projects/{ref}/config/auth`](https://supabase.com/docs/reference/api/v1-get-auth-service-config)).
That response includes SMTP settings, so store it as a secret. If you add
custom OAuth providers to Auth, record each one's settings and client secret
the same way: the export leaves them out.

## Restore types

### Same project

Restoring into the same project brings Vault back with the data. The project
keeps its root key, so the credential key and other Vault secrets stay
readable and need no action. Supabase offers this as a provider restore from a
daily backup or point-in-time recovery, which are optional paid features
([What your Supabase plan changes](#what-your-supabase-plan-changes)).
Scheduled jobs, payment reconciliation included, resume as soon as the
restore completes. Storage files are not part of database backups. Payments
the payment provider recorded after the restore point are missing from the
restored database; reconcile them before relying on payment status. Invoice
numbers issued after the restore point are missing too: move the invoice
counters past them before anyone renders a bill
([Invoice numbers issued after the export](#invoice-numbers-issued-after-the-export)).
Then work through the [verification checklist](#verification-checklist).

Without provider backups, as on the free plan, there is no same-project
restore. Recover with a logical restore into a new project, followed by the
[cutover steps](#keep-restore-targets-away-from-live-payments). The logical
restore steps below load an export into an empty project; they do not restore
an export over an existing project's data, and stop before writing anything
if the target holds any.

### New environment

There are two ways to restore into a new Supabase project.

**Supabase's restore to a new project** (an optional paid feature that needs
physical backups on the source) copies Vault's root key, so Vault secrets and
stored credentials stay readable. It does not copy Storage files or bucket
settings, Auth settings, API keys or Edge Functions. Scheduled jobs, including
payment reconciliation with the source's worker URL and secret, start running
as soon as the restore completes, and cannot be excluded or paused. Payment
processing therefore starts before you can verify the target. Use it only for
a production replacement where that is acceptable. For rehearsals and every
other target, use a logical restore, as Supabase recommends when cron jobs
must be inspected or removed before they run
([Restore to a new project](https://supabase.com/docs/guides/platform/clone-project)).

**A logical restore from an export** works on any plan. Vault's contents do
not travel with it: the export leaves the `vault` schema out of its data
dump, and the target project has its own root key. You recreate the Vault
secrets from your offline copies. Supabase also documents copying a project's
root key to another project while the source is still active. This runbook
does not rely on that: it is unavailable once the source is gone, and the
export holds no Vault secrets for the key to unlock.

#### Logical restore steps

1. **Prepare the target.** Create the project, record its project ref in your
   private record, and enable the Vault, pg_cron and pg_net extensions. Put
   its connection in a PostgreSQL service entry (`PGSERVICE`) with the
   password in `.pgpass`, so it stays out of command arguments. Use the entry
   for this target only, and remove it when you delete the target. The
   commands below assume a service named `mgm-restore-target`, and a checkout
   of the MGM release you are restoring in `$MGM_CHECKOUT`.

2. **Confirm the target**, before you decrypt anything:

   ```bash
   PGSERVICE=mgm-restore-target psql -X --command '\conninfo'
   PGSERVICE=mgm-restore-target psql -X --variable ON_ERROR_STOP=1 \
     --file "$MGM_CHECKOUT/supabase/scripts/restore-target-preflight.sql"
   ```

   `\conninfo` shows the host and user the service entry connects with. The
   project ref is the `<ref>` in the host `db.<ref>.supabase.co` of a direct
   connection, or in the user `postgres.<ref>` of a pooler connection. Stop
   unless it matches the ref you recorded for this target, and stop if it is
   the ref of any project that serves users.

   `restore-target-preflight.sql` writes nothing. It stops with
   `restore target is not empty` if the target has any table in `public` or
   any Auth user: a new project has neither, and a live MGM database has
   both. Never make a target pass by deleting what it holds. A target that
   holds data is either the wrong database or one that has been restored into
   already, and either way the restore needs a new project. The restore in
   step 4 runs the same check inside its transaction, so a target that has
   changed since still stops the restore before anything is written.

3. **Check, decrypt and verify the export** on a trusted machine with an
   encrypted disk. First compare the encrypted file's SHA-256 with the value
   the scheduler recorded when it wrote that export, and stop if they differ:
   the file is not the one the export wrote. Then bring the age identity from
   offline storage, for this step only.

   ```bash
   sha256sum mgm-db-export-<time>.tar.gz.age   # compare with the scheduler's record
   age --decrypt -i /path/to/age-identity.txt -o export.tar.gz mgm-db-export-<time>.tar.gz.age
   tar -xzf export.tar.gz
   cd mgm-db-export-<time>
   jq -r '.files[] | "\(.sha256)  \(.name)"' manifest.json | sha256sum -c -
   ```

   The manifest check needs `jq`. On macOS, use `shasum -a 256` in place of
   `sha256sum`.

4. **Restore the database** with the commands from Supabase's guide, plus
   four additions that run in the same transaction:

   - `restore-target-preflight.sql` runs first and repeats step 2's check, so
     the transaction stops before writing anything unless the target is
     still empty.
   - `restore-default-privileges.sql` makes the tables, sequences and
     functions that `schema.sql` restores in `public` keep the privileges
     they had in the source. It runs before `schema.sql`, and `schema.sql`
     then sets the source's own default privileges for objects created later.
   - `restore-managed-schema-objects.sql` re-creates the triggers and policies
     MGM's migrations put on `auth` and `storage` tables, which the export
     cannot carry. Without it, new users get no profile and the
     `invoice-logos` bucket has no access policies.
   - The final `--command` disables merchant accounts. Include it on every
     target, a production replacement too: the target then never commits
     with merchant accounts able to start checkouts, and a production
     replacement turns them back on at the cutover, once it is verified. It
     prints the IDs of the accounts it disabled; keep them in your private
     record, because a cutover re-enables exactly those. The payment
     reconciliation job needs no command: the export carries no pg_cron
     jobs, so the target has none until the cutover schedules it.

   ```bash
   PGSERVICE=mgm-restore-target psql --single-transaction --variable ON_ERROR_STOP=1 \
     --file "$MGM_CHECKOUT/supabase/scripts/restore-target-preflight.sql" \
     --file "$MGM_CHECKOUT/supabase/scripts/restore-default-privileges.sql" \
     --file roles.sql \
     --file schema.sql \
     --command 'SET session_replication_role = replica' \
     --file data.sql \
     --file "$MGM_CHECKOUT/supabase/scripts/restore-managed-schema-objects.sql" \
     --command 'UPDATE public.payment_merchant_accounts SET disabled = true WHERE NOT disabled RETURNING id'
   ```

5. **Restore the migration history**, so later upgrades apply only the
   migrations the database is missing:

   ```bash
   PGSERVICE=mgm-restore-target psql --single-transaction --variable ON_ERROR_STOP=1 \
     --file history_schema.sql --file history_data.sql
   ```

   This expects a target without a `supabase_migrations` schema. The Supabase
   CLI creates one when it pushes migrations to a project or seeds it, and the
   restore then stops on a duplicate primary key. If the target has one,
   confirm the target again before you drop it. The preflight cannot run
   again now that step 4 has restored into the target, so check the project
   ref as in step 2:

   ```bash
   PGSERVICE=mgm-restore-target psql -X --command '\conninfo'
   ```

   Stop unless the project ref in the host or user it shows matches the ref
   you recorded for this target, and stop if it is the ref of any project
   that serves users. Then drop the schema and run this step again. The drop
   stops, and drops nothing, if `supabase_migrations.schema_migrations` lists
   any migration, as it does in every database the Supabase CLI has migrated:

   ```bash
   PGSERVICE=mgm-restore-target psql -X --variable ON_ERROR_STOP=1 <<'SQL'
   DO $$
   BEGIN
     IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
       IF EXISTS (SELECT FROM supabase_migrations.schema_migrations) THEN
         RAISE EXCEPTION 'supabase_migrations.schema_migrations lists migrations; not dropping it';
       END IF;
     END IF;
     DROP SCHEMA supabase_migrations CASCADE;
   END $$;
   SQL
   ```

6. **Compare row counts now**, before anyone signs in or anything else writes
   to the target (see the [checklist](#verification-checklist)).

7. **Recreate the credential key, and nothing else in Vault.** This is the
   recovery for a logical restore in [dek.md](dek.md#recover): after
   restoring, replace MGM's Vault entries with your copies, using the same
   key as before, so the restored credentials decrypt again. On a restore
   target it comes in two parts: the key now, and the payment worker entries
   at the [cutover](#keep-restore-targets-away-from-live-payments), on a
   production replacement only. In `psql` with the target's service entry,
   first check that the target holds none of MGM's Vault entries:

   ```sql
   SELECT name FROM vault.secrets
   WHERE name IN ('mgm_ems_dek', 'mbe_ems_dek', 'payments_worker_url', 'payments_worker_secret');
   ```

   The export carries no Vault entries, so this lists none unless someone
   has created them in the target since. If it lists any, run `\conninfo`
   and check the project ref as in step 2, then delete them, as dek.md does:

   ```sql
   DELETE FROM vault.secrets WHERE name IN
     ('mgm_ems_dek', 'mbe_ems_dek', 'payments_worker_url', 'payments_worker_secret');
   ```

   Then create the key from its offline copy. `\prompt` reads it into a psql
   variable, so it stays out of your shell history, psql's history and any
   saved SQL file; it does show what you type, so clear the terminal
   afterwards:

   ```sql
   \prompt 'Credential key: ' dek
   SELECT vault.create_secret(:'dek', 'mgm_ems_dek', 'MGM credential encryption key');
   \unset dek
   ```

   Two things differ from dek.md, to keep the target away from live
   payments:

   - Leave `payments_worker_url` and `payments_worker_secret` unset. A
     production replacement creates them at the cutover, once it is
     verified.
   - Check the key with the checklist's decryption checks, not with
     **Test connection**: **Save and test connection** on a payment account
     registers a notification with the payment provider using live
     credentials and re-enables the account, and a microgrid's connection
     test connects to its energy management system with production
     credentials. On a production replacement, the connection tests dek.md
     asks for come after the cutover.

8. **Copy Storage files** from your latest Storage copy, decrypted on the same
   trusted machine. The data restore already created the bucket definitions
   and object metadata, so copy the objects only. Keep each object's bucket
   and path, and overwrite objects that already exist. With the AWS CLI, for
   example, `aws s3 sync <copy>/invoice-logos s3://invoice-logos` with the
   target's endpoint and S3 access keys.

9. **Apply Auth settings** from your record, with the target's own site URL
   and redirect URLs. Configure SMTP only on a production replacement, so a
   rehearsal cannot email your users. Users and their password hashes come
   with the data, so existing users sign in with their current passwords.
   Sessions do not, so every user signs in again.

10. **Set passwords for custom login roles**, if you have any. `roles.sql`
    carries none. On a production replacement, once it takes over, point the
    scheduled exports at it: put its `postgres` connection string in the
    scheduler's secret store in place of the old one.

11. **Move the invoice counters** (production replacement only) past every
    invoice number the source issued, and give the bills the source first
    rendered after the export the numbers it gave them. Do it before
    deploying the application, so that no bill is numbered before the
    counters move
    ([Invoice numbers issued after the export](#invoice-numbers-issued-after-the-export)).

12. **Deploy the application** at the same MGM release, configured with the
    target project's URL and keys (from the target, not the backup) and the
    target's own public URL.

13. **Verify** with the checklist, and fill in the verification record.

## Keep restore targets away from live payments

A restored database carries what it needs to act on live payments: merchant
credentials (readable again once the credential key is in place) and provider
notification registrations that point at the source's address. Supabase's
restore to a new project also starts the reconciliation job straight away
with the source's worker settings, which is why it is kept for production
replacements. Until a target deliberately takes over production:

- **Leave the reconciliation job unscheduled.** A logical restore has none,
  because the export carries no pg_cron jobs. Check that
  `SELECT jobname, active FROM cron.job;` does not list
  `mgm-payments-reconcile`.
- **Disable merchant accounts** so the target cannot start checkouts with live
  credentials. The logical restore does this inside the restore transaction
  and prints the IDs; keep them.
- **Do not test, save or reconfigure a payment account, refresh a payment's
  status, or create payment links in the target.** Testing or saving an
  account registers a notification URL with the provider using live
  credentials and re-enables the account. Refreshing a payment's status asks
  the provider about it with the original account's live credentials, even
  when the account is disabled, and writes the answer into the target before
  you have compared billing records.
- **On a rehearsal target, consider replacing the stored provider
  credentials with placeholders** once the decryption checks have passed, so
  that nothing in the target can authenticate to a provider.
- **Give the target application its own public URL** and no
  `PAYMENTS_WORKER_SECRET`. Never give it the production domain or production
  secrets.
- **Leave SMTP unconfigured** on rehearsal targets.
- **Delete the target when the rehearsal ends.** It holds production personal
  data.

**Cutover to a production replacement.** Start only once the old environment
has stopped serving and every [checklist](#verification-checklist) item except
**Payment reconciliation running** has passed, so the target is verified
before workers and payment callbacks start:

1. Set `payments_worker_url` and `payments_worker_secret` in Vault for the new
   application, from your copies, as in [dek.md](dek.md#recover). This
   completes the Vault recovery that step 7 of the logical restore began.
2. Schedule the reconciliation job, with the statement from the release's
   migrations:

   ```sql
   SELECT cron.schedule('mgm-payments-reconcile', '*/5 * * * *', 'SELECT public.fn_payment_run_worker()');
   ```

   Check that `SELECT jobname, active FROM cron.job;` lists it as active.
3. Re-enable the merchant accounts whose IDs you recorded.
4. If the public URL changed, update each merchant account's provider
   notification registration, the worker URL in Vault, and Supabase Auth's
   site and redirect URLs, and check each one.
5. Payments made after the export started are not in the target, but the
   payment provider still has them. Reconcile them before relying on payment
   status.
6. Complete the **Payment reconciliation running** checklist item.

Closing billing periods is not a cutover step. Periods the source closed
after the export started stay open through the cutover, and are closed
afterwards by a person, in the application
([Billing periods closed after the export](#billing-periods-closed-after-the-export)).

## Billing periods closed after the export

Closing a billing period is a decision a person makes in the application. A
period that the source closed after the data dump started is open in the
restored target, with the line items it had when the dump started. On a
rehearsal target that is expected and needs nothing more. On a production
replacement:

1. **List them in the verification record**, before the cutover. If the
   source is still reachable, list the periods it closed after the data dump
   started, then keep those that are open in the target:

   ```sql
   SELECT id, microgrid_id, closed_at
   FROM public.billing_periods
   WHERE status = 'closed'
     AND closed_at >= timestamptz '<data_dump_started_utc from the manifest>' - interval '1 hour'
   ORDER BY closed_at;
   ```

   `closed_at` is when the close began, so the hour's margin catches a close
   that was still committing when the snapshot was taken. If the source is
   lost, compare the target's open periods with the invoices issued after the
   export started, and ask the people who close periods.
2. **After the cutover, an authorised person closes each one in the
   application**, the same way as any other period. Readings and bills
   recorded after the export started are missing from the target, so they
   first bring the period up to what was billed from the source, through the
   application, and close it only when it matches. A period that cannot be
   made to match stays open, with the reason in the record.
3. **Record** who closed each period, and when.

Never close a period with SQL, and never as part of the cutover.

## Invoice numbers issued after the export

Each community numbers its bills per year, `<prefix>-<year>-<number>`, from a
counter in `public.invoice_counters`. A bill gets its number the first time it
is rendered, and the counter then records the highest number issued. Numbers
the source issued after the export started are missing from the restored
copy, so its counters are behind the numbers already sent, and the
application would issue those numbers again. A bill that existed at the
export but was first rendered afterwards has no number in the target, so
rendering it there would give it a second number.

On a rehearsal target this needs nothing. On a production replacement, move
the counters and give those bills their numbers before invoicing resumes,
and before anyone renders a bill in the target (logical restore, step 11):

1. **Find the highest number issued** for each community and year. If the
   source is reachable, read its counters:

   ```sql
   SELECT community_id, year, counter AS highest_issued
   FROM public.invoice_counters
   ORDER BY community_id, year;
   ```

   If it is not, take the highest number on the invoices already sent for
   each community and year, from your invoicing records. Include years the
   target has no counter for: numbering starts again each year.
2. **Move the target's counters past them**, through supported
   administration tooling (such as `psql` with the target's service entry),
   with the SQL reviewed by a second person before it runs. One row per
   community and year:

   ```sql
   INSERT INTO public.invoice_counters (community_id, year, counter)
   VALUES ('<community id>', <year>, <highest number issued>)
   ON CONFLICT (community_id, year)
     DO UPDATE SET counter = greatest(invoice_counters.counter, excluded.counter)
   RETURNING community_id, year, counter;
   ```

   The next bill rendered for that community and year then gets the number
   after the counter. `greatest` keeps a counter from moving back. Never reuse
   a number: if you are not sure you have found the highest one, set the
   counter higher and record the gap this leaves.

   A community created after the export started is missing from the restored
   copy, so its counter can't be moved yet. Re-create the community first,
   then move its counter past the highest number it already issued, before
   any of its bills is rendered.
3. **Give bills the numbers the source gave them.** If the source is
   reachable, list the bills that the target holds without a number and the
   source has numbered. Add a service entry for the source, here
   `mgm-restore-source`, as in step 1 of the logical restore, and remove it
   when you are done. Give it the source's `postgres` login, the one exports
   run with ([Requirements](#requirements)): row-level security on
   `public.billing_line_items` stops a login that only has `SELECT` on the
   table, and `postgres` bypasses it. Nothing here writes to the source.
   From a private directory on the trusted machine:

   ```bash
   PGSERVICE=mgm-restore-source psql -X --variable ON_ERROR_STOP=1 \
     --command '\copy (SELECT id, invoice_number FROM public.billing_line_items WHERE invoice_number IS NOT NULL) TO source-invoice-numbers.csv WITH (FORMAT csv)'
   PGSERVICE=mgm-restore-target psql -X --variable ON_ERROR_STOP=1 \
     --command 'CREATE TEMP TABLE source_invoice_numbers (id uuid PRIMARY KEY, invoice_number text NOT NULL)' \
     --command '\copy source_invoice_numbers FROM source-invoice-numbers.csv WITH (FORMAT csv)' \
     --command 'SELECT li.id, s.invoice_number FROM public.billing_line_items li JOIN source_invoice_numbers s USING (id) WHERE li.invoice_number IS NULL ORDER BY s.invoice_number'
   ```

   Each row is a bill that existed at the export and was first rendered
   afterwards, with the number the source gave it, which its customer may
   already have. Give each one that number, so that rendering it in the
   target shows the same number again. With the SQL reviewed by a second
   person, as in step 2, and from the same directory:

   ```bash
   PGSERVICE=mgm-restore-target psql -X --single-transaction --variable ON_ERROR_STOP=1 \
     --command 'CREATE TEMP TABLE source_invoice_numbers (id uuid PRIMARY KEY, invoice_number text NOT NULL)' \
     --command '\copy source_invoice_numbers FROM source-invoice-numbers.csv WITH (FORMAT csv)' \
     --command 'UPDATE public.billing_line_items li SET invoice_number = s.invoice_number FROM source_invoice_numbers s WHERE li.id = s.id AND li.invoice_number IS NULL RETURNING li.id, li.invoice_number'
   ```

   It prints the bills it numbered; check they are the ones listed. A listed
   bill holds what it held at the export. If the source changed it after
   that, bring it up to date in the application before anyone renders it,
   as for [billing periods closed after the export](#billing-periods-closed-after-the-export).

   If the source is lost, match the target's bills that have no number with
   the invoices you sent after the export started, from your invoicing
   records. To give a matched bill its number, put its ID and number on a
   line of `source-invoice-numbers.csv` (`<bill id>,<invoice number>`) and run
   the second command. A bill you cannot match gets a new number when it is
   rendered.
4. **Record** each counter before and after, where the highest numbers came
   from, the bills given the source's numbers, who reviewed the SQL, and any
   bill that will be numbered again because it could not be matched. Delete
   `source-invoice-numbers.csv` once the record is complete.

## Verification checklist

Work in this order. Row counts come first, because signing in and scheduled
jobs write to the target. **Payment reconciliation running** comes last, and
only on a production replacement: it is checked after the cutover, which
starts only when every other item has passed.

- [ ] **Target confirmed.** The target's project ref matched your record, and
  `restore-target-preflight.sql` reported the target empty (logical restore,
  step 2).
- [ ] **Export identity and integrity.** The encrypted file's SHA-256 matched
  the value the scheduler recorded when it wrote the export, which detects a
  substituted file. The manifest checksums matched, which detects corruption
  (logical restore, step 3). `psql` finished without error.
  `--single-transaction` with `ON_ERROR_STOP` means a failed restore leaves
  nothing behind.
- [ ] **Row counts.** Every table in `data.sql` has the same number of rows in
  the target. From the extracted export directory:

  ```bash
  (
    awk '/^COPY /{table=$2; rows=0; next} /^\\\.$/{if (table != "") print table, rows; table=""; next} table != ""{rows++}' data.sql >expected-row-counts.txt &&
      [ -s expected-row-counts.txt ] || { echo "ERROR: no table data read from data.sql" >&2; exit 2; }
    mismatches=0
    while read -r table rows; do
      actual=$(PGSERVICE=mgm-restore-target psql -X -A -t --variable ON_ERROR_STOP=1 \
        --command "SELECT count(*) FROM $table" </dev/null) ||
        { echo "ERROR: psql could not count $table; stopping" >&2; exit 2; }
      if [ "$actual" != "$rows" ]; then
        echo "MISMATCH $table export=$rows target=$actual"
        mismatches=$((mismatches + 1))
      fi
    done <expected-row-counts.txt
    echo "row counts compared; mismatches: $mismatches"
    [ "$mismatches" -eq 0 ]
  )
  ```

  It stops at the first table `psql` cannot count, and its exit status is 0
  only when every count matches. It writes `expected-row-counts.txt` next to
  `data.sql`, so it goes when you delete the decrypted export. A count that cannot be taken is a failed
  check, not a mismatch to explain. Platform-written tables such as Auth's
  audit log can differ if anything has run since the restore. Investigate any
  other mismatch.
- [ ] **Migration history.** `SELECT max(version) FROM
  supabase_migrations.schema_migrations;` matches the newest file in the
  release's `supabase/migrations`.
- [ ] **Objects on Supabase-managed tables.** Every trigger and policy that
  `restore-managed-schema-objects.sql` creates is listed (Supabase's own
  objects appear too):

  ```sql
  SELECT t.tgrelid::regclass AS table_name, t.tgname
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relnamespace::regnamespace::text IN ('auth', 'storage') AND NOT t.tgisinternal;
  SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname IN ('auth', 'storage');
  ```

- [ ] **Payments inactive.** `cron.job` does not list
  `mgm-payments-reconcile`, every merchant account is disabled, and the
  target's Vault holds no worker URL or secret. On a production replacement
  this holds until the cutover.
- [ ] **Dummy credential decrypts.** Keep a canary: a dummy credential with a
  known value, stored on a test microgrid, whose SHA-256 you recorded when
  you saved it. After restore, its hash matches:

  ```sql
  SELECT encode(extensions.digest(fn_ems_decrypt_secret(ems_bearer_token_encrypted), 'sha256'), 'hex')
  FROM microgrids WHERE id = '<canary microgrid id>';
  ```

  Use the column for the canary's authentication type. Then check that
  every stored credential decrypts. Any value that does not decrypt raises
  an error and stops the block. The columns match the table in
  [dek.md](dek.md); when that table changes, change this block.

  ```sql
  DO $$
  BEGIN
    PERFORM fn_ems_decrypt_secret(ems_aws_secret_access_key_encrypted),
            fn_ems_decrypt_secret(ems_basic_auth_password_encrypted),
            fn_ems_decrypt_secret(ems_bearer_token_encrypted),
            fn_ems_decrypt_secret(ems_keycloak_client_secret_encrypted)
      FROM microgrids;
    PERFORM fn_ems_decrypt_secret(secret_encrypted) FROM payment_merchant_accounts;
    PERFORM fn_ems_decrypt_secret(payment_provider_secret_encrypted) FROM communities;
    PERFORM fn_ems_decrypt_secret((configuration->>'secret_encrypted')::bytea) FROM payment_merchant_versions;
    RAISE NOTICE 'every stored credential decrypts';
  END $$;
  ```

- [ ] **Invoice counters** (production replacement only). Before any bill was
  rendered in the target, each community's counter was moved to at least the
  highest number already issued, for every year with issued numbers, and
  every bill the source first rendered after the export has the number the
  source gave it
  ([Invoice numbers issued after the export](#invoice-numbers-issued-after-the-export)).
- [ ] **Files.** `SELECT bucket_id, count(*) FROM storage.objects GROUP BY 1;`
  matches the number of objects copied per bucket. A known invoice logo
  loads in the application and appears on an invoice PDF.
- [ ] **Sign-in.** An existing operator account signs in with its password and
  sees only its own organizations.
- [ ] **Representative billing records.** For a sample of billing periods
  that were already closed when the data dump started (closed in the target),
  compare the target with the source as it stood at that time (the
  manifest's `data_dump_started_utc`), not with what the source holds now. A
  period closed after that is still open in the target, which is not a
  discrepancy; on a production replacement, list it
  ([Billing periods closed after the export](#billing-periods-closed-after-the-export)).
  - The number of line items, the totals, the pinned tariff and the invoice
    numbers match exactly. A closed period does not change.
  - Every payment the target holds for those periods is in the source with
    the same values. A payment the source holds and the target lacks must
    have been recorded after the export started. A later payment is expected,
    not a discrepancy; anything else is.
  - If the source is lost, compare with the invoices you issued for those
    periods and with earlier verification records, until MGM ships its
    billing integrity export ([Verification record](#verification-record)).
- [ ] **Clean-up.** Decrypted export and Storage copies, and any
  `source-invoice-numbers.csv`, are deleted. A rehearsal target is deleted.
- [ ] **Payment reconciliation running** (production replacement only, after
  the cutover). Within ten minutes of scheduling the job, its latest runs
  show `succeeded`, and the worker's responses are 2xx:

  ```sql
  SELECT d.status, d.return_message, d.start_time
  FROM cron.job_run_details d JOIN cron.job j USING (jobid)
  WHERE j.jobname = 'mgm-payments-reconcile'
  ORDER BY d.start_time DESC LIMIT 3;
  SELECT status_code, error_msg, created FROM net._http_response
  ORDER BY created DESC LIMIT 3;
  ```

  The job only queues the request, so a `succeeded` run alone does not show
  that the worker answered. Check the application's logs for the worker
  requests too.

## Verification record

Keep a record of each restore in your private operations records. Until MGM
ships its billing integrity export, compare billing records by hand as above.

When the integrity export is available, follow its procedure in place of the
manual comparison. It reports separate checksums for closed-period billing,
which must not change, and for payment records, which legitimately gain later
payments. Capture its reference output from the same quiescent state as the
export: writes paused, in-flight work drained, payment processing suspended.
Compare the target's output with that reference, not with the live source,
before enabling the reconciliation job or payment callbacks, and record both
values with the format version that produced them.

```text
Restore verification record
Date (UTC), operator, reviewer:
MGM release and commit:
Export: file name, SHA-256 of the encrypted file and where the scheduler recorded it, manifest created_utc and data_dump_started_utc, pg_dump and server versions:
Restore type: same project | Supabase restore to a new project | logical restore
Target purpose: rehearsal | production replacement (identifier in private records)
Target confirmation: project ref checked against the record (by whom), preflight result:
Inputs used: credential key copy, age identity, Storage copy (date, tool), Auth settings record (date):
Checklist results, item by item:
Row-count mismatches and their explanation:
Billing periods compared (identifiers in private records), what was compared, payments that postdate the export, result:
Production replacement: billing periods closed in the source after the data dump started and open in the target (identifiers in private records); for each, who closed it in the application and when, or why it stays open:
Production replacement: invoice counters before and after, per community and year; where the highest numbers came from; bills given the number the source gave them after the export (identifiers in private records); who reviewed the SQL; any gap left; bills that will be numbered again:
Deviations from this runbook, and the runbook changes they need:
Target and decrypted files deleted on:
```

## References

- Supabase: [Backup and restore using the CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore),
  [Database backups](https://supabase.com/docs/guides/platform/backups),
  [Billing](https://supabase.com/docs/guides/platform/billing-on-supabase),
  [Upgrading](https://supabase.com/docs/guides/platform/upgrading),
  [Restore to a new project](https://supabase.com/docs/guides/platform/clone-project),
  [Vault](https://supabase.com/docs/guides/database/vault),
  [User sessions](https://supabase.com/docs/guides/auth/sessions),
  [Storage S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility),
  [S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication)
- PostgreSQL: [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
- [pg_cron](https://github.com/citusdata/pg_cron)
- [age](https://github.com/FiloSottile/age)
