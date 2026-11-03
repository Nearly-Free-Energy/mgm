-- Keep closed and paid billing whichever row a delete names, and keep closed
-- periods closed.
--
-- 20261103090100 keeps a closed period, or a draft with payment activity,
-- from a direct delete. This migration applies the same rule to every other
-- way a delete can reach that billing:
--
--   1. fn_billing_period_before_delete_guard is re-issued without its
--      cascade exemption, so a period that a parent delete cascades to is
--      refused like a direct delete. It now locks the period's line items in
--      id order.
--   2. trg_billing_kept_before_delete on organizations, communities and
--      microgrids refuses deleting the entity while any of its periods is
--      closed or has payment activity.
--   3. trg_billing_line_item_before_delete_guard refuses deleting a bill in a
--      closed period or a bill with payment activity, directly or by
--      deleting its household.
--   4. trg_billing_period_stays_closed refuses changing a closed period's
--      status. 00029 already keeps a period closed when its bills are
--      regenerated.
--   5. TRUNCATE skips row triggers, so trg_billing_before_truncate_guard
--      refuses TRUNCATE on billing_periods, billing_line_items,
--      payment_attempts and payment_events for every role, including
--      TRUNCATE ... CASCADE from a parent table, and the TRUNCATE privilege on
--      those tables is revoked from the API roles.
--
-- Guards 1 to 3 key on a period being closed and on payment activity, so
-- the rows they read must not be changed first and deleted afterwards:
--
--   6. trg_billing_line_item_closed_period_guard keeps a bill in a closed
--      period there, with its household. Its amount changes only when
--      fn_record_line_item_with_audit regenerates it.
--   7. trg_billing_line_item_payment_fields_guard refuses a direct write of
--      a bill's payment_status or paid_at by the API roles. The payment
--      functions, which run as their owner, still write them.
--   8. trg_payment_record_kept refuses deleting payment_attempts and
--      payment_events rows, and moving a payment event to another bill.
--   9. fn_record_line_item_with_audit is re-issued to announce its write to
--      guard 6.
--
-- Payment activity means the same as in 20261103090100. A line item has it
-- when its payment_status is not 'unpaid', its paid_at is set, or a
-- payment_attempts or payment_events row exists for it. A period has it when
-- one of its line items does. Guards 1 to 3 each spell this out. Change them
-- together, and change lineItemHasRecordedPayment in
-- src/lib/billing/period-delete.ts with them.
--
-- A refused delete raises SQLSTATE 23514, a message starting
-- 'billing_period_kept', and DETAIL 'closed' or 'payment_activity', as
-- 20261103090100 does. src/lib/billing/period-delete.ts and
-- src/lib/entity-deletion/shared.ts map these to the messages the app shows.
-- A refused reopen, or a refused change to a bill in a closed period, raises
-- 23514 'billing_period_closed' with DETAIL 'closed'. A refused change to a
-- payment record raises 23514 'payment_record_kept' with DETAIL
-- 'payment_activity'. A refused TRUNCATE raises 23514
-- 'billing_truncate_refused'. The application makes none of the writes that
-- guards 4 and 6 to 8 refuse, so it maps none of these three.
--
-- No caller is exempt from these guards, service_role and the database owner
-- included, with two exceptions that each guard states: guard 6 lets the
-- audited regeneration change a closed bill's amount, and guard 7 refuses
-- only the API roles. For the reason no caller is exempt, see
-- fn_billing_period_before_delete_guard.
--
-- Rollback, in this order:
--   DROP TRIGGER IF EXISTS trg_payment_record_kept ON payment_events;
--   DROP TRIGGER IF EXISTS trg_payment_record_kept ON payment_attempts;
--   DROP FUNCTION IF EXISTS fn_payment_record_kept();
--   DROP TRIGGER IF EXISTS trg_billing_line_item_payment_fields_guard ON billing_line_items;
--   DROP FUNCTION IF EXISTS fn_billing_line_item_payment_fields_guard();
--   DROP TRIGGER IF EXISTS trg_billing_line_item_closed_period_guard ON billing_line_items;
--   DROP FUNCTION IF EXISTS fn_billing_line_item_closed_period_guard();
--   then re-run the CREATE OR REPLACE FUNCTION fn_record_line_item_with_audit
--   from 20260929093017, with its REVOKE and GRANT;
--   GRANT TRUNCATE ON billing_periods, billing_line_items, payment_attempts, payment_events
--     TO anon, authenticated, service_role;
--   DROP TRIGGER IF EXISTS trg_billing_before_truncate_guard ON payment_events;
--   DROP TRIGGER IF EXISTS trg_billing_before_truncate_guard ON payment_attempts;
--   DROP TRIGGER IF EXISTS trg_billing_before_truncate_guard ON billing_line_items;
--   DROP TRIGGER IF EXISTS trg_billing_before_truncate_guard ON billing_periods;
--   DROP FUNCTION IF EXISTS fn_billing_before_truncate_guard();
--   DROP TRIGGER IF EXISTS trg_billing_period_stays_closed ON billing_periods;
--   DROP FUNCTION IF EXISTS fn_billing_period_stays_closed();
--   DROP TRIGGER IF EXISTS trg_billing_line_item_before_delete_guard ON billing_line_items;
--   DROP FUNCTION IF EXISTS fn_billing_line_item_before_delete_guard();
--   DROP TRIGGER IF EXISTS trg_billing_kept_before_delete ON microgrids;
--   DROP TRIGGER IF EXISTS trg_billing_kept_before_delete ON communities;
--   DROP TRIGGER IF EXISTS trg_billing_kept_before_delete ON organizations;
--   DROP FUNCTION IF EXISTS fn_billing_kept_before_parent_delete();
--   then re-run the CREATE OR REPLACE FUNCTION fn_billing_period_before_delete_guard
--   from 20261103090100, which restores its cascade exemption. To remove
--   that guard as well:
--   DROP TRIGGER IF EXISTS trg_billing_period_before_delete_guard ON billing_periods;
--   DROP FUNCTION IF EXISTS fn_billing_period_before_delete_guard();
--
-- Idempotent: CREATE OR REPLACE, DROP TRIGGER IF EXISTS, and REVOKE.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Billing period delete guard, without the cascade exemption.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_billing_period_before_delete_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
-- DEFINER so the payment-activity checks see every row: session callers can
-- read payment_attempts only through its RLS policy, and a check that sees
-- fewer rows than exist would let the delete through.
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- No exemption at any trigger depth. A delete that cascades from a
  -- microgrid, community or organization is refused like a direct delete.
  -- trg_billing_kept_before_delete usually refuses such a delete first, and
  -- its message names the entity. This guard still holds for any cascade
  -- that reaches a period without passing through that trigger.

  -- No caller is exempt, service_role included. This is a retention rule
  -- about the row (closed, or carrying payment evidence), not a permission
  -- rule about who is asking: service_role's RLS bypass widens which rows a
  -- caller may reach, and that has no bearing on whether a row may be
  -- destroyed. Exempting it would let the role that records payment
  -- evidence also erase that evidence with one statement. Same stance as
  -- fn_payment_check_scope, which holds for privileged writes too.

  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'billing_period_kept: a closed billing period cannot be deleted'
      USING ERRCODE = '23514',
            DETAIL = 'closed',
            HINT = 'Closed periods are kept as the billing record.';
  END IF;

  -- Lock the period's line items before looking for payment activity, so a
  -- payment recorded concurrently either commits first (and is seen below)
  -- or waits for this delete and then fails its foreign key. Id order keeps
  -- two transactions that lock the same line items from deadlocking.
  PERFORM 1 FROM billing_line_items
  WHERE billing_period_id = OLD.id
  ORDER BY id
  FOR UPDATE;

  IF EXISTS (
       SELECT 1 FROM billing_line_items li
       WHERE li.billing_period_id = OLD.id
         AND (li.payment_status <> 'unpaid' OR li.paid_at IS NOT NULL)
     )
     OR EXISTS (
       SELECT 1 FROM payment_attempts pa
       JOIN billing_line_items li ON li.id = pa.line_item_id
       WHERE li.billing_period_id = OLD.id
     )
     OR EXISTS (
       SELECT 1 FROM payment_events pe
       JOIN billing_line_items li ON li.id = pe.line_item_id
       WHERE li.billing_period_id = OLD.id
     )
  THEN
    RAISE EXCEPTION 'billing_period_kept: a billing period with recorded payments cannot be deleted'
      USING ERRCODE = '23514',
            DETAIL = 'payment_activity',
            HINT = 'Periods with payment activity are kept with their payment records.';
  END IF;

  RETURN OLD;
