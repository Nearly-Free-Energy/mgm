import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ compose: vi.fn(), resolve: vi.fn(), stable: vi.fn(), checkout: vi.fn(), dispose: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/payments/compose", () => ({ composePayments: mocks.compose }));
vi.mock("@/lib/payments/resolve-org", () => ({ resolveOrgForLineItem: mocks.resolve }));
import { POST } from "../route";
const id = "33333333-3333-3333-3333-333333333333";
const invoke = () => POST(new NextRequest(`https://mgm.test/api/billing-line-items/${id}/url`, { method: "POST", body: JSON.stringify({ force: true }) }), { params: Promise.resolve({ lineItemId: id }) });
beforeEach(() => { vi.clearAllMocks(); mocks.resolve.mockResolvedValue({ orgId: "org" }); mocks.dispose.mockResolvedValue(undefined); mocks.compose.mockResolvedValue({ ok: true, data: { payments: { stablePaymentLink: mocks.stable, ensureCheckout: mocks.checkout }, dispose: mocks.dispose } }); mocks.stable.mockResolvedValue({ ok: true, data: { url: `https://mgm.test/api/billing-line-items/${id}/pay` } }); });
describe("sharing stable payment links", () => {
 it("returns the stable link without submitting a payment even with force", async () => { const response = await invoke(); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ redirectUrl: expect.stringContaining("/pay"), orderTrackingId: null }); expect(mocks.checkout).not.toHaveBeenCalled(); expect(mocks.dispose).toHaveBeenCalledOnce(); });
 it("denies hidden bills", async () => { mocks.resolve.mockResolvedValue(null); expect((await invoke()).status).toBe(404); expect(mocks.compose).not.toHaveBeenCalled(); });
 it("propagates composition authorization denial", async () => { mocks.compose.mockResolvedValue({ ok: false, status: 403, message: "Denied", code: "forbidden" }); expect((await invoke()).status).toBe(403); expect(mocks.stable).not.toHaveBeenCalled(); });
});
