-- RFC #259 § 1, ADR-008 decision 2 (#270): MGM's table of the clients it
-- accepts, and the record of a person's approval of a client sign-in.
--
-- An installation registers two public clients with Supabase Auth's OAuth
-- server, the CLI (an operator client) and the assistant bridge (an agent
-- client), and lists each here (docs/setup.md, "Clients that are not a
-- browser"). fn_auth_access_token_hook (20261126090100) refuses a token for
-- a client this table does not list, and writes the client's kind into the
-- token. Until #274 gives agent clients their own role, the hook refuses an
-- agent client too, so only the CLI is listed for now.
--
-- mgm_client_approvals holds the record MGM's consent page writes when the
-- person approves a client sign-in (#271). The hook counts a new client
-- sign-in only against a record younger than the authorization lifetime, and
-- uses it up.
--
-- Who reads and writes them:
--   * the operator lists and removes clients, and MGM's server writes an
--     approval record after a getUser() check: both as service_role, which
--     is granted every privilege on both tables below, explicitly, because
--     default privileges differ between databases (20261111200000);
--   * Supabase Auth runs the hook as supabase_auth_admin, which owns neither
--     table and does not bypass row-level security, so it gets the column
--     grants the hook needs and a policy for each, and nothing else;
--   * anon and authenticated hold no privilege and no policy, so no browser
--     or client token reads or writes either table through the database API.
--     The assistant's role (#274) is granted nothing here either.
--
-- The hook is SECURITY INVOKER, so what supabase_auth_admin lacks here stops
-- every client sign-in, in one of two ways. A missing column grant raises
-- permission denied in the hook, and Supabase Auth answers every client
-- sign-in with 500 "Error running hook URI": that 500 means a grant is
-- missing. A missing policy raises nothing: the hook finds no row and refuses
-- with its own 403, as unlisted or unapproved. Neither touches a browser
-- sign-in, for which the hook reads no table.
-- auth_access_token_hook_clients.test.ts signs a client in through Supabase
-- Auth itself, as supabase_auth_admin, checks the grants and policies in the
-- catalogs, and checks that a browser event passes with no table grant.

-- client_id is the id of the client in auth.oauth_clients, which Supabase
-- Auth writes into the token's client_id claim. No foreign key: MGM does not
-- depend on Auth's table beyond the claim, and a client deleted in Supabase
-- is refused anyway, by Supabase Auth.
--
-- kind is text with a CHECK rather than an enum, because an enum value can
-- never be removed. Nothing makes a kind unique, so a client is replaced by
-- listing the new one before removing the old.
CREATE TABLE public.mgm_clients (
  client_id UUID PRIMARY KEY,
  kind TEXT NOT NULL CONSTRAINT mgm_clients_kind_check CHECK (kind IN ('operator', 'agent')),
  label TEXT NOT NULL CONSTRAINT mgm_clients_label_check CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mgm_clients IS
  'Clients that are not a browser, which MGM accepts (ADR-008 decision 2). The access-token hook refuses a client this table does not list.';

-- A record is used up rather than deleted, so it keeps when it was used.
-- Removing a client or the person removes their records.
CREATE TABLE public.mgm_client_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.mgm_clients(client_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ
);

COMMENT ON TABLE public.mgm_client_approvals IS
  'A person''s approval of one client sign-in, written by MGM''s consent page and used up by the access-token hook (ADR-008 decision 2).';

-- The hook's lookup: the person's unused records for the client, oldest first.
CREATE INDEX mgm_client_approvals_unused_idx
  ON public.mgm_client_approvals (user_id, client_id, created_at)
  WHERE used_at IS NULL;

CREATE INDEX mgm_client_approvals_client_id_idx
  ON public.mgm_client_approvals (client_id);

ALTER TABLE public.mgm_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mgm_client_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mgm_clients FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.mgm_client_approvals FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mgm_clients, public.mgm_client_approvals TO service_role;

-- supabase_auth_admin exists only on Supabase (CLI and hosted). Docker mode
-- runs Supabase Auth as postgres, which owns both tables and needs neither
-- grants nor policies; CREATE POLICY ... TO a missing role is an error, so
-- both go inside the check.
--
-- Exactly what fn_auth_access_token_hook reads and writes: a client's kind,
-- and an unused record's columns, of which it sets used_at alone. The UPDATE
-- policy lets it only mark an unused record used. If the hook reads or writes
-- another column, grant it in a new migration, or every client sign-in fails
-- with a 500.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT SELECT (client_id, kind) ON public.mgm_clients TO supabase_auth_admin;
    CREATE POLICY "Supabase Auth reads the clients"
      ON public.mgm_clients
      FOR SELECT TO supabase_auth_admin
      USING (true);

    GRANT SELECT (id, user_id, client_id, created_at, used_at) ON public.mgm_client_approvals TO supabase_auth_admin;
    GRANT UPDATE (used_at) ON public.mgm_client_approvals TO supabase_auth_admin;
    CREATE POLICY "Supabase Auth reads the approvals"
      ON public.mgm_client_approvals
      FOR SELECT TO supabase_auth_admin
      USING (true);
    CREATE POLICY "Supabase Auth uses an approval up"
      ON public.mgm_client_approvals
      FOR UPDATE TO supabase_auth_admin
      USING (used_at IS NULL)
      WITH CHECK (used_at IS NOT NULL);
  END IF;
END;
$$;
