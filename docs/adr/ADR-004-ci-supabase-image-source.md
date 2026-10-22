# ADR-004: Pull Supabase CI images from GHCR

## Status: Accepted

## Context

The `Test` workflow runs `npx supabase start` on `ubuntu-latest`. The pinned
Supabase CLI (2.98.2) pulls every service image from `public.ecr.aws/supabase`
by default. ECR Public throttles anonymous pulls per source IP, and GitHub's
shared runners hit that limit, so `Test` failed with
`toomanyrequests: Data limit exceeded` before any test ran (run 39753054304).

The CLI source at the pinned tag (`internal/utils/docker.go`) reads
`INTERNAL_IMAGE_REGISTRY` through viper with the `SUPABASE` env prefix, so the
supported override is `SUPABASE_INTERNAL_IMAGE_REGISTRY`. The image name is
rewritten to `<registry>/supabase/<name>:<tag>`. Docker Hub (`docker.io`) is
also accepted but has its own anonymous rate limit on shared IPs. Supabase
publishes the same images and tags to `ghcr.io/supabase`; the tags the pinned
CLI uses were checked to exist there anonymously.

## Decision

Set `SUPABASE_INTERNAL_IMAGE_REGISTRY: ghcr.io` in the job-level `env` of the
`Test` job, so every Supabase CLI command in the job pulls from GHCR. That
covers `supabase start` and any later command that recreates a container,
such as the `supabase db reset` runs in the fresh-install key check, which
delete and recreate the database container. No services are excluded: the
database suites use storage (`invoice_logos_bucket`), and the saving from
excluding the rest is small against the risk of diverging from the local
setup. The job names `Test` and `CodeQL` and `permissions: contents: read`
are unchanged.

## Consequences

- Image pulls come from a registry that serves GitHub-hosted runners without
  the ECR Public anonymous limit; no secrets or extra permissions are needed.
- If a future CLI upgrade pins an image that is not mirrored to GHCR, the step
  fails at pull time; re-check the registry then, or fall back to caching.
- Local development is unaffected; the variable is set in CI only.
- This repository has no Structurizr DSL, so none is updated.

### Amendment (22 Oct 2026): authenticate to GHCR

Anonymous pulls from GHCR were then also refused with `toomanyrequests` on shared runners. The `Test` job now logs in to `ghcr.io` with the job's own `GITHUB_TOKEN` (`packages: read`, no stored secret) before `supabase start`, so pulls count as authenticated. Fork pull requests get the same read-only token, so this needs no repository secret.

The start step also retries up to three times with a growing pause, because GHCR throttles in short bursts even for authenticated pulls ("toomanyrequests: retry-after ...ms").

### Amendment (22 Oct 2026): pre-pull one at a time and cache

Login and retries were not enough: every `supabase start` attempt still failed with `toomanyrequests: retry-after: <microseconds>, allowed: 44000/minute` (run 39821988704), because the CLI pulls about a dozen images in parallel and GHCR throttles that burst from shared runner IPs. The `Test` job now:

1. restores the images from `actions/cache` (key `supabase-images-<hash of .github/supabase-ci-images.txt>`, a gzip'd `docker save` tarball);
2. on a miss, pulls each missing image alone, up to 12 attempts with a short pause, alternating GHCR with `public.ecr.aws/supabase` (the CLI default mirror, re-tagged to the GHCR name) because single GHCR pulls were also throttled (run 39826733507: `retry-after: 65µs`, about half of attempts refused), then archives the full set so the cache is saved at job end (never from a partial set);
3. runs `supabase start` as before. The CLI (compose pull, `PullPolicyMissing`, `internal/utils/config.go GetServices`) skips images already present locally, so a warm run pulls nothing.

The list is `.github/supabase-ci-images.txt`. Tags come from the pinned CLI's `pkg/config/templates/Dockerfile` and names from `GetRegistryImageUrl` (`ghcr.io/supabase/<last path segment>`). It holds every image `GetServices` returns for `supabase/config.toml`: db, kong, postgrest, gotrue, mailpit, realtime, storage-api (used by the rls suites), imgproxy (pulled whenever storage is enabled), edge-runtime, studio and postgres-meta. Vector, logflare and supavisor are omitted because analytics and the pooler are disabled in the config; omitting them was checked against `GetServices`, not assumed.

Consequences: when the CLI version changes, the list must be regenerated (a cache key change follows automatically). A step after start warns if a running Supabase container is missing from the list, so drift shows up as a warning and a slower run, not a failure. A failed pre-pull is a warning too: `supabase start` and its retries remain the fallback. The cache needs no extra permission or secret and works for fork pull requests (they restore, and save only in their own scope). A tarball is roughly 1.5 to 2 GB, within the 10 GB repository cache budget.
