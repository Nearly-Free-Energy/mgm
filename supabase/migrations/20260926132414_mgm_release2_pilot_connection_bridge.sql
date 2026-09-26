-- Forward bridge for the curated MGM pilot: preserve existing data and
-- legacy edge columns; install only OpenEMS configuration prerequisites.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'mbe_ems_dek') THEN
    IF coalesce(current_setting('app.ems_dek_bootstrap', true), '') = '' THEN
      RAISE EXCEPTION 'Explicit production DEK bootstrap required before applying the pilot connection bridge';
    END IF;
    PERFORM vault.create_secret(current_setting('app.ems_dek_bootstrap'), 'mbe_ems_dek', 'MGM OpenEMS credential encryption key');
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION fn_ems_encrypt_secret(p_plaintext TEXT)
RETURNS BYTEA
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dek TEXT;
BEGIN
  IF p_plaintext IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO v_dek
  FROM vault.decrypted_secrets
  WHERE name = 'mbe_ems_dek'
  LIMIT 1;

  IF v_dek IS NULL THEN
    RAISE EXCEPTION 'mbe_ems_dek not found in Vault. Run 00018 migration with app.ems_dek_bootstrap GUC set.'
      USING ERRCODE = '55000';
  END IF;

  RETURN extensions.pgp_sym_encrypt(p_plaintext, v_dek);
END;
$$;

CREATE OR REPLACE FUNCTION fn_ems_decrypt_secret(p_ciphertext BYTEA)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dek TEXT;
BEGIN
  IF p_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO v_dek
  FROM vault.decrypted_secrets
  WHERE name = 'mbe_ems_dek'
  LIMIT 1;

  IF v_dek IS NULL THEN
    RAISE EXCEPTION 'mbe_ems_dek not found in Vault. Cannot decrypt OpenEMS secret.'
      USING ERRCODE = '55000';
  END IF;

  -- pgp_sym_decrypt throws on mismatched key or corrupted input; let it propagate.
  RETURN extensions.pgp_sym_decrypt(p_ciphertext, v_dek);
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'microgrid_ems_type') THEN
    CREATE TYPE microgrid_ems_type AS ENUM ('cloud_aws', 'direct_url');
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. Add ems_* columns to microgrids.
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE microgrids
  ADD COLUMN IF NOT EXISTS ems_type microgrid_ems_type,
  ADD COLUMN IF NOT EXISTS ems_backend_url TEXT,
  ADD COLUMN IF NOT EXISTS ems_aws_region TEXT,
  ADD COLUMN IF NOT EXISTS ems_aws_access_key_id TEXT,
  ADD COLUMN IF NOT EXISTS ems_aws_secret_access_key_encrypted BYTEA,
  ADD COLUMN IF NOT EXISTS ems_last_discover_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ems_last_discover_status TEXT,
  ADD COLUMN IF NOT EXISTS ems_last_discover_error TEXT,
  ADD COLUMN IF NOT EXISTS ems_last_discover_count INT;

-- Named CHECK constraints (AC-SCHEMA-3). Drop-if-exists for idempotency.

ALTER TABLE microgrids DROP CONSTRAINT IF EXISTS microgrids_ems_backend_url_required;
ALTER TABLE microgrids
  ADD CONSTRAINT microgrids_ems_backend_url_required
  CHECK (
    ems_type IS NULL
    OR (ems_backend_url IS NOT NULL AND length(btrim(ems_backend_url)) > 0)
  );

ALTER TABLE microgrids DROP CONSTRAINT IF EXISTS microgrids_ems_aws_fields_required;
ALTER TABLE microgrids
  ADD CONSTRAINT microgrids_ems_aws_fields_required
  CHECK (
    ems_type IS DISTINCT FROM 'cloud_aws'
    OR (
      ems_aws_region IS NOT NULL
      AND ems_aws_access_key_id IS NOT NULL
      AND ems_aws_secret_access_key_encrypted IS NOT NULL
    )
  );

ALTER TABLE microgrids DROP CONSTRAINT IF EXISTS microgrids_ems_last_discover_status_valid;
ALTER TABLE microgrids
  ADD CONSTRAINT microgrids_ems_last_discover_status_valid
  CHECK (
    ems_last_discover_status IS NULL
    OR ems_last_discover_status IN ('success', 'auth_failed', 'unreachable', 'zero_edges', 'unknown_error')
  );

