-- billing_audit_log rows are written by the billing functions that record
-- the change they describe.
--
-- Four functions insert into billing_audit_log, each in the same transaction
-- as the change it records (the latest definition of each, found by reading
-- every migration; no trigger and no other function inserts into the table,
-- and no application code does):
--   fn_create_billing_period              (20260928151821)  billing_period_created
--   fn_close_billing_period               (20261118130000)  period_closed
--   fn_record_line_item_with_audit        (20261116230000)  line_item_generated / _regenerated
--                                                           (also reached through
--                                                           fn_regenerate_bill_with_audit)
--   fn_record_first_line_item_with_audit  (20261120130100)  line_item_generated
-- supabase/scripts/reconcile-historical-period-tariff.sql also inserts one
-- (tariff_reconciled); it is operator SQL run as the database owner, which
-- section 1 exempts.
--
-- This migration adds:
--   1. trg_billing_audit_log_written_by_functions, which refuses an insert by
--      a signed-in caller (the API roles, authenticated and anon) unless the
--      transaction-local setting mgm.billing_audit_writer is 'on';
--   2. the four functions again, each body copied from its latest
--      definition with two lines added: it sets mgm.billing_audit_writer to
--      'on' immediately before its INSERT into billing_audit_log and clears
--      it immediately after;
--   3. in fn_record_line_item_with_audit and
--      fn_record_first_line_item_with_audit, which take the audit row's
--      actor as arguments, a check before that INSERT that a signed-in
--      caller's row names the caller: actor_kind 'human' and actor_user_id
--      auth.uid(). fn_create_billing_period and fn_close_billing_period
--      already write auth.uid() and 'human' themselves.
--   Signatures, security mode, search_path and grants are unchanged
--   (CREATE OR REPLACE keeps the grants; each function's latest grant
--   statements are repeated as they were).
--
-- The INSERT grant to authenticated and the "Authorized users can write
-- billing_audit_log" policy (00064) stay. The four functions are SECURITY
-- INVOKER: their INSERT runs as the caller, with the caller's privileges and
-- row security, so without the grant and the policy their own audit rows
-- would be refused. The policy still checks that the row's period is one the
-- caller can access. The trigger adds what neither can say: that the row
-- comes from one of these functions.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_billing_audit_log_written_by_functions ON billing_audit_log;
--   DROP FUNCTION IF EXISTS fn_billing_audit_log_written_by_functions();
-- The functions may keep setting the flag; nothing reads it then.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Audit rows come from the billing functions
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Refused for a signed-in caller (the API roles, authenticated and anon):
-- any insert into billing_audit_log while mgm.billing_audit_writer is not
-- 'on'. Refusals raise SQLSTATE 42501 with a message starting
-- billing_audit_log_via_function and DETAIL audit_via_function.
--
-- Roles other than the API roles are exempt, because they act on the
-- database directly rather than as a person: service_role already bypasses
-- row-level security and is how fixtures, imports and restores write rows,
-- and postgres runs migrations and operator SQL and can disable this
-- trigger. A SECURITY DEFINER function owned by postgres also runs as
-- postgres, so one that inserts audit rows would be exempt too; none does
-- today, and one that does decides for itself what it records. This is the
-- scope trg_billing_period_transitions_by_close (20261118130000) has.
--
-- The trigger function is SECURITY INVOKER, so current_user is the role the
-- inserting statement runs as: inside the four SECURITY INVOKER functions
-- that is still the caller's role, which is why they set the flag.
--
-- A signed-in caller cannot set the flag: PostgREST runs no SET for them,
-- set_config is not in a schema PostgREST exposes, and the only functions the
-- API roles can execute that set it are the four below, each of which turns
-- it on only for its own audit INSERT, in the transaction that makes the
-- change the row records, and clears it straight after. The setting is
-- transaction-local; if the INSERT fails inside a caller's exception block,
-- rolling back that subtransaction restores the setting as well. If a
-- function granted to the API roles comes to set the flag around anything
-- but its own audit insert, or PostgREST comes to pass client-chosen
-- settings through, this check no longer holds; revisit.
--
-- A new function that writes audit rows sets the flag the same way around
-- its INSERT, or a signed-in caller's call to it is refused here.

