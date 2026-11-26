/**
 * POST /api/auth/logout (#297, ADR-008 decision 5): who may end a session,
 * and which session ends. The person, client and session come from the
 * token's claims, never the body; a cookie session and an agent client are
 * refused before anything privileged. Against a real database and the real
 * middleware: logout.db.test.ts beside this file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordCaller, type Caller } from "@/lib/runtime/caller";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  rpc: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.createServiceClient }));

import { POST } from "../route";

const USER = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

function token(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "ES256", typ: "JWT" })}.${part(claims)}.c2lnbmF0dXJl`;
}

const OPERATOR_CLAIMS = {
  sub: USER,
  role: "authenticated",
  client_id: CLIENT,
  mgm_client_kind: "operator",
  session_id: SESSION,
};

/** The client createClient hands the route, recorded as acting for `caller`. */
function clientFor(caller: Caller | null) {
  const client = { auth: { getUser: mocks.getUser } };
  if (caller) recordCaller(client, caller);
  return client;
}

function request(claims: Record<string, unknown> = OPERATOR_CLAIMS, body?: unknown) {
  return new Request("https://mgm.example.org/api/auth/logout", {
    method: "POST",
    headers: { authorization: `Bearer ${token(claims)}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.createClient.mockResolvedValue(clientFor({ kind: "operator", clientId: CLIENT }));
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER } } });
  mocks.rpc.mockResolvedValue({ data: [{ outcome: "ended", sessions_ended: 1, consent_revoked: false }], error: null });
  mocks.createServiceClient.mockReturnValue({ rpc: mocks.rpc });
});

describe("POST /api/auth/logout", () => {
  it("ends the token's own session, named by its claims, and answers 204 with no body", async () => {
    const res = await POST(request());
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("fn_client_sessions_end", {
      _user_id: USER,
      _client_id: CLIENT,
      _session_id: SESSION,
    });
  });

  it("ignores a body naming another session, person or client", async () => {
    const res = await POST(
      request(OPERATOR_CLAIMS, { session_id: OTHER, user_id: OTHER, client_id: OTHER, _session_id: null }),
    );
    expect(res.status).toBe(204);
    expect(mocks.rpc).toHaveBeenCalledWith("fn_client_sessions_end", {
      _user_id: USER,
      _client_id: CLIENT,
      _session_id: SESSION,
    });
  });

  it("answers 204 when the session was already gone", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ outcome: "not_found", sessions_ended: 0, consent_revoked: false }], error: null });
    expect((await POST(request())).status).toBe(204);
  });

  it("checks the session with getUser() before it creates the service client", async () => {
    const order: string[] = [];
    mocks.getUser.mockImplementation(async () => {
      order.push("getUser");
      return { data: { user: { id: USER } } };
    });
    mocks.createServiceClient.mockImplementation(() => {
      order.push("service");
      return { rpc: mocks.rpc };
    });
    await POST(request());
    expect(order).toEqual(["getUser", "service"]);
  });

  it("refuses a browser session with 403 and ends nothing", async () => {
    mocks.createClient.mockResolvedValue(clientFor(null));
    const res = await POST(new Request("https://mgm.example.org/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "operator_client_only" });
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("refuses an agent client with 403 and ends nothing", async () => {
    mocks.createClient.mockResolvedValue(clientFor({ kind: "agent", clientId: CLIENT }));
    const res = await POST(request({ ...OPERATOR_CLAIMS, role: "mgm_agent", mgm_client_kind: "agent" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "operator_client_only" });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("answers 401 when Supabase Auth no longer accepts the token", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it.each([
    ["no session_id", { ...OPERATOR_CLAIMS, session_id: undefined }],
    ["a session_id that is not a uuid", { ...OPERATOR_CLAIMS, session_id: "session" }],
    ["another person's sub", { ...OPERATOR_CLAIMS, sub: OTHER }],
    ["another client's id", { ...OPERATOR_CLAIMS, client_id: OTHER }],
  ])("answers 401 for claims with %s, and ends nothing", async (_name, claims) => {
    const res = await POST(request(claims));
    expect(res.status).toBe(401);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("answers 500 and says where to revoke when the database refuses", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    const res = await POST(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "logout_failed", error: expect.stringContaining("Connected apps") });
  });
});
