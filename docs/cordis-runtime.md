# MGM Cordis runtime

MGM is organized as Cordis plugins. This document describes how those plugins
are loaded and how a request reaches them. Code lives in `src/lib/runtime/`.

## Two lifetimes

**Platform (one per server process).** `getMgmRuntime()` lazily creates one
root `Context` per Node process (one per warm Vercel function instance) and
loads the platform plugins into it:

| Plugin | Provides | Injects |
|---|---|---|
| `mgm-catalog` | `mgmCatalog` — the bundled plugin catalog (`src/lib/plugins/bundled.ts`) | — |
| `mgm-gate` | `mgmGate` — organization resolution + per-org plugin enablement | `mgmCatalog` |
| `mgm-surface` | `mgmSurface` — capability GUI contributions and installed GUI metadata, checked when they register (`src/lib/gui/host/server/surface-registry.ts`) | `mgmCatalog` |
| `<gui name>` | installs a compiled-in GUI's metadata (`src/gui/meta.ts`, `guiInstallPlugin`) | `mgmSurface` |
| `<capability>-surface` | contributes a capability's GUI navigation, and later its views and actions (`src/lib/<capability>/surface-plugin.ts`, contributing `src/lib/<capability>/surface.ts`), one plugin each for `organization-directory`, `community-management`, `metering`, `billing`, `payments` and `tenant-app` | `mgmSurface` |
| `metering-providers` | `meteringProviders` — registry of metering provider factories | — |
| `openems-metering` | registers the `openems` factory | `meteringProviders` |
| `fixture-metering` | registers the `synthetic` factory (site samples and per-meter energy series), only while `MGM_METERING_FIXTURES` is on (`src/lib/metering/fixture/plugin.ts`) | `meteringProviders` |
| `payment-providers` | `paymentProviders` — registry of payment provider factories | — |
| `pesapal` | registers the `pesapal` factory | `paymentProviders` |
| `mail-transports` | `mailTransports` — registry of mail transport factories, keyed by the settings' kind (RFC #186) | — |
| `smtp` | registers the `smtp` factory (`src/lib/email/smtp/`) | `mailTransports` |
| `community-management`, `metering`, `billing`, `billing-review`, `payments`, `tenant-app` | capability *plugins* (loaded per request, see below) | `mgmRequest` + the platform services they need |

Platform plugins hold no request data, credentials, or database clients.
A mail transport is built for one send from settings its caller has already
authorized and decrypted (an organization's email sender, read by
`PUT /api/organizations/[id]/email-sender` after its access check); the
registry keeps only the factories. Organization senders carry notices only,
never sign-in links or codes (RFC #186 decision 5).
Provider factories receive the client of whoever asks for a provider:
normally the request's Supabase client, so RLS applies to the caller. One
caller passes a service-role client after its own check instead: the tenant
app's usage source
(`src/lib/tenant-app/infrastructure/usage-source.ts`). A tenant's own client
reads no `microgrids` or `edges` row, so the usage source builds the unit's
microgrid's provider on the service role, after `composeTenantApp` has
authorized the unit, for the microgrid `fn_tenant_home` named and the device
rows the tenant's own client returned. The shared-use days (see "The
tenant app" below) are not read there: the tenant's own client asks
`fn_tenant_shared_meter_days`, which answers only the unit's own tenant and
returns dates only, never whose. If that read ever moves back to the
service role, or the function returns a tenant id or takes ids, revisit
it. A new
caller that builds a provider on the service role needs the same reasoning,
and a listing in `service-role-session-check.test.ts`. Adding a second metering
source or payment provider is a new platform plugin that registers into the
existing registry; nothing in billing or the routes changes. Metering plugins
register a factory and an optional `supports(client, microgridId)` selector
that reads their own configuration through the caller’s RLS-scoped client.
Billing uses `forRequest(client)` and does not choose a vendor; the Operations
day asks `select(client, microgridId)` for the provider's name, the same
choice `forRequest` makes. Exactly one
matching provider is required; ambiguous selections fail closed. OpenEMS is
the compatibility fallback for existing microgrids. A configured non-fallback
provider takes precedence, and selection errors never fall back silently.

A provider may also implement `getDeviceEnergySeries`: kWh per local day or
local hour for each meter, null where the source has no value, never a
substituted zero (`src/lib/metering/energy-series.ts` lays out the buckets
and refuses a range it cannot read with 400). The OpenEMS provider reads it
with `queryHistoricTimeseriesEnergyPerPeriod` in the microgrid's zone, with
values keyed by edge and channel, since a component id such as `meter0`
repeats on every edge. It always asks for hours: NFE's backend stamps an
hourly bucket with the end of its hour, and its daily buckets are UTC days
(03:00 to 03:00 in Kampala), so a local day is the sum of its local hours,
null when an hour that has ended has no value. The backend returned the
first two hourly buckets of any range empty in the RFC mgm#197 spike, so the
read runs from the day before the requested start to the day after its end,
and the provider drops those days before it returns. The synthetic provider
generates each meter's figures from the meter, the day and a fixed seed
(`src/lib/metering/fixture/meter-energy.ts`).

The `synthetic` provider serves a microgrid whose edges all have ids starting
`SYNTHETIC-EDGE-`. It refuses a microgrid that mixes them with real edges
(409), generates site samples and meter energy series only for devices on
such edges, and marks what it produces as synthetic, which the Operations
day shows in a banner.
While the setting is off, nothing registers it and the edge registration
route refuses those ids (400). Only that route refuses them, not the
database (`docs/setup.md` § "Synthetic site data").

**Request (one per API call).** Authenticated composers call
`authorizeOrganization()` to authenticate and check organization access,
except the tenant app's, which calls `authorizeTenant()` (see "The tenant
app" below). `openOrganizationScope()` is a low-level constructor accepting
an already authorized request; it does not authenticate or authorize. The
capability plugins take its `organizationId` and `roles` as organization
access their composer authorized, except billing-review, whose composer
passes no roles and whose plugin reads only through RLS, and the tenant
app's scope, which carries no organization access (below). The request's
`audience` says which: `"organization"` unless the composer opens the scope
with `{ audience: "tenant" }`, as only `composeTenantApp` does, and a request
object already carrying another audience is refused rather than relabelled.
Public payment callers establish their separate bearer-token/notification
verification boundary.
It creates an *isolated* child context of the root. Isolation gives the request its own `mgmRequest`, capability and
registry slots, so concurrent requests on one warm instance never share a
capability. The request scope plugin provides `mgmRequest`; capability plugins
are then loaded into that child and declare `inject: ["mgmRequest", ...]`.
Disposing the scope fiber unloads every capability that injected it — Cordis
does the cascade — and each capability's `isActive` guard turns false, so a
reference retained after the request cannot write.

The composers are thin adapters over `openOrganizationScope()`. They differ
in what they check before opening the scope, and a route must supply whatever
its composer does not:

| Composer | Authenticates and checks org access | Refuses a disabled plugin |
|---|---|---|
| `composeCommunityManagement`, `composeMetering` | yes (`authorizeOrganization`) | yes: `409`, or `503` when plugin state cannot be read |
| `composeBilling` | yes | yes: `409` or `503` — except with `readOnly: true` |
| `composePayments` | yes | new checkouts only, in the Payments capability (see "Payments" below) |
| `composePaymentsPublic` | no — no user session; see below | new checkouts only, in the Payments capability |
| `composeBillingReview` | no | no |
| `composeTenantApp` | yes, as the unit's tenant, not as staff (`authorizeTenant`) | yes, reads included: `409`, or `503` when plugin state cannot be read |

Staff, here and below, is not a role: it means holding a `user_roles` row
whose role is not `tenant`, now (`src/lib/roles.ts`, `docs/entity-model.md`
§ "Roles"). `staff_access_accounts` is the history of who ever did.

The composers that refuse a disabled plugin check access first, so a caller
without it gets `401`/`403` and learns nothing about the plugin. A code's
prefix is the plugin's name with hyphens as underscores (`codePrefix` in
`gate.ts`): `community_management_…`, `tenant_app_…`.
`composeCommunityManagement`, `composeMetering` and `composeBilling` then
read plugin state with `isPluginEnabledForOrg`, the read the gate makes,
and refuse with the gate's codes and copy before opening any scope:
`409 <plugin>_disabled` while the plugin is off, `503 <plugin>_gate_unavailable`
when its state cannot be read. The per-plugin helpers (`isBillingEnabled`
and the rest) would not do: supabase-js answers a failed read with
`{ error }` rather than rejecting, and they read that as disabled. `compose-fail-closed.test.ts`
compares each refusal with the gate's for the same client and checks that no
scope was opened.

