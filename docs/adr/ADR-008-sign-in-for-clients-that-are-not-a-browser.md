# ADR-008: Sign-in for clients that are not a browser

## Status: Accepted

Records the sign-in decisions of RFC #259 (accepted 25 November 2026), as phase 0's two spikes found them (#267, #268). Hillary asked for this record in his review of #259, including the way out of the beta dependency below.

## Context

RFC #259 makes MGM usable from a terminal (`mgm`), from a script through the HTTP API, and through an assistant on the person's own machine. Each acts as the signed-in person, under the same routes, plugin gate and row-level security as their browser. Until now MGM has signed people in only through a browser cookie session, by email link (RFC #186).

A client that is not a browser needs three things the cookie session does not give:

- a token MGM can tell apart by client;
- a way for the person to end one client without ending the others;
- for an assistant, a bound that holds at the database itself, because a client's token also works against Supabase's database API directly, where only row-level security applies.

Phase 0 ran on a throwaway local stack built from main at 3a5ae4e. Versions: Supabase Auth v2.197.0, PostgREST v16.5, Storage v1.84.19, Realtime v2.147.1, Supabase CLI 2.122.1. The results, with what each step showed, are on #259. Phase 0 probed each API directly with the clients' tokens. It loaded no MGM view under the assistant's role, and it did not check a hosted project's dashboard settings.

**Supabase Auth v2.198.0 (16 November 2026) changed what some of this rests on, and phase 0 did not run it.**

- v2.197.0, which CI and local development run, accepts a client's token on every user endpoint of Supabase Auth's own API, as it accepts a browser session's.
- v2.198.0 refuses client tokens on every user endpoint but `GET /user`. Its source marks that one as a temporary exception and points clients to `GET /oauth/userinfo`.
- A hosted project may already run v2.198.0 or later.

## Decision

1. **Supabase Auth's OAuth 2.1 server issues client tokens.** It is in beta, on all plans, and supported by the pinned CLI. It uses authorization code with PKCE (`S256`; the server also accepts `plain`, which MGM's clients never send) and refreshes tokens.
   - A token is the person's own: `sub` is their user id and `role` is `authenticated`. So the composers and row-level security work unchanged, and Supabase Auth answers for the token as for the person (decision 6).
   - The token carries the client as `client_id`, and the session row records it.
   - **MGM registers clients only on Supabase Auth v2.198.0 or later**, so that a client's token cannot use Supabase Auth's own user endpoints: change the account, revoke the person's other apps, approve a sign-in or sign the person out everywhere. Before #270 merges, CI and local development move to an Auth image at that version or later, and the `Test` gate checks that `PUT /user` and `DELETE /user/oauth/grants` refuse a client's token.

2. **Two registered public clients per installation, and MGM's table of them.**
   - The CLI is an *operator* client and the assistant bridge an *agent* client. Each is registered with no secret, and public registration stays off.
   - MGM keeps its own table of the clients it accepts: client id, kind and label.
   - `fn_auth_access_token_hook` refuses a token for a client that table does not list, and writes the client's kind into the token. A refused sign-in creates no session.
   - The hook refuses a client sign-in that asks for scope `openid`. MGM's clients get an access token and a refresh token, and nothing else.
   - **A new client sign-in counts only after MGM's own consent page has recorded the person's approval.**
     - The page writes a record for the person and the client when they click. Only MGM's server writes it, after a `getUser()` check of the cookie session, on a path that refuses a bearer token.
     - The table has row-level security on, no policy, and no grant to `anon`, `authenticated` or `mgm_agent`, so no client token can write one through the database API either.
     - The hook refuses an `authorization_code` sign-in for that person and client unless a record younger than the authorization lifetime (10 minutes by default) exists, and uses it up. Refreshes need no record.
     - Using a record up is a write, so the hook stops being `STABLE`, and `supabase_auth_admin` gets exactly the grants on the table that it needs. The hook fails closed, so a missing grant stops every sign-in, the emergency sign-in link included; #270's tests sign in through the hook both ways.
   - The hook runs on sign-in and on every refresh, so a client removed from the table cannot refresh.
   - **Removing a client from the table ends no session.** Tokens already issued keep working at MGM's routes and the database until they expire. Deleting a client in Supabase is the same. A ban ends no session, and the only admin routes that end sessions (deleting the person, setting their password) end all of them.
   - **These rules hold only while the hook is on.** While it is off, Supabase Auth still issues client tokens, with `client_id` and the person's ordinary role, so no kind, no consent record and no table check apply. When the hook is turned off to change it (`docs/setup.md`), the OAuth server is turned off first and back on last, and the resolver refuses a bearer token that carries `client_id` and no kind. Phase 1 checks that turning the OAuth server off stops refreshes.

