-- RFC #259 § 1, ADR-008 decisions 2 and 7 (#270): the access-token hook
-- learns about clients that are not a browser.
--
-- Replaces the body 20261117210000 created. Turn the hook off, and check it
-- is off, before pushing this to a project where it is on, and turn the OAuth
-- server off first (docs/setup.md, "Rolling back, or changing the function").
-- That is a precaution: CREATE OR REPLACE never leaves the function missing,
-- and the REVOKE below does not touch supabase_auth_admin.
--
-- Supabase Auth's OAuth server puts the client's id in the token's client_id
-- claim, and the scopes the client asked for in scope; a browser session has
-- neither claim. Supabase Auth v2.198.0 reports a client's first sign-in as
-- 'oauth_provider/authorization_code' and every refresh, a client's or a
-- browser's, as 'token_refresh'. If a later version reports other names,
-- revisit the method checks below. In v2.198.0 client_id is omitted when
-- empty and set only for a session an OAuth client started, so a browser
-- event never carries the key; a client_id that is present but null, empty
-- or not a uuid is refused. If a later version sends the key for a browser
-- session, every sign-in is refused, the emergency link included: revisit
-- the browser check below.
--
-- In order:
--   1. A session a password or a recovery started is refused, new or
--      refreshed (RFC #186 § 6, unchanged).
--   2. A token whose role is service_role or supabase_admin, the two roles
--      Supabase Auth treats as administrators, is refused, so the hook never
--      hands either out (ADR-008 decision 7).
--   3. An event with no client_id claim is a browser's, and is returned
--      unchanged. It reads no table.
--   4. A client this installation does not list in mgm_clients is refused.
--   5. Only an operator client is accepted, and its token runs as
--      authenticated; any other role is refused. An agent client is refused
--      until #274 gives it its own select-only role here: as authenticated it
--      would hold the person's full authority at the database API (ADR-008
--      decision 7). #274 changes only this function; mgm_clients already
--      accepts the kind 'agent'.
--   6. A client sign-in that asks for scope openid is refused: MGM's clients
--      get an access token and a refresh token, and nothing else. The test
--      is for the word anywhere in the scope claim; see the check below.
--   7. A new client sign-in counts only after MGM's own consent page has
--      recorded the person's approval: an 'oauth_provider/authorization_code'
--      event uses up a record for that person and client younger than the
--      authorization lifetime, or is refused. A refresh needs no record. Any
--      other method on a client token is refused.
--   8. The client's kind goes into the mgm_client_kind claim, which MGM's
--      resolver reads (#272). Nothing else in the event changes.
--
-- A refusal is a 403 with a message, which Supabase Auth passes to the
-- client. Supabase Auth runs the hook inside the transaction that creates the
-- session, so a refusal leaves no session behind, and a record is used up
-- only by a sign-in that gets its token.
--
-- Using a record up is a write, so the hook is VOLATILE. It stays SECURITY
-- INVOKER: Supabase Auth runs it as supabase_auth_admin, which reads and
-- writes the two tables through the grants and policies of 20261126090000.
-- The hook still fails closed: while it is enabled, a missing function or a
-- missing EXECUTE grant stops every sign-in and refresh, the emergency link
-- included; a missing table grant or policy stops every client sign-in.
CREATE OR REPLACE FUNCTION public.fn_auth_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  _uuid CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  _claims JSONB := event->'claims';
  _amr JSONB := event->'claims'->'amr';
  _method TEXT := event->>'authentication_method';
  _client TEXT := event->'claims'->>'client_id';
  _user TEXT := event->>'user_id';
  _kind TEXT;
  _approval UUID;
BEGIN
  IF _method IN ('password', 'recovery')
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

  IF _claims->>'role' IN ('service_role', 'supabase_admin') THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'MGM refused this sign-in.'
    ));
  END IF;

  IF jsonb_typeof(_claims) IS DISTINCT FROM 'object' OR NOT (_claims ? 'client_id') THEN
    RETURN event;
  END IF;

  IF _client IS NULL OR _client !~ _uuid THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'MGM does not accept this app.'
    ));
  END IF;

  SELECT c.kind INTO _kind FROM public.mgm_clients c WHERE c.client_id = _client::uuid;
  IF _kind IS NULL THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'MGM does not accept this app.'
    ));
  END IF;

  IF _kind IS DISTINCT FROM 'operator' OR _claims->>'role' IS DISTINCT FROM 'authenticated' THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'MGM refused this sign-in.'
    ));
  END IF;

  -- Supabase Auth v2.198.0 passes the scope the client asked for at
  -- authorize, unchanged, and issues an ID token when ParseScopeString finds
  -- openid in it: it splits on an ASCII space and trims each part with Go's
  -- strings.TrimSpace, which also strips Unicode spaces such as U+00A0
  -- (internal/models/oauth_scope.go). So ' openid' next to a no-break space
  -- is openid to Supabase Auth. Rather than copy that split, refuse the word
  -- anywhere: every part ParseScopeString reads as openid contains it,
  -- whatever the separators. Auth refuses at authorize any part that is not
  -- a supported scope (validateScopes), and openid is the only supported
  -- scope containing the word, so for every scope that reaches the hook this
  -- refuses exactly what Auth would read as openid. If Supabase Auth adds a
  -- supported scope that contains the word, revisit.
  IF position('openid' IN coalesce(_claims->>'scope', '')) > 0 THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'MGM gives this app an access token only. Sign in without the openid scope.'
    ));
  END IF;

  IF _method = 'oauth_provider/authorization_code' THEN
    IF _user IS NULL OR _user !~ _uuid THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'http_code', 403, 'message', 'MGM refused this sign-in.'
      ));
    END IF;
    -- Ten minutes is Supabase Auth's default authorization lifetime
    -- (GOTRUE_OAUTH_SERVER_AUTHORIZATION_TTL). The CLI passes no such
    -- setting, and docs/setup.md does not change it. If Supabase changes the
    -- default or an installation sets another lifetime, change this in a new
    -- migration to match. SKIP LOCKED: a record
    -- another sign-in is using up is not waited for, under the hook's
    -- two-second statement timeout.
    UPDATE public.mgm_client_approvals AS a
       SET used_at = now()
     WHERE a.id = (
       SELECT b.id
         FROM public.mgm_client_approvals AS b
        WHERE b.user_id = _user::uuid
          AND b.client_id = _client::uuid
          AND b.used_at IS NULL
          AND b.created_at > now() - interval '10 minutes'
        ORDER BY b.created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING a.id INTO _approval;
    IF _approval IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'http_code', 403,
        'message', 'Approve this sign-in on MGM''s consent page, then try again.'
      ));
    END IF;
  ELSIF _method IS DISTINCT FROM 'token_refresh' THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'MGM refused this sign-in.'
    ));
  END IF;

  RETURN jsonb_set(event, '{claims,mgm_client_kind}', to_jsonb(_kind));
END;
$$;

-- As in 20261117210000: this function is SECURITY INVOKER and no MGM role
-- calls it. Only Supabase Auth does, as supabase_auth_admin, so every other
-- role, service_role included, holds no EXECUTE on it. CREATE OR REPLACE
-- keeps the grants; they are stated again so this file says what they are.
-- Docker mode runs Supabase Auth as postgres, which owns the function.
REVOKE EXECUTE ON FUNCTION public.fn_auth_access_token_hook(JSONB) FROM PUBLIC, anon, authenticated, service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT EXECUTE ON FUNCTION public.fn_auth_access_token_hook(JSONB) TO supabase_auth_admin;
  END IF;
END;
$$;
