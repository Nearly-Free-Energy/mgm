import { describe, expect, it } from "vitest";
import { secretMatches } from "../constant-time";

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
});
