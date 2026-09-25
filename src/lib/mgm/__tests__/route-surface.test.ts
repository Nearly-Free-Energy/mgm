import { describe, expect, it } from "vitest";
import { isMgmPilotRoute } from "../route-surface";

describe("MGM pilot route surface", () => {
  it("allows review and authentication reads", () => {
    expect(isMgmPilotRoute("/review", "GET")).toBe(true);
    expect(isMgmPilotRoute("/login", "GET")).toBe(true);
    expect(isMgmPilotRoute("/api/mgm/health", "GET")).toBe(true);
    expect(isMgmPilotRoute("/api/billing-review/preview", "POST")).toBe(true);
  });

  it("blocks inherited billing, payment, hardware, and API-token mutations", () => {
    for (const path of [
      "/api/billing/generate",
      "/api/v1/billing/generate",
      "/api/billing-line-items/id/pay",
      "/api/payments/ipn",
      "/api/edges/id",
      "/api/org-api-tokens",
    ]) {
      expect(isMgmPilotRoute(path, "POST")).toBe(false);
      expect(isMgmPilotRoute(path, "GET")).toBe(false);
    }
    expect(isMgmPilotRoute("/api/billing-review/preview", "GET")).toBe(false);
    expect(isMgmPilotRoute("/api/billing-review/preview", "DELETE")).toBe(false);
  });
});
