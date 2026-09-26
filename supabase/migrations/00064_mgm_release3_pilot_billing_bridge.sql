-- 00064_mgm_release3_pilot_billing_bridge.sql
-- Release 3 (issue #5, review P1): forward upgrade from the deployed curated
-- pilot schema to the Release-3 billing surface.
--
-- Background: the deployed MGM pilot was built from the reviewed base
-- migrations (through 00015) plus the curated
-- supabase/pilot/20260924_mgm_review_import_essentials.sql overlay plus the
-- Release-1/2 bridges (00057, release-2 connection bridge, management
-- projection bridge) — NOT the full inherited chain (00016–00055). Relative
-- to the Release-3 operator workflow (tariff → period → generate → close →
-- PDF/CSV export → manual payment) it therefore lacks:
--   * billing_line_items payment columns (00021: paid_at, paid_by_user_id,
--     payment_notes; 00028: pesapal_order_id, payment_failed_at,
--     payment_refunded_at; 00033: invoice_number, pesapal_redirect_url;
--     00038: short_slug) and the converged audit-fields CHECK (00040)
--   * payment_events + fn_apply_payment_event at the 00050 state (deny-by-
--     default gate, server-derived actor, 7-arg signature)
--   * billing_audit_log + fn_record_line_item_with_audit at the 00041 state
--     (rounded numerics, amount-change cache invalidation, actor_kind/ref)
--   * invoice_counters + fn_next_invoice_number + invoice-logos bucket (00033)
--   * communities invoice/payment columns (00033, 00020) and
--     rate_schedules.service_charge_description (00033)
--   * table write grants on billing tables (the pilot overlay leaves
--     authenticated SELECT-only; full chain grants ALL via 00016, including
--     its FOR ROLE postgres default privileges for later-created tables —
--     the pilot never ran 00016, so payment_events/billing_audit_log/
--     invoice_counters need explicit grants here)
--
-- This migration replays exactly those pieces, idempotently, so it is a
-- no-op on databases that already applied the full chain and an upgrade on
-- pilot-curated databases. Every statement is ADD COLUMN IF NOT EXISTS /
-- CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE / DROP-IF-EXISTS + CREATE,
-- with source-migration pointers per section. The two function bodies are
-- verbatim copies of their converged versions (fn_record_line_item_with_audit
-- from 00041 §4, fn_apply_payment_event from 00050). Do not add unrelated
-- schema here.
--
-- Deliberately NOT bridged:
--   * fn_get_community_payment_secret (00020 §3) — online payment gateways
--     are separate future work (issue #5); the payment_provider COLUMNS are
--     bridged because the released PDF/detail surfaces read them.
--   * households.contact_email — dropped by 00036 the week it shipped; 00057
--     deliberately did not bridge it either.
--
-- Rehearsal: supabase/scripts/rehearse-release3.sql simulates the
-- pilot-missing objects on a scratch transaction (DROP … CASCADE), applies
-- this file, runs the complete operator workflow (tariff → period →
-- generate → regenerate → manual paid → invoice number → close → audit),
-- and rolls back. See the PR description for the transcript.

-- ── 1. Enums ────────────────────────────────────────────────────────────────
-- Pilot overlay already creates billing_line_item_payment_status (all five
-- values) and billing_line_item_reading_source; the guards keep this a
-- no-op there and create them on any database missing them.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_line_item_payment_status') THEN
    CREATE TYPE billing_line_item_payment_status AS ENUM (
      'unpaid', 'paid', 'failed', 'refunded', 'link_generated'
    );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_line_item_reading_source') THEN
    CREATE TYPE billing_line_item_reading_source AS ENUM ('edge', 'manual');
  END IF;
END;
$$;

-- 00029 §3 verbatim.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_audit_event_type') THEN
    CREATE TYPE billing_audit_event_type AS ENUM (
      'period_created',
      'period_closed',
      'line_item_generated',
      'line_item_regenerated'
    );
  END IF;
END;
$$;

-- 00020 §1 verbatim.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_provider_type') THEN
    CREATE TYPE payment_provider_type AS ENUM ('pesapal');
  END IF;
END;
$$;

REVOKE USAGE ON TYPE billing_line_item_payment_status FROM PUBLIC, anon;
GRANT USAGE ON TYPE billing_line_item_payment_status TO authenticated, service_role;
REVOKE USAGE ON TYPE billing_line_item_reading_source FROM PUBLIC, anon;
GRANT USAGE ON TYPE billing_line_item_reading_source TO authenticated, service_role;
REVOKE USAGE ON TYPE billing_audit_event_type FROM PUBLIC, anon;
GRANT USAGE ON TYPE billing_audit_event_type TO authenticated, service_role;
REVOKE USAGE ON TYPE payment_provider_type FROM PUBLIC, anon;
GRANT USAGE ON TYPE payment_provider_type TO authenticated, service_role;

-- ── 2. billing_line_items columns (00021 + 00028 §1 + 00033 §4 + 00038) ─────

ALTER TABLE billing_line_items
  ADD COLUMN IF NOT EXISTS payment_status billing_line_item_payment_status NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS paid_by_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_notes TEXT NULL;

ALTER TABLE billing_line_items
  ADD COLUMN IF NOT EXISTS pesapal_order_id   TEXT NULL,
  ADD COLUMN IF NOT EXISTS payment_failed_at  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS payment_refunded_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_billing_line_items_pesapal_order_id'
  ) THEN
    CREATE UNIQUE INDEX idx_billing_line_items_pesapal_order_id
      ON billing_line_items(pesapal_order_id)
      WHERE pesapal_order_id IS NOT NULL;
  END IF;
END;
$$;

ALTER TABLE billing_line_items
  ADD COLUMN IF NOT EXISTS invoice_number TEXT NULL,
  ADD COLUMN IF NOT EXISTS pesapal_redirect_url TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_billing_line_items_invoice_number'
  ) THEN
    CREATE UNIQUE INDEX idx_billing_line_items_invoice_number
      ON billing_line_items(invoice_number)
      WHERE invoice_number IS NOT NULL;
  END IF;
