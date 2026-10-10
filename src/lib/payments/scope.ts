import "server-only";

import type { Context } from "cordis";
import type { PaymentsCapabilityContract, PaymentsScope } from "./repository";

declare module "cordis" {
  interface Context {
    paymentsScope?: PaymentsScope;
    payments?: PaymentsCapabilityContract;
  }
}

export type CordisContext = Context;
