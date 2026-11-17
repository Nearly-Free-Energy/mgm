import { describe, expect, it, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn(() => {
  throw new Error("NEXT_REDIRECT");
}));
vi.mock("next/navigation", () => ({ redirect }));

import AcceptInvitePage from "../page";

describe("/accept-invite", () => {
  it("sends earlier invitation links on to sign-in by email link", () => {
    expect(() => AcceptInvitePage()).toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});
