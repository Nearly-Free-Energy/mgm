-- Historical tariff reconciliation for periods billed before rate_schedule_id
-- existed. Run ONLY after comparing the original invoice / MBE tariff and
-- line-item amounts with the selected immutable rate_schedules row. If the
-- historical tariff was edited in place and no matching row survives, first
-- reconstruct and independently verify the original tariff as a new version.
-- This is privileged operator SQL, never a browser/PostgREST endpoint.
--
-- Before running: replace all three values below. Run one period per review.
-- The zero UUID and blank reference intentionally make the template fail.
BEGIN;
DO $$
DECLARE
  v_period_id uuid := '00000000-0000-0000-0000-000000000000';
  v_schedule_id uuid := '00000000-0000-0000-0000-000000000000';
  v_review_reference text := '';
  v_period public.billing_periods%ROWTYPE;
  v_schedule public.rate_schedules%ROWTYPE;
  v_line_count integer;
BEGIN
  IF v_period_id = '00000000-0000-0000-0000-000000000000'
     OR v_schedule_id = '00000000-0000-0000-0000-000000000000'
     OR btrim(v_review_reference) = '' THEN
    RAISE EXCEPTION 'Set period ID, verified tariff ID, and review reference';
  END IF;

  SELECT * INTO v_period FROM public.billing_periods
  WHERE id = v_period_id FOR UPDATE;
  IF NOT FOUND OR v_period.rate_schedule_id IS NOT NULL THEN
    RAISE EXCEPTION 'Period missing or already pinned';
  END IF;
  SELECT * INTO v_schedule FROM public.rate_schedules
  WHERE id = v_schedule_id AND microgrid_id = v_period.microgrid_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tariff missing or belongs to another microgrid';
  END IF;
  SELECT count(*) INTO v_line_count FROM public.billing_line_items
  WHERE billing_period_id = v_period_id;
  IF v_line_count = 0 AND v_period.status = 'draft' THEN
    RAISE EXCEPTION 'Empty draft: use normal tariff selection, not historical reconciliation';
  END IF;

  UPDATE public.billing_periods SET rate_schedule_id = v_schedule_id
  WHERE id = v_period_id;
  INSERT INTO public.billing_audit_log (
    billing_period_id, event_type, actor_kind, actor_ref, details
  ) VALUES (
    v_period_id, 'tariff_reconciled', 'system', v_review_reference,
    jsonb_build_object(
      'rate_schedule_id', v_schedule_id,
      'line_item_count', v_line_count,
      'review_reference', v_review_reference
    )
  );
  RAISE NOTICE 'Pinned period % to verified tariff % (% existing bills)',
    v_period_id, v_schedule_id, v_line_count;
END;
$$;
COMMIT;
