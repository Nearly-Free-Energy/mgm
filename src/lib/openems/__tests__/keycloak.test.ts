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
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchSpy);
    _resetKeycloakTokenCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
});
