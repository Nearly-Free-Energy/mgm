# Synthetic pilot import foundation

This foundation supports review and bounded import metadata in a fresh MGM database. It does not connect to a source system or retain source files or raw source identifiers. There is no browser route for importing data. The standalone SQL is in supabase/pilot/20260924_mgm_review_import_essentials.sql and requires the reviewed base migration files through 00015. Use this curated setup script for the pilot database.

## Accepted input

`src/lib/pilot-import/prepare.ts` accepts object rows with exactly these fields:

| Field | Meaning |
| --- | --- |
| `source_household_id` | Synthetic stable household reference |
| `source_meter_id` | Synthetic stable meter reference |
| `reading_kwh` | Non-negative cumulative meter value |
| `read_at` | ISO timestamp including a timezone |

Unexpected columns fail the whole preparation step. In particular, names, phone numbers, email addresses, and addresses are not accepted. Household and meter references are converted to stable HMAC pseudonyms with a server-held key of at least 32 bytes. Keep that key outside the repository and never expose it through a `NEXT_PUBLIC_` variable. The returned records contain no source IDs.

One preparation run is capped at 5,000 readings and 500 distinct households. The result is in memory only. `reconcilePilotRows` produces inserts, unchanged counts, and conflicts; conflicting values for the same meter and timestamp are never overwritten.

## Target and operator controls

Before any write-capable caller is added, it must call `assertPilotImportTarget`. The accepted target is exactly `synthetic-pilot`; the target microgrid UUID must match a separately configured pilot UUID; a write requires explicit operator confirmation and a localhost PostgreSQL URL. Dry runs do not write. Do not relax this guard for a hosted environment as part of the synthetic rehearsal.

The import must be started explicitly by an operator after reviewing the reconciliation preview. It must have an operator-provided batch identifier and bounded row count. No schedule, webhook, or billing-period close action may invoke it. Billing periods remain manually closed by the entrepreneur.

## Atomic write protocol for a future persistence adapter

The persistence adapter must apply one prepared batch in one Postgres transaction: lock the dedicated pilot microgrid row; verify the exact configured target and batch identifier; resolve only pseudonymized household and meter keys; apply effective-dated meter assignments; compare existing values and abort on any conflict; record only batch ID, counts, and outcome in `pilot_import_batches`; then commit. On any validation, constraint, or reconciliation error, roll back the entire batch. Never log the payload, pseudonym key, or raw source rows. The review API derives `baselineImportedAt` from the earliest `applied_at` for an applied baseline batch belonging to the requested billing period.

The current module intentionally ends at preparation and reconciliation. A persistence adapter requires a confirmed target schema and operator workflow. It must remain server-side and use a transaction-capable database path; multiple independent PostgREST writes are not an atomic import. The batch ledger stores counts and timestamps only, with RLS-scoped reads for authorized organization users; client roles cannot alter it. The setup script checks the reviewed base migration identities, rejects later inherited migrations, and refuses to apply the UTC default where billing periods already exist.

## Meter assignment dates

`household_devices.effective_from` is inclusive and `effective_to` is exclusive; `NULL` means current. Existing assignments are backfilled from their creation date. The pilot review schema records the effective period for assignments represented in the database; confirm the source assignment history and mapping with the operator before preparing a real import.

## Synthetic rehearsal

Use only invented identifiers and readings. First call `preparePilotRows`, then inspect `reconcilePilotRows`; a caller should stop if `conflicts` is non-empty. The current code does not write imported data. Any future rehearsal must use a dedicated local database and an affirmative operator action. Never point it at customer, staging, or production data.

## Real pilot import (pending access)

No real source data has been requested or copied. The intended source is OpenEMS. A future real pilot import remains pending until the operator grants source access and confirms the OpenEMS-to-MGM field mapping, data minimization basis, pilot organization and microgrid, effective dates for meter replacements, and baseline period. The operator must review a dry-run reconciliation and resolve conflicts before a separately approved import. Keep all source access and import execution server-side; never commit source extracts or credentials.
