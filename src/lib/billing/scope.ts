import "server-only";

import type { Context } from "cordis";
import type { BillingCapabilityContract, BillingScope } from "./repository";

declare module "cordis" {
  interface Context {
    billingScope?: BillingScope;
    billing?: BillingCapabilityContract;
  }
}

export type CordisContext = Context;
