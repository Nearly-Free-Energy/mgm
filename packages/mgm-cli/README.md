# mgm, MGM's command line

`mgm` signs in to an MGM installation as you and acts as you from a terminal
(RFC #259). This first part (#297) has three commands: `login`, `whoami` and
`logout`. Read commands (#298), `mgm do` (#299) and the assistant bridge
`mgm mcp` (#301) build on them.

**Not released yet.** An installation answers the routes `mgm` needs
(`/api/auth/discovery`, `/api/auth/logout`, `/api/gui/manifest` and the
consent and code pages) only from the release that ships the CLI (#300).
Until then `mgm login` says the installation does not offer sign-in from the
terminal.

## Running it

Node.js 24, on macOS or Linux. From a checkout of this repository:

```bash
npm run mgm -- login --url http://127.0.0.1:3000
npm run mgm -- whoami
npm run mgm -- logout
```

Node.js runs the sources as they are (`src/mgm.ts`); the release archive
(#300) bundles them. `mgm` has no runtime dependency.

Locally, the installation must be set up for clients that are not a browser
(`docs/setup.md`, "Clients that are not a browser"): the OAuth server on, the
CLI registered and listed as an `operator` client, and MGM opened at
`MGM_APP_URL`, `http://127.0.0.1:3000`.

## Commands

Every command takes `--json`, which prints the answer as one JSON object on
standard output. Prompts and progress always go to standard error.

| Command | Does | Options |
|---------|------|---------|
| `mgm login --url <address>` | Signs in to the installation you open at `<address>` | `--no-browser` prints the sign-in address without opening a browser |
| `mgm whoami` | Says which installation and person this terminal is signed in as | `--url` picks the installation |
| `mgm logout` | Ends this terminal's session and deletes its token file | `--url` picks the installation |

Without `--url`, `whoami` and `logout` use the installation `mgm login` last
signed in to. With `--url`, every command finds the installation the same
way: an address that redirects to the installation's own (see the token
store below) leads to the same sign-in, whether or not `mgm login` was given
that address. `mgm admin` is not a command: that name belongs to the
installation tooling (#252).

### `mgm login`

1. Reads the installation's public discovery answer (`GET /api/auth/discovery`):
   its Supabase URL and anon key, Supabase Auth's authorize and token
   endpoints, its sign-in code page, and the clients it lists. `mgm` signs in
   as the last `operator` client listed. It follows up to three redirects,
   each only to an https address (or http on this computer), and uses the
   answer only when its code page is on the origin that answered, so the
   installation it signs in to is the one that gave the answer. When the
   address you typed led elsewhere, it says where.
2. Opens your browser at Supabase Auth's authorize endpoint and prints the
   address too, so you can open it on another device when the terminal has
   no browser (over SSH, on a server). It opens no local port. The request
   uses PKCE with `S256`, a new random `state`, and scope `email`; never
   `openid`, which the installation refuses.
3. MGM's consent page asks you to connect the MGM command line. Approve only
   if you ran `mgm login` yourself just now. The code page then shows one
   string, `<state>.<code>`.
4. You paste it into the terminal. `mgm` refuses a string whose state is not
   the one this command made, and writes nothing. Otherwise it exchanges the
   code with its PKCE verifier (a code works once, for 10 minutes).
5. It saves the token file and says who you are signed in as: the
   installation, your email address and the client kind, for example

   ```
   Signed in to https://mgm.example.org as person@example.org.
   Client:     operator (the MGM command line)
   Token file: /home/person/.config/mgm/installations/https+mgm.example.org/operator.json (readable only by you)
   Contract:   0.2.1 (this mgm), 0.2.1 (installation)
   ```

   The email comes from the installation's manifest (`GET /api/gui/manifest`)
   or, while the installation's release does not answer that, from Supabase
   Auth (`GET /user`).

Staff and people whose access is only to their own unit (tenants) sign in
the same way.

Signing in again replaces the token file. `mgm` then ends the session the
old file held, as `mgm logout` would; when it cannot, it says that the
earlier session may still be live until it expires, and that revoking the
MGM command line from Connected apps ends it (and the new one too).

### `mgm whoami`

Names the installation, the signed-in person, the client kind and the file
that holds the token, refreshing the token first when it is about to expire.
It also compares the GUI contract version this `mgm` was built with against
the installation's (from its manifest) and says so when they differ; install
the `mgm` from the installation's release then. This is the one place the
CLI checks the version.

### `mgm logout`

Asks the installation to end this terminal's session
(`POST /api/auth/logout`, with this session's own token), then deletes the
token file.

What it ends:

- this terminal's session: its refresh fails at once, and Supabase Auth and
  MGM's routes refuse its access token at once.

What it does not end:

- your browser session, your other apps, and another terminal's `mgm`
  session of yours;
- your approval of the MGM command line, so it stays listed under Connected
  apps, and the next `mgm login` still shows the consent page;
- the access token issued before logout, at the database API. That token
  keeps working there until it expires: the project's JWT expiry, one hour
  by default (ADR-008 decision 4). MGM's own routes refuse it at once.

It sends the token only to the installation the token file names.

When MGM answers that it does not accept the token (401), `mgm` asks
Supabase Auth itself (`GET /user`) before saying the session had already
ended, since MGM answers 401 to every app request while it cannot reach
Supabase Auth. The session counts as already ended only when Supabase Auth
refuses the token too.

If MGM cannot be reached, or does not answer that the session ended (its
release has no logout route, client tokens are turned off, or Supabase Auth
still accepts a token MGM refused), `mgm` still deletes the token file,
exits with status 1, and says to revoke the MGM command line from Connected
apps in MGM, which ends every session of it at once.

## The token store

Where the files are:

- `$XDG_CONFIG_HOME/mgm` when `XDG_CONFIG_HOME` is set, else
  `~/Library/Application Support/mgm` on macOS and `~/.config/mgm` on Linux.
- One file per installation and client:
  `installations/<scheme>+<host>[+<port>]/operator.json` holds the command
  line's token, for example `installations/https+mgm.example.org/` or
  `installations/http+127.0.0.1+3000/`. A host character other than a
  letter, digit, `.` or `-` is written as `_` and two hex digits, so each
  origin has its own folder. `mgm mcp` (#301) will sign in on its own as the
  agent client and keep `agent.json` beside it; it never reads the operator
  file. The installation's folder is named after its own address (the
  origin of the code page it returns clients to), so an address that
  redirects to it shares its files.
- `config.json` names the installation commands use without `--url`, and
  the addresses `mgm login` was given that led to another installation
  address (`aliases`). `whoami` and `logout` given an address with no
  folder and no alias ask its discovery answer where it leads.

A token file holds the installation, its Supabase URL, anon key and token
endpoint, the client id and kind, the access and refresh tokens, when the
access token expires, and who it is signed in as.

Only you can read them:

- `mgm` makes its directories `0700` and its files `0600`, and refuses a
  directory that is a symbolic link, belongs to someone else or that others
  can write to.
- It writes a file to a new temporary file, checks it, and renames it over
  the old one. If the file system left it readable by others (some report
  every file as `0777`), it deletes it and saves nothing.
- It checks the file again on every read, without following a symbolic link,
  and refuses one that is not yours or that others can read or write, saying
  why and how to fix it (`chmod 600 <file>`).
- Windows is refused for now: Node.js reports every file there as readable
  by everyone, so the check cannot be made from the mode, and checking the
  file's access list instead is not decided (#297). Use `mgm` from WSL.
- The operating system's credential store is left for later.

Each file has its own lock, `<file>.lock`. Supabase Auth replaces the refresh
token on every refresh, and a refresh token used again after the project's
reuse window (`refresh_token_reuse_interval`, 10 seconds locally; a hosted
project's own setting governs) signs you out. So a command whose access token
has less than a minute left takes the file's lock, reads the file again, and
refreshes only if no other command did so meanwhile. Two commands never
refresh with the same token. A lock is taken over once the command that holds
it has stopped (when it was taken on this computer), or after 60 seconds; a
lock taken on another computer, as with a config folder on a network disk,
counts as held until then. Every request gives up after 20 seconds, so a
running command always finishes well before that. A command waits up to 30
seconds for another's lock.

Only one waiting command takes over a stale lock at a time: it first takes a
second, short-lived lock (`<file>.lock.break`), checks again that the lock is
the stale one, moves it aside, and deletes it only if it moved that same
file. A `.lock.break` left behind by a command killed in those few file
operations is removed after 5 seconds; only that removal is a plain check
then delete.

When a refresh is refused (you revoked the app, or the session ended), the
command says to run `mgm login` again.

## Errors

`mgm` prints `mgm: <what went wrong and what to do>` on standard error, or
`{ "error", "code" }` with `--json`, and exits with status 1 (2 for a usage
mistake). It reads MGM's refusals as `{ error, code }` where the route gives
a code, `{ error }` where it does not, and plain text for a path the
installation's release does not include, so it never depends on a code being
there.

## Development

- `src/__tests__/boundary.test.ts` holds what the CLI imports: its own files,
  `node:` built-ins, and three modules of the app, the client-safe GUI
  contract (`src/lib/gui/contract.ts`), the pasted-code codec
  (`src/lib/auth/pasted-code.ts`) and the discovery answer's type
  (`src/lib/auth/discovery-answer.ts`). It also type-checks the sources with
  this package's `tsconfig.json` (Node.js types, no DOM, only syntax Node.js
  can strip), so a contract change that breaks the CLI fails in the same
  pull request.
- `npm test -- --project cli` runs the unit tests.
  `src/__tests__/cli.db.test.ts` runs `login`, `whoami` and `logout` against a
  local Supabase with the installation's routes in process; it runs in the
  `rls` project.
