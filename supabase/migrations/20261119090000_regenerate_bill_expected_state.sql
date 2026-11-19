-- Regenerate one bill only while it is still the bill the person decided on
-- (#201, review of #208).
--
-- POST /api/billing-line-items/[lineItemId]/regenerate reads a bill and
-- refuses it when its period is closed, it has an invoice number, it is
-- refunded, or it is paid and the person did not acknowledge that. It then
-- writes the bill through fn_record_line_item_with_audit. Between that read
-- and the write, the bill can change: a payment recorded by
-- fn_apply_payment_event (a Pesapal notification, or a person marking it
-- paid or refunded), its first PDF download (which allocates its invoice
-- number), the period's close, or another regeneration. The write would
-- then go ahead on a decision made about a bill that no longer exists.
--
-- fn_regenerate_bill_with_audit takes fn_record_line_item_with_audit's
-- arguments and, first, _expected: the bill as the route read it,
--   { line_item_id, payment_status, total_amount, usage_kwh, start_kwh,
--     end_kwh, reading_source, device_id, tier_breakdown,
--     entered_by_user_id, manual_reason }
-- every key present (a value may be null). These are payment_status and
-- every column fn_record_line_item_with_audit writes except entered_at, so
-- any write since the read shows in one of them. That includes another
-- regeneration that changed only the reason, who entered the reading, or the
-- meter: two copies of one request sent at once both read the bill before
-- either writes, and both find it needs writing (sameBill in
-- src/lib/billing/generate.ts compares the same columns). The second then
-- finds the bill changed and is refused, instead of adding a second audit
-- row. If fn_record_line_item_with_audit comes to write another column, or
-- sameBill to compare one, add it here too. Under a FOR SHARE lock on the
-- period and a FOR UPDATE lock on the bill, both held to commit, it refuses
-- with SQLSTATE 23514 and a message starting with a token, which
-- src/lib/billing/generate.ts maps to a response:
--   billing_period_closed       the period is not a draft
--   billing_line_item_changed   the bill is gone, is not this period's bill
--                               for this tenant, or one of the expected
--                               values differs
--   billing_line_item_invoiced  the bill has an invoice number
-- and otherwise calls fn_record_line_item_with_audit with the same arguments
-- in the same transaction, which writes the bill and its audit row.
-- A malformed _expected raises 22023 'billing_expected_bill_invalid'.
--
-- The locks are taken in the order the other writers of these rows take
-- them, so none of them deadlocks with this one:
--   * fn_close_billing_period (20261118130000) takes the period FOR UPDATE,
--     then the period's bills FOR SHARE. It waits for this function, or this
--     function waits for it and then finds the period closed.
--   * fn_apply_payment_event takes the bill FOR UPDATE, and
--     fn_billing_line_item_closed_period_guard then takes the period FOR
--     SHARE, which does not conflict with this function's FOR SHARE.
--   * The PDF route's UPDATE ... SET invoice_number ... WHERE invoice_number
--     IS NULL takes the bill's row lock, as fn_apply_payment_event does.
-- If one of those comes to lock the period FOR UPDATE after locking a bill,
-- revisit.
--
-- POST /api/billing/generate keeps calling fn_record_line_item_with_audit,
-- which checks none of this: a closed period's bill and an invoiced or paid
-- bill are still regenerated there, as before.
--
-- SECURITY INVOKER, like fn_record_line_item_with_audit: the caller's row
-- security decides which periods and bills it can lock and write. Execute is
-- revoked from PUBLIC and anon and granted to authenticated and service_role,
-- as CLAUDE.md asks of SECURITY DEFINER functions.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS fn_regenerate_bill_with_audit(jsonb, uuid, uuid, uuid, numeric, numeric, numeric, jsonb, numeric, billing_line_item_reading_source, uuid, text, uuid, jsonb, uuid, text, text);

CREATE OR REPLACE FUNCTION fn_regenerate_bill_with_audit(
  _expected            JSONB,
  _billing_period_id   UUID,
  _tenant_id           UUID,
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
)
RETURNS billing_line_items
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period_status billing_period_status;
  v_bill          billing_line_items%ROWTYPE;
  v_line_item_id  UUID;
BEGIN
  IF _expected IS NULL
     OR jsonb_typeof(_expected) <> 'object'
     OR NOT (_expected ?& ARRAY['line_item_id', 'payment_status', 'total_amount', 'usage_kwh', 'start_kwh', 'end_kwh', 'reading_source', 'device_id', 'tier_breakdown', 'entered_by_user_id', 'manual_reason'])
  THEN
    RAISE EXCEPTION 'billing_expected_bill_invalid: _expected names the bill and every value it was read with'
      USING ERRCODE = '22023';
  END IF;
  v_line_item_id := (_expected->>'line_item_id')::uuid;

  -- The period first, as fn_record_line_item_with_audit and the closed-period
  -- guard lock it. A close waiting on this lock finds the bill rewritten; a
  -- close that got here first leaves the period closed, and this refuses.
  SELECT status INTO v_period_status
  FROM billing_periods
  WHERE id = _billing_period_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_line_item_changed: the bill''s billing period is not visible'
      USING ERRCODE = '23514';
  END IF;
  IF v_period_status <> 'draft' THEN
    RAISE EXCEPTION 'billing_period_closed: a bill in a closed billing period is not regenerated here'
      USING ERRCODE = '23514', DETAIL = 'closed';
  END IF;

  -- Then the bill, to commit: a payment, an invoice number or another
  -- regeneration of it waits for this one, or this one sees it.
  SELECT * INTO v_bill
  FROM billing_line_items
  WHERE id = v_line_item_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_bill.billing_period_id IS DISTINCT FROM _billing_period_id
     OR v_bill.tenant_id IS DISTINCT FROM _tenant_id
  THEN
    RAISE EXCEPTION 'billing_line_item_changed: the bill is not this period''s bill for this tenant'
      USING ERRCODE = '23514';
  END IF;

  IF v_bill.invoice_number IS NOT NULL THEN
    RAISE EXCEPTION 'billing_line_item_invoiced: an invoiced bill is not regenerated here'
      USING ERRCODE = '23514';
  END IF;

  IF v_bill.payment_status::text IS DISTINCT FROM (_expected->>'payment_status')
     OR v_bill.total_amount IS DISTINCT FROM (_expected->>'total_amount')::numeric
     OR v_bill.usage_kwh IS DISTINCT FROM (_expected->>'usage_kwh')::numeric
     OR v_bill.start_kwh IS DISTINCT FROM (_expected->>'start_kwh')::numeric
     OR v_bill.end_kwh IS DISTINCT FROM (_expected->>'end_kwh')::numeric
     OR v_bill.reading_source::text IS DISTINCT FROM (_expected->>'reading_source')
     OR v_bill.device_id IS DISTINCT FROM (_expected->>'device_id')::uuid
     OR v_bill.tier_breakdown IS DISTINCT FROM (_expected->'tier_breakdown')
     OR v_bill.entered_by_user_id IS DISTINCT FROM (_expected->>'entered_by_user_id')::uuid
     OR v_bill.manual_reason IS DISTINCT FROM (_expected->>'manual_reason')
  THEN
    RAISE EXCEPTION 'billing_line_item_changed: the bill changed after it was read'
      USING ERRCODE = '23514';
  END IF;

  RETURN fn_record_line_item_with_audit(
    _billing_period_id,
    _tenant_id,
    _device_id,
    _usage_kwh,
    _start_kwh,
    _end_kwh,
    _tier_breakdown,
    _total_amount,
    _reading_source,
    _entered_by_user_id,
    _manual_reason,
    _actor_user_id,
    _audit_details,
    _rate_schedule_id,
    _actor_kind,
    _actor_ref
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_regenerate_bill_with_audit(JSONB, UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC, billing_line_item_reading_source, UUID, TEXT, UUID, JSONB, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_regenerate_bill_with_audit(JSONB, UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC, billing_line_item_reading_source, UUID, TEXT, UUID, JSONB, UUID, TEXT, TEXT) TO authenticated, service_role;
