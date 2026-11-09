import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const checkGate = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({ checkGate: (...args: unknown[]) => checkGate(...args) }));

import { pluginGate } from "../gate-state";
import { ORG_A, ORG_B, contextFor, managerOf } from "./host-fakes";

beforeEach(() => {
  checkGate.mockReset();
});

describe("pluginGate", () => {
  it("asks the gate as a write on the organization, once per plugin, on one new client", async () => {
    const client = {} as SupabaseClient;
    const newClient = vi.fn(async () => client);
    checkGate.mockImplementation(async (_supabase, { plugin }) =>
      plugin === "billing"
        ? { ok: false, status: 409, code: "billing_disabled", message: "Billing is disabled." }
        : { ok: true, organizationId: ORG_A },
    );
    const gate = pluginGate(contextFor([managerOf(ORG_A)], newClient), ORG_A);

    await expect(gate("billing")).resolves.toMatchObject({ ok: false, code: "billing_disabled" });
    await expect(gate("metering")).resolves.toEqual({ ok: true, organizationId: ORG_A });
    await gate("billing");

    expect(newClient).toHaveBeenCalledTimes(1);
    expect(checkGate).toHaveBeenCalledTimes(2);
    expect(checkGate).toHaveBeenCalledWith(client, {
      plugin: "billing",
      target: { kind: "organization", id: ORG_A },
      method: "GET",
      access: "write",
    });
  });

  it("opens no client until a plugin is asked about", () => {
    const newClient = vi.fn();
    pluginGate(contextFor([managerOf(ORG_A)], newClient), ORG_A);
    expect(newClient).not.toHaveBeenCalled();
  });

  it("passes the gate's 503 through", async () => {
    checkGate.mockResolvedValue({ ok: false, status: 503, code: "metering_gate_unavailable", message: "Retry." });
    await expect(pluginGate(contextFor([managerOf(ORG_A)]), ORG_A)("metering")).resolves.toMatchObject({
      status: 503,
    });
  });

  it("refuses an organization the caller's roles do not reach", () => {
    expect(() => pluginGate(contextFor([managerOf(ORG_A)]), ORG_B)).toThrow(/cannot access/);
    expect(checkGate).not.toHaveBeenCalled();
  });

  it("refuses a context hostContext did not issue", () => {
    const newClient = vi.fn();
    const forged = { ...contextFor([managerOf(ORG_A)], newClient) };
    expect(() => pluginGate(forged, ORG_A)).toThrow(/did not issue/);
    expect(newClient).not.toHaveBeenCalled();
  });
});
