-- supabase/scripts/load-synthetic-demo.sql
-- Synthetic demonstration dataset (issue #44, ADR-005). OPERATOR ACTION ONLY.
--
-- Creates, inside ONE existing organization you name:
--   * a community and microgrid labelled "Synthetic Demo ...",
--   * one demonstration edge, SYNTHETIC-EDGE-001,
--   * 8 consumption meters SYNTHETIC-METER-001..008,
--   * 8 households "Synthetic Household 001..008", each linked to its meter
--     as primary_consumption_meter.
-- No readings are stored: the synthetic metering plugin generates the month
-- of readings (2026-09-01 .. 2026-09-30) deterministically when billing asks.
-- Meters 006-008 deliberately carry missing data (see docs/setup.md).
--
-- Not a migration and not operator provisioning: nothing runs it
-- automatically, and it never touches tariffs, billing periods or bills.
-- Every name and identifier is invented; no real customer, meter or site.
--
-- Run (explicit confirmation required; use a demonstration environment):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v org_id=<organization uuid> -v confirm=load-synthetic-demo \
--     -f supabase/scripts/load-synthetic-demo.sql
--
-- Re-running is refused while the demonstration microgrid exists. To remove
-- it, delete the microgrid "Synthetic Demo Microgrid"; cascades clear its
-- edge, meters and households. Then enable the "Synthetic metering
-- (demonstration)" plugin in Settings -> Plugins; it is off by default.

\set ON_ERROR_STOP on

-- Missing variables are an error with a non-zero exit (ON_ERROR_STOP), not a
-- silent quit.
\if :{?org_id}
\else
  DO $$ BEGIN RAISE EXCEPTION 'pass -v org_id=<organization uuid>'; END $$;
\endif
\if :{?confirm}
\else
  DO $$ BEGIN RAISE EXCEPTION 'pass -v confirm=load-synthetic-demo to load demonstration data'; END $$;
\endif

BEGIN;

SELECT set_config('mgm.demo_org', :'org_id', true) AS _org,
       set_config('mgm.demo_confirm', :'confirm', true) AS _confirm \gset

DO $$
DECLARE
  v_org UUID := current_setting('mgm.demo_org')::uuid;
  v_community UUID;
  v_microgrid UUID;
  v_edge UUID;
  v_device UUID;
  v_household UUID;
  v_n TEXT;
BEGIN
  IF current_setting('mgm.demo_confirm') <> 'load-synthetic-demo' THEN
    RAISE EXCEPTION 'Refusing to load: confirm must be load-synthetic-demo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN
    RAISE EXCEPTION 'Organization % does not exist', v_org;
  END IF;
  IF EXISTS (
    SELECT 1 FROM microgrids m JOIN communities c ON c.id = m.community_id
    WHERE c.org_id = v_org AND m.name = 'Synthetic Demo Microgrid'
  ) THEN
    RAISE EXCEPTION 'Synthetic demonstration data is already loaded for this organization';
  END IF;

  INSERT INTO communities (org_id, name)
  VALUES (v_org, 'Synthetic Demo Community') RETURNING id INTO v_community;

  INSERT INTO microgrids (community_id, name)
  VALUES (v_community, 'Synthetic Demo Microgrid') RETURNING id INTO v_microgrid;

  -- The SYNTHETIC-EDGE- id is the routing marker the synthetic metering
  -- plugin looks for. Columns match the current schema (database.gen.ts).
  INSERT INTO edges (microgrid_id, name, openems_edge_id, role)
  VALUES (v_microgrid, 'Synthetic demo edge', 'SYNTHETIC-EDGE-001', 'metering')
  RETURNING id INTO v_edge;

  FOR i IN 1..8 LOOP
    v_n := lpad(i::text, 3, '0');

    INSERT INTO devices (edge_id, name, device_type, openems_component_id)
    VALUES (v_edge, 'Synthetic meter ' || v_n, 'consumption_meter', 'SYNTHETIC-METER-' || v_n)
    RETURNING id INTO v_device;

    -- primary_phone is NOT NULL; the value is an obviously fake placeholder.
    INSERT INTO households (microgrid_id, display_name, unit_label, primary_phone)
    VALUES (v_microgrid, 'Synthetic Household ' || v_n, 'SYN-' || v_n, '000-SYNTHETIC-' || v_n)
    RETURNING id INTO v_household;

    -- Effective-dated from before the demonstration month, so the
    -- assignment covers it (the column otherwise defaults to today).
    INSERT INTO household_devices (household_id, device_id, role, effective_from)
    VALUES (v_household, v_device, 'primary_consumption_meter', DATE '2026-01-01');
  END LOOP;

  RAISE NOTICE 'OK: synthetic demonstration microgrid % loaded for organization %', v_microgrid, v_org;
END
$$;

COMMIT;
