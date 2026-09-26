/**
 * Household create/update/delete operations for the community-management
 * plugin.
 *
 * Domain logic only: validation, organization-scope enforcement, device-link
 * reconciliation, and result mapping. All persistence flows through
 * `CommunityManagementRepository` — see `../types` and the
 * import-boundary test.
 */
import "server-only";

import type { Household } from "@/lib/types/domain";
import {
  accessDenied,
  mapRlsError,
  requireScopedAccess,
  UUID_RE,
} from "./shared";
import {
  communityFailure,
  type CommunityManagementRepository,
  type CommunityManagementResult,
  type HouseholdCreateInput,
  type OrganizationScope,
} from "../types";

const ACCOUNT_NUMBER_MAX_LENGTH = 30;
const METER_SERIAL_MAX_LENGTH = 50;
const METER_TYPE_MAX_LENGTH = 50;
const CUSTOMER_TYPES = new Set(["residential", "commercial"]);

const ALLOWED_UPDATE_FIELDS = new Set([
  "display_name",
  "primary_email",
  "primary_phone",
  "address_line1",
  "address_line2",
  "unit_label",
  "address_city",
  "address_region",
  "address_country",
  "address_postal_code",
  "geography_notes",
  "device_id",
  "account_number",
  "meter_serial",
  "meter_type",
  "customer_type",
]);

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nullableString(
  value: unknown
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nullableUuid(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!UUID_RE.test(trimmed)) return undefined;
  return trimmed;
}

function parseCreateInput(
  body: unknown
): CommunityManagementResult<{ input: HouseholdCreateInput; microgridId: string }> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return communityFailure({
      status: 400,
      code: "household_invalid_body",
      message: "Invalid JSON body",
    });
  }
  const record = body as Record<string, unknown>;
  const microgridId =
    typeof record.microgrid_id === "string" ? record.microgrid_id.trim() : "";
  if (!microgridId) {
    return communityFailure({
      status: 422,
      code: "household_microgrid_required",
      message: "microgrid_id is required.",
      field: "microgrid_id",
    });
  }
  const displayName =
    typeof record.display_name === "string" ? record.display_name.trim() : "";
  if (!displayName) {
    return communityFailure({
      status: 422,
      code: "household_name_required",
      message: "display_name is required.",
      field: "display_name",
    });
  }

  let deviceId: string | null = null;
  if (record.device_id !== undefined && record.device_id !== null) {
    if (typeof record.device_id !== "string") {
      return communityFailure({
        status: 422,
        code: "household_invalid_device",
        message: "device_id must be a string, null, or omitted.",
        field: "device_id",
      });
    }
    const trimmed = record.device_id.trim();
    deviceId = trimmed.length > 0 ? trimmed : null;
  }

  const primaryPhone =
    typeof record.primary_phone === "string" ? record.primary_phone.trim() : "";
  if (!primaryPhone) {
    return communityFailure({
      status: 400,
      code: "household_phone_required",
      message: "household_phone_required",
      field: "primary_phone",
    });
  }

  let accountNumber: string | null = null;
  if (record.account_number !== undefined && record.account_number !== null) {
    if (typeof record.account_number !== "string") {
      return communityFailure({
        status: 400,
        code: "household_invalid_account_number",
        message: "account_number must be a string or null",
        field: "account_number",
      });
    }
    const trimmed = record.account_number.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > ACCOUNT_NUMBER_MAX_LENGTH) {
        return communityFailure({
          status: 400,
          code: "household_account_number_too_long",
          message: `account_number must be ${ACCOUNT_NUMBER_MAX_LENGTH} characters or fewer`,
          field: "account_number",
        });
      }
      accountNumber = trimmed;
    }
  }

  let meterSerial: string | null = null;
  if (record.meter_serial !== undefined && record.meter_serial !== null) {
    if (typeof record.meter_serial !== "string") {
      return communityFailure({
        status: 400,
        code: "household_invalid_meter_serial",
        message: "meter_serial must be a string or null",
        field: "meter_serial",
      });
    }
    const trimmed = record.meter_serial.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > METER_SERIAL_MAX_LENGTH) {
        return communityFailure({
          status: 400,
          code: "household_meter_serial_too_long",
          message: `meter_serial must be ${METER_SERIAL_MAX_LENGTH} characters or fewer`,
          field: "meter_serial",
        });
      }
      meterSerial = trimmed;
    }
  }

  let meterType: string | undefined;
  if (record.meter_type !== undefined && record.meter_type !== null) {
    if (typeof record.meter_type !== "string") {
      return communityFailure({
        status: 400,
        code: "household_invalid_meter_type",
        message: "meter_type must be a non-empty string",
        field: "meter_type",
      });
    }
    const trimmed = record.meter_type.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > METER_TYPE_MAX_LENGTH) {
        return communityFailure({
          status: 400,
          code: "household_meter_type_too_long",
          message: `meter_type must be ${METER_TYPE_MAX_LENGTH} characters or fewer`,
          field: "meter_type",
        });
      }
      meterType = trimmed;
    }
  }

  let customerType: string | undefined;
  if (record.customer_type !== undefined && record.customer_type !== null) {
    if (typeof record.customer_type !== "string" || !CUSTOMER_TYPES.has(record.customer_type)) {
      return communityFailure({
        status: 400,
        code: "household_invalid_customer_type",
        message: "customer_type must be 'residential' or 'commercial'",
        field: "customer_type",
      });
    }
    customerType = record.customer_type;
  }

  return {
    ok: true,
    data: {
      microgridId,
      input: {
        microgrid_id: microgridId,
        display_name: displayName,
        device_id: deviceId,
        primary_phone: primaryPhone,
        primary_email: optionalString(record.primary_email),
        address_line1: optionalString(record.address_line1),
        address_line2: optionalString(record.address_line2),
        unit_label: optionalString(record.unit_label),
        address_city: optionalString(record.address_city),
        address_region: optionalString(record.address_region),
        address_country: optionalString(record.address_country),
        address_postal_code: optionalString(record.address_postal_code),
        geography_notes: optionalString(record.geography_notes),
        account_number: accountNumber,
        meter_serial: meterSerial,
        ...(meterType !== undefined ? { meter_type: meterType } : {}),
        ...(customerType !== undefined ? { customer_type: customerType } : {}),
      },
    },
  };
}

