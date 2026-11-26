/**
 * GET /api/auth/discovery (#271): what `mgm login --url` is told. Only values
 * that are already public: the public Supabase URL (never the internal one)
 * and anon key, the OAuth endpoints under it, this site's code page, and each
 * listed client's id and kind, read with those two columns only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  order: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ from: mocks.from }),
}));

import { GET } from "../route";

const SERVICE_KEY = "service-role-secret";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_INTERNAL_URL", "http://kong:8000");
  vi.stubEnv("MGM_PUBLIC_SUPABASE_COOKIE_NAME", "sb-mgm-auth-token");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
  vi.stubEnv("MGM_APP_URL", "https://mgm.example.org");
  mocks.from.mockReturnValue({ select: mocks.select });
  mocks.select.mockReturnValue({ order: mocks.order });
  mocks.order.mockResolvedValue({
    data: [
      { client_id: "c-1", kind: "operator" },
      { client_id: "c-2", kind: "agent" },
    ],
    error: null,
  });
});

const get = (ip = "203.0.113.7") =>
  GET(new NextRequest("https://mgm.example.org/api/auth/discovery", { headers: { "x-forwarded-for": ip } }));

describe("GET /api/auth/discovery", () => {
  it("answers the public URL, anon key, endpoints, code page and listed clients, uncached", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      supabase_url: "https://abc.supabase.co",
      supabase_anon_key: "sb_publishable_test",
      authorize_url: "https://abc.supabase.co/auth/v1/oauth/authorize",
      token_url: "https://abc.supabase.co/auth/v1/oauth/token",
      redirect_uri: "https://mgm.example.org/oauth/code",
      clients: [
        { client_id: "c-1", kind: "operator" },
        { client_id: "c-2", kind: "agent" },
      ],
    });
  });

  it("reads mgm_clients with the id and kind only, and never sends the internal URL or the service key", async () => {
    const text = await (await get()).text();
    expect(mocks.from).toHaveBeenCalledWith("mgm_clients");
    expect(mocks.select).toHaveBeenCalledWith("client_id, kind");
    expect(text).not.toContain("kong");
    expect(text).not.toContain(SERVICE_KEY);
  });

  it("answers 500 without detail when the read fails", async () => {
    mocks.order.mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("relation");
  });

  it("refuses a burst from one address before reading", async () => {
    const ip = "198.51.100.23";
    for (let i = 0; i < 60; i++) expect((await get(ip)).status).toBe(200);
    mocks.from.mockClear();
    const res = await get(ip);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
