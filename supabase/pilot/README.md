# MGM review/import schema

20260924_mgm_review_import_essentials.sql is a targeted, standalone SQL migration for a new Supabase project after the reviewed base migration files through 00015 (00003 is a seed template; 00005 and 00006 do not exist).

It is outside supabase/migrations on purpose. The pilot setup uses a curated schema and permissions subset. The script checks the reviewed base migration identities and required tables before changing the schema. Do not use the standard migration runner for this pilot setup.

The script adds the columns needed by the billing review path, the effective dates used by review calculations, and a metadata-only pilot_import_batches ledger. It limits a batch to 500 households and 5,000 readings. The ledger records the baseline timestamp and reconciliation counts but never stores source files, raw source identifiers, or pseudonymization keys. Row-level reads are limited to users already authorized for the associated billing period's microgrid. It gives authenticated users SELECT on the named base tables and keeps import writes restricted to the server role. The new ledger denies PUBLIC and anon; authenticated users receive SELECT, while service_role receives table-scoped SELECT, INSERT, and UPDATE. It does not change default privileges or install billing/payment mutation RPCs.

No data is included or imported by this script. Real pilot import remains pending source access, field mapping, and operator review.

## Local verification

Use a disposable local Supabase database initialized with the reviewed base files through 00015 and no billing periods. The preflight rejects missing or later inherited migrations and refuses to assign a default timezone to existing billing periods. Do not reset the repository's ordinary local project, which runs the full application migration chain. Apply this SQL script twice to check replay idempotency, then verify:

- pilot_import_batches has RLS enabled and one SELECT policy scoped through user_can_access_microgrid.
- anon and PUBLIC have no table privileges on pilot_import_batches; authenticated has SELECT only.
- authenticated can execute fn_finalize_user_invitation, while anon cannot; the function itself still checks the inviter's role and organization access.
- No batch can be marked applied with conflicts, mismatched counts, or more than 500 households or 5,000 readings.
- baselineImportedAt can be derived from the earliest applied_at where is_baseline is true for the requested billing period.

## Apply controls

Apply only to the new MGM pilot project after confirming the base schema is at 00015 and reviewing the grants and RLS. The script restricts inherited mutating/trigger functions from direct role invocation except fn_finalize_user_invitation, which is available only to signed-in inviters and performs its own authorization checks. It contains no real-data import. Do not run the standard migration chain against the pilot project.

For an existing pilot that already ran the earlier overlay, apply the versioned `20261005141300_restore_pilot_invitation_execute.sql` upgrade. The production MGM pilot received that upgrade on 2026-10-05. New pilots get the same grant from this curated overlay, so they do not need the upgrade solely for invitation access.
