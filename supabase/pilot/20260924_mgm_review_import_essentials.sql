-- MGM review/import essentials for a new project.
--
-- Apply only after the reviewed base migration files through 00015. This is intentionally
-- outside supabase/migrations because the MGM pilot uses a curated schema
-- surface rather than the full inherited application migration chain.
--
-- It only adds columns, types, indexes, a metadata table, constraints, and a
-- read policy. It does not import any customer data.

-- Fail closed unless this database is exactly at the reviewed base version.
-- Also avoid stamping existing billing periods with an assumed UTC zone.
DO $$
DECLARE
  v_timezone_column_exists BOOLEAN;
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'MGM pilot schema requires the reviewed base migration history';
  END IF;

  -- The repository has no 00005/00006 files; 00003 is a seed template and
  -- is deliberately omitted from the empty cloud project. Supabase CLI and
  -- the management API record different version formats, so check the
  -- reviewed migration identities rather than assuming a five-digit version.
  IF EXISTS (
    SELECT required.version
    FROM (VALUES
      ('00001'), ('00002'), ('00004'), ('00007'), ('00008'), ('00009'),
      ('00010'), ('00011'), ('00012'), ('00013'), ('00014'), ('00015')
    ) AS required(version)
    WHERE NOT EXISTS (
      SELECT 1 FROM supabase_migrations.schema_migrations AS applied
      WHERE applied.version::text = required.version
         OR applied.name LIKE 'mgm_' || required.version || '_%'
    )
  ) THEN
    RAISE EXCEPTION 'MGM pilot schema requires the reviewed base migrations through 00015';
  END IF;

  IF EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations AS applied
    WHERE (applied.version::text ~ '^[0-9]{5}$' AND applied.version::text > '00015')
       OR applied.name ~ '^mgm_000(1[6-9]|[2-9][0-9])'
  ) THEN
    RAISE EXCEPTION 'MGM pilot schema cannot run after later inherited migrations';
  END IF;

  IF to_regclass('public.billing_periods') IS NULL
    OR to_regclass('public.billing_line_items') IS NULL
    OR to_regclass('public.household_devices') IS NULL THEN
    RAISE EXCEPTION 'MGM pilot schema is missing required base billing tables';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'billing_periods'
      AND column_name = 'timezone'
  ) INTO v_timezone_column_exists;

  IF NOT v_timezone_column_exists
    AND EXISTS (SELECT 1 FROM public.billing_periods LIMIT 1) THEN
    RAISE EXCEPTION 'MGM pilot migration will not assign UTC to existing billing periods';
  END IF;
END;
$$;

-- The MGM pilot does not expose inherited mutation RPCs. Trigger functions
-- remain attached to their triggers; revoking direct EXECUTE does not disable
-- trigger execution.
REVOKE EXECUTE ON FUNCTION public.fn_change_user_role(UUID, public.user_role, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_finalize_user_invitation(
  UUID, TEXT, TEXT, TEXT, public.user_role, UUID
) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_device_openems_component_valid()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_set_updated_at()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_user_roles_before_delete_guard()
  FROM PUBLIC, anon, authenticated;

-- The billing review route reads these values from persisted line items.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'billing_line_item_reading_source'
  ) THEN
    CREATE TYPE public.billing_line_item_reading_source AS ENUM ('edge', 'manual');
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'billing_line_item_payment_status'
  ) THEN
    CREATE TYPE public.billing_line_item_payment_status AS ENUM (
      'unpaid', 'paid', 'failed', 'refunded', 'link_generated'
    );
  END IF;
END;
$$;

REVOKE USAGE ON TYPE public.billing_line_item_reading_source FROM PUBLIC, anon;
REVOKE USAGE ON TYPE public.billing_line_item_payment_status FROM PUBLIC, anon;
GRANT USAGE ON TYPE public.billing_line_item_reading_source TO authenticated, service_role;
GRANT USAGE ON TYPE public.billing_line_item_payment_status TO authenticated, service_role;

ALTER TABLE public.billing_periods
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

ALTER TABLE public.billing_line_items
  ADD COLUMN IF NOT EXISTS reading_source public.billing_line_item_reading_source NOT NULL DEFAULT 'edge',
  ADD COLUMN IF NOT EXISTS entered_by_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS entered_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS manual_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS payment_status public.billing_line_item_payment_status NOT NULL DEFAULT 'unpaid';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.billing_line_items'::regclass
      AND conname = 'billing_line_items_manual_reason_max_length'
  ) THEN
    ALTER TABLE public.billing_line_items
      ADD CONSTRAINT billing_line_items_manual_reason_max_length
      CHECK (manual_reason IS NULL OR length(manual_reason) <= 500);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_line_items_period_household
  ON public.billing_line_items (billing_period_id, household_id);

