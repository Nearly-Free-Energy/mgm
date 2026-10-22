# ADR-002: CI build gate and merge controls for outside contributors

## Status: Accepted (social contract; ruleset enforcement deferred, see #30)

## Context

MGM is being prepared for public development with outside contributors
(launch tracker #30, execution issue #33). Two problems follow.

First, the only production-build proof today is the hosting provider's
preview deployment. A pull request from a fork waits on a deployment
authorization it cannot obtain, and the check exists only while the hosting
integration does. The project must not depend on a hosting provider to prove
that it builds.

Second, the merge rules (signed commits, sign-off, checks, review of sensitive
areas) existed as prose in `CLAUDE.md` with no code owners and no statement of
how squash merges interact with signing. Outside contributions
are squash-merged; a reader could assume the squash commit replaces the
original commits for signing purposes. It does not: the requirement applies
to the commits on the pull request.

Constraints: the NFE GitHub organization stays on the GitHub Free plan. For a
public repository that plan provides rulesets, code owners, secret scanning,
and private vulnerability reporting. Untrusted fork code must never receive
credentials.

Also found while preparing this change: `.nvmrc` and `engines` did not exist;
the `Dockerfile` (`node:20-alpine`) and the `Test` job (`node-version: '20'`)
used Node.js 20, while the plan targets Node.js 24 LTS. The Vercel project
already builds on Node.js 24.x.

On 22 October 2026 the project decided that, for now, merge control is a
maintainer social contract and that ruleset enforcement is deferred (#30 § 2).

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
   (`>=24 <25`). `Build` and `Test` read `.nvmrc` through
   `actions/setup-node`; `Build` also fails if the runner is not Node 24. The
   `Dockerfile` stays on Node 20 until a follow-up PR, linked from #33.
3. **Define the merge policy for `main` as a maintainer social contract.**
   The merger checklist: a pull request; `Test`, `CodeQL` (both entries) and
   `Build` green; every commit Verified and signed off; code-owner approval
   for owned paths on the final head commit, re-requested after any push, and
   not from the person who pushed the owned-path change (reviewers suggest
   changes rather than pushing to the author's branch); no rebase merging,
   because GitHub cannot sign rebased commits; nobody force-pushes or deletes
   `main`. GitHub does not block a merge that breaks the checklist.
   Enforcement through a ruleset is deferred (#30). No automated DCO check
   exists, so the merger verifies sign-off; a DCO app or workflow job can be
   added separately and named then.
4. **Code-owner approval** by someone other than the author for the areas in
   `.github/CODEOWNERS` (migrations and RLS helpers, roles, the Cordis runtime
   gate and plugin catalog, request middleware, workflows; owners:
   `@tushabe`, `@arindahills`). That file is the single path list. Other
   changes may be merged by their author once the checks pass.
5. **Squash merging does not waive signing or sign-off.** Both apply to the
   commits on the pull request. Outside contributions are squash-merged;
   maintainers may merge their own verified, signed-off commits with merge
   commits.
6. **Hosting previews are informational** and never required checks.
7. **Documentation moves together:** `CLAUDE.md`, `docs/operating-model.md`,
   `CONTRIBUTING.md`, and `docs/setup.md` are updated in the same change as
   the workflow.

The fork rehearsal is outside this change and is recorded on #33. Revisit
this ADR when ruleset enforcement is taken up under #30.

## Consequences

Better: a fork pull request gets a complete, credential-free verdict from
`Test`, `CodeQL`, and `Build` without waiting on any hosting provider; the
sensitive areas have named reviewers; the docs say what the policy is and do
not claim GitHub enforces it.

Worse or to watch:

- The policy depends on the merger. A merge that skips a checklist item is
  not blocked by GitHub. When enforcement is added later, apply it only after
  `Build` has run successfully on `main`, so the check context resolves.
- A CODEOWNERS pattern that matches nothing protects nothing and GitHub does
  not warn about it. Update `.github/CODEOWNERS` in the same change as any move
  of a listed path. Two owners are listed, so a change authored by one owner is
  approved by the other; if the team grows, add maintainers.
- Code-owner review adds latency to migrations and workflow changes by design.
- `Build` could begin to need a real service. The answer is to fix the build,
  not to add a secret to the workflow.
- Runtime split, one path at a time. Vercel uses `package.json`
  `engines.node` in place of the project's Node.js setting for builds and
  Functions, and the project already builds on 24.x, so `engines` does not
  change the production runtime. `Build` and `Test` run on Node 24 from
  `.nvmrc`. The container image (`Dockerfile`, `node:20-alpine`) is the only
  path still on 20; moving it is a follow-up PR linked from #33 and needs its
  own validation. `engines` makes npm warn, not fail, when run on Node 20.
- The checklist is unproven until a fork pull request has been rehearsed with
  a second account, positive and negative cases (withhold the merge for an
  unsigned or unsigned-off commit), including the GitHub web-editor path.
  The result is recorded on #33.
- The exact Cordis version for 0.1 is a separate decision (the dependency is
  currently pinned at `4.0.0-rc.10`) and is not made here.
