-- Close a billing period against the totals a person reviewed (#201).
--
-- 1. fn_billing_period_close_review returns what a person reviews before
--    closing: the period's totals, its warnings, the acknowledgements the
--    close requires, and a digest of the figures behind the totals.
-- 2. fn_close_billing_period(_period_id, _digest, _acknowledged) replaces the
--    (_period_id, _confirmed) version. In one transaction it locks the
--    period, recomputes the digest and compares it with the one the person
--    confirmed, checks every required acknowledgement, sets the status and
--    records the digest and acknowledgements in the audit log.
-- 3. A trigger refuses any other change to a period's status or closed_at
--    made by a signed-in caller, so the function above is the only way a
--    person closes a period.
--
-- Nothing about reopening changes: trg_billing_period_stays_closed
-- (20261103160000) still refuses every change away from 'closed'.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The review
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The digest covers what the totals are made of: the period (id, dates,
-- pinned tariff), the microgrid's currency, every bill (id, tenant, usage,
-- total, tier breakdown) in id order, and the tenants with no bill. A bill
-- added, removed or regenerated with different figures changes it; a payment
-- recorded against a bill does not, because payment fields are not part of
-- the totals. jsonb::text is canonical (keys sorted, no whitespace choices),
-- and numerics are digested as their text, so the same rows always give the
-- same digest. The `v1:` prefix names this recipe: a later migration that
-- changes what is digested changes the prefix, so a digest taken under the
-- old recipe never matches.
--
-- Acknowledgements, by id (the capability's labels are keyed on these ids,
-- src/lib/billing/close.ts; a new id needs a label there):
--   totals_reviewed      always.
--   tenants_without_bills when a tenant of the microgrid has no bill in the
--                         period (the old _confirmed flag's case).
--   bills_without_usage   when a bill has no usage recorded (#167).
--
-- SECURITY INVOKER: it reads through the caller's row-level security, so a
-- person reviews only a period they can read, and returns NULL otherwise.

CREATE OR REPLACE FUNCTION fn_billing_period_close_review(_period_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period    billing_periods%ROWTYPE;
  v_currency  TEXT;
  v_bills     JSONB;
  v_count     INTEGER;
  v_total     NUMERIC;
  v_usage     NUMERIC;
  v_unbilled  JSONB;
  v_unmetered JSONB;
  v_acks      JSONB;
  v_digest    TEXT;
BEGIN
  SELECT * INTO v_period FROM billing_periods WHERE id = _period_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT m.currency INTO v_currency FROM microgrids m WHERE m.id = v_period.microgrid_id;

  SELECT
    COALESCE(jsonb_agg(jsonb_build_array(
      li.id, li.tenant_id, li.usage_kwh::text, li.total_amount::text, li.tier_breakdown
    ) ORDER BY li.id), '[]'::jsonb),
    count(*),
    COALESCE(sum(li.total_amount), 0),
    COALESCE(sum(li.usage_kwh), 0)
  INTO v_bills, v_count, v_total, v_usage
  FROM billing_line_items li
  WHERE li.billing_period_id = _period_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tenantId', t.id, 'tenantName', t.display_name
  ) ORDER BY t.display_name, t.id), '[]'::jsonb)
  INTO v_unbilled
  FROM tenants t
  WHERE t.microgrid_id = v_period.microgrid_id
    AND NOT EXISTS (
      SELECT 1 FROM billing_line_items li
      WHERE li.billing_period_id = _period_id AND li.tenant_id = t.id
    );

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tenantId', t.id, 'tenantName', t.display_name
  ) ORDER BY t.display_name, t.id), '[]'::jsonb)
  INTO v_unmetered
  FROM billing_line_items li
  JOIN tenants t ON t.id = li.tenant_id
  WHERE li.billing_period_id = _period_id
    AND li.usage_kwh IS NULL;

  v_acks := '["totals_reviewed"]'::jsonb
    || CASE WHEN jsonb_array_length(v_unbilled) > 0
            THEN '["tenants_without_bills"]'::jsonb ELSE '[]'::jsonb END
    || CASE WHEN jsonb_array_length(v_unmetered) > 0
            THEN '["bills_without_usage"]'::jsonb ELSE '[]'::jsonb END;

  v_digest := 'v1:' || encode(sha256(convert_to(jsonb_build_object(
    'period', jsonb_build_array(
      v_period.id, v_period.start_date, v_period.end_date, v_period.rate_schedule_id
    ),
    'currency', v_currency,
    'bills', v_bills,
    'unbilled', (
      SELECT COALESCE(jsonb_agg(e->'tenantId' ORDER BY e->>'tenantId'), '[]'::jsonb)
      FROM jsonb_array_elements(v_unbilled) e
    )
  )::text, 'UTF8')), 'hex');

  RETURN jsonb_build_object(
    'periodId', v_period.id,
    'microgridId', v_period.microgrid_id,
    'status', v_period.status,
    'startDate', v_period.start_date,
    'endDate', v_period.end_date,
    'currency', v_currency,
    'billCount', v_count,
    'totalAmount', v_total,
    'usageKwh', v_usage,
    'unbilled', v_unbilled,
    'unmetered', v_unmetered,
    'acknowledgements', v_acks,
    'digest', v_digest
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_billing_period_close_review(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_billing_period_close_review(UUID) TO authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The close
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Two locks make the comparison hold until commit, so every change to the
-- bills behind the digest lands either before the review (and changes the
-- digest) or after the close (and meets the closed-period guards):
--   * FOR UPDATE on the period. A new bill waits on it: the foreign key check
--     of an INSERT into billing_line_items takes FOR KEY SHARE on the period,
--     and fn_record_line_item_with_audit takes FOR SHARE on it.
--   * FOR SHARE on the period's bills, taken before the review reads them. An
--     UPDATE or DELETE of one of those bills, directly or cascaded from its
--     tenant, waits on it.
-- Tenants added to or removed from the microgrid while a close runs do not
-- wait; either order is a valid outcome, since a period closed before a
-- tenant joined or left is correct either way. If billing_line_items stops
-- referencing billing_periods by foreign key, or the digest comes to cover a
-- table other than billing_line_items, billing_periods and microgrids,
-- revisit.
--
-- Errors carry a token at the start of the message, which the billing
-- capability maps to a response (src/lib/billing/capability.ts):
--   billing_period_not_found             P0002  no such period, or not the caller's
--   billing_period_closed                23514  already closed
--   billing_close_totals_changed         23514  digest differs from the review
--   billing_close_acknowledgement_missing 23514 a required acknowledgement is absent
--
-- The status is set under a transaction-local setting naming the period,
-- which is how trg_billing_period_transitions_by_close (section 3) tells
-- this function's update from any other. It is cleared straight after.

DROP FUNCTION IF EXISTS fn_close_billing_period(UUID, BOOLEAN);

CREATE FUNCTION fn_close_billing_period(
  _period_id UUID,
  _digest TEXT,
  _acknowledged TEXT[]
)
RETURNS SETOF billing_periods
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period  billing_periods%ROWTYPE;
  v_review  JSONB;
  v_missing TEXT[];
BEGIN
  SELECT * INTO v_period
  FROM billing_periods
  WHERE id = _period_id
    AND user_can_access_microgrid(microgrid_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_period_not_found: the billing period does not exist or is not yours to close'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_period.status = 'closed' THEN
    RAISE EXCEPTION 'billing_period_closed: the billing period is already closed'
      USING ERRCODE = '23514', DETAIL = 'closed';
  END IF;

  PERFORM 1
  FROM billing_line_items li
  WHERE li.billing_period_id = _period_id
  ORDER BY li.id
  FOR SHARE;

  v_review := fn_billing_period_close_review(_period_id);

  IF _digest IS NULL OR _digest IS DISTINCT FROM v_review->>'digest' THEN
    RAISE EXCEPTION 'billing_close_totals_changed: the period''s totals changed after they were reviewed'
      USING ERRCODE = '23514', DETAIL = 'totals_changed';
  END IF;

  SELECT COALESCE(array_agg(a ORDER BY a), '{}'::text[])
  INTO v_missing
  FROM jsonb_array_elements_text(v_review->'acknowledgements') AS a
  -- COALESCE: a NULL element would make the comparison NULL, which must
  -- count as not acknowledged.
  WHERE NOT COALESCE(a = ANY (_acknowledged), false);

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'billing_close_acknowledgement_missing: %', array_to_string(v_missing, ', ')
      USING ERRCODE = '23514', DETAIL = array_to_string(v_missing, ',');
  END IF;

  PERFORM set_config('mgm.billing_period_close', _period_id::text, true);

  UPDATE billing_periods bp
  SET status = 'closed', closed_at = now()
  WHERE bp.id = _period_id
  RETURNING bp.* INTO v_period;

  PERFORM set_config('mgm.billing_period_close', '', true);

  INSERT INTO billing_audit_log (
    billing_period_id, event_type, actor_user_id, actor_kind, details
  ) VALUES (
    v_period.id, 'period_closed', auth.uid(), 'human',
    jsonb_build_object(
      'digest', v_review->'digest',
      'acknowledged', v_review->'acknowledgements',
      'bill_count', v_review->'billCount',
      'total_amount', v_review->'totalAmount',
      'currency', v_review->'currency',
      'unresolved', v_review->'unbilled',
      'unmetered', v_review->'unmetered'
    )
  );

  RETURN NEXT v_period;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_close_billing_period(UUID, TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_close_billing_period(UUID, TEXT, TEXT[]) TO authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. A period's status changes only through the close
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Refused for a signed-in caller (the API roles, authenticated and anon):
--   * inserting a period that is not a draft, or that has a closed_at;
--   * changing status or closed_at on a period, unless
--     fn_close_billing_period is doing it for that period.
-- UPDATE OF status, closed_at fires for any statement that names either
-- column, including a resend of the same values, so the body compares values
-- and lets an unchanged resend through.
--
-- Roles other than the API roles are exempt, because they act on the
-- database directly rather than as a person: service_role already bypasses
-- row-level security and is how fixtures, imports and restores write rows,
-- and postgres runs migrations and can disable this trigger. A SECURITY
-- DEFINER function owned by postgres also runs as postgres, so one that
-- updates billing_periods.status would be exempt too; none does today, and a
-- new one that does must check the person itself or call
-- fn_close_billing_period instead.
--
-- fn_close_billing_period sets the transaction-local setting
-- mgm.billing_period_close to the period's id around its update and clears it
-- straight after. A signed-in caller cannot set it: PostgREST runs no SET for
-- them, set_config is not in a schema PostgREST exposes, and no function the
-- API roles can execute sets it with a value they choose. If a function that
-- does is ever granted to authenticated, or PostgREST comes to pass
-- client-chosen settings through, this check no longer holds; revisit.
--
-- Postgres fires BEFORE triggers on a table in name order. This trigger's
-- name sorts after trg_billing_period_stays_closed, so reopening a closed
-- period is still refused by that trigger, with its own code and message
-- (23514, billing_period_closed); this one refuses it too if that trigger is
-- ever dropped. If either is renamed, check the order again.

CREATE OR REPLACE FUNCTION fn_billing_period_transitions_by_close()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'draft' OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'billing_period_status_via_close: a billing period starts as a draft and is closed with fn_close_billing_period'
        USING ERRCODE = '42501', DETAIL = 'status_via_close';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.closed_at IS DISTINCT FROM OLD.closed_at)
     AND current_setting('mgm.billing_period_close', true) IS DISTINCT FROM NEW.id::text
  THEN
    RAISE EXCEPTION 'billing_period_status_via_close: a billing period''s status changes only through fn_close_billing_period'
      USING ERRCODE = '42501', DETAIL = 'status_via_close';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_billing_period_transitions_by_close() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_billing_period_transitions_by_close() TO service_role;

DROP TRIGGER IF EXISTS trg_billing_period_transitions_by_close ON billing_periods;
CREATE TRIGGER trg_billing_period_transitions_by_close
  BEFORE INSERT OR UPDATE OF status, closed_at ON billing_periods
  FOR EACH ROW
  EXECUTE FUNCTION fn_billing_period_transitions_by_close();
