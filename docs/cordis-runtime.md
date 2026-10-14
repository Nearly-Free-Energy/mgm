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
| `metering-providers` | `meteringProviders` — registry of metering provider factories | — |
| `openems-metering` | registers the `openems` factory | `meteringProviders` |
| `payment-providers` | `paymentProviders` — registry of payment provider factories | — |
| `pesapal` | registers the `pesapal` factory | `paymentProviders` |
| `community-management`, `metering`, `billing`, `billing-review`, `payments` | capability *plugins* (loaded per request, see below) | `mgmRequest` + the platform services they need |

Platform plugins hold no request data, credentials, or database clients.
Provider factories receive the request's Supabase client when a request asks
for a provider, so RLS always applies to the caller. Adding a second metering
source or payment provider is a new platform plugin that registers into the
existing registry; nothing in billing or the routes changes. Metering plugins
register a factory and an optional `supports(client, microgridId)` selector
that reads their own configuration through the caller’s RLS-scoped client.
Billing uses `forRequest(client)` and does not choose a vendor. Exactly one
matching provider is required; ambiguous selections fail closed. OpenEMS is
the compatibility fallback for existing microgrids. A configured non-fallback
provider takes precedence, and selection errors never fall back silently.

**Request (one per API call).** Authenticated composers call
`authorizeOrganization()` to authenticate and check organization access.
`openOrganizationScope()` is a low-level constructor accepting an already
authorized request; it does not authenticate or authorize. Public payment
callers establish their separate bearer-token/notification verification boundary.
It creates an *isolated* child context of the root. Isolation gives the request its own `mgmRequest`, capability and
registry slots, so concurrent requests on one warm instance never share a
capability. The request scope plugin provides `mgmRequest`; capability plugins
are then loaded into that child and declare `inject: ["mgmRequest", ...]`.
Disposing the scope fiber unloads every capability that injected it — Cordis
does the cascade — and each capability's `isActive` guard turns false, so a
reference retained after the request cannot write.

The five composers (`composeCommunityManagement`, `composeMetering`,
`composeBilling`, `composeBillingReview`, `composePayments` /
`composePaymentsPublic`) keep their signatures and error codes; they are now
thin adapters over `openOrganizationScope()`.

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
(`mgm_plugin_enabled_for_org`). Policy:

- **Writes** (`POST`, `PUT`, `PATCH`, `DELETE`) on a non-core plugin return
  `409 <plugin>_disabled` while the plugin is off. Stored data is preserved.
- **Reads** stay available, matching the "disabling preserves data" promise in
  Settings → Plugins.
- A target the caller cannot see resolves to no organization; the route's own
  404/403 handling applies (RLS remains the authority).
- If organization or plugin state cannot be read, writes fail closed with
  `503 <plugin>_gate_unavailable`.
- Core plugins (organization directory) are never gated.

`src/lib/runtime/__tests__/route-surface.test.ts` fails the build when any
API `route.ts` — released or not — has a write handler (including inventoried
external-call GETs) that neither composes
a capability nor calls `gateRoute`, or when the route has no owner in the
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

### Callers without a user session

Two kinds of route run without a logged-in user and still enter the runtime:

- **Customer-app API (`/api/v1/*`).** The per-org API token resolves the
  organization (`resolveOrgFromToken`). Write routes check microgrid and
  period ownership first — keeping the 404-before-403 order that hides
  other organizations' records — then call `gateRoute` with
  `{ kind: "organization", id: <token org> }` on the service-role client.
  Bill generation takes its OpenEMS source from the root
  `meteringProviders` registry, like the dashboard's billing capability.
- **Payments webhook and worker.** These compose through
  `composePaymentsPublic`; checkout and settlement are gated inside the
  Payments capability.

The OpenEMS proxy routes (`/api/openems/*`) call the vendor with stored
credentials, so they are gated like writes (`access: "write"`) even when
the HTTP method is `GET`.

`/api/v1/*`, `/api/openems/*` and `/api/org-api-tokens/*` are still outside
the released-route allowlist (`src/lib/mgm/released-routes.ts`), so
middleware answers 404 until a release opens them. They are on the runtime
already, so opening them is an allowlist change only.

## Database verification

`src/lib/runtime/__tests__/gate.db.test.ts` runs in the `rls` project
against the local Supabase CI starts. It checks every target kind's
organization lookup through real PostgREST and RLS for an org manager, a
super admin and an outsider, and that disabled plugins refuse writes.

## Lifetime notes

- The root is created at most once per module instance. In development, HMR
  can re-evaluate the module and create a new root; the old one holds no
  resources and is garbage-collected.
- Request scopes must be disposed in `finally`. Each composer documents this.
