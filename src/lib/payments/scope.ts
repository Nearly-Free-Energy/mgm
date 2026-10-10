import "server-only";

import type { Context } from "cordis";
import type { PaymentsCapabilityContract, PaymentsScope, ProviderFactory } from "./repository";

declare module "cordis" {
  interface Context {
    paymentProviders?: ProviderFactory;
    paymentsScope?: PaymentsScope;
    payments?: PaymentsCapabilityContract;
  }
}

export type CordisContext = Context;
