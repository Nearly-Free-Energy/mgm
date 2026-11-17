-- RFC #186 § 6, decision 4: Supabase Auth refuses password sign-in.
--
-- MGM signs people in only by the link it emails (/api/auth/sign-in-link,
-- /auth/confirm). Supabase Auth still has its own password endpoints, so
-- this Custom Access Token hook refuses to issue an access token for a
-- session that a password or a recovery started:
--
--   * a new sign-in, where authentication_method is 'password' or
--     'recovery';
--   * a refresh (authentication_method 'token_refresh') of such a session,
--     whose amr claim still records the method it started with. So a
--     password session that already exists ends at its next refresh, within
--     jwt_expiry (one hour), even before the cutover revokes it.
--
-- Everything else is returned unchanged, claims included. A sign-in by
-- emailed link reports 'otp', and so do Supabase's own recovery and invite
-- links: those send to the person's own address, the same trust as MGM's
-- link. Checked against GoTrue v2.187 on 2026-11-17; if Supabase Auth starts
-- reporting other method names, revisit the list below.
--
-- The hook only takes effect where Supabase Auth is told to call it:
-- supabase/config.toml ([auth.hook.custom_access_token]) locally and in CI,
-- docker-compose.yml (GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_*), and on a hosted
-- project the dashboard's Authentication › Auth Hooks, or the Management
-- API (docs/setup.md, "Supabase Auth settings").
--
-- The hook fails closed: while it is enabled, a missing or failing function
-- stops every sign-in and refresh, the emergency link included. Turn the hook
-- off, and check it is off, before a later migration replaces or drops this
-- function (docs/setup.md, "Rolling back, or changing the function").
CREATE OR REPLACE FUNCTION public.fn_auth_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  _amr JSONB := event->'claims'->'amr';
BEGIN
  IF event->>'authentication_method' IN ('password', 'recovery')
     OR (jsonb_typeof(_amr) = 'array' AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(_amr) AS a
       WHERE a->>'method' IN ('password', 'recovery')
     ))
  THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'MGM signs in by email link only. Ask for a sign-in link on the sign-in page.'
    ));
  END IF;
  RETURN event;
END;
$$;

-- Departure from the grant convention in CLAUDE.md ("SECURITY DEFINER
-- grants"): this function is SECURITY INVOKER and no MGM role calls it.
-- Only Supabase Auth does, as supabase_auth_admin, so every other role,
-- service_role included, loses EXECUTE, and supabase_auth_admin alone gets
-- it. That role exists only on Supabase (CLI and hosted); docker mode runs
-- GoTrue as postgres, which owns the function.
REVOKE EXECUTE ON FUNCTION public.fn_auth_access_token_hook(JSONB) FROM PUBLIC, anon, authenticated, service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT EXECUTE ON FUNCTION public.fn_auth_access_token_hook(JSONB) TO supabase_auth_admin;
  END IF;
END;
$$;
