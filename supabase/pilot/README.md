# MGM review/import schema

20260924_mgm_review_import_essentials.sql is a targeted, standalone SQL migration for a new Supabase project after the base migrations 00001 through 00015.

It is outside supabase/migrations on purpose. The pilot uses a curated schema and permissions subset; the inherited migration chain has not been approved as a whole for this deployment. Do not use the standard migration runner for this pilot setup until that chain has been reviewed.

The script adds the columns needed by the billing review path, the effective dates used by review calculations, and a metadata-only pilot_import_batches ledger. It limits a batch to 500 households and 5,000 readings. The ledger records the baseline timestamp and reconciliation counts but never stores source files, raw source identifiers, or pseudonymization keys. Row-level reads are limited to users already authorized for the associated billing period's microgrid. It gives authenticated users SELECT on the named base tables and keeps import writes restricted to the server role. The new ledger denies PUBLIC and anon; authenticated users receive SELECT, while service_role receives table-scoped SELECT, INSERT, and UPDATE. It does not change default privileges or install billing/payment mutation RPCs.

No data is included or imported by this script. Real pilot import remains pending source access, field mapping, and operator review.

## Local verification

Use a disposable local Supabase database initialized with only 00001 through 00015. Do not reset the repository's ordinary local project, which runs the full inherited migration chain. Apply this SQL script twice to check replay idempotency, then verify:

- pilot_import_batches has RLS enabled and one SELECT policy scoped through user_can_access_microgrid.
- anon and PUBLIC have no table privileges on pilot_import_batches; authenticated has SELECT only.
- No batch can be marked applied with conflicts, mismatched counts, or more than 500 households or 5,000 readings.
- baselineImportedAt can be derived from the earliest applied_at where is_baseline is true for the requested billing period.

## Apply controls

Apply only to the new MGM pilot project after verifying its base schema is at 00015 and reviewing the grants and RLS. This script contains no real-data import. Do not run the standard migration chain against the pilot project until the legacy migration history is cleaned up.
