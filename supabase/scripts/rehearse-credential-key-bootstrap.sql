-- Local scratch databases / CI only; every change rolls back.
--
-- Rehearses the fresh-install path of migration 00018's credential-key
-- section (section 2): the operator added `mgm_ems_dek` to Vault before the
-- first migration run (docs/runbooks/dek.md § "Create the key"). The section
-- must adopt that key and copy it to the legacy name `mbe_ems_dek`, and the
-- operator's key must win over the development opt-in, which stays present.
--
-- The section is read from the migration file itself, from its
-- "-- 2. Make sure Vault" heading to its "-- 3. Envelope" heading, so this
-- runs exactly what the migration runs. If either heading changes, update
-- the sed pattern below; the script stops when it cannot find the section.
--
-- Run from the repository root:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/scripts/rehearse-credential-key-bootstrap.sql
\set ON_ERROR_STOP on
\set key_section `sed -n '/^-- 2\. Make sure Vault/,/^-- 3\. Envelope/p' supabase/migrations/00018_openems_backend_per_microgrid.sql`

BEGIN;

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

-- Keep every other source of a key present, so the operator's key has to win:
-- the development opt-in in both its forms, and a bootstrap session setting.
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
SET LOCAL app.ems_dek_bootstrap = 'rehearsal-session-key-not-to-be-used';

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

ROLLBACK;
