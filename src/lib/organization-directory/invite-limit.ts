/**
 * The per-person limit on invitations: at most INVITATIONS_PER_WINDOW
 * invitation attempts per inviter per window, in one process, whatever the
 * caller (a browser session, the CLI or an assistant), since an invitation
 * emails someone (decided on #272). POST /api/users/invite and
 * POST /api/users/[id]/resend-invite share the count, since a resend
 * emails the invitation too. Each counts every attempt it has authorized,
 * before it looks the address or the account up, so one that ends in 409
 * or an error counts too and no lookup result shows through the 429. The
 * resend route keeps its own per-invitee limit as well. If either route
 * stops calling checkInvitation, or another route that emails an
 * invitation is added, revisit this comment.
 *
 * Twenty an hour is far more than a person setting up an organization's
 * managers sends, and stops a stuck script from mailing a list.
 *
 * The limiter is this module's own (createRateLimiter), not the shared
 * `checkRateLimit` store: its keys are signed-in inviters' ids, written
 * only after a route has checked the session with getUser() and the
 * inviter's authority. If a key that needs no session is ever put in it,
 * keys from many addresses can evict an inviter's count. Per process, like
 * every limiter in @/lib/rate-limit/in-memory.
 */
import { createRateLimiter, type RateLimitResult } from "@/lib/rate-limit/in-memory";

export const INVITATIONS_PER_WINDOW = 20;
export const INVITATION_WINDOW_MS = 60 * 60_000;

const limiter = createRateLimiter({ maxKeys: 10_000 });

/** Counts one invitation by `inviterId`; call only after the route has authorized them. */
export function checkInvitation(inviterId: string, nowMs?: number): RateLimitResult {
  return limiter.check(`invite:${inviterId}`, INVITATIONS_PER_WINDOW, INVITATION_WINDOW_MS, nowMs);
}

/** Clears this module's limiter; for tests only. */
export function _resetInvitationLimiterForTests(): void {
  limiter.reset();
}