3. **The pasted code.** `mgm login` opens the browser to Supabase's authorize endpoint. Supabase sends the person to MGM's consent page. On approval, MGM's code page shows one string that carries the code and the request's `state`, and the person pastes it into the terminal.
   - The code page is the client's one registered return address. Return addresses must match exactly, port included, so a loopback return with a variable port is not available.
   - A code works once, only for its client, return address and PKCE verifier, and until the authorization expires: 10 minutes from the authorize request, Supabase Auth's default.
   - The CLI refuses a string whose `state` is not its own.
   - **Once a person has approved a client, Supabase approves the next sign-in without asking.** The consent page must still show its warning and wait for a click before it reveals the code. The page names the client and its kind, and for an agent client says that what the assistant reads goes to the assistant's provider. Its warning says that a program on the computer that ran the command will act as the person, so continue only if they ran `mgm login` themselves just now.
   - The code page says to paste the code only into the terminal that asked for it, and loads nothing from a third party.
   - When an app is connected to a person's account, MGM emails them which app and when, and where to revoke it. The mail goes through the deployment's sender, as sign-in mail does.

4. **Revoke ends access at once.** The person revokes a client from Connected apps (Supabase's `DELETE /user/oauth/grants`, called by MGM with the person's browser session). That deletes the client's sessions for them and revokes their consent.
   - The client's refresh fails at once, and so does Supabase Auth's answer for its token. The next sign-in asks for consent again.
   - An access token issued before the revoke keeps working at the database API until it expires: an agent token reads what its role is granted, and an operator token reads and writes whatever row-level security allows the person. That is the project's JWT expiry, one hour by default; production's setting is the one that counts. MGM's own routes refuse it at once (decision 6).
   - Phase 0 measured this on v2.197.0. Phase 1 repeats the revoke check on v2.198.0 or later.

5. **Ending another person's client, and a client's own sign-out, are MGM's own function.** Supabase has no admin API that ends one person's grant to one client, and no revocation endpoint.
   - A `SECURITY DEFINER` function, called after an organization check, deletes that person's sessions for the client and revokes their consent. Without revoking the consent, the next sign-in would be approved without asking.
   - `mgm logout` calls an MGM route that ends the calling client's own session through the same function, limited to that one session, and then deletes the token file. Supabase's `/logout` refuses client tokens from v2.198.0. If MGM cannot be reached, the CLI deletes the file and says to revoke the app from Connected apps.
   - It depends on the shape of Supabase's `auth.sessions` and `auth.oauth_consents`. A database test fails if those change.

6. **One resolver for a cookie session or a bearer token.**
   - A request carries one or the other, never both. A bearer token is accepted on `/api/*` only, and pages stay cookie-only.
   - Every bearer request is checked with Supabase Auth on an endpoint that accepts client tokens: `GET /user` today, `GET /oauth/userinfo` once `/user` refuses them. So a revoked client is refused at once on MGM's routes.
   - The caller's kind (browser session, operator client, agent client) comes from the verified claims.
   - An agent client may call only a pinned allow-list of host read routes.

