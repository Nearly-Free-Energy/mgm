import "server-only";

import type { Context } from "cordis";
import type { CommunityManagementCapabilityContract } from "./types";
import type { OrganizationScope } from "./types";

declare module "cordis" {
  interface Context {
    organizationScope?: OrganizationScope;
    communityManagement?: CommunityManagementCapabilityContract;
  }
}

export type { OrganizationScope };

// Referenced so the Cordis Context import is not elided before module
// augmentation is evaluated by bundlers that drop type-only imports.
export type CordisContext = Context;
