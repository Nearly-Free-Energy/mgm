# Runbook: the credential encryption key (DEK)

MGM encrypts stored third-party credentials with one data-encryption key
(DEK) held in Supabase Vault. Losing the key makes every encrypted value
unrecoverable; operators would have to re-enter each credential by hand.
This runbook covers creating, backing up, recovering, and rotating it.

## What the key protects

| Table | Column | Holds |
|---|---|---|
| `microgrids` | `ems_aws_secret_access_key_encrypted` | OpenEMS cloud (AWS) secret access key |
| `microgrids` | `ems_basic_auth_password_encrypted` | OpenEMS Basic-auth password |
| `microgrids` | `ems_bearer_token_encrypted` | OpenEMS bearer token |
| `microgrids` | `ems_keycloak_client_secret_encrypted` | OpenEMS Keycloak client secret |
| `payment_merchant_accounts` | `secret_encrypted` | Payment provider (Pesapal) consumer secret |
| `payment_merchant_versions` | `configuration.secret_encrypted` | Historical credentials used by existing payment attempts |
| `communities` | `payment_provider_secret_encrypted` | Legacy per-community payment secret |

Values are encrypted with `pgp_sym_encrypt` through `fn_ems_encrypt_secret`
and decrypted by `fn_ems_decrypt_secret`, which only `service_role` may
execute. Both read the Vault secret named **`mgm_ems_dek`** at call time,
falling back to the legacy name `mbe_ems_dek` if the new one is missing.
The plaintext never leaves the database except to the server code that
needs it.

If you add a new encrypted column, add it to the table above, to the
rotation step below, and to the guard at the top of
`supabase/scripts/rehearse-credential-key-bootstrap.sql` in the same PR.

## Create the key (new environment)

The migrations never generate a key for a shared database. A database
without one stops at migration `00018_openems_backend_per_microgrid` with
`No credential encryption key`, and nothing after it is applied. Before the
first migration run:

1. Generate the key and store it in the team password manager, labelled with
   the environment and `mgm_ems_dek` (see "Back it up"):

   ```bash
   openssl rand -base64 32
   ```

   Migration `00018` refuses a key shorter than 32 characters.

2. Add it to the new database's Vault from a psql session connected as
   `postgres`. `\prompt` reads the key into a psql variable, so the key is
   not in your shell history, psql's history or a saved SQL file; paste it
   at the prompt:

   ```sql
   \prompt 'Credential key: ' dek
   SELECT vault.create_secret(:'dek', 'mgm_ems_dek', 'MGM credential encryption key');
   \unset dek
   ```

   You can instead run the same `SELECT` in the Supabase SQL editor, with
   the key as a quoted literal in place of `:'dek'`, then delete the saved
   snippet.