END;
$$;

-- Trigger functions fire with the owner's privileges whatever the EXECUTE
-- grants say; revoking from session roles only keeps the function off the
-- RPC surface (00047 §2d pattern).
REVOKE EXECUTE ON FUNCTION fn_billing_period_before_delete_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_billing_period_before_delete_guard() TO service_role;

DROP TRIGGER IF EXISTS trg_billing_period_before_delete_guard ON billing_periods;
CREATE TRIGGER trg_billing_period_before_delete_guard
  BEFORE DELETE ON billing_periods
  FOR EACH ROW
  EXECUTE FUNCTION fn_billing_period_before_delete_guard();

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Organization, community and microgrid delete guard.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- fn_entity_delete_org / _community / _microgrid (20260926130210) delete only
-- the entity's row and rely on ON DELETE CASCADE below it. A BEFORE ROW
-- trigger runs before any of that cascade, so this check sees every billing
-- row the delete would remove. The period guard alone cannot: an
-- organization's payment_attempts cascade from payment_attempts.org_id, at
-- the first level of the cascade, before the cascade reaches the
-- organization's billing periods. Revisit this trigger if billing ever hangs
-- off another table that cascades from these three.

CREATE OR REPLACE FUNCTION fn_billing_kept_before_parent_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
-- DEFINER for the same reason as fn_billing_period_before_delete_guard.
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entity TEXT;
  v_microgrid_ids UUID[];
