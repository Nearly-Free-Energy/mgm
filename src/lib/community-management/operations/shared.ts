/**
 * shared.ts — pure helpers for community-management operations.
 *
 * Import boundary: this module (and every module under `operations/`) may
 * import only pure modules — sibling files, `../types`, validation helpers,
 * and domain types. It must NOT import database clients, auth helpers,
 * plugin state, or framework modules. See
 * `__tests__/import-boundary.test.ts`. All persistence flows through the
 * `CommunityManagementRepository` interface.
 */
import "server-only";

import {
  communityFailure,
  type CommunityManagementError,
  type CommunityManagementRepository,
  type OrganizationScope,
} from "../types";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function isMissingScope(
  scope: OrganizationScope | undefined,
  organizationId: string
): CommunityManagementError | null {
  if (!scope) {
    return communityFailure({
      status: 401,
      code: "community_unauthenticated",
      message: "Authentication required.",
    });
  }
  if (scope.organizationId !== organizationId) {
    return communityFailure({
      status: 403,
      code: "community_scope_mismatch",
      message: "Not authorized to act on this organization.",
      reason: "forbidden",
    });
  }
  return null;
}

export async function requireScopedAccess(
  repo: CommunityManagementRepository,
  scope: OrganizationScope | undefined,
  organizationId: string
): Promise<CommunityManagementError | null> {
  const scopeError = isMissingScope(scope, organizationId);
  if (scopeError) return scopeError;

  // Organization access was established when the Cordis composition was
  // created; RLS remains the final authority at write time. Re-check the
  // plugin gate here because an operator can flip it between composition
  // and the write.
  if (!(await repo.isPluginEnabled(organizationId))) {
    return communityFailure({
      status: 409,
      code: "community_management_disabled",
      message:
        "Community management is disabled for this organization. Enable it in Settings → Plugins; existing records are preserved.",
    });
  }
  return null;
}

export function accessDenied(message: string): CommunityManagementError {
  return communityFailure({
    status: 403,
    code: "community_forbidden",
    message,
    reason: "forbidden",
  });
}

export function mapRlsError(
  error: { code?: string; message?: string },
  message: string
): CommunityManagementError | null {
  if (error.code === "42501" || (error.message ?? "").includes("row-level security")) {
    return communityFailure({
      status: 403,
      code: "community_forbidden",
      message,
      reason: "forbidden",
    });
  }
  return null;
}
