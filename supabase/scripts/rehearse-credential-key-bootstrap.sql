-- Local scratch databases / CI only; every change rolls back.
--
-- Rehearses the fresh-install path of migration 00018's credential-key
-- section (section 2): the operator added `mgm_ems_dek` to Vault before the
-- first migration run (docs/runbooks/dek.md § "Create the key"). The section
-- must adopt that key and copy it to the legacy name `mbe_ems_dek`, and the
-- operator's key must win over the development opt-in, which stays present.
-- It must also refuse an operator key shorter than 32 characters, and must
-- not take a key from the session setting app.ems_dek_bootstrap, which it no
-- longer reads.
--
-- The section is read from the migration file itself, from its
-- "-- 2. Make sure Vault" heading to its "-- 3. Envelope" heading, so this
-- runs exactly what the migration runs. If either heading changes, update
-- the sed pattern below; the script stops when it cannot find the section.
--
-- The script replaces the Vault key and refuses to start on a database that
-- holds encrypted credentials. The guard checks the columns listed in
-- docs/runbooks/dek.md § "What the key protects"; a new encrypted column
-- goes there and into the guard.
--
-- Run from the repository root:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/scripts/rehearse-credential-key-bootstrap.sql
\set ON_ERROR_STOP on
\set key_section `sed -n '/^-- 2\. Make sure Vault/,/^-- 3\. Envelope/p' supabase/migrations/00018_openems_backend_per_microgrid.sql`

BEGIN;

DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM microgrids
       WHERE ems_aws_secret_access_key_encrypted IS NOT NULL
          OR ems_basic_auth_password_encrypted IS NOT NULL
          OR ems_bearer_token_encrypted IS NOT NULL
          OR ems_keycloak_client_secret_encrypted IS NOT NULL
     )
     OR EXISTS (SELECT 1 FROM payment_merchant_accounts WHERE secret_encrypted IS NOT NULL)
     OR EXISTS (
       SELECT 1 FROM payment_merchant_versions
       WHERE configuration->>'secret_encrypted' IS NOT NULL
     )
     OR EXISTS (SELECT 1 FROM communities WHERE payment_provider_secret_encrypted IS NOT NULL) THEN
    RAISE EXCEPTION 'This database holds encrypted credentials. Run this rehearsal only on a local scratch or CI database.';
  END IF;
END $$;

SELECT length(set_config('mgm_rehearsal.key_section', :'key_section', true)) AS section_length;
DO $$
DECLARE
  section text := current_setting('mgm_rehearsal.key_section');
BEGIN
  IF section NOT LIKE '-- 2. Make sure Vault%'
     OR section NOT LIKE '%PERFORM vault.create_secret(%' THEN
    RAISE EXCEPTION 'Could not read section 2 of migration 00018. Run this script from the repository root.';
  END IF;
END $$;

-- A fresh install: no key under either name, then the operator's key.
DELETE FROM vault.secrets WHERE name IN ('mgm_ems_dek', 'mbe_ems_dek');
SELECT vault.create_secret(
  'rehearsal-operator-key-7f3a9c1e5b2d4f60',
  'mgm_ems_dek',
  'Credential key bootstrap rehearsal'
) IS NOT NULL AS operator_key_created;

-- Keep the development opt-in present in both its forms, so the operator's
-- key has to win.
DO $$
DECLARE
  marker uuid;
BEGIN
  SELECT id INTO marker FROM vault.secrets WHERE name = 'mgm_allow_dev_credential_key';
  IF marker IS NULL THEN
    PERFORM vault.create_secret('1', 'mgm_allow_dev_credential_key');
  ELSE
    PERFORM vault.update_secret(marker, '1');
  END IF;
END $$;
SET LOCAL app.allow_dev_dek = '1';

-- Section 2 of 00018, as read above.
:key_section

