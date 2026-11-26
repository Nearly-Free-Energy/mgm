-- RFC #259 § 2, ADR-008 (Consequences: the audit column for the client id),
-- #272: audit rows that record an actor also record the client the person
-- acted through.
--
-- billing_audit_log, payment_events and mgm_plugin_audit_log gain
-- actor_client_id: the OAuth client's id (`client_id`) when the person acted
-- through a client (the CLI, or later the assistant bridge), and NULL for a
-- browser session, whose token carries no client_id, and for rows written
-- before this migration. Plain uuid with no foreign key: a client removed
-- from mgm_clients, or deleted from Supabase Auth, keeps its audit rows.
--
-- Where the value comes from
--
-- A BEFORE trigger on each table, fn_audit_actor_client_id, reads the
-- request's own token claims (the request.jwt.claims setting, which
-- auth.jwt() also reads; read directly, so no role needs a grant on auth).
-- PostgREST sets those claims once per request, from the verified token, as
-- transaction-local settings, so they are the same inside a SECURITY
-- DEFINER function, where current_user is the function's owner. Every
-- audit write a signed-in person makes through the database API is
-- therefore covered, whether the function that writes the row runs as the
-- caller (fn_create_billing_period, fn_record_line_item_with_audit) or as
-- its owner (fn_mgm_set_plugin_enabled).
--
-- - Claims whose role is authenticated, anon or mgm_agent (a person's token,
--   the anonymous key, or #274's assistant role): the trigger sets
--   actor_client_id from the claims' client_id, overriding any value the
--   statement supplied, so a caller cannot record another client's id. A
--   browser session's token has no client_id, so its rows get NULL. An
--   UPDATE that names the column keeps the value recorded at insert.
-- - Any other role, or no claims at all (the service role, a direct
--   database session, a migration): the supplied value stays. The trigger
--   exempts the service role because it already bypasses RLS and can write
--   every column of these tables, so a restriction would add nothing. The
--   service role writes for a person only through a function that takes the
--   client's id (fn_payment_reconcile below).
--
-- If PostgREST stops setting request.jwt.claims per request, or Supabase
-- Auth puts client_id into a browser session's token, revisit.
--
-- The one write on a person's behalf that runs on the service role is
-- fn_payment_reconcile (POST /api/payments/attempts/[id]/reconcile, through
-- PaymentsCapability.reconcile with composePayments' service-role writer).
-- It gains a trailing _actor_client_id, recorded on its payment event. Its
-- body is otherwise 20261010202643's, unchanged. The other payment writes on
-- the service role (fn_apply_payment_event from a provider notification,
-- fn_payment_commit_verification) record the system, not a person. A new
-- service-role write of an audit row for a person passes the client's id
-- the same way, or its row reads as a browser session's.

-- ── 1. The column ──────────────────────────────────────────────────────────

ALTER TABLE public.billing_audit_log ADD COLUMN actor_client_id UUID;
ALTER TABLE public.payment_events ADD COLUMN actor_client_id UUID;
ALTER TABLE public.mgm_plugin_audit_log ADD COLUMN actor_client_id UUID;

COMMENT ON COLUMN public.billing_audit_log.actor_client_id IS
  'The OAuth client (client_id) the actor acted through: the CLI or the assistant bridge. NULL for a browser session, the system, and rows before 20261126180000. Set from the request''s token by trg_billing_audit_log_actor_client_id.';
COMMENT ON COLUMN public.payment_events.actor_client_id IS
  'The OAuth client (client_id) the actor acted through: the CLI or the assistant bridge. NULL for a browser session, the system, and rows before 20261126180000. Set from the request''s token by trg_payment_events_actor_client_id, or passed by fn_payment_reconcile.';
COMMENT ON COLUMN public.mgm_plugin_audit_log.actor_client_id IS
  'The OAuth client (client_id) the actor acted through: the CLI or the assistant bridge. NULL for a browser session and rows before 20261126180000. Set from the request''s token by trg_mgm_plugin_audit_log_actor_client_id.';

-- ── 2. The trigger ─────────────────────────────────────────────────────────

-- SECURITY INVOKER: it reads only a setting of the current transaction,
-- which every role may read. A client_id that is not a uuid raises (22P02)
-- and refuses the write; Supabase Auth issues only uuids.
CREATE OR REPLACE FUNCTION public.fn_audit_actor_client_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  _claims JSONB := NULLIF(current_setting('request.jwt.claims', true), '')::JSONB;
BEGIN
  IF _claims IS NULL OR COALESCE(_claims->>'role', '') NOT IN ('authenticated', 'anon', 'mgm_agent') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.actor_client_id := OLD.actor_client_id;
  ELSE
    NEW.actor_client_id := NULLIF(_claims->>'client_id', '')::UUID;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_audit_actor_client_id() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_billing_audit_log_actor_client_id
  BEFORE INSERT OR UPDATE OF actor_client_id ON public.billing_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_actor_client_id();
CREATE TRIGGER trg_payment_events_actor_client_id
  BEFORE INSERT OR UPDATE OF actor_client_id ON public.payment_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_actor_client_id();
CREATE TRIGGER trg_mgm_plugin_audit_log_actor_client_id
  BEFORE INSERT OR UPDATE OF actor_client_id ON public.mgm_plugin_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_actor_client_id();

-- ── 3. fn_payment_reconcile records the client ─────────────────────────────

-- CREATE OR REPLACE cannot add a parameter, so the old signature goes first.
-- The body is 20261010202643's with actor_client_id added to its payment
-- event; the grants are the same (service_role only).
DROP FUNCTION public.fn_payment_reconcile(uuid,text,numeric,text,text,uuid);

CREATE FUNCTION fn_payment_reconcile(_attempt_id uuid,_action text,_external_amount numeric,_reference text,_notes text,_actor uuid,_actor_client_id uuid DEFAULT NULL) RETURNS void
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
 INSERT INTO payment_events(line_item_id,from_status,to_status,source,actor_user_id,actor_kind,raw_payload,actor_client_id) VALUES(b.id,b.payment_status,target,'manual',_actor,'human',jsonb_build_object('action',_action,'external_amount',_external_amount,'reference',_reference,'notes',_notes,'received',received,'attempt_id',a.id),_actor_client_id);
 UPDATE payment_attempts SET status='resolved',resolved_by=_actor,resolved_at=now(),resolve_notes=jsonb_build_object('action',_action,'external_amount',_external_amount,'reference',_reference,'notes',_notes)::text WHERE line_item_id=b.id AND status='needs_reconciliation';
END $$;
REVOKE ALL ON FUNCTION fn_payment_reconcile(uuid,text,numeric,text,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fn_payment_reconcile(uuid,text,numeric,text,text,uuid,uuid) TO service_role;
