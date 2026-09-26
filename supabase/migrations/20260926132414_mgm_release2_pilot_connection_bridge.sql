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
-- 00054_ems_basic_auth_credentials.sql
-- #327. Credentials for an authenticated self-hosted OpenEMS Backend.
--
-- `direct_url` shipped with no auth fields — a decision recorded in #101 and
-- restated in `src/lib/openems/index.ts`. An operator running OpenEMS Backend
-- with the REST/JSON-RPC API enabled gets an authenticated endpoint by
-- default, so the documented answer was "put an authenticated Lambda in front
-- and use cloud_aws". That is a coherent boundary and the wrong one for a
-- pilot: it asks a customer to do infrastructure work to use a feature that
-- already ships. Widened deliberately (#327).
--
-- ── Why no new `ems_type` value ──────────────────────────────────────────
--
-- These are OPTIONAL columns on the existing `direct_url` mode, not a third
-- connection type. `ALTER TYPE … ADD VALUE` cannot be undone: #316 added
-- `ems_operator` to `user_role` and #321 deleted the entire model the same
-- day, and the value is still in the type with nothing reading it. A mode
-- that is "direct_url, with credentials if present" leaves no residue if it
-- is ever withdrawn.
--
-- ── The guard enumeration below is the load-bearing part ─────────────────
--
-- `fn_microgrids_guard_ems_config` names its columns literally, in two
-- places: the `BEFORE UPDATE OF` statement filter and the `IS DISTINCT FROM`
-- value checks in the body. Both new columns go in BOTH. A guarded column
-- omitted from either is writable with no error and no warning.
--
-- Literal enumeration is mandated by CLAUDE.md because prefix matching would
-- absorb the `ems_last_discover_*` health columns, which must stay writable
-- for Discover on the user's own client. The cost of that correctness is that
-- additions are easy to forget; this is the first addition since 00052.
--
-- Note this is NOT justified by an exposure that exists today: the RLS policy
-- on `microgrids` and the guard's predicate currently admit the same people.
-- They are two separately-maintained expressions reaching the same org by
-- different routes —
--
--   policy  user_can_access_community(community_id)   (00031)
--   guard   user_can_access_microgrid(NEW.id)         (00053)
--
-- — and nothing ties them together. The guard is what would still be
-- enforcing if they diverge, which is exactly why a credential column belongs
-- inside it rather than outside.
--
-- Contents:
--   1. Two columns: username (plaintext) + password (DEK-encrypted BYTEA)
--   2. Guard function re-issued with both columns enumerated
--   3. Trigger re-issued with both columns in BEFORE UPDATE OF
--   4. fn_get_ems_basic_auth_password() — service-role-only read, mirroring
--      fn_get_ems_secret's post-00049 grants


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Columns
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Username is plaintext by design: it is an identifier, not a secret, and it
-- must be readable to render "configured as <user>" without a decrypt. It is
-- therefore added to MICROGRID_PUBLIC_COLUMNS in the same change.
--
-- Password is BYTEA holding pgp_sym_encrypt output, exactly like
-- ems_aws_secret_access_key_encrypted (00018). No new secret mechanism: the
-- same Vault DEK, the same fn_ems_encrypt_secret / fn_ems_decrypt_secret pair.
-- It stays OUT of MICROGRID_PUBLIC_COLUMNS.

ALTER TABLE public.microgrids
  ADD COLUMN IF NOT EXISTS ems_basic_auth_username TEXT,
  ADD COLUMN IF NOT EXISTS ems_basic_auth_password_encrypted BYTEA;

COMMENT ON COLUMN public.microgrids.ems_basic_auth_username IS
  'HTTP Basic username for direct_url mode (#327). Plaintext — an identifier, not a secret.';

COMMENT ON COLUMN public.microgrids.ems_basic_auth_password_encrypted IS
  'HTTP Basic password for direct_url mode (#327), pgp_sym_encrypt output under the Vault DEK. Read only via fn_get_ems_basic_auth_password (service_role).';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Guard function — both new columns added to the value-level checks
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Body is 00053's verbatim except for the two added OR clauses. SECURITY
-- INVOKER, as it has been since 00052: the function fires as the caller and
-- reaches `user_can_access_microgrid`, which is SECURITY DEFINER and carries
-- its own rights.

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

-- Same pattern as 00047 § 2d. The half that transfers is "regardless of
-- EXECUTE grants" — true of any trigger function. § 2d's other half, "fires
-- with the function-owner's privileges", is a SECURITY DEFINER property; this
-- function is SECURITY INVOKER and fires as the caller.
--
-- Statement order in this section — function, then trigger, then revoke — is
-- safe to change only while migrations apply as the function's owner: REVOKE …
-- FROM PUBLIC leaves owner rights intact, and CREATE TRIGGER requires EXECUTE
-- on the function. An applier that is not the owner and revokes first fails at
-- CREATE TRIGGER. If this repo ever applies migrations as a non-owner role,
-- revisit the order here.


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Trigger — both new columns added to the statement-level filter
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `UPDATE OF` keys off the columns NAMED in the statement, not the values, so
-- it must list every guarded column or a write naming only the new ones never
-- fires the trigger at all. DROP … IF EXISTS keeps the file re-runnable.
--
-- APPLY THIS FILE IN A SINGLE TRANSACTION. Between the DROP and the CREATE
-- below the ems_* columns are unguarded on a live table. Postgres DDL is
-- transactional, so BEGIN … COMMIT (or psql --single-transaction) closes the
-- gap completely; applied statement-by-statement over an interactive session
-- it is real, and its length is however long the two statements are apart.
-- Low consequence for THIS migration — the new columns are unwritten and the
-- microgrids RLS policy still refuses cross-org writers throughout — but the
-- property belongs to the DROP/CREATE pair, not to this migration's contents,
-- so it holds for every future reissue of this trigger.

DROP TRIGGER IF EXISTS trg_microgrids_guard_ems_config ON public.microgrids;
CREATE TRIGGER trg_microgrids_guard_ems_config
  BEFORE UPDATE OF
    ems_type,
    ems_backend_url,
    ems_aws_region,
    ems_aws_access_key_id,
    ems_aws_secret_access_key_encrypted,
    ems_basic_auth_username,
    ems_basic_auth_password_encrypted,
    ems_known_edge_ids
  ON public.microgrids
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_microgrids_guard_ems_config();

REVOKE EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_config() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_config() TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Password read — service_role only, mirroring fn_get_ems_secret post-00049
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 00049 revoked fn_get_ems_secret and fn_ems_decrypt_secret from
-- `authenticated` to close a decrypt oracle. This function is created with the
-- post-00049 grants from the start rather than inheriting them later.
--
-- The body's permission gate is deliberately kept even though `authenticated`
-- cannot execute the function at all — it is the guard that would matter if
-- the grant were ever widened. It is NOT what does the work today; the grant
-- is. Anyone reading this body and concluding that org managers can call it
-- would be reading the wrong control.
--
-- Callers MUST go through `getEmsSecretForMicrogrid`'s sibling in
-- `src/lib/openems/config.ts` rather than invoking this directly: that helper
-- authorizes by reading the microgrid row on the caller's own RLS-evaluated
-- client and treats "no row" as terminal BEFORE any service-role client is
-- constructed. Called directly from a service-role client, this function
-- contributes no authorization whatsoever.

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
