/**
 * meter_readings_insert_only.test.ts — #35, migration 20261124120000.
 *
 * Asserts against a live local Supabase that signed-in users insert meter
 * readings and never update or delete one, super admins included, and that
 * deleting an edge still removes its meter's readings.
 *
 * The rule is the authenticated role's table privileges, so these tests go
 * through PostgREST with each user's own token rather than through a route.
 *
 * Fixture:
 *   ORG ─ community ─ microgrid ─ edge ─ device (consumption meter)
 *
 *   SA  — super_admin
 *   MGR — org_manager @ ORG
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase. The
 * `Test` gate starts its own Supabase and runs this file on every PR.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  createTestUser,
  cleanupTestData,
  runAsDatabaseOwner,
  type TestUser,
} from "./rls.helpers";

const FIXTURE = {
  org: "35350000-aaaa-4000-8000-000000000001",
  community: "35351111-aaaa-4000-8000-000000000001",
  microgrid: "35352222-aaaa-4000-8000-000000000001",
  edge: "35353333-aaaa-4000-8000-000000000001",
  device: "35354444-aaaa-4000-8000-000000000001",
};

const emails = ["readings35-sa@test.local", "readings35-mgr@test.local"];

let SA: TestUser, MGR: TestUser;

const skip = shouldSkip();

function ownerRows<T>(sql: string): T[] {
  const result = runAsDatabaseOwner(sql);
  if (!result.ok) throw new Error(`[owner query] ${result.output}`);
  return JSON.parse(result.stdout) as T[];
}

/** Inserts a reading with the service client and returns its id. */
async function seedReading(readingKwh: number, readAt: string): Promise<string> {
  const svc = await serviceClient();
  const { data, error } = await svc
    .from("meter_readings")
    .insert({ device_id: FIXTURE.device, reading_kwh: readingKwh, read_at: readAt })
    .select("id")
    .single();
  if (error) throw new Error(`[fixture] reading: ${error.message}`);
  return data.id as string;
}

async function storedReading(id: string): Promise<number | null> {
  const svc = await serviceClient();
  const { data } = await svc
    .from("meter_readings")
    .select("reading_kwh")
    .eq("id", id)
    .maybeSingle();
  return data === null ? null : Number(data.reading_kwh);
}

beforeAll(async () => {
  if (skip) return;
  await assertEnvironmentReady();

  await cleanupTestData({ orgIds: [FIXTURE.org], userEmails: emails });

  const svc = await serviceClient();
  const must = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`[fixture] ${what}: ${error.message}`);
  };
  must(
    "org",
    (await svc.from("organizations").insert({ id: FIXTURE.org, name: "READINGS35 Org" })).error,
  );
  must(
    "community",
    (
      await svc
        .from("communities")
        .insert({ id: FIXTURE.community, org_id: FIXTURE.org, name: "READINGS35 Community" })
    ).error,
  );
  must(
    "microgrid",
    (
      await svc.from("microgrids").insert({
        id: FIXTURE.microgrid,
        community_id: FIXTURE.community,
        name: "READINGS35 Microgrid",
        currency: "UGX",
      })
    ).error,
  );
  must(
    "edge",
    (
      await svc.from("edges").insert({
        id: FIXTURE.edge,
        microgrid_id: FIXTURE.microgrid,
        name: "READINGS35 Edge",
        openems_edge_id: "readings35-edge",
      })
    ).error,
  );
  must(
    "device",
    (
      await svc.from("devices").insert({
        id: FIXTURE.device,
        edge_id: FIXTURE.edge,
        name: "READINGS35 Meter",
        device_type: "consumption_meter",
        openems_component_id: "readings35-meter",
      })
    ).error,
  );

  SA = await createTestUser({ email: emails[0], role: "super_admin", scopeId: null });
  MGR = await createTestUser({ email: emails[1], role: "org_manager", scopeId: FIXTURE.org });
});

afterAll(async () => {
  if (skip) return;
  await cleanupTestData({ orgIds: [FIXTURE.org], userEmails: emails });
});

