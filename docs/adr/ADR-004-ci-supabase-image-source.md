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
