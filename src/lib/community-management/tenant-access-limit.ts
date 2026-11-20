/**
 * The per-manager limit on giving tenant access
 * (POST /api/tenants/[id]/access): at most TENANT_ACCESS_GRANTS_PER_WINDOW
 * grants per manager per window, in one process.
 *
 * The limiter is this module's own (createRateLimiter), not the shared
 * `checkRateLimit` store: its keys are signed-in managers' ids, written
 * only after composeCommunityManagement has authorized the request. If a
 * key that needs no session is ever put in it, keys from many addresses can
 * evict a manager's count, and it gives no more than the shared store does.
 */
import { createRateLimiter, type RateLimitResult } from "@/lib/rate-limit/in-memory";

export const TENANT_ACCESS_GRANTS_PER_WINDOW = 30;
export const TENANT_ACCESS_WINDOW_MS = 10 * 60_000;

const limiter = createRateLimiter({ maxKeys: 10_000 });

/** Counts one grant by `actorId`; call only after the composer has authorized them. */
export function checkTenantAccessGrant(actorId: string, nowMs?: number): RateLimitResult {
  return limiter.check(
    `tenant-access:${actorId}`,
    TENANT_ACCESS_GRANTS_PER_WINDOW,
    TENANT_ACCESS_WINDOW_MS,
    nowMs
  );
}

/** Clears this module's limiter; for tests only. */
export function _resetTenantAccessLimiterForTests(): void {
  limiter.reset();
}