END;
$$;

ALTER TABLE billing_line_items DROP CONSTRAINT IF EXISTS billing_line_items_invoice_number_format;
ALTER TABLE billing_line_items
  ADD CONSTRAINT billing_line_items_invoice_number_format
  CHECK (
    invoice_number IS NULL
    OR invoice_number ~ '^[A-Z0-9]{2,8}-\d{4}-\d{5}$'
  );

ALTER TABLE billing_line_items DROP CONSTRAINT IF EXISTS billing_line_items_pesapal_redirect_url_max_length;
ALTER TABLE billing_line_items
  ADD CONSTRAINT billing_line_items_pesapal_redirect_url_max_length
  CHECK (
    pesapal_redirect_url IS NULL
    OR length(pesapal_redirect_url) <= 2048
  );

ALTER TABLE billing_line_items
  ADD COLUMN IF NOT EXISTS short_slug TEXT NULL;

ALTER TABLE billing_line_items
  DROP CONSTRAINT IF EXISTS billing_line_items_short_slug_format;
ALTER TABLE billing_line_items
  ADD CONSTRAINT billing_line_items_short_slug_format
  CHECK (
    short_slug IS NULL
    OR short_slug ~ '^[A-Za-z0-9]{6,8}$'
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'billing_line_items_short_slug_unique'
  ) THEN
    CREATE UNIQUE INDEX billing_line_items_short_slug_unique
      ON billing_line_items(short_slug)
      WHERE short_slug IS NOT NULL;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_billing_line_items_payment_status
  ON billing_line_items(payment_status);

-- Converged audit-fields CHECK (00040 verbatim — temporal-audit invariant:
-- paid/refunded rows must have paid_at; the "who" lives in payment_events).
ALTER TABLE billing_line_items DROP CONSTRAINT IF EXISTS billing_line_items_payment_audit_fields_required;
ALTER TABLE billing_line_items
  ADD CONSTRAINT billing_line_items_payment_audit_fields_required
  CHECK (
    (
      payment_status = ANY (ARRAY[
        'unpaid'::billing_line_item_payment_status,
        'failed'::billing_line_item_payment_status,
        'link_generated'::billing_line_item_payment_status
      ])
      AND paid_at IS NULL
      AND paid_by_user_id IS NULL
    )
    OR
    (
      payment_status = ANY (ARRAY[
        'paid'::billing_line_item_payment_status,
        'refunded'::billing_line_item_payment_status
      ])
      AND paid_at IS NOT NULL
    )
  );

