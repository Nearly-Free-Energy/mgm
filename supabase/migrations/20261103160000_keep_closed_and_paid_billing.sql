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
--      refuses TRUNCATE on billing_periods and billing_line_items for every
--      role, including TRUNCATE ... CASCADE from a parent table, and the
--      TRUNCATE privilege on both tables is revoked from the API roles.
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
-- A refused reopen raises 23514 'billing_period_closed'. A refused TRUNCATE
-- raises 23514 'billing_truncate_refused'.
--
-- No caller is exempt from these guards, service_role and the database owner
-- included. For the reason, see fn_billing_period_before_delete_guard.
--
-- Rollback, in this order:
--   GRANT TRUNCATE ON billing_periods, billing_line_items
--     TO anon, authenticated, service_role;
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
-- 5. No TRUNCATE on billing_periods or billing_line_items.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- TRUNCATE removes rows without firing the row triggers above. The
-- statement-level trigger refuses it for every role. Postgres fires it for
-- every table a TRUNCATE ... CASCADE reaches, so truncating a parent such as
-- microgrids or households is refused as well. Nothing in the application or
-- the maintenance scripts truncates these tables. A local database is reset
-- with `supabase db reset`, which recreates it.
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

REVOKE TRUNCATE ON billing_periods, billing_line_items FROM PUBLIC, anon, authenticated, service_role;
