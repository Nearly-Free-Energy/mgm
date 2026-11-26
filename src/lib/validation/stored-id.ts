/**
 * The format MGM stores for an OpenEMS edge id (`edges.openems_edge_id`) and
 * component id (`devices.openems_component_id`): 1 to 64 characters from
 * letters, digits, `_`, `.`, `:` and `-`, after trimming. OpenEMS's own ids
 * (`edge0`, `meter1`, `ess0`, `SYNTHETIC-EDGE-<uuid>`) all fit.
 *
 * The database holds the same pattern as a CHECK on each column
 * (`edges_openems_edge_id_format`, `devices_openems_component_id_format`,
 * migration `20261124160100`); `src/lib/openems/__tests__/ids.test.ts` reads
 * the newest migration that defines them and fails while the two differ. If
 * the pattern changes, change it there in a new migration in the same commit.
 *
 * Vendor-neutral, so the metering domain can check the stored format without
 * importing `@/lib/openems` (ADR-007 decision 4); `@/lib/openems/ids`
 * re-exports it under the same name.
 */
export const OPENEMS_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
