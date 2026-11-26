import { NextResponse } from "next/server";
import type { z } from "zod";

/**
 * `empty`: the request had no body and was read as `options.whenEmpty`, so a
 * route can tell a caller that sent nothing from one that sent `{}`. Absent
 * otherwise.
 */
export type ParsedBody<T> = { ok: true; data: T; empty?: true } | { ok: false; response: NextResponse };

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

/**
 * How a route reads a body that its existing callers send, or are answered,
 * in a shape of their own. A new route needs none of it.
 */
export interface ParseBodyOptions {
  /**
   * What a request with no body is read as, then parsed with the schema like
   * any other body; the result says `empty: true`. Without it such a request
   * is refused as a body that is not JSON. For a route whose existing callers
   * send nothing, such as a page's bare DELETE.
   *
   * A body of nothing but whitespace is no body, the rule DELETE
   * /api/billing-periods/[periodId] and the DELETE routes of a community, a
   * microgrid and a tenant apply inline: if one of these rules changes,
   * change the others with it, so a route reads an empty body one way.
   *
   * The GUI host sends a JSON object with every write (invoke in
   * src/lib/gui/host/client/invoke.ts), so a route can tell the host's
   * request from a page's bare one by `empty`. If invoke stops sending a
   * JSON object for every write, revisit each route that reads `empty`.
   */
  whenEmpty?: unknown;
  /** The route's own answers to a body it refuses, in place of the generic 400. */
  refusals?: BodyRefusals;
  /**
   * Keys added to the generic 400 a schema refusal answers, from the issue
   * that refused it: for a route whose callers read more than `error`, such
   * as a `reason`. `error`, `field` and `code` stay the helper's. With
   * `refusals`, it adds to the generic answer given when `refusals.issue`
   * answers none of the issues.
   */
  refusalKeys?: (issue: z.core.$ZodIssue) => Record<string, string> | undefined;
}

function refused({ status, body }: RefusedBody): ParsedBody<never> {
  return { ok: false, response: NextResponse.json(body, { status }) };
}

function invalid(error: string, field?: string, extra?: Record<string, string>): ParsedBody<never> {
  return {
    ok: false,
    response: NextResponse.json(
      { ...extra, error, ...(field ? { field } : {}), code: "invalid_body" },
      { status: 400 }
    ),
  };
}

/**
 * Read a JSON request body and parse it with the action's schema from
 * src/lib/<capability>/schemas.ts. A failure answers 400 with the first
 * issue: { error, field?, code: "invalid_body" }, where field is the
 * top-level key the issue is under (none for the body itself), with what
 * `options.refusalKeys` adds for that issue.
 *
 * With `options.refusals`, a body that is not JSON gets `refusals.json`, and
 * a body the schema refuses gets the answer to the first of its issues, in
 * the schema's key order (its unknown keys first with `unknownKeysFirst`),
 * that `refusals.issue` answers; the generic answer when it answers none.
 */
export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  options: ParseBodyOptions = {}
): Promise<ParsedBody<z.output<S>>> {
  const { refusals } = options;
  let body: unknown;
  let empty = false;
  try {
    if (Object.hasOwn(options, "whenEmpty")) {
      const text = await request.text();
      empty = text.trim() === "";
      body = empty ? options.whenEmpty : JSON.parse(text);
    } else {
      body = await request.json();
    }
  } catch {
    return refusals ? refused(refusals.json) : invalid("Invalid JSON body");
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return empty ? { ok: true, data: parsed.data, empty: true } : { ok: true, data: parsed.data };
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
  return invalid(
    issue.message,
    typeof issue.path[0] === "string" ? issue.path[0] : undefined,
    options.refusalKeys?.(issue)
  );
}
