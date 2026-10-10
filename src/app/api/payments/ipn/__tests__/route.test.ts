import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), upsert: vi.fn(), handle: vi.fn(), compose: vi.fn(), dispose: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.lookup }) }), upsert: mocks.upsert }) }) }));
vi.mock("@/lib/payments/compose", () => ({ composePaymentsPublic: mocks.compose }));
import { GET, POST } from "../route";
beforeEach(() => { vi.clearAllMocks(); mocks.lookup.mockResolvedValue({ data: { org_id: "org" }, error: null }); mocks.upsert.mockResolvedValue({ error: null }); mocks.dispose.mockResolvedValue(undefined); mocks.compose.mockResolvedValue({ ok: true, data: { payments: { handleNotification: mocks.handle }, dispose: mocks.dispose } }); mocks.handle.mockResolvedValue({ ok: true, data: { processed: true } }); });
const raw = { OrderTrackingId: "TRACK-1", OrderMerchantReference: "MGM-test" };
describe("Pesapal acknowledgement", () => {
 it("returns the documented acknowledgement after durable verification", async () => { const response = await POST(new NextRequest("https://mgm.test/api/payments/ipn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(raw) })); expect(response.status).toBe(200); expect(await response.json()).toEqual({ orderNotificationType: "IPNCHANGE", orderTrackingId: "TRACK-1", orderMerchantReference: "MGM-test", status: 200 }); expect(mocks.handle).toHaveBeenCalledWith(raw); expect(mocks.dispose).toHaveBeenCalledOnce(); });
 it("accepts form-encoded notifications", async () => { const response = await POST(new NextRequest("https://mgm.test/api/payments/ipn", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(raw).toString() })); expect(response.status).toBe(200); expect(mocks.handle).toHaveBeenCalledWith(raw); });
 it("returns failure without any legacy settlement on verification failure", async () => { mocks.handle.mockResolvedValue({ ok: true, data: { processed: false } }); const response = await GET(new NextRequest(`https://mgm.test/api/payments/ipn?${new URLSearchParams(raw)}`)); expect(response.status).toBe(500); expect((await response.json()).status).toBe(500); });
 it("retains unknown references for investigation", async () => { mocks.lookup.mockResolvedValue({ data: null, error: null }); expect((await GET(new NextRequest(`https://mgm.test/api/payments/ipn?${new URLSearchParams(raw)}`))).status).toBe(500); expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ org_id: null, tracking_id: "TRACK-1" }), expect.any(Object)); });
 it("rejects missing identity without writing evidence", async () => { expect((await GET(new NextRequest("https://mgm.test/api/payments/ipn"))).status).toBe(500); expect(mocks.handle).not.toHaveBeenCalled(); expect(mocks.lookup).not.toHaveBeenCalled(); });
});
