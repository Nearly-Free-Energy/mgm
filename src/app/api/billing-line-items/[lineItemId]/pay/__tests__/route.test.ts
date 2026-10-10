import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ compose: vi.fn(), resolve: vi.fn(), checkout: vi.fn(), dispose: vi.fn(), legacy: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({}) }));
vi.mock("@/lib/payments/compose", () => ({ composePaymentsPublic: mocks.compose }));
vi.mock("@/lib/payments/resolve-org", () => ({ resolveOrgForLineItem: mocks.resolve }));
vi.mock("@/lib/payments/ensure-payment-link", () => ({ ensurePaymentLinkForLineItem: mocks.legacy }));
vi.mock("@/lib/rate-limit/in-memory", () => ({ checkRateLimit: () => ({ ok: true }) }));
import { GET } from "../route";
const id = "33333333-3333-3333-3333-333333333333";
const invoke = (lineItemId = id) => GET(new NextRequest(`https://mgm.test/api/billing-line-items/${lineItemId}/pay`), { params: Promise.resolve({ lineItemId }) });
beforeEach(() => { vi.clearAllMocks(); mocks.resolve.mockResolvedValue({ orgId: "org" }); mocks.dispose.mockResolvedValue(undefined); mocks.compose.mockResolvedValue({ ok: true, data: { payments: { ensureCheckout: mocks.checkout }, dispose: mocks.dispose } }); });
describe("public MGM checkout", () => {
 it("redirects an authorized capability checkout", async () => { mocks.checkout.mockResolvedValue({ ok: true, data: { redirectUrl: "https://pay.example/checkout" } }); const response = await invoke(); expect(response.status).toBe(302); expect(response.headers.get("location")).toBe("https://pay.example/checkout"); expect(mocks.dispose).toHaveBeenCalledOnce(); });
 it.each(["payments_disabled", "payments_needs_reconciliation", "payments_confirmation_pending", "payments_override_broken"])("does not bypass %s through legacy code", async code => { mocks.checkout.mockResolvedValue({ ok: false, status: 409, code }); expect((await invoke()).status).toBe(409); expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.dispose).toHaveBeenCalledOnce(); });
 it("does not bypass a thrown infrastructure failure", async () => { mocks.checkout.mockRejectedValue(new Error("database unavailable")); expect((await invoke()).status).toBe(502); expect(mocks.legacy).not.toHaveBeenCalled(); });
 it("returns 404 for a missing bill", async () => { mocks.resolve.mockResolvedValue(null); expect((await invoke()).status).toBe(404); expect(mocks.checkout).not.toHaveBeenCalled(); });
 it("rejects malformed ids", async () => { expect((await invoke("invalid")).status).toBe(400); expect(mocks.resolve).not.toHaveBeenCalled(); });
});
