-- The selected tariff and bill write must agree in the same transaction.
-- Drop the old signature to avoid PostgREST PGRST203 overload ambiguity.
DROP FUNCTION IF EXISTS public.fn_record_line_item_with_audit(
  UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC,
  billing_line_item_reading_source, UUID, TEXT, UUID, JSONB, TEXT, TEXT
);

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
