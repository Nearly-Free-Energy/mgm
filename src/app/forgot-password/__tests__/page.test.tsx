import { describe, expect, it, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn(() => {
  throw new Error("NEXT_REDIRECT");
}));
vi.mock("next/navigation", () => ({ redirect }));

import Page from "../page";

describe("/forgot-password", () => {
  it("sends people on to sign-in by email link", () => {
    expect(() => Page()).toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});
