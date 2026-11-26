import { NextResponse } from "next/server";
import type { z } from "zod";

export type ParsedBody<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

/** One answer a route gives for a body it refuses: its status and its JSON body. */
export interface RefusedBody {
  status: number;
  body: { error: string; code?: string; field?: string; reason?: string };
}

/**
 * The answers of a route that refused bodies in its own words before it
 * parsed them with a schema, so that describing it as an action left those
 * answers as they were (community management's routes, #278). A new route
 * answers with the generic 400 instead and needs none of this.
 */
export interface BodyRefusals {
  /** For a body that is not JSON. */
  json: RefusedBody;
  /**
   * For one issue of a body the schema refuses; null where the route had no
   * answer of its own for that issue (it ignored the key, or read a value of
   * another type as null), which leaves it to the generic answer.
   */
  issue(issue: z.core.$ZodIssue): RefusedBody | null;
  /** The route refused an unknown key before any field, so that issue is answered first. */
  unknownKeysFirst?: true;
}

function refused({ status, body }: RefusedBody): ParsedBody<never> {
  return { ok: false, response: NextResponse.json(body, { status }) };
}

function invalid(error: string, field?: string): ParsedBody<never> {
  return {
    ok: false,
    response: NextResponse.json(
      { error, ...(field ? { field } : {}), code: "invalid_body" },
      { status: 400 }
    ),
  };
}

/**
 * Read a JSON request body and parse it with the action's schema from
 * src/lib/<capability>/schemas.ts. A failure answers 400 with the first
 * issue: { error, field?, code: "invalid_body" }, where field is the
 * top-level key the issue is under (none for the body itself).
 *
 * With `refusals`, a body that is not JSON gets `refusals.json`, and a body
 * the schema refuses gets the answer to the first of its issues, in the
 * schema's key order (its unknown keys first with `unknownKeysFirst`), that
 * `refusals.issue` answers; the generic answer when it answers none.
 */
export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  refusals?: BodyRefusals
): Promise<ParsedBody<z.output<S>>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refusals ? refused(refusals.json) : invalid("Invalid JSON body");
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, data: parsed.data };
  const { issues } = parsed.error;
  if (refusals) {
    const unknown = (i: z.core.$ZodIssue) => i.code === "unrecognized_keys";
    const ordered = refusals.unknownKeysFirst
      ? [...issues.filter(unknown), ...issues.filter((i) => !unknown(i))]
      : issues;
    for (const issue of ordered) {
      const answer = refusals.issue(issue);
      if (answer) return refused(answer);
    }
  }
  const issue = issues[0];
  return invalid(issue.message, typeof issue.path[0] === "string" ? issue.path[0] : undefined);
}
