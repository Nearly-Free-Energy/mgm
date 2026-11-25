import { NextResponse } from "next/server";
import type { z } from "zod";

export type ParsedBody<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

/** How a route reads a body that its existing callers send in a shape of their own. */
export interface ParseBodyOptions {
  /**
   * What a request with no body at all (zero bytes) is read as, then parsed
   * with the schema like any other body. Without it such a request is
   * refused as "Invalid JSON body". For a route whose existing callers send
   * nothing, such as a page's bare DELETE, while the GUI host always sends a
   * JSON object (invoke in src/lib/gui/host/client/invoke.ts). Whitespace
   * is not an empty body.
   */
  whenEmpty?: unknown;
  /**
   * Keys added to the 400 a schema refusal answers, from the issue that
   * refused it: for a route whose callers read more than `error`, such as a
   * `reason`. `error`, `field` and `code` stay the helper's.
   */
  refusal?: (issue: z.core.$ZodIssue) => Record<string, string> | undefined;
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
 * `options.refusal` adds for that issue.
 */
export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  options: ParseBodyOptions = {}
): Promise<ParsedBody<z.output<S>>> {
  let body: unknown;
  try {
    if (Object.hasOwn(options, "whenEmpty")) {
      const text = await request.text();
      body = text === "" ? options.whenEmpty : JSON.parse(text);
    } else {
      body = await request.json();
    }
  } catch {
    return invalid("Invalid JSON body");
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  return invalid(
    issue.message,
    typeof issue.path[0] === "string" ? issue.path[0] : undefined,
    options.refusal?.(issue)
  );
}
