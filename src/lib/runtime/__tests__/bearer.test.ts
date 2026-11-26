/**
 * verifyBearer (ADR-008 decision 6): every bearer token that could be
 * accepted is asked about at Supabase Auth's GET /user, and accepted only
 * when Auth answers for the subject its claims name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyBearer } from "../bearer";
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

  it("refuses when Supabase Auth cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(await verifyBearer(tokenWith(operatorClaims()), SETTINGS)).toMatchObject({ ok: false });
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
