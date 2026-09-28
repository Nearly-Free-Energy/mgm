-- Serialize period creation per microgrid, reject intersecting windows, and
-- keep each period state change and its audit record in one transaction.
-- This timestamped migration sorts after the pilot's 00063/00064 migrations;
-- include it explicitly when pushing that history (for example, db push
-- --include-all) so Supabase does not skip it as an out-of-order migration.

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

CREATE OR REPLACE FUNCTION fn_close_billing_period(_period_id UUID)
RETURNS SETOF billing_periods
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_period billing_periods%ROWTYPE;
BEGIN
  UPDATE billing_periods bp
  SET status = 'closed', closed_at = now()
  WHERE bp.id = _period_id
    AND bp.status <> 'closed'
    AND user_can_access_microgrid(bp.microgrid_id)
  RETURNING bp.* INTO v_period;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Billing period not found, unauthorized, or already closed'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO billing_audit_log (
    billing_period_id, event_type, actor_user_id, actor_kind, details
  ) VALUES (
    v_period.id, 'period_closed', auth.uid(), 'human', '{}'::jsonb
  );

  RETURN NEXT v_period;
END;
$$;

REVOKE ALL ON FUNCTION fn_create_billing_period(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_create_billing_period(UUID, DATE, DATE) TO authenticated;
REVOKE ALL ON FUNCTION fn_close_billing_period(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_close_billing_period(UUID) TO authenticated;
