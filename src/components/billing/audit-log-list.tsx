"use client";

// AuditLogList — renders the BC4 per-period audit history (#176).
//
// Receives precomputed entries + an optional `lineItemIdToTenantId` map
// + an optional `filterTenantId`. When the filter id is set and resolves
// to a known tenant, the list filters client-side by ownership of the
// entry's billingLineItemId. The page server-component does the tenant
// lookup once and passes a string→string map so the client doesn't need
// to round-trip Supabase.
//
// Empty-state branches (per ticket AC6):
//   - 0 entries for the period (no filter)        → "No changes recorded yet"
//   - 0 entries after tenant filter applied    → "No changes recorded for {hh}" + "Show all"
//   - filter id matched no tenant in this MG   → banner "unknown tenant" + same filter path
// In all empty-state branches the `<ol>` is OMITTED — we never emit an empty list.
//
// Truncation notice: when `entries.length >= 1000` (BC1's 500/side worst
// case), render "History may be truncated — showing the most recent 1000
// events" above the list. Real pagination is deferred (see ticket Out of
// Scope).

import * as React from "react";
import Link from "next/link";
import type { BillingAuditLogEntry } from "@/lib/types/billing-audit";
import { LocalDateTime } from "@/components/format/local-date-time";
import { EmptyState } from "@/components/ui/empty-state";
import { Banner } from "@/components/ui/banner";
import {
  actorDisplayLabel,
  humanizeAuditEvent,
  PostCloseRevisionChip,
} from "@/lib/billing/audit-humanize";

const TRUNCATION_THRESHOLD = 1000;

export interface AuditLogListProps {
  entries: BillingAuditLogEntry[];
  /** lineItemId → tenantId map (server-resolved from billing_line_items). */
  lineItemIdToTenantId: Record<string, string>;
  /** tenantId → display_name map (for the "filtered to {name}" banner). */
  tenantNamesById: Record<string, string>;
  /** When set, only entries whose billingLineItemId belongs to this
   *  tenant render. The history page reads this from
   *  `searchParams.tenant_id`. */
  filterTenantId?: string;
  /** For the "Show all" link's href. */
  microgridId: string;
  periodId: string;
}

export function AuditLogList({
  entries,
  lineItemIdToTenantId,
  tenantNamesById,
  filterTenantId,
  microgridId,
  periodId,
}: AuditLogListProps) {
  const showAllHref = `/microgrids/${microgridId}/billing/${periodId}/history`;

  // ── Filter (client-side) ───────────────────────────────────────────────
  const filtered = React.useMemo(() => {
    if (!filterTenantId) return entries;
    return entries.filter((e) => {
      if (!e.billingLineItemId) return false;
      const owner = lineItemIdToTenantId[e.billingLineItemId];
      return owner === filterTenantId;
    });
  }, [entries, filterTenantId, lineItemIdToTenantId]);

  const filteredTenantName = filterTenantId
    ? tenantNamesById[filterTenantId] ?? null
    : null;

  // ── Filter banner ──────────────────────────────────────────────────────
  const filterBanner = filterTenantId ? (
    <Banner
      tone="info"
      title={
        <>
          Showing changes for{" "}
          <strong>{filteredTenantName ?? "unknown tenant"}</strong>
        </>
      }
    >
      <Link
        href={showAllHref}
        className="underline underline-offset-2 hover:opacity-80"
      >
        Show all
      </Link>
    </Banner>
  ) : null;

  // ── Empty-state branches ───────────────────────────────────────────────
  if (filtered.length === 0) {
    if (filterTenantId) {
      // Filter narrowed to zero. We render a per-filter empty state with
      // a "Show all" secondary so the user has an escape hatch back to
      // the unfiltered list.
      const hhLabel = filteredTenantName ?? "unknown tenant";
      return (
        <div className="space-y-4">
          {filterBanner}
          <EmptyState
            eyebrow="Audit history"
            title={`No changes recorded for ${hhLabel}`}
            body="Other tenants on this period may have entries."
            secondary={
              <Link
                href={showAllHref}
                className="text-sm text-primary underline underline-offset-2 hover:opacity-80"
              >
                Show all
              </Link>
            }
          />
        </div>
      );
    }
    // No filter — period has zero events.
    return (
      <EmptyState
        eyebrow="Audit history"
        title="No changes recorded yet"
        body="This period has no events. As you generate bills, close the period, or take payments, entries will appear here."
      />
    );
  }

  // ── Truncation notice ──────────────────────────────────────────────────
  // BC1 caps at 500 per side; if we hit ~1000 the page may be incomplete.
  // The notice is informational; pagination is deferred per ticket OOS.
  const truncated = entries.length >= TRUNCATION_THRESHOLD;

  return (
    <div className="space-y-4">
      {filterBanner}
      {truncated && (
        <Banner tone="warn" title="History may be truncated">
          Showing the most recent 1000 events.
        </Banner>
      )}
      <ol
        aria-label="Audit history"
        className="space-y-3 [counter-reset:audit-list]"
      >
        {filtered.map((entry) => (
          <AuditLogEntryRow key={entry.id} entry={entry} />
        ))}
      </ol>
    </div>
  );
}

// ── Per-entry row ─────────────────────────────────────────────────────────

function AuditLogEntryRow({ entry }: { entry: BillingAuditLogEntry }) {
  const { label, summary, manualReason, postCloseRevision } =
    humanizeAuditEvent(entry);
  const actor = actorDisplayLabel(entry);

  return (
    <li className="rounded-md border border-border bg-card p-3 shadow-elev-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <LocalDateTime
          value={entry.createdAt}
          className="text-xs text-muted-foreground"
        />
        <span className="text-xs text-muted-foreground">·</span>
        <span className="text-xs text-muted-foreground">{actor}</span>
        <span className="text-xs text-muted-foreground">·</span>
        <span className="font-medium text-foreground">{label}</span>
        {postCloseRevision && (
          <span className="ml-1 inline-flex">
            <PostCloseRevisionChip />
          </span>
        )}
      </div>
      {summary && (
        <div className="mt-1 text-sm text-foreground">{summary}</div>
      )}
      {manualReason && (
        <div className="mt-1 text-xs italic text-muted-foreground">
          {manualReason}
        </div>
      )}
    </li>
  );
}
