-- Disposable local installations only: writes #133's investigation fixture
-- set (docs/investigation-cases.md §1) as rows. Run it through
-- scripts/seed-investigation-cases.sh, which finds this repository's own
-- local database, runs this file in one transaction and checks the result.
-- docs/setup.md § "Investigation cases" says how.
--
-- The file has no BEGIN or COMMIT: its caller decides the transaction. The
-- wrapper runs it with --single-transaction; the Test job runs it inside a
-- transaction it rolls back, followed by rehearse-investigation-seed.sql.
--
-- Four guards come first, in this order, and refuse before anything is
-- written:
--   1. ON_ERROR_STOP, so a raw `psql -f` stops at the first error too.
--   2. The `disposable` variable, which only the wrapper sets.
--   3. The development opt-in in Vault (`mgm_allow_dev_credential_key` = '1'),
--      the marker migration 00018 reads before it generates a throwaway
--      credential key. The CLI writes it when MGM_ALLOW_DEV_CREDENTIAL_KEY=1
--      is set, as ./setup.sh and the Test job do, and a production database
--      must not carry it (docs/runbooks/dek.md). It is checked inside the
--      database, so a tunnelled port to a production database does not get
--      past it. It proves a development database, not whose: another
--      account's local database carries it too. The wrapper checks which
--      container the database is in. If 00018 or dek.md stop using that
--      marker, revisit.
--   4. No organization but the sample one 00003_seed.sql.template writes, and
--      neither of the two this file writes: a database that holds any other
--      is not a fresh local one. Reset it instead (`supabase db reset`); that
--      is also why this file need not be idempotent.
--
-- Every identifier is pinned: the fixture generator keys a day on the
-- microgrid's UUID and a house meter on the device's UUID, so a changed id is
-- a changed case. The organizations, communities, microgrids, edge ids and
-- devices restate src/lib/metering/fixture/case-ids.ts and CASE_VARIANTS
-- (src/lib/metering/__tests__/investigation-cases.pins.ts), and the plugin
-- rows restate the plugin catalog (src/lib/plugins/bundled.ts);
-- src/lib/metering/fixture/__tests__/seed-investigation-cases.test.ts fails
-- when either side changes alone. The ids this file adds (not read by the
-- generator) follow the same scheme:
--   edges     00000000-0000-4000-8000-0000000e<nn><01 synthetic | 02 real>
--   tenants   00000000-0000-4000-8000-0000000d<nn>0<unit>
--   manager   00000000-0000-4000-8000-0000000f0001
--
-- Synthetic data only: no credentials, no real phone numbers or addresses.

\set ON_ERROR_STOP on

-- ── Guard 2: the disposable flag ────────────────────────────────────────────
-- `-v disposable=0` is refused as well as a missing flag. \quit ends this
-- file before anything is written, without relying on an error.
\if :{?disposable}
  \if :disposable
  \else
    \echo Refusing: run scripts/seed-investigation-cases.sh --disposable
    \quit
  \endif
\else
  \echo Refusing: run scripts/seed-investigation-cases.sh --disposable
  \quit
\endif

-- ── Guard 3: the development opt-in in Vault ────────────────────────────────
-- The predicate is migration 00018's own (section 2, case c).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name = 'mgm_allow_dev_credential_key' AND decrypted_secret = '1'
  ) THEN
    RAISE EXCEPTION 'Refusing: this database has no development opt-in in Vault (mgm_allow_dev_credential_key). Seed only a local database reset with MGM_ALLOW_DEV_CREDENTIAL_KEY=1.'
      USING ERRCODE = '55000';
  END IF;
END $$;

-- ── Guard 4: a fresh local database ─────────────────────────────────────────
-- 'a0000000-0000-0000-0000-000000000001' is the sample organization of
-- 00003_seed.sql.template; if the template's id changes, change it here (the
-- static test compares them).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id NOT IN (
      'a0000000-0000-0000-0000-000000000001',
      '00000000-0000-4000-8000-0000000c00a0',
      '00000000-0000-4000-8000-0000000c00b0'
    )
  ) THEN
    RAISE EXCEPTION 'Refusing: this database holds organizations besides the local sample one. Seed only a freshly reset local database (MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase db reset).'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id IN (
      '00000000-0000-4000-8000-0000000c00a0',
      '00000000-0000-4000-8000-0000000c00b0'
    )
  ) THEN
    RAISE EXCEPTION 'Refusing: the investigation cases are already seeded here. To seed them again, reset the database (MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase db reset) and run the script again.'
      USING ERRCODE = '55000';
  END IF;
