# ADR-006: MGM GUI contract v0, experimental

## Status: Accepted

The contract this records is experimental while its version is 0.x
(decision 6).

## Context

MGM's capabilities (community management, metering, billing, payments) are
Cordis plugins (`docs/cordis-runtime.md`). Its interface is one set of
Next.js pages under `src/app`, and each page reads and writes its capability
directly. So a new capability means new pages, and a second interface over
the same capabilities would have to repeat every page.

Any way of separating the two must keep these where they are:

- organization isolation, the plugin gate on writes, the released-route
  allowlist in middleware, the session checks before privileged reads, and
  row-level security;
- the existing API routes as the only way to write, each with its own gate
  and schema;
- the URLs people already use.

An interface must not gain a way to write except through those routes, to
read a stored credential, or to send data to another origin.

## Decision

1. **The contract is three TypeScript modules.**
   - `src/lib/gui/contract.ts` is client-safe. It holds what an interface
     renders: formatted values, the five view kinds and their models, links,
     action references, signals, the manifest, the props and state the kit
     hands an interface, and an interface's metadata (`GuiMeta`). It
     imports only types, and only from the plugin catalog, so a client that
     is not an interface type-checks it without React.
     It also carries the answers the host's routes give a client that is
     not an interface, such as the CLI, which may import only this file
     (RFC #259 §§ 3-4): the action catalog (`ActionCatalog`, served by
     `GET /api/gui/catalog`) and the refusal every host route answers with
     (`HostFailureBody`: `ActionResult`'s failure with `error`, the same
     text as `message`). An interface never receives these: the kit turns a
     refusal into the `ActionResult` an interface always got. Each has a
     strict schema in `src/lib/gui/host/server/model-schema.ts`, as every
     shape a browser receives does.
   - `src/lib/gui/contract-react.ts` is client-safe too. It holds the types
     that name React types: the kit interface (`GuiKit`), what an interface
     plugin implements (`GuiPlugin`), and the kit's component props
     (`LinkProps`, `ShellProps`, `OverlayProps`, `SyncComponent`). It
     imports only types, from `react` and `contract.ts`.
   - `src/lib/gui/surface.ts` is server-only. It holds what a capability
     contributes: views with loaders, actions bound to its existing API
     routes with a confirmation level, navigation entries, signals, status
     items, search and its own entity kinds.
2. **Capabilities describe and interfaces present.** A contribution carries
   data and route references, never React components. Interfaces are
   compiled into the build and reviewed like any other code. An interface
   writes only through the kit, which sends each write to the action's own
   route.
3. **The contract is enforced in layers.**
   - The types make a wrong contribution fail `tsc`, and
     `src/lib/gui/__tests__/contract-types.test.ts` pins each rule they
     express. They are aids only: a widened `boolean` still compiles.
   - So whatever registers a contribution checks the same rules again when
     it registers it, and refuses anything outside the contract. That check
     reads no environment, network or database, so the `Test` gate refuses
     exactly what production would. A refused contribution stops the
     runtime rather than being dropped.
   - The confirmation step before a write belongs to the host, not to an
     interface: an interface frames the step but never runs it.
   - The routes, the plugin gate and the database stay the authority for
     every write and read, whatever an interface or a contribution says.
4. **Values are formatted on the server**, with the same formatting
   functions and status maps as the existing pages, so an interface may
   print a value's `text` as given. Money arrives as the stored major-unit
   amount and is sent in integer minor units.
5. **Import boundaries follow where code runs.**
   `src/lib/gui/__tests__/gui-boundary.test.ts` enforces them:
   - `contract.ts` imports only types, and only from
     `@/lib/plugins/bundled`; no npm package is reached through its imports,
     even as types; and it type-checks with no `@types` package loaded,
     loading no file outside `src/` and TypeScript's own libraries. So a
     client that is not an interface type-checks it without React.
     `contract-react.ts` holds `GuiKit`, `GuiPlugin` and the kit's props,
     imports only types, from `react` and `contract.ts`, and re-exports
     nothing.
   - `surface.ts`, `fmt.ts` and everything under `src/lib/gui/host/server/`
     start with `import "server-only"`.
   - Everything under `src/lib/gui/host/client/` starts with `"use client"`.
   - Everything under `src/lib/gui/host/shared/` runs on both sides, so it
     carries neither marker and imports no `react-dom`, Supabase, Cordis
     runtime or Next.js server API. Every host file is in one of these three
     directories.
   - No file a browser can load reaches `surface.ts`, `fmt.ts` or
     `host/server/` through its imports.
   - An interface package under `src/gui/<name>/` imports only the
     contract, the kit, `react`, `react-dom`, its own files and the npm
     packages reviewed for it (`REVIEWED_PACKAGES` in the test), and no
     stylesheet. Its `meta.ts`, and `src/gui/meta.ts`, import only types
     and metadata, because metadata is read at start-up without React.