describe("meter_readings: signed-in users insert and never change or remove (#35)", () => {
  it("the authenticated role holds SELECT and INSERT only, and anon holds nothing", () => {
    if (skip) return;
    // has_any_column_privilege also sees a column-level grant, which
    // has_table_privilege misses. A comma-separated list is true if any
    // privilege in it is held.
    const rows = ownerRows<Record<string, boolean>>(
      `SELECT has_table_privilege('authenticated', 'public.meter_readings', 'SELECT') AS select,
              has_table_privilege('authenticated', 'public.meter_readings', 'INSERT') AS insert,
              has_table_privilege('authenticated', 'public.meter_readings', 'UPDATE') AS update,
              has_any_column_privilege('authenticated', 'public.meter_readings', 'UPDATE') AS column_update,
              has_table_privilege('authenticated', 'public.meter_readings', 'DELETE') AS delete,
              has_table_privilege('authenticated', 'public.meter_readings', 'TRUNCATE') AS truncate,
              has_table_privilege('anon', 'public.meter_readings',
                'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') AS anon_any,
              has_any_column_privilege('anon', 'public.meter_readings',
                'SELECT, INSERT, UPDATE') AS anon_any_column`,
    );
    expect(rows).toEqual([
      {
        select: true,
        insert: true,
        update: false,
        column_update: false,
        delete: false,
        truncate: false,
        anon_any: false,
        anon_any_column: false,
      },
    ]);
  });

  it("an org manager inserts a reading for a meter in their organization and reads it back", async () => {
    if (skip) return;
    const { data, error } = await MGR.client
      .from("meter_readings")
      .insert({
        device_id: FIXTURE.device,
        reading_kwh: 120.5,
        read_at: "2026-11-01T00:00:00Z",
      })
      .select("id, reading_kwh")
      .single();

    expect(error).toBeNull();
    expect(Number(data?.reading_kwh)).toBe(120.5);
  });

  it("an org manager cannot update or delete a reading", async () => {
    if (skip) return;
    const id = await seedReading(200, "2026-11-02T00:00:00Z");

    const update = await MGR.client
      .from("meter_readings")
      .update({ reading_kwh: 1 })
      .eq("id", id);
    expect(update.error?.code).toBe("42501");

    const del = await MGR.client.from("meter_readings").delete().eq("id", id);
    expect(del.error?.code).toBe("42501");

    expect(await storedReading(id)).toBe(200);
  });

  it("nor can a super admin", async () => {
    if (skip) return;
    const id = await seedReading(300, "2026-11-03T00:00:00Z");

    const update = await SA.client
      .from("meter_readings")
      .update({ reading_kwh: 1 })
      .eq("id", id);
    expect(update.error?.code).toBe("42501");

    const del = await SA.client.from("meter_readings").delete().eq("id", id);
    expect(del.error?.code).toBe("42501");

    expect(await storedReading(id)).toBe(300);
  });

  // Keep this test last: it deletes the fixture's edge, device and readings,
  // which the tests above need.
  //
  // fn_entity_delete_edge is SECURITY INVOKER (20260926130210), so its
  // DELETE on edges runs as the org manager and the cascade is the session
  // user's own delete path. If the function becomes SECURITY DEFINER, this
  // only shows that a definer path cascades.
  it("deleting the edge still removes its meter's readings", async () => {
    if (skip) return;
    const id = await seedReading(400, "2026-11-04T00:00:00Z");

    const { data: deleted, error } = await MGR.client.rpc("fn_entity_delete_edge", {
      p_id: FIXTURE.edge,
    });
    expect(error).toBeNull();
    expect(deleted).toBe(1);

    expect(await storedReading(id)).toBeNull();
    const svc = await serviceClient();
    const { count } = await svc
      .from("meter_readings")
      .select("id", { count: "exact", head: true })
      .eq("device_id", FIXTURE.device);
    expect(count).toBe(0);
  });
});