COMMENT ON CONSTRAINT billing_line_items_payment_audit_fields_required ON billing_line_items IS
  'Temporal-audit invariant: paid/refunded rows must have paid_at. The previous "paid rows must have paid_by_user_id" arm was dropped in #243 because Pesapal IPN has no human actor; payment_events (source + actor_user_id) is the audit source-of-truth.';

-- ── 3. communities + rate_schedules columns (00033 §1/§3, 00020 §2) ─────────

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS invoice_prefix TEXT NULL,
  ADD COLUMN IF NOT EXISTS invoice_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE communities DROP CONSTRAINT IF EXISTS communities_invoice_prefix_format;
ALTER TABLE communities
  ADD CONSTRAINT communities_invoice_prefix_format
  CHECK (invoice_prefix IS NULL OR invoice_prefix ~ '^[A-Z0-9]{2,8}$');

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS payment_provider payment_provider_type,
  ADD COLUMN IF NOT EXISTS payment_provider_config JSONB,
  ADD COLUMN IF NOT EXISTS payment_provider_secret_encrypted BYTEA,
  ADD COLUMN IF NOT EXISTS payment_last_configured_at TIMESTAMPTZ;

ALTER TABLE communities DROP CONSTRAINT IF EXISTS communities_payment_fields_required;
ALTER TABLE communities
  ADD CONSTRAINT communities_payment_fields_required
  CHECK (
    payment_provider IS NULL
    OR (
      payment_provider_config IS NOT NULL
      AND payment_provider_secret_encrypted IS NOT NULL
      AND payment_last_configured_at IS NOT NULL
    )
  );

ALTER TABLE rate_schedules
  ADD COLUMN IF NOT EXISTS service_charge_description TEXT NULL;

ALTER TABLE rate_schedules DROP CONSTRAINT IF EXISTS rate_schedules_service_charge_description_max_length;
ALTER TABLE rate_schedules
  ADD CONSTRAINT rate_schedules_service_charge_description_max_length
  CHECK (
    service_charge_description IS NULL
    OR length(service_charge_description) <= 200
  );

-- ── 4. payment_events (00028 §3–§4 + 00041 §2–§3) ────────────────────────────

CREATE TABLE IF NOT EXISTS payment_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_item_id    UUID NOT NULL REFERENCES billing_line_items(id) ON DELETE CASCADE,
  from_status     billing_line_item_payment_status NULL,
  to_status       billing_line_item_payment_status NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('ipn', 'manual', 'generate_link')),
  actor_user_id   UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  raw_payload     JSONB NULL,
  at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_line_item_at
  ON payment_events(line_item_id, at DESC);

ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized users can access payment_events" ON payment_events;
CREATE POLICY "Authorized users can access payment_events"
  ON payment_events FOR ALL
  USING (
    user_can_access_microgrid((
      SELECT bp.microgrid_id
      FROM billing_line_items bli
      JOIN billing_periods bp ON bp.id = bli.billing_period_id
      WHERE bli.id = payment_events.line_item_id
    ))
  )
  WITH CHECK (
    user_can_access_microgrid((
      SELECT bp.microgrid_id
      FROM billing_line_items bli
      JOIN billing_periods bp ON bp.id = bli.billing_period_id
      WHERE bli.id = payment_events.line_item_id
    ))
  );

-- 00041 §2 verbatim: actor_kind / actor_ref + legacy-IPN backfill.
ALTER TABLE payment_events
  ALTER COLUMN actor_user_id DROP NOT NULL;

ALTER TABLE payment_events
  ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'human'
    CHECK (actor_kind IN ('human', 'customerapp', 'system'));

ALTER TABLE payment_events
  ADD COLUMN IF NOT EXISTS actor_ref TEXT NULL;

UPDATE payment_events
SET    actor_kind = 'system',
       actor_ref  = COALESCE(actor_ref, 'pesapal_ipn_legacy')
WHERE  actor_user_id IS NULL
  AND  actor_kind    = 'human';

ALTER TABLE payment_events
  DROP CONSTRAINT IF EXISTS payment_events_actor_consistency;
ALTER TABLE payment_events
  ADD CONSTRAINT payment_events_actor_consistency CHECK (
    (actor_kind = 'human'  AND actor_user_id IS NOT NULL AND actor_ref IS NULL)
    OR
    (actor_kind <> 'human' AND actor_user_id IS NULL     AND actor_ref IS NOT NULL)
  );

