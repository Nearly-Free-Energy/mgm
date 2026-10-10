-- 00065_payments_capability.sql
-- Payment capability with Pesapal as MGM's first provider plugin.
--
-- Design (provider-neutral, per plan):
--   * `payment_merchant_accounts` — organization-default merchant accounts.
--     One row per (org_id, provider) is the org default when no community
--     override exists. `version` is bumped on every credential/config change
--     so attempts stay bound to the account configuration they started with.
--   * `community_payment_overrides` — optional per-community override.
--     Resolution is explicit: override row present → use it (a broken
--     override errors, never falls back to the org default); absent → org
--     default. Deleting the row restores the default.
--   * `payment_attempts` — immutable checkout attempts, written BEFORE
--     contacting the provider. Stores bill revision (total + line-item
--     updated_at), amount, currency, merchant account + version, and the
--     unique merchant reference. Provider tracking ids live here, separate
--     from `billing_line_items`.
--   * `payment_receipts` — verified receipt history, separate from the bill's
--     mutable amount. Idempotent on (attempt_id, provider_tracking_id,
--     provider_status).
--   * `payment_notifications` — raw provider notification receipts, persisted
--     BEFORE acknowledgement, processed idempotently with retry bookkeeping.
--
-- Compatibility:
--   * Existing `communities.payment_provider*` config is backfilled into
--     merchant accounts + overrides (no deletes, no history loss).
--   * Existing `billing_line_items.pesapal_order_id` values become
--     `payment_attempts` rows bound to the migrated account.
--   * Public payment URLs are preserved — `/api/billing-line-items/[id]/pay`
--     and `/p/<slug>` keep working; the stable MGM link resolves to the
--     current bill revision.
--
-- Plugin registration follows 00059/00063: widen the trusted-name CHECKs and
-- the `fn_mgm_set_plugin_enabled` whitelist to `payments` + `pesapal`.
-- Disabling either plugin stops new checkouts (application gate) but this
-- migration adds no trigger that deletes or blocks reads of history.
--
-- RLS: all five tables are org-scoped via `user_can_access_org(org_id)`,
-- chained through the existing helpers (never inline JOIN chains).
-- Grants mirror 00056: authenticated gets row-level access, service_role for
-- the webhook/worker path. SECURITY DEFINER functions revoke from anon.

-- ── 0. Plugin whitelist ─────────────────────────────────────────────────

ALTER TABLE mgm_plugins
  DROP CONSTRAINT IF EXISTS mgm_plugins_name_known;
ALTER TABLE mgm_plugins
  ADD CONSTRAINT mgm_plugins_name_known CHECK (
    plugin_name IN (
      'organization-directory',
      'community-management',
      'metering',
      'billing',
      'payments',
      'pesapal'
    )
  );

ALTER TABLE mgm_plugin_audit_log
  DROP CONSTRAINT IF EXISTS mgm_plugin_audit_log_plugin_known;
ALTER TABLE mgm_plugin_audit_log
  ADD CONSTRAINT mgm_plugin_audit_log_plugin_known CHECK (
    plugin_name IN (
      'organization-directory',
      'community-management',
      'metering',
      'billing',
      'payments',
      'pesapal'
    )
  );

