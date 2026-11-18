import { describe, expect, it, vi } from "vitest";
import { readTenantUnits } from "../units";
import { ORG_A, ORG_B, contextFor, managerOf, superAdmin, tableClient, tenantHomes, tenantOf } from "./host-fakes";

const UNIT_A = "e7400000-0000-4000-8000-00000000000a";
const UNIT_B = "e7400000-0000-4000-8000-00000000000b";
const UNIT_GONE = "e7400000-0000-4000-8000-00000000000c";

describe("readTenantUnits", () => {
  it("reads each of the person's units with fn_tenant_home on one new client of their session, by label", async () => {
    const { client, calls } = tableClient(
      {},
      tenantHomes([
        { id: UNIT_A, name: "Shop 9", orgId: ORG_A, microgrid: "Kasana East", timezone: "Africa/Kampala" },
        { id: UNIT_B, name: "Grace Namata", unitLabel: " Unit 4 ", orgId: ORG_B, microgrid: "Kiwumu" },
      ]),
    );
    const newClient = vi.fn(async () => client);
    const units = await readTenantUnits(contextFor([tenantOf(UNIT_A), managerOf(ORG_A), tenantOf(UNIT_B.toUpperCase())], newClient));
    expect(units).toEqual([
      { tenantId: UNIT_B, label: "Grace Namata", unitLabel: "Unit 4", microgridName: "Kiwumu", timezone: "Africa/Kampala", organizationId: ORG_B },
      { tenantId: UNIT_A, label: "Shop 9", unitLabel: null, microgridName: "Kasana East", timezone: "Africa/Kampala", organizationId: ORG_A },
    ]);
    expect(newClient).toHaveBeenCalledTimes(1);
    // Nothing but the function, which is a tenant's only view of a microgrid or organization.
    expect(calls).toEqual([
      { table: "rpc:fn_tenant_home", ops: [["rpc", [{ _tenant_id: UNIT_A }]]] },
      { table: "rpc:fn_tenant_home", ops: [["rpc", [{ _tenant_id: UNIT_B }]]] },
    ]);
  });

  it("leaves out a unit the function no longer answers for", async () => {
    const { client } = tableClient({}, tenantHomes([{ id: UNIT_A, name: "Shop 9", orgId: ORG_A }]));
    const units = await readTenantUnits(contextFor([tenantOf(UNIT_A), tenantOf(UNIT_GONE)], async () => client));
    expect(units.map((u) => u.tenantId)).toEqual([UNIT_A]);
  });

  it("reads nothing for a person with no tenant row", async () => {
    const newClient = vi.fn();
    await expect(readTenantUnits(contextFor([managerOf(ORG_A), superAdmin()], newClient))).resolves.toEqual([]);
    expect(newClient).not.toHaveBeenCalled();
  });

  it("throws when a unit cannot be read, without the database's text", async () => {
    const { client } = tableClient({}, { fn_tenant_home: () => ({ data: null, error: { message: "secret detail" } }) });
    const error = await readTenantUnits(contextFor([tenantOf(UNIT_A)], async () => client)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("GUI host: a unit could not be read");
  });

  it("refuses a context hostContext did not issue", async () => {
    await expect(readTenantUnits({ ...contextFor([tenantOf(UNIT_A)]) })).rejects.toThrow(/did not issue/);
  });
});
