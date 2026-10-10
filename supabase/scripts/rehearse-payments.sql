-- Scratch databases only. All fixtures and changes are rolled back.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.reject_test_payment_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.raw_payload->>'force'='failure' THEN RAISE EXCEPTION 'synthetic downstream audit failure' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rehearsal_reject_audit BEFORE INSERT ON payment_events FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_test_payment_audit();
DO $$
DECLARE org uuid:=gen_random_uuid(); other_org uuid:=gen_random_uuid(); manager uuid:=gen_random_uuid();
 community uuid; foreign_community uuid; grid uuid; household uuid; tariff uuid; period uuid; bill uuid;
 account uuid; attempt payment_attempts; b billing_line_items; rev timestamptz; cfg jsonb; n integer;
BEGIN
 INSERT INTO organizations(id,name) VALUES(org,'Payments rehearsal'),(other_org,'Foreign organization');
 INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) VALUES(manager,'authenticated','authenticated',manager::text||'@test.local','{}','{}');
 INSERT INTO user_roles(user_id,role,scope_type,scope_id) VALUES(manager,'org_manager','org',org);
 INSERT INTO communities(org_id,name) VALUES(org,'Payment community') RETURNING id INTO community;
 INSERT INTO communities(org_id,name) VALUES(other_org,'Other community') RETURNING id INTO foreign_community;
 INSERT INTO microgrids(community_id,name,currency,timezone) VALUES(community,'Payment grid','UGX','Africa/Kampala') RETURNING id INTO grid;
 INSERT INTO rate_schedules(microgrid_id,tiers,service_charge,tax_rate) VALUES(grid,'[{"min_kwh":1,"max_kwh":null,"rate_per_kwh":100}]',0,0) RETURNING id INTO tariff;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',manager)::text,true);
 SELECT id INTO period FROM fn_create_billing_period(grid,'2026-09-01','2026-09-30');
 INSERT INTO households(microgrid_id,display_name,primary_phone) VALUES(grid,'Payment customer','+256700000099') RETURNING id INTO household;
 INSERT INTO billing_line_items(billing_period_id,household_id,total_amount) VALUES(period,household,5000) RETURNING id,updated_at INTO bill,rev;
 INSERT INTO payment_merchant_accounts(org_id,consumer_key,secret_encrypted,base_url,ipn_id,last_test_status,is_default)
 VALUES(org,'key-v1','\x00','https://cybqa.pesapal.com/pesapalv3','ipn-v1','success',true) RETURNING id INTO account;
 SELECT configuration INTO cfg FROM payment_merchant_versions WHERE account_id=account AND version=1;
 IF cfg->>'consumer_key'<>'key-v1' THEN RAISE EXCEPTION 'merchant version was not captured'; END IF;
 UPDATE payment_merchant_accounts SET consumer_key='key-v2',secret_encrypted='\x01' WHERE id=account;
 IF (SELECT version FROM payment_merchant_accounts WHERE id=account)<>2 OR (SELECT configuration->>'consumer_key' FROM payment_merchant_versions WHERE account_id=account AND version=1)<>'key-v1' THEN RAISE EXCEPTION 'credential rotation lost original version'; END IF;
 RAISE NOTICE 'OK: immutable merchant versions';
 SELECT * INTO attempt FROM fn_payment_reserve_checkout(org,bill,community,account,2,5000,'UGX',rev,'MGM-rehearsal-'||bill);
 BEGIN
  PERFORM fn_payment_reserve_checkout(org,bill,community,account,2,5000,'UGX',rev,'MGM-duplicate-'||bill);
  RAISE EXCEPTION 'second checkout was permitted' USING ERRCODE='XX000';
 EXCEPTION WHEN raise_exception THEN NULL; END;
 RAISE NOTICE 'OK: duplicate reservation denied';
 UPDATE payment_attempts SET provider_tracking_id='TRACK-'||bill,checkout_url='https://pay.example.test/checkout' WHERE id=attempt.id;
 -- Force a downstream audit error; receipt and attempt must roll back too.
 BEGIN
  PERFORM fn_payment_commit_verification(attempt.id,5000,'UGX','completed','TRACK-'||bill,NULL,NULL,'{"force":"failure"}');
  RAISE EXCEPTION 'audit failure did not abort settlement' USING ERRCODE='XX000';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF EXISTS(SELECT 1 FROM payment_receipts WHERE attempt_id=attempt.id) OR (SELECT payment_status FROM billing_line_items WHERE id=bill)<>'unpaid' THEN RAISE EXCEPTION 'partial settlement survived rollback'; END IF;
 PERFORM fn_payment_commit_verification(attempt.id,5000,'UGX','completed','TRACK-'||bill,'confirmation','card','{}');
 IF (SELECT payment_status FROM billing_line_items WHERE id=bill)<>'paid' OR (SELECT status FROM payment_attempts WHERE id=attempt.id)<>'verified' THEN RAISE EXCEPTION 'atomic settlement failed'; END IF;
 PERFORM fn_payment_commit_verification(attempt.id,5000,'UGX','completed','TRACK-'||bill,'confirmation','card','{}');
 SELECT count(*) INTO n FROM payment_receipts WHERE attempt_id=attempt.id;
 IF n<>1 THEN RAISE EXCEPTION 'duplicate receipt recorded'; END IF;
 PERFORM fn_payment_commit_verification(attempt.id,5000,'UGX','failed','TRACK-'||bill,NULL,NULL,'{}');
 IF (SELECT status FROM payment_attempts WHERE id=attempt.id)<>'verified' THEN RAISE EXCEPTION 'stale failure overwrote success'; END IF;
 UPDATE payment_attempts SET status='confirmation_pending' WHERE id=attempt.id;
 IF (SELECT status FROM payment_attempts WHERE id=attempt.id)<>'verified' THEN RAISE EXCEPTION 'refresh regressed verified state'; END IF;
 RAISE NOTICE 'OK: atomic settlement, duplicate and stale event handling';
 PERFORM fn_payment_commit_verification(attempt.id,5000,'UGX','reversed','TRACK-'||bill,NULL,NULL,'{}');
 IF (SELECT payment_status FROM billing_line_items WHERE id=bill)<>'refunded' OR (SELECT status FROM payment_attempts WHERE id=attempt.id)<>'reversed' THEN RAISE EXCEPTION 'reversal missing'; END IF;
 RAISE NOTICE 'OK: verified provider reversal';
 -- Second customer: draft amount correction followed by a late old payment.
 INSERT INTO households(microgrid_id,display_name,primary_phone) VALUES(grid,'Revised customer','+256700000098') RETURNING id INTO household;
 INSERT INTO billing_line_items(billing_period_id,household_id,total_amount) VALUES(period,household,5000) RETURNING id,updated_at INTO bill,rev;
 SELECT * INTO attempt FROM fn_payment_reserve_checkout(org,bill,community,account,2,5000,'UGX',rev,'MGM-rehearsal-'||bill);
 UPDATE payment_attempts SET provider_tracking_id='TRACK-'||bill WHERE id=attempt.id;
 UPDATE billing_line_items SET total_amount=5500 WHERE id=bill;
 IF (SELECT status FROM payment_attempts WHERE id=attempt.id)<>'needs_reconciliation' THEN RAISE EXCEPTION 'revision did not flag attempt'; END IF;
 PERFORM fn_payment_commit_verification(attempt.id,5000,'UGX','completed','TRACK-'||bill,NULL,NULL,'{}');
 IF (SELECT payment_status FROM billing_line_items WHERE id=bill)='paid' THEN RAISE EXCEPTION 'old receipt silently settled revised bill'; END IF;
 BEGIN
  PERFORM fn_payment_reconcile(attempt.id,'accept_exact',0,NULL,NULL,manager);
  RAISE EXCEPTION 'inexact settlement accepted' USING ERRCODE='XX000';
 EXCEPTION WHEN raise_exception THEN NULL; END;
 BEGIN
  PERFORM fn_payment_reconcile(attempt.id,'record_external',400,'bad-adjustment','Wrong amount',manager);
  RAISE EXCEPTION 'wrong external amount accepted' USING ERRCODE='XX000';
 EXCEPTION WHEN raise_exception THEN NULL; END;
 PERFORM fn_payment_reconcile(attempt.id,'record_external',500,'external-receipt','Completed cash collection',manager);
 IF (SELECT payment_status FROM billing_line_items WHERE id=bill)<>'paid' OR (SELECT status FROM payment_attempts WHERE id=attempt.id)<>'resolved' OR NOT EXISTS(SELECT 1 FROM payment_events WHERE line_item_id=bill AND actor_user_id=manager AND raw_payload->>'external_amount'='500') THEN RAISE EXCEPTION 'external reconciliation was not audited settlement'; END IF;
 RAISE NOTICE 'OK: draft revision, late receipt and external settlement';
 -- Pass fixture IDs to a separate role-scoped block. Change SQL roles outside
 -- PL/pgSQL so privilege tests do not reuse a mixed-role execution context.
 PERFORM set_config('mgm_rehearsal.org',org::text,true);
 PERFORM set_config('mgm_rehearsal.foreign_community',foreign_community::text,true);
 PERFORM set_config('mgm_rehearsal.account',account::text,true);
 PERFORM set_config('mgm_rehearsal.attempt',attempt.id::text,true);
