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

- **Changes to MGM's own files** that you distribute must be made
  available under EPL-2.0 (§ 3). Running MGM as a service, modified or
  not, is not distribution and creates no obligation on its own.
- **Plugins and other code in files of their own** may carry any licence.
  A plugin that alters MGM's files is a change to MGM.
- **No Secondary Licence is designated** (EPL-2.0 § 3.2 and Exhibit A), so
  MGM's code is not available under the GPL, and GPL code cannot be
  combined into MGM. Keep that in mind when choosing dependencies.
- **Third-party packages** bundled into a release are listed, with their
  licence texts, in the `mgm-third-party-notices-<version>.txt` file
  published beside each release asset ([releasing](docs/releasing.md)).
  The Inter typeface, self-hosted by `next/font`, is under the
  [SIL Open Font License 1.1](https://openfontlicense.org/).

Contributions are accepted under EPL-2.0 with a
[Developer Certificate of Origin](https://developercertificate.org/)
sign-off; there is no contributor licence agreement
([contributing](CONTRIBUTING.md)).
