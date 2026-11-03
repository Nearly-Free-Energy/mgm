import "server-only";

/**
 * Shared helpers for the entity-deletion route handlers (#89).
 *
 * Owned here so the four DELETE/preview route handlers share identical
 * logging, error-mapping, and parent-resolution logic. If you add a new
 * entity-deletion surface, reuse these helpers rather than re-implementing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DescendantCounts, EntityKind } from "@/lib/entity-descendants";
import { SUPER_ADMIN } from "@/lib/roles";
import { getCurrentUserRoles } from "@/lib/auth/access";
import { isPeriodKeptError } from "@/lib/billing/period-delete";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Parent =
  | { kind: "organization"; id: string }
  | { kind: "community"; id: string }
  | { kind: "microgrid"; id: string }
  | null;

/**
 * Resolve the parent entity for an entity about to be deleted. Used to
 * populate the `parent` field in the delete-preview response so the
 * client can redirect post-DELETE without a second round-trip (AC-UI-3
 * step 5 / AC-ROUTE-3).
 */
export async function resolveParent(
  supabase: SupabaseClient,
  kind: EntityKind,
  id: string
): Promise<Parent> {
  switch (kind) {
    case "organization":
      return null;
    case "community": {
      const { data } = await supabase
        .from("communities")
        .select("org_id")
        .eq("id", id)
        .maybeSingle<{ org_id: string }>();
      if (!data) return null;
      return { kind: "organization", id: data.org_id };
    }
    case "microgrid": {
      const { data } = await supabase
        .from("microgrids")
        .select("community_id")
        .eq("id", id)
        .maybeSingle<{ community_id: string }>();
      if (!data) return null;
      return { kind: "community", id: data.community_id };
    }
    case "edge": {
      const { data } = await supabase
        .from("edges")
        .select("microgrid_id")
        .eq("id", id)
        .maybeSingle<{ microgrid_id: string }>();
      if (!data) return null;
      return { kind: "microgrid", id: data.microgrid_id };
    }
  }
}

/**
 * The structured log payload emitted on successful DELETE per AC-LOG-1.
 * Serialized via `console.info(JSON.stringify(payload))` so Vercel's log
 * drain picks it up as a single line. Do NOT leak this shape into HTTP
 * responses; it's for logs + tests only.
 */
export interface EntityDeleteLogPayload {
  event: "entity.delete";
  entity_kind: EntityKind;
  entity_id: string;
  entity_name: string;
  actor_user_id: string;
  actor_role: "super_admin" | "org_manager";
  descendant_counts: DescendantCounts;
  at: string;
}

/**
 * Returns the highest-privilege role the actor holds. `super_admin` wins
 * over `org_manager` per AC-LOG-1. Returns `null` only for unauthenticated
 * callers (in which case the route should already have 401/403'd).
 */
export async function resolveActorRole(
  supabase: SupabaseClient
): Promise<"super_admin" | "org_manager" | null> {
  const roles = await getCurrentUserRoles(supabase);
  if (roles.length === 0) return null;
  if (roles.some((r) => r.role === SUPER_ADMIN)) return "super_admin";
  return "org_manager";
}

/**
 * Mirrors the `{ error: string }` shape used by #79's user-delete route
 * and the rest of the MGM API surface. Keep the key shape identical
 * across all #89 routes so a future shared error-helper stays uniform.
 */
export function errorBody(message: string): { error: string } {
  return { error: message };
}

function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/**
 * Billing the database keeps, which makes it refuse the delete: closed
 * periods, and draft periods with payment activity (migration
 * 20261103160000). `null` for an edge, whose delete never removes billing
 * periods, and when there is none.
 */
export function keptBillingCounts(
  counts: DescendantCounts
): { closed: number; withPayments: number } | null {
  if (counts.kind === "edge") return null;
  const kept = {
    closed: counts.billing_periods_closed,
    withPayments: counts.billing_periods_with_payments,
  };
  return kept.closed > 0 || kept.withPayments > 0 ? kept : null;
}

/** Why the delete-preview route will not open the delete dialog. */
export function keptBillingMessage(
  entityLabel: string,
  kept: { closed: number; withPayments: number }
): string {
  const held = [
    kept.closed > 0
      ? plural(kept.closed, "closed billing period", "closed billing periods")
      : null,
    kept.withPayments > 0
      ? `${plural(kept.withPayments, "billing period", "billing periods")} with recorded payments`
      : null,
  ].filter(Boolean);
  return (
    `This ${entityLabel} has ${held.join(" and ")}. Closed billing and billing ` +
    `with recorded payments are kept, so this ${entityLabel} cannot be deleted.`
  );
}

/**
 * The message for the database's own refusal (`billing_period_kept`, DETAIL
 * `closed` or `payment_activity`), which the DELETE route gets when billing
 * appeared after the preview, or when the caller's RLS hid it from the
 * preview's counts.
 */
function keptBillingRefusalMessage(entityLabel: string, details?: string | null): string {
  if (details === "closed") {
    return `This ${entityLabel} has closed billing periods, which are kept as the billing record, so it cannot be deleted.`;
  }
  if (details === "payment_activity") {
    return `This ${entityLabel} has billing with recorded payments, which is kept with its payment records, so it cannot be deleted.`;
  }
  return `This ${entityLabel} holds billing that is kept as the billing record, so it cannot be deleted.`;
}

/**
 * Map a Postgres error surfaced by supabase-js into an HTTP status code
 * and human-readable message. Used by the DELETE routes for their
 * terminal Postgres error branch (AC-ROUTE-2 step 6).
 *
 * Safe-by-default: unknown errors map to 500 with a generic message —
 * we do NOT leak raw SQLSTATEs or stack traces to the client.
 */
export function mapPgError(
  err: { code?: string; message?: string; details?: string | null },
  entityLabel: string
): { status: number; message: string } {
  const code = err.code;
  const msg = err.message ?? "";

  // The billing retention guards (migration 20261103160000) refuse deleting
  // an organization, community or microgrid that holds closed billing or
  // billing with recorded payments.
  if (isPeriodKeptError(err)) {
    return { status: 409, message: keptBillingRefusalMessage(entityLabel, err.details) };
  }

  if (code === "42501" || msg.includes("row-level security")) {
    return {
      status: 403,
      message: `You do not have permission to delete this ${entityLabel}.`,
    };
  }
  // 40000 is reserved for the last-super_admin guard — in the #89 flow
  // this only fires via the user_roles BEFORE DELETE trigger that we
  // bypass with the cascade GUC. Preserve the mapping for defensive
  // coverage in case the bypass is ever disabled.
  if (code === "40000") {
    return { status: 409, message: msg || "Conflict." };
  }
  // Filter obviously-SQL-internal shapes from the payload.
  if (msg && !/ERROR|SQLSTATE|syntax|relation/i.test(msg)) {
    return { status: 500, message: msg };
  }
  return { status: 500, message: "Unexpected database error." };
}
