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
| Schema and data, including Auth users and Storage object metadata | Postgres | Yes: `schema.sql`, `data.sql`. Auth sessions and MFA factors are left out ([Run an export](#run-an-export)). | Scheduled, encrypted exports |
| Scheduled jobs (pg_cron) and queued outbound requests (pg_net) | Postgres, in schemas Supabase manages | No | MGM's payment reconciliation job is re-created at the [cutover](#keep-restore-targets-away-from-live-payments). Record any job you add yourself. |
| MGM's triggers and policies on tables in `auth` and `storage` | Postgres, in schemas Supabase manages | No | Re-created from the release by [`supabase/scripts/restore-managed-schema-objects.sql`](../../supabase/scripts/restore-managed-schema-objects.sql) |
| Database roles | Postgres cluster | Yes, without passwords: `roles.sql` | Keep custom login role passwords offline |
| Migration history | `supabase_migrations` schema | Yes: `history_schema.sql`, `history_data.sql` | Part of the export |
| Credential encryption key | Vault secret `mgm_ems_dek` | No | An offline copy, required in addition to any password-manager entry ([dek.md](dek.md)) |
| Payment worker URL and secret | Vault secrets `payments_worker_url`, `payments_worker_secret`; the application's `PAYMENTS_WORKER_SECRET` | No | An offline copy of the secret, in addition to any password-manager entry; the URL in your records ([payments rollout](../payments-rollout.md)) |
| Uploaded files (invoice logos) | Supabase Storage | Metadata only | An encrypted file copy ([Copy Storage files](#copy-storage-files)) |
| Auth settings: site URL, redirect URLs, SMTP, email templates, providers | Supabase project settings | No | A private record, with the SMTP password kept as a secret |
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
- **Export with a read-only login, not `postgres`.** The script works with
  any login that can read the tables it exports and bypass row-level security
  ([Requirements](#requirements)). A `postgres` login can also read every
  Vault secret, including the credential key and the payment worker secret,
  and change the database, so a `postgres` export credential is equivalent to
  the credential key. Prefer a dedicated role with `LOGIN`, `BYPASSRLS`,
  `default_transaction_read_only` on, and `SELECT` on the tables the export
  reads. Grant it nothing else: nothing on the `vault`, `cron` or `net`
  schemas, which the export does not read, and no membership in `postgres`.
  Supabase's `postgres` role may lack the grant option on the `auth` schema
  and on some `auth` and `storage` tables, and a `GRANT` it cannot give only
  warns, so run one export with the new role on a staging project before you
  rely on it.
- Whoever holds the export credential can read a full copy of your data.
  Give it only to the export job and the people who run it, and replace it
  when one of them leaves.
- The host that runs exports needs only the age *public* recipient, so the
  exports it writes are unreadable without the offline identity. It does hold
  the export credential: with a read-only role, a full copy of your data
  without the keys; with `postgres`, the keys too.
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
Unlike the CLI, it never switches to the `postgres` role, so a read-only login
can run it, and its data dump reads only the schemas MGM's data lives in. It
also writes a manifest.

### Requirements

- The PostgreSQL client programs `pg_dump` and `pg_dumpall`, of at least the
  database server's major version (`SHOW server_version;`): `pg_dump` refuses
  to dump a newer server. Operating systems and CI images often ship an older
  client; the PostgreSQL project's package repositories provide every
  supported version. Neither the Supabase CLI nor Docker is needed.
- `age` when encrypting, plus `bash`, `sed`, `awk`, `tar`, `gzip`, and
  `sha256sum` or `shasum`.
- A connection string for the database, from the project's **Connect** dialog.
  Use the session pooler string unless the export host has IPv6 or the project
  has the IPv4 add-on. Put the password in the string's user-info part
  (`postgresql://user:password@host...`) and percent-encode its special
  characters. The script refuses a `password=` parameter.
- A login that can read every table the export reads and bypass row-level
  security. `pg_dump` stops with an error on a table it cannot read, or whose
  row-level security it cannot bypass, instead of exporting part of it. Use
  the read-only role described in
  [Keep keys and exports apart](#keep-keys-and-exports-apart); a `postgres`
  login also works, with the risks described there.

### Run an export

The script reads the connection string from the environment variable you name
and never takes it as an argument. Provide the variable from a secret store;
do not type the value on a command line, where shell history keeps it.

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
| `data.sql` | Data of the `public`, `auth`, `storage` and `supabase_functions` schemas: MGM's data, Auth users and Storage metadata. It deliberately leaves out Auth's sessions, refresh tokens, MFA factors, challenges and claims, pending sign-in flows, one-time tokens and SAML relay states: refresh tokens are usable values that do not expire by default ([User sessions](https://supabase.com/docs/guides/auth/sessions)), and MFA factors hold TOTP secrets. Because it reads only those schemas, it also leaves out pg_cron's jobs and pg_net's request queue, so a restored database starts no scheduled job and sends no queued request until you choose. |
| `history_schema.sql`, `history_data.sql` | The Supabase CLI migration history |
| `manifest.json` | UTC start time, `pg_dump` and server versions, and each file's size and SHA-256 |

Each file comes from a separate `pg_dump` or `pg_dumpall` run, so together
they are not one snapshot. Do not apply migrations while an export runs.

Without `--age-recipients` the script writes the same files as a plaintext
directory and still exits 0. Use that only on an encrypted disk for an
immediate restore, never on a schedule.

| Exit code | Meaning |
|---|---|
| 0 | Export written |
| 2 | Usage error |
| 3 | Missing or unusable input: the environment variable, output directory, staging directory, recipients file or a required program. Nothing was dumped. |
| 4 | `pg_dump` or `pg_dumpall` failed or wrote nothing. Its error is shown, with the connection string and password removed. |
| 5 | Packaging, encryption or moving the export into place failed |

The script checks everything it can before the first dump, including that
`age` accepts every entry in the recipients file. It hands the password to
`pg_dump` and `pg_dumpall` in the `PGPASSWORD` environment variable, so it
never appears in the process list. It redacts the connection string and
password from any output of theirs it shows.

With `--age-recipients`, the plaintext dumps are staged in a private
directory under `$TMPDIR` (default `/tmp`), never in `--out`. `age` writes to a
hidden `.<name>.tar.gz.age.partial` file in `--out`, which is renamed when
complete. Without `--age-recipients`, staging is a hidden directory inside
`--out`. On any failure, and after encryption, the script deletes the staging
directory, the plaintext in it and any partial file.

A run that is killed outright (out of memory, power loss, `kill -9`) cannot
clean up. Plaintext can then remain in the staging directory under
`$TMPDIR`, and a `.partial` file in `--out`. So:

- Run exports on a host no one else uses, such as an ephemeral CI runner or a
  dedicated machine with an encrypted disk, and keep `$TMPDIR` on that
  encrypted disk or in memory.
- Make `--out` a local directory, not a mounted bucket or a synced folder, and
  copy only `*.tar.gz.age` files out of it.

### Schedule it

- Export at least daily, and before every upgrade.
- Pass the connection string to the export step only, as an environment
  variable from the scheduler's secret store.
- Always pass `--age-recipients`, and make the job fail unless the path the
  script prints ends in `.tar.gz.age`. Without the flag the script writes
  plaintext and still succeeds.
- Keep the SHA-256 the script prints in the scheduler's log, or another record
  outside export storage. At restore time it shows the file is the one the
  export wrote: anyone who can write to export storage can encrypt a file to
  your public recipients, so the manifest inside an archive proves only that
  the archive is intact.
- Install the PostgreSQL client for the server's major version on the export
  host, and update it when Supabase upgrades the project's Postgres.
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
That response includes SMTP settings, so store it as a secret.

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
restored database; reconcile them before relying on payment status. Then work
through the [verification checklist](#verification-checklist).

Without provider backups, as on the free plan, there is no same-project
restore. Recover with a logical restore into a new project, followed by the
[cutover steps](#keep-restore-targets-away-from-live-payments). The logical
restore steps below load an export into an empty project; they do not restore
an export over an existing project's data.

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

1. **Prepare the target.** Create the project and enable the Vault, pg_cron
   and pg_net extensions. Put its connection in a PostgreSQL service entry
   (`PGSERVICE`) with the password in `.pgpass`, so it stays out of command
   arguments. The commands below assume a service named `mgm-restore-target`,
   and a checkout of the MGM release you are restoring in `$MGM_CHECKOUT`.

2. **Check, decrypt and verify the export** on a trusted machine with an
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

3. **Restore the database** with the commands from Supabase's guide, plus
   two additions that run in the same transaction:

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
     --file roles.sql \
     --file schema.sql \
     --command 'SET session_replication_role = replica' \
     --file data.sql \
     --file "$MGM_CHECKOUT/supabase/scripts/restore-managed-schema-objects.sql" \
     --command 'UPDATE public.payment_merchant_accounts SET disabled = true WHERE NOT disabled RETURNING id'
   ```

4. **Restore the migration history**, so later upgrades apply only the
   migrations the database is missing:

   ```bash
   PGSERVICE=mgm-restore-target psql --single-transaction --variable ON_ERROR_STOP=1 \
     --file history_schema.sql --file history_data.sql
   ```

   This expects a target without a `supabase_migrations` schema. The Supabase
   CLI creates one when it pushes migrations to a project or seeds it, and the
   restore then stops on a duplicate primary key. If the target has one, check
   that `supabase_migrations.schema_migrations` lists no migrations, drop it
   with `DROP SCHEMA supabase_migrations CASCADE;`, and run this step again.

5. **Compare row counts now**, before anyone signs in or anything else writes
   to the target (see the [checklist](#verification-checklist)).

6. **Recreate the credential key, and nothing else in Vault.** On a restore
   target, follow this step rather than the recovery section of
   [dek.md](dek.md). Create the key from its offline copy, in `psql`, so the
   value stays out of your shell history (`\prompt` shows what you type;
   clear the terminal afterwards):

   ```sql
   \prompt 'Credential key: ' credential_key
   SELECT vault.create_secret(:'credential_key', 'mgm_ems_dek', 'MGM credential encryption key');
   \unset credential_key
   ```

   If `SELECT name FROM vault.secrets;` already lists `mgm_ems_dek`, replace
   its value with `vault.update_secret` rather than creating a second one.
   Check the key with the checklist's decryption checks, not by testing
   connections: **Save and test connection** on a payment account registers a
   notification with the payment provider using live credentials and
   re-enables the account, and a microgrid's connection test connects to its
   energy management system with production credentials. Leave
   `payments_worker_url` and `payments_worker_secret` unset. A production
   replacement creates them at the
   [cutover](#keep-restore-targets-away-from-live-payments), once it is
   verified.

7. **Copy Storage files** from your latest Storage copy, decrypted on the same
   trusted machine. The data restore already created the bucket definitions
   and object metadata, so copy the objects only. Keep each object's bucket
   and path, and overwrite objects that already exist. With the AWS CLI, for
   example, `aws s3 sync <copy>/invoice-logos s3://invoice-logos` with the
   target's endpoint and S3 access keys.

8. **Apply Auth settings** from your record, with the target's own site URL
   and redirect URLs. Configure SMTP only on a production replacement, so a
   rehearsal cannot email your users. Users and their password hashes come
   with the data, so existing users sign in with their current passwords.
   Sessions do not, so every user signs in again.

9. **Set passwords for custom login roles**, if you have any. `roles.sql`
   carries none. Give the export role a password only on a production
   replacement, when its scheduled exports start.

10. **Deploy the application** at the same MGM release, configured with the
    target project's URL and keys (from the target, not the backup) and the
    target's own public URL.

11. **Verify** with the checklist, and fill in the verification record.

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
   application.
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

## Verification checklist

Work in this order. Row counts come first, because signing in and scheduled
jobs write to the target. **Payment reconciliation running** comes last, and
only on a production replacement: it is checked after the cutover, which
starts only when every other item has passed.

- [ ] **Export identity and integrity.** The encrypted file's SHA-256 matched
  the value the scheduler recorded when it wrote the export, which detects a
  substituted file. The manifest checksums matched, which detects corruption
  (logical restore, step 2). `psql` finished without error.
  `--single-transaction` with `ON_ERROR_STOP` means a failed restore leaves
  nothing behind.
- [ ] **Row counts.** Every table in `data.sql` has the same number of rows in
  the target. From the extracted export directory:

  ```bash
  awk '/^COPY /{table=$2; rows=0; next} /^\\\.$/{if (table != "") print table, rows; table=""; next} table != ""{rows++}' data.sql |
  while read -r table rows; do
    actual=$(PGSERVICE=mgm-restore-target psql -X -A -t -c "SELECT count(*) FROM $table" </dev/null)
    [ "$actual" = "$rows" ] || echo "MISMATCH $table export=$rows target=$actual"
  done
  ```

  Platform-written tables such as Auth's audit log can differ if anything
  has run since the restore. Investigate any other mismatch.
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

- [ ] **Files.** `SELECT bucket_id, count(*) FROM storage.objects GROUP BY 1;`
  matches the number of objects copied per bucket. A known invoice logo
  loads in the application and appears on an invoice PDF.
- [ ] **Sign-in.** An existing operator account signs in with its password and
  sees only its own organizations.
- [ ] **Representative billing records.** For a sample of billing periods
  that were already closed when the export started (closed in the target),
  compare the target with the source as it stood when the export started (the
  manifest's `created_utc`), not with what the source holds now. A period
  closed after the export started is still open in the target, which is not
  a discrepancy.
  - The number of line items, the totals, the pinned tariff and the invoice
    numbers match exactly. A closed period does not change.
  - Every payment the target holds for those periods is in the source with
    the same values. A payment the source holds and the target lacks must
    have been recorded after the export started. A later payment is expected,
    not a discrepancy; anything else is.
  - If the source is lost, compare with the invoices you issued for those
    periods and with earlier verification records, until MGM ships its
    billing integrity export ([Verification record](#verification-record)).
- [ ] **Clean-up.** Decrypted export and Storage copies are deleted. A
  rehearsal target is deleted.
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
Export: file name, SHA-256 of the encrypted file and where the scheduler recorded it, manifest created_utc, pg_dump and server versions:
Restore type: same project | Supabase restore to a new project | logical restore
Target purpose: rehearsal | production replacement (identifier in private records)
Inputs used: credential key copy, age identity, Storage copy (date, tool), Auth settings record (date):
Checklist results, item by item:
Row-count mismatches and their explanation:
Billing periods compared (identifiers in private records), what was compared, payments that postdate the export, result:
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
