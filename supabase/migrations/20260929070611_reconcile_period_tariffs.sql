-- Empty drafts may follow a newly versioned tariff until the first bill is
-- written. Once billed or closed, the period's selected tariff is immutable.
ALTER TYPE public.billing_audit_event_type
  ADD VALUE IF NOT EXISTS 'tariff_reconciled';

-- now() is constant across a transaction; two versions created in one
-- transaction could otherwise sort by random UUID rather than insertion time.
ALTER TABLE public.rate_schedules
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

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
     AND NEW.rate_schedule_id IS DISTINCT FROM OLD.rate_schedule_id
     AND (OLD.status <> 'draft' OR EXISTS (
       SELECT 1 FROM public.billing_line_items
       WHERE billing_period_id = OLD.id
     )) THEN
    RAISE EXCEPTION 'A billed or closed period tariff cannot be changed'
      USING ERRCODE = '23514';
  END IF;

  -- Historical recovery is an audited SQL operation by the database owner,
  -- never a direct Data API update by an authenticated manager. This
  -- current_user check assumes no future postgres-owned SECURITY DEFINER
  -- function exposes an arbitrary billing_periods update; audit any such
  -- function before granting it to an application role.
  IF TG_OP = 'UPDATE' AND OLD.rate_schedule_id IS NULL
     AND NEW.rate_schedule_id IS NOT NULL
     AND (OLD.status <> 'draft' OR EXISTS (
       SELECT 1 FROM public.billing_line_items
       WHERE billing_period_id = OLD.id
     )) AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Historical tariff reconciliation requires privileged operator SQL'
      USING ERRCODE = '42501';
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

-- This RPC is deliberately invoker-scoped: the billing period and schedule
-- reads/updates remain subject to RLS. Locking the row serializes generation
-- with re-pinning, so concurrent writes cannot select different tariffs.
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

  IF period_row.status <> 'draft' OR EXISTS (
    SELECT 1 FROM public.billing_line_items WHERE billing_period_id = _period_id
  ) THEN
    IF period_row.rate_schedule_id IS NULL THEN
      RAISE EXCEPTION 'Unpinned billed or closed period requires tariff reconciliation'
        USING ERRCODE = '23514';
    END IF;
    RETURN period_row.rate_schedule_id;
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

  IF chosen_id IS DISTINCT FROM period_row.rate_schedule_id THEN
    UPDATE public.billing_periods
    SET rate_schedule_id = chosen_id
    WHERE id = _period_id;
  END IF;
  RETURN chosen_id;
END;
$$;
