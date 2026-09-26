import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  obtainKeycloakToken,
  _resetKeycloakTokenCacheForTests,
  type KeycloakCredentials,
} from "../keycloak";
import { OpenEmsError } from "../errors";

const CREDS: KeycloakCredentials = {
  tokenUrl: "https://keycloak.example/realms/energy/protocol/openid-connect/token",
  clientId: "mgm-client",
  clientSecret: "shhh",
};

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: "access-abc",
      token_type: "Bearer",
      expires_in: 300,
      ...overrides,
    }),
  } as Response;
}

describe("obtainKeycloakToken", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubEnv("OPENEMS_KEYCLOAK_TOKEN_URLS", "https://keycloak.example/realms/energy/protocol/openid-connect/token");
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchSpy);
    _resetKeycloakTokenCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("rejects an unapproved public endpoint before sending credentials", async () => {
    await expect(obtainKeycloakToken({ ...CREDS, tokenUrl: "https://attacker.example/token" }))
      .rejects.toMatchObject({ code: "OPENEMS_INVALID_BACKEND_URL" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when no token endpoints are approved", async () => {
    vi.stubEnv("OPENEMS_KEYCLOAK_TOKEN_URLS", "");
    await expect(obtainKeycloakToken(CREDS))
      .rejects.toMatchObject({ code: "OPENEMS_INVALID_BACKEND_URL" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts client_credentials and caches until near expiry", async () => {
    fetchSpy.mockResolvedValue(tokenResponse());

    const first = await obtainKeycloakToken(CREDS, 1_000_000);
    expect(first).toBe("access-abc");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, options] = fetchSpy.mock.calls[0] as [
      string,
      { headers?: Record<string, string>; body?: string },
    ];
    const params = new URLSearchParams(options?.body ?? "");
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("mgm-client");
    expect(params.get("client_secret")).toBe("shhh");

    // Well within the 300s life (minus 60s skew): cache hit, no fetch.
    expect(await obtainKeycloakToken(CREDS, 1_100_000)).toBe("access-abc");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Inside the skew window: refetch.
    fetchSpy.mockResolvedValue(
      tokenResponse({ access_token: "access-def" })
    );
    expect(await obtainKeycloakToken(CREDS, 1_250_000)).toBe("access-def");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("maps IdP rejection to AUTH_FAILED", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401 } as Response);
    await expect(obtainKeycloakToken(CREDS, 0)).rejects.toMatchObject({
      code: "OPENEMS_AUTH_FAILED",
      statusCode: 401,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("maps transport failure to UNREACHABLE", async () => {
    fetchSpy.mockRejectedValue(new Error("socket hangup"));
    await expect(obtainKeycloakToken(CREDS, 0)).rejects.toMatchObject({
      code: "OPENEMS_UNREACHABLE",
      statusCode: 503,
    });
  });

  it("rejects token responses without an access token", async () => {
    fetchSpy.mockResolvedValue(tokenResponse({ access_token: undefined }));
    await expect(obtainKeycloakToken(CREDS, 0)).rejects.toBeInstanceOf(
      OpenEmsError
    );
    // Nothing cached: a retry fetches again.
    fetchSpy.mockResolvedValue(tokenResponse());
    expect(await obtainKeycloakToken(CREDS, 0)).toBe("access-abc");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects token responses without a usable expiry", async () => {
    fetchSpy.mockResolvedValue(tokenResponse({ expires_in: "never" }));
    await expect(obtainKeycloakToken(CREDS, 0)).rejects.toMatchObject({
      code: "OPENEMS_RPC_ERROR",
    });
  });

  // ── P1 (PR #8 re-review): the token request carries the client secret,
  // so the endpoint is validated at the sink and redirects are never
  // followed. Each test asserts fetch was never reached (plaintext URL)
  // or reached exactly once (redirect) — the secret cannot be forwarded.

  it("rejects a plaintext http endpoint without contacting it", async () => {
    await expect(
      obtainKeycloakToken({ ...CREDS, tokenUrl: "http://kc.example/token" }, 0)
    ).rejects.toMatchObject({ code: "OPENEMS_INVALID_BACKEND_URL" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an endpoint with embedded credentials without contacting it", async () => {
    await expect(
      obtainKeycloakToken(
        { ...CREDS, tokenUrl: "https://user:pass@kc.example/token" },
        0
      )
    ).rejects.toMatchObject({ code: "OPENEMS_INVALID_BACKEND_URL" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a literal private-address endpoint without contacting it", async () => {
    await expect(
      obtainKeycloakToken({ ...CREDS, tokenUrl: "https://10.0.0.5/token" }, 0)
    ).rejects.toMatchObject({ code: "OPENEMS_INVALID_BACKEND_URL" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a redirect without following it", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 307,
      headers: { get: (name: string) => (name === "location" ? "https://evil.example/token" : null) },
      json: async () => ({}),
    } as unknown as Response);
    await expect(obtainKeycloakToken(CREDS, 0)).rejects.toMatchObject({
      code: "OPENEMS_REDIRECT",
      statusCode: 502,
    });
    // Exactly one request left the process — the redirect target was never
    // contacted, so the secret reached only the validated endpoint.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, options] = fetchSpy.mock.calls[0] as [
      string,
      { redirect?: string },
    ];
    expect(options?.redirect).toBe("manual");
  });

  it("rejects an opaque redirect without following it", async () => {
    fetchSpy.mockResolvedValue({
      type: "opaqueredirect",
      status: 0,
      headers: { get: () => null },
      json: async () => ({}),
    } as unknown as Response);
    await expect(obtainKeycloakToken(CREDS, 0)).rejects.toMatchObject({
      code: "OPENEMS_REDIRECT",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
