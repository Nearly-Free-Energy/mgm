export {
  composeCommunityManagement,
  COMMUNITY_MANAGEMENT_PLUGIN_NAME,
  COMMUNITY_MANAGEMENT_PLUGIN_VERSION,
  type CommunityManagementComposition,
} from "./compose";
export { CommunityManagementCapability } from "./capability";
export { createSupabaseCommunityRepository } from "./infrastructure/supabase-repository";
export {
  communityFailure,
  type CommunityManagementCapabilityContract,
  type CommunityManagementError,
  type CommunityManagementRepository,
  type CommunityManagementResult,
  type HierarchyLevel,
  type HierarchyScope,
  type OrganizationScope,
  type RepositoryError,
  type RepositoryResult,
} from "./types";
