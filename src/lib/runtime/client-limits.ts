/**
 * Rate limits on clients that are not a browser (RFC #259 § 2, decided on
 * #272): the CLI and the assistant bridge, counted per person and client.
 * A browser session is never counted here.
 *
 * - Every bearer request middleware accepts counts once
 *   (checkClientRequest, called by bearerRequest in src/middleware.ts after
 *   verifyBearer accepts the token).
 * - A view whose `cost` is "vendor" calls an outside system on every load,
 *   so a client's load of one counts again, against a lower limit
 *   (checkClientVendorRead, called by the GUI host's dispatchView and
 *   dispatchTenantView in src/lib/gui/host/server/view.ts, before the
 *   loader runs). dispatchView asks the plugin gate first, so a load the
 *   gate refuses is not counted; a tenant view's gate is asked inside its
 *   loader (composeTenantApp), so its loads count even when the tenant app
 *   is off. If either dispatcher moves the check, revisit this.
 *
 * Each limiter has its own store (createRateLimiter), not the shared
 * `checkRateLimit` one: its keys are a person's id and a client's id taken
 * from a token Supabase Auth has accepted, written only after that check.
 * If a key that needs no session is ever put in one, keys from many
 * addresses could evict a person's count.
 *
 * The counts are per process, like every limiter in
 * @/lib/rate-limit/in-memory: on Vercel each function instance counts on
 * its own, so a client whose requests land on several instances gets more.
 * They are a brake on a runaway or looping client, not a quota.
 */
import { createRateLimiter, type RateLimitResult } from "@/lib/rate-limit/in-memory";

/**
 * Requests per person and client per minute. Two a second, sustained: the
 * CLI sends a few requests per command (catalog, prepare, the write) and the
 * assistant a few view reads per step, so a person using either stays far
 * below it, while a client stuck in a loop is stopped within a minute.
 */
export const CLIENT_REQUESTS_PER_WINDOW = 120;
export const CLIENT_REQUEST_WINDOW_MS = 60_000;

/**
 * Loads of a vendor view per person and client per minute. The GUI host
 * refreshes a vendor view at most once a minute (MIN_REFRESH_SECONDS in
 * @/lib/gui/host/server/view), so a browser showing a page makes about one
 * a minute; twenty lets a client read several such views a few times a
 * minute without flooding the outside system behind them. If that minimum
 * changes, revisit this number.
 */
export const CLIENT_VENDOR_READS_PER_WINDOW = 20;
export const CLIENT_VENDOR_WINDOW_MS = 60_000;

const requests = createRateLimiter({ maxKeys: 10_000 });
const vendorReads = createRateLimiter({ maxKeys: 10_000 });

/** A client, as the limiters count it: the person and the OAuth client acting as them. */
export type CountedClient = { userId: string; clientId: string };

const keyOf = ({ userId, clientId }: CountedClient) => `${userId}:${clientId}`;

/** Counts one request by `client`; call only once Supabase Auth has accepted its token. */
export function checkClientRequest(client: CountedClient, nowMs?: number): RateLimitResult {
  return requests.check(keyOf(client), CLIENT_REQUESTS_PER_WINDOW, CLIENT_REQUEST_WINDOW_MS, nowMs);
}

/** Counts one load of a vendor view by `client`; call only for a caller that is not a browser. */
export function checkClientVendorRead(client: CountedClient, nowMs?: number): RateLimitResult {
  return vendorReads.check(keyOf(client), CLIENT_VENDOR_READS_PER_WINDOW, CLIENT_VENDOR_WINDOW_MS, nowMs);
}

/** Clears both limiters; for tests only. */
export function _resetClientLimitersForTests(): void {
  requests.reset();
  vendorReads.reset();
}
