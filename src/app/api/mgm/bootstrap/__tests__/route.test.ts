import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { _resetRateLimitStoreForTests } from "@/lib/rate-limit/in-memory";

let currentUser: { id: string } | null = { id: "user-1" };
const mockRpc = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}));

const mockRevalidate = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));

function makePost(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mgm/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  bootstrap_token: "test-bootstrap-token",
  organization: {
    name: "New Frontiers Energy",
    address_city: "Kampala",
    address_country: "Uganda",
  },
};

describe("POST /api/mgm/bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimitStoreForTests();
    currentUser = { id: "user-1" };
    process.env.MGM_BOOTSTRAP_TOKEN = "test-bootstrap-token";
    mockRpc.mockResolvedValue({
      data: { id: "org-1", name: "New Frontiers Energy" },
      error: null,
    });
  });

  it("503 when the bootstrap token is not configured", async () => {
    delete process.env.MGM_BOOTSTRAP_TOKEN;
    const { POST } = await import("../route");
    const res = await POST(makePost(VALID_BODY));
    expect(res.status).toBe(503);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("403 on token mismatch", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePost({ ...VALID_BODY, bootstrap_token: "wrong" })
    );
    expect(res.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("422 when the organization name is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePost({
        ...VALID_BODY,
        organization: { ...VALID_BODY.organization, name: "  " },
      })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("name");
  });

  it("401 when unauthenticated", async () => {
    currentUser = null;
    const { POST } = await import("../route");
    const res = await POST(makePost(VALID_BODY));
    expect(res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("409 when an organization already exists", async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0001", message: "An organization already exists" },
    });
    const { POST } = await import("../route");
    const res = await POST(makePost(VALID_BODY));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("bootstrap_already_bootstrapped");
  });

  it("201 creates the first organization and operator role", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePost(VALID_BODY));
    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith(
      "fn_mgm_bootstrap_first_organization",
      expect.objectContaining({
        _name: "New Frontiers Energy",
        _address_city: "Kampala",
        _address_country: "Uganda",
      })
    );
    expect(mockRevalidate).toHaveBeenCalledWith("/", "layout");
  });
});
