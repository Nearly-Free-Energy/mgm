-- A tenant's first bill is written by an insert-only function that checks
-- the period under its lock (#201).
--
-- The bill engine (src/lib/billing/generate.ts) bills a tenant who has no
-- bill in two guarded runs: a whole period from meter data (POST
-- /api/billing-periods/[periodId]/generate-from-meters, guardExistingBills)
-- and one tenant from readings typed by hand (POST
-- /api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings,
-- newBillOnly). Both read the period's status and the tenant's bill before
-- they write. This migration adds the write those runs make for a tenant
-- whose bill they found missing:
--
--   1. fn_record_first_line_item_with_audit takes
--      fn_record_line_item_with_audit's arguments and, under a FOR SHARE lock
--      on the period held to commit, inserts the bill only while the period
--      is a draft and the tenant has no bill for it, with the same audit row
--      (line_item_generated). It never updates a bill.
--   2. trg_billing_line_item_insert_closed_period_guard refuses a signed-in
--      caller's direct insert of a bill into a closed period.
--
-- ── 1. The function ─────────────────────────────────────────────────────────
--
-- Refusals raise SQLSTATE 23514 (P0002 for the first) with a message
-- starting with a token, which src/lib/billing/generate.ts maps to fixed
-- copy, as it maps fn_regenerate_bill_with_audit's (20261119090000):
--   billing_period_not_found   P0002  no such period, or not the caller's
--   billing_period_closed      23514  the period is not a draft (DETAIL closed)
--   Billing period tariff changed; recalculate before writing bill
--                              23514  the pin moved since the engine read it
--                                     (fn_record_line_item_with_audit's text,
--                                     which the engine maps to tariff_changed)
--   billing_line_item_exists   23514  the tenant already has a bill for the
--                                     period (DETAIL bill_exists)
-- A refusal writes nothing.
--
-- Locks, and how each race ends:
--   * fn_close_billing_period (20261118130000) takes the period FOR UPDATE,
--     which conflicts with this function's FOR SHARE. A close that holds it
--     first makes this function wait and then read the period as closed
--     (in READ COMMITTED a FOR SHARE that waited returns the row as
--     committed), so it refuses. A close that comes second waits for this
--     insert to commit; its review then counts the new bill, the digest
--     differs from the one the person reviewed, and the close is refused
--     with billing_close_totals_changed.
--   * Two first bills for one tenant: both hold FOR SHARE, which do not
--     conflict. The unique index on (billing_period_id, tenant_id) makes the
--     second insert's ON CONFLICT DO NOTHING wait for the first transaction,
--     and once it commits the second inserts nothing and refuses with
--     billing_line_item_exists. A bill inserted by any other path
--     (fn_record_line_item_with_audit on POST /api/billing/generate) meets
--     the same index.
--   * An empty draft's re-pin of its rate schedule
--     (fn_pin_billing_period_rate_schedule) takes the period FOR UPDATE, and
--     this function then finds the pin changed, as
--     fn_record_line_item_with_audit does.
-- If the close stops locking the period FOR UPDATE, or a bill stops being
-- unique per period and tenant, revisit.
--
-- What it writes duplicates fn_record_line_item_with_audit's insert (last
-- issued by 20261116230000): the same twelve columns, rounding (kWh to 3
-- places, amounts to whole units, each tier as {label, kwh, amount} in
-- order), entered_at, entered_by_user_id and manual_reason only for a
-- manual reading, and the same audit row with rate_schedule_id added to its
-- details. If that function changes what it writes or how it rounds, change
-- this one with it, and ExpectedBill and sameBill in
-- src/lib/billing/generate.ts likewise; record_first_line_item.test.ts
-- compares the rows the two write from the same inputs.
--
-- It does not set mgm.audited_bill_write: that setting lets the audited
-- regeneration change a closed bill's amount (20261103160000, guard 6) or
-- insert into a closed period (section 2 below), and this function writes
-- only into a draft.
--
-- POST /api/billing/generate (the legacy pre-flight panel, the v1 route, the
-- cron and PATCH /api/billing-line-items/[lineItemId]/usage) keeps calling
-- fn_record_line_item_with_audit, which upserts: its manual rows overwrite a
-- bill, and it accepts a closed period (Q4=B), as before.
--
-- SECURITY INVOKER, like fn_record_line_item_with_audit and
-- fn_regenerate_bill_with_audit: the caller's row security decides which
-- periods it can lock and which bills and audit rows it can insert, so a
-- tenant or another organization's manager finds no period and is refused
-- with billing_period_not_found. Execute is revoked from PUBLIC and anon and
-- granted to authenticated and service_role, as CLAUDE.md asks of SECURITY
-- DEFINER functions.
--
-- ── 2. The closed-period insert guard ───────────────────────────────────────
--
-- trg_billing_line_item_closed_period_guard (20261103160000, guard 6) keeps a
-- closed period's bills as they were closed, on UPDATE. This adds its INSERT
-- side: a signed-in caller (the API roles, authenticated and anon) cannot
-- insert a bill into a closed period, whatever the write path. It takes the
-- period FOR SHARE first, so an insert racing a close either commits before
-- the close's lock (and the close's digest sees it) or waits and finds the
-- period closed.
--
-- Exempt:
--   * Roles other than the API roles. They act on the database directly
--     rather than as a person: service_role already bypasses row-level
--     security and is how fixtures, imports and restores write rows, and
--     postgres runs migrations and can disable this trigger. A SECURITY
--     DEFINER function owned by postgres also runs as postgres; none inserts
--     bills today, and a new one that does must check the period itself.
--     This is the scope trg_billing_period_transitions_by_close
--     (20261118130000) has.
--   * The audited write of fn_record_line_item_with_audit, which names the
--     bill's period and tenant in mgm.audited_bill_write around its upsert,
--     as guard 6 reads it: POST /api/billing/generate still adds a tenant's
--     bill to a closed period (Q4=B), recorded in billing_audit_log with
--     period_was_closed. If that route stops accepting closed periods, drop
--     this exemption.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_billing_line_item_insert_closed_period_guard ON billing_line_items;
--   DROP FUNCTION IF EXISTS fn_billing_line_item_insert_closed_period_guard();
--   DROP FUNCTION IF EXISTS fn_record_first_line_item_with_audit(uuid, uuid, uuid, numeric, numeric, numeric, jsonb, numeric, billing_line_item_reading_source, uuid, text, uuid, jsonb, uuid, text, text);
-- and point src/lib/billing/generate.ts back at fn_record_line_item_with_audit
-- for a tenant's first bill first.