BEGIN
  IF TG_TABLE_NAME = 'organizations' THEN
    v_entity := 'an organization';
    SELECT coalesce(array_agg(m.id), '{}') INTO v_microgrid_ids
    FROM microgrids m
    JOIN communities c ON c.id = m.community_id
    WHERE c.org_id = OLD.id;
  ELSIF TG_TABLE_NAME = 'communities' THEN
    v_entity := 'a community';
    SELECT coalesce(array_agg(m.id), '{}') INTO v_microgrid_ids
    FROM microgrids m
    WHERE m.community_id = OLD.id;
  ELSIF TG_TABLE_NAME = 'microgrids' THEN
    v_entity := 'a microgrid';
    v_microgrid_ids := ARRAY[OLD.id];
  ELSE
    RAISE EXCEPTION 'fn_billing_kept_before_parent_delete is not written for table %', TG_TABLE_NAME;
  END IF;

  IF EXISTS (
       SELECT 1 FROM billing_periods bp
       WHERE bp.microgrid_id = ANY (v_microgrid_ids)
         AND bp.status = 'closed'
     )
  THEN
    RAISE EXCEPTION 'billing_period_kept: % with closed billing periods cannot be deleted', v_entity
      USING ERRCODE = '23514',
            DETAIL = 'closed',
            HINT = 'Closed periods are kept as the billing record, and so is the entity that holds them.';
  END IF;

  IF EXISTS (
       SELECT 1 FROM billing_line_items li
       JOIN billing_periods bp ON bp.id = li.billing_period_id
       WHERE bp.microgrid_id = ANY (v_microgrid_ids)
         AND (li.payment_status <> 'unpaid' OR li.paid_at IS NOT NULL)
     )
     OR EXISTS (
       SELECT 1 FROM payment_attempts pa
       JOIN billing_line_items li ON li.id = pa.line_item_id
       JOIN billing_periods bp ON bp.id = li.billing_period_id
       WHERE bp.microgrid_id = ANY (v_microgrid_ids)
     )
     OR EXISTS (
       SELECT 1 FROM payment_events pe
       JOIN billing_line_items li ON li.id = pe.line_item_id
       JOIN billing_periods bp ON bp.id = li.billing_period_id
       WHERE bp.microgrid_id = ANY (v_microgrid_ids)
     )
  THEN
    RAISE EXCEPTION 'billing_period_kept: % with recorded payments cannot be deleted', v_entity
      USING ERRCODE = '23514',
            DETAIL = 'payment_activity',
            HINT = 'Billing with payment activity is kept with its payment records, and so is the entity that holds it.';
  END IF;

  RETURN OLD;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_billing_kept_before_parent_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_billing_kept_before_parent_delete() TO service_role;

DROP TRIGGER IF EXISTS trg_billing_kept_before_delete ON organizations;
CREATE TRIGGER trg_billing_kept_before_delete
  BEFORE DELETE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION fn_billing_kept_before_parent_delete();

DROP TRIGGER IF EXISTS trg_billing_kept_before_delete ON communities;
CREATE TRIGGER trg_billing_kept_before_delete
  BEFORE DELETE ON communities
  FOR EACH ROW
  EXECUTE FUNCTION fn_billing_kept_before_parent_delete();

