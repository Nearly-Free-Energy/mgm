import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const checkGate = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({ checkGate: (...args: unknown[]) => checkGate(...args) }));

import { pluginGate, unitPluginGate } from "../gate-state";
import { ORG_A, ORG_B, contextFor, managerOf, superAdmin, tenantOf } from "./host-fakes";

const UNIT_A = "e7400000-0000-4000-8000-00000000000a";
const UNIT_B = "e7400000-0000-4000-8000-00000000000b";

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

  it("refuses a person whose rows are all tenant rows, whatever organization their units are in", () => {
    const newClient = vi.fn();
    expect(() => pluginGate(contextFor([tenantOf(UNIT_A)], newClient), ORG_A)).toThrow(/cannot access/);
    expect(newClient).not.toHaveBeenCalled();
    expect(checkGate).not.toHaveBeenCalled();
  });

  it("refuses a context hostContext did not issue", () => {
    const newClient = vi.fn();
    const forged = { ...contextFor([managerOf(ORG_A)], newClient) };
    expect(() => pluginGate(forged, ORG_A)).toThrow(/did not issue/);
    expect(newClient).not.toHaveBeenCalled();
  });
});

describe("unitPluginGate", () => {
  it("asks the gate about the unit's organization, as pluginGate asks, on the tenant's own new client", async () => {
    const client = {} as SupabaseClient;
    const newClient = vi.fn(async () => client);
    checkGate.mockResolvedValue({ ok: false, status: 409, code: "tenant_app_disabled", message: "Off." });
    const gate = unitPluginGate(contextFor([tenantOf(UNIT_A)], newClient), { tenantId: UNIT_A, organizationId: ORG_A });
    await expect(gate("tenant-app")).resolves.toMatchObject({ ok: false, code: "tenant_app_disabled" });
    await gate("tenant-app");
    expect(newClient).toHaveBeenCalledTimes(1);
    expect(checkGate).toHaveBeenCalledTimes(1);
    expect(checkGate).toHaveBeenCalledWith(client, {
      plugin: "tenant-app",
      target: { kind: "organization", id: ORG_A },
      method: "GET",
      access: "write",
    });
  });

  it("refuses a unit the caller holds no tenant row for, staff rows included", () => {
    expect(() => unitPluginGate(contextFor([tenantOf(UNIT_A)]), { tenantId: UNIT_B, organizationId: ORG_A })).toThrow(/does not hold/);
    expect(() => unitPluginGate(contextFor([managerOf(ORG_A)]), { tenantId: UNIT_A, organizationId: ORG_A })).toThrow(/does not hold/);
    expect(() => unitPluginGate(contextFor([superAdmin()]), { tenantId: UNIT_A, organizationId: ORG_A })).toThrow(/does not hold/);
    expect(checkGate).not.toHaveBeenCalled();
  });

  it("refuses a context hostContext did not issue", () => {
    const forged = { ...contextFor([tenantOf(UNIT_A)]) };
    expect(() => unitPluginGate(forged, { tenantId: UNIT_A, organizationId: ORG_A })).toThrow(/did not issue/);
  });
});
