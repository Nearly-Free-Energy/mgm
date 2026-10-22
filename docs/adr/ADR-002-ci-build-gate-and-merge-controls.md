# ADR-002: CI build gate and merge controls for outside contributors

## Status: Accepted (proposed until the ruleset is applied)

## Context

MGM is being prepared for public development with outside contributors
(launch tracker #30, execution issue #33). Two problems follow.

First, the only production-build proof today is the hosting provider's
preview deployment. A pull request from a fork waits on a deployment
authorization it cannot obtain, and the check exists only while the hosting
integration does. The project must not depend on a hosting provider to prove
that it builds.

Second, the merge rules (signed commits, DCO sign-off, required checks, review
of sensitive areas) existed as prose in `CLAUDE.md` with no code owners and no
statement of how squash merges interact with signing. Outside contributions
are squash-merged; a reader could assume the squash commit replaces the
original commits for signing purposes. It does not: the requirement applies
to the commits on the pull request.

Constraints: the NFE GitHub organization stays on the GitHub Free plan. For a
public repository that plan provides rulesets, code owners, secret scanning,
and private vulnerability reporting. Untrusted fork code must never receive
credentials.

Also found while preparing this change: `.nvmrc` and `engines` did not exist;
the `Dockerfile` (`node:20-alpine`) and the `Test` job (`node-version: '20'`)
use Node.js 20, while the plan targets Node.js 24 LTS.

## Decision

1. **Add a required `Build` job** (`.github/workflows/build.yml`, job name
   `Build`) that runs `npm ci` and `npm run build` with no hosting provider and
   no secrets, using obviously fake placeholder Supabase values. It runs on
   `pull_request` (never `pull_request_target`) and on push to `main`, with
   `permissions: contents: read`. The existing `Test` and `CodeQL` job names
   are unchanged. Third-party actions use the same major-version tags as the
   existing workflows (`actions/checkout@v4`, `actions/setup-node@v4`); the
   repository does not currently pin actions by commit SHA.
2. **Pin Node.js 24** with `.nvmrc` and `package.json` `engines`
   (`>=24 <25`). `Build` reads `.nvmrc` through `actions/setup-node` and fails
   if the runner is not Node 24. The `Dockerfile` and `Test` job stay on
   Node 20 until a separate, deliberate runtime change; this is recorded, not
   silently altered.
3. **Define the merge policy for `main`**, to be enforced by a repository
   ruleset: pull request required; status checks `Test`, `CodeQL`, `Build`;
   verified commit signatures; DCO sign-off (compulsory web sign-off enabled so
   web-editor commits carry it); force-push and branch deletion blocked; no
   routine admin bypass.
4. **Code-owner review** by someone other than the author for database
   migrations (including the RLS helpers in `00002_rls.sql`), `src/lib/roles.ts`,
   the Cordis runtime gate, request middleware, and `.github/workflows/`,
   through `.github/CODEOWNERS` (owners: `@tushabe`, `@arindahills`). Other
   changes may be merged by their author once required checks pass.
5. **Squash merging does not bypass signing or sign-off.** Both apply to the
   commits on the pull request. Outside contributions are squash-merged;
   maintainers may merge their own signed commits with merge commits.
6. **Hosting previews are informational** and never required checks.
7. **Documentation moves together:** `CLAUDE.md`, `docs/operating-model.md`,
   `CONTRIBUTING.md`, and `docs/setup.md` are updated in the same change as
   the workflow.

The ruleset, the compulsory web sign-off setting, and the fork rehearsal are
repository settings and are outside this change. An admin applies them after
review; this ADR becomes plain "Accepted" once that is done and the
rehearsal results are recorded on #33.

## Consequences

Better: a fork pull request gets a complete, credential-free verdict from
`Test`, `CodeQL`, and `Build` without waiting on any hosting provider; the
sensitive areas have named reviewers; the signing policy states what is
actually enforced.

Worse or to watch:

- A required check that does not exist blocks every merge. Apply the ruleset
  only after `Build` has run successfully on `main`, so the context resolves.
- A CODEOWNERS pattern that matches nothing protects nothing and GitHub does
  not warn about it. Update `.github/CODEOWNERS` in the same change as any move
  of a listed path. Two owners are listed, so a change authored by one owner is
  approved by the other; if the team grows, add maintainers.
- Code-owner review adds latency to migrations and workflow changes by design.
- `Build` could begin to need a real service. The answer is to fix the build,
  not to add a secret to the workflow.
- Runtime split: until the `Dockerfile` and `Test` job move to Node 24, the
  application is built and tested on 24 only by `Build`, and shipped and
  tested elsewhere on 20. Moving them is a runtime change that needs its own
  validation and review. `package.json` `engines` produces an npm warning,
  not a failure, on Node 20.
- The merge controls are unproven until a fork pull request has been
  rehearsed with a second account, positive and negative cases, including the
  GitHub web-editor path. Until then they are intended policy.
- The exact Cordis version for 0.1 is a separate decision (the dependency is
  currently pinned at `4.0.0-rc.10`) and is not made here.
