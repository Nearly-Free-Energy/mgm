import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ access: vi.fn(), existing: vi.fn(), test: vi.fn(), rpc: vi.fn(), service: vi.fn() }));
vi.mock("@/lib/auth/access", () => ({ currentUserCanAccessOrg: mocks.access }));
vi.mock("@/lib/payments/infrastructure/merchant-configuration", () => ({ testMerchantConfiguration: mocks.test }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: () => { const query = { select: () => query, eq: () => query, maybeSingle: mocks.existing }; return query; }, rpc: async () => ({ data: "encrypted-test-secret", error: null }) }) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.service }));
import { POST } from "../route";
const id = "11111111-1111-1111-1111-111111111111";
const account = "22222222-2222-2222-2222-222222222222";
function invoke(body: unknown) { return POST(new NextRequest(`https://mgm.test/api/organizations/${id}/payment-accounts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }); }
beforeEach(() => { vi.clearAllMocks(); mocks.access.mockResolvedValue(true); mocks.existing.mockResolvedValue({ data: { id: account, version: 2, is_default: true }, error: null }); mocks.test.mockResolvedValue({ ok: true, baseUrl: "https://provider.test", ipnId: "IPN", ipnUrl: "https://mgm.test/api/payments/ipn" }); mocks.rpc.mockResolvedValue({ data: account, error: null }); mocks.service.mockReturnValue({ rpc: mocks.rpc }); });
describe("merchant configuration versioned save", () => {
 it.each(["auth_failed", "register_ipn_failed"])("preserves active credentials and version after %s", async reason => {
  mocks.test.mockResolvedValue({ ok: false, reason, message: "Test failed" });
  expect((await invoke({ consumerKey: "replacement", consumerSecret: "candidate-secret", sandbox: true })).status).toBe(503);
  expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it("atomically saves a tested candidate with expected version", async () => {
  const response = await invoke({ consumerKey: "replacement", consumerSecret: "candidate-secret", sandbox: true });
  expect(response.status).toBe(200); expect(mocks.rpc).toHaveBeenCalledWith("fn_payment_save_account", expect.objectContaining({ _account_id: account, _expected_version: 2, _payload: expect.objectContaining({ is_default: true, secret_encrypted: "encrypted-test-secret" }) }));
  expect(JSON.stringify(await response.json())).not.toContain("candidate-secret");
 });
 it("keeps new override accounts separate from the default", async () => {
  mocks.existing.mockResolvedValue({ data: null, error: null });
  expect((await invoke({ consumerKey: "override", consumerSecret: "candidate", sandbox: true, createOverride: true })).status).toBe(200);
  expect(mocks.rpc).toHaveBeenCalledWith("fn_payment_save_account", expect.objectContaining({ _account_id: null, _payload: expect.objectContaining({ is_default: false }) }));
 });
 it("returns a conflict on a concurrent account edit", async () => { mocks.rpc.mockResolvedValue({ data: null, error: { message: "changed" } }); expect((await invoke({ consumerKey: "key", consumerSecret: "candidate", sandbox: true })).status).toBe(409); });
 it("denies other organizations before any provider probe", async () => { mocks.access.mockResolvedValue(false); expect((await invoke({ consumerKey: "key", consumerSecret: "candidate", sandbox: true })).status).toBe(403); expect(mocks.test).not.toHaveBeenCalled(); });
 it("requires an explicit environment", async () => { expect((await invoke({ consumerKey: "key", consumerSecret: "candidate" })).status).toBe(400); expect(mocks.test).not.toHaveBeenCalled(); });
});
