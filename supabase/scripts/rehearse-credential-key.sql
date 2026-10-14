-- Local scratch databases / CI only; all fixtures and key changes roll back.
\set ON_ERROR_STOP on
BEGIN;
\ir rotate-credential-key.sql
DO $$
DECLARE org uuid:=gen_random_uuid(); manager uuid:=gen_random_uuid(); community uuid;
 grid uuid; tariff uuid; period uuid; household uuid; bill uuid; account uuid;
 attempt payment_attempts; old_configuration jsonb; old_key text; before_versions integer;
BEGIN
 INSERT INTO organizations(id,name) VALUES(org,'Credential rotation rehearsal');
 INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
 VALUES(manager,'authenticated','authenticated',manager::text||'@test.local','{}','{}');
 INSERT INTO user_roles(user_id,role,scope_type,scope_id) VALUES(manager,'org_manager','org',org);
 INSERT INTO communities(org_id,name,payment_provider_secret_encrypted)
 VALUES(org,'Rotation community',fn_ems_encrypt_secret('community-secret')) RETURNING id INTO community;
 INSERT INTO microgrids(community_id,name,currency,timezone,ems_bearer_token_encrypted)
 VALUES(community,'Rotation grid','UGX','Africa/Kampala',fn_ems_encrypt_secret('meter-secret')) RETURNING id INTO grid;
 INSERT INTO rate_schedules(microgrid_id,tiers,service_charge,tax_rate)
 VALUES(grid,'[{"min_kwh":1,"max_kwh":null,"rate_per_kwh":100}]',0,0) RETURNING id INTO tariff;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',manager)::text,true);
 SELECT id INTO period FROM fn_create_billing_period(grid,'2026-09-01','2026-09-30');
 INSERT INTO households(microgrid_id,display_name,primary_phone) VALUES(grid,'Rotation customer','+256700000098') RETURNING id INTO household;
 INSERT INTO billing_line_items(billing_period_id,household_id,total_amount) VALUES(period,household,5000) RETURNING id INTO bill;
 INSERT INTO payment_merchant_accounts(org_id,consumer_key,secret_encrypted,base_url,ipn_id,is_default,last_test_status)
 VALUES(org,'key-v1',fn_ems_encrypt_secret('merchant-v1'),'https://pay.example.test','ipn-v1',true,'success') RETURNING id INTO account;
 SELECT * INTO attempt FROM fn_payment_reserve_checkout(org,bill,community,account,1,5000,'UGX',
   (SELECT updated_at FROM billing_line_items WHERE id=bill),'MGM-rotation-'||bill);
 SELECT configuration INTO old_configuration FROM payment_merchant_versions WHERE account_id=account AND version=1;
 UPDATE payment_merchant_accounts SET consumer_key='key-v2',secret_encrypted=fn_ems_encrypt_secret('merchant-v2') WHERE id=account;
 PERFORM pg_temp.mgm_rotate_credential_key(repeat('rotation-rehearsal-key-',3));
 IF fn_payment_account_version(account,1,org)->>'secret'<>'merchant-v1'
   OR fn_payment_account_version(account,2,org)->>'secret'<>'merchant-v2' THEN
   RAISE EXCEPTION 'Historical credential versions did not survive rotation';
 END IF;
 IF (SELECT configuration-'secret_encrypted' FROM payment_merchant_versions WHERE account_id=account AND version=1)
   IS DISTINCT FROM (old_configuration-'secret_encrypted') THEN RAISE EXCEPTION 'Historical configuration changed'; END IF;
 IF fn_payment_account_version(attempt.merchant_account_id,attempt.merchant_account_version,org)->>'secret'<>'merchant-v1'
   OR (SELECT merchant_account_version FROM payment_attempts WHERE id=attempt.id)<>1 THEN
   RAISE EXCEPTION 'Pending attempt lost its original merchant credentials';
 END IF;
 IF fn_ems_decrypt_secret((SELECT ems_bearer_token_encrypted FROM microgrids WHERE id=grid))<>'meter-secret'
   OR fn_ems_decrypt_secret((SELECT payment_provider_secret_encrypted FROM communities WHERE id=community))<>'community-secret'
   OR fn_ems_decrypt_secret((SELECT secret_encrypted FROM payment_merchant_accounts WHERE id=account))<>'merchant-v2' THEN
   RAISE EXCEPTION 'Active credentials did not survive rotation';
 END IF;
 RAISE NOTICE 'OK: historical identities, pending attempt, active credentials survive rotation';

 SELECT decrypted_secret INTO old_key FROM vault.decrypted_secrets WHERE name='mgm_ems_dek';
 SELECT count(*) INTO before_versions FROM payment_merchant_versions WHERE account_id=account;
 EXECUTE 'CREATE FUNCTION pg_temp.reject_rotation() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION ''synthetic downstream failure'' USING ERRCODE=''23514''; END $body$';
 EXECUTE 'CREATE TRIGGER rehearsal_rotation_failure BEFORE UPDATE ON payment_merchant_accounts FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_rotation()';
 BEGIN
   PERFORM pg_temp.mgm_rotate_credential_key(repeat('failed-rotation-key-',3));
   RAISE EXCEPTION 'Expected failure did not occur';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 IF (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='mgm_ems_dek') IS DISTINCT FROM old_key
   OR (SELECT count(*) FROM payment_merchant_versions WHERE account_id=account)<>before_versions
   OR fn_payment_account_version(account,1,org)->>'secret'<>'merchant-v1'
   OR fn_ems_decrypt_secret((SELECT ems_bearer_token_encrypted FROM microgrids WHERE id=grid))<>'meter-secret' THEN
   RAISE EXCEPTION 'Failed rotation did not roll back';
 END IF;
 RAISE NOTICE 'OK: downstream failure rolls back key, credentials and version writes';
END $$;
ROLLBACK;
