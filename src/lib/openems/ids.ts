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

/**
 * The first id that `values` name more than once after trimming, else null.
 * Values outside the stored format are passed over, so check those with
 * `parseOpenEmsId` first. A save that upserts several rows keyed on one of
 * these ids calls it before any database call: Postgres refuses an
 * `INSERT … ON CONFLICT DO UPDATE` that reaches the same row twice, so two
 * entries that differ only by surrounding spaces (`meter0`, ` meter0`) would
 * otherwise fail the whole save with a 500. Ids compare exactly, case
 * included, as the plain TEXT unique constraints on both columns compare them
 * (`00001_schema.sql`): if either becomes case-insensitive (citext, a
 * nondeterministic collation, a unique index on `lower()`), compare the same
 * way here, or `Meter0` and `meter0` reach one row again.
 */
export function firstDuplicateOpenEmsId(values: readonly unknown[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    const id = parseOpenEmsId(value);
    if (id === null) continue;
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

/** Shown to an operator next to a refused id. */
export const OPENEMS_ID_FORMAT_HINT =
  "1 to 64 characters: letters, digits, '_', '.', ':' or '-'";

/** The database's CHECK of the stored format on `edges.openems_edge_id`. */
export const EDGE_ID_FORMAT_CONSTRAINT = "edges_openems_edge_id_format";

/** The database's CHECK of the stored format on `devices.openems_component_id`. */
export const COMPONENT_ID_FORMAT_CONSTRAINT = "devices_openems_component_id_format";

/**
 * True when a Postgres error is `constraint` refusing a row (check_violation,
 * 23514). Both CHECKs are NOT VALID (migration `20261124160100`), so a row
 * stored before them can hold an id outside the format, and Postgres then
 * refuses every UPDATE of that row, whichever columns it sets. The PATCH
 * routes of edges and devices use this to answer 409
 * `stored_id_outside_format` instead of 500. Once a later migration runs
 * VALIDATE CONSTRAINT on both, no stored row can be outside the format and
 * those branches cannot be reached; revisit them then.
 */
export function isIdFormatViolation(
  error: { code?: string; message?: string } | null | undefined,
  constraint: typeof EDGE_ID_FORMAT_CONSTRAINT | typeof COMPONENT_ID_FORMAT_CONSTRAINT
): boolean {
  return error?.code === "23514" && (error.message ?? "").includes(constraint);
}
