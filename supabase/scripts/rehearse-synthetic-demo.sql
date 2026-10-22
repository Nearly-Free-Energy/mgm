-- supabase/scripts/rehearse-synthetic-demo.sql
-- CI rehearsal for issue #44: run the operator loader against the local
-- database with a throwaway organization and assert what it created.
--
-- Run from the repository root (the loader path is relative):
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/scripts/rehearse-synthetic-demo.sql
-- Never run against a real environment: it creates and deletes an organization.

\set ON_ERROR_STOP on

INSERT INTO organizations (name) VALUES ('Synthetic Demo Rehearsal Org') RETURNING id AS org_id \gset
\set confirm load-synthetic-demo
\i supabase/scripts/load-synthetic-demo.sql

-- The loader's own setting is transaction-local; keep the org for the checks.
SELECT set_config('mgm.demo_org', :'org_id', false) \gset

DO $$
DECLARE
  v_org UUID := current_setting('mgm.demo_org')::uuid;
  v_n INT;
BEGIN
  SELECT count(*) INTO v_n FROM microgrids m JOIN communities c ON c.id = m.community_id
    WHERE c.org_id = v_org AND m.name = 'Synthetic Demo Microgrid';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 microgrid, got %', v_n; END IF;

  SELECT count(*) INTO v_n FROM edges e
    JOIN microgrids m ON m.id = e.microgrid_id JOIN communities c ON c.id = m.community_id
    WHERE c.org_id = v_org AND e.openems_edge_id = 'SYNTHETIC-EDGE-001';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 synthetic edge, got %', v_n; END IF;

  SELECT count(*) INTO v_n FROM devices d JOIN edges e ON e.id = d.edge_id
    JOIN microgrids m ON m.id = e.microgrid_id JOIN communities c ON c.id = m.community_id
    WHERE c.org_id = v_org AND d.openems_component_id LIKE 'SYNTHETIC-METER-%'
      AND d.device_type = 'consumption_meter';
  IF v_n <> 8 THEN RAISE EXCEPTION 'expected 8 synthetic meters, got %', v_n; END IF;

  SELECT count(*) INTO v_n FROM household_devices hd JOIN households h ON h.id = hd.household_id
    JOIN microgrids m ON m.id = h.microgrid_id JOIN communities c ON c.id = m.community_id
    WHERE c.org_id = v_org AND hd.role = 'primary_consumption_meter'
      AND hd.effective_to IS NULL AND hd.effective_from <= DATE '2026-09-01'
      AND h.display_name LIKE 'Synthetic Household %';
  IF v_n <> 8 THEN RAISE EXCEPTION 'expected 8 assigned households, got %', v_n; END IF;

  IF mgm_plugin_enabled_for_org(v_org, 'synthetic-metering') THEN
    RAISE EXCEPTION 'synthetic-metering must be off by default';
  END IF;

  DELETE FROM organizations WHERE id = v_org;
  RAISE NOTICE 'OK: synthetic demonstration loader rehearsal passed';
END
$$;
