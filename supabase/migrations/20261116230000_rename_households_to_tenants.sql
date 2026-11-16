-- Rename households to tenants.
--
-- MGM calls a microgrid's customer a tenant (docs/entity-model.md). This
-- file renames every database object that used the old word, and nothing
-- else: rows keep their ids and values, and every privilege, policy
-- expression, constraint and trigger keeps working as it did.
--
--  1. Tables: households, household_devices and household_users become
--     tenants, tenant_devices and tenant_users.
--  2. Columns: household_id becomes tenant_id on tenant_devices,
--     tenant_users and billing_line_items;
--     pilot_import_batches.household_count becomes tenant_count.
--  3. The household_device_role enum becomes tenant_device_role. Its values
--     do not change.
--  4. Constraints, indexes, triggers and row-level security policies named
--     after households take the same name with "tenant". Postgres stores
--     policy expressions, constraints and views as parsed objects, so they
--     follow the renamed tables and columns without being recreated.
--  5. Functions. A function body is text, read when the function runs, so
--     every function that names a household table, column or message is
--     recreated with the new names. Bodies are otherwise unchanged.
--     fn_create_household, fn_create_household_with_meter and
--     fn_household_device_no_overlap are renamed in place, which keeps their
--     privileges. fn_replace_household_device and
--     fn_record_line_item_with_audit have a parameter named after households,
--     and Postgres cannot rename a parameter in place, so they are dropped
--     and created again with the privileges they had:
--     EXECUTE for authenticated and service_role only.
--  6. microgrid_recent_activity reports 'tenant_added' / "Tenant added: …"
--     where it reported 'household_added' / "Household added: …".
--
-- Historical data is not rewritten. billing_audit_log is append-only, and
-- the details of bills generated before this file keep the key
-- household_name; the history reader (src/lib/billing/audit-log-fetch.ts)
-- reads either key.
--
-- Deploying: every release before the one that ships this file queries the
-- old names, and that release queries the new ones. Apply this file and
-- promote that release back to back, at a quiet hour; between the two, the
-- running application's tenant pages, billing and checkout fail.
--
-- Not idempotent: a rename runs once.

-- 1. Tables
ALTER TABLE households RENAME TO tenants;
ALTER TABLE household_devices RENAME TO tenant_devices;
ALTER TABLE household_users RENAME TO tenant_users;

-- 2. Columns
ALTER TABLE tenant_devices RENAME COLUMN household_id TO tenant_id;
ALTER TABLE tenant_users RENAME COLUMN household_id TO tenant_id;
ALTER TABLE billing_line_items RENAME COLUMN household_id TO tenant_id;
ALTER TABLE pilot_import_batches RENAME COLUMN household_count TO tenant_count;

-- 3. Enum
ALTER TYPE household_device_role RENAME TO tenant_device_role;

-- 4. Constraints (renaming a primary key or exclusion constraint renames its
-- index too), indexes, triggers and policies
ALTER TABLE tenants RENAME CONSTRAINT households_pkey TO tenants_pkey;
ALTER TABLE tenants RENAME CONSTRAINT households_microgrid_id_fkey TO tenants_microgrid_id_fkey;
ALTER TABLE tenants RENAME CONSTRAINT households_account_number_shape TO tenants_account_number_shape;
ALTER TABLE tenants RENAME CONSTRAINT households_customer_type_enum TO tenants_customer_type_enum;
ALTER TABLE tenants RENAME CONSTRAINT households_meter_serial_shape TO tenants_meter_serial_shape;
ALTER TABLE tenants RENAME CONSTRAINT households_meter_type_shape TO tenants_meter_type_shape;

