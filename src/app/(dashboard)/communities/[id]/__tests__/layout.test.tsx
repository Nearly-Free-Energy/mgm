import { describe, it, expect, vi, beforeEach } from "vitest";
const { access, client, notFound } = vi.hoisted(() => ({
  access: vi.fn(), client: { from: vi.fn() },
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client }));
vi.mock("@/lib/auth/access", () => ({ currentUserCanAccessCommunity: access }));
vi.mock("next/navigation", () => ({ notFound }));
import CommunityLayout from "../layout";
describe("released community layout", () => {
  beforeEach(() => vi.clearAllMocks());
  it("renders an authorized community without querying unreleased payment schema", async () => {
    access.mockResolvedValue(true);
    const result = await CommunityLayout({ children: "management", params: Promise.resolve({ id: "community" }) });
    expect(access).toHaveBeenCalledWith(client, "community");
    expect(result.props.children).toBe("management");
    expect(client.from).not.toHaveBeenCalled();
  });
  it("denies inaccessible communities", async () => {
    access.mockResolvedValue(false);
    await expect(CommunityLayout({ children: "management", params: Promise.resolve({ id: "other" }) })).rejects.toThrow("NOT_FOUND");
    expect(client.from).not.toHaveBeenCalled();
  });
});
