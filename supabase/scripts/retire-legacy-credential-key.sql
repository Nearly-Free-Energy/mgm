-- Session-local, explicitly invoked maintenance; not a deployment migration.
CREATE OR REPLACE FUNCTION pg_temp.mgm_retire_legacy_credential_key()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE current_key text; legacy_key text; probe bytea;
BEGIN
  LOCK TABLE microgrids,communities,payment_merchant_accounts,
    payment_merchant_versions,vault.secrets IN SHARE ROW EXCLUSIVE MODE;
  SELECT decrypted_secret INTO current_key FROM vault.decrypted_secrets WHERE name='mgm_ems_dek';
  SELECT decrypted_secret INTO legacy_key FROM vault.decrypted_secrets WHERE name='mbe_ems_dek';
  IF current_key IS NULL THEN RAISE EXCEPTION 'MGM credential key is missing'; END IF;
  IF legacy_key IS NOT NULL AND legacy_key IS DISTINCT FROM current_key THEN
    RAISE EXCEPTION 'Credential key names disagree; refusing retirement';
  END IF;
  probe:=fn_ems_encrypt_secret('MGM retirement verification');
  DELETE FROM vault.secrets WHERE name='mbe_ems_dek';
  IF fn_ems_decrypt_secret(probe)<>'MGM retirement verification' THEN
    RAISE EXCEPTION 'Credential functions do not support the MGM key';
  END IF;
  -- Verify every protected value after deletion; an error rolls deletion back.
  PERFORM fn_ems_decrypt_secret(ems_aws_secret_access_key_encrypted),
    fn_ems_decrypt_secret(ems_basic_auth_password_encrypted),
    fn_ems_decrypt_secret(ems_bearer_token_encrypted),
    fn_ems_decrypt_secret(ems_keycloak_client_secret_encrypted) FROM microgrids;
  PERFORM fn_ems_decrypt_secret(secret_encrypted) FROM payment_merchant_accounts;
  PERFORM fn_ems_decrypt_secret(payment_provider_secret_encrypted) FROM communities;
  PERFORM fn_ems_decrypt_secret((configuration->>'secret_encrypted')::bytea) FROM payment_merchant_versions;
END $$;
