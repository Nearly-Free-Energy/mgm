import "server-only";

import type { Context } from "cordis";
import type { TenantAppCapabilityContract, TenantAppScope } from "./types";

declare module "cordis" {
  interface Context {
    tenantAppScope?: TenantAppScope;
    tenantApp?: TenantAppCapabilityContract;
  }
}

export type CordisContext = Context;