CREATE OR REPLACE FUNCTION fn_billing_audit_log_written_by_functions()
RETURNS TRIGGER
LANGUAGE plpgsql
-- INVOKER, so current_user is the role the statement runs as.
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF current_setting('mgm.billing_audit_writer', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'billing_audit_log_via_function: billing audit rows are written by the billing functions that record the change'
      USING ERRCODE = '42501', DETAIL = 'audit_via_function';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_billing_audit_log_written_by_functions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_billing_audit_log_written_by_functions() TO service_role;

DROP TRIGGER IF EXISTS trg_billing_audit_log_written_by_functions ON billing_audit_log;
CREATE TRIGGER trg_billing_audit_log_written_by_functions
  BEFORE INSERT ON billing_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION fn_billing_audit_log_written_by_functions();

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The four functions set the flag around their audit insert
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Each body below is its latest definition with the two set_config lines
-- added. If one of these functions is re-issued later, carry the two lines
-- with it, or its audit insert is refused for a signed-in caller.
--
-- fn_record_line_item_with_audit and fn_record_first_line_item_with_audit
-- also check the actor they are given, just before their audit INSERT. For a
-- signed-in caller (the API roles) the row must be actor_kind 'human' with
-- actor_user_id = auth.uid(); anything else raises SQLSTATE 42501 with a
-- message starting billing_audit_actor_is_caller and DETAIL
-- audit_actor_is_caller, and the whole call, bill write included, rolls
-- back. fn_regenerate_bill_with_audit passes its actor through to
-- fn_record_line_item_with_audit, so the check covers it too. Other roles
-- are exempt for the reason section 1 gives: they act on the database
-- directly rather than as a person, and a non-human actor (actor_kind
-- 'system' with an actor_ref) is recorded by such a role naming it. The
-- app's signed-in writes (generate.ts, through the billing capability) pass
-- the session user; if one comes to need another actor, it goes through
-- such a role or this check is revisited. If either function is re-issued
-- later, carry the check with it.

-- fn_create_billing_period (20260928151821)

CREATE OR REPLACE FUNCTION fn_create_billing_period(
  _microgrid_id UUID,
  _start_date DATE,
  _end_date DATE
)
RETURNS SETOF billing_periods
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_period billing_periods%ROWTYPE;
BEGIN
  IF _start_date IS NULL OR _end_date IS NULL OR _start_date > _end_date THEN
    RAISE EXCEPTION 'Invalid billing period date range' USING ERRCODE = '22007';
  END IF;
  IF NOT user_can_access_microgrid(_microgrid_id) THEN
    RAISE EXCEPTION 'Not authorized to create billing period' USING ERRCODE = '42501';
  END IF;

  -- Hash collisions only serialize unrelated microgrids; they cannot weaken
  -- the overlap guarantee.
  PERFORM pg_advisory_xact_lock(hashtextextended(_microgrid_id::text, 0));

  IF EXISTS (
    SELECT 1 FROM billing_periods bp
    WHERE bp.microgrid_id = _microgrid_id
      AND daterange(bp.start_date, bp.end_date, '[]')
          && daterange(_start_date, _end_date, '[]')
  ) THEN
    RAISE EXCEPTION 'Billing period overlaps an existing period'
      USING ERRCODE = '23P01';
  END IF;

  INSERT INTO billing_periods (microgrid_id, start_date, end_date)
  VALUES (_microgrid_id, _start_date, _end_date)
  RETURNING * INTO v_period;

  PERFORM set_config('mgm.billing_audit_writer', 'on', true);
  INSERT INTO billing_audit_log (
    billing_period_id, event_type, actor_user_id, actor_kind, details
  ) VALUES (
    v_period.id, 'billing_period_created', auth.uid(), 'human',
    jsonb_build_object('start_date', v_period.start_date, 'end_date', v_period.end_date)
  );
  PERFORM set_config('mgm.billing_audit_writer', '', true);

  RETURN NEXT v_period;
END;
$$;
REVOKE ALL ON FUNCTION fn_create_billing_period(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_create_billing_period(UUID, DATE, DATE) TO authenticated;

-- fn_close_billing_period (20261118130000)

CREATE OR REPLACE FUNCTION fn_close_billing_period(
  _period_id UUID,
  _digest TEXT,
  _acknowledged TEXT[]
)
RETURNS SETOF billing_periods
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period  billing_periods%ROWTYPE;
  v_review  JSONB;
  v_missing TEXT[];
  v_rows    INTEGER;
BEGIN
  SELECT * INTO v_period
  FROM billing_periods
  WHERE id = _period_id
    AND user_can_access_microgrid(microgrid_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_period_not_found: the billing period does not exist or is not yours to close'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_period.status = 'closed' THEN
    RAISE EXCEPTION 'billing_period_closed: the billing period is already closed'
      USING ERRCODE = '23514', DETAIL = 'closed';
  END IF;

  PERFORM 1
  FROM billing_line_items li
  WHERE li.billing_period_id = _period_id
  ORDER BY li.id
  FOR SHARE;

  v_review := fn_billing_period_close_review(_period_id);

  IF jsonb_array_length(v_review->'fractionalTotals') > 0 THEN
    RAISE EXCEPTION 'billing_close_fractional_total: % bill(s) have a total that is not a whole number',
      jsonb_array_length(v_review->'fractionalTotals')
      USING ERRCODE = '23514', DETAIL = 'fractional_total';
  END IF;

  IF _digest IS NULL OR _digest IS DISTINCT FROM v_review->>'digest' THEN
    RAISE EXCEPTION 'billing_close_totals_changed: the period''s totals changed after they were reviewed'
      USING ERRCODE = '23514', DETAIL = 'totals_changed';
  END IF;

  SELECT COALESCE(array_agg(a ORDER BY a), '{}'::text[])
  INTO v_missing
  FROM jsonb_array_elements_text(v_review->'acknowledgements') AS a
  -- COALESCE: a NULL element would make the comparison NULL, which must
  -- count as not acknowledged.
  WHERE NOT COALESCE(a = ANY (_acknowledged), false);

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'billing_close_acknowledgement_missing: %', array_to_string(v_missing, ', ')
      USING ERRCODE = '23514', DETAIL = array_to_string(v_missing, ',');
  END IF;

  PERFORM set_config('mgm.billing_period_close', _period_id::text, true);

  UPDATE billing_periods bp
  SET status = 'closed', closed_at = now()
  WHERE bp.id = _period_id
  RETURNING bp.* INTO v_period;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Cannot happen under the row lock taken above; checked so that no audit
  -- row is ever written for a close that changed nothing.
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'billing_period_not_found: the billing period does not exist or is not yours to close'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('mgm.billing_period_close', '', true);

  PERFORM set_config('mgm.billing_audit_writer', 'on', true);
  INSERT INTO billing_audit_log (
    billing_period_id, event_type, actor_user_id, actor_kind, details
  ) VALUES (
    v_period.id, 'period_closed', auth.uid(), 'human',
    jsonb_build_object(
      'digest', v_review->'digest',
      'acknowledged', v_review->'acknowledgements',
      'bill_count', v_review->'billCount',
      'total_amount', v_review->'totalAmount',
      'currency', v_review->'currency',
      'unresolved', v_review->'unbilled',
      'unmetered', v_review->'unmetered'
    )
  );
  PERFORM set_config('mgm.billing_audit_writer', '', true);

  RETURN NEXT v_period;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_close_billing_period(UUID, TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_close_billing_period(UUID, TEXT, TEXT[]) TO authenticated, service_role;

-- fn_record_line_item_with_audit (20261116230000)

CREATE OR REPLACE FUNCTION public.fn_record_line_item_with_audit(_billing_period_id uuid, _tenant_id uuid, _device_id uuid, _usage_kwh numeric, _start_kwh numeric, _end_kwh numeric, _tier_breakdown jsonb, _total_amount numeric, _reading_source billing_line_item_reading_source, _entered_by_user_id uuid, _manual_reason text, _actor_user_id uuid, _audit_details jsonb, _rate_schedule_id uuid, _actor_kind text DEFAULT 'human'::text, _actor_ref text DEFAULT NULL::text)
 RETURNS billing_line_items
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

-- fn_record_first_line_item_with_audit (20261120130100)

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
BEGIN
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
    COALESCE(_audit_details, '{}'::jsonb)
      || jsonb_build_object('rate_schedule_id', _rate_schedule_id)
  );
  PERFORM set_config('mgm.billing_audit_writer', '', true);

  RETURN v_row;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_record_first_line_item_with_audit(UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC, billing_line_item_reading_source, UUID, TEXT, UUID, JSONB, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_record_first_line_item_with_audit(UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC, billing_line_item_reading_source, UUID, TEXT, UUID, JSONB, UUID, TEXT, TEXT) TO authenticated, service_role;
