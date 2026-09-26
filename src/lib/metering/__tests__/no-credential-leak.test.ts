/**
 * No-credential-leak guard (issue #4 acceptance).
 *
 * Row-level RLS does not restrict columns, so `MICROGRID_PUBLIC_COLUMNS`
 * is the projection boundary for every microgrid SELECT: `ems_*`
 * identifiers and health signals are intentionally projected (the setup UI
 * needs them), but the two ciphertext columns must never appear. See
 * `src/lib/types/microgrid-columns.ts` for the documented contract.
 */
import { describe, expect, it } from "vitest";
import { MICROGRID_PUBLIC_COLUMNS } from "@/lib/types/microgrid-columns";

const SECRET_COLUMNS = [
  "ems_aws_secret_access_key_encrypted",
  "ems_basic_auth_password_encrypted",
  "ems_bearer_token_encrypted",
] as const;

function projectedColumns(): string[] {
  return MICROGRID_PUBLIC_COLUMNS.split(",").map((column) => column.trim());
}

describe("no OpenEMS credentials in client-bound projections", () => {
  it("never projects ciphertext columns", () => {
    const columns = projectedColumns();
    for (const secret of SECRET_COLUMNS) {
      expect(
        columns.includes(secret),
        `${secret} must never be projected to the browser`
      ).toBe(false);
    }
  });

  it("still projects the connection-readiness signals the UI needs", () => {
    // Type, URL, key identifiers, and discover health are identifiers, not
    // secrets — the setup UI and metering repository read them server-side.
    const columns = projectedColumns();
    for (const column of [
      "id",
      "community_id",
      "name",
      "currency",
      "timezone",
      "ems_type",
      "ems_backend_url",
      "ems_aws_region",
      "ems_aws_access_key_id",
      "ems_basic_auth_username",
      "ems_known_edge_ids",
      "ems_last_discover_at",
      "ems_last_discover_status",
    ] as const) {
      expect(columns.includes(column), `${column} must stay projected`).toBe(
        true
      );
    }
  });
});
