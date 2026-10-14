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

If you add a new encrypted column, add it to the table above and to the
rotation step below in the same PR.

## Create the key (new environment)

Migrations create the Vault secret if it is missing, and refuse to invent
one silently (migration `00025`). The earlier migrations create it under the
legacy name `mbe_ems_dek`; migration `20261014090000_mgm_credential_key_name`
then copies it to `mgm_ems_dek`:

- **Production or any shared database:** generate the key yourself and
  pass it to the migration run.

  ```bash
  DEK="$(openssl rand -base64 32)"
  # Store $DEK in the team password manager now — see "Back it up".
  psql "$DB_URL" -v ON_ERROR_STOP=1 \
    -c "ALTER DATABASE postgres SET app.ems_dek_bootstrap = '$DEK';"
  # run migrations (supabase db push / your deploy pipeline)
  psql "$DB_URL" -c "ALTER DATABASE postgres RESET app.ems_dek_bootstrap;"
  ```

  Reset the setting once the migrations have run, so the key is not left in
  the database configuration.

- **Local development:** `./setup.sh` sets `app.allow_dev_dek = '1'`, and the
  migration generates a throwaway key. Local credentials become
  unreadable after the next `supabase db reset`; re-enter them.

If neither setting is present on a database without the secret, the
migration stops with `DEK bootstrap required` — by design.

## Back it up

Store the plaintext DEK in the team password manager as soon as it is
created, labelled with the environment and the Vault secret name. Vault is
the only other copy. To read the current value from a database (for
example, to back up a key that was generated before this runbook existed),
use a privileged connection:

```sql
SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mgm_ems_dek';
```

Never paste the key into an issue, PR, chat, or log.

## Recover

- **Database restored from backup:** Vault is restored with it; nothing to do.
- **Vault secret lost but the plaintext is in the password manager:**
  recreate it with the same value.

  ```sql
  SELECT vault.create_secret('<plaintext from password manager>', 'mgm_ems_dek',
    'MGM credential encryption key');
  ```

- **Both lost:** the encrypted values cannot be recovered. Generate a new
  key as in "Create the key", set the encrypted columns above to `NULL`, and
  have operators re-enter OpenEMS and payment credentials in the app.

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
verified. The guarded operator tooling is reviewed separately in
[PR #25](https://github.com/Nearly-Free-Energy/mgm/pull/25); use it only after
that maintenance change is approved and its prerequisites are fulfilled.

Do not delete the legacy row as a deployment step. Retirement must refuse
mismatched keys and verify active and historical credentials after removal,
rolling back if any value cannot decrypt. The functions retain their fallback,
so leaving the legacy name in place is supported.
