-- Sign-in by email link and code (RFC #186, PR 2): the request log that
-- rate-limits it, and the lookup that decides whether to send anything.
--
-- MGM creates the one-time token with auth.admin.generateLink, which sends
-- nothing and is not covered by Supabase's own email rate limits, so MGM
-- limits requests itself:
--
--   * Link requests: about 1 a minute and 5 an hour per address, 20 an hour
--     per IP. Counted before the address is looked up, so the limits behave
--     the same whether or not an account exists.
--   * Code attempts: 5 per issued code (the link email carries a 6-digit
--     code). Supabase's own verification limit counts per IP only. Requesting
--     a new link replaces the old token and code in Supabase, which starts a
--     new count.
--
-- Addresses and IPs are stored as SHA-256 hashes, computed by the
-- application, and rows older than 30 days are deleted as new ones arrive.
-- Only the service role reads or writes the table: the routes that use it
-- run before any session exists (POST /api/auth/sign-in-link,
-- POST /api/auth/verify-code).
--
-- fn_auth_sign_in_target reads auth.users, so it is SECURITY DEFINER; like
-- the claim functions it is executable by the service role only.

-- ── 1. Table ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth_sign_in_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  ip_hash TEXT,
  outcome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT auth_sign_in_requests_kind_known CHECK (kind IN ('link', 'code')),
  CONSTRAINT auth_sign_in_requests_outcome_known CHECK (
    outcome IN ('claimed', 'limited', 'sent', 'send_failed', 'no_access', 'verified', 'wrong_code')
  ),
  CONSTRAINT auth_sign_in_requests_hash_shape CHECK (
    email_hash ~ '^[0-9a-f]{64}$' AND (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$')
  )
);

CREATE INDEX IF NOT EXISTS idx_auth_sign_in_requests_email
  ON auth_sign_in_requests (email_hash, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_sign_in_requests_ip
  ON auth_sign_in_requests (ip_hash, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_sign_in_requests_created
  ON auth_sign_in_requests (created_at);

ALTER TABLE auth_sign_in_requests ENABLE ROW LEVEL SECURITY;
-- No policies: nobody but the service role (which bypasses RLS) uses it.
REVOKE ALL ON auth_sign_in_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON auth_sign_in_requests TO service_role;

-- ── 2. Claim a link request ────────────────────────────────────────────
--
-- Returns the new row's id when the request is within the limits (outcome
-- 'claimed', which the route later sets to sent, send_failed or no_access),
-- or NULL when it is not (a 'limited' row is kept for the record but not
-- counted). The advisory lock serializes requests for one address, so two
-- concurrent requests cannot both pass the one-a-minute check.

CREATE OR REPLACE FUNCTION public.fn_auth_claim_sign_in_request(_email_hash TEXT, _ip_hash TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('auth_sign_in:' || _email_hash, 0));

  DELETE FROM auth_sign_in_requests
  WHERE id IN (
    SELECT id FROM auth_sign_in_requests
    WHERE created_at < now() - interval '30 days'
    ORDER BY created_at
    LIMIT 100
  );

  IF (SELECT count(*) FROM auth_sign_in_requests
      WHERE email_hash = _email_hash AND kind = 'link' AND outcome <> 'limited'
        AND created_at > now() - interval '1 minute') >= 1
     OR (SELECT count(*) FROM auth_sign_in_requests
         WHERE email_hash = _email_hash AND kind = 'link' AND outcome <> 'limited'
           AND created_at > now() - interval '1 hour') >= 5
     OR (_ip_hash IS NOT NULL AND (SELECT count(*) FROM auth_sign_in_requests
         WHERE ip_hash = _ip_hash AND kind = 'link' AND outcome <> 'limited'
           AND created_at > now() - interval '1 hour') >= 20)
  THEN
    INSERT INTO auth_sign_in_requests (kind, email_hash, ip_hash, outcome)
    VALUES ('link', _email_hash, _ip_hash, 'limited');
    RETURN NULL;
  END IF;

  INSERT INTO auth_sign_in_requests (kind, email_hash, ip_hash, outcome)
  VALUES ('link', _email_hash, _ip_hash, 'claimed')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_auth_claim_sign_in_request(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_auth_claim_sign_in_request(TEXT, TEXT) TO service_role;

-- ── 3. Claim a code attempt ─────────────────────────────────────────────
--
-- Counts attempts at this address since the last link sent to it (or the
-- last 15 minutes, the code's lifetime, when none was sent). Returns the new
-- row's id, or NULL after 5 attempts or 30 an hour from one IP. An attempt
-- in flight counts, so concurrent guesses cannot get past the limit.

CREATE OR REPLACE FUNCTION public.fn_auth_claim_code_attempt(_email_hash TEXT, _ip_hash TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_since TIMESTAMPTZ;
  v_id BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('auth_sign_in:' || _email_hash, 0));

  SELECT greatest(max(created_at), now() - interval '15 minutes') INTO v_since
  FROM auth_sign_in_requests
  WHERE email_hash = _email_hash AND kind = 'link' AND outcome = 'sent';
  v_since := coalesce(v_since, now() - interval '15 minutes');

  IF (SELECT count(*) FROM auth_sign_in_requests
      WHERE email_hash = _email_hash AND kind = 'code' AND outcome <> 'limited'
        AND created_at > v_since) >= 5
     OR (_ip_hash IS NOT NULL AND (SELECT count(*) FROM auth_sign_in_requests
         WHERE ip_hash = _ip_hash AND kind = 'code' AND outcome <> 'limited'
           AND created_at > now() - interval '1 hour') >= 30)
  THEN
    INSERT INTO auth_sign_in_requests (kind, email_hash, ip_hash, outcome)
    VALUES ('code', _email_hash, _ip_hash, 'limited');
    RETURN NULL;
  END IF;

  INSERT INTO auth_sign_in_requests (kind, email_hash, ip_hash, outcome)
  VALUES ('code', _email_hash, _ip_hash, 'claimed')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_auth_claim_code_attempt(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_auth_claim_code_attempt(TEXT, TEXT) TO service_role;

-- ── 4. Who may be sent a sign-in link ──────────────────────────────────
--
-- The auth user with this address, if they hold at least one MGM role;
-- NULL otherwise. The route sends nothing on NULL, and never calls
-- generateLink for such an address, because generateLink creates an account
-- for an address it does not know. GoTrue stores addresses lowercased.

CREATE OR REPLACE FUNCTION public.fn_auth_sign_in_target(_email TEXT)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id
  FROM auth.users u
  WHERE u.email = lower(_email)
    AND u.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = u.id)
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_auth_sign_in_target(TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_auth_sign_in_target(TEXT) TO service_role;