DROP TRIGGER IF EXISTS trg_billing_kept_before_delete ON microgrids;
CREATE TRIGGER trg_billing_kept_before_delete
  BEFORE DELETE ON microgrids
  FOR EACH ROW
  EXECUTE FUNCTION fn_billing_kept_before_parent_delete();

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Bill (billing line item) delete guard.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Covers a direct delete of a bill and a household delete, which reaches its
-- bills through billing_line_items.household_id ON DELETE CASCADE. If that
-- foreign key stops cascading, a household delete with bills fails on the
-- foreign key instead, and this guard still covers the direct delete.

CREATE OR REPLACE FUNCTION fn_billing_line_item_before_delete_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
-- DEFINER for the same reason as fn_billing_period_before_delete_guard.
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- When the bill's period is already gone, the bill is being deleted with
  -- it. fn_billing_period_before_delete_guard allowed that only for a draft
  -- with no payment activity on any of its bills, so the payment check below
  -- passes too.
  IF EXISTS (
       SELECT 1 FROM billing_periods bp
       WHERE bp.id = OLD.billing_period_id
         AND bp.status = 'closed'
     )
  THEN
    RAISE EXCEPTION 'billing_period_kept: a bill in a closed billing period cannot be deleted'
      USING ERRCODE = '23514',
            DETAIL = 'closed',
            HINT = 'Closed periods are kept with their bills.';
  END IF;

  -- The DELETE locked this row before the trigger fired, so a payment
  -- attempt or event recorded concurrently either commits first (and is seen
  -- here) or waits for this delete and then fails its foreign key.
  IF OLD.payment_status <> 'unpaid'
     OR OLD.paid_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.line_item_id = OLD.id)
     OR EXISTS (SELECT 1 FROM payment_events pe WHERE pe.line_item_id = OLD.id)
  THEN
    RAISE EXCEPTION 'billing_period_kept: a bill with recorded payments cannot be deleted'
      USING ERRCODE = '23514',
            DETAIL = 'payment_activity',
            HINT = 'Bills with payment activity are kept with their payment records.';
  END IF;

  RETURN OLD;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_billing_line_item_before_delete_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_billing_line_item_before_delete_guard() TO service_role;

DROP TRIGGER IF EXISTS trg_billing_line_item_before_delete_guard ON billing_line_items;
CREATE TRIGGER trg_billing_line_item_before_delete_guard
  BEFORE DELETE ON billing_line_items
  FOR EACH ROW
  EXECUTE FUNCTION fn_billing_line_item_before_delete_guard();

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. A closed period stays closed.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The audited corrections after close leave a period's status alone:
-- fn_record_line_item_with_audit regenerates a bill in a closed period and
-- records period_was_closed, fn_apply_payment_event records payments, and
-- supabase/scripts/reconcile-historical-period-tariff.sql pins a tariff.
-- None of them is affected. If a supported way to reopen a period is ever
-- added, it changes this function in a migration of its own.
--
-- UPDATE OF status fires for any statement that names the column, including
-- a resend of the same value, so the body compares values. Only an actual
-- change away from 'closed' is refused.

CREATE OR REPLACE FUNCTION fn_billing_period_stays_closed()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- No caller is exempt, for the reason given in
  -- fn_billing_period_before_delete_guard. A reopened period could otherwise
  -- be deleted as a draft.
  IF OLD.status = 'closed' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'billing_period_closed: a closed billing period cannot be reopened'
      USING ERRCODE = '23514',
            DETAIL = 'closed',
            HINT = 'Closed periods stay closed; corrections are recorded against the closed period.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_billing_period_stays_closed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_billing_period_stays_closed() TO service_role;

DROP TRIGGER IF EXISTS trg_billing_period_stays_closed ON billing_periods;
CREATE TRIGGER trg_billing_period_stays_closed
  BEFORE UPDATE OF status ON billing_periods
  FOR EACH ROW
  EXECUTE FUNCTION fn_billing_period_stays_closed();

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. No TRUNCATE on billing_periods, billing_line_items, payment_attempts or
--    payment_events.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- TRUNCATE removes rows without firing the row triggers above and in section
-- 8. The statement-level trigger refuses it for every role. Postgres fires it
-- for every table a TRUNCATE ... CASCADE reaches, so truncating a parent such
-- as microgrids or households is refused as well. Nothing in the application
-- or the maintenance scripts truncates these tables. A local database is
-- reset with `supabase db reset`, which recreates it.
--
-- The revoke removes a privilege the API roles never use, through PostgREST
-- or any function they call. The trigger is what holds if a later
-- `GRANT ALL ON ALL TABLES` (00016) gives the privilege back.