DO $$
DECLARE
  operator_key CONSTANT text := 'rehearsal-operator-key-7f3a9c1e5b2d4f60';
  current_key text;
  legacy_key text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name = 'mgm_allow_dev_credential_key' AND decrypted_secret = '1'
  ) THEN
    RAISE EXCEPTION 'The development opt-in was not present during the rehearsal';
  END IF;

  IF (SELECT count(*) FROM vault.secrets WHERE name = 'mbe_ems_dek') <> 1 THEN
    RAISE EXCEPTION 'Section 2 did not store exactly one mbe_ems_dek';
  END IF;

  SELECT decrypted_secret INTO current_key FROM vault.decrypted_secrets WHERE name = 'mgm_ems_dek';
  SELECT decrypted_secret INTO legacy_key FROM vault.decrypted_secrets WHERE name = 'mbe_ems_dek';
  IF current_key IS DISTINCT FROM operator_key THEN
    RAISE EXCEPTION 'Section 2 changed the operator key (mgm_ems_dek)';
  END IF;
  IF legacy_key IS DISTINCT FROM current_key THEN
    RAISE EXCEPTION 'mbe_ems_dek does not hold the operator key';
  END IF;

  -- The stored key is the one the encryption functions use.
  IF extensions.pgp_sym_decrypt(fn_ems_encrypt_secret('rehearsal-probe'), operator_key)
     IS DISTINCT FROM 'rehearsal-probe' THEN
    RAISE EXCEPTION 'Credentials are not encrypted with the operator key';
  END IF;

  RAISE NOTICE 'OK: 00018 adopts the operator key as mbe_ems_dek ahead of the development opt-in';
END $$;

-- Runs section 2 again on the Vault as it stands. Returns its error as
-- 'SQLSTATE: message', or NULL when it succeeds; an error undoes the run.
CREATE FUNCTION pg_temp.run_key_section() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE current_setting('mgm_rehearsal.key_section');
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ': ' || SQLERRM;
END $$;

DO $$
DECLARE
  boundary_key CONSTANT text := 'rehearsal-boundary-key-0123456789';
  short_key text;
  outcome text;
BEGIN
  -- An empty or short operator key stops section 2, even with the
  -- development opt-in present, and the error does not include the key.
  FOREACH short_key IN ARRAY ARRAY['', left(boundary_key, 31)] LOOP
    DELETE FROM vault.secrets WHERE name IN ('mgm_ems_dek', 'mbe_ems_dek');
    PERFORM vault.create_secret(short_key, 'mgm_ems_dek');
    outcome := pg_temp.run_key_section();
    IF outcome IS NULL
       OR outcome NOT LIKE '55000: The credential encryption key in Vault (mgm_ems_dek) is shorter than 32 characters.%' THEN
      RAISE EXCEPTION 'Section 2 accepted a % character key: %', length(short_key), coalesce(outcome, 'no error');
    END IF;
    IF short_key <> '' AND strpos(outcome, short_key) > 0 THEN
      RAISE EXCEPTION 'The short-key error includes the key';
    END IF;
    IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'mbe_ems_dek') THEN
      RAISE EXCEPTION 'Section 2 stored mbe_ems_dek despite a short key';
    END IF;
  END LOOP;

  -- 32 characters is enough.
  DELETE FROM vault.secrets WHERE name = 'mgm_ems_dek';
  PERFORM vault.create_secret(left(boundary_key, 32), 'mgm_ems_dek');
  outcome := pg_temp.run_key_section();
  IF outcome IS NOT NULL
     OR (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mbe_ems_dek')
        IS DISTINCT FROM left(boundary_key, 32) THEN
    RAISE EXCEPTION 'Section 2 did not adopt a 32 character key: %', coalesce(outcome, 'no error');
  END IF;

  -- With no operator key and no development opt-in, a key in the session
  -- setting app.ems_dek_bootstrap does not satisfy section 2.
  DELETE FROM vault.secrets
  WHERE name IN ('mgm_ems_dek', 'mbe_ems_dek', 'mgm_allow_dev_credential_key');
  PERFORM set_config('app.allow_dev_dek', '', true);
  PERFORM set_config('app.ems_dek_bootstrap', 'rehearsal-session-key-0123456789abcdef', true);
  outcome := pg_temp.run_key_section();
  IF outcome IS NULL OR outcome NOT LIKE '55000: No credential encryption key.%' THEN
    RAISE EXCEPTION 'Section 2 took a key from app.ems_dek_bootstrap: %', coalesce(outcome, 'no error');
  END IF;

  RAISE NOTICE 'OK: 00018 refuses a key shorter than 32 characters and ignores app.ems_dek_bootstrap';
END $$;

ROLLBACK;
