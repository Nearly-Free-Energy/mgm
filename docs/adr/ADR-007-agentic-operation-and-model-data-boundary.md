# ADR-007: Agentic operation through A3, and the model data boundary

## Status: Accepted

Accepted by tushabe on 25 November 2026, after the changes arindahills
asked for were made
([review](https://github.com/Nearly-Free-Energy/mgm/pull/261#pullrequestreview-6063252173)).
Corrected on 25 November 2026 to agree with ADR-008 (#290):
decisions 1, 5, 8 and 10. It records what #133 settled for
agentic operation through milestone A3, the decisions recorded on #133
on 25 November 2026, and what #259, accepted that day, settles for an
agent client. On that day the A0 owner moved this ADR ahead of A0's
cases, example answers, fixture set and manual baseline. The cases still
ratify A3's acceptance, and may amend this ADR when they do.

## Context

#133 is the adopted roadmap for agentic operation in MGM, in milestones A0
to A6. Its A0 milestone asks for a short ADR covering capability ownership,
logical lifetimes, durable operations, the relationship between domain
contracts, GUI contributions and agent tools, the agent's identity, and the
model data boundary. This is that ADR. It cites ADR-001 (the Cordis
decision: the import boundary, the exact pin and the exit rule) and ADR-006
(the GUI contract), restates each #133 point it relies on, and adds only
what agentic operation changes.

At `ef222e4e` the repository has the parts an assistant would read through,
and no assistant:

- A view may declare `agent: "read"`; nothing else lets an assistant read
  it (`src/lib/gui/surface.ts:166-167`). No registered contribution
  declares it; only a billing test fixture does.
- Registration refuses the mark on a tenant view
  (`src/lib/gui/host/server/contribution-schema.ts:262-266`; the type says
  `agent?: never`, `surface.ts:194-201`) and on a view reached from
  configure or system navigation (`contribution-schema.ts:476-478`).
  Nothing refuses it on a billing or payments view, on a view with a
  device segment, or on a view that takes signals.
- A signal watcher has no mark (`surface.ts:340-360`), and its strict
  schema refuses an `agent` key as unknown (`contribution-schema.ts:377`).
  Four watchers exist: `billing.period-due`, `metering.connection`,
  `payments.reconcile` and `payments.failed`.
- Every contributed action is `humanOnly: true`, and prepare refuses an
  action an assistant proposed when it is human-only
  (`src/lib/gui/host/server/prepare.ts:168`).
- The host asks the plugin gate as a write, with the organization as its
  target, on every view (`src/lib/gui/host/server/gate-state.ts:30-35`). A
  plugin's own entity kind reaches an organization through the
  `organizationOf` it contributes (`surface.ts:370-374`).
- The plugin catalog has no assistant or operations plugin
  (`src/lib/plugins/bundled.ts:11-19`).

Whatever this ADR adds must keep these where they are, as #133 does:

- tenant isolation enforced in the database, row-level security on new
  tables, and the meanings of the existing access helpers;
- released-route controls, credentials handled on the server, deterministic
  financial calculations, immutable closed periods, and billing-period
  closure by a person only;
- every mutation, from any path, entering its owning capability or the
  runtime boundary; discoverability or a manifest declaration never grants
  authority.

## Decision

Decisions 1 to 5 restate what #133 settled, with what #259 adds for an
agent client. Decisions 6 to 11 record the model data boundary. The items
decided on #133 on 25 November 2026 are cited as "item N of 25 November".
Where this ADR words or proposes something #133 or #259 left to it, it
says so.

1. **Through A3 an agent acts only as the signed-in operator.**
   - It has that person's access and nothing more, and never runs on the
     service role.
   - Each step is an ordinary authenticated request in the operator's own
     session, so the capability composers authorize it again. Operation
     records never hold a user token or request context.
   - Through A3 there is no background worker, queue or delegated
     identity, and process-local Cordis events are notifications only.
   - An agent client (#259 § 2) is not a delegated identity: it is the
     signed-in person, with no worker and no service role. MGM's routes
     refuse it everything but the catalog and the view route for marked
     views (#259 § 2).
     A marked view's loader may still read on the server after a
     `getUser()`-backed check, as it does for a browser session (decision
     8): that read belongs to the view, not to the agent client.
   - Its token reaches the database as `mgm_agent`, a select-only role of
     its own (#259 decision 12) that the token hook sets (shown by #268).
     The role is `NOLOGIN` and granted to `authenticator`, never made a
     member of `authenticated`, so it reads only what grants and policies
     give it. It has no write grant on any table, so an invoker function
     it can call through `PUBLIC` cannot write. A definer function is
     closed to it only by that function's own `REVOKE … FROM PUBLIC`, which
     CLAUDE.md requires of every definer function, and a guard test checks
     the role against every definer function (ADR-008 decision 7). A new
     table is out of its reach until a migration grants it (#274). A table with columns outside decision
     6's boundary is granted to it by column, so the database holds that
     part of the boundary beneath MGM's checks. The one exception is
     `user_roles`, granted whole under a `RESTRICTIVE` policy that limits
     the role to `user_id = auth.uid()`, so the only user id it reads there
     is the caller's own, which no loader puts into a model (ADR-008
     decision 8).
   - If the role is not built, #259 § 5 waits and the question returns to
     #259 § 2, so no agent client reads anything.
   - Unattended work needs its own reviewed design for worker identity,
     queueing and settlement before it is built. That review starts from
     two fixed points: a new role value with its own row-level-security
     helper, which leaves existing policies untouched, and the scheduled,
     leased worker pattern payment reconciliation already uses.
2. **Capabilities own the work, and each record arrives with its first
   consumer.**
   - Investigations, planning, operations and control are capability-owned
     behaviour; the platform stays small. Services express commands and
     queries; events express facts, and Cordis's process-local events and
     any durable business events have different delivery guarantees.
   - A2 builds the operation and evidence records and the investigation's
     result; A3 adds the agent session; proposal, authorization and
     execution records wait for A5 and A6. Operations connect work across
     capabilities; they do not replace measurement records, billing
     ledgers or ordinary synchronous writes.
   - Composition has three levels: installation (the bundled packages),
     site (a microgrid's configured providers and capabilities) and
     operation (the versions, evidence and authority it used). A step
     rebuilds its logical scope; it does not keep a process or a session
     alive. Plugin enablement stays per organization through A3; enabling
     a capability per site changes the plugin gate and needs code-owner
     review.
3. **Durable operations are a capability, with a boundary in the database
   as well as in TypeScript.**
   - An operations plugin owns the operation and evidence records. #255
     (the evidence design, not yet merged) states them as requirements on
     A2.
   - No API role writes those tables directly. Each write is one database
     function (create, capture, transition, result), and each function
     checks in SQL what a direct call over PostgREST would otherwise skip:
     the caller's access through `user_can_access_microgrid`, the
     operations plugin's state through `mgm_plugin_enabled_for_org`, the
     operation's state, and the content's shape and size. So a direct call
     enters the capability under the composer's checks.
   - One write is an exception, as #255 sets out (E1, O3, § 8). While Q6
     (retention by delete on write) stands as proposed, create also runs
     the retention pass, which ends and deletes expired operations across
     all organizations. It skips the caller-access and operation-state
     checks, records no actor, returns nothing about what it changed, and
     is the only write that touches operations the caller may not read.
     Proposed here: each call deletes at most a fixed number of rows, so no
     caller pays for a backlog, and the function pins `search_path =
     public, pg_temp`. If Q6 settles on another mechanism, this exception
     changes with it.
   - Proposed here, as #255 § 10 asks, for the reviewer: the tables' policy
     shape is **read-only to the API roles**, with each grant naming its
     role:
     - Each table has one `FOR SELECT` policy `TO authenticated, mgm_agent`
       that calls `user_can_access_microgrid` with the row's microgrid id,
       and no INSERT, UPDATE or DELETE policy.
     - `authenticated` is granted SELECT and has INSERT, UPDATE and DELETE
       revoked. `mgm_agent` is granted SELECT by column, without the
       capturer column or any other staff user id (decision 6), and
       `EXECUTE` on `user_can_access_microgrid`, the one helper the policy
       calls; the helpers that one calls run as their owner.
     - The write functions are `SECURITY DEFINER`. They revoke `EXECUTE`
       from `PUBLIC` and `anon` as CLAUDE.md requires, grant it to
       `authenticated`, and revoke it from `service_role` explicitly unless
       A2 gives the structural reason to keep it. `mgm_agent` is not a
       member of `authenticated`, so it gets none. They decide by the
       caller only through `auth.uid()` and the helpers.
     - No operations table joins the `supabase_realtime` publication
       until what `mgm_agent` may receive from it is decided (#268).
     - No helper body changes, and CLAUDE.md names this third policy shape
       beside the `FOR ALL` staff policies and the `FOR SELECT` tenant
       policies.
     - If `mgm_agent` is not built (decision 1), the policies are
       `TO authenticated` alone, and no restrictive policy keyed on the
       client's id takes the role's place (#259 decision 12).
   - Left to A2, as #255 leaves them: whether the service role may call
     the write functions (with the structural reason CLAUDE.md asks for),
     whether the operations plugin is off by default, and how the
     TypeScript side gates each step.
4. **Domain contracts, GUI contributions and agent tools stay separate.**
   - MGM owns the energy contracts. Domain logic imports no concrete
     vendor, and new domain contracts stay independent of the chosen
     harness and of Cordis (ADR-001).
   - A capability's GUI integration is a contribution under ADR-006.
   - Through A3, agent tools read domain data only from views marked
     `agent: "read"`, through the GUI host, and a guard test fails the
     build for any domain-data read tool outside that set. Deterministic
     calculations use approved capabilities over authorized inputs and
     open no other read path. Investigation-record writes go through the
     operations capability (decision 3). This couples assistants to the
     shape of views; revisit it if an investigation needs data no view
     carries.
   - GUI contract v0's agent-readable, proposable and human-only
     distinctions (`agent: "read"`, and `ProposableAction` / `HumanAction`
     at `src/lib/gui/surface.ts:276-286`) and its confirmation rules
     (ADR-006 decision 10) stay (#133): an assistant may propose only an
     action whose `humanOnly` is false, a proposal is not authority to
     execute, and autonomous writes need their own reviewed contract. No
     GUI flag enables them. Since #259 § 4 (accepted 25 November 2026, and
     #133 edited to match), "human-only" means refused to an agent client,
     by the client's kind at the server and the database rather than by a
     prompt, so a person may run such an action from the CLI as from the
     browser.
5. **The assistant is an optional plugin, off until an operator turns it
   on, and each of its steps is gated like a write.**
   - It is a non-core plugin. Its model provider registers only when the
     installation's model credential, a server-only setting, is set, as
     the fixture metering provider registers only while
     `MGM_METERING_FIXTURES` is on. MGM works fully with no model
     configured, and no other capability depends on the assistant.
   - Once the credential is set, the assistant stays off for each
     organization until an operator turns it on in Settings → Plugins
     (item 5 of 25 November): `defaultEnabled: false` in the catalog and
     the plugin in `mgm_plugin_enabled_for_org`'s default-off list, in one
     commit, as `default-off-plugins.test.ts` requires. Sending an
     organization's data to a model provider is that organization's
     choice.
   - Every assistant step, including one that only reads and calls the
     model, asks the gate with `access: "write"` and is refused while the
     plugin is off for the organization. Turning it off stops new steps.
     Turning a capability off follows the gate's existing policy: reads of
     stored data stay available and vendor-backed reads refuse.
   - The switch holds at MGM's routes and the bridge, not at the
     database: an agent token reads through the database API what
     `mgm_agent` is granted whatever the switch says, which is no more
     than the person could already read (ADR-008, Consequences). An
     installation that wants no assistant at all removes the agent client
     from MGM's table.
   - Text that comes from the database or a vendor system is untrusted in
     model context: data to analyse, never instructions.
6. **What may reach a model.** A model receives only what marked views
   and marked watchers emit through the host, and from those only:
   - readings and values calculated from them, and device types;
   - the ids of the organization, community, microgrid, edges and devices
     in scope, and OpenEMS edge and component ids;
   - the names of the organization, community, microgrid and edges, which
     name sites and equipment (item 4 of 25 November);
   - worded here, for the views and watchers on the first list (decision
     8): the dates and IANA time zones of the windows a view shows; the
     times of events MGM itself recorded that a view or watcher reports,
     such as when a connection check last ran (a signal's `at` and its
     facts); MGM's own fixed copy; same-origin MGM paths built only from
     the ids, dates and fixed copy above (a signal's `href`, site-day's
     `dayHref`); the ids of an operation and of its evidence records; and
     the closed codes and schema keys of a view's model and of #255's
     evidence and result schemas, including its citations (an evidence id
     and an RFC 6901 pointer over those keys, array indices and device
     ids). For the investigation view, #255 § 4's closed string allowlist
     (uuids, the date, IANA zones, closed codes, checked edge and component
     ids, RFC 6901 pointers) is the binding form of this list.

   In a tenant view (decision 10), read only by an agent client signed in
   as that tenant (#259 § 5), the following may also appear: the tenant's
   own id as the view's entity, and its unit label or display name (item 6
   of 25 November). Nothing else about a tenant may appear, in a tenant
   view or any other.

   **Devices are named by id, never by name.** A device is identified by
   its id or its OpenEMS component id, never by `devices.name`: a
   consumption meter can be a tenant's primary meter and be named after
   them, and a meter shared with another unit can be named after that
   unit's tenant, so a marked view labels devices by component id and
   type. This holds in tenant views too (confirmed by tushabe on 25
   November 2026).

   Outside in every view: contact details and payment data, the EMS
   address and user name, staff user ids, and message text. Outside in
   every staff view (item 4 of 25 November): tenant names, address columns
   and coordinates, and device names. A timestamp or path taken from
   vendor or free text stays outside too, such as the stored error text of
   a connection check, which `metering.connection`'s signals already leave
   out. Edge and component ids come from the database or a vendor, so they
   stay untrusted text in model context (decision 5) even when their shape
   is checked.
7. **Three checks in MGM hold the boundary, all in place before the first
   view or watcher is marked.** `mgm_agent`'s grants hold it beneath them
   at the database (decision 1).
   - **The contribution check.** Registration refuses the mark, beyond what
     it refuses today, on any view or watcher of the billing and payments
     plugins (item 3 of 25 November for watchers), on a view with a tenant
     or device segment in its path, and on a view that takes signals. It
     also refuses the mark on a view or watcher that is not on the
     code-owned list, on a marked view whose declaration differs from its
     list entry, and on a view that declares a key prefix (decision 8).
     The check reads only the contribution, the catalog and that list, so
     it stays deterministic (ADR-006 decision 3).
   - **The read interface A1 adds.** It serves only marked views, and that
     applies to embedded and attached views too. It refuses a model that
     carries a reference to a tenant, a billing period or a payment, except
     that a tenant view served to an agent client signed in as that tenant
     may carry a reference to that tenant (decision 10). An unmarked view
     attached to or embedded in a marked view is left out of what an
     assistant reads, with a note that a section was withheld, and the
     marked view is still served (item 2 of 25 November). The same holds
     for signals: only a marked watcher's signals reach an assistant.
   - **The code-owned list** (decision 8). Its review is what keeps text
     typed into cells out of a model, such as a list of tenants at
     microgrid scope, which no mechanical check can recognise.
8. **Marks are listed in code, under code-owner review.**
   - A watcher takes the same `agent: "read"` mark as a view (item 3 of 25
     November).
   - Confirmed by tushabe on 25 November 2026: the list is one constant
     under `src/lib/gui/`, which is code-owned (ADR-006 decision 7),
     holding the ids of marked views and marked watchers. It starts empty.
     Each entry is added in its own pull request, reviewed by a code owner
     against decisions 6 and 7, and marks the view or watcher in the same
     commit. Removing an entry removes the mark.
   - Proposed here: each view entry pins the view's declaration: its
     `declares.keys`, its `ext.schema` id, and the key paths of its
     `ext.zod` schema (found by the same structural walk `strictProblems`
     makes in `contribution-schema.ts`). The contribution check refuses a
     marked view whose declaration differs from its entry, so widening a
     marked view needs an edit under `src/lib/gui/`, reviewed like a new
     entry. The pin lands with the list's first entry at the latest.
   - A listed view declares every key by name. The contribution check
     refuses the mark on a view that declares a key prefix (#284), since a
     key added under a prefix would reach a model with no edit under
     `src/lib/gui/`.
   - A watcher entry pins only its id: a signal's fields are fixed by the
     contract (`SignalOut`, `src/lib/gui/surface.ts`), which is already
     code-owned, and its facts are values with no keys of their own.
   - Each entry's pull request adds the view's or watcher's surface and
     model files to `.github/CODEOWNERS`, so later edits to what they emit
     get code-owner review. That is still a social contract (#30), but it
     covers what the pin cannot see.
   - Before a listed view is served to an agent client, its loader reads
     under `mgm_agent` only columns granted to it (decision 1). Anything
     more it reads on the server after a `getUser()`-backed check, as it
     does for a browser session, and it puts only values inside decision 6
     into its model (ADR-008 decision 7). Both listed views
     that exist today select `devices.name`
     (`src/lib/metering/infrastructure/supabase-repository.ts:170`,
     `src/lib/tenant-app/infrastructure/supabase-repository.ts:85`), which
     the role is never granted, so the pull request that first serves
     each view to an agent client changes those reads.
   - The first list, approved here for those pull requests:

     | Entry | Kind | Condition |
     |---|---|---|
     | The investigation view (decision 9) | view | Marked in the pull request that builds it (A3's, #255 § 12) |
     | `metering.site-day` | view | `billing.savings`, its attached section, is withheld, and so is its time-zone notice (item 2 of 25 November). Its house meters reach it under `mgm_agent` only through a definer function that checks `user_can_access_microgrid` for the caller and returns the house-meter ids in force for that microgrid and day, or the view says by name that house figures are not available to an assistant (ADR-008 decision 8) |
     | `metering.connection` | watcher | The only watcher that qualifies today (item 3 of 25 November); listed by tushabe's confirmation of 25 November |
     | `tenant.home`, `tenant.usage-month`, `tenant.usage-day` | view | Decision 10 |

   - The time-zone notice carries the microgrid's free-text country
     (`src/lib/timezone/nudge.ts:25-26`), and site-day carries it in its
     ext (`src/lib/metering/surface/site-day-ext.ts:42`), not in the
     model's `notice`. So withholding it is a rule about that view's
     content, not about an attached view; A1 chooses how, and its test is
     that no text of the notice reaches the read interface's output.
9. **Evidence reaches a model through a stored evidence view** (item 1 of
   25 November).
   - The operations plugin contributes one view per investigation, at
     `/microgrids/[microgridId]/investigations/[operationId]`, marked
     `agent: "read"`. It serves the stored snapshot and result
     (`site-day-evidence/1`, `site-day-result/1`, #255 §§ 4-5), never a
     live read, so a model sees exactly what the result cites.
   - The operation is an entity kind the operations plugin declares and
     resolves through its own `organizationOf`, so the plugin gate needs
     no new target.
   - Through A3, stored facts are vouched for by the capturing operator's
     session (item 7 of 25 November, as #255 § 2 proposes). The capturer
     column, which the caller cannot set, traces each record to a person.
     Revisit before evidence is used as proof against its own capturer, or
     before anything captures evidence without a signed-in person; either
     needs a server-held attestation (#255 § 12).
10. **Tenant views are on the first list** (item 6 of 25 November).
    arindahills accepted #259 as code owner on 25 November 2026, § 4 and
    § 5 included
    ([review](https://github.com/Nearly-Free-Energy/mgm/issues/259#issuecomment-7153527024)),
    and tushabe added two sentences to #133 to match that day
    ([comment](https://github.com/Nearly-Free-Energy/mgm/issues/133#issuecomment-7166783972)).
    A tenant view is readable only by an agent client signed in as that
    tenant, so its unit label or the tenant's own name reaches only that
    tenant's own assistant, never a staff one. **No tenant view is marked
    until #259's tenant-phase pull request (D2) lands.** Besides the contract
    rule, CLAUDE.md and the read interface's tenant-reference refusal
    (decision 7), it does the following.
    - Meter labels: what `tenant.home` gives the read interface labels each
      meter by its component id and type, never by `devices.name`
      (`src/lib/tenant-app/surface/home-model.ts:65`), and its loader stops
      selecting that column for an agent client (decision 8). Item 6's
      exception covers the unit label and the tenant's own name only, and a
      shared meter can be named after another unit's tenant. Its test is
      that no `devices.name` reaches the read interface's output.
    - Meter keys: `tenant.home` declares its meters under the prefix
      `meter.` (`src/lib/tenant-app/surface.ts:78`), which decision 8
      refuses on a listed view. D2 gives the meters fixed keys or takes them
      out of the view, and removes what #284 keeps for tenant views until
      then: the prefix rule's tenant exemption and the tenant app's
      `"refused"` in `ASSISTANT_READING`.
    - Policies and grants: a copy of each of the three tenant policies
      `TO mgm_agent`, the grants the tenant views' loaders need, and
      `EXECUTE` for the role on `user_can_access_tenant`,
      `user_is_tenant_of_device`, and the definer functions the tenant
      loaders call with the caller's client: `fn_tenant_home`,
      `fn_tenant_shared_meter_days` and `mgm_plugin_enabled_for_org`
      (ADR-008 decision 7).
    - Tenant names at the database: the staff policy on `tenants` names no
      role, so once `mgm_agent` may read any column of `tenants`, a staff
      member's assistant could read every tenant's name in the
      organization (#268). Whichever pull request first grants `mgm_agent`
      anything on `tenants` or `tenant_devices` adds a `RESTRICTIVE` policy
      `TO mgm_agent` on `tenants` that calls `user_can_access_tenant`, with
      a database test that a staff member's assistant reads no tenant
      row. It adds the same policy on `tenant_devices`, as #268 tested and
      ADR-008 decision 8 records. Restricting `tenants` alone would not
      keep `tenant_devices` readable for a staff member's assistant: the
      staff policy on `tenant_devices` looks up the tenant's microgrid in
      `tenants` as the caller (`00002_rls.sql`), so it would read no link
      either. `metering.site-day`, which reads those links with the
      caller's client to find house meters
      (`src/lib/metering/infrastructure/supabase-repository.ts:210`), gets
      them under the role only as its first-list condition says (decision
      8). That pull request adds two policies, edits none, and updates
      CLAUDE.md's policy section.
11. **A mark grants nothing.** It only lets an assistant read what the
    signed-in person could already read there: the view's loader, the
    plugin gate, the composers and row-level security still decide that,
    and the assistant's own gate (decision 5) is asked first.

## Open, with owners

- #255's open questions keep the owners named there. Q10 (an evidence
  view, its scope, and the time-zone notice) is settled by decisions 8 and
  9. tushabe answered Q6 (retention by delete on write) and Q7 (cascade
  on microgrid deletion) as proposed on 25 November 2026
  ([comment](https://github.com/Nearly-Free-Energy/mgm/pull/255#issuecomment-7152066520)),
  and asked arindahills to confirm or object there.
- How the read interface recognises a tenant, billing period or payment
  reference was left to the A1 pull request that builds it. A1-1 settles
  it in `src/lib/gui/host/server/assistant-references.ts`, applied by
  `readForAssistant` (`assistant-read.ts`) to every model and signal it
  gives out. It reads both entity references (`entity`, `related` and a
  `ref` value) and hrefs (`href`, `link` and `next`). It refuses a
  reference of the kinds the contribution check refuses in a path
  (`ASSISTANT_REFUSED_KINDS`: tenant, device, rate schedule, billing
  period, line item and payment attempt, and community management's
  `community.tenant-access`, a tenant's access to its unit, whose label is
  the person's address, and the organization directory's `org.user`, a
  person) or of a plugin kind whose plugin
  is unknown or refused; an href that leaves the origin, names no view or
  catalog page, has a segment of a refused kind, names a view or catalog
  page of a refused plugin or a tenant view (bare or with any search
  parameter, since a refused plugin's `query` is never reviewed against
  this decision and can name a tenant or a bill), carries a search
  parameter its view does not declare or a fragment, or is any API route
  (an assistant is given no action or download, and an API path can name
  a tenant or device whatever plugin owns it); and a link's share or
  download. A listed view that emits one is
  refused whole, as a review failure. `ext.data` is not read by name:
  the list's review and its pin cover it (decision 8).
- That goes beyond decision 7's tenant, billing-period and payment
  references on purpose. A device reference's label is the device's
  name, which decision 6 keeps out of every staff view, and a rate
  schedule or line item is billing's record, whose plugin decision 7
  already refuses. Refusing them makes a future view that lists devices
  unreadable to an assistant until it labels them by component id.
- The action catalog (#293) stays out of the read interface. Decision 6
  admits only what marked views and watchers emit, and a catalog reason is
  an action's own copy, which a refused plugin's `available()` writes.
  Giving an assistant the catalog needs a written reading of decision 6
  and refused plugins' reasons turned into codes first.

## Consequences

Better:

- An assistant reads the same views a person sees, through the same host
  checks, so it gains no read path a person lacks, and the data it may see
  is a short, reviewed list rather than whatever a loader happens to emit.
- A marked view keeps working when a section attached to it is withheld,
  so one billing section does not keep `metering.site-day` from an
  assistant.
- Evidence a model reads is the stored record a result cites, so an answer
  can be checked against what the investigation actually held.

Worse, or to watch:

- Coupling to view shapes: a change to a marked view's model changes what
  a model sees. Review alone catches new text in a declared key and the
  text a marked watcher writes into its signals (decision 8). If a marked
  view's loader starts filling an existing key from a different column,
  revisit its entry.
- Decision 10 conflicts with today's code (`surface.ts:194-201`,
  `contribution-schema.ts:265`, `src/lib/tenant-app/surface.ts:19-21`) and
  with CLAUDE.md's tenant-view rule until #259's tenant-phase pull request
  (D2) lands. Until then the code wins.
- The meter name a tenant sees in the GUI may differ from what their
  assistant is given (decision 10). If a tenant view is ever readable by
  anyone but its tenant, revisit decisions 6 and 10.
- The investigation view's path has a segment of a plugin's own kind, and
  catalog pages take only core kinds today (`bundled.ts:61-72`); every
  microgrid page is spelled `/microgrids/[id]/…`. Its catalog entry (A3's,
  #255 § 12) needs both settled, under code-owner review.

## Alternatives considered

- **A read API for models beside the views.** Refused by #133: it would be
  a second business API, with its own access rules to keep in step.
- **Evidence read live when a model asks.** Refused (item 1 of 25
  November): a model would see values the stored result does not cite.
- **Refusing a marked view whole when an unmarked view is attached to
  it.** Refused (item 2 of 25 November): it would keep `metering.site-day`
  from every assistant for the sake of one billing section.
- **Reading signals through Today.** Refused: Today carries other plugins'
  tiles, billing's among them, so signals are marked per watcher (item 3 of
  25 November).
- **The assistant on wherever a model credential is set.** Refused (item 5
  of 25 November): the credential is the installation's, the data is each
  organization's.
- **Server-held attestation of evidence now.** Deferred (item 7 of 25
  November): it needs an owner, a runbook entry and a reconciliation with
  "nothing on the service role".

## References

- #133: invariants, A0 (model data boundary, ADR scope), A1 to A3; the
  decisions of 25 November 2026 (issuecomment-7151922210) and A0's order
  as changed that day (issuecomment-7152556012); A0's status map
  (issuecomment-7149087376).
- #255, `docs/investigation-evidence.md` (E1, O3; §§ 2, 3, 4, 5, 8, 10,
  11, 12, 13).
- #259 §§ 2, 4 and 5, and decision 12; arindahills's acceptance
  (issuecomment-7153527024); #268's result, posted on #259
  (issuecomment-7168074158).
- ADR-008 (decisions 7 and 8: the agent role, its grants and its
  policies; #283).
- #263, #264, #274 and #284.
- ADR-001; ADR-006 (decisions 3, 7, 8, 9 and 10).
- `src/lib/gui/surface.ts`, `src/lib/gui/host/server/contribution-schema.ts`,
  `src/lib/gui/host/server/view.ts`, `src/lib/gui/host/server/signals.ts`,
  `src/lib/gui/host/server/prepare.ts`, `src/lib/plugins/bundled.ts`,
  `src/lib/plugins/__tests__/default-off-plugins.test.ts`,
  `supabase/migrations/20261118140000_tenant_app_plugin.sql:192-208`.
