import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createOpenEmsClient } from "@/lib/openems";
import type { OpenEmsClientConfig } from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import { OpenEmsError } from "@/lib/openems/errors";
import { MeteringError } from "./errors";
import type { MeteringProvider, MeteringReadRequest } from "./types";

/**
 * OpenEMS integration. This is the only place in the billing-review path that
 * knows about OpenEMS configuration, channel identifiers, or error codes.
 */
export class OpenEmsMeteringProvider implements MeteringProvider {
  constructor(private readonly supabase: SupabaseClient) {}

  async getReadings(request: MeteringReadRequest) {
    try {
      const config = await resolveOpenEmsConfig(
        this.supabase,
        request.microgridId
      );
      if (!config) {
        throw new MeteringError(
          "Metering provider is not configured for this microgrid",
          "METERING_CONFIGURATION",
          409,
          { microgridId: request.microgridId }
        );
      }

      // OpenEmsClient itself only ever asks for
      // `${componentId}/ActiveConsumptionEnergy`; it never requests `_sum`.
      return await createOpenEmsClient(config).getReadings(
        request.devices,
        request.startDate,
        request.endDate,
        request.timezone
      );
    } catch (error) {
      if (error instanceof MeteringError) throw error;
      if (error instanceof OpenEmsError) throw translateOpenEmsError(error);
      throw new MeteringError(
        "Metering provider failed unexpectedly",
        "METERING_UNAVAILABLE",
        503,
        error
      );
    }
  }
}

/**
 * MGM's pilot database deliberately does not contain the legacy MBE
 * `microgrids.ems_*` credential columns or their decrypt RPCs. When an MGM
 * OpenEMS environment is configured, its exact microgrid binding is checked
 * before any database lookup. A partial configuration or a different
 * microgrid is never allowed to fall back to the database path.
 *
 * The OpenEMS identity configured through these variables must be read-only;
 * this provider only calls historic energy reads, but server code cannot turn
 * a write-capable backend identity into a safe one.
 */
async function resolveOpenEmsConfig(
  supabase: SupabaseClient,
  requestedMicrogridId: string
): Promise<OpenEmsClientConfig | null> {
  const microgridId = process.env.MGM_OPENEMS_MICROGRID_ID;
  const url = process.env.MGM_OPENEMS_URL;
  const username = process.env.MGM_OPENEMS_USERNAME;
  const password = process.env.MGM_OPENEMS_PASSWORD;
  const anyPilotConfig = Boolean(microgridId || url || username || password);

  if (!anyPilotConfig) {
    // Compatibility for the inherited MBE schema and its existing tests.
    return getMicrogridEmsConfig(supabase, requestedMicrogridId);
  }

  if (!microgridId || !url) {
    throw new MeteringError(
      "Pilot OpenEMS configuration is incomplete",
      "METERING_CONFIGURATION",
      503
    );
  }
  if (microgridId !== requestedMicrogridId) {
    throw new MeteringError(
      "Pilot OpenEMS is not configured for this microgrid",
      "METERING_CONFIGURATION",
      403
    );
  }
  if (Boolean(username) !== Boolean(password)) {
    throw new MeteringError(
      "Pilot OpenEMS credentials are incomplete",
      "METERING_CONFIGURATION",
      503
    );
  }

  return {
    type: "direct_url",
    url,
    ...(username && password ? { username, password } : {}),
  };
}

export function createOpenEmsMeteringProvider(
  supabase: SupabaseClient
): MeteringProvider {
  return new OpenEmsMeteringProvider(supabase);
}

function translateOpenEmsError(error: OpenEmsError): MeteringError {
  if (error.code === "OPENEMS_AUTH_FAILED" || error.code === "OPENEMS_FORBIDDEN") {
    return new MeteringError(error.message, "METERING_UNAUTHORIZED", error.statusCode, error.details);
  }
  if (
    error.code === "OPENEMS_NOT_CONFIGURED" ||
    error.code === "OPENEMS_INVALID_CONFIG" ||
    error.code === "OPENEMS_INVALID_BACKEND_URL"
  ) {
    return new MeteringError(error.message, "METERING_CONFIGURATION", error.statusCode, error.details);
  }
  if (error.code === "DEVICE_INVALID_DATA_SOURCE") {
    return new MeteringError(error.message, "METERING_INVALID_DATA", error.statusCode, error.details);
  }
  return new MeteringError(error.message, "METERING_UNAVAILABLE", error.statusCode, error.details);
}
