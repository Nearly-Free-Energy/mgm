# Metering & Billing Engine (MBE)

Multi-tenant billing engine for microgrid energy management. Tracks energy consumption per tenant, applies time-of-use rate schedules, and generates billing summaries for microgrid entrepreneurs.

**Stack:** Next.js (App Router) + Supabase (Postgres, Auth, RLS) + OpenEMS (meter data via B2B REST API)

## Getting Started

See [docs/setup.md](docs/setup.md) for prerequisites and setup instructions.

```bash
./setup.sh      # bootstrap local Supabase + .env.local
npm run dev     # start dev server at http://localhost:3000
```

## Related

- [https://github.com/Nearly-Free-Energy/openems) -- OpenEMS energy platform (Edge + Backend + UI)

### OpenEMS Keycloak configuration

Before enabling Keycloak client credentials, set the server-only
`OPENEMS_KEYCLOAK_TOKEN_URLS` environment variable to a comma-separated list of
exact approved HTTPS token endpoint URLs. The URL entered in each microgrid's
OpenEMS configuration must match an entry. Unlisted endpoints fail closed;
redirects are rejected. Add the pilot's actual token endpoint during deployment.
This setting contains URLs only, never client secrets. Client IDs and encrypted
client secrets remain configured per microgrid in MGM.
