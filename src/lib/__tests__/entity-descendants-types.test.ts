/**
 * descendantCountsAreEmpty — every counted descendant, including the grid
 * tariffs and savings settings (migration 20261111200000), makes an entity
 * non-empty.
 */

import { describe, it, expect } from "vitest";
import {
  descendantCountsAreEmpty,
  type DescendantCounts,
} from "@/lib/entity-descendants-types";

const EMPTY_MICROGRID: Extract<DescendantCounts, { kind: "microgrid" }> = {
  kind: "microgrid",
  edges: 0,
  devices: 0,
  households: 0,
  household_devices: 0,
  household_users: 0,
  billing_periods_draft: 0,
  billing_periods_closed: 0,
  billing_periods_with_payments: 0,
  billing_line_items: 0,
  rate_schedules: 0,
  grid_tariffs: 0,
  microgrid_savings_settings: 0,
};

const EMPTY_COMMUNITY: Extract<DescendantCounts, { kind: "community" }> = {
  ...EMPTY_MICROGRID,
  kind: "community",
  microgrids: 0,
};

const EMPTY_ORGANIZATION: Extract<DescendantCounts, { kind: "organization" }> = {
  ...EMPTY_COMMUNITY,
  kind: "organization",
  communities: 0,
  user_roles: 0,
};

describe("descendantCountsAreEmpty", () => {
  it.each([EMPTY_MICROGRID, EMPTY_COMMUNITY, EMPTY_ORGANIZATION])(
    "is true for a $kind with nothing under it",
    (counts) => {
      expect(descendantCountsAreEmpty(counts)).toBe(true);
    },
  );

  it.each(["grid_tariffs", "microgrid_savings_settings", "rate_schedules"] as const)(
    "is false when only %s is non-zero",
    (field) => {
      for (const counts of [EMPTY_MICROGRID, EMPTY_COMMUNITY, EMPTY_ORGANIZATION]) {
        expect(descendantCountsAreEmpty({ ...counts, [field]: 1 })).toBe(false);
      }
    },
  );
});