export async function createHouseholdOperation(
  repo: CommunityManagementRepository,
  scope: OrganizationScope | undefined,
  body: unknown
): Promise<CommunityManagementResult<{ household_id: string }>> {
  const parsed = parseCreateInput(body);
  if (!parsed.ok) return parsed;

  // Preserve the route contract: RLS decides cross-microgrid access, so an
  // invisible parent microgrid surfaces as 403 here.
  const resolved = await repo.getMicrogridOrganization(parsed.data.microgridId);
  if (!resolved) {
    return accessDenied("Not authorized to create a household on this microgrid.");
  }

  const accessError = await requireScopedAccess(repo, scope, resolved.orgId);
  if (accessError) return accessError;

  const rpcArgs: Record<string, unknown> = {
    p_microgrid_id: parsed.data.input.microgrid_id,
    p_display_name: parsed.data.input.display_name,
    p_primary_phone: parsed.data.input.primary_phone,
    p_primary_email: parsed.data.input.primary_email ?? undefined,
    p_address_line1: parsed.data.input.address_line1 ?? undefined,
    p_address_line2: parsed.data.input.address_line2 ?? undefined,
    p_unit_label: parsed.data.input.unit_label ?? undefined,
    p_address_city: parsed.data.input.address_city ?? undefined,
    p_address_region: parsed.data.input.address_region ?? undefined,
    p_address_country: parsed.data.input.address_country ?? undefined,
    p_address_postal_code: parsed.data.input.address_postal_code ?? undefined,
    p_geography_notes: parsed.data.input.geography_notes ?? undefined,
    p_account_number: parsed.data.input.account_number ?? undefined,
    p_meter_serial: parsed.data.input.meter_serial ?? undefined,
    p_meter_type: parsed.data.input.meter_type ?? undefined,
    p_customer_type: parsed.data.input.customer_type ?? undefined,
  };
  const withMeter = parsed.data.input.device_id != null;
  const { data, error } = await repo.createHousehold(
    withMeter
      ? { ...rpcArgs, p_device_id: parsed.data.input.device_id }
      : { ...rpcArgs, p_device_id: null },
    withMeter
  );

  if (error) {
    const rlsError = mapRlsError(
      error,
      "Not authorized to create a household on this microgrid."
    );
    if (rlsError) return rlsError;
    const message = error.message || "";
    if (message.includes("household_phone_required")) {
      return communityFailure({
        status: 400,
        code: "household_phone_required",
        message: "household_phone_required",
        field: "primary_phone",
      });
    }
    if (message.includes("does not belong to microgrid")) {
      return communityFailure({
        status: 403,
        code: "household_device_microgrid_mismatch",
        message: "Selected meter does not belong to this microgrid. Pick another meter.",
      });
    }
    if (message.includes("is not a consumption_meter")) {
      return communityFailure({
        status: 422,
        code: "household_device_not_consumption_meter",
        message: "Selected device is not a consumption meter.",
      });
    }
    if (error.code === "23505") {
      return communityFailure({
        status: 409,
        code: "household_device_conflict",
        message: "This meter was just assigned to another household. Pick another meter.",
      });
    }
    return communityFailure({
      status: 500,
      code: "household_create_failed",
      message: `Could not create household: ${error.message}`,
    });
  }

  return { ok: true, data: { household_id: data as string } };
}

