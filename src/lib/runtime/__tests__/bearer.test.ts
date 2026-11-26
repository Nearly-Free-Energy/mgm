/**
 * verifyBearer (ADR-008 decision 6): every bearer token that could be
 * accepted is asked about at Supabase Auth's GET /user, and accepted only
 * when Auth answers for the subject its claims name. A refusal by Auth and no
 * answer from it are told apart; both refuse.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_TIMEOUT_MS, verifyBearer } from "../bearer";
import { CLIENT_ID, USER_ID, agentClaims, browserClaims, operatorClaims, tokenWith } from "./token-fixtures";

const SETTINGS = { url: "http://127.0.0.1:54321", anonKey: "sb_publishable_test" };

function authAnswers(status: number, body: object) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const user = (id = USER_ID) => ({ id, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "" });

afterEach(() => vi.unstubAllGlobals());

describe("verifyBearer", () => {
  it("accepts an operator client Supabase Auth answers for, asking GET /user with the token", async () => {
    const token = tokenWith(operatorClaims());
    const fetch = authAnswers(200, user());
    expect(await verifyBearer(token, SETTINGS)).toEqual({ ok: true, caller: { kind: "operator", clientId: CLIENT_ID }, userId: USER_ID });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/auth/v1/user");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${token}`);
  });

  it("accepts an agent client the same way", async () => {
    authAnswers(200, user());
    expect(await verifyBearer(tokenWith(agentClaims()), SETTINGS)).toMatchObject({ ok: true, caller: { kind: "agent" } });
  });

  it("refuses a token Supabase Auth refuses, such as a revoked client's", async () => {
    authAnswers(403, { code: 403, error_code: "session_not_found", msg: "Session not found" });
    expect(await verifyBearer(tokenWith(operatorClaims()), SETTINGS)).toEqual({ ok: false, reason: "auth_refused" });
  });

  it.each([
    [401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" }],
    [404, { code: 404, error_code: "user_not_found", msg: "User not found" }],
  ])("refuses a token Supabase Auth answers %i for as auth_refused", async (status, body) => {
    authAnswers(status, body);
    expect(await verifyBearer(tokenWith(operatorClaims()), SETTINGS)).toEqual({ ok: false, reason: "auth_refused" });
  });

  it("refuses when Supabase Auth cannot be reached, as auth_unavailable rather than a refusal of the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(await verifyBearer(tokenWith(operatorClaims()), SETTINGS)).toEqual({ ok: false, reason: "auth_unavailable" });
  });

  it.each([
    [500, { code: 500, error_code: "unexpected_failure", msg: "Unexpected failure" }],
    [502, { message: "Bad gateway" }],
    [503, { message: "Service unavailable" }],
    [429, { code: 429, error_code: "over_request_rate_limit", msg: "Rate limit exceeded" }],
  ])("refuses as auth_unavailable when Supabase Auth answers %i", async (status, body) => {
    authAnswers(status, body);
    expect(await verifyBearer(tokenWith(operatorClaims()), SETTINGS)).toEqual({ ok: false, reason: "auth_unavailable" });
  });

  it("refuses as auth_unavailable when Supabase Auth answers with something that is not its JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>gateway</html>", { status: 500, headers: { "content-type": "text/html" } })));
    expect(await verifyBearer(tokenWith(operatorClaims()), SETTINGS)).toEqual({ ok: false, reason: "auth_unavailable" });
  });

  it("bounds the call to Supabase Auth by AUTH_TIMEOUT_MS, and refuses as auth_unavailable when it runs out", async () => {
    // AbortSignal.timeout runs on Node's own timers, which fake timers do not
    // reach, so the test stands in a signal it can fire itself.
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      let asked!: () => void;
      const reached = new Promise<void>((resolve) => (asked = resolve));
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
              asked();
            }),
        ),
      );
      const pending = verifyBearer(tokenWith(operatorClaims()), SETTINGS);
      await reached;
      expect(timeoutSpy).toHaveBeenCalledWith(AUTH_TIMEOUT_MS);
      timeout.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      expect(await pending).toEqual({ ok: false, reason: "auth_unavailable" });
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("refuses a token whose subject is not the user Auth answers for", async () => {
    authAnswers(200, user("e7100000-0000-4000-8fff-000000000009"));
    expect(await verifyBearer(tokenWith(operatorClaims()), SETTINGS)).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([
    ["a browser session's token", tokenWith(browserClaims()), "not_a_client"],
    ["a client token with no kind", tokenWith(operatorClaims({ mgm_client_kind: undefined })), "no_kind"],
    ["a string that is not a token", "a.b.c", "malformed"],
  ])("refuses %s without asking Auth", async (_label, token, reason) => {
    const fetch = authAnswers(200, user());
    expect(await verifyBearer(token, SETTINGS)).toEqual({ ok: false, reason });
    expect(fetch).not.toHaveBeenCalled();
  });
});
