/**
 * Microgrid create/update operations for the community-management plugin.
 *
 * Domain logic only: validation, organization-scope enforcement, and result
 * mapping. All persistence flows through `CommunityManagementRepository` —
 * see `../types` and the import-boundary test.
 */
import "server-only";

import type { Microgrid } from "@/lib/types/domain";
import { validateCurrency } from "@/lib/validation/currency";
import {
  canonicalTimezone,
  validateTimezone,
} from "@/lib/validation/timezone";
import {
  accessDenied,
  mapRlsError,
  readOptionalString,
  requireScopedAccess,
  UUID_RE,
} from "./shared";
import {
  communityFailure,
  type CommunityManagementRepository,
  type CommunityManagementResult,
  type MicrogridCreateInput,
  type MicrogridUpdateInput,
  type OrganizationScope,
} from "../types";

const OPTIONAL_STRING_FIELDS = [
  "address_line1",
  "address_line2",
  "address_city",
  "address_region",
  "address_country",
  "address_postal_code",
] as const;

function readOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseCreateInput(
  body: unknown
): CommunityManagementResult<{ input: MicrogridCreateInput; communityId: string }> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return communityFailure({
      status: 400,
      code: "microgrid_invalid_body",
      message: "Invalid JSON body",
    });
  }
  const record = body as Record<string, unknown>;
  const communityId =
    typeof record.community_id === "string" ? record.community_id : "";
  if (!UUID_RE.test(communityId)) {
    return communityFailure({
      status: 400,
      code: "microgrid_invalid_community",
      message: "Invalid community_id — expected UUID.",
      field: "community_id",
    });
  }
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) {
    return communityFailure({
      status: 422,
      code: "microgrid_name_required",
      message: "Name is required.",
      field: "name",
    });
  }
  const currencyInput =
    typeof record.currency === "string" ? record.currency.trim() : "";
  const currencyError = validateCurrency(currencyInput);
  if (currencyError) {
    return communityFailure({
      status: 422,
      code: "microgrid_invalid_currency",
      message: currencyError,
      field: "currency",
    });
  }

  let timezoneInput: string | null = null;
  if ("timezone" in record) {
    const raw = typeof record.timezone === "string" ? record.timezone.trim() : "";
    const timezoneError = validateTimezone(raw);
    if (timezoneError) {
      return communityFailure({
        status: 422,
        code: "microgrid_invalid_timezone",
        message: timezoneError,
        field: "timezone",
      });
    }
    timezoneInput = canonicalTimezone(raw);
  }

  return {
    ok: true,
    data: {
      communityId,
      input: {
        community_id: communityId,
        name,
        currency: currencyInput,
        ...(timezoneInput !== null ? { timezone: timezoneInput } : {}),
        address_line1: readOptionalString(record.address_line1),
        address_line2: readOptionalString(record.address_line2),
        address_city: readOptionalString(record.address_city),
        address_region: readOptionalString(record.address_region),
        address_country: readOptionalString(record.address_country),
        address_postal_code: readOptionalString(record.address_postal_code),
        lat: readOptionalNumber(record.lat),
        lng: readOptionalNumber(record.lng),
      },
    },
  };
}

function parseUpdateInput(
  body: unknown
): CommunityManagementResult<MicrogridUpdateInput> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return communityFailure({
      status: 400,
      code: "microgrid_invalid_body",
      message: "Invalid JSON body",
    });
  }
  const record = body as Record<string, unknown>;
  const updates: Record<string, string | number | null> = {};

  if ("name" in record) {
    if (typeof record.name !== "string" || !record.name.trim()) {
      return communityFailure({
        status: 422,
        code: "microgrid_name_required",
        message: "Name is required.",
        field: "name",
      });
    }
    updates.name = record.name.trim();
  }
  if ("currency" in record) {
    const currency = typeof record.currency === "string" ? record.currency.trim() : "";
    const currencyError = validateCurrency(currency);
    if (currencyError) {
      return communityFailure({
        status: 422,
        code: "microgrid_invalid_currency",
        message: currencyError,
        field: "currency",
      });
    }
    updates.currency = currency;
  }
  if ("timezone" in record) {
    const timezone = typeof record.timezone === "string" ? record.timezone.trim() : "";
    const timezoneError = validateTimezone(timezone);
    if (timezoneError) {
      return communityFailure({
        status: 422,
        code: "microgrid_invalid_timezone",
        message: timezoneError,
        field: "timezone",
      });
    }
    updates.timezone = canonicalTimezone(timezone);
  }
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (field in record) {
      const value = record[field];
      updates[field] = typeof value === "string" && value.trim() ? value.trim() : null;
    }
  }
  for (const field of ["lat", "lng"] as const) {
    if (field in record) {
      const value = record[field];
      if (value === null || value === "") {
        updates[field] = null;
      } else if (typeof value === "number" && Number.isFinite(value)) {
        updates[field] = value;
      } else if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          return communityFailure({
            status: 422,
            code: "microgrid_invalid_coordinate",
            message: `Invalid ${field} value.`,
            field,
          });
        }
        updates[field] = parsed;
      } else {
        updates[field] = null;
      }
    }
  }
  if (Object.keys(updates).length === 0) {
    return communityFailure({
      status: 400,
      code: "microgrid_empty_diff",
      message: "No fields to update.",
    });
  }
  return { ok: true, data: updates as MicrogridUpdateInput };
}

