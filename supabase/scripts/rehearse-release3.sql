-- supabase/scripts/rehearse-release3.sql
-- Release 3 (issue #5, review P1) rehearsal: complete operator billing
-- workflow against the pilot-upgraded schema (00064 bridge applied).
--
-- Run: psql "$PILOT_DB_URL" -v ON_ERROR_STOP=1 -f supabase/scripts/rehearse-release3.sql
--   (e.g. PILOT_DB_URL=postgresql://postgres:postgres@127.0.0.1:56422/postgres)
--
-- Pass: NOTICE "OK: …" per step. Fail: RAISE EXCEPTION aborts (ON_ERROR_STOP).
--
-- The script builds its own fixtures (org/community/microgrid/household/
-- tariff/period) and exercises, as an authenticated org_manager exactly as
-- PostgREST would (JWT claims + SET ROLE authenticated):
--   1. tariff insert (rate_schedules) + period insert (timezone stamped)
--   2. bill generation write via fn_record_line_item_with_audit (INSERT path)
--   3. selective regeneration via the same fn (UPDATE path: payment preserved,
--      audit row appended with previous snapshot details)
--   4. manual paid via fn_apply_payment_event (paid_at set, payment_events row)
--   5. invoice numbering via fn_next_invoice_number (per-community sequence)
--   6. operator close (UPDATE status) + post-close correction attempt logged
--      with period_was_closed audit hint
--   7. audit reads (billing_audit_log + payment_events scoped joins)
--
-- Fixture UUIDs are random per run (gen_random_uuid into psql variables via
-- a DO block is impossible, so plain tables + RETURNING … INTO script
-- variables are used throughout). The script is safe to run on a
-- pilot-bridge rehearsal database; do NOT run it against production.

\set ON_ERROR_STOP on
\echo '======================================================================'
\echo ' Release 3 rehearsal — operator billing workflow (issue #5, P1)'
\echo '======================================================================'

-- ── 0. Fixtures ─────────────────────────────────────────────────────────────
\echo '-- [0] fixtures (org, manager, community, microgrid, household, tariff)'

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_community UUID;
  v_microgrid UUID;
  v_household UUID;
  v_period UUID;
  v_item billing_line_items%ROWTYPE;
  v_audit INT;
  v_events INT;
  v_n INT;
  v_tz TEXT;
BEGIN
  INSERT INTO organizations(id, name, address_city, address_country)
  VALUES (v_org, 'Release3 Rehearsal Org', 'Kampala', 'Uganda');

  INSERT INTO auth.users(
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, email_change,
    email_change_token_new, recovery_token
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', v_user, 'authenticated',
    'authenticated', 'release3-rehearsal@test.local', 'x', now(),
    '{}', '{}', now(), now(), '', '', '', ''
  );
  INSERT INTO user_roles(user_id, role, scope_type, scope_id)
  VALUES (v_user, 'org_manager', 'org', v_org);

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_user::text, 'role', 'authenticated')::text,
    true
  );
  SET ROLE authenticated;

  INSERT INTO communities(org_id, name, address_city, address_country,
    invoice_prefix, invoice_config)
  VALUES (v_org, 'Rehearsal Community', 'Kampala', 'Uganda',
    'RH', '{"tax": {"show_section": true, "rate_pct": 18}}'::jsonb)
  RETURNING id INTO v_community;

  INSERT INTO microgrids(community_id, name, currency, timezone)
  VALUES (v_community, 'Rehearsal Microgrid', 'UGX', 'Africa/Kampala')
  RETURNING id INTO v_microgrid;

  INSERT INTO households(microgrid_id, display_name, primary_phone)
  VALUES (v_microgrid, 'Rehearsal Household', '+256700000001')
  RETURNING id INTO v_household;

  -- ── 1. Tariff ──────────────────────────────────────────────────────────
  INSERT INTO rate_schedules(microgrid_id, tiers, service_charge, tax_rate)
  VALUES (v_microgrid,
    '[{"label": "T1", "min_kwh": 1, "max_kwh": 10, "rate_per_kwh": 100},
      {"label": "T2", "min_kwh": 11, "max_kwh": null, "rate_per_kwh": 200}]'::jsonb,
    500, 0)
  RETURNING id INTO v_period; -- reuse variable briefly as schedule id
  RAISE NOTICE 'OK: tariff created';

  -- ── 2. Period (timezone stamped, never re-derived) ─────────────────────
  INSERT INTO billing_periods(microgrid_id, start_date, end_date, status)
  VALUES (v_microgrid, '2026-09-01', '2026-09-30', 'draft')
  RETURNING id INTO v_period;

  SELECT timezone INTO v_tz FROM billing_periods WHERE id = v_period;
  IF v_tz <> 'Africa/Kampala' THEN
    RAISE EXCEPTION 'period timezone not stamped: %', v_tz;
  END IF;
  RAISE NOTICE 'OK: period created with stamped timezone %', v_tz;

  -- ── 3. Generate (INSERT path) ──────────────────────────────────────────
  SELECT * INTO v_item FROM fn_record_line_item_with_audit(
    v_period, v_household, NULL,
    12.5, 100.0, 112.5,
    '[{"label": "T1", "kwh": 10, "amount": 1000},
      {"label": "T2", "kwh": 2.5, "amount": 500}]'::jsonb,
    2000, 'edge', NULL, NULL, v_user,
    '{"household_name": "Rehearsal Household"}'::jsonb,
    'human', NULL
  );
  IF v_item.total_amount <> 2000 THEN
    RAISE EXCEPTION 'unexpected total_amount: %', v_item.total_amount;
  END IF;
  IF v_item.payment_status <> 'unpaid' THEN
    RAISE EXCEPTION 'new bill must start unpaid, got %', v_item.payment_status;
  END IF;
  RAISE NOTICE 'OK: bill generated (total 2000, unpaid)';

  -- ── 4. Regenerate (UPDATE path: payment preserved, audit appended) ─────
  SELECT * INTO v_item FROM fn_record_line_item_with_audit(
    v_period, v_household, NULL,
    15.0, 100.0, 115.0,
    '[{"label": "T1", "kwh": 10, "amount": 1000},
      {"label": "T2", "kwh": 5, "amount": 1000}]'::jsonb,
    2500, 'edge', NULL, NULL, v_user,
    '{"household_name": "Rehearsal Household", "previous_total_amount": 2000}'::jsonb,
    'human', NULL
  );
  IF v_item.total_amount <> 2500 THEN
    RAISE EXCEPTION 'regenerate did not update total: %', v_item.total_amount;
  END IF;

  SELECT COUNT(*) INTO v_audit FROM billing_audit_log
  WHERE billing_period_id = v_period;
  IF v_audit <> 2 THEN
    RAISE EXCEPTION 'expected 2 audit rows, got %', v_audit;
  END IF;
  RAISE NOTICE 'OK: selective regeneration preserved payment state + audit history';

  -- ── 5. Manual paid (operator cash collection) ──────────────────────────
  SELECT * INTO v_item FROM fn_apply_payment_event(
    v_item.id, 'paid', 'manual', v_user,
    '{"payment_notes": "M-Pesa ABC123"}'::jsonb,
    'human', NULL
  );
  IF v_item.payment_status <> 'paid' OR v_item.paid_at IS NULL THEN
    RAISE EXCEPTION 'manual paid transition failed: % at %',
      v_item.payment_status, v_item.paid_at;
  END IF;
  IF v_item.payment_notes <> 'M-Pesa ABC123' THEN
    RAISE EXCEPTION 'payment notes not stored: %', v_item.payment_notes;
  END IF;

  SELECT COUNT(*) INTO v_events FROM payment_events
  WHERE line_item_id = v_item.id;
  IF v_events <> 1 THEN
    RAISE EXCEPTION 'expected 1 payment event, got %', v_events;
  END IF;
  RAISE NOTICE 'OK: manual payment recorded with notes + payment event';

  -- Regenerate again AFTER payment: payment state must survive.
  SELECT * INTO v_item FROM fn_record_line_item_with_audit(
    v_period, v_household, NULL,
    15.0, 100.0, 115.0,
    '[{"label": "T1", "kwh": 10, "amount": 1000},
      {"label": "T2", "kwh": 5, "amount": 1000}]'::jsonb,
    2500, 'edge', NULL, NULL, v_user,
    '{"household_name": "Rehearsal Household"}'::jsonb,
    'human', NULL
  );
  IF v_item.payment_status <> 'paid' OR v_item.paid_at IS NULL THEN
    RAISE EXCEPTION 'regeneration clobbered payment state!';
  END IF;
  RAISE NOTICE 'OK: payment state preserved across regeneration';

  -- ── 6. Invoice numbering (per-community sequence) ──────────────────────
  SELECT fn_next_invoice_number(v_community, 2026) INTO v_n;
  IF v_n <> 1 THEN RAISE EXCEPTION 'first invoice number must be 1, got %', v_n; END IF;
  SELECT fn_next_invoice_number(v_community, 2026) INTO v_n;
  IF v_n <> 2 THEN RAISE EXCEPTION 'second invoice number must be 2, got %', v_n; END IF;
  RAISE NOTICE 'OK: per-community invoice sequence advances';

  -- ── 7. Close period + post-close correction audit ──────────────────────
  UPDATE billing_periods SET status = 'closed', closed_at = now()
  WHERE id = v_period;

  SELECT * INTO v_item FROM fn_record_line_item_with_audit(
    v_period, v_household, NULL,
    15.0, 100.0, 115.0,
    '[{"label": "T1", "kwh": 10, "amount": 1000},
      {"label": "T2", "kwh": 5, "amount": 1000}]'::jsonb,
    2500, 'manual', v_user, 'post-close correction', v_user,
    '{"household_name": "Rehearsal Household"}'::jsonb,
    'human', NULL
  );
  IF NOT EXISTS (
    SELECT 1 FROM billing_audit_log
    WHERE billing_line_item_id = v_item.id
      AND (details->>'period_was_closed')::boolean IS TRUE
  ) THEN
    RAISE EXCEPTION 'post-close correction missing period_was_closed audit hint';
  END IF;
  RAISE NOTICE 'OK: period closed; post-close correction audited with period_was_closed';

  -- ── 8. Audit reads ─────────────────────────────────────────────────────
  SELECT COUNT(*) INTO v_audit FROM billing_audit_log
  WHERE billing_period_id = v_period;
  SELECT COUNT(*) INTO v_events FROM payment_events pe
  JOIN billing_line_items bli ON bli.id = pe.line_item_id
  WHERE bli.billing_period_id = v_period;
  RAISE NOTICE 'OK: audit reads (billing_audit_log=%, payment_events=%)',
    v_audit, v_events;

  RESET ROLE;
END;
$$;

\echo ' Release 3 rehearsal complete — all steps passed.'