CREATE OR REPLACE FUNCTION fn_record_first_line_item_with_audit(
  _billing_period_id   UUID,
  _tenant_id           UUID,
  _device_id           UUID,
  _usage_kwh           NUMERIC,
  _start_kwh           NUMERIC,
  _end_kwh             NUMERIC,
  _tier_breakdown      JSONB,
  _total_amount        NUMERIC,
  _reading_source      billing_line_item_reading_source,
  _entered_by_user_id  UUID,
  _manual_reason       TEXT,
  _actor_user_id       UUID,
  _audit_details       JSONB,
  _rate_schedule_id    UUID,
  _actor_kind          TEXT DEFAULT 'human',
  _actor_ref           TEXT DEFAULT NULL
)
RETURNS billing_line_items
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row                    billing_line_items%ROWTYPE;
  v_period_status          billing_period_status;
  v_pinned_rate_schedule   UUID;
  v_tier_breakdown_rounded JSONB;
BEGIN
  SELECT status, rate_schedule_id
  INTO v_period_status, v_pinned_rate_schedule
  FROM billing_periods
  WHERE id = _billing_period_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_period_not_found: the billing period does not exist or is not yours to bill'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_period_status <> 'draft' THEN
    RAISE EXCEPTION 'billing_period_closed: a first bill is not added to a closed billing period'
      USING ERRCODE = '23514', DETAIL = 'closed';
  END IF;
  IF _rate_schedule_id IS NULL
     OR v_pinned_rate_schedule IS DISTINCT FROM _rate_schedule_id THEN
    RAISE EXCEPTION 'Billing period tariff changed; recalculate before writing bill'
      USING ERRCODE = '23514';
  END IF;

  v_tier_breakdown_rounded := COALESCE(
    (SELECT jsonb_agg(
       jsonb_build_object(
         'label',  elem->>'label',
         'kwh',    ROUND((elem->>'kwh')::numeric, 3),
         'amount', ROUND((elem->>'amount')::numeric, 0)
       )
       ORDER BY ord
     )
     FROM jsonb_array_elements(COALESCE(_tier_breakdown, '[]'::jsonb))
       WITH ORDINALITY AS t(elem, ord)),
    '[]'::jsonb);

  INSERT INTO billing_line_items (
    billing_period_id,
    tenant_id,
    device_id,
    usage_kwh,
    start_kwh,
    end_kwh,
    tier_breakdown,
    total_amount,
    reading_source,
    entered_by_user_id,
    entered_at,
    manual_reason
  )
  VALUES (
    _billing_period_id,
    _tenant_id,
    _device_id,
    ROUND(_usage_kwh, 3),
    ROUND(_start_kwh, 3),
    ROUND(_end_kwh,   3),
    v_tier_breakdown_rounded,
    ROUND(_total_amount, 0),
    _reading_source,
    CASE WHEN _reading_source = 'manual' THEN _entered_by_user_id ELSE NULL END,
    CASE WHEN _reading_source = 'manual' THEN now() ELSE NULL END,
    CASE WHEN _reading_source = 'manual' THEN _manual_reason ELSE NULL END
  )
  ON CONFLICT (billing_period_id, tenant_id) DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_line_item_exists: the tenant already has a bill for this billing period'
      USING ERRCODE = '23514', DETAIL = 'bill_exists';
  END IF;

  INSERT INTO billing_audit_log (
    billing_period_id,
    billing_line_item_id,
    event_type,
    actor_user_id,
    actor_kind,
    actor_ref,
    details
  )
  VALUES (
    _billing_period_id,
    v_row.id,
    'line_item_generated',
    _actor_user_id,
    COALESCE(_actor_kind, 'human'),
    _actor_ref,
    COALESCE(_audit_details, '{}'::jsonb)
      || jsonb_build_object('rate_schedule_id', _rate_schedule_id)
  );

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_record_first_line_item_with_audit(UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC, billing_line_item_reading_source, UUID, TEXT, UUID, JSONB, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_record_first_line_item_with_audit(UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC, billing_line_item_reading_source, UUID, TEXT, UUID, JSONB, UUID, TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION fn_billing_line_item_insert_closed_period_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
-- INVOKER, so current_user is the role the statement runs as.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status billing_period_status;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF coalesce(current_setting('mgm.audited_bill_write', true), '')
     = NEW.billing_period_id::text || '/' || NEW.tenant_id::text
  THEN
    RETURN NEW;
  END IF;

  SELECT status INTO v_status
  FROM billing_periods
  WHERE id = NEW.billing_period_id
  FOR SHARE;

  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'billing_period_closed: a bill cannot be added to a closed billing period'
      USING ERRCODE = '23514',
            DETAIL = 'closed',
            HINT = 'Closed periods keep the bills they were closed with.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_billing_line_item_insert_closed_period_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_billing_line_item_insert_closed_period_guard() TO service_role;

DROP TRIGGER IF EXISTS trg_billing_line_item_insert_closed_period_guard ON billing_line_items;
CREATE TRIGGER trg_billing_line_item_insert_closed_period_guard
  BEFORE INSERT ON billing_line_items
  FOR EACH ROW
  EXECUTE FUNCTION fn_billing_line_item_insert_closed_period_guard();
