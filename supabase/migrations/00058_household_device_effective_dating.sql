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
