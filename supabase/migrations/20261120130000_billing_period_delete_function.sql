-- Draft billing periods are deleted through DELETE
-- /api/billing-periods/[periodId] and a delete function (#201).
--
-- The billing capability (BillingCapability.deletePeriod, behind the billing
-- plugin gate) deletes a draft period against the name the person typed. The
-- legacy periods list and period page call the same route. This migration
-- gives that route its own write path and makes it the only one a signed-in
-- caller has:
--
--   1. fn_delete_draft_billing_period(_period_id) deletes one period the
--      caller may manage and returns its id, or NULL when there is no such
--      period or it is not the caller's.
--   2. DELETE on billing_periods is revoked from authenticated and anon.
--      service_role keeps it (fixtures, imports and restores), and so does
--      the owner.
--
-- SECURITY DEFINER, because the caller no longer holds DELETE on the table.
-- As the definer no row security applies, so the function checks the
-- organization itself, with user_can_access_microgrid on the period's
-- microgrid: a super admin, or an org manager of the microgrid's
-- organization, which is what the "Authorized users can access
-- billing_periods" policy (00002, FOR ALL) allows today and what
-- fn_close_billing_period (20261118130000) checks. The helper is called, not
-- changed (CLAUDE.md, "Do not change what user_can_access_org /
-- user_can_access_microgrid mean"). A tenant, another organization's
-- manager, an account with no role and a call with no user (service_role
-- without a session, where auth.uid() is NULL) delete nothing and get NULL.
-- The policy stays, as do the INSERT, UPDATE and SELECT grants: reads,
-- creation and the close still go through it.
--
-- Closed periods and payment activity: fn_billing_period_before_delete_guard
-- (last issued by 20261103160000) fires on this DELETE as on any other, and
-- exempts no caller, the owner included. It refuses a closed period with
-- SQLSTATE 23514, a message starting billing_period_kept and DETAIL
-- 'closed', and a period with payment activity with DETAIL
-- 'payment_activity', which src/lib/billing/period-delete.ts maps to its
-- fixed copy as before. A period a pilot import refers to raises 23503
-- (pilot_import_batches.billing_period_id has no ON DELETE), which the
-- capability maps to billing_period_referenced. If that guard stops refusing
-- either case, this function deletes such a period: add the checks here
-- then.
--
-- Locks: the DELETE takes the period's row lock, and the guard then locks
-- the period's bills FOR UPDATE in id order, as a direct delete did, which
-- is the order fn_close_billing_period takes (period, then its bills). A
-- delete that waits on a close re-reads the period once the close commits,
-- and the guard refuses it as closed.
--
-- No audit row is written, as before: the period's billing_audit_log rows go
-- with it by cascade, and a deleted draft leaves no record.
--
-- Organization, community and microgrid deletes (fn_entity_delete_org,
-- _community, _microgrid and _edge, SECURITY INVOKER) delete only the
-- parent row; its periods go by the foreign key's ON DELETE CASCADE, which
-- runs as the owner of billing_periods and needs no DELETE privilege of the
-- caller. If those functions come to delete billing_periods rows by
-- statement, revisit this revoke.
--
-- A later GRANT ... ON ALL TABLES IN SCHEMA public TO authenticated (as
-- 00016 once did) would give the privilege back, and with it a delete that
-- skips the route's plugin gate; if one is ever written, revoke DELETE on
-- billing_periods again in the same migration.
-- delete_draft_billing_period.test.ts pins the privileges.
--
-- Rollback:
--   GRANT DELETE ON billing_periods TO authenticated;
--   DROP FUNCTION IF EXISTS fn_delete_draft_billing_period(UUID);
-- and point deleteBillingPeriod in
-- src/lib/billing/infrastructure/supabase-repository.ts back at a direct
-- delete first.

CREATE OR REPLACE FUNCTION fn_delete_draft_billing_period(_period_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  DELETE FROM billing_periods bp
  WHERE bp.id = _period_id
    AND user_can_access_microgrid(bp.microgrid_id)
  RETURNING bp.id INTO v_id;

  RETURN v_id;
END;
$$;

ALTER FUNCTION fn_delete_draft_billing_period(UUID) OWNER TO postgres;

REVOKE EXECUTE ON FUNCTION fn_delete_draft_billing_period(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_delete_draft_billing_period(UUID) TO authenticated, service_role;

REVOKE DELETE ON billing_periods FROM anon, authenticated;