3. Run the migrations with the development opt-in cleared, so a value in a
   `.env` file cannot apply (see "Local development and CI"):

   ```bash
   MGM_ALLOW_DEV_CREDENTIAL_KEY= supabase db push
   ```

   Check that the output has no "Generated a throwaway credential encryption
   key" warning. Not every Supabase CLI version prints server warnings, so
   also confirm that the key in use is your copy. Migration `00018` copies
   your key to the legacy name `mbe_ems_dek` (see "Retire the legacy key
   name"); in psql, paste the key again and check the result is `t`:

   ```sql
   \prompt 'Credential key: ' dek
   SELECT decrypted_secret = :'dek' AS key_matches
     FROM vault.decrypted_secrets WHERE name = 'mbe_ems_dek';
   \unset dek
   ```

   A deploy pipeline that runs the migrations must not set
   `MGM_ALLOW_DEV_CREDENTIAL_KEY` either.

If a run stopped at `00018`, do steps 1 and 2, then step 3 again; the
migrations continue from `00018`. If it stopped because the key in Vault is
shorter than 32 characters, delete that entry before step 2; nothing has
been encrypted with it yet:

```sql
DELETE FROM vault.secrets WHERE name = 'mgm_ems_dek';
```

### Local development and CI

Local and CI databases use a throwaway key instead. Set
`MGM_ALLOW_DEV_CREDENTIAL_KEY=1` for `supabase db reset`, for
`supabase start` when it creates a new database, and for commands that
build a shadow database from the migrations, such as `supabase db diff`:

```bash
MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase db reset
```

`./setup.sh` (local mode) and the CI `Test` job set it for you. The Supabase
CLI then adds the `mgm_allow_dev_credential_key` entry from
`supabase/config.toml` to Vault before running the migrations, and migration
`00018` generates a key and raises a warning (not every CLI version prints
it). Every reset creates a new key, so re-enter local credentials
afterwards. A psql session that applies the migrations by hand can run
`SET app.allow_dev_dek = '1'` instead.

Never set the variable when migrating a shared database. The CLI writes
`[db.vault]` entries during `supabase db push` and `supabase migration up`
too, so a new database would get a key that nobody has a copy of. For the
same reason, never put `MGM_ALLOW_DEV_CREDENTIAL_KEY` in any `.env` file:
the CLI reads `.env`, `.env.local`, `.env.development*` and `supabase/.env*`
for every command, including `db push` and `migration up`. Pass it only to
the commands above, as in the example.

## Back it up

Store the plaintext DEK in the team password manager as soon as it is
created, labelled with the environment and the Vault secret name. Vault is
the only other copy, and a logical restore into a new project cannot read
it (see "Recover"). To read the current value from a database (for example,
to back up a key that was generated before this runbook existed), use a
privileged connection:

```sql
SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mgm_ems_dek';
```

Keep copies of MGM's other Vault entries as well: `payments_worker_url`
(the deployment's `/api/payments/reconcile-worker` URL) and
`payments_worker_secret` (the application's `PAYMENTS_WORKER_SECRET`; see
`docs/payments-rollout.md`).

Never paste the key into an issue, PR, chat, or log.

## Recover

Supabase encrypts Vault with a root key that belongs to the project, and
backup files never contain it. What to do depends on where the database
comes back:

- **Restored into the same project** (scheduled backup or point-in-time
  recovery): Vault is restored with it; nothing to do.
- **Supabase's "Restore to a new project":** Supabase copies the root key,
  so Vault stays readable. If the new project will serve a different
  deployment, update `payments_worker_url`.
- **Logical restore into a new project** (`supabase db dump` or `pg_dump`
  files restored with psql): the new project has its own root key, so the
  restored Vault entries cannot be decrypted, and neither can any stored
  credential. Either:
  - while the old project is still active, copy its root key to the new
    project before restoring, as described under "Supabase Vault or column
    encryption" in Supabase's
    [Backup and restore using the CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
    Copying replaces the new project's root key, so do it while the new
    project's Vault is still empty; or
  - after restoring, replace MGM's Vault entries with your copies. Use the
    same key as before, so the restored credentials decrypt again:

    ```sql
    DELETE FROM vault.secrets WHERE name IN
      ('mgm_ems_dek', 'mbe_ems_dek', 'payments_worker_url', 'payments_worker_secret');
    SELECT vault.create_secret('<key from the password manager>', 'mgm_ems_dek',
      'MGM credential encryption key');
    SELECT vault.create_secret('<https://…/api/payments/reconcile-worker>', 'payments_worker_url');
    SELECT vault.create_secret('<PAYMENTS_WORKER_SECRET>', 'payments_worker_secret');
    ```

  Then run **Test connection** on one microgrid and one payment account.
- **Vault secret lost but the plaintext is in the password manager:**
  recreate it with the same value.

  ```sql
  SELECT vault.create_secret('<plaintext from password manager>', 'mgm_ems_dek',
    'MGM credential encryption key');
  ```

- **Both lost:** the encrypted values cannot be recovered. Generate a new
  key and add it to Vault as in "Create the key", set the encrypted columns
  above to `NULL`, and have operators re-enter OpenEMS and payment
  credentials in the app.

## Rotate

Rotate when the key may have been exposed, or on a schedule you choose.
Pause credential configuration writes and drain in-flight requests before
starting. Row locks alone cannot stop an application request that has already
encrypted a secret from writing that old-key ciphertext after rotation.
Back up the current and replacement keys in the password manager first.

The tested implementation is
[`supabase/scripts/rotate-credential-key.sql`](../../supabase/scripts/rotate-credential-key.sql).
Loading it defines a session-local helper; it does not rotate anything. On a
privileged psql connection, from the repository root:

```sql
\i supabase/scripts/rotate-credential-key.sql
BEGIN;
SELECT pg_temp.mgm_rotate_credential_key('<new plaintext key from password manager>');
COMMIT;
```

The helper locks credential tables, decrypts active and historical secrets
before changing either Vault key name, then re-encrypts them in the same
transaction. Historical account/version identities and all non-secret JSON
fields remain unchanged. Normal active-account triggers may add a new current
version; pending attempts retain their original version. NULL secrets remain
NULL. Any failure aborts the operation. Do not print key values or save them
in shell history or command-line arguments.

The CI rehearsal uses the same helper to verify active credentials, multiple
historical versions, a pending attempt bound to the original version, and
rollback after an injected downstream failure. Run only against a scratch DB:

```bash
psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/scripts/rehearse-credential-key.sql
```

After committing, run **Test connection** on one microgrid and one payment
account, then verify an existing payment attempt's status. Resume credential
writes after these checks. Retain the old key backup until verification is
complete; replacing Vault names does not make a key backup obsolete immediately.

## Retire the legacy key name

Retirement is optional maintenance, not part of the rename deployment. Keep
both key names until the new migration and existing credential reads have been
verified. To retire the legacy name, use the guarded `retire` command in
[credential-key-maintenance.md](credential-key-maintenance.md).

Do not delete the legacy row as a deployment step. Retirement must refuse
mismatched keys and verify active and historical credentials after removal,
rolling back if any value cannot decrypt. The functions retain their fallback,
so leaving the legacy name in place is supported.
