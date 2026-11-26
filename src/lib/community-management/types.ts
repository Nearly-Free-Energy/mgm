import type {
  Community,
  Tenant,
  Microgrid,
  UserRoleRecord,
} from "@/lib/types/domain";
import type { HierarchyLevel as HierarchyLevelT } from "@/components/ui/hierarchy-nav";
import type { HierarchyScope as HierarchyScopeT } from "@/lib/hierarchy";

export type HierarchyLevel = HierarchyLevelT;
export type HierarchyScope = HierarchyScopeT;

/** Organization-bound request identity carried by the Cordis context. */
export type OrganizationScope = {
  organizationId: string;
  userId: string;
  roles: UserRoleRecord[];
};

export type CommunityManagementError = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503;
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

/**
 * Minimal structural database error. Repository implementations map their
 * driver errors into this shape so domain operations never import a
 * database client, query builder, or PostgREST error type.
 */
export type RepositoryError = {
  code?: string;
  message: string;
};

export type RepositoryResult<T> = {
  data: T | null;
  error: RepositoryError | null;
};

/**
 * Persistence boundary for the community-management plugin (issue #3,
 * Release-1 architectural follow-up).
 *
 * Domain operations (`operations/*`) and the capability consume ONLY this
 * interface. The Supabase/PostgREST implementation lives in
 * `infrastructure/` alongside the auth and RLS plumbing. An
 * import-boundary test (`__tests__/import-boundary.test.ts`) fails the
 * build if operations or the capability import a database client, server
 * helpers, or framework modules directly.
 */
export interface CommunityManagementRepository {
  getAuthenticatedUserId(): Promise<string | null>;
  getUserRoles(): Promise<UserRoleRecord[]>;
  /** Rejects when plugin state cannot be read; the operations answer 503. */
  isPluginEnabled(organizationId: string): Promise<boolean>;
  getCommunityOrganizationId(communityId: string): Promise<string | null>;
  getMicrogridOrganization(
    microgridId: string
  ): Promise<{ microgridId: string; communityId: string; orgId: string } | null>;
  findTenant(
    tenantId: string
  ): Promise<RepositoryResult<{
    id: string;
    display_name: string;
    microgrid_id: string;
  }>>;
  updateTenantFields(
    id: string,
    patch: Record<string, unknown>
  ): Promise<RepositoryResult<Tenant | null>>;
  insertCommunity(
    row: CommunityCreateInput
  ): Promise<RepositoryResult<Community>>;
  updateCommunity(
    id: string,
    patch: CommunityUpdateInput
  ): Promise<RepositoryResult<Community | null>>;
  insertMicrogrid(
    row: MicrogridCreateInput
  ): Promise<RepositoryResult<Microgrid>>;
  updateMicrogrid(
    id: string,
    patch: MicrogridUpdateInput
  ): Promise<RepositoryResult<Microgrid | null>>;
  /**
   * The microgrid's stored currency and how many of its billing periods are
   * closed, read before a currency change (updateMicrogridOperation); null
   * data when the microgrid is not found.
   */
  getMicrogridCurrencyUse(
    microgridId: string
  ): Promise<RepositoryResult<{ currency: string; closedPeriods: number }>>;
  createTenant(
    args: Record<string, unknown>,
    withMeter: boolean
  ): Promise<{ data: string | null; error: RepositoryError | null }>;
  findDeviceLink(
    deviceId: string,
    excludeTenantId: string
  ): Promise<{ tenant_id: string } | null>;
  /**
   * Currently open primary link (effective_to IS NULL), if any. Release 2
   * (issue #4): replacements close and open links instead of deleting them,
   * so history survives meter swaps.
   */
  getOpenDeviceLink(
    tenantId: string
  ): Promise<{ id: string; device_id: string; effective_from: string } | null>;
  closeDeviceLink(
    linkId: string,
    effectiveTo: string
  ): Promise<RepositoryError | null>;
  /**
   * Atomic close-and-open replacement (fn_replace_tenant_device):
   * closes open primary links at the date and opens the new one in a single
   * transaction, so a failed insert cannot leave the tenant meterless.
   * Same-day links are deleted rather than zero-length closed.
   */
  replaceDeviceLink(
    tenantId: string,
    deviceId: string,
    effectiveDate: string
  ): Promise<{ id: string | null; error: RepositoryError | null }>;
  deleteDeviceLink(linkId: string): Promise<RepositoryError | null>;
  refetchTenant(id: string): Promise<RepositoryResult<Tenant>>;
  countBillingLineItems(
    tenantId: string
  ): Promise<{ count: number | null; error: RepositoryError | null }>;
  deleteTenant(
    id: string
  ): Promise<RepositoryResult<{ id: string }[]>>;
  resolveHierarchyLevels(
    scope: HierarchyScope
  ): Promise<HierarchyLevel[]>;
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

export type TenantCreateInput = {
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

export type TenantUpdateInput = Record<string, unknown>;

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
  createTenant(
    input: unknown
  ): Promise<CommunityManagementResult<{ tenant_id: string }>>;
  updateTenant(
    id: string,
    input: unknown
  ): Promise<CommunityManagementResult<Tenant>>;
  deleteTenant(
    id: string
  ): Promise<CommunityManagementResult<{ id: string }>>;
  resolveHierarchy(
    scope: HierarchyScope
  ): Promise<CommunityManagementResult<HierarchyLevel[]>>;
}
