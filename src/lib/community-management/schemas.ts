/**
 * Body schemas for community management's write routes. The tenant access
 * route (POST /api/tenants/[id]/access) parses with these; a contributed GUI
 * action for the same write would take its input from the same schema, so
 * the form and the route share one definition.
 *
 * Client-safe: its only runtime import is zod. If it gains a server-only or
 * side-effecting import, revisit.
 */
import { z } from "zod";

const bodyError = (issue: { code: string; keys?: string[] }) =>
  issue.code === "unrecognized_keys"
    ? `Unknown field: ${(issue.keys ?? []).join(", ")}`
    : "Request body must be an object";

const EMAIL = "Enter a valid email address.";

/**
 * POST /api/tenants/[id]/access. The unit comes from the path and the
 * account from this address: no field names an account by id. The address
 * is trimmed and lowercased, as Supabase Auth stores it and
 * fn_auth_sign_in_target compares it; nothing else is folded.
 */
export const TenantAccessGrantBody = z.strictObject(
  {
    email: z
      .string({ error: EMAIL })
      .trim()
      .toLowerCase()
      .max(254, { error: EMAIL })
      .pipe(z.email({ error: EMAIL }))
      .meta({ title: "Email address" }),
  },
  { error: bodyError }
);
export type TenantAccessGrantBody = z.output<typeof TenantAccessGrantBody>;
