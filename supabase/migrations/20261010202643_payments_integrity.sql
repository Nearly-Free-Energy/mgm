-- Payment evidence is server-owned. All money/accounting transitions below
-- run atomically, after row locks; manager actions include an independently
-- validated human identity. No credentials or deployment URLs are embedded.
ALTER TABLE billing_line_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE payment_merchant_accounts ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
DROP INDEX IF EXISTS uq_payment_merchant_default_per_org;
UPDATE payment_merchant_accounts p SET is_default = true
WHERE p.id = (SELECT id FROM payment_merchant_accounts a WHERE a.org_id=p.org_id AND a.provider=p.provider ORDER BY created_at, id LIMIT 1);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_merchant_default_per_org ON payment_merchant_accounts(org_id,provider) WHERE is_default;

CREATE TABLE IF NOT EXISTS payment_merchant_versions (
  account_id uuid NOT NULL REFERENCES payment_merchant_accounts(id) ON DELETE RESTRICT,
  version integer NOT NULL, org_id uuid NOT NULL REFERENCES organizations(id),
  configuration jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,version)
);
ALTER TABLE payment_merchant_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payment_merchant_versions FROM PUBLIC,anon,authenticated;
GRANT ALL ON payment_merchant_versions TO service_role;
INSERT INTO payment_merchant_versions(account_id,version,org_id,configuration)
SELECT id,version,org_id,to_jsonb(p) FROM payment_merchant_accounts p ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION fn_payment_snapshot_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.consumer_key,NEW.secret_encrypted,NEW.base_url,NEW.sandbox,NEW.ipn_id) IS DISTINCT FROM (OLD.consumer_key,OLD.secret_encrypted,OLD.base_url,OLD.sandbox,OLD.ipn_id) THEN
   NEW.version := OLD.version+1;
 END IF;
 INSERT INTO payment_merchant_versions(account_id,version,org_id,configuration)
 VALUES(NEW.id,NEW.version,NEW.org_id,to_jsonb(NEW)) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
-- AFTER permits the version row to reference its newly inserted account.
CREATE OR REPLACE FUNCTION fn_payment_bump_account() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF (NEW.consumer_key,NEW.secret_encrypted,NEW.base_url,NEW.sandbox,NEW.ipn_id) IS DISTINCT FROM (OLD.consumer_key,OLD.secret_encrypted,OLD.base_url,OLD.sandbox,OLD.ipn_id) THEN NEW.version:=OLD.version+1; ELSE NEW.version:=OLD.version; END IF;
 RETURN NEW; END $$;
DROP TRIGGER IF EXISTS payment_account_bump ON payment_merchant_accounts;
CREATE TRIGGER payment_account_bump BEFORE UPDATE ON payment_merchant_accounts FOR EACH ROW EXECUTE FUNCTION fn_payment_bump_account();
DROP TRIGGER IF EXISTS payment_account_snapshot ON payment_merchant_accounts;
CREATE TRIGGER payment_account_snapshot AFTER INSERT OR UPDATE ON payment_merchant_accounts FOR EACH ROW EXECUTE FUNCTION fn_payment_snapshot_account();

