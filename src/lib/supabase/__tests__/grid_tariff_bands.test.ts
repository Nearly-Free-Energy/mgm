/**
 * grid_tariff_bands.test.ts (migration 20261115110000)
 *
 * Verifies, against a live local Supabase, that the database refuses the
 * grid tariff bands the application refuses, with the application's own
 * message:
 *   - every single-fault case gets SQLSTATE 23514 and the message
 *     AddGridTariffBody gives for it (the route's schema, which wraps
 *     validateGridTariffBands);
 *   - valid bands are stored, in any order;
 *   - a JSON number is judged as written, and a rate beyond a double is
 *     refused;
 *   - an update that changes the bands is checked, one that leaves them
 *     alone is not, so a row stored before the check can still be moved;
 *   - no role is exempt: service_role and the table owner are refused too.
 *
 * Self-fixturing; honors `SKIP_RLS_TESTS=1` for runs without local Supabase.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AddGridTariffBody } from "@/lib/billing/schemas";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
  createTestUser,
  runAsDatabaseOwner,
  testAnonKey,
  LOCAL_SUPABASE_URL,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[grid_tariff_bands] SKIP_RLS_TESTS=1 — skipping suite.");
}

const FIXTURE = {
  org: "9a1d7b00-0000-4000-8000-00000000000a",
  comm: "9a1d7b00-0000-4000-8001-00000000000a",
  mg: "9a1d7b00-0000-4000-8002-00000000000a",
  legacy: "9a1d7b00-0000-4000-8003-00000000000a",
};

const EMAIL_MANAGER = `gtb-mgr-${Date.now()}@test.local`;

const SHAPE = "Each band needs a start hour, an end hour and a rate.";
const WHOLE = "Band hours must be whole hours.";
const HOURS = "Each band must start before it ends, between hour 0 and hour 24.";
const RATE = "Each band's rate must be a number of 0 or more.";
const COUNT = "A tariff needs between 1 and 24 bands.";

const band = (from_hour: unknown, to_hour: unknown, rate: unknown = 400) => ({
  from_hour,
  to_hour,
  rate,
});
const hourly = (n: number) => Array.from({ length: n }, (_, i) => band(i, i + 1));

/** Each case has one fault; `message` is what the application says about it. */
const REFUSED: { name: string; bands: unknown; message: string }[] = [
  { name: "an object, not a list", bands: band(0, 24), message: "Bands must be a list." },
  { name: "a string", bands: "0-24:400", message: "Bands must be a list." },
  { name: "no bands", bands: [], message: COUNT },
  { name: "25 bands", bands: Array.from({ length: 25 }, () => band(0, 1)), message: COUNT },
  { name: "a number for a band", bands: [5], message: SHAPE },
  { name: "null for a band", bands: [null], message: SHAPE },
  { name: "a list for a band", bands: [[0, 24, 400]], message: SHAPE },
  { name: "an extra key", bands: [{ ...band(0, 24), note: "peak" }], message: SHAPE },
  { name: "no from_hour", bands: [{ to_hour: 24, rate: 400 }], message: WHOLE },
  { name: "from_hour as a string", bands: [band("0", 24)], message: WHOLE },
  { name: "a fractional hour", bands: [band(0, 12.5), band(12.5, 24)], message: WHOLE },
  { name: "to_hour null", bands: [band(0, null)], message: WHOLE },
  { name: "an hour beyond 2^53", bands: [band(0, 2 ** 53)], message: WHOLE },
  { name: "a negative hour", bands: [band(-1, 24)], message: HOURS },
  { name: "hour 25", bands: [band(0, 25)], message: HOURS },
  { name: "an empty band", bands: [band(0, 12), band(12, 12), band(12, 24)], message: HOURS },
  { name: "a band that ends first", bands: [band(18, 6)], message: HOURS },
  { name: "no rate", bands: [{ from_hour: 0, to_hour: 24 }], message: RATE },
  { name: "the rate as a string", bands: [band(0, 24, "400")], message: RATE },
  { name: "a negative rate", bands: [band(0, 24, -1)], message: RATE },
  { name: "a gap", bands: [band(0, 10), band(12, 24)], message: "No band covers hour 10." },
  { name: "an overlap", bands: [band(0, 12), band(10, 24)], message: "Bands overlap at hour 10." },
  { name: "two bands from one hour", bands: [band(0, 10), band(0, 24)], message: "Bands overlap at hour 0." },
  { name: "a short day", bands: [band(0, 23)], message: "No band covers hour 23." },
  { name: "a late start", bands: [band(1, 24)], message: "No band covers hour 0." },
  {
    name: "an out-of-order gap",
    bands: [band(18, 24), band(0, 6), band(7, 18)],
    message: "No band covers hour 6.",
  },
];