6. **Versioning.**
   - `GUI_CONTRACT` is semver, starting at 0.1.0. An interface declares a
     caret range, and installation refuses an interface whose range
     excludes the running contract.
   - Through 0.x a minor version may change shapes, and a patch only adds
     optional fields, kinds or values. Every compiled-in interface is
     checked against a change in the same pull request.
   - 0.2.0 added the required `repeat` on every action (decision 11), the
     first change of shape since 0.1.0.
   - 0.2.1 added the action catalog's types and `HostFailureBody`
     (decision 1). The catalog is a new answer. The refusal body every host
     route sends gained `error` beside `message`, a key added to an answer
     whose type was not in the contract before; the kit reads it and gives
     an interface the `ActionResult` it always did, without `error`. No
     shape an interface receives changed, so a patch was enough. It also
     covers `Signals.attention` (#230), an optional field added while the
     contract read 0.2.0.
   - A1-5 on #133 moved the types that name React types to
     `contract-react.ts` (decision 1). No shape changed and interfaces are
     compiled in (decision 2), so `GUI_CONTRACT` stayed 0.2.1.
   - Each view kind records the version it arrived in (`GUI_KINDS_SINCE`),
     so a kind newer than an interface's range can be shown by a generic
     fallback.
   - 1.0 is declared when two interfaces pass the same conformance checks.
7. **Ownership.** Everything under `src/lib/gui/` is code-owned
   (`.github/CODEOWNERS`): the contract files, the host, the kit and the
   guard tests. Interface packages may import from there, so a file added
   there reaches every interface at once. The compiled-in interface list
   (`src/gui/meta.ts`) is owned from the pull request that creates it.
   Interface packages under `src/gui/<name>/` are not owned: what they may
   import is fixed by the boundary test, which is.
8. **A plugin that is off for the organization.** The host asks the plugin
   gate about the plugin as a write, on every view, attachment and prepare,
   and treats only its 409 ("off") as off. An unreadable gate (its 503, or a
   throw) leaves every tab, tile and section out, shows every action
   disabled and refuses every prepare.
   - Its views of cost `db` still load, with the gate's notice. A view's
     loader may give a notice of its own (`LoadedModel.notice`); the host
     shows its own notice first (the gate's, else the one on generated
     figures), then the loader's, in one notice, and a loader's `danger`
     tone outranks the host's warning (`shownNotice` in
     `host/server/view.ts`). Its views of cost `vendor` are refused.
   - Its sections are still listed where they are attached, so their place
     shows the gate's notice. Its tabs and tiles are left out, unless the
     attachment declares `whilePluginOff: "listed"`.
   - Its actions are shown disabled with the gate's copy on its own views,
     left out of other plugins' views, and refused at prepare, unless the
     action declares `whilePluginOff: "enabled"`. Such an action is shown
     enabled on its own plugin's views and prepared; its `available()` and
     `prepare` still run, and other plugins' views still leave it out.
   - Only an action whose `METHOD /api/route` is a `PaymentExemption` in
     `UNGATED_WRITES` (`src/lib/runtime/__tests__/route-rules.ts`) may
     declare `whilePluginOff`, so the host never offers a write the route
     would refuse; only a Payments or Pesapal view may declare
     `attach.whilePluginOff`, and only while every Payments capability
     method a surface module may call runs while the plugin is off.
     `gui-surface.test.ts` checks both. The registration check refuses
     `attach.whilePluginOff` on a section or a `vendor` view.
   - Its watchers are not run, and are listed as neither checked nor
     unchecked, unless the watcher declares `whilePluginOff: "checked"`;
     an unreadable gate lists every watcher as unchecked. As with
     `attach.whilePluginOff`, only a Payments or Pesapal watcher may
     declare it, and only while every Payments capability method a surface
     module may call runs while the plugin is off.