-- Preserve the effective period of each currently recorded device assignment.
-- The existing primary-meter uniqueness guard is left intact.
ALTER TABLE public.household_devices
  ADD COLUMN IF NOT EXISTS effective_from DATE,
  ADD COLUMN IF NOT EXISTS effective_to DATE;

UPDATE public.household_devices
SET effective_from = created_at::date
WHERE effective_from IS NULL;

ALTER TABLE public.household_devices
  ALTER COLUMN effective_from SET DEFAULT CURRENT_DATE,
  ALTER COLUMN effective_from SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.household_devices'::regclass
      AND conname = 'household_devices_effective_period_valid'
  ) THEN
    ALTER TABLE public.household_devices
      ADD CONSTRAINT household_devices_effective_period_valid
      CHECK (effective_to IS NULL OR effective_to > effective_from);
  END IF;
END;
$$;

COMMENT ON COLUMN public.household_devices.effective_from IS
  'Inclusive start date for this household-device assignment.';
COMMENT ON COLUMN public.household_devices.effective_to IS
  'Exclusive end date; NULL means the assignment is current.';

-- The ledger contains batch metadata only: never a source file, raw source ID,
-- household details, or pseudonymization key. applied_at supplies a per-period
-- baselineImportedAt value to a later review endpoint.
CREATE TABLE IF NOT EXISTS public.pilot_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_period_id UUID NOT NULL REFERENCES public.billing_periods(id),
  initiated_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  source_label TEXT NOT NULL CHECK (source_label IN ('synthetic-pilot', 'approved-pilot-import')),
  is_baseline BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'previewed'
    CHECK (status IN ('previewed', 'applied', 'aborted')),
  household_count INTEGER NOT NULL DEFAULT 0 CHECK (household_count BETWEEN 0 AND 500),
  reading_count INTEGER NOT NULL DEFAULT 0 CHECK (reading_count BETWEEN 0 AND 5000),
  inserted_reading_count INTEGER NOT NULL DEFAULT 0 CHECK (inserted_reading_count BETWEEN 0 AND 5000),
  unchanged_reading_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_reading_count BETWEEN 0 AND 5000),
  conflict_count INTEGER NOT NULL DEFAULT 0 CHECK (conflict_count BETWEEN 0 AND 5000),
  duplicate_source_row_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_source_row_count BETWEEN 0 AND 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  CONSTRAINT pilot_import_batches_applied_at_matches_status
    CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
  CONSTRAINT pilot_import_batches_applied_counts_match
    CHECK (
      status <> 'applied'
      OR inserted_reading_count + unchanged_reading_count
        + conflict_count + duplicate_source_row_count = reading_count
    ),
  CONSTRAINT pilot_import_batches_applied_without_conflicts
    CHECK (status <> 'applied' OR conflict_count = 0)
);

CREATE INDEX IF NOT EXISTS pilot_import_batches_period_created_at_idx
  ON public.pilot_import_batches (billing_period_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS pilot_import_batches_one_baseline_per_period_idx
  ON public.pilot_import_batches (billing_period_id)
  WHERE is_baseline AND status = 'applied';

ALTER TABLE public.pilot_import_batches ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'pilot_import_batches'
      AND policyname = 'Authorized users can view pilot import batches'
  ) THEN
    CREATE POLICY "Authorized users can view pilot import batches"
      ON public.pilot_import_batches
      FOR SELECT TO authenticated
      USING (
        user_can_access_microgrid((
          SELECT bp.microgrid_id
          FROM public.billing_periods bp
          WHERE bp.id = pilot_import_batches.billing_period_id
        ))
      );
  END IF;
END;
$$;

-- MGM's isolated review deployment is read-only through the authenticated
-- client. Establish that access explicitly on this exact base-table allowlist.
-- service_role is untouched on these tables for a separately controlled
-- server-side import path. No schema-wide or default privileges are changed.
REVOKE ALL ON TABLE
  public.billing_line_items,
  public.billing_periods,
  public.communities,
  public.devices,
  public.edges,
  public.household_devices,
  public.household_users,
  public.households,
  public.meter_readings,
  public.microgrids,
  public.organizations,
  public.rate_schedules,
  public.user_profiles,
  public.user_roles
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.billing_line_items,
  public.billing_periods,
  public.communities,
  public.devices,
  public.edges,
  public.household_devices,
  public.household_users,
  public.households,
  public.meter_readings,
  public.microgrids,
  public.organizations,
  public.rate_schedules,
  public.user_profiles,
  public.user_roles
TO authenticated;

-- These legacy views are outside the MGM review surface.
REVOKE ALL ON TABLE
  public.microgrid_recent_activity,
  public.microgrid_shared_devices
FROM PUBLIC, anon, authenticated;

-- Explicit, table-scoped access to import metadata. No access is granted to
-- anon or PUBLIC; authenticated users can read only through the RLS policy.
REVOKE ALL ON TABLE public.pilot_import_batches FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.pilot_import_batches TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.pilot_import_batches TO service_role;
