-- Serialize period creation per microgrid, reject intersecting windows, and
-- keep each period state change and its audit record in one transaction.
-- This timestamped migration sorts after the pilot's 00063/00064 migrations;
-- include it explicitly when pushing that history (for example, db push
-- --include-all) so Supabase does not skip it as an out-of-order migration.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- Backfill/reconcile any existing overlapping periods before this migration:
-- accepting them would leave the database able to double bill a day.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM billing_periods a
    JOIN billing_periods b ON a.microgrid_id = b.microgrid_id AND a.id < b.id
    WHERE daterange(a.start_date, a.end_date, '[]') &&
          daterange(b.start_date, b.end_date, '[]')
  ) THEN
    RAISE EXCEPTION 'Existing overlapping billing periods must be reconciled before Release 3 migration';
  END IF;
END;
$$;

ALTER TABLE billing_periods
  ADD CONSTRAINT billing_periods_no_overlap
  EXCLUDE USING gist (
    microgrid_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );

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

  INSERT INTO billing_audit_log (
    billing_period_id, event_type, actor_user_id, actor_kind, details
  ) VALUES (
    v_period.id, 'billing_period_created', auth.uid(), 'human',
    jsonb_build_object('start_date', v_period.start_date, 'end_date', v_period.end_date)
  );

  RETURN NEXT v_period;
END;
$$;

CREATE OR REPLACE FUNCTION fn_close_billing_period(
  _period_id UUID,
  _confirmed BOOLEAN DEFAULT FALSE
)
RETURNS SETOF billing_periods
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_period billing_periods%ROWTYPE;
  v_unresolved JSONB;
BEGIN
  SELECT * INTO v_period
  FROM billing_periods
  WHERE id = _period_id
    AND status <> 'closed'
    AND user_can_access_microgrid(microgrid_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Billing period not found, unauthorized, or already closed'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'householdId', h.id,
    'householdName', h.display_name,
    'reason', 'No bill generated for this household in this period.'
  ) ORDER BY h.display_name), '[]'::jsonb)
  INTO v_unresolved
  FROM households h
  WHERE h.microgrid_id = v_period.microgrid_id
    AND NOT EXISTS (
      SELECT 1 FROM billing_line_items li
      WHERE li.billing_period_id = v_period.id AND li.household_id = h.id
    );

  IF jsonb_array_length(v_unresolved) > 0 AND NOT _confirmed THEN
    RAISE EXCEPTION 'Period has unresolved households; explicit confirmation required'
      USING ERRCODE = '23514';
  END IF;

  UPDATE billing_periods bp
  SET status = 'closed', closed_at = now()
  WHERE bp.id = _period_id
  RETURNING bp.* INTO v_period;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Billing period not found, unauthorized, or already closed'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO billing_audit_log (
    billing_period_id, event_type, actor_user_id, actor_kind, details
  ) VALUES (
    v_period.id, 'period_closed', auth.uid(), 'human',
    jsonb_build_object('confirmed', _confirmed, 'unresolved', v_unresolved)
  );

  RETURN NEXT v_period;
END;
$$;

REVOKE ALL ON FUNCTION fn_create_billing_period(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_create_billing_period(UUID, DATE, DATE) TO authenticated;
REVOKE ALL ON FUNCTION fn_close_billing_period(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_close_billing_period(UUID, BOOLEAN) TO authenticated;