COMMENT ON CONSTRAINT payment_events_actor_consistency ON payment_events IS
  'Actor shape invariant (#250) — mirror of billing_audit_log_actor_consistency.';

-- Table grants converge with the full chain, where 00016's ALTER DEFAULT
-- PRIVILEGES (FOR ROLE postgres) grants ALL on later-created tables. The
-- pilot never ran 00016, so grant explicitly here (idempotent). Row access
-- stays gated by the RLS policy above — same as full chain.
GRANT ALL ON payment_events TO authenticated;

-- ── 5. billing_audit_log (00029 §4 + 00041 §1/§3) ────────────────────────────

CREATE TABLE IF NOT EXISTS billing_audit_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_period_id    UUID NOT NULL REFERENCES billing_periods(id) ON DELETE CASCADE,
  billing_line_item_id UUID NULL REFERENCES billing_line_items(id) ON DELETE SET NULL,
  event_type           billing_audit_event_type NOT NULL,
  actor_user_id        UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  details              JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_billing_audit_log_period_created_at
  ON billing_audit_log (billing_period_id, created_at DESC);

ALTER TABLE billing_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized users can read billing_audit_log" ON billing_audit_log;
CREATE POLICY "Authorized users can read billing_audit_log"
  ON billing_audit_log FOR SELECT
  USING (
    user_can_access_microgrid((
      SELECT bp.microgrid_id
      FROM billing_periods bp
      WHERE bp.id = billing_audit_log.billing_period_id
    ))
  );

DROP POLICY IF EXISTS "Authorized users can write billing_audit_log" ON billing_audit_log;
CREATE POLICY "Authorized users can write billing_audit_log"
  ON billing_audit_log FOR INSERT
  WITH CHECK (
    user_can_access_microgrid((
      SELECT bp.microgrid_id
      FROM billing_periods bp
      WHERE bp.id = billing_audit_log.billing_period_id
    ))
  );

GRANT SELECT, INSERT ON billing_audit_log TO authenticated;

-- 00041 §1 verbatim.
ALTER TABLE billing_audit_log
  ALTER COLUMN actor_user_id DROP NOT NULL;

ALTER TABLE billing_audit_log
  ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'human'
    CHECK (actor_kind IN ('human', 'customerapp', 'system'));

ALTER TABLE billing_audit_log
  ADD COLUMN IF NOT EXISTS actor_ref TEXT NULL;

UPDATE billing_audit_log
SET    actor_kind = 'system',
       actor_ref  = COALESCE(actor_ref, 'legacy_system_actor')
WHERE  actor_user_id IS NULL
  AND  actor_kind    = 'human';

ALTER TABLE billing_audit_log
  DROP CONSTRAINT IF EXISTS billing_audit_log_actor_consistency;
ALTER TABLE billing_audit_log
  ADD CONSTRAINT billing_audit_log_actor_consistency CHECK (
    (actor_kind = 'human'  AND actor_user_id IS NOT NULL AND actor_ref IS NULL)
    OR
    (actor_kind <> 'human' AND actor_user_id IS NULL     AND actor_ref IS NOT NULL)
  );

COMMENT ON CONSTRAINT billing_audit_log_actor_consistency ON billing_audit_log IS
  'Actor shape invariant (#250): human rows carry actor_user_id and not actor_ref; non-human (customerapp/system) rows carry actor_ref and not actor_user_id.';

-- ── 6. invoice_counters + fn_next_invoice_number (00033 §5 verbatim) ─────────

CREATE TABLE IF NOT EXISTS invoice_counters (
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  year         INT NOT NULL CHECK (year >= 2020 AND year <= 2200),
  counter      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (community_id, year)
);

ALTER TABLE invoice_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized users can read invoice_counters" ON invoice_counters;
CREATE POLICY "Authorized users can read invoice_counters"
  ON invoice_counters FOR SELECT
  USING (user_can_access_org((SELECT org_id FROM communities WHERE id = community_id)));

DROP POLICY IF EXISTS "Authorized users can write invoice_counters" ON invoice_counters;
CREATE POLICY "Authorized users can write invoice_counters"
  ON invoice_counters FOR INSERT
  WITH CHECK (user_can_access_org((SELECT org_id FROM communities WHERE id = community_id)));

