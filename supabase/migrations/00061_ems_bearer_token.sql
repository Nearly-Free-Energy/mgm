-- 00061_ems_bearer_token.sql
-- Release 2 (issue #4): Keycloak token authentication for direct_url backends.
--
-- The plugin spoke HTTP Basic only. Backends fronted by Keycloak issue a
-- bearer token for the dedicated MGM account instead, so compatibility with
-- that account could never be confirmed. This migration adds an OPTIONAL
-- bearer-token credential to the existing `direct_url` mode — not a third
-- `ems_type` value (`ALTER TYPE … ADD VALUE` cannot be undone; see 00054's
-- rationale, which applies verbatim).
--
-- Contents (mirrors 00054 §1–4):
--   1. One column: token (DEK-encrypted BYTEA). No plaintext identifier is
--      needed — unlike Basic's username, nothing renders "configured as
--      <token>". Presence is probed with a COUNT, never by selecting the
--      ciphertext.
--   2. Guard function re-issued with the column in the value-level checks.
--   3. Trigger re-issued with the column in BEFORE UPDATE OF.
--   4. fn_get_ems_bearer_token() — service-role-only read, mirroring
--      fn_get_ems_basic_auth_password's post-00049 grants.
--
-- The guard enumeration rule (CLAUDE.md + ems-guard-enumeration.test.ts)
-- applies: both lists, literally. A future ems_* column repeats this file's
-- §2–3 shape in a new migration.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Column
-- ═══════════════════════════════════════════════════════════════════════════
--
-- BYTEA holding pgp_sym_encrypt output, exactly like the Basic password
-- (00054) and the AWS secret (00018). No new secret mechanism: the same
-- Vault DEK, the same fn_ems_encrypt_secret / fn_ems_decrypt_secret pair.
-- It stays OUT of MICROGRID_PUBLIC_COLUMNS.

ALTER TABLE public.microgrids
  ADD COLUMN IF NOT EXISTS ems_bearer_token_encrypted BYTEA;

COMMENT ON COLUMN public.microgrids.ems_bearer_token_encrypted IS
  'Keycloak bearer token for direct_url mode (issue #4), pgp_sym_encrypt output under the Vault DEK. Read only via fn_get_ems_bearer_token (service_role).';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Guard function — new column added to the value-level checks
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Body is 00054's verbatim except for the one added OR clause. SECURITY
-- INVOKER, as it has been since 00052.

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

-- Same pattern as 00047 § 2d — see 00054's note on statement order, which
-- applies unchanged (function, then trigger, then revoke).


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Trigger — new column added to the statement-level filter
-- ═══════════════════════════════════════════════════════════════════════════
--
-- APPLY THIS FILE IN A SINGLE TRANSACTION (see 00054's note — the
-- DROP/CREATE gap property belongs to the pair, not to any one migration).
--
-- Conditional: pilot-curated databases (see 00057) never applied the
-- inherited ems_* column family (00018/00019/00054), so CREATE TRIGGER
-- naming those columns fails there with 42703. The guard function above
-- is safe to (re)define unconditionally — PL/pgSQL bodies are validated
-- on first execution, not at CREATE time, and without the trigger it
-- never fires. Create the trigger only where the full column family
-- exists; pilot databases get the column + decrypt RPC now and the guard
-- together with the rest of the ems stack if they ever adopt it.

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
        'ems_known_edge_ids'
      )
    HAVING COUNT(*) = 9
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
        ems_known_edge_ids
      ON public.microgrids
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_microgrids_guard_ems_config()';
  ELSE
    RAISE NOTICE 'ems_bearer_token: ems_* column family incomplete — skipping guard trigger creation (column + decrypt RPC still applied).';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_config() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_config() TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Token read — service_role only, mirroring fn_get_ems_basic_auth_password
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Created with the post-00049 grants from the start. The body's permission
-- gate is deliberately kept even though `authenticated` cannot execute the
-- function at all — it is the guard that would matter if the grant were
-- ever widened (see 00054's note; the grant is the control today).
--
-- Callers MUST go through the sibling getter in `src/lib/openems/config.ts`
-- rather than invoking this directly (same ordering invariant as the Basic
-- password: authorize on the caller's RLS-evaluated client first, decrypt on
-- the service-role client second).

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
