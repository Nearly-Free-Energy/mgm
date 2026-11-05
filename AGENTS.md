# AGENTS.md — MGM (Microgrid Manager)

Configuration for AI coding agents that read `AGENTS.md` (Codex, Cursor, and others). It mirrors `CLAUDE.md`, which is the fuller reference; when the two disagree, `CLAUDE.md` wins.

## Before you start

Read, in this order:
1. `docs/operating-model.md` — how work moves, the architectural invariants, where decisions and lessons are recorded.
2. `CLAUDE.md` — conventions, migration rules, design-system rules, merge controls.
3. `docs/cordis-runtime.md` — plugins, request scopes, and the plugin gate.

## Stack & build

- **Framework:** Next.js 16 (App Router) + TypeScript
- **Plugin runtime:** Cordis 4 (`src/lib/runtime/`)
- **Auth + DB:** Supabase (Postgres + Auth + RLS)
- **Hosting:** Vercel
- **Testing:** Vitest
- **Dev:** `npm run dev` · **Build:** `npm run build` · **Test:** `npm test` · **Lint:** `npm run lint` · **Type check:** `npx tsc --noEmit`

## Critical rules

1. **OpenEMS calls are server-side only.** Credentials never reach the browser and never use a `NEXT_PUBLIC_` variable.
2. **RLS on every table.** Row Level Security enforces organization isolation; app-side checks are defense in depth.
3. **Every write enters the Cordis runtime.** Compose a capability or call `gateRoute()` with the owning plugin; `route-surface.test.ts` enforces it.
4. **This is a public repo.** Never commit credentials, infrastructure identifiers, or strategy. A security weakness is described only in a private security advisory until that advisory is published — never in an issue, PR, commit, or comment; `SECURITY.md` and `docs/operating-model.md` § "Security fixes" set out how the fix is tested and released before the advisory is published.
5. **Billing periods are closed by a person.** Never automate period close.
6. **Billing logic is provider-neutral.** It consumes the metering provider interface, not OpenEMS types.

## Recording lessons

When a session teaches something future contributors need, record it in the repository: a rule in `CLAUDE.md` (with the reason and what would invalidate it), or a decision in `docs/` next to the area it governs. Commit it with the change that motivated it.