CREATE OR REPLACE FUNCTION fn_payment_account_version(_account_id uuid,_version integer,_org_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v jsonb; plaintext text;
BEGIN
 SELECT configuration INTO v FROM payment_merchant_versions WHERE account_id=_account_id AND version=_version AND org_id=_org_id;
 IF v IS NULL THEN RETURN NULL; END IF;
 plaintext:=fn_ems_decrypt_secret((v->>'secret_encrypted')::bytea);
 IF plaintext IS NULL THEN RETURN NULL; END IF;
 RETURN (v-'secret_encrypted') || jsonb_build_object('secret',plaintext);
END $$;
REVOKE ALL ON FUNCTION fn_payment_account_version(uuid,integer,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fn_payment_account_version(uuid,integer,uuid) TO service_role;

-- Evidence tables cannot be spoofed by session clients. Reads remain RLS scoped.
REVOKE INSERT,UPDATE,DELETE ON payment_attempts,payment_receipts,payment_notifications,payment_merchant_accounts FROM authenticated,anon;
REVOKE SELECT ON payment_merchant_accounts FROM authenticated;
GRANT SELECT(id,org_id,provider,display_name,sandbox,consumer_key,base_url,ipn_id,ipn_url,version,is_default,disabled,last_tested_at,last_test_status,last_test_message,created_at,updated_at) ON payment_merchant_accounts TO authenticated;
DROP POLICY IF EXISTS payment_notifications_all ON payment_notifications;
DROP POLICY IF EXISTS payment_notifications_read ON payment_notifications;
CREATE POLICY payment_notifications_read ON payment_notifications FOR SELECT TO authenticated USING(org_id IS NOT NULL AND user_can_access_org(org_id));

-- Legacy attempts captured the migration's current bill total; stamp the
-- same initial revision before enabling immutable attempt enforcement.
UPDATE payment_attempts a SET bill_revision_updated_at=b.updated_at FROM billing_line_items b
WHERE a.line_item_id=b.id AND a.bill_revision_updated_at IS NULL AND a.bill_revision_total=b.total_amount;

-- Enforce parent organization relationships even for privileged writes.
CREATE OR REPLACE FUNCTION fn_payment_check_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE org uuid; community uuid;
BEGIN
 IF TG_TABLE_NAME='community_payment_overrides' THEN
  SELECT org_id INTO org FROM communities WHERE id=NEW.community_id;
  IF org IS DISTINCT FROM NEW.org_id THEN RAISE EXCEPTION 'community organization mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.merchant_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_merchant_accounts WHERE id=NEW.merchant_account_id AND org_id=NEW.org_id) THEN RAISE EXCEPTION 'merchant organization mismatch' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='payment_attempts' THEN
  SELECT c.org_id,c.id INTO org,community FROM billing_line_items li JOIN billing_periods bp ON bp.id=li.billing_period_id JOIN microgrids m ON m.id=bp.microgrid_id JOIN communities c ON c.id=m.community_id WHERE li.id=NEW.line_item_id;
  IF org IS DISTINCT FROM NEW.org_id OR community IS DISTINCT FROM NEW.community_id OR NOT EXISTS(SELECT 1 FROM payment_merchant_versions WHERE account_id=NEW.merchant_account_id AND version=NEW.merchant_account_version AND org_id=NEW.org_id) THEN RAISE EXCEPTION 'attempt organization mismatch' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (NEW.org_id,NEW.line_item_id,NEW.amount,NEW.currency,NEW.merchant_account_id,NEW.merchant_account_version,NEW.merchant_reference,NEW.bill_revision_updated_at) IS DISTINCT FROM (OLD.org_id,OLD.line_item_id,OLD.amount,OLD.currency,OLD.merchant_account_id,OLD.merchant_account_version,OLD.merchant_reference,OLD.bill_revision_updated_at) THEN RAISE EXCEPTION 'immutable attempt changed' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND OLD.status IN ('verified','resolved','reversed','needs_reconciliation') AND NEW.status IN ('pending','confirmation_pending','failed') THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND OLD.provider_tracking_id IS NOT NULL AND NEW.provider_tracking_id IS DISTINCT FROM OLD.provider_tracking_id THEN RAISE EXCEPTION 'tracking identity changed' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='payment_receipts' THEN
  IF NOT EXISTS(SELECT 1 FROM payment_attempts WHERE id=NEW.attempt_id AND org_id=NEW.org_id) THEN RAISE EXCEPTION 'receipt organization mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payment_override_scope ON community_payment_overrides;
CREATE TRIGGER payment_override_scope BEFORE INSERT OR UPDATE ON community_payment_overrides FOR EACH ROW EXECUTE FUNCTION fn_payment_check_scope();
DROP TRIGGER IF EXISTS payment_attempt_scope ON payment_attempts;
CREATE TRIGGER payment_attempt_scope BEFORE INSERT OR UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION fn_payment_check_scope();
DROP TRIGGER IF EXISTS payment_receipt_scope ON payment_receipts;
CREATE TRIGGER payment_receipt_scope BEFORE INSERT ON payment_receipts FOR EACH ROW EXECUTE FUNCTION fn_payment_check_scope();

CREATE OR REPLACE FUNCTION fn_payment_bill_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF NEW.total_amount IS DISTINCT FROM OLD.total_amount THEN
   NEW.updated_at:=clock_timestamp();
   UPDATE payment_attempts SET status='needs_reconciliation',failure_code='bill_revised',failure_message='Bill amount changed after checkout was created' WHERE line_item_id=NEW.id AND status IN ('pending','confirmation_pending','verified','resolved');
 END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS payment_bill_revision ON billing_line_items;
CREATE TRIGGER payment_bill_revision BEFORE UPDATE ON billing_line_items FOR EACH ROW EXECUTE FUNCTION fn_payment_bill_revision();

CREATE OR REPLACE FUNCTION fn_payment_reserve_checkout(_org_id uuid,_line_item_id uuid,_community_id uuid,_account_id uuid,_account_version integer,_amount numeric,_currency text,_revision timestamptz,_reference text)
RETURNS payment_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b billing_line_items; a payment_attempts; org uuid; cid uuid; curr text;
BEGIN
 SELECT * INTO b FROM billing_line_items WHERE id=_line_item_id FOR UPDATE;
 SELECT c.org_id,c.id,m.currency INTO org,cid,curr FROM billing_periods bp JOIN microgrids m ON m.id=bp.microgrid_id JOIN communities c ON c.id=m.community_id WHERE bp.id=b.billing_period_id;
 IF org IS DISTINCT FROM _org_id OR cid IS DISTINCT FROM _community_id THEN RAISE EXCEPTION 'bill scope mismatch'; END IF;
 IF b.total_amount IS DISTINCT FROM _amount OR b.updated_at IS DISTINCT FROM _revision OR COALESCE(curr,'UGX') IS DISTINCT FROM _currency THEN RAISE EXCEPTION 'bill changed; refresh before checkout'; END IF;
 IF b.payment_status IN ('paid','refunded') OR EXISTS(SELECT 1 FROM payment_attempts WHERE line_item_id=b.id AND status IN ('pending','confirmation_pending','verified','resolved','needs_reconciliation')) THEN RAISE EXCEPTION 'existing payment requires refresh or reconciliation'; END IF;
 IF NOT EXISTS(SELECT 1 FROM payment_merchant_accounts p WHERE p.id=_account_id AND p.org_id=_org_id AND p.version=_account_version AND NOT p.disabled AND p.last_test_status='success' AND p.ipn_id IS NOT NULL AND (EXISTS(SELECT 1 FROM community_payment_overrides o WHERE o.community_id=_community_id AND o.merchant_account_id=p.id) OR (p.is_default AND NOT EXISTS(SELECT 1 FROM community_payment_overrides o WHERE o.community_id=_community_id)))) THEN RAISE EXCEPTION 'merchant selection changed'; END IF;
 IF EXISTS(SELECT 1 FROM mgm_plugins WHERE org_id=_org_id AND plugin_name IN ('payments','pesapal') AND NOT enabled) THEN RAISE EXCEPTION 'payment plugin disabled'; END IF;
 INSERT INTO payment_attempts(org_id,line_item_id,community_id,merchant_account_id,merchant_account_version,amount,currency,bill_revision_total,bill_revision_updated_at,merchant_reference)
 VALUES(_org_id,b.id,_community_id,_account_id,_account_version,_amount,_currency,_amount,_revision,_reference) RETURNING * INTO a;
 RETURN a;
END $$;
REVOKE ALL ON FUNCTION fn_payment_reserve_checkout(uuid,uuid,uuid,uuid,integer,numeric,text,timestamptz,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fn_payment_reserve_checkout(uuid,uuid,uuid,uuid,integer,numeric,text,timestamptz,text) TO service_role;

CREATE OR REPLACE FUNCTION fn_payment_commit_verification(_attempt_id uuid,_amount numeric,_currency text,_status text,_tracking text,_confirmation text,_method text,_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a payment_attempts; b billing_line_items; target billing_line_item_payment_status; other boolean; fresh boolean;
BEGIN
 -- Lock bill before attempt consistently with draft edits and reservation.
 SELECT * INTO a FROM payment_attempts WHERE id=_attempt_id;
 SELECT * INTO b FROM billing_line_items WHERE id=a.line_item_id FOR UPDATE;
 SELECT * INTO a FROM payment_attempts WHERE id=_attempt_id FOR UPDATE;
 IF a.id IS NULL OR _amount IS NULL OR _amount<0 OR COALESCE(trim(_currency),'')='' OR _tracking IS DISTINCT FROM a.provider_tracking_id OR _tracking IS NULL OR _status NOT IN ('completed','failed','reversed') THEN RAISE EXCEPTION 'invalid verified evidence'; END IF;
 -- A stale failure cannot overwrite a previously completed/reversed receipt.
 IF _status='failed' AND EXISTS(SELECT 1 FROM payment_receipts WHERE attempt_id=a.id AND provider_status IN ('completed','reversed')) THEN RETURN; END IF;
 INSERT INTO payment_receipts(org_id,attempt_id,amount,currency,provider_status,provider_tracking_id,confirmation_code,payment_method,raw_payload)
 VALUES(a.org_id,a.id,_amount,_currency,_status,_tracking,_confirmation,_method,COALESCE(_payload,'{}')) ON CONFLICT DO NOTHING;
 fresh:=FOUND;
 IF NOT fresh THEN RETURN; END IF;
 SELECT EXISTS(SELECT 1 FROM payment_receipts r JOIN payment_attempts p ON p.id=r.attempt_id WHERE p.line_item_id=b.id AND p.id<>a.id AND r.provider_status='completed') INTO other;
 IF _status='completed' AND (_currency<>a.currency OR _amount<>a.amount OR b.total_amount<>_amount OR b.updated_at IS DISTINCT FROM a.bill_revision_updated_at OR other OR b.payment_status='paid') THEN
  UPDATE payment_attempts SET status='needs_reconciliation',failure_code='balance_mismatch',failure_message='Receipt differs from current bill or duplicates an existing settlement' WHERE id=a.id;
  RETURN;
 END IF;
 IF _status='failed' THEN
  UPDATE payment_attempts SET status='failed' WHERE id=a.id; RETURN;
 END IF;
 IF _status='reversed' AND (other OR b.payment_status<>'paid' OR EXISTS(SELECT 1 FROM payment_events WHERE line_item_id=b.id AND raw_payload ? 'external_amount') OR NOT EXISTS(SELECT 1 FROM payment_receipts WHERE attempt_id=a.id AND provider_status='completed' AND amount=_amount AND currency=_currency)) THEN
  UPDATE payment_attempts SET status='needs_reconciliation',failure_code='reversal',failure_message='Verified reversal needs balance review' WHERE id=a.id; RETURN;
 END IF;
 target:=CASE WHEN _status='completed' THEN 'paid'::billing_line_item_payment_status ELSE 'refunded'::billing_line_item_payment_status END;
 UPDATE billing_line_items SET payment_status=target,paid_at=CASE WHEN target='paid' THEN now() ELSE paid_at END,paid_by_user_id=NULL,payment_refunded_at=CASE WHEN target='refunded' THEN now() ELSE payment_refunded_at END WHERE id=b.id;
 INSERT INTO payment_events(line_item_id,from_status,to_status,source,actor_kind,actor_ref,raw_payload) VALUES(b.id,b.payment_status,target,'ipn','system','payments_verification',COALESCE(_payload,'{}')||jsonb_build_object('attempt_id',a.id,'amount',_amount,'currency',_currency));
 UPDATE payment_attempts SET status=CASE WHEN _status='completed' THEN 'verified' ELSE 'reversed' END WHERE id=a.id;
END $$;
REVOKE ALL ON FUNCTION fn_payment_commit_verification(uuid,numeric,text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fn_payment_commit_verification(uuid,numeric,text,text,text,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION fn_payment_reconcile(_attempt_id uuid,_action text,_external_amount numeric,_reference text,_notes text,_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a payment_attempts; b billing_line_items; received numeric; target billing_line_item_payment_status;
BEGIN
 SELECT * INTO a FROM payment_attempts WHERE id=_attempt_id;
 SELECT * INTO b FROM billing_line_items WHERE id=a.line_item_id FOR UPDATE;
 SELECT * INTO a FROM payment_attempts WHERE id=_attempt_id FOR UPDATE;
 IF a.id IS NULL OR a.status<>'needs_reconciliation' THEN RAISE EXCEPTION 'nothing to reconcile'; END IF;
 IF NOT EXISTS(SELECT 1 FROM user_roles WHERE user_id=_actor AND (role='super_admin' OR (role='org_manager' AND scope_type='org' AND scope_id=a.org_id))) THEN RAISE EXCEPTION 'manager authorization required' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM payment_attempts WHERE line_item_id=b.id AND provider_tracking_id IS NULL AND status IN ('pending','confirmation_pending','needs_reconciliation')) THEN RAISE EXCEPTION 'unknown submission outcome must be investigated with provider'; END IF;
 -- Net verified receipts for every attempt, reversals subtract their original completion.
 SELECT COALESCE(sum(CASE WHEN r.provider_status='completed' THEN r.amount WHEN r.provider_status='reversed' THEN -r.amount ELSE 0 END),0) INTO received FROM payment_receipts r JOIN payment_attempts p ON p.id=r.attempt_id WHERE p.line_item_id=b.id;
 IF EXISTS(SELECT 1 FROM payment_receipts r JOIN payment_attempts p ON p.id=r.attempt_id WHERE p.line_item_id=b.id AND r.currency<>a.currency) THEN RAISE EXCEPTION 'mixed receipt currencies require provider investigation'; END IF;
 SELECT received+COALESCE(sum((raw_payload->>'external_amount')::numeric),0) INTO received FROM payment_events WHERE line_item_id=b.id AND raw_payload ? 'external_amount';
 IF _action='accept_exact' THEN
  IF _external_amount<>0 OR received<>b.total_amount THEN RAISE EXCEPTION 'receipts are not exact settlement'; END IF;
 ELSIF _action='record_external' THEN
  IF COALESCE(trim(_reference),'')='' OR COALESCE(trim(_notes),'')='' OR _external_amount IS NULL OR received+_external_amount<>b.total_amount THEN RAISE EXCEPTION 'external collection/refund must exactly reconcile balance and include reference and notes'; END IF;
 ELSE RAISE EXCEPTION 'invalid reconciliation action'; END IF;
 target:='paid';
 UPDATE billing_line_items SET payment_status=target,paid_at=now(),paid_by_user_id=_actor WHERE id=b.id;
 INSERT INTO payment_events(line_item_id,from_status,to_status,source,actor_user_id,actor_kind,raw_payload) VALUES(b.id,b.payment_status,target,'manual',_actor,'human',jsonb_build_object('action',_action,'external_amount',_external_amount,'reference',_reference,'notes',_notes,'received',received,'attempt_id',a.id));
 UPDATE payment_attempts SET status='resolved',resolved_by=_actor,resolved_at=now(),resolve_notes=jsonb_build_object('action',_action,'external_amount',_external_amount,'reference',_reference,'notes',_notes)::text WHERE line_item_id=b.id AND status='needs_reconciliation';
END $$;
REVOKE ALL ON FUNCTION fn_payment_reconcile(uuid,text,numeric,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fn_payment_reconcile(uuid,text,numeric,text,text,uuid) TO service_role;

-- Worker leases prevent concurrent runs processing the same inbox entry.
ALTER TABLE payment_notifications DROP CONSTRAINT IF EXISTS payment_notifications_status_known;
ALTER TABLE payment_notifications ADD CONSTRAINT payment_notifications_status_known CHECK(status IN ('received','processed','failed','processing','dead_letter'));
CREATE OR REPLACE FUNCTION fn_payment_due_notifications(_limit integer DEFAULT 50) RETURNS SETOF payment_notifications LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE payment_notifications SET status='dead_letter',last_error=COALESCE(last_error,'retry_limit') WHERE status IN ('received','failed','processing') AND next_retry_at<=now() AND attempt_count>=12;
 RETURN QUERY UPDATE payment_notifications SET status='processing',attempt_count=attempt_count+1,next_retry_at=now()+interval '5 minutes'
 WHERE id IN(SELECT id FROM payment_notifications WHERE status IN ('received','failed','processing') AND next_retry_at<=now() AND attempt_count<12 ORDER BY next_retry_at LIMIT LEAST(GREATEST(COALESCE(_limit,50),1),50) FOR UPDATE SKIP LOCKED) RETURNING *;
END;
$$;
REVOKE ALL ON FUNCTION fn_payment_due_notifications(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fn_payment_due_notifications(integer) TO service_role;

-- Trigger helpers are not public RPCs.
REVOKE ALL ON FUNCTION fn_payment_snapshot_account(),fn_payment_bump_account(),fn_payment_check_scope(),fn_payment_bill_revision() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION fn_payment_save_account(_payload jsonb,_account_id uuid,_expected_version integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE account uuid; current_version integer;
BEGIN
 IF _account_id IS NOT NULL THEN
  SELECT version INTO current_version FROM payment_merchant_accounts WHERE id=_account_id AND org_id=(_payload->>'org_id')::uuid FOR UPDATE;
  IF current_version IS DISTINCT FROM _expected_version THEN RAISE EXCEPTION 'merchant configuration changed'; END IF;
  UPDATE payment_merchant_accounts SET display_name=_payload->>'display_name',consumer_key=_payload->>'consumer_key',secret_encrypted=(_payload->>'secret_encrypted')::bytea,sandbox=(_payload->>'sandbox')::boolean,base_url=_payload->>'base_url',ipn_id=_payload->>'ipn_id',ipn_url=_payload->>'ipn_url',disabled=false,last_tested_at=now(),last_test_status='success',last_test_message='Connected' WHERE id=_account_id RETURNING id INTO account;
 ELSE
  INSERT INTO payment_merchant_accounts(org_id,display_name,consumer_key,secret_encrypted,sandbox,base_url,ipn_id,ipn_url,is_default,last_tested_at,last_test_status)
  VALUES((_payload->>'org_id')::uuid,_payload->>'display_name',_payload->>'consumer_key',(_payload->>'secret_encrypted')::bytea,(_payload->>'sandbox')::boolean,_payload->>'base_url',_payload->>'ipn_id',_payload->>'ipn_url',(_payload->>'is_default')::boolean,now(),'success') RETURNING id INTO account;
 END IF;
 RETURN account;
END $$;
REVOKE ALL ON FUNCTION fn_payment_save_account(jsonb,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fn_payment_save_account(jsonb,uuid,integer) TO service_role;

CREATE OR REPLACE FUNCTION fn_payment_enqueue_notification(_org uuid,_tracking text,_reference text,_payload jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE nid uuid;
BEGIN
 INSERT INTO payment_notifications(org_id,tracking_id,merchant_reference,raw_payload) VALUES(_org,_tracking,_reference,_payload)
 ON CONFLICT(provider,tracking_id) DO UPDATE SET status=CASE WHEN payment_notifications.status='processed' THEN 'received' ELSE payment_notifications.status END, next_retry_at=CASE WHEN payment_notifications.status='processed' THEN now() ELSE payment_notifications.next_retry_at END
 WHERE payment_notifications.merchant_reference=EXCLUDED.merchant_reference
 RETURNING id INTO nid;
 IF nid IS NULL THEN RAISE EXCEPTION 'notification identity mismatch'; END IF;
 RETURN nid;
END $$;
REVOKE ALL ON FUNCTION fn_payment_enqueue_notification(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fn_payment_enqueue_notification(uuid,text,text,jsonb) TO service_role;

-- Supabase Cron invokes the authenticated worker every five minutes. Configure
-- payments_worker_url and payments_worker_secret in Vault at deployment time.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE OR REPLACE FUNCTION fn_payment_run_worker() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE endpoint text; token text;
BEGIN
 SELECT decrypted_secret INTO endpoint FROM vault.decrypted_secrets WHERE name='payments_worker_url' LIMIT 1;
 SELECT decrypted_secret INTO token FROM vault.decrypted_secrets WHERE name='payments_worker_secret' LIMIT 1;
 IF endpoint IS NULL OR token IS NULL THEN RAISE EXCEPTION 'payment worker Vault configuration missing'; END IF;
 RETURN net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','x-payments-worker-secret',token),body:='{}'::jsonb,timeout_milliseconds:=10000);
END $$;
REVOKE ALL ON FUNCTION fn_payment_run_worker() FROM PUBLIC,anon,authenticated;
SELECT cron.schedule('mgm-payments-reconcile','*/5 * * * *','SELECT public.fn_payment_run_worker()');