ALTER TABLE tenant_devices RENAME CONSTRAINT household_devices_pkey TO tenant_devices_pkey;
ALTER TABLE tenant_devices RENAME CONSTRAINT household_devices_household_id_fkey TO tenant_devices_tenant_id_fkey;
ALTER TABLE tenant_devices RENAME CONSTRAINT household_devices_device_id_fkey TO tenant_devices_device_id_fkey;
ALTER TABLE tenant_devices RENAME CONSTRAINT household_devices_effective_period_valid TO tenant_devices_effective_period_valid;
ALTER TABLE tenant_devices RENAME CONSTRAINT household_devices_primary_no_overlap TO tenant_devices_primary_no_overlap;

ALTER TABLE tenant_users RENAME CONSTRAINT household_users_pkey TO tenant_users_pkey;
ALTER TABLE tenant_users RENAME CONSTRAINT household_users_household_id_fkey TO tenant_users_tenant_id_fkey;
ALTER TABLE tenant_users RENAME CONSTRAINT household_users_user_id_fkey TO tenant_users_user_id_fkey;

ALTER TABLE billing_line_items RENAME CONSTRAINT billing_line_items_household_id_fkey TO billing_line_items_tenant_id_fkey;
ALTER TABLE pilot_import_batches RENAME CONSTRAINT pilot_import_batches_household_count_check TO pilot_import_batches_tenant_count_check;

ALTER INDEX idx_households_microgrid_id RENAME TO idx_tenants_microgrid_id;
ALTER INDEX idx_household_devices_device RENAME TO idx_tenant_devices_device;
ALTER INDEX idx_household_devices_household RENAME TO idx_tenant_devices_tenant;
ALTER INDEX idx_household_users_household RENAME TO idx_tenant_users_tenant;
ALTER INDEX idx_household_users_user RENAME TO idx_tenant_users_user;
ALTER INDEX idx_billing_line_items_household RENAME TO idx_billing_line_items_tenant;
ALTER INDEX idx_billing_line_items_period_household RENAME TO idx_billing_line_items_period_tenant;

ALTER TRIGGER trg_mgm_require_community_plugin_enabled_households ON tenants
  RENAME TO trg_mgm_require_community_plugin_enabled_tenants;
ALTER TRIGGER trg_household_device_no_overlap ON tenant_devices
  RENAME TO trg_tenant_device_no_overlap;

ALTER POLICY "Authorized users can access households" ON tenants
  RENAME TO "Authorized users can access tenants";
ALTER POLICY "Authorized users can access household_devices" ON tenant_devices
  RENAME TO "Authorized users can access tenant_devices";
ALTER POLICY "Authorized users can access household_users" ON tenant_users
  RENAME TO "Authorized users can access tenant_users";

COMMENT ON COLUMN tenant_devices.effective_from IS
  'Inclusive start date for this tenant-device assignment.';

-- 5. Functions
ALTER FUNCTION fn_create_household(uuid, text, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text)
  RENAME TO fn_create_tenant;
ALTER FUNCTION fn_create_household_with_meter(uuid, text, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text)
  RENAME TO fn_create_tenant_with_meter;
ALTER FUNCTION fn_household_device_no_overlap() RENAME TO fn_tenant_device_no_overlap;

DROP FUNCTION fn_replace_household_device(uuid, uuid, date);
DROP FUNCTION fn_record_line_item_with_audit(uuid, uuid, uuid, numeric, numeric, numeric, jsonb, numeric, billing_line_item_reading_source, uuid, text, uuid, jsonb, uuid, text, text);

CREATE OR REPLACE FUNCTION public.fn_billing_line_item_closed_period_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_closed BOOLEAN;
  v_new_closed BOOLEAN;
