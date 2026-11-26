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

Open [http://localhost:3000](http://localhost:3000) and sign in. MGM has no
passwords (RFC #186): enter `admin@example.org`, choose **Email me a sign-in
link**, then open the email in Mailpit at
[http://localhost:8025](http://localhost:8025) and follow its link.

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

If you set up before the seed changed, your database still has the old
sample admin address, so `admin@example.org` gets no link. Run
`./setup.sh --docker --force`: it copies the seed template again before it
starts the stack. The manual commands do not copy it.

### Limitations

- No hot reload -- runs `next start` (production build). Use the dev path for active development.
- No Supabase Studio -- use the dev path if you need the database admin UI.
- No sign-in for clients that are not a browser -- docker mode leaves
  Supabase Auth's OAuth server off, so the CLI and the assistant bridge cannot
  sign in. Use the dev path ([Clients that are not a browser](#clients-that-are-not-a-browser)).

## Dev path (developer)

Runs local Supabase via CLI with hot reload and full dev tooling.

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 24 (see `.nvmrc`) | `nvm install` or `fnm install` (reads `.nvmrc`), or `brew install node@24` (keg-only: add it to your `PATH`). `brew install node` installs the newest release, not 24. |
| npm | 9+ | Bundled with Node.js |
| Docker Desktop | 4.0+ | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |
| Supabase CLI | 3.4+ (`package-lock.json` pins 3.4.0, which `npx supabase` runs; `./setup.sh` refuses an older global CLI) | `brew install supabase/tap/supabase` or [docs](https://supabase.com/docs/guides/cli/getting-started); upgrading from 2.x: [Upgrading to Supabase CLI 3](#upgrading-to-supabase-cli-3) |

### Quick Start — Local Supabase (recommended)

```bash
git clone https://github.com/Nearly-Free-Energy/mgm.git
cd mgm
./setup.sh
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in. MGM has no
passwords (RFC #186): enter `admin@example.org`, choose **Email me a sign-in
link**, then open the email in the local mail catcher at
[http://127.0.0.1:54324](http://127.0.0.1:54324) and follow its link. This
needs `MGM_SMTP_URL` and `MGM_MAIL_FROM` in `.env.local`, which
`.env.local.example` sets for the catcher.

**Already set up before the seed changed?** Your copied
`supabase/migrations/00003_seed.sql` and your database still have the old
sample admin address, so `admin@example.org` gets no link. Copy the template
again and reset the local database, which deletes its data:

```bash
cp supabase/migrations/00003_seed.sql.template supabase/migrations/00003_seed.sql
MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase db reset
```

`./setup.sh --force` also does both, but it rewrites `.env.local` as well,
with only the Supabase keys, `MGM_APP_URL` and the OpenEMS defaults. That
drops `MGM_SMTP_URL` and `MGM_MAIL_FROM`, which sign-in needs, and
`SUPABASE_JWT_SECRET`, which the RLS tests need, so add them back after it.
On the Docker path, see *Reset to fresh state* above.

`npm run dev` builds the interface's stylesheet once before it starts. While
you change classes under `src/gui/` or the tokens in `src/styles/tokens.css`,
run `npm run gui:styles:watch` beside it to rebuild the stylesheet.

### Upgrading to Supabase CLI 3

`supabase/config.toml` is written for Supabase CLI 3.4 or later, whose local
stack runs Supabase Auth v2.198.0
([ADR-008](adr/ADR-008-sign-in-for-clients-that-are-not-a-browser.md)). A
checkout set up before that keeps its old CLI and its old Auth until you:

1. Run `npm ci`, so `npx supabase` and the `db:types` scripts use the pinned
   3.4.0. Until then `npm run db:types` and the pre-commit check refuse to
   run.
2. Upgrade the global CLI (`brew upgrade supabase`), or run the commands
   below as `npx supabase`.
3. Restart the stack so it pulls the new images: `supabase stop`, then
   `MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase start`. `supabase stop` keeps the
   database.
4. Check that `docker ps` shows `gotrue:v2.198.0`.

In a checkout where you ran `supabase link`, `supabase start` runs the Auth
version in `supabase/.temp/gotrue-version` instead, the linked project's
version when you linked it, which may be older or newer. Delete that file to
run the pinned version; the next `supabase link` writes it again.

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
1. Checks prerequisites (Node.js, npm, Docker, Supabase CLI 3.4 or later)
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
| `MGM_APP_URL` | for sign-in and payments | no | Public origin of this installation (`https://mgm.example.org`, no path). Must be `https`, except for `localhost`, `127.0.0.1` and `[::1]`. Builds sign-in links (`/auth/confirm`), payment links, the provider return URL `/payment/callback`, and the notification URL `/api/payments/ipn` registered with the payment provider |
| `MGM_SMTP_URL` | for sign-in by email | no | The deployment's own mail server (RFC #186): the only sender of sign-in links, and the fallback for organizations' notices. `smtps://user:password@smtp.example.com:465` (TLS) or `smtp://user:password@smtp.example.com:587` (STARTTLS required); percent-encode `@`, `/` and `:` in the user or password. Plaintext `smtp://` is accepted only for `localhost`, `127.0.0.1` and `[::1]`, for the local mail catcher: `smtp://127.0.0.1:54325`, then read the mail at http://127.0.0.1:54324; or for a container-network name with no dot when `MGM_SMTP_ALLOW_PLAINTEXT_LOCAL=1`. Errors name the variable, never its value. Without it the "Email me a sign-in link" button sends nothing and the server logs why |
| `MGM_MAIL_FROM` | with `MGM_SMTP_URL` | no | The From of the deployment's emails: `MGM <no-reply@example.org>` or a bare address |
| `MGM_SMTP_ALLOW_PLAINTEXT_LOCAL` | no | no | `1` allows `MGM_SMTP_URL` to be plaintext `smtp://` to a name with no dot, such as docker compose's `smtp://mailpit:1025`. Set it only where that name is a mail catcher in the same container network, never in production: sign-in links are credentials, and a dotless name may resolve to another machine |
| `MGM_GUI` | no | no | Which compiled-in interface (`src/gui/meta.ts`) serves this installation's pages. Unset or blank means `gridtop`, the default. The interface pages read it and link that interface's stylesheet; payment and sign-in pages do not |
| `MGM_METERING_FIXTURES` | no | no | `on` (or `1`, `true`) lets the fixture metering provider generate synthetic site data and meter energy for edges whose id starts with `SYNTHETIC-EDGE-` ([Synthetic site data](#synthetic-site-data)). Unset, blank, `off`, `0` or `false` means off. Read when the server's runtime starts, so a change needs a restart |
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
A missing `MGM_APP_URL` only logs a warning, because the features that need
it, sign-in links and payments, fail clearly on first use: the server logs
`send_failed` naming the variable. An `MGM_GUI` that names no compiled-in GUI is also
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

### Supabase Auth settings

People sign in only by the link MGM emails (RFC #186). Three settings
belong to the Supabase project rather than to MGM's environment.
`supabase/config.toml` sets them for the local Supabase and CI, and
`docker-compose.yml` for docker mode. On a hosted project, set them yourself:

- **Email OTP length 10, and expiry 900 seconds** (Authentication › Sign In
  / Providers › Email). The link says it works for 15 minutes.
- **The Custom Access Token hook** (Authentication › Auth Hooks): a
  Postgres function, `public.fn_auth_access_token_hook`, which migration
  `20261117210000` creates and `20261126090100` replaces. It refuses a token
  for a session that a password or a recovery started, new or refreshed, so
  Supabase's own password endpoints sign nobody in. For a client of the OAuth
  server it applies the rules in
  [Clients that are not a browser](#clients-that-are-not-a-browser). Push the
  migration before you enable the hook: while the function is missing,
  Supabase Auth issues no tokens at all.
- **Recommended: "Allow new users to sign up" off** (Authentication › Sign
  In / Providers). MGM creates accounts only through the admin API, when
  someone is invited, so this changes nothing in MGM. It stops strangers
  making accounts with no MGM role through Supabase's public endpoints.

A hosted project's settings can also be read and set with the Management
API (`GET`/`PATCH /v1/projects/<ref>/config/auth`: `mailer_otp_length`,
`mailer_otp_exp`, `disable_signup`, `hook_custom_access_token_enabled`,
`hook_custom_access_token_uri` =
`pg-functions://postgres/public/fn_auth_access_token_hook`).

**An installation that had passwords** finishes the change once, after the
hook is on, in the Supabase SQL editor:

```sql
UPDATE auth.users SET encrypted_password = '' WHERE encrypted_password <> '';
DELETE FROM auth.sessions;
```

The first line deletes every stored password hash. The second signs
everyone out: their refresh tokens go with the sessions. Access tokens
already issued stay valid until they expire, at most `jwt_expiry` (one
hour). Everyone then signs in by email link. Make sure the mail sender
works first (`MGM_SMTP_URL`), keep `docs/runbooks/emergency-sign-in.md`
at hand, and have at least two super admins, so one can still help if the
other's mailbox fails.

**Rolling back, or changing the function.** While the hook is on, Supabase
Auth calls the function for every sign-in and every refresh, the email link
and the emergency link included. If the function is missing or fails,
nobody can sign in. While it is off, Supabase Auth still issues tokens to
clients of the OAuth server, with no kind, no approval record and no check of
MGM's table of clients (ADR-008 decision 2). So, in this order:

1. If the project's OAuth server is on, turn it off first
   ([Clients that are not a browser](#clients-that-are-not-a-browser)), and
   check it is off: while it is off, Supabase Auth answers `404` with
   `feature_disabled` for
   `curl -sS <supabase-url>/auth/v1/.well-known/oauth-authorization-server -H "apikey: <anon key>"`.
2. Turn the hook off (Authentication › Auth Hooks, or `PATCH
   /v1/projects/<ref>/config/auth` with
   `hook_custom_access_token_enabled: false`), and read the setting back
   with `GET` to check it is `false`.
3. Only then change, replace or drop `public.fn_auth_access_token_hook`.
   Pushing a migration that replaces it, such as `20261126090100`, counts.
4. Turn the hook back on, if it should be, once the function is in place.
5. If you turned the OAuth server off in step 1, turn it back on last, only
   once the hook is on again.

Turning the hook off makes Supabase Auth issue tokens again; it does not
bring passwords back. The cutover above deleted the hashes for good, so
after it everyone still signs in by email link.

### Clients that are not a browser

MGM's command line (`mgm`) and the assistant bridge sign in as the person
through Supabase Auth's OAuth 2.1 server, which is in beta (RFC #259,
ADR-008). Each installation registers its own two public clients with
Supabase Auth and lists them in MGM's table, `public.mgm_clients`:

| Client | Kind | Lists it when |
|--------|------|---------------|
| The CLI | `operator` | The installation wants the CLI |
| The assistant bridge | `agent` | The release includes the assistant's database role (#274). Until then, register and list the operator client only: the hook refuses every sign-in and refresh of an `agent` client, listed or not |

The access-token hook (above) refuses a token for a client that
`mgm_clients` does not list, and writes the client's kind into the token as
the `mgm_client_kind` claim. It refuses a client sign-in that asks for scope
`openid`: MGM's clients get an access token and a refresh token, and nothing
else. A new client sign-in counts only after MGM's own consent page has
recorded the person's approval (`public.mgm_client_approvals`, written by
MGM's server); the hook uses that record up, and a refresh needs none. A
browser sign-in has no client and is unchanged.

**Supabase Auth v2.198.0 or later only** (ADR-008 decision 1). Older versions
accept a client's token on Supabase Auth's own account endpoints. Check
the version a project runs with `curl <supabase-url>/auth/v1/health -H
"apikey: <anon key>"`.

**1. Turn the OAuth server on.**

- *Local and CI:* `supabase/config.toml` does it (`[auth.oauth_server]`:
  `enabled = true`, `authorization_url_path = "/oauth/consent"`,
  `allow_dynamic_registration = false`). Supabase Auth sends the person to
  the consent page at `site_url` plus that path. The CLI's built-in signing
  key is enough; no key setup is needed. The clients' return address is
  `MGM_APP_URL` plus `/oauth/code` (the discovery answer gives the CLI that
  address), and the consent page follows Supabase Auth only to the code page
  of its own origin, so `MGM_APP_URL` must have `site_url`'s origin. Locally
  that is `http://127.0.0.1:3000`, not the `http://localhost:3000` that
  `./setup.sh` and `.env.local.example` write: to sign a client in locally,
  set `MGM_APP_URL=http://127.0.0.1:3000` in `.env.local` and open MGM at
  that address.
- *Hosted:* leave the OAuth server off until the release you run includes
  MGM's consent and code pages (#271, released with the CLI), the
  resolver's check of client tokens (#272) and the CLI. Before then no client can complete a sign-in, and a
  server that is on adds the turn-it-off-first step to every later change of
  the hook. Once they ship: in the dashboard's Authentication settings for
  the OAuth server, turn it on, set the authorization path to
  `/oauth/consent`, and leave dynamic client registration off. Leave the
  authorization lifetime at its default of 10 minutes: the hook counts an
  approval record for 10 minutes, and a different lifetime needs a
  migration that changes the hook to match. The project's Site URL must be
  MGM's address (`MGM_APP_URL`). These dashboard steps have not yet been
  checked against a hosted project (ADR-008, Consequences), so read each
  setting back after saving. Supabase recommends an asymmetric signing key
  (ES256) for the OAuth server.
- *Docker mode:* the OAuth server stays off, so no client can sign in.

If the access-token hook is not on, or the migrations up to
`20261126150000` are not pushed, leave the OAuth server off.

**2. Register each client** with Supabase Auth's admin endpoint, as a
public client: no secret, the grant types `authorization_code` and
`refresh_token`, and one return address, MGM's sign-in code page:
`MGM_APP_URL` plus `/oauth/code`, the address the discovery answer gives
the CLI. Supabase Auth compares return addresses as exact strings, so
`localhost` and `127.0.0.1` differ, and so do ports. Locally, with
`MGM_APP_URL` set as in step 1:

```bash
eval "$(supabase status -o env | grep '^SERVICE_ROLE_KEY=')"
MGM_APP_URL=http://127.0.0.1:3000   # as in .env.local: site_url's origin
curl -sS -X POST http://127.0.0.1:54321/auth/v1/admin/oauth/clients \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"client_name": "MGM CLI",
       "redirect_uris": ["'"$MGM_APP_URL"'/oauth/code"],
       "grant_types": ["authorization_code", "refresh_token"],
       "token_endpoint_auth_method": "none"}'
```

The answer's `client_id` is the client's id, and its `client_type` must be
`public`. For a hosted project, send the same request to
`https://<ref>.supabase.co/auth/v1/admin/oauth/clients` with the project's
service-role key and `MGM_APP_URL` set to MGM's address; or add the client
in the dashboard as a public client with the same return address. For the assistant bridge, repeat with `"client_name": "MGM
assistant bridge"`.

**3. List each client in MGM's table.** Locally with `supabase db query`,
on a hosted project in the SQL editor:

```sql
-- The CLI:
INSERT INTO public.mgm_clients (client_id, kind, label)
VALUES ('<client_id>', 'operator', 'MGM CLI');

-- The assistant bridge, once the release includes #274:
INSERT INTO public.mgm_clients (client_id, kind, label)
VALUES ('<client_id>', 'agent', 'MGM assistant bridge');
```

Only the service role and the database owner can write the table; no
browser or client token reads or writes it through the database API. The
label is the name MGM's consent page shows the person.

**What the person sees** (#271). These pages and routes answer 404 until the
release that ships the CLI lists them in `src/lib/mgm/released-routes.ts`.

- `mgm login --url <MGM's address>` first asks `GET /api/auth/discovery`,
  which needs no session and answers with the public Supabase URL and anon
  key, Supabase Auth's authorize and token endpoints, the code page's
  address (`MGM_APP_URL` plus `/oauth/code`) and the id and kind of each
  client in `mgm_clients`.
- Supabase Auth sends the browser to `/oauth/consent`, signing the person in
  first if needed. The page names the client (its label), its kind and what
  that kind may do, and warns that a program on the computer that ran the
  command will act as them. It asks Supabase Auth nothing until the person
  clicks Connect, even for a client they approved before, which Supabase
  Auth would approve on its first look. Connect records the approval through
  `POST /api/auth/oauth/approvals`, which refuses a bearer token and a
  cross-site request and checks the cookie session with Supabase Auth before
  it writes one record for that sign-in (`mgm_client_approvals.authorization_id`);
  only then does the page ask Supabase Auth for the code. Don't connect asks
  nothing, and the sign-in expires on its own.
- Supabase Auth then sends the browser to `/oauth/code`, which shows one
  string, `<state>.<code>`, to paste into the terminal that asked for it.

**Removing a client.** `DELETE FROM public.mgm_clients WHERE client_id =
'<id>';` refuses its next sign-in and its next refresh. It ends no session:
tokens already issued keep working at MGM's routes and at the database
until they expire (`jwt_expiry`, one hour by default). Deleting the client
in Supabase is the same. To replace a client, list the new one before
removing the old. An installation that wants no assistant at all leaves the
agent client out of the table.

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

It also generates each meter's energy per local day and hour for the
tenant app's usage views (`src/lib/metering/fixture/meter-energy.ts`), from
the meter, the day and a fixed seed, so a meter's figures do not depend on
which other meters are read. About one day in fourteen has a three-hour
block the meter "did not report", which the views show as no data. These
figures are generated separately from the site samples and do not add up to
them.

Two keys guard it:

- `MGM_METERING_FIXTURES` must be on ([Runtime configuration](#runtime-configuration)).
  Only then does the runtime register it, as the `synthetic` metering
  provider (`src/lib/metering/fixture/plugin.ts`). While it is off, edge
  registration refuses ids that start with `SYNTHETIC-EDGE-` (400). It
  checks the session with Supabase Auth first, so only a caller with a live
  session sees that refusal; others get 401. Only that route refuses the
  prefix. The setting is an environment variable the database never sees,
  so a direct insert or update through the Supabase API, which row-level
  security limits to people who can already edit the microgrid, still
  accepts it. Such an edge does nothing while the setting is off. If the
  setting is turned on later, a microgrid that mixes it with real edges is
  refused (409): its Operations day shows a banner saying so, and generating
  a bill for it fails. Synthetic data is never shown or billed as real.
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
   consumption meters on that edge, then link the meters to tenants.

## Local Supabase Services

After `./setup.sh` in local mode, these services are running:

| Service | URL | Description |
|---------|-----|-------------|
| API (PostgREST) | http://127.0.0.1:54321 | REST API used by the app |
| Studio | http://127.0.0.1:54323 | Database admin UI |
| Mailpit | http://127.0.0.1:54324 | Email testing (catches auth emails) |
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

## RLS Tests (local Supabase only)

The RLS test suite (`src/lib/supabase/__tests__/rls.test.ts`) verifies that Row Level Security
policies correctly constrain cross-organization access. These tests **require a running local Supabase CLI
instance** — they never run against cloud Supabase to prevent polluting shared data.

### Prerequisites

- **Local Supabase CLI** running (`MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase start`, or `./setup.sh`).

### Running RLS tests

A stack that was already running when you pulled a change to
`supabase/config.toml` keeps its old settings until you restart it
(`supabase stop`, then `MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase start`; the
database is kept). For example, a stack started before `[auth.oauth_server]`
was turned on in `supabase/config.toml` keeps its OAuth server off until it is
restarted, and
`auth_access_token_hook_clients.test.ts` fails in `beforeAll` with `404`
`feature_disabled` from `/admin/oauth/clients`.

```bash
# 1. Start local Supabase (if not already running)
MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase start

# 2. Re-apply migrations + seed (only needed once, or after schema changes)
MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase db reset

# 3. Get the JWT secret (needed to mint impersonation JWTs)
supabase status -o env | grep '^JWT_SECRET='
# Output: JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"

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
Chromium at 360 × 800 with touch as the pointer, it signs in by email link
(RFC #186), reading the link from the local Supabase's mail catcher, opens the home
page, a microgrid's tenants list and a tenant record with its App access
section, its Give access dialog and its Remove confirmation (with a long
address), and checks that no page or dialog scrolls
sideways, that tables scroll inside their own box and that controls are at
least 44 px. It also opens a community's invoice branding page, checks that
the invoice logo loads from its signed Supabase Storage URL, and runs
Preview bill, checking that the popup is sent to a `blob:` URL holding a
PDF. It opens a microgrid's billing periods, checking that the GUI host
serves the page (the `billing.periods` view) and lists the draft period,
and opens New billing period to check that its form fits the screen,
leaving without creating one; it opens that period's review (the
`billing.period-review` view), checking that it lists the bills as cards
with the totals and the period's controls, and opens a bill's actions to
check that they fit the screen, pressing none of them; and it opens that
period's history (the `billing.period-history` view) and its link back to
the period. It opens a
draft billing period's close checklist and its Close
confirmation step (the totals, the acknowledgements and the name to type),
checks that the step fits the screen and that its controls are 44 px
targets, and leaves without confirming. It opens the period's payment
links (the send queue, `…/send`), with a sandbox payment account seeded for
the organization, and checks that it says nothing is sent from it and that
the bill with a total offers its payment link to copy, without opening or
copying it. It opens that bill's payments, with an online payment attempt
seeded on it and held for reconciliation, checks that Refresh status and
both reconciliations are offered, and opens Record completed adjustment to
check that its step fits the screen, leaving without sending it; it never
presses Refresh status, which would ask the payment provider. Every page
fails on a page error, a
console error or a content security policy violation, popups included, and
on any write to the app's API other than the invoice preview and the
prepare steps, none of which writes. The headless Chromium it runs
has no PDF viewer, so it sees the preview as a download; it cannot show
that a desktop browser displays it. It creates its own organization,
community (with an invoice logo in the `invoice-logos` bucket), microgrids,
tenants, tariff, billing period, bills, payment account (no credential, and
never contacted), payment attempt and user in the local database and deletes
them afterwards (an organization with payment records is purged as the
database owner, which needs the `supabase` CLI and this project's
directory, or `SUPABASE_WORKDIR`).
Timings are printed, not enforced.

It also signs in a tenant (RFC #197) at 360 px. Their unit is in a second
organization of the smoke's own, with the tenant app turned on and one
meter on a `SYNTHETIC-EDGE-` edge, so the server runs with
`MGM_METERING_FIXTURES=1` ([Synthetic site data](#synthetic-site-data)).
The tenant lands on their home, `/my`, and the smoke opens a past month and
one of its days, checks that
neither scrolls sideways and that every link and button in `main` is at
least 44 × 44 px, and follows the links from the month to a day, to the
day before and back up to the month.

`e2e/oauth.spec.ts` signs a client in through the consent and code pages
(#271), once as the organization manager and once as the tenant: it
registers a client of its own with Supabase Auth, whose return address is
the code page on port 3100, lists it in `mgm_clients`, answers Connect,
exchanges the string the code page shows for a token, opens a second
sign-in and answers Don't connect, and opens an unknown sign-in and the
code page with no code, checking each at 360 px. Connect's record is the
one write it allows. It is skipped until `src/lib/mgm/released-routes.ts`
lists `/oauth/consent`, `/oauth/code` and `/api/auth/oauth/approvals`, and
runs from the release that does.

```bash
npx playwright install chromium        # once
npm run build
eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET)=')"
MGM_PUBLIC_SUPABASE_URL="$API_URL" MGM_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" \
  SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" SUPABASE_JWT_SECRET="$JWT_SECRET" \
  npm run test:e2e
```

It starts the app on port 3100, or reuses one already listening there. It
refuses to run unless `MGM_PUBLIC_SUPABASE_URL` is the local Supabase. The
app sends its sign-in link to the mail catcher on the default local ports
(`MGM_SMTP_URL=smtp://127.0.0.1:54325`, read through
`MGM_MAIL_CATCHER_URL=http://127.0.0.1:54324`); set both if your Supabase
uses other ports. The smoke sets `MGM_APP_URL` to the app on port 3100
itself, because the link is built from it, and checks that the link lands
there. It sets `MGM_METERING_FIXTURES=1` on the server it starts; a server
you started yourself and it reuses needs that setting too, or the tenant's
usage pages show no figures.

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
| `inbucket in supabase/config.toml is no longer supported` | The branch predates the move to Supabase CLI 3, which renamed the section to `[local_smtp]`. Rebase it on `main`, or run `npm ci` on that branch so `npx supabase` is its pinned 2.x CLI (and `npm ci` again after switching back). Until then its pre-commit `db:types:check` skips as if no database were running. |
| `./setup.sh` says the Supabase CLI is older than 3.4.0, or an older global `supabase` refuses `supabase/config.toml` | [Upgrading to Supabase CLI 3](#upgrading-to-supabase-cli-3) |
| `No credential encryption key` from `supabase start` or `supabase db reset` | Local database: rerun with `MGM_ALLOW_DEV_CREDENTIAL_KEY=1`. Shared database: follow [docs/runbooks/dek.md](runbooks/dek.md) |
| No sign-in email arrives | Check the server log for `auth.sign_in_link`: `no_access` means the address has no MGM role (run `MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase db reset`, or `./setup.sh --docker --force` in docker mode, to re-seed the admin user); `send_failed` with a setting name means `MGM_SMTP_URL` or `MGM_MAIL_FROM` is missing; `limited` means wait a minute (1 a minute, 5 an hour per address). In production, if a super admin must get in before the mail server is fixed, follow `docs/runbooks/emergency-sign-in.md` |
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
