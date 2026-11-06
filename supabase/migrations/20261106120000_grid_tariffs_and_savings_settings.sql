-- Grid tariffs and savings settings for a microgrid's Operations view.
--
-- Two tables, both owned by the billing plugin (src/lib/plugins/bundled.ts):
--
--   * `grid_tariffs` — what the microgrid pays the grid utility per kWh, by
--     local hour of day (time-of-use bands). Effective-dated: the tariff for
--     a day is the row with the latest `effective_from` on or before that
--     day, so a tariff change is a new row and past days keep the rate they
--     were charged at. `bands` is a JSON array of
--     {from_hour, to_hour, rate}; the database checks only its shape (an
--     array of 1 to 24 bands). That the bands are integers, sorted,
--     contiguous and cover hours 0 to 24 exactly is checked by the
--     application (validateGridTariffBands in src/lib/billing/site-savings.ts)
--     before every write; if a write path that skips it is added, move that
--     check here.
--
--   * `microgrid_savings_settings` — one optional row per microgrid: the
--     date from which solar savings are counted, the date from which battery
--     arbitrage is counted (NULL means that saving is not counted), and the
--     battery round-trip efficiency used to price stored energy.
--
-- Neither table is read by billing: these figures value the energy the site
-- did not buy from the grid. They are not what households are charged, which
-- stays in `rate_schedules`.
--
-- Deleting a microgrid deletes both (ON DELETE CASCADE), like
-- `rate_schedules`; the delete preview counts them
-- (src/lib/entity-descendants.ts).
--
-- RLS: one FOR ALL policy per table through user_can_access_microgrid, so
-- read and write follow org access as every other microgrid table does.
-- Grants are explicit, not left to default privileges (which differ between
-- the full chain and the pilot database and would also hand authenticated
-- TRUNCATE, which RLS does not filter): authenticated gets exactly SELECT,
-- INSERT, UPDATE and DELETE, service_role everything, anon nothing.
--
-- This migration depends only on objects from 00001/00002 (`microgrids`,
-- `user_can_access_microgrid`) so it also applies to a pilot database built
-- from the supabase/pilot overlay. Idempotent: safe to run twice.

-- ── 1. grid_tariffs ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS grid_tariffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  microgrid_id UUID NOT NULL REFERENCES microgrids(id) ON DELETE CASCADE,
  effective_from DATE NOT NULL,
  bands JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grid_tariffs_microgrid_effective_from_key UNIQUE (microgrid_id, effective_from),
  CONSTRAINT grid_tariffs_bands_shape CHECK (
    jsonb_typeof(bands) = 'array'
    AND jsonb_array_length(bands) BETWEEN 1 AND 24
  )
);

-- The UNIQUE constraint's index (microgrid_id, effective_from) serves both
-- the per-microgrid lookup and "latest effective_from <= day".

ALTER TABLE grid_tariffs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS grid_tariffs_all ON grid_tariffs;
CREATE POLICY grid_tariffs_all ON grid_tariffs FOR ALL
  USING (user_can_access_microgrid(microgrid_id))
  WITH CHECK (user_can_access_microgrid(microgrid_id));

REVOKE ALL ON grid_tariffs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON grid_tariffs TO authenticated;
GRANT ALL ON grid_tariffs TO service_role;

-- ── 2. microgrid_savings_settings ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS microgrid_savings_settings (
  microgrid_id UUID PRIMARY KEY REFERENCES microgrids(id) ON DELETE CASCADE,
  solar_savings_from DATE,
  arbitrage_from DATE,
  round_trip_efficiency NUMERIC(4, 3) NOT NULL DEFAULT 0.900,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT microgrid_savings_settings_efficiency_range CHECK (
    round_trip_efficiency > 0 AND round_trip_efficiency <= 1
  )
);

ALTER TABLE microgrid_savings_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS microgrid_savings_settings_all ON microgrid_savings_settings;
CREATE POLICY microgrid_savings_settings_all ON microgrid_savings_settings FOR ALL
  USING (user_can_access_microgrid(microgrid_id))
  WITH CHECK (user_can_access_microgrid(microgrid_id));

REVOKE ALL ON microgrid_savings_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON microgrid_savings_settings TO authenticated;
GRANT ALL ON microgrid_savings_settings TO service_role;
