/**
 * repository.ts — persistence boundary for the metering plugin (issue #4).
 *
 * The metering capability and its domain logic consume ONLY this interface.
 * The Supabase/PostgREST implementation lives in `infrastructure/`. An
 * import-boundary test fails the build if domain files import a database
 * client, server helper, or framework module directly.
 */
import type { DeviceConfig } from "@/lib/adapters/types";
import type { UserRoleRecord } from "@/lib/types/domain";
import type {
  AssignmentGap,
  AssignmentHistoryEntry,
  ConnectionTestResult,
  DeviceConsumption,
  DiscoveredMeter,
} from "./types";
import type { SiteDayOperations, SiteDayRead } from "./site-operations";
import type { SiteDayCapture, SiteDayWindow } from "./site-day-evidence";
export type { MeteringProviderName } from "./registry";

export type MeteringScope = {
  organizationId: string;
  userId: string;
  roles: UserRoleRecord[];
};

export type MeteringResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503;
      code: string;
      message: string;
      field?: string;
      reason?: string;
    };

export function meteringFailure(
  error: Omit<Extract<MeteringResult<never>, { ok: false }>, "ok">
): Extract<MeteringResult<never>, { ok: false }> {
  return { ok: false, ...error };
}

export type RepositoryError = { code?: string; message: string };

/** Stored OpenEMS connection (identifiers only — never secrets). */
export type StoredConnection = {
  type: "cloud_aws" | "direct_url";
  backendUrl: string;
  region: string | null;
  accessKeyId: string | null;
  basicAuthUsername: string | null;
  hasBasicAuthPassword: boolean;
  knownEdgeIds: string[];
  lastDiscoverAt: string | null;
  lastDiscoverStatus: string | null;
};

/** Managed device with its vendor mapping (MGM id + OpenEMS ids). */
export type ManagedDevice = DeviceConfig & {
  name: string;
  edgeId: string;
  deviceType: string;
};

