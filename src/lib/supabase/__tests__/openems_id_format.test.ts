/**
 * openems_id_format.test.ts
 *
 * The format CHECKs on stored OpenEMS ids (20261124160100):
 *   - edges_openems_edge_id_format on edges.openems_edge_id
 *   - devices_openems_component_id_format on devices.openems_component_id
 *
 * An id in the format is stored; one outside it is refused with
 * check_violation (23514) on insert and on update. Both constraints are NOT
 * VALID, so adding one does not scan existing rows, and an existing row
 * outside the format fails its next update.
 *
 * Prerequisites mirror the RLS suite (docs/setup.md § "RLS Tests").
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
  runAsDatabaseOwner,
} from "./rls.helpers";
import { OPENEMS_ID_PATTERN } from "@/lib/openems/ids";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

const FIXTURE = {
  orgId: "eeeeeeee-0e1d-4000-8000-000000000001",
  communityId: "eeeeeeee-0e1d-4000-8001-000000000001",
  microgridId: "eeeeeeee-0e1d-4000-8002-000000000001",
  edgeId: "eeeeeeee-0e1d-4000-8003-000000000001",
};

const OUTSIDE = [
  ["empty", ""],
  ["65 characters", "e".repeat(65)],
  ["a space inside", "edge 0"],
  ["a leading space", " edge0"],
  ["a slash", "meter0/ActivePower"],
  ["a comma", "a,b"],
  ["a non-ASCII letter", "édge0"],
  ["a trailing newline", "edge0\n"],
] as const;

desc("OpenEMS id format CHECKs (20261124160100)", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();

    const svc = await serviceClient();
    await cleanupTestData({ orgIds: [FIXTURE.orgId], userEmails: [] });

    const steps = [
      svc.from("organizations").insert({ id: FIXTURE.orgId, name: "Id Format Org" }),
      svc.from("communities").insert({
        id: FIXTURE.communityId,
        org_id: FIXTURE.orgId,
        name: "Id Format Community",
      }),
      svc.from("microgrids").insert({
        id: FIXTURE.microgridId,
        community_id: FIXTURE.communityId,
        name: "Id Format Microgrid",
        currency: "UGX",
      }),
      svc.from("edges").insert({
        id: FIXTURE.edgeId,
        microgrid_id: FIXTURE.microgridId,
        name: "Id Format Edge",
        openems_edge_id: "edge0",
      }),
    ];
    for (const step of steps) {
      const { error } = await step;
      if (error) throw new Error(`fixture: ${error.message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupTestData({ orgIds: [FIXTURE.orgId], userEmails: [] });
  }, 30_000);

  describe("edges.openems_edge_id", () => {
    it.each([
      "fems:edge_0.a-1",
      "SYNTHETIC-EDGE-550e8400-e29b-41d4-a716-446655440000",
      "e".repeat(64),
    ])("stores %s", async (id) => {
      const svc = await serviceClient();
      const { error } = await svc.from("edges").insert({
        microgrid_id: FIXTURE.microgridId,
        name: `Edge ${id}`,
        openems_edge_id: id,
      });
      expect(error).toBeNull();
    });

    it.each(OUTSIDE)("refuses an id that is %s with check_violation", async (_label, id) => {
      const svc = await serviceClient();
      const { error } = await svc.from("edges").insert({
        microgrid_id: FIXTURE.microgridId,
        name: `Refused edge ${JSON.stringify(id)}`,
        openems_edge_id: id,
      });
      expect(error?.code).toBe("23514");
      expect(error?.message).toContain("edges_openems_edge_id_format");
    });

    it("refuses an update to an id outside the format", async () => {
      const svc = await serviceClient();
      const { error } = await svc
        .from("edges")
        .update({ openems_edge_id: "edge 0" })
        .eq("id", FIXTURE.edgeId);
      expect(error?.code).toBe("23514");
    });
  });

  describe("devices.openems_component_id", () => {
    it.each(["meter0", "ess0", "pvInverter_1.a:b-c", "m".repeat(64)])(
      "stores %s",
      async (id) => {
        const svc = await serviceClient();
        const { error } = await svc.from("devices").insert({
          edge_id: FIXTURE.edgeId,
          name: `Device ${id}`,
          device_type: "consumption_meter",
          openems_component_id: id,
        });
        expect(error).toBeNull();
      }
    );

    it.each(OUTSIDE)("refuses an id that is %s with check_violation", async (_label, id) => {
      const svc = await serviceClient();
      const { error } = await svc.from("devices").insert({
        edge_id: FIXTURE.edgeId,
        name: `Refused device ${JSON.stringify(id)}`,
        device_type: "consumption_meter",
        openems_component_id: id,
      });
      expect(error?.code).toBe("23514");
      expect(error?.message).toContain("devices_openems_component_id_format");
    });

    it("refuses an update to an id outside the format", async () => {
      const svc = await serviceClient();
      const { data: device, error: insertError } = await svc
        .from("devices")
        .insert({
          edge_id: FIXTURE.edgeId,
          name: "Device to rename",
          device_type: "consumption_meter",
          openems_component_id: "meterRename0",
        })
        .select("id")
        .single();
      expect(insertError).toBeNull();
      const { error } = await svc
        .from("devices")
        .update({ openems_component_id: "meter/0" })
        .eq("id", device!.id);
      expect(error?.code).toBe("23514");
    });
  });

  it("both constraints are NOT VALID", () => {
    const query = runAsDatabaseOwner(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conname IN ('edges_openems_edge_id_format',
                          'devices_openems_component_id_format')
        ORDER BY conname`
    );
    expect(query.ok, query.output).toBe(true);
    expect(JSON.parse(query.stdout)).toEqual([
      { conname: "devices_openems_component_id_format", convalidated: false },
      { conname: "edges_openems_edge_id_format", convalidated: false },
    ]);
  });

  // Puts an edge id outside the format in place the way an older row holds
  // one (written before the constraint), re-adds the constraint as the
  // migration does, and checks the add succeeds and the row's next update
  // fails. The block always ends in an exception, so all of it rolls back.
  it("an existing row outside the format does not stop the constraint, and fails its next update", () => {
    const probe = runAsDatabaseOwner(
      [
        "DO $probe$",
        "BEGIN",
        "  ALTER TABLE public.edges DROP CONSTRAINT edges_openems_edge_id_format;",
        `  UPDATE public.edges SET openems_edge_id = 'old edge id' WHERE id = '${FIXTURE.edgeId}';`,
        "  ALTER TABLE public.edges ADD CONSTRAINT edges_openems_edge_id_format",
        `    CHECK (openems_edge_id ~ '${OPENEMS_ID_PATTERN.source}') NOT VALID;`,
        "  BEGIN",
        `    UPDATE public.edges SET name = 'Renamed' WHERE id = '${FIXTURE.edgeId}';`,
        "  EXCEPTION WHEN check_violation THEN",
        "    RAISE EXCEPTION 'probe: update refused';",
        "  END;",
        "  RAISE EXCEPTION 'probe: update accepted';",
        "END",
        "$probe$",
      ].join("\n")
    );
    expect(probe.ok).toBe(false);
    expect(probe.output).toContain("probe: update refused");
  });
});
