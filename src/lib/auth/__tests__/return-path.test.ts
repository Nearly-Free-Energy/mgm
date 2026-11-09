import { describe, it, expect } from "vitest";
import { returnPathFor, safeReturnPath } from "../return-path";

describe("safeReturnPath", () => {
  it.each([
    ["/communities", "/communities"],
    ["/microgrids/m1/operations?date=2026-11-08", "/microgrids/m1/operations?date=2026-11-08"],
    ["/billing#period", "/billing#period"],
    ["/a/../communities", "/communities"],
  ])("follows the same-site path %s", (value, expected) => {
    expect(safeReturnPath(value)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["communities"],
    ["https://evil.example/"],
    ["http:/evil.example"],
    ["javascript:alert(1)"],
    ["//evil.example/"],
    ["/\\evil.example"],
    ["/\t/evil.example"],
    ["/\n/evil.example"],
    ["/ /evil.example"],
    ["/.//evil.example"],
    ["/%2F/evil.example/../.."],
    ["/login"],
    ["/login?next=/communities"],
  ])("goes to the start page for %j", (value) => {
    const result = safeReturnPath(value);
    expect(result).toBe("/");
  });

  it("never returns something a browser reads as another host", () => {
    for (const value of ["/.//x", "/./\\x", "/%5C/x", "/%2F%2Fx"]) {
      const result = safeReturnPath(value);
      expect(new URL(result, "https://mgm.example").origin).toBe("https://mgm.example");
    }
  });
});

describe("returnPathFor", () => {
  it("keeps the path and its query", () => {
    expect(returnPathFor("/microgrids/m1/operations", "?date=2026-11-08")).toBe(
      "/microgrids/m1/operations?date=2026-11-08",
    );
  });

  it("has nothing to return to for the start page", () => {
    expect(returnPathFor("/", "")).toBeNull();
  });
});
