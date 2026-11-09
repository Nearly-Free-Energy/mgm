import { describe, expect, it, vi } from "vitest";
import { pickOrganization, selectOrganization, visibleOrganizations } from "../organization";
import { ORG_A, ORG_B, contextFor, managerOf, superAdmin, tableClient } from "./host-fakes";

const ORG_C = "e7100000-0000-4000-8000-000000000003";
const ORGS = [
  { id: ORG_A, name: "Org A" },
  { id: ORG_B, name: "Org B" },
];

describe("visibleOrganizations", () => {
  it("reads the organizations row-level security shows, by name, on a new client", async () => {
    const { client, calls } = tableClient({ organizations: { data: ORGS } });
    const newClient = vi.fn(async () => client);
    await expect(visibleOrganizations(contextFor([superAdmin()], newClient))).resolves.toEqual(ORGS);
    expect(newClient).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ table: "organizations", ops: [["select", ["id, name"]], ["order", ["name"]]] }]);
  });

  it("keeps only organizations the person's roles reach", async () => {
    const { client } = tableClient({ organizations: { data: [...ORGS, { id: ORG_C, name: "Org C", extra: 1 }] } });
    const ctx = contextFor([managerOf(ORG_B)], async () => client);
    await expect(visibleOrganizations(ctx)).resolves.toEqual([{ id: ORG_B, name: "Org B" }]);
  });

  it("throws when the organizations cannot be read, without the database's text", async () => {
    const { client } = tableClient({ organizations: { data: null, error: { message: "secret detail" } } });
    const read = visibleOrganizations(contextFor([superAdmin()], async () => client));
    await expect(read).rejects.toThrow("GUI host: organizations could not be read");
  });

  it("refuses a context hostContext did not issue", async () => {
    const copy = { ...contextFor([superAdmin()]) };
    await expect(visibleOrganizations(copy)).rejects.toThrow(/did not issue/);
  });
});

describe("pickOrganization", () => {
  it("prefers the path, then ?org=, then the last used, then the first", () => {
    expect(pickOrganization(ORGS, { fromPath: ORG_B, requested: ORG_A, preferred: ORG_A })).toBe(ORG_B);
    expect(pickOrganization(ORGS, { requested: ORG_B, preferred: ORG_A })).toBe(ORG_B);
    expect(pickOrganization(ORGS, { preferred: ORG_B })).toBe(ORG_B);
    expect(pickOrganization(ORGS, {})).toBe(ORG_A);
  });

  it("ignores a hint the person cannot see or that is not a UUID", () => {
    expect(pickOrganization(ORGS, { requested: ORG_C, preferred: ORG_B })).toBe(ORG_B);
    expect(pickOrganization(ORGS, { requested: "org-b", fromPath: `${ORG_B} ` })).toBe(ORG_B);
    expect(pickOrganization(ORGS, { requested: ORG_B.toUpperCase() })).toBe(ORG_B);
    expect(pickOrganization([], { requested: ORG_A })).toBeNull();
  });
});

describe("selectOrganization", () => {
  it("returns the choice with the organizations it chose from", async () => {
    const { client } = tableClient({ organizations: { data: ORGS } });
    const ctx = contextFor([managerOf(ORG_A)], async () => client);
    await expect(selectOrganization(ctx, { requested: ORG_B })).resolves.toEqual({
      organizationId: ORG_A,
      organizations: [{ id: ORG_A, name: "Org A" }],
    });
  });
});
