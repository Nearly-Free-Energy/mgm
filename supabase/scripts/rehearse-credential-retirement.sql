-- Local scratch databases / CI only. No key removal survives this transaction.
\set ON_ERROR_STOP on
BEGIN;
\ir retire-legacy-credential-key.sql
DO $$
DECLARE org uuid:=gen_random_uuid(); account uuid; configuration jsonb;
 current_key text; failed boolean:=false;
BEGIN
 SELECT decrypted_secret INTO current_key FROM vault.decrypted_secrets WHERE name='mgm_ems_dek';
 IF current_key IS NULL THEN RAISE EXCEPTION 'Key-name migration is required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM vault.secrets WHERE name='mbe_ems_dek') THEN
   PERFORM vault.create_secret(current_key,'mbe_ems_dek');
 END IF;
 INSERT INTO organizations(id,name) VALUES(org,'Credential retirement rehearsal');
 INSERT INTO payment_merchant_accounts(org_id,secret_encrypted)
 VALUES(org,fn_ems_encrypt_secret('historical-retirement-secret')) RETURNING id INTO account;
 SELECT v.configuration INTO configuration FROM payment_merchant_versions v WHERE account_id=account AND version=1;
 PERFORM vault.update_secret(id,repeat('mismatched-key-',3)) FROM vault.secrets WHERE name='mbe_ems_dek';
 BEGIN
   PERFORM pg_temp.mgm_retire_legacy_credential_key();
   RAISE EXCEPTION 'Expected mismatched key refusal' USING ERRCODE='XX000';
 EXCEPTION WHEN raise_exception THEN NULL;
 END;
 IF NOT EXISTS(SELECT 1 FROM vault.secrets WHERE name='mbe_ems_dek') THEN RAISE EXCEPTION 'Mismatched legacy key was removed'; END IF;
 PERFORM vault.update_secret(id,current_key) FROM vault.secrets WHERE name='mbe_ems_dek';

 UPDATE payment_merchant_versions v SET configuration=jsonb_set(v.configuration,'{secret_encrypted}','"\\x00"') WHERE account_id=account AND version=1;
 BEGIN
   PERFORM pg_temp.mgm_retire_legacy_credential_key();
 EXCEPTION WHEN OTHERS THEN failed:=true;
 END;
 IF NOT failed OR NOT EXISTS(SELECT 1 FROM vault.secrets WHERE name='mbe_ems_dek') THEN
   RAISE EXCEPTION 'Unreadable historical credential did not roll retirement back';
 END IF;
 -- Avoid a PL/pgSQL variable/column ambiguity by restoring through a parameter.
 EXECUTE 'UPDATE payment_merchant_versions SET configuration=$1 WHERE account_id=$2 AND version=1' USING configuration,account;
 PERFORM pg_temp.mgm_retire_legacy_credential_key();
 PERFORM pg_temp.mgm_retire_legacy_credential_key();
 IF EXISTS(SELECT 1 FROM vault.secrets WHERE name='mbe_ems_dek')
   OR fn_payment_account_version(account,1,org)->>'secret'<>'historical-retirement-secret' THEN
   RAISE EXCEPTION 'Historical credential did not survive retirement';
 END IF;
 RAISE NOTICE 'OK: retirement refuses mismatches, rolls back on unreadable history, preserves old versions, and is idempotent';
END $$;
ROLLBACK;
