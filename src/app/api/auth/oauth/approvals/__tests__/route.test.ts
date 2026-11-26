/**
 * POST /api/auth/oauth/approvals (#271, ADR-008 decision 2): who may record
 * an approval, and what each refusal answers. Every refusal before getUser()
 * reads nothing; the record is written for the getUser() id only. Against a
 * real database: sign-in.db.test.ts beside this file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  getClaims: vi.fn(),
  createServiceClient: vi.fn(() => ({ service: true })),
  recordClientApproval: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock("@/lib/auth/client-consent", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client-consent")>()),
  recordClientApproval: mocks.recordClientApproval,
}));

import { POST } from "../route";

const ID = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
const SITE = "https://mgm.example.org";

function request(headers: Record<string, string> = {}, body: unknown = { authorization_id: ID }) {
  return new NextRequest(`${SITE}/api/auth/oauth/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function readNothing() {
  expect(mocks.createClient).not.toHaveBeenCalled();
  expect(mocks.createServiceClient).not.toHaveBeenCalled();
  expect(mocks.recordClientApproval).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MGM_APP_URL", SITE);
  mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser, getClaims: mocks.getClaims } });
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "user-1", role: "authenticated" } } });
  mocks.recordClientApproval.mockResolvedValue({ outcome: "ok", client: { id: "c-1", kind: "operator", label: "MGM CLI" } });
});

describe("POST /api/auth/oauth/approvals", () => {
  it("records the approval for the signed-in person, whoever they are, and answers 201", async () => {
    const res = await POST(request());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ client_id: "c-1", kind: "operator" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.recordClientApproval).toHaveBeenCalledWith({ service: true }, ID, "user-1");
  });

  it("checks the session with getUser() before it creates the service client", async () => {
    const order: string[] = [];
    mocks.getUser.mockImplementation(async () => {
      order.push("getUser");
      return { data: { user: { id: "user-1" } } };
    });
    mocks.createServiceClient.mockImplementation(() => {
      order.push("service");
      return { service: true };
    });
    await POST(request());
    expect(order).toEqual(["getUser", "service"]);
  });

  it.each(["Bearer a.b.c", "Basic eDp5", ""])("refuses any Authorization header (%j) with 401, reading nothing", async (value) => {
    const res = await POST(request({ authorization: value }));
    expect(res.status).toBe(401);
    readNothing();
  });

  it.each([
    ["a cross-site request", { "sec-fetch-site": "cross-site" }],
    ["a same-site request from another origin", { "sec-fetch-site": "same-site" }],
    ["a request with neither header", { "sec-fetch-site": "" }],
  ])("refuses %s with 403, reading nothing", async (_name, headers) => {
    const req = request(headers);
    if (headers["sec-fetch-site"] === "") req.headers.delete("sec-fetch-site");
    const res = await POST(req);
    expect(res.status).toBe(403);
    readNothing();
  });

  it("accepts this site's Origin where the browser sends no Sec-Fetch-Site, and refuses another", async () => {
    const own = request({ origin: SITE });
    own.headers.delete("sec-fetch-site");
    expect((await POST(own)).status).toBe(201);
    const other = request({ origin: "https://evil.example" });
    other.headers.delete("sec-fetch-site");
    expect((await POST(other)).status).toBe(403);
  });

  it.each([
    ["a body that is not JSON", { "content-type": "text/plain" }, "x", 415],
    ["no id", {}, {}, 422],
    ["an id of the wrong shape", {}, { authorization_id: "x/../y" }, 422],
    ["a body that does not parse", {}, "{", 422],
  ])("refuses %s, reading nothing", async (_name, headers, body, status) => {
    const res = await POST(request(headers as Record<string, string>, body));
    expect(res.status).toBe(status);
    readNothing();
  });

  it("answers 401 with no session, and records nothing", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("refuses a client's token in the cookie, which getUser() answers for", async () => {
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "user-1", client_id: "c-1" } } });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("refuses claims that are missing or name someone else", async () => {
    mocks.getClaims.mockResolvedValue({ data: null });
    expect((await POST(request())).status).toBe(401);
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "user-2" } } });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", 404],
    ["expired", 410],
    ["answered", 409],
    ["unlisted", 403],
  ])("answers the database's %s with %i", async (outcome, status) => {
    mocks.recordClientApproval.mockResolvedValue({ outcome });
    const res = await POST(request());
    expect(res.status).toBe(status);
    expect((await res.json()).outcome).toBe(outcome);
  });
});