type HouseholdFieldUpdate = {
  display_name?: string;
  primary_email?: string | null;
  primary_phone?: string;
  address_line1?: string | null;
  address_line2?: string | null;
  unit_label?: string | null;
  address_city?: string | null;
  address_region?: string | null;
  address_country?: string | null;
  address_postal_code?: string | null;
  geography_notes?: string | null;
  account_number?: string | null;
  meter_serial?: string | null;
  meter_type?: string;
  customer_type?: string;
};

function parseUpdateInput(
  body: unknown
): CommunityManagementResult<{
  update: HouseholdFieldUpdate;
  deviceProvided: boolean;
  deviceValue: string | null;
}> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return communityFailure({
      status: 400,
      code: "household_invalid_body",
      message: "Request body must be an object",
    });
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_UPDATE_FIELDS.has(key)) {
      return communityFailure({
        status: 400,
        code: "household_unsupported_field",
        message: `Unsupported field: ${key}`,
        reason: "unsupported_field",
      });
    }
  }

  let displayName: string | undefined;
  if ("display_name" in record) {
    const value = record.display_name;
    if (typeof value !== "string" || value.trim().length === 0) {
      return communityFailure({
        status: 400,
        code: "household_invalid_display_name",
        message: "display_name must be a non-empty string",
        reason: "invalid_display_name",
      });
    }
    displayName = value.trim();
  }

  let deviceProvided = false;
  let deviceValue: string | null = null;
  if ("device_id" in record) {
    const parsedDevice = nullableUuid(record.device_id);
    if (parsedDevice === undefined) {
      return communityFailure({
        status: 400,
        code: "household_invalid_device",
        message: "device_id must be a valid UUID or null",
        reason: "invalid_device_id",
      });
    }
    deviceProvided = true;
    deviceValue = parsedDevice;
  }

  const update: HouseholdFieldUpdate = {};
  if (displayName !== undefined) update.display_name = displayName;
  const stringFields = [
    "primary_email",
    "address_line1",
    "address_line2",
    "unit_label",
    "address_city",
    "address_region",
    "address_country",
    "address_postal_code",
    "geography_notes",
    "account_number",
    "meter_serial",
  ] as const;
  for (const field of stringFields) {
    if (field in record) {
      const parsed = nullableString(record[field]);
      if (parsed === undefined) {
        return communityFailure({
          status: 400,
          code: `household_invalid_${field}`,
          message: `${field} must be a string or null`,
          reason: `invalid_${field}`,
        });
      }
      if (
        (field === "account_number" && parsed !== null && parsed.length > ACCOUNT_NUMBER_MAX_LENGTH) ||
        (field === "meter_serial" && parsed !== null && parsed.length > METER_SERIAL_MAX_LENGTH)
      ) {
        const max =
          field === "account_number" ? ACCOUNT_NUMBER_MAX_LENGTH : METER_SERIAL_MAX_LENGTH;
        return communityFailure({
          status: 400,
          code: `household_${field}_too_long`,
          message: `${field} must be ${max} characters or fewer`,
          reason: `${field}_too_long`,
        });
      }
      update[field] = parsed;
    }
  }

  if ("primary_phone" in record) {
    const raw = record.primary_phone;
    if (raw === null || (typeof raw === "string" && raw.trim().length === 0)) {
      return communityFailure({
        status: 400,
        code: "household_phone_required",
        message: "household_phone_required",
        reason: "household_phone_required",
      });
    }
    if (typeof raw !== "string") {
      return communityFailure({
        status: 400,
        code: "household_invalid_primary_phone",
        message: "primary_phone must be a string",
        reason: "invalid_primary_phone",
      });
    }
    update.primary_phone = raw.trim();
  }
  if ("meter_type" in record) {
    const raw = record.meter_type;
    if (raw === null || typeof raw !== "string" || raw.trim().length === 0) {
      return communityFailure({
        status: 400,
        code: "household_invalid_meter_type",
        message: "meter_type must be a non-empty string",
        reason: "invalid_meter_type",
      });
    }
    const trimmed = raw.trim();
    if (trimmed.length > METER_TYPE_MAX_LENGTH) {
      return communityFailure({
        status: 400,
        code: "household_meter_type_too_long",
        message: `meter_type must be ${METER_TYPE_MAX_LENGTH} characters or fewer`,
        reason: "meter_type_too_long",
      });
    }
    update.meter_type = trimmed;
  }
  if ("customer_type" in record) {
    const raw = record.customer_type;
    if (raw === null || typeof raw !== "string" || !CUSTOMER_TYPES.has(raw)) {
      return communityFailure({
        status: 400,
        code: "household_invalid_customer_type",
        message: "customer_type must be 'residential' or 'commercial'",
        reason: "invalid_customer_type",
      });
    }
    update.customer_type = raw;
  }

  if (Object.keys(update).length === 0 && !deviceProvided) {
    return communityFailure({
      status: 400,
      code: "household_empty_diff",
      message: "No fields provided to update",
      reason: "empty_diff",
    });
  }
  return { ok: true, data: { update, deviceProvided, deviceValue } };
}