The plugin can be turned off between composition and a write, so the
capabilities behind those composers read its state again before they
act: `requirePlugin` in `src/lib/billing/capability.ts` before each billing
write, `requirePlugin` in `src/lib/metering/capability.ts` before each
metering write or provider call, and `requireCommunityPlugin` in
`src/lib/community-management/operations/shared.ts` before each community
write. They read through their Supabase repository, which also uses
`isPluginEnabledForOrg` and rejects when the state cannot be read, and refuse
with the same `409` or `503` before anything is written or called. Billing's
`previewBills` saves no bills and does not re-check, though preview mode can
re-pin an empty draft period's tariff, so a route that calls it gates itself
(see `readOnly` below). The capabilities' unit tests
check that each method in their `WRITES` / `GATED` tables re-checks before it
acts; the tables are kept by hand, so a new gated method is covered only once
it has a row there. `compose-fail-closed.test.ts` also writes through each
composed capability with the plugin turned off after composition, or its
state unreadable at the re-check, and compares the refusal with the gate's.

**The tenant app.** `composeTenantApp({ supabase, tenantId })` composes the
tenant app for a signed-in tenant's request about one unit they rent (RFC
mgm#197 § 3). `authorizeTenant` in `scope.ts`, beside
`authorizeOrganization`, checks the id, settles the session with
`getUser()`, finds the caller's own `tenant` row for the unit and reads the
unit with `fn_tenant_home`, which names its microgrid and organization. It
reads all of it with the caller's own client, and staff rows never reach a
unit: a super admin or org manager reads a tenant through the staff pages,
as `user_can_access_tenant` decides. The composer then asks the gate itself
(`checkGate` on the unit's organization, asked as a write, the way the GUI
host asks whether a plugin is live), so a disabled tenant app refuses reads
too and its `409 tenant_app_disabled` and `503 tenant_app_gate_unavailable`
are the gate's own. Only then does it open the scope for that organization with
`openOrganizationScope` and load the `tenant-app` capability. That scope is
opened for a person who may hold no access to the organization: its
`organizationId` is only the unit's and its `roles` only the caller's tenant
rows. So it is opened with `audience: "tenant"`, and nothing but the
`tenant-app` capability loads into it: the community-management, metering,
billing and payments plugins treat those fields as access their composer
authorized with `authorizeOrganization`, and billing-review, which reads
only through RLS, is a staff capability, so each calls
`requireOrganizationAudience` (`src/lib/runtime/services.ts`) first in
`apply` and refuses any audience but `"organization"`. The `tenant-app`
plugin in turn refuses any audience but `"tenant"`.
`src/lib/runtime/__tests__/request-audience.test.ts` loads each into the
other's scope. A new capability plugin that trusts `organizationId` or
`roles` calls `requireOrganizationAudience` too. The composition also hands
out no context to load more. The `tenant-app` capability
provides `tenantAppScope` and `tenantApp` (both in `REQUEST_SERVICES`).