END $$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE org uuid:=current_setting('mgm_rehearsal.org')::uuid;
 foreign_community uuid:=current_setting('mgm_rehearsal.foreign_community')::uuid;
 account uuid:=current_setting('mgm_rehearsal.account')::uuid;
 attempt_id uuid:=current_setting('mgm_rehearsal.attempt')::uuid;
BEGIN
 BEGIN
  INSERT INTO community_payment_overrides(org_id,community_id,merchant_account_id) VALUES(org,foreign_community,account);
  RAISE EXCEPTION 'cross-org override accepted' USING ERRCODE='XX000';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  PERFORM fn_payment_due_notifications(50);
  RAISE EXCEPTION 'global notifications callable by authenticated' USING ERRCODE='XX000';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  INSERT INTO payment_receipts(org_id,attempt_id,amount,currency,provider_status) VALUES(org,attempt_id,5000,'UGX','completed');
  RAISE EXCEPTION 'client could forge payment evidence' USING ERRCODE='XX000';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 RAISE NOTICE 'OK: authenticated cross-org and evidence denial';
END $$;
RESET ROLE;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='mgm-payments-reconcile' AND schedule='*/5 * * * *') THEN RAISE EXCEPTION 'worker schedule missing'; END IF;
 RAISE NOTICE 'OK: five-minute schedule present';
END $$;
ROLLBACK;