DROP POLICY IF EXISTS "Authorized users can increment invoice_counters" ON invoice_counters;
CREATE POLICY "Authorized users can increment invoice_counters"
  ON invoice_counters FOR UPDATE
  USING (user_can_access_org((SELECT org_id FROM communities WHERE id = community_id)))
  WITH CHECK (user_can_access_org((SELECT org_id FROM communities WHERE id = community_id)));

GRANT SELECT, INSERT, UPDATE ON invoice_counters TO authenticated;

CREATE OR REPLACE FUNCTION fn_next_invoice_number(p_community_id UUID, p_year INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_counter INT;
BEGIN
  IF p_year < 2020 OR p_year > 2200 THEN
    RAISE EXCEPTION 'Invalid year %', p_year USING ERRCODE = '22023';
  END IF;
  INSERT INTO invoice_counters (community_id, year, counter)
  VALUES (p_community_id, p_year, 1)
  ON CONFLICT (community_id, year)
    DO UPDATE SET counter = invoice_counters.counter + 1
  RETURNING counter INTO v_counter;
  RETURN v_counter;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_next_invoice_number(UUID, INT) TO authenticated;

-- ── 7. invoice-logos bucket + storage RLS (00033 §6 verbatim) ────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'invoice-logos',
  'invoice-logos',
  false,
  1048576,
  ARRAY['image/png', 'image/jpeg', 'image/svg+xml']::text[]
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "invoice_logos_select" ON storage.objects;
CREATE POLICY "invoice_logos_select" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  );

DROP POLICY IF EXISTS "invoice_logos_insert" ON storage.objects;
CREATE POLICY "invoice_logos_insert" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  );

DROP POLICY IF EXISTS "invoice_logos_update" ON storage.objects;
CREATE POLICY "invoice_logos_update" ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  )
  WITH CHECK (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  );

DROP POLICY IF EXISTS "invoice_logos_delete" ON storage.objects;
CREATE POLICY "invoice_logos_delete" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  );

-- ── 8. Table write grants for the billing workflow ───────────────────────────
--
-- The pilot overlay leaves authenticated SELECT-only on domain tables (00057
-- restored write verbs for management tables only). RLS policies (00002
-- base) already scope writes to the caller's organizations; restore the
-- write grants so operators can run the billing workflow. On full-chain
-- databases these grants already exist (00016 blanket grant) — GRANT is
-- idempotent. payment_events keeps full-chain semantics (no direct grants;
-- writes go through the DEFINER fn_apply_payment_event).

GRANT INSERT, UPDATE, DELETE ON rate_schedules TO authenticated;
GRANT INSERT, UPDATE, DELETE ON billing_periods TO authenticated;
GRANT INSERT, UPDATE, DELETE ON billing_line_items TO authenticated;

-- ── 9. fn_record_line_item_with_audit at the converged 00041 state ───────────
--
-- Verbatim body from 00041 §4 (rounded numerics + amount-change cache
-- invalidation + actor_kind/ref). DROP the 13-arg overload first per the
-- PGRST203 precedent (same as 00041); on pilot there is no 13-arg overload
-- and the DROP is a no-op, on full chain it is already gone.

