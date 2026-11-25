/**
 * The twice-sent cases of the metering plugin's "safe" actions
 * (../repeat.db.test.ts), with their fixture: one organization, community
 * and microgrid, and an edge and device of its own for each case that
 * changes one, so no case reaches another's rows. Every case is sent as a
 * manager of the organization, the person the Edges and tenant pages are
 * offered to.
 *
 * None of these routes asks the vendor system: registering an edge, editing
 * or deleting one, saving or editing devices and recording an opening
 * register read and write only the database, and the test's fetch guard
 * holds them to the local Supabase. The two connection actions, which do
 * ask OpenEMS, are "unsafe" (src/lib/metering/surface.ts) and have no case;
 * if either becomes "safe", its case registers a stub as the billing module
 * registers a metering provider, before it can be sent.
 */
import { cleanupTestData, createTestUser, serviceClient } from "@/lib/supabase/__tests__/rls.helpers";
import type { CaseModule, Fixture } from "./harness";

const ORG = "e2790000-0000-4000-8000-000000000001";
const COMMUNITY = "e2790000-0000-4000-8001-000000000001";
const MG = "e2790000-0000-4000-8002-000000000001";
/** The edge each case changes, or whose devices it changes. */
const EDGE = {
  edit: "e2790000-0000-4000-8003-000000000001",
  delete: "e2790000-0000-4000-8003-000000000002",
  devices: "e2790000-0000-4000-8003-000000000003",
} as const;
const DEVICE = {
  edit: "e2790000-0000-4000-8004-000000000001",
  opening: "e2790000-0000-4000-8004-000000000002",
  /** On the edge that is deleted, so the delete takes a device and its reading with it. */
  deleted: "e2790000-0000-4000-8004-000000000003",
} as const;
const EMAILS = { manager: "repeat-metering-manager@test.local" };
const DELETED_EDGE_NAME = "Repeat edge to delete";

export const METERING_CASES: CaseModule = {
  cases: {
    // The edge is now registered with this name: 200, one updated with the same values.
    "metering.register-edges": [
      {
        as: "manager",
        params: { id: MG },
        body: () => ({ edges: [{ openems_edge_id: "repeat-metering-registered", name: "Repeat registered edge", role: "main" }] }),
        first: 200,
        second: 200,
      },
    ],
    // The edge already has this name and role: 200, the same row.
    "metering.edit-edge": [
      { as: "manager", params: { id: EDGE.edit }, body: () => ({ name: "Repeat edge renamed", role: "backup" }), first: 200, second: 200 },
    ],
    // The edge is gone: 404.
    "metering.delete-edge": [
      {
        as: "manager",
        params: { id: EDGE.delete },
        body: () => ({ confirmation: { acknowledged: [], typed: DELETED_EDGE_NAME } }),
        first: 204,
        second: 404,
      },
    ],
    // The device is saved with these values: 200, upserted onto the same row.
    "metering.save-devices": [
      {
        as: "manager",
        params: {},
        body: () => ({
          edgeId: EDGE.devices,
          devices: [{ componentId: "meter7", factoryId: "Meter.Socomec", openemsChannelAddress: null, deviceType: "consumption_meter", name: "Repeat meter 7" }],
        }),
        first: 200,
        second: 200,
      },
    ],
    // The device is already of this type and name: 200, the same row.
    "metering.edit-device": [
      { as: "manager", params: { id: DEVICE.edit }, body: () => ({ device_type: "grid_meter", name: "Repeat grid meter" }), first: 200, second: 200 },
    ],
    // A reading is already recorded for the meter at that time: 409 metering_duplicate_reading.
    "metering.record-opening-register": [
      {
        as: "manager",
        params: {},
        body: () => ({ device_id: DEVICE.opening, reading_kwh: 120.5, read_at: "2026-09-01T00:00:00.000Z" }),
        first: 201,
        second: 409,
      },
    ],
  },

  async cleanup() {
    await cleanupTestData({ orgIds: [ORG], userEmails: Object.values(EMAILS) });
  },

  async seed(): Promise<Fixture> {
    const svc = await serviceClient();
    const edge = (id: string, name: string, openems: string) => ({ id, microgrid_id: MG, name, openems_edge_id: openems });
    const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
      ["organizations", { id: ORG, name: "Repeat Metering Org" }],
      ["communities", { id: COMMUNITY, org_id: ORG, name: "Repeat Metering Community" }],
      ["microgrids", { id: MG, community_id: COMMUNITY, name: "Repeat Metering site", currency: "UGX", timezone: "Africa/Kampala" }],
      [
        "edges",
        [
          edge(EDGE.edit, "Repeat edge", "repeat-metering-edit"),
          edge(EDGE.delete, DELETED_EDGE_NAME, "repeat-metering-delete"),
          edge(EDGE.devices, "Repeat edge with devices", "repeat-metering-devices"),
        ],
      ],
      [
        "devices",
        [
          { id: DEVICE.edit, edge_id: EDGE.devices, name: "Repeat device", device_type: "pv_meter", openems_component_id: "meter2" },
          { id: DEVICE.opening, edge_id: EDGE.devices, name: "Repeat house meter", device_type: "consumption_meter", openems_component_id: "meter3" },
          { id: DEVICE.deleted, edge_id: EDGE.delete, name: "Repeat meter on the deleted edge", device_type: "consumption_meter", openems_component_id: "meter4" },
        ],
      ],
      ["meter_readings", { device_id: DEVICE.deleted, reading_kwh: 10, read_at: "2026-08-01T00:00:00.000Z" }],
    ];
    for (const [table, value] of rows) {
      const { error } = await svc.from(table).insert(value);
      if (error) throw new Error(`[repeat metering] ${table}: ${error.message}`);
    }
    return {
      orgId: ORG,
      users: { manager: await createTestUser({ email: EMAILS.manager, role: "org_manager", scopeId: ORG }) },
    };
  },
};
