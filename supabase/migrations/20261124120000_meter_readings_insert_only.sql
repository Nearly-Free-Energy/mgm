-- Meter readings are insert-only for signed-in users (#35).
--
-- A reading is a billing input: the bill engine reads registers from this
-- table, and a closed period's figures were computed from them. Signed-in
-- users keep SELECT and INSERT, under the FOR ALL policy (00002) as before,
-- and lose the UPDATE and DELETE that 20261114230100 granted authenticated.
-- That applies to super admins too: the rule is on the authenticated role,
-- not a row, so it is a table privilege rather than a policy or a trigger
-- (CLAUDE.md § "A whole-table restriction on every signed-in user is a table
-- privilege"). The policy and its helper stay as they are. Corrections are
-- made as the database owner. The service role keeps every privilege.
--
-- TRUNCATE skips RLS and row triggers. 20261114222000 already took it from
-- authenticated on every table, and every table privilege from anon; this
-- revoke names TRUNCATE, and anon, for this table as well, so the rule holds
-- here even if a later schema-wide grant gives either back. Revoking a
-- table-level UPDATE also revokes any column-level UPDATE on the table.
--
-- The app's only session-client write to the table is insertMeterReading
-- (src/lib/metering/infrastructure/supabase-repository.ts); every other
-- session read of it is a SELECT, and no database function writes it. If a
-- feature needs to correct a reading, give it a SECURITY DEFINER function
-- with its own access check and audit row rather than granting UPDATE or
-- DELETE back. An INSERT ... ON CONFLICT DO UPDATE needs UPDATE, so an
-- upsert from the session client fails too.
--
-- Deleting a device, edge, microgrid, community or organization still removes
-- its readings: meter_readings.device_id is ON DELETE CASCADE, and Postgres
-- runs a foreign key's cascade as the owner of the referencing table, not as
-- the caller. meter_readings_insert_only.test.ts asserts it for an org
-- manager's fn_entity_delete_edge, which is SECURITY INVOKER
-- (20260926130210), so the DELETE on edges runs as the org manager; if it
-- becomes SECURITY DEFINER, that test only shows a definer path cascades.
--
-- #35's other half, letting only a super admin change
-- organizations.customerapp_enabled, needs nothing here:
-- 20261124090000_remove_customerapp_integration dropped the column.

REVOKE UPDATE, DELETE, TRUNCATE ON public.meter_readings FROM anon, authenticated;

COMMENT ON TABLE public.meter_readings IS
  'Register readings per device, a billing input. Signed-in users select and insert under RLS and never update or delete (#35); corrections are made as the database owner. Readings go with their device through ON DELETE CASCADE.';