let manager: TestUser;
let day = 0;

/** A fresh effective_from for every row, so no case trips the unique key. */
function nextDate(): string {
  day += 1;
  return new Date(Date.UTC(2027, 0, day)).toISOString().slice(0, 10);
}

/** What the application says about `bands`: null when it accepts them. */
function appMessage(bands: unknown): string | null {
  const parsed = AddGridTariffBody.safeParse({ effective_from: "2027-01-01", bands });
  return parsed.success ? null : parsed.error.issues[0].message;
}

/** POSTs a raw JSON body as the manager, for number literals JSON.stringify cannot write. */
async function insertRaw(bandsJson: string): Promise<{ status: number; code?: string; message?: string }> {
  const body = `{"microgrid_id":"${FIXTURE.mg}","effective_from":"${nextDate()}","bands":${bandsJson}}`;
  const res = await fetch(`${LOCAL_SUPABASE_URL}/rest/v1/grid_tariffs`, {
    method: "POST",
    headers: {
      apikey: testAnonKey() ?? "",
      Authorization: `Bearer ${manager.jwt}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body,
  });
  if (res.ok) return { status: res.status };
  const error = (await res.json()) as { code?: string; message?: string };
  return { status: res.status, code: error.code, message: error.message };
}

desc("20261115110000_grid_tariff_band_rules.sql", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();
    await cleanupTestData({ orgIds: [FIXTURE.org], userEmails: [EMAIL_MANAGER] });

    for (const [table, row] of [
      ["organizations", { id: FIXTURE.org, name: "Grid Tariff Bands Org" }],
      ["communities", { id: FIXTURE.comm, org_id: FIXTURE.org, name: "GTB Comm" }],
      ["microgrids", { id: FIXTURE.mg, community_id: FIXTURE.comm, name: "GTB MG", currency: "UGX" }],
    ] as const) {
      const { error } = await svc.from(table).insert(row);
      if (error) throw new Error(`[grid_tariff_bands] fixture insert failed on ${table}: ${error.message}`);
    }
    manager = await createTestUser({ email: EMAIL_MANAGER, role: "org_manager", scopeId: FIXTURE.org });
  }, 60_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupTestData({ orgIds: [FIXTURE.org], userEmails: [EMAIL_MANAGER] });
  }, 60_000);

  it.each(REFUSED)("refuses $name with the application's message", async ({ bands, message }) => {
    // The case list is the application's: if this fails, the list is stale.
    expect(appMessage(bands)).toBe(message);
    const { error } = await manager.client
      .from("grid_tariffs")
      .insert({ microgrid_id: FIXTURE.mg, effective_from: nextDate(), bands });
    expect(error?.code).toBe("23514");
    expect(error?.message).toBe(message);
  });

  it("stores valid bands, in any order", async () => {
    const cases = [
      [band(0, 24, 0)],
      [band(18, 24, 650), band(0, 18, 400)],
      [band(6, 18, 412.5), band(18, 24, 650), band(0, 6, 300)],
      hourly(24),
    ];
    for (const bands of cases) {
      expect(appMessage(bands)).toBeNull();
      const { data, error } = await manager.client
        .from("grid_tariffs")
        .insert({ microgrid_id: FIXTURE.mg, effective_from: nextDate(), bands })
        .select("bands")
        .single();
      expect(error, JSON.stringify(bands)).toBeNull();
      expect(data?.bands).toEqual(bands);
    }
  });

  it("judges a JSON number as written", async () => {
    // A whole number written with a decimal point is whole.
    expect(await insertRaw('[{"from_hour":0.0,"to_hour":18.0,"rate":400},{"from_hour":18,"to_hour":24,"rate":650}]')).toEqual({ status: 201 });
    // Too large for a double: Infinity to the application, so refused here.
    expect(await insertRaw('[{"from_hour":0,"to_hour":24,"rate":1e309}]')).toMatchObject({ code: "23514", message: RATE });
    expect(await insertRaw('[{"from_hour":0,"to_hour":1e400,"rate":400}]')).toMatchObject({ code: "23514", message: WHOLE });
    // The application rounds this hour to 1 and would accept it; the
    // database does not round, and refuses it.
    expect(
      await insertRaw('[{"from_hour":0,"to_hour":1.00000000000000000001,"rate":400},{"from_hour":1,"to_hour":24,"rate":400}]'),
    ).toMatchObject({ code: "23514", message: WHOLE });
  });

  it("checks an update that changes the bands", async () => {
    const { data, error } = await manager.client
      .from("grid_tariffs")
      .insert({ microgrid_id: FIXTURE.mg, effective_from: nextDate(), bands: [band(0, 24)] })
      .select("id")
      .single();
    expect(error).toBeNull();
    const id = data!.id as string;

    const refused = await manager.client.from("grid_tariffs").update({ bands: [band(0, 12)] }).eq("id", id);
    expect(refused.error?.code).toBe("23514");
    expect(refused.error?.message).toBe("No band covers hour 12.");

    const changed = [band(0, 12, 300), band(12, 24, 500)];
    const accepted = await manager.client.from("grid_tariffs").update({ bands: changed }).eq("id", id).select("bands");
    expect(accepted.error).toBeNull();
    expect(accepted.data).toEqual([{ bands: changed }]);
  });

  it("lets a row stored before the check move, but not keep invalid bands it is given", async () => {
    // Plant a row the check would refuse, as one stored before it existed.
    const planted = runAsDatabaseOwner(`DO $$ BEGIN
      ALTER TABLE grid_tariffs DISABLE TRIGGER trg_grid_tariffs_check_bands;
      INSERT INTO grid_tariffs (id, microgrid_id, effective_from, bands)
        VALUES ('${FIXTURE.legacy}', '${FIXTURE.mg}', '2026-12-01', '[{"from_hour":0,"to_hour":12,"rate":400}]');
      ALTER TABLE grid_tariffs ENABLE TRIGGER trg_grid_tariffs_check_bands;
    END $$;`);
    expect(planted.ok, planted.output).toBe(true);

    const moved = await manager.client
      .from("grid_tariffs")
      .update({ effective_from: "2026-12-02" })
      .eq("id", FIXTURE.legacy)
      .select("effective_from");
    expect(moved.error).toBeNull();
    expect(moved.data).toEqual([{ effective_from: "2026-12-02" }]);

    const resent = await manager.client
      .from("grid_tariffs")
      .update({ bands: [band(0, 12), band(12, 23)] })
      .eq("id", FIXTURE.legacy);
    expect(resent.error?.code).toBe("23514");
    expect(resent.error?.message).toBe("No band covers hour 23.");
  });

  it("refuses service_role and the table owner too", async () => {
    const svc = await serviceClient();
    const { error } = await svc
      .from("grid_tariffs")
      .insert({ microgrid_id: FIXTURE.mg, effective_from: nextDate(), bands: [band(0, 12)] });
    expect(error?.code).toBe("23514");
    expect(error?.message).toBe("No band covers hour 12.");

    const owner = runAsDatabaseOwner(
      `INSERT INTO grid_tariffs (microgrid_id, effective_from, bands) VALUES ('${FIXTURE.mg}', '${nextDate()}', '[{"from_hour":0,"to_hour":12,"rate":400}]')`,
    );
    expect(owner.ok).toBe(false);
    expect(owner.output).toContain("No band covers hour 12.");
  });
});
