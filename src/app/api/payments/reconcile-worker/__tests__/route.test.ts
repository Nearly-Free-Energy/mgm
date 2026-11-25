import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ service: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.service }));
vi.mock("@/lib/payments/compose", () => ({ composePaymentsPublic: vi.fn() }));
import { POST } from "../route";
beforeEach(() => { vi.clearAllMocks(); mocks.rpc.mockResolvedValue({ data: [], error: null }); mocks.service.mockReturnValue({ rpc: mocks.rpc, from: () => { const query = { select: () => query, in: () => query, not: () => query, limit: async () => ({ data: [] }) }; return query; } }); });
afterEach(() => vi.unstubAllEnvs());
it("fails closed when the worker secret is missing", async () => { vi.stubEnv("PAYMENTS_WORKER_SECRET", ""); expect((await POST(new NextRequest("https://mgm.test/api/payments/reconcile-worker", { method: "POST" }))).status).toBe(503); expect(mocks.service).not.toHaveBeenCalled(); });
it("rejects an incorrect header even for session callers", async () => { vi.stubEnv("PAYMENTS_WORKER_SECRET", "test-worker-secret"); expect((await POST(new NextRequest("https://mgm.test/api/payments/reconcile-worker", { method: "POST", headers: { "x-payments-worker-secret": "wrong" } }))).status).toBe(403); expect(mocks.service).not.toHaveBeenCalled(); });
it("does not accept a secret exposed in the query string", async () => { vi.stubEnv("PAYMENTS_WORKER_SECRET", "test-worker-secret"); expect((await POST(new NextRequest("https://mgm.test/api/payments/reconcile-worker?secret=test-worker-secret", { method: "POST" }))).status).toBe(403); });
it("leases notifications only after header authentication", async () => { vi.stubEnv("PAYMENTS_WORKER_SECRET", "test-worker-secret"); expect((await POST(new NextRequest("https://mgm.test/api/payments/reconcile-worker", { method: "POST", headers: { "x-payments-worker-secret": "test-worker-secret" } }))).status).toBe(200); expect(mocks.rpc).toHaveBeenCalledWith("fn_payment_due_notifications", { _limit: 50 }); });
it("refuses a header longer or shorter than the configured secret", async () => {
  vi.stubEnv("PAYMENTS_WORKER_SECRET", "test-worker-secret");
  for (const header of ["test-worker-secret-and-more", "test-worker-secre", "t"]) {
    expect((await POST(new NextRequest("https://mgm.test/api/payments/reconcile-worker", { method: "POST", headers: { "x-payments-worker-secret": header } }))).status).toBe(403);
  }
  expect(mocks.service).not.toHaveBeenCalled();
});
it("refuses a header of the same length that differs from the configured secret", async () => {
  vi.stubEnv("PAYMENTS_WORKER_SECRET", "test-worker-secret");
  expect((await POST(new NextRequest("https://mgm.test/api/payments/reconcile-worker", { method: "POST", headers: { "x-payments-worker-secret": "test-worker-secreT" } }))).status).toBe(403);
  expect(mocks.service).not.toHaveBeenCalled();
});
it("refuses a request with no header", async () => {
  vi.stubEnv("PAYMENTS_WORKER_SECRET", "test-worker-secret");
  expect((await POST(new NextRequest("https://mgm.test/api/payments/reconcile-worker", { method: "POST" }))).status).toBe(403);
  expect(mocks.service).not.toHaveBeenCalled();
});
it("accepts the configured secret with surrounding whitespace trimmed from the setting", async () => {
  vi.stubEnv("PAYMENTS_WORKER_SECRET", "  test-worker-secret\n");
  expect((await POST(new NextRequest("https://mgm.test/api/payments/reconcile-worker", { method: "POST", headers: { "x-payments-worker-secret": "test-worker-secret" } }))).status).toBe(200);
  expect(mocks.rpc).toHaveBeenCalledWith("fn_payment_due_notifications", { _limit: 50 });
});
