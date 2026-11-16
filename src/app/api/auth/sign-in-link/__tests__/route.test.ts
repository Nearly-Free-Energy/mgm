import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ after: vi.fn(), issue: vi.fn(), limit: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<object>()), after: mocks.after }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ service: true }) }));
vi.mock("@/lib/runtime/root", () => ({ getMgmRuntime: async () => ({ mailTransports: { registry: true } }) }));
vi.mock("@/lib/rate-limit/in-memory", () => ({ checkRateLimit: mocks.limit }));
vi.mock("@/lib/auth/sign-in-link", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueSignInLink: mocks.issue,
}));

import { POST } from "../route";

function post(body: unknown) {
  return POST(
    new NextRequest("https://mgm.test/api/auth/sign-in-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limit.mockReturnValue({ ok: true });
});

describe("POST /api/auth/sign-in-link", () => {
  it("answers 202 before any lookup, and does the work after the response", async () => {
    const response = await post({ email: " manager@example.org ", next: "/x" });
    expect(response.status).toBe(202);
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.after).toHaveBeenCalledOnce();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.issue).toHaveBeenCalledWith({
      service: { service: true },
      transports: { registry: true },
      email: "manager@example.org",
      ip: "203.0.113.9",
      next: "/x",
    });
  });

  it("answers the same whatever the outcome turns out to be", async () => {
    const bodies = [];
    for (const outcome of ["sent", "no_access", "limited"]) {
      mocks.issue.mockResolvedValueOnce(outcome);
      const response = await post({ email: "a@example.org" });
      bodies.push([response.status, await response.json()]);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("keeps a failure in the background work from reaching the caller", async () => {
    mocks.issue.mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await post({ email: "a@example.org" });
    await expect(mocks.after.mock.calls[0][0]()).resolves.toBeUndefined();
    error.mockRestore();
  });

  it.each([[{}], [{ email: "nope" }], [{ email: `${"a".repeat(320)}@example.org` }]])("refuses %j", async (body) => {
    expect((await post(body)).status).toBe(422);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("answers 429 to a burst from one IP", async () => {
    mocks.limit.mockReturnValue({ ok: false, retryAfter: 30 });
    const response = await post({ email: "a@example.org" });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(mocks.after).not.toHaveBeenCalled();
  });
});
