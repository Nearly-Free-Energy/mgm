-- RFC #259 § 1, ADR-008 decisions 2 and 3 (#271): what MGM's consent page
-- reads about a client sign-in before the person answers, and the approval
-- record it writes when they approve.
--
-- The consent page (src/app/oauth/consent) names the client before the
-- person clicks, and asks Supabase Auth nothing until then: on its first
-- call, Supabase Auth's GET /oauth/authorizations/{id} approves the sign-in
-- of a client the person approved before and issues its code, and answers
-- with the code alone, without naming the client. So MGM reads the
-- authorization itself, from Supabase Auth's auth.oauth_authorizations,
-- which the database API does not expose.
--
-- Both functions are SECURITY DEFINER, and only service_role may run them.
-- MGM's server calls them after a getUser() check of the person's cookie
-- session, with that person's id (the consent page and
-- POST /api/auth/oauth/approvals; service-role-session-check.test.ts lists
-- both). They read six columns of auth.oauth_authorizations as Supabase Auth
-- v2.198.0 defines them: authorization_id, client_id, user_id, status,
-- expires_at and created_at (the record alone reads created_at). If
-- Supabase renames one, the functions that read it fail; if it changes what
-- status holds, the page answers that the sign-in was already answered.
-- client_consent.test.ts pins the columns, their types and the status labels
-- on the version CI runs (ADR-008, Consequences: MGM depends on the shape of
-- Supabase Auth's tables; and its amendment of 26 Nov 2026 on this table).
--
-- An answer, in order:
--   'unknown'  no such authorization, or Supabase Auth has bound it to
--              another person, so nothing about it is told to this one;
--   'expired'  past its expiry (ten minutes by default) or marked expired;
--   'answered' approved or denied already;
--   'unlisted' its client is not in mgm_clients, which the hook refuses;
--   'ok'       with the client's id, kind and label.

-- The authorization an approval was written for. One record per
-- authorization, so a second click, or a reload after the first click, writes
-- nothing more, while two sign-ins of the same client by the same person
-- each get their own record. Null on records written before this column.
-- The hook (20261126090100) does not read it, and supabase_auth_admin gets no
-- grant on it; service_role's table-wide grant covers it.
ALTER TABLE public.mgm_client_approvals
  ADD COLUMN authorization_id TEXT
    CONSTRAINT mgm_client_approvals_authorization_id_check CHECK (length(authorization_id) BETWEEN 1 AND 128),
  ADD CONSTRAINT mgm_client_approvals_authorization_id_key UNIQUE (authorization_id);

CREATE OR REPLACE FUNCTION public.fn_client_authorization_read(_authorization_id TEXT, _user_id UUID)
RETURNS TABLE (outcome TEXT, client_id UUID, kind TEXT, label TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  _client UUID;
  _owner UUID;
  _status TEXT;
  _expires TIMESTAMPTZ;
  _kind TEXT;
  _label TEXT;
BEGIN
  IF _authorization_id IS NULL OR _user_id IS NULL THEN
    RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT a.client_id, a.user_id, a.status::text, a.expires_at
    INTO _client, _owner, _status, _expires
    FROM auth.oauth_authorizations AS a
   WHERE a.authorization_id = _authorization_id;

  IF NOT FOUND OR (_owner IS NOT NULL AND _owner <> _user_id) THEN
    RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF _status = 'expired' OR _expires <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF _status IS DISTINCT FROM 'pending' THEN
    RETURN QUERY SELECT 'answered'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT c.kind, c.label INTO _kind, _label FROM public.mgm_clients AS c WHERE c.client_id = _client;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unlisted'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ok'::text, _client, _kind, _label;
END;
$$;

COMMENT ON FUNCTION public.fn_client_authorization_read(TEXT, UUID) IS
  'What MGM''s consent page shows before the person answers a client sign-in: the client of a pending authorization, for the person it is or may be bound to (ADR-008 decision 3). service_role only, after getUser().';

-- Writes the approval the hook uses up when the client exchanges its code.
-- The record is for _user_id, the person whose cookie session the server
-- checked; the browser then asks Supabase Auth for the code with that same
-- session, which binds the authorization to them. A record whose
-- authorization another person recorded first is not written, and the
-- answer is 'unknown'.
--
-- A record takes its authorization's created_at rather than the time of the
-- click, or the click's if that is earlier (Supabase Auth's clock running
-- ahead of the database's). The hook counts a record for ten minutes from created_at, and an authorization
-- lives ten minutes from its own created_at by default, so a record ends
-- with the sign-in it was written for, give or take the skew between the two
-- clocks, rather than up to ten minutes after it. The person's own exchange
-- loses nothing: its code works only until the authorization expires
-- (ADR-008 decision 3). If the hook's window or Supabase Auth's lifetime
-- changes, or Supabase Auth stops setting created_at when it creates the
-- authorization, revisit this.
CREATE OR REPLACE FUNCTION public.fn_client_approval_record(_authorization_id TEXT, _user_id UUID)
RETURNS TABLE (outcome TEXT, client_id UUID, kind TEXT, label TEXT)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  _read RECORD;
  _started TIMESTAMPTZ;
BEGIN
  SELECT r.outcome, r.client_id, r.kind, r.label INTO _read
    FROM public.fn_client_authorization_read(_authorization_id, _user_id) AS r;
  IF _read.outcome IS DISTINCT FROM 'ok' THEN
    RETURN QUERY SELECT _read.outcome, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT a.created_at INTO _started
    FROM auth.oauth_authorizations AS a
   WHERE a.authorization_id = _authorization_id;
  IF _started IS NULL THEN
    -- Gone since the read above: Supabase Auth cleans up old authorizations.
    RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  INSERT INTO public.mgm_client_approvals (user_id, client_id, authorization_id, created_at)
  VALUES (_user_id, _read.client_id, _authorization_id, LEAST(_started, now()))
  ON CONFLICT ON CONSTRAINT mgm_client_approvals_authorization_id_key DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM public.mgm_client_approvals AS a
     WHERE a.authorization_id = _authorization_id AND a.user_id = _user_id
  ) THEN
    RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ok'::text, _read.client_id, _read.kind, _read.label;
END;
$$;

COMMENT ON FUNCTION public.fn_client_approval_record(TEXT, UUID) IS
  'Records a person''s approval of one client sign-in, once per authorization, for the access-token hook to use up (ADR-008 decision 2). service_role only, after getUser().';

-- No signed-in caller may run either: a token holder could otherwise approve
-- a sign-in without passing through the consent page, or read whose sign-in
-- an authorization id belongs to.
REVOKE EXECUTE ON FUNCTION public.fn_client_authorization_read(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_client_approval_record(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_client_authorization_read(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_client_approval_record(TEXT, UUID) TO service_role;
