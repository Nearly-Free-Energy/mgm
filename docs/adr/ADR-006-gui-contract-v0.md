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

1. **The contract is two TypeScript modules.**
   - `src/lib/gui/contract.ts` is client-safe. It holds what an interface
     renders: formatted values, the five view kinds and their models, links,
     action references, signals, the manifest, the kit interface
     (`GuiKit`) and what an interface plugin implements (`GuiPlugin`,
     `GuiMeta`). It imports only types, from `react` and the plugin catalog.
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
   - `contract.ts` imports only types, from `react` and
     `@/lib/plugins/bundled`.
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
   - Each view kind records the version it arrived in (`GUI_KINDS_SINCE`),
     so a kind newer than an interface's range can be shown by a generic
     fallback.
   - 1.0 is declared when two interfaces pass the same conformance checks.
7. **Ownership.** The contract files, the host under `src/lib/gui/host/`,
   the compiled-in interface list and the guard tests are code-owned
   (`.github/CODEOWNERS`). Interface packages under `src/gui/<name>/` are
   not: what they may import is fixed by the boundary test, which is.

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

- `src/lib/gui/contract.ts`, `src/lib/gui/surface.ts`
- `src/lib/gui/__tests__/contract-types.test.ts`,
  `src/lib/gui/__tests__/gui-boundary.test.ts`
- `docs/cordis-runtime.md`; CLAUDE.md, "Cordis runtime"
