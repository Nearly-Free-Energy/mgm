/**
 * POST /api/payments/attempts/[id]/refresh and /reconcile look the attempt
 * up on the service role before composing Payments. Both ask Supabase Auth
 * for the session first, so a session signed out elsewhere (whose token
 * middleware still verifies) gets 401 before that lookup runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const getUserMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: getUserMock } }),
}));

const maybeSingleMock = vi.fn();
const createServiceClientMock = vi.fn(() => ({
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }),
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => createServiceClientMock(),
}));

const composePaymentsMock = vi.fn();
vi.mock("@/lib/payments/compose", () => ({
  composePayments: (...args: unknown[]) => composePaymentsMock(...args),
}));

import { POST as refresh } from "../refresh/route";
import { POST as reconcile } from "../reconcile/route";

const ATTEMPT_ID = "12345678-1234-1234-1234-123456789012";

function call(handler: typeof refresh, name: string) {
  return handler(
    new NextRequest(`http://localhost/api/payments/attempts/${ATTEMPT_ID}/${name}`, {
      method: "POST",
      body: JSON.stringify({ action: "accept_exact" }),
    }),
    { params: Promise.resolve({ id: ATTEMPT_ID }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  ["refresh", refresh],
  ["reconcile", reconcile],
] as const)("POST /api/payments/attempts/[id]/%s", (name, handler) => {
  it("answers 401 without a live session, before the service-role lookup", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });

    const res = await call(handler, name);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Authentication required.",
      reason: "payments_unauthenticated",
    });
    expect(createServiceClientMock).not.toHaveBeenCalled();
    expect(composePaymentsMock).not.toHaveBeenCalled();
  });

  it("looks the attempt up once the session is live", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    maybeSingleMock.mockResolvedValue({ data: null, error: null });

    const res = await call(handler, name);

    expect(res.status).toBe(404);
    expect(createServiceClientMock).toHaveBeenCalledTimes(1);
    expect(composePaymentsMock).not.toHaveBeenCalled();
  });

  it("composes Payments for the attempt's organization", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    maybeSingleMock.mockResolvedValue({
      data: { id: ATTEMPT_ID, org_id: "org-1" },
      error: null,
    });
    composePaymentsMock.mockResolvedValue({
      ok: false,
      status: 403,
      code: "payments_forbidden",
      message: "Forbidden.",
    });

    const res = await call(handler, name);

    expect(res.status).toBe(403);
    expect(composePaymentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1" })
    );
  });
});
