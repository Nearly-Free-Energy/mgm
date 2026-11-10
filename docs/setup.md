# MGM Local Development Setup

## Which path should I use?

| I want to... | Use |
|--------------|-----|
| Run and test the app (no dev tools needed) | **Docker path** (`./setup.sh --docker`) |
| Write code with hot reload and Supabase Studio | **Dev path** (`./setup.sh`) |

## Docker path (contributor / tester)

Run the entire stack in Docker. No Node.js, npm, or Supabase CLI required.

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Docker Desktop | 4.0+ | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |

### Quick Start

```bash
git clone https://github.com/Nearly-Free-Energy/mgm.git
cd mgm
./setup.sh --docker
```

Open [http://localhost:3000](http://localhost:3000) and log in:
- **Email:** `admin@eiot.energy`
- **Password:** `admin123`

### Data persistence

| Command | Data preserved? |
|---------|----------------|
| `docker compose stop` / `start` | Yes |
| `docker compose down` | Yes (volume kept) |
| `docker compose down -v` | **No** (fresh start) |
| `docker compose up --build` | Yes (images rebuilt, data kept) |

### Reset to fresh state

```bash
./setup.sh --docker --force
# or manually:
docker compose down -v && docker compose up --build -d
```

### Limitations

- No hot reload -- runs `next start` (production build). Use the dev path for active development.
- No Supabase Studio -- use the dev path if you need the database admin UI.

## Dev path (developer)

Runs local Supabase via CLI with hot reload and full dev tooling.

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 24 (see `.nvmrc`) | `nvm install` or `fnm install` (reads `.nvmrc`), or `brew install node@24` (keg-only: add it to your `PATH`). `brew install node` installs the newest release, not 24. |
| npm | 9+ | Bundled with Node.js |
| Docker Desktop | 4.0+ | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |
| Supabase CLI | 2.75+ | `brew install supabase/tap/supabase` or [docs](https://supabase.com/docs/guides/cli/getting-started) |

### Quick Start — Local Supabase (recommended)

```bash
git clone https://github.com/Nearly-Free-Energy/mgm.git
cd mgm
./setup.sh
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and log in:
- **Email:** `admin@eiot.energy`
- **Password:** `admin123`

`npm run dev` builds the interface's stylesheet once before it starts. While
you change classes under `src/gui/` or the tokens in `src/styles/tokens.css`,
run `npm run gui:styles:watch` beside it to rebuild the stylesheet.

### Quick Start — Cloud Supabase

Connects to an existing hosted Supabase project. No Docker required.

```bash
git clone https://github.com/Nearly-Free-Energy/mgm.git
cd mgm

# Interactive (prompts for credentials):
./setup.sh --cloud

# Non-interactive (CI / scripted):
./setup.sh --cloud \
  --url=https://your-project.supabase.co \
  --anon-key=your-anon-key \
  --service-role-key=your-service-role-key

npm run dev
```

## Setup Script Reference

```
Usage:
  ./setup.sh                     Local mode (default)
  ./setup.sh --local             Explicit local mode
  ./setup.sh --docker            Docker mode, full stack in Docker
  ./setup.sh --cloud             Cloud mode, interactive prompts
  ./setup.sh --cloud --url=URL --anon-key=KEY --service-role-key=KEY
                                 Cloud mode, non-interactive
  ./setup.sh --force             Overwrite existing .env.local
```

### Flags

| Flag | Description |
|------|-------------|
| `--local` | Use local Supabase via CLI (default if no mode specified) |
| `--docker` | Run the full stack in Docker (no dev tools needed) |
| `--cloud` | Use a hosted Supabase instance |
| `--url=URL` | Supabase project URL (cloud mode only) |
| `--anon-key=KEY` | Supabase anon/publishable key (cloud mode only) |
| `--service-role-key=KEY` | Supabase service role key (cloud mode only) |
| `--force` | Overwrite `.env.local` if it already exists. In docker mode: `docker compose down -v` first. |
| `--help`, `-h` | Show usage information and exit |

### What the script does

**Docker mode:**
1. Checks prerequisites (Docker, docker compose)
2. Builds and starts 6 containers (Postgres, GoTrue, PostgREST, Kong, migrations, Next.js app)
3. Waits for the app to be ready
4. Prints summary with URLs and credentials

**Local mode:**
1. Checks prerequisites (Node.js, npm, Docker, Supabase CLI)
2. Starts local Supabase containers (`supabase start`)
3. Applies database migrations and seeds a dev admin user (`supabase db reset`).
   Both run with `MGM_ALLOW_DEV_CREDENTIAL_KEY=1`, so the local database gets a
   throwaway credential encryption key ([runbook](runbooks/dek.md#local-development-and-ci)).
4. Generates `.env.local` with local Supabase URLs and keys
5. Installs npm dependencies

**Cloud mode:**
1. Checks prerequisites (Node.js, npm)
2. Collects Supabase credentials (from flags or interactive prompts)
3. Generates `.env.local` with cloud Supabase URLs and keys
4. Installs npm dependencies

Local and cloud modes write the runtime configuration names
(`MGM_PUBLIC_SUPABASE_URL`, `MGM_PUBLIC_SUPABASE_ANON_KEY`,
`MGM_APP_URL=http://localhost:3000`; see "Runtime configuration" below) and
append OpenEMS B2B defaults to `.env.local`:
```
OPENEMS_B2B_URL=http://localhost:8075
OPENEMS_B2B_USERNAME=admin
OPENEMS_B2B_PASSWORD=Icui4cyou
```

## Runtime configuration

MGM reads its deployment settings from the server environment **at request
time**, so one build (a Vercel deployment or the published container image)
can serve any installation. Nothing deployment-specific is baked into the
browser bundle or the image. The decision is recorded in
`docs/adr/ADR-003-runtime-public-configuration.md`.

| Variable | Required | Reaches the browser | Purpose |
|---|---|---|---|
| `MGM_PUBLIC_SUPABASE_URL` | yes | yes | Supabase project URL used by the browser and, unless overridden, the server |
| `MGM_PUBLIC_SUPABASE_ANON_KEY` | yes | yes | Supabase public key: an `sb_publishable_…` key or a JWT whose role is `anon`. Anything else (secret or service-role keys included) is refused |
| `MGM_PUBLIC_SUPABASE_COOKIE_NAME` | when `SUPABASE_INTERNAL_URL` is on another host | yes | Fixed auth cookie name, so server, middleware and browser find the same session. Without it, Supabase derives the cookie name from the URL each side uses; MGM refuses to start a request when the internal and public hosts differ and this is unset |
| `SUPABASE_INTERNAL_URL` | no | no | Server-only Supabase URL override, e.g. `http://kong:8000` inside a container network |
| `MGM_APP_URL` | for payments | no | Public origin of this installation (`https://mgm.example.org`, no path). Must be `https`, except for `localhost`, `127.0.0.1` and `[::1]`. Builds payment links, the provider return URL `/payment/callback`, and the notification URL `/api/payments/ipn` registered with the payment provider |
| `MGM_GUI` | no | no | Which compiled-in interface (`src/gui/meta.ts`) serves this installation's pages. Unset or blank means `gridtop`, the default. The interface pages read it and link that interface's stylesheet; payment and sign-in pages do not |
| `MGM_METERING_FIXTURES` | no | no | `on` (or `1`, `true`) lets the fixture metering provider generate synthetic site data for edges whose id starts with `SYNTHETIC-EDGE-` ([Synthetic site data](#synthetic-site-data)). Unset, blank, `off`, `0` or `false` means off. Read when the server's runtime starts, so a change needs a restart |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | no | Privileged server key; never serialized |

How it works: the root layout renders per request (it is never prerendered or
served from a shared cache), validates the three `MGM_PUBLIC_*` values, and
passes only those to a client configuration provider. Browser Supabase
clients take their settings from that provider. Server code and the session
middleware (which runs on the Node.js runtime) use the same validated values.
Missing or invalid settings stop the request with an error that names the
variable and never prints its value.

At server start (`src/instrumentation.ts`, not during `next build`) MGM
validates the Supabase settings, `MGM_APP_URL` and `MGM_GUI`. An invalid
Supabase setting is logged at server start; every page and API request then
fails with 500 while the process keeps running (it does not exit, so a
restart policy does not fire). Look for "Failed to prepare server" or "An
error occurred while loading instrumentation hook" in the logs. An invalid `MGM_APP_URL` is logged
as an error naming the variable and does not stop anything else; payment
links and notification registration fail with the same message on first use.
A missing `MGM_APP_URL` only logs a warning, because payments are the only
feature that needs it. An `MGM_GUI` that names no compiled-in GUI is also
logged as an error naming the variable; its value is printed only when it
looks like a GUI name. It does not stop payment pages or webhooks, which render no
interface. An `MGM_METERING_FIXTURES` value other than on or off is logged
as an error naming the variable, never the value, and counts as off; `on`
is logged as a warning, so synthetic data is never on unnoticed. A
compiled-in GUI that does not support this build's GUI contract is
different: the runtime refuses to install it at start, which stops every
request, payments included. The `Test` gate
(`src/gui/__tests__/installed-guis.test.ts`) refuses such a build first.

Variables are read when a request is served. Set them in the hosting
environment (Vercel project settings, the container's `environment:`, or
`.env.local` for `npm run dev`); for the container there are no build
arguments.

### Upgrading from v0.0.1 or v0.0.2

v0.0.1 and v0.0.2 still accepted the old Next.js build-time names when the
new names were unset. Later releases **no longer read the old names**. Rename
them in the hosting environment before upgrading (the same applies to a build
from before v0.0.1):

| Old name (no longer read) | New name |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `MGM_PUBLIC_SUPABASE_URL` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `MGM_PUBLIC_SUPABASE_ANON_KEY` |
| `NEXT_PUBLIC_SUPABASE_COOKIE_NAME` | `MGM_PUBLIC_SUPABASE_COOKIE_NAME` |
| `NEXT_PUBLIC_APP_URL` | `MGM_APP_URL` (origin only) |
| `NEXT_PUBLIC_PAYMENT_CALLBACK_URL` | `MGM_APP_URL` (its origin only) |

- **Payment return URL.** It is always the `MGM_APP_URL` origin plus
  `/payment/callback`. A custom path or query in
  `NEXT_PUBLIC_PAYMENT_CALLBACK_URL` is not carried over. With only
  `NEXT_PUBLIC_APP_URL` set, releases before v0.0.1 sent payers back to
  `http://localhost:3000/payment/callback`; since v0.0.1 the return URL has
  been the application origin plus `/payment/callback`.
- **Cookie name.** If you set `NEXT_PUBLIC_SUPABASE_COOKIE_NAME`, rename it
  too. Without `MGM_PUBLIC_SUPABASE_COOKIE_NAME`, sessions use Supabase's
  default cookie name, so everyone has to sign in again, and an internal
  Supabase URL on another host is refused (see the table above).
- **What happens if you forget.** An old name left set is ignored. At server
  start MGM logs one warning for each old name that is set while its new name
  is not, naming both and never the value, for example
  `[mgm] NEXT_PUBLIC_SUPABASE_URL is set but no longer read; set MGM_PUBLIC_SUPABASE_URL instead.`
  The missing new names then fail as described above: missing Supabase
  settings make every page and API request fail with 500, and a missing
  `MGM_APP_URL` fails payment links and notification registration. An old
  name set next to its new name is ignored without a warning; delete it once
  you have renamed it.
- **Containers.** The image takes no `--build-arg NEXT_PUBLIC_*`. Pass the
  variables above as runtime environment.
- **Local development.** Rename the same names in `.env.local`. `./setup.sh`
  warns about each old name it finds there; `./setup.sh --force` regenerates
  the file instead, but in local mode it also resets the local database.

After renaming, redeploy and confirm login and a payment link.

Changing an installation's public URL also means updating the payment
provider's notification registration, the payment worker URL in Vault, and
Supabase Auth's site and redirect URLs (`docs/payments-rollout.md`).

## Synthetic site data

For demonstrations, reviews and browser tests without an OpenEMS backend,
the fixture metering provider (`src/lib/metering/fixture-provider.ts`)
generates a site's battery, grid, load and house-meter samples from a fixed
seed (`src/lib/metering/fixture/site-samples.ts`). The same microgrid and
day always give the same samples. Each day follows one of five scenarios:
a clear day, an evening power cut, a long cut in which the battery reaches
its floor and the houses go dark, a battery at its floor before dawn, and a
45-minute gateway gap. Time bins follow the microgrid's time zone, so a day
with a daylight-saving change has 23 or 25 hours of bins.

Two keys guard it:

- `MGM_METERING_FIXTURES` must be on ([Runtime configuration](#runtime-configuration)).
  Only then does the runtime register it, as the `synthetic` metering
  provider (`src/lib/metering/fixture/plugin.ts`). While it is off, edge
  registration refuses ids that start with `SYNTHETIC-EDGE-`.
- Every edge of the microgrid must have an id starting with
  `SYNTHETIC-EDGE-`. A microgrid with none keeps its usual provider, and one
  that mixes synthetic and real edges is refused (409). The provider also
  refuses any device whose edge id lacks the prefix, so it never stands in
  for a real meter.

The Operations day of such a microgrid shows a "Synthetic data" banner.
It has no readings for billing, so generating a bill for such a microgrid
fails rather than billing zero.

To set one up with the setting on, create a microgrid and register its edge
and devices through the API:

1. `POST /api/microgrids/<id>/edges/register` with
   `{"edges":[{"openems_edge_id":"SYNTHETIC-EDGE-001","name":"Synthetic"}]}`.
2. `POST /api/devices` for a battery, a grid meter, an inverter and
   consumption meters on that edge, then link the meters to households.

## Local Supabase Services

After `./setup.sh` in local mode, these services are running:

| Service | URL | Description |
|---------|-----|-------------|
| API (PostgREST) | http://127.0.0.1:54321 | REST API used by the app |
| Studio | http://127.0.0.1:54323 | Database admin UI |
| Inbucket | http://127.0.0.1:54324 | Email testing (catches auth emails) |
| Database | postgresql://postgres:postgres@127.0.0.1:54322/postgres | Direct psql access |

### Useful commands

```bash
supabase status         # Show running services and keys
MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase db reset   # Re-apply migrations + seed (destructive)
supabase stop           # Stop all local Supabase containers
supabase start          # Restart containers
```

Without `MGM_ALLOW_DEV_CREDENTIAL_KEY=1`, a reset stops at migration `00018`
because the new database has no credential encryption key. `supabase start`
needs the variable too when it creates a new database (the first start, or
after `supabase stop --no-backup`), and so does `supabase db diff`, which
builds a shadow database from the migrations. See
[the runbook](runbooks/dek.md#local-development-and-ci).

## Per-org customerapp activation (`/api/v1/*`)

The customerapp integration (`/api/v1/*` routes) is gated per-org by
`organizations.customerapp_enabled` (#251). The column defaults to `FALSE`
on every org — a valid per-org API token (#255) is necessary but not
sufficient. An org must be explicitly opted in before any `/api/v1/*` call
against it succeeds; otherwise the call returns `403 customerapp_not_enabled`.

Flip the flag (super_admin only — enforced by RLS on `organizations`):

```sql
UPDATE organizations
SET customerapp_enabled = TRUE
WHERE id = '<org-uuid>';
```

To kill-switch a misbehaving org without revoking the token, flip it back
to `FALSE`. See `docs/customerapp-activation.md` for the full activation
runbook.

## RLS Tests (local Supabase only)

The RLS test suite (`src/lib/supabase/__tests__/rls.test.ts`) verifies that Row Level Security
policies correctly constrain cross-tenant access. These tests **require a running local Supabase CLI
instance** — they never run against cloud Supabase to prevent polluting shared data.

### Prerequisites

- **Local Supabase CLI** running (`MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase start`, or `./setup.sh`).

### Running RLS tests

```bash
# 1. Start local Supabase (if not already running)
MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase start

# 2. Re-apply migrations + seed (only needed once, or after schema changes)
MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase db reset

# 3. Get the JWT secret (needed to mint impersonation JWTs)
supabase status | grep "JWT secret"
# Output: JWT secret: super-secret-jwt-token-with-at-least-32-characters-long

# 4. Add SUPABASE_JWT_SECRET to .env.local
echo 'SUPABASE_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long' >> .env.local

# 5. Run only the RLS tests
npm test -- rls.test.ts

# 6. Run the full test suite (includes RLS)
npm test
```

### Bypassing RLS tests

If you don't have local Supabase running (e.g. CI without Docker), set `SKIP_RLS_TESTS=1`:

```bash
SKIP_RLS_TESTS=1 npm test
```

Missing `MGM_PUBLIC_SUPABASE_ANON_KEY` or `SUPABASE_JWT_SECRET` without `SKIP_RLS_TESTS=1` will **fail
loudly** with an actionable error — this is intentional so CI catches missing config rather than
silently skipping coverage.

### The fresh-install key test

`src/lib/supabase/__tests__/dek-bootstrap.test.ts` runs `supabase db reset`
twice: without `MGM_ALLOW_DEV_CREDENTIAL_KEY`, where the migrations must stop
at `00018`, and with it. Each reset wipes the local database, so `npm test`
reports the suite as skipped unless you ask for it:

```bash
RUN_DEK_BOOTSTRAP_TEST=1 npm test -- dek-bootstrap.test.ts
```

CI runs it in its own step after `npm test`.

### How JWT impersonation works

The harness mints JWTs locally with `jose` and `SUPABASE_JWT_SECRET`. Each JWT carries `sub=<userId>`
and `aud=authenticated`, which Supabase PostgREST uses to derive `auth.uid()` when evaluating RLS
policies. No password round-trips to GoTrue — the impersonation is purely local and fast.

## Browser smoke test (local Supabase only)

`e2e/` holds a Playwright smoke test that `Test` runs after `npm test`. In
Chromium at 360 × 800 with touch as the pointer, it signs in, opens the home
page and a microgrid's households list, and checks that no page scrolls
sideways, that tables scroll inside their own box and that controls are at
least 44 px. It creates its own organization, microgrids, households and
user in the local database and deletes them afterwards. Timings are printed,
not enforced.

```bash
npx playwright install chromium        # once
npm run build
eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET)=')"
MGM_PUBLIC_SUPABASE_URL="$API_URL" MGM_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" \
  SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" SUPABASE_JWT_SECRET="$JWT_SECRET" \
  npm run test:e2e
```

It starts the app on port 3100, or reuses one already listening there. It
refuses to run unless `MGM_PUBLIC_SUPABASE_URL` is the local Supabase.

## Full-Stack Setup (with OpenEMS)

To test meter readings and billing generation, you need the OpenEMS stack running alongside MGM.

```bash
# Terminal 1: Start OpenEMS
cd path/to/docker-openems   # your checkout of the OpenEMS Docker stack
./setup.sh --edges 1

# Terminal 2: Start MGM
cd path/to/mgm
./setup.sh            # or ./setup.sh --docker
```

If using `--docker` mode, OpenEMS on the host is reachable via `host.docker.internal:8075` (configured automatically).

If using local/dev mode, run `npm run dev` after setup.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Docker daemon is not running` | Start Docker Desktop, then re-run `./setup.sh` |
| `supabase: command not found` | Install: `brew install supabase/tap/supabase` |
| `function gen_salt(unknown) does not exist` | Verify seed.sql uses `extensions.crypt()` / `extensions.gen_salt()`. Run `MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase db reset` to re-apply. |
| `.env.local already exists` | Use `./setup.sh --force` to overwrite |
| `[mgm] NEXT_PUBLIC_… is set but no longer read` at `npm run dev` | Rename the variable in `.env.local` ([Upgrading from v0.0.1 or v0.0.2](#upgrading-from-v001-or-v002)), or rerun `./setup.sh --force` (in local mode this also resets the local database) |
| `No credential encryption key` from `supabase start` or `supabase db reset` | Local database: rerun with `MGM_ALLOW_DEV_CREDENTIAL_KEY=1`. Shared database: follow [docs/runbooks/dek.md](runbooks/dek.md) |
| Login fails with "Invalid credentials" | Run `MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase db reset` (local mode) or `./setup.sh --docker --force` (docker mode) to re-seed the admin user |
| `Failed to reach OpenEMS at localhost:8075` | Start the docker-openems stack first (see Full-Stack Setup) |
| Billing generation shows "No meter reading data" | Ensure OpenEMS edge simulations are running and meters are assigned to tenants |
| Docker mode: app not starting | Check `docker compose logs mgm-app` for errors |
| Docker mode: migration failures | Check `docker compose logs mgm-migrate` for errors. Try `./setup.sh --docker --force` for a fresh start. |

## Architecture

```
Browser (localhost:3000)
   |
   +-- Next.js App (App Router)
   |     +-- Supabase Auth (login, session, RLS)
   |     +-- Supabase Postgres (orgs, microgrids, tenants, billing)
   |     +-- OpenEMS B2B REST API (meter readings)
   |
   +-- Local Supabase (localhost:54321)  <-- setup.sh --local
   |   or Docker Supabase (localhost:54321)  <-- setup.sh --docker
   |   or Cloud Supabase (*.supabase.co)  <-- setup.sh --cloud
   |
   +-- OpenEMS Backend (localhost:8075)  <-- docker-openems
```
