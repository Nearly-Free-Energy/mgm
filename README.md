# MGM — Microgrid Manager

An operating system for microgrid operators. Organizations manage their communities, microgrids, households, and meters; read consumption from OpenEMS; bill households against tariffs; and collect payments — each as a plugin they can turn on or off.

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