CREATE OR REPLACE FUNCTION fn_mgm_set_plugin_enabled(
  _org_id UUID,
  _plugin_name TEXT,
  _plugin_version TEXT,
  _enabled BOOLEAN
)
RETURNS mgm_plugins
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous BOOLEAN;
  v_row mgm_plugins%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  IF NOT user_can_access_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized to change plugins for this organization'
      USING ERRCODE = '42501';
  END IF;

  IF _plugin_name NOT IN ('organization-directory', 'community-management', 'metering', 'billing', 'payments', 'pesapal') THEN
    RAISE EXCEPTION 'Unknown plugin: %', _plugin_name
      USING ERRCODE = 'P0001';
  END IF;

  IF _plugin_version IS NULL OR btrim(_plugin_version) = '' THEN
    RAISE EXCEPTION 'Plugin version is required'
      USING ERRCODE = 'P0001';
  END IF;

  IF _plugin_name = 'organization-directory' AND NOT _enabled THEN
    RAISE EXCEPTION 'organization-directory cannot be disabled'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT enabled INTO v_previous
  FROM mgm_plugins
  WHERE org_id = _org_id
    AND plugin_name = _plugin_name;

  INSERT INTO mgm_plugins (org_id, plugin_name, version, enabled)
  VALUES (_org_id, _plugin_name, btrim(_plugin_version), _enabled)
  ON CONFLICT (org_id, plugin_name)
  DO UPDATE SET
    version = EXCLUDED.version,
    enabled = EXCLUDED.enabled,
    updated_at = now()
  RETURNING * INTO v_row;

  INSERT INTO mgm_plugin_audit_log (
    org_id,
    plugin_name,
    action,
    previous_enabled,
    new_enabled,
    actor_user_id
  )
  VALUES (
    _org_id,
    _plugin_name,
    CASE WHEN _enabled THEN 'enabled' ELSE 'disabled' END,
    v_previous,
    _enabled,
    auth.uid()
  );

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_mgm_set_plugin_enabled(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_mgm_set_plugin_enabled(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;

-- ── 1. Merchant accounts (org defaults) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_merchant_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'pesapal',
  display_name TEXT NOT NULL DEFAULT 'Default Pesapal account',
  sandbox BOOLEAN NOT NULL DEFAULT TRUE,
  consumer_key TEXT NOT NULL DEFAULT '',
  secret_encrypted BYTEA,
  base_url TEXT NOT NULL DEFAULT '',
  ipn_id TEXT,
  ipn_url TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_tested_at TIMESTAMPTZ,
  last_test_status TEXT,
  last_test_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_merchant_accounts_provider_known CHECK (provider IN ('pesapal')),
  CONSTRAINT payment_merchant_accounts_test_status_known CHECK (
    last_test_status IS NULL OR last_test_status IN ('success', 'auth_failed', 'unreachable', 'register_ipn_failed', 'error')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_merchant_default_per_org
  ON payment_merchant_accounts (org_id, provider)
  WHERE display_name = 'Default Pesapal account';
CREATE INDEX IF NOT EXISTS idx_payment_merchant_accounts_org
  ON payment_merchant_accounts (org_id);

DROP TRIGGER IF EXISTS trg_payment_merchant_accounts_updated_at ON payment_merchant_accounts;
CREATE TRIGGER trg_payment_merchant_accounts_updated_at
  BEFORE UPDATE ON payment_merchant_accounts
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE payment_merchant_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_merchant_accounts_all ON payment_merchant_accounts;
CREATE POLICY payment_merchant_accounts_all ON payment_merchant_accounts FOR ALL
  USING (is_super_admin() OR user_can_access_org(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_merchant_accounts TO authenticated;
GRANT ALL ON payment_merchant_accounts TO service_role;

-- ── 2. Community overrides ──────────────────────────────────────────────
-- A row means "this community does NOT use the org default". A broken
-- override (missing/disabled account) must error, never silently fall back.

CREATE TABLE IF NOT EXISTS community_payment_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  merchant_account_id UUID REFERENCES payment_merchant_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (community_id)
);

CREATE INDEX IF NOT EXISTS idx_community_payment_overrides_org
  ON community_payment_overrides (org_id);
CREATE INDEX IF NOT EXISTS idx_community_payment_overrides_community
  ON community_payment_overrides (community_id);

DROP TRIGGER IF EXISTS trg_community_payment_overrides_updated_at ON community_payment_overrides;
CREATE TRIGGER trg_community_payment_overrides_updated_at
  BEFORE UPDATE ON community_payment_overrides
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE community_payment_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS community_payment_overrides_all ON community_payment_overrides;
CREATE POLICY community_payment_overrides_all ON community_payment_overrides FOR ALL
  USING (is_super_admin() OR user_can_access_org(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON community_payment_overrides TO authenticated;
GRANT ALL ON community_payment_overrides TO service_role;

-- ── 3. Payment attempts (immutable) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  line_item_id UUID NOT NULL REFERENCES billing_line_items(id) ON DELETE CASCADE,
  community_id UUID REFERENCES communities(id) ON DELETE SET NULL,
  merchant_account_id UUID REFERENCES payment_merchant_accounts(id) ON DELETE SET NULL,
  merchant_account_version INTEGER NOT NULL DEFAULT 1,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'UGX',
  bill_revision_total NUMERIC NOT NULL DEFAULT 0,
  bill_revision_updated_at TIMESTAMPTZ,
  merchant_reference TEXT NOT NULL UNIQUE,
  provider_tracking_id TEXT,
  provider TEXT NOT NULL DEFAULT 'pesapal',
  status TEXT NOT NULL DEFAULT 'pending',
  checkout_url TEXT,
  failure_code TEXT,
  failure_message TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolve_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_attempts_status_known CHECK (
    status IN ('pending', 'confirmation_pending', 'verified', 'failed', 'reversed', 'needs_reconciliation', 'resolved')
  )
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_org ON payment_attempts (org_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_line_item ON payment_attempts (line_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_merchant_ref ON payment_attempts (merchant_reference);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_tracking ON payment_attempts (provider_tracking_id)
  WHERE provider_tracking_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_payment_attempts_updated_at ON payment_attempts;
CREATE TRIGGER trg_payment_attempts_updated_at
  BEFORE UPDATE ON payment_attempts
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_attempts_all ON payment_attempts;
CREATE POLICY payment_attempts_all ON payment_attempts FOR ALL
  USING (is_super_admin() OR user_can_access_org(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_attempts TO authenticated;
GRANT ALL ON payment_attempts TO service_role;

-- ── 4. Payment receipts (verified history) ──────────────────────────────

CREATE TABLE IF NOT EXISTS payment_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  attempt_id UUID NOT NULL REFERENCES payment_attempts(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  provider TEXT NOT NULL DEFAULT 'pesapal',
  provider_status TEXT NOT NULL,
  provider_tracking_id TEXT,
  confirmation_code TEXT,
  payment_method TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, provider_tracking_id, provider_status)
);

CREATE INDEX IF NOT EXISTS idx_payment_receipts_org ON payment_receipts (org_id);
CREATE INDEX IF NOT EXISTS idx_payment_receipts_attempt ON payment_receipts (attempt_id, created_at);

ALTER TABLE payment_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_receipts_all ON payment_receipts;
CREATE POLICY payment_receipts_all ON payment_receipts FOR ALL
  USING (is_super_admin() OR user_can_access_org(org_id));

GRANT SELECT, INSERT ON payment_receipts TO authenticated;
GRANT ALL ON payment_receipts TO service_role;

-- ── 5. Payment notifications (raw inbox + retry) ────────────────────────

CREATE TABLE IF NOT EXISTS payment_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'pesapal',
  tracking_id TEXT NOT NULL,
  merchant_reference TEXT NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'received',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  processed_attempt_id UUID REFERENCES payment_attempts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, tracking_id),
  CONSTRAINT payment_notifications_status_known CHECK (
    status IN ('received', 'processed', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_payment_notifications_retry
  ON payment_notifications (status, next_retry_at)
  WHERE status IN ('received', 'failed');
CREATE INDEX IF NOT EXISTS idx_payment_notifications_ref
  ON payment_notifications (merchant_reference);

DROP TRIGGER IF EXISTS trg_payment_notifications_updated_at ON payment_notifications;
CREATE TRIGGER trg_payment_notifications_updated_at
  BEFORE UPDATE ON payment_notifications
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE payment_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_notifications_all ON payment_notifications;
CREATE POLICY payment_notifications_all ON payment_notifications FOR ALL
  USING (org_id IS NULL OR is_super_admin() OR user_can_access_org(org_id));

GRANT SELECT, INSERT, UPDATE ON payment_notifications TO authenticated;
GRANT ALL ON payment_notifications TO service_role;

-- ── 6. Legacy backfill (no deletes, history preserved) ──────────────────
-- Backfill org-default merchant accounts from communities.payment_provider
-- rows, then point community overrides at them, then materialize attempts
-- from billing_line_items.pesapal_order_id. All idempotent (NOT EXISTS /
-- ON CONFLICT DO NOTHING) so re-running the migration is safe.

-- 6a. One merchant account per org that has at least one configured community.
DO $$
DECLARE
  v_org RECORD;
  v_row RECORD;
BEGIN
  FOR v_org IN
    SELECT DISTINCT c.org_id
    FROM communities c
    WHERE c.payment_provider IS NOT NULL
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM payment_merchant_accounts p
      WHERE p.org_id = v_org.org_id AND p.provider = 'pesapal'
    ) THEN
      SELECT c.payment_provider_config, c.payment_provider_secret_encrypted
        INTO v_row
      FROM communities c
      WHERE c.org_id = v_org.org_id AND c.payment_provider IS NOT NULL
      ORDER BY c.payment_last_configured_at DESC NULLS LAST
      LIMIT 1;
      INSERT INTO payment_merchant_accounts (
        org_id, provider, display_name, sandbox, consumer_key,
        secret_encrypted, base_url, ipn_id, ipn_url,
        last_tested_at, last_test_status
      )
      VALUES (
        v_org.org_id,
        'pesapal',
        'Default Pesapal account',
        COALESCE((v_row.payment_provider_config->>'sandbox')::boolean, TRUE),
        COALESCE(v_row.payment_provider_config->>'consumer_key', ''),
        v_row.payment_provider_secret_encrypted,
        COALESCE(v_row.payment_provider_config->>'base_url', ''),
        v_row.payment_provider_config->>'ipn_id',
        NULL,
        now(),
        'success'
      )
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END;
$$;

-- 6b. Community overrides for every configured community.
INSERT INTO community_payment_overrides (org_id, community_id, merchant_account_id)
SELECT
  c.org_id,
  c.id,
  (
    SELECT p.id FROM payment_merchant_accounts p
    WHERE p.org_id = c.org_id AND p.provider = 'pesapal'
    ORDER BY p.created_at ASC
    LIMIT 1
  )
FROM communities c
WHERE c.payment_provider IS NOT NULL
ON CONFLICT (community_id) DO NOTHING;

-- 6c. Attempts from legacy pesapal_order_id references.
INSERT INTO payment_attempts (
  org_id, line_item_id, community_id, merchant_account_id,
  merchant_account_version, amount, currency,
  bill_revision_total, merchant_reference, provider,
  status, checkout_url
)
SELECT
  comm.org_id,
  li.id,
  mg.community_id,
  (
    SELECT p.id FROM payment_merchant_accounts p
    WHERE p.org_id = comm.org_id AND p.provider = 'pesapal'
    ORDER BY p.created_at ASC
    LIMIT 1
  ),
  1,
  li.total_amount,
  COALESCE(mg.currency, 'UGX'),
  li.total_amount,
  li.pesapal_order_id,
  'pesapal',
  'pending',
  li.pesapal_redirect_url
FROM billing_line_items li
JOIN billing_periods bp ON bp.id = li.billing_period_id
JOIN microgrids mg ON mg.id = bp.microgrid_id
JOIN communities comm ON comm.id = mg.community_id
WHERE li.pesapal_order_id IS NOT NULL
ON CONFLICT (merchant_reference) DO NOTHING;

-- ── 7. Secret accessor + reconciliation helper ──────────────────────────
-- `fn_get_payment_merchant_secret` mirrors `fn_get_community_payment_secret`
-- semantics but for the new merchant-account rows. Reuses the existing
-- envelope mechanism (same DEK via `fn_ems_decrypt_secret`): no new Vault
-- secret, no new rotation surface. Service-role only — the application
-- performs the RLS row read on the caller client first (authorize), then
-- decrypts on the service client (see infrastructure/supabase-repository.ts).
-- Withdrawing `authenticated` matches 00049; the clauses are re-issued so
-- this migration is self-contained regardless of apply order.

CREATE OR REPLACE FUNCTION fn_get_payment_merchant_secret(_account_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ciphertext BYTEA;
BEGIN
  IF NOT (auth.role() = 'service_role') THEN
    RETURN NULL;
  END IF;

  SELECT secret_encrypted INTO v_ciphertext
  FROM payment_merchant_accounts
  WHERE id = _account_id
  LIMIT 1;

  IF v_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN fn_ems_decrypt_secret(v_ciphertext);
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_get_payment_merchant_secret(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_get_payment_merchant_secret(UUID) TO service_role;

-- Next notification due for retry (received/failed and past next_retry_at).
-- Service-role/worker path; authenticated callers are still RLS-gated by
-- the table policy. Explicit anon revoke per migration conventions.

CREATE OR REPLACE FUNCTION fn_payment_due_notifications(_limit INTEGER DEFAULT 50)
RETURNS SETOF payment_notifications
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT *
  FROM payment_notifications
  WHERE status IN ('received', 'failed')
    AND next_retry_at <= now()
  ORDER BY next_retry_at ASC
  LIMIT COALESCE(_limit, 50);
$$;

REVOKE EXECUTE ON FUNCTION fn_payment_due_notifications(INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_payment_due_notifications(INTEGER) TO authenticated, service_role;
