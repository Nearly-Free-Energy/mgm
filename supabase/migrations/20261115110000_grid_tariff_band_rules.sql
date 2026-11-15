-- Check a grid tariff's bands in the database, not only in the application.
--
-- 20261111200000 created `grid_tariffs` with a CHECK on the shape of `bands`
-- (a JSON array of 1 to 24 entries). This trigger adds the band rules the
-- application applies, on every insert and on every update that changes
-- `bands`, whoever writes: the rules describe valid data, not who may write
-- it, so no role is exempt.
--
-- The rules are the request body's for POST /api/microgrids/[id]/grid-tariffs
-- (AddGridTariffBody in src/lib/billing/schemas.ts, which adds strict keys to
-- validateGridTariffBands in src/lib/billing/site-savings.ts):
--
--   * `bands` is a list of 1 to 24 bands, in any order;
--   * each band is an object with exactly the keys from_hour, to_hour and
--     rate;
--   * the hours are whole numbers with 0 <= from_hour < to_hour <= 24 (an
--     hour beyond 2^53 is not whole to AddGridTariffBody, whose z.int()
--     takes only safe integers, so it gets that message here too);
--   * the rate is a number of 0 or more;
--   * sorted by from_hour, the bands cover hour 0 to hour 24 with no gap or
--     overlap.
--
-- Each refusal raises SQLSTATE 23514 (check_violation) with the message the
-- application gives for the same single fault, checked in the same order
-- (src/lib/supabase/__tests__/grid_tariff_bands.test.ts compares them). If those
-- rules or messages change, change this function in a new migration.
--
-- Numbers are judged as written. A JSON number the application would only
-- accept after rounding it to a double (an hour of 1.00000000000000000001,
-- a rate of -1e-400) is refused here, and a rate too large for a double,
-- which the application reads as Infinity and refuses, is refused too. So
-- the database never accepts bands the application refuses.
--
-- Rows already stored are not re-checked: an update that leaves `bands` as
-- it was passes, and the application already counts a stored tariff with
-- invalid bands as no tariff (valueSiteDays).
--
-- SECURITY INVOKER: the function reads only NEW and OLD. Trigger functions
-- are not callable through PostgREST, and EXECUTE is not checked when a
-- trigger fires, so EXECUTE is revoked from everyone but service_role.
--
-- Idempotent: safe to run twice.

CREATE OR REPLACE FUNCTION fn_grid_tariffs_check_bands()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  shape CONSTANT TEXT := 'Each band needs a start hour, an end hour and a rate.';
  whole CONSTANT TEXT := 'Band hours must be whole hours.';
  hours CONSTANT TEXT := 'Each band must start before it ends, between hour 0 and hour 24.';
  rate_message CONSTANT TEXT := 'Each band''s rate must be a number of 0 or more.';
  -- Number.MAX_VALUE. A larger rate is Infinity to the application.
  max_double CONSTANT NUMERIC := 1.7976931348623157e308;
  -- Number.MAX_SAFE_INTEGER, the largest hour z.int() calls whole.
  max_safe CONSTANT NUMERIC := 9007199254740991;
  band JSONB;
  from_num NUMERIC;
  to_num NUMERIC;
  rate_num NUMERIC;
  froms INT[] := '{}';
  tos INT[] := '{}';
  expected INT := 0;
  next_band RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.bands IS NOT DISTINCT FROM OLD.bands THEN
    RETURN NEW;
  END IF;
  -- NOT NULL reports a missing value.
  IF NEW.bands IS NULL THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(NEW.bands) <> 'array' THEN
    RAISE EXCEPTION 'Bands must be a list.' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(NEW.bands) NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'A tariff needs between 1 and 24 bands.' USING ERRCODE = '23514';
  END IF;

  -- Each band in the order given, as the application checks them.
  FOR band IN
    SELECT value FROM jsonb_array_elements(NEW.bands) WITH ORDINALITY ORDER BY ordinality
  LOOP
    IF jsonb_typeof(band) <> 'object'
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(band) AS k
         WHERE k NOT IN ('from_hour', 'to_hour', 'rate')
       ) THEN
      RAISE EXCEPTION '%', shape USING ERRCODE = '23514';
    END IF;

    IF jsonb_typeof(band -> 'from_hour') IS DISTINCT FROM 'number'
       OR jsonb_typeof(band -> 'to_hour') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION '%', whole USING ERRCODE = '23514';
    END IF;
    from_num := (band -> 'from_hour')::NUMERIC;
    to_num := (band -> 'to_hour')::NUMERIC;
    IF from_num <> trunc(from_num) OR to_num <> trunc(to_num)
       OR abs(from_num) > max_safe OR abs(to_num) > max_safe THEN
      RAISE EXCEPTION '%', whole USING ERRCODE = '23514';
    END IF;
    IF from_num < 0 OR to_num > 24 OR from_num >= to_num THEN
      RAISE EXCEPTION '%', hours USING ERRCODE = '23514';
    END IF;

    IF jsonb_typeof(band -> 'rate') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION '%', rate_message USING ERRCODE = '23514';
    END IF;
    rate_num := (band -> 'rate')::NUMERIC;
    IF rate_num < 0 OR rate_num > max_double THEN
      RAISE EXCEPTION '%', rate_message USING ERRCODE = '23514';
    END IF;

    froms := froms || from_num::INT;
    tos := tos || to_num::INT;
  END LOOP;

  -- Sorted by start hour (ties keep their order, as the application's
  -- stable sort does), the bands must run 0 to 24 with no gap or overlap.
  FOR next_band IN
    SELECT f, t FROM unnest(froms, tos) WITH ORDINALITY AS b(f, t, i) ORDER BY f, i
  LOOP
    IF next_band.f <> expected THEN
      IF next_band.f < expected THEN
        RAISE EXCEPTION 'Bands overlap at hour %.', next_band.f USING ERRCODE = '23514';
      END IF;
      RAISE EXCEPTION 'No band covers hour %.', expected USING ERRCODE = '23514';
    END IF;
    expected := next_band.t;
  END LOOP;
  IF expected <> 24 THEN
    RAISE EXCEPTION 'No band covers hour %.', expected USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_grid_tariffs_check_bands() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_grid_tariffs_check_bands() TO service_role;

DROP TRIGGER IF EXISTS trg_grid_tariffs_check_bands ON grid_tariffs;
CREATE TRIGGER trg_grid_tariffs_check_bands
  BEFORE INSERT OR UPDATE ON grid_tariffs
  FOR EACH ROW EXECUTE FUNCTION fn_grid_tariffs_check_bands();
