-- Credential encryption key: MGM name, with the legacy name as fallback.
--
-- The data-encryption key (DEK) that protects stored OpenEMS and payment
-- credentials has lived in Vault as `mbe_ems_dek` since the project was
-- forked. This migration:
--
--   1. Copies it to `mgm_ems_dek` when the new name is missing. The value is
--      identical, so every existing ciphertext still decrypts.
--   2. Re-issues fn_ems_encrypt_secret / fn_ems_decrypt_secret to read
--      `mgm_ems_dek` first and fall back to `mbe_ems_dek`, so a database where
--      step 1 has not run (or was rolled back) keeps working.
--
-- The legacy `mbe_ems_dek` row is left in place. Remove it only after
-- confirming `mgm_ems_dek` matches it (docs/runbooks/dek.md § "Retire the
-- legacy key name"); while both exist, rotation must update `mgm_ems_dek`.
--
-- Function bodies are otherwise unchanged from
-- 20260926132414_mgm_release2_pilot_connection_bridge.sql, and the grants
-- below restate that migration's: encrypt for authenticated + service_role
-- (the Save route encrypts as the caller), decrypt for service_role only.

DO $$
DECLARE
  v_legacy TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'mgm_ems_dek') THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_legacy
  FROM vault.decrypted_secrets
  WHERE name = 'mbe_ems_dek'
  LIMIT 1;

  -- A database without either name is bootstrapped by the earlier
  -- migrations' DEK logic, which this migration does not repeat.
  IF v_legacy IS NULL THEN
    RETURN;
  END IF;

  PERFORM vault.create_secret(
    v_legacy,
    'mgm_ems_dek',
    'MGM credential encryption key (copied from mbe_ems_dek). See docs/runbooks/dek.md.'
  );
END;
$$;

CREATE OR REPLACE FUNCTION fn_ems_encrypt_secret(p_plaintext TEXT)
RETURNS BYTEA
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dek TEXT;
BEGIN
  IF p_plaintext IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO v_dek
  FROM vault.decrypted_secrets
  WHERE name IN ('mgm_ems_dek', 'mbe_ems_dek')
  ORDER BY (name = 'mgm_ems_dek') DESC
  LIMIT 1;

  IF v_dek IS NULL THEN
    RAISE EXCEPTION 'Credential encryption key (mgm_ems_dek) not found in Vault. See docs/runbooks/dek.md.'
      USING ERRCODE = '55000';
  END IF;

  RETURN extensions.pgp_sym_encrypt(p_plaintext, v_dek);
END;
$$;

CREATE OR REPLACE FUNCTION fn_ems_decrypt_secret(p_ciphertext BYTEA)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dek TEXT;
BEGIN
  IF p_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO v_dek
  FROM vault.decrypted_secrets
  WHERE name IN ('mgm_ems_dek', 'mbe_ems_dek')
  ORDER BY (name = 'mgm_ems_dek') DESC
  LIMIT 1;

  IF v_dek IS NULL THEN
    RAISE EXCEPTION 'Credential encryption key (mgm_ems_dek) not found in Vault. Cannot decrypt stored credential. See docs/runbooks/dek.md.'
      USING ERRCODE = '55000';
  END IF;

  -- pgp_sym_decrypt throws on mismatched key or corrupted input; let it propagate.
  RETURN extensions.pgp_sym_decrypt(p_ciphertext, v_dek);
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_ems_encrypt_secret(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_ems_encrypt_secret(TEXT) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION fn_ems_decrypt_secret(BYTEA) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_ems_decrypt_secret(BYTEA) TO service_role;