`TenantAppPlugin` also injects the root `meteringProviders` for the unit's
month and day of use (RFC mgm#197 § 5). No metering capability loads into a
tenant's scope, so the usage source (`infrastructure/usage-source.ts`)
builds the unit's microgrid's provider itself, on the service role as
described above, and only for meters the tenant's own client returned as
linked to the unit. The capability writes nothing, but its usage reads are
provider calls: the usage source asks the metering gate with the tenant's
client right before each one, in place of the metering capability's
`requirePlugin` re-check, and the tenant-app gate is asked at composition,
in the same request. Only the unit's primary consumption meter is its use,
on the home, the month and the day (`USAGE_METER_ROLE` in
`src/lib/tenant-app/types.ts`). A meter that two units hold as primary on
the same day, on the same microgrid or not, is shown to each with the label
"Shared with another unit, not only yours" on those days (D12). For that,
the usage source asks the database with the tenant's own client:
`fn_tenant_shared_meter_days`, a `SECURITY DEFINER` function that answers
only the unit's own tenant while the tenant app is on, reads the unit's
links itself and counts every other unit that holds the meter as primary,
as billing bills each. The service role takes no part. That read concerns MGM's own link rows, not
the backend, so it runs without the metering gate and outside the usage
cache, on every view. It returns device ids and dates only, cut to the
unit's own links; a tenant can call it directly, so if it ever returns a
tenant id or more days than the views need, revisit it. If it fails, the
view answers `tenant_app_unavailable` rather than show shared use
unlabelled. A read is cached in process memory for 60 s per unit,
view and period, and a unit may cause at most six uncached reads a minute
in each process (`src/lib/tenant-app/usage-throttle.ts`, through a limiter with its own
store, so keys that need no session cannot evict a unit's count); over the
limit, a read kept for up to 15 minutes is served marked stale, or the view
shows no data. An uncached read that fails is answered the same way: the
kept read, marked stale with its read time, or no data. One that finds
metering off, or a provider with no series, shows no data and never a kept
read. Neither is a refusal. The cache is read before the metering
gate is asked, so while metering is off for the unit's organization nothing
is read from the backend, but a figure read before it was turned off may
still be served from the cache: for up to 60 s, or, while the unit is over
its limit, marked stale for up to 15 minutes. `compose-fail-closed.test.ts` still leaves the
tenant app out, because the composer reads plugin state only through
`checkGate`: `src/lib/tenant-app/__tests__/compose.test.ts` compares its
refusals with the gate's and covers its load failure. If the capability
ever writes, or a usage read moves out of the request that composed it (a
worker, a background refresh), it needs a tenant-app re-check before the
call. If the composer starts reading plugin state another way, it goes into
`COMPOSERS` in `compose-fail-closed.test.ts`.

The tenant asks `mgm_plugin_enabled_for_org` with their own token, about an
organization whose `mgm_plugins` rows they cannot read. That works because
the function answers any signed-in caller about any organization, tenant-only
accounts included, so its answer is no access check: it discloses only an
organization's plugin on/off state, for an id the caller already has. The gate
returns an `organization` target's id unchecked (`resolveTargetOrganization`),
so for a tenant the id is trusted only because it came from `fn_tenant_home`.
If the function gains an access check, it must let a tenant through for their
own unit's organization first, or every tenant is refused with `503`. Since
`authorizeTenant` calls `getUser()` before any read,
`service-role-session-check.test.ts` counts it and `composeTenantApp` as
session checks, as it counts `authorizeOrganization` and the organization
composers.

Giving and removing a person's access to a unit is not the tenant app's: it
is community-management's, from the tenant record, through
`composeCommunityManagement`. `POST /api/tenants/[id]/access` finds or
creates the account for the address in its body and calls
`fn_tenant_access_grant` on the service role with the manager's `getUser()`
id as `_actor`, then sends the notice through `sendNotice`, which never
carries a sign-in link; `DELETE /api/tenants/[id]/access/[accessId]` calls
`fn_tenant_access_revoke` with the manager's own client. While the tenant
app is off for the unit's organization, the POST gives no access.

`composeBillingReview` takes the `organizationId` the route resolved and
trusts it. Its only caller, `POST /api/billing-review/preview`, resolves that
id through `checkGate` on the caller's RLS-scoped client, so a period the
caller cannot see yields no organization and a 404. A new caller must do the
same.

## Who is calling: the session resolver

A request carries a browser's cookie session or a client's
`Authorization: Bearer` token, never both (RFC #259 § 2, ADR-008 decision
6). A client is the CLI (an *operator* client) or the assistant bridge (an
*agent* client), each acting as the signed-in person; Supabase Auth's OAuth
server issues their tokens, and the token hook writes the client's kind
into them (`mgm_client_kind`).

Middleware (`src/middleware.ts`) decides a bearer request before any route
runs, after the release allowlist:

- a bearer token with a session cookie is `400 credentials_conflict`, and a
  bearer token on a page (anything outside `/api/*`) is a `400`: pages stay
  cookie-only;
- while `MGM_CLIENT_TOKENS` is off, every bearer token is
  `403 client_tokens_off` (`docs/setup.md`), and without
  `SUPABASE_SERVICE_ROLE_KEY`, which keys the mark below, `503
  client_tokens_unavailable`;
- the token's claims must name a client (`callerFromClaims` in
  `src/lib/runtime/caller.ts`: a uuid `client_id`, a kind, and the role
  that kind runs as; `client_id` with no kind was issued while the hook was
  off and is refused; a token with no `client_id` is a browser session's,
  sent from a script, and is refused too: ADR-008's amendment of 26 Nov
  2026), and Supabase Auth must answer `GET /user` for it (`verifyBearer`
  in `src/lib/runtime/bearer.ts`), so a revoked client is refused at once;
  otherwise `401 unauthenticated`. When Auth does not answer within five
  seconds, cannot be reached, or answers with an error of its own (a `5xx`
  or `429`), the request is `503 auth_unavailable` instead, still refused,
  so the client can tell an outage from a dead token and try again rather
  than sign in again;
- an agent client may call only `AGENT_ROUTES`
  (`src/lib/runtime/agent-routes.ts`): `GET /api/gui/catalog` and
  `GET /api/gui/view`. Every other request, whatever its method, public
  paths included, is `403 agent_route_refused`.

An accepted bearer request goes on with `x-mgm-credential` set to the
token's mark (`credentialMark` in `src/lib/runtime/credential.ts`): an
HMAC-SHA256 of the token keyed with the server-only
`SUPABASE_SERVICE_ROLE_KEY`, so only the server can make one. Middleware
replaces any value the client sent and deletes it from every other
request. It never builds the cookie
client or sets a cookie for one. A client's token found in the session
cookie counts as signed out. Every `/api` refusal middleware makes is
`{ error, code }`, the unauthenticated `401` included
(`code: "unauthenticated"`); only the release allowlist's `404` stays plain
text.

On the route side, `createClient` (`@/lib/supabase/server`) asks
`bearerClientFor` (`src/lib/runtime/request-session.ts`) first. With the
mark, it builds a client that sends the token as its global `Authorization`
header, so PostgREST runs as the person and `auth.getUser()` asks Supabase
Auth about the token: every `getUser()`-backed check (`getCurrentUserAccess`,
`authorizeOrganization`, `authorizeTenant`, the composers) works unchanged
and refuses a revoked client too. That holds only while Supabase Auth's
`GET /user` answers a client's token, which v2.198.0 marks as a temporary
exception. When an Auth version stops answering it, every bearer request is
refused, closed, at middleware and at these checks, until `verifyBearer` and
these checks move to `GET /oauth/userinfo` (ADR-008 decision 6;
`docs/setup.md` tells an operator what that looks like). A bearer token without a matching mark
throws, and so does any bearer token while `MGM_CLIENT_TOKENS` is off: a
second fence for pages and for any page or route the middleware matcher
skips, where nothing removes a mark the client set, which therefore never
matches. Every other request gets the cookie client as before. Nothing else builds a client on a bearer token
(`request-session.test.ts`).

The client records who it acts for (`recordCaller`; `callerOf` reads it,
and reads any client `createClient` did not make as a browser session).
`openOrganizationScope` puts it on `mgmRequest.caller`, read from the
client, never from the composer. The GUI host's routes open their request
with `openHostRequest` (`src/lib/gui/host/server/http.ts`), which puts it
on the host context (`HostContext.caller`) and refuses an agent client
(`403 gui_agent_refused`) on every route but the two that opt in. There an
agent client gets less (`src/lib/gui/host/server/agent.ts`):

- the catalog gives it an organization's catalog only: any `entity=` is
  refused, so no tenant, bill, payment, tenant access or person (`org.user`)
  reaches it by id, and no action's `available()` is asked;
- the view route gives it only an organization's view marked
  `agent: "read"`, and answers any other view, tenant views included, as a
  page that does not exist, before any read;
- `prepareAction` refuses it, whatever route calls it;
- each step first asks the assistant plugin's gate for the organization as
  a write (ADR-007 decision 5, `assistantGate`). No `assistant` plugin is
  bundled yet, so every agent step is refused (`409 assistant_disabled`);
  `agent.test.ts` fails when one is bundled, so that what a marked view
  gives an agent beyond its model (its actions, attached and embedded
  views) is settled first.

The host's own reads on these two routes run on the agent's client, whose
token reaches the database as `mgm_agent` (`20261126160000`, CLAUDE.md):
the person's role rows and the ids and names of their organizations, which
the catalog and every organization view read before they ask the
assistant's gate. The rows the host reads for a view's path (a
community's, a microgrid's, an edge's, in `resolveSegments`) are not
granted yet; they come with the first marked view whose path names one.
`bearer-session.db.test.ts` sends a real agent token to the catalog and
expects `409 assistant_disabled`.

An operator client holds the person's access: nothing grants or refuses
anything by that kind. For a new `/api` route:

- It is open to operator clients, like a browser session, and closed to
  agent clients unless it is added to `AGENT_ROUTES`, which is a change to
  what an assistant can reach.
- A route that must take only a browser session refuses clients itself:
  it builds its client with `createClient` and answers `403` unless
  `callerOf(client).kind === "browser"`, before it reads anything, with a
  test that an operator client's token is refused. Recording the person's
  approval of a client (ADR-008 decision 2) is one; ending another person's
  client (decision 5) is likely another. Middleware does not know which
  routes these are.
- A webhook, worker or other caller with no MGM session cannot
  authenticate with `Authorization: Bearer <secret>`. Middleware reads any
  bearer header on a released path as a client token, public paths
  included, and refuses it (`401`, or `403 client_tokens_off`) before the
  route runs; a scheduler that sends its secret that way, such as a Vercel
  Cron job, never reaches the route. Such a route takes its secret in a
  header of its own, as the payments worker does
  (`x-payments-worker-secret`), and compares it with `secretMatches`
  (`@/lib/security/constant-time`).

## GUI surface

`mgmSurface` holds what capabilities contribute to GUIs (views, actions,
navigation, signals, status, search, entity kinds) and the metadata of the
GUIs compiled into the build. It is a root service, not a request one:

- Contributions are code, identical for every organization and request, so
  they are checked once per process, like the catalog. A platform plugin
  registers each one with `ctx.effect(() => ctx.mgmSurface.contribute(…))`,
  so unloading it removes the contribution.
- It holds definitions and functions, never request data. Each loader call is
  handed its own request (the caller's RLS client and checked user) as an
  argument.
- Whether a plugin is enabled for an organization is data. Code that serves
  a request must filter contributions by the gate's plugin state for that
  organization; it does not unload them.
- A request scope isolates every `REQUEST_SERVICES` name, and a scope that
  isolated `mgmSurface` would see no contributions. So it stays out of that
  list, and `runtime.test.ts` checks that a request scope reads the root's
  registry.

`contribute()` and `install()` throw on any broken rule, naming the plugin or
GUI and the path. The platform plugin then fails and the runtime does not
start, payments included. That is acceptable only because both are
deterministic: they read the contribution, the GUI metadata and the catalog,
never the environment, network or database. `runtime.test.ts` builds the same
root in the `Test` gate, so it refuses exactly what production would.

Plugins see `ctx.mgmSurface` typed as `MgmSurface`, the write side. The host
reads definitions only through `surfaceSnapshot()`
(`src/lib/gui/host/server/snapshot.ts`), and serves a contributed view with
`GET /api/gui/view?href=<page>` after checking the caller's session.
`POST /api/gui/prepare` returns an action's form, confirmation, route and
method for the same caller; it writes nothing, and the write goes to the
action's own route. `GET /api/gui/signals?org=<id>` and
`GET /api/gui/search?q=<text>&prefix=@|#&org=<id>` run contributed watchers
and searches for the caller's organization, each only while its plugin is
enabled and each within its own time budget, so one slow plugin cannot hold
the others. The registry is privileged in
`service-role-session-check.test.ts`: the functions it holds can compose
capabilities, and a call made through it cannot be followed by import, so
every file that names it is tracked.

Two more host routes describe MGM to a client other than the page, such as
the CLI (RFC #259 § 3). Both are GET, read only, and stay out of
`GUI_HOST_API_ROUTES` (`src/lib/mgm/released-routes.ts`) until the CLI ships
(RFC #259 § 7), so a released installation answers 404 for them; tests call
the handlers directly. Each takes only the parameters below, and any other
key is a 400.

- `GET /api/gui/manifest?path=<page>&org=<id>` answers the manifest the
  (gui) layout renders, from the same `buildManifest`, with the interface
  `MGM_GUI` selects and the same hints, in this order: the organization of
  the records `path` (a released page on this site) names, then `org` (or,
  only when `org` is absent, the `?org=` of `path`), then the org cookie,
  and failing all of them the person's first organization. As on the
  page, a hint naming an organization the person cannot see is passed
  over, so such an `org` answers another organization's manifest where
  the catalog below answers 404, and a path's records outrank `org`. A person who sees no
  organization but holds a unit gets the tenant manifest, whose `org` is a
  unit, whatever `org` says. A client that asks for one organization, such
  as `mgm places --org`, checks `manifest.org.id` against it. Views reach
  it as navigation entries, as the page gets them.
- `GET /api/gui/catalog?org=<id>`, or `?entity=<kind>:<id>` up to four
  times, each of another kind, answers an `ActionCatalog`
  (`src/lib/gui/contract.ts`): every registered action, in catalog order
  and then by id, with its route pattern, bind, input JSON Schema (as
  prepare serves it), confirmation, `targeted`, `repeat` and availability.
  An `org` the person cannot see is a 404; without one, the org cookie and
  then the first organization choose. Entities decide the organization, as
  a view's path does, and limit the list to actions offered on their kinds,
  each filled and asked its own `available()`. A person who reaches no
  organization but holds a unit, or whose rows are all tenant rows, gets no
  actions, since every action is a staff route.

An entry's `confirm` is the level of the step the GUI host shows before it
sends, and the host sends the confirmation that step asks for. The route
stays the authority and checks that confirmation on every write (ADR-006,
decision 10), so a client other than the host sends what its entry's level
asks for too. The typed deletes refuse a request without it: billing's
period delete answers 428 `billing_delete_confirmation_required`, and
community management's three (`DELETE /api/communities/[id]`,
`/api/microgrids/[id]` and `/api/tenants/[id]`) answer 428
`*_delete_confirmation_required`, each naming the record to type; a
confirmation with another name, or none typed, answers 428
`*_delete_name_mismatch`. Nothing is deleted on either. The community
page and the tenants list send the name their dialogs ask for; no page
deletes a microgrid, which only the GUI host's typed step does. Community management's access removal is a
ceremony with nothing to tick or type, so its route has nothing in it to
check.

The organization directory's three typed deletes work the same way.
`DELETE /api/organizations/[id]` asks for the organization's name (428
`organization_delete_confirmation_required` or
`organization_delete_name_mismatch`), and the organization page's delete
dialog sends it. `DELETE /api/organizations/[id]/email-sender` asks for the
saved mail server's name while one is saved (`email_sender_delete_*`), and
the email settings page asks for it. `DELETE /api/users/[id]` asks for the
person's email address (`user_remove_confirmation_required` or
`user_remove_email_mismatch`), which the Users page's revoke dialog asks
for. That route reads the person through `fn_list_visible_users` with the
caller's own client first. Anyone that list does not show the caller gets
the route's single 403 at once, whatever confirmation the body carries, so
the 428 names an address only to someone who can already see it. An org
manager's delete matches no colleague's row today (the `user_roles` SELECT
policy shows a manager only their own rows), so `org.remove-user`'s prepare
refuses anyone but a super admin with that same 403. A role change
(`PATCH /api/users/[id]/role`) is a ceremony with nothing to tick or type,
and its route has nothing in it to check.

An entry's `availability` lists each check that refused it in `reasons`,
and each check not decided in `unchecked`, so `available: true` means only
that nothing refused it:

| Check | Refused with | When |
|---|---|---|
| `installed` | `gui_not_released` | its route, filled or as a pattern, is not released (`POST /api/gui/prepare` answers the same action 404 `gui_not_found`, as it answers one that does not exist) |
| `enabled` | the gate's code and copy, such as `billing_disabled` | its plugin is off, unless it declares `whilePluginOff: "enabled"` |
| `healthy` | `<plugin>_gate_unavailable` (hyphens as underscores) | the gate could not be read or threw; `enabled` is then undecided |
| `healthy` | `gui_availability_unchecked` | `available()` was late, threw, or gave no usable answer; `state` is then undecided |
| `state` | `gui_action_unavailable`, with the action's own reason | `available()` said no |
| `configured`, `authorized` | never | always undecided: no contract field models configuration, and a route may check its own roles (the payment-status route refuses `failed` and `refunded` to anyone but a super admin) |

A role check an action can make before its write is reported only in one
of two places. An action with no confirmation step has no prepare, so it
refuses by role in `available()`, and the catalog reports it under
`state` (the organization directory's `org.update-organization` and
`org.update-profile`); an action with a step refuses in its prepare, and
the catalog leaves `authorized` undecided, as above.

`state` is also undecided without entities, when a bound kind is not
given, when the action has no `available()`, and when an earlier check
refused it. The request itself is refused with one of the host's codes
below, such as `gui_not_found` for an `org` the person cannot see.

Every host route answers a refusal in `ActionResult`'s failure shape with
`error` beside `message`, carrying the same text (`HostFailureBody` in
`src/lib/gui/contract.ts`, sent by `hostFailure` in
`src/lib/gui/host/server/http.ts`), so it also has the `{ error, code }`
shape the gate and `parseJsonBody` answer. A client reads `code`, which is
stable, and shows `error`. An action route's own refusals were written
before the described API and are not all alike: some carry `code`, many a
`reason` instead, some only `error`, and those billing's composer and
capability build carry `message` in place of `error`. The GUI kit reads
`code` when there is one, and `error`, else `message` (`failureOf` in
`src/lib/gui/host/client/invoke.ts`); the OpenAPI document describes them
the same way (`ActionRefusal`).

The described API's error codes are listed in one place,
`src/lib/gui/host/server/error-codes.ts`, each with what it means and the
statuses it comes with: the host's `gui_` codes, the catalog's reasons
among them; the gate's two refusals, `<plugin>_disabled` (409) and
`<plugin>_gate_unavailable` (503); `invalid_body` (400), which
`parseJsonBody` answers on every action route; and each code an action
lists in `prepareAgainOn` (409), its route's own, on which the host
prepares the action again (`PREPARE_AGAIN`). An action route's other codes
are its own too and are not listed yet, since no field of an action names
them. `openapi.test.ts` fails while an operation names a code the
document does not list at that status. `error-codes.test.ts` fails while a
`gui_` code written in the host's server modules or routes is missing from
the list, a listed one is written nowhere, or a status written beside a
code is not listed for it, and it asks the gate and `parseJsonBody` for
theirs. Two answers come from
middleware before any route and carry no code: a 401 `{ error }` for an
API request with no session, and a plain-text 404 for a path not
released.

A watcher (`signals` in a contribution) reports what needs someone in one
organization: a period not closed, a month with no period, a payment held for
reconciliation, checkouts that never reached the provider. The
host runs it only for a person with a staff role in that organization (a
person whose rows are all tenant rows gets a 403 and no watcher runs), on a
request of its own, so it reads through the person's own client or a
capability's reads after its composer. It filters by the organization
itself, since a super admin's row-level security shows every organization,
and throws when a read fails, so the host lists it as unchecked rather than
as having nothing to report. The host refuses a watcher's whole answer when
any signal breaks its schema, repeats an id, links anywhere but a released
page, or leads anywhere but a page its own plugin owns, and when it returns
more than `MAX_SIGNALS_PER_SOURCE` (50, in `src/lib/gui/surface.ts`), so a
watcher caps itself, most urgent first. It sends each id prefixed with the
watcher's (`<watcher id>:<id>`). Watchers run on every load of the signals,
which an interface may poll, so they read the database, with one kind of
exception (ADR-006 decision 9): a cached provider read made through the
capability after its composer has authorized the organization, with a TTL
cache, a bounded number of reads at once, a timeout within the watcher's
budget, and only while its plugin is on. `metering.edge-status` is the one
such watcher: after reading the organization's microgrids with an OpenEMS
backend and edges, it composes metering and asks each backend which
gateways (edges) are online, through a per-process cache keyed by microgrid
(`src/lib/metering/infrastructure/edge-status-cache.ts`: five minutes, a
failure one minute, reads under way shared, at most four at once in the
process across every caller, each timing out at 2 s within its 3 s budget).
It examines every such microgrid up to 500, and is unchecked past that. It
reads microgrids never read first, then those read longest ago, so
successive loads rotate through an organization too large to read in one
budget. A read still under way at the deadline is reported as not read for
this load and finishes into the cache for the next; one that never got a
slot leaves nothing behind. It returns at most 50 signals, offline gateways
ahead of quiet meters, and both ahead of what could not be read. An organization with no such
microgrid composes nothing and calls no backend, so a local database and
the browser smoke stay deterministic. A microgrid whose read fails or times
out is reported as such, a signal about that site, and the watcher is
unchecked only when the organization's own database reads fail. Beside
each status read it makes a second cached read under the same rules and
slots: each meter's `ActivePower` history at five-minute resolution, one
request per edge (`src/lib/metering/infrastructure/meter-activity.ts`).
Meters (consumption, grid and PV devices with a component id)
on an online gateway with no reading for half an hour are one signal per
microgrid, after the offline gateways; a meter read that failed is a signal
that the meters could not be checked, and one with no answer by the
deadline is left for the next load. Batteries, inverters and EV chargers
are not asked about, since their power channel depends on the driver or
the OpenEMS version. Each declares examples,
which `contribute()` parses and `gui-surface.test.ts` holds to the plugin's
own released pages. Severities follow fixed rules, listed in ADR-006
decision 9; the installed app's badge counts only the `warn` and `critical`
signals (`attention` in the answer), while the tray and Today show every
one.

What a contribution names is checked in CI by
`src/lib/gui/__tests__/gui-surface.test.ts`, against the snapshot of the root
it boots: each action's route file, method, gate and release, and that the
route parses its body with the action's own `input` from the plugin's
`schemas.ts`; each view's examples, declared names and links; each watcher's
examples' links. It also reads
every module a contributing plugin's surface module loads, and refuses any
capability method outside its `LOADER_READS`, so a new contributing plugin
lists the module that exports its contribution in `SURFACE_MODULES` there,
as an `@/` specifier. That module's exports must reach every function the
plugin registered.

A route described after it shipped may keep the answers it gave bad bodies
before: `parseJsonBody` (`src/lib/validation/parse-body.ts`) takes the
route's own refusals (`BodyRefusals`, its options' `refusals`), which
replace its generic 400 for each issue the route answered itself.
Community management's routes do (the `*_REFUSALS` in
`src/lib/community-management/schemas.ts`, which its `schemas.test.ts`
holds to the capability's own answers); a new route answers the generic
400. A path segment that names a plugin's own entity
kind resolves through the `organizationOf` the plugin contributes.
Community management's `community.tenant-access`, a tenant's access to its
unit, is the first: an org manager cannot read the role row it names, so
it resolves only beside the tenant whose access list holds it
(`tenantAccessOrganization`).
The organization directory's `org.user`, a person by account id, resolves
through `fn_list_visible_users` with the caller's own client, the list the
Users page shows. It resolves to the organization of the person's
organization manager row (`userOrganization`). A person the caller cannot
see, a person whose rows are all tenant rows, a super admin and an account
with no role row all resolve to nothing, so the host answers 404 for them.
The user actions therefore do not reach super admins through the host; the
Users page still does.

The reverse direction is checked by
`src/lib/runtime/__tests__/described-writes.test.ts`: every write handler
under `src/app/api` on a released path is named by an action, or listed in
`UNDESCRIBED_WRITES` (`src/lib/runtime/__tests__/route-rules.ts`), either as
permanent, with the reason the route cannot be an action (no person sends
it; it writes nothing, since a `POST` that only reads, such as the OpenEMS
connection test, is not an action; or it must refuse every caller but the
person's own cookie session on one of MGM's pages, as the consent page's
`POST /api/auth/oauth/approvals` does, while an action is offered to any
signed-in caller, a client's bearer token included), or as not yet
described, with the issue in `DESCRIBING_ISSUES` that will describe it.
Unlike the gate rule (§ "The gate"), it covers core plugins. It finds
handlers with the TypeScript AST and checks that the gate rule's handler
finder sees each of them.

While a plugin is off for an organization (the gate's 409, asked as a write
by `pluginGate` in `src/lib/gui/host/server/gate-state.ts`), the host still
serves its views of cost `db`, with the gate's notice followed by the
loader's own (`dispatchView` and `shownNotice`), and refuses its `vendor`
views. `attachedViews` lists its sections and leaves out its tabs and tiles,
unless an attachment declares `whilePluginOff: "listed"`. `actionRef`
(`src/lib/gui/host/shared/merge-actions.ts`) shows its actions disabled with
the gate's copy on its own views and leaves them out of other plugins', and
`prepareAction` refuses them with the gate's 409, unless an action declares
`whilePluginOff: "enabled"`: that one is shown enabled on its own plugin's
views and prepared, with its `available()` and `prepare` run as usual. Only
the 409 is passed over: an unreadable gate (503, or a throw) still disables,
refuses and leaves out everything. The same 409 skips the plugin's
watchers in the signals, unless a watcher declares `whilePluginOff:
"checked"`; an unreadable gate lists each as unchecked. `gui-surface.test.ts` allows
`whilePluginOff` on an action only where its `METHOD /api/route` is a
`PaymentExemption` in `UNGATED_WRITES` naming a method that
`capability-gating.test.ts` (`GATING`) says runs while the plugin is off, on
a Payments or Pesapal action, so the host never offers a write its route
refuses. It allows `attach.whilePluginOff`, and a watcher's `whilePluginOff`, only on
a Payments or Pesapal view or watcher, while every Payments method in
`LOADER_READS` runs while off. The
helpers it reads for this (`paymentsGating`, `PAYMENT_EXEMPTION_OWNERS`) are
in `src/lib/runtime/__tests__/route-rules.ts`, shared with
`route-surface.test.ts`.

Every action declares `repeat`, what a second identical send does (ADR-006
decision 11): `"safe"` (it writes nothing, though it may answer unlike the
first), `"keyed"` (the route takes a repeat key) or `"unsafe"` (it may write
twice). Registration requires the field. `gui-surface.test.ts` (check 12)
refuses `"unsafe"` on a billing, payments or Pesapal action unless
`REPEAT_KEY_PENDING` (`src/lib/gui/__tests__/repeat/exemptions.ts`) names the
issue building its repeat key. `src/lib/gui/__tests__/repeat.db.test.ts` is
the evidence for each `"safe"`: it sends the action twice to its route
against a database, as the person it is offered to, and fails if the second
send changes a row of the tables its snapshot reads, apart from a timestamp
column of one named row that a case lists with its reason. Every `"safe"`
action has a case there, in its plugin's module under
`src/lib/gui/__tests__/repeat/`, and the test refuses `"keyed"` until a route
takes a key.

A view is about an organization's records unless it says otherwise:
`scope: "installation"` serves an installation-wide view (no organization),
and `scope: "tenant"` a view about one unit the caller rents (RFC mgm#197 §
4). A tenant view's path has no segments; the host picks the unit from the
caller's own tenant rows (`?unit=<tenants.id>`, or their only unit,
`chooseTenantUnit` in `src/lib/gui/host/shared/tenant-units.ts`), reads
nothing of an organization, asks no gate, offers no action and never embeds
it in another view. Its loader gets a `TenantRequest` and authorizes the unit
itself through `composeTenantApp`, which also refuses while the tenant app is
off for the unit's organization. Nav entries carry an audience, `staff` by
default, `super-admin` or `tenant`; a tenant entry names a tenant view, and
any entry that leads to a tenant view is a tenant entry. A tenant view is
never attached to another view and never read by an assistant (#133's data
boundary). `contribution-schema.ts` refuses a contribution that breaks any of
these, and `credential-canary.db.test.ts` dispatches each tenant view as a
tenant of every seeded unit.

Tenant entries are shown by the plugin state of the caller's own units'
organizations (`fn_tenant_home` gives each unit's organization, and the gate
is asked with the tenant's own session), never by that of the organization
the manifest is built for, so a manager who rents elsewhere sees both groups.
A person whose rows are all tenant rows sees no organization, whatever
staff rows they held before (the host reads the rows held now): the host
gives them the tenant manifest (`buildTenantManifestModel` in
`src/lib/gui/host/shared/manifest-model.ts`), whose `org` is their current
unit, whose places are their units and whose nav is tenant entries only.
Every page under `src/app/(gui)` sends them to tenant pages, deny by
default, as its first call (`keepTenantOnlyToTenantPages` in
`src/lib/gui/host/server/tenant-pages.ts`), and the (gui) layout does the
same when it renders. A page is a tenant page when the catalog has a view
serve it and the contributed view whose path fits it has scope `tenant`
(`isTenantPage`, which reads the surface, so a new tenant view needs no list
edited). From any other page, `/` and every staff page included, they are
sent to `/my` before the page opens a client or loads a view, and never to
`/setup`. The page's call is the one that holds: a client-side navigation
within the `(gui)` group skips the layout, rendering from the first segment
that changes, but always renders the page. It sends them away and grants
nothing; what they can read is still decided by RLS (their own tenant,
`tenant_devices` and device rows, which they could query directly), with
`dispatchView` refusing them every view that is not a tenant view. `/my` is
a released route (`src/lib/mgm/released-routes.ts`); should it stop being
one, they are sent to `/no-access` instead, which has Log out: middleware
would answer `/my` with the static "not in this release" page, which has no
script and links back to `/`. `/no-access` is outside the layout, and
sign-out is a Supabase Auth call from the browser, so neither sends them
round. Otherwise they reach `/no-access` only when the manifest refuses
because none of their units can be read. The
layout's test walks every catalog page and every page file under
`src/app/(gui)` as such a person, and `tenant-only-pages.test.tsx` calls
every page file without the layout, as a client-side navigation renders it,
and fails when one opens a Supabase client or loads a view before the
redirect. Every staff entry point of the host also
refuses them by their roles: `surfaceRequest`, `installationRequest`, `pluginGate`,
`visibleOrganizations` (none), `resolveSegments`, `dispatchView` for any
view that is not a tenant view, and `buildActionCatalog` (no actions, or a
404 when the query names an organization or an entity, with nothing read). A tenant view opened without `?unit=` by a
person with several units shows a choice of them, and one whose plugin is
off for the unit's organization shows the "not in this release" page. The
choice leaves out a unit whose organization has the tenant app, or a plugin
it depends on, off for certain, decided as the tenant nav decides it
(`unitOrganizationPlugins` in `src/lib/gui/host/server/gate-state.ts`); a
unit whose state could not be read stays, and its view answers for itself.
When every unit is left out, the person gets the "not in this release" page.

A person may rent any number of units, in any organizations, and nothing in
the host holds them to one. Each unit is named by its unit label, else the
tenant's display name (the tenant's own name, which their units share), with
its microgrid added where two of their units would read alike
(`src/lib/gui/host/server/units.ts`); a unit that cannot be read is left out
rather than failing the others. Choosing another unit changes only `?unit=`,
so `HostKitProvider` rebuilds the manifest for it, as it does for `?org=`,
and the shell's context, clock and remembered unit follow.

### The OpenAPI document

`docs/api/openapi.json` is an OpenAPI 3.1 document of the described API,
generated from the runtime root's surface snapshot by `openApiDocument`
(`src/lib/gui/host/server/openapi.ts`):

- one operation per action route, however many actions are sent to it:
  its path parameters, each of the kind its actions bind; the whole body
  the route parses (`describeBody`, bound fields and `confirmation`
  included), required unless the route reads an empty body as `{}`
  (`EMPTY_BODY_ROUTES`); the codes it refuses with, `invalid_body`, the gate's two
  unless its actions declare `whilePluginOff`, and its `prepareAgainOn`
  codes; and under `x-mgm-actions` each action as the catalog describes it
  (`describeAction`), so the two cannot disagree. Each of its refusal
  responses says its list is partial (`x-mgm-codes-complete: false`), and
  its 401 is middleware's or the route's own, for a session Supabase Auth
  refuses. A write's answer and the route's own codes are not described
  yet;
- one operation per host route (`HOST_ROUTES` in the same file), its
  answer described by the strict schema the host parses it with, and the
  codes it refuses with;
- `x-mgm-error-codes`, the list from `error-codes.ts`, and on each
  response the codes it carries (`x-mgm-codes`);
- `x-mgm-released` on each operation, false for a route middleware does
  not serve in this build: the catalog and the manifest until the CLI
  ships (RFC #259 § 7).

`info.version` is `GUI_CONTRACT`, and the document says the API is
experimental while that is 0.x; the generator throws once it is not, so
the stability statement is decided again then. It says too what that
version does not cover: the actions, routes and codes the document lists
change from one release to the next while `GUI_CONTRACT` stays, and an
action's body is versioned by its own `inputVersion`. It is deterministic, so one
commit always generates the same file. `npm run api:openapi` writes it,
and `src/lib/gui/host/server/__tests__/openapi.test.ts`, in the `Test`
gate, fails while the committed file differs from what the registry
generates, while a registered action or a host route file
(`src/app/api/gui/`) is not described, or while the gate's codes on an
action route disagree with `UNGATED_WRITES`. The generator runs under
vitest rather than as a script, because it needs the runtime root's
modules resolved as the tests resolve them. Anything the generator reads
changes the file, a route's release and `GUI_CONTRACT` included, so a
merge conflict in it is resolved by taking either side and running
`npm run api:openapi` again. Publishing the document with each release is
not done yet (#282).

## The gate

Every released API route enters the runtime. Routes that use a capability go
through a composer. Routes whose bodies still query Supabase directly call
`gateRoute()` first:

```ts
const gate = await gateRoute(supabase, {
  plugin: METERING_PLUGIN_NAME,
  target: { kind: "edge", id: edgeId },
  method: request.method,
});
if (gate) return gate; // 409 <plugin>_disabled or 503 <plugin>_gate_unavailable
```

The gate resolves the target's organization with one RLS-scoped query and asks
the database whether the plugin is enabled for that organization
(`mgm_plugin_enabled_for_org`). That function answers any signed-in caller,
tenants included, about any organization; who may act there is the
composer's check, not the gate's.

A missing `mgm_plugins` row means enabled, so existing organizations need no
backfill, except for a plugin the catalog marks `defaultEnabled: false`, as
it marks the tenant app and the operations plugin: that plugin is off for an
organization until an operator turns it on there, so no organization's
tenants get an app nobody switched on (RFC mgm#197 § 3), and no
organization's investigations share the installation-wide evidence budget
without opting in (#133). `mgm_plugin_enabled_for_org` names those
plugins in SQL, while Settings → Plugins reads `defaultEnabled`
(`resolvePluginStatuses`, and `validatePluginToggle` for a plugin's
dependents). `src/lib/plugins/__tests__/default-off-plugins.test.ts` reads
the list from the newest migration that defines the function and fails while
it differs from the catalog's, so a plugin's default changes on both sides in
one commit, the SQL side in a new migration. The same test fails while a
bundled plugin is missing from `mgm_plugins_name_known`,
`mgm_plugin_audit_log_plugin_known` or `fn_mgm_set_plugin_enabled`, so a new
plugin ships with the migration that names it.

Policy:

- **Writes** (`POST`, `PUT`, `PATCH`, `DELETE`) on a non-core plugin return
  `409 <plugin>_disabled` while the plugin is off. Stored data is preserved.
- **Reads** stay available, matching the "disabling preserves data" promise in
  Settings → Plugins. The tenant app is the exception: `composeTenantApp`
  asks the gate as a write, so its reads refuse too, and a tenant of an
  organization that has it off is shown the "not in this release" page
  (RFC mgm#197 § 3).
- A target the caller cannot see resolves to no organization; the route's own
  404/403 handling applies (RLS remains the authority).
- If organization or plugin state cannot be read, writes fail closed with
  `503 <plugin>_gate_unavailable`.
- Core plugins (organization directory) are never gated.

The `409`/`503` part of this policy, with the gate's codes and copy, is also
applied without calling the gate: by `composeCommunityManagement`,
`composeMetering` and `composeBilling` (§ "Two lifetimes"), by the
re-checks in their capabilities before a write, and by the Payments
checkout (`requirePlugins` in `src/lib/payments/capability.ts`). A change to the policy or the copy in
`gate.ts` must be made in each of them as well; `compose-fail-closed.test.ts`
and `capability-gating.test.ts` compare their refusals with the gate's.

`src/lib/runtime/__tests__/route-surface.test.ts` fails the build when any
API `route.ts` — released or not — has a write handler (including inventoried
external-call GETs) that neither calls a composer that refuses its plugin nor
calls `gateRoute`/`checkGate`, or when the route has no owner in the
catalog's `routes` lists. The check is per handler, so a gated `PATCH` does
not cover an ungated `DELETE` in the same file. This is a source-level
guardrail, not a proof of all control flow. Direct `gateRoute` calls are
parsed as TypeScript and must check and return their blocked response; comments
do not count. Branches, composer result handling, and mutation ordering still
require review. `runtime-gate-wiring.test.ts` executes the direct gated routes
with 409 and 503 decisions and verifies they return before subsequent database
work. GETs constructing an OpenEMS client must appear in the external-call
inventory and declare `access: "write"`. Add behavioral coverage for new
mutation routes; a composer call alone does not prove its result is checked.

A composer call counts as gating only if the composer refuses a disabled
plugin before opening its scope (the table above; the test's `COMPOSERS` map
is the list it checks against). `composeBillingReview` does not count, and
neither does `composeBilling` called with `readOnly: true` (or with options
the test cannot read statically): routes using them call `checkGate`/`gateRoute`
themselves. A route that calls `previewBills` is one: preview can re-pin an
empty draft period's tariff, so it is a billing write even though it saves no
bills, and preview mode skips the capability's plugin check (the capability
checks only for generation in write mode), so the route's gate is the only
check on that path. Such a route composes first, so the composer settles
organization access (`401`/`403`) before the gate's `409`/`503` can reveal
whether billing is on; calls `checkGate` inside the `try` whose `finally`
disposes the scope; and answers `404` unless the gate resolved the target to
the organization the scope was authorized for. `POST
/api/billing/regenerate-preview` was the worked example until it was removed
with nothing left calling it (#201's Deletes); no route passes `readOnly`
today.

### Payments

The payments composers open their scope whatever the plugin state, because
most of the capability must keep working while Payments is off:
`docs/payments-rollout.md` requires that "plugin disablement blocks new
checkout while keeping history and verification available", and the
`payments_disabled` message also promises reconciliation. Only
`ensureCheckout` reads plugin state to refuse: `409 payments_disabled` or
`pesapal_disabled` while either plugin is off, `503 payments_gate_unavailable`
when their state cannot be read, before it obtains a provider or writes
anything. The reads (`getReadiness`, `stablePaymentLink`, `listHistory`),
verification of attempts already submitted (`refreshPaymentStatus`,
`handleNotification`) and `reconcile` run regardless. `getReadiness` answers
`disabled` when either plugin reads as off, and refuses with
`503 payments_unavailable` when a state cannot be read and neither plugin
reads as off, rather than say payments are turned off when they may not be.
Its callers (the invoice PDF route, the billing period page and the send
queue) offer a payment link only for `ready` or `sandbox` and treat that
refusal as no link, so an invoice renders without one instead of failing; a
new caller does the same. If a caller starts failing on that refusal, revisit
this paragraph and the comment in `getReadiness`. The `503` relies on the payments repository rejecting
when it cannot read the state, as `isPluginEnabledForOrg` does; a repository
that reads a failure as `false` answers `409` instead.

The payments composers do not count as gating. Their write routes (the
stable link, refresh, reconcile, the IPN webhook and the notification worker)
reach capability methods that only read or keep running while Payments is
off. So each is listed in `UNGATED_WRITES`
(`src/lib/runtime/__tests__/route-rules.ts`) as a `PaymentExemption` naming
the one method it reaches. route-surface reads the whole route file, not
only the handler, since helpers, code that runs when the module loads and
sibling handlers can all run for it. It checks that the file composes
Payments and calls only that method on the capability. It checks that the
file hands neither the capability nor its composition on, whether by
aliasing the composer, destructuring the result or passing it along, and
reaches the capability no other way. It also checks that
`capability-gating.test.ts` classifies the method as available while
disabled, that Payments or Pesapal owns the route, and that the file
consults no plugin gate (`gateRoute`, `checkGate`, the plugin-state helpers
or their database function), since an exemption says the route accepts the
write while its plugin is off and the GUI host relies on that. A route whose
exemption is a plain reason may not reach the capability at all, under any
import name or module path. A new payments write route fails the build until
it calls `checkGate`/`gateRoute` itself or carries a `PaymentExemption`.
For the same reason the GUI host keeps `payments.refresh-attempt`,
`payments.record-adjustment` and `payments.accept-receipts`, whose routes are
the refresh and reconcile exemptions, enabled and preparable while Payments
is off, and still lists the period review's Payments tab
(`payments.bill-attempts`), through the `whilePluginOff` fields described
under "GUI surface".

Two other tests hold what those methods and routes may do.
`src/lib/payments/__tests__/capability-gating.test.ts` classifies every
capability method, with the reason each available one may run. It checks the
provider operations and writes each method performs with the plugins off and
with their state unreadable. `payments-route-boundary.test.ts` follows every
import from `src/app`, the middleware and the instrumentation hook. It fails
when a request can reach a provider or write payment records other than
through the capability. It also checks every route Payments or Pesapal owns
that composes the capability, its GETs included. Such a route fails when the
code it runs does any of the following outside the capability: writes a
table, calls a database function, invokes an Edge Function, makes a Supabase
Auth call other than a read, reaches `fetch`, or imports a package outside
the allowlist `ROUTE_PACKAGES`. A write counts however its `from` or `rpc` is
spelled, with element access or through `.call`, `.apply` or `.bind`. Each
exception states why it is allowed while Payments is off: merchant setup,
community overrides, manual payment recording under Billing, the webhook's
and worker's notification queue, and each allowed package. If either test is
dropped, the payment exemptions lose their footing, and the payments write
routes must gate themselves with `checkGate`/`gateRoute`.

### Callers without a user session

The payments webhook and worker run without a logged-in user and still enter
the runtime. They compose through `composePaymentsPublic` and verify through
`handleNotification`, which stays available while Payments is off (see
"Payments" above).

The OpenEMS proxy routes (`/api/openems/*`) call the vendor with stored
credentials, so they are gated like writes (`access: "write"`) even when
the HTTP method is `GET`.

`/api/openems/*` is still outside the released-route allowlist
(`src/lib/mgm/released-routes.ts`), so middleware answers 404 until a release
opens it. It is on the runtime already, so opening it is an allowlist change,
provided each of its write handlers is named by an action or listed in
`UNDESCRIBED_WRITES`, as `described-writes.test.ts` requires of every
released write handler (§ "GUI surface"). Its one write handler today,
`POST /api/openems/channels`, is listed already; if a handler is added there,
or that entry goes, revisit this.

## Catalog pages

Each plugin in `src/lib/plugins/bundled.ts` lists the signed-in pages it owns
in `pages`. A page is its path as spelled under `src/app`, with route-group
folders left out, and the entity kind (one of `CORE_ENTITY_KINDS`) of each
bracketed segment: `/microgrids/[id]/billing/[periodId]` is a microgrid and a
billing period. A page carries `servedBy: "view"` once a contributed GUI view
serves it instead of a `page.tsx`. A page that switches to a view deletes its
`page.tsx` in the same commit (`catalog-pages.test.ts` fails otherwise), and
the host's catch-all (`src/app/(gui)/[[...path]]/page.tsx`) then serves it
outside any segment layout, such as `microgrids/[id]/layout.tsx`: the page
loses that layout's header, tabs and notices, and shows the GUI's own dock
and trail instead. A billing screen's page switches only once no row of
that screen in `src/lib/billing/parity.ts` is pending (`parity.test.ts`).
Every billing page under a microgrid is served this way since a period's
review switched (the last to), so `microgrids/[id]/layout.tsx` and its
timezone nudge now frame only Setup's pages.

`getRouteOwner` reads page paths as ownership prefixes beside `routes`, so
`/microgrids/[id]/operations` belongs to metering and `…/setup/rates` to
billing. No page path starts with `/api` (the test below checks this), so
API ownership, and with it the gate checks above, is unchanged.
`matchCatalogPage(pathname)` gives the page a URL is, its plugin and its
segment values; a fixed segment beats a bracketed one, as in Next.js.

`src/lib/plugins/__tests__/catalog-pages.test.ts` walks `src/app` and fails
when a plugin page has no catalog entry or an entry has no `page.tsx`, when
a page path starts with `/api`, when a bracketed segment's kind differs from
the one its name gives in `SEGMENT_KINDS`, when a page's owner differs from
`PAGE_OWNERS`, when a page's release state differs from
`src/lib/mgm/released-routes.ts`, or when `getRouteOwner` gives a page to a
plugin that does not list it. A page that is not released yet is listed in
`UNRELEASED_PAGES` with a reason, and pages the host serves outside any
plugin (sign-in, password reset, first-run setup) in `HOST_PAGES`.

## Database verification

`src/lib/runtime/__tests__/gate.db.test.ts` runs in the `rls` project
against the local Supabase CI starts. It checks every target kind's
organization lookup through real PostgREST and RLS for an org manager, a
super admin and an outsider, and that disabled plugins refuse writes.
`src/lib/supabase/__tests__/tenant_access.test.ts` asks
`mgm_plugin_enabled_for_org` for each bundled plugin of an organization
with no state rows and expects the catalog's defaults, and checks that a
tenant reads the tenant app's state for their own organization with their
own token but cannot change it.

## Lifetime notes

- The root is created at most once per module instance. In development, HMR
  can re-evaluate the module and create a new root; the old one holds no
  resources and is garbage-collected.
- Request scopes must be disposed in `finally`. A scope that is never
  disposed stays registered on the root for the life of the process, holding
  the caller's Supabase client. `scope-dispose.test.ts` fails the build
  unless every composer call is bound alone to a `const`
  (`const c = await composeX(…)`) and followed, past `if (!c.ok) return`
  guards or inside `if (c.ok) { … }`, by a `try` whose `finally` starts with
  an unconditional `[await] c.data.dispose()` (or `c.dispose()`): no code
  before it, no condition, `&&`, `?.`, argument or closure around it, and not
  in a generator, which never runs its `finally` if abandoned. A composer may
  be referenced only as the callee of such a call, so storing, passing,
  re-exporting or dynamically importing it fails, in the module that defines
  it as much as anywhere else. Only the composer modules may bind
  `openOrganizationScope`, and there only a composer calls it: in its own
  body, or through an unexported function that only composers call. Neither
  they nor `runtime/scope.ts` may hand it on under another name. Names are
  resolved through each file's imports, renamed and namespace imports and the
  `@/lib/community-management` and `@/lib/runtime` barrels included. A new
  composer module goes in the test's `COMPOSER_MODULES`; until it does, its
  own `openOrganizationScope` binding fails the test.
- `compose-concurrency.test.ts` composes billing and metering for two
  organizations at once. It checks that each composition runs on its own
  organization's client, that disposing one organization's scopes makes its
  capabilities refuse while the other's keep working, that plugin state is
  read per organization, and that the root registry returns to its starting
  size. `compose-fail-closed.test.ts` checks that a composer refusing on
  plugin state opens no scope, and that one whose capability fails to load
  disposes the scope it opened.