CREATE OR REPLACE FUNCTION fn_billing_before_truncate_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'billing_truncate_refused: % cannot be truncated', TG_TABLE_NAME
    USING ERRCODE = '23514',
          DETAIL = 'truncate',
          HINT = 'Delete rows instead, so the retention guards decide which rows may go.';
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_billing_before_truncate_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_billing_before_truncate_guard() TO service_role;

DROP TRIGGER IF EXISTS trg_billing_before_truncate_guard ON billing_periods;
CREATE TRIGGER trg_billing_before_truncate_guard
  BEFORE TRUNCATE ON billing_periods
  FOR EACH STATEMENT
  EXECUTE FUNCTION fn_billing_before_truncate_guard();

DROP TRIGGER IF EXISTS trg_billing_before_truncate_guard ON billing_line_items;
CREATE TRIGGER trg_billing_before_truncate_guard
  BEFORE TRUNCATE ON billing_line_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION fn_billing_before_truncate_guard();

DROP TRIGGER IF EXISTS trg_billing_before_truncate_guard ON payment_attempts;
CREATE TRIGGER trg_billing_before_truncate_guard
  BEFORE TRUNCATE ON payment_attempts
  FOR EACH STATEMENT
  EXECUTE FUNCTION fn_billing_before_truncate_guard();

DROP TRIGGER IF EXISTS trg_billing_before_truncate_guard ON payment_events;
CREATE TRIGGER trg_billing_before_truncate_guard
  BEFORE TRUNCATE ON payment_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION fn_billing_before_truncate_guard();

REVOKE TRUNCATE ON billing_periods, billing_line_items, payment_attempts, payment_events
  FROM PUBLIC, anon, authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. A bill in a closed period stays there, with its household.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Guards 2 and 3 refuse deleting a bill whose period is closed. Moving the
-- bill into a draft first would get around them, so a bill cannot be moved
-- into or out of a closed period, and a bill in a closed period keeps its
-- household.
--
-- Its amount changes only when fn_record_line_item_with_audit regenerates
-- it. That is the audited correction after close: it records
-- period_was_closed in billing_audit_log. The function is SECURITY INVOKER,
-- so the role a statement runs as cannot tell its write from a direct
-- UPDATE. Instead it names the bill's period and household in the
-- transaction-local setting mgm.audited_bill_write for the length of its
-- write (section 9). The API roles cannot set it: PostgREST has no way to
-- run SET, and set_config is not in a schema it exposes. That stops holding
-- if a role that can run SQL of its own is given UPDATE on billing_line_items,
-- so revisit this exemption then.
--
-- UPDATE OF fires for any statement that names one of the columns, including
-- a resend of the same value, so the body compares values. Moving a bill
-- between draft periods, and the device_id that an edge or device delete
-- sets to NULL, are unaffected.

CREATE OR REPLACE FUNCTION fn_billing_line_item_closed_period_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
-- DEFINER so the period lookups see the period whatever the caller's RLS.
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_closed BOOLEAN;
  v_new_closed BOOLEAN;
