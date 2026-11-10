/**
 * save-config.test.ts — ordering invariant for saveEmsConfigForMicrogrid.
 *
 * The save runs on the service-role client, which bypasses RLS and the guard
 * trigger's access check. That makes `currentUserCanAccessMicrogrid` on the
 * caller's session the only authorization, so the assertion that matters is
 * "a caller without access never reaches the service client", the same shape
 * as config.test.ts asserts for the decrypt.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

let canAccess = true;
const accessCheck = vi.fn(async () => canAccess);
vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: (...args: unknown[]) =>
    (accessCheck as unknown as (...a: unknown[]) => unknown)(...args),
}));

const eq = vi.fn(async () => ({ error: null }));
const update = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ update }));
const createServiceClient = vi.fn(() => ({ from }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: (...args: unknown[]) =>
    (createServiceClient as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { saveEmsConfigForMicrogrid } from "../config";

const MICROGRID_ID = "00000000-0000-4000-8000-000000000020";
const USER_CLIENT = { marker: "user" } as unknown as SupabaseClient;

describe("saveEmsConfigForMicrogrid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccess = true;
  });

  it("refuses with 42501 and never builds the service client without access", async () => {
    canAccess = false;
    const result = await saveEmsConfigForMicrogrid(USER_CLIENT, MICROGRID_ID, {
      ems_backend_url: "https://ems.example/rest",
    });

    expect(result.error?.code).toBe("42501");
    expect(accessCheck).toHaveBeenCalledWith(USER_CLIENT, MICROGRID_ID);
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it("checks access on the caller's client, then writes on the service client", async () => {
    const payload = { ems_backend_url: "https://ems.example/rest" };
    const result = await saveEmsConfigForMicrogrid(
      USER_CLIENT,
      MICROGRID_ID,
      payload
    );

    expect(result.error).toBeNull();
    expect(accessCheck.mock.invocationCallOrder[0]).toBeLessThan(
      createServiceClient.mock.invocationCallOrder[0]
    );
    expect(from).toHaveBeenCalledWith("microgrids");
    expect(update).toHaveBeenCalledWith(payload);
    expect(eq).toHaveBeenCalledWith("id", MICROGRID_ID);
  });

  it("passes a database error through with its code", async () => {
    eq.mockResolvedValueOnce({
      error: { code: "23514", message: "check failed" },
    } as never);
    const result = await saveEmsConfigForMicrogrid(USER_CLIENT, MICROGRID_ID, {});
    expect(result.error).toEqual({ code: "23514", message: "check failed" });
  });
});
