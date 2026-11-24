-- Remove the customer-app integration's database objects.
--
-- Tenants see their own usage in MGM's tenant app (RFC #197), and the
-- separate customer app that called the /api/v1 routes with an organization
-- API token is retired. Its routes, the token routes and the Settings › API
-- tokens page are removed in the same change as this migration. This drops
-- what only they used:
--
--   1. customerapp_enabled_for_org(UUID) (00044, grants from 00047 and
--      20261114230100), the per-organization opt-in check.
--   2. organizations.customerapp_enabled (00044, 20261114230100), the opt-in
--      itself.
--   3. org_api_tokens (00042, policies from 00043, grants from
--      20261114222000 and 20261114230100), with its policies and indexes,
--      which go with the table. No trigger, view or other function refers to
--      it or to the column; neither drop uses CASCADE, so one added since
--      stops this migration instead of going with them.
--
-- Kept, because existing rows may use them:
--
--   * 'customerapp' in the actor_kind CHECKs on billing_audit_log and
--     payment_events (00041, 00064). Audit rows written by the customer app
--     keep it; the CHECKs still accept it, and nothing writes it any more.
--   * token_generated, token_revoked and token_regenerated in
--     billing_audit_event_type (00041), the events of the token page. Postgres
--     cannot drop an enum value.
--   * billing_audit_log.org_id and billing_audit_log_scope_consistency
--     (00043), which scope those token rows to their organization.
--
-- IF EXISTS on each drop, as 20261114230100 created these objects with
-- IF NOT EXISTS for databases that already had them.

-- ── 1. The opt-in check ─────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.customerapp_enabled_for_org(UUID);

-- ── 2. The opt-in ───────────────────────────────────────────────────────────
ALTER TABLE public.organizations DROP COLUMN IF EXISTS customerapp_enabled;

-- ── 3. Organization API tokens ──────────────────────────────────────────────
DROP TABLE IF EXISTS public.org_api_tokens;
