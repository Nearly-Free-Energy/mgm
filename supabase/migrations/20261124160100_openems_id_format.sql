-- The format of stored OpenEMS ids.
--
-- Adds a CHECK on each column that holds an id MGM sends to OpenEMS:
--
--   1. edges_openems_edge_id_format on edges.openems_edge_id (NOT NULL since
--      00018 and 20261114230100, so no NULL branch).
--   2. devices_openems_component_id_format on devices.openems_component_id
--      (nullable in the table; fn_device_openems_component_valid refuses NULL on
--      insert and update, and the NULL branch here leaves that rule to it).
--
-- Both allow 1 to 64 characters from letters, digits, '_', '.', ':' and '-',
-- which OpenEMS's usual ids (edge0, meter1, ess0) and the synthetic
-- SYNTHETIC-EDGE-<uuid> ids fit. The application checks the same pattern
-- before it writes: OPENEMS_ID_PATTERN in src/lib/openems/ids.ts, which
-- trims first, so a stored id never carries surrounding spaces.
-- src/lib/openems/__tests__/ids.test.ts reads the newest migration that adds
-- these constraints and fails while its pattern and OPENEMS_ID_PATTERN differ;
-- change both in one commit, the SQL side in a new migration.
--
-- Both are added NOT VALID: Postgres checks every row inserted or updated from
-- now on, but this migration does not scan the rows already there, so it
-- cannot fail on a database holding an id written before the routes checked
-- the format. An existing row outside the format can still be read and
-- deleted; any UPDATE of it fails with check_violation (23514) until its id
-- is corrected, since Postgres checks the whole new row, not only the columns
-- the statement names. Once production has been checked for such rows (a
-- SELECT of each column with NOT (col ~ '<pattern>') returns nothing), a
-- later migration may run ALTER TABLE ... VALIDATE CONSTRAINT on each.

-- ── 1. Edge ids ─────────────────────────────────────────────────────────────
ALTER TABLE public.edges
  ADD CONSTRAINT edges_openems_edge_id_format
  CHECK (openems_edge_id ~ '^[A-Za-z0-9_.:-]{1,64}$') NOT VALID;

COMMENT ON CONSTRAINT edges_openems_edge_id_format ON public.edges IS
  'Same pattern as OPENEMS_ID_PATTERN in src/lib/openems/ids.ts. Added NOT VALID by 20261124160100: rows written before it are not checked until a VALIDATE CONSTRAINT.';

-- ── 2. Component ids ────────────────────────────────────────────────────────
ALTER TABLE public.devices
  ADD CONSTRAINT devices_openems_component_id_format
  CHECK (
    openems_component_id IS NULL
    OR openems_component_id ~ '^[A-Za-z0-9_.:-]{1,64}$'
  ) NOT VALID;

COMMENT ON CONSTRAINT devices_openems_component_id_format ON public.devices IS
  'Same pattern as OPENEMS_ID_PATTERN in src/lib/openems/ids.ts. Added NOT VALID by 20261124160100: rows written before it are not checked until a VALIDATE CONSTRAINT.';
