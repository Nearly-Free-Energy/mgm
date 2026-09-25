import "server-only";

import type { Context } from "cordis";
import type {
  MeteringCapabilityContract,
  MeteringScope,
} from "./repository";
import type { MeteringRegistry } from "./registry";

declare module "cordis" {
  interface Context {
    meteringScope?: MeteringScope;
    meteringRegistry?: MeteringRegistry;
    metering?: MeteringCapabilityContract;
  }
}

export type CordisContext = Context;
