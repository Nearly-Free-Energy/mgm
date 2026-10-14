-- Defines a session-local helper; loading this file does not rotate anything.
-- Pause and drain credential writes first. Invoke inside an explicit transaction.
CREATE OR REPLACE FUNCTION pg_temp.mgm_rotate_credential_key(new_key text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE current_key text; legacy_key text;
BEGIN
  IF new_key IS NULL OR length(new_key) < 32 THEN
    RAISE EXCEPTION 'A new credential key of at least 32 characters is required';
  END IF;
  LOCK TABLE microgrids, communities, payment_merchant_accounts,
    payment_merchant_versions, vault.secrets IN SHARE ROW EXCLUSIVE MODE;
  SELECT decrypted_secret INTO current_key FROM vault.decrypted_secrets WHERE name='mgm_ems_dek';
  SELECT decrypted_secret INTO legacy_key FROM vault.decrypted_secrets WHERE name='mbe_ems_dek';
  IF current_key IS NULL THEN RAISE EXCEPTION 'Apply the MGM key-name migration first'; END IF;
  IF legacy_key IS NOT NULL AND legacy_key IS DISTINCT FROM current_key THEN
    RAISE EXCEPTION 'Credential key names disagree; resolve before rotation';
  END IF;
  IF new_key=current_key THEN RAISE EXCEPTION 'The replacement key must differ'; END IF;

  CREATE TEMP TABLE mgm_rotation_values ON COMMIT DROP AS
  SELECT 'microgrids' AS tbl,id,
    fn_ems_decrypt_secret(ems_aws_secret_access_key_encrypted) AS aws,
    fn_ems_decrypt_secret(ems_basic_auth_password_encrypted) AS basic,
    fn_ems_decrypt_secret(ems_bearer_token_encrypted) AS bearer,
    fn_ems_decrypt_secret(ems_keycloak_client_secret_encrypted) AS keycloak,
    NULL::text AS merchant,NULL::text AS community
  FROM microgrids
  UNION ALL SELECT 'payment_merchant_accounts',id,NULL,NULL,NULL,NULL,
    fn_ems_decrypt_secret(secret_encrypted),NULL FROM payment_merchant_accounts
  UNION ALL SELECT 'communities',id,NULL,NULL,NULL,NULL,NULL,
    fn_ems_decrypt_secret(payment_provider_secret_encrypted) FROM communities;
  CREATE TEMP TABLE mgm_rotation_versions ON COMMIT DROP AS
  SELECT account_id,version,configuration,
    fn_ems_decrypt_secret((configuration->>'secret_encrypted')::bytea) AS plaintext
  FROM payment_merchant_versions;

  PERFORM vault.update_secret(id,new_key) FROM vault.secrets
    WHERE name IN ('mgm_ems_dek','mbe_ems_dek');
  UPDATE microgrids m SET
    ems_aws_secret_access_key_encrypted=fn_ems_encrypt_secret(r.aws),
    ems_basic_auth_password_encrypted=fn_ems_encrypt_secret(r.basic),
    ems_bearer_token_encrypted=fn_ems_encrypt_secret(r.bearer),
    ems_keycloak_client_secret_encrypted=fn_ems_encrypt_secret(r.keycloak)
  FROM mgm_rotation_values r WHERE r.tbl='microgrids' AND r.id=m.id;
  UPDATE payment_merchant_accounts a SET secret_encrypted=fn_ems_encrypt_secret(r.merchant)
  FROM mgm_rotation_values r WHERE r.tbl='payment_merchant_accounts' AND r.id=a.id;
  UPDATE communities c SET payment_provider_secret_encrypted=fn_ems_encrypt_secret(r.community)
  FROM mgm_rotation_values r WHERE r.tbl='communities' AND r.id=c.id;
  -- Rekey physical ciphertext, preserving each historical identity and all
  -- non-secret configuration. Active-account triggers may add a new version.
  UPDATE payment_merchant_versions v SET configuration=jsonb_set(
    r.configuration,'{secret_encrypted}',
    coalesce(to_jsonb(fn_ems_encrypt_secret(r.plaintext)),'null'::jsonb))
  FROM mgm_rotation_versions r WHERE r.account_id=v.account_id AND r.version=v.version;
  IF EXISTS (
    SELECT 1 FROM mgm_rotation_versions r LEFT JOIN payment_merchant_versions v
      ON v.account_id=r.account_id AND v.version=r.version
    WHERE v.account_id IS NULL OR (v.configuration-'secret_encrypted') IS DISTINCT FROM (r.configuration-'secret_encrypted')
      OR fn_ems_decrypt_secret((v.configuration->>'secret_encrypted')::bytea) IS DISTINCT FROM r.plaintext
  ) THEN RAISE EXCEPTION 'Historical merchant configuration verification failed'; END IF;
  DROP TABLE mgm_rotation_versions,mgm_rotation_values;
END $$;