export async function createMicrogridOperation(
  repo: CommunityManagementRepository,
  scope: OrganizationScope | undefined,
  body: unknown
): Promise<CommunityManagementResult<Microgrid>> {
  const parsed = parseCreateInput(body);
  if (!parsed.ok) return parsed;

  // Preserve the route contract: a missing/inaccessible parent community is
  // a 403 because organization resolution cannot distinguish the two cases.
  const orgId = await repo.getCommunityOrganizationId(parsed.data.communityId);
  if (!orgId) {
    return accessDenied("Not authorized to add microgrids to this community.");
  }

  const accessError = await requireScopedAccess(repo, scope, orgId);
  if (accessError) return accessError;

  const { data, error } = await repo.insertMicrogrid(parsed.data.input);
  if (error) {
    if (
      error.code === "23505" &&
      error.message.includes("microgrids_community_name_unique")
    ) {
      return communityFailure({
        status: 409,
        code: "microgrid_duplicate_name",
        message: `A microgrid named '${parsed.data.input.name}' already exists in this community.`,
        field: "name",
      });
    }
    const rlsError = mapRlsError(
      error,
      "Not authorized to add microgrids to this community."
    );
    if (rlsError) return rlsError;
    return communityFailure({
      status: 500,
      code: "microgrid_create_failed",
      message: `Failed to create microgrid: ${error.message}`,
    });
  }
  if (!data) {
    return communityFailure({
      status: 500,
      code: "microgrid_create_failed",
      message: "Failed to create microgrid.",
    });
  }

  return { ok: true, data };
}

export async function updateMicrogridOperation(
  repo: CommunityManagementRepository,
  scope: OrganizationScope | undefined,
  id: string,
  body: unknown
): Promise<CommunityManagementResult<Microgrid>> {
  if (!UUID_RE.test(id)) {
    return communityFailure({
      status: 400,
      code: "microgrid_invalid_id",
      message: "Invalid microgrid id — expected UUID.",
    });
  }
  const parsed = parseUpdateInput(body);
  if (!parsed.ok) return parsed;

  const resolved = await repo.getMicrogridOrganization(id);
  if (!resolved) {
    return accessDenied("Not authorized to update this microgrid.");
  }

  const accessError = await requireScopedAccess(repo, scope, resolved.orgId);
  if (accessError) return accessError;

  const { data, error } = await repo.updateMicrogrid(id, parsed.data);
  if (error) {
    if (
      error.code === "23505" &&
      error.message.includes("microgrids_community_name_unique")
    ) {
      const name =
        typeof parsed.data.name === "string" ? parsed.data.name : "";
      return communityFailure({
        status: 409,
        code: "microgrid_duplicate_name",
        message: `A microgrid named '${name}' already exists in this community.`,
        field: "name",
      });
    }
    const rlsError = mapRlsError(
      error,
      "Not authorized to update this microgrid."
    );
    if (rlsError) return rlsError;
    return communityFailure({
      status: 500,
      code: "microgrid_update_failed",
      message: `Failed to update microgrid: ${error.message}`,
    });
  }
  if (!data) {
    return communityFailure({
      status: 404,
      code: "microgrid_not_found",
      message: "Microgrid not found.",
    });
  }
  return { ok: true, data };
}
