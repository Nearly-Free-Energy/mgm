/**
 * grid_tariffs.test.ts (migration 20261106120000)
 *
 * Verifies, against a live local Supabase through PostgREST, the two tables
 * behind the Operations savings view:
 *   - an org manager of the microgrid's organization can create, read,
 *     change and delete grid_tariffs and microgrid_savings_settings rows;
 *   - an org manager of another organization sees none of them and cannot
 *     write them;
 *   - anon can neither read nor write either table;
 *   - a super admin can read and write both;
 *   - a microgrid has at most one tariff per effective_from date;
 *   - the bands shape check and the round_trip_efficiency range check hold;
 *   - the delete preview's counts (countEntityDescendants) see both tables,
 *     and both go with their microgrid when it is deleted.
 *
 * Self-fixturing; honors `SKIP_RLS_TESTS=1` for runs without local Supabase.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { countEntityDescendants } from "@/lib/entity-descendants";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
  createTestUser,
  testAnonKey,
  LOCAL_SUPABASE_URL,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[grid_tariffs] SKIP_RLS_TESTS=1 — skipping suite.");
}

const FIXTURE = {
  // The org manager's organization, with two microgrids: mgA for the access
  // cases and mgCascade for the counts and the cascade.
  orgA: "9a1d7a00-0000-4000-8000-00000000000a",
  commA: "9a1d7a00-0000-4000-8001-00000000000a",
  mgA: "9a1d7a00-0000-4000-8002-00000000000a",
  mgCascade: "9a1d7a00-0000-4000-8002-00000000000c",
  // Another organization, whose manager must see nothing of orgA's.
  orgB: "9a1d7a00-0000-4000-8000-00000000000b",
  commB: "9a1d7a00-0000-4000-8001-00000000000b",
  mgB: "9a1d7a00-0000-4000-8002-00000000000b",
};

const EMAIL_MANAGER_A = `gt-mgr-a-${Date.now()}@test.local`;
const EMAIL_MANAGER_B = `gt-mgr-b-${Date.now()}@test.local`;
const EMAIL_SUPER_ADMIN = `gt-super-${Date.now()}@test.local`;

/** A full day of two time-of-use bands, with neutral example rates. */
const BANDS = [
  { from_hour: 0, to_hour: 18, rate: 400 },
  { from_hour: 18, to_hour: 24, rate: 650 },
];

let managerA: TestUser;
let managerB: TestUser;
let superAdmin: TestUser;
let anon: SupabaseClient;

async function insertOrThrow(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await client.from(table).insert(rows as any);
  if (error) {
    throw new Error(`[grid_tariffs] fixture insert failed on ${table}: ${error.message}`);
  }
}

