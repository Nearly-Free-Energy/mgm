import { NextResponse } from "next/server";
import type { z } from "zod";

export type ParsedBody<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

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
 */
export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S
): Promise<ParsedBody<z.output<S>>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalid("Invalid JSON body");
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  return invalid(issue.message, typeof issue.path[0] === "string" ? issue.path[0] : undefined);
}
