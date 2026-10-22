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
nvm use            # or install Node.js 24 another way
./setup.sh         # starts a local Supabase and writes .env.local
npm run dev
```

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

1. **DCO sign-off.** Add the trailer with `git commit -s`. It adds
   `Signed-off-by: Your Name <your-email>`, certifying the
   [Developer Certificate of Origin](https://developercertificate.org/).
2. **A verified signature.** Configure commit signing once, then plain
   `git commit -s` signs automatically. The setup steps (SSH signing key,
   uploaded to GitHub as a *Signing Key*) are in `CLAUDE.md`
   § "Required Merge Controls". GitHub must show the commit as **Verified**.

Edits made in GitHub's web editor are signed by GitHub, and carry the
sign-off when "require contributors to sign off on web-based commits" is
enabled for the repository. Check the Verified badge and the sign-off on your
pull request's commits; if either is missing the merge is blocked.

Squash merging does **not** bypass these rules. The signature and sign-off
requirements apply to the commits in your pull request, not only to the
squashed result. Fix a missing sign-off or signature by amending or rebasing
(`git rebase --signoff` re-signs and signs off) and pushing the branch again.

## What must pass before merge

A pull request to `main` needs these required checks:

| Check | What it proves |
|---|---|
| `Test` | type check, lint, database rehearsals, and the full test suite |
| `CodeQL` | static security analysis |
| `Build` | the production build succeeds with no hosting provider and no secrets |
| DCO | every commit is signed off |
| Verified signatures | every commit is cryptographically signed |

Changes to database migrations, RLS helpers, the Cordis runtime gate, request
middleware, and `.github/workflows/` also need approval from a code owner
other than the author (`.github/CODEOWNERS`). Other changes can be merged by
their author once the required checks pass.

**Hosting previews (for example a Vercel preview) are informational.** They
are never required, and a pull request from a fork does not wait on one. If a
preview fails or is not authorized for your fork, rely on the checks above.

## Pull request habits

- One focused change per pull request; code, tests, and docs together.
- Describe what the change adds. Do not describe an unfixed security weakness
  in an issue, pull request, commit message, comment, or test name; report it
  privately instead (Security tab, private vulnerability reporting).
- Use synthetic data only. No customer names, personal data, or credentials.
