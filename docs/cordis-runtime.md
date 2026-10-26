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

The three composers that refuse a disabled plugin check access first, so a
caller without it gets `401`/`403` and learns nothing about the plugin. They
then read plugin state with `isPluginEnabledForOrg`, the read the gate makes,
and refuse with the gate's codes and copy before opening any scope:
`409 <plugin>_disabled` while the plugin is off, `503 <plugin>_gate_unavailable`
when its state cannot be read (`community_management_…` for community
management). The per-plugin helpers (`isBillingEnabled` and the rest) would
not do: supabase-js answers a failed read with `{ error }` rather than
rejecting, and they read that as disabled. `compose-fail-closed.test.ts`
compares each refusal with the gate's for the same client and checks that no
scope was opened.

The plugin can be turned off between composition and a write, so the
capabilities behind those three composers read its state again before they
act: `requirePlugin` in `src/lib/billing/capability.ts` before each billing
write, `requirePlugin` in `src/lib/metering/capability.ts` before each
metering write or provider call, and `requireCommunityPlugin` in
`src/lib/community-management/operations/shared.ts` before each community
write. They read through their Supabase repository, which also uses
`isPluginEnabledForOrg` and rejects when the state cannot be read, and refuse
with the same `409` or `503` before anything is written or called. Billing's
`previewBills` saves nothing and does not re-check (see
`POST /api/billing/regenerate-preview` below). The capabilities' unit tests
check that each method in their `WRITES` / `GATED` tables re-checks before it
acts; the tables are kept by hand, so a new gated method is covered only once
it has a row there. `compose-fail-closed.test.ts` also writes through each
composed capability with the plugin turned off after composition, or its
state unreadable at the re-check, and compares the refusal with the gate's.

`composeBillingReview` takes the `organizationId` the route resolved and
trusts it. Its only caller, `POST /api/billing-review/preview`, resolves that
id through `checkGate` on the caller's RLS-scoped client, so a period the
caller cannot see yields no organization and a 404. A new caller must do the
same.

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

The `409`/`503` part of this policy, with the gate's codes and copy, is also
applied without calling the gate: by the three composers that refuse a
disabled plugin (§ "Two lifetimes"), by the re-checks in their capabilities
before a write, and by the Payments checkout (`requirePlugins` in
`src/lib/payments/capability.ts`). A change to the policy or the copy in
`gate.ts` must be made in each of them as well; `compose-fail-closed.test.ts`
and `capability-gating.test.ts` compare their refusals with the gate's.

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

A composer call counts as gating only if a disabled plugin is refused on that
path: by the composer (the table above) or, for the payments composers, by
the capability (below). `composeBillingReview` does not count, and neither
does `composeBilling` called with `readOnly: true` (or with options the test
cannot read statically): routes using them call `checkGate`/`gateRoute`
themselves. `POST /api/billing/regenerate-preview` is the worked example —
preview can re-pin an empty draft period's tariff, so it is a billing write
even though it saves no bills. `previewBills` runs generation in preview mode,
which skips the capability's plugin check (the capability checks only for
generation in write mode), so the route's gate is the only check on this path.
The route composes first, so the composer settles organization access
(`401`/`403`) before the gate's `409`/`503` can reveal whether billing is on.
It calls `checkGate` inside the `try` whose `finally` disposes the scope, and
answers `404` unless the gate resolved the period to the organization the
scope was authorized for. Its route test pins that order.

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
`handleNotification`) and `reconcile` run regardless; `getReadiness` reports
unreadable state as disabled, so an invoice renders without a payment link
instead of failing. The `503` relies on the payments repository rejecting
when it cannot read the state, as `isPluginEnabledForOrg` does; a repository
that reads a failure as `false` answers `409` instead.

Two tests let route-surface count `composePayments` and
`composePaymentsPublic` as gating.
`src/lib/payments/__tests__/capability-gating.test.ts` classifies every
capability method, with the reason each available one may run, and checks the
provider operations and writes each performs with the plugins off and with
their state unreadable. `payments-route-boundary.test.ts` follows every
import from `src/app`, the middleware and the instrumentation hook, and fails
when a request can reach a provider or write payment records other than
through the capability, or when a route Payments or Pesapal owns that
composes the capability writes or calls out itself. Each of its
exceptions (merchant setup, community overrides, manual payment recording
under Billing, the webhook's and worker's notification queue) states why it
is allowed while Payments is off. If either test is dropped, the payments
routes must gate themselves with `checkGate`/`gateRoute`.

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
  `composePaymentsPublic` and verify through `handleNotification`, which
  stays available while Payments is off (see "Payments" above).

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
- Request scopes must be disposed in `finally`. A scope that is never
  disposed stays registered on the root for the life of the process, holding
  the caller's Supabase client. `scope-dispose.test.ts` fails the build
  unless every composer call outside the composer modules is bound alone to a
  `const` (`const c = await composeX(…)`) and followed, past
  `if (!c.ok) return` guards or inside `if (c.ok) { … }`, by a `try` whose
  `finally` starts with an unconditional `[await] c.data.dispose()` (or
  `c.dispose()`): no code before it, no condition, `&&` or closure around it,
  and not in a generator, which never runs its `finally` if abandoned. A
  composer may be referenced only as the callee of such a call, so storing,
  passing, re-exporting or dynamically importing it fails, and only the
  composer modules may bind `openOrganizationScope`. Names are resolved
  through each file's imports, renamed and namespace imports and the
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