END $$;

-- ── 1. Organizations ────────────────────────────────────────────────────────
INSERT INTO public.organizations (id, name) VALUES
  ('00000000-0000-4000-8000-0000000c00a0', 'Investigation cases A'),
  ('00000000-0000-4000-8000-0000000c00b0', 'Investigation cases B');

-- ── 2. Plugin states ────────────────────────────────────────────────────────
-- A row for every bundled plugin in both organizations, written directly:
-- no actor, so no audit row. SQL does not check plugin dependencies, so the
-- rows themselves keep B consistent: metering is off there (case C14), and so
-- is every plugin that depends on it, as Settings → Plugins would insist
-- (validatePluginToggle). The tenant app is off in A. Community management is
-- on in both before any community, microgrid or tenant is written, since a
-- trigger refuses those writes while it is off (00056).
INSERT INTO public.mgm_plugins (org_id, plugin_name, version, enabled) VALUES
  ('00000000-0000-4000-8000-0000000c00a0', 'organization-directory', '0.1.0', true),
  ('00000000-0000-4000-8000-0000000c00a0', 'community-management', '0.1.0', true),
  ('00000000-0000-4000-8000-0000000c00a0', 'metering', '0.1.0', true),
  ('00000000-0000-4000-8000-0000000c00a0', 'billing', '0.1.0', true),
  ('00000000-0000-4000-8000-0000000c00a0', 'payments', '0.1.0', true),
  ('00000000-0000-4000-8000-0000000c00a0', 'pesapal', '0.1.0', true),
  ('00000000-0000-4000-8000-0000000c00a0', 'tenant-app', '0.1.0', false),
  ('00000000-0000-4000-8000-0000000c00b0', 'organization-directory', '0.1.0', true),
  ('00000000-0000-4000-8000-0000000c00b0', 'community-management', '0.1.0', true),
  ('00000000-0000-4000-8000-0000000c00b0', 'metering', '0.1.0', false),
  ('00000000-0000-4000-8000-0000000c00b0', 'billing', '0.1.0', false),
  ('00000000-0000-4000-8000-0000000c00b0', 'payments', '0.1.0', false),
  ('00000000-0000-4000-8000-0000000c00b0', 'pesapal', '0.1.0', false),
  ('00000000-0000-4000-8000-0000000c00b0', 'tenant-app', '0.1.0', false);

-- ── 3. Communities ──────────────────────────────────────────────────────────
INSERT INTO public.communities (id, org_id, name) VALUES
  ('00000000-0000-4000-8000-0000000c00a1', '00000000-0000-4000-8000-0000000c00a0', 'Investigation cases A'),
  ('00000000-0000-4000-8000-0000000c00b1', '00000000-0000-4000-8000-0000000c00b0', 'Investigation cases B');

