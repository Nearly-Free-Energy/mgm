-- Scratch databases and CI only. Checks what seed-investigation-cases.sql
-- wrote, in the same transaction, which the caller rolls back. The Test job
-- runs both, from the repository root:
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -c BEGIN \
--     -f supabase/scripts/seed-investigation-cases.sql \
--     -f supabase/scripts/rehearse-investigation-seed.sql -c ROLLBACK
--
-- Every check is scoped to the seed's two organizations, since a developer's
-- database also holds 00003_seed.sql.template's sample microgrid. The lists
-- below restate the seed: the legacy devices are CASE_VARIANTS.legacy
-- (src/lib/metering/__tests__/investigation-cases.pins.ts) and the plugin
-- states are the seed's mgm_plugins rows. The seed's static test
-- (src/lib/metering/fixture/__tests__/seed-investigation-cases.test.ts)
-- fails when either list stops matching, so a plugin added to the catalog
-- is added here too.
\set ON_ERROR_STOP on

DO $$
DECLARE
  org_a CONSTANT uuid := '00000000-0000-4000-8000-0000000c00a0';
  org_b CONSTANT uuid := '00000000-0000-4000-8000-0000000c00b0';
  n integer;
  missing text;
  expected record;
BEGIN
  -- Twenty microgrids, 01 to 14 in hexadecimal, 0a in B and the rest in A.
  SELECT count(*) INTO n
  FROM microgrids m JOIN communities c ON c.id = m.community_id
  WHERE c.org_id IN (org_a, org_b);
  IF n <> 20 THEN
    RAISE EXCEPTION 'Expected 20 case microgrids under organizations A and B, found %', n;
  END IF;
  SELECT count(*) INTO n
  FROM microgrids m JOIN communities c ON c.id = m.community_id
  WHERE c.org_id = org_b;
  IF n <> 1 THEN
    RAISE EXCEPTION 'Expected 1 case microgrid under organization B, found %', n;
  END IF;

  -- Exactly the three legacy devices have no component id.
  SELECT string_agg(d.id::text, ', ' ORDER BY d.id) INTO missing
  FROM devices d
  JOIN edges e ON e.id = d.edge_id
  JOIN microgrids m ON m.id = e.microgrid_id
  JOIN communities c ON c.id = m.community_id
  WHERE c.org_id IN (org_a, org_b) AND d.openems_component_id IS NULL;
  IF missing IS DISTINCT FROM
       '00000000-0000-4000-8000-0000000c0513, 00000000-0000-4000-8000-0000000c0704, 00000000-0000-4000-8000-0000000c1313'
  THEN
    RAISE EXCEPTION 'Expected devices 05/13, 07/04 and 13/13 to have no component id, found: %', coalesce(missing, 'none');
  END IF;

  -- The component-id trigger is enabled again after the legacy insert.
  IF (
    SELECT tgenabled FROM pg_trigger
    WHERE tgrelid = 'public.devices'::regclass
      AND tgname = 'trg_device_openems_component_valid'
  ) IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'trg_device_openems_component_valid is not enabled after the seed';
  END IF;

  -- The plugin gate answers as the seed's rows say.
  FOR expected IN
    SELECT * FROM (VALUES
      (org_a, 'organization-directory', true),
      (org_a, 'community-management', true),
      (org_a, 'metering', true),
      (org_a, 'billing', true),
      (org_a, 'payments', true),
      (org_a, 'pesapal', true),
      (org_a, 'tenant-app', false),
      (org_a, 'operations', true),
      (org_b, 'organization-directory', true),
      (org_b, 'community-management', true),
      (org_b, 'metering', false),
      (org_b, 'billing', false),
      (org_b, 'payments', false),
      (org_b, 'pesapal', false),
      (org_b, 'tenant-app', false),
      (org_b, 'operations', true)
    ) AS t(org_id, plugin_name, enabled)
  LOOP
    IF mgm_plugin_enabled_for_org(expected.org_id, expected.plugin_name) IS DISTINCT FROM expected.enabled THEN
      RAISE EXCEPTION 'mgm_plugin_enabled_for_org(%, %) is not %',
        expected.org_id, expected.plugin_name, expected.enabled;
    END IF;
  END LOOP;

  -- Three primary-meter links in force on 2026-09-01 on every microgrid,
  -- each from a unit to a meter of its own microgrid.
  SELECT string_agg(m.id::text || ' (' || coalesce(l.links, 0) || ')', ', ') INTO missing
  FROM microgrids m
  JOIN communities c ON c.id = m.community_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS links
    FROM tenant_devices td
    JOIN tenants t ON t.id = td.tenant_id
    JOIN devices d ON d.id = td.device_id
    JOIN edges e ON e.id = d.edge_id
    WHERE t.microgrid_id = m.id
      AND e.microgrid_id = m.id
      AND td.role = 'primary_consumption_meter'
      AND td.effective_from <= DATE '2026-09-01'
      AND (td.effective_to IS NULL OR td.effective_to > DATE '2026-09-01')
  ) l ON true
  WHERE c.org_id IN (org_a, org_b) AND coalesce(l.links, 0) <> 3;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Expected 3 meter links in force on 2026-09-01 on every case microgrid; differs on: %', missing;
  END IF;

  RAISE NOTICE 'OK: the investigation seed wrote 20 microgrids, 3 legacy devices, the plugin states and the meter links';
END $$;