export async function updateHouseholdOperation(
  repo: CommunityManagementRepository,
  scope: OrganizationScope | undefined,
  id: string,
  body: unknown
): Promise<CommunityManagementResult<Household>> {
  if (!UUID_RE.test(id)) {
    return communityFailure({
      status: 400,
      code: "household_invalid_id",
      message: "Invalid household ID — expected UUID",
    });
  }
  const parsed = parseUpdateInput(body);
  if (!parsed.ok) return parsed;

  // RLS-filtered fetch: a missing or hidden household is a 404, preserving
  // the route contract.
  const { data: existing, error: fetchError } = await repo.findHousehold(id);
  if (fetchError || !existing) {
    return communityFailure({
      status: 404,
      code: "household_not_found",
      message: fetchError?.message ?? "Household not found",
    });
  }

  const resolved = await repo.getMicrogridOrganization(existing.microgrid_id);
  if (!resolved) {
    return accessDenied("You do not have permission to update this household.");
  }
  const accessError = await requireScopedAccess(repo, scope, resolved.orgId);
  if (accessError) return accessError;

  if (parsed.data.deviceProvided && parsed.data.deviceValue) {
    const existingLink = await repo.findDeviceLink(parsed.data.deviceValue, id);
    if (existingLink) {
      return communityFailure({
        status: 409,
        code: "household_device_already_linked",
        message:
          "Device is already linked to another household. Unlink it from the source household first.",
        reason: "device_already_linked",
      });
    }
  }

  let updatedHousehold: Record<string, unknown> | null = null;
  if (Object.keys(parsed.data.update).length > 0) {
    const { data, error } = await repo.updateHouseholdFields(
      id,
      parsed.data.update
    );
    if (error) {
      const rlsError = mapRlsError(error, "Not authorized to update this household.");
      if (rlsError) {
        return { ...rlsError, reason: "rls_denied" };
      }
      return communityFailure({
        status: 500,
        code: "household_update_failed",
        message: `Failed to update household: ${error.message}`,
      });
    }
    updatedHousehold = data as Record<string, unknown> | null;
  }

  if (parsed.data.deviceProvided) {
    // Release 2 (issue #4): replacements are atomic close-and-open swaps
    // through fn_replace_household_device, so a failed insert cannot leave
    // the household meterless. Same-day links never covered a day, so they
    // are deleted rather than closed as a zero-length interval (which the
    // period CHECK would reject). Dates are server UTC days; sub-day
    // precision is intentionally not modeled.
    const today = new Date().toISOString().slice(0, 10);
    const openLink = await repo.getOpenDeviceLink(id);
    const wantsLink = parsed.data.deviceValue;

    if (wantsLink && openLink && openLink.device_id === wantsLink) {
      // No-op: the requested meter is already the open link. Skip the write
      // so history rows are not churned.
    } else if (wantsLink) {
      const { error: replaceError } = await repo.replaceDeviceLink(
        id,
        wantsLink,
        today
      );
      if (replaceError) {
        const rlsError = mapRlsError(
          replaceError,
          "Not authorized to assign this device."
        );
        if (rlsError) return { ...rlsError, reason: "rls_denied" };
        if (
          replaceError.code === "23P01" ||
          (replaceError.code === "23505" &&
            replaceError.message.includes("overlaps"))
        ) {
          return communityFailure({
            status: 409,
            code: "household_device_overlap",
            message:
              "Meter assignment overlaps an existing assignment for this household. Retry the replacement.",
            reason: "device_assignment_overlap",
          });
        }
        if (replaceError.code === "23505") {
          return communityFailure({
            status: 409,
            code: "household_device_already_linked",
            message: "Meter is already assigned to another household.",
            reason: "device_already_linked",
          });
        }
        return communityFailure({
          status: 500,
          code: "household_device_link_failed",
          message: `Failed to link device to household: ${replaceError.message}`,
        });
      }
    } else if (openLink) {
      // Unlink: same-day links are corrections (delete); older links are
      // history (close at today).
      if (openLink.effective_from === today) {
        const deleteError = await repo.deleteDeviceLink(openLink.id);
        if (deleteError) {
          const rlsError = mapRlsError(
            deleteError,
            "Not authorized to update the household device link."
          );
          if (rlsError) return { ...rlsError, reason: "rls_denied" };
          return communityFailure({
            status: 500,
            code: "household_device_unlink_failed",
            message: `Failed to remove device link: ${deleteError.message}`,
          });
        }
      } else {
        const closeError = await repo.closeDeviceLink(openLink.id, today);
        if (closeError) {
          const rlsError = mapRlsError(
            closeError,
            "Not authorized to update the household device link."
          );
          if (rlsError) return { ...rlsError, reason: "rls_denied" };
          return communityFailure({
            status: 500,
            code: "household_device_unlink_failed",
            message: `Failed to close existing device link: ${closeError.message}`,
          });
        }
      }
    }
  }

  if (!updatedHousehold) {
    const { data, error } = await repo.refetchHousehold(id);
    if (error || !data) {
      return communityFailure({
        status: 500,
        code: "household_read_failed",
        message: `Failed to read updated household: ${error?.message ?? "not found"}`,
      });
    }
    updatedHousehold = data as unknown as Record<string, unknown>;
  }

  const actorUserId = await repo.getAuthenticatedUserId();
  console.info(
    JSON.stringify({
      event: "household.update",
      household_id: id,
      microgrid_id: existing.microgrid_id,
      changed_fields: Object.keys(parsed.data.update),
      device_link_changed: parsed.data.deviceProvided,
      device_link_action: parsed.data.deviceProvided
        ? parsed.data.deviceValue
          ? "link"
          : "clear"
        : "none",
      actor_user_id: actorUserId,
      at: new Date().toISOString(),
    })
  );

  return { ok: true, data: updatedHousehold as Household };
}

