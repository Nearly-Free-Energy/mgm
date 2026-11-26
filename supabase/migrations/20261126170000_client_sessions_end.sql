-- RFC #259 § 4, ADR-008 decision 5 (#297): MGM's own function that ends a
-- client for a person. Supabase Auth has no admin API that ends one person's
-- grant to one client, and its /logout refuses a client's token from
-- v2.198.0, so MGM ends them itself.
--
-- fn_client_sessions_end(_user_id, _client_id, _session_id):
--   - With a session: ends that one session, and only when it is that
--     person's session for that client. Answers 'ended', or 'not_found' when
--     no such session exists (already ended, or another person's, or another
--     client's), and then ends nothing. The consent is left as it is.
--     `mgm logout` reaches this through POST /api/auth/logout, which takes
--     all three from the verified claims of the caller's own token.
--   - With no session: ends every session the person has for the client,
--     revokes their consent for it, so the next sign-in asks again, and uses
--     up any approval record the consent page wrote for that client that the
--     token hook has not used yet, so a sign-in in flight when the client is
--     ended gets no token. Answers 'ended' with the count, which may be 0.
--     #273's "end this person's app" calls it, after its organization check.
-- A NULL person or client raises 22004.
--
-- It does not read mgm_clients: a client already removed from that table
-- can still be ended.
--
-- It does what Supabase Auth's own DELETE /user/oauth/grants does for the
-- person (v2.198.0: the consent's revoked_at set, then
-- DELETE FROM auth.sessions WHERE user_id AND oauth_client_id), on Supabase
-- Auth's tables as v2.198.0 defines them:
--   auth.sessions (id uuid, user_id uuid, oauth_client_id uuid), whose
--     refresh tokens and MFA claims go with it (ON DELETE CASCADE);
--   auth.oauth_consents (user_id uuid, client_id uuid, revoked_at
--     timestamptz), one row per person and client.
-- If Supabase renames one of those columns the function raises, so the
-- route answers with an error and the CLI says to revoke the app from
-- Connected apps; if it stops cascading a session's refresh tokens, a
-- refresh after logout would no longer fail. client_sessions_end.test.ts
-- pins the columns and the cascades on the version CI runs (ADR-008,
-- Consequences, and decision 9 for a hosted project's newer version).
--
-- The function runs as its owner (postgres), which needs DELETE on
-- auth.sessions and UPDATE on auth.oauth_consents. The local stack and CI
-- grant both; a hosted project is checked by hand before the CLI's routes
-- are released there (ADR-008 decision 9).
--
-- Only service_role may run it. Each caller is an MGM route that checks the
-- caller first (getUser() and, for logout, an operator client's own token);
-- service-role-session-check.test.ts lists them. No signed-in role may run it
-- through the database API: a token holder could otherwise end other
-- people's sessions. Revoking from PUBLIC also keeps the assistant's role
-- (mgm_agent, #274) out, since that role reaches a definer function only
-- through PUBLIC.

CREATE OR REPLACE FUNCTION public.fn_client_sessions_end(_user_id UUID, _client_id UUID, _session_id UUID DEFAULT NULL)
RETURNS TABLE (outcome TEXT, sessions_ended INTEGER, consent_revoked BOOLEAN)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  _ended INTEGER := 0;
  _revoked INTEGER := 0;
BEGIN
  IF _user_id IS NULL OR _client_id IS NULL THEN
    RAISE EXCEPTION 'fn_client_sessions_end needs a person and a client' USING ERRCODE = '22004';
  END IF;

  IF _session_id IS NOT NULL THEN
    DELETE FROM auth.sessions AS s
     WHERE s.id = _session_id
       AND s.user_id = _user_id
       AND s.oauth_client_id = _client_id;
    GET DIAGNOSTICS _ended = ROW_COUNT;
    RETURN QUERY SELECT CASE WHEN _ended = 0 THEN 'not_found' ELSE 'ended' END::text, _ended, false;
    RETURN;
  END IF;

  DELETE FROM auth.sessions AS s
   WHERE s.user_id = _user_id
     AND s.oauth_client_id = _client_id;
  GET DIAGNOSTICS _ended = ROW_COUNT;

  UPDATE auth.oauth_consents AS c
     SET revoked_at = now()
   WHERE c.user_id = _user_id
     AND c.client_id = _client_id
     AND c.revoked_at IS NULL;
  GET DIAGNOSTICS _revoked = ROW_COUNT;

  UPDATE public.mgm_client_approvals AS a
     SET used_at = now()
   WHERE a.user_id = _user_id
     AND a.client_id = _client_id
     AND a.used_at IS NULL;

  RETURN QUERY SELECT 'ended'::text, _ended, _revoked > 0;
END;
$$;

COMMENT ON FUNCTION public.fn_client_sessions_end(UUID, UUID, UUID) IS
  'Ends a person''s client (ADR-008 decision 5): one session of it, or every session with the consent revoked. service_role only, called by MGM routes after their own check.';

REVOKE EXECUTE ON FUNCTION public.fn_client_sessions_end(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_client_sessions_end(UUID, UUID, UUID) TO service_role;
