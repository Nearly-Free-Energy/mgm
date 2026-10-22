import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SYNTHETIC_COMPONENT_PREFIX,
  SYNTHETIC_EDGE_ID,
  SYNTHETIC_EDGE_ID_PREFIX,
  SYNTHETIC_METERS,
  findSyntheticMeter,
} from "../dataset";

const SQL = readFileSync(
  path.resolve(__dirname, "../../../../../supabase/scripts/load-synthetic-demo.sql"),
  "utf8"
);

describe("synthetic demonstration dataset", () => {
  it("uses only obviously synthetic identifiers", () => {
    expect(SYNTHETIC_EDGE_ID.startsWith(SYNTHETIC_EDGE_ID_PREFIX)).toBe(true);
    for (const meter of SYNTHETIC_METERS) {
      expect(meter.componentId.startsWith(SYNTHETIC_COMPONENT_PREFIX)).toBe(true);
      expect(meter.householdName).toMatch(/^Synthetic Household \d{3}$/);
      expect(meter.unitLabel).toMatch(/^SYN-\d{3}$/);
    }
    expect(new Set(SYNTHETIC_METERS.map((m) => m.componentId)).size).toBe(SYNTHETIC_METERS.length);
  });

  it("covers complete and missing-data cases", () => {
    const profiles = new Set(SYNTHETIC_METERS.map((m) => m.profile));
    for (const p of ["typical", "interior-gap", "boundary-gap", "no-data"]) {
      expect(profiles.has(p as never)).toBe(true);
    }
    expect(findSyntheticMeter("SYNTHETIC-METER-001")).toBeDefined();
    expect(findSyntheticMeter("real-meter-1")).toBeUndefined();
  });

  it("the operator SQL script creates exactly this dataset", () => {
    expect(SQL).toContain(`'${SYNTHETIC_EDGE_ID}'`);
    expect(SQL).toContain(`FOR i IN 1..${SYNTHETIC_METERS.length} LOOP`);
    expect(SQL).toContain(`'${SYNTHETIC_COMPONENT_PREFIX}' || v_n`);
    expect(SQL).toContain("'Synthetic Household ' || v_n");
    expect(SQL).toContain("'SYN-' || v_n");
  });

  it("the script writes only columns that exist in the current schema", () => {
    const gen = readFileSync(
      path.resolve(__dirname, "../../../types/database.gen.ts"),
      "utf8"
    );
    expect(SQL).not.toContain("data_source_type");
    const edgesInsert = /INSERT INTO edges \(([^)]*)\)/.exec(SQL)?.[1] ?? "";
    const edgeRow = /edges: \{\s+Row: \{([^}]*)\}/.exec(gen)?.[1] ?? "";
    for (const column of edgesInsert.split(",").map((c) => c.trim())) {
      expect(edgeRow).toContain(`${column}:`);
    }
    expect(SQL).toContain("primary_phone");
  });

  it("the script needs explicit confirmation and is not a migration", () => {
    expect(SQL).toContain("load-synthetic-demo");
    expect(SQL).toMatch(/Refusing to load/);
    expect(SQL).not.toMatch(/INSERT INTO (billing_|rate_schedules|meter_readings)/);
  });
});