CREATE OR REPLACE FUNCTION fn_get_ems_secret(_microgrid_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ciphertext BYTEA;
  v_is_super BOOLEAN;
  v_is_service BOOLEAN;
BEGIN
  -- service_role (server-side internal path) gets plaintext.
  -- auth.role() returns 'authenticated' for user-bound, 'anon' for unauth,
  -- 'service_role' for service-role calls.
  v_is_service := (auth.role() = 'service_role');

  v_is_super := is_super_admin();

  -- Redact if caller is neither super_admin nor service_role (org_manager,
  -- anon, etc.) — return NULL without leaking existence info.
  IF NOT v_is_super AND NOT v_is_service THEN
    RETURN NULL;
  END IF;

  SELECT ems_aws_secret_access_key_encrypted INTO v_ciphertext
  FROM microgrids
  WHERE id = _microgrid_id
  LIMIT 1;

  IF v_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN fn_ems_decrypt_secret(v_ciphertext);
END;
$$;


REVOKE EXECUTE ON FUNCTION fn_ems_encrypt_secret(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_ems_encrypt_secret(TEXT) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION fn_ems_decrypt_secret(BYTEA) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_ems_decrypt_secret(BYTEA) TO service_role;
REVOKE EXECUTE ON FUNCTION fn_get_ems_secret(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_get_ems_secret(UUID) TO service_role;
-- Migration 00019: Add ems_known_edge_ids column to microgrids (#112)
--
-- Rationale: the B2B REST surface of OpenEMS does not expose a catalog-listing
-- method — getEdgesStatus([]) returns {} on real backends. The super_admin
-- knows their edge IDs from the OpenEMS setup script. We store them
-- explicitly so Save & test can validate each via getEdgesStatus([...ids])
-- and the Discover route can pass the persisted list instead of [].
--
-- NOT NULL DEFAULT '{}': the column always has a value; "not configured" is
-- still signalled by ems_type IS NULL. No code path should key off
-- ems_known_edge_ids IS NULL.
--
-- Idempotency: all statements are guarded with IF NOT EXISTS / DROP...IF EXISTS
-- so re-running this migration is safe.

ALTER TABLE microgrids
  ADD COLUMN IF NOT EXISTS ems_known_edge_ids TEXT[] NOT NULL DEFAULT '{}';

-- Named CHECK constraint: every element must be non-empty after trim.
-- Pattern mirrors microgrids_ems_backend_url_required in migration 00018
-- (lines 265-271).
--
-- Implementation note: PostgreSQL does not allow subqueries in CHECK
-- constraints (PG error 0A000). We enforce the invariant via a helper
-- function (IMMUTABLE, SECURITY INVOKER) instead.
ALTER TABLE microgrids DROP CONSTRAINT IF EXISTS microgrids_ems_known_edge_ids_nonempty_strings;

CREATE OR REPLACE FUNCTION fn_edge_ids_all_nonempty(ids TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT
    CASE WHEN cardinality(ids) = 0 THEN TRUE
         ELSE '' != ALL(array(SELECT btrim(e) FROM unnest(ids) e))
    END;
$$;

GRANT EXECUTE ON FUNCTION fn_edge_ids_all_nonempty(TEXT[])
  TO anon, authenticated, service_role;

ALTER TABLE microgrids
  ADD CONSTRAINT microgrids_ems_known_edge_ids_nonempty_strings
  CHECK (fn_edge_ids_all_nonempty(ems_known_edge_ids));
ALTER TABLE public.microgrids
  ADD COLUMN IF NOT EXISTS ems_basic_auth_username TEXT,
  ADD COLUMN IF NOT EXISTS ems_basic_auth_password_encrypted BYTEA;

COMMENT ON COLUMN public.microgrids.ems_basic_auth_username IS
  'HTTP Basic username for direct_url mode (#327). Plaintext — an identifier, not a secret.';

COMMENT ON COLUMN public.microgrids.ems_basic_auth_password_encrypted IS
  'HTTP Basic password for direct_url mode (#327), pgp_sym_encrypt output under the Vault DEK. Read only via fn_get_ems_basic_auth_password (service_role).';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Guard function — both new columns added to the value-level checks
CREATE OR REPLACE FUNCTION public.fn_get_ems_basic_auth_password(_microgrid_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ciphertext BYTEA;
BEGIN
  IF NOT (auth.role() = 'service_role' OR user_can_access_microgrid(_microgrid_id)) THEN
    RETURN NULL;
  END IF;

  SELECT ems_basic_auth_password_encrypted INTO v_ciphertext
    FROM microgrids
    WHERE id = _microgrid_id
    LIMIT 1;

  IF v_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN fn_ems_decrypt_secret(v_ciphertext);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_get_ems_basic_auth_password(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_get_ems_basic_auth_password(UUID) TO service_role;
ALTER TABLE public.microgrids
  ADD COLUMN IF NOT EXISTS ems_bearer_token_encrypted BYTEA;

COMMENT ON COLUMN public.microgrids.ems_bearer_token_encrypted IS
  'Keycloak bearer token for direct_url mode (issue #4), pgp_sym_encrypt output under the Vault DEK. Read only via fn_get_ems_bearer_token (service_role).';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Guard function — new column added to the value-level checks
CREATE OR REPLACE FUNCTION public.fn_get_ems_bearer_token(_microgrid_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ciphertext BYTEA;
BEGIN
  IF NOT (auth.role() = 'service_role' OR user_can_access_microgrid(_microgrid_id)) THEN
    RETURN NULL;
  END IF;

  SELECT ems_bearer_token_encrypted INTO v_ciphertext
    FROM microgrids
    WHERE id = _microgrid_id
    LIMIT 1;

  IF v_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN fn_ems_decrypt_secret(v_ciphertext);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_get_ems_bearer_token(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_get_ems_bearer_token(UUID) TO service_role;
-- 00062_ems_keycloak_client.sql
-- Release 2 (issue #4): Keycloak client-credentials for direct_url backends.
--
-- Storing a manually supplied bearer token (00061) unblocks the initial
-- test, but access stops when the token expires. A Keycloak confidential
-- client lets the server obtain and refresh access tokens itself via the
-- OAuth2 client-credentials grant, so the dedicated account keeps working
-- without operator intervention. Static bearer tokens remain supported for
-- backends without client-credentials; the read-time precedence
-- (Keycloak-auto, then static token, then Basic, then none) lives in
-- src/lib/openems/config.ts.
--
-- Contents (mirrors 00054/00061):
--   1. Three columns: token endpoint URL + client id (plaintext
--      identifiers, like the Basic username) and client secret
--      (DEK-encrypted BYTEA, like every other stored secret).
--   2. Guard function re-issued with all three columns in the value checks.
--      The token endpoint URL is guarded too: it decides where the client
--      secret is sent, so changing it is changing the credential's blast
--      radius, not a cosmetic edit.
--   3. Trigger re-issued with all three columns in BEFORE UPDATE OF
--      (conditional creation — see 00061's note on pilot-curated databases,
--      which lack the ems_* column family).
--   4. fn_get_ems_keycloak_client_secret() — service-role-only read.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Columns
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.microgrids
  ADD COLUMN IF NOT EXISTS ems_keycloak_token_url TEXT,
  ADD COLUMN IF NOT EXISTS ems_keycloak_client_id TEXT,
  ADD COLUMN IF NOT EXISTS ems_keycloak_client_secret_encrypted BYTEA;

COMMENT ON COLUMN public.microgrids.ems_keycloak_token_url IS
  'Keycloak token endpoint URL for direct_url client-credentials (issue #4), e.g. https://keycloak.example/realms/energy/protocol/openid-connect/token. Plaintext — an identifier, not a secret.';
COMMENT ON COLUMN public.microgrids.ems_keycloak_client_id IS
  'Keycloak confidential-client id for direct_url client-credentials (issue #4). Plaintext — an identifier, not a secret.';
COMMENT ON COLUMN public.microgrids.ems_keycloak_client_secret_encrypted IS
  'Keycloak client secret for direct_url client-credentials (issue #4), pgp_sym_encrypt output under the Vault DEK. Read only via fn_get_ems_keycloak_client_secret (service_role).';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Guard function — three new columns in the value-level checks
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_microgrids_guard_ems_config()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF session_user IN ('postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF (NEW.ems_type                            IS DISTINCT FROM OLD.ems_type)
     OR (NEW.ems_backend_url                  IS DISTINCT FROM OLD.ems_backend_url)
     OR (NEW.ems_aws_region                   IS DISTINCT FROM OLD.ems_aws_region)
     OR (NEW.ems_aws_access_key_id            IS DISTINCT FROM OLD.ems_aws_access_key_id)
     OR (NEW.ems_aws_secret_access_key_encrypted
                                              IS DISTINCT FROM OLD.ems_aws_secret_access_key_encrypted)
     OR (NEW.ems_basic_auth_username          IS DISTINCT FROM OLD.ems_basic_auth_username)
     OR (NEW.ems_basic_auth_password_encrypted
                                              IS DISTINCT FROM OLD.ems_basic_auth_password_encrypted)
     OR (NEW.ems_bearer_token_encrypted       IS DISTINCT FROM OLD.ems_bearer_token_encrypted)
     OR (NEW.ems_keycloak_token_url           IS DISTINCT FROM OLD.ems_keycloak_token_url)
     OR (NEW.ems_keycloak_client_id           IS DISTINCT FROM OLD.ems_keycloak_client_id)
     OR (NEW.ems_keycloak_client_secret_encrypted
                                              IS DISTINCT FROM OLD.ems_keycloak_client_secret_encrypted)
     OR (NEW.ems_known_edge_ids               IS DISTINCT FROM OLD.ems_known_edge_ids)
  THEN
    IF NOT user_can_access_microgrid(NEW.id) THEN
      RAISE EXCEPTION
        'You do not have permission to configure the OpenEMS connection for this microgrid.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Trigger — three new columns in the statement-level filter
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Conditional creation, same as 00061: pilot-curated databases lack the
-- ems_* column family, so an unconditional CREATE TRIGGER fails there
-- with 42703. The function above is safe to (re)define unconditionally.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'microgrids'
      AND column_name IN (
        'ems_type',
        'ems_backend_url',
        'ems_aws_region',
        'ems_aws_access_key_id',
        'ems_aws_secret_access_key_encrypted',
        'ems_basic_auth_username',
        'ems_basic_auth_password_encrypted',
        'ems_bearer_token_encrypted',
        'ems_keycloak_token_url',
        'ems_keycloak_client_id',
        'ems_keycloak_client_secret_encrypted',
        'ems_known_edge_ids'
      )
    HAVING COUNT(*) = 12
  ) THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_microgrids_guard_ems_config ON public.microgrids';
    EXECUTE 'CREATE TRIGGER trg_microgrids_guard_ems_config
      BEFORE UPDATE OF
        ems_type,
        ems_backend_url,
        ems_aws_region,
        ems_aws_access_key_id,
        ems_aws_secret_access_key_encrypted,
        ems_basic_auth_username,
        ems_basic_auth_password_encrypted,
        ems_bearer_token_encrypted,
        ems_keycloak_token_url,
        ems_keycloak_client_id,
        ems_keycloak_client_secret_encrypted,
        ems_known_edge_ids
      ON public.microgrids
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_microgrids_guard_ems_config()';
  ELSE
    RAISE NOTICE 'keycloak client: ems_* column family incomplete — skipping guard trigger creation.';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_config() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_config() TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Client-secret read — service_role only
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Same shape and grants as fn_get_ems_bearer_token (00061): the body's
-- permission gate is kept for the hypothetical widened-grant future, but
-- the grant is the control today. Callers MUST go through the sibling
-- getter in src/lib/openems/config.ts (authorize on the caller's
-- RLS-evaluated client first, decrypt second).

CREATE OR REPLACE FUNCTION public.fn_get_ems_keycloak_client_secret(_microgrid_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ciphertext BYTEA;
BEGIN
  IF NOT (auth.role() = 'service_role' OR user_can_access_microgrid(_microgrid_id)) THEN
    RETURN NULL;
  END IF;

  SELECT ems_keycloak_client_secret_encrypted INTO v_ciphertext
    FROM microgrids
    WHERE id = _microgrid_id
    LIMIT 1;

  IF v_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN fn_ems_decrypt_secret(v_ciphertext);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_get_ems_keycloak_client_secret(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_get_ems_keycloak_client_secret(UUID) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_list_ems_operators(_microgrid_id UUID)
RETURNS TABLE (
  user_id      UUID,
  display_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    ur.user_id,
    COALESCE(
      NULLIF(TRIM(CONCAT_WS(' ', up.first_name, up.last_name)), ''),
      au.email
    )::TEXT AS display_name
  FROM microgrids m
  JOIN communities c   ON c.id = m.community_id
  JOIN user_roles  ur  ON ur.role = 'org_manager'
                      AND ur.scope_type = 'org'
                      AND ur.scope_id = c.org_id
  JOIN auth.users  au  ON au.id = ur.user_id
  LEFT JOIN user_profiles up ON up.user_id = ur.user_id
  WHERE user_can_access_microgrid(_microgrid_id)
    AND m.id = _microgrid_id
  ORDER BY 2, au.email;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_list_ems_operators(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_ems_operators(UUID) TO authenticated, service_role;
-- Retain legacy edge metadata, but registration no longer needs an edge URL.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='edges' AND column_name='data_source_type') THEN
    ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_openems_fields_required;
    ALTER TABLE edges ADD CONSTRAINT edges_openems_fields_required
      CHECK (data_source_type != 'openems' OR openems_edge_id IS NOT NULL);
  END IF;
END $$;
-- The curated pilot omitted 00052's organization-role cascade FK.
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS scope_org_id UUID
  GENERATED ALWAYS AS (CASE WHEN scope_type = 'org' THEN scope_id END) STORED;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.user_roles'::regclass AND conname='user_roles_scope_org_fkey') THEN
    ALTER TABLE user_roles ADD CONSTRAINT user_roles_scope_org_fkey
      FOREIGN KEY (scope_org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Organization deletion is already a released, explicitly authorized action.
GRANT DELETE ON organizations TO authenticated;
