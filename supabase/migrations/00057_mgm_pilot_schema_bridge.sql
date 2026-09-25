-- 00057_mgm_pilot_schema_bridge.sql
-- Release 1 (issue #3, review item 3): forward upgrade from the deployed
-- curated pilot schema to the Release-1 management surface.
--
-- Background: the deployed MGM pilot was built from the reviewed base
-- migrations (through 00015) plus the curated
-- supabase/pilot/20260924_mgm_review_import_essentials.sql overlay — NOT the
-- full inherited chain (00016–00055). It therefore lacks, relative to the
-- Release-1 create workflows:
--   * microgrids.timezone (00055)
--   * household address/PDF columns (00022, 00033)
--   * fn_create_household + current fn_create_household_with_meter
--     (00026, 00034, 00036)
--   * user_can_access_community + the microgrid INSERT policy fix (00031)
--   * table-level write grants (the pilot overlay leaves authenticated
--     SELECT-only on domain tables)
--
-- This migration replays exactly those pieces, idempotently, so it is a
-- no-op on databases that already applied the full chain and an upgrade on
-- pilot-curated databases. Every statement is ADD COLUMN IF NOT EXISTS /
-- CREATE OR REPLACE / DROP-IF-EXISTS + CREATE, with source-migration
-- pointers per section. Do not add unrelated schema here.
--
-- Rehearsal: applied to a scratch database built from the reviewed base
-- (00001, 00002, 00004, 00007–00015) plus the pilot overlay, then exercised
-- as an org_manager: INSERT community, INSERT microgrid with
-- timezone='Africa/Kampala', fn_create_household with p_device_id NULL,
-- and the metered wrapper path. See the PR description for the transcript.

-- ── 1. households columns (00022 address fields, 00033 PDF fields) ─────────
--
-- contact_email is deliberately NOT bridged: 00036 dropped it the same week
-- it shipped. Pilot databases never had it.

ALTER TABLE households
  ADD COLUMN IF NOT EXISTS address_city         TEXT NULL,
  ADD COLUMN IF NOT EXISTS address_region       TEXT NULL,
  ADD COLUMN IF NOT EXISTS address_country      TEXT NULL,
  ADD COLUMN IF NOT EXISTS address_postal_code  TEXT NULL,
  ADD COLUMN IF NOT EXISTS geography_notes      TEXT NULL,
  ADD COLUMN IF NOT EXISTS account_number TEXT NULL,
  ADD COLUMN IF NOT EXISTS customer_type TEXT NOT NULL DEFAULT 'residential',
  ADD COLUMN IF NOT EXISTS meter_serial TEXT NULL,
  ADD COLUMN IF NOT EXISTS meter_type TEXT NOT NULL DEFAULT 'Smart Submeter';

ALTER TABLE households DROP CONSTRAINT IF EXISTS households_account_number_shape;
ALTER TABLE households
  ADD CONSTRAINT households_account_number_shape
  CHECK (
    account_number IS NULL
    OR (length(trim(account_number)) > 0 AND length(account_number) <= 30)
  );

ALTER TABLE households DROP CONSTRAINT IF EXISTS households_customer_type_enum;
ALTER TABLE households
  ADD CONSTRAINT households_customer_type_enum
  CHECK (customer_type IN ('residential', 'commercial'));

ALTER TABLE households DROP CONSTRAINT IF EXISTS households_meter_serial_shape;
ALTER TABLE households
  ADD CONSTRAINT households_meter_serial_shape
  CHECK (
    meter_serial IS NULL
    OR (length(trim(meter_serial)) > 0 AND length(meter_serial) <= 50)
  );

ALTER TABLE households DROP CONSTRAINT IF EXISTS households_meter_type_shape;
ALTER TABLE households
  ADD CONSTRAINT households_meter_type_shape
  CHECK (length(meter_type) > 0 AND length(meter_type) <= 50);

-- primary_phone NOT NULL (00024) — conditional. 00024 hard-reset violating
-- rows on a pre-prod database; a pilot database may hold real rows, so never
-- delete here. Enforce only when no NULLs exist; otherwise warn and leave
-- the column nullable (the fn_create_household guard still enforces phone at
-- create time). Backfill NULL phones before re-running to converge.
DO $$
DECLARE
  v_null_phones INT;
BEGIN
  SELECT COUNT(*) INTO v_null_phones
  FROM households WHERE primary_phone IS NULL;
  IF v_null_phones > 0 THEN
    RAISE WARNING
      'mgm pilot bridge: % household(s) have NULL primary_phone; leaving the column nullable. Backfill, then re-run this migration to enforce NOT NULL.',
      v_null_phones;
  ELSE
    ALTER TABLE households ALTER COLUMN primary_phone SET NOT NULL;
  END IF;
END;
$$;

-- ── 2. microgrids.timezone + period stamp trigger (00055) ───────────────────

ALTER TABLE microgrids
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

CREATE OR REPLACE FUNCTION fn_billing_period_stamp_timezone()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Unconditional assignment: any client-supplied NEW.timezone is discarded.
  -- Mirrors 00055; covers present + future period-creation paths on
  -- pilot-upgraded databases.
  NEW.timezone := COALESCE(
    (SELECT timezone FROM microgrids WHERE id = NEW.microgrid_id),
    'UTC'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_period_stamp_timezone ON billing_periods;

CREATE TRIGGER trg_billing_period_stamp_timezone
  BEFORE INSERT ON billing_periods
  FOR EACH ROW
  EXECUTE FUNCTION fn_billing_period_stamp_timezone();

-- ── 3. user_can_access_community + microgrid INSERT policy fix (00031) ─────
--
-- Verbatim from 00031 (helper + DROP+CREATE with the byte-identical policy
-- name). On full-chain databases this re-applies the same definition.

CREATE OR REPLACE FUNCTION user_can_access_community(_community_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT user_can_access_org((
    SELECT org_id FROM communities WHERE id = _community_id
  ));
$$;

DROP POLICY IF EXISTS "Authorized users can access microgrids" ON microgrids;

CREATE POLICY "Authorized users can access microgrids"
  ON microgrids FOR ALL
  USING (user_can_access_community(community_id))
  WITH CHECK (user_can_access_community(community_id));

-- ── 4. Household creation RPCs at current 17-arg arity (00036) ─────────────
--
-- Verbatim bodies from 00036 (post-PDF5 shape: no p_contact_email). DROP the
-- older 8-arg and 13-arg signatures first per the 00023/00034/00036
-- overload-collision precedent, so PostgREST resolves the 17-arg overload
-- unambiguously. The pilot overlay revoked EXECUTE on the legacy 8-arg
-- signature; the new signatures are granted below with an explicit anon
-- REVOKE per current convention (the pilot base predates the 00016/00047
-- default-grant narrowing).

DROP FUNCTION IF EXISTS fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
);

DROP FUNCTION IF EXISTS fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
);

DROP FUNCTION IF EXISTS fn_create_household(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
);

CREATE OR REPLACE FUNCTION fn_create_household(
  p_microgrid_id        UUID,
  p_display_name        TEXT,
  p_device_id           UUID    DEFAULT NULL,
  p_primary_phone       TEXT    DEFAULT NULL,
  p_primary_email       TEXT    DEFAULT NULL,
  p_address_line1       TEXT    DEFAULT NULL,
  p_address_line2       TEXT    DEFAULT NULL,
  p_unit_label          TEXT    DEFAULT NULL,
  p_address_city        TEXT    DEFAULT NULL,
  p_address_region      TEXT    DEFAULT NULL,
  p_address_country     TEXT    DEFAULT NULL,
  p_address_postal_code TEXT    DEFAULT NULL,
  p_geography_notes     TEXT    DEFAULT NULL,
  p_account_number      TEXT    DEFAULT NULL,
  p_meter_serial        TEXT    DEFAULT NULL,
  p_meter_type          TEXT    DEFAULT NULL,
  p_customer_type       TEXT    DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  _household_id UUID;
BEGIN
  -- Guard 0 (#155): phone is required for Pesapal billing-address contact.
  IF p_primary_phone IS NULL OR trim(p_primary_phone) = '' THEN
    RAISE EXCEPTION 'household_phone_required';
  END IF;

  -- Guards 1 + 2 only apply when a device is being linked.
  IF p_device_id IS NOT NULL THEN
    -- Guard 1: device's edge must belong to the target microgrid.
    IF NOT EXISTS (
      SELECT 1
      FROM devices d
      JOIN edges e ON e.id = d.edge_id
      WHERE d.id = p_device_id
        AND e.microgrid_id = p_microgrid_id
    ) THEN
      RAISE EXCEPTION
        'device % does not belong to microgrid %',
        p_device_id, p_microgrid_id;
    END IF;

    -- Guard 2: device must be of type consumption_meter.
    IF (SELECT device_type FROM devices WHERE id = p_device_id) <> 'consumption_meter' THEN
      RAISE EXCEPTION
        'device % is not a consumption_meter',
        p_device_id;
    END IF;
  END IF;

  -- Atomic insert (+ optional device link). RLS on households /
  -- household_devices applies via SECURITY INVOKER.
  --
  -- COALESCE on meter_type / customer_type so a NULL caller-arg honors the
  -- column DEFAULT explicitly (Postgres can't fall through to DEFAULT when
  -- a NULL VALUE is supplied).
  INSERT INTO households (
    microgrid_id,
    display_name,
    primary_phone,
    primary_email,
    address_line1,
    address_line2,
    unit_label,
    address_city,
    address_region,
    address_country,
    address_postal_code,
    geography_notes,
    account_number,
    meter_serial,
    meter_type,
    customer_type
  ) VALUES (
    p_microgrid_id,
    p_display_name,
    p_primary_phone,
    p_primary_email,
    p_address_line1,
    p_address_line2,
    p_unit_label,
    p_address_city,
    p_address_region,
    p_address_country,
    p_address_postal_code,
    p_geography_notes,
    p_account_number,
    p_meter_serial,
    COALESCE(p_meter_type,    'Smart Submeter'),
    COALESCE(p_customer_type, 'residential')
  )
  RETURNING id INTO _household_id;

  IF p_device_id IS NOT NULL THEN
    INSERT INTO household_devices (household_id, device_id, role)
    VALUES (_household_id, p_device_id, 'primary_consumption_meter');
  END IF;

  RETURN _household_id;
END;
$$;

CREATE OR REPLACE FUNCTION fn_create_household_with_meter(
  p_microgrid_id        UUID,
  p_display_name        TEXT,
  p_device_id           UUID,
  p_primary_phone       TEXT    DEFAULT NULL,
  p_primary_email       TEXT    DEFAULT NULL,
  p_address_line1       TEXT    DEFAULT NULL,
  p_address_line2       TEXT    DEFAULT NULL,
  p_unit_label          TEXT    DEFAULT NULL,
  p_address_city        TEXT    DEFAULT NULL,
  p_address_region      TEXT    DEFAULT NULL,
  p_address_country     TEXT    DEFAULT NULL,
  p_address_postal_code TEXT    DEFAULT NULL,
  p_geography_notes     TEXT    DEFAULT NULL,
  p_account_number      TEXT    DEFAULT NULL,
  p_meter_serial        TEXT    DEFAULT NULL,
  p_meter_type          TEXT    DEFAULT NULL,
  p_customer_type       TEXT    DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN fn_create_household(
    p_microgrid_id        => p_microgrid_id,
    p_display_name        => p_display_name,
    p_device_id           => p_device_id,
    p_primary_phone       => p_primary_phone,
    p_primary_email       => p_primary_email,
    p_address_line1       => p_address_line1,
    p_address_line2       => p_address_line2,
    p_unit_label          => p_unit_label,
    p_address_city        => p_address_city,
    p_address_region      => p_address_region,
    p_address_country     => p_address_country,
    p_address_postal_code => p_address_postal_code,
    p_geography_notes     => p_geography_notes,
    p_account_number      => p_account_number,
    p_meter_serial        => p_meter_serial,
    p_meter_type          => p_meter_type,
    p_customer_type       => p_customer_type
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_create_household(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_create_household(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT
) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT
) TO authenticated, service_role;

-- ── 5. Table write grants for management workflows ──────────────────────────
--
-- The pilot overlay leaves authenticated SELECT-only on domain tables. RLS
-- policies (00002, plus §3 above) already scope writes to the caller's
-- organizations; restore the write grants so org managers can create and
-- edit communities, microgrids, households, and device links. On full-chain
-- databases these grants already exist — GRANT is idempotent.

GRANT INSERT, UPDATE, DELETE ON communities TO authenticated;
GRANT INSERT, UPDATE, DELETE ON microgrids TO authenticated;
GRANT INSERT, UPDATE, DELETE ON households TO authenticated;
GRANT INSERT, UPDATE, DELETE ON household_devices TO authenticated;
-- Edges/devices: metered households link to provisioned devices, and the
-- setup flows register edges/devices through these tables. RLS policies
-- (00002 base) already scope all four verbs to the caller's organizations.
GRANT INSERT, UPDATE, DELETE ON edges TO authenticated;
GRANT INSERT, UPDATE, DELETE ON devices TO authenticated;
-- meter_readings: operators record explicit opening registers (issue #4)
-- through the validated server endpoint. RLS (00002 base, via the device →
-- edge → microgrid chain) already scopes writes to the caller's
-- organizations; restore the write grants the pilot overlay removed.
GRANT INSERT, UPDATE, DELETE ON meter_readings TO authenticated;