BEGIN
  -- Lock the periods first, so a period being closed concurrently either
  -- commits first (and is seen below) or waits for this write. Id order
  -- keeps two such writes from deadlocking. fn_record_line_item_with_audit
  -- already holds this lock on its period.
  PERFORM 1 FROM billing_periods
  WHERE id IN (OLD.billing_period_id, NEW.billing_period_id)
  ORDER BY id
  FOR SHARE;

  SELECT bp.status = 'closed' INTO v_old_closed
  FROM billing_periods bp WHERE bp.id = OLD.billing_period_id;
  v_old_closed := coalesce(v_old_closed, false);

  IF NEW.billing_period_id IS DISTINCT FROM OLD.billing_period_id THEN
    SELECT bp.status = 'closed' INTO v_new_closed
    FROM billing_periods bp WHERE bp.id = NEW.billing_period_id;
    IF v_old_closed OR coalesce(v_new_closed, false) THEN
      RAISE EXCEPTION 'billing_period_closed: a bill cannot be moved into or out of a closed billing period'
        USING ERRCODE = '23514',
              DETAIL = 'closed',
              HINT = 'Closed periods keep the bills they were closed with.';
    END IF;
  END IF;

  IF v_old_closed AND NEW.household_id IS DISTINCT FROM OLD.household_id THEN
    RAISE EXCEPTION 'billing_period_closed: a bill in a closed billing period keeps its household'
      USING ERRCODE = '23514',
            DETAIL = 'closed',
            HINT = 'Closed periods keep the bills they were closed with.';
  END IF;

  IF v_old_closed
     AND NEW.total_amount IS DISTINCT FROM OLD.total_amount
     AND coalesce(current_setting('mgm.audited_bill_write', true), '')
         <> OLD.billing_period_id::text || '/' || OLD.household_id::text
  THEN
    RAISE EXCEPTION 'billing_period_closed: a bill in a closed billing period changes amount only when it is regenerated'
      USING ERRCODE = '23514',
            DETAIL = 'closed',
            HINT = 'Regenerate the bill, which records the correction in billing_audit_log.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_billing_line_item_closed_period_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_billing_line_item_closed_period_guard() TO service_role;

DROP TRIGGER IF EXISTS trg_billing_line_item_closed_period_guard ON billing_line_items;
CREATE TRIGGER trg_billing_line_item_closed_period_guard
  BEFORE UPDATE OF billing_period_id, household_id, total_amount ON billing_line_items
  FOR EACH ROW
  EXECUTE FUNCTION fn_billing_line_item_closed_period_guard();

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. A bill's payment_status and paid_at change only through the payment
--    functions.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Guards 1 to 3 count a payment_status other than 'unpaid', or a paid_at, as
-- payment activity, so resetting them directly would make a paid bill look
-- unpaid. Their writers are fn_apply_payment_event, the payment state
-- machine (00064), and fn_payment_commit_verification and
-- fn_payment_reconcile (20261010202643). All three are SECURITY DEFINER, so
-- their writes run as their owner. A statement that runs as one of the roles
-- API requests use (anon, authenticated, service_role) is a direct write,
-- and this guard refuses it. fn_record_line_item_with_audit leaves these
-- columns alone.
--
-- fn_apply_payment_event's manual undo (paid back to unpaid) keeps working.
-- It records a payment_events row, which section 8 keeps, so the bill stays
-- kept. If a SECURITY INVOKER function ever needs to write these columns,
-- route it through fn_apply_payment_event or change this guard with it.

CREATE OR REPLACE FUNCTION fn_billing_line_item_payment_fields_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
-- INVOKER, so current_user is the role the statement runs as: an API role
-- for a direct write, the owner inside the payment functions.
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated', 'service_role')
     AND (NEW.payment_status IS DISTINCT FROM OLD.payment_status
          OR NEW.paid_at IS DISTINCT FROM OLD.paid_at)
  THEN
    RAISE EXCEPTION 'payment_record_kept: a bill''s payment status changes only through the payment functions'
      USING ERRCODE = '23514',
            DETAIL = 'payment_activity',
            HINT = 'Record or undo a payment with fn_apply_payment_event, which records a payment event with it.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_billing_line_item_payment_fields_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_billing_line_item_payment_fields_guard() TO service_role;

DROP TRIGGER IF EXISTS trg_billing_line_item_payment_fields_guard ON billing_line_items;
CREATE TRIGGER trg_billing_line_item_payment_fields_guard
  BEFORE UPDATE OF payment_status, paid_at ON billing_line_items
  FOR EACH ROW
  EXECUTE FUNCTION fn_billing_line_item_payment_fields_guard();

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. Payment attempts and payment events are kept, on their bill.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Guards 1 to 3 count a bill's payment_attempts and payment_events rows as
-- payment activity. Deleting them, or moving them to another bill, would make
-- the bill deletable again. So neither table allows a delete, and a payment
-- event's line_item_id cannot change. A payment attempt's line_item_id
-- already cannot change: fn_payment_check_scope (20261010202643) refuses it.
--
-- No caller is exempt, as in guards 1 to 3. Nothing in the application
-- deletes these rows. A cascade does not reach them either, because guard 3
-- refuses deleting a bill that has any.

