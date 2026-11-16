-- Organization email senders (RFC #186, PR 1).
--
-- One optional row per organization: the mail server that sends the
-- organization's notices (invitations now, billing mail later). It never
-- sends a sign-in link or code; those go only through the deployment's own
-- sender (#186 decision 5), so nothing here is read before a session exists.
-- Owned by the organization-directory plugin (src/lib/plugins/bundled.ts).
--
-- The password is stored encrypted with the credential key, like the
-- payment merchant secret (docs/runbooks/dek.md lists the column).
--
-- Who writes what:
--
--   * Only the service role inserts or updates a row. `authenticated` gets
--     no INSERT or UPDATE grant at all: the settings route
--     (PUT /api/organizations/[id]/email-sender) checks org access with
--     currentUserCanAccessOrg, sends a test email, and only then saves on
--     the service client. Without the grant there is nothing for a trigger
--     to guard against signed-in writers.
--   * `authenticated` may SELECT every column except `password_encrypted`
--     (column-level grant), and DELETE, both filtered by RLS. A query that
--     names the password column, or `*`, is refused.
--   * A saved password stays with the server and username it was entered
--     for: an UPDATE that changes host, port or username must also write a
--     new password. This applies to the service role too: it describes the
--     row, not who may write it. Migrations run as postgres or
--     supabase_admin are exempt.
--
-- RLS: one FOR ALL policy through user_can_access_org, so org managers of
-- the organization and super admins see and delete it. Helpers unchanged.
--
-- Deleting an organization deletes its sender (ON DELETE CASCADE).
-- Idempotent: safe to run twice.

-- ── 1. Table ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organization_email_senders (
  org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  password_encrypted BYTEA NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT,
  reply_to TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  last_tested_at TIMESTAMPTZ,
  last_test_status TEXT,
  last_test_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 465 is TLS from the first byte; 587 must upgrade with STARTTLS. The
  -- application refuses plaintext on both (src/lib/email/smtp/transport.ts).
  CONSTRAINT organization_email_senders_port_known CHECK (port IN (465, 587)),
  -- A lowercase DNS name, never an address literal: TLS checks the
  -- certificate against it (src/lib/email/smtp/address.ts).
  CONSTRAINT organization_email_senders_host_shape CHECK (
    host = lower(host)
    AND host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    AND host !~ '^[0-9.]+$'
  ),
  CONSTRAINT organization_email_senders_test_status_known CHECK (
    last_test_status IS NULL
    OR last_test_status IN ('success', 'auth_failed', 'unreachable', 'tls_failed', 'rejected', 'refused_address', 'error')
  )
);

DROP TRIGGER IF EXISTS trg_organization_email_senders_updated_at ON organization_email_senders;
CREATE TRIGGER trg_organization_email_senders_updated_at
  BEFORE UPDATE ON organization_email_senders
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_updated_at();

-- ── 2. A saved password stays with its server and username ─────────────

CREATE OR REPLACE FUNCTION public.fn_organization_email_senders_guard_password()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF session_user IN ('postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF (NEW.host IS DISTINCT FROM OLD.host
      OR NEW.port IS DISTINCT FROM OLD.port
      OR NEW.username IS DISTINCT FROM OLD.username)
     AND NEW.password_encrypted IS NOT DISTINCT FROM OLD.password_encrypted
  THEN
    RAISE EXCEPTION
      'Enter the password again when the mail server or username changes.'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_organization_email_senders_guard_password() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_organization_email_senders_guard_password() TO service_role;

DROP TRIGGER IF EXISTS trg_organization_email_senders_guard_password ON organization_email_senders;
CREATE TRIGGER trg_organization_email_senders_guard_password
  BEFORE UPDATE OF host, port, username, password_encrypted ON organization_email_senders
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_organization_email_senders_guard_password();

-- ── 3. RLS and grants ───────────────────────────────────────────────────

ALTER TABLE organization_email_senders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organization_email_senders_all ON organization_email_senders;
CREATE POLICY organization_email_senders_all ON organization_email_senders FOR ALL
  USING (user_can_access_org(org_id))
  WITH CHECK (user_can_access_org(org_id));

REVOKE ALL ON organization_email_senders FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  org_id, host, port, username, from_address, from_name, reply_to, version,
  last_tested_at, last_test_status, last_test_message, created_at, updated_at
) ON organization_email_senders TO authenticated;
GRANT DELETE ON organization_email_senders TO authenticated;
GRANT ALL ON organization_email_senders TO service_role;

-- ── 4. The saved password, for the service role only ───────────────────
--
-- SECURITY INVOKER: it runs as the service role, which may already execute
-- fn_ems_decrypt_secret (00049); the function only saves the route reading
-- the ciphertext itself.

CREATE OR REPLACE FUNCTION public.fn_organization_email_sender_password(_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ciphertext BYTEA;
BEGIN
  SELECT password_encrypted INTO v_ciphertext
  FROM organization_email_senders
  WHERE org_id = _org_id;

  IF v_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN fn_ems_decrypt_secret(v_ciphertext);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_organization_email_sender_password(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_organization_email_sender_password(UUID) TO service_role;
