/**
 * microgridPublicColumns names only columns of MICROGRID_PUBLIC_COLUMNS: the
 * compiler refuses any other (the @ts-expect-error lines below fail
 * `npx tsc --noEmit` if it stops refusing them).
 */
import { describe, expect, it } from "vitest";
import { MICROGRID_PUBLIC_COLUMNS, microgridPublicColumns, type MicrogridPublicColumn } from "../microgrid-columns";

describe("microgridPublicColumns", () => {
  it("joins the columns it is given, each one of the public projection", () => {
    expect(microgridPublicColumns("id", "name", "currency", "community_id")).toBe("id, name, currency, community_id");
    const all = MICROGRID_PUBLIC_COLUMNS.split(", ") as MicrogridPublicColumn[];
    expect(microgridPublicColumns(all[0], ...all.slice(1))).toBe(MICROGRID_PUBLIC_COLUMNS);
  });

  it("refuses, at compile time, a column the projection leaves out", () => {
    // @ts-expect-error an encrypted credential is not a public column
    microgridPublicColumns("id", "ems_basic_auth_password_encrypted");
    // @ts-expect-error nor is a column that does not exist
    microgridPublicColumns("location");
    // @ts-expect-error nor the star
    microgridPublicColumns("*");
    expect(true).toBe(true);
  });
});
