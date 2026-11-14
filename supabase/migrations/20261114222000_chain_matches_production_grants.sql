-- Bring the migration chain's table and function privileges to the narrower
-- set NFE's production database already has, and add the pilot import ledger
-- to the chain.
--
-- Production was built from the base migrations, the pilot overlay
-- (supabase/pilot/) and selected later migrations. Its grants are narrower
-- than the chain's. A later migration converges production on the chain,
-- so that `supabase db push` can manage it; for that, the chain has to end
-- where production is, not the other way round.
--
-- How production gets it: the operator applies this file with
-- `supabase db query --remote=<ref> -f <file>` (mgm-operations,
-- runbooks/apply-migrations.md), then records it with `supabase migration
-- repair`. Rehearsed on a schema-only copy of production on 2026-11-14: the
-- only changes there are item 6's (below). Every object this file names
-- without a guard exists on production (read 2026-11-14):
-- fn_edge_ids_all_nonempty(text[]), fn_device_openems_component_valid(),
-- fn_set_updated_at(), fn_user_roles_before_delete_guard(),
-- user_can_access_microgrid(uuid), household_users, user_profiles,
-- user_roles, billing_periods, microgrid_recent_activity,
-- microgrid_shared_devices, pilot_import_batches and auth.users.
--
-- MAINTAIN (items 2 and 6) exists from PostgreSQL 17. Production runs 17.6
-- (`server_version`, read 2026-11-14) and supabase/config.toml pins 17 for
-- local and CI databases. On an earlier major version this file fails rather
-- than half-applying. If production's major version ever changes, revisit.
--
-- 1. anon holds no table or view privilege. Signed-out routes read through the
--    service role (src/app/p/[slug], /api/payments/ipn), never anon, so
--    nothing in the app uses these grants. If a signed-out route starts
--    reading a table with the session client, revisit.
-- 2. authenticated holds no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any
--    table. Row-level security does not apply to TRUNCATE.
-- 3. The narrow grants of 20261103090000 and the pilot overlay, applied to
--    production by hand: household_users is read-only, user_profiles is
--    updatable only in the three columns that grant names, user_roles keeps
--    SELECT and DELETE only (role changes go through fn_change_user_role),
--    the legacy view microgrid_recent_activity has no grants, and
--    microgrid_shared_devices keeps SELECT only.
-- 4. org_api_tokens gets the grants 00043 meant: authenticated may SELECT,
--    INSERT and UPDATE (its policies have no DELETE), service_role keeps all.
-- 5. Three trigger and helper functions lose EXECUTE for anon and
--    authenticated, as production revoked on 2026-09-26. A trigger fires
--    without its caller holding EXECUTE on the trigger function.
-- 6. Default privileges: tables created later by postgres in public no longer
--    grant anon anything, or authenticated TRUNCATE, REFERENCES, TRIGGER or
--    MAINTAIN. Without this, every new table reopens items 1 and 2.
--    This affects only tables created after it. On production, the ten
--    tables created after the base (billing_audit_log,
--    community_payment_overrides, invoice_counters, mgm_plugin_audit_log,
--    mgm_plugins, payment_attempts, payment_events,
--    payment_merchant_accounts, payment_notifications, payment_receipts)
--    lose anon's privileges through item 1 and authenticated's TRUNCATE,
--    REFERENCES, TRIGGER and MAINTAIN through item 2; the base tables
--    already have neither. The pull request lists every privilege removed.
-- 7. pilot_import_batches, the pilot import ledger the billing review reads
--    (src/app/api/billing-review/preview/route.ts), joins the chain with the
--    definition and grants production has.
-- 8. fn_edge_ids_all_nonempty gets back the search_path pin 00048 gave it;
--    20260926132414 re-issued it without one.
--
-- Organizations INSERT/UPDATE and meter_readings INSERT/UPDATE/DELETE for
-- authenticated stay as the chain has them; production gains them when it
-- converges.

-- 1. anon: no table privileges at all.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

-- 2. authenticated: no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN.
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ALL TABLES IN SCHEMA public FROM authenticated;

-- 3. Narrow grants on the tables and views production narrowed.
REVOKE INSERT, UPDATE, DELETE ON public.household_users FROM authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.user_profiles FROM authenticated;
GRANT UPDATE (first_name, last_name, phone) ON public.user_profiles TO authenticated;

REVOKE INSERT, UPDATE ON public.user_roles FROM authenticated;

REVOKE ALL ON public.microgrid_recent_activity FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.microgrid_shared_devices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.microgrid_shared_devices TO authenticated;

-- 4. org_api_tokens: the grants 00043 meant. On production the table does
-- not exist yet; the converging migration creates it with these grants.
DO $$
BEGIN
  IF to_regclass('public.org_api_tokens') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.org_api_tokens FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.org_api_tokens TO authenticated';
    EXECUTE 'GRANT ALL ON public.org_api_tokens TO service_role';
  END IF;
END;
$$;

-- 5. Functions that only triggers call.
REVOKE EXECUTE ON FUNCTION public.fn_device_openems_component_valid() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_user_roles_before_delete_guard() FROM PUBLIC, anon, authenticated;

-- 6. Tables created later inherit the narrow grants.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES FROM authenticated;

-- 7. The pilot import ledger. It holds batch metadata only: never a source
-- file, raw source ID, household details or pseudonymization key. applied_at
-- gives the billing review a per-period baselineImportedAt.
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

REVOKE ALL ON public.pilot_import_batches FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.pilot_import_batches TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.pilot_import_batches TO service_role;

-- 8. Restore 00048's pin.
ALTER FUNCTION public.fn_edge_ids_all_nonempty(TEXT[]) SET search_path = public, pg_temp;