CREATE OR REPLACE FUNCTION fn_payment_record_kept()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_record_kept: % rows cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = '23514',
            DETAIL = 'payment_activity',
            HINT = 'Payment records are kept with the bill they belong to.';
  END IF;

  IF NEW.line_item_id IS DISTINCT FROM OLD.line_item_id THEN
    RAISE EXCEPTION 'payment_record_kept: a % row stays on its bill', TG_TABLE_NAME
      USING ERRCODE = '23514',
            DETAIL = 'payment_activity',
            HINT = 'Payment records are kept with the bill they belong to.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_payment_record_kept() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_payment_record_kept() TO service_role;

DROP TRIGGER IF EXISTS trg_payment_record_kept ON payment_attempts;
CREATE TRIGGER trg_payment_record_kept
  BEFORE DELETE ON payment_attempts
  FOR EACH ROW
  EXECUTE FUNCTION fn_payment_record_kept();

DROP TRIGGER IF EXISTS trg_payment_record_kept ON payment_events;
CREATE TRIGGER trg_payment_record_kept
  BEFORE DELETE OR UPDATE OF line_item_id ON payment_events
  FOR EACH ROW
  EXECUTE FUNCTION fn_payment_record_kept();

-- ═════════════════════════════════════════════════════════════════════════════
-- 9. fn_record_line_item_with_audit announces its write to guard 6.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Re-issued from 20260929093017 with two additions: it sets
-- mgm.audited_bill_write to the bill's period and household before its
-- UPSERT, and clears it right after. The rest of the body, the signature and
-- the grants are unchanged. A later change to this function keeps both
-- set_config calls, or a bill in a closed period can no longer be
-- regenerated.

CREATE OR REPLACE FUNCTION fn_record_line_item_with_audit(
  _billing_period_id   UUID,
  _household_id        UUID,
  _device_id           UUID,
  _usage_kwh           NUMERIC,
  _start_kwh           NUMERIC,
  _end_kwh             NUMERIC,
  _tier_breakdown      JSONB,
  _total_amount        NUMERIC,
  _reading_source      billing_line_item_reading_source,
  _entered_by_user_id  UUID,
  _manual_reason       TEXT,
  _actor_user_id       UUID,
  _audit_details       JSONB,
  _rate_schedule_id    UUID,
  _actor_kind          TEXT DEFAULT 'human',
  _actor_ref           TEXT DEFAULT NULL
) RETURNS billing_line_items
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row                     billing_line_items%ROWTYPE;
  v_was_inserted            BOOLEAN;
  v_period_status           billing_period_status;
  v_pinned_rate_schedule_id UUID;
  v_event_type              billing_audit_event_type;
  v_entered_at              TIMESTAMPTZ;
  v_audit_details           JSONB := COALESCE(_audit_details, '{}'::jsonb)
    || jsonb_build_object('rate_schedule_id', _rate_schedule_id);
  v_line_item_id            UUID;
  v_tier_breakdown_rounded  JSONB;