async function tariffCount(microgridId: string): Promise<number> {
  const svc = await serviceClient();
  const { count, error } = await svc
    .from("grid_tariffs")
    .select("id", { count: "exact", head: true })
    .eq("microgrid_id", microgridId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function settingsCount(microgridId: string): Promise<number> {
  const svc = await serviceClient();
  const { count, error } = await svc
    .from("microgrid_savings_settings")
    .select("microgrid_id", { count: "exact", head: true })
    .eq("microgrid_id", microgridId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** A refusal at the grant layer or by an RLS policy. */
function expectDenied(error: { code?: string; message?: string } | null) {
  expect(error).not.toBeNull();
  expect(
    error?.code === "42501" ||
      error?.message?.toLowerCase().includes("permission denied") ||
      error?.message?.toLowerCase().includes("row-level security"),
  ).toBe(true);
}

async function cleanupFixtures(): Promise<void> {
  await cleanupTestData({
    orgIds: [FIXTURE.orgA, FIXTURE.orgB],
    userEmails: [EMAIL_MANAGER_A, EMAIL_MANAGER_B, EMAIL_SUPER_ADMIN],
  });
}

desc("20261106120000_grid_tariffs_and_savings_settings.sql", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();

    await cleanupFixtures();

    await insertOrThrow(svc, "organizations", [
      { id: FIXTURE.orgA, name: "Grid Tariff Org A" },
      { id: FIXTURE.orgB, name: "Grid Tariff Org B" },
    ]);
    await insertOrThrow(svc, "communities", [
      { id: FIXTURE.commA, org_id: FIXTURE.orgA, name: "GT Comm A" },
      { id: FIXTURE.commB, org_id: FIXTURE.orgB, name: "GT Comm B" },
    ]);
    await insertOrThrow(svc, "microgrids", [
      { id: FIXTURE.mgA, community_id: FIXTURE.commA, name: "GT MG A", currency: "UGX" },
      { id: FIXTURE.mgCascade, community_id: FIXTURE.commA, name: "GT MG cascade", currency: "UGX" },
      { id: FIXTURE.mgB, community_id: FIXTURE.commB, name: "GT MG B", currency: "UGX" },
    ]);

    managerA = await createTestUser({
      email: EMAIL_MANAGER_A,
      role: "org_manager",
      scopeId: FIXTURE.orgA,
    });
    managerB = await createTestUser({
      email: EMAIL_MANAGER_B,
      role: "org_manager",
      scopeId: FIXTURE.orgB,
    });
    superAdmin = await createTestUser({ email: EMAIL_SUPER_ADMIN, role: "super_admin" });

    anon = createClient(LOCAL_SUPABASE_URL, testAnonKey() ?? "", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }, 60_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupFixtures();
  }, 60_000);

  // ── The microgrid's org manager ──────────────────────────────────────────

  it("the org manager creates, reads, changes and deletes a grid tariff", async () => {
    const { data: created, error: insertError } = await managerA.client
      .from("grid_tariffs")
      .insert({ microgrid_id: FIXTURE.mgA, effective_from: "2026-01-01", bands: BANDS })
      .select("id, bands")
      .single();
    expect(insertError).toBeNull();
    expect(created?.bands).toEqual(BANDS);
    const id = created!.id as string;

    const { data: read, error: readError } = await managerA.client
      .from("grid_tariffs")
      .select("id, effective_from")
      .eq("microgrid_id", FIXTURE.mgA);
    expect(readError).toBeNull();
    expect(read).toEqual([{ id, effective_from: "2026-01-01" }]);

    const changed = [{ from_hour: 0, to_hour: 24, rate: 550 }];
    const { data: updated, error: updateError } = await managerA.client
      .from("grid_tariffs")
      .update({ bands: changed })
      .eq("id", id)
      .select("bands");
    expect(updateError).toBeNull();
    expect(updated).toEqual([{ bands: changed }]);

    const { data: deleted, error: deleteError } = await managerA.client
      .from("grid_tariffs")
      .delete()
      .eq("id", id)
      .select("id");
    expect(deleteError).toBeNull();
    expect(deleted).toEqual([{ id }]);
    expect(await tariffCount(FIXTURE.mgA)).toBe(0);
  });

  it("the org manager creates, reads, changes and deletes the savings settings", async () => {
    const { data: created, error: insertError } = await managerA.client
      .from("microgrid_savings_settings")
      .insert({ microgrid_id: FIXTURE.mgA, solar_savings_from: "2026-02-01" })
      .select("solar_savings_from, arbitrage_from, round_trip_efficiency")
      .single();
    expect(insertError).toBeNull();
    // A start date left out means that saving is not counted; the
    // efficiency has a default.
    expect(created).toEqual({
      solar_savings_from: "2026-02-01",
      arbitrage_from: null,
      round_trip_efficiency: 0.9,
    });

    const { data: upserted, error: upsertError } = await managerA.client
      .from("microgrid_savings_settings")
      .upsert({
        microgrid_id: FIXTURE.mgA,
        solar_savings_from: "2026-02-01",
        arbitrage_from: "2026-03-01",
        round_trip_efficiency: 0.85,
      })
      .select("arbitrage_from, round_trip_efficiency");
    expect(upsertError).toBeNull();
    expect(upserted).toEqual([{ arbitrage_from: "2026-03-01", round_trip_efficiency: 0.85 }]);

    const { data: deleted, error: deleteError } = await managerA.client
      .from("microgrid_savings_settings")
      .delete()
      .eq("microgrid_id", FIXTURE.mgA)
      .select("microgrid_id");
    expect(deleteError).toBeNull();
    expect(deleted).toEqual([{ microgrid_id: FIXTURE.mgA }]);
    expect(await settingsCount(FIXTURE.mgA)).toBe(0);
  });

  // ── Another organization's manager ───────────────────────────────────────

  it("another organization's manager sees nothing and cannot write", async () => {
    const svc = await serviceClient();
    await insertOrThrow(svc, "grid_tariffs", {
      microgrid_id: FIXTURE.mgA,
      effective_from: "2026-04-01",
      bands: BANDS,
    });
    await insertOrThrow(svc, "microgrid_savings_settings", {
      microgrid_id: FIXTURE.mgA,
      solar_savings_from: "2026-04-01",
    });

    const tariffs = await managerB.client
      .from("grid_tariffs")
      .select("id")
      .eq("microgrid_id", FIXTURE.mgA);
    expect(tariffs.error).toBeNull();
    expect(tariffs.data).toEqual([]);
    const settings = await managerB.client
      .from("microgrid_savings_settings")
      .select("microgrid_id")
      .eq("microgrid_id", FIXTURE.mgA);
    expect(settings.error).toBeNull();
    expect(settings.data).toEqual([]);

    const insertTariff = await managerB.client
      .from("grid_tariffs")
      .insert({ microgrid_id: FIXTURE.mgA, effective_from: "2026-05-01", bands: BANDS });
    expectDenied(insertTariff.error);
    const insertSettings = await managerB.client
      .from("microgrid_savings_settings")
      .upsert({ microgrid_id: FIXTURE.mgA, arbitrage_from: "2026-05-01" });
    expectDenied(insertSettings.error);

    // Updates and deletes of rows it cannot see touch nothing.
    const updated = await managerB.client
      .from("grid_tariffs")
      .update({ bands: [{ from_hour: 0, to_hour: 24, rate: 1 }] })
      .eq("microgrid_id", FIXTURE.mgA)
      .select("id");
    expect(updated.data ?? []).toEqual([]);
    const deleted = await managerB.client
      .from("microgrid_savings_settings")
      .delete()
      .eq("microgrid_id", FIXTURE.mgA)
      .select("microgrid_id");
    expect(deleted.data ?? []).toEqual([]);

    // Nor can it move its own microgrid's row onto orgA's microgrid.
    await insertOrThrow(managerB.client, "grid_tariffs", {
      microgrid_id: FIXTURE.mgB,
      effective_from: "2026-04-01",
      bands: BANDS,
    });
    const moved = await managerB.client
      .from("grid_tariffs")
      .update({ microgrid_id: FIXTURE.mgA })
      .eq("microgrid_id", FIXTURE.mgB);
    expectDenied(moved.error);

    expect(await tariffCount(FIXTURE.mgA)).toBe(1);
    expect(await settingsCount(FIXTURE.mgA)).toBe(1);
    const { data: kept } = await svc
      .from("grid_tariffs")
      .select("bands")
      .eq("microgrid_id", FIXTURE.mgA);
    expect(kept).toEqual([{ bands: BANDS }]);
  });

  // ── anon ─────────────────────────────────────────────────────────────────

  it("anon can neither read nor write either table", async () => {
    // Rows from the previous case exist on mgA.
    const tariffs = await anon.from("grid_tariffs").select("id");
    expect(tariffs.error !== null || (tariffs.data ?? []).length === 0).toBe(true);
    if (tariffs.error) expectDenied(tariffs.error);
    const settings = await anon.from("microgrid_savings_settings").select("microgrid_id");
    expect(settings.error !== null || (settings.data ?? []).length === 0).toBe(true);
    if (settings.error) expectDenied(settings.error);

    expectDenied(
      (
        await anon
          .from("grid_tariffs")
          .insert({ microgrid_id: FIXTURE.mgA, effective_from: "2026-06-01", bands: BANDS })
      ).error,
    );
    expectDenied(
      (
        await anon
          .from("microgrid_savings_settings")
          .insert({ microgrid_id: FIXTURE.mgB, solar_savings_from: "2026-06-01" })
      ).error,
    );
  });

  // ── Super admin ──────────────────────────────────────────────────────────

  it("a super admin can read and write both tables", async () => {
    const tariffs = await superAdmin.client
      .from("grid_tariffs")
      .select("id")
      .in("microgrid_id", [FIXTURE.mgA, FIXTURE.mgB]);
    expect(tariffs.error).toBeNull();
    expect(tariffs.data).toHaveLength(2);

    const insertTariff = await superAdmin.client
      .from("grid_tariffs")
      .insert({ microgrid_id: FIXTURE.mgB, effective_from: "2026-07-01", bands: BANDS })
      .select("id")
      .single();
    expect(insertTariff.error).toBeNull();
    expect(insertTariff.data?.id).toBeTruthy();

    const upsertSettings = await superAdmin.client
      .from("microgrid_savings_settings")
      .upsert({ microgrid_id: FIXTURE.mgB, arbitrage_from: "2026-07-01" })
      .select("microgrid_id");
    expect(upsertSettings.error).toBeNull();
    expect(upsertSettings.data).toEqual([{ microgrid_id: FIXTURE.mgB }]);
  });

  // ── Constraints ──────────────────────────────────────────────────────────

  it("a microgrid has at most one tariff per effective_from date", async () => {
    await insertOrThrow(managerA.client, "grid_tariffs", {
      microgrid_id: FIXTURE.mgA,
      effective_from: "2026-08-01",
      bands: BANDS,
    });
    const duplicate = await managerA.client
      .from("grid_tariffs")
      .insert({ microgrid_id: FIXTURE.mgA, effective_from: "2026-08-01", bands: BANDS });
    expect(duplicate.error?.code).toBe("23505");

    // The same date on another microgrid is fine.
    await insertOrThrow(managerB.client, "grid_tariffs", {
      microgrid_id: FIXTURE.mgB,
      effective_from: "2026-08-01",
      bands: BANDS,
    });
  });

  it("bands must be an array of 1 to 24 bands", async () => {
    const tooMany = Array.from({ length: 25 }, (_, i) => ({
      from_hour: i,
      to_hour: i + 1,
      rate: 400,
    }));
    const full = Array.from({ length: 24 }, (_, i) => ({
      from_hour: i,
      to_hour: i + 1,
      rate: 400,
    }));
    const cases: { date: string; bands: unknown }[] = [
      { date: "2026-09-01", bands: { from_hour: 0, to_hour: 24, rate: 400 } },
      { date: "2026-09-02", bands: [] },
      { date: "2026-09-03", bands: tooMany },
      { date: "2026-09-04", bands: "0-24:400" },
    ];
    for (const { date, bands } of cases) {
      const { error } = await managerA.client
        .from("grid_tariffs")
        .insert({ microgrid_id: FIXTURE.mgA, effective_from: date, bands });
      expect(error?.code, `bands ${JSON.stringify(bands).slice(0, 40)}`).toBe("23514");
    }

    // 24 one-hour bands is the most allowed.
    await insertOrThrow(managerA.client, "grid_tariffs", {
      microgrid_id: FIXTURE.mgA,
      effective_from: "2026-09-05",
      bands: full,
    });
  });

  it("round_trip_efficiency must be above 0 and at most 1", async () => {
    for (const efficiency of [0, -0.5, 1.001, 1.5]) {
      const { error } = await managerA.client
        .from("microgrid_savings_settings")
        .update({ round_trip_efficiency: efficiency })
        .eq("microgrid_id", FIXTURE.mgA);
      expect(error?.code, `efficiency ${efficiency}`).toBe("23514");
    }
    const { data, error } = await managerA.client
      .from("microgrid_savings_settings")
      .update({ round_trip_efficiency: 1 })
      .eq("microgrid_id", FIXTURE.mgA)
      .select("round_trip_efficiency");
    expect(error).toBeNull();
    expect(data).toEqual([{ round_trip_efficiency: 1 }]);
  });

  // ── Delete preview counts and cascade ────────────────────────────────────

  it("the delete preview counts both tables, and both go with their microgrid", async () => {
    await insertOrThrow(managerA.client, "grid_tariffs", [
      { microgrid_id: FIXTURE.mgCascade, effective_from: "2026-01-01", bands: BANDS },
      { microgrid_id: FIXTURE.mgCascade, effective_from: "2026-06-01", bands: BANDS },
    ]);
    await insertOrThrow(managerA.client, "microgrid_savings_settings", {
      microgrid_id: FIXTURE.mgCascade,
      solar_savings_from: "2026-01-01",
    });

    const [microgrid, community, organization, otherOrg] = await Promise.all([
      countEntityDescendants(managerA.client, "microgrid", FIXTURE.mgCascade),
      countEntityDescendants(managerA.client, "community", FIXTURE.commA),
      countEntityDescendants(superAdmin.client, "organization", FIXTURE.orgA),
      // Another org's manager counts nothing it cannot see.
      countEntityDescendants(managerB.client, "microgrid", FIXTURE.mgCascade),
    ]);
    expect(microgrid).toMatchObject({
      kind: "microgrid",
      grid_tariffs: 2,
      microgrid_savings_settings: 1,
    });
    // mgA holds the 2026-04-01, 2026-08-01 and 2026-09-05 tariffs and one
    // settings row from the cases above.
    expect(community).toMatchObject({
      kind: "community",
      grid_tariffs: 5,
      microgrid_savings_settings: 2,
    });
    expect(organization).toMatchObject({
      kind: "organization",
      grid_tariffs: 5,
      microgrid_savings_settings: 2,
    });
    expect(otherOrg).toMatchObject({ grid_tariffs: 0, microgrid_savings_settings: 0 });

    const { error } = await managerA.client
      .from("microgrids")
      .delete()
      .eq("id", FIXTURE.mgCascade);
    expect(error).toBeNull();
    expect(await tariffCount(FIXTURE.mgCascade)).toBe(0);
    expect(await settingsCount(FIXTURE.mgCascade)).toBe(0);
  });
});
