/**
 * Allowlist tests for the MGM release gate (issue #4 review).
 *
 * `isReleasedRoute` is the middleware's explicit allowlist: every released
 * page and API must match, and every inherited-but-unreleased surface must
 * not. When Release 3 ships billing, its routes get their own section here
 * — and their tests.
 */
import { describe, expect, it } from "vitest";
import { isReleasedRoute } from "../released-routes";

describe("isReleasedRoute", () => {
  it.each([
    // Release 1 survivors.
    "/",
    "/login",
    "/setup",
    "/review",
    "/organizations",
    "/organizations/abc",
    "/communities",
    "/microgrids",
    "/microgrids/abc",
    "/microgrids/abc/setup/households",
    "/settings/plugins",
    "/api/mgm/bootstrap",
    "/api/communities",
    "/api/microgrids/abc",
    "/api/households/with-meter",
    "/api/households/abc",
    // Release 2 pages.
    "/microgrids/abc/setup",
    "/microgrids/abc/setup/openems-backend",
    "/microgrids/abc/setup/edges",
    "/microgrids/abc/setup/edges/edge-1",
    "/microgrids/abc/setup/edges/shared",
    "/microgrids/abc/setup/households/hh-1",
    // Release 2 APIs.
    "/api/microgrids/abc/openems-backend",
    "/api/microgrids/abc/openems-backend/discover",
    "/api/microgrids/abc/openems-backend/test",
    "/api/microgrids/abc/edges/register",
    "/api/edges",
    "/api/edges/edge-1",
    "/api/edges/edge-1/discover-devices",
    "/api/devices",
    "/api/devices/dev-1",
    "/api/metering/readings",
    "/api/households/hh-1/assignments",
    "/api/meter-readings/opening",
    // Release 3 pages.
    "/microgrids/abc/billing",
    "/microgrids/abc/billing/period-1",
    "/microgrids/abc/billing/period-1/history",
    "/microgrids/abc/setup/rates",
    "/communities/abc/invoice",
    // Release 3 APIs.
    "/api/rate-schedules",
    "/api/rate-schedules/rs-1",
    "/api/billing/generate",
    "/api/billing/regenerate-preview",
    "/api/billing-review/preview",
    "/api/billing-periods",
    "/api/billing-periods/abc",
    "/api/billing-periods/abc/close",
    "/api/billing-periods/abc/audit-log",
    "/api/billing-periods/abc/export-csv",
    "/api/billing-line-items/abc",
    "/api/billing-line-items/abc/payment-status",
    "/api/billing-line-items/abc/pdf",
    "/api/billing-line-items/abc/usage",
    "/api/communities/abc/invoice-config",
    "/api/communities/abc/invoice-preview",
    "/api/communities/abc/invoice-logo",
  ])("allows released route %s", (path) => {
    expect(isReleasedRoute(path)).toBe(true);
  });

  it.each([
    // Online gateways, payment links, portals, and notifications stay gated.
    "/api/billing-line-items/abc/pay",
    "/api/billing-line-items/abc/url",
    "/api/payments/ipn",
    "/api/v1/microgrids",
    "/p/abc123",
    "/communities/abc/payment",
    "/microgrids/abc/setup/edges/edge-1/devices/extra",
    "/api/microgrids/abc/openems-backend/unknown",
    "/api/metering",
    "/api/meter-readings",
    "/settings",
    "/admin",
  ])("blocks unreleased route %s", (path) => {
    expect(isReleasedRoute(path)).toBe(false);
  });

  it("tolerates a trailing slash", () => {
    expect(isReleasedRoute("/microgrids/abc/setup/edges/")).toBe(true);
    expect(isReleasedRoute("/api/metering/readings/")).toBe(true);
  });
});