BEGIN
  -- Hold a share lock through the line-item UPSERT and audit insert. A
  -- concurrent empty-draft re-pin needs FOR UPDATE and must wait. If it
  -- committed before this call, reject the stale calculation instead.
  SELECT rate_schedule_id, status
  INTO v_pinned_rate_schedule_id, v_period_status
  FROM billing_periods
  WHERE id = _billing_period_id
  FOR SHARE;
  IF NOT FOUND OR _rate_schedule_id IS NULL
     OR v_pinned_rate_schedule_id IS DISTINCT FROM _rate_schedule_id THEN
    RAISE EXCEPTION 'Billing period tariff changed; recalculate before writing bill'
      USING ERRCODE = '23514';
  END IF;

  -- Resolve entered_at only when the new reading is manual (otherwise NULL,
  -- per AC1 of #173).
  IF _reading_source = 'manual' THEN
    v_entered_at := now();
  ELSE
    v_entered_at := NULL;
  END IF;

  -- Round each tier-breakdown element. WITH ORDINALITY preserves the
  -- tier sequence (T1 → T2 → …); jsonb_agg without ORDER BY does not
  -- guarantee element order. Shape MUST remain {label, kwh, amount}.
  v_tier_breakdown_rounded := COALESCE(
    (SELECT jsonb_agg(
       jsonb_build_object(
         'label',  elem->>'label',
         'kwh',    ROUND((elem->>'kwh')::numeric, 3),
         'amount', ROUND((elem->>'amount')::numeric, 0)
       )
       ORDER BY ord
     )
     FROM jsonb_array_elements(COALESCE(_tier_breakdown, '[]'::jsonb))
       WITH ORDINALITY AS t(elem, ord)),
    '[]'::jsonb);

  -- Announce this audited write to fn_billing_line_item_closed_period_guard
  -- (20261103160000), which lets a bill in a closed period take a new amount
  -- only while this names its period and household. Cleared right after.
  PERFORM set_config('mgm.audited_bill_write',
                     _billing_period_id::text || '/' || _household_id::text, true);

  -- UPSERT on (billing_period_id, household_id) — body unchanged from 00039.
  INSERT INTO billing_line_items (
    billing_period_id,
    household_id,
    device_id,
    usage_kwh,
    start_kwh,
    end_kwh,
    tier_breakdown,
    total_amount,
    reading_source,
    entered_by_user_id,
    entered_at,
    manual_reason
  )
  VALUES (
    _billing_period_id,
    _household_id,
    _device_id,
    ROUND(_usage_kwh, 3),
    ROUND(_start_kwh, 3),
    ROUND(_end_kwh,   3),
    COALESCE(v_tier_breakdown_rounded, '[]'::jsonb),
    ROUND(_total_amount, 0),
    _reading_source,
    CASE WHEN _reading_source = 'manual' THEN _entered_by_user_id ELSE NULL END,
    v_entered_at,
    CASE WHEN _reading_source = 'manual' THEN _manual_reason ELSE NULL END
  )
  ON CONFLICT (billing_period_id, household_id) DO UPDATE SET
    device_id            = EXCLUDED.device_id,
    usage_kwh            = EXCLUDED.usage_kwh,
    start_kwh            = EXCLUDED.start_kwh,
    end_kwh              = EXCLUDED.end_kwh,
    tier_breakdown       = EXCLUDED.tier_breakdown,
    total_amount         = EXCLUDED.total_amount,
    reading_source       = EXCLUDED.reading_source,
    entered_by_user_id   = EXCLUDED.entered_by_user_id,
    entered_at           = EXCLUDED.entered_at,
    manual_reason        = EXCLUDED.manual_reason,
    pesapal_redirect_url = CASE
      WHEN EXCLUDED.total_amount IS DISTINCT FROM billing_line_items.total_amount
      THEN NULL
      ELSE billing_line_items.pesapal_redirect_url
    END,
    pesapal_order_id     = CASE
      WHEN EXCLUDED.total_amount IS DISTINCT FROM billing_line_items.total_amount
      THEN NULL
      ELSE billing_line_items.pesapal_order_id
    END,
    payment_failed_at    = CASE
      WHEN EXCLUDED.total_amount IS DISTINCT FROM billing_line_items.total_amount
      THEN NULL
      ELSE billing_line_items.payment_failed_at
    END
    -- DELIBERATELY OMITTED — owned by fn_apply_payment_event:
    --   payment_status, paid_at, paid_by_user_id, payment_notes,
    --   payment_refunded_at
  RETURNING (xmax = 0), id
  INTO v_was_inserted, v_line_item_id;

  PERFORM set_config('mgm.audited_bill_write', '', true);

  -- Re-read as a composite.
  SELECT * INTO v_row
  FROM billing_line_items
  WHERE id = v_line_item_id;

  -- Period-was-closed audit hint (Q4=B).
  SELECT status INTO v_period_status
  FROM billing_periods
  WHERE id = _billing_period_id;

  IF v_period_status = 'closed' THEN
    v_audit_details := v_audit_details || jsonb_build_object('period_was_closed', true);
  END IF;

  v_event_type := CASE
    WHEN v_was_inserted THEN 'line_item_generated'::billing_audit_event_type
    ELSE 'line_item_regenerated'::billing_audit_event_type
  END;

  INSERT INTO billing_audit_log (
    billing_period_id,
    billing_line_item_id,
    event_type,
    actor_user_id,
    actor_kind,
    actor_ref,
    details
  )
  VALUES (
    _billing_period_id,
    v_row.id,
    v_event_type,
    _actor_user_id,
    COALESCE(_actor_kind, 'human'),
    _actor_ref,
    v_audit_details
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_record_line_item_with_audit(
  UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC,
  billing_line_item_reading_source, UUID, TEXT, UUID, JSONB, UUID, TEXT, TEXT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_record_line_item_with_audit(
  UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC,
  billing_line_item_reading_source, UUID, TEXT, UUID, JSONB, UUID, TEXT, TEXT
) TO authenticated, service_role;
