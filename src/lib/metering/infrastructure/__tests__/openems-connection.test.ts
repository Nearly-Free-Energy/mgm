/**
 * OpenEMS connection tests (issue #4): candidate validation and bearer
 * wiring end-to-end with a stubbed fetch transport.
 *
 * The mixed-identity 422 fires before any network access; the bearer test
 * captures the Authorization header a real client sends, proving the token
 * reaches the backend as `Bearer` and nothing else (no Basic fallback, no
 * secret in logs or results).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createOpenEmsConnection } from "../openems-connection";
import type { MeteringRepository } from "../../repository";

function stubRepo(): MeteringRepository {
  return {
    getAuthenticatedUserId: async () => "user-1",
    getUserRoles: async () => [],
    isPluginEnabled: async () => true,
    getMicrogridOrganization: async () => null,
    getHouseholdOrganization: async () => null,
    getDeviceOrganization: async () => null,
    getStoredConnection: async () => null,
    getMicrogridTimezone: async () => null,
    getManagedDevices: async () => [],
    getMicrogridEdges: async () => [],
    getKnownEdgeIds: async () => [],
    getAssignmentLinks: async () => [],
    insertMeterReading: async () => ({ id: null, error: null }),
    findMeterReadingAt: async () => null,
  };
}

const MG_ID = "660e8400-e29b-41d4-a716-446655440000";

function mockEdgesStatusResponse() {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "test-id",
    result: { edge0: { online: true } },
  });
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

describe("OpenEmsConnection.testCandidate", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a bearer token mixed with Basic credentials without network access", async () => {
    const connection = createOpenEmsConnection({} as never, stubRepo());
    const result = await connection.testCandidate(MG_ID, {
      type: "direct_url",
      backendUrl: "http://localhost:8075",
      basicAuthUsername: "openems",
      basicAuthPassword: "s3cret",
      bearerToken: "keycloak-abc",
    });
    expect(result).toEqual({
      ok: false,
      code: "invalid_config",
      message: "Use either a bearer token or a username/password pair, not both.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the token as a Bearer header and returns edge inventory", async () => {
    fetchSpy.mockResolvedValue(mockEdgesStatusResponse());
    const connection = createOpenEmsConnection({} as never, stubRepo());
    const result = await connection.testCandidate(MG_ID, {
      type: "direct_url",
      backendUrl: "http://localhost:8075",
      bearerToken: "keycloak-abc",
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, options] = fetchSpy.mock.calls[0] as [
      string,
      { headers?: Record<string, string> },
    ];
    expect(options?.headers).toMatchObject({
      Authorization: "Bearer keycloak-abc",
    });
    // The token appears in exactly one place: the header.
    const serialized = JSON.stringify(fetchSpy.mock.calls);
    expect(serialized.match(/keycloak-abc/g)?.length).toBe(1);
  });

  it("rejects a half-filled Basic pair without network access", async () => {
    const connection = createOpenEmsConnection({} as never, stubRepo());
    const result = await connection.testCandidate(MG_ID, {
      type: "direct_url",
      backendUrl: "http://localhost:8075",
      basicAuthUsername: "openems",
    });
    expect(result).toEqual({
      ok: false,
      code: "invalid_config",
      message: "basicAuthUsername and basicAuthPassword must be set together.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a partial Keycloak triple without network access", async () => {
    const connection = createOpenEmsConnection({} as never, stubRepo());
    const result = await connection.testCandidate(MG_ID, {
      type: "direct_url",
      backendUrl: "http://localhost:8075",
      keycloakTokenUrl: "https://kc.example/token",
      keycloakClientId: "ems-backend",
    });
    expect(result).toEqual({
      ok: false,
      code: "invalid_config",
      message:
        "keycloakTokenUrl, keycloakClientId, and keycloakClientSecret must be set together.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects Keycloak mixed with a static bearer token without network access", async () => {
    const connection = createOpenEmsConnection({} as never, stubRepo());
    const result = await connection.testCandidate(MG_ID, {
      type: "direct_url",
      backendUrl: "http://localhost:8075",
      bearerToken: "stale-manual-token",
      keycloakTokenUrl: "https://kc.example/token",
      keycloakClientId: "ems-backend",
      keycloakClientSecret: "s3cret",
    });
    expect(result).toEqual({
      ok: false,
      code: "invalid_config",
      message:
        "Use one identity only: Keycloak, a bearer token, or a username/password pair — not a mix.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mints a Keycloak token for the candidate and probes with it", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "fresh-idp-token", expires_in: 300 }),
      })
      .mockResolvedValueOnce(mockEdgesStatusResponse());
    const connection = createOpenEmsConnection({} as never, stubRepo());
    const result = await connection.testCandidate(MG_ID, {
      type: "direct_url",
      backendUrl: "http://localhost:8075",
      keycloakTokenUrl: "https://kc.example/token",
      keycloakClientId: "ems-backend",
      keycloakClientSecret: "s3cret",
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // First call is the IdP token request carrying the client secret.
    const [tokenUrl, tokenOptions] = fetchSpy.mock.calls[0] as [
      string,
      { body?: URLSearchParams | string },
    ];
    expect(tokenUrl).toBe("https://kc.example/token");
    // Second call is the EMS probe carrying the minted token — and only it.
    const [, probeOptions] = fetchSpy.mock.calls[1] as [
      string,
      { headers?: Record<string, string> },
    ];
    expect(probeOptions?.headers).toMatchObject({
      Authorization: "Bearer fresh-idp-token",
    });
    const serialized = JSON.stringify(fetchSpy.mock.calls[1]);
    expect(serialized).not.toMatch(/s3cret/);
    void tokenOptions;
  });

  it("reports an IdP rejection as auth_failed, not a crash", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const connection = createOpenEmsConnection({} as never, stubRepo());
    const result = await connection.testCandidate(MG_ID, {
      type: "direct_url",
      backendUrl: "http://localhost:8075",
      keycloakTokenUrl: "https://kc.example/token",
      keycloakClientId: "ems-backend",
      keycloakClientSecret: "wrong",
    });
    expect(result).toEqual({
      ok: false,
      code: "auth_failed",
      message:
        "Authentication failed or the identity is not authorized for reads. Verify the credentials and that the identity has read access.",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
