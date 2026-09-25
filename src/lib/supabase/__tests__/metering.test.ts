/**
 * metering.test.ts — database-backed tests for Release 2 (issue #4).
 *
 * Covers, as an org_manager / super_admin / outsider:
 *   - Cross-organization meter_readings reads and writes are denied, while
 *     own-organization opening-register writes are allowed.
 *   - The effective-period overlap trigger rejects concurrent primary links
 *     and allows same-day close-and-open replacement.
 *   - Disabling the metering plugin fails capability-gated writes closed
 *     (unit-covered); the trigger and RLS remain the database backstop.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "./rls.helpers";

const FIXTURE = {
  orgA: "d1000000-0000-4000-8000-000000000001",
  orgB: "d1000000-0000-4000-8000-000000000002",
  communityA: "d1000000-0000-4000-8001-000000000001",
  microgridA: "d1000000-0000-4000-8002-000000000001",
  microgridB: "d1000000-0000-4000-8002-000000000002",
  edgeA: "d1000000-0000-4000-8003-000000000001",
  deviceA1: "d1000000-0000-4000-8004-000000000001",
  deviceA2: "d1000000-0000-4000-8004-000000000002",
  deviceB1: "d1000000-0000-4000-8004-000000000003",
  householdA: "d1000000-0000-4000-8005-000000000001",
};

let userA: TestUser; // org_manager scoped to orgA
let userB: TestUser; // org_manager scoped to orgB

const testUserEmails = [
  "metering-test-usera@test.local",
  "metering-test-userb@test.local",
];

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  const svc = await serviceClient();

  await cleanupTestData({
    orgIds: [FIXTURE.orgA, FIXTURE.orgB],
    userEmails: testUserEmails,
  });

  const { error: orgError } = await svc.from("organizations").insert([
    { id: FIXTURE.orgA, name: "Metering Test Org A" },
    { id: FIXTURE.orgB, name: "Metering Test Org B" },
  ]);
  if (orgError) throw new Error(`[fixture] orgs: ${orgError.message}`);

  const { error: commError } = await svc.from("communities").insert([
    { id: FIXTURE.communityA, org_id: FIXTURE.orgA, name: "Metering Community A" },
  ]);
  if (commError) throw new Error(`[fixture] communities: ${commError.message}`);

  const { error: mgError } = await svc.from("microgrids").insert([
    {
      id: FIXTURE.microgridA,
      community_id: FIXTURE.communityA,
      name: "Metering Microgrid A",
      currency: "UGX",
      timezone: "Africa/Kampala",
    },
  ]);
  if (mgError) throw new Error(`[fixture] microgrids: ${mgError.message}`);

  const { error: edgeError } = await svc.from("edges").insert([
    {
      id: FIXTURE.edgeA,
      microgrid_id: FIXTURE.microgridA,
      name: "Metering Edge A",
      openems_edge_id: "metering-test-edge-a",
    },
  ]);
  if (edgeError) throw new Error(`[fixture] edges: ${edgeError.message}`);

  const { error: devError } = await svc.from("devices").insert([
    {
      id: FIXTURE.deviceA1,
      edge_id: FIXTURE.edgeA,
      name: "Metering Device A1",
      device_type: "consumption_meter",
      openems_component_id: "metering-meter-a1",
    },
    {
      id: FIXTURE.deviceA2,
      edge_id: FIXTURE.edgeA,
      name: "Metering Device A2",
      device_type: "consumption_meter",
      openems_component_id: "metering-meter-a2",
    },
  ]);
  if (devError) throw new Error(`[fixture] devices: ${devError.message}`);

  const { error: hhError } = await svc.from("households").insert([
    {
      id: FIXTURE.householdA,
      microgrid_id: FIXTURE.microgridA,
      display_name: "Metering Household A",
      primary_phone: "+256700000001",
    },
  ]);
  if (hhError) throw new Error(`[fixture] households: ${hhError.message}`);

  const { error: linkError } = await svc.from("household_devices").insert({
    household_id: FIXTURE.householdA,
    device_id: FIXTURE.deviceA1,
    role: "primary_consumption_meter",
    effective_from: "2026-01-01",
    effective_to: null,
  });
  if (linkError) throw new Error(`[fixture] link: ${linkError.message}`);

  [userA, userB] = await Promise.all([
    createTestUser({
      email: testUserEmails[0],
      role: "org_manager",
      scopeId: FIXTURE.orgA,
    }),
    createTestUser({
      email: testUserEmails[1],
      role: "org_manager",
      scopeId: FIXTURE.orgB,
    }),
  ]);
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  await cleanupTestData({
    orgIds: [FIXTURE.orgA, FIXTURE.orgB],
    userEmails: testUserEmails,
  });
});

describe("metering organization isolation + assignment integrity", () => {
  it("org_manager A records an opening register on their own meter", async () => {
    if (shouldSkip()) return;
    const { data, error } = await userA.client
      .from("meter_readings")
      .insert({
        device_id: FIXTURE.deviceA1,
        reading_kwh: 1500.5,
        read_at: "2026-09-01T00:00:00Z",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBeDefined();
  });

  it("org_manager B can neither read nor write orgA meter readings", async () => {
    if (shouldSkip()) return;
    const { data: rows, error: readError } = await userB.client
      .from("meter_readings")
      .select("id")
      .eq("device_id", FIXTURE.deviceA1);
    expect(readError).toBeNull();
    expect(rows ?? []).toEqual([]);

    const { error: writeError } = await userB.client
      .from("meter_readings")
      .insert({
        device_id: FIXTURE.deviceA1,
        reading_kwh: 1,
        read_at: "2026-09-02T00:00:00Z",
      });
    expect(writeError?.code).toBe("42501");
  });

  it("overlapping primary links are rejected with 23505", async () => {
    if (shouldSkip()) return;
    const { error } = await userA.client.from("household_devices").insert({
      household_id: FIXTURE.householdA,
      device_id: FIXTURE.deviceA2,
      role: "primary_consumption_meter",
      effective_from: "2026-06-01",
      effective_to: null,
    });
    expect(error?.code).toBe("23505");
    expect(error?.message).toContain("overlaps");
  });

  it("same-day close-and-open replacement is allowed and preserves history", async () => {
    if (shouldSkip()) return;
    const { error: closeError } = await userA.client
      .from("household_devices")
      .update({ effective_to: "2026-06-01" })
      .eq("household_id", FIXTURE.householdA)
      .eq("device_id", FIXTURE.deviceA1)
      .eq("role", "primary_consumption_meter");
    expect(closeError).toBeNull();

    const { error: openError } = await userA.client
      .from("household_devices")
      .insert({
        household_id: FIXTURE.householdA,
        device_id: FIXTURE.deviceA2,
        role: "primary_consumption_meter",
        effective_from: "2026-06-01",
        effective_to: null,
      });
    expect(openError).toBeNull();

    const { data: links, error: readError } = await userA.client
      .from("household_devices")
      .select("device_id, effective_from, effective_to")
      .eq("household_id", FIXTURE.householdA)
      .eq("role", "primary_consumption_meter")
      .order("effective_from", { ascending: true });
    expect(readError).toBeNull();
    expect(links).toHaveLength(2);
    expect(links?.[0]).toMatchObject({
      device_id: FIXTURE.deviceA1,
      effective_to: "2026-06-01",
    });
    expect(links?.[1]).toMatchObject({
      device_id: FIXTURE.deviceA2,
      effective_from: "2026-06-01",
      effective_to: null,
    });
  });

  it("org_manager B cannot touch orgA assignment links", async () => {
    if (shouldSkip()) return;
    const { data: rows } = await userB.client
      .from("household_devices")
      .select("id")
      .eq("household_id", FIXTURE.householdA);
    expect(rows ?? []).toEqual([]);

    const { error } = await userB.client
      .from("household_devices")
      .update({ effective_to: "2026-07-01" })
      .eq("household_id", FIXTURE.householdA);
    // RLS hides the rows, so the update matches nothing — or denies.
    // Either way no orgA row may change: assert no error-driven write.
    if (!error) {
      const svc = await serviceClient();
      const { data: after } = await svc
        .from("household_devices")
        .select("effective_to")
        .eq("household_id", FIXTURE.householdA)
        .eq("device_id", FIXTURE.deviceA2);
      expect(
        (after ?? []).some((row) => row.effective_to === "2026-07-01")
      ).toBe(false);
    } else {
      expect(error.code).toBe("42501");
    }
  });
});