export async function deleteHouseholdOperation(
  repo: CommunityManagementRepository,
  scope: OrganizationScope | undefined,
  id: string
): Promise<CommunityManagementResult<{ id: string }>> {
  if (!UUID_RE.test(id)) {
    return communityFailure({
      status: 400,
      code: "household_invalid_id",
      message: "Invalid household ID — expected UUID",
    });
  }

  const { data: existing, error: fetchError } = await repo.findHousehold(id);
  if (fetchError || !existing) {
    return communityFailure({
      status: 404,
      code: "household_not_found",
      message: "Household not found",
    });
  }

  const resolved = await repo.getMicrogridOrganization(existing.microgrid_id);
  if (!resolved) {
    return accessDenied("You do not have permission to delete this household.");
  }
  const accessError = await requireScopedAccess(repo, scope, resolved.orgId);
  if (accessError) return accessError;

  // Deletion safeguard: billing history cascades off households, so refuse
  // to delete a household that has ever been billed. Meter links and portal
  // users cascade harmlessly and need no guard.
  const { count: lineItemCount, error: countError } =
    await repo.countBillingLineItems(id);
  if (countError) {
    return communityFailure({
      status: 500,
      code: "household_delete_failed",
      message: `Could not verify billing history: ${countError.message}`,
    });
  }
  if ((lineItemCount ?? 0) > 0) {
    return communityFailure({
      status: 409,
      code: "household_has_billing_history",
      message:
        "Cannot delete a household with billing history. Unlink its meter instead.",
      reason: "household_has_billing_history",
    });
  }

  const { data: deleted, error: deleteError } = await repo.deleteHousehold(id);
  if (deleteError) {
    const rlsError = mapRlsError(
      deleteError,
      "You do not have permission to delete this household."
    );
    if (rlsError) return rlsError;
    return communityFailure({
      status: 500,
      code: "household_delete_failed",
      message: `Could not delete household: ${deleteError.message}`,
    });
  }
  if (!deleted || deleted.length === 0) {
    return communityFailure({
      status: 404,
      code: "household_not_found",
      message: "Household not found",
    });
  }

  const actorUserId = await repo.getAuthenticatedUserId();
  console.info(
    JSON.stringify({
      event: "household.delete",
      household_id: id,
      microgrid_id: existing.microgrid_id,
      actor_user_id: actorUserId,
      at: new Date().toISOString(),
    })
  );

  return { ok: true, data: { id } };
}
