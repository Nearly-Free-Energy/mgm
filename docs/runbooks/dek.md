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
Run everything in **one transaction** on a privileged connection, during a
quiet period:

```sql
BEGIN;

-- 1. Decrypt every value under the current key into a temporary table.
CREATE TEMP TABLE dek_rotation ON COMMIT DROP AS
SELECT 'microgrids' AS tbl, id,
       fn_ems_decrypt_secret(ems_aws_secret_access_key_encrypted)   AS aws,
       fn_ems_decrypt_secret(ems_basic_auth_password_encrypted)     AS basic,
       fn_ems_decrypt_secret(ems_bearer_token_encrypted)            AS bearer,
       fn_ems_decrypt_secret(ems_keycloak_client_secret_encrypted)  AS keycloak,
       NULL::text AS merchant, NULL::text AS community
FROM microgrids
UNION ALL
SELECT 'payment_merchant_accounts', id, NULL, NULL, NULL, NULL,
       fn_ems_decrypt_secret(secret_encrypted), NULL
FROM payment_merchant_accounts
UNION ALL
SELECT 'communities', id, NULL, NULL, NULL, NULL, NULL,
       fn_ems_decrypt_secret(payment_provider_secret_encrypted)
FROM communities;

-- 2. Switch Vault to the new key (generate it with `openssl rand -base64 32`
--    and store it in the password manager first).
--    While the legacy `mbe_ems_dek` row still exists, update both names so
--    neither can serve a stale key.
SELECT vault.update_secret(id, '<new plaintext key>')
FROM vault.secrets WHERE name IN ('mgm_ems_dek', 'mbe_ems_dek');

-- 3. Re-encrypt under the new key.
UPDATE microgrids m SET
  ems_aws_secret_access_key_encrypted  = fn_ems_encrypt_secret(r.aws),
  ems_basic_auth_password_encrypted    = fn_ems_encrypt_secret(r.basic),
  ems_bearer_token_encrypted           = fn_ems_encrypt_secret(r.bearer),
  ems_keycloak_client_secret_encrypted = fn_ems_encrypt_secret(r.keycloak)
FROM dek_rotation r WHERE r.tbl = 'microgrids' AND r.id = m.id;

UPDATE payment_merchant_accounts a SET secret_encrypted = fn_ems_encrypt_secret(r.merchant)
FROM dek_rotation r WHERE r.tbl = 'payment_merchant_accounts' AND r.id = a.id;

UPDATE communities c SET payment_provider_secret_encrypted = fn_ems_encrypt_secret(r.community)
FROM dek_rotation r WHERE r.tbl = 'communities' AND r.id = c.id;

COMMIT;
```

`fn_ems_encrypt_secret` and `fn_ems_decrypt_secret` return `NULL` for
`NULL` input, so empty columns stay empty. Column-guard triggers exempt
privileged roles, so the updates are allowed on this connection. After
committing, open one microgrid's OpenEMS page and run **Test connection**,
and one organization's payment account test, to confirm decryption works.
Then replace the old key in the password manager.

## Retire the legacy key name

After the `mgm_ems_dek` migration has run on an environment, the legacy
`mbe_ems_dek` row is redundant. Remove it once you have confirmed the two
match:

```sql
SELECT (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mgm_ems_dek')
     = (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mbe_ems_dek')
  AS keys_match;   -- must be true

DELETE FROM vault.secrets WHERE name = 'mbe_ems_dek';
```

Then run **Test connection** on one microgrid to confirm decryption still
works. The functions keep their fallback, so this step is optional and can
wait.
