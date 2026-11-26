-- The operations plugin's records (#133, A2-8): an operation, the
-- investigation of one microgrid's finished day, and its evidence, the reads
-- captured for it (docs/investigation-evidence.md § 3; ADR-007 decision 3).
--
--  1. What this adds: two tables, public.operations and
--     public.operation_evidence, read-only to the API roles; one FOR SELECT
--     policy on each; two SECURITY DEFINER write functions,
--     fn_operation_create and fn_operation_transition; three guard triggers.
--     Capture (#133 A2-9) and the result with retention (#133 A2-10) come in
--     later migrations, so until A2-9 no API role can write an evidence row
--     at all.
--
--  2. Policy shape (ADR-007 decision 3; investigation-evidence.md § 10):
--     FOR SELECT TO authenticated, through
--     user_can_access_microgrid(microgrid_id); no INSERT, UPDATE or DELETE
--     policy. TO authenticated alone because mgm_agent does not exist yet
--     (#274): the pull request that first serves the investigation view to
--     an agent client adds that role to both policies, grants it SELECT by
--     column without created_by, ended_by and captured_by, and EXECUTE on
--     user_can_access_microgrid (ADR-008 decision 8). No helper body changes
--     (CLAUDE.md, "Do not change what user_can_access_org /
--     user_can_access_microgrid mean"): the helper is called, not edited.
--
--  3. Privileges: INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and
--     MAINTAIN are revoked from authenticated and service_role; anon and
--     PUBLIC hold nothing; SELECT is granted to authenticated and
--     service_role. A later GRANT ... ON ALL TABLES IN SCHEMA public (as
--     00016 once did) would give the writes back; if one is ever written,
--     revoke them on these two tables again in the same migration.
--     operation_records.test.ts pins the privileges.
--
--  4. No FORCE ROW LEVEL SECURITY: the write functions run as postgres, the
--     tables' owner, and read and write without row security; they apply
--     the access check themselves.
--
--  5. Write functions: SECURITY DEFINER, owned by postgres, search_path =
--     public, pg_temp. They decide the caller only by auth.uid() and the
--     helpers, never by current_user, which inside them is postgres. Order
--     of checks: a signed-in caller, the arguments,
--     user_can_access_microgrid, then mgm_plugin_enabled_for_org(org,
--     'operations'), then the operation's state. A caller without access
--     gets operations_forbidden before the plugin is asked, so it learns
--     nothing about the organization (the 20261120130000 order). The plugin
--     check asks only the operations plugin's own state, as the plugin gate
--     does (src/lib/runtime/gate.ts, isPluginEnabledForOrg); if the gate
--     comes to ask more (dependencies, say), ask the same here. It reads the
--     function, not mgm_plugins: a missing row is the plugin's default, off
--     since 20261125120000.
--
--  6. EXECUTE on the write functions goes to authenticated alone and is
--     revoked from PUBLIC, anon and service_role (investigation-evidence.md
--     E8). Their only actor is auth.uid(): they record it as the actor and
--     decide access through helpers keyed on it. The service role carries no
--     user, so these functions can never act for it. Granting it EXECUTE
--     would make "the service role writes no operation table" depend on the
--     first line of each function body, which a later re-issue could drop;
--     revoking it makes that rule a privilege, as the table revokes (item 3)
--     already do. A writer with no signed-in person (unattended work,
--     server-held attestation) needs its own reviewed design (ADR-007
--     decision 1) and brings its own role or function; it does not reuse
--     these.
--
--  7. Reads ignore the plugin: stored investigations stay readable while
--     the plugin is off (#133). Writes are refused while it is off, cancel
--     included; a running operation then waits until the plugin is back on
--     or retention (A2-10) expires it (investigation-evidence.md O4).
--
--  8. The zone at creation (investigation-evidence.md O2): the caller
--     passes the zone it resolved as openSiteQuery resolves it
--     (src/lib/metering/capability.ts: the stored microgrids.timezone when
--     validateTimezone accepts it, else UTC with zone = 'fallback'). The
--     function re-reads the stored zone in its own transaction and refuses,
--     with window_zone_stale, a 'microgrid' pair that does not name the
--     stored zone exactly, and a 'fallback' pair that is not UTC or is
--     claimed for a microgrid whose stored zone is literally UTC (which
--     validateTimezone accepts, so it is never a fallback). It does not
--     refuse a 'fallback' claimed for a stored zone validateTimezone would
--     accept: whether a stored zone is valid is Intl's rule, which the
--     database does not judge, so it cannot tell a true fallback from a
--     false one. Such an operation is judged window_not_closed in UTC and
--     fails at its first capture through MGM with window_changed. If
--     openSiteQuery or the operations capability's creation resolver
--     (#133 A2-11) stops reading microgrids.timezone, or falls back to
--     anything but UTC, revisit; A2-11 shares one resolver with
--     openSiteQuery so the two cannot drift. A zone the caller resolved as
--     valid that this database's tzdata does not know is refused with
--     window_zone_unrecognised, MGM's defect rather than the site's.
--
--  9. Cascade (investigation-evidence.md § 9): deleting a microgrid,
--     community or organization deletes its operations and their evidence
--     by ON DELETE CASCADE, which runs as the tables' owner, so the SECURITY
--     INVOKER fn_entity_delete_* functions need no privilege on these
--     tables. If those functions come to delete operations rows by
--     statement, revisit the revoke. No delete guard.
--
-- 10. Users: every user reference is ON DELETE SET NULL, an update the
--     guard triggers let through.
--
-- 11. Restore: the replica-mode load of data.sql fires no trigger, so the
--     guards do not refuse restored rows; CHECK constraints still apply.
--
-- 12. Realtime: neither table joins supabase_realtime until what mgm_agent
--     may receive from it is decided (#268).
--
-- 13. Audit: no audit-log rows. An operation records its own creator and
--     the person who ended it; plugin toggles stay in mgm_plugin_audit_log.
--     A deleted operation leaves no record, as a deleted draft period does.
--
-- 14. Running release: the release before this one never reads these
--     tables, so no cutover is needed.
--
-- 15. Rollback:
--       DROP FUNCTION IF EXISTS public.fn_operation_create(UUID, DATE, TEXT, public.operation_window_zone);
--       DROP FUNCTION IF EXISTS public.fn_operation_transition(UUID, public.operation_status, public.operation_failure_code);
--       DROP TABLE IF EXISTS public.operation_evidence, public.operations;
--       DROP FUNCTION IF EXISTS public.fn_operations_guard_update();
--       DROP FUNCTION IF EXISTS public.fn_operation_evidence_while_running();
--       DROP FUNCTION IF EXISTS public.fn_operation_evidence_guard_update();
--       DROP TYPE IF EXISTS public.operation_evidence_outcome, public.operation_window_zone,
--         public.operation_failure_code, public.operation_status;
--     and remove the operations plugin's tables entry from
--     src/lib/plugins/bundled.ts.
--
-- 16. The guards and CLAUDE.md's column-guard rules: the update guards are
--     plain BEFORE UPDATE with no OF <cols> list, because they watch every
--     column, so the OF list would be the whole row; they compare each
--     column, enumerated literally, with IS DISTINCT FROM, so a no-op resend
--     passes. They exempt no role, service_role included: no API role holds
--     UPDATE or INSERT on these tables, so an exemption would exempt
--     nothing, and the only writers left (the definer functions and the
--     referential actions) run as postgres, whom the guards exist to hold.
--     The column pin in operation_records.test.ts stands in for
--     ems-guard-enumeration.test.ts. If an API role is ever granted UPDATE
--     on either table, revisit the exemption and this reasoning.
--
-- Idempotent: CREATE ... IF NOT EXISTS, DROP ... IF EXISTS and CREATE OR
-- REPLACE throughout, so a re-run converges on the same state.

-- ── Types ───────────────────────────────────────────────────────────────
-- Enums, because their values are only ever added
-- (investigation-evidence.md § 6), which is the one change an enum
-- supports, and codegen gives TypeScript the unions and Constants.

DO $$ BEGIN
  CREATE TYPE public.operation_status AS ENUM ('running', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.operation_failure_code AS ENUM (
    'access_refused', 'no_successful_read', 'window_changed',
    'evidence_too_large', 'evidence_budget_full', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.operation_window_zone AS ENUM ('microgrid', 'fallback');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.operation_evidence_outcome AS ENUM ('read', 'refused');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── public.operations ───────────────────────────────────────────────────
-- O1: microgrid_id and org_id are set by fn_operation_create (the
-- organization through the microgrid's community) and never change
-- (fn_operations_guard_update). The plugin check asks the recorded org_id.
-- An operation keeps the organization recorded at creation; access is
-- decided by the microgrid's current organization through the helper. If a
-- microgrid's community or a community's organization changes (nothing in
-- the schema prevents either today), the recorded org_id and the access
-- organization differ; revisit which organization the plugin check asks.
--
-- O3: created_by records the creation and ended_by the one change out of
-- running. Retention (A2-10) leaves ended_by NULL, so a NULL ended_by on an
-- ended operation is either retention ('expired') or a deleted user; the
-- failure code tells them apart.
--
-- result and result_size are written only by A2-10's result function. They
-- exist now so operations_result_when_completed holds for every writer from
-- this migration on, and so the guard and the column pin enumerate the row
-- once.

CREATE TABLE IF NOT EXISTS public.operations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  microgrid_id  UUID NOT NULL REFERENCES public.microgrids(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  window_date   DATE NOT NULL,
  window_tz     TEXT NOT NULL,
  window_zone   public.operation_window_zone NOT NULL,
  status        public.operation_status NOT NULL DEFAULT 'running',
  failure_code  public.operation_failure_code NULL,
  result        JSONB NULL,
  result_size   INTEGER NULL,
  created_by    UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_by      UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ended_at      TIMESTAMPTZ NULL,

  -- The target of operation_evidence's composite foreign key (E2).
  CONSTRAINT operations_id_microgrid_org_key UNIQUE (id, microgrid_id, org_id),
  CONSTRAINT operations_window_tz_shape CHECK (char_length(window_tz) BETWEEN 1 AND 64),
  CONSTRAINT operations_fallback_is_utc CHECK (window_zone <> 'fallback' OR window_tz = 'UTC'),
  CONSTRAINT operations_failed_has_code CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT operations_ended_when_not_running CHECK ((status = 'running') = (ended_at IS NULL)),
  CONSTRAINT operations_ended_after_created CHECK (ended_at IS NULL OR ended_at >= created_at),
  CONSTRAINT operations_no_end_actor_while_running CHECK (status <> 'running' OR ended_by IS NULL),
  CONSTRAINT operations_expired_has_no_actor CHECK (failure_code IS DISTINCT FROM 'expired' OR ended_by IS NULL),
  CONSTRAINT operations_result_when_completed CHECK ((status = 'completed') = (result IS NOT NULL)),
  CONSTRAINT operations_result_is_object CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  CONSTRAINT operations_result_size_with_result CHECK ((result IS NULL) = (result_size IS NULL)),
  CONSTRAINT operations_result_size_positive CHECK (result_size IS NULL OR result_size > 0)
);

CREATE INDEX IF NOT EXISTS operations_microgrid_created_idx ON public.operations (microgrid_id, created_at DESC);
CREATE INDEX IF NOT EXISTS operations_org_idx ON public.operations (org_id);
CREATE INDEX IF NOT EXISTS operations_created_by_idx ON public.operations (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS operations_ended_by_idx ON public.operations (ended_by) WHERE ended_by IS NOT NULL;

-- ── public.operation_evidence ───────────────────────────────────────────
-- E6: exactly the evidence document's columns; no foreign key to devices,
-- edges or tenant links (their ids are copied into content as history).
-- E2: the composite key means no row, whoever writes it, names a microgrid
-- or organization other than its operation's. E4 (structural part): one
-- record per attempt key, at most one 'read' per operation. The
-- three-record cap, the zone and size rules, the key allowlist and
-- "outcome agrees with content" are the capture function's (A2-9).

CREATE TABLE IF NOT EXISTS public.operation_evidence (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id  UUID NOT NULL,
  microgrid_id  UUID NOT NULL,
  org_id        UUID NOT NULL,
  attempt_key   UUID NOT NULL,
  schema_name   TEXT NOT NULL,
  outcome       public.operation_evidence_outcome NOT NULL,
  content       JSONB NOT NULL,
  size          INTEGER NOT NULL,
  captured_by   UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT operation_evidence_operation_fk
    FOREIGN KEY (operation_id, microgrid_id, org_id)
    REFERENCES public.operations (id, microgrid_id, org_id) ON DELETE CASCADE,
  -- Its leading operation_id also serves the cascade from operations.
  CONSTRAINT operation_evidence_attempt_key UNIQUE (operation_id, attempt_key),
  CONSTRAINT operation_evidence_schema_known CHECK (schema_name IN ('site-day-evidence/1')),
  CONSTRAINT operation_evidence_content_is_object CHECK (jsonb_typeof(content) = 'object'),
  CONSTRAINT operation_evidence_size_positive CHECK (size > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS operation_evidence_one_read_idx
  ON public.operation_evidence (operation_id) WHERE outcome = 'read';
CREATE INDEX IF NOT EXISTS operation_evidence_captured_by_idx
  ON public.operation_evidence (captured_by) WHERE captured_by IS NOT NULL;

-- ── Privileges, row security, policies ──────────────────────────────────

ALTER TABLE public.operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_evidence ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.operations, public.operation_evidence FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.operations, public.operation_evidence TO authenticated, service_role;

-- Tenants read nothing: user_can_access_microgrid grants nothing for tenant
-- rows. If that helper ever comes to, revisit these policies.
DROP POLICY IF EXISTS "Staff can read the operations of microgrids they can access" ON public.operations;
CREATE POLICY "Staff can read the operations of microgrids they can access"
  ON public.operations FOR SELECT TO authenticated
  USING (user_can_access_microgrid(microgrid_id));

DROP POLICY IF EXISTS "Staff can read the evidence of microgrids they can access" ON public.operation_evidence;
CREATE POLICY "Staff can read the evidence of microgrids they can access"
  ON public.operation_evidence FOR SELECT TO authenticated
  USING (user_can_access_microgrid(microgrid_id));

-- ── Guard triggers ──────────────────────────────────────────────────────
-- SECURITY INVOKER, exempting no role (header item 16). A trigger fires
-- without its caller holding EXECUTE on the trigger function
-- (20261114222000 item 5), so EXECUTE is revoked from every API role. Each
-- refuses with SQLSTATE 55000, a message starting with its code, and DETAIL
-- the code.

-- O1, O3, O4 for every writer. The columns are enumerated literally; a new
-- column on operations goes into this function in a new migration, and into
-- the column pin in operation_records.test.ts, which fails until it does.
CREATE OR REPLACE FUNCTION public.fn_operations_guard_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Fixed at creation. created_by may only become NULL (ON DELETE SET NULL).
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.microgrid_id IS DISTINCT FROM OLD.microgrid_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.window_date IS DISTINCT FROM OLD.window_date
     OR NEW.window_tz IS DISTINCT FROM OLD.window_tz
     OR NEW.window_zone IS DISTINCT FROM OLD.window_zone
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'operation_immutable: an operation''s microgrid, organization, window, creator and creation time are fixed'
      USING ERRCODE = '55000', DETAIL = 'operation_immutable';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    -- No status change: only ended_by may change, and only to NULL. That
    -- leaves exactly the ON DELETE SET NULL updates.
    IF NEW.failure_code IS DISTINCT FROM OLD.failure_code
       OR NEW.result IS DISTINCT FROM OLD.result
       OR NEW.result_size IS DISTINCT FROM OLD.result_size
       OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
       OR (NEW.ended_by IS DISTINCT FROM OLD.ended_by AND NEW.ended_by IS NOT NULL) THEN
      RAISE EXCEPTION 'operation_immutable: an operation''s outcome changes only with its status'
        USING ERRCODE = '55000', DETAIL = 'operation_immutable';
    END IF;
  ELSIF OLD.status <> 'running' THEN
    -- O4: the one status change is out of running. Which writer may make
    -- which change is the write functions' job; the CHECK constraints keep
    -- the failure code, result and end time coherent with the new status.
    RAISE EXCEPTION 'operation_transition_refused: an operation that is % does not change status', OLD.status
      USING ERRCODE = '55000', DETAIL = 'operation_transition_refused';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.fn_operations_guard_update() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.fn_operations_guard_update() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_operations_guard_update ON public.operations;
CREATE TRIGGER trg_operations_guard_update
  BEFORE UPDATE ON public.operations
  FOR EACH ROW EXECUTE FUNCTION public.fn_operations_guard_update();

-- E3 for every writer. FOR SHARE conflicts with the FOR UPDATE a transition
-- holds, so an insert racing a cancel waits for it, re-reads the row and is
-- refused. A2-9's capture takes FOR UPDATE on the operation first; this
-- FOR SHARE in the same transaction then costs nothing.
CREATE OR REPLACE FUNCTION public.fn_operation_evidence_while_running()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM public.operations
   WHERE id = NEW.operation_id AND status = 'running'
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation_not_running: evidence is written only while its operation is running'
      USING ERRCODE = '55000', DETAIL = 'operation_not_running';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.fn_operation_evidence_while_running() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.fn_operation_evidence_while_running() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_operation_evidence_while_running ON public.operation_evidence;
CREATE TRIGGER trg_operation_evidence_while_running
  BEFORE INSERT ON public.operation_evidence
  FOR EACH ROW EXECUTE FUNCTION public.fn_operation_evidence_while_running();

-- E5: evidence is immutable; the one change let through is captured_by
-- becoming NULL when that user is deleted (ON DELETE SET NULL). Columns
-- enumerated literally, as for the operations guard.
CREATE OR REPLACE FUNCTION public.fn_operation_evidence_guard_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.microgrid_id IS DISTINCT FROM OLD.microgrid_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.attempt_key IS DISTINCT FROM OLD.attempt_key
     OR NEW.schema_name IS DISTINCT FROM OLD.schema_name
     OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.size IS DISTINCT FROM OLD.size
     OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
     OR (NEW.captured_by IS DISTINCT FROM OLD.captured_by AND NEW.captured_by IS NOT NULL) THEN
    RAISE EXCEPTION 'operation_evidence_immutable: evidence does not change once captured'
      USING ERRCODE = '55000', DETAIL = 'operation_evidence_immutable';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.fn_operation_evidence_guard_update() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.fn_operation_evidence_guard_update() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_operation_evidence_guard_update ON public.operation_evidence;
CREATE TRIGGER trg_operation_evidence_guard_update
  BEFORE UPDATE ON public.operation_evidence
  FOR EACH ROW EXECUTE FUNCTION public.fn_operation_evidence_guard_update();

-- ── fn_operation_create ─────────────────────────────────────────────────
-- Creates a running operation for one microgrid's finished day. The caller
-- passes the zone it resolved (header item 8); the database clock (now(),
-- the transaction's start) decides window_not_closed, not the caller's.
-- Refusals raise with DETAIL the code (operations_unauthenticated,
-- operation_request_invalid, operations_forbidden, operations_disabled,
-- window_zone_stale, window_zone_unrecognised, window_not_closed), which
-- the operations capability (A2-11) maps by PostgREST's details.

CREATE OR REPLACE FUNCTION public.fn_operation_create(
  _microgrid_id UUID,
  _window_date  DATE,
  _window_tz    TEXT,
  _window_zone  public.operation_window_zone
)
RETURNS public.operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_org    UUID;
  v_stored TEXT;
  v_today  DATE;
  v_row    public.operations%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'operations_unauthenticated: sign in to start an investigation'
      USING ERRCODE = '42501', DETAIL = 'operations_unauthenticated';
  END IF;

  IF _microgrid_id IS NULL OR _window_date IS NULL OR _window_tz IS NULL OR _window_zone IS NULL THEN
    RAISE EXCEPTION 'operation_request_invalid: a microgrid, a date and a zone are required'
      USING ERRCODE = '22023', DETAIL = 'operation_request_invalid';
  END IF;

  -- An unknown microgrid and one the caller may not access get the same
  -- answer.
  SELECT c.org_id, m.timezone
    INTO v_org, v_stored
    FROM microgrids m
    JOIN communities c ON c.id = m.community_id
   WHERE m.id = _microgrid_id
     AND user_can_access_microgrid(m.id);

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'operations_forbidden: no such microgrid, or no access to it'
      USING ERRCODE = '42501', DETAIL = 'operations_forbidden';
  END IF;

  IF NOT mgm_plugin_enabled_for_org(v_org, 'operations') THEN
    RAISE EXCEPTION 'operations_disabled: investigations are turned off for this organization'
      USING ERRCODE = '55000', DETAIL = 'operations_disabled';
  END IF;

  -- O2: the pair the caller resolved names the stored zone, or UTC as a
  -- fallback. A fallback claimed for a stored zone validateTimezone accepts
  -- is not refused: the database does not judge a zone's validity (header
  -- item 8). window_zone_stale is a creation-only code
  -- (investigation-evidence.md § 6); it is never stored.
  IF (_window_zone = 'microgrid' AND _window_tz IS DISTINCT FROM v_stored)
     OR (_window_zone = 'fallback' AND (_window_tz <> 'UTC' OR v_stored IS NOT DISTINCT FROM 'UTC')) THEN
    RAISE EXCEPTION 'window_zone_stale: the microgrid''s time zone changed; resolve it again'
      USING ERRCODE = '22023', DETAIL = 'window_zone_stale';
  END IF;

  BEGIN
    v_today := (now() AT TIME ZONE _window_tz)::date;
  EXCEPTION WHEN invalid_parameter_value THEN
    -- A zone Intl accepts and this database's tzdata does not: MGM's
    -- defect, which the capability reports as internal_error.
    RAISE EXCEPTION 'window_zone_unrecognised: the database does not know the time zone %', _window_tz
      USING ERRCODE = '22023', DETAIL = 'window_zone_unrecognised';
  END;

  IF _window_date >= v_today THEN
    RAISE EXCEPTION 'window_not_closed: the day has not ended in the microgrid''s time zone'
      USING ERRCODE = '22023', DETAIL = 'window_not_closed';
  END IF;

  INSERT INTO operations (microgrid_id, org_id, window_date, window_tz, window_zone, created_by)
  VALUES (_microgrid_id, v_org, _window_date, _window_tz, _window_zone, v_uid)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

ALTER FUNCTION public.fn_operation_create(UUID, DATE, TEXT, public.operation_window_zone) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.fn_operation_create(UUID, DATE, TEXT, public.operation_window_zone) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fn_operation_create(UUID, DATE, TEXT, public.operation_window_zone) TO authenticated;

-- ── fn_operation_transition ─────────────────────────────────────────────
-- The transitions a person drives (O4): cancel, by anyone with access to
-- the microgrid, not only the creator; and failed with access_refused, the
-- step recording that metering refused the person. Every other failure
-- code and completed are written by A2-9 and A2-10. The FOR UPDATE lock
-- serializes a transition with any capture (A2-9 locks the same row) and
-- with any other transition; after waiting, the row is re-read and one that
-- is no longer running is refused (E3). A retried cancel of a cancelled
-- operation gets operation_not_running.

CREATE OR REPLACE FUNCTION public.fn_operation_transition(
  _operation_id UUID,
  _to           public.operation_status,
  _failure_code public.operation_failure_code DEFAULT NULL
)
RETURNS public.operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_op  public.operations%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'operations_unauthenticated: sign in to change an investigation'
      USING ERRCODE = '42501', DETAIL = 'operations_unauthenticated';
  END IF;

  -- NULL-safe: a NULL _failure_code with _to = 'failed' is refused here,
  -- not left to the CHECK constraints.
  IF _operation_id IS NULL OR _to IS NULL OR NOT coalesce(
       (_to = 'cancelled' AND _failure_code IS NULL)
       OR (_to = 'failed' AND _failure_code IS NOT DISTINCT FROM 'access_refused'),
       false) THEN
    RAISE EXCEPTION 'operation_request_invalid: an operation may only be cancelled, or failed with access_refused, here'
      USING ERRCODE = '22023', DETAIL = 'operation_request_invalid';
  END IF;

  SELECT o.* INTO v_op
    FROM operations o
   WHERE o.id = _operation_id
     AND user_can_access_microgrid(o.microgrid_id)
     FOR UPDATE OF o;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'operations_forbidden: no such investigation, or no access to it'
      USING ERRCODE = '42501', DETAIL = 'operations_forbidden';
  END IF;

  IF NOT mgm_plugin_enabled_for_org(v_op.org_id, 'operations') THEN
    RAISE EXCEPTION 'operations_disabled: investigations are turned off for this organization'
      USING ERRCODE = '55000', DETAIL = 'operations_disabled';
  END IF;

  IF v_op.status <> 'running' THEN
    RAISE EXCEPTION 'operation_not_running: the investigation is already %', v_op.status
      USING ERRCODE = '55000', DETAIL = 'operation_not_running';
  END IF;

  UPDATE operations
     SET status = _to,
         failure_code = _failure_code,
         ended_by = v_uid,
         ended_at = now()
   WHERE id = v_op.id
  RETURNING * INTO v_op;

  RETURN v_op;
END;
$$;

ALTER FUNCTION public.fn_operation_transition(UUID, public.operation_status, public.operation_failure_code) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.fn_operation_transition(UUID, public.operation_status, public.operation_failure_code) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fn_operation_transition(UUID, public.operation_status, public.operation_failure_code) TO authenticated;
