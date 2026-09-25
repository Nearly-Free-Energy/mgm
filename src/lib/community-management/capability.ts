/**
 * CommunityManagementCapability — typed entry point for the
 * community-management plugin's domain operations.
 *
 * Import boundary: consumes operations and the repository interface only —
 * never a database client. See `__tests__/import-boundary.test.ts`.
 */
import "server-only";

import {
  createCommunityOperation,
  updateCommunityOperation,
} from "./operations/communities";
import {
  createMicrogridOperation,
  updateMicrogridOperation,
} from "./operations/microgrids";
import {
  createHouseholdOperation,
  deleteHouseholdOperation,
  updateHouseholdOperation,
} from "./operations/households";
import {
  communityFailure,
  type CommunityManagementCapabilityContract,
  type CommunityManagementError,
  type CommunityManagementRepository,
  type CommunityManagementResult,
  type HierarchyLevel,
  type HierarchyScope,
  type OrganizationScope,
} from "./types";
import type { Community, Household, Microgrid } from "@/lib/types/domain";

export class CommunityManagementCapability
  implements CommunityManagementCapabilityContract
{
  constructor(
    private readonly repo: CommunityManagementRepository,
    private readonly scope: OrganizationScope,
    private readonly isActive: () => boolean
  ) {}

  private ensureActive(): CommunityManagementError | null {
    if (this.isActive()) return null;
    return communityFailure({
      status: 500,
      code: "community_composition_disposed",
      message: "Community management composition has been disposed.",
    });
  }

  async createCommunity(
    input: unknown
  ): Promise<CommunityManagementResult<Community>> {
    return (
      this.ensureActive() ??
      createCommunityOperation(this.repo, this.scope, input)
    );
  }

  async updateCommunity(
    id: string,
    input: unknown
  ): Promise<CommunityManagementResult<Community>> {
    return (
      this.ensureActive() ??
      updateCommunityOperation(this.repo, this.scope, id, input)
    );
  }

  async createMicrogrid(
    input: unknown
  ): Promise<CommunityManagementResult<Microgrid>> {
    return (
      this.ensureActive() ??
      createMicrogridOperation(this.repo, this.scope, input)
    );
  }

  async updateMicrogrid(
    id: string,
    input: unknown
  ): Promise<CommunityManagementResult<Microgrid>> {
    return (
      this.ensureActive() ??
      updateMicrogridOperation(this.repo, this.scope, id, input)
    );
  }

  async createHousehold(
    input: unknown
  ): Promise<CommunityManagementResult<{ household_id: string }>> {
    return (
      this.ensureActive() ??
      createHouseholdOperation(this.repo, this.scope, input)
    );
  }

  async updateHousehold(
    id: string,
    input: unknown
  ): Promise<CommunityManagementResult<Household>> {
    return (
      this.ensureActive() ??
      updateHouseholdOperation(this.repo, this.scope, id, input)
    );
  }

  async deleteHousehold(
    id: string
  ): Promise<CommunityManagementResult<{ id: string }>> {
    return (
      this.ensureActive() ??
      deleteHouseholdOperation(this.repo, this.scope, id)
    );
  }

  /**
   * Resolve hierarchy breadcrumb levels through the organization scope.
   * Reads stay available while the plugin is disabled — only the scope
   * check applies here, never the plugin gate.
   */
  async resolveHierarchy(
    hierarchyScope: HierarchyScope
  ): Promise<CommunityManagementResult<HierarchyLevel[]>> {
    const inactive = this.ensureActive();
    if (inactive) return inactive;

    const mismatch = communityFailure({
      status: 403,
      code: "community_scope_mismatch",
      message: "Not authorized to act on this organization.",
      reason: "forbidden",
    });

    if (
      "orgId" in hierarchyScope &&
      hierarchyScope.orgId &&
      hierarchyScope.orgId !== this.scope.organizationId
    ) {
      return mismatch;
    }

    if ("communityId" in hierarchyScope && hierarchyScope.communityId) {
      const orgId = await this.repo.getCommunityOrganizationId(
        hierarchyScope.communityId
      );
      if (!orgId || orgId !== this.scope.organizationId) return mismatch;
    }

    if ("microgridId" in hierarchyScope && hierarchyScope.microgridId) {
      const resolved = await this.repo.getMicrogridOrganization(
        hierarchyScope.microgridId
      );
      if (!resolved || resolved.orgId !== this.scope.organizationId) {
        return mismatch;
      }
    }

    if ("householdId" in hierarchyScope && hierarchyScope.householdId) {
      const { data: household } = await this.repo.findHousehold(
        hierarchyScope.householdId
      );
      if (!household) return mismatch;
      const resolved = await this.repo.getMicrogridOrganization(
        household.microgrid_id
      );
      if (!resolved || resolved.orgId !== this.scope.organizationId) {
        return mismatch;
      }
    }

    return {
      ok: true,
      data: await this.repo.resolveHierarchyLevels(hierarchyScope),
    };
  }
}