BEGIN
  -- Lock the periods first, so a period being closed concurrently either
  -- commits first (and is seen below) or waits for this write. Id order
  -- keeps two such writes from deadlocking. fn_record_line_item_with_audit
  -- already holds this lock on its period.
  PERFORM 1 FROM billing_periods
  WHERE id IN (OLD.billing_period_id, NEW.billing_period_id)
  ORDER BY id
  FOR SHARE;

  SELECT bp.status = 'closed' INTO v_old_closed
  FROM billing_periods bp WHERE bp.id = OLD.billing_period_id;
  v_old_closed := coalesce(v_old_closed, false);

  IF NEW.billing_period_id IS DISTINCT FROM OLD.billing_period_id THEN
    SELECT bp.status = 'closed' INTO v_new_closed
    FROM billing_periods bp WHERE bp.id = NEW.billing_period_id;
    IF v_old_closed OR coalesce(v_new_closed, false) THEN
      RAISE EXCEPTION 'billing_period_closed: a bill cannot be moved into or out of a closed billing period'
        USING ERRCODE = '23514',
              DETAIL = 'closed',
              HINT = 'Closed periods keep the bills they were closed with.';
    END IF;
  END IF;

  IF v_old_closed AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'billing_period_closed: a bill in a closed billing period keeps its tenant'
      USING ERRCODE = '23514',
            DETAIL = 'closed',
            HINT = 'Closed periods keep the bills they were closed with.';
  END IF;

  IF v_old_closed
     AND NEW.total_amount IS DISTINCT FROM OLD.total_amount
     AND coalesce(current_setting('mgm.audited_bill_write', true), '')
         <> OLD.billing_period_id::text || '/' || OLD.tenant_id::text
  THEN
    RAISE EXCEPTION 'billing_period_closed: a bill in a closed billing period changes amount only when it is regenerated'
      USING ERRCODE = '23514',
            DETAIL = 'closed',
            HINT = 'Regenerate the bill, which records the correction in billing_audit_log.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_close_billing_period(_period_id uuid, _confirmed boolean DEFAULT false)
 RETURNS SETOF billing_periods
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period billing_periods%ROWTYPE;
  v_unresolved JSONB;
