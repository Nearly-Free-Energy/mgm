import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn(), select: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { organizationExists } from "../organization-exists";

describe("organizationExists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServiceClient.mockReturnValue({
      from: () => ({ select: mocks.select }),
    });
  });

  it("uses a privileged global existence check", async () => {
    mocks.select.mockReturnValue({
      limit: async () => ({ data: [{ id: "existing-org" }], error: null }),
    });
    expect(await organizationExists()).toBe(true);
    expect(mocks.createServiceClient).toHaveBeenCalledOnce();
    expect(mocks.select).toHaveBeenCalledWith("id");
  });

  it("recognizes a fresh installation", async () => {
    mocks.select.mockReturnValue({
      limit: async () => ({ data: [], error: null }),
    });
    expect(await organizationExists()).toBe(false);
  });

  it("fails closed when the global check fails", async () => {
    mocks.select.mockReturnValue({
      limit: async () => ({ data: null, error: { message: "unavailable" } }),
    });
    await expect(organizationExists()).rejects.toThrow("unavailable");
  });
});