DROP FUNCTION IF EXISTS fn_record_line_item_with_audit(
  UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC,
  billing_line_item_reading_source, UUID, TEXT, UUID, JSONB
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
  v_event_type              billing_audit_event_type;
  v_entered_at              TIMESTAMPTZ;
  v_audit_details           JSONB := COALESCE(_audit_details, '{}'::jsonb);
  v_line_item_id            UUID;
  v_tier_breakdown_rounded  JSONB;
BEGIN
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

GRANT EXECUTE ON FUNCTION fn_record_line_item_with_audit(
  UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC,
  billing_line_item_reading_source, UUID, TEXT, UUID, JSONB, TEXT, TEXT
) TO authenticated, service_role;

-- ── 10. fn_apply_payment_event at the converged 00050 state ──────────────────
--
-- Verbatim body from 00050 (deny-by-default gate + server-derived actor).
-- DROP the 5-arg overload first (same PGRST203 precedent as 00041); on
-- pilot the DROP is a no-op, on full chain it is already gone.

DROP FUNCTION IF EXISTS fn_apply_payment_event(
  UUID, billing_line_item_payment_status, TEXT, UUID, JSONB
);

CREATE OR REPLACE FUNCTION fn_apply_payment_event(
  _line_item_id   UUID,
  _to_status      billing_line_item_payment_status,
  _source         TEXT,
  _actor_user_id  UUID,
  _raw_payload    JSONB,
  _actor_kind     TEXT DEFAULT 'human',
  _actor_ref      TEXT DEFAULT NULL
)
RETURNS billing_line_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row              billing_line_items%ROWTYPE;
  v_from             billing_line_item_payment_status;
  v_now              TIMESTAMPTZ := NOW();
  v_allowed          BOOLEAN := FALSE;
  v_recent_event_id  UUID;
  v_microgrid_id     UUID;
  v_is_service_role  BOOLEAN := (auth.role() = 'service_role');
  v_actor_user_id    UUID;
  v_actor_kind       TEXT;
  v_actor_ref        TEXT;
BEGIN
  -- ── Authorization gate (deny-by-default, one named exception) ──────────
  SELECT bp.microgrid_id INTO v_microgrid_id
  FROM billing_line_items bli
  JOIN billing_periods bp ON bp.id = bli.billing_period_id
  WHERE bli.id = _line_item_id;

  IF NOT (
    v_is_service_role
    OR (v_microgrid_id IS NOT NULL AND user_can_access_microgrid(v_microgrid_id))
  ) THEN
    RAISE EXCEPTION 'permission denied for line item %', _line_item_id
      USING ERRCODE = '42501';
  END IF;

  -- ── Audit actor — derived server-side, same discriminator as the gate ──
  IF v_is_service_role THEN
    v_actor_user_id := _actor_user_id;
    v_actor_kind    := COALESCE(_actor_kind, 'human');
    v_actor_ref     := _actor_ref;
  ELSE
    v_actor_user_id := auth.uid();
    v_actor_kind    := 'human';
    v_actor_ref     := NULL;
  END IF;

  -- Source whitelist.
  IF _source NOT IN ('ipn', 'manual', 'generate_link') THEN
    RAISE EXCEPTION 'invalid_source: %', _source USING ERRCODE = 'P0001';
  END IF;

  -- Lock the row.
  SELECT * INTO v_row
  FROM billing_line_items
  WHERE id = _line_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'line_item_not_found: %', _line_item_id USING ERRCODE = 'P0002';
  END IF;

  v_from := v_row.payment_status;

  -- Same-state handling.
  IF v_from = _to_status THEN
    IF _source = 'generate_link' THEN
      INSERT INTO payment_events (
        line_item_id, from_status, to_status, source,
        actor_user_id, actor_kind, actor_ref, raw_payload, at
      ) VALUES (
        _line_item_id, v_from, _to_status, _source,
        v_actor_user_id, v_actor_kind, v_actor_ref, _raw_payload, v_now
      );

      IF _raw_payload IS NOT NULL AND _raw_payload ? 'pesapal_order_id' THEN
        UPDATE billing_line_items
          SET pesapal_order_id = _raw_payload->>'pesapal_order_id'
          WHERE id = _line_item_id
          RETURNING * INTO v_row;
      END IF;

      RETURN v_row;
    END IF;

    IF _source = 'ipn' THEN
      SELECT id INTO v_recent_event_id
      FROM payment_events
      WHERE line_item_id = _line_item_id
        AND source = 'ipn'
        AND to_status = _to_status
        AND at >= v_now - INTERVAL '60 seconds'
      ORDER BY at DESC
      LIMIT 1;

      IF v_recent_event_id IS NULL THEN
        INSERT INTO payment_events (
          line_item_id, from_status, to_status, source,
          actor_user_id, actor_kind, actor_ref, raw_payload, at
        ) VALUES (
          _line_item_id, v_from, _to_status, _source,
          v_actor_user_id, v_actor_kind, v_actor_ref, _raw_payload, v_now
        );
      END IF;
    END IF;

    RETURN v_row;
  END IF;

  -- Validate the transition against the per-source matrix (unchanged).
  IF _source = 'generate_link' THEN
    v_allowed := (v_from = 'unpaid' AND _to_status = 'link_generated');
  ELSIF _source = 'ipn' THEN
    v_allowed :=
      ((v_from IN ('link_generated', 'unpaid')) AND _to_status IN ('paid', 'failed'))
      OR (v_from = 'paid' AND _to_status = 'refunded');
  ELSIF _source = 'manual' THEN
    v_allowed :=
      (v_from = 'unpaid'         AND _to_status = 'paid')
      OR (v_from = 'paid'         AND _to_status = 'unpaid')
      OR (v_from = 'failed'       AND _to_status = 'paid')
      OR (v_from = 'link_generated' AND _to_status IN ('unpaid', 'paid', 'failed'))
      OR (v_from = 'paid'         AND _to_status = 'refunded');
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'invalid_transition: % -> % via %', v_from, _to_status, _source
      USING ERRCODE = 'P0001';
  END IF;

  -- Compare-and-set on the row.
  UPDATE billing_line_items
  SET
    payment_status      = _to_status,
    paid_at             = CASE
                            WHEN _to_status IN ('paid', 'refunded') THEN COALESCE(paid_at, v_now)
                            WHEN _to_status IN ('unpaid', 'failed', 'link_generated') THEN NULL
                            ELSE paid_at
                          END,
    paid_by_user_id     = CASE
                            WHEN _to_status IN ('paid', 'refunded')
                              THEN COALESCE(paid_by_user_id, v_actor_user_id)
                            WHEN _to_status IN ('unpaid', 'failed', 'link_generated') THEN NULL
                            ELSE paid_by_user_id
                          END,
    payment_failed_at   = CASE
                            WHEN _to_status = 'failed' THEN v_now
                            WHEN _to_status IN ('paid', 'refunded') THEN payment_failed_at
                            ELSE NULL
                          END,
    payment_refunded_at = CASE
                            WHEN _to_status = 'refunded' THEN v_now
                            ELSE payment_refunded_at
                          END,
    pesapal_order_id    = CASE
                            WHEN _raw_payload IS NOT NULL AND _raw_payload ? 'pesapal_order_id'
                              THEN _raw_payload->>'pesapal_order_id'
                            ELSE pesapal_order_id
                          END,
    payment_notes       = CASE
                            WHEN _raw_payload IS NOT NULL AND _raw_payload ? 'payment_notes'
                              THEN NULLIF(BTRIM(COALESCE(_raw_payload->>'payment_notes', '')), '')
                            ELSE payment_notes
                          END
  WHERE id = _line_item_id
    AND payment_status = v_from
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_conflict: row state changed mid-flight'
      USING ERRCODE = 'P0001';
  END IF;

  -- Append the audit row.
  INSERT INTO payment_events (
    line_item_id, from_status, to_status, source,
    actor_user_id, actor_kind, actor_ref, raw_payload, at
  ) VALUES (
    _line_item_id, v_from, _to_status, _source,
    v_actor_user_id, v_actor_kind, v_actor_ref, _raw_payload, v_now
  );

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION fn_apply_payment_event(
  UUID, billing_line_item_payment_status, TEXT, UUID, JSONB, TEXT, TEXT
) IS
  'Authoritative payment state machine. Deny-by-default body-side gate: service_role, or user_can_access_microgrid() on the line item''s billing period. The audit actor triple (actor_user_id / actor_kind / actor_ref) is derived server-side for session callers — the caller-supplied values are ignored — and passed through for service_role, which has no session to derive from.';

GRANT EXECUTE ON FUNCTION fn_apply_payment_event(
  UUID, billing_line_item_payment_status, TEXT, UUID, JSONB, TEXT, TEXT
) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION fn_apply_payment_event(
  UUID, billing_line_item_payment_status, TEXT, UUID, JSONB, TEXT, TEXT
) FROM PUBLIC, anon;

-- ── 11. New audit event values (00041 §6 verbatim — MUST stay last) ──────────
--
-- Postgres rejects same-transaction references to freshly added enum values;
-- these sit at the end and are consumed by application code in subsequent
-- connections only.

ALTER TYPE billing_audit_event_type ADD VALUE IF NOT EXISTS 'billing_period_created';
ALTER TYPE billing_audit_event_type ADD VALUE IF NOT EXISTS 'token_generated';
ALTER TYPE billing_audit_event_type ADD VALUE IF NOT EXISTS 'token_revoked';
ALTER TYPE billing_audit_event_type ADD VALUE IF NOT EXISTS 'token_regenerated';