7. **An assistant's token runs as its own database role, `mgm_agent`, set by the token hook.**
   - Supabase Auth issues the token with that role and accepts it. A refresh keeps it.
   - The role is `NOLOGIN` and granted to `authenticator` only.
   - **Tables are closed by default.** The role reads only the tables and columns a migration grants it.
   - **Functions are not.** Postgres makes every new function executable through `PUBLIC`, and MGM's default privileges revoke that only from `anon` and `authenticated`. An invoker function runs as the role, so any write it tries is refused and any read is bounded by the role's grants. A definer function is closed to the role only by its own `REVOKE … FROM PUBLIC`, so the guard test checks `has_function_privilege` for the role on every definer function against a pinned list.
   - Measured on the database API directly, the role is refused every write, every table and column not granted, the two definer functions tried, storage and GraphQL. On realtime it reaches only public broadcast channels, which carry no table data. No MGM table is in the realtime publication; adding one needs a decision about this role at the same time.
   - **Supabase Auth's own API is outside the role.** It is closed to client tokens by decision 1's version floor, not by the role.
   - **Grants follow ADR-007 as merged.** Grants are by column wherever a table holds a column outside ADR-007's boundary. Place names are granted. Device names, tenant names, addresses, coordinates and connection settings are not. A tenant view gets its own tenant's name and unit label, which ADR-007 decision 10 allows, through `fn_tenant_home`, never by a column grant on `tenants`. Phase 0's grant of `devices` whole is not the one #274 ships.
   - **A marked view's loader reads under the role only what is granted.** A loader that needs more reads it on the server after `getUser()`, and puts only values inside the boundary into its model; its view is not served to an agent client until it does. Several loaders call definer functions with the caller's client, and need `EXECUTE` on them: `mgm_plugin_enabled_for_org` (the plugin gate and the composers), `fn_tenant_home` (tenant views) and `fn_tenant_shared_meter_days` (tenant usage).
   - **#274 ships the role with what every agent call needs**: the caller's own role rows (decision 8) and the plugin gate. Each view on ADR-007's list adds its loader's grants and policy twins in the pull request that first serves it to an agent client, with a test that loads the view with an agent token.
   - The hook never writes `service_role` or `supabase_admin`, the two roles Supabase Auth treats as administrators; `authenticator` can also switch to `service_role`. A test holds this.
   - A request-start function (PostgREST's `db-pre-request`) was tried as a second way and is not used: Storage takes the role from the token, so it would still see `authenticated`.

8. **Policies for the assistant role.** All of these add policies; none edits a helper or an existing policy.
   - **Twins.** No policy written `TO authenticated` applies to the role: the three tenant policies, `payment_notifications_read` and the `pilot_import_batches` policy among them. Each one a marked view reads gets a twin `TO mgm_agent` in the pull request that first serves the view to an agent client. ADR-007's investigation policies name the role themselves (`TO authenticated, mgm_agent`, its decision 3). If A2 builds those tables before #274 creates the role, they are `TO authenticated` alone, and the pull request that first serves the investigation view to an agent client adds the role.
   - **`user_roles`.** The host and the composers read the caller's own role rows with the caller's client. The policy for super admins calls `is_super_admin()` directly, so the role needs `EXECUTE` on it, and with that a super admin's assistant would read every role row. So #274 gives the role a `RESTRICTIVE` policy on `user_roles` limiting it to `user_id = auth.uid()`. Under it, `user_id` is only ever the caller's own and no loader puts it into a model, so #274 grants `user_roles` whole.
   - **Tenant data.** The staff policy on `tenants` names no role and would otherwise let a staff member's assistant read tenant names. So the role gets `RESTRICTIVE` policies on `tenants` and `tenant_devices` that limit it to the person's own units. They ship with the first grant to the role on either table, with a test that a staff member's assistant reads no tenant row. Restricting `tenants` alone is not enough to keep `tenant_devices` readable for staff assistants, as ADR-007 decision 10 expected: the staff policy on `tenant_devices` looks up the tenant's microgrid in `tenants` as the caller (`00002_rls.sql`), so once a staff member's assistant reads no tenant row, it reads no link either. ADR-007 is corrected to match.
   - **What a staff member's assistant loses with them.** Site-day reads its house meters through `tenant_devices` with the caller's client, so under these policies it would show "Needs tenant meters". Site-day is served to an agent client only once a definer function returns the house-meter ids in force for a microgrid and day (ids are inside the boundary), or its view says by name that house figures are not available to an assistant.

9. **The way out of the beta dependency.** Only the issuing of tokens depends on Supabase's OAuth server; nothing stored does.
   - **The setting:** one server-side setting makes the resolver refuse every bearer token, and the operator removes both clients from MGM's table, so the hook refuses every refresh. MGM's routes refuse clients at once, and tokens already issued keep working at the database API until they expire. The browser is unaffected and no data is lost. A new RFC then picks the replacement: the candidates are the sign-in email, which names no client, and MGM issuing tokens itself. Phase 1 tests the hook refusing a refresh.
   - **When it is used:** the feature is withdrawn, is priced so that an installation cannot accept it, or changes so that revoke or the client claim stops working, or Supabase Auth stops refusing a revoked client's token at once.
   - **The early warning:** a test in the `Test` gate signs in both clients through the OAuth server on the job's own Supabase. It checks that the agent token runs as `mgm_agent` and is refused a write, calls a route, revokes the grant, and checks that the refresh and Supabase Auth's answer then fail. It runs the Auth version the pinned CLI names, so it fails the pull request that moves the CLI. A hosted project upgrades with no pull request here, so when its `/auth/v1/health` reports a version CI does not run, the revoke check is run by hand on that version.

## Consequences

- An installation turns on the OAuth server (its dashboard for a hosted project, `[auth.oauth_server]` locally), registers the two clients and lists them in MGM's table (`docs/setup.md`). Phase 0 did not check the hosted dashboard settings (the authorization path and dynamic registration off), and it ran with an ES256 signing key, which Supabase recommends for the OAuth server.
- Five migrations follow, each with its database tests in the same commit:
  - the clients table and the consent records;
  - the token hook's new rules;
  - the assistant role with its grants and policies;
  - the function that ends a client's session or another person's client;
  - the audit column for the client id.
- Middleware, the runtime and the GUI host gain the resolver and the caller's kind (#272). These are code-owned paths.
- A revoked client can use the database API until its token expires (one hour by default). The token lifetime bounds it, as it bounds a browser session signed out elsewhere today (`CLAUDE.md`, "Session checks before privilege").
- Two `mgm` commands that refresh with the same token can sign the person out: reusing a refresh token outside the reuse window revokes the session's tokens. The window is the project's `refresh_token_reuse_interval`: 10 seconds in `supabase/config.toml`, and a hosted project's own setting governs. The CLI therefore locks and re-reads its token file before it refreshes. The token file itself (owner-only, checked on write and on read, RFC #259 decision 15) is the CLI's design, recorded in its documentation with C1.
- A refresh token has no age limit unless the project sets a session time-box or inactivity timeout; those apply to client sessions as to browser sessions. On a hosted project they need the Pro plan or above.
- The page-recorded approval (decision 2) leaves one narrow window. An approval that does not pass through the page could use up a record the person made by approving a sign-in for the same client in the same 10 minutes, and a refused code stays usable for its whole 10 minutes. That other sign-in then gets a token and the person's own fails. Connected apps shows one grant per client, so the person cannot tell the two apart; revoking the client ends both.
- ADR-007's per-organization assistant switch holds at MGM's routes and the bridge, not at the database: an agent token reads through the database API whatever the switch says. The switch governs what MGM sends to an assistant. An agent token at the database reads less than the same person's operator token or browser session, so it gives the person nothing they could not already read. An installation that wants no assistant at all removes the agent client from its table.
- If the hook can no longer set `mgm_agent`, the operator removes the agent client from MGM's table and #259 § 5 waits; no restrictive policy keyed on the client's id takes the role's place (#259 decision 12, ADR-007 decision 1).
- MGM depends on the shape of two Supabase Auth tables (decision 5), on the hook accepting a custom role (decision 7), and on Supabase Auth refusing client tokens on its user endpoints (decision 1). Supabase can change any of these. The tests above fail when it does on the version CI runs; a hosted project's newer version is checked by hand (decision 9).

## Alternatives considered

- **Per-organization API tokens.** Removed by #241: a token that identifies an organization cannot act as a person under row-level security.
- **The sign-in email reused for the CLI.** It gives a session that names no client, so clients cannot be told apart or revoked one at a time.
- **MGM as its own authorization server.** A token store and a consent protocol for two maintainers to keep safe.
- **A loopback return address.** Not supported with a variable port, and of no use over SSH. It can be added later with a fixed port.
- **Restrictive policies keyed on the client's id, instead of a role.** A policy governs rows, not the functions a token may call.
- **A request-start function instead of the hook** (decision 7). It leaves Storage open.
- **Changing the default privileges so new functions are closed to `PUBLIC`.** It would also close every new invoker function to `authenticated` unless its migration granted it. The guard test on definer functions is narrower.

## References

- RFC #259 and its phase 0 results; #267, #268.
- ADR-006 (the GUI contract), ADR-007 (agentic operation and the model data boundary, #261, #288).
- RFC #186 (sign-in by email link), RFC #197 (tenant access).
