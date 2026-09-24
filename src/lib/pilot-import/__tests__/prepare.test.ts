import { describe, expect, it } from "vitest";
import {
  assertPilotImportTarget,
  PilotImportError,
  preparePilotRows,
  reconcilePilotRows,
} from "../prepare";

const key = "synthetic-test-key-with-at-least-32-bytes";
const validRow = {
  source_household_id: "synthetic-household-01",
  source_meter_id: "synthetic-meter-01",
  reading_kwh: 12.5,
  read_at: "2026-09-01T08:00:00+03:00",
};
const localTarget = {
  target: "synthetic-pilot",
  targetMicrogridId: "00000000-0000-4000-8000-000000000001",
  expectedPilotMicrogridId: "00000000-0000-4000-8000-000000000001",
  databaseUrl: "postgresql://localhost:54322/postgres",
  operatorConfirmed: true,
  dryRun: false,
};

describe("pilot import preparation", () => {
  it("accepts only allowlisted fields and returns stable pseudonyms", () => {
    const [first] = preparePilotRows([validRow], key);
    const [repeat] = preparePilotRows([validRow], key);
    expect(first).toEqual(repeat);
    expect(JSON.stringify(first)).not.toContain("synthetic-household-01");
    expect(JSON.stringify(first)).not.toContain("synthetic-meter-01");
    expect(first.read_at).toBe("2026-09-01T05:00:00.000Z");
  });

  it("rejects PII or unrecognized source columns", () => {
    expect(() => preparePilotRows([{ ...validRow, phone: "+256700000000" }], key)).toThrow(PilotImportError);
  });

  it("rejects malformed measurements and a weak pseudonymization key", () => {
    expect(() => preparePilotRows([{ ...validRow, reading_kwh: -1 }], key)).toThrow(/non-negative/);
    expect(() => preparePilotRows([validRow], "short")).toThrow(/at least 32 bytes/);
  });

  it("requires explicit operator confirmation and a local write target", () => {
    expect(() => assertPilotImportTarget({ ...localTarget, operatorConfirmed: false })).toThrow(/explicitly confirm/);
    expect(() => assertPilotImportTarget({ ...localTarget, databaseUrl: "postgresql://example.supabase.co/db" })).toThrow(/local database/);
    expect(() => assertPilotImportTarget({ ...localTarget, target: "production", dryRun: true })).toThrow(/synthetic-pilot/);
    expect(() => assertPilotImportTarget({ ...localTarget, targetMicrogridId: "00000000-0000-4000-8000-000000000002" })).toThrow(/configured synthetic pilot/);
  });

  it("builds an insert preview and flags changed readings without overwriting", () => {
    const prepared = preparePilotRows([validRow, validRow], key);
    const [row] = prepared;
    const result = reconcilePilotRows(prepared, [
      { meter_key: row.meter_key, read_at: row.read_at, reading_kwh: 12.5 },
    ]);
    expect(result).toMatchObject({ inserts: [], unchanged: 1, conflicts: [], duplicate_source_rows: 1 });

    const conflict = reconcilePilotRows([{ ...row, reading_kwh: 13 }], [row]);
    expect(conflict.inserts).toEqual([]);
    expect(conflict.conflicts).toEqual([{ meter_key: row.meter_key, read_at: row.read_at }]);
  });
});