BEGIN
  SELECT * INTO v_period
  FROM billing_periods
  WHERE id = _period_id
    AND status <> 'closed'
    AND user_can_access_microgrid(microgrid_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Billing period not found, unauthorized, or already closed'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tenantId', h.id,
    'tenantName', h.display_name,
    'reason', 'No bill generated for this tenant in this period.'
  ) ORDER BY h.display_name), '[]'::jsonb)
  INTO v_unresolved
  FROM tenants h
  WHERE h.microgrid_id = v_period.microgrid_id
    AND NOT EXISTS (
      SELECT 1 FROM billing_line_items li
      WHERE li.billing_period_id = v_period.id AND li.tenant_id = h.id
    );

  IF jsonb_array_length(v_unresolved) > 0 AND NOT _confirmed THEN
    RAISE EXCEPTION 'Period has unresolved tenants; explicit confirmation required'
      USING ERRCODE = '23514';
  END IF;

  UPDATE billing_periods bp
  SET status = 'closed', closed_at = now()
  WHERE bp.id = _period_id
  RETURNING bp.* INTO v_period;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Billing period not found, unauthorized, or already closed'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO billing_audit_log (
    billing_period_id, event_type, actor_user_id, actor_kind, details
  ) VALUES (
    v_period.id, 'period_closed', auth.uid(), 'human',
    jsonb_build_object('confirmed', _confirmed, 'unresolved', v_unresolved)
  );

  RETURN NEXT v_period;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_create_tenant(p_microgrid_id uuid, p_display_name text, p_device_id uuid DEFAULT NULL::uuid, p_primary_phone text DEFAULT NULL::text, p_primary_email text DEFAULT NULL::text, p_address_line1 text DEFAULT NULL::text, p_address_line2 text DEFAULT NULL::text, p_unit_label text DEFAULT NULL::text, p_address_city text DEFAULT NULL::text, p_address_region text DEFAULT NULL::text, p_address_country text DEFAULT NULL::text, p_address_postal_code text DEFAULT NULL::text, p_geography_notes text DEFAULT NULL::text, p_account_number text DEFAULT NULL::text, p_meter_serial text DEFAULT NULL::text, p_meter_type text DEFAULT NULL::text, p_customer_type text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _tenant_id UUID;
BEGIN
  -- Guard 0 (#155): phone is required for Pesapal billing-address contact.
  IF p_primary_phone IS NULL OR trim(p_primary_phone) = '' THEN
    RAISE EXCEPTION 'tenant_phone_required';
  END IF;

  -- Guards 1 + 2 only apply when a device is being linked.
  IF p_device_id IS NOT NULL THEN
    -- Guard 1: device's edge must belong to the target microgrid.
    IF NOT EXISTS (
      SELECT 1
      FROM devices d
      JOIN edges e ON e.id = d.edge_id
      WHERE d.id = p_device_id
        AND e.microgrid_id = p_microgrid_id
    ) THEN
      RAISE EXCEPTION
        'device % does not belong to microgrid %',
        p_device_id, p_microgrid_id;
    END IF;

    -- Guard 2: device must be of type consumption_meter.
    IF (SELECT device_type FROM devices WHERE id = p_device_id) <> 'consumption_meter' THEN
      RAISE EXCEPTION
        'device % is not a consumption_meter',
        p_device_id;
    END IF;
  END IF;

  -- Atomic insert (+ optional device link). RLS on tenants /
  -- tenant_devices applies via SECURITY INVOKER.
  --
  -- COALESCE on meter_type / customer_type so a NULL caller-arg honors the
  -- column DEFAULT explicitly (Postgres can't fall through to DEFAULT when
  -- a NULL VALUE is supplied).
  INSERT INTO tenants (
    microgrid_id,
    display_name,
    primary_phone,
    primary_email,
    address_line1,
    address_line2,
    unit_label,
    address_city,
    address_region,
    address_country,
    address_postal_code,
    geography_notes,
    account_number,
    meter_serial,
    meter_type,
    customer_type
  ) VALUES (
    p_microgrid_id,
    p_display_name,
    p_primary_phone,
    p_primary_email,
    p_address_line1,
    p_address_line2,
    p_unit_label,
    p_address_city,
    p_address_region,
    p_address_country,
    p_address_postal_code,
    p_geography_notes,
    p_account_number,
    p_meter_serial,
    COALESCE(p_meter_type,    'Smart Submeter'),
    COALESCE(p_customer_type, 'residential')
  )
  RETURNING id INTO _tenant_id;

  IF p_device_id IS NOT NULL THEN
    INSERT INTO tenant_devices (tenant_id, device_id, role)
    VALUES (_tenant_id, p_device_id, 'primary_consumption_meter');
  END IF;

  RETURN _tenant_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_create_tenant_with_meter(p_microgrid_id uuid, p_display_name text, p_device_id uuid, p_primary_phone text DEFAULT NULL::text, p_primary_email text DEFAULT NULL::text, p_address_line1 text DEFAULT NULL::text, p_address_line2 text DEFAULT NULL::text, p_unit_label text DEFAULT NULL::text, p_address_city text DEFAULT NULL::text, p_address_region text DEFAULT NULL::text, p_address_country text DEFAULT NULL::text, p_address_postal_code text DEFAULT NULL::text, p_geography_notes text DEFAULT NULL::text, p_account_number text DEFAULT NULL::text, p_meter_serial text DEFAULT NULL::text, p_meter_type text DEFAULT NULL::text, p_customer_type text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN fn_create_tenant(
    p_microgrid_id        => p_microgrid_id,
    p_display_name        => p_display_name,
    p_device_id           => p_device_id,
    p_primary_phone       => p_primary_phone,
    p_primary_email       => p_primary_email,
    p_address_line1       => p_address_line1,
    p_address_line2       => p_address_line2,
    p_unit_label          => p_unit_label,
    p_address_city        => p_address_city,
    p_address_region      => p_address_region,
    p_address_country     => p_address_country,
    p_address_postal_code => p_address_postal_code,
    p_geography_notes     => p_geography_notes,
    p_account_number      => p_account_number,
    p_meter_serial        => p_meter_serial,
    p_meter_type          => p_meter_type,
    p_customer_type       => p_customer_type
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tenant_device_no_overlap()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Only the billable role is guarded; secondary/battery/solar links may
  -- repeat across overlapping periods.
  IF NEW.role <> 'primary_consumption_meter' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM tenant_devices
    WHERE tenant_id = NEW.tenant_id
      AND role = 'primary_consumption_meter'
      AND id IS DISTINCT FROM NEW.id
      AND daterange(effective_from, effective_to, '[)')
        && daterange(NEW.effective_from, NEW.effective_to, '[)')
  ) THEN
    RAISE EXCEPTION
      'primary meter assignment for tenant % overlaps an existing assignment ([%, %))',
      NEW.tenant_id, NEW.effective_from, NEW.effective_to
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_mgm_require_community_plugin_enabled()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org_id UUID;
  v_other_org_id UUID;
BEGIN
  -- Structural service-role exemption: service_role bypasses RLS by design.
  -- This trigger declines to add a restriction to that administrative path.
  -- Check current_user (not session_user): PostgREST connects as
  -- authenticator and switches to the request role per call.
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'communities' THEN
    IF TG_OP = 'DELETE' THEN
      v_org_id := OLD.org_id;
    ELSIF TG_OP = 'INSERT' THEN
      v_org_id := NEW.org_id;
    ELSE
      v_org_id := NEW.org_id;
      v_other_org_id := OLD.org_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'microgrids' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT org_id INTO v_org_id
      FROM communities
      WHERE id = OLD.community_id;
    ELSE
      SELECT org_id INTO v_org_id
      FROM communities
      WHERE id = NEW.community_id;
      IF TG_OP = 'UPDATE' THEN
        SELECT org_id INTO v_other_org_id
        FROM communities
        WHERE id = OLD.community_id;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'tenants' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT c.org_id INTO v_org_id
      FROM microgrids m
      JOIN communities c ON c.id = m.community_id
      WHERE m.id = OLD.microgrid_id;
    ELSE
      SELECT c.org_id INTO v_org_id
      FROM microgrids m
      JOIN communities c ON c.id = m.community_id
      WHERE m.id = NEW.microgrid_id;
      IF TG_OP = 'UPDATE' THEN
        SELECT c.org_id INTO v_other_org_id
        FROM microgrids m
        JOIN communities c ON c.id = m.community_id
        WHERE m.id = OLD.microgrid_id;
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'fn_mgm_require_community_plugin_enabled is bound to an unexpected table: %', TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;

  -- A missing parent is left to FK/RLS handling. The trigger only gates writes
  -- whose organization scope it can resolve.
  IF v_org_id IS NOT NULL
    AND NOT mgm_plugin_enabled_for_org(v_org_id, 'community-management')
  THEN
    RAISE EXCEPTION 'community-management plugin is disabled for this organization'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE'
    AND v_other_org_id IS NOT NULL
    AND v_other_org_id IS DISTINCT FROM v_org_id
    AND NOT mgm_plugin_enabled_for_org(v_other_org_id, 'community-management')
  THEN
    RAISE EXCEPTION 'community-management plugin is disabled for this organization'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_record_line_item_with_audit(_billing_period_id uuid, _tenant_id uuid, _device_id uuid, _usage_kwh numeric, _start_kwh numeric, _end_kwh numeric, _tier_breakdown jsonb, _total_amount numeric, _reading_source billing_line_item_reading_source, _entered_by_user_id uuid, _manual_reason text, _actor_user_id uuid, _audit_details jsonb, _rate_schedule_id uuid, _actor_kind text DEFAULT 'human'::text, _actor_ref text DEFAULT NULL::text)
 RETURNS billing_line_items
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row                     billing_line_items%ROWTYPE;
  v_was_inserted            BOOLEAN;
  v_period_status           billing_period_status;
  v_pinned_rate_schedule_id UUID;
  v_event_type              billing_audit_event_type;
  v_entered_at              TIMESTAMPTZ;
  v_audit_details           JSONB := COALESCE(_audit_details, '{}'::jsonb)
    || jsonb_build_object('rate_schedule_id', _rate_schedule_id);
  v_line_item_id            UUID;
  v_tier_breakdown_rounded  JSONB;
BEGIN
  -- Hold a share lock through the line-item UPSERT and audit insert. A
  -- concurrent empty-draft re-pin needs FOR UPDATE and must wait. If it
  -- committed before this call, reject the stale calculation instead.
  SELECT rate_schedule_id, status
  INTO v_pinned_rate_schedule_id, v_period_status
  FROM billing_periods
  WHERE id = _billing_period_id
  FOR SHARE;
  IF NOT FOUND OR _rate_schedule_id IS NULL
     OR v_pinned_rate_schedule_id IS DISTINCT FROM _rate_schedule_id THEN
    RAISE EXCEPTION 'Billing period tariff changed; recalculate before writing bill'
      USING ERRCODE = '23514';
  END IF;

  -- Resolve entered_at only when the new reading is manual (otherwise NULL,
  -- per AC1 of #173).
  IF _reading_source = 'manual' THEN
    v_entered_at := now();
  ELSE
    v_entered_at := NULL;
  END IF;

  -- Round each tier-breakdown element. WITH ORDINALITY preserves the
  -- tier sequence (T1 → T2 → …); jsonb_agg without ORDER BY does not
  -- guarantee element order. Shape MUST remain {label, kwh, amount}.
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

  -- Announce this audited write to fn_billing_line_item_closed_period_guard
  -- (20261103160000), which lets a bill in a closed period take a new amount
  -- only while this names its period and tenant. Cleared right after.
  PERFORM set_config('mgm.audited_bill_write',
                     _billing_period_id::text || '/' || _tenant_id::text, true);

  -- UPSERT on (billing_period_id, tenant_id) — body unchanged from 00039.
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
    COALESCE(v_tier_breakdown_rounded, '[]'::jsonb),
    ROUND(_total_amount, 0),
    _reading_source,
    CASE WHEN _reading_source = 'manual' THEN _entered_by_user_id ELSE NULL END,
    v_entered_at,
    CASE WHEN _reading_source = 'manual' THEN _manual_reason ELSE NULL END
  )
  ON CONFLICT (billing_period_id, tenant_id) DO UPDATE SET
    device_id            = EXCLUDED.device_id,
    usage_kwh            = EXCLUDED.usage_kwh,
    start_kwh            = EXCLUDED.start_kwh,
    end_kwh              = EXCLUDED.end_kwh,
    tier_breakdown       = EXCLUDED.tier_breakdown,
    total_amount         = EXCLUDED.total_amount,
    reading_source       = EXCLUDED.reading_source,
    entered_by_user_id   = EXCLUDED.entered_by_user_id,
    entered_at           = EXCLUDED.entered_at,
    manual_reason        = EXCLUDED.manual_reason,
    pesapal_redirect_url = CASE
      WHEN EXCLUDED.total_amount IS DISTINCT FROM billing_line_items.total_amount
      THEN NULL
      ELSE billing_line_items.pesapal_redirect_url
    END,
    pesapal_order_id     = CASE
      WHEN EXCLUDED.total_amount IS DISTINCT FROM billing_line_items.total_amount
      THEN NULL
      ELSE billing_line_items.pesapal_order_id
    END,
    payment_failed_at    = CASE
      WHEN EXCLUDED.total_amount IS DISTINCT FROM billing_line_items.total_amount
      THEN NULL
      ELSE billing_line_items.payment_failed_at
    END
    -- DELIBERATELY OMITTED — owned by fn_apply_payment_event:
    --   payment_status, paid_at, paid_by_user_id, payment_notes,
    --   payment_refunded_at
  RETURNING (xmax = 0), id
  INTO v_was_inserted, v_line_item_id;

  PERFORM set_config('mgm.audited_bill_write', '', true);

  -- Re-read as a composite.
  SELECT * INTO v_row
  FROM billing_line_items
  WHERE id = v_line_item_id;

  -- Period-was-closed audit hint (Q4=B).
  SELECT status INTO v_period_status
  FROM billing_periods
  WHERE id = _billing_period_id;

  IF v_period_status = 'closed' THEN
    v_audit_details := v_audit_details || jsonb_build_object('period_was_closed', true);
  END IF;

  v_event_type := CASE
    WHEN v_was_inserted THEN 'line_item_generated'::billing_audit_event_type
    ELSE 'line_item_regenerated'::billing_audit_event_type
  END;

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
    v_event_type,
    _actor_user_id,
    COALESCE(_actor_kind, 'human'),
    _actor_ref,
    v_audit_details
  );

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_replace_tenant_device(p_tenant_id uuid, p_device_id uuid, p_effective_date date)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_new_id UUID;
BEGIN
  -- Serialize concurrent swaps: lock the tenant's primary links. A swap
  -- on a currently meterless tenant locks nothing; the overlap
  -- trigger + exclusion constraint still reject a concurrent double-open.
  PERFORM 1
  FROM tenant_devices
  WHERE tenant_id = p_tenant_id
    AND role = 'primary_consumption_meter'
  FOR UPDATE;

  -- Same-day links are corrections, not history: remove rather than close.
  DELETE FROM tenant_devices
  WHERE tenant_id = p_tenant_id
    AND role = 'primary_consumption_meter'
    AND effective_to IS NULL
    AND effective_from = p_effective_date;

  -- Close remaining open links at the boundary.
  UPDATE tenant_devices
  SET effective_to = p_effective_date
  WHERE tenant_id = p_tenant_id
    AND role = 'primary_consumption_meter'
    AND effective_to IS NULL;

  INSERT INTO tenant_devices (
    tenant_id, device_id, role, effective_from, effective_to
  )
  VALUES (
    p_tenant_id, p_device_id, 'primary_consumption_meter',
    p_effective_date, NULL
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$function$;


REVOKE EXECUTE ON FUNCTION fn_replace_tenant_device(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_replace_tenant_device(uuid, uuid, date) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION fn_record_line_item_with_audit(uuid, uuid, uuid, numeric, numeric, numeric, jsonb, numeric, billing_line_item_reading_source, uuid, text, uuid, jsonb, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_record_line_item_with_audit(uuid, uuid, uuid, numeric, numeric, numeric, jsonb, numeric, billing_line_item_reading_source, uuid, text, uuid, jsonb, uuid, text, text) TO authenticated, service_role;

-- 6. Activity view: same columns and order as 00011, with the new kind and
-- wording for a tenant's creation.
CREATE OR REPLACE VIEW microgrid_recent_activity
  WITH (security_invoker = true)
AS
  SELECT
    bp.microgrid_id,
    'period_opened'::TEXT AS kind,
    bp.created_at         AS timestamp,
    'Period opened: ' || bp.start_date::TEXT || ' – ' || bp.end_date::TEXT AS description
  FROM billing_periods bp

  UNION ALL

  SELECT
    bp.microgrid_id,
    'period_closed'::TEXT AS kind,
    bp.closed_at          AS timestamp,
    'Period closed: ' || bp.start_date::TEXT || ' – ' || bp.end_date::TEXT AS description
  FROM billing_periods bp
  WHERE bp.closed_at IS NOT NULL

  UNION ALL

  SELECT
    t.microgrid_id,
    'tenant_added'::TEXT AS kind,
    t.created_at         AS timestamp,
    'Tenant added: ' || t.display_name AS description
  FROM tenants t

  UNION ALL

  SELECT
    e.microgrid_id,
    'devices_discovered'::TEXT                                               AS kind,
    date_trunc('hour', d.created_at)                                         AS timestamp,
    'Discovered ' || COUNT(*)::TEXT || ' device(s) on ' || e.name            AS description
  FROM devices d
  JOIN edges e ON e.id = d.edge_id
  GROUP BY e.microgrid_id, e.name, date_trunc('hour', d.created_at)

ORDER BY timestamp DESC, kind ASC;
