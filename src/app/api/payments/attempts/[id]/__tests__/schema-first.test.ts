/**
 * POST /api/payments/attempts/[id]/refresh and /reconcile parse their body
 * (src/lib/payments/schemas.ts) once the session is live and before the
 * attempt is looked up: a body that does not parse answers 400
 * { error, field?, code: "invalid_body" } and reaches neither the service
 * role nor the capability; a body that parses reaches the capability as
 * parsed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getUserMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: getUserMock } }),
}));

const maybeSingleMock = vi.fn();
const createServiceClientMock = vi.fn(() => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }) }),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => createServiceClientMock() }));

const reconcileMock = vi.fn();
const refreshMock = vi.fn();
const disposeMock = vi.fn();
const composePaymentsMock = vi.fn();
vi.mock("@/lib/payments/compose", () => ({ composePayments: (...args: unknown[]) => composePaymentsMock(...args) }));

import { POST as refresh } from "../refresh/route";
import { POST as reconcile } from "../reconcile/route";

const ATTEMPT_ID = "12345678-1234-4234-8234-123456789012";

function call(handler: typeof refresh, name: string, body: string) {
  return handler(
    new NextRequest(`http://localhost/api/payments/attempts/${ATTEMPT_ID}/${name}`, { method: "POST", body }),
    { params: Promise.resolve({ id: ATTEMPT_ID }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
  maybeSingleMock.mockResolvedValue({ data: { id: ATTEMPT_ID, org_id: "org-1" }, error: null });
  reconcileMock.mockResolvedValue({ ok: true, data: { attempt: { id: ATTEMPT_ID } } });
  refreshMock.mockResolvedValue({ ok: true, data: { attempt: { id: ATTEMPT_ID }, receipts: [] } });
  composePaymentsMock.mockResolvedValue({
    ok: true,
    data: { payments: { reconcile: reconcileMock, refreshPaymentStatus: refreshMock }, dispose: disposeMock },
  });
});

describe.each([
  ["refresh", refresh, { action: "accept_exact" }, "Unknown field: action"],
  ["reconcile", reconcile, { action: "accept_exact", attemptId: "x" }, "Unknown field: attemptId"],
] as const)("POST /api/payments/attempts/[id]/%s", (name, handler, unknown, message) => {
  it("refuses an unknown key with 400 invalid_body, before the lookup and the capability", async () => {
    const res = await call(handler, name, JSON.stringify(unknown));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: message, code: "invalid_body" });
    expect(createServiceClientMock).not.toHaveBeenCalled();
    expect(composePaymentsMock).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON with 400", async () => {
    const res = await call(handler, name, "{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body", code: "invalid_body" });
    expect(createServiceClientMock).not.toHaveBeenCalled();
  });

  it("refuses an empty body with 400: there is no default body", async () => {
    const res = await call(handler, name, "");
    expect(res.status).toBe(400);
    expect(composePaymentsMock).not.toHaveBeenCalled();
  });

  it("answers 401 without a live session before reading the body", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const res = await call(handler, name, "{not json");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/payments/attempts/[id]/reconcile", () => {
  it("passes the parsed, trimmed body to the capability", async () => {
    const body = {
      action: "record_external",
      externalAmount: -2500,
      externalReference: "  MTN-1  ",
      notes: " refunded ",
      confirmation: { acknowledged: [], typed: "Akello Grace" },
    };
    const res = await call(reconcile, "reconcile", JSON.stringify(body));
    expect(res.status).toBe(200);
    expect(reconcileMock).toHaveBeenCalledWith(ATTEMPT_ID, { ...body, externalReference: "MTN-1", notes: "refunded" });
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a field of the wrong type with its name", async () => {
    const res = await call(reconcile, "reconcile", JSON.stringify({ action: "record_external", externalAmount: "5" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "externalAmount must be a number.", field: "externalAmount", code: "invalid_body" });
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/payments/attempts/[id]/refresh", () => {
  it("refreshes with an empty body", async () => {
    const res = await call(refresh, "refresh", "{}");
    expect(res.status).toBe(200);
    expect(refreshMock).toHaveBeenCalledWith(ATTEMPT_ID);
  });
});
