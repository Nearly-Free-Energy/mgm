/**
 * The caller's kind from a token's claims (RFC #259 § 2, ADR-008 decisions
 * 2 and 6): a cookie is a browser session and never a client's token; a
 * bearer token is always a client, of a kind the hook wrote, with the role
 * that kind runs as.
 */
import { describe, expect, it } from "vitest";
import { BROWSER, callerFromClaims, callerOf, claimsOfToken, recordCaller } from "../caller";
import { CLIENT_ID, agentClaims, browserClaims, operatorClaims, tokenWith } from "./token-fixtures";

describe("callerFromClaims", () => {
  it("reads a browser session from a cookie whose token names no client", () => {
    expect(callerFromClaims(browserClaims(), "cookie")).toEqual({ ok: true, caller: BROWSER });
  });

  it.each([
    ["a client's token", operatorClaims()],
    ["a client_id that is null", browserClaims({ client_id: null })],
    ["a client_id that is empty", browserClaims({ client_id: "" })],
  ])("treats %s in the cookie as no session", (_label, claims) => {
    expect(callerFromClaims(claims, "cookie")).toEqual({ ok: false, reason: "client_token_in_cookie" });
  });

  it("reads an operator client from a bearer token, with its client id in lower case", () => {
    expect(callerFromClaims(operatorClaims({ client_id: CLIENT_ID.toUpperCase() }), "bearer")).toEqual({
      ok: true,
      caller: { kind: "operator", clientId: CLIENT_ID },
    });
  });

  it("reads an agent client from a bearer token that runs as mgm_agent (#274)", () => {
    expect(callerFromClaims(agentClaims(), "bearer")).toEqual({ ok: true, caller: { kind: "agent", clientId: CLIENT_ID } });
  });

  it("refuses a bearer token that names no client: a browser session's token used from a script", () => {
    expect(callerFromClaims(browserClaims(), "bearer")).toEqual({ ok: false, reason: "not_a_client" });
  });

  it.each([
    ["no kind", operatorClaims({ mgm_client_kind: undefined })],
    ["a null kind", operatorClaims({ mgm_client_kind: null })],
    ["an empty kind", operatorClaims({ mgm_client_kind: "" })],
  ])("refuses a bearer token with client_id and %s, issued while the hook was off", (_label, claims) => {
    const { mgm_client_kind, ...rest } = claims;
    const withKey = mgm_client_kind === undefined ? rest : claims;
    expect(callerFromClaims(withKey, "bearer")).toEqual({ ok: false, reason: "no_kind" });
  });

  it.each([
    ["an operator token that runs as another role", operatorClaims({ role: "mgm_agent" })],
    ["an agent token that runs as authenticated, which would carry the person's whole authority", agentClaims({ role: "authenticated" })],
    ["an agent token that runs as service_role", agentClaims({ role: "service_role" })],
    ["a kind MGM does not know", operatorClaims({ mgm_client_kind: "browser" })],
    ["a client_id that is not a uuid", operatorClaims({ client_id: "cli" })],
    ["no subject", operatorClaims({ sub: undefined })],
  ])("refuses %s", (_label, claims) => {
    expect(callerFromClaims(claims, "bearer")).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([null, "x", [], 1])("refuses claims that are not an object (%j)", (claims) => {
    expect(callerFromClaims(claims, "bearer")).toEqual({ ok: false, reason: "malformed" });
    expect(callerFromClaims(claims, "cookie")).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("claimsOfToken", () => {
  it("decodes a JWT's payload", () => {
    expect(claimsOfToken(tokenWith(operatorClaims()))).toEqual(operatorClaims());
  });

  it.each(["", "a.b", "a.b.c.d", "a..c", "a.!!.c", `x.${Buffer.from("[1]").toString("base64url")}.y`, "x.bm90IGpzb24.y"])(
    "returns null for %j",
    (token) => {
      expect(claimsOfToken(token)).toBeNull();
    },
  );
});

describe("callerOf", () => {
  it("returns what was recorded for a client, and a browser session for any other", () => {
    const client = {};
    recordCaller(client, { kind: "operator", clientId: CLIENT_ID });
    expect(callerOf(client)).toEqual({ kind: "operator", clientId: CLIENT_ID });
    expect(callerOf({})).toBe(BROWSER);
  });
});
