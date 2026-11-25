# ADR-008: Sign-in for clients that are not a browser

## Status: Proposed

Records the sign-in decisions of RFC #259 (accepted 25 November 2026), as phase 0's two spikes found them (#267, #268). Hillary asked for this record in his review of #259, including the way out of the beta dependency below.

## Context

RFC #259 makes MGM usable from a terminal (`mgm`), from a script through the HTTP API, and through an assistant on the person's own machine. Each acts as the signed-in person, under the same routes, plugin gate and row-level security as their browser. Until now MGM has signed people in only through a browser cookie session, by email link (RFC #186).

A client that is not a browser needs three things the cookie session does not give:

- a token MGM can tell apart by client;
- a way for the person to end one client without ending the others;
- for an assistant, a bound that holds at the database itself, because a client's token also works against Supabase's database API directly, where only row-level security applies.

Phase 0 ran on a throwaway local stack built from main at 3a5ae4e. Versions: Supabase Auth v2.197.0, PostgREST v16.5, Storage v1.84.19, Realtime v2.147.1, Supabase CLI 2.122.1. The results, with what each step showed, are on #259.

## Decision

1. **Supabase Auth's OAuth 2.1 server issues client tokens.** It is in beta, on all plans, and supported by the pinned CLI. It uses authorization code with PKCE (`S256`; the server also accepts `plain`, which MGM's clients never send) and refreshes tokens.
   - A token is the person's own: `sub` is their user id and `role` is `authenticated`. So `getUser()`, the composers and row-level security work unchanged.
   - The token carries the client as `client_id`, and the session row records it.

2. **Two registered public clients per installation, and MGM's table of them.**
   - The CLI is an *operator* client and the assistant bridge an *agent* client. Each is registered with no secret, and public registration stays off.
   - MGM keeps its own table of the clients it accepts: client id, kind and label.
   - `fn_auth_access_token_hook` refuses a token for a client that table does not list, and writes the client's kind into the token. A refused sign-in creates no session.
   - The hook refuses a client sign-in that asks for scope `openid`. MGM's clients get an access token and a refresh token, and nothing else.
   - **A new client sign-in counts only after MGM's own consent page has recorded the person's approval.** The page writes a record for the person and the client when they click. It is a cookie-session page, so no client token can write one. The hook refuses an `authorization_code` sign-in for that person and client unless a record younger than 10 minutes exists, and uses it up. Refreshes need no record.
   - The hook runs on sign-in and on every refresh, so a client removed from the table cannot refresh.

3. **The pasted code.** `mgm login` opens the browser to Supabase's authorize endpoint. Supabase sends the person to MGM's consent page. On approval, MGM's code page shows one string that carries the code and the request's `state`, and the person pastes it into the terminal.
   - The code page is the client's one registered return address. Return addresses must match exactly, port included, so a loopback return with a variable port is not available.
   - A code works once, only for its client, return address and PKCE verifier, and for 10 minutes from the authorize request.
   - The CLI refuses a string whose `state` is not its own.
   - **Once a person has approved a client, Supabase approves the next sign-in without asking.** The consent page must still show its warning and wait for a click before it reveals the code. The warning says that a program on the computer that ran the command will act as the person.
   - MGM emails the person when an app is connected to their account.

