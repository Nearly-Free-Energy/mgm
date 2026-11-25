-- The line-item functions record who entered a manual bill and build the
-- audit row's details themselves.
--
-- fn_record_line_item_with_audit and fn_record_first_line_item_with_audit
-- (both SECURITY INVOKER, latest definitions in 20261124160000) take two
-- inputs that describe the write rather than make it:
--   _entered_by_user_id  written to billing_line_items.entered_by_user_id
--                        when _reading_source = 'manual', and shown by name
--                        in the period review (period-review.ts);
--   _audit_details       written, with rate_schedule_id and
--                        period_was_closed added, as billing_audit_log.details.
-- This migration re-issues both functions from 20261124160000, keeping its
-- flag lines (mgm.billing_audit_writer) and its actor check, and adds, for a
-- signed-in caller (current_user authenticated or anon, the test the actor
-- check uses):
--   1. a manual bill is entered by the caller: _entered_by_user_id must be
--      auth.uid(), or the call raises SQLSTATE 42501 with a message starting
--      billing_entered_by_is_caller and DETAIL entered_by_is_caller. An edge
--      bill writes no entered_by_user_id (NULL), so the argument is not
--      checked then;
--   2. the details are the function's: it builds every key from the bill it
--      writes, the row it replaces (read and locked in the same transaction,
--      before the upsert) and the tenant, and the caller's _audit_details
--      contributes nothing. A caller's details may still carry the keys an
--      app built before this migration sends (listed below); the function's
--      values replace them. Any other key, or details that are not a JSON
--      object, raise SQLSTATE 42501 with a message starting
--      billing_audit_details_from_function and DETAIL
--      audit_details_from_function.
-- Both refusals come before anything is written, and the call writes
-- nothing. fn_regenerate_bill_with_audit passes both arguments through to
-- fn_record_line_item_with_audit, so the rules cover it too.
--
-- The details the functions build are the ones generate.ts built before
-- this migration (LineItemRegeneratedDetails, src/lib/types/billing-audit.ts),
-- key for key, so the period history, the audit-log route and every other
-- reader see no change:
--   tenant_name              tenants.display_name (the tenant id if the
--                            caller cannot read the tenant, as generate.ts
--                            fell back to it)
--   previous_total_amount    the replaced bill's total_amount, rounded to a
--                            whole unit; null for a first bill
--   new_total_amount         the written bill's total_amount
--   previous_reading_source  the replaced bill's reading_source; null for a
--                            first bill
--   new_reading_source       the written bill's reading_source
--   manual_reason            the written bill's manual_reason, only when it
--                            is a manual bill with a non-empty reason
--   previous_snapshot        only when a bill is replaced: its start_kwh,
--                            end_kwh, usage_kwh, tier_breakdown, device_id,
--                            entered_by_user_id, entered_at and manual_reason
--                            as stored (#218)
--   rate_schedule_id         _rate_schedule_id, checked against the period's
--                            pinned tariff (unchanged)
--   period_was_closed        true when the period was closed (unchanged)
-- No key is caller knowledge: the manual reason is the bill's own
-- manual_reason, which the function writes from _manual_reason. So no
-- caller key is accepted as free text.
--
-- Other roles (service_role, postgres) keep passing _audit_details as
-- before: when it is not NULL it is written as given, with rate_schedule_id
-- and period_was_closed added, and _entered_by_user_id is written as given.
-- They already bypass row-level security and may insert billing_audit_log
-- and billing_line_items rows directly (20261124160000 § 1), so a check here
-- would refuse nothing they cannot write anyway; fixtures, imports and
-- restores use it. When they pass NULL, the function builds the details as
-- for a signed-in caller.
--
-- Signatures, security mode, search_path and grants are unchanged
-- (CREATE OR REPLACE keeps the grants; the grant statements are repeated as
-- 20261124160000 left them), so database.gen.ts does not change.
--
-- Rollback: re-run section 2 of 20261124160000 for these two functions.

-- ═════════════════════════════════════════════════════════════════════════════
-- fn_record_line_item_with_audit (20261124160000)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Keys an app built before this migration sends in _audit_details (the
-- object generate.ts built). A signed-in caller's details may carry them and
-- the function replaces them; once no deployed app sends them, this list can
-- be emptied, so that any caller details are refused. If generate.ts starts
-- sending details again, revisit. The same list is in
-- fn_record_first_line_item_with_audit below.

CREATE OR REPLACE FUNCTION public.fn_record_line_item_with_audit(_billing_period_id uuid, _tenant_id uuid, _device_id uuid, _usage_kwh numeric, _start_kwh numeric, _end_kwh numeric, _tier_breakdown jsonb, _total_amount numeric, _reading_source billing_line_item_reading_source, _entered_by_user_id uuid, _manual_reason text, _actor_user_id uuid, _audit_details jsonb, _rate_schedule_id uuid, _actor_kind text DEFAULT 'human'::text, _actor_ref text DEFAULT NULL::text)
 RETURNS billing_line_items
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row                     billing_line_items%ROWTYPE;
  v_prior                   billing_line_items%ROWTYPE;
  v_has_prior               BOOLEAN;
  v_tenant_name             TEXT;
  v_was_inserted            BOOLEAN;
  v_period_status           billing_period_status;
  v_pinned_rate_schedule_id UUID;
  v_event_type              billing_audit_event_type;
  v_entered_at              TIMESTAMPTZ;
  v_audit_details           JSONB;
  v_line_item_id            UUID;
  v_tier_breakdown_rounded  JSONB;
BEGIN
  -- A signed-in caller's manual bill is entered by the caller, and its audit
  -- details are built below; see the header.
  IF current_user IN ('authenticated', 'anon') THEN
    IF _audit_details IS NOT NULL THEN
      IF jsonb_typeof(_audit_details) <> 'object' THEN
        RAISE EXCEPTION 'billing_audit_details_from_function: the billing functions build a signed-in caller''s audit details'
          USING ERRCODE = '42501', DETAIL = 'audit_details_from_function';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_object_keys(_audit_details) AS k
        WHERE k <> ALL (ARRAY['tenant_name', 'previous_total_amount', 'new_total_amount',
                              'previous_reading_source', 'new_reading_source',
                              'manual_reason', 'previous_snapshot'])
      ) THEN
        RAISE EXCEPTION 'billing_audit_details_from_function: the billing functions build a signed-in caller''s audit details'
          USING ERRCODE = '42501', DETAIL = 'audit_details_from_function';
      END IF;
    END IF;
    IF _reading_source = 'manual' AND _entered_by_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'billing_entered_by_is_caller: a signed-in caller''s manual bill is entered by the caller'
        USING ERRCODE = '42501', DETAIL = 'entered_by_is_caller';
    END IF;
  END IF;

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

  -- The bill this call replaces, if any, locked to commit, for the audit
  -- row's previous_* keys. Period first, then bill, the order
  -- fn_regenerate_bill_with_audit takes them in (it has already locked this
  -- row when it calls here). A bill inserted by another transaction after
  -- this read is still updated by the upsert below; its audit row then has
  -- no previous values, as when generate.ts read the bill before calling.
  SELECT * INTO v_prior
  FROM billing_line_items
  WHERE billing_period_id = _billing_period_id
    AND tenant_id = _tenant_id
  FOR UPDATE;
  v_has_prior := FOUND;

  SELECT display_name INTO v_tenant_name
  FROM tenants
  WHERE id = _tenant_id;

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
  -- only while this names its period and tenant. Cleared right after.
  PERFORM set_config('mgm.audited_bill_write',
                     _billing_period_id::text || '/' || _tenant_id::text, true);

  -- UPSERT on (billing_period_id, tenant_id) — body unchanged from 00039.
  INSERT INTO billing_line_items (
    billing_period_id,
    tenant_id,
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
    _tenant_id,
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
  ON CONFLICT (billing_period_id, tenant_id) DO UPDATE SET
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

  -- The audit row's details: as given by a role other than the API roles,
  -- else built from the bills (see the header).
  IF current_user NOT IN ('authenticated', 'anon') AND _audit_details IS NOT NULL THEN
    v_audit_details := _audit_details
      || jsonb_build_object('rate_schedule_id', _rate_schedule_id);
  ELSE
    v_audit_details := jsonb_build_object(
        'tenant_name',             COALESCE(v_tenant_name, _tenant_id::text),
        'previous_total_amount',   CASE WHEN v_has_prior THEN ROUND(v_prior.total_amount, 0) END,
        'new_total_amount',        v_row.total_amount,
        'previous_reading_source', CASE WHEN v_has_prior THEN v_prior.reading_source END,
        'new_reading_source',      v_row.reading_source,
        'rate_schedule_id',        _rate_schedule_id
      )
      || CASE WHEN v_row.reading_source = 'manual' AND v_row.manual_reason <> ''
              THEN jsonb_build_object('manual_reason', v_row.manual_reason)
              ELSE '{}'::jsonb END
      || CASE WHEN v_has_prior
              THEN jsonb_build_object('previous_snapshot', jsonb_build_object(
                     'start_kwh',          v_prior.start_kwh,
                     'end_kwh',            v_prior.end_kwh,
                     'usage_kwh',          v_prior.usage_kwh,
                     'tier_breakdown',     v_prior.tier_breakdown,
                     'device_id',          v_prior.device_id,
                     'entered_by_user_id', v_prior.entered_by_user_id,
                     'entered_at',         v_prior.entered_at,
                     'manual_reason',      v_prior.manual_reason))
              ELSE '{}'::jsonb END;
  END IF;

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

  IF current_user IN ('authenticated', 'anon')
     AND (COALESCE(_actor_kind, 'human') <> 'human'
          OR _actor_user_id IS DISTINCT FROM auth.uid()) THEN
    RAISE EXCEPTION 'billing_audit_actor_is_caller: a signed-in caller''s audit row names the caller'
      USING ERRCODE = '42501', DETAIL = 'audit_actor_is_caller';
  END IF;

  PERFORM set_config('mgm.billing_audit_writer', 'on', true);
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
  PERFORM set_config('mgm.billing_audit_writer', '', true);

  RETURN v_row;
END;
$function$;
REVOKE EXECUTE ON FUNCTION fn_record_line_item_with_audit(uuid, uuid, uuid, numeric, numeric, numeric, jsonb, numeric, billing_line_item_reading_source, uuid, text, uuid, jsonb, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_record_line_item_with_audit(uuid, uuid, uuid, numeric, numeric, numeric, jsonb, numeric, billing_line_item_reading_source, uuid, text, uuid, jsonb, uuid, text, text) TO authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- fn_record_first_line_item_with_audit (20261124160000)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A first bill replaces none, so its details have no previous values and no
-- previous_snapshot, as generate.ts built them for a first bill.

CREATE OR REPLACE FUNCTION fn_record_first_line_item_with_audit(
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
  v_row                    billing_line_items%ROWTYPE;
  v_period_status          billing_period_status;
  v_pinned_rate_schedule   UUID;
  v_tier_breakdown_rounded JSONB;
  v_tenant_name            TEXT;
  v_audit_details          JSONB;
BEGIN
  -- As in fn_record_line_item_with_audit above, with the same key list.
  IF current_user IN ('authenticated', 'anon') THEN
    IF _audit_details IS NOT NULL THEN
      IF jsonb_typeof(_audit_details) <> 'object' THEN
        RAISE EXCEPTION 'billing_audit_details_from_function: the billing functions build a signed-in caller''s audit details'
          USING ERRCODE = '42501', DETAIL = 'audit_details_from_function';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_object_keys(_audit_details) AS k
        WHERE k <> ALL (ARRAY['tenant_name', 'previous_total_amount', 'new_total_amount',
                              'previous_reading_source', 'new_reading_source',
                              'manual_reason', 'previous_snapshot'])
      ) THEN
        RAISE EXCEPTION 'billing_audit_details_from_function: the billing functions build a signed-in caller''s audit details'
          USING ERRCODE = '42501', DETAIL = 'audit_details_from_function';
      END IF;
    END IF;
    IF _reading_source = 'manual' AND _entered_by_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'billing_entered_by_is_caller: a signed-in caller''s manual bill is entered by the caller'
        USING ERRCODE = '42501', DETAIL = 'entered_by_is_caller';
    END IF;
  END IF;

  SELECT status, rate_schedule_id
  INTO v_period_status, v_pinned_rate_schedule
  FROM billing_periods
  WHERE id = _billing_period_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_period_not_found: the billing period does not exist or is not yours to bill'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_period_status <> 'draft' THEN
    RAISE EXCEPTION 'billing_period_closed: a first bill is not added to a closed billing period'
      USING ERRCODE = '23514', DETAIL = 'closed';
  END IF;
  IF _rate_schedule_id IS NULL
     OR v_pinned_rate_schedule IS DISTINCT FROM _rate_schedule_id THEN
    RAISE EXCEPTION 'Billing period tariff changed; recalculate before writing bill'
      USING ERRCODE = '23514';
  END IF;

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

  INSERT INTO billing_line_items (
    billing_period_id,
    tenant_id,
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
    _tenant_id,
    _device_id,
    ROUND(_usage_kwh, 3),
    ROUND(_start_kwh, 3),
    ROUND(_end_kwh,   3),
    v_tier_breakdown_rounded,
    ROUND(_total_amount, 0),
    _reading_source,
    CASE WHEN _reading_source = 'manual' THEN _entered_by_user_id ELSE NULL END,
    CASE WHEN _reading_source = 'manual' THEN now() ELSE NULL END,
    CASE WHEN _reading_source = 'manual' THEN _manual_reason ELSE NULL END
  )
  ON CONFLICT (billing_period_id, tenant_id) DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_line_item_exists: the tenant already has a bill for this billing period'
      USING ERRCODE = '23514', DETAIL = 'bill_exists';
  END IF;

  IF current_user NOT IN ('authenticated', 'anon') AND _audit_details IS NOT NULL THEN
    v_audit_details := _audit_details
      || jsonb_build_object('rate_schedule_id', _rate_schedule_id);
  ELSE
    SELECT display_name INTO v_tenant_name
    FROM tenants
    WHERE id = _tenant_id;

    v_audit_details := jsonb_build_object(
        'tenant_name',             COALESCE(v_tenant_name, _tenant_id::text),
        'previous_total_amount',   NULL,
        'new_total_amount',        v_row.total_amount,
        'previous_reading_source', NULL,
        'new_reading_source',      v_row.reading_source,
        'rate_schedule_id',        _rate_schedule_id
      )
      || CASE WHEN v_row.reading_source = 'manual' AND v_row.manual_reason <> ''
              THEN jsonb_build_object('manual_reason', v_row.manual_reason)
              ELSE '{}'::jsonb END;
  END IF;

  IF current_user IN ('authenticated', 'anon')
     AND (COALESCE(_actor_kind, 'human') <> 'human'
          OR _actor_user_id IS DISTINCT FROM auth.uid()) THEN
    RAISE EXCEPTION 'billing_audit_actor_is_caller: a signed-in caller''s audit row names the caller'
      USING ERRCODE = '42501', DETAIL = 'audit_actor_is_caller';
  END IF;

  PERFORM set_config('mgm.billing_audit_writer', 'on', true);
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
    'line_item_generated',
    _actor_user_id,
    COALESCE(_actor_kind, 'human'),
    _actor_ref,
    v_audit_details
  );
  PERFORM set_config('mgm.billing_audit_writer', '', true);

  RETURN v_row;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_record_first_line_item_with_audit(UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC, billing_line_item_reading_source, UUID, TEXT, UUID, JSONB, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_record_first_line_item_with_audit(UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC, billing_line_item_reading_source, UUID, TEXT, UUID, JSONB, UUID, TEXT, TEXT) TO authenticated, service_role;
