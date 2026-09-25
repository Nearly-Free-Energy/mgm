import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit/in-memory";
import {
  COMMUNITY_MANAGEMENT_PLUGIN_VERSION,
  ORGANIZATION_DIRECTORY_PLUGIN_VERSION,
} from "@/lib/plugins/bundled";

function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function tokenMatches(provided: string): boolean {
  const expected = process.env.MGM_BOOTSTRAP_TOKEN ?? "";
  if (!expected || !provided) return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * POST /api/mgm/bootstrap — first-organization bootstrap (Release 1, issue #3).
 *
 * Creates the initial organization and grants the calling authenticated user
 * the organization-manager role. Three independent guards must all pass:
 *
 *   1. `MGM_BOOTSTRAP_TOKEN` must be configured and match (timing-safe).
 *   2. The caller must be authenticated.
 *   3. No organization may exist yet — enforced atomically inside
 *      `fn_mgm_bootstrap_first_organization`, so concurrent first-run calls
 *      cannot create two organizations.
 *
 * After the first organization exists the endpoint is inert (409). Remove
 * `MGM_BOOTSTRAP_TOKEN` from the environment once bootstrap is complete.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const rate = checkRateLimit(`mgm-bootstrap:${ip}`, 5, 60_000);
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly.", code: "bootstrap_rate_limited" },
      {
        status: 429,
        headers: rate.retryAfter
          ? { "Retry-After": String(rate.retryAfter) }
          : undefined,
      }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "bootstrap_invalid_body" },
      { status: 400 }
    );
  }

  const token = typeof body.bootstrap_token === "string" ? body.bootstrap_token : "";
  if (!process.env.MGM_BOOTSTRAP_TOKEN) {
    return NextResponse.json(
      {
        error: "Organization bootstrap is not configured.",
        code: "bootstrap_not_configured",
      },
      { status: 503 }
    );
  }
  if (!tokenMatches(token)) {
    return NextResponse.json(
      { error: "Invalid bootstrap token.", code: "bootstrap_forbidden" },
      { status: 403 }
    );
  }

  const org = (body.organization ?? {}) as Record<string, unknown>;
  const name = typeof org.name === "string" ? org.name.trim() : "";
  const addressCity =
    typeof org.address_city === "string" ? org.address_city.trim() : "";
  const addressCountry =
    typeof org.address_country === "string" ? org.address_country.trim() : "";
  if (!name) {
    return NextResponse.json(
      { error: "Name is required.", code: "bootstrap_invalid", field: "name" },
      { status: 422 }
    );
  }
  if (!addressCity) {
    return NextResponse.json(
      {
        error: "City is required.",
        code: "bootstrap_invalid",
        field: "address_city",
      },
      { status: 422 }
    );
  }
  if (!addressCountry) {
    return NextResponse.json(
      {
        error: "Country is required.",
        code: "bootstrap_invalid",
        field: "address_country",
      },
      { status: 422 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required.", code: "bootstrap_unauthenticated" },
      { status: 401 }
    );
  }

  const { data, error } = await supabase.rpc(
    "fn_mgm_bootstrap_first_organization",
    {
      _name: name,
      _address_line1: readOptionalString(org.address_line1) ?? undefined,
      _address_line2: readOptionalString(org.address_line2) ?? undefined,
      _address_city: addressCity,
      _address_region: readOptionalString(org.address_region) ?? undefined,
      _address_country: addressCountry,
      _address_postal_code:
        readOptionalString(org.address_postal_code) ?? undefined,
      _organization_directory_version: ORGANIZATION_DIRECTORY_PLUGIN_VERSION,
      _community_management_version: COMMUNITY_MANAGEMENT_PLUGIN_VERSION,
    }
  );

  if (error) {
    if (
      error.code === "42501" ||
      (error.message ?? "").includes("row-level security")
    ) {
      return NextResponse.json(
        { error: "Authentication required.", code: "bootstrap_unauthenticated" },
        { status: 401 }
      );
    }
    if (
      error.code === "P0001" &&
      (error.message ?? "").includes("already exists")
    ) {
      return NextResponse.json(
        {
          error: "An organization already exists.",
          code: "bootstrap_already_bootstrapped",
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        error: `Could not bootstrap the organization: ${error.message}`,
        code: "bootstrap_failed",
      },
      { status: 500 }
    );
  }

  revalidatePath("/", "layout");
  revalidatePath("/organizations", "layout");
  return NextResponse.json({ organization: data }, { status: 201 });
}
