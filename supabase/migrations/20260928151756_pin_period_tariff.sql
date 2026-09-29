-- A period keeps the tariff version selected when it is created. Tariff edits
-- create new rows, so regenerating an older period cannot silently reprice it.
ALTER TABLE public.billing_periods
  ADD COLUMN IF NOT EXISTS rate_schedule_id uuid
  REFERENCES public.rate_schedules(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_billing_periods_rate_schedule_id
  ON public.billing_periods(rate_schedule_id);

-- Only unbilled drafts can safely select an existing tariff. Even if a
-- historical period has just one schedule row today, that row may have been
-- edited in place, so billed or closed history remains unpinned and blocked
-- from regeneration until its original tariff is reconciled explicitly.
UPDATE public.billing_periods AS period
SET rate_schedule_id = candidate.id
FROM (
  SELECT microgrid_id, min(id::text)::uuid AS id
  FROM public.rate_schedules
  GROUP BY microgrid_id
  HAVING count(*) = 1
) AS candidate
WHERE period.microgrid_id = candidate.microgrid_id
  AND period.rate_schedule_id IS NULL
  AND period.status = 'draft'
  AND NOT EXISTS (
    SELECT 1 FROM public.billing_line_items li
    WHERE li.billing_period_id = period.id
  );

CREATE OR REPLACE FUNCTION public.fn_guard_period_tariff()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.rate_schedule_id IS NULL THEN
    SELECT id INTO NEW.rate_schedule_id
    FROM public.rate_schedules
    WHERE microgrid_id = NEW.microgrid_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.rate_schedule_id IS NOT NULL
     AND NEW.rate_schedule_id IS DISTINCT FROM OLD.rate_schedule_id THEN
    RAISE EXCEPTION 'A billing period tariff cannot be changed once selected'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.rate_schedule_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.rate_schedules
    WHERE id = NEW.rate_schedule_id AND microgrid_id = NEW.microgrid_id
  ) THEN
    RAISE EXCEPTION 'Billing period tariff must belong to its microgrid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_period_tariff ON public.billing_periods;
CREATE TRIGGER trg_guard_period_tariff
  BEFORE INSERT OR UPDATE ON public.billing_periods
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_period_tariff();

CREATE OR REPLACE FUNCTION public.fn_guard_referenced_tariff()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.billing_periods WHERE rate_schedule_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'A tariff selected by a billing period cannot be edited'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_referenced_tariff ON public.rate_schedules;
CREATE TRIGGER trg_guard_referenced_tariff
  BEFORE UPDATE ON public.rate_schedules
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_referenced_tariff();

-- Recover an old, unbilled draft period at first write. The row lock makes
-- concurrent generations pick the same version. Closed or already-billed
-- ambiguous periods require explicit reconciliation and cannot be repriced.
CREATE OR REPLACE FUNCTION public.fn_pin_billing_period_rate_schedule(_period_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  period_row public.billing_periods%ROWTYPE;
  chosen_id uuid;
BEGIN
  SELECT * INTO period_row
  FROM public.billing_periods
  WHERE id = _period_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Billing period not found' USING ERRCODE = 'P0002';
  END IF;
  IF period_row.rate_schedule_id IS NOT NULL THEN
    RETURN period_row.rate_schedule_id;
  END IF;
  IF period_row.status <> 'draft' OR EXISTS (
    SELECT 1 FROM public.billing_line_items WHERE billing_period_id = _period_id
  ) THEN
    RAISE EXCEPTION 'Unpinned billed or closed period requires tariff reconciliation'
      USING ERRCODE = '23514';
  END IF;

  SELECT id INTO chosen_id
  FROM public.rate_schedules
  WHERE microgrid_id = period_row.microgrid_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  IF chosen_id IS NULL THEN
    RAISE EXCEPTION 'No rate schedule exists for this microgrid'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.billing_periods
  SET rate_schedule_id = chosen_id
  WHERE id = _period_id;
  RETURN chosen_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_pin_billing_period_rate_schedule(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_pin_billing_period_rate_schedule(uuid) TO authenticated;