9. **Signals.** A plugin reports what needs someone through watchers
   (`signals` in its contribution); `GET /api/gui/signals` and
   `collectSignals` (`src/lib/gui/host/server/signals.ts`) collect them for
   one organization.
   - Only staff of that organization get signals. A person whose rows are
     all tenant rows gets a 403, and no watcher runs.
   - The host asks the plugin gate per watcher. Its 409 skips the watcher,
     which is then neither checked nor unchecked, unless it declares
     `whilePluginOff: "checked"` (decision 8); an unreadable gate lists it
     as unchecked, without running it.
   - Each watcher runs on its own request, within its own budget (1500 ms
     unless it sets `budgetMs`). One that is late, throws, or returns
     anything the host refuses is listed as unchecked, and only its id and
     the kind of miss are logged, so one failing watcher never hides the
     others.
   - The host refuses a watcher's whole answer when a signal breaks its
     schema, repeats an id, links anywhere but a released page, or leads
     (`href`) anywhere but a page its own plugin owns, or when it holds
     more than 50 signals. It sends each id prefixed with the watcher's.
   - The answer carries the first 20 signals, most severe first (`top`),
     how many there were (`count`), and how many of them are `warn` or
     `critical` (`attention`, optional since it was added in 0.2.1),
     both counted over every signal, not only `top`.
   - A watcher sets each signal's severity by fixed rules, decided on #230:
     a billing period with bills not closed is a warning from the day after
     its last day and critical seven days after it, in the period's own
     zone, and one with no bills stays a warning (`billing.period-due`); a
     microgrid with metered tenants last month and no period for it is a
     warning from the 2nd of the month in its zone
     (`billing.period-missing`); attempts held for reconciliation are
     critical only when one reached Pesapal (a tracking id or a receipt),
     otherwise a warning (`payments.reconcile`); failures on bills still
     unpaid in the last week are a warning (`payments.failed`), and so are
     three or more checkouts in a community that never reached Pesapal in
     the last 24 hours (`payments.not-submitted`), which say something about
     the payment account rather than a bill. A metering connection check
     that failed is a warning (`metering.connection`). A microgrid with one
     or more OpenEMS gateways (edges) offline now is a warning, one signal
     per microgrid however many are offline, and so is a microgrid whose
     gateways' status could not be read because the read failed, timed out
     or gave no answer within the budget (`metering.edge-status`, mgm#287).
     So is a microgrid with one or more meters on an online gateway that
     have sent no reading for half an hour, one signal per microgrid with a
     count, and one whose meters' history could not be read. When more than
     50 are found, offline gateways are kept first, then quiet meters, then
     statuses and meters that could not be read.
   - A watcher reads through the person's own client or a capability's
     reads, filters by the organization itself and throws when a read
     fails. It reads the database, since every load of the signals runs
     every watcher, with one exception, decided on #230 (decision 3): a
     cached provider read through its capability, made only after the
     capability's composer has authorized the organization, through a cache
     with a TTL, with a bounded number of reads at once, each with a timeout
     within the watcher's budget, and only while its plugin is on (the host
     skips it otherwise, and the composer checks again). A failed provider
     read for one site is a signal about that site, with fixed copy, not a
     missing answer: the watcher is unchecked only when its database reads
     or its composition fail. The read is a listed capability read
     (`LOADER_READS` in `gui-surface.test.ts`), and nothing the provider
     says reaches the signal but counts. `metering.edge-status` is the one
     such watcher (`docs/cordis-runtime.md` § "GUI surface"): five minutes'
     TTL, a failure kept one minute, four reads at once in each process, a
     2 s timeout within a 3 s budget, every microgrid of the organization
     examined up to 500 (unchecked past that), those never read or read
     longest ago first, and a read under way at the deadline kept for the
     next load. Beside each microgrid's status read it makes a second
     cached read, of its meters' power history (one request per edge), which
     shares the same cache rules and slots; a meter read with no answer by
     the deadline is left for the next load rather than reported. No
     scheduled writer replaces it: on Vercel Hobby crons run about daily.
   - A watcher aggregates (one signal per period or site, not per bill),
     writes fixed copy with values formatted on the server, and names no
     tenant, because an assistant may read signals later (#133's data
     boundary).
   - Each watcher declares examples. Registration parses them;
     `gui-surface.test.ts` holds their links to the plugin's own released
     pages.
   - A view may declare `takesSignals`. The host then collects the signals
     of the organization the view loads in, with these rules, before its
     loader runs, and hands them over as `req.signals` (null when they could
     not be collected). Today (`org.today`), the home page on "/", is such a
     view: one row per signal, with the tray's copy when nothing needs the
     person or a source did not answer, and other plugins attach tiles to
     it (`attach.hint: "tile"`), which the host leaves out while their
     plugin is off. Each load runs every watcher, so registration refuses
     `takesSignals` on a view that is not an organization's, is attached to
     another view, or polls.
   - The shell fetches `GET /api/gui/signals` for the organization its
     manifest shows after the first paint, never in the manifest
     (`src/lib/gui/host/client/signals-feed.ts`): again every five minutes
     while the page is visible, on focus or coming back into view when the
     last fetch is two minutes old, on coming back online after a fetch
     that failed (once shown, if the page is hidden then; a failure of
     that fetch is not counted), and after an action whose route answers
     `signals: true`. A view that takes signals carries them in its model
     (`signals`), and the shell takes those instead of fetching again.
     `useSignals()` returns them, and the installed app's badge shows their
     `attention`, the warn and critical signals, where the browser supports
     the Badging API (or `count` from an answer without it). Info signals
     still show in the tray, whose number is `count`, and on Today, but put
     no number on the icon (#230). A 401 clears both and stops fetching; a 403
     clears both; any other failure keeps what was shown and doubles the
     wait, up to 30 minutes. A tenant's manifest fetches nothing, and the
     badge is cleared for it, when the organization changes, on sign-out
     (after which the page sets it no more) and whenever /login shows.
     The badge belongs to the installed app, not to a window: two windows
     on different organizations show whichever fetched last. Only an open
     page sets it (no service worker or push), so the badge is not updated
     while the app is closed: where the platform keeps it, it shows the
     count from when the app was last open.

10. **The host's confirmation steps.**
   - A step's tone, and an `ActionRef`'s `tone`, come from the action's
     definition on the server (`actionTone` in
     `host/shared/merge-actions.ts`): danger for a DELETE or a
     `risk: "destructive"` action, neutral for every other, typed and
     ceremony included. A confirmation level says how carefully a person
     confirms, not what the write does. The one-step form's footer, the
     confirm, typed and ceremony steps and the Overlay's `tone` all take
     the prepared action's tone; a GUI's ref cannot change it. Design
     rule 5 in CLAUDE.md applies the same rule to `<ConfirmDialog>`.
   - An action may declare `prepareAgainOn`: codes of its route's 409
     answers that mean what the person confirmed changed after prepare (the
     figures a ceremony's digest covers, say). Registration refuses it
     without `prepare` or at level none. When a write answers 409 with a
     declared code, the host prepares the action again with the same ref
     and the values sent, less secrets. If it gets the same action back
     (action, route, method and bound fields) at no weaker level, it shows
     the new step as a new round, ticks and typing cleared, with the
     route's message as its note, and never sends on its own. A refusal of
     the new prepare ends the action with that refusal and refreshes the
     view; any other answer ends it with the route's 409. Any other failed
     write shows the same step again with the route's message. The host
     prepares again through `prepareAction` rather than using a step the
     route's body may carry, so the step is always one the host checked,
     with the gate, `available()` and the action's own refusals asked
     again. The codes are declared per action, not inferred from the
     status: the plugin gate's own 409 must never prepare again. The route
     stays the authority and checks the confirmation again on every write.

11. **What a repeat does.** Each action declares `repeat` (RFC #259 § 3),
   so a client that lost an answer knows whether it may send the write
   again.
   - `"safe"`: a second identical send writes nothing. Its answer may
     differ from the first's (a 404 once a delete has run, a 409 once a
     create has, a 400 `no_op`, a 200 that says nothing changed), so a
     client that lost the first answer reads the view rather than trusting
     the second. Safety is judged right after the first send, with outside
     state (meter data, a provider's answer) unchanged. A timestamp a route
     stamps on every write and nothing reads may move; the test lists each
     such column with its case, the one row it may move in, and its reason.
   - `"keyed"`: the route takes a repeat key and answers a repeat with the
     first result. No route takes one yet, and where a key's record is kept
     is open on #259, so the twice-sent test refuses `"keyed"` until a
     route takes a key and a case can send it.
   - `"unsafe"`: a repeat may write twice.
   - The field is required: `tsc` refuses an action without it, and so does
     registration. `src/lib/gui/__tests__/repeat.db.test.ts` sends every
     `"safe"` action twice to its route against a database, as the person
     it is offered to, and fails if the second send changes a row it reads.
     A new `"safe"` action gets a case in its plugin's module there.
   - `gui-surface.test.ts` (check 12) refuses `"unsafe"` on a billing,
     payments or Pesapal action, unless `REPEAT_KEY_PENDING`
     (`src/lib/gui/__tests__/repeat/exemptions.ts`) lists it with the issue
     building its repeat key: an action that failed the twice-sent test
     declares `"unsafe"` until that key lands.
   - The field informs a client and changes nothing the host does: the kit
     never sends a write on its own (decision 10), and the routes decide
     what each send writes.

## Consequences

Better:

- A capability can add views and actions without touching any interface,
  and an interface can change without touching any capability.
- What an interface may import, and what may run in a browser, is checked
  on every pull request rather than left to review alone.
- Nothing about writes moves: each still goes to its route, with the same
  gate, schema and row-level security.

Worse, or to watch:

- Contributions are checked when the runtime starts, so a refused one stops
  every request that enters the runtime, payments included. The check is
  deterministic and the `Test` gate builds the same root, so it fails there
  first. If the check ever reads the environment, a database or the
  network, that stops being true; revisit then.
- Shapes may change in 0.x minor versions, so each change updates every
  compiled-in interface in the same pull request.
- The type rules alone are not enough: code that registers contributions
  must check them again at run time (decision 3).
- The import boundary rests on the test and on review. It is not process
  isolation.
- Which actions, views and watchers may declare `whilePluginOff` (decision 8) is
  checked in CI by `gui-surface.test.ts`, not when a contribution is
  registered, because the registration check reads no test data. The route
  stays the authority, so a declaration that slipped past CI could only
  show an action enabled that its route then refuses. If a route with a
  `PaymentExemption` starts consulting the gate, `route-surface.test.ts`
  refuses the exemption while the route file names the gate; once the
  exemption is removed, `gui-surface.test.ts` refuses its actions'
  `whilePluginOff` until it goes. Only the route file is read for the gate:
  a helper module that asks it is caught for the reconcile route by its
  database test, which posts with Payments off, and for the other exempt
  routes by review.
- That each `prepareAgainOn` code is one its route answers (decision 10) is
  checked in CI by `gui-surface.test.ts`, which looks for the code written
  in the route file or in a source file under `src/lib`, not when a
  contribution is registered. A code that slipped past CI could only leave
  the host showing the old step again with the route's message, as it does
  for any other refusal.
- The twice-sent test (decision 11) sends one copy after another and sees
  only the tables its snapshot reads. Two copies sent at once rest on each
  route's own locks, and a route that starts writing another table escapes
  the test until the snapshot reads that table.
- When this was recorded, the repository held the two contract files and
  their tests, and nothing imported them. The run-time checks in decision 3
  arrive with the code that reads contributions, each with its own tests.

## Alternatives considered

- **Pages per interface.** Every capability times every interface; the
  cost grows with both.
- **Server-driven forms only, with no interface-specific renderers.** Simple,
  but it cannot draw views such as charts that a generic renderer does not
  know.
- **Loading interfaces at run time.** Refused: interfaces are reviewed code,
  compiled into the build.

## References

- `src/lib/gui/contract.ts`, `src/lib/gui/contract-react.ts`,
  `src/lib/gui/surface.ts`
- `src/lib/gui/host/client/action-host.tsx`,
  `src/lib/gui/host/server/prepare.ts` (decision 10)
- `src/lib/gui/__tests__/repeat.db.test.ts`, `src/lib/gui/__tests__/repeat/`
  (decision 11)
- `src/lib/gui/__tests__/contract-types.test.ts`,
  `src/lib/gui/__tests__/gui-boundary.test.ts`
- `docs/cordis-runtime.md`; CLAUDE.md, "Cordis runtime"