/** Assignment link row with effective dates. */
export type AssignmentLink = {
  id: string;
  tenantId: string;
  deviceId: string;
  role: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export interface MeteringRepository {
  getAuthenticatedUserId(): Promise<string | null>;
  getUserRoles(): Promise<UserRoleRecord[]>;
  /** Rejects when plugin state cannot be read; the capability answers 503. */
  isPluginEnabled(organizationId: string): Promise<boolean>;
  getMicrogridOrganization(
    microgridId: string
  ): Promise<{ microgridId: string; communityId: string; orgId: string } | null>;
  getTenantOrganization(
    tenantId: string
  ): Promise<{ tenantId: string; microgridId: string; orgId: string } | null>;
  getDeviceOrganization(
    deviceId: string
  ): Promise<{ deviceId: string; microgridId: string; orgId: string } | null>;
  getStoredConnection(microgridId: string): Promise<StoredConnection | null>;
  /**
   * The microgrid's stored zone, as stored (not validated); null when the
   * microgrid has none or is not found. Throws when the read fails, so a
   * failed read is not mistaken for a microgrid without a zone.
   */
  getMicrogridTimezone(microgridId: string): Promise<string | null>;
  /**
   * The microgrid's devices with their OpenEMS ids. Empty when it has none;
   * throws when a read fails, so a failed read is not mistaken for a
   * microgrid without devices.
   */
  getManagedDevices(microgridId: string): Promise<ManagedDevice[]>;
  /**
   * Ids of this microgrid's devices linked to a tenant as its primary or
   * secondary consumption meter on `date` (YYYY-MM-DD): links whose
   * half-open period [effective_from, effective_to) contains the day. Empty
   * when there are none; throws when a read fails, so a failed read is not
   * mistaken for a site without tenant meters.
   */
  getHouseMeterIds(microgridId: string, date: string): Promise<string[]>;
  getMicrogridEdges(
    microgridId: string
  ): Promise<{ id: string; openemsEdgeId: string; name: string }[]>;
  getKnownEdgeIds(microgridId: string): Promise<string[]>;
  getAssignmentLinks(tenantId: string): Promise<AssignmentLink[]>;
  insertMeterReading(input: {
    deviceId: string;
    readingKwh: number;
    readAt: string;
  }): Promise<{ id: string | null; error: RepositoryError | null }>;
  findMeterReadingAt(
    deviceId: string,
    readAt: string
  ): Promise<{ id: string } | null>;
}

/**
 * Vendor-facing connection operations. The implementation wraps the OpenEMS
 * client; OpenEMS identifiers and channel mapping never leave it. Candidate
 * configs may carry plaintext secrets in memory for a single test call —
 * they are never logged, persisted, or returned.
 */
export interface MeteringConnection {
  testStored(microgridId: string): Promise<ConnectionTestResult>;
  testCandidate(
    microgridId: string,
    candidate: StoredConnectionCandidate
  ): Promise<ConnectionTestResult>;
  discover(microgridId: string): Promise<
    {
      edgeId: string;
      online: boolean;
      components: { id: string; name: string }[];
    }[]
  >;
}

export interface MeteringCapabilityContract {
  testConnection(
    microgridId: string,
    candidate?: StoredConnectionCandidate
  ): Promise<MeteringResult<ConnectionTestResult>>;
  discoverMeters(
    microgridId: string
  ): Promise<MeteringResult<DiscoveredMeter[]>>;
  getConsumption(
    query: unknown
  ): Promise<MeteringResult<DeviceConsumption[]>>;
  getAssignmentHistory(
    tenantId: string
  ): Promise<
    MeteringResult<{
      entries: AssignmentHistoryEntry[];
      gaps: AssignmentGap[];
    }>
  >;
  recordOpeningRegister(
    input: unknown
  ): Promise<MeteringResult<{ id: string }>>;
  getSiteDay(query: unknown): Promise<MeteringResult<SiteDayRead>>;
  /** Query `{ microgrid_id, start_date, end_date }`; one entry per day, in order. */
  getSiteDays(query: unknown): Promise<MeteringResult<SiteDayOperations[]>>;
  /**
   * One site day as investigation evidence, `site-day-evidence/1`
   * (docs/investigation-evidence.md §4): what getSiteDay reads, plus every
   * fact and calculated item the snapshot stores. Query as getSiteDay's; its
   * date must be the window's. `window` is the operation's (evidence §3 O2,
   * "a date and a zone, fixed at creation"): every refused snapshot takes its
   * date, and its zone too when the read is refused before or at its zone
   * read (then `zoneRead` is null). Every refusal but an access refusal comes
   * back as a refused snapshot, and so does MGM's own defect in building the
   * snapshot, whether one of the builder's checks or any other throw from
   * building it; an access refusal comes back with no snapshot. It throws
   * (a SiteDayEvidenceDefect) only when even the refused snapshot built from
   * constants and `window` fails its schema, which means `window` itself is
   * not a valid operation window.
   */
  captureSiteDay(query: unknown, window: SiteDayWindow): Promise<SiteDayCapture>;
}

/** Candidate connection for test-without-save (never persisted). */
export type StoredConnectionCandidate = {
  type: "cloud_aws" | "direct_url";
  backendUrl: string;
  region?: string | null;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  basicAuthUsername?: string | null;
  basicAuthPassword?: string | null;
  /** Keycloak bearer token (issue #4). Mutually exclusive with Basic. */
  bearerToken?: string | null;
  /**
   * Keycloak client-credentials (issue #4 follow-up). All-or-nothing, and
   * mutually exclusive with both `bearerToken` and Basic: the connection
   * obtains a fresh access token from the IdP at test time. Secrets stay
   * in memory for the call only.
   */
  keycloakTokenUrl?: string | null;
  keycloakClientId?: string | null;
  keycloakClientSecret?: string | null;
};
