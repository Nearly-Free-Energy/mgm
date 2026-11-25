import { timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretMatches } from "../constant-time";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

describe("secretMatches", () => {
  it("accepts the same secret", () => {
    expect(secretMatches("test-worker-secret", "test-worker-secret")).toBe(true);
  });

  it("refuses a value of the same length that differs", () => {
    expect(secretMatches("test-worker-secret", "test-worker-secreT")).toBe(false);
  });

  it("refuses a shorter or longer value", () => {
    expect(secretMatches("test-worker-secret", "test")).toBe(false);
    expect(secretMatches("test-worker-secret", "test-worker-secret-and-more")).toBe(false);
  });

  it("refuses a missing value", () => {
    expect(secretMatches("test-worker-secret", "")).toBe(false);
    expect(secretMatches("test-worker-secret", null)).toBe(false);
    expect(secretMatches("test-worker-secret", undefined)).toBe(false);
  });

  it("never matches when no secret is configured", () => {
    expect(secretMatches("", "")).toBe(false);
    expect(secretMatches("", null)).toBe(false);
  });

  it("compares the full UTF-8 value, not a prefix", () => {
    expect(secretMatches("sécret", "sécret")).toBe(true);
    expect(secretMatches("sécret", "secret")).toBe(false);
  });

  describe("runs timingSafeEqual on two 32-byte digests for every value", () => {
    beforeEach(() => {
      vi.mocked(timingSafeEqual).mockClear();
    });

    it.each([
      ["the same value", "test-worker-secret", "test-worker-secret"],
      ["a longer value", "test-worker-secret", "test-worker-secret-and-more"],
      ["a shorter value", "test-worker-secret", "test"],
      ["a missing value", "test-worker-secret", null],
      ["no configured secret", "", "test-worker-secret"],
    ])("%s", (_label, expected, provided) => {
      secretMatches(expected, provided);
      expect(vi.mocked(timingSafeEqual)).toHaveBeenCalledTimes(1);
      const lengths = vi
        .mocked(timingSafeEqual)
        .mock.calls[0].map((buffer) => (buffer as Uint8Array).byteLength);
      expect(lengths).toEqual([32, 32]);
    });
  });
});
