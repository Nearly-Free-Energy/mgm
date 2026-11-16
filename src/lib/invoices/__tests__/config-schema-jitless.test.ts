/**
 * config-schema.ts turns off Zod's compiled parsers in the browser only:
 * their probe for `new Function` is a content security policy violation
 * there, and servers have no such policy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete z.config().jitless;
});

describe("config-schema's Zod setting", () => {
  it("sets jitless when loaded in a browser", async () => {
    delete z.config().jitless;
    vi.stubGlobal("window", {});
    vi.resetModules();
    await import("../config-schema");
    expect(z.config().jitless).toBe(true);
  });

  it("leaves servers on the compiled parsers", async () => {
    delete z.config().jitless;
    vi.resetModules();
    await import("../config-schema");
    expect(z.config().jitless).toBeUndefined();
  });
});
