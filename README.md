# MGM — Microgrid Manager

An operating system for microgrid operators. Organizations manage their communities, microgrids, tenants, and meters; read consumption from OpenEMS; bill tenants against tariffs; and collect payments — each as a plugin they can turn on or off.

**Stack:** Next.js (App Router) + [Cordis](https://github.com/cordiverse/cordis) plugin runtime + Supabase (Postgres, Auth, RLS) + OpenEMS (meter data via its B2B API) + Pesapal (payments)

**Docs:** [operating model](docs/operating-model.md) · [Cordis runtime](docs/cordis-runtime.md) · [entity model](docs/entity-model.md) · [setup](docs/setup.md) · [releasing](docs/releasing.md) · [runbooks](docs/runbooks/)

## Getting Started

See [docs/setup.md](docs/setup.md) for prerequisites and setup instructions.

```bash
./setup.sh      # bootstrap local Supabase + .env.local
npm run dev     # start dev server at http://localhost:3000
```

## Related

- [Nearly-Free-Energy/openems](https://github.com/Nearly-Free-Energy/openems) — OpenEMS energy platform (Edge + Backend + UI)

### OpenEMS Keycloak configuration

Before enabling Keycloak client credentials, set the server-only
`OPENEMS_KEYCLOAK_TOKEN_URLS` environment variable to a comma-separated list of
exact approved HTTPS token endpoint URLs. The URL entered in each microgrid's
OpenEMS configuration must match an entry. Unlisted endpoints fail closed;
redirects are rejected. Add the pilot's actual token endpoint during deployment.
This setting contains URLs only, never client secrets. Client IDs and encrypted
client secrets remain configured per microgrid in MGM.

## Licence

MGM is free software under the [Eclipse Public License 2.0](LICENSE)
(EPL-2.0). It began on 23 September 2026 as a fork of
[`energy-iot/metering-billing-engine`](https://github.com/energy-iot/metering-billing-engine),
which is also EPL-2.0, and keeps that licence; the copyright in each file
belongs to the people who wrote it. `NOTICE` carries the attribution.

What EPL-2.0 means here:

- **Changes to MGM's own files** that you distribute: their Source Code
  must be made available under EPL-2.0 (§ 3.1(a) and § 3.2). The Object
  Code may go out under another licence that meets § 3.1(b).
- **Hosted use.** Running MGM as a service creates no obligation for code
  that runs only on the server, because that code is not distributed.
  MGM treats code sent to browsers as distributed: EPL-2.0 § 1 counts
  "making available in any manner that enables the transfer of a copy"
  as distributing, and MGM is a Next.js app that sends its client
  JavaScript to every browser. On that reading, whoever hosts MGM
  accompanies it with a statement that the Source Code is available under
  EPL-2.0 and says how to obtain it (§ 3.1(a)). The place for that
  statement is the running app, for an unmodified release as well as a
  modified one. For an unmodified release, the Source Code is the
  release's source in this repository. Whoever hosts a modified MGM also
  makes the Source Code of their modified files that reach the browser
  available to those users, in a manner customarily used for software
  exchange (a public repository linked from the running app is one way).
  MGM does not show such a statement yet; adding one is a follow-up.
- **Plugins.** A plugin kept in this repository is a contribution to MGM
  and is under EPL-2.0 ([contributing](CONTRIBUTING.md)). A plugin
  distributed separately, in files of its own, carries the licence its
  author chooses. A plugin that alters MGM's files, or copies MGM code
  into its own files, is a change to MGM (EPL-2.0 § 1, "Modified Works").
  Distributing a plugin together with MGM, including in the same bundle,
  requires that the terms of both licences can be met at once.
- **No Secondary Licence is designated** (EPL-2.0 § 3.2 and Exhibit A), so
  MGM's code is not available under the GNU General Public License (GPL),
  and GPL code cannot be combined with MGM, whether in this repository or
  in a bundle distributed with it. Keep that in mind when choosing
  dependencies and plugins.
- **Third-party packages** bundled into a release are listed, with their
  licence texts, in the `mgm-third-party-notices-<version>.txt` file
  published beside each release asset ([releasing](docs/releasing.md)).
  The Inter typeface, self-hosted by `next/font`, is under the
  [SIL Open Font License 1.1](https://openfontlicense.org/) (not yet
  listed in that file; see
  [#37](https://github.com/Nearly-Free-Energy/mgm/issues/37)).

Contributions are accepted under EPL-2.0 with a
[Developer Certificate of Origin](https://developercertificate.org/)
sign-off; there is no contributor licence agreement
([contributing](CONTRIBUTING.md)).
