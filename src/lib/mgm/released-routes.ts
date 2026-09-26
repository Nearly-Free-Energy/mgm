/**
 * The web and API routes shipped by released MGM slices. Keep this list
 * explicit: anything not listed here returns 404 from middleware, so an
 * inherited MBE surface cannot become callable through deep links or
 * direct API requests before its release.
 *
 * Release 1: organization, community, microgrid, and household management.
 * Release 2 (issue #4): OpenEMS connection setup, meter discovery and
 * registration, household meter detail, and the metering APIs. Billing,
 * payments, customerapp, and rate surfaces stay gated for Release 3.
 */
const RELEASE_1_PAGE_ROUTES = [
  /^\/$/,
  /^\/(?:login|accept-invite|forgot-password|reset-password|no-access|setup)$/,
  /^\/review$/,
  /^\/organizations(?:\/[^/]+)?$/,
  /^\/communities(?:\/[^/]+)?$/,
  /^\/microgrids(?:\/[^/]+)?$/,
  /^\/microgrids\/[^/]+\/setup\/households$/,
  /^\/settings\/(?:profile|plugins|users)$/,
];

const RELEASE_2_PAGE_ROUTES = [
  // Setup hub (redirects to the edges tab).
  /^\/microgrids\/[^/]+\/setup$/,
  // Connection setup: configure + test the OpenEMS backend.
  /^\/microgrids\/[^/]+\/setup\/openems-backend$/,
  // Discovery and explicit registration (edge detail + shared devices).
  /^\/microgrids\/[^/]+\/setup\/edges(?:\/[^/]+(?:\/shared)?)?$/,
  // Household meter detail: assignment history, gaps, opening register.
  /^\/microgrids\/[^/]+\/setup\/households\/[^/]+$/,
];

const RELEASE_1_API_ROUTES = [
  /^\/api\/mgm\/bootstrap$/,
  /^\/api\/mgm\/health$/,
  /^\/api\/organizations(?:\/[^/]+(?:\/(?:plugins|delete-preview))?)?$/,
  /^\/api\/communities(?:\/[^/]+(?:\/delete-preview)?)?$/,
  /^\/api\/microgrids(?:\/[^/]+(?:\/delete-preview)?)?$/,
  /^\/api\/households\/(?:with-meter|[^/]+)$/,
  /^\/api\/users(?:\/invite|\/[^/]+(?:\/(?:profile|role|resend-invite))?)?$/,
];

const RELEASE_2_API_ROUTES = [
  // Connection save + safe test-without-save + discovery.
  /^\/api\/microgrids\/[^/]+\/openems-backend(?:\/(?:discover|test))?$/,
  // Explicit edge registration.
  /^\/api\/microgrids\/[^/]+\/edges\/register$/,
  // Edge device discovery.
  /^\/api\/edges(?:\/[^/]+(?:\/discover-devices)?)?$/,
  // Device registration and reclassification.
  /^\/api\/devices(?:\/[^/]+)?$/,
  // Metering capability reads and writes.
  /^\/api\/metering\/readings$/,
  /^\/api\/households\/[^/]+\/assignments$/,
  /^\/api\/meter-readings\/opening$/,
];

export function isReleasedRoute(pathname: string): boolean {
  const path = pathname.replace(/\/$/, "") || "/";
  return [
    ...RELEASE_1_PAGE_ROUTES,
    ...RELEASE_2_PAGE_ROUTES,
    ...RELEASE_1_API_ROUTES,
    ...RELEASE_2_API_ROUTES,
  ].some((pattern) => pattern.test(path));
}
