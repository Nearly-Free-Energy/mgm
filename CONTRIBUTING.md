# Contributing to MGM

Thank you for helping. This guide covers the minimum to get a change merged.
The reasons behind the rules are in `docs/operating-model.md` and
`CLAUDE.md`.

## Setup

You need Node.js 24 (see `.nvmrc`), npm, Docker, and the Supabase CLI.
`docs/setup.md` has the full walkthrough; the short version:

```bash
git clone https://github.com/<you>/mgm.git   # your fork
cd mgm
git remote add upstream https://github.com/Nearly-Free-Energy/mgm.git
nvm install        # reads .nvmrc; or `fnm install`, or `brew install node@24`
./setup.sh         # starts a local Supabase and writes .env.local
npm run dev
```

`brew install node` installs the newest Node.js, not 24. If you use Homebrew,
`brew install node@24` is keg-only: add it to your `PATH` as brew instructs.

Never commit credentials, project URLs, or keys. `.env.local` is gitignored.

## Run the checks locally

```bash
npx tsc --noEmit   # types
npm run lint       # lint
npm test           # unit tests, plus database tests against local Supabase
npm run build      # production build (needs NEXT_PUBLIC_SUPABASE_URL and
                   # NEXT_PUBLIC_SUPABASE_ANON_KEY set to any well-formed value)
```

The database-backed suites need `supabase start` first; see `CLAUDE.md`
§ "Running RLS Tests". After any change under `supabase/migrations/`, run
`npm run db:types` and commit the regenerated `src/lib/types/database.gen.ts`
in the same change.

## Sign off and sign your commits

Every commit on a pull request needs both:

1. **Sign-off.** Add the trailer with `git commit -s`. It adds
   `Signed-off-by: Your Name <your-email>`, certifying the
   [Developer Certificate of Origin](https://developercertificate.org/).
   A merge commit that only brings in `main` needs no sign-off;
   `git show --remerge-diff <sha>` prints nothing for one. A merge that
   resolves conflicts needs `-s`.
2. **A verified signature.** Configure commit signing once, then plain
   `git commit -s` signs automatically. The setup steps (SSH signing key,
   uploaded to GitHub as a *Signing Key*) are in `CLAUDE.md`
   § "Required Merge Controls". GitHub must show the commit as **Verified**.

Edits made in GitHub's web editor are signed by GitHub, and carry the
sign-off only when the repository's web sign-off setting is on. Check the
Verified badge and the sign-off on your pull request's commits. A maintainer
verifies both before merging and will ask you to correct a commit that lacks
either.

Squash merging does **not** waive these rules. The signature and sign-off
apply to the commits in your pull request, not only to the squashed result.

To fix a missing sign-off or signature on a branch you already pushed, rebase
onto the current `main` with sign-off, then push with a lease:

```bash
git fetch upstream && git rebase --signoff upstream/main
git push --force-with-lease
```

A bare `git rebase --signoff` adds nothing to commits already up to date, and
a plain `git push` is rejected after a rebase. Don't `git pull` on the branch;
it creates merge commits.

## What must pass before merge

Merging is a maintainer social contract: GitHub does not block a merge that
breaks these rules, so the maintainer who merges checks each one by hand
(enforcement is deferred; see issue #30). A pull request to `main` needs:

| Item | What it proves |
|---|---|
| `Test` | type check, lint, database rehearsals, and the full test suite |
| `CodeQL` (both entries) | static security analysis |
| `Build` | the production build succeeds with no hosting provider and no secrets |
| Verified signatures | every commit is cryptographically signed |
| Sign-off | every commit carries `Signed-off-by:` (the merger reads the commits; no automated check reports it) |

Changes to the areas listed in `.github/CODEOWNERS` (migrations and RLS
helpers, roles, the runtime gate and plugin catalog, request middleware,
workflows) also need approval from a code owner other than the person who
pushed the change, on the final head commit. After you push again, ask for
the approval again. Reviewers suggest changes rather than pushing to your
branch. Other changes can be merged by their author once the checks pass. We
do not use rebase merging, because GitHub cannot sign rebased commits.

**First-time contributors:** the workflow runs on your pull request wait for a
maintainer to approve them. That is expected; it can take a while.

**Hosting previews (for example a Vercel preview) are informational.** They
are not part of the checklist, and a pull request from a fork does not wait on
one. If a preview fails or is not authorized for your fork, rely on the checks
above.

## Pull request habits

- One focused change per pull request; code, tests, and docs together.
- Describe what the change adds. Do not describe an unfixed security weakness
  in an issue, pull request, commit message, comment, or test name; report it
  privately instead (Security tab, private vulnerability reporting).
- Use synthetic data only. No customer names, personal data, or credentials.
