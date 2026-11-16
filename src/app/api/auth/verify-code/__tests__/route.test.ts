import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ claim: vi.fn(), record: vi.fn(), verify: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ service: true }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { verifyOtp: mocks.verify } }) }));
vi.mock("@/lib/auth/sign-in-link", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimCodeAttempt: mocks.claim,
  recordCodeOutcome: mocks.record,
}));

import { POST } from "../route";

function post(body: unknown) {
  return POST(
    new NextRequest("https://mgm.test/api/auth/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockResolvedValue(7);
  mocks.verify.mockResolvedValue({ error: null });
});

describe("POST /api/auth/verify-code", () => {
  it("claims the attempt before Supabase sees the code, then signs in", async () => {
    const response = await post({ email: "Manager@Example.org", code: "123 456", next: "/microgrids/m1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "/microgrids/m1" });
    expect(mocks.claim).toHaveBeenCalledWith({ service: true }, "manager@example.org", "203.0.113.9");
    expect(mocks.verify).toHaveBeenCalledWith({ email: "manager@example.org", token: "123456", type: "email" });
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(mocks.verify.mock.invocationCallOrder[0]);
    expect(mocks.record).toHaveBeenCalledWith({ service: true }, 7, "verified");
  });

  it("refuses without asking Supabase once the tries are used up", async () => {
    mocks.claim.mockResolvedValue(null);
    const response = await post({ email: "a@example.org", code: "123456" });
    expect(response.status).toBe(429);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("records a wrong code", async () => {
    mocks.verify.mockResolvedValue({ error: { code: "otp_expired" } });
    const response = await post({ email: "a@example.org", code: "123456" });
    expect(response.status).toBe(401);
    expect(mocks.record).toHaveBeenCalledWith({ service: true }, 7, "wrong_code");
  });

  it("sends a return path off the site home", async () => {
    const response = await post({ email: "a@example.org", code: "123456", next: "https://evil.example/" });
    expect(await response.json()).toEqual({ next: "/" });
  });

  it.each([
    [{ email: "a@example.org", code: "12345" }, "code"],
    [{ email: "a@example.org", code: "abcdef" }, "code"],
    [{ email: "nope", code: "123456" }, "email"],
  ])("refuses %j without claiming an attempt", async (body, field) => {
    const response = await post(body);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field });
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
