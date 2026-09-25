import type {
  Community,
  Household,
  Microgrid,
  UserRoleRecord,
} from "@/lib/types/domain";
import type { HierarchyLevel } from "@/components/ui/hierarchy-nav";
import type { HierarchyScope } from "@/lib/hierarchy";

/** Organization-bound request identity carried by the Cordis context. */
export type OrganizationScope = {
  organizationId: string;
  userId: string;
  roles: UserRoleRecord[];
};

export type CommunityManagementError = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 422 | 500;
  code: string;
  message: string;
  field?: string;
  reason?: string;
};

export type CommunityManagementResult<T> =
  | { ok: true; data: T }
  | CommunityManagementError;

export function communityFailure(
  error: Omit<CommunityManagementError, "ok">
): CommunityManagementError {
  return { ok: false, ...error };
}

export type CommunityCreateInput = {
  org_id: string;
  name: string;
  address_line1?: string | null;
  address_line2?: string | null;
  address_city?: string | null;
  address_region?: string | null;
  address_country?: string | null;
  address_postal_code?: string | null;
  geography_notes?: string | null;
};

export type CommunityUpdateInput = {
  name?: string;
  address_line1?: string | null;
  address_line2?: string | null;
  address_city?: string | null;
  address_region?: string | null;
  address_country?: string | null;
  address_postal_code?: string | null;
  geography_notes?: string | null;
};

export type MicrogridCreateInput = {
  community_id: string;
  name: string;
  currency: string;
  timezone?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  address_city?: string | null;
  address_region?: string | null;
  address_country?: string | null;
  address_postal_code?: string | null;
  lat?: number | null;
  lng?: number | null;
};

export type MicrogridUpdateInput = {
  name?: string;
  currency?: string;
  timezone?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  address_city?: string | null;
  address_region?: string | null;
  address_country?: string | null;
  address_postal_code?: string | null;
  lat?: number | string | null;
  lng?: number | string | null;
};

export type HouseholdCreateInput = {
  microgrid_id: string;
  display_name: string;
  device_id?: string | null;
  primary_phone: string;
  primary_email?: string | null;
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

export type HouseholdUpdateInput = Record<string, unknown>;

export interface CommunityManagementCapabilityContract {
  createCommunity(
    input: unknown
  ): Promise<CommunityManagementResult<Community>>;
  updateCommunity(
    id: string,
    input: unknown
  ): Promise<CommunityManagementResult<Community>>;
  createMicrogrid(
    input: unknown
  ): Promise<CommunityManagementResult<Microgrid>>;
  updateMicrogrid(
    id: string,
    input: unknown
  ): Promise<CommunityManagementResult<Microgrid>>;
  createHousehold(
    input: unknown
  ): Promise<CommunityManagementResult<{ household_id: string }>>;
  updateHousehold(
    id: string,
    input: unknown
  ): Promise<CommunityManagementResult<Household>>;
  deleteHousehold(
    id: string
  ): Promise<CommunityManagementResult<{ id: string }>>;
  resolveHierarchy(
    scope: HierarchyScope
  ): Promise<CommunityManagementResult<HierarchyLevel[]>>;
}
