-- 00060_meter_reading_dedupe.sql
-- Release 2 (issue #4): one reading per meter per instant.
--
-- The opening-register endpoint guards duplicates with a pre-insert lookup,
-- but two overlapping requests can both pass the lookup and both insert:
-- meter_readings has no uniqueness on (device_id, read_at). Billing review
-- deliberately rejects duplicated boundary readings, so a retry race could
-- make a household unbillable. This unique index makes the second insert
-- fail atomically with 23505, which the endpoint maps to 409 duplicate.
--
-- Upgrade safety: if a database already holds duplicates (e.g. pilot
-- imports), failing the upgrade would strand it. Check first: with
-- duplicates present, warn and skip index creation (the application-level
-- guard still applies); otherwise create the index. De-duplicate, then
-- re-run this migration to converge.

DO $$
DECLARE
  v_dupes INT;
BEGIN
  SELECT COUNT(*) INTO v_dupes
  FROM (
    SELECT device_id, read_at
    FROM meter_readings
    GROUP BY device_id, read_at
    HAVING COUNT(*) > 1
  ) AS d;

  IF v_dupes > 0 THEN
    RAISE WARNING
      'meter_reading_dedupe: % (device_id, read_at) duplicate group(s) present; skipping unique index creation. De-duplicate, then re-run this migration.',
      v_dupes;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS meter_readings_device_read_at_unique
      ON meter_readings (device_id, read_at);
  END IF;
END;
$$;
