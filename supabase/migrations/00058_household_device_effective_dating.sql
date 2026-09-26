-- 00058_household_device_effective_dating.sql
-- Release 2 (issue #4): effective-dated household meter assignments.
--
-- household_devices gains effective_from DATE NOT NULL DEFAULT CURRENT_DATE
-- and effective_to DATE NULL, with a validity CHECK. Existing rows backfill
-- effective_from from created_at::date. (The curated pilot overlay carried
-- the same shape; the statements below are IF NOT EXISTS guarded so they
-- are no-ops there.)
--
-- The partial unique index household_one_primary_consumption_meter (00001)
-- forbade a household from ever holding two primary links over time, which
-- contradicts replacement history. It is replaced by a trigger that rejects
-- OVERLAPPING effective periods for the same household's primary role.
-- Same-day replacement is expressed by closing the old link (effective_to)
-- and opening the new one (effective_from) on the same date: half-open
-- intervals [effective_from, effective_to) never overlap at a boundary, and
-- NULL effective_to means "open-ended".
--
-- Overlap violations raise 23505 with an 'overlaps' message so application
-- layers map them to 409 Conflict, distinct from cross-household steals.
-- Consumers that counted on "at most one primary row ever" (billing review)
-- keep working: they already treat multiple rows as an explicit,
-- actionable assignment error rather than silent zero usage.

-- ── 1. Columns ──────────────────────────────────────────────────────────────

ALTER TABLE household_devices
  ADD COLUMN IF NOT EXISTS effective_from DATE,
  ADD COLUMN IF NOT EXISTS effective_to DATE;

-- Backfill before the NOT NULL below. created_at::date is the honest
-- lower bound: the link demonstrably existed then.
UPDATE household_devices
SET effective_from = created_at::date
WHERE effective_from IS NULL;

ALTER TABLE household_devices
  ALTER COLUMN effective_from SET DEFAULT CURRENT_DATE,
  ALTER COLUMN effective_from SET NOT NULL;

-- Validity: an end, when present, is strictly after the start. Same name as
-- the pilot overlay so the DROP + ADD below converges both histories.
ALTER TABLE household_devices
  DROP CONSTRAINT IF EXISTS household_devices_effective_period_valid;
ALTER TABLE household_devices
  ADD CONSTRAINT household_devices_effective_period_valid
  CHECK (effective_to IS NULL OR effective_to > effective_from);

-- ── 2. Overlap guard replaces the partial unique index ──────────────────────
--
-- Two changes, both required for replacement history:
--
--   (a) DROP the table-level UNIQUE (household_id, device_id, role) from
--       00001. It forbids reopening a previously used meter (A→B→A): the
--       closed A row plus the new A row violate it even though their
--       effective periods never overlap. The overlap machinery below is the
--       correct uniqueness for effective-dated history. Resolved by column
--       set rather than by (possibly renamed) constraint name.
--
--   (b) DROP the partial unique index household_one_primary_consumption_meter
--       (00001), which forbade a household from ever holding two primary
--       links over time.

DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT c.conname INTO v_conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
    AND t.relnamespace = 'public'::regnamespace
    AND t.relname = 'household_devices'
  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
  WHERE c.contype = 'u'
  GROUP BY c.conname
  HAVING array_agg(a.attname ORDER BY k.ord) = ARRAY['household_id', 'device_id', 'role']::name[];
  IF FOUND THEN
    EXECUTE format('ALTER TABLE household_devices DROP CONSTRAINT %I', v_conname);
  END IF;
END;
$$;

DROP INDEX IF EXISTS household_one_primary_consumption_meter;

CREATE OR REPLACE FUNCTION fn_household_device_no_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only the billable role is guarded; secondary/battery/solar links may
  -- repeat across overlapping periods.
  IF NEW.role <> 'primary_consumption_meter' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM household_devices
    WHERE household_id = NEW.household_id
      AND role = 'primary_consumption_meter'
      AND id IS DISTINCT FROM NEW.id
      AND daterange(effective_from, effective_to, '[)')
        && daterange(NEW.effective_from, NEW.effective_to, '[)')
  ) THEN
    RAISE EXCEPTION
      'primary meter assignment for household % overlaps an existing assignment ([%, %))',
      NEW.household_id, NEW.effective_from, NEW.effective_to
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_household_device_no_overlap ON household_devices;

CREATE TRIGGER trg_household_device_no_overlap
  BEFORE INSERT OR UPDATE ON household_devices
  FOR EACH ROW
  EXECUTE FUNCTION fn_household_device_no_overlap();

-- ── 3. Exclusion constraint: atomic overlap protection ──────────────────────
--
-- The trigger above gives a clear 23505 message in the common case, but
-- under READ COMMITTED two concurrent transactions can both see no
-- conflicting committed row and both insert, defeating it. The exclusion
-- constraint serializes on the index: exactly one concurrent double-open
-- wins, the other gets 23P01 (exclusion_violation), which application
-- layers map to 409 exactly like the trigger's 23505. Keep both: the
-- trigger explains, the constraint guarantees.
--
-- btree_gist supplies the UUID equality operator class; daterange gist is
-- built-in. Half-open '[)' bounds match the trigger semantics, and the
-- partial predicate scopes the index to the billable role.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

ALTER TABLE household_devices
  DROP CONSTRAINT IF EXISTS household_devices_primary_no_overlap;
ALTER TABLE household_devices
  ADD CONSTRAINT household_devices_primary_no_overlap
  EXCLUDE USING gist (
    household_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  )
  WHERE (role = 'primary_consumption_meter');

-- ── 4. Atomic close-and-open replacement RPC ────────────────────────────────
--
-- Closing the old link and inserting the new one as two round trips leaves
-- a failure window: if the insert fails after the close, the household has
-- no open meter. This RPC performs both steps in one transaction —
-- serializing concurrent swaps on the household's primary links — so a
-- failed replacement rolls back to the previous open link instead of a
-- meterless household.
--
-- Same-day links never covered a day, so they are deleted rather than
-- closed as a zero-length interval (which the period CHECK would reject).
-- SECURITY INVOKER: RLS on household_devices applies to the caller.

CREATE OR REPLACE FUNCTION fn_replace_household_device(
  p_household_id UUID,
  p_device_id UUID,
  p_effective_date DATE
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new_id UUID;
BEGIN
  -- Serialize concurrent swaps: lock the household's primary links. A swap
  -- on a currently meterless household locks nothing; the overlap
  -- trigger + exclusion constraint still reject a concurrent double-open.
  PERFORM 1
  FROM household_devices
  WHERE household_id = p_household_id
    AND role = 'primary_consumption_meter'
  FOR UPDATE;

  -- Same-day links are corrections, not history: remove rather than close.
  DELETE FROM household_devices
  WHERE household_id = p_household_id
    AND role = 'primary_consumption_meter'
    AND effective_to IS NULL
    AND effective_from = p_effective_date;

  -- Close remaining open links at the boundary.
  UPDATE household_devices
  SET effective_to = p_effective_date
  WHERE household_id = p_household_id
    AND role = 'primary_consumption_meter'
    AND effective_to IS NULL;

  INSERT INTO household_devices (
    household_id, device_id, role, effective_from, effective_to
  )
  VALUES (
    p_household_id, p_device_id, 'primary_consumption_meter',
    p_effective_date, NULL
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_replace_household_device(UUID, UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_replace_household_device(UUID, UUID, DATE) TO authenticated, service_role;
