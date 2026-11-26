/**
 * The sign-in request mgm login opens (ADR-008 decisions 2 and 3): PKCE with
 * S256 only, a fresh state the code page accepts, and scope email, never
 * openid.
 */
import { describe, expect, it } from "vitest";
import { isPastedState } from "../../../../src/lib/auth/pasted-code.ts";
import { installationOrigin } from "../discovery.ts";
import { SCOPE, authorizeAddress, challengeFor, newState, newVerifier } from "../oauth.ts";

describe("PKCE and state", () => {
  it("computes the S256 challenge of RFC 7636's example", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("makes a new 43-character verifier and state each time, in the shape the code page accepts", () => {
    const verifiers = new Set(Array.from({ length: 20 }, newVerifier));
    const states = new Set(Array.from({ length: 20 }, newState));
    expect(verifiers.size).toBe(20);
    expect(states.size).toBe(20);
    for (const value of [...verifiers, ...states]) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const state of states) expect(isPastedState(state)).toBe(true);
  });

  it("opens the authorize endpoint with S256, the state, scope email and the code page", () => {
    const address = new URL(
      authorizeAddress("https://abc.supabase.co/auth/v1/oauth/authorize", {
        clientId: "c1",
        redirectUri: "https://mgm.example.org/oauth/code",
        state: "s".repeat(43),
        challenge: "x".repeat(43),
      }),
    );
    expect(`${address.origin}${address.pathname}`).toBe("https://abc.supabase.co/auth/v1/oauth/authorize");
    expect(Object.fromEntries(address.searchParams)).toEqual({
      response_type: "code",
      client_id: "c1",
      redirect_uri: "https://mgm.example.org/oauth/code",
      scope: "email",
      state: "s".repeat(43),
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
    });
    expect(SCOPE.split(/\s+/)).not.toContain("openid");
  });
});

describe("installation addresses", () => {
  it.each([
    ["mgm.example.org", "https://mgm.example.org"],
    ["https://mgm.example.org/organizations/x?y=1", "https://mgm.example.org"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://localhost:3000/", "http://localhost:3000"],
  ])("takes %s as %s", (typed, origin) => {
    expect(installationOrigin(typed)).toBe(origin);
  });

  it.each(["http://mgm.example.org", "ftp://mgm.example.org", "https://user:pass@mgm.example.org", "not an address"])(
    "refuses %s",
    (typed) => {
      expect(() => installationOrigin(typed)).toThrow(/not an MGM address/);
    },
  );
});
