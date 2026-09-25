import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getUser: vi.fn(),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import DashboardLayout from "../layout";
import NoAccessPage from "../../no-access/page";

describe("MGM invited reviewer navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MGM_PILOT_SURFACE = "true";
    process.env.MGM_REVIEW_ALLOWED_EMAIL = "aaron.tushabe@nearlyfreeenergy.com";
    delete process.env.MGM_REVIEW_ALLOWED_USER_ID;
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "reviewer-1", email: "aaron.tushabe@nearlyfreeenergy.com" } },
    });
  });

  it("routes the invitation's root landing to review before the legacy MBE role query", async () => {
    await expect(DashboardLayout({ children: null })).rejects.toThrow("redirect:/review");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("recovers an allowlisted reviewer already on the legacy no-access page", async () => {
    await expect(NoAccessPage()).rejects.toThrow("redirect:/review");
  });

  it("does not redirect another authenticated user from no-access", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "other", email: "other@example.com" } },
    });
    await expect(NoAccessPage()).resolves.toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