4. **Revoke ends access at once.** The person revokes a client from Connected apps (Supabase's `DELETE /user/oauth/grants`). That deletes the client's sessions for them and revokes their consent.
   - The client's refresh fails at once, and so does `getUser()`. The next sign-in asks for consent again.
   - An access token issued before the revoke can still read through the database API until it expires. That is the project's JWT expiry, one hour by default. MGM's own routes refuse it at once (decision 6).

5. **Ending another person's client is MGM's own function.** Supabase has no admin API that ends one person's grant to one client.
   - A `SECURITY DEFINER` function, called after an organization check, deletes that person's sessions for the client and revokes their consent. Without revoking the consent, the next sign-in would be approved without asking.
   - It depends on the shape of Supabase's `auth.sessions` and `auth.oauth_consents`. A database test fails if those change.

6. **One resolver for a cookie session or a bearer token.**
   - A request carries one or the other, never both. A bearer token is accepted on `/api/*` only, and pages stay cookie-only.
   - Every bearer request passes `getUser()`, so a revoked client is refused at once on MGM's routes.
   - The caller's kind (browser session, operator client, agent client) comes from the verified claims.
   - An agent client may call only a pinned allow-list of host read routes.

7. **An assistant's token runs as its own database role, `mgm_agent`, set by the token hook.**
   - Supabase Auth issues the token with that role and accepts it at `getUser()`. A refresh keeps it.
   - The role is `NOLOGIN` and granted to `authenticator` only. It holds read grants on an enumerated list of tables and columns, and `EXECUTE` on the helpers their policies call. Nothing else is granted, so a new table or function stays out of its reach until a migration grants it.
   - Measured, it is refused every write, every table and column not granted, every definer function not granted, storage and GraphQL. On realtime it reaches only public broadcast channels, which carry no table data. No MGM table is in the realtime publication; adding one needs a decision about this role at the same time.
   - Column grants carry ADR-007's data boundary into the database: place names are readable, and addresses and connection settings are not.
   - The hook never writes `service_role` or `supabase_admin`, the two roles Supabase Auth treats as administrators; `authenticator` can also switch to `service_role`. A test holds this.
   - A request-start function (PostgREST's `db-pre-request`) was tried as a second way and is not used: Storage takes the role from the token, so it would still see `authenticated`.

8. **Tenant data for the assistant role.**
   - The tenant policies are written `TO authenticated`, so the role gets a twin of each.
   - The staff policy on `tenants` names no role and would otherwise let a staff member's assistant read tenant names. So the role also gets `RESTRICTIVE` policies on `tenants` and `tenant_devices` that limit it to the person's own units.
   - Both add policies; neither edits a helper or an existing policy.

9. **The way out of the beta dependency.** Only the issuing of tokens depends on Supabase's OAuth server; nothing stored does.
   - **The setting:** one server-side setting makes the resolver refuse every bearer token. Clients stop, the browser is unaffected and no data is lost. A new RFC then picks the replacement: the candidates are the sign-in email, which names no client, and MGM issuing tokens itself.
   - **When it is used:** the feature is withdrawn, is priced so that an installation cannot accept it, or changes so that revoke or the client claim stops working.
   - **The early warning:** a test in the `Test` gate signs in through the OAuth server on the job's own Supabase, calls a route and revokes the grant. A Supabase upgrade that changes any of that fails on its own pull request. A hosted project updates on Supabase's schedule, so this warns early but not always first.

## Consequences

- An installation turns on the OAuth server (its dashboard for a hosted project, `[auth.oauth_server]` locally), registers the two clients and lists them in MGM's table (`docs/setup.md`).
- Five migrations follow, each with its database tests in the same commit:
  - the clients table;
  - the token hook's new rules;
  - the assistant role with its grants and policies;
  - the function that ends another person's client;
  - the audit column for the client id.
- Middleware, the runtime and the GUI host gain the resolver and the caller's kind (#272). These are code-owned paths.
- A revoked client can read through the database API for up to an hour. The token lifetime bounds it, as it bounds a browser session signed out elsewhere today (`CLAUDE.md`, "Session checks before privilege").
- Two `mgm` commands that refresh with the same token can sign the person out: reusing a refresh token outside the reuse window (10 seconds in MGM's configuration) revokes the session's tokens. The CLI therefore locks and re-reads its token file before it refreshes.
- A refresh token has no age limit unless the project sets a session time-box or inactivity timeout; those apply to client sessions as to browser sessions.
- The page-recorded approval (decision 2) leaves one narrow window: an approval that does not pass through the page could use up a record the person made by approving a sign-in for the same client in the same 10 minutes. The person's own sign-in then fails and they approve again.
- MGM depends on the shape of two Supabase Auth tables (decision 5) and on the hook accepting a custom role (decision 7). Supabase can change either; the tests above fail when it does.

## Alternatives considered

- **Per-organization API tokens.** Removed by #241: a token that identifies an organization cannot act as a person under row-level security.
- **The sign-in email reused for the CLI.** It gives a session that names no client, so clients cannot be told apart or revoked one at a time.
- **MGM as its own authorization server.** A token store and a consent protocol for two maintainers to keep safe.
- **A loopback return address.** Not supported with a variable port, and of no use over SSH. It can be added later with a fixed port.
- **Restrictive policies keyed on the client's id, instead of a role.** A policy governs rows, not the functions a token may call.
- **A request-start function instead of the hook** (decision 7). It leaves Storage open.

## References

- RFC #259 and its phase 0 results; #267, #268.
- ADR-006 (the GUI contract), ADR-007 (agentic operation and the model data boundary, #261).
- RFC #186 (sign-in by email link), RFC #197 (tenant access).
