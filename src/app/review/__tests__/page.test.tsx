import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import ReviewRedirect from "../page";

describe("/review redirect", () => {
  it("redirects legacy review bookmarks to the management dashboard", () => {
    expect(() => ReviewRedirect()).toThrow("redirect:/");
    expect(mocks.redirect).toHaveBeenCalledWith("/");
  });
});
