import { z } from "zod";

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
 */
export const OPENEMS_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Trims, then checks the format. Use it in every body schema that writes either id. */
export const openEmsIdSchema = z.string().trim().regex(OPENEMS_ID_PATTERN);

/**
 * The trimmed id when `value` is a string in the stored format, else null.
 * For checks outside a zod schema (route bodies validated by hand, ids
 * returned by OpenEMS).
 */
export function parseOpenEmsId(value: unknown): string | null {
  const parsed = openEmsIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Shown to an operator next to a refused id. */
export const OPENEMS_ID_FORMAT_HINT =
  "1 to 64 characters: letters, digits, '_', '.', ':' or '-'";