-- ── 4. Microgrids 01 to 14 (hexadecimal) ────────────────────────────────────
-- No EMS settings or credentials. 06's zone is stored as text the capability
-- cannot use, so it reads the day in UTC (case C10). 0a is B's.
INSERT INTO public.microgrids (id, community_id, name, currency, timezone) VALUES
  ('00000000-0000-4000-8000-0000000c0001', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 01', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c0002', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 02', 'UGX', 'Europe/London'),
  ('00000000-0000-4000-8000-0000000c0003', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 03', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c0004', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 04', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c0005', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 05', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c0006', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 06', 'UGX', 'Not/AZone'),
  ('00000000-0000-4000-8000-0000000c0007', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 07', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c0008', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 08', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c0009', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 09', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c000a', '00000000-0000-4000-8000-0000000c00b1', 'Case microgrid 0a', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c000b', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 0b', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c000c', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 0c', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c000d', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 0d', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c000e', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 0e', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c000f', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 0f', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c0010', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 10', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c0011', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 11', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c0012', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 12', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c0013', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 13', 'UGX', 'Africa/Kampala'),
  ('00000000-0000-4000-8000-0000000c0014', '00000000-0000-4000-8000-0000000c00a1', 'Case microgrid 14', 'UGX', 'Africa/Kampala');

-- ── 5. Edges ────────────────────────────────────────────────────────────────
-- One synthetic edge per microgrid; 09 also has a real edge with no devices,
-- so its provider selection is refused as mixed (case C13).
INSERT INTO public.edges (id, microgrid_id, name, openems_edge_id) VALUES
  ('00000000-0000-4000-8000-0000000e0101', '00000000-0000-4000-8000-0000000c0001', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-01'),
  ('00000000-0000-4000-8000-0000000e0201', '00000000-0000-4000-8000-0000000c0002', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-02'),
  ('00000000-0000-4000-8000-0000000e0301', '00000000-0000-4000-8000-0000000c0003', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-03'),
  ('00000000-0000-4000-8000-0000000e0401', '00000000-0000-4000-8000-0000000c0004', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-04'),
  ('00000000-0000-4000-8000-0000000e0501', '00000000-0000-4000-8000-0000000c0005', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-05'),
  ('00000000-0000-4000-8000-0000000e0601', '00000000-0000-4000-8000-0000000c0006', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-06'),
  ('00000000-0000-4000-8000-0000000e0701', '00000000-0000-4000-8000-0000000c0007', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-07'),
  ('00000000-0000-4000-8000-0000000e0801', '00000000-0000-4000-8000-0000000c0008', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-08'),
  ('00000000-0000-4000-8000-0000000e0901', '00000000-0000-4000-8000-0000000c0009', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-09'),
  ('00000000-0000-4000-8000-0000000e0902', '00000000-0000-4000-8000-0000000c0009', 'Real edge', 'edge0'),
  ('00000000-0000-4000-8000-0000000e0a01', '00000000-0000-4000-8000-0000000c000a', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-10'),
  ('00000000-0000-4000-8000-0000000e0b01', '00000000-0000-4000-8000-0000000c000b', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-11'),
  ('00000000-0000-4000-8000-0000000e0c01', '00000000-0000-4000-8000-0000000c000c', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-12'),
  ('00000000-0000-4000-8000-0000000e0d01', '00000000-0000-4000-8000-0000000c000d', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-13'),
  ('00000000-0000-4000-8000-0000000e0e01', '00000000-0000-4000-8000-0000000c000e', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-14'),
  ('00000000-0000-4000-8000-0000000e0f01', '00000000-0000-4000-8000-0000000c000f', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-15'),
  ('00000000-0000-4000-8000-0000000e1001', '00000000-0000-4000-8000-0000000c0010', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-16'),
  ('00000000-0000-4000-8000-0000000e1101', '00000000-0000-4000-8000-0000000c0011', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-17'),
  ('00000000-0000-4000-8000-0000000e1201', '00000000-0000-4000-8000-0000000c0012', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-18'),
  ('00000000-0000-4000-8000-0000000e1301', '00000000-0000-4000-8000-0000000c0013', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-19'),
  ('00000000-0000-4000-8000-0000000e1401', '00000000-0000-4000-8000-0000000c0014', 'Synthetic edge', 'SYNTHETIC-EDGE-CASE-20');

-- ── 6. Devices ──────────────────────────────────────────────────────────────
-- The full set on each microgrid's synthetic edge, less what its variant
-- omits (03 has no battery, 04 no grid meter, 08 neither) and less the legacy
-- rows below.
INSERT INTO public.devices (id, edge_id, name, device_type, openems_component_id) VALUES
  ('00000000-0000-4000-8000-0000000c0101', '00000000-0000-4000-8000-0000000e0101', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c0102', '00000000-0000-4000-8000-0000000e0101', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c0103', '00000000-0000-4000-8000-0000000e0101', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0104', '00000000-0000-4000-8000-0000000e0101', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0111', '00000000-0000-4000-8000-0000000e0101', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0112', '00000000-0000-4000-8000-0000000e0101', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0113', '00000000-0000-4000-8000-0000000e0101', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c0201', '00000000-0000-4000-8000-0000000e0201', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c0202', '00000000-0000-4000-8000-0000000e0201', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c0203', '00000000-0000-4000-8000-0000000e0201', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0204', '00000000-0000-4000-8000-0000000e0201', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0211', '00000000-0000-4000-8000-0000000e0201', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0212', '00000000-0000-4000-8000-0000000e0201', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0213', '00000000-0000-4000-8000-0000000e0201', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c0302', '00000000-0000-4000-8000-0000000e0301', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c0303', '00000000-0000-4000-8000-0000000e0301', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0304', '00000000-0000-4000-8000-0000000e0301', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0311', '00000000-0000-4000-8000-0000000e0301', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0312', '00000000-0000-4000-8000-0000000e0301', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0313', '00000000-0000-4000-8000-0000000e0301', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c0401', '00000000-0000-4000-8000-0000000e0401', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c0403', '00000000-0000-4000-8000-0000000e0401', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0404', '00000000-0000-4000-8000-0000000e0401', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0411', '00000000-0000-4000-8000-0000000e0401', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0412', '00000000-0000-4000-8000-0000000e0401', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0413', '00000000-0000-4000-8000-0000000e0401', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c0501', '00000000-0000-4000-8000-0000000e0501', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c0502', '00000000-0000-4000-8000-0000000e0501', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c0503', '00000000-0000-4000-8000-0000000e0501', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0504', '00000000-0000-4000-8000-0000000e0501', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0511', '00000000-0000-4000-8000-0000000e0501', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0512', '00000000-0000-4000-8000-0000000e0501', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0601', '00000000-0000-4000-8000-0000000e0601', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c0602', '00000000-0000-4000-8000-0000000e0601', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c0603', '00000000-0000-4000-8000-0000000e0601', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0604', '00000000-0000-4000-8000-0000000e0601', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0611', '00000000-0000-4000-8000-0000000e0601', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0612', '00000000-0000-4000-8000-0000000e0601', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0613', '00000000-0000-4000-8000-0000000e0601', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c0701', '00000000-0000-4000-8000-0000000e0701', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c0702', '00000000-0000-4000-8000-0000000e0701', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c0703', '00000000-0000-4000-8000-0000000e0701', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0711', '00000000-0000-4000-8000-0000000e0701', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0712', '00000000-0000-4000-8000-0000000e0701', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0713', '00000000-0000-4000-8000-0000000e0701', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c0803', '00000000-0000-4000-8000-0000000e0801', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0804', '00000000-0000-4000-8000-0000000e0801', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0811', '00000000-0000-4000-8000-0000000e0801', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0812', '00000000-0000-4000-8000-0000000e0801', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0813', '00000000-0000-4000-8000-0000000e0801', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c0901', '00000000-0000-4000-8000-0000000e0901', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c0902', '00000000-0000-4000-8000-0000000e0901', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c0903', '00000000-0000-4000-8000-0000000e0901', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0904', '00000000-0000-4000-8000-0000000e0901', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0911', '00000000-0000-4000-8000-0000000e0901', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0912', '00000000-0000-4000-8000-0000000e0901', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0913', '00000000-0000-4000-8000-0000000e0901', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c0a01', '00000000-0000-4000-8000-0000000e0a01', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c0a02', '00000000-0000-4000-8000-0000000e0a01', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c0a03', '00000000-0000-4000-8000-0000000e0a01', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0a04', '00000000-0000-4000-8000-0000000e0a01', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0a11', '00000000-0000-4000-8000-0000000e0a01', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0a12', '00000000-0000-4000-8000-0000000e0a01', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0a13', '00000000-0000-4000-8000-0000000e0a01', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c0b01', '00000000-0000-4000-8000-0000000e0b01', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c0b02', '00000000-0000-4000-8000-0000000e0b01', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c0b03', '00000000-0000-4000-8000-0000000e0b01', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0b04', '00000000-0000-4000-8000-0000000e0b01', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0b11', '00000000-0000-4000-8000-0000000e0b01', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0b12', '00000000-0000-4000-8000-0000000e0b01', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0b13', '00000000-0000-4000-8000-0000000e0b01', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c0c01', '00000000-0000-4000-8000-0000000e0c01', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c0c02', '00000000-0000-4000-8000-0000000e0c01', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c0c03', '00000000-0000-4000-8000-0000000e0c01', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0c04', '00000000-0000-4000-8000-0000000e0c01', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0c11', '00000000-0000-4000-8000-0000000e0c01', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0c12', '00000000-0000-4000-8000-0000000e0c01', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0c13', '00000000-0000-4000-8000-0000000e0c01', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c0d01', '00000000-0000-4000-8000-0000000e0d01', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c0d02', '00000000-0000-4000-8000-0000000e0d01', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c0d03', '00000000-0000-4000-8000-0000000e0d01', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0d04', '00000000-0000-4000-8000-0000000e0d01', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0d11', '00000000-0000-4000-8000-0000000e0d01', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0d12', '00000000-0000-4000-8000-0000000e0d01', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0d13', '00000000-0000-4000-8000-0000000e0d01', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c0e01', '00000000-0000-4000-8000-0000000e0e01', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c0e02', '00000000-0000-4000-8000-0000000e0e01', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c0e03', '00000000-0000-4000-8000-0000000e0e01', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0e04', '00000000-0000-4000-8000-0000000e0e01', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0e11', '00000000-0000-4000-8000-0000000e0e01', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0e12', '00000000-0000-4000-8000-0000000e0e01', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0e13', '00000000-0000-4000-8000-0000000e0e01', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c0f01', '00000000-0000-4000-8000-0000000e0f01', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c0f02', '00000000-0000-4000-8000-0000000e0f01', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c0f03', '00000000-0000-4000-8000-0000000e0f01', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c0f04', '00000000-0000-4000-8000-0000000e0f01', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c0f11', '00000000-0000-4000-8000-0000000e0f01', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c0f12', '00000000-0000-4000-8000-0000000e0f01', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c0f13', '00000000-0000-4000-8000-0000000e0f01', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c1001', '00000000-0000-4000-8000-0000000e1001', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c1002', '00000000-0000-4000-8000-0000000e1001', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c1003', '00000000-0000-4000-8000-0000000e1001', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c1004', '00000000-0000-4000-8000-0000000e1001', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c1011', '00000000-0000-4000-8000-0000000e1001', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c1012', '00000000-0000-4000-8000-0000000e1001', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c1013', '00000000-0000-4000-8000-0000000e1001', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c1101', '00000000-0000-4000-8000-0000000e1101', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c1102', '00000000-0000-4000-8000-0000000e1101', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c1103', '00000000-0000-4000-8000-0000000e1101', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c1104', '00000000-0000-4000-8000-0000000e1101', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c1111', '00000000-0000-4000-8000-0000000e1101', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c1112', '00000000-0000-4000-8000-0000000e1101', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c1113', '00000000-0000-4000-8000-0000000e1101', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c1201', '00000000-0000-4000-8000-0000000e1201', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c1202', '00000000-0000-4000-8000-0000000e1201', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c1203', '00000000-0000-4000-8000-0000000e1201', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c1204', '00000000-0000-4000-8000-0000000e1201', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c1211', '00000000-0000-4000-8000-0000000e1201', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c1212', '00000000-0000-4000-8000-0000000e1201', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c1213', '00000000-0000-4000-8000-0000000e1201', 'Unit 3 meter', 'consumption_meter', 'meter3'),
  ('00000000-0000-4000-8000-0000000c1301', '00000000-0000-4000-8000-0000000e1301', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c1302', '00000000-0000-4000-8000-0000000e1301', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c1303', '00000000-0000-4000-8000-0000000e1301', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c1304', '00000000-0000-4000-8000-0000000e1301', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c1311', '00000000-0000-4000-8000-0000000e1301', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c1312', '00000000-0000-4000-8000-0000000e1301', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c1401', '00000000-0000-4000-8000-0000000e1401', 'Battery', 'battery', 'ess0'),
  ('00000000-0000-4000-8000-0000000c1402', '00000000-0000-4000-8000-0000000e1401', 'Grid meter', 'grid_meter', 'meter0'),
  ('00000000-0000-4000-8000-0000000c1403', '00000000-0000-4000-8000-0000000e1401', 'Inverter', 'inverter', 'inverter0'),
  ('00000000-0000-4000-8000-0000000c1404', '00000000-0000-4000-8000-0000000e1401', 'Solar meter', 'pv_meter', 'meter4'),
  ('00000000-0000-4000-8000-0000000c1411', '00000000-0000-4000-8000-0000000e1401', 'Unit 1 meter', 'consumption_meter', 'meter1'),
  ('00000000-0000-4000-8000-0000000c1412', '00000000-0000-4000-8000-0000000e1401', 'Unit 2 meter', 'consumption_meter', 'meter2'),
  ('00000000-0000-4000-8000-0000000c1413', '00000000-0000-4000-8000-0000000e1401', 'Unit 3 meter', 'consumption_meter', 'meter3');

-- Legacy rows: devices with no component id, as rows written before 00018
-- can still be (cases C09, C11 and C23). trg_device_openems_component_valid
-- refuses NULL on every insert, so it is disabled for this one statement and
-- enabled again, all inside one DO block: the block is one statement, so the
-- trigger cannot be left disabled by a failure, whatever transaction the
-- caller runs. The ALTER takes a SHARE ROW EXCLUSIVE lock on devices, held to
-- the end of the transaction, so no other session writes a device while the
-- trigger is off, and none sees it off. The column's format CHECK allows NULL
-- (20261124160100). Only this trigger is touched: never DISABLE TRIGGER ALL
-- or session_replication_role, which would skip every other check too.
DO $$
BEGIN
  ALTER TABLE public.devices DISABLE TRIGGER trg_device_openems_component_valid;
  INSERT INTO public.devices (id, edge_id, name, device_type, openems_component_id) VALUES
    ('00000000-0000-4000-8000-0000000c0513', '00000000-0000-4000-8000-0000000e0501', 'Unit 3 meter', 'consumption_meter', NULL),
    ('00000000-0000-4000-8000-0000000c0704', '00000000-0000-4000-8000-0000000e0701', 'Solar meter', 'pv_meter', NULL),
    ('00000000-0000-4000-8000-0000000c1313', '00000000-0000-4000-8000-0000000e1301', 'Unit 3 meter', 'consumption_meter', NULL);
  ALTER TABLE public.devices ENABLE TRIGGER trg_device_openems_component_valid;
END $$;
\echo Wrote 3 legacy devices with no component id, with trg_device_openems_component_valid disabled for that statement and enabled again.

-- ── 7. Tenants ──────────────────────────────────────────────────────────────
-- Units 1 to 3 on every microgrid. primary_phone is NOT NULL (00024), so each
-- carries the same number, which no country uses.
INSERT INTO public.tenants (id, microgrid_id, display_name, primary_phone) VALUES
  ('00000000-0000-4000-8000-0000000d0101', '00000000-0000-4000-8000-0000000c0001', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0102', '00000000-0000-4000-8000-0000000c0001', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0103', '00000000-0000-4000-8000-0000000c0001', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0201', '00000000-0000-4000-8000-0000000c0002', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0202', '00000000-0000-4000-8000-0000000c0002', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0203', '00000000-0000-4000-8000-0000000c0002', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0301', '00000000-0000-4000-8000-0000000c0003', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0302', '00000000-0000-4000-8000-0000000c0003', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0303', '00000000-0000-4000-8000-0000000c0003', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0401', '00000000-0000-4000-8000-0000000c0004', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0402', '00000000-0000-4000-8000-0000000c0004', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0403', '00000000-0000-4000-8000-0000000c0004', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0501', '00000000-0000-4000-8000-0000000c0005', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0502', '00000000-0000-4000-8000-0000000c0005', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0503', '00000000-0000-4000-8000-0000000c0005', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0601', '00000000-0000-4000-8000-0000000c0006', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0602', '00000000-0000-4000-8000-0000000c0006', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0603', '00000000-0000-4000-8000-0000000c0006', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0701', '00000000-0000-4000-8000-0000000c0007', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0702', '00000000-0000-4000-8000-0000000c0007', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0703', '00000000-0000-4000-8000-0000000c0007', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0801', '00000000-0000-4000-8000-0000000c0008', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0802', '00000000-0000-4000-8000-0000000c0008', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0803', '00000000-0000-4000-8000-0000000c0008', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0901', '00000000-0000-4000-8000-0000000c0009', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0902', '00000000-0000-4000-8000-0000000c0009', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0903', '00000000-0000-4000-8000-0000000c0009', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0a01', '00000000-0000-4000-8000-0000000c000a', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0a02', '00000000-0000-4000-8000-0000000c000a', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0a03', '00000000-0000-4000-8000-0000000c000a', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0b01', '00000000-0000-4000-8000-0000000c000b', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0b02', '00000000-0000-4000-8000-0000000c000b', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0b03', '00000000-0000-4000-8000-0000000c000b', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0c01', '00000000-0000-4000-8000-0000000c000c', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0c02', '00000000-0000-4000-8000-0000000c000c', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0c03', '00000000-0000-4000-8000-0000000c000c', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0d01', '00000000-0000-4000-8000-0000000c000d', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0d02', '00000000-0000-4000-8000-0000000c000d', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0d03', '00000000-0000-4000-8000-0000000c000d', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0e01', '00000000-0000-4000-8000-0000000c000e', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0e02', '00000000-0000-4000-8000-0000000c000e', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0e03', '00000000-0000-4000-8000-0000000c000e', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0f01', '00000000-0000-4000-8000-0000000c000f', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0f02', '00000000-0000-4000-8000-0000000c000f', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d0f03', '00000000-0000-4000-8000-0000000c000f', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1001', '00000000-0000-4000-8000-0000000c0010', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1002', '00000000-0000-4000-8000-0000000c0010', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1003', '00000000-0000-4000-8000-0000000c0010', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1101', '00000000-0000-4000-8000-0000000c0011', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1102', '00000000-0000-4000-8000-0000000c0011', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1103', '00000000-0000-4000-8000-0000000c0011', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1201', '00000000-0000-4000-8000-0000000c0012', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1202', '00000000-0000-4000-8000-0000000c0012', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1203', '00000000-0000-4000-8000-0000000c0012', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1301', '00000000-0000-4000-8000-0000000c0013', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1302', '00000000-0000-4000-8000-0000000c0013', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1303', '00000000-0000-4000-8000-0000000c0013', 'Unit 3', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1401', '00000000-0000-4000-8000-0000000c0014', 'Unit 1', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1402', '00000000-0000-4000-8000-0000000c0014', 'Unit 2', '+000000000000'),
  ('00000000-0000-4000-8000-0000000d1403', '00000000-0000-4000-8000-0000000c0014', 'Unit 3', '+000000000000');

-- ── 8. Meter links ──────────────────────────────────────────────────────────
-- Unit n's primary consumption meter is device 1n, from 2026-01-01,
-- open-ended, so every pinned date has all three.
INSERT INTO public.tenant_devices (tenant_id, device_id, role, effective_from, effective_to) VALUES
  ('00000000-0000-4000-8000-0000000d0101', '00000000-0000-4000-8000-0000000c0111', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0102', '00000000-0000-4000-8000-0000000c0112', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0103', '00000000-0000-4000-8000-0000000c0113', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0201', '00000000-0000-4000-8000-0000000c0211', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0202', '00000000-0000-4000-8000-0000000c0212', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0203', '00000000-0000-4000-8000-0000000c0213', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0301', '00000000-0000-4000-8000-0000000c0311', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0302', '00000000-0000-4000-8000-0000000c0312', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0303', '00000000-0000-4000-8000-0000000c0313', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0401', '00000000-0000-4000-8000-0000000c0411', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0402', '00000000-0000-4000-8000-0000000c0412', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0403', '00000000-0000-4000-8000-0000000c0413', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0501', '00000000-0000-4000-8000-0000000c0511', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0502', '00000000-0000-4000-8000-0000000c0512', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0503', '00000000-0000-4000-8000-0000000c0513', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0601', '00000000-0000-4000-8000-0000000c0611', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0602', '00000000-0000-4000-8000-0000000c0612', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0603', '00000000-0000-4000-8000-0000000c0613', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0701', '00000000-0000-4000-8000-0000000c0711', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0702', '00000000-0000-4000-8000-0000000c0712', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0703', '00000000-0000-4000-8000-0000000c0713', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0801', '00000000-0000-4000-8000-0000000c0811', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0802', '00000000-0000-4000-8000-0000000c0812', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0803', '00000000-0000-4000-8000-0000000c0813', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0901', '00000000-0000-4000-8000-0000000c0911', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0902', '00000000-0000-4000-8000-0000000c0912', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0903', '00000000-0000-4000-8000-0000000c0913', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0a01', '00000000-0000-4000-8000-0000000c0a11', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0a02', '00000000-0000-4000-8000-0000000c0a12', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0a03', '00000000-0000-4000-8000-0000000c0a13', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0b01', '00000000-0000-4000-8000-0000000c0b11', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0b02', '00000000-0000-4000-8000-0000000c0b12', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0b03', '00000000-0000-4000-8000-0000000c0b13', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0c01', '00000000-0000-4000-8000-0000000c0c11', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0c02', '00000000-0000-4000-8000-0000000c0c12', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0c03', '00000000-0000-4000-8000-0000000c0c13', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0d01', '00000000-0000-4000-8000-0000000c0d11', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0d02', '00000000-0000-4000-8000-0000000c0d12', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0d03', '00000000-0000-4000-8000-0000000c0d13', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0e01', '00000000-0000-4000-8000-0000000c0e11', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0e02', '00000000-0000-4000-8000-0000000c0e12', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0e03', '00000000-0000-4000-8000-0000000c0e13', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0f01', '00000000-0000-4000-8000-0000000c0f11', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0f02', '00000000-0000-4000-8000-0000000c0f12', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d0f03', '00000000-0000-4000-8000-0000000c0f13', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1001', '00000000-0000-4000-8000-0000000c1011', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1002', '00000000-0000-4000-8000-0000000c1012', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1003', '00000000-0000-4000-8000-0000000c1013', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1101', '00000000-0000-4000-8000-0000000c1111', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1102', '00000000-0000-4000-8000-0000000c1112', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1103', '00000000-0000-4000-8000-0000000c1113', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1201', '00000000-0000-4000-8000-0000000c1211', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1202', '00000000-0000-4000-8000-0000000c1212', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1203', '00000000-0000-4000-8000-0000000c1213', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1301', '00000000-0000-4000-8000-0000000c1311', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1302', '00000000-0000-4000-8000-0000000c1312', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1303', '00000000-0000-4000-8000-0000000c1313', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1401', '00000000-0000-4000-8000-0000000c1411', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1402', '00000000-0000-4000-8000-0000000c1412', 'primary_consumption_meter', '2026-01-01', NULL),
  ('00000000-0000-4000-8000-0000000d1403', '00000000-0000-4000-8000-0000000c1413', 'primary_consumption_meter', '2026-01-01', NULL);

-- ── 9. An organization manager of both organizations ────────────────────────
-- No password, as in 00003_seed.sql.template: they sign in by email link,
-- which locally goes to the mail catcher.
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, last_sign_in_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-0000000f0001',
  'authenticated', 'authenticated',
  'investigations-manager@example.org',
  '',
  now(), now(),
  '{"provider":"email","providers":["email"]}', '{}',
  now(), now(), '', '', '', ''
);

INSERT INTO auth.identities (
  id, user_id, provider_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-0000000f0001',
  '00000000-0000-4000-8000-0000000f0001',
  '00000000-0000-4000-8000-0000000f0001',
  jsonb_build_object('sub', '00000000-0000-4000-8000-0000000f0001', 'email', 'investigations-manager@example.org'),
  'email', now(), now(), now()
);

INSERT INTO public.user_roles (user_id, role, scope_type, scope_id) VALUES
  ('00000000-0000-4000-8000-0000000f0001', 'org_manager', 'org', '00000000-0000-4000-8000-0000000c00a0'),
  ('00000000-0000-4000-8000-0000000f0001', 'org_manager', 'org', '00000000-0000-4000-8000-0000000c00b0');

\echo Seeded the investigation cases: organizations A and B, microgrids 01 to 14.
\echo Start the app with MGM_METERING_FIXTURES=on so the synthetic provider serves them,
\echo and sign in as investigations-manager@example.org through the local mail catcher.
