-- The days a unit's primary meter is also another unit's primary (D12 on
-- mgm#217), read by the tenant app's usage source with the tenant's own
-- session (mgm#225).
--
-- The tenant app shows a meter that is the primary of two units on the
-- same day to each of them, labelled "Shared with another unit, not only
-- yours". The days come from this function, which
-- the tenant's own client calls. It is granted to authenticated and lives
-- in public, so a tenant can also call it directly through PostgREST:
-- every row it returns is the tenant's to read, whatever the views show,
-- and a new column, a wider range or a count is a disclosure to the
-- tenant. If any of that changes, revisit CLAUDE.md "The tenant app's
-- usage reads" first.
--
--   - It answers only the tenant who holds the unit (user_can_access_tenant),
--     and only while the tenant-app plugin is on for the unit's
--     organization (mgm_plugin_enabled_for_org, the check composeTenantApp
--     makes): what it returns is derived from other units' links and
--     exists only for the tenant app. Staff, another unit's tenant, the
--     service role (auth.uid() is NULL), an unknown unit and a unit whose
--     organization has the app off all get the same 42501, so the answer
--     says neither which ids are units nor the plugin's state. If
--     mgm_plugin_enabled_for_org gains an access check, this caller is a
--     tenant too (auth.uid() is the tenant's inside this function).
--   - It takes no device ids: it reads the unit's own links itself, the
--     primary_consumption_meter links to consumption_meter devices. These
--     are USAGE_METER_ROLE and USAGE_DEVICE_TYPE in
--     src/lib/tenant-app/types.ts and the meter billing bills the unit
--     for; if either changes, change this function with it, in a new
--     migration.
--   - Every other unit's primary link of the meter counts, whatever
--     microgrid that unit is on (Hillary on mgm#228). Billing bills each
--     unit that holds the meter as its primary, so a co-holder on another
--     microgrid shares the meter's use as much as one on this microgrid,
--     and a day missed here would show shared use as the unit's own, which
--     D12 forbids. The answer tells the tenant only a date span on their
--     own meter, never which unit or which microgrid. A secondary link never
--     counts, on either side.
--   - It answers for the unit's links in the range whenever they were made,
--     including days before this tenant was given access to the unit. Those
--     links are already the tenant's to read (the tenant_devices policy for
--     tenants), and the days returned are a subset of them. If a tenant
--     should ever see only the days since their access began, cut the
--     range here, and in the views with it.
--   - The range ends at the database's UTC date + 2 at the latest. The
--     views never label a day after the microgrid's today (the home asks
--     [today, today + 1); the month and the day label only days that have
--     a figure), and no time zone's today + 1 is past UTC's date + 2. The
--     date is taken in UTC, not the session's TimeZone, which a PostgREST
--     caller can set. Non-finite dates are refused.
--   - It returns a device id and a date span, half-open like the links
--     (00058): per device, the days that are this unit's own link days, in
--     the range, and another such unit's primary-link days, merged, so
--     neither which unit nor how many units hold the meter, nor where
--     their links start or end outside the unit's own days, is returned.
--     effective_to is never NULL.
--
-- Running release: additive. The release before this one never calls this
-- function. Apply this migration before deploying the release that calls
-- it, and roll that release back before dropping it: without it that
-- release's tenant views answer tenant_app_unavailable.

CREATE OR REPLACE FUNCTION public.fn_tenant_shared_meter_days(
  _tenant_id UUID,
  _from_date DATE,
  _to_date DATE
)
RETURNS TABLE (device_id UUID, effective_from DATE, effective_to DATE)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_microgrid UUID;
  v_org UUID;
  v_to DATE;
BEGIN
  IF _tenant_id IS NULL OR _from_date IS NULL OR _to_date IS NULL
     OR NOT isfinite(_from_date) OR NOT isfinite(_to_date)
     OR _from_date >= _to_date THEN
    RAISE EXCEPTION 'A unit and a finite date range that is not empty are required.'
      USING ERRCODE = '22023';
  END IF;

  SELECT t.microgrid_id, c.org_id
  INTO v_microgrid, v_org
  FROM tenants t
  JOIN microgrids m ON m.id = t.microgrid_id
  JOIN communities c ON c.id = m.community_id
  WHERE t.id = _tenant_id;

  IF v_microgrid IS NULL
     OR NOT user_can_access_tenant(_tenant_id)
     OR NOT mgm_plugin_enabled_for_org(v_org, 'tenant-app') THEN
    RAISE EXCEPTION 'You do not have access to this unit.'
      USING ERRCODE = '42501';
  END IF;

  v_to := LEAST(_to_date, (now() AT TIME ZONE 'UTC')::date + 2);
  IF _from_date >= v_to THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH own AS (
    -- The unit's own primary consumption-meter links, cut to the range.
    SELECT td.device_id,
           daterange(td.effective_from, td.effective_to, '[)')
             * daterange(_from_date, v_to, '[)') AS days
    FROM tenant_devices td
    JOIN devices d ON d.id = td.device_id
    WHERE td.tenant_id = _tenant_id
      AND td.role = 'primary_consumption_meter'
      AND d.device_type = 'consumption_meter'
      AND daterange(td.effective_from, td.effective_to, '[)')
            && daterange(_from_date, v_to, '[)')
  ),
  shared AS (
    -- Every other unit's primary links of the same devices, on any
    -- microgrid, cut to the unit's own days.
    SELECT o.device_id,
           o.days * daterange(other.effective_from, other.effective_to, '[)') AS days
    FROM own o
    JOIN tenant_devices other ON other.device_id = o.device_id
    WHERE other.role = 'primary_consumption_meter'
      AND other.tenant_id <> _tenant_id
      AND daterange(other.effective_from, other.effective_to, '[)') && o.days
  )
  SELECT s.device_id, lower(span.days), upper(span.days)
  FROM (
    SELECT shared.device_id, range_agg(shared.days) AS spans
    FROM shared
    GROUP BY shared.device_id
  ) s
  CROSS JOIN LATERAL unnest(s.spans) AS span(days)
  ORDER BY 1, 2;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_tenant_shared_meter_days(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_tenant_shared_meter_days(UUID, DATE, DATE) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_tenant_shared_meter_days(UUID, DATE, DATE) IS
  'The days of [_from_date, _to_date), ending at UTC''s date + 2 at the latest, on which a primary consumption meter of the caller''s own unit is also the primary of another unit, on any microgrid (D12 on mgm#217, mgm#228): device id and merged half-open date spans, never which unit or how many. It answers for the unit's links in the range, including days before the caller was given access, since those links are already the caller's to read. Callable by the tenant directly through PostgREST, so every row is the tenant''s to read; a new column, a wider range or a count is a disclosure. Refuses (42501) anyone user_can_access_tenant does not answer for, the service role included, and any unit whose organization has the tenant-app plugin off. Its role and device type are USAGE_METER_ROLE and USAGE_DEVICE_TYPE in src/lib/tenant-app/types.ts; if those change, change this function in a new migration.';
