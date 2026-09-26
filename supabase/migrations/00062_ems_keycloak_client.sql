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
