import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  compose: vi.fn(),
  dispose: vi.fn(),
  testConnection: vi.fn(),
  from: vi.fn(),
  getEmsConfig: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("@/lib/metering/compose", () => ({
  composeMetering: (...args: unknown[]) => mocks.compose(...args),
}));
vi.mock("@/lib/openems/config", () => ({
  getMicrogridEmsConfig: mocks.getEmsConfig,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mocks.from }),
}));

const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const ORG_ID = "660e8400-e29b-41d4-a716-446655440099";

function wireMicrogrid() {
  mocks.from.mockImplementation(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { id: MG_ID, communities: { org_id: ORG_ID } },
          error: null,
        }),
      }),
    }),
  }));
}

function wireCapability() {
  mocks.compose.mockResolvedValue({
    ok: true,
    data: {
      metering: { testConnection: mocks.testConnection },
      dispose: mocks.dispose,
    },
  });
}

function makePost(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/microgrids/${MG_ID}/openems-backend/test`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

const CANDIDATE = {
  type: "direct_url",
  backendUrl: "http://localhost:8075",
};

describe("POST openems-backend/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireMicrogrid();
    wireCapability();
  });

  it("400 on malformed microgrid id", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePost(CANDIDATE), {
      params: Promise.resolve({ id: "bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 when the microgrid is hidden or missing", async () => {
    mocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }));
    const { POST } = await import("../route");
    const res = await POST(makePost(CANDIDATE), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(404);
    expect(mocks.compose).not.toHaveBeenCalled();
  });

  it("maps composition failures and disposes nothing", async () => {
    mocks.compose.mockResolvedValue({
      ok: false,
      status: 403,
      code: "metering_forbidden",
      message: "Nope.",
    });
    const { POST } = await import("../route");
    const res = await POST(makePost(CANDIDATE), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(403);
    expect(mocks.testConnection).not.toHaveBeenCalled();
  });

  it("returns the test result with 200 and disposes", async () => {
    mocks.testConnection.mockResolvedValue({
      ok: true,
      data: { ok: true, edgeCount: 2, edges: [] },
    });
    const { POST } = await import("../route");
    const res = await POST(makePost(CANDIDATE), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, edgeCount: 2, edges: [] });
    expect(mocks.testConnection).toHaveBeenCalledWith(MG_ID, {
      type: "direct_url",
      backendUrl: "http://localhost:8075",
      region: null,
      accessKeyId: null,
      secretAccessKey: null,
      basicAuthUsername: null,
      basicAuthPassword: null,
      bearerToken: null,
    });
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it("maps candidate validation failures", async () => {
    mocks.testConnection.mockResolvedValue({
      ok: false,
      status: 422,
      code: "metering_invalid_body",
      message: "Bad candidate.",
    });
    const { POST } = await import("../route");
    const res = await POST(makePost({ type: "nope" }), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(422);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it("fills omitted secrets from the stored config of the same type", async () => {
    mocks.getEmsConfig.mockResolvedValue({
      type: "direct_url",
      url: "http://localhost:8075",
      username: "openems",
      password: "stored-secret",
    });
    mocks.testConnection.mockResolvedValue({
      ok: true,
      data: { ok: true, edgeCount: 1, edges: [] },
    });
    const { POST } = await import("../route");
    const res = await POST(
      makePost({ type: "direct_url", backendUrl: "http://localhost:8075" }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(200);
    expect(mocks.testConnection).toHaveBeenCalledWith(MG_ID, {
      type: "direct_url",
      backendUrl: "http://localhost:8075",
      region: null,
      accessKeyId: null,
      secretAccessKey: null,
      basicAuthUsername: "openems",
      basicAuthPassword: "stored-secret",
      bearerToken: null,
    });
  });

  it("does not merge secrets across types", async () => {
    mocks.getEmsConfig.mockResolvedValue({
      type: "cloud_aws",
      url: "https://x",
      region: "us-east-1",
      accessKeyId: "AKIA",
      secretAccessKey: "stored-aws-secret",
    });
    mocks.testConnection.mockResolvedValue({
      ok: true,
      data: { ok: true, edgeCount: 0, edges: [] },
    });
    const { POST } = await import("../route");
    await POST(
      makePost({ type: "direct_url", backendUrl: "http://localhost:8075" }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(mocks.testConnection).toHaveBeenCalledWith(MG_ID, {
      type: "direct_url",
      backendUrl: "http://localhost:8075",
      region: null,
      accessKeyId: null,
      secretAccessKey: null,
      basicAuthUsername: null,
      basicAuthPassword: null,
      bearerToken: null,
    });
  });

  it("fills an omitted bearer token from the stored config", async () => {
    mocks.getEmsConfig.mockResolvedValue({
      type: "direct_url",
      url: "http://localhost:8075",
      token: "stored-bearer",
    });
    mocks.testConnection.mockResolvedValue({
      ok: true,
      data: { ok: true, edgeCount: 1, edges: [] },
    });
    const { POST } = await import("../route");
    const res = await POST(
      makePost({ type: "direct_url", backendUrl: "http://localhost:8075" }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(200);
    expect(mocks.testConnection).toHaveBeenCalledWith(MG_ID, {
      type: "direct_url",
      backendUrl: "http://localhost:8075",
      region: null,
      accessKeyId: null,
      secretAccessKey: null,
      basicAuthUsername: null,
      basicAuthPassword: null,
      bearerToken: "stored-bearer",
    });
  });
});
