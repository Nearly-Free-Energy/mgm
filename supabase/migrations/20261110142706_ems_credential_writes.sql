-- Saved OpenEMS credentials: who writes them, and the address they stay with.
--
-- microgrids keeps four encrypted OpenEMS credentials:
--   ems_aws_secret_access_key_encrypted, ems_basic_auth_password_encrypted,
--   ems_bearer_token_encrypted, ems_keycloak_client_secret_encrypted.
-- Only the service role decrypts them, to authenticate requests to the
-- addresses stored on the same row: ems_backend_url for all four, and
-- ems_keycloak_token_url as well for the Keycloak client secret.
--
-- This migration adds two rules to fn_microgrids_guard_ems_config:
--
--   1. Only the service role writes the encrypted columns. The connection
--      settings route (PUT /api/microgrids/[id]/openems-backend) encrypts what
--      the operator typed and saves it on the service client after
--      currentUserCanAccessMicrogrid, the way the Payments capability saves
--      merchant credentials through fn_payment_save_account. A new BEFORE
--      INSERT trigger applies the same rule to new rows: anyone else inserts
--      a microgrid with the four columns NULL.
--
--      The service role is exempt from rule 1 because it is the writer the
--      rule names. It bypasses RLS and holds every privilege on the table,
--      so exempting it declines to add a restriction rather than removing
--      one.
--
--   2. A saved credential stays with the address it was entered for. An
--      UPDATE that changes ems_backend_url must clear or rewrite every
--      encrypted column that is set; one that changes ems_keycloak_token_url
--      must clear or rewrite the Keycloak client secret. This applies to the
--      service role too: it describes the row, not who may write it. The
--      route asks the operator to enter the credentials again before it gets
--      here.
--
-- Unchanged: the twelve-column enumeration, in both the BEFORE UPDATE OF
-- filter and the IS DISTINCT FROM checks (ems-guard-enumeration.test.ts reads
-- both from the newest migration that creates the trigger), the access check
-- through user_can_access_microgrid, and the exemption for migrations run as
-- postgres or supabase_admin. Trigger creation stays conditional, as in 00061
-- and 20260926132414: pilot-curated databases may lack the ems_* columns.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. UPDATE guard
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

  -- Rule 2, for every other writer the service role included.
  IF NEW.ems_backend_url IS DISTINCT FROM OLD.ems_backend_url
     AND (   (NEW.ems_aws_secret_access_key_encrypted IS NOT NULL
              AND NEW.ems_aws_secret_access_key_encrypted
                  IS NOT DISTINCT FROM OLD.ems_aws_secret_access_key_encrypted)
          OR (NEW.ems_basic_auth_password_encrypted IS NOT NULL
              AND NEW.ems_basic_auth_password_encrypted
                  IS NOT DISTINCT FROM OLD.ems_basic_auth_password_encrypted)
          OR (NEW.ems_bearer_token_encrypted IS NOT NULL
              AND NEW.ems_bearer_token_encrypted
                  IS NOT DISTINCT FROM OLD.ems_bearer_token_encrypted)
          OR (NEW.ems_keycloak_client_secret_encrypted IS NOT NULL
              AND NEW.ems_keycloak_client_secret_encrypted
                  IS NOT DISTINCT FROM OLD.ems_keycloak_client_secret_encrypted))
  THEN
    RAISE EXCEPTION
      'Saved OpenEMS credentials are not kept when the backend URL changes. Enter them again.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.ems_keycloak_token_url IS DISTINCT FROM OLD.ems_keycloak_token_url
     AND NEW.ems_keycloak_client_secret_encrypted IS NOT NULL
     AND NEW.ems_keycloak_client_secret_encrypted
         IS NOT DISTINCT FROM OLD.ems_keycloak_client_secret_encrypted
  THEN
    RAISE EXCEPTION
      'The saved Keycloak client secret is not kept when the token URL changes. Enter it again.'
      USING ERRCODE = '23514';
  END IF;

  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Rule 1.
  IF (NEW.ems_aws_secret_access_key_encrypted
                                              IS DISTINCT FROM OLD.ems_aws_secret_access_key_encrypted)
     OR (NEW.ems_basic_auth_password_encrypted
                                              IS DISTINCT FROM OLD.ems_basic_auth_password_encrypted)
     OR (NEW.ems_bearer_token_encrypted       IS DISTINCT FROM OLD.ems_bearer_token_encrypted)
     OR (NEW.ems_keycloak_client_secret_encrypted
                                              IS DISTINCT FROM OLD.ems_keycloak_client_secret_encrypted)
  THEN
    RAISE EXCEPTION
      'Saved OpenEMS credentials can only be changed through the microgrid''s OpenEMS connection settings.'
      USING ERRCODE = '42501';
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

REVOKE EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_config() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_config() TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. INSERT guard — rule 1 for new rows
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_microgrids_guard_ems_credentials_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF session_user IN ('postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  -- Same exemption and reason as rule 1 in fn_microgrids_guard_ems_config.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.ems_aws_secret_access_key_encrypted IS NOT NULL
     OR NEW.ems_basic_auth_password_encrypted IS NOT NULL
     OR NEW.ems_bearer_token_encrypted IS NOT NULL
     OR NEW.ems_keycloak_client_secret_encrypted IS NOT NULL
  THEN
    RAISE EXCEPTION
      'Saved OpenEMS credentials can only be changed through the microgrid''s OpenEMS connection settings.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_credentials_insert() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_credentials_insert() TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Triggers
-- ═══════════════════════════════════════════════════════════════════════════

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

    EXECUTE 'DROP TRIGGER IF EXISTS trg_microgrids_ems_credentials_insert ON public.microgrids';
    EXECUTE 'CREATE TRIGGER trg_microgrids_ems_credentials_insert
      BEFORE INSERT ON public.microgrids
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_microgrids_guard_ems_credentials_insert()';
  ELSE
    RAISE NOTICE 'ems credential writes: ems_* column family incomplete — skipping guard trigger creation.';
  END IF;
END;
$$;
