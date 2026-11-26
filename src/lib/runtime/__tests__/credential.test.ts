/**
 * Reading a request's credential (RFC #259 § 2): the Authorization header's
 * bearer token, the session cookie, the mark middleware puts on an accepted
 * token, and the switch that turns client tokens off (ADR-008 decision 9).
 */
import { describe, expect, it } from "vitest";
import { clientTokensAccepted, readClientTokens } from "@/lib/config/client-tokens";
import { bearerCredential, credentialMark, credentialMarkMatches, sessionCookiePresent } from "../credential";
import { operatorClaims, tokenWith } from "./token-fixtures";

const TOKEN = tokenWith(operatorClaims());

describe("bearerCredential", () => {
  it("is null without a header, or for another scheme", () => {
    expect(bearerCredential(null)).toBeNull();
    expect(bearerCredential("Basic dXNlcjpwYXNz")).toBeNull();
    expect(bearerCredential("Bearertoken")).toBeNull();
  });

  it.each([`Bearer ${TOKEN}`, `bearer ${TOKEN}`, `BEARER  ${TOKEN} `])("reads the token from %j", (header) => {
    expect(bearerCredential(header)).toEqual({ ok: true, token: TOKEN });
  });

  it.each(["Bearer", "Bearer ", `Bearer ${TOKEN} ${TOKEN}`, "Bearer abc", "Bearer a.b.c=", "Bearer a.b"])(
    "counts %j as a bearer credential that is not well formed",
    (header) => {
      expect(bearerCredential(header)).toEqual({ ok: false });
    },
  );
});

describe("credentialMark", () => {
  const ENV = { SUPABASE_SERVICE_ROLE_KEY: "key-one" };
  const OTHER = tokenWith(operatorClaims({ sub: "00000000-0000-4000-8000-000000000999" }));

  it("is a MAC of the token under the server-only key: fixed for one token and key, different for another of either", () => {
    const mark = credentialMark(TOKEN, ENV);
    expect(mark).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credentialMark(TOKEN, ENV)).toBe(mark);
    expect(credentialMark(OTHER, ENV)).not.toBe(mark);
    expect(credentialMark(TOKEN, { SUPABASE_SERVICE_ROLE_KEY: "key-two" })).not.toBe(mark);
  });

  it("is never made without the key", () => {
    expect(credentialMark(TOKEN, {})).toBeNull();
    expect(credentialMark(TOKEN, { SUPABASE_SERVICE_ROLE_KEY: "" })).toBeNull();
  });

  it("matches only its own token's mark", () => {
    const mark = credentialMark(TOKEN, ENV);
    expect(credentialMarkMatches(TOKEN, mark, ENV)).toBe(true);
    expect(credentialMarkMatches(OTHER, mark, ENV)).toBe(false);
    for (const forged of [null, "", "bearer", `${mark}x`]) expect(credentialMarkMatches(TOKEN, forged, ENV)).toBe(false);
    expect(credentialMarkMatches(TOKEN, mark, {})).toBe(false);
  });
});

describe("sessionCookiePresent", () => {
  const KEY = "sb-mgm-auth-token";
  it.each([
    [[{ name: KEY, value: "x" }], true],
    [[{ name: `${KEY}.0`, value: "x" }], true],
    [[{ name: `${KEY}.12`, value: "x" }], true],
    [[{ name: KEY, value: "" }], false],
    [[{ name: `${KEY}-code-verifier`, value: "x" }], false],
    [[{ name: `${KEY}.01`, value: "x" }], false],
    [[{ name: `${KEY}.x`, value: "x" }], false],
    [[{ name: "mgm_org", value: "x" }], false],
    [[], false],
  ])("for %j is %s", (cookies, present) => {
    expect(sessionCookiePresent(cookies, KEY)).toBe(present);
  });
});

describe("clientTokensAccepted (MGM_CLIENT_TOKENS)", () => {
  it.each([undefined, "", " ", "on", "ON", "1", "true"])("accepts client tokens for %j", (value) => {
    expect(clientTokensAccepted({ MGM_CLIENT_TOKENS: value })).toBe(true);
  });

  it.each(["off", "0", "false", "no", "of", "disabled"])("refuses them for %j, a mistyped value included", (value) => {
    expect(clientTokensAccepted({ MGM_CLIENT_TOKENS: value })).toBe(false);
  });

  it("reads a value that is neither on nor off as invalid, which the start-up check logs", () => {
    expect(readClientTokens({ MGM_CLIENT_TOKENS: undefined })).toBe("on");
    expect(readClientTokens({ MGM_CLIENT_TOKENS: " Off " })).toBe("off");
    expect(readClientTokens({ MGM_CLIENT_TOKENS: "no" })).toBe("invalid");
  });
});
