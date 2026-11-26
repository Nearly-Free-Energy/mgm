/**
 * /oauth/code's metadata (#271, ADR-008 decision 3): the address carries the
 * code, so the page sends no referrer, and it is never indexed. Either one
 * dropped fails here.
 */
import { describe, expect, it } from "vitest";
import { metadata } from "../page";

describe("the sign-in code page's metadata", () => {
  it("sends no referrer and asks not to be indexed or followed", () => {
    expect(metadata.referrer).toBe("no-referrer");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
