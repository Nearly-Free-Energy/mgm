import "server-only";

/**
 * Examples of the `metering.connection` watcher's signals, built by its own
 * model with a fixed clock, so they are what it returns: a backend that
 * refused the saved sign-in at its last check, and one that could not be
 * reached. All data is synthetic.
 */
import { createFmt } from "@/lib/gui/fmt";
import type { SignalOut } from "@/lib/gui/surface";
import { buildConnectionSignals } from "./connection-signals-model";

export const CONNECTION_EXAMPLES: readonly SignalOut[] = buildConnectionSignals(
  createFmt({ locale: "en-GB" }),
  [
    {
      id: "00000000-0000-4000-8000-0000000000b1",
      name: "Kiwumu",
      timezone: "Africa/Kampala",
      emsType: "cloud_aws",
      status: "auth_failed",
      checkedAt: "2026-11-19T06:15:00Z",
    },
    {
      id: "00000000-0000-4000-8000-0000000000b2",
      name: "Lwamata",
      timezone: "Africa/Kampala",
      emsType: "direct_url",
      status: "unreachable",
      checkedAt: "2026-11-18T17:40:00Z",
    },
  ],
  new Date("2026-11-20T09:00:00Z"),
);
