-- Keep billing periods that carry billing or payment history.
--
-- Adds a BEFORE DELETE guard on billing_periods that decides which periods
-- may be deleted:
--
--   * a draft period with no payment activity can still be deleted;
--   * a closed period is kept;
--   * a draft period with any recorded payment activity is kept: a line item
--     whose payment_status is not 'unpaid' or whose paid_at is set, or any
--     payment_attempts or payment_events row for one of its line items;
--   * deleting the parent microgrid, community or organization still
--     removes its periods (see the cascade branch below).
--
-- A refused delete raises SQLSTATE 23514 with a message that starts with
-- 'billing_period_kept' and DETAIL 'closed' or 'payment_activity'. PostgREST
-- returns those as error.code / error.message / error.details, and the
-- billing UI (src/lib/billing/period-delete.ts) recognises them.
--
-- Idempotent: CREATE OR REPLACE plus DROP TRIGGER IF EXISTS.

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
  -- Parent-entity deletion. fn_entity_delete_org / _community / _microgrid
  -- (20260926130210) delete only the parent row and rely on ON DELETE CASCADE
  -- down to billing_periods.microgrid_id. Postgres performs a cascade from an
  -- internal referential trigger, so this trigger then fires at
  -- pg_trigger_depth() >= 2, after the parent microgrid row is already gone.
  -- Both conditions are required: depth alone would also admit a DELETE
  -- issued from some other trigger while the microgrid still exists.
  -- Revisit if the entity-deletion RPCs start deleting billing_periods
  -- explicitly (those deletes run at depth 1 and would be refused like any
  -- direct delete), or if billing_periods.microgrid_id stops being
  -- ON DELETE CASCADE.
  IF pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM microgrids WHERE id = OLD.microgrid_id)
  THEN
    RETURN OLD;
  END IF;

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
  -- or waits for this delete and then fails its foreign key.
  PERFORM 1 FROM billing_line_items WHERE billing_period_id = OLD.id FOR UPDATE;

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
